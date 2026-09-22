import { describe, expect, it } from 'vitest';
import { decodeFunctionData, encodeFunctionData } from 'viem';
import { NonfungiblePositionManager, Pool as V3Pool, Position as V3Position } from '@uniswap/v3-sdk';
import { Percent, Token } from '@uniswap/sdk-core';
import { CHAIN, CONTRACTS } from '../chain';
import { planV3Mint, V3_POSITION_MANAGER_ABI, type V3PoolInfo } from './mint';

const OWNER = '0x000000000000000000000000000000000000dEaD' as const;
const WETH = CONTRACTS.weth as `0x${string}`;
const TOKEN = '0x2222222222222222222222222222222222222222' as const;

/** currency0 is the lower address, as a v3 pool orders its tokens. */
const POOL: V3PoolInfo = {
  address: '0x3333333333333333333333333333333333333333',
  token0: WETH,
  token1: TOKEN,
  fee: 3000,
  tickSpacing: 60,
  decimals0: 18,
  decimals1: 18,
};

/** 1:1, so the maths is easy to reason about by hand. */
const SQRT_1_1 = 79228162514264337593543950336n;

describe('planV3Mint', () => {
  /**
   * The same discipline §20 applied to the v4 encoder: Balast's bytes are
   * compared with Uniswap's own SDK building the same position, so a wrong
   * field order or a mistyped type fails here rather than on chain.
   */
  it('encodes a mint Uniswap’s own SDK would have encoded', () => {
    const plan = planV3Mint({
      pool: POOL,
      sqrtPriceX96: SQRT_1_1,
      tick: 0,
      tokenIsCurrency0: false,
      depositQuote: 10n ** 18n,
      minPct: -10,
      maxPct: 10,
      bins: 1,
      shape: 'spot',
      owner: OWNER,
      slippageBps: 100,
      deadline: 1_800_000_000n,
    });
    expect(plan.positions).toHaveLength(1);
    const p = plan.positions[0];

    const t0 = new Token(CHAIN.id, WETH, 18);
    const t1 = new Token(CHAIN.id, TOKEN, 18);
    const sdkPool = new V3Pool(t0, t1, POOL.fee, SQRT_1_1.toString(), '0', 0);
    const sdkPosition = new V3Position({
      pool: sdkPool,
      liquidity: p.liquidity.toString(),
      tickLower: p.tickLower,
      tickUpper: p.tickUpper,
    });
    const { calldata } = NonfungiblePositionManager.addCallParameters(sdkPosition, {
      recipient: OWNER,
      deadline: '1800000000',
      slippageTolerance: new Percent(100, 10_000),
    });

    expect(plan.calldata.toLowerCase()).toBe(calldata.toLowerCase());
  });

  it('batches several bins through the manager’s own multicall', () => {
    const plan = planV3Mint({
      pool: POOL,
      sqrtPriceX96: SQRT_1_1,
      tick: 0,
      tokenIsCurrency0: false,
      depositQuote: 10n ** 18n,
      minPct: -12,
      maxPct: 12,
      bins: 4,
      shape: 'spot',
      owner: OWNER,
      deadline: 1_800_000_000n,
    });
    expect(plan.positions.length).toBeGreaterThan(1);
    const decoded = decodeFunctionData({ abi: V3_POSITION_MANAGER_ABI, data: plan.calldata });
    expect(decoded.functionName).toBe('multicall');
    const calls = decoded.args?.[0] as readonly `0x${string}`[];
    expect(calls).toHaveLength(plan.positions.length);
    for (const call of calls) {
      expect(decodeFunctionData({ abi: V3_POSITION_MANAGER_ABI, data: call }).functionName).toBe('mint');
    }
  });

  /**
   * ALFA's rule (§27): a pair is entered with this chain's own ether. A v3
   * pool holds the wrapper and never native ether, so the manager is sent
   * the ether and wraps it — and the unspent remainder has to be asked back,
   * or it stays in the manager. `refundETH` is not optional.
   */
  it('pays in ether and asks for the change back', () => {
    const plan = planV3Mint({
      pool: POOL,
      sqrtPriceX96: SQRT_1_1,
      tick: 0,
      tokenIsCurrency0: false,
      depositQuote: 10n ** 18n,
      minPct: -10,
      maxPct: 10,
      bins: 1,
      shape: 'spot',
      owner: OWNER,
      deadline: 1_800_000_000n,
      payWithEtherFor: WETH,
    });
    const decoded = decodeFunctionData({ abi: V3_POSITION_MANAGER_ABI, data: plan.calldata });
    expect(decoded.functionName).toBe('multicall');
    const calls = decoded.args?.[0] as readonly `0x${string}`[];
    expect(decodeFunctionData({ abi: V3_POSITION_MANAGER_ABI, data: calls[calls.length - 1] }).functionName).toBe(
      'refundETH',
    );
    // The value is the wrapped side's amount, and that side is currency0 here.
    expect(plan.value).toBe(plan.amount0);
    expect(plan.value).toBeGreaterThan(0n);
  });

  it('sends no ether for a pair the wallet pays in ERC-20s', () => {
    const plan = planV3Mint({
      pool: { ...POOL, token0: '0x1111111111111111111111111111111111111111', token1: TOKEN },
      sqrtPriceX96: SQRT_1_1,
      tick: 0,
      tokenIsCurrency0: false,
      depositQuote: 10n ** 18n,
      minPct: -10,
      maxPct: 10,
      bins: 1,
      shape: 'spot',
      owner: OWNER,
      deadline: 1_800_000_000n,
      payWithEtherFor: WETH,
    });
    expect(plan.value).toBe(0n);
    expect(decodeFunctionData({ abi: V3_POSITION_MANAGER_ABI, data: plan.calldata }).functionName).toBe('mint');
  });

  /**
   * v3 takes at most `amountDesired`, so the tolerance runs downward — the
   * minimum is what the mint may fall short by. v4's `amountMax` is the
   * opposite, a cap on what may be taken, and passing one convention into
   * the other's field is a mint that either always reverts or guards
   * nothing.
   *
   * And the figure is not a flat percentage off the desired. The guard is
   * "what would this liquidity need if the price moved against it by the
   * tolerance", which at 3% is well below desired × 0.97 — a flat figure
   * would have reverted mints that were perfectly fine.
   */
  it('guards on what an adverse move would really need, as Uniswap defines it', () => {
    const slippageBps = 300;
    const plan = planV3Mint({
      pool: POOL,
      sqrtPriceX96: SQRT_1_1,
      tick: 0,
      tokenIsCurrency0: false,
      depositQuote: 10n ** 18n,
      minPct: -10,
      maxPct: 10,
      bins: 1,
      shape: 'spot',
      owner: OWNER,
      slippageBps,
      deadline: 1_800_000_000n,
    });
    const { args } = decodeFunctionData({ abi: V3_POSITION_MANAGER_ABI, data: plan.calldata });
    const params = args?.[0] as {
      amount0Desired: bigint;
      amount1Desired: bigint;
      amount0Min: bigint;
      amount1Min: bigint;
    };
    expect(params.amount0Desired).toBe(plan.positions[0].amount0);
    expect(params.amount0Min).toBeLessThan(params.amount0Desired);
    expect(plan.amount0Max).toBe(plan.amount0);

    // The same numbers Uniswap's own SDK computes for this position.
    const t0 = new Token(CHAIN.id, WETH, 18);
    const t1 = new Token(CHAIN.id, TOKEN, 18);
    const sdkPool = new V3Pool(t0, t1, POOL.fee, SQRT_1_1.toString(), '0', 0);
    const sdkPosition = new V3Position({
      pool: sdkPool,
      liquidity: plan.positions[0].liquidity.toString(),
      tickLower: plan.positions[0].tickLower,
      tickUpper: plan.positions[0].tickUpper,
    });
    const sdkMin = sdkPosition.mintAmountsWithSlippage(new Percent(slippageBps, 10_000));
    expect(params.amount0Min).toBe(BigInt(sdkMin.amount0.toString()));
    expect(params.amount1Min).toBe(BigInt(sdkMin.amount1.toString()));

    const sdkDesired = sdkPosition.mintAmounts;
    expect(params.amount0Desired).toBe(BigInt(sdkDesired.amount0.toString()));
    expect(params.amount1Desired).toBe(BigInt(sdkDesired.amount1.toString()));
  });

  it('refuses a deposit too small to place rather than minting nothing', () => {
    expect(() =>
      planV3Mint({
        pool: POOL,
        sqrtPriceX96: SQRT_1_1,
        tick: 0,
        tokenIsCurrency0: false,
        depositQuote: 0n,
        minPct: -10,
        maxPct: 10,
        bins: 1,
        shape: 'spot',
        owner: OWNER,
        deadline: 1_800_000_000n,
      }),
    ).toThrow(/positive/);
  });

  it('targets the address Uniswap’s registry gives for this chain', () => {
    expect(CONTRACTS.v3PositionManager.toLowerCase()).toBe('0x73991a25c818bf1f1128deaab1492d45638de0d3');
    // And the encoder is the manager's, not something shaped like it.
    expect(
      encodeFunctionData({ abi: V3_POSITION_MANAGER_ABI, functionName: 'refundETH' }),
    ).toBe('0x12210e8a');
  });
});
