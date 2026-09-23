import { describe, expect, it } from 'vitest';
import { CONTRACTS } from '../../lib/chain';
import { ExplorerPositions, explorerPositionIds, type ExplorerFetch } from './explorer-positions';

const OWNER = '0x0000000000000000000000000000000000000b0b';
const V3_MANAGER = CONTRACTS.v3PositionManager;

/** Blockscout's shape: items with the token contract and the id, and a cursor to the next page. */
function explorer(pages: Record<string, unknown>[], seen: string[] = []): ExplorerFetch {
  return async (url) => {
    seen.push(url);
    const page = new URL(url).searchParams.get('page') ?? '0';
    return new Response(JSON.stringify(pages[Number(page)]), { status: 200, headers: { 'content-type': 'application/json' } });
  };
}

describe('explorerPositionIds', () => {
  it('lists the v4 PositionManager ids the wallet holds, across pages, and nothing else', async () => {
    const seen: string[] = [];
    const ids = await explorerPositionIds(OWNER, {
      base: 'https://explorer.example/',
      fetch: explorer(
        [
          {
            items: [
              { id: '3000001', token: { address_hash: CONTRACTS.positionManager, type: 'ERC-721' } },
              // A v3 position: enumerable on chain, not this list's job.
              { id: '77', token: { address_hash: V3_MANAGER, type: 'ERC-721' } },
              // Some other NFT entirely.
              { id: '5', token: { address_hash: '0x1111111111111111111111111111111111111111' } },
            ],
            next_page_params: { page: 1, items_count: 50 },
          },
          // An older Blockscout spelled the contract `address`.
          { items: [{ id: '12', token: { address: CONTRACTS.positionManager.toLowerCase() } }], next_page_params: null },
        ],
        seen,
      ),
    });
    expect(ids).toEqual([3_000_001n, 12n]);
    expect(seen[0]).toBe(`https://explorer.example/api/v2/addresses/${OWNER}/nft?type=ERC-721`);
    expect(seen[1]).toContain('page=1');
    expect(seen[1]).toContain('type=ERC-721');
  });

  it('throws when the explorer will not answer, so the caller can say the list may be incomplete', async () => {
    const refusing: ExplorerFetch = async () => new Response('forbidden', { status: 403 });
    await expect(explorerPositionIds(OWNER, { base: 'https://x.example', fetch: refusing })).rejects.toThrow('403');
  });
});

describe('ExplorerPositions', () => {
  it('remembers a wallet’s answer briefly, keeps the last one on a failure, and reports its state', async () => {
    let calls = 0;
    let fail = false;
    let now = 0;
    const cache = new ExplorerPositions({
      base: 'https://x.example',
      ttlMs: 1_000,
      now: () => now,
      fetch: async () => {
        calls += 1;
        if (fail) throw new Error('network down');
        return new Response(JSON.stringify({ items: [{ id: '9', token: { address_hash: CONTRACTS.positionManager } }] }));
      },
    });
    expect(await cache.owned(OWNER)).toEqual([9n]);
    expect(await cache.owned(OWNER)).toEqual([9n]);
    expect(calls).toBe(1);
    fail = true;
    now = 2_000;
    // The last answer rather than nothing; the state says what happened.
    expect(await cache.owned(OWNER)).toEqual([9n]);
    expect(cache.status().lastError).toBe('network down');
    expect(await cache.owned('0x000000000000000000000000000000000000c0c0')).toBeNull();
  });
});
