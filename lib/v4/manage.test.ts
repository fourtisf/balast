/**
 * The collect and withdraw plans against Uniswap's own planner, the way the
 * mint encoder is tested: a byte out of place is a revert at best.
 */

import { Actions as SdkActions, V4Planner } from '@uniswap/v4-sdk';
import { describe, expect, it } from 'vitest';
import { decodeAbiParameters, hexToBytes } from 'viem';
import { Actions } from './actions';
import { planCollect, planWithdraw } from './manage';
import type { PoolKey } from './pool';

const KEY: PoolKey = {
  currency0: '0x0000000000000000000000000000000000000000',
  currency1: '0x4200000000000000000000000000000000000006',
  fee: 3000,
  tickSpacing: 60,
  hooks: '0x0000000000000000000000000000000000000000',
};
const OWNER = '0x000000000000000000000000000000000000dEaD' as const;
const DEADLINE = 1_800_000_000n;

function decodeActions(unlockData: `0x${string}`) {
  const [actions, params] = decodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], unlockData);
  return { actions: Array.from(hexToBytes(actions)), params };
}

describe('planCollect', () => {
  it('decreases by nothing, then takes both currencies to the owner, and pays nothing in', () => {
    const plan = planCollect({ key: KEY, tokenId: 7n, owner: OWNER, deadline: DEADLINE });
    expect(plan.actions).toEqual([Actions.DECREASE_LIQUIDITY, Actions.TAKE_PAIR]);
    expect(plan.value).toBe(0n);
    const planner = new V4Planner();
    planner.addAction(SdkActions.DECREASE_LIQUIDITY, ['7', '0', '0', '0', '0x']);
    planner.addAction(SdkActions.TAKE_PAIR, [KEY.currency0, KEY.currency1, OWNER]);
    expect(plan.unlockData.toLowerCase()).toBe(planner.finalize().toLowerCase());
  });
});

describe('planWithdraw', () => {
  it('burns the position with minimums a tolerance below the amounts, then takes both to the owner', () => {
    const plan = planWithdraw({
      key: KEY,
      tokenId: 7n,
      owner: OWNER,
      amount0: 1_000_000n,
      amount1: 5_000n,
      slippageBps: 50,
      deadline: DEADLINE,
    });
    expect(plan.actions).toEqual([Actions.BURN_POSITION, Actions.TAKE_PAIR]);
    expect(plan.amount0Min).toBe(995_000n);
    expect(plan.amount1Min).toBe(4_975n);
    const { params } = decodeActions(plan.unlockData);
    const [tokenId, min0, min1] = decodeAbiParameters(
      [{ type: 'uint256' }, { type: 'uint128' }, { type: 'uint128' }, { type: 'bytes' }],
      params[0],
    );
    expect(tokenId).toBe(7n);
    expect(min0).toBe(995_000n);
    expect(min1).toBe(4_975n);
    const planner = new V4Planner();
    planner.addAction(SdkActions.BURN_POSITION, ['7', '995000', '4975', '0x']);
    planner.addAction(SdkActions.TAKE_PAIR, [KEY.currency0, KEY.currency1, OWNER]);
    expect(plan.unlockData.toLowerCase()).toBe(planner.finalize().toLowerCase());
  });

  it('defaults to a one percent tolerance', () => {
    const plan = planWithdraw({ key: KEY, tokenId: 1n, owner: OWNER, amount0: 10_000n, amount1: 0n, deadline: DEADLINE });
    expect(plan.amount0Min).toBe(9_900n);
    expect(plan.amount1Min).toBe(0n);
  });
});
