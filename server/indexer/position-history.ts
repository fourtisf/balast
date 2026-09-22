/**
 * The positions minted before PositionManager was followed (§23).
 *
 * The poller reads PositionManager's Transfer logs and the salt on the
 * PoolManager's ModifyLiquidity on every pass — from the pass that first
 * ran this code. On a box whose cursor was millions of blocks in by then,
 * every position minted before it was never read: no transfer row, and the
 * liquidity rows already in the table carry no salt, because the column did
 * not exist when they were written. A portfolio built from that would show
 * a wallet nothing it minted through Uniswap's own interface, and the
 * masthead's count would be short by every one of them.
 *
 * So the first pass walks the history from the start block to the block
 * PositionManager has been followed from (`position_history_block`,
 * advanced by every pass since): the Transfer logs at the one address, and
 * the ModifyLiquidity logs at the PoolManager, keeping those PositionManager
 * sent. Transfers are written as the poller writes them; a liquidity row
 * already in the table is given its salt, and nothing else about it changes
 * — its amounts were derived once from the log prefix (§9) and the salt is
 * a fact from the same log. Progress is remembered so a restart resumes, and
 * the stage heartbeats (working.ts) so health reads `working` while it runs.
 *
 * The same shape as the v3 factory's history (v3-history.ts), for the same
 * reason: a contract followed late has a past the main loop never saw.
 */

import { CHAIN, CONTRACTS } from '../../lib/chain';
import { MODIFY_LIQUIDITY_TOPIC, POSITION_TRANSFER_TOPIC } from '../chain/abi';
import { prisma } from '../db';
import { decodePoolManagerLog, decodePositionManagerLog, sortEvents, type ChainEvent } from './events';
import { planIngest } from './ingest';
import type { LogSource } from './poller';
import { writePositionTransfers } from './store';
import { asLog, readState, walk, writeState } from './v3-history';
import { withWork } from './working';

/** `indexer_state`: the block up to which PositionManager's history has been read. */
export const POSITION_HISTORY_KEY = 'position_history_block';

export interface PositionHistoryResult {
  /** Transfer rows written that were not in the table. */
  transfers: number;
  /** Liquidity rows that had no salt and have one now. */
  salted: number;
  windows: number;
}

export async function backfillPositionHistory(args: {
  source: LogSource;
  startBlock: bigint;
  /** The block PositionManager has been followed from; the cursor on a box that never followed it. */
  toBlock: bigint;
  window: bigint;
  maxWindow: bigint;
  log?: (message: string) => void;
}): Promise<PositionHistoryResult> {
  const log = args.log ?? (() => {});
  const positionManager = CONTRACTS.positionManager.toLowerCase();
  const poolManager = CONTRACTS.poolManager.toLowerCase();
  const scanned = await readState(POSITION_HISTORY_KEY);
  const from = scanned === null ? args.startBlock : max(args.startBlock, BigInt(scanned) + 1n);
  const result: PositionHistoryResult = { transfers: 0, salted: 0, windows: 0 };
  if (from > args.toBlock) return result;

  log(`  position history: reading PositionManager from block ${from} to ${args.toBlock}`);
  const filters = [
    { address: [positionManager], topics: [POSITION_TRANSFER_TOPIC] },
    { address: [poolManager], topics: [MODIFY_LIQUIDITY_TOPIC] },
  ];
  await withWork('position history', (note) =>
    walk(args.source, filters, from, args.toBlock, args.window, args.maxWindow, async (logs, w) => {
      result.windows++;
      note(`block ${w.to.toLocaleString()} of ${args.toBlock.toLocaleString()}, ${result.transfers} transfer(s) so far`);
      if (logs.length > 0) {
        const times = await args.source.getBlockTimes(w.from, w.to);
        const transfers: ChainEvent[] = [];
        const salts: { txHash: string; logIndex: number; salt: string }[] = [];
        for (const raw of logs) {
          const time = times.get(raw.blockNumber);
          if (!time) continue;
          const source = raw.address.toLowerCase();
          if (source === positionManager) {
            const decoded = decodePositionManagerLog(asLog(raw), time);
            if (decoded) transfers.push(decoded);
          } else if (source === poolManager) {
            const decoded = decodePoolManagerLog(asLog(raw), time);
            if (decoded?.kind === 'liquidity' && decoded.owner.toLowerCase() === positionManager && decoded.salt) {
              salts.push({ txHash: decoded.txHash, logIndex: decoded.logIndex, salt: decoded.salt });
            }
          }
        }
        if (transfers.length > 0) {
          const plan = planIngest(sortEvents(transfers), {
            chainId: CHAIN.id,
            sqrtPriceByPool: new Map(),
            feePipsByPool: new Map(),
          });
          result.transfers += await writePositionTransfers(plan);
        }
        if (salts.length > 0) result.salted += await saltLiquidityRows(salts);
      }
      await writeState(POSITION_HISTORY_KEY, w.to.toString());
      if (result.windows % 20 === 0) {
        log(`  position history: read to block ${w.to} of ${args.toBlock}, ${result.transfers} transfer(s), ${result.salted} row(s) salted`);
      }
    }),
  );
  return result;
}

/**
 * Give liquidity rows written before the salt column existed their salt.
 * Only rows still without one: a row the poller wrote with its salt is
 * left exactly as it is, and a row that is not in the table — a pool the
 * indexer never knew — is not invented here.
 */
async function saltLiquidityRows(rows: { txHash: string; logIndex: number; salt: string }[]): Promise<number> {
  let updated = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const batch = rows.slice(i, i + 500);
    const values = batch.map((_, j) => `($${3 * j + 1}, $${3 * j + 2}::int, $${3 * j + 3})`).join(', ');
    const params = batch.flatMap((r) => [r.txHash.toLowerCase(), r.logIndex, r.salt.toLowerCase()]);
    updated += await prisma.$executeRawUnsafe(
      `UPDATE liquidity_events le SET salt = v.salt
         FROM (VALUES ${values}) AS v(tx_hash, log_index, salt)
        WHERE lower(le.tx_hash) = v.tx_hash AND le.log_index = v.log_index AND le.salt IS NULL`,
      ...params,
    );
  }
  return updated;
}

function max(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}
