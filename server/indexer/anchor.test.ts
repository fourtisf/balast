/**
 * Finding the USD anchor without being told.
 *
 * The behaviour this protects is the one that mattered on the real box: the
 * indexer used to refuse to start without `USDG_ADDRESS`, so the site sat on
 * a "not configured" page waiting for a step only a person could take. It now
 * indexes regardless and finds USDG in its own tables.
 *
 * The retroactive pricing is the part worth proving. Raw rows written before
 * the anchor was known get their dollar figures on the pass that finds it,
 * with no second scan of the chain — which only works because aggregates are
 * rebuilt rather than incremented (§9's design, paying off somewhere it was
 * not designed for).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../db';
import { isReachable, resetDatabase } from '../test/db';
import { FixtureLogSource, USDG, buildFixtureChain, fixtureTokenReader } from '../test/fixture';
import { resolveUsdg } from './anchor';
import { Poller } from './poller';

const chain = buildFixtureChain();

/** A poller with NO configured anchor — the state a fresh box is in. */
function blindPoller(source: FixtureLogSource, blockRange: number): Poller {
  return new Poller({
    source,
    // Deliberately absent.
    usdgAddress: null,
    startBlock: 0n,
    blockRange,
    tokenReader: fixtureTokenReader,
  });
}

beforeAll(async () => {
  if (!(await isReachable())) {
    throw new Error('These tests need a Postgres at TEST_DATABASE_URL. See README.');
  }
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('resolveUsdg', () => {
  it('reports none on an empty database, without throwing', async () => {
    await resetDatabase();
    const resolved = await resolveUsdg(null);
    expect(resolved.address).toBeNull();
    expect(resolved.source).toBe('none');
    expect(resolved.note).toMatch(/has been indexed yet|set USDG_ADDRESS/i);
  });

  it('takes a configured address without looking at the chain', async () => {
    const resolved = await resolveUsdg(USDG);
    expect(resolved.address).toBe(USDG.toLowerCase());
    expect(resolved.source).toBe('configured');
  });

  it('refuses a malformed override rather than discovering something else', async () => {
    // Someone meant to pin a specific token and mistyped it. Quietly choosing
    // a different one would price the entire site off the wrong token.
    const resolved = await resolveUsdg('0xnope');
    expect(resolved.address).toBeNull();
    expect(resolved.source).toBe('none');
    expect(resolved.note).toMatch(/not an address/i);
  });
});

describe('an indexer with no anchor configured', () => {
  it('indexes the chain anyway, and finds USDG in its own tables', async () => {
    await resetDatabase();
    const source = new FixtureLogSource(chain);
    await blindPoller(source, chain.headBlock + 1).syncToHead();

    // It indexed.
    expect(await prisma.pool.count()).toBe(4);
    expect(await prisma.swapEvent.count()).toBeGreaterThan(500);

    // And it found the anchor without being told.
    const resolved = await resolveUsdg(null);
    expect(resolved.address).toBe(USDG.toLowerCase());
    expect(resolved.source).toBe('discovered');
    expect(resolved.note).toMatch(/Discovered USDG/i);
  });

  it('prices everything, exactly as if the address had been configured', async () => {
    // The whole point: no human step, and no worse an answer for it.
    const discovered = await prisma.$queryRaw<{ pool_id: string; tvl: string; price: string }[]>`
      SELECT pool_id, tvl_usd::text AS tvl, price_usd::text AS price
      FROM pool_state ORDER BY pool_id
    `;
    expect(discovered.length).toBe(4);
    for (const row of discovered) {
      expect(Number(row.price)).toBeGreaterThan(0);
    }

    await resetDatabase();
    const source = new FixtureLogSource(chain);
    await new Poller({
      source,
      usdgAddress: USDG,
      startBlock: 0n,
      blockRange: chain.headBlock + 1,
      tokenReader: fixtureTokenReader,
    }).syncToHead();

    const configured = await prisma.$queryRaw<{ pool_id: string; tvl: string; price: string }[]>`
      SELECT pool_id, tvl_usd::text AS tvl, price_usd::text AS price
      FROM pool_state ORDER BY pool_id
    `;
    expect(configured).toEqual(discovered);
  });

  it('prices retroactively rows written before the anchor existed', async () => {
    // The ordering that makes this work at all. On a first sync the anchor
    // does not exist for the first few passes: raw rows are written with no
    // dollar figures, and the pass that discovers USDG rebuilds them. No
    // second scan of the chain, because aggregates are rebuilt not incremented.
    await resetDatabase();
    const source = new FixtureLogSource(chain, 0);
    const poller = blindPoller(source, 400);

    // A first window that contains pools but, on its own, no priced rows yet.
    source.setHead(400);
    await poller.syncToHead();
    const rawEarly = await prisma.swapEvent.count();
    expect(rawEarly).toBeGreaterThan(0);

    // Run it out. Whatever the anchor's state was early on, the finished
    // sync has to price the early hours too.
    for (let head = 800; head <= chain.headBlock; head += 800) {
      source.setHead(head);
      await poller.syncToHead();
    }
    source.setHead(chain.headBlock);
    await poller.syncToHead();

    const [early] = await prisma.$queryRaw<{ priced: number; total: number }[]>`
      SELECT
        COUNT(*) FILTER (WHERE fees_usd > 0)::int AS priced,
        COUNT(*)::int                            AS total
      FROM pool_fee_hourly
      WHERE hour < (SELECT MIN(hour) + interval '12 hours' FROM pool_fee_hourly)
    `;
    // The earliest hours — indexed before any anchor was known — carry USD.
    expect(early.total).toBeGreaterThan(0);
    expect(early.priced).toBeGreaterThan(0);
  });
});
