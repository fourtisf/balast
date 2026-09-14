/**
 * The adaptive block range.
 *
 * A fixed 2,000-block window is right once the indexer follows head and wrong
 * by four orders of magnitude during a first sync. On the real chain — 62
 * million blocks, almost all of them empty — it meant roughly thirty thousand
 * round trips, about thirty-four hours, before reaching anything worth
 * indexing. The observed run was at block 47,000 after ten minutes.
 *
 * The fix has to hold two things at once: collapse the pass count, and change
 * nothing about the rows produced. §9 compares a block-zero run against an
 * incremental one, and a window that changes size mid-sync is a harder
 * version of exactly that comparison.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../db';
import { isReachable, resetDatabase } from '../test/db';
import { FixtureLogSource, USDG, buildFixtureChain, fixtureTokenReader } from '../test/fixture';
import { Poller } from './poller';

const chain = buildFixtureChain();

/** A source with a long empty tail, like a chain whose contracts are recent. */
class SparseSource extends FixtureLogSource {
  readonly widths: bigint[] = [];
  constructor(
    chainData: ReturnType<typeof buildFixtureChain>,
    head: number,
    /** Refuse any range wider than this, as a real endpoint does. */
    private readonly cap: bigint | null = null,
  ) {
    super(chainData, head);
  }

  override async getLogs(args: { address: string | string[]; fromBlock: bigint; toBlock: bigint }) {
    const width = args.toBlock - args.fromBlock + 1n;
    this.widths.push(width);
    if (this.cap !== null && width > this.cap) {
      throw new Error(`query returned more than 10000 results / range too large (${width})`);
    }
    return super.getLogs(args);
  }
}

beforeAll(async () => {
  if (!(await isReachable())) {
    throw new Error('These tests need a Postgres at TEST_DATABASE_URL. See README.');
  }
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('backfilling an empty chain', () => {
  it('widens the window, so an empty stretch costs passes not thousands', async () => {
    await resetDatabase();
    // A chain whose head is far past its last event: the shape of a real one.
    const source = new SparseSource(chain, 60_000);
    const passes = await new Poller({
      source,
      usdgAddress: USDG,
      startBlock: 0n,
      blockRange: 2_000,
      maxBlockRange: 50_000,
      tokenReader: fixtureTokenReader,
    }).syncToHead();

    // 60,000 blocks at a fixed 2,000 is 30 passes. Widening should beat that
    // comfortably; the exact number depends on where the events sit.
    expect(passes.length).toBeLessThan(20);
    // And it must actually have widened, not just got lucky.
    expect(source.widths.some((w) => w > 2_000n)).toBe(true);
    expect(await prisma.swapEvent.count()).toBeGreaterThan(500);
  });

  it('finds an endpoint\'s cap by hitting it, then stays under it', async () => {
    // No endpoint announces its limit, so the only way to learn it is to be
    // refused once. What must not happen is refusing forever.
    await resetDatabase();
    const source = new SparseSource(chain, 60_000, 8_000n);
    const passes = await new Poller({
      source,
      usdgAddress: USDG,
      startBlock: 0n,
      blockRange: 2_000,
      maxBlockRange: 50_000,
      tokenReader: fixtureTokenReader,
    }).syncToHead();

    const refused = source.widths.filter((w) => w > 8_000n);
    expect(refused.length).toBeGreaterThan(0);
    // Having learned it, it must not keep asking for more.
    const afterFirstRefusal = source.widths.slice(source.widths.indexOf(refused[0]) + 1);
    expect(afterFirstRefusal.every((w) => w <= 8_000n)).toBe(true);
    // And it still finished.
    expect(passes[passes.length - 1].caughtUp).toBe(true);
    expect(await prisma.swapEvent.count()).toBeGreaterThan(500);
  });

  it('narrows again once it is following head', async () => {
    // A wide window costs latency when there is nothing to catch up on.
    await resetDatabase();
    const source = new SparseSource(chain, 60_000);
    const poller = new Poller({
      source,
      usdgAddress: USDG,
      startBlock: 0n,
      blockRange: 2_000,
      maxBlockRange: 50_000,
      tokenReader: fixtureTokenReader,
    });
    await poller.syncToHead();
    const atHead = await poller.runPass();
    expect(atHead.blockRange).toBeLessThanOrEqual(2_000);
  });

  it('produces byte-identical rows to a fixed window', async () => {
    // The requirement the speed-up must not have cost. §9 compares a
    // block-zero run against an incremental one; a window that changes size
    // mid-sync is a harder version of the same comparison.
    await resetDatabase();
    await new Poller({
      source: new SparseSource(chain, 60_000),
      usdgAddress: USDG,
      startBlock: 0n,
      blockRange: 2_000,
      maxBlockRange: 50_000,
      tokenReader: fixtureTokenReader,
    }).syncToHead();
    const adaptive = await prisma.$queryRaw<Record<string, string>[]>`
      SELECT pool_id, to_char(hour, 'YYYY-MM-DD HH24:MI') AS hour,
             fees_token0::text AS f0, fees_token1::text AS f1,
             fees_usd::text AS usd, swaps::text AS n
      FROM pool_fee_hourly ORDER BY pool_id, hour
    `;

    await resetDatabase();
    await new Poller({
      source: new SparseSource(chain, 60_000),
      usdgAddress: USDG,
      startBlock: 0n,
      // Floor and ceiling equal: no adaptation at all.
      blockRange: 2_000,
      maxBlockRange: 2_000,
      tokenReader: fixtureTokenReader,
    }).syncToHead();
    const fixed = await prisma.$queryRaw<Record<string, string>[]>`
      SELECT pool_id, to_char(hour, 'YYYY-MM-DD HH24:MI') AS hour,
             fees_token0::text AS f0, fees_token1::text AS f1,
             fees_usd::text AS usd, swaps::text AS n
      FROM pool_fee_hourly ORDER BY pool_id, hour
    `;

    expect(adaptive.length).toBeGreaterThan(50);
    expect(adaptive).toEqual(fixed);
  });
});
