/**
 * When was this contract deployed?
 *
 * Left at `START_BLOCK=0` the indexer scans from genesis. On Robinhood Chain
 * that is 62 million blocks of mostly nothing — at 2,000 blocks a pass, some
 * thirty thousand round trips before it reaches anything that matters. The
 * observed run was at block 7,872 of 62,638,664 after several minutes.
 *
 * The PoolManager's deployment block is the honest starting point, and it is
 * findable rather than something a person has to dig out of an explorer:
 * `eth_getCode` returns empty before a contract exists and non-empty after,
 * which is monotonic, so a binary search finds the boundary in about
 * log2(62.6M) ≈ 26 calls.
 *
 * It needs an archive node — a pruned one answers `eth_getCode` for old blocks
 * with empty, which would look like "deployed at head". That case is detected
 * rather than trusted: if the contract reads as absent at a block where we
 * know it existed, the search is abandoned and the configured value stands.
 */

import { getAddress } from 'viem';
import { rpc } from './client';

async function hasCodeAt(address: string, block: bigint): Promise<boolean> {
  const code = await rpc(
    (c) => c.getCode({ address: getAddress(address), blockNumber: block }),
    `getCode(${address}@${block})`,
  );
  return typeof code === 'string' && code.length > 2;
}

export interface DeploymentSearch {
  block: bigint | null;
  /** Calls spent, for the log — this is a budgeted operation, not a scan. */
  probes: number;
  note: string;
}

/**
 * The first block at which `address` has code, by bisection.
 *
 * Returns null when the node cannot answer historically, which is a normal
 * limitation of a public endpoint rather than an error.
 */
export async function findDeploymentBlock(
  address: string,
  head: bigint,
): Promise<DeploymentSearch> {
  let probes = 0;

  // It must exist NOW, or we are looking for the wrong address entirely and
  // a bisection would spend 26 calls proving it.
  probes++;
  if (!(await hasCodeAt(address, head))) {
    return {
      block: null,
      probes,
      note: `${address} has no code at head — wrong address, or not on this chain.`,
    };
  }

  // An archive node reports no code at genesis. A pruned one refuses the
  // question entirely — and this probe sits OUTSIDE the bisection loop, so an
  // uncaught throw here would take the indexer down at startup instead of
  // falling back to the configured value. It did.
  probes++;
  try {
    if (await hasCodeAt(address, 0n)) {
      return { block: 0n, probes, note: 'Code present at genesis; starting from 0.' };
    }
  } catch (error) {
    return {
      block: null,
      probes,
      note:
        `The node cannot read state at genesis (${(error as Error).message.split('\n')[0]}). ` +
        'An archive endpoint is needed to find the deployment block; set START_BLOCK by hand.',
    };
  }

  let lo = 0n; // known absent
  let hi = head; // known present
  while (hi - lo > 1n) {
    const mid = lo + (hi - lo) / 2n;
    probes++;
    try {
      if (await hasCodeAt(address, mid)) hi = mid;
      else lo = mid;
    } catch (error) {
      // Typically "missing trie node" or "state not available" — a pruned
      // node. Abandon rather than guess: a wrong START_BLOCK above a pool's
      // creation means never seeing the mint that funded it.
      return {
        block: null,
        probes,
        note:
          `The node cannot read state at block ${mid} (${(error as Error).message.split('\n')[0]}). ` +
          'An archive endpoint is needed to find the deployment block; set START_BLOCK by hand.',
      };
    }
  }

  return {
    block: hi,
    probes,
    note: `Deployed at block ${hi}, found in ${probes} probes.`,
  };
}
