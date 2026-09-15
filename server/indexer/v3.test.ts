/**
 * v3 pool discovery through the factory (§4).
 *
 * v4 announces every pool on one PoolManager. v3 announces it on the factory
 * and then emits everything else from the pool's own address — so a v3 pool
 * is only discoverable through `PoolCreated`, and a hand-maintained list
 * silently omits every pool nobody thought to add. §4 says some older pools on
 * this chain are v3, so that omission would be real.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../db';
import { isReachable, resetDatabase } from '../test/db';
import {
  FixtureLogSource,
  USDG,
  V3_FACTORY,
  V3_POOL,
  V3_POOL_ID,
  buildV3Chain,
  fixtureTokenReader,
} from '../test/fixture';
import { Poller } from './poller';

const chain = buildV3Chain();

function poller(source: FixtureLogSource, blockRange: number, withFactory = true): Poller {
  return new Poller({
    source,
    usdgAddress: USDG,
    startBlock: 0n,
    blockRange,
    v3Factory: withFactory ? V3_FACTORY : null,
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

describe('the v3 factory', () => {
  it('discovers a v3 pool, and indexes its swaps on the next pass', async () => {
    await resetDatabase();
    const source = new FixtureLogSource(chain, 0);
    const p = poller(source, 100);

    // Pass over the range holding PoolCreated. The pool's own swaps come
    // from an address we were not watching when those logs were fetched.
    source.setHead(100);
    await p.syncToHead();

    const pool = await prisma.pool.findUnique({ where: { id: V3_POOL_ID } });
    expect(pool).not.toBeNull();
    expect(pool!.protocol).toBe('v3');
    expect(pool!.address).toBe(V3_POOL.toLowerCase());
    // 3000 pips on chain; the UI renders it from bips.
    expect(pool!.feeTier).toBe(3000);
    expect(pool!.tickSpacing).toBe(60);
    // v3 has no hooks — null rather than the zero address, so the launchpad
    // classifier cannot mistake it for an unrecognised hook.
    expect(pool!.hooks).toBeNull();
    expect(pool!.stakeable).toBe(true);

    // The 32-block re-scan (§4.1) is what picks up the swaps it emitted
    // before we started watching its address. Doing a second job for free.
    source.setHead(200);
    await p.syncToHead();

    const swaps = await prisma.swapEvent.count({ where: { poolId: V3_POOL_ID } });
    expect(swaps).toBeGreaterThan(0);
  });

  it('attributes v3 fees at the pool\'s tier, since the event carries none', async () => {
    // v4's Swap event carries the fee actually charged; v3's does not, so the
    // tier has to come from the pool row. A zero here means the tier lookup
    // silently failed and every v3 pool would show no fees at all.
    const [row] = await prisma.$queryRaw<{ attributed: number; zero: number }[]>`
      SELECT COUNT(*) FILTER (WHERE fee_amount > 0)::int  AS attributed,
             COUNT(*) FILTER (WHERE fee_amount = 0)::int  AS zero
      FROM swap_events WHERE pool_id = ${V3_POOL_ID}
    `;
    expect(row.attributed).toBeGreaterThan(0);
    expect(row.zero).toBe(0);
  });

  it('counts a swap that pays the token as a sell, and only as a sell', async () => {
    // Every v3 swap in the fixture pays NVDA into the pool for WETH: the
    // trader is selling the token. The split reads the input side.
    const [row] = await prisma.$queryRaw<{ swaps: number; buys: number; sells: number; vol: string; sold: string }[]>`
      SELECT SUM(swaps)::int AS swaps, SUM(buys)::int AS buys, SUM(sells)::int AS sells,
             SUM(volume_usd)::text AS vol, SUM(sell_volume_usd)::text AS sold
      FROM pool_fee_hourly WHERE pool_id = ${V3_POOL_ID}
    `;
    expect(row.swaps).toBeGreaterThan(0);
    expect(row.sells).toBe(row.swaps);
    expect(row.buys).toBe(0);
    expect(row.sold).toBe(row.vol);
  });

  it('reads amounts straight off v3 Mint, which carries them', async () => {
    // The v4 path has to derive them from a liquidity delta; v3 does not.
    const mint = await prisma.liquidityEvent.findFirst({ where: { poolId: V3_POOL_ID } });
    expect(mint).not.toBeNull();
    expect(Number(mint!.amount0)).toBeGreaterThan(0);
    expect(Number(mint!.amount1)).toBeGreaterThan(0);
    expect(Number(mint!.liquidityDelta)).toBeGreaterThan(0);
  });

  it('prices the v3 pool through the same anchor as a v4 one', async () => {
    const state = await prisma.poolState.findUnique({ where: { poolId: V3_POOL_ID } });
    expect(state).not.toBeNull();
    expect(Number(state!.priceUsd)).toBeGreaterThan(0);
    expect(Number(state!.tvlUsd)).toBeGreaterThan(0);
  });

  it('keeps following the pool after a restart', async () => {
    // A fresh Poller has no memory of the pool, and v3 log filters name each
    // pool's own address — so without reloading from the database a restart
    // would quietly stop indexing every v3 pool it had found.
    const before = await prisma.swapEvent.count({ where: { poolId: V3_POOL_ID } });

    const cursor = await prisma.indexerCursor.findFirstOrThrow();
    await prisma.indexerCursor.update({
      where: { contract: cursor.contract },
      data: { lastIndexedBlock: 30n },
    });

    const restarted = poller(new FixtureLogSource(chain), 400);
    await restarted.syncToHead();

    expect(await prisma.swapEvent.count({ where: { poolId: V3_POOL_ID } })).toBe(before);
  });

  it('backfills a v3 pool the factory named before the factory was followed', async () => {
    // The live box: the factory was configured with the cursor millions of
    // blocks in, so every PoolCreated before that was never read and WIF's
    // real market — a v3 pool — was absent while a hooked v4 pool stood for
    // the token. A poller that gains the factory late has to read the
    // factory's history and the pools' own, and end up where a poller that
    // followed it from the start would have.
    await resetDatabase();
    await poller(new FixtureLogSource(chain), 400, false).syncToHead();
    expect(await prisma.pool.findUnique({ where: { id: V3_POOL_ID } })).toBeNull();

    const lines: string[] = [];
    const late = new Poller({
      source: new FixtureLogSource(chain),
      usdgAddress: USDG,
      startBlock: 0n,
      blockRange: 400,
      v3Factory: V3_FACTORY,
      tokenReader: fixtureTokenReader,
      log: (line) => lines.push(line),
    });
    await late.syncToHead();

    const pool = await prisma.pool.findUnique({ where: { id: V3_POOL_ID } });
    expect(pool).not.toBeNull();
    expect(await prisma.swapEvent.count({ where: { poolId: V3_POOL_ID } })).toBeGreaterThan(0);
    expect(lines.some((l) => l.includes('v3 history') && l.includes('rebuilding'))).toBe(true);
    const state = await prisma.poolState.findUnique({ where: { poolId: V3_POOL_ID } });
    expect(Number(state!.tvlUsd)).toBeGreaterThan(0);
    const backfilled = await prisma.$queryRaw<Record<string, string>[]>`
      SELECT pool_id, to_char(hour, 'YYYY-MM-DD HH24:MI') AS hour,
             fees_token0::text AS f0, fees_token1::text AS f1, fees_usd::text AS usd, swaps::text AS n
      FROM pool_fee_hourly ORDER BY pool_id, hour
    `;

    // Nothing left to read on the next start, and nothing read twice.
    const swapsBefore = await prisma.swapEvent.count();
    await poller(new FixtureLogSource(chain), 400).runPass();
    expect(await prisma.swapEvent.count()).toBe(swapsBefore);

    // The same rows as a poller that followed the factory from the start.
    await resetDatabase();
    await poller(new FixtureLogSource(chain), 400).syncToHead();
    const throughout = await prisma.$queryRaw<Record<string, string>[]>`
      SELECT pool_id, to_char(hour, 'YYYY-MM-DD HH24:MI') AS hour,
             fees_token0::text AS f0, fees_token1::text AS f1, fees_usd::text AS usd, swaps::text AS n
      FROM pool_fee_hourly ORDER BY pool_id, hour
    `;
    expect(backfilled.length).toBeGreaterThan(0);
    expect(backfilled).toEqual(throughout);
  });

  it('finds nothing v3 at all when the factory is not configured', async () => {
    // The gap this whole feature closes: without V3_FACTORY the only v3 pools
    // are the ones hand-listed in V3_POOLS.
    await resetDatabase();
    const source = new FixtureLogSource(chain);
    await poller(source, 400, false).syncToHead();

    expect(await prisma.pool.count({ where: { protocol: 'v3' } })).toBe(0);
    // The v4 anchor is still indexed, so this is the factory's absence and
    // not a broken pass.
    expect(await prisma.pool.count({ where: { protocol: 'v4' } })).toBe(1);
  });

  it('follows a hand-listed pool even with no factory', async () => {
    await resetDatabase();
    const source = new FixtureLogSource(chain);
    await new Poller({
      source,
      usdgAddress: USDG,
      startBlock: 0n,
      blockRange: 400,
      v3Factory: null,
      v3Pools: [V3_POOL],
      tokenReader: fixtureTokenReader,
    }).syncToHead();

    // Its logs are fetched, but with no PoolCreated there is no pool row for
    // them to attach to, so they are dropped and the poller says so. That is
    // the honest outcome: a swap counted against a pool we know nothing about
    // would have no tier, no tokens and no decimals.
    expect(await prisma.pool.count({ where: { protocol: 'v3' } })).toBe(0);
    expect(await prisma.swapEvent.count({ where: { poolId: V3_POOL_ID } })).toBe(0);
  });
});
