/**
 * Decoded events to database rows. Pure: no clock, no network, no database.
 *
 * This is the file §9's acceptance criterion lives or dies on. Two properties
 * make "byte-identical rows from a block-zero re-run and an incremental run"
 * true rather than hopeful:
 *
 *   1. Every row is keyed by `(txHash, logIndex)` and written by upsert, so
 *      re-scanning the last 32 blocks each pass (§4.1) rewrites identical
 *      rows. Nothing is ever incremented.
 *
 *   2. The one piece of carried state — a pool's sqrtPrice, needed to value a
 *      v4 `ModifyLiquidity` that carries no amounts — is a pure function of
 *      the event prefix under the `(blockNumber, logIndex)` total order. The
 *      caller loads it from the database rather than from memory, so a restart
 *      mid-chain resumes with exactly the state a full replay would have.
 *
 * The temptation to "just add the fees as they arrive" is what makes most
 * indexers unable to replay. It is not done here.
 */

import { feeFromSwap, swapInputSide } from '../chain/price';
import { amountsForLiquidity } from '../chain/tick-math';
import { sortEvents, type ChainEvent, type Protocol } from './events';

export interface PoolRow {
  id: string;
  address: string;
  chainId: number;
  token0: string;
  token1: string;
  feeTier: number;
  tickSpacing: number;
  hooks: string | null;
  protocol: Protocol;
  createdBlock: bigint;
  createdAt: Date;
}

export interface SwapRow {
  txHash: string;
  logIndex: number;
  poolId: string;
  blockNum: bigint;
  blockTime: Date;
  amount0: bigint;
  amount1: bigint;
  sqrtPrice: bigint;
  liquidity: bigint;
  tick: number;
  feeAmount: bigint;
  /** 0 or 1, or -1 when the swap's direction could not be read. */
  feeToken: number;
  sender: string;
}

export interface LiquidityRow {
  txHash: string;
  logIndex: number;
  poolId: string;
  blockNum: bigint;
  blockTime: Date;
  tickLower: number;
  tickUpper: number;
  liquidityDelta: bigint;
  amount0: bigint;
  amount1: bigint;
  owner: string;
}

/** Latest price/tick/liquidity seen for a pool in this batch. */
export interface StateRow {
  poolId: string;
  sqrtPrice: bigint;
  tick: number;
  liquidity: bigint;
  updatedAt: Date;
  blockNum: bigint;
}

export interface IngestPlan {
  pools: PoolRow[];
  swaps: SwapRow[];
  liquidity: LiquidityRow[];
  states: StateRow[];
}

/**
 * What the ingest step needs to know about the world before this batch.
 *
 * Both maps must be loaded from the database, not carried in memory across
 * passes — that is what makes a restart and a replay agree.
 */
export interface IngestContext {
  chainId: number;
  /**
   * Last sqrtPriceX96 known for each pool, at or before this batch's first
   * event. For a pool whose Initialize is inside the batch, the Initialize
   * supplies it and no entry is needed.
   */
  sqrtPriceByPool: Map<string, bigint>;
  /** Fee tier per pool, for v3 swaps whose event carries no fee. */
  feePipsByPool: Map<string, number>;
}

/**
 * Turn a batch of decoded events into rows.
 *
 * The batch does not need to be sorted, aligned to a block boundary, or free
 * of events already in the database. It does need to be complete for the
 * blocks it covers: a partial block would place a `ModifyLiquidity` before a
 * `Swap` that actually preceded it and value it at the wrong price.
 */
export function planIngest(events: ChainEvent[], context: IngestContext): IngestPlan {
  const plan: IngestPlan = { pools: [], swaps: [], liquidity: [], states: [] };
  // Copies, so a caller can reuse the context for a second batch unchanged.
  const sqrtPrice = new Map(context.sqrtPriceByPool);
  const feePips = new Map(context.feePipsByPool);
  const latestState = new Map<string, StateRow>();

  for (const event of sortEvents(events)) {
    switch (event.kind) {
      case 'initialize': {
        plan.pools.push({
          id: event.poolId,
          // v4's identity is the bytes32 pool id, not the shared manager
          // address; v3's is its own contract. Both are unique per chain.
          address: event.poolId.slice(event.protocol.length + 1),
          chainId: context.chainId,
          token0: event.currency0,
          token1: event.currency1,
          feeTier: event.feePips,
          tickSpacing: event.tickSpacing,
          hooks: event.hooks,
          protocol: event.protocol,
          createdBlock: event.blockNumber,
          createdAt: event.blockTime,
        });
        sqrtPrice.set(event.poolId, event.sqrtPriceX96);
        feePips.set(event.poolId, event.feePips);
        latestState.set(event.poolId, {
          poolId: event.poolId,
          sqrtPrice: event.sqrtPriceX96,
          tick: event.tick,
          liquidity: 0n,
          updatedAt: event.blockTime,
          blockNum: event.blockNumber,
        });
        break;
      }

      case 'swap': {
        const side = swapInputSide(event.amount0, event.amount1);
        const pips = event.feePips ?? feePips.get(event.poolId) ?? 0;
        const amountIn = side === 0 ? event.amount0 : side === 1 ? event.amount1 : 0n;
        plan.swaps.push({
          txHash: event.txHash,
          logIndex: event.logIndex,
          poolId: event.poolId,
          blockNum: event.blockNumber,
          blockTime: event.blockTime,
          amount0: event.amount0,
          amount1: event.amount1,
          sqrtPrice: event.sqrtPriceX96,
          liquidity: event.liquidity,
          tick: event.tick,
          feeAmount: feeFromSwap(amountIn, pips),
          // -1, not 0: a swap we could not read must not silently attribute
          // its fee to token0 (§7 — no guessed numbers).
          feeToken: side ?? -1,
          sender: event.sender,
        });
        sqrtPrice.set(event.poolId, event.sqrtPriceX96);
        latestState.set(event.poolId, {
          poolId: event.poolId,
          sqrtPrice: event.sqrtPriceX96,
          tick: event.tick,
          liquidity: event.liquidity,
          updatedAt: event.blockTime,
          blockNum: event.blockNumber,
        });
        break;
      }

      case 'liquidity': {
        let { amount0, amount1 } = event;
        if (amount0 === null || amount1 === null) {
          // v4: derive the amounts from the delta and the pool's price at this
          // log's position in the stream. The price comes from the prefix, so
          // the derived amounts are reproducible.
          const price = sqrtPrice.get(event.poolId);
          if (price === undefined) {
            // A ModifyLiquidity with no preceding Initialize or Swap for its
            // pool means the batch started mid-pool. Recording a zero-value
            // row would understate the pool's reserves for good, so skip it
            // and let the caller widen its range. Loud, not silent.
            throw new Error(
              `No price known for pool ${event.poolId} at block ${event.blockNumber} — ` +
                'the batch is missing its Initialize. Re-scan from the pool\'s creation block.',
            );
          }
          const derived = amountsForLiquidity({
            sqrtPriceX96: price,
            tickLower: event.tickLower,
            tickUpper: event.tickUpper,
            liquidityDelta: event.liquidityDelta,
          });
          amount0 = derived.amount0;
          amount1 = derived.amount1;
        }
        plan.liquidity.push({
          txHash: event.txHash,
          logIndex: event.logIndex,
          poolId: event.poolId,
          blockNum: event.blockNumber,
          blockTime: event.blockTime,
          tickLower: event.tickLower,
          tickUpper: event.tickUpper,
          liquidityDelta: event.liquidityDelta,
          amount0,
          amount1,
          owner: event.owner,
        });
        break;
      }
    }
  }

  plan.states = [...latestState.values()];
  return plan;
}

/**
 * Pools referenced by a batch. The caller uses this to check every pool
 * exists before writing rows that point at it — a swap on a pool whose
 * Initialize predates our start block would otherwise fail a foreign key and
 * take down the whole pass.
 */
export function referencedPools(events: ChainEvent[]): Set<string> {
  return new Set(events.map((e) => e.poolId));
}
