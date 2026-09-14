/**
 * Finding a contract's deployment block by bisection.
 *
 * The alternative is scanning from genesis, which on this chain is 62 million
 * blocks of mostly nothing — roughly thirty thousand passes before the
 * indexer reaches anything worth indexing. This turns that into about 26
 * calls.
 *
 * The `rpc` module is mocked so the search itself is under test rather than
 * an endpoint's behaviour.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls: bigint[] = [];
let deployedAt = 0n;
let failAtOldBlocks = false;

vi.mock('./client', () => ({
  rpc: async (fn: (client: unknown) => Promise<unknown>) =>
    fn({
      getCode: async ({ blockNumber }: { blockNumber: bigint }) => {
        calls.push(blockNumber);
        if (failAtOldBlocks && blockNumber < 1_000_000n) {
          throw new Error('missing trie node: state not available');
        }
        return blockNumber >= deployedAt ? '0x6080604052' : '0x';
      },
    }),
}));

const { findDeploymentBlock } = await import('./deployment');
const ADDRESS = '0x8366a39CC670B4001A1121B8F6A443A643e40951';
const HEAD = 62_638_664n;

beforeEach(() => {
  calls.length = 0;
  failAtOldBlocks = false;
});

describe('findDeploymentBlock', () => {
  it('finds the exact block', async () => {
    deployedAt = 4_821_337n;
    const result = await findDeploymentBlock(ADDRESS, HEAD);
    expect(result.block).toBe(4_821_337n);
  });

  it('spends a budget, not a scan', async () => {
    // The whole point. Anything near the block count means it is scanning.
    deployedAt = 4_821_337n;
    const result = await findDeploymentBlock(ADDRESS, HEAD);
    expect(result.probes).toBeLessThan(35);
    expect(Math.log2(Number(HEAD))).toBeGreaterThan(25);
  });

  it('finds a contract deployed very late', async () => {
    deployedAt = HEAD - 1n;
    expect((await findDeploymentBlock(ADDRESS, HEAD)).block).toBe(HEAD - 1n);
  });

  it('reports genesis when the code was always there', async () => {
    deployedAt = 0n;
    const result = await findDeploymentBlock(ADDRESS, HEAD);
    expect(result.block).toBe(0n);
    // Two probes: head and genesis. No bisection needed.
    expect(result.probes).toBe(2);
  });

  it('refuses when the address has no code at head', async () => {
    // The wrong address entirely. Bisecting would spend 26 calls proving it.
    deployedAt = HEAD + 1n;
    const result = await findDeploymentBlock(ADDRESS, HEAD);
    expect(result.block).toBeNull();
    expect(result.probes).toBe(1);
    expect(result.note).toMatch(/no code at head/i);
  });

  it('gives up on a pruned node rather than guessing', async () => {
    // A wrong START_BLOCK above a pool's creation means never seeing the mint
    // that funded it, and its depth reads as unknown for good. Better to
    // return nothing and let the configured value stand.
    deployedAt = 4_821_337n;
    failAtOldBlocks = true;
    const result = await findDeploymentBlock(ADDRESS, HEAD);
    expect(result.block).toBeNull();
    expect(result.note).toMatch(/archive endpoint|cannot read state/i);
  });
});
