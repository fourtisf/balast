/**
 * Uniswap v3's own mint arithmetic, ported exactly.
 *
 * Two numbers reach a v3 `mint` and both have to be Uniswap's, not something
 * close to them:
 *
 *   - **`amountDesired`** is what the manager may pull, and it rounds **up**.
 *     Rounding down places marginally less liquidity than the plan says,
 *     which is a silent shortfall rather than a revert.
 *   - **`amountMin`** is what the mint may fall short by before it reverts.
 *     A flat percentage off the desired is not that figure: the guard has to
 *     be "if the price moves against me by the tolerance, what would this
 *     liquidity actually need", which is what Uniswap computes by pricing
 *     the same position at both ends of the tolerance and taking the
 *     smaller amount from each end.
 *
 * `lib/v3/mint.test.ts` compares the encoded bytes against the SDK building
 * the same position, so a drift in any of this fails there rather than as a
 * bad fill on chain. The SDK stays a dev dependency — it carries ethers v5
 * and JSBI and would double the page (§20).
 */

import { Q96, getSqrtRatioAtTick } from '../v4/tick-math';

/** v3's usable sqrt-price bounds, from TickMath. */
export const MIN_SQRT_RATIO = 4295128739n;
export const MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342n;

/** Integer square root, floor — `sqrt` from @uniswap/sdk-core, in bigint. */
export function sqrtBigInt(value: bigint): bigint {
  if (value < 0n) throw new RangeError('negative');
  if (value < 2n) return value;
  // Newton's method from a power-of-two seed, which converges in a few steps
  // even at 192 bits.
  let x = value;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + value / x) / 2n;
  }
  return x;
}

/** sqrt(amount1 / amount0) as Q64.96 — `encodeSqrtRatioX96`. */
export function encodeSqrtRatioX96(amount1: bigint, amount0: bigint): bigint {
  return sqrtBigInt((amount1 << 192n) / amount0);
}

/** L·(√B−√A)·Q96/(√A·√B), rounded as asked — `SqrtPriceMath.getAmount0Delta`. */
export function amount0Delta(sqrtA: bigint, sqrtB: bigint, liquidity: bigint, roundUp: boolean): bigint {
  const [lo, hi] = sqrtA > sqrtB ? [sqrtB, sqrtA] : [sqrtA, sqrtB];
  if (lo <= 0n) return 0n;
  const numerator1 = liquidity << 96n;
  const numerator2 = hi - lo;
  if (roundUp) {
    const inner = divRoundUp(numerator1 * numerator2, hi);
    return divRoundUp(inner, lo);
  }
  return (numerator1 * numerator2) / hi / lo;
}

/** L·(√B−√A)/Q96 — `SqrtPriceMath.getAmount1Delta`. */
export function amount1Delta(sqrtA: bigint, sqrtB: bigint, liquidity: bigint, roundUp: boolean): bigint {
  const [lo, hi] = sqrtA > sqrtB ? [sqrtB, sqrtA] : [sqrtA, sqrtB];
  const numerator = liquidity * (hi - lo);
  return roundUp ? divRoundUp(numerator, Q96) : numerator / Q96;
}

function divRoundUp(a: bigint, b: bigint): bigint {
  return a / b + (a % b === 0n ? 0n : 1n);
}

/**
 * The amounts this liquidity has to be offered to mint — `Position.mintAmounts`.
 *
 * It branches on where the price sits relative to the range, and rounds up on
 * both sides.
 */
export function mintAmounts(args: {
  sqrtPriceX96: bigint;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
}): { amount0: bigint; amount1: bigint } {
  const { sqrtPriceX96, tickLower, tickUpper, liquidity } = args;
  const lower = getSqrtRatioAtTick(tickLower);
  const upper = getSqrtRatioAtTick(tickUpper);
  if (sqrtPriceX96 < lower) {
    return { amount0: amount0Delta(lower, upper, liquidity, true), amount1: 0n };
  }
  if (sqrtPriceX96 < upper) {
    return {
      amount0: amount0Delta(sqrtPriceX96, upper, liquidity, true),
      amount1: amount1Delta(lower, sqrtPriceX96, liquidity, true),
    };
  }
  return { amount0: 0n, amount1: amount1Delta(lower, upper, liquidity, true) };
}

/**
 * The liquidity the router will actually create from these amounts —
 * `maxLiquidityForAmounts` with `useFullPrecision: false`, which is the
 * imprecise form the v3 periphery itself uses. Matching core's more precise
 * form here would plan a position the router cannot create.
 */
export function maxLiquidityForAmounts(args: {
  sqrtPriceX96: bigint;
  tickLower: number;
  tickUpper: number;
  amount0: bigint;
  amount1: bigint;
}): bigint {
  const { sqrtPriceX96, amount0, amount1 } = args;
  const a = getSqrtRatioAtTick(args.tickLower);
  const b = getSqrtRatioAtTick(args.tickUpper);
  const [lo, hi] = a > b ? [b, a] : [a, b];

  const forAmount0 = (sa: bigint, sb: bigint, amt: bigint): bigint => {
    const [x, y] = sa > sb ? [sb, sa] : [sa, sb];
    const intermediate = (x * y) / Q96;
    return (amt * intermediate) / (y - x);
  };
  const forAmount1 = (sa: bigint, sb: bigint, amt: bigint): bigint => {
    const [x, y] = sa > sb ? [sb, sa] : [sa, sb];
    return (amt * Q96) / (y - x);
  };

  if (sqrtPriceX96 <= lo) return forAmount0(lo, hi, amount0);
  if (sqrtPriceX96 < hi) {
    const l0 = forAmount0(sqrtPriceX96, hi, amount0);
    const l1 = forAmount1(lo, sqrtPriceX96, amount1);
    return l0 < l1 ? l0 : l1;
  }
  return forAmount1(lo, hi, amount1);
}

/** The sqrt prices a tolerance either side of the pool's — `ratiosAfterSlippage`. */
export function ratiosAfterSlippage(sqrtPriceX96: bigint, slippageBps: bigint): {
  lower: bigint;
  upper: bigint;
} {
  // token0Price as an exact fraction: sqrtPX96² / 2^192.
  const num = sqrtPriceX96 * sqrtPriceX96;
  const den = 1n << 192n;
  // ×(1 − tol) and ×(1 + tol), kept rational so nothing rounds early.
  let lower = encodeSqrtRatioX96(num * (10_000n - slippageBps), den * 10_000n);
  let upper = encodeSqrtRatioX96(num * (10_000n + slippageBps), den * 10_000n);
  if (lower <= MIN_SQRT_RATIO) lower = MIN_SQRT_RATIO + 1n;
  if (upper >= MAX_SQRT_RATIO) upper = MAX_SQRT_RATIO - 1n;
  return { lower, upper };
}

/**
 * The minimums a mint should ask for — `Position.mintAmountsWithSlippage`.
 *
 * The smaller amount0 occurs at the upper price and the smaller amount1 at
 * the lower, so each side is priced where it is worth least.
 */
export function mintAmountsWithSlippage(args: {
  sqrtPriceX96: bigint;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
  slippageBps: bigint;
}): { amount0: bigint; amount1: bigint } {
  const { sqrtPriceX96, tickLower, tickUpper, liquidity, slippageBps } = args;
  const { lower, upper } = ratiosAfterSlippage(sqrtPriceX96, slippageBps);

  // The router is imprecise, so the guard is built against the position it
  // will really create from the desired amounts, not the one we planned.
  const desired = mintAmounts({ sqrtPriceX96, tickLower, tickUpper, liquidity });
  const created = maxLiquidityForAmounts({
    sqrtPriceX96,
    tickLower,
    tickUpper,
    amount0: desired.amount0,
    amount1: desired.amount1,
  });

  const atUpper = mintAmounts({ sqrtPriceX96: upper, tickLower, tickUpper, liquidity: created });
  const atLower = mintAmounts({ sqrtPriceX96: lower, tickLower, tickUpper, liquidity: created });
  return { amount0: atUpper.amount0, amount1: atLower.amount1 };
}
