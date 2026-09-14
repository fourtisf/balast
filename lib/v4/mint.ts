/**
 * A shaped position, planned as one PositionManager transaction.
 *
 * The shape builder describes a deposit in the quote currency, a range as a
 * percentage around the token's price, a bin count and a shape. This turns
 * that into N `MINT_POSITION` actions — one per bin, each with the liquidity
 * its weight of the deposit buys at the live price — followed by a
 * `SETTLE_PAIR` that pays for all of them and, for an ether pool, a `SWEEP`
 * that returns the unspent ether. Every amount is computed in bigint from
 * the sqrt price the chain reported; nothing here comes from the indexer.
 */

import type { Address, Hex } from 'viem';
import { NATIVE_ETH } from '../chain';
import type { ShapeId } from '../data/types';
import { shapeWeights, weightsToBps } from '../shapes';
import { Actions, encodeMint, encodeModifyLiquidities, encodeSettlePair, encodeSweep, encodeUnlockData } from './actions';
import { amount0InCurrency1, liquidityForValue } from './liquidity';
import { alignDown, alignUp, ticksForFactor, type PoolKey } from './pool';
import { amountsForLiquidity } from './tick-math';

export interface MintPlanInput {
  key: PoolKey;
  /** The live slot0. */
  sqrtPriceX96: bigint;
  tick: number;
  /** Which side the builder calls "the token"; the other is the quote the deposit is in. */
  tokenIsCurrency0: boolean;
  /** The deposit, in the quote currency's raw units. */
  depositQuote: bigint;
  /** Range around the token's price, in percent: min at or below 0, max at or above 0. */
  minPct: number;
  maxPct: number;
  bins: number;
  shape: ShapeId;
  owner: Address;
  /** How much more than the planned amounts the transaction may take; the price can move before it lands. */
  slippageBps?: number;
  /** Unix seconds. */
  deadline: bigint;
}

export interface PlannedPosition {
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
  amount0: bigint;
  amount1: bigint;
}

export interface MintPlan {
  positions: PlannedPosition[];
  tickLower: number;
  tickUpper: number;
  /** Planned totals at the live price. */
  amount0: bigint;
  amount1: bigint;
  /** What the transaction is allowed to take, slippage included. */
  amount0Max: bigint;
  amount1Max: bigint;
  /** msg.value: amount0Max when currency0 is ether, else zero. */
  value: bigint;
  calldata: Hex;
  unlockData: Hex;
}

/** Ticks for the token's price range, in the pool's own orientation. */
export function rangeTicks(args: {
  tick: number;
  tickSpacing: number;
  tokenIsCurrency0: boolean;
  minPct: number;
  maxPct: number;
}): { tickLower: number; tickUpper: number } {
  const { tick, tickSpacing, tokenIsCurrency0, minPct, maxPct } = args;
  if (!(maxPct > minPct)) throw new RangeError('max must be above min');
  const lo = ticksForFactor(1 + minPct / 100);
  const hi = ticksForFactor(1 + maxPct / 100);
  // The pool prices currency0 in currency1. When the token is currency1 its
  // price is the inverse, so the token's range maps to the pool's mirrored.
  const [rawLower, rawUpper] = tokenIsCurrency0 ? [tick + lo, tick + hi] : [tick - hi, tick - lo];
  const tickLower = alignDown(rawLower, tickSpacing);
  let tickUpper = alignUp(rawUpper, tickSpacing);
  if (tickUpper <= tickLower) tickUpper = tickLower + tickSpacing;
  return { tickLower, tickUpper };
}

/** Split [lower, upper] into up to `bins` sub-ranges of whole tick spacings, as even as the arithmetic allows. */
export function splitRange(tickLower: number, tickUpper: number, tickSpacing: number, bins: number): [number, number][] {
  const steps = Math.round((tickUpper - tickLower) / tickSpacing);
  const n = Math.max(1, Math.min(bins, steps));
  const base = Math.floor(steps / n);
  const extra = steps % n;
  const out: [number, number][] = [];
  let t = tickLower;
  for (let i = 0; i < n; i++) {
    const width = (base + (i < extra ? 1 : 0)) * tickSpacing;
    out.push([t, t + width]);
    t += width;
  }
  return out;
}

export function planMint(input: MintPlanInput): MintPlan {
  const { key, sqrtPriceX96, tick, tokenIsCurrency0, depositQuote, owner, deadline } = input;
  const slippageBps = BigInt(input.slippageBps ?? 100);
  if (depositQuote <= 0n) throw new RangeError('deposit must be positive');

  const { tickLower, tickUpper } = rangeTicks({
    tick,
    tickSpacing: key.tickSpacing,
    tokenIsCurrency0,
    minPct: input.minPct,
    maxPct: input.maxPct,
  });
  const ranges = splitRange(tickLower, tickUpper, key.tickSpacing, input.bins);

  // The deposit is in the quote; the value maths is in currency1. When the
  // quote is currency0 (native ether always is), convert at the live price.
  const quoteIsCurrency0 = !tokenIsCurrency0;
  const valueIn1 = quoteIsCurrency0 ? amount0InCurrency1(depositQuote, sqrtPriceX96) : depositQuote;

  // Weights run along the token's price; pool ticks run along currency0's.
  // For a currency1 token the two run opposite ways.
  let bps = weightsToBps(shapeWeights(input.shape, ranges.length));
  if (!tokenIsCurrency0) bps = [...bps].reverse();

  const positions: PlannedPosition[] = [];
  ranges.forEach(([lo, hi], i) => {
    const share = (valueIn1 * BigInt(bps[i])) / 10_000n;
    const liquidity = liquidityForValue({ sqrtPriceX96, tickLower: lo, tickUpper: hi, valueIn1: share });
    if (liquidity <= 0n) return;
    const { amount0, amount1 } = amountsForLiquidity({ sqrtPriceX96, tickLower: lo, tickUpper: hi, liquidityDelta: liquidity });
    positions.push({ tickLower: lo, tickUpper: hi, liquidity, amount0, amount1 });
  });
  if (positions.length === 0) throw new RangeError('the deposit is too small to place');

  const amount0 = positions.reduce((s, p) => s + p.amount0, 0n);
  const amount1 = positions.reduce((s, p) => s + p.amount1, 0n);
  // The pool rounds what it takes up; the tolerance covers that and a move in price.
  const withSlippage = (a: bigint) => (a === 0n ? 0n : (a * (10_000n + slippageBps)) / 10_000n + 1n);
  const amount0Max = withSlippage(amount0);
  const amount1Max = withSlippage(amount1);

  // Per position the cap is its own share, so one bin cannot draw on another's.
  const actions: number[] = [];
  const params: Hex[] = [];
  for (const p of positions) {
    actions.push(Actions.MINT_POSITION);
    params.push(
      encodeMint({
        key,
        tickLower: p.tickLower,
        tickUpper: p.tickUpper,
        liquidity: p.liquidity,
        amount0Max: withSlippage(p.amount0),
        amount1Max: withSlippage(p.amount1),
        owner,
      }),
    );
  }
  actions.push(Actions.SETTLE_PAIR);
  params.push(encodeSettlePair(key.currency0, key.currency1));

  const native = key.currency0.toLowerCase() === NATIVE_ETH;
  if (native) {
    actions.push(Actions.SWEEP);
    params.push(encodeSweep(key.currency0, owner));
  }

  const unlockData = encodeUnlockData(actions, params);
  return {
    positions,
    tickLower,
    tickUpper,
    amount0,
    amount1,
    amount0Max,
    amount1Max,
    value: native ? amount0Max : 0n,
    unlockData,
    calldata: encodeModifyLiquidities(unlockData, deadline),
  };
}
