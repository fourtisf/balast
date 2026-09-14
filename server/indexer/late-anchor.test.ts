/**
 * An anchor that turns up late, which is what a real first sync looks like.
 *
 * Every other fixture creates the USDG pool at block 1, so the anchor is
 * known from the first pass and nothing is ever skipped. On the real chain it
 * was unknown for the first few million blocks, and two things went wrong
 * that no test had covered:
 *
 *   - Token flow was skipped along with the priced tables while the anchor
 *     was unknown. When it resolved, only that pass's hours had flow rows, so
 *     every pool's reserves were recent swaps minus a mint it never saw —
 *     negative, therefore "unknown depth", therefore TVL $0 across the site.
 *   - The rebuild on the discovering pass was bounded to its own hours, so
 *     "prices everything retroactively" (§17) was true of the fixture and
 *     false of the chain.
 *
 * The proof is the one the anchor suite already uses for the early case: a
 * sync that discovers the anchor late must produce the same rows, as text,
 * as a sync that had the address configured from the start.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../db';
import { isReachable, resetDatabase } from '../test/db';
import {
  FIXTURE_POOLS,
  FixtureLogSource,
  USDG,
  buildFixtureChain,
  fixtureTokenReader,
  type FixturePool,
} from '../test/fixture';
import { Poller } from './poller';

/** The default pools, with the anchor created two thirds of the way in. */
const LATE_ANCHOR_BLOCK = 2_001;
const LATE_POOLS: FixturePool[] = FIXTURE_POOLS.map((pool, i) =>
  i === 0 ? { ...pool, initBlock: LATE_ANCHOR_BLOCK } : pool,
);
const chain = buildFixtureChain(3_000, 4663, LATE_POOLS);

/** Sync in windows small enough that several passes complete before the anchor exists. */
async function syncInWindows(usdgAddress: string | null): Promise<void> {
  const source = new FixtureLogSource(chain, 0);
  const poller = new Poller({
    source,
    usdgAddress,
    startBlock: 0n,
    blockRange: 400,
    tokenReader: fixtureTokenReader,
  });
  for (let head = 400; head < chain.headBlock; head += 400) {
    source.setHead(head);
    await poller.syncToHead();
  }
  source.setHead(chain.headBlock);
  await poller.syncToHead();
}

const ROWS = {
  state: () => prisma.$queryRaw<unknown[]>`
    SELECT pool_id, tvl_usd::text AS tvl, price_usd::text AS price, mc_usd::text AS mc
    FROM pool_state ORDER BY pool_id`,
  fees: () => prisma.$queryRaw<unknown[]>`
    SELECT pool_id, hour, fees_usd::text AS fees, volume_usd::text AS volume, swaps
    FROM pool_fee_hourly ORDER BY pool_id, hour`,
  flows: () => prisma.$queryRaw<unknown[]>`
    SELECT pool_id, hour, delta0::text AS d0, delta1::text AS d1
    FROM pool_flow_hourly ORDER BY pool_id, hour`,
};

beforeAll(async () => {
  if (!(await isReachable())) {
    throw new Error('These tests need a Postgres at TEST_DATABASE_URL. See README.');
  }
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('an anchor discovered several passes into the sync', () => {
  it('still knows every pool\'s depth, because flow was staged before it existed', async () => {
    await resetDatabase();
    await syncInWindows(null);

    // The pools created at block 1 were funded in hour zero, five passes
    // before the anchor appeared. Their reserves must include that mint.
    const states = await prisma.poolState.findMany({ include: { pool: true } });
    // The fixture's youngest pool is created past this chain's head, so it
    // never exists here; every pool that does must have a known depth.
    const created = LATE_POOLS.filter((p) => p.initBlock <= chain.headBlock).length;
    expect(states.length).toBe(created);
    for (const state of states) {
      expect(Number(state.tvlUsd), `TVL of ${state.pool.id}`).toBeGreaterThan(0);
    }
    // And the flow table covers the early hours, not only the discovering pass's.
    const [{ first }] = await prisma.$queryRaw<{ first: Date }[]>`
      SELECT MIN(hour) AS first FROM pool_flow_hourly`;
    const [{ earliest }] = await prisma.$queryRaw<{ earliest: Date }[]>`
      SELECT MIN(date_trunc('hour', block_time)) AS earliest FROM liquidity_events`;
    expect(first.getTime()).toBe(earliest.getTime());
  });

  it('produces exactly the rows a sync configured with the address would', async () => {
    await resetDatabase();
    await syncInWindows(null);
    const discovered = {
      state: await ROWS.state(),
      fees: await ROWS.fees(),
      flows: await ROWS.flows(),
    };

    await resetDatabase();
    await syncInWindows(USDG);
    const configured = {
      state: await ROWS.state(),
      fees: await ROWS.fees(),
      flows: await ROWS.flows(),
    };

    // As text: a float comparison would hide the numeric drift this exists
    // to catch (§14). Not just the counts — the values.
    expect(discovered.flows).toEqual(configured.flows);
    expect(discovered.fees).toEqual(configured.fees);
    expect(discovered.state).toEqual(configured.state);
    expect(discovered.fees.length).toBeGreaterThan(0);
  });
});
