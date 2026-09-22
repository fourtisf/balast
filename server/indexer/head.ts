/**
 * The chain's head, while the backfill is still weeks behind it.
 *
 * The indexer reads from `START_BLOCK` forward, in order, because that is the
 * only way to know a pool's reserves: they are the sum of its whole event
 * history, and a sum with a hole in it is not a smaller number, it is a wrong
 * one (§14). On a chain of sixty million blocks that ordering costs days, and
 * for all of them the board's figures are a day two months old. An aggregator
 * patches over the tokens it happens to list (§21) and leaves the rest.
 *
 * So this reads the other end. It follows the last `HEAD_WINDOW_HOURS` of
 * blocks, decodes the same swap logs with the same decoders, and writes them
 * to `recent_swaps` — a table nothing else in the pipeline reads.
 *
 * That isolation is the whole design. These rows answer one question, "what
 * traded today", and they are not allowed near any figure that needs a
 * complete history: not reserves, not liquidity, not the fee yield, not §9's
 * replay proof. When the backfill eventually reaches these blocks it writes
 * them into `swap_events` in the ordinary way, and the rows here are pruned
 * behind the window. Nothing is double-counted, because nothing sums the two.
 *
 * It follows by topic and keeps what it recognises, exactly as the main
 * poller does (§20): the PoolManager, and the v3 pools already in `pools`.
 * A pool the backfill has not reached yet is still written — its rows simply
 * do not join to anything until it is named.
 */

import { CONTRACTS } from '../../lib/chain';
import { FOLLOWED_TOPICS } from '../chain/abi';
import { feeFromSwap, swapInputSide } from '../chain/price';
import { prisma } from '../db';
import { decodePoolManagerLog, decodeV3PoolLog, type SwapEventDecoded } from './events';
import type { LogSource } from './poller';
import { readCursor, writeCursor } from './store';
import { asLog } from './v3-history';

/** The head follower's own cursor, so it cannot be confused with the backfill's. */
export const HEAD_CURSOR = `head:${CONTRACTS.poolManager.toLowerCase()}`;

/** Rows older than the window plus this are pruned; an hour of slack keeps a 24h query whole at its edge. */
const PRUNE_SLACK_HOURS = 2;

export interface HeadFollowerOptions {
  source: LogSource;
  /** How many hours of chain the window covers. The board's figures are 24h. */
  windowHours?: number;
  /** Chain milliseconds per block, for turning hours into a block count. */
  blockMs?: number;
  /** Blocks per request. Narrows on a refusal, like the poller's (§20). */
  blockRange?: bigint;
  /** Requests sent together. */
  concurrency?: number;
  log?: (line: string) => void;
}

export interface HeadPassResult {
  fromBlock: bigint;
  toBlock: bigint;
  headBlock: bigint;
  swapsWritten: number;
  pruned: number;
  /** Blocks still to read before the window is whole. Zero once it is following head. */
  behind: bigint;
  refused: boolean;
  blockRange: number;
}

/** The narrowest window a refusal can force, as in the poller. */
const HARD_MIN_RANGE = 64n;

export class HeadFollower {
  private readonly source: LogSource;
  private readonly windowHours: number;
  private readonly blockMs: number;
  private readonly log: (line: string) => void;
  private readonly maxRange: bigint;
  private range: bigint;
  private concurrency: number;
  /** v3 pool addresses this follower keeps logs from, reloaded each pass from `pools`. */
  private v3Pools = new Set<string>();
  private said = false;

  constructor(options: HeadFollowerOptions) {
    this.source = options.source;
    this.windowHours = Math.max(1, options.windowHours ?? 24);
    this.blockMs = Math.max(1, options.blockMs ?? 100);
    this.maxRange = options.blockRange ?? 2_000n;
    this.range = this.maxRange;
    this.concurrency = Math.max(1, options.concurrency ?? 6);
    this.log = options.log ?? (() => {});
  }

  /** How many blocks the window covers, from the chain's own block time. */
  windowBlocks(): bigint {
    return BigInt(Math.round((this.windowHours * 3600 * 1000) / this.blockMs));
  }

  /**
   * One pass: read forward from the cursor toward head, write what traded.
   *
   * The cursor starts a window's worth of blocks behind head, so the first
   * few passes are a catch-up of that window and every pass after it is the
   * handful of blocks the chain has made since. A pass that is refused by
   * every endpoint narrows the window and moves nothing.
   */
  async pass(): Promise<HeadPassResult> {
    const head = await this.source.getHeadBlock();
    const window = this.windowBlocks();
    const earliest = head.number > window ? head.number - window : 0n;
    const stored = await readCursor(HEAD_CURSOR);
    // Below the window is history the backfill owns; never read it twice.
    const from = stored === null ? earliest : stored + 1n > earliest ? stored + 1n : earliest;

    if (from > head.number) {
      return {
        fromBlock: from,
        toBlock: head.number,
        headBlock: head.number,
        swapsWritten: 0,
        pruned: 0,
        behind: 0n,
        refused: false,
        blockRange: Number(this.range),
      };
    }

    const span = this.range * BigInt(this.concurrency);
    const to = head.number < from + span - 1n ? head.number : from + span - 1n;

    await this.loadV3Pools();

    // Windows go out together and settle independently, as the poller's do:
    // the ones that arrived before a refusal are kept and the cursor moves to
    // the end of them, so a refused burst costs the refused windows only.
    const windows: { from: bigint; to: bigint }[] = [];
    for (let at = from; at <= to; at += this.range) {
      const end = at + this.range - 1n < to ? at + this.range - 1n : to;
      windows.push({ from: at, to: end });
    }
    const answers = await Promise.all(
      windows.map(async (w) => {
        try {
          return {
            w,
            logs: await this.source.getLogs({
              topics: FOLLOWED_TOPICS,
              fromBlock: w.from,
              toBlock: w.to,
            }),
          };
        } catch (error) {
          return { w, error: error as Error };
        }
      }),
    );

    let settled: bigint | null = null;
    const kept: SwapEventDecoded[] = [];
    let refusal: Error | null = null;
    for (const answer of answers) {
      if ('error' in answer && answer.error) {
        refusal = answer.error;
        break;
      }
      const blockTimes = await this.source.getBlockTimes(answer.w.from, answer.w.to);
      for (const raw of answer.logs!) {
        const address = raw.address.toLowerCase();
        const at = blockTimes.get(raw.blockNumber) ?? head.timestamp;
        const event =
          address === CONTRACTS.poolManager.toLowerCase()
            ? decodePoolManagerLog(asLog(raw), at)
            : this.v3Pools.has(address)
              ? decodeV3PoolLog(asLog(raw), at)
              : null;
        if (event && event.kind === 'swap') kept.push(event);
      }
      settled = answer.w.to;
    }

    if (refusal !== null) {
      // The width is a fact about the endpoint, not a preference: narrow it
      // past the configured floor rather than asking for the same range for
      // ever (§20). The cursor does not move over an unread window.
      const half = this.range / 2n;
      this.range = half > HARD_MIN_RANGE ? half : HARD_MIN_RANGE;
      if (!this.said) {
        this.said = true;
        this.log(`  head: ${refusal.message} — window now ${this.range}`);
      }
    } else if (this.range < this.maxRange) {
      const wider = this.range * 2n;
      this.range = wider < this.maxRange ? wider : this.maxRange;
    }

    if (settled === null) {
      return {
        fromBlock: from,
        toBlock: from,
        headBlock: head.number,
        swapsWritten: 0,
        pruned: 0,
        behind: head.number - from,
        refused: true,
        blockRange: Number(this.range),
      };
    }

    const written = await this.write(kept);
    const pruned = await this.prune(head.timestamp);
    const lastTime = kept.length > 0 ? kept[kept.length - 1].blockTime : head.timestamp;
    await writeCursor(HEAD_CURSOR, settled, lastTime, head.number);

    return {
      fromBlock: from,
      toBlock: settled,
      headBlock: head.number,
      swapsWritten: written,
      pruned,
      behind: head.number - settled,
      refused: false,
      blockRange: Number(this.range),
    };
  }

  /**
   * The v3 pools worth keeping logs from. Reloaded every pass because the
   * backfill discovers more of them as it goes; a pool it has not named yet
   * simply has its logs dropped, and picked up once it has.
   */
  private async loadV3Pools(): Promise<void> {
    const rows = await prisma.pool.findMany({ where: { protocol: 'v3' }, select: { address: true } });
    this.v3Pools = new Set(rows.map((r) => r.address.toLowerCase()));
  }

  /** Upsert by log coordinates, so a re-read of the same blocks changes nothing. */
  private async write(swaps: SwapEventDecoded[]): Promise<number> {
    if (swaps.length === 0) return 0;
    const feeTiers = await this.feeTiers(swaps);
    const rows = swaps.map((event) => {
      const side = swapInputSide(event.amount0, event.amount1);
      const pips = event.feePips ?? feeTiers.get(event.poolId) ?? 0;
      const amountIn = side === 0 ? event.amount0 : side === 1 ? event.amount1 : 0n;
      return {
        txHash: event.txHash,
        logIndex: event.logIndex,
        poolId: event.poolId,
        blockNum: event.blockNumber,
        blockTime: event.blockTime,
        amount0: event.amount0.toString(),
        amount1: event.amount1.toString(),
        sqrtPrice: event.sqrtPriceX96.toString(),
        feeAmount: feeFromSwap(amountIn, pips).toString(),
        // -1, not 0: a swap whose direction could not be read must not
        // attribute its fee to token0 (§7).
        feeToken: side ?? -1,
      };
    });
    await prisma.recentSwap.createMany({ data: rows, skipDuplicates: true });
    return rows.length;
  }

  /** v3 pools do not emit a fee on the swap; it is the pool's immutable tier. */
  private async feeTiers(swaps: SwapEventDecoded[]): Promise<Map<string, number>> {
    const needed = [...new Set(swaps.filter((s) => s.feePips === null).map((s) => s.poolId))];
    if (needed.length === 0) return new Map();
    const rows = await prisma.pool.findMany({
      where: { id: { in: needed } },
      select: { id: true, feeTier: true },
    });
    return new Map(rows.map((r) => [r.id, r.feeTier]));
  }

  /** Drop what has fallen out of the window, so the table stays a day's worth. */
  private async prune(now: Date): Promise<number> {
    const before = new Date(now.getTime() - (this.windowHours + PRUNE_SLACK_HOURS) * 3600_000);
    const { count } = await prisma.recentSwap.deleteMany({ where: { blockTime: { lt: before } } });
    return count;
  }
}
