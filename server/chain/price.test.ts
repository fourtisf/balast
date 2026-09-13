import { describe, expect, it } from 'vitest';
import { getSqrtRatioAtTick } from './tick-math';
import {
  feeFromSwap,
  fromUnits,
  invertPrice,
  priceFromSqrtX96,
  swapInputSide,
  tokenPriceInWeth,
  wethPriceUsd,
} from './price';

const Q96 = 2n ** 96n;

/** sqrtPriceX96 for a given token1-per-token0 price, both sides 18 decimals. */
function sqrtFor(price: number): bigint {
  return BigInt(Math.floor(Math.sqrt(price) * 2 ** 96));
}

describe('priceFromSqrtX96', () => {
  it('is 1 at 2^96 for a matched-decimals pair', () => {
    expect(priceFromSqrtX96(Q96, 18, 18)).toBeCloseTo(1, 12);
  });

  it('reads token1 per token0', () => {
    expect(priceFromSqrtX96(sqrtFor(2500), 18, 18)).toBeCloseTo(2500, 6);
    expect(priceFromSqrtX96(sqrtFor(0.0004), 18, 18)).toBeCloseTo(0.0004, 12);
  });

  it('corrects for a decimals mismatch', () => {
    // USDG at 6 decimals against WETH at 18: the wei ratio is 1e-12 of the
    // human ratio, and getting this backwards is a 1e24 error on every price.
    const humanPrice = 2500; // USDG per WETH
    const weiRatio = humanPrice / 1e12; // 6-dec units per 18-dec unit
    expect(priceFromSqrtX96(sqrtFor(weiRatio), 18, 6)).toBeCloseTo(humanPrice, 4);
  });

  it('is zero for an uninitialised pool rather than NaN', () => {
    expect(priceFromSqrtX96(0n, 18, 18)).toBe(0);
    expect(priceFromSqrtX96(-1n, 18, 18)).toBe(0);
  });

  it('survives an extreme but legal price', () => {
    const top = priceFromSqrtX96(getSqrtRatioAtTick(800_000), 18, 18);
    expect(Number.isFinite(top)).toBe(true);
    expect(top).toBeGreaterThan(0);
  });
});

describe('invertPrice', () => {
  it('round-trips', () => {
    expect(invertPrice(invertPrice(1234.5))).toBeCloseTo(1234.5, 9);
  });
  it('returns zero rather than Infinity at zero', () => {
    expect(invertPrice(0)).toBe(0);
  });
});

describe('tokenPriceInWeth', () => {
  // The two orderings are the single most common way to ship a site where
  // every price is the reciprocal of the truth, so both are pinned.
  it('reads the ratio directly when WETH is token1', () => {
    const p = tokenPriceInWeth({
      sqrtPriceX96: sqrtFor(0.002), // WETH per token
      tokenDecimals: 18,
      wethDecimals: 18,
      wethIsToken1: true,
    });
    expect(p).toBeCloseTo(0.002, 9);
  });

  it('inverts when WETH is token0', () => {
    const p = tokenPriceInWeth({
      sqrtPriceX96: sqrtFor(500), // tokens per WETH
      tokenDecimals: 18,
      wethDecimals: 18,
      wethIsToken1: false,
    });
    expect(p).toBeCloseTo(1 / 500, 9);
  });

  it('gives the same answer whichever side WETH sits on', () => {
    const direct = tokenPriceInWeth({
      sqrtPriceX96: sqrtFor(0.002),
      tokenDecimals: 18,
      wethDecimals: 18,
      wethIsToken1: true,
    });
    const inverted = tokenPriceInWeth({
      sqrtPriceX96: sqrtFor(1 / 0.002),
      tokenDecimals: 18,
      wethDecimals: 18,
      wethIsToken1: false,
    });
    expect(inverted).toBeCloseTo(direct, 9);
  });
});

describe('wethPriceUsd', () => {
  it('prices WETH from the WETH/USDG pool, both orderings', () => {
    const asToken0 = wethPriceUsd({
      sqrtPriceX96: sqrtFor(2521.08 / 1e12),
      wethDecimals: 18,
      usdgDecimals: 6,
      usdgIsToken1: true,
    });
    expect(asToken0).toBeCloseTo(2521.08, 3);

    const asToken1 = wethPriceUsd({
      sqrtPriceX96: sqrtFor((1 / 2521.08) * 1e12),
      wethDecimals: 18,
      usdgDecimals: 6,
      usdgIsToken1: false,
    });
    expect(asToken1).toBeCloseTo(2521.08, 0);
  });

  it('is zero when the anchor pool is uninitialised', () => {
    // §4 allows one anchor and one path. A missing anchor has to read as zero
    // and break visibly, not fall back to a guess.
    expect(
      wethPriceUsd({ sqrtPriceX96: 0n, wethDecimals: 18, usdgDecimals: 6, usdgIsToken1: true }),
    ).toBe(0);
  });
});

describe('fromUnits', () => {
  it('converts whole and fractional parts', () => {
    expect(fromUnits(10n ** 18n, 18)).toBe(1);
    expect(fromUnits(1_500_000n, 6)).toBe(1.5);
    expect(fromUnits(0n, 18)).toBe(0);
  });

  it('keeps the sign', () => {
    expect(fromUnits(-(10n ** 18n) / 2n, 18)).toBe(-0.5);
  });

  it('does not lose the integer part of a large balance', () => {
    // 6.2 million WETH: bigger than any pool here, and still exact to the
    // dollar after conversion.
    const amount = 6_200_000n * 10n ** 18n;
    expect(fromUnits(amount, 18)).toBeCloseTo(6_200_000, 6);
  });

  it('handles a token with fewer decimals than the kept precision', () => {
    expect(fromUnits(12345n, 2)).toBe(123.45);
  });
});

describe('feeFromSwap', () => {
  it('takes the fee off the input at the given pips', () => {
    // 0.30% of 1000 tokens.
    expect(feeFromSwap(1000n * 10n ** 18n, 3000)).toBe(3n * 10n ** 18n);
  });

  it('uses the pips the swap actually charged, not a tier', () => {
    // A dynamic-fee hook charging 1% on this one swap (§3.2, §4).
    expect(feeFromSwap(1000n * 10n ** 18n, 10_000)).toBe(10n * 10n ** 18n);
  });

  it('is zero for a zero or negative input', () => {
    expect(feeFromSwap(0n, 3000)).toBe(0n);
    expect(feeFromSwap(-100n, 3000)).toBe(0n);
    expect(feeFromSwap(100n, 0)).toBe(0n);
  });
});

describe('swapInputSide', () => {
  it('identifies the side that entered the pool', () => {
    expect(swapInputSide(100n, -90n)).toBe(0);
    expect(swapInputSide(-90n, 100n)).toBe(1);
  });

  it('refuses to guess when both sides move the same way', () => {
    // Never attribute a fee to a swap we cannot read. A zero-fee row is
    // honest; a guessed one quietly inflates the yield on the board.
    expect(swapInputSide(100n, 100n)).toBeNull();
    expect(swapInputSide(-1n, -1n)).toBeNull();
    expect(swapInputSide(0n, 0n)).toBeNull();
  });
});
