/**
 * The events §4 subscribes to, as viem ABI fragments.
 *
 * Two protocols, because some older pools on this chain are v3 and the
 * listing has to include them. The shapes differ in ways that matter:
 *
 *   v4 Swap carries the pool id and the fee actually charged on that swap, so
 *   a hook running a dynamic fee is attributed correctly rather than at the
 *   static tier.
 *
 *   v3 Swap carries neither — the pool is the emitting address and the fee is
 *   the pool's immutable tier, read from the pool at discovery.
 *
 *   v4 ModifyLiquidity carries a liquidity delta but NOT token amounts, so the
 *   amounts are computed at ingest. See indexer/amounts.ts.
 */

import { parseAbi, toEventSelector, type AbiEvent } from 'viem';

/** Uniswap v4 PoolManager (§2). One contract, every pool. */
export const POOL_MANAGER_ABI = parseAbi([
  'event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)',
  'event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)',
  'event ModifyLiquidity(bytes32 indexed id, address indexed sender, int24 tickLower, int24 tickUpper, int256 liquidityDelta, bytes32 salt)',
]);

/** Uniswap v3 pool. One contract per pool, so the address identifies it. */
export const V3_POOL_ABI = parseAbi([
  'event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)',
  'event Mint(address sender, address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)',
  'event Burn(address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)',
]);

/** v3 factory, for discovering v3 pools the same way Initialize discovers v4. */
export const V3_FACTORY_ABI = parseAbi([
  'event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)',
]);

/** topic0 of every event in an ABI. */
function selectors(abi: readonly { type: string }[]): string[] {
  return abi.filter((item) => item.type === 'event').map((item) => toEventSelector(item as AbiEvent).toLowerCase());
}

/**
 * The event signatures the indexer decodes, for filtering a fetch by topic
 * rather than by address.
 *
 * v3 has one contract per pool, and the factory on this chain has named
 * nearly thirteen thousand of them. An `eth_getLogs` that lists every pool
 * address is a request the size of a small file, and the endpoints answered
 * it in seventeen seconds when they answered at all. The signatures are
 * seven, and they never grow; the poller asks by signature and keeps the
 * logs whose address it follows (indexer/poller.ts).
 */
export const POOL_MANAGER_TOPICS = selectors(POOL_MANAGER_ABI);
export const V3_POOL_TOPICS = selectors(V3_POOL_ABI);
export const V3_FACTORY_TOPICS = selectors(V3_FACTORY_ABI);
export const FOLLOWED_TOPICS = [...new Set([...POOL_MANAGER_TOPICS, ...V3_FACTORY_TOPICS, ...V3_POOL_TOPICS])];

/** Read-only v3 pool state, for the reserves half of a TVL figure. */
export const V3_POOL_READ_ABI = parseAbi([
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
  'function liquidity() view returns (uint128)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function fee() view returns (uint24)',
  'function tickSpacing() view returns (int24)',
]);

/** v4 StateView (§2): pool state without a storage-slot read of our own. */
export const STATE_VIEW_ABI = parseAbi([
  'function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
  'function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)',
]);

/** Token metadata. Nothing here is a number we display (§4). */
export const ERC20_ABI = parseAbi([
  'function symbol() view returns (string)',
  'function name() view returns (string)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)',
  'function totalSupply() view returns (uint256)',
]);
