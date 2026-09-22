/**
 * A position's uncollected fees, read from the chain.
 *
 * Fees are not in any event the indexer reads: v4 accrues them into the
 * pool's fee-growth accumulators and settles a position's share when its
 * liquidity is next touched. So they are state, and StateView answers for
 * it: the pool's fee growth inside the position's range now, and the value
 * the position last settled at. The difference, times the liquidity, over
 * 2^128, is what a collect would pay — the same arithmetic v4-core's
 * `Position.update` does, wrap included.
 */

import { parseAbi, toHex, type Address, type PublicClient } from 'viem';
import { CONTRACTS } from '../chain';
import { poolId, type PoolKey } from './pool';

export const STATE_VIEW_FEES_ABI = parseAbi([
  'function getFeeGrowthInside(bytes32 poolId, int24 tickLower, int24 tickUpper) view returns (uint256 feeGrowthInside0X128, uint256 feeGrowthInside1X128)',
  'function getPositionInfo(bytes32 poolId, address owner, int24 tickLower, int24 tickUpper, bytes32 salt) view returns (uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128)',
]);

const Q128 = 2n ** 128n;
const MASK_256 = 2n ** 256n - 1n;

/** PositionManager's salt for a token: its id as 32 bytes. */
export function positionSalt(tokenId: bigint): `0x${string}` {
  return toHex(tokenId, { size: 32 });
}

/**
 * liquidity × (growth now − growth at last settlement) / 2^128.
 *
 * The accumulators are uint256 and are allowed to overflow; the subtraction
 * wraps the same way the pool's does, so a growth that has gone round is
 * still a small positive delta and not a negative fee.
 */
export function feesOwed(liquidity: bigint, growthNow: bigint, growthLast: bigint): bigint {
  const delta = (growthNow - growthLast) & MASK_256;
  return (liquidity * delta) / Q128;
}

export interface PositionFees {
  fees0: bigint;
  fees1: bigint;
  /** The liquidity the chain reports, which is what the fees accrue on. */
  liquidity: bigint;
}

export interface FeeQuery {
  tokenId: bigint;
  key: PoolKey;
  tickLower: number;
  tickUpper: number;
}

/**
 * Uncollected fees for several positions in one multicall: two reads each.
 * A position the node will not answer for is left out rather than reported
 * as zero — zero is a figure, and an unanswered question is not (§7).
 */
export async function readPositionFees(client: PublicClient, queries: FeeQuery[]): Promise<Map<string, PositionFees>> {
  const out = new Map<string, PositionFees>();
  if (queries.length === 0) return out;
  const contracts = queries.flatMap((q) => {
    const id = poolId(q.key);
    return [
      {
        address: CONTRACTS.stateView as Address,
        abi: STATE_VIEW_FEES_ABI,
        functionName: 'getFeeGrowthInside' as const,
        args: [id, q.tickLower, q.tickUpper] as const,
      },
      {
        address: CONTRACTS.stateView as Address,
        abi: STATE_VIEW_FEES_ABI,
        functionName: 'getPositionInfo' as const,
        args: [id, CONTRACTS.positionManager as Address, q.tickLower, q.tickUpper, positionSalt(q.tokenId)] as const,
      },
    ];
  });
  const results = await client.multicall({
    contracts,
    allowFailure: true,
    multicallAddress: CONTRACTS.multicall3 as Address,
  });
  queries.forEach((q, i) => {
    const growth = results[2 * i];
    const info = results[2 * i + 1];
    if (growth.status !== 'success' || info.status !== 'success') return;
    const [now0, now1] = growth.result as readonly [bigint, bigint];
    const [liquidity, last0, last1] = info.result as readonly [bigint, bigint, bigint];
    out.set(q.tokenId.toString(), {
      fees0: feesOwed(liquidity, now0, last0),
      fees1: feesOwed(liquidity, now1, last1),
      liquidity,
    });
  });
  return out;
}
