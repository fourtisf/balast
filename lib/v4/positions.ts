/**
 * A wallet's Uniswap v4 positions, verified on the chain.
 *
 * The portfolio used to list v4 positions from the indexer alone, and the
 * indexer is as far behind as its backfill (§21, §25): weeks. So a position
 * minted today was not on the page at all — and a position on the page could
 * already be withdrawn or sent away, with its row still offering Withdraw.
 * Money that cannot be seen cannot be taken out through the site, and a row
 * that describes a position the wallet no longer holds is a claim about
 * nothing (§7).
 *
 * v4's PositionManager is not enumerable, so it cannot be asked "what does
 * this wallet hold". It can be asked about a token id, and that is enough:
 * the candidates come from the indexer, from a scan of the ids minted since
 * the indexer's last one (server/api/v4-scanner.ts), and from the ids this
 * browser saw minted (lib/tx-history.ts) — and every candidate is then
 * checked here, live: who owns it, which pool and range it is, and how much
 * liquidity it holds. Only what the chain confirms is shown.
 */

import type { Address, Hex, PublicClient } from 'viem';
import { CONTRACTS } from '../chain';
import { POSITION_MANAGER_ABI } from './actions';
import { positionSalt, STATE_VIEW_FEES_ABI } from './fees';
import { poolId, type PoolKey } from './pool';

/**
 * PositionManager's packed `PositionInfo` (v4-periphery
 * `PositionInfoLibrary`): from the least significant bit, 8 bits of
 * has-subscriber, 24 bits of tickLower, 24 bits of tickUpper, and the top 200
 * bits of the pool id.
 *
 * Decoding it by hand is the one step here that has no Uniswap SDK function
 * to be compared against, so `readV4Positions` does not trust it: every
 * decoded range is checked against StateView, which answers for the pool's
 * own record of the position, and a range the pool does not confirm is
 * dropped rather than shown (and counted).
 */
export function decodePositionInfo(info: bigint): {
  poolIdPrefix: Hex;
  tickLower: number;
  tickUpper: number;
  hasSubscriber: boolean;
} {
  const int24 = (raw: bigint): number => {
    const v = Number(raw & 0xffffffn);
    return v >= 0x800000 ? v - 0x1000000 : v;
  };
  return {
    poolIdPrefix: `0x${(info >> 56n).toString(16).padStart(50, '0')}`,
    tickLower: int24(info >> 8n),
    tickUpper: int24(info >> 32n),
    hasSubscriber: (info & 0xffn) !== 0n,
  };
}

export interface V4OnchainPosition {
  tokenId: bigint;
  key: PoolKey;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
}

export interface V4Read {
  positions: V4OnchainPosition[];
  /** Candidates the chain answered for but whose decoded range the pool did not confirm. Expected to be zero. */
  unconfirmed: number;
}

type Reader = Pick<PublicClient, 'multicall'>;

const manager = CONTRACTS.positionManager as Address;
const stateView = CONTRACTS.stateView as Address;
const multicallAddress = CONTRACTS.multicall3 as Address;
/** Token ids per multicall: well under an eth_call's gas at a few thousand gas each. */
const CHUNK = 250;

function chunks<T>(items: T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * The candidates this wallet really holds, with liquidity in them.
 *
 * A burned token's `ownerOf` reverts and a sent one names someone else; both
 * are dropped. A position with no liquidity has nothing to withdraw — v4
 * settles fees on every liquidity change, so an emptied position is owed
 * nothing — and is dropped too.
 */
export async function readV4Positions(client: Reader, owner: Address, candidates: bigint[]): Promise<V4Read> {
  const unique = [...new Set(candidates.map((c) => c.toString()))].map((c) => BigInt(c));
  const held: V4OnchainPosition[] = [];
  // A decode whose pool-id bits do not match the key the manager returned
  // beside it is wrong somewhere, and is not planned against.
  let misdecoded = 0;
  for (const ids of chunks(unique)) {
    const results = await client.multicall({
      contracts: ids.flatMap((id) => [
        { address: manager, abi: POSITION_MANAGER_ABI, functionName: 'ownerOf' as const, args: [id] as const },
        { address: manager, abi: POSITION_MANAGER_ABI, functionName: 'getPoolAndPositionInfo' as const, args: [id] as const },
        { address: manager, abi: POSITION_MANAGER_ABI, functionName: 'getPositionLiquidity' as const, args: [id] as const },
      ]),
      allowFailure: true,
      multicallAddress,
    });
    ids.forEach((tokenId, i) => {
      const [ownerOf, info, liquidity] = [results[3 * i], results[3 * i + 1], results[3 * i + 2]];
      if (ownerOf.status !== 'success' || info.status !== 'success' || liquidity.status !== 'success') return;
      if ((ownerOf.result as string).toLowerCase() !== owner.toLowerCase()) return;
      const amount = liquidity.result as bigint;
      if (amount === 0n) return;
      const [key, packed] = info.result as readonly [PoolKey, bigint];
      const decoded = decodePositionInfo(packed);
      const readKey: PoolKey = {
        currency0: key.currency0,
        currency1: key.currency1,
        fee: Number(key.fee),
        tickSpacing: Number(key.tickSpacing),
        hooks: key.hooks,
      };
      if (decoded.poolIdPrefix.toLowerCase() !== poolId(readKey).slice(0, 52).toLowerCase()) {
        misdecoded += 1;
        return;
      }
      held.push({
        tokenId,
        key: readKey,
        tickLower: decoded.tickLower,
        tickUpper: decoded.tickUpper,
        liquidity: amount,
      });
    });
  }
  if (held.length === 0) return { positions: [], unconfirmed: misdecoded };

  // The pool's own record, at the decoded range: the same liquidity, or the
  // decode is wrong and the range must not be shown or planned against.
  const confirmed: V4OnchainPosition[] = [];
  let unconfirmed = misdecoded;
  for (const batch of chunks(held)) {
    const checks = await client.multicall({
      contracts: batch.map((p) => ({
        address: stateView,
        abi: STATE_VIEW_FEES_ABI,
        functionName: 'getPositionInfo' as const,
        args: [poolId(p.key), manager, p.tickLower, p.tickUpper, positionSalt(p.tokenId)] as const,
      })),
      allowFailure: true,
      multicallAddress,
    });
    batch.forEach((p, i) => {
      const check = checks[i];
      const ok = check.status === 'success' && (check.result as readonly [bigint, bigint, bigint])[0] === p.liquidity;
      if (ok) confirmed.push(p);
      else unconfirmed += 1;
    });
  }
  return { positions: confirmed, unconfirmed };
}

/** The next id PositionManager will mint: every id below it has been minted (some since burned). */
export async function readNextTokenId(client: Pick<PublicClient, 'readContract'>): Promise<bigint> {
  return client.readContract({ address: manager, abi: POSITION_MANAGER_ABI, functionName: 'nextTokenId' });
}

/** Who holds each token id in [from, to). A burned id is absent. */
export async function readOwners(client: Reader, from: bigint, to: bigint): Promise<Map<bigint, string>> {
  const out = new Map<bigint, string>();
  const ids: bigint[] = [];
  for (let id = from; id < to; id++) ids.push(id);
  for (const batch of chunks(ids, 500)) {
    const results = await client.multicall({
      contracts: batch.map((id) => ({
        address: manager,
        abi: POSITION_MANAGER_ABI,
        functionName: 'ownerOf' as const,
        args: [id] as const,
      })),
      allowFailure: true,
      multicallAddress,
    });
    batch.forEach((id, i) => {
      const r = results[i];
      if (r.status === 'success') out.set(id, (r.result as string).toLowerCase());
    });
  }
  return out;
}
