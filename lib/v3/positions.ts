/**
 * A wallet's Uniswap v3 positions, read straight from the chain.
 *
 * The v4 side of the portfolio comes from the indexer, which follows v4's
 * PositionManager (§23). v3's NonfungiblePositionManager is an
 * ERC721Enumerable, so what a wallet holds there is three reads away —
 * `balanceOf`, `tokenOfOwnerByIndex`, `positions` — and all of them are
 * current state, not history. Reading them live is both simpler and fresher
 * than indexing another contract's events, and it is the chain's own answer.
 *
 * Uncollected fees are read the way Uniswap's own interface reads them: an
 * `eth_call` of `collect(max, max)` from the owner, which returns exactly what
 * a collect would pay now — settled and unsettled fees alike — and changes
 * nothing, because a call is not a transaction.
 */

import type { Address, PublicClient } from 'viem';
import { CONTRACTS } from '../chain';
import { MAX_UINT128, V3_MANAGE_ABI } from './manage';

/** More than any wallet should hold here, and a bound on what one request can cost. */
export const MAX_V3_POSITIONS = 100;

export interface V3OnchainPosition {
  tokenId: bigint;
  token0: Address;
  token1: Address;
  /** Hundredths of a bip. */
  fee: number;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
  /** Fees already settled into the position; the unsettled part is only known by a collect call. */
  owed0: bigint;
  owed1: bigint;
}

/** Anything that can multicall: the browser's client and the server's failover client alike. */
type Reader = Pick<PublicClient, 'readContract' | 'multicall'>;

const manager = CONTRACTS.v3PositionManager as Address;
const multicallAddress = CONTRACTS.multicall3 as Address;

/**
 * Every v3 position the wallet holds that still has something in it —
 * liquidity, or fees owed. A position read as empty and owing nothing is a
 * spent NFT that was never burned, and has nothing for the page to show.
 *
 * A token the node did not answer for is left out rather than guessed at;
 * the whole read throws only if the balance itself cannot be read, so the
 * caller can say "v3 unreadable" rather than "no v3 positions".
 */
export async function readV3Positions(client: Reader, owner: Address): Promise<V3OnchainPosition[]> {
  const balance = await client.readContract({
    address: manager,
    abi: V3_MANAGE_ABI,
    functionName: 'balanceOf',
    args: [owner],
  });
  const count = Number(balance > BigInt(MAX_V3_POSITIONS) ? BigInt(MAX_V3_POSITIONS) : balance);
  if (count === 0) return [];

  const ids = await client.multicall({
    contracts: Array.from({ length: count }, (_, i) => ({
      address: manager,
      abi: V3_MANAGE_ABI,
      functionName: 'tokenOfOwnerByIndex' as const,
      args: [owner, BigInt(i)] as const,
    })),
    allowFailure: true,
    multicallAddress,
  });
  const tokenIds = ids.filter((r) => r.status === 'success').map((r) => r.result as bigint);
  if (tokenIds.length === 0) return [];

  const details = await client.multicall({
    contracts: tokenIds.map((id) => ({
      address: manager,
      abi: V3_MANAGE_ABI,
      functionName: 'positions' as const,
      args: [id] as const,
    })),
    allowFailure: true,
    multicallAddress,
  });

  const out: V3OnchainPosition[] = [];
  details.forEach((r, i) => {
    if (r.status !== 'success') return;
    const [, , token0, token1, fee, tickLower, tickUpper, liquidity, , , owed0, owed1] = r.result as readonly [
      bigint,
      Address,
      Address,
      Address,
      number,
      number,
      number,
      bigint,
      bigint,
      bigint,
      bigint,
      bigint,
    ];
    if (liquidity === 0n && owed0 === 0n && owed1 === 0n) return;
    out.push({ tokenId: tokenIds[i], token0, token1, fee, tickLower, tickUpper, liquidity, owed0, owed1 });
  });
  return out;
}

export interface V3Fees {
  fees0: bigint;
  fees1: bigint;
  liquidity: bigint;
}

/**
 * What a collect would pay each position now, and its live liquidity.
 *
 * One `eth_call` per position — a collect has to come from the owner, which a
 * Multicall3 batch cannot be — plus one multicall for the liquidity. A
 * position the node did not answer for is absent, not zero (§7).
 */
export async function readV3Fees(
  client: Pick<PublicClient, 'simulateContract' | 'multicall'>,
  owner: Address,
  tokenIds: bigint[],
): Promise<Map<string, V3Fees>> {
  const out = new Map<string, V3Fees>();
  if (tokenIds.length === 0) return out;
  const [collects, details] = await Promise.all([
    Promise.all(
      tokenIds.map((tokenId) =>
        client
          .simulateContract({
            address: manager,
            abi: V3_MANAGE_ABI,
            functionName: 'collect',
            args: [{ tokenId, recipient: owner, amount0Max: MAX_UINT128, amount1Max: MAX_UINT128 }],
            account: owner,
          })
          .then((r) => r.result as readonly [bigint, bigint])
          .catch(() => null),
      ),
    ),
    client.multicall({
      contracts: tokenIds.map((id) => ({
        address: manager,
        abi: V3_MANAGE_ABI,
        functionName: 'positions' as const,
        args: [id] as const,
      })),
      allowFailure: true,
      multicallAddress,
    }),
  ]);
  tokenIds.forEach((tokenId, i) => {
    const fees = collects[i];
    const detail = details[i];
    if (!fees || detail.status !== 'success') return;
    const liquidity = (detail.result as readonly unknown[])[7] as bigint;
    out.set(tokenId.toString(), { fees0: fees[0], fees1: fees[1], liquidity });
  });
  return out;
}

/** The manager's own wrapper, so an unwrap is only ever asked of the token it will unwrap. */
export async function readV3Weth9(client: Pick<PublicClient, 'readContract'>): Promise<Address | null> {
  try {
    return await client.readContract({ address: manager, abi: V3_MANAGE_ABI, functionName: 'WETH9' });
  } catch {
    return null;
  }
}
