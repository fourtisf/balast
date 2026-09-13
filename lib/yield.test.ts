import { describe, expect, it } from 'vitest';
import {
  MIN_DATA_HOURS,
  YIELD_WINDOW_HOURS,
  computeFeeYield,
  feeYieldQualifier,
  feeYieldValue,
  yieldPct,
} from './yield';

/**
 * §7 calls these product rules, not style preferences: "breaking one makes the
 * site dishonest". They get tests for exactly that reason.
 */
describe('computeFeeYield', () => {
  const mature = { feesWindowUsd: 10_000, tvlUsd: 1_000_000, windowHours: 168, ageHours: 2000 };

  it('annualises the trailing 7d window: fees_7d / tvl_now * 365/7', () => {
    const y = computeFeeYield(mature);
    expect(y.basis).toBe('trailing7d');
    // 10_000 / 1_000_000 * (365/7) * 100
    expect(yieldPct(y)).toBeCloseTo((10_000 / 1_000_000) * (365 / 7) * 100, 6);
  });

  it('shows nothing at all below 24h of data', () => {
    for (const ageHours of [0, 1, 12, MIN_DATA_HOURS - 0.01]) {
      const y = computeFeeYield({ ...mature, ageHours, windowHours: Math.max(ageHours, 0.5) });
      expect(y.basis).toBe('insufficient');
      expect(feeYieldValue(y)).toBe('—');
    }
  });

  it('marks a pool younger than 7d as an estimate, never as trailing 7d', () => {
    for (const ageHours of [MIN_DATA_HOURS, 48, YIELD_WINDOW_HOURS - 1]) {
      const y = computeFeeYield({ ...mature, ageHours, windowHours: ageHours });
      expect(y.basis).toBe('estimate');
    }
  });

  it('treats exactly 7d as a full trailing window', () => {
    const y = computeFeeYield({ ...mature, ageHours: YIELD_WINDOW_HOURS, windowHours: YIELD_WINDOW_HOURS });
    expect(y.basis).toBe('trailing7d');
  });

  it('annualises a young pool over the window that exists, not over 7 days', () => {
    // One day old, $500 of fees on $180k. Annualising one day is what makes
    // the 1200% figure §7 warns about; the label is what makes it honest.
    const y = computeFeeYield({ feesWindowUsd: 500, tvlUsd: 180_000, windowHours: 24, ageHours: 24 });
    expect(y.basis).toBe('estimate');
    expect(yieldPct(y)).toBeCloseTo((500 / 180_000) * (365 * 24 / 24) * 100, 6);
  });

  it('refuses to divide by an empty pool', () => {
    expect(computeFeeYield({ ...mature, tvlUsd: 0 }).basis).toBe('insufficient');
    expect(computeFeeYield({ ...mature, windowHours: 0 }).basis).toBe('insufficient');
  });
});

describe('labels', () => {
  it('carries the pool age next to an estimate (§7)', () => {
    const y = computeFeeYield({ feesWindowUsd: 500, tvlUsd: 180_000, windowHours: 24, ageHours: 24 });
    expect(feeYieldQualifier(y, '1d')).toBe('est. · 1d');
  });

  it('does not qualify a full trailing window, and never qualifies an em dash', () => {
    const full = computeFeeYield({ feesWindowUsd: 1, tvlUsd: 1, windowHours: 168, ageHours: 900 });
    expect(feeYieldQualifier(full, '69d')).toBeNull();
    const none = computeFeeYield({ feesWindowUsd: 1, tvlUsd: 1, windowHours: 1, ageHours: 1 });
    expect(feeYieldQualifier(none, '1h')).toBeNull();
  });

  it('never says APR or APY', () => {
    const cases = [
      computeFeeYield({ feesWindowUsd: 1, tvlUsd: 1, windowHours: 1, ageHours: 1 }),
      computeFeeYield({ feesWindowUsd: 1, tvlUsd: 1, windowHours: 24, ageHours: 24 }),
      computeFeeYield({ feesWindowUsd: 1, tvlUsd: 1, windowHours: 168, ageHours: 900 }),
    ];
    for (const y of cases) {
      expect(feeYieldValue(y)).not.toMatch(/APR|APY/i);
      expect(feeYieldQualifier(y, '1d') ?? '').not.toMatch(/APR|APY/i);
    }
  });
});

describe('yieldPct', () => {
  it('sorts pools without enough data to the bottom, not the top', () => {
    const none = computeFeeYield({ feesWindowUsd: 1, tvlUsd: 1, windowHours: 1, ageHours: 1 });
    expect(yieldPct(none)).toBeLessThan(0);
  });
});
