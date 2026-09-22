/**
 * Rows stamped with a time that is not a time, undone.
 *
 * Before chain/block-time.ts refused them, an endpoint's zeroed timestamp
 * went straight into the pass: the cursor's chain time became 1 January
 * 1970, the top bar read "20718d behind", and every row of that pass — its
 * swaps, its liquidity events, its transfers — carried the epoch, so the
 * hourly tables gained rows in 1970 that no trailing window would ever
 * reach. The source refuses such a stamp now; this puts right what was
 * written before it did.
 *
 * The repair is a rewind, not a guess. Rows before the floor are deleted,
 * the aggregate hours before it with them, and the cursor is moved back to
 * the block before the earliest of them — so the next pass reads those
 * blocks again, times them properly, and the rebuild-never-increment rule
 * (§14) does the rest. The cursor's own time is set from the newest row
 * still in the tables, and the full rebuild is forced so no stale hour
 * survives. Runs on every start; on a healthy box it finds nothing and
 * changes nothing.
 */

import { CONTRACTS } from '../../lib/chain';
import { MIN_BLOCK_TIME_MS } from '../chain/block-time';
import { prisma } from '../db';

/**
 * The poller's cursor row and its rebuilt-anchor marker, spelled here the
 * way poller.ts spells them rather than imported from it (the poller
 * imports this file). The repair suite asserts the two agree.
 */
export const POOL_MANAGER_CURSOR = `v4:${CONTRACTS.poolManager.toLowerCase()}`;
export const REBUILT_ANCHOR_KEY = 'rebuilt_anchor';

export interface TimeRepair {
  /** Raw rows deleted for carrying a time before the floor. */
  rows: number;
  /** Aggregate rows (hours before the floor) deleted. */
  hours: number;
  /** The block the cursor was moved back to, when it was. */
  rewoundTo: bigint | null;
  /** Whether the cursor's own chain time was replaced. */
  cursorTimeFixed: boolean;
}

export async function repairBlockTimes(log: (message: string) => void = () => {}): Promise<TimeRepair> {
  const floor = new Date(MIN_BLOCK_TIME_MS);
  const result: TimeRepair = { rows: 0, hours: 0, rewoundTo: null, cursorTimeFixed: false };

  const [bad] = await prisma.$queryRaw<{ min_block: bigint | null; rows: bigint }[]>`
    SELECT MIN(block_num) AS min_block, COUNT(*) AS rows FROM (
      SELECT block_num FROM swap_events      WHERE block_time < ${floor}
      UNION ALL
      SELECT block_num FROM liquidity_events WHERE block_time < ${floor}
      UNION ALL
      SELECT block_num FROM position_transfers WHERE block_time < ${floor}
    ) t
  `;
  const cursor = await prisma.indexerCursor.findUnique({ where: { contract: POOL_MANAGER_CURSOR } });

  if (bad.min_block !== null) {
    result.rows = Number(bad.rows);
    await prisma.$executeRaw`DELETE FROM swap_events WHERE block_time < ${floor}`;
    await prisma.$executeRaw`DELETE FROM liquidity_events WHERE block_time < ${floor}`;
    await prisma.$executeRaw`DELETE FROM position_transfers WHERE block_time < ${floor}`;
  }
  // The hours those rows were aggregated into, whether or not the rows are
  // still here: an hour in 1970 is stale by definition.
  for (const table of ['weth_usd_hourly', 'pool_flow_hourly', 'pool_fee_hourly']) {
    result.hours += await prisma.$executeRawUnsafe(`DELETE FROM ${table} WHERE hour < $1`, floor);
  }

  if (cursor) {
    const data: { lastIndexedBlock?: bigint; lastIndexedAt?: Date } = {};
    if (bad.min_block !== null) {
      const rewind = BigInt(bad.min_block) - 1n;
      if (rewind < cursor.lastIndexedBlock) {
        data.lastIndexedBlock = rewind < 0n ? 0n : rewind;
        result.rewoundTo = data.lastIndexedBlock;
      }
    }
    if (cursor.lastIndexedAt.getTime() < MIN_BLOCK_TIME_MS || data.lastIndexedBlock !== undefined) {
      const upTo = data.lastIndexedBlock ?? cursor.lastIndexedBlock;
      const [newest] = await prisma.$queryRaw<{ at: Date | null }[]>`
        SELECT MAX(block_time) AS at FROM (
          SELECT block_time FROM swap_events      WHERE block_num <= ${upTo}
          UNION ALL
          SELECT block_time FROM liquidity_events WHERE block_num <= ${upTo}
        ) t
      `;
      if (newest?.at && newest.at.getTime() >= MIN_BLOCK_TIME_MS && newest.at.getTime() !== cursor.lastIndexedAt.getTime()) {
        data.lastIndexedAt = newest.at;
        result.cursorTimeFixed = true;
      }
    }
    if (Object.keys(data).length > 0) {
      await prisma.indexerCursor.update({ where: { contract: POOL_MANAGER_CURSOR }, data });
    }
  }

  if (result.rows > 0 || result.hours > 0 || result.rewoundTo !== null || result.cursorTimeFixed) {
    // Every priced table is rebuilt from the raw rows on the next pass.
    await prisma.indexerState.deleteMany({ where: { key: REBUILT_ANCHOR_KEY } });
    log(
      `  block times: ${result.rows} row(s) and ${result.hours} aggregate hour(s) carried a time before ${floor.toISOString().slice(0, 10)}` +
        (result.rewoundTo !== null ? `; cursor rewound to block ${result.rewoundTo} to read them again` : '') +
        (result.cursorTimeFixed ? '; cursor time restored from the newest row' : '') +
        ' — priced tables will be rebuilt in full',
    );
  }
  return result;
}
