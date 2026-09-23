/**
 * The zap's encoders against Uniswap's own, and its arithmetic.
 *
 * A swap sent with the wrong layout is a revert at best and a trade with no
 * minimum at worst, so the v4 swap is compared as bytes with the SDK's
 * V4Planner at both router versions, and the v3 swap with SwapRouter02's
 * published ABI.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Actions as SdkActions, URVersion, V4Planner } from '@uniswap/v4-sdk';
import { decodeFunctionData, encodeFunctionData, type Abi, type Address } from 'viem';
import { describe, expect, it } from 'vitest';
import { CONTRACTS } from './chain';
import {
  QUOTER_V2_ABI,
  SWAP_ROUTER02_ABI,
  SwapActions,
  UNIVERSAL_ROUTER_ABI,
  coverBps,
  encodeV3Swap,
  encodeV4Swap,
  encodeV4SwapInput,
  fitBps,
  sizeZap,
  valueInOther,
  zapCandidate,
} from './zap';
import type { PoolKey } from './v4/pool';

const KEY: PoolKey = {
  currency0: '0x0000000000000000000000000000000000000000',
  currency1: '0x4200000000000000000000000000000000000006',
  fee: 3000,
  tickSpacing: 60,
  hooks: '0x0000000000000000000000000000000000000000',
};
const OWNER = '0x000000000000000000000000000000000000dEaD' as Address;
const Q96 = 1n << 96n;

function artifactAbi(path: string): Abi {
  return (JSON.parse(readFileSync(join(__dirname, '..', 'node_modules', '@uniswap', path), 'utf8')) as { abi: Abi }).abi;
}

describe('v4 swap through the Universal Router', () => {
  const args = { key: KEY, zeroForOne: true, amountIn: 123_456_789n, amountOutMinimum: 98_765n };

  it('uses the action ids in v4-periphery Actions.sol', () => {
    expect(SwapActions.SWAP_EXACT_IN_SINGLE).toBe(SdkActions.SWAP_EXACT_IN_SINGLE);
    expect(SwapActions.SETTLE_ALL).toBe(SdkActions.SETTLE_ALL);
    expect(SwapActions.TAKE_ALL).toBe(SdkActions.TAKE_ALL);
  });

  for (const [version, sdk] of [
    ['v2.1.1', URVersion.V2_1_1],
    ['v2.0', URVersion.V2_0],
  ] as const) {
    it(`is byte-identical to the SDK planner at router ${version}`, () => {
      const planner = new V4Planner();
      planner.addAction(
        SdkActions.SWAP_EXACT_IN_SINGLE,
        [
          {
            poolKey: KEY,
            zeroForOne: true,
            amountIn: args.amountIn.toString(),
            amountOutMinimum: args.amountOutMinimum.toString(),
            ...(version === 'v2.1.1' ? { minHopPriceX36: '0' } : {}),
            hookData: '0x',
          },
        ],
        sdk,
      );
      planner.addAction(SdkActions.SETTLE_ALL, [KEY.currency0, args.amountIn.toString()]);
      planner.addAction(SdkActions.TAKE_ALL, [KEY.currency1, args.amountOutMinimum.toString()]);
      expect(encodeV4SwapInput({ ...args, version }).toLowerCase()).toBe(planner.finalize().toLowerCase());
    });
  }

  it('sends ether in as exactly the amount settled, and nothing for a token in', () => {
    const native = encodeV4Swap({ ...args, deadline: 99n });
    expect(native.to).toBe(CONTRACTS.universalRouter);
    expect(native.value).toBe(args.amountIn);
    const decoded = decodeFunctionData({ abi: UNIVERSAL_ROUTER_ABI, data: native.calldata });
    expect(decoded.args[0]).toBe('0x10');
    expect(decoded.args[2]).toBe(99n);
    expect(encodeV4Swap({ ...args, zeroForOne: false, deadline: 99n }).value).toBe(0n);
  });
});

describe('v3 swap through SwapRouter02', () => {
  const router = artifactAbi('swap-router-contracts/artifacts/contracts/SwapRouter02.sol/SwapRouter02.json');
  const swap = {
    tokenIn: CONTRACTS.weth as Address,
    tokenOut: '0x1111111111111111111111111111111111111111' as Address,
    fee: 3000,
    recipient: OWNER,
    amountIn: 10n ** 17n,
    amountOutMinimum: 5n * 10n ** 18n,
  };

  it('matches the calldata built from the router’s own ABI, ether refunded', () => {
    const call = encodeV3Swap({ ...swap, deadline: 1234n, payWithEther: true });
    const exact = encodeFunctionData({ abi: router, functionName: 'exactInputSingle', args: [{ ...swap, sqrtPriceLimitX96: 0n }] });
    const refund = encodeFunctionData({ abi: router, functionName: 'refundETH' });
    const expected = encodeFunctionData({ abi: router, functionName: 'multicall', args: [1234n, [exact, refund]] });
    expect(call.calldata).toBe(expected);
    expect(call.value).toBe(swap.amountIn);
    expect(call.to).toBe(CONTRACTS.swapRouter02);
  });

  it('sends no value and no refund when the token is pulled', () => {
    const call = encodeV3Swap({ ...swap, deadline: 1234n, payWithEther: false });
    expect(call.value).toBe(0n);
    const outer = decodeFunctionData({ abi: SWAP_ROUTER02_ABI, data: call.calldata });
    expect((outer.args[1] as readonly unknown[]).length).toBe(1);
  });

  it('asks QuoterV2 with its own layout', () => {
    const quoter = artifactAbi('v3-periphery/artifacts/contracts/lens/QuoterV2.sol/QuoterV2.json');
    const p = { tokenIn: swap.tokenIn, tokenOut: swap.tokenOut, amountIn: 7n, fee: 500, sqrtPriceLimitX96: 0n };
    expect(encodeFunctionData({ abi: QUOTER_V2_ABI, functionName: 'quoteExactInputSingle', args: [p] })).toBe(
      encodeFunctionData({ abi: quoter, functionName: 'quoteExactInputSingle', args: [p] }),
    );
  });
});

describe('zap arithmetic', () => {
  it('values one side in the other at the pool price, both ways', () => {
    const sqrt = 2n * Q96; // price 4: one currency0 is four currency1
    expect(valueInOther(10n, sqrt, true)).toBe(40n);
    expect(valueInOther(40n, sqrt, false)).toBe(10n);
  });

  it('knows which way to swap, and when it cannot', () => {
    expect(zapCandidate({ needToken: 100n, needQuote: 50n, haveToken: 0n, haveQuote: 500n })).toEqual({ direction: 'quote-to-token', want: 100n });
    expect(zapCandidate({ needToken: 100n, needQuote: 50n, haveToken: 900n, haveQuote: 10n })).toEqual({ direction: 'token-to-quote', want: 40n });
    expect(zapCandidate({ needToken: 100n, needQuote: 50n, haveToken: 0n, haveQuote: 0n })).toBeNull();
    expect(zapCandidate({ needToken: 100n, needQuote: 50n, haveToken: 100n, haveQuote: 50n })).toBeNull();
  });

  it('fits a small shortfall, a larger one only after a zap, and never a large one', () => {
    const h = (haveToken: bigint) => ({ needToken: 1000n, needQuote: 1000n, haveToken, haveQuote: 5000n });
    expect(coverBps(h(990n))).toBe(9900);
    expect(fitBps(h(1000n), false)).toBeNull();
    expect(fitBps(h(990n), false)).toBe(9890);
    expect(fitBps(h(900n), false)).toBeNull();
    expect(fitBps(h(900n), true)).toBe(8990);
    expect(fitBps(h(800n), true)).toBeNull();
  });

  it('sizes the swap to deliver what is wanted, and reports what it costs', async () => {
    // Price 1 (sqrt = Q96), a 1% fee and no impact: out = in × 0.99.
    const quote = async (amountIn: bigint) => (amountIn * 99n) / 100n;
    const z = await sizeZap({
      direction: 'quote-to-token',
      want: 1_000_000n,
      surplus: 10n ** 12n,
      sqrtPriceX96: Q96,
      tokenIsCurrency0: true,
      feePips: 10_000,
      slippageBps: 100,
      quote,
    });
    expect(z.expectedOut).toBeGreaterThanOrEqual(1_000_000n);
    expect(z.expectedOut).toBeLessThan(1_000_010n);
    expect(z.lossBps).toBeGreaterThanOrEqual(99);
    expect(z.lossBps).toBeLessThanOrEqual(100);
    expect(z.minOut).toBe((z.expectedOut * 9_900n) / 10_000n);
  });

  it('never spends more than the surplus', async () => {
    const z = await sizeZap({
      direction: 'token-to-quote',
      want: 1_000_000n,
      surplus: 500_000n,
      sqrtPriceX96: Q96,
      tokenIsCurrency0: false,
      feePips: 3000,
      slippageBps: 50,
      quote: async (a) => a / 2n,
    });
    expect(z.amountIn).toBe(500_000n);
    expect(z.lossBps).toBe(5000);
  });
});

describe('v4 swap paid in ETH into a pool quoted in the wrapper', () => {
  const WKEY: PoolKey = { ...KEY, currency0: '0x1111111111111111111111111111111111111111', currency1: CONTRACTS.weth as Address };

  it('wraps in the router, then settles from the router, byte-identical to the SDK planner', () => {
    const planner = new V4Planner();
    planner.addAction(
      SdkActions.SWAP_EXACT_IN_SINGLE,
      [{ poolKey: WKEY, zeroForOne: false, amountIn: '1000', amountOutMinimum: '900', minHopPriceX36: '0', hookData: '0x' }],
      URVersion.V2_1_1,
    );
    planner.addAction(SdkActions.SETTLE, [WKEY.currency1, '1000', false]);
    planner.addAction(SdkActions.TAKE_ALL, [WKEY.currency0, '900']);
    const call = encodeV4Swap({ key: WKEY, zeroForOne: false, amountIn: 1000n, amountOutMinimum: 900n, deadline: 5n, wrapEtherIn: true });
    const decoded = decodeFunctionData({ abi: UNIVERSAL_ROUTER_ABI, data: call.calldata });
    expect(decoded.args[0]).toBe('0x0b10');
    const inputs = decoded.args[1] as readonly `0x${string}`[];
    expect(inputs[1].toLowerCase()).toBe(planner.finalize().toLowerCase());
    // WRAP_ETH to the router itself (ADDRESS_THIS = 2), exactly the amount the swap settles.
    expect(inputs[0]).toBe(`0x${'2'.padStart(64, '0')}${(1000).toString(16).padStart(64, '0')}`);
    expect(call.value).toBe(1000n);
  });

  it('refuses to wrap for a pool that already holds native ether', () => {
    expect(() => encodeV4Swap({ key: KEY, zeroForOne: true, amountIn: 1n, amountOutMinimum: 1n, deadline: 1n, wrapEtherIn: true })).toThrow();
  });
});
