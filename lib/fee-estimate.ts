/**
 * What a planned position would have earned from today's fees, had it been in
 * the pool all day at today's liquidity.
 *
 * A swap's fee is shared across the liquidity active at the price it trades
 * through, in proportion to each position's liquidity there. So a new
 * position's share of the pool's fees is
 *
 *     yours at the price / (the pool's active liquidity + yours)
 *
 * and a day's income is that share of the day's fees. Both liquidities are
 * the chain's own units: the pool's `liquidity()` (v3) or StateView's
 * `getLiquidity` (v4), and the liquidity the plan will mint, so nothing here
 * is a dollar figure that could be stale or an aggregator's.
 *
 * It replaced a heuristic — the pool's yield times `0.6 / span × density`,
 * capped at 6× — whose 0.6 was invented, which knew nothing about how much
 * liquidity other LPs already hold at the price, and which therefore read
 * 285% for spot and 643% for curve on a pool it could not see into.
 *
 * What it still assumes, and the page says: today's fees repeat, the price
 * stays in the bin it is in, and nobody else adds or removes liquidity there.
 * A position whose bins do not hold the price earns nothing, and reads 0%.
 */

export interface PlannedLiquidity {
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
}

export interface FeeEstimate {
  /** Annualised, percent of the deposit. */
  pct: number;
  /** This position's share of the fees paid at the current price, 0–1. */
  share: number;
  /** Dollars a day, at today's fees. */
  dailyUsd: number;
}

/** Scale for turning a bigint ratio into a float without losing the small end. */
const SCALE = 10n ** 12n;

/**
 * The estimate, or null when it cannot honestly be made: no active-liquidity
 * reading, no fees measured today, or no deposit value.
 */
export function estimateFeeYield(args: {
  fees24hUsd: number | null;
  activeLiquidity: bigint | null;
  positions: PlannedLiquidity[];
  /** The pool's current tick. */
  tick: number;
  depositUsd: number;
}): FeeEstimate | null {
  const { fees24hUsd, activeLiquidity, positions, tick, depositUsd } = args;
  if (fees24hUsd === null || !Number.isFinite(fees24hUsd) || fees24hUsd < 0) return null;
  if (activeLiquidity === null || activeLiquidity < 0n) return null;
  if (!(depositUsd > 0) || !Number.isFinite(depositUsd)) return null;
  // Uniswap's rule for which positions a swap at `tick` pays: lower ≤ tick < upper.
  const yours = positions.reduce(
    (sum, p) => (p.tickLower <= tick && tick < p.tickUpper ? sum + p.liquidity : sum),
    0n,
  );
  const total = activeLiquidity + yours;
  const share = total === 0n ? 0 : Number((yours * SCALE) / total) / Number(SCALE);
  const dailyUsd = fees24hUsd * share;
  return { pct: ((dailyUsd * 365) / depositUsd) * 100, share, dailyUsd };
}
