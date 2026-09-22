import { describe, expect, it } from 'vitest';
import { feesOwed, positionSalt } from './fees';

const Q128 = 2n ** 128n;

describe('feesOwed', () => {
  it('is liquidity times the growth since the last settlement, over 2^128', () => {
    const liquidity = 10n ** 18n;
    const last = 5n * Q128;
    const now = last + 3n * Q128; // three units of fee per unit of liquidity
    expect(feesOwed(liquidity, now, last)).toBe(3n * 10n ** 18n);
  });

  it('wraps like the pool does when the accumulator has gone round', () => {
    // The fee-growth accumulator is a uint256 that is allowed to overflow.
    // Read naively the delta is hugely negative; wrapped it is fifteen.
    const last = 2n ** 256n - 5n;
    const now = 10n;
    expect(feesOwed(Q128, now, last)).toBe(15n);
  });

  it('is zero for a position with no liquidity or no growth', () => {
    expect(feesOwed(0n, 10n * Q128, 0n)).toBe(0n);
    expect(feesOwed(10n ** 18n, 7n * Q128, 7n * Q128)).toBe(0n);
  });
});

describe('positionSalt', () => {
  it('is the token id as 32 bytes, which is what PositionManager salts its liquidity with', () => {
    expect(positionSalt(41n)).toBe('0x0000000000000000000000000000000000000000000000000000000000000029');
  });
});
