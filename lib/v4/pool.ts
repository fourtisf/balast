/**
 * A Uniswap v4 pool's identity, and the tick arithmetic a position needs.
 *
 * v4 has one contract for every pool; a pool is a `PoolKey` and its id is
 * the keccak of the key's ABI encoding — the same id the indexer stores
 * after `v4:` and the one StateView answers for.
 */

import { encodeAbiParameters, getAddress, keccak256, type Address, type Hex } from 'viem';
import { NATIVE_ETH } from '../chain';
import type { PoolKeyInfo } from '../data/types';
import { MAX_TICK, MIN_TICK } from './tick-math';

export interface PoolKey {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
}

/** The struct exactly as PositionManager decodes it. */
export const POOL_KEY_COMPONENTS = [
  { name: 'currency0', type: 'address' },
  { name: 'currency1', type: 'address' },
  { name: 'fee', type: 'uint24' },
  { name: 'tickSpacing', type: 'int24' },
  { name: 'hooks', type: 'address' },
] as const;

export function toPoolKey(info: PoolKeyInfo): PoolKey {
  return {
    currency0: getAddress(info.currency0),
    currency1: getAddress(info.currency1),
    fee: info.fee,
    tickSpacing: info.tickSpacing,
    hooks: getAddress(info.hooks || NATIVE_ETH),
  };
}

/** keccak256(abi.encode(key)) — `PoolId.toId()` in v4-core. */
export function poolId(key: PoolKey): Hex {
  return keccak256(encodeAbiParameters([{ type: 'tuple', components: POOL_KEY_COMPONENTS }], [key]));
}

/** The indexer's `v4:0x…` identity for this key. */
export function indexerPoolId(key: PoolKey): string {
  return `v4:${poolId(key).toLowerCase()}`;
}

/** How many ticks a price factor is: ln(f) / ln(1.0001). Fractional; callers align. */
export function ticksForFactor(factor: number): number {
  if (!(factor > 0)) throw new RangeError(`price factor must be positive, got ${factor}`);
  return Math.log(factor) / Math.log(1.0001);
}

/** The nearest usable tick at or below `tick` for this spacing, inside the pool's bounds. */
export function alignDown(tick: number, spacing: number): number {
  const aligned = Math.floor(tick / spacing) * spacing;
  return Math.max(aligned, minUsableTick(spacing));
}

/** The nearest usable tick at or above `tick` for this spacing, inside the pool's bounds. */
export function alignUp(tick: number, spacing: number): number {
  const aligned = Math.ceil(tick / spacing) * spacing;
  return Math.min(aligned, maxUsableTick(spacing));
}

export function minUsableTick(spacing: number): number {
  return Math.ceil(MIN_TICK / spacing) * spacing;
}

export function maxUsableTick(spacing: number): number {
  return Math.floor(MAX_TICK / spacing) * spacing;
}

/**
 * The price of currency0 in currency1, in human units, from a sqrt price.
 *
 * Q96 arithmetic is exact in bigint; the division into a JavaScript number
 * happens last, and only for display — every amount that reaches a
 * transaction is computed in bigint from the sqrt price itself.
 */
export function priceFromSqrt(sqrtPriceX96: bigint, decimals0: number, decimals1: number): number {
  const scale = 10n ** 18n;
  const raw = (sqrtPriceX96 * sqrtPriceX96 * scale) >> 192n; // currency1 per currency0, raw units, ×1e18
  return (Number(raw) / 1e18) * 10 ** (decimals0 - decimals1);
}
