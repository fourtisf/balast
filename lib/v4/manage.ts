/**
 * Managing a position the wallet already holds: collect its fees, or take
 * it out of the pool altogether. Both are one `modifyLiquidities` through
 * PositionManager, the contract that minted it (§20), and both send the
 * proceeds to the owner in the same transaction.
 *
 *   collect   DECREASE_LIQUIDITY by zero — which settles the position's fees
 *             into its owed balance — then TAKE_PAIR to the owner.
 *   withdraw  BURN_POSITION, which removes all its liquidity, settles its
 *             fees and burns the NFT, then TAKE_PAIR to the owner.
 *
 * The minimums on a withdrawal are the position's two sides at the last
 * price the page saw, less a tolerance; a price that moves more than that
 * between planning and inclusion makes the pool revert rather than pay
 * less. Collecting has no minimums: fees are what they are.
 */

import type { Address, Hex } from 'viem';
import { Actions, encodeBurn, encodeDecrease, encodeModifyLiquidities, encodeTakePair, encodeUnlockData } from './actions';
import type { PoolKey } from './pool';

export interface ManagePlan {
  kind: 'collect' | 'withdraw';
  actions: number[];
  unlockData: Hex;
  calldata: Hex;
  /** Nothing is paid in either way; msg.value is always zero. */
  value: bigint;
  amount0Min: bigint;
  amount1Min: bigint;
}

export function planCollect(args: { key: PoolKey; tokenId: bigint; owner: Address; deadline: bigint }): ManagePlan {
  const actions = [Actions.DECREASE_LIQUIDITY, Actions.TAKE_PAIR];
  const params = [
    encodeDecrease({ tokenId: args.tokenId, liquidity: 0n, amount0Min: 0n, amount1Min: 0n }),
    encodeTakePair(args.key.currency0, args.key.currency1, args.owner),
  ];
  const unlockData = encodeUnlockData(actions, params);
  return {
    kind: 'collect',
    actions,
    unlockData,
    calldata: encodeModifyLiquidities(unlockData, args.deadline),
    value: 0n,
    amount0Min: 0n,
    amount1Min: 0n,
  };
}

export function planWithdraw(args: {
  key: PoolKey;
  tokenId: bigint;
  owner: Address;
  /** The position's two sides at the price the page last read. */
  amount0: bigint;
  amount1: bigint;
  /** How much less than that the transaction may pay before it reverts. */
  slippageBps?: number;
  deadline: bigint;
}): ManagePlan {
  const bps = BigInt(args.slippageBps ?? 100);
  const withTolerance = (a: bigint) => (a * (10_000n - bps)) / 10_000n;
  const amount0Min = withTolerance(args.amount0);
  const amount1Min = withTolerance(args.amount1);
  const actions = [Actions.BURN_POSITION, Actions.TAKE_PAIR];
  const params = [
    encodeBurn({ tokenId: args.tokenId, amount0Min, amount1Min }),
    encodeTakePair(args.key.currency0, args.key.currency1, args.owner),
  ];
  const unlockData = encodeUnlockData(actions, params);
  return {
    kind: 'withdraw',
    actions,
    unlockData,
    calldata: encodeModifyLiquidities(unlockData, args.deadline),
    value: 0n,
    amount0Min,
    amount1Min,
  };
}
