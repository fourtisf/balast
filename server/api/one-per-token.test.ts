/**
 * One row per token.
 *
 * The first real board listed CASHCAT twice and the ether market twice: a
 * token on this chain routinely has several pools, and the query returned
 * one row per pool. The board is a token listing (§6), so a token's row is
 * its deepest pool — the one the Stake button opens — and the shallower
 * pools stay indexed and unlisted.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../db';
import { Poller } from '../indexer/poller';
import { isReachable, resetDatabase } from '../test/db';
import {
  FIXTURE_POOLS,
  FixtureLogSource,
  USDG,
  buildFixtureChain,
  fixtureTokenReader,
  type FixturePool,
} from '../test/fixture';
import { buildSnapshot } from './snapshot';

/** The default pools plus a second, shallower NVDA/WETH pool at another fee tier. */
const nvda = FIXTURE_POOLS[1];
const DUPLICATE_POOLS: FixturePool[] = [
  ...FIXTURE_POOLS,
  {
    ...nvda,
    id: `0x${'d1'.padStart(64, '0')}` as `0x${string}`,
    feePips: 10_000,
    tickSpacing: 200,
    liquidity: nvda.liquidity / 5n,
    initBlock: 2,
  },
];
const chain = buildFixtureChain(3_000, 4663, DUPLICATE_POOLS);

beforeAll(async () => {
  if (!(await isReachable())) {
    throw new Error('These tests need a Postgres at TEST_DATABASE_URL. See README.');
  }
  await resetDatabase();
  await new Poller({
    source: new FixtureLogSource(chain),
    usdgAddress: USDG,
    startBlock: 0n,
    blockRange: chain.headBlock + 1,
    tokenReader: fixtureTokenReader,
  }).syncToHead();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('a token with two pools', () => {
  it('is one row, and the row is its deepest pool', async () => {
    // Both pools are indexed.
    expect(await prisma.pool.count()).toBe(DUPLICATE_POOLS.filter((p) => p.initBlock <= 3_000).length);

    const snapshot = await buildSnapshot({ usdgAddress: USDG, minFdvUsd: 0 });
    const rows = snapshot!.pools.filter((p) => p.token.symbol === 'NVDA');
    expect(rows).toHaveLength(1);

    // The deeper of the two, by TVL, is the one listed.
    const states = await prisma.$queryRaw<{ pool_id: string; tvl: number }[]>`
      SELECT ps.pool_id, ps.tvl_usd::float8 AS tvl
      FROM pool_state ps JOIN pools p ON p.id = ps.pool_id
      WHERE lower(p.token0) = ${nvda.currency0.toLowerCase()}
      ORDER BY ps.tvl_usd DESC`;
    expect(states).toHaveLength(2);
    expect(states[0].tvl).toBeGreaterThan(states[1].tvl);
    expect(rows[0].id).toBe(states[0].pool_id);

    // No token appears twice, anywhere on the board.
    const symbols = snapshot!.pools.map((p) => p.token.address);
    expect(new Set(symbols).size).toBe(symbols.length);
  });

  it('keeps the shallower pool, off the board, for the builder to offer', async () => {
    // Collapsed away entirely, a person choosing where to provide liquidity
    // was offered whichever pool happened to be deepest and nothing else —
    // so a wallet holding ether saw a token's USDG pool with "Balance 0"
    // beside the deposit box and no way to pick the ether market (§26). The
    // board stays one row per token; the other markets ride beside it.
    const snapshot = await buildSnapshot({ usdgAddress: USDG, minFdvUsd: 0 });
    const board = snapshot!.pools.filter((p) => p.token.symbol === 'NVDA');
    const rest = (snapshot!.otherPools ?? []).filter((p) => p.token.symbol === 'NVDA');
    expect(board).toHaveLength(1);
    expect(rest).toHaveLength(1);
    expect(rest[0].id).not.toBe(board[0].id);

    // A pool worth minting into: it carries its key and its fee tier.
    expect(rest[0].feeTierBps).not.toBe(board[0].feeTierBps);
    expect(rest[0].key).toBeDefined();

    // And nothing on the board is repeated in it, so no total counts twice.
    const boardIds = new Set(snapshot!.pools.map((p) => p.id));
    for (const p of snapshot!.otherPools ?? []) expect(boardIds.has(p.id)).toBe(false);

    // No sparkline: nothing draws one for these, and the page polls.
    expect(rest[0].feeHistory).toEqual([]);
    expect(rest[0].volumeHistory).toEqual([]);
  });
});
