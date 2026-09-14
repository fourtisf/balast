/**
 * PositionManager's action encoding, as v4-periphery decodes it.
 *
 * `modifyLiquidities(bytes unlockData, uint256 deadline)` takes
 * `abi.encode(bytes actions, bytes[] params)`: one byte per action, one
 * ABI-encoded parameter blob per action, executed in order inside a single
 * PoolManager unlock. The ids and layouts below are from
 * `src/libraries/Actions.sol` and `PositionManager._handleAction`, and the
 * test compares the bytes this file produces with what Uniswap's own SDK
 * planner produces for the same actions.
 */

import { encodeAbiParameters, encodeFunctionData, parseAbi, toHex, type Address, type Hex } from 'viem';
import { POOL_KEY_COMPONENTS, type PoolKey } from './pool';

export const Actions = {
  DECREASE_LIQUIDITY: 0x01,
  MINT_POSITION: 0x02,
  BURN_POSITION: 0x03,
  SETTLE_PAIR: 0x0d,
  TAKE_PAIR: 0x11,
  CLOSE_CURRENCY: 0x12,
  SWEEP: 0x14,
} as const;

export const POSITION_MANAGER_ABI = parseAbi([
  'function modifyLiquidities(bytes unlockData, uint256 deadline) payable',
  'function nextTokenId() view returns (uint256)',
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function balanceOf(address owner) view returns (uint256)',
  'function getPositionLiquidity(uint256 tokenId) view returns (uint128 liquidity)',
  'function getPoolAndPositionInfo(uint256 tokenId) view returns ((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, uint256 info)',
  'function permit2() view returns (address)',
  'event Transfer(address indexed from, address indexed to, uint256 indexed id)',
]);

const POOL_KEY = { type: 'tuple', components: POOL_KEY_COMPONENTS } as const;

/** MINT_POSITION: (PoolKey, int24, int24, uint256 liquidity, uint128 amount0Max, uint128 amount1Max, address owner, bytes hookData). */
export function encodeMint(args: {
  key: PoolKey;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
  amount0Max: bigint;
  amount1Max: bigint;
  owner: Address;
  hookData?: Hex;
}): Hex {
  return encodeAbiParameters(
    [
      POOL_KEY,
      { type: 'int24' },
      { type: 'int24' },
      { type: 'uint256' },
      { type: 'uint128' },
      { type: 'uint128' },
      { type: 'address' },
      { type: 'bytes' },
    ],
    [args.key, args.tickLower, args.tickUpper, args.liquidity, args.amount0Max, args.amount1Max, args.owner, args.hookData ?? '0x'],
  );
}

/** SETTLE_PAIR: pay whatever the two currencies are owed, from the caller through Permit2 (or msg.value for ether). */
export function encodeSettlePair(currency0: Address, currency1: Address): Hex {
  return encodeAbiParameters([{ type: 'address' }, { type: 'address' }], [currency0, currency1]);
}

/** SWEEP: return any of `currency` left in PositionManager to `to` — the ether sent above what settlement took. */
export function encodeSweep(currency: Address, to: Address): Hex {
  return encodeAbiParameters([{ type: 'address' }, { type: 'address' }], [currency, to]);
}

/** DECREASE_LIQUIDITY: (uint256 tokenId, uint256 liquidity, uint128 amount0Min, uint128 amount1Min, bytes hookData). Zero liquidity collects fees. */
export function encodeDecrease(args: {
  tokenId: bigint;
  liquidity: bigint;
  amount0Min: bigint;
  amount1Min: bigint;
  hookData?: Hex;
}): Hex {
  return encodeAbiParameters(
    [{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint128' }, { type: 'uint128' }, { type: 'bytes' }],
    [args.tokenId, args.liquidity, args.amount0Min, args.amount1Min, args.hookData ?? '0x'],
  );
}

/** BURN_POSITION: (uint256 tokenId, uint128 amount0Min, uint128 amount1Min, bytes hookData). Empties the position first if needed. */
export function encodeBurn(args: { tokenId: bigint; amount0Min: bigint; amount1Min: bigint; hookData?: Hex }): Hex {
  return encodeAbiParameters(
    [{ type: 'uint256' }, { type: 'uint128' }, { type: 'uint128' }, { type: 'bytes' }],
    [args.tokenId, args.amount0Min, args.amount1Min, args.hookData ?? '0x'],
  );
}

/** TAKE_PAIR: send whatever the two currencies are owed to `recipient`. */
export function encodeTakePair(currency0: Address, currency1: Address, recipient: Address): Hex {
  return encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'address' }], [currency0, currency1, recipient]);
}

/** `abi.encode(bytes actions, bytes[] params)` — the unlock data. */
export function encodeUnlockData(actions: readonly number[], params: readonly Hex[]): Hex {
  if (actions.length !== params.length) throw new Error('one parameter blob per action');
  return encodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], [toHex(Uint8Array.from(actions)), [...params]]);
}

/** The transaction's calldata. `deadline` is a unix timestamp (§2: never a block number). */
export function encodeModifyLiquidities(unlockData: Hex, deadline: bigint): Hex {
  return encodeFunctionData({ abi: POSITION_MANAGER_ABI, functionName: 'modifyLiquidities', args: [unlockData, deadline] });
}
