/**
 * The action encoder against Uniswap's own planner.
 *
 * PositionManager decodes each action's parameters with fixed layouts; a
 * byte out of place is a revert at best and a position minted to the wrong
 * owner at worst. So the bytes this module produces are compared with what
 * `@uniswap/v4-sdk`'s V4Planner produces for the same actions, and the
 * action ids with `Actions.sol`.
 */

import { Actions as SdkActions, V4Planner, V4PositionManager } from '@uniswap/v4-sdk';
import { describe, expect, it } from 'vitest';
import { decodeFunctionData } from 'viem';
import {
  Actions,
  POSITION_MANAGER_ABI,
  encodeBurn,
  encodeDecrease,
  encodeMint,
  encodeModifyLiquidities,
  encodeSettlePair,
  encodeSweep,
  encodeTakePair,
  encodeUnlockData,
} from './actions';
import type { PoolKey } from './pool';

const KEY: PoolKey = {
  currency0: '0x0000000000000000000000000000000000000000',
  currency1: '0x4200000000000000000000000000000000000006',
  fee: 3000,
  tickSpacing: 60,
  hooks: '0x0000000000000000000000000000000000000000',
};
const OWNER = '0x000000000000000000000000000000000000dEaD';

describe('action ids', () => {
  it('are the ones in v4-periphery Actions.sol', () => {
    expect(Actions.DECREASE_LIQUIDITY).toBe(0x01);
    expect(Actions.MINT_POSITION).toBe(0x02);
    expect(Actions.BURN_POSITION).toBe(0x03);
    expect(Actions.SETTLE_PAIR).toBe(0x0d);
    expect(Actions.TAKE_PAIR).toBe(0x11);
    expect(Actions.CLOSE_CURRENCY).toBe(0x12);
    expect(Actions.SWEEP).toBe(0x14);
    // And agree with the SDK's enum where it declares them.
    expect(Actions.MINT_POSITION).toBe(SdkActions.MINT_POSITION);
    expect(Actions.SETTLE_PAIR).toBe(SdkActions.SETTLE_PAIR);
    expect(Actions.SWEEP).toBe(SdkActions.SWEEP);
    expect(Actions.TAKE_PAIR).toBe(SdkActions.TAKE_PAIR);
    expect(Actions.DECREASE_LIQUIDITY).toBe(SdkActions.DECREASE_LIQUIDITY);
    expect(Actions.BURN_POSITION).toBe(SdkActions.BURN_POSITION);
  });
});

describe('unlock data', () => {
  it('is byte-identical to the SDK planner for mint, settle pair and sweep', () => {
    const mint = {
      key: KEY,
      tickLower: -1680,
      tickUpper: 1440,
      liquidity: 123456789012345678n,
      amount0Max: 1_000_000_000_000_000_000n,
      amount1Max: 2_500_000_000n,
      owner: OWNER as `0x${string}`,
    };
    const ours = encodeUnlockData(
      [Actions.MINT_POSITION, Actions.SETTLE_PAIR, Actions.SWEEP],
      [encodeMint(mint), encodeSettlePair(KEY.currency0, KEY.currency1), encodeSweep(KEY.currency0, OWNER as `0x${string}`)],
    );
    const planner = new V4Planner();
    planner.addAction(SdkActions.MINT_POSITION, [
      KEY,
      mint.tickLower,
      mint.tickUpper,
      mint.liquidity.toString(),
      mint.amount0Max.toString(),
      mint.amount1Max.toString(),
      OWNER,
      '0x',
    ]);
    planner.addAction(SdkActions.SETTLE_PAIR, [KEY.currency0, KEY.currency1]);
    planner.addAction(SdkActions.SWEEP, [KEY.currency0, OWNER]);
    expect(ours.toLowerCase()).toBe(planner.finalize().toLowerCase());
  });

  it('matches the SDK for decrease, burn and take pair', () => {
    const ours = encodeUnlockData(
      [Actions.DECREASE_LIQUIDITY, Actions.BURN_POSITION, Actions.TAKE_PAIR],
      [
        encodeDecrease({ tokenId: 7n, liquidity: 0n, amount0Min: 1n, amount1Min: 2n }),
        encodeBurn({ tokenId: 7n, amount0Min: 3n, amount1Min: 4n }),
        encodeTakePair(KEY.currency0, KEY.currency1, OWNER as `0x${string}`),
      ],
    );
    const planner = new V4Planner();
    planner.addAction(SdkActions.DECREASE_LIQUIDITY, ['7', '0', '1', '2', '0x']);
    planner.addAction(SdkActions.BURN_POSITION, ['7', '3', '4', '0x']);
    planner.addAction(SdkActions.TAKE_PAIR, [KEY.currency0, KEY.currency1, OWNER]);
    expect(ours.toLowerCase()).toBe(planner.finalize().toLowerCase());
  });

  it('wraps into modifyLiquidities exactly as the SDK does, with a timestamp deadline', () => {
    const unlock = encodeUnlockData([Actions.SETTLE_PAIR], [encodeSettlePair(KEY.currency0, KEY.currency1)]);
    const deadline = 1_800_000_000n;
    const ours = encodeModifyLiquidities(unlock, deadline);
    expect(ours.toLowerCase()).toBe(V4PositionManager.encodeModifyLiquidities(unlock, deadline.toString()).toLowerCase());
    const decoded = decodeFunctionData({ abi: POSITION_MANAGER_ABI, data: ours });
    expect(decoded.functionName).toBe('modifyLiquidities');
    expect(decoded.args?.[1]).toBe(deadline);
  });

  it('refuses a params list that does not pair with the actions', () => {
    expect(() => encodeUnlockData([Actions.SWEEP], [])).toThrow(/one parameter blob per action/);
  });
});
