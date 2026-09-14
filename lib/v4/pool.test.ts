import { Ether, Token } from '@uniswap/sdk-core';
import { Pool } from '@uniswap/v4-sdk';
import { describe, expect, it } from 'vitest';
import { CHAIN } from '../chain';
import { alignDown, alignUp, indexerPoolId, maxUsableTick, minUsableTick, poolId, priceFromSqrt, ticksForFactor, toPoolKey } from './pool';
import { getSqrtRatioAtTick } from './tick-math';

const USDG = '0x1111111111111111111111111111111111111111';
const ZERO = '0x0000000000000000000000000000000000000000';

describe('poolId', () => {
  it('is the id Uniswap\'s SDK derives for the same key, for an ether pool and an ERC20 pool', () => {
    const key = toPoolKey({ currency0: ZERO, currency1: USDG, fee: 500, tickSpacing: 10, hooks: '', decimals0: 18, decimals1: 6 });
    const sdk = Pool.getPoolId(Ether.onChain(CHAIN.id), new Token(CHAIN.id, USDG, 6), 500, 10, ZERO);
    expect(poolId(key).toLowerCase()).toBe(sdk.toLowerCase());
    expect(indexerPoolId(key)).toBe(`v4:${sdk.toLowerCase()}`);

    const a = '0x2222222222222222222222222222222222222222';
    const key2 = toPoolKey({ currency0: USDG, currency1: a, fee: 3000, tickSpacing: 60, hooks: a, decimals0: 6, decimals1: 18 });
    const sdk2 = Pool.getPoolId(new Token(CHAIN.id, USDG, 6), new Token(CHAIN.id, a, 18), 3000, 60, a);
    expect(poolId(key2).toLowerCase()).toBe(sdk2.toLowerCase());
  });

  it('checksums the addresses and reads an empty hooks column as no hook', () => {
    const key = toPoolKey({ currency0: ZERO, currency1: USDG.toLowerCase(), fee: 500, tickSpacing: 10, hooks: '', decimals0: 18, decimals1: 6 });
    expect(key.hooks).toBe(ZERO);
    expect(key.currency1).toBe(USDG);
  });
});

describe('ticks', () => {
  it('turns a price factor into ticks: 1.0001 is one tick, 1 is none', () => {
    expect(ticksForFactor(1.0001)).toBeCloseTo(1, 6);
    expect(ticksForFactor(1)).toBe(0);
    expect(ticksForFactor(0.85)).toBeCloseTo(-1625.2, 0);
  });

  it('aligns to the spacing in the safe direction and stays inside the pool', () => {
    expect(alignDown(-1625.2, 60)).toBe(-1680);
    expect(alignUp(1397.9, 60)).toBe(1440);
    expect(alignDown(-1_000_000, 60)).toBe(minUsableTick(60));
    expect(alignUp(1_000_000, 60)).toBe(maxUsableTick(60));
    expect(minUsableTick(60)).toBe(-887220);
    expect(maxUsableTick(60)).toBe(887220);
  });
});

describe('priceFromSqrt', () => {
  it('reads tick 0 as 1 for equal decimals and as 1e12 for an 18/6 pair', () => {
    expect(priceFromSqrt(getSqrtRatioAtTick(0), 18, 18)).toBeCloseTo(1, 12);
    expect(priceFromSqrt(getSqrtRatioAtTick(0), 18, 6)).toBeCloseTo(1e12, 0);
  });
  it('follows 1.0001^tick', () => {
    expect(priceFromSqrt(getSqrtRatioAtTick(6931), 18, 18)).toBeCloseTo(1.0001 ** 6931, 3);
  });
});
