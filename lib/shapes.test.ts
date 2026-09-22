import { describe, expect, it } from 'vitest';
import { densityAtPrice, MAX_BINS, MIN_BINS, SHAPES, shapeWeights, weightsToBps } from './shapes';

const ALL_BIN_COUNTS = Array.from({ length: MAX_BINS - MIN_BINS + 1 }, (_, i) => MIN_BINS + i);

describe('shapeWeights', () => {
  it('returns one normalised weight per bin', () => {
    for (const { id } of SHAPES) {
      for (const bins of [MIN_BINS, 24, MAX_BINS]) {
        const w = shapeWeights(id, bins);
        expect(w).toHaveLength(bins);
        expect(w.reduce((a, v) => a + v, 0)).toBeCloseTo(1, 12);
        expect(w.every((v) => v > 0)).toBe(true);
      }
    }
  });

  it('spreads spot evenly', () => {
    const w = shapeWeights('spot', 12);
    expect(new Set(w.map((v) => v.toFixed(12))).size).toBe(1);
  });

  it('concentrates curve at the current price', () => {
    const w = shapeWeights('curve', 12);
    const middle = w[6];
    expect(middle).toBeGreaterThan(w[0]);
    expect(middle).toBeGreaterThan(w[11]);
  });

  it('puts bid-ask heaviest at the edges', () => {
    const w = shapeWeights('bidask', 12);
    expect(w[0]).toBeGreaterThan(w[6]);
    expect(w[11]).toBeGreaterThan(w[6]);
  });

  it('is symmetric for every shape', () => {
    for (const { id } of SHAPES) {
      const w = shapeWeights(id, 20);
      for (let i = 0; i < 10; i++) expect(w[i]).toBeCloseTo(w[19 - i], 12);
    }
  });
});

describe('weightsToBps', () => {
  /**
   * §3.2: BalastShaper enforces sum(weightBps) == 10_000 on-chain. A rounding
   * bug here is a reverted mint, so every shape at every bin count is checked.
   */
  it('sums to exactly 10000 for every shape and every legal bin count', () => {
    for (const { id } of SHAPES) {
      for (const bins of ALL_BIN_COUNTS) {
        const bps = weightsToBps(shapeWeights(id, bins));
        expect(bps).toHaveLength(bins);
        expect(bps.reduce((a, v) => a + v, 0)).toBe(10_000);
      }
    }
  });

  it('returns whole basis points only, never a fraction', () => {
    for (const { id } of SHAPES) {
      for (const bins of [MIN_BINS, 37, MAX_BINS]) {
        for (const v of weightsToBps(shapeWeights(id, bins))) {
          expect(Number.isInteger(v)).toBe(true);
          expect(v).toBeGreaterThan(0);
        }
      }
    }
  });

  it('holds for a pathological weight set', () => {
    // Three bins that each round down: naive flooring would give 9999.
    const bps = weightsToBps([1 / 3, 1 / 3, 1 / 3]);
    expect(bps.reduce((a, v) => a + v, 0)).toBe(10_000);
  });
});

describe('bin limits', () => {
  it('caps a transaction at 60 bins (§3.2)', () => {
    expect(MAX_BINS).toBe(60);
  });
});

describe('densityAtPrice', () => {
  /**
   * The one number that separates the shapes. Only the bin holding the
   * current price earns a fee, so a shape's liquidity there is what its
   * estimate should be scaled by — the builder used a constant per shape
   * before, and the constant for bid-ask (0.8) was more than twice what the
   * shape actually holds.
   */
  it('is exactly 1 for spot, whatever the bin count', () => {
    for (const bins of ALL_BIN_COUNTS) {
      expect(densityAtPrice(shapeWeights('spot', bins), -0.15, 0.15)).toBeCloseTo(1, 12);
    }
  });

  it('puts curve well above an even spread and bid-ask well below it', () => {
    const curve = densityAtPrice(shapeWeights('curve', 24), -0.15, 0.15);
    const bidask = densityAtPrice(shapeWeights('bidask', 24), -0.15, 0.15);
    expect(curve).toBeGreaterThan(2);
    expect(bidask).toBeLessThan(0.4);
    expect(curve).toBeGreaterThan(bidask * 5);
  });

  it('never ranks bid-ask above spot, or spot above curve, at any bin count', () => {
    for (const bins of ALL_BIN_COUNTS) {
      const spot = densityAtPrice(shapeWeights('spot', bins), -0.2, 0.2);
      const curve = densityAtPrice(shapeWeights('curve', bins), -0.2, 0.2);
      const bidask = densityAtPrice(shapeWeights('bidask', bins), -0.2, 0.2);
      expect(bidask).toBeLessThan(spot);
      expect(curve).toBeGreaterThan(spot);
    }
  });

  it('reads the bin the price is actually in, not the middle one', () => {
    // A range that is mostly above the price: for curve the peak sits near
    // the middle of the range, which is well above the price, so the density
    // where the price is has to come out lower than a centred range's.
    const weights = shapeWeights('curve', 24);
    const centred = densityAtPrice(weights, -0.15, 0.15);
    const lopsided = densityAtPrice(weights, -0.03, 0.3);
    expect(lopsided).toBeLessThan(centred);
  });

  it('holds together on the degenerate inputs the builder can hand it mid-edit', () => {
    expect(densityAtPrice([], -0.1, 0.1)).toBe(1);
    expect(densityAtPrice(shapeWeights('curve', 12), 0, 0)).toBe(1);
    // A range entirely above the price clamps to the first bin rather than
    // indexing off the end of the array.
    expect(Number.isFinite(densityAtPrice(shapeWeights('curve', 12), 0.05, 0.3))).toBe(true);
    expect(Number.isFinite(densityAtPrice(shapeWeights('curve', 12), -0.3, -0.05))).toBe(true);
  });
});
