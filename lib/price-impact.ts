/**
 * Price impact on holdings (§7, the honest name for impermanent loss): what a
 * position is worth against what holding its principal would be worth, both
 * at the same prices.
 *
 * On a small position minted recently the figure is cents, and the page used
 * to round anything under half a dollar to "$0". That read as "not measured"
 * next to a caption saying it was. The figure is shown to the cent now, with
 * its percentage of the held value beside it, because a percentage is what
 * lets a $27 position and a $27,000 one be read the same way.
 */

import type { UserPosition } from './data/types';
import { usdFine } from './format';

export interface PriceImpact {
  /** Summed over the positions whose principal is known. */
  usd: number;
  /** Against what holding those positions' principal would be worth. Null when that is not known. */
  pct: number | null;
  /** How many positions the figure covers. */
  measured: number;
}

export function priceImpactOf(positions: UserPosition[]): PriceImpact {
  let usd = 0;
  let hold = 0;
  let holdKnown = true;
  let measured = 0;
  for (const p of positions) {
    if (p.priceImpactUsd === undefined) continue;
    measured += 1;
    usd += p.priceImpactUsd;
    const h = p.live?.holdUsd;
    if (h == null || !(h > 0)) holdKnown = false;
    else hold += h;
  }
  return { usd, pct: measured > 0 && holdKnown && hold > 0 ? (usd / hold) * 100 : null, measured };
}

/**
 * The figure with its sign: "−$0.03", "−<$0.01", "$0". A positive figure is
 * a cent of rounding in the pool's own arithmetic, never a gain from holding
 * liquidity, and carries a plus so it is not read as a loss.
 */
export function impactText(usd: number): string {
  const text = usdFine(usd);
  return usd > 0 && text !== '$0' ? `+${text}` : text;
}

/** "−0.11%", or "<0.01%" for a figure too small to print, or null. */
export function impactPctText(pct: number | null): string | null {
  if (pct === null || !Number.isFinite(pct)) return null;
  if (pct === 0) return '0%';
  const a = Math.abs(pct);
  const sign = pct < 0 ? '−' : '+';
  if (a < 0.01) return `${sign}<0.01%`;
  return `${sign}${a < 1 ? a.toFixed(2) : a.toFixed(1)}%`;
}
