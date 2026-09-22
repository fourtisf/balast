/**
 * The 1970 cursor (repair-times.ts, chain/block-time.ts).
 *
 * A synced database is given exactly what the box had: rows from a stretch
 * of blocks stamped with the epoch, aggregate hours in 1970, and a cursor
 * whose chain time is 1 January 1970. One pass of a new process has to put
 * it right without deleting a row or moving the cursor — and the tables
 * afterwards have to equal a clean sync's, as text (§9).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIN_BLOCK_TIME_MS } from '../chain/block-time';
import { prisma } from '../db';
import { isReachable, resetDatabase } from '../test/db';
import { FixtureLogSource, USDG, buildFixtureChain, fixtureTokenReader } from '../test/fixture';
import { POOL_MANAGER_CURSOR, Poller, REBUILT_ANCHOR_KEY } from './poller';
import * as repair from './repair-times';

const chain = buildFixtureChain(2_500);

function poller(source: FixtureLogSource): Poller {
  return new Poller({ source, usdgAddress: USDG, startBlock: 0n, blockRange: chain.headBlock + 1, tokenReader: fixtureTokenReader });
}

async function feeRows() {
  return prisma.$queryRaw<{ pool_id: string; hour: Date; fees_usd: string; volume_usd: string; swaps: number }[]>`
    SELECT pool_id, hour, fees_usd::text AS fees_usd, volume_usd::text AS volume_usd, swaps
    FROM pool_fee_hourly ORDER BY pool_id, hour
  `;
}

beforeAll(async () => {
  if (!(await isReachable())) throw new Error('These tests need a Postgres at TEST_DATABASE_URL. See README.');
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('rows and a cursor stamped before the floor', () => {
  it('spells the cursor row and the marker the way the poller does', () => {
    expect(repair.POOL_MANAGER_CURSOR).toBe(POOL_MANAGER_CURSOR);
    expect(repair.REBUILT_ANCHOR_KEY).toBe(REBUILT_ANCHOR_KEY);
  });

  it('finds nothing to do on a healthy database', async () => {
    await resetDatabase();
    await poller(new FixtureLogSource(chain)).syncToHead();
    const before = await feeRows();
    const cursorBefore = await prisma.indexerCursor.findUniqueOrThrow({ where: { contract: POOL_MANAGER_CURSOR } });
    const done = await repair.repairBlockTimes(new FixtureLogSource(chain));
    expect(done).toEqual({ blocks: 0, rows: 0, unanswered: 0, hours: 0, cursorTimeFixed: false });
    expect(await feeRows()).toEqual(before);
    const cursorAfter = await prisma.indexerCursor.findUniqueOrThrow({ where: { contract: POOL_MANAGER_CURSOR } });
    expect(cursorAfter.lastIndexedAt).toEqual(cursorBefore.lastIndexedAt);
    expect(await prisma.indexerState.findUnique({ where: { key: REBUILT_ANCHOR_KEY } })).not.toBeNull();
  });

  it('re-times the bad rows in place on the first pass, moving nothing, and the tables end up as a clean sync leaves them', async () => {
    const clean = await feeRows();
    expect(clean.length).toBeGreaterThan(0);
    const epoch = new Date(0);
    const bad = 2_000n;
    // What the box had: a pass whose blocks were timed at the epoch.
    await prisma.$executeRaw`UPDATE swap_events SET block_time = ${epoch} WHERE block_num >= ${bad}`;
    await prisma.$executeRaw`UPDATE liquidity_events SET block_time = ${epoch} WHERE block_num >= ${bad}`;
    await prisma.$executeRaw`UPDATE indexer_cursors SET last_indexed_at = ${epoch} WHERE contract = ${POOL_MANAGER_CURSOR}`;
    await prisma.$executeRaw`
      INSERT INTO pool_fee_hourly (pool_id, hour, fees_token0, fees_token1, fees_usd, volume_usd, swaps)
      SELECT id, ${epoch}, 0, 0, 1, 1, 1 FROM pools LIMIT 1
    `;
    const corrupted = await prisma.swapEvent.count({ where: { blockTime: { lt: new Date(MIN_BLOCK_TIME_MS) } } });
    expect(corrupted).toBeGreaterThan(0);
    const swapsBefore = await prisma.swapEvent.count();
    const liquidityBefore = await prisma.liquidityEvent.count();

    // A new process: the repair runs ahead of its first pass and asks the
    // node for the real times; the pass itself is an ordinary one from the
    // cursor, and the priced tables are rebuilt in full.
    const source = new FixtureLogSource(chain);
    const p = poller(source);
    const pass = await p.runPass();
    // Not a rewind: the pass starts at the re-scan behind the cursor, not at the bad rows.
    expect(pass.fromBlock).toBeGreaterThan(bad);
    await p.syncToHead();

    // Every row kept, every one timed as the chain times it.
    expect(await prisma.swapEvent.count()).toBe(swapsBefore);
    expect(await prisma.liquidityEvent.count()).toBe(liquidityBefore);
    const retimed = await prisma.swapEvent.findMany({ where: { blockNum: { gte: bad } }, select: { blockNum: true, blockTime: true } });
    expect(retimed.length).toBeGreaterThan(0);
    for (const row of retimed) expect(row.blockTime).toEqual(chain.blockTime(Number(row.blockNum)));
    expect(await prisma.swapEvent.count({ where: { blockTime: { lt: new Date(MIN_BLOCK_TIME_MS) } } })).toBe(0);
    expect(await prisma.liquidityEvent.count({ where: { blockTime: { lt: new Date(MIN_BLOCK_TIME_MS) } } })).toBe(0);
    const [stale] = await prisma.$queryRaw<{ n: bigint }[]>`SELECT COUNT(*) AS n FROM pool_fee_hourly WHERE hour < ${new Date(MIN_BLOCK_TIME_MS)}`;
    expect(Number(stale.n)).toBe(0);
    const cursor = await prisma.indexerCursor.findUniqueOrThrow({ where: { contract: POOL_MANAGER_CURSOR } });
    expect(cursor.lastIndexedAt).toEqual(chain.blockTime(chain.headBlock));
    expect(cursor.lastIndexedBlock).toBe(BigInt(chain.headBlock));
    expect(await feeRows()).toEqual(clean);
  });

  it('restores the cursor time from the newest row when only the cursor was wrong', async () => {
    const epoch = new Date(0);
    await prisma.$executeRaw`UPDATE indexer_cursors SET last_indexed_at = ${epoch} WHERE contract = ${POOL_MANAGER_CURSOR}`;
    const done = await repair.repairBlockTimes(null);
    expect(done.rows).toBe(0);
    expect(done.blocks).toBe(0);
    expect(done.cursorTimeFixed).toBe(true);
    const cursor = await prisma.indexerCursor.findUniqueOrThrow({ where: { contract: POOL_MANAGER_CURSOR } });
    expect(cursor.lastIndexedAt.getTime()).toBeGreaterThanOrEqual(MIN_BLOCK_TIME_MS);
  });
});
