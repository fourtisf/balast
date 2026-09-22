/**
 * Rows stamped with a time that is not a time, re-timed in place.
 *
 * Before chain/block-time.ts refused them, an endpoint's zeroed timestamp
 * went straight into the pass: the cursor's chain time became 1 January
 * 1970, the top bar read "20718d behind", and every row of that pass — its
 * swaps, its liquidity events, its transfers — carried the epoch, so the
 * hourly tables gained rows in 1970 that no trailing window would ever
 * reach. The source refuses such a stamp now; this puts right what was
 * written before it did.
 *
 * The rows are correct in everything but their time, and the time is one
 * `getBlock` away: the block numbers are on the rows. So the repair asks
 * the node for those blocks' timestamps and writes them onto the rows,
 * deletes the aggregate hours before the floor, restores the cursor's own
 * time from the newest row, and forces the full rebuild so no stale hour
 * survives. Nothing is deleted from the raw tables and the cursor is not
 * moved. The first version of this deleted the rows and rewound the cursor
 * to before the earliest of them, which on the box was block 305,284 — a
 * re-read of four million blocks to recover rows that were never wrong
 * about anything but their clock (§24). A block the node will not answer
 * for is left as it is, logged, and tried again on the next start.
 *
 * Runs on every start; on a healthy box it finds nothing and changes
 * nothing.
 */

import { CONTRACTS } from '../../lib/chain';
import { MIN_BLOCK_TIME_MS, isSaneBlockTime } from '../chain/block-time';
import { prisma } from '../db';
import type { LogSource } from './poller';

/**
 * The poller's cursor row and its rebuilt-anchor marker, spelled here the
 * way poller.ts spells them rather than imported from it (the poller
 * imports this file). The repair suite asserts the two agree.
 */
export const POOL_MANAGER_CURSOR = `v4:${CONTRACTS.poolManager.toLowerCase()}`;
export const REBUILT_ANCHOR_KEY = 'rebuilt_anchor';

/** Blocks asked for at a time; the source batches them into as few requests as it can. */
const CHUNK = 200;

export interface TimeRepair {
  /** Distinct blocks whose rows carried a time before the floor. */
  blocks: number;
  /** Rows given their real time. */
  rows: number;
  /** Blocks the node would not answer for; their rows are left and tried again next start. */
  unanswered: number;
  /** Aggregate rows (hours before the floor) deleted. */
  hours: number;
  /** Whether the cursor's own chain time was replaced. */
  cursorTimeFixed: boolean;
}

export async function repairBlockTimes(
  source: LogSource | null,
  log: (message: string) => void = () => {},
): Promise<TimeRepair> {
  const floor = new Date(MIN_BLOCK_TIME_MS);
  const result: TimeRepair = { blocks: 0, rows: 0, unanswered: 0, hours: 0, cursorTimeFixed: false };

  const bad = await prisma.$queryRaw<{ block_num: bigint }[]>`
    SELECT DISTINCT block_num FROM (
      SELECT block_num FROM swap_events        WHERE block_time < ${floor}
      UNION
      SELECT block_num FROM liquidity_events   WHERE block_time < ${floor}
      UNION
      SELECT block_num FROM position_transfers WHERE block_time < ${floor}
    ) t ORDER BY block_num
  `;
  result.blocks = bad.length;

  if (bad.length > 0) {
    if (!source) {
      log(`  block times: ${bad.length} block(s) carry a time before ${floor.toISOString().slice(0, 10)} and no source is at hand to re-time them`);
      result.unanswered = bad.length;
    } else {
      log(`  block times: ${bad.length} block(s) carry a time before ${floor.toISOString().slice(0, 10)}; asking the node for their real times`);
      for (let i = 0; i < bad.length; i += CHUNK) {
        const chunk = bad.slice(i, i + CHUNK).map((r) => BigInt(r.block_num));
        let times: Map<bigint, Date>;
        try {
          times = await source.timeBlocks(chunk);
        } catch (error) {
          log(`  block times: the node refused ${chunk.length} block(s) (${(error as Error).message.split('\n')[0]}); left for the next start`);
          result.unanswered += chunk.length;
          continue;
        }
        for (const block of chunk) {
          const time = times.get(block);
          if (!time || !isSaneBlockTime(time)) {
            result.unanswered++;
            continue;
          }
          for (const table of ['swap_events', 'liquidity_events', 'position_transfers']) {
            result.rows += await prisma.$executeRawUnsafe(
              `UPDATE ${table} SET block_time = $1 WHERE block_num = $2 AND block_time < $3`,
              time,
              block,
              floor,
            );
          }
        }
        if ((i / CHUNK) % 10 === 9) log(`  block times: ${Math.min(i + CHUNK, bad.length)} of ${bad.length} block(s) re-timed`);
      }
    }
  }

  // The hours those rows were aggregated into: an hour in 1970 is stale by
  // definition, and the full rebuild below puts the rows in their real hours.
  for (const table of ['weth_usd_hourly', 'pool_flow_hourly', 'pool_fee_hourly']) {
    result.hours += await prisma.$executeRawUnsafe(`DELETE FROM ${table} WHERE hour < $1`, floor);
  }

  const cursor = await prisma.indexerCursor.findUnique({ where: { contract: POOL_MANAGER_CURSOR } });
  if (cursor && (cursor.lastIndexedAt.getTime() < MIN_BLOCK_TIME_MS || result.rows > 0)) {
    const [newest] = await prisma.$queryRaw<{ at: Date | null }[]>`
      SELECT MAX(block_time) AS at FROM (
        SELECT block_time FROM swap_events      WHERE block_num <= ${cursor.lastIndexedBlock}
        UNION ALL
        SELECT block_time FROM liquidity_events WHERE block_num <= ${cursor.lastIndexedBlock}
      ) t
    `;
    if (newest?.at && isSaneBlockTime(newest.at) && newest.at.getTime() !== cursor.lastIndexedAt.getTime()) {
      await prisma.indexerCursor.update({ where: { contract: POOL_MANAGER_CURSOR }, data: { lastIndexedAt: newest.at } });
      result.cursorTimeFixed = true;
    }
  }

  if (result.rows > 0 || result.hours > 0 || result.cursorTimeFixed) {
    // Every priced table is rebuilt from the raw rows on the next pass.
    await prisma.indexerState.deleteMany({ where: { key: REBUILT_ANCHOR_KEY } });
    log(
      `  block times: ${result.rows} row(s) across ${result.blocks - result.unanswered} block(s) re-timed, ` +
        `${result.hours} aggregate hour(s) before the floor dropped` +
        (result.unanswered > 0 ? `, ${result.unanswered} block(s) unanswered and left for the next start` : '') +
        (result.cursorTimeFixed ? '; cursor time restored from the newest row' : '') +
        ' — priced tables will be rebuilt in full',
    );
  }
  return result;
}
