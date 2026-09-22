/**
 * The chain's head beside a backfill that is still weeks behind it (§25).
 *
 * Two properties matter here, and the second matters more.
 *
 * It has to be RIGHT: the day's volume, its split and the 24h move computed
 * from the last day of blocks, with the same arithmetic the indexer uses, so
 * a pool's live figure and its figure once the backfill arrives are the same
 * number reached two ways.
 *
 * And it has to be SEALED. Reserves are the sum of a pool's whole event
 * history, and §9's replay proof rests on the same completeness — so a window
 * of recent blocks with a gap behind it must not reach `swap_events`,
 * `pool_flow_hourly`, `pool_fee_hourly` or `pool_state`. The test that would
 * catch a leak is the one that snapshots every one of those tables around a
 * head pass and asserts nothing moved.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../db';
import { isReachable, resetDatabase } from '../test/db';
import { FIXTURE_BLOCK_SECONDS, FixtureLogSource, USDG, buildFixtureChain, fixtureTokenReader } from '../test/fixture';
import { recentEthPrice, recentMarket } from '../api/recent';
import { HeadFollower } from './head';
import { Poller } from './poller';

const chain = buildFixtureChain();
/** The backfill stops here; head is far beyond it, as on the box. */
const BACKFILL_TO = 6_000;

/** The fixture's blocks are a minute apart (see fixture.ts), not the chain's 100ms. */
const BLOCK_MS = FIXTURE_BLOCK_SECONDS * 1000;

function follower(): HeadFollower {
  return new HeadFollower({
    source: new FixtureLogSource(chain),
    windowHours: 24,
    blockMs: BLOCK_MS,
    blockRange: 400n,
    concurrency: 4,
  });
}

/** Every table the head reader must not touch, as text so nothing is rounded away. */
async function indexerTables(): Promise<unknown> {
  return {
    swaps: await prisma.$queryRaw`SELECT tx_hash, log_index, amount0::text, amount1::text FROM swap_events ORDER BY tx_hash, log_index`,
    fees: await prisma.$queryRaw`SELECT pool_id, hour, fees_usd::text AS f, volume_usd::text AS v, swaps FROM pool_fee_hourly ORDER BY pool_id, hour`,
    flow: await prisma.$queryRaw`SELECT pool_id, hour, delta0::text AS d0, delta1::text AS d1 FROM pool_flow_hourly ORDER BY pool_id, hour`,
    state: await prisma.$queryRaw`SELECT pool_id, tvl_usd::text AS tvl, price_usd::text AS price FROM pool_state ORDER BY pool_id`,
  };
}

beforeAll(async () => {
  if (!(await isReachable())) {
    throw new Error('These tests need a Postgres at TEST_DATABASE_URL. See README.');
  }
  await resetDatabase();
  // The backfill, stopped a long way short of head — which is the state the
  // real box is in for days, and the whole reason this reader exists.
  const source = new FixtureLogSource(chain, BACKFILL_TO);
  await new Poller({
    source,
    usdgAddress: USDG,
    startBlock: 0n,
    blockRange: 2_000,
    tokenReader: fixtureTokenReader,
  }).syncToHead();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('the head reader', () => {
  it('reads the last day of blocks and nothing below it', async () => {
    const head = follower();
    const window = head.windowBlocks();
    expect(window).toBe(BigInt((24 * 3600 * 1000) / BLOCK_MS));

    let passes = 0;
    let result = await head.pass();
    while (result.behind > 0n && passes < 100) {
      result = await head.pass();
      passes++;
    }
    expect(result.behind).toBe(0n);

    const rows = await prisma.recentSwap.findMany({ select: { blockNum: true } });
    expect(rows.length).toBeGreaterThan(0);
    const lowest = rows.reduce((a, r) => (r.blockNum < a ? r.blockNum : a), rows[0].blockNum);
    // Below the window is history the backfill owns.
    expect(lowest).toBeGreaterThanOrEqual(BigInt(chain.headBlock) - window);
  });

  it('touches nothing the indexer owns', async () => {
    // The property the whole design rests on. A head row reaching the flow
    // table would make every liquidity figure on the site wrong, because
    // reserves are a sum over a history this window has a hole behind it.
    const before = await indexerTables();
    await follower().pass();
    expect(await indexerTables()).toEqual(before);
  });

  it('answers the day from the chain, and the split sums to the volume', async () => {
    const now = await recentMarket(USDG);
    expect(now.size).toBeGreaterThan(0);

    for (const [, row] of now) {
      expect(row.volume24hUsd).toBeGreaterThanOrEqual(0);
      expect(row.buys24h + row.sells24h).toBe(row.trades24h);
      // The same swaps split two ways: the dollars have to add back up.
      expect(row.buyVolume24hUsd + row.sellVolume24hUsd).toBeCloseTo(row.volume24hUsd, 6);
      expect(Number.isFinite(row.volume24hUsd)).toBe(true);
    }

    // And it is a different day from the backfill's, which is what it is for.
    const cursor = await prisma.indexerCursor.findFirstOrThrow({ where: { contract: { startsWith: 'v4:' } } });
    const newest = await prisma.recentSwap.aggregate({ _max: { blockTime: true } });
    expect(newest._max.blockTime!.getTime()).toBeGreaterThan(cursor.lastIndexedAt.getTime());
  });

  it('prices ether from the anchor pool at the head, not at the backfill', async () => {
    const atHead = await recentEthPrice(USDG);
    expect(atHead).not.toBeNull();
    expect(atHead!.usd).toBeGreaterThan(0);
    const cursor = await prisma.indexerCursor.findFirstOrThrow({ where: { contract: { startsWith: 'v4:' } } });
    expect(Date.parse(atHead!.at)).toBeGreaterThan(cursor.lastIndexedAt.getTime());
  });

  it('is idempotent: the same blocks read again change nothing', async () => {
    const before = await prisma.recentSwap.count();
    const sums = await prisma.$queryRaw<{ v: string }[]>`SELECT SUM(fee_amount)::text AS v FROM recent_swaps`;
    // Rewind its cursor so the next pass re-reads blocks it already has.
    await prisma.indexerCursor.updateMany({
      where: { contract: { startsWith: 'head:' } },
      data: { lastIndexedBlock: BigInt(chain.headBlock) - 500n },
    });
    await follower().pass();
    expect(await prisma.recentSwap.count()).toBe(before);
    expect(await prisma.$queryRaw<{ v: string }[]>`SELECT SUM(fee_amount)::text AS v FROM recent_swaps`).toEqual(sums);
  });

  it("puts today's figure on the board, where the backfill's day was", async () => {
    // End to end: the snapshot a page receives carries the head's day, and
    // the row shows it. Without this the reader could be perfect and the
    // board would still read `chain` on every row.
    const { buildSnapshot } = await import('../api/snapshot');
    const { shownVolume } = await import('../../lib/market-figures');
    const snapshot = await buildSnapshot({ usdgAddress: USDG, minFdvUsd: 0, minBackingUsd: 0 });
    expect(snapshot).not.toBeNull();

    const withHead = snapshot!.pools.filter((p) => p.now);
    expect(withHead.length).toBeGreaterThan(0);
    for (const p of withHead) {
      const volume = shownVolume(p);
      expect(volume.basis).toBe('chain-now');
      expect(volume.value).toBe(p.now!.volume24hUsd);
    }
    // And the masthead's ETH price is the head's, not the backfill's.
    expect(snapshot!.global.ethPriceBasis).toBe('chain-now');
  });

  it('prunes what has fallen out of the window', async () => {
    const stale = await prisma.recentSwap.findFirst({ orderBy: { blockNum: 'asc' } });
    expect(stale).not.toBeNull();
    // Push one row far into the past and run a pass: it goes.
    await prisma.recentSwap.update({
      where: { txHash_logIndex: { txHash: stale!.txHash, logIndex: stale!.logIndex } },
      data: { blockTime: new Date(chain.blockTime(chain.headBlock).getTime() - 40 * 3600_000) },
    });
    await prisma.indexerCursor.updateMany({
      where: { contract: { startsWith: 'head:' } },
      data: { lastIndexedBlock: BigInt(chain.headBlock) - 10n },
    });
    await follower().pass();
    const still = await prisma.recentSwap.findUnique({
      where: { txHash_logIndex: { txHash: stale!.txHash, logIndex: stale!.logIndex } },
    });
    expect(still).toBeNull();
  });
});
