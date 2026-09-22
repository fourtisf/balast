import type { ShapeId } from './data/types';

/**
 * Liquidity shapes are weight generators in the frontend, not contract modes
 * (§3.2). BalastShaper takes whatever bins we hand it, so a new shape ships
 * without touching a contract.
 */
export const SHAPES: { id: ShapeId; label: string; hint: string }[] = [
  {
    id: 'spot',
    label: 'Spot',
    hint:
      'The same liquidity in every bin. It earns the same fee wherever the price sits inside the ' +
      'range, and holds more of the token the further the price falls.',
  },
  {
    id: 'curve',
    label: 'Curve',
    hint:
      'Bunched around the current price and thin at the edges. Only the bin holding the price ' +
      'earns, so this earns the most while the price sits still — and drops away fastest as it moves.',
  },
  {
    id: 'bidask',
    label: 'Bid-ask',
    hint:
      'The opposite: heavy at both edges, almost nothing at the price. It earns little while the ' +
      'price sits still, and fills as the price moves — buying below, selling above. A ladder of ' +
      'orders, not a fee position.',
  },
];

/** Max bins per transaction — past this, two transactions are cheaper (§3.2). */
export const MAX_BINS = 60;
export const MIN_BINS = 6;

/** Normalised bin weights, summing to 1. On-chain these become weightBps. */
export function shapeWeights(shape: ShapeId, bins: number): number[] {
  const raw: number[] = [];
  for (let i = 0; i < bins; i++) {
    const x = ((i + 0.5) / bins) * 2 - 1; // -1 … 1 across the range
    raw.push(shape === 'spot' ? 1 : shape === 'curve' ? Math.exp(-x * x * 4) : 0.15 + x * x);
  }
  const total = raw.reduce((a, v) => a + v, 0);
  return raw.map((v) => v / total);
}

/** Integer basis points summing to exactly 10_000, as the contract requires. */
export function weightsToBps(weights: number[]): number[] {
  const bps = weights.map((w) => Math.floor(w * 10_000));
  let drift = 10_000 - bps.reduce((a, v) => a + v, 0);
  for (let i = 0; drift > 0; i = (i + 1) % bps.length, drift--) bps[i] += 1;
  return bps;
}

/**
 * How much liquidity this shape puts where the price actually is, as a
 * multiple of what an even spread over the same range would put there.
 *
 * Only the bin holding the current price earns a fee, so this is the one
 * number that separates the shapes: at 24 bins over a symmetric range,
 * `curve` is about 2.3x an even spread and `bidask` about 0.3x. The builder
 * used to scale its estimate by a constant per shape — 1.35 for curve, 0.8
 * for bid-ask — which was invented, and wrong in the flattering direction
 * for the shape that holds the least where it counts.
 *
 * `minPct` and `maxPct` are the range as fractions (-0.15, 0.15), and the
 * bins are equal-width across it, as the chart draws them.
 */
export function densityAtPrice(weights: number[], minPct: number, maxPct: number): number {
  const bins = weights.length;
  if (bins === 0) return 1;
  const span = maxPct - minPct;
  if (!(span > 0)) return 1;
  // Where the current price sits in the range, 0 at the bottom, 1 at the top.
  const fraction = Math.min(1, Math.max(0, (0 - minPct) / span));
  const index = Math.min(bins - 1, Math.floor(fraction * bins));
  return weights[index] * bins;
}
