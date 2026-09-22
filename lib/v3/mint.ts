/**
 * A shaped position in a Uniswap **v3** pool, as one transaction.
 *
 * Balast deploys no contract of its own (§20) and mints through Uniswap's
 * own periphery. For v4 that is the PositionManager; for v3 it is the
 * NonfungiblePositionManager, deployed on this chain at the address Uniswap's
 * registry gives for chainId 4663.
 *
 * This exists because a token's **ether market here is often a v3 pool**.
 * VIRTUAL's is, and CASHCAT's, so the builder offered those tokens their
 * USDG market and nothing else, three times over. That was never a fact
 * about the chain — v3's position manager is deployed and its `mint` is a
 * simpler call than v4's — it was a gap in what had been built.
 *
 * Everything above the encoding is shared with the v4 planner: the same
 * range ticks, the same tick-spacing split, the same shape weights and the
 * same liquidity maths, so a shape means the same thing in either venue.
 * What differs is the call:
 *
 *   - v3 `mint` takes **desired amounts and minimums**, not a liquidity
 *     figure, so each bin's own amounts become its own caps. One bin cannot
 *     draw on another's, exactly as the v4 plan caps each position.
 *   - Several bins are several `mint` calls, batched through the periphery's
 *     own `multicall`.
 *   - A v3 pool holds **wrapped** ether, never native. The manager is
 *     payable and wraps what it is sent, so the person still pays in ETH —
 *     which is what ALFA asked for — and `refundETH` returns the rest. It is
 *     the last call in the batch, and it is not optional: without it the
 *     unspent ether stays in the manager.
 */

import { encodeFunctionData, parseAbi, type Address, type Hex } from 'viem';
import { shapeWeights, weightsToBps } from '../shapes';
import type { ShapeId } from '../data/types';
import { amount0InCurrency1, liquidityForValue } from '../v4/liquidity';
import { rangeTicks, splitRange, type PlannedPosition } from '../v4/mint';
import { maxUsableTick, minUsableTick } from '../v4/pool';
import { mintAmounts, mintAmountsWithSlippage } from './amounts';

export const V3_POSITION_MANAGER_ABI = parseAbi([
  'struct MintParams { address token0; address token1; uint24 fee; int24 tickLower; int24 tickUpper; uint256 amount0Desired; uint256 amount1Desired; uint256 amount0Min; uint256 amount1Min; address recipient; uint256 deadline; }',
  'function mint(MintParams params) payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)',
  'function multicall(bytes[] data) payable returns (bytes[] results)',
  'function refundETH() payable',
  'function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)',
]);

/** The pool's own `slot0`, which is where a v3 price is read from. */
export const V3_POOL_ABI = parseAbi([
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
]);

export interface V3PoolInfo {
  /** The pool contract, which the indexer already knows for every v3 pool. */
  address: Address;
  token0: Address;
  token1: Address;
  /** Hundredths of a bip, as the pool's own `fee()` reports it. */
  fee: number;
  tickSpacing: number;
  decimals0: number;
  decimals1: number;
}

export interface V3MintInput {
  pool: V3PoolInfo;
  sqrtPriceX96: bigint;
  tick: number;
  tokenIsCurrency0: boolean;
  depositQuote: bigint;
  minPct: number;
  maxPct: number;
  bins: number;
  shape: ShapeId;
  fullRange?: boolean;
  owner: Address;
  slippageBps?: number;
  deadline: bigint;
  /**
   * The wrapper's address, when the quote side is it and the person is
   * paying in ether. The manager wraps what it is sent; omit to pay with
   * the ERC-20 the wallet already holds.
   */
  payWithEtherFor?: Address;
}

export interface V3MintPlan {
  positions: PlannedPosition[];
  tickLower: number;
  tickUpper: number;
  amount0: bigint;
  amount1: bigint;
  amount0Max: bigint;
  amount1Max: bigint;
  /** msg.value: the wrapped side's cap when paying in ether, else zero. */
  value: bigint;
  calldata: Hex;
}

export function planV3Mint(input: V3MintInput): V3MintPlan {
  const { pool, sqrtPriceX96, tick, tokenIsCurrency0, depositQuote, owner, deadline } = input;
  const slippageBps = BigInt(input.slippageBps ?? 100);
  if (depositQuote <= 0n) throw new RangeError('deposit must be positive');

  const { tickLower, tickUpper } = input.fullRange
    ? { tickLower: minUsableTick(pool.tickSpacing), tickUpper: maxUsableTick(pool.tickSpacing) }
    : rangeTicks({
        tick,
        tickSpacing: pool.tickSpacing,
        tokenIsCurrency0,
        minPct: input.minPct,
        maxPct: input.maxPct,
      });
  const ranges: [number, number][] = input.fullRange
    ? [[tickLower, tickUpper]]
    : splitRange(tickLower, tickUpper, pool.tickSpacing, input.bins);

  const quoteIsCurrency0 = !tokenIsCurrency0;
  const valueIn1 = quoteIsCurrency0 ? amount0InCurrency1(depositQuote, sqrtPriceX96) : depositQuote;

  let bps = weightsToBps(shapeWeights(input.shape, ranges.length));
  if (!tokenIsCurrency0) bps = [...bps].reverse();

  const positions: PlannedPosition[] = [];
  ranges.forEach(([lo, hi], i) => {
    const share = (valueIn1 * BigInt(bps[i])) / 10_000n;
    const liquidity = liquidityForValue({ sqrtPriceX96, tickLower: lo, tickUpper: hi, valueIn1: share });
    if (liquidity <= 0n) return;
    // v3's own rounding: the desired amounts round UP, because they are what
    // the manager may pull to reach this liquidity.
    const { amount0, amount1 } = mintAmounts({ sqrtPriceX96, tickLower: lo, tickUpper: hi, liquidity });
    positions.push({ tickLower: lo, tickUpper: hi, liquidity, amount0, amount1 });
  });
  if (positions.length === 0) throw new RangeError('the deposit is too small to place');

  const amount0 = positions.reduce((s, p) => s + p.amount0, 0n);
  const amount1 = positions.reduce((s, p) => s + p.amount1, 0n);
  // Desired is what the manager may pull; the minimum is what the mint may
  // fall short by before it reverts — the opposite direction from v4's
  // `amountMax`, which is a cap. It is not a flat percentage off the
  // desired: the guard is what this liquidity would need if the price moved
  // against it by the tolerance, which is Uniswap's own definition.
  const calls: Hex[] = positions.map((p) => {
    const min = mintAmountsWithSlippage({
      sqrtPriceX96,
      tickLower: p.tickLower,
      tickUpper: p.tickUpper,
      liquidity: p.liquidity,
      slippageBps,
    });
    return encodeFunctionData({
      abi: V3_POSITION_MANAGER_ABI,
      functionName: 'mint',
      args: [
        {
          token0: pool.token0,
          token1: pool.token1,
          fee: pool.fee,
          tickLower: p.tickLower,
          tickUpper: p.tickUpper,
          amount0Desired: p.amount0,
          amount1Desired: p.amount1,
          amount0Min: min.amount0,
          amount1Min: min.amount1,
          recipient: owner,
          deadline,
        },
      ],
    });
  });

  // Paying in ether: the manager wraps what it is sent, and the remainder
  // has to be asked back. Without this call it stays in the manager.
  const wrapped = input.payWithEtherFor?.toLowerCase();
  const payingEther =
    wrapped === pool.token0.toLowerCase() || wrapped === pool.token1.toLowerCase() ? wrapped : null;
  if (payingEther) {
    calls.push(encodeFunctionData({ abi: V3_POSITION_MANAGER_ABI, functionName: 'refundETH' }));
  }

  const value = payingEther === pool.token0.toLowerCase() ? amount0 : payingEther ? amount1 : 0n;

  return {
    positions,
    tickLower,
    tickUpper,
    amount0,
    amount1,
    amount0Max: amount0,
    amount1Max: amount1,
    value,
    calldata:
      calls.length === 1 && !payingEther
        ? calls[0]
        : encodeFunctionData({ abi: V3_POSITION_MANAGER_ABI, functionName: 'multicall', args: [calls] }),
  };
}
