/**
 * Sizing a position by value.
 *
 * A bin is a tick range with a share of the deposit. The pool measures a
 * position in liquidity, not in value, and the two are related through the
 * current price: at sqrt price P, one unit of liquidity in [lower, upper]
 * is worth `amount1 + amount0 × P²` in currency1. That is linear in
 * liquidity, so the liquidity for a target value is one division.
 */

import { amountsForLiquidity } from './tick-math';

const Q192 = 2n ** 192n;

/** Value in currency1 raw units of `amount0` currency0 at this price. */
export function amount0InCurrency1(amount0: bigint, sqrtPriceX96: bigint): bigint {
  return (amount0 * sqrtPriceX96 * sqrtPriceX96) / Q192;
}

/** Value in currency0 raw units of `amount1` currency1 at this price. */
export function amount1InCurrency0(amount1: bigint, sqrtPriceX96: bigint): bigint {
  return (amount1 * Q192) / (sqrtPriceX96 * sqrtPriceX96);
}

/** What `liquidity` in the range is worth, in currency1, at this price. */
export function valueInCurrency1(args: {
  sqrtPriceX96: bigint;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
}): bigint {
  const { amount0, amount1 } = amountsForLiquidity({
    sqrtPriceX96: args.sqrtPriceX96,
    tickLower: args.tickLower,
    tickUpper: args.tickUpper,
    liquidityDelta: args.liquidity,
  });
  return amount1 + amount0InCurrency1(amount0, args.sqrtPriceX96);
}

/** The liquidity in the range worth `valueIn1` currency1 at this price; zero for an empty range. */
export function liquidityForValue(args: {
  sqrtPriceX96: bigint;
  tickLower: number;
  tickUpper: number;
  valueIn1: bigint;
}): bigint {
  if (args.valueIn1 <= 0n || args.tickUpper <= args.tickLower) return 0n;
  // A large probe keeps the division precise; the result is linear in it.
  const probe = 1n << 96n;
  const perProbe = valueInCurrency1({ ...args, liquidity: probe });
  if (perProbe === 0n) return 0n;
  return (args.valueIn1 * probe) / perProbe;
}
