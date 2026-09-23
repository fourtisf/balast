import { describe, expect, it } from 'vitest';
import { decodeFunctionData } from 'viem';
import JSBI from 'jsbi';
import { NonfungiblePositionManager, Pool as V3Pool, Position as V3Position, TickMath } from '@uniswap/v3-sdk';
import { CurrencyAmount, Ether, Percent, Token } from '@uniswap/sdk-core';
import { CHAIN, CONTRACTS } from '../chain';
import { burnAmountsWithSlippage, encodeSqrtRatioX96 } from './amounts';
import { V3_MANAGE_ABI, planV3Collect, planV3Withdraw } from './manage';

const OWNER = '0x000000000000000000000000000000000000dEaD' as const;
const WETH = CONTRACTS.weth as `0x${string}`;
const TOKEN = '0x2222222222222222222222222222222222222222' as const;
const OTHER = '0x1111111111111111111111111111111111111111' as const;
const DEADLINE = 1_800_000_000n;

/** A price that is not 1:1, so a swapped side or a wrong rounding shows. */
const SQRT_2_1 = encodeSqrtRatioX96(2n, 1n);
const TICK_2_1 = TickMath.getTickAtSqrtRatio(JSBI.BigInt(SQRT_2_1.toString()));

function sdkPosition(token0: string, token1: string, sqrt: bigint, tick: number, liquidity: bigint, lower: number, upper: number) {
  const pool = new V3Pool(new Token(CHAIN.id, token0, 18), new Token(CHAIN.id, token1, 18), 3000, sqrt.toString(), '0', tick);
  return new V3Position({ pool, liquidity: liquidity.toString(), tickLower: lower, tickUpper: upper });
}

describe('v3 collect and withdraw', () => {
  it('collects a token pair straight to the owner, as the SDK does', () => {
    const plan = planV3Collect({
      tokenId: 42n,
      token0: OTHER,
      token1: TOKEN,
      owner: OWNER,
      unwrap: null,
      expected0: 0n,
      expected1: 0n,
    });
    const t0 = new Token(CHAIN.id, OTHER, 18);
    const t1 = new Token(CHAIN.id, TOKEN, 18);
    const { calldata } = NonfungiblePositionManager.collectCallParameters({
      tokenId: '42',
      recipient: OWNER,
      expectedCurrencyOwed0: CurrencyAmount.fromRawAmount(t0, '0'),
      expectedCurrencyOwed1: CurrencyAmount.fromRawAmount(t1, '0'),
    });
    expect(plan.calldata.toLowerCase()).toBe(calldata.toLowerCase());
    expect(plan.value).toBe(0n);
  });

  /**
   * An ether pair is ETH (§27): the wrapped side is collected into the
   * manager, unwrapped and sent as ether, and the token swept to the owner.
   */
  it('collects the ether side as ETH, byte for byte with the SDK', () => {
    const plan = planV3Collect({
      tokenId: 7n,
      token0: WETH,
      token1: TOKEN,
      owner: OWNER,
      unwrap: WETH,
      expected0: 1234n,
      expected1: 5678n,
    });
    const { calldata } = NonfungiblePositionManager.collectCallParameters({
      tokenId: '7',
      recipient: OWNER,
      expectedCurrencyOwed0: CurrencyAmount.fromRawAmount(Ether.onChain(CHAIN.id), '1234'),
      expectedCurrencyOwed1: CurrencyAmount.fromRawAmount(new Token(CHAIN.id, TOKEN, 18), '5678'),
    });
    expect(plan.calldata.toLowerCase()).toBe(calldata.toLowerCase());
  });

  it('never unwraps when the manager’s wrapper was not confirmed', () => {
    const plan = planV3Collect({
      tokenId: 7n,
      token0: WETH,
      token1: TOKEN,
      owner: OWNER,
      unwrap: null,
      expected0: 0n,
      expected1: 0n,
    });
    // One call, sent as itself rather than through multicall.
    const collect = decodeFunctionData({ abi: V3_MANAGE_ABI, data: plan.calldata });
    expect(collect.functionName).toBe('collect');
    // Straight to the owner: nothing is left in the manager for anyone to sweep.
    expect((collect.args?.[0] as { recipient: string }).recipient.toLowerCase()).toBe(OWNER.toLowerCase());
  });

  it('withdraws in full — decrease, collect as ETH, burn — exactly as the SDK removes a position', () => {
    const liquidity = 10n ** 20n;
    const lower = TICK_2_1 - 600 - (TICK_2_1 % 60);
    const upper = lower + 1800;
    const plan = planV3Withdraw({
      tokenId: 99n,
      token0: WETH,
      token1: TOKEN,
      owner: OWNER,
      unwrap: WETH,
      sqrtPriceX96: SQRT_2_1,
      tickLower: lower,
      tickUpper: upper,
      liquidity,
      owed0: 11n,
      owed1: 22n,
      slippageBps: 100,
      deadline: DEADLINE,
    });

    const position = sdkPosition(WETH, TOKEN, SQRT_2_1, TICK_2_1, liquidity, lower, upper);
    const { calldata } = NonfungiblePositionManager.removeCallParameters(position, {
      tokenId: '99',
      liquidityPercentage: new Percent(1),
      slippageTolerance: new Percent(100, 10_000),
      deadline: DEADLINE.toString(),
      burnToken: true,
      collectOptions: {
        recipient: OWNER,
        expectedCurrencyOwed0: CurrencyAmount.fromRawAmount(Ether.onChain(CHAIN.id), '11'),
        expectedCurrencyOwed1: CurrencyAmount.fromRawAmount(new Token(CHAIN.id, TOKEN, 18), '22'),
      },
    });
    expect(plan.calldata.toLowerCase()).toBe(calldata.toLowerCase());
    // Both sides are guarded: the price sits inside the range.
    expect(plan.amount0Min).toBeGreaterThan(0n);
    expect(plan.amount1Min).toBeGreaterThan(0n);
  });

  it('computes the SDK’s burn minimums below, inside and above the range', () => {
    const liquidity = 123_456_789_000_000_000n;
    for (const [lower, upper] of [
      [TICK_2_1 + 600, TICK_2_1 + 1200],
      [TICK_2_1 - 600, TICK_2_1 + 600],
      [TICK_2_1 - 1200, TICK_2_1 - 600],
    ]) {
      const lo = lower - (((lower % 60) + 60) % 60);
      const hi = upper - (((upper % 60) + 60) % 60);
      const ours = burnAmountsWithSlippage({ sqrtPriceX96: SQRT_2_1, tickLower: lo, tickUpper: hi, liquidity, slippageBps: 50n });
      const sdk = sdkPosition(OTHER, TOKEN, SQRT_2_1, TICK_2_1, liquidity, lo, hi).burnAmountsWithSlippage(new Percent(50, 10_000));
      expect(ours.amount0.toString()).toBe(sdk.amount0.toString());
      expect(ours.amount1.toString()).toBe(sdk.amount1.toString());
    }
  });

  it('skips the decrease for an empty position and still collects what is owed before the burn', () => {
    const plan = planV3Withdraw({
      tokenId: 5n,
      token0: OTHER,
      token1: TOKEN,
      owner: OWNER,
      unwrap: null,
      sqrtPriceX96: SQRT_2_1,
      tickLower: -600,
      tickUpper: 600,
      liquidity: 0n,
      owed0: 3n,
      owed1: 4n,
      deadline: DEADLINE,
    });
    const decoded = decodeFunctionData({ abi: V3_MANAGE_ABI, data: plan.calldata });
    const names = (decoded.args?.[0] as readonly `0x${string}`[]).map(
      (c) => decodeFunctionData({ abi: V3_MANAGE_ABI, data: c }).functionName,
    );
    // decreaseLiquidity reverts on zero liquidity, so it is not sent.
    expect(names).toEqual(['collect', 'burn']);
  });
});
