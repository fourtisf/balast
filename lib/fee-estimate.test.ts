import { describe, expect, it } from 'vitest';
import { estimateFeeYield } from './fee-estimate';

const bins = (liquidities: bigint[], width = 60) =>
  liquidities.map((liquidity, i) => ({ tickLower: i * width, tickUpper: (i + 1) * width, liquidity }));

describe('estimateFeeYield', () => {
  it('is the share of today’s fees the liquidity at the price would take, annualised over the deposit', () => {
    // The pool has 9,000 units at the price; the bin holding tick 100 adds 1,000: a tenth of the fees.
    const e = estimateFeeYield({ fees24hUsd: 1_600, activeLiquidity: 9_000n, positions: bins([500n, 1_000n, 500n]), tick: 100, depositUsd: 10_000 });
    expect(e?.share).toBeCloseTo(0.1, 9);
    expect(e?.dailyUsd).toBeCloseTo(160, 6);
    expect(e?.pct).toBeCloseTo((160 * 365) / 10_000 * 100, 6);
  });

  it('pays only the bin holding the price, so a shape with more there earns more — and no more than that', () => {
    const at = (liquidity: bigint[]) =>
      estimateFeeYield({ fees24hUsd: 1_000, activeLiquidity: 1_000_000n, positions: bins(liquidity), tick: 70, depositUsd: 100 })!.pct;
    const spot = at([100n, 100n, 100n]);
    const curve = at([50n, 200n, 50n]);
    expect(curve / spot).toBeCloseTo(2, 2);
  });

  it('reads 0% when no bin holds the price, and never a share of fees it would not be paid', () => {
    const e = estimateFeeYield({ fees24hUsd: 1_000, activeLiquidity: 10n, positions: bins([100n, 100n]), tick: 500, depositUsd: 100 });
    expect(e?.pct).toBe(0);
    // A tick exactly on a bin's upper edge belongs to the next bin, as in Uniswap.
    expect(estimateFeeYield({ fees24hUsd: 1_000, activeLiquidity: 0n, positions: bins([100n]), tick: 60, depositUsd: 100 })?.pct).toBe(0);
  });

  it('cannot be made without today’s fees, the pool’s liquidity, or a deposit', () => {
    const base = { fees24hUsd: 1_000, activeLiquidity: 10n, positions: bins([1n]), tick: 0, depositUsd: 100 };
    expect(estimateFeeYield({ ...base, fees24hUsd: null })).toBeNull();
    expect(estimateFeeYield({ ...base, activeLiquidity: null })).toBeNull();
    expect(estimateFeeYield({ ...base, depositUsd: 0 })).toBeNull();
  });
});
