import { describe, expect, it } from 'vitest';
import {
  MAX_TICK,
  MIN_TICK,
  amountsForLiquidity,
  amount0Delta,
  amount1Delta,
  getSqrtRatioAtTick,
} from './tick-math';

const Q96 = 2n ** 96n;

/**
 * sqrt(1.0001^tick) * 2^96, computed independently in floating point. The
 * integer table is the authority; this is only a cross-check on it.
 */
function sqrtRatioApprox(tick: number): number {
  return Math.sqrt(Math.pow(1.0001, tick)) * 2 ** 96;
}

/**
 * The tolerance is chosen, not guessed. `Math.pow(1.0001, t)` accumulates its
 * own error as |t| grows — measured at 2.9e-12 near tick 524288 and 2.0e-10 at
 * the extreme tick, which is the reference drifting, not the table being
 * wrong. A mistyped hex digit in any constant moves the ratio by 1e-6 at the
 * very least, usually by orders of magnitude. 1e-8 sits two decades above the
 * reference's noise and two below the smallest plausible typo.
 */
const TOLERANCE = 1e-8;

function relativeError(exact: bigint, approx: number): number {
  return Math.abs(Number(exact) - approx) / approx;
}

describe('getSqrtRatioAtTick', () => {
  it('is exactly 2^96 at tick 0', () => {
    expect(getSqrtRatioAtTick(0)).toBe(Q96);
  });

  it('agrees with sqrt(1.0001^t)*2^96 at every power-of-two tick', () => {
    // This is the transcription check: the table has 20 constants and each one
    // only participates at its own bit, so a typo in any of them fails here.
    for (let i = 0; i < 20; i++) {
      const tick = 1 << i;
      if (tick > MAX_TICK) break;
      for (const t of [tick, -tick]) {
        expect(relativeError(getSqrtRatioAtTick(t), sqrtRatioApprox(t))).toBeLessThan(TOLERANCE);
      }
    }
  });

  it('agrees across a spread of ordinary ticks', () => {
    for (const t of [1, -1, 60, -60, 887, -887, 20_000, -20_000, 500_000, -500_000]) {
      expect(relativeError(getSqrtRatioAtTick(t), sqrtRatioApprox(t))).toBeLessThan(TOLERANCE);
    }
  });

  it('agrees across the whole tick range', () => {
    // Every constant in the table participates somewhere in this sweep, which
    // makes it the real transcription check rather than the power-of-two one.
    for (let t = MIN_TICK; t <= MAX_TICK; t += 1013) {
      expect(relativeError(getSqrtRatioAtTick(t), sqrtRatioApprox(t))).toBeLessThan(TOLERANCE);
    }
  });

  it('is monotonic', () => {
    let previous = 0n;
    for (let t = -100_000; t <= 100_000; t += 997) {
      const r = getSqrtRatioAtTick(t);
      expect(r).toBeGreaterThan(previous);
      previous = r;
    }
  });

  it('rejects ticks outside the pool range', () => {
    expect(() => getSqrtRatioAtTick(MAX_TICK + 1)).toThrow(RangeError);
    expect(() => getSqrtRatioAtTick(MIN_TICK - 1)).toThrow(RangeError);
  });
});

describe('amountsForLiquidity', () => {
  const L = 10n ** 18n;

  it('is all token0 when the price is below the range', () => {
    const a = amountsForLiquidity({
      sqrtPriceX96: getSqrtRatioAtTick(-1000),
      tickLower: 0,
      tickUpper: 1000,
      liquidityDelta: L,
    });
    expect(a.amount0).toBeGreaterThan(0n);
    expect(a.amount1).toBe(0n);
  });

  it('is all token1 when the price is above the range', () => {
    const a = amountsForLiquidity({
      sqrtPriceX96: getSqrtRatioAtTick(2000),
      tickLower: 0,
      tickUpper: 1000,
      liquidityDelta: L,
    });
    expect(a.amount0).toBe(0n);
    expect(a.amount1).toBeGreaterThan(0n);
  });

  it('is both sides when the price is inside the range', () => {
    const a = amountsForLiquidity({
      sqrtPriceX96: getSqrtRatioAtTick(500),
      tickLower: 0,
      tickUpper: 1000,
      liquidityDelta: L,
    });
    expect(a.amount0).toBeGreaterThan(0n);
    expect(a.amount1).toBeGreaterThan(0n);
  });

  it('mints and burns cancel exactly, so reserves return to zero', () => {
    // This is what makes reserves derivable by summing events: if a burn did
    // not return exactly the mint's amounts, a pool's reserves would drift
    // every time someone rebalanced.
    const args = { sqrtPriceX96: getSqrtRatioAtTick(321), tickLower: -600, tickUpper: 900 };
    const mint = amountsForLiquidity({ ...args, liquidityDelta: L });
    const burn = amountsForLiquidity({ ...args, liquidityDelta: -L });
    expect(mint.amount0 + burn.amount0).toBe(0n);
    expect(mint.amount1 + burn.amount1).toBe(0n);
  });

  it('scales linearly with liquidity', () => {
    const args = { sqrtPriceX96: getSqrtRatioAtTick(120), tickLower: -240, tickUpper: 240 };
    const one = amountsForLiquidity({ ...args, liquidityDelta: L });
    const ten = amountsForLiquidity({ ...args, liquidityDelta: L * 10n });
    // Integer division can lose at most a few wei per term.
    expect(ten.amount0 - one.amount0 * 10n).toBeLessThanOrEqual(10n);
    expect(ten.amount1 - one.amount1 * 10n).toBeLessThanOrEqual(10n);
  });

  it('a zero delta moves nothing', () => {
    const a = amountsForLiquidity({
      sqrtPriceX96: Q96,
      tickLower: -60,
      tickUpper: 60,
      liquidityDelta: 0n,
    });
    expect(a).toEqual({ amount0: 0n, amount1: 0n });
  });
});

describe('amount deltas', () => {
  it('do not care which bound is passed first', () => {
    const a = getSqrtRatioAtTick(-500);
    const b = getSqrtRatioAtTick(500);
    const L = 10n ** 20n;
    expect(amount0Delta(a, b, L)).toBe(amount0Delta(b, a, L));
    expect(amount1Delta(a, b, L)).toBe(amount1Delta(b, a, L));
  });

  it('a one-tick-wide range at price 1 holds roughly equal value', () => {
    // At tick 0 the two tokens are 1:1, so a symmetric range around it should
    // hold near-equal amounts. A factor-of-two error in either delta shows here.
    const L = 10n ** 24n;
    const lower = getSqrtRatioAtTick(-60);
    const upper = getSqrtRatioAtTick(60);
    const a0 = amount0Delta(Q96, upper, L);
    const a1 = amount1Delta(lower, Q96, L);
    const ratio = Number(a0) / Number(a1);
    expect(ratio).toBeGreaterThan(0.99);
    expect(ratio).toBeLessThan(1.01);
  });
});
