/**
 * The event signatures the indexer fetches by (chain/abi.ts).
 *
 * A fetch by topic is only as complete as this list: a signature missing
 * from it is a log the decoder would have handled and the node never sent,
 * and nothing downstream could tell. So the list is checked against the
 * fixture chains — every log they carry, built from the same ABIs, has to
 * be one the fetch asks for — and against the canonical Uniswap selectors,
 * which are what the real contracts emit.
 */

import { describe, expect, it } from 'vitest';
import { FOLLOWED_TOPICS, POOL_MANAGER_TOPICS, V3_FACTORY_TOPICS, V3_POOL_TOPICS } from './abi';
import { buildFixtureChain, buildV3Chain } from '../test/fixture';

describe('the followed event signatures', () => {
  it('are the seven the decoders handle, once each', () => {
    expect(POOL_MANAGER_TOPICS).toHaveLength(3);
    expect(V3_POOL_TOPICS).toHaveLength(3);
    expect(V3_FACTORY_TOPICS).toHaveLength(1);
    expect(FOLLOWED_TOPICS).toHaveLength(7);
    expect(new Set(FOLLOWED_TOPICS).size).toBe(7);
    for (const t of FOLLOWED_TOPICS) expect(t).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('are the canonical Uniswap selectors', () => {
    // keccak256 of the canonical signatures, as every explorer lists them.
    // A typo in an ABI string above would decode nothing on the real chain
    // and pass every fixture test, since the fixture is built from the same
    // string; this is the one place the text is checked against the world.
    expect(V3_POOL_TOPICS).toContain('0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67'); // v3 Swap
    expect(V3_POOL_TOPICS).toContain('0x7a53080ba414158be7ec69b987b5fb7d07dee101fe85488f0853ae16239d0bde'); // v3 Mint
    expect(V3_POOL_TOPICS).toContain('0x0c396cd989a39f4459b5fa1aed6a9a8dcdbc45908acfd67e028cd568da98982c'); // v3 Burn
    expect(V3_FACTORY_TOPICS).toContain('0x783cca1c0412dd0d695e784568c96da2e9c22ff989357a2e8b1d9b2b4e6b7118'); // PoolCreated
    expect(POOL_MANAGER_TOPICS).toContain('0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f'); // v4 Swap
    expect(POOL_MANAGER_TOPICS).toContain('0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438'); // v4 Initialize
    expect(POOL_MANAGER_TOPICS).toContain('0xf208f4912782fd25c7f114ca3723a2d5dd6f3bcc3ac8db5af63baa85f711d5ec'); // v4 ModifyLiquidity
  });

  it('cover every log the fixture chains carry', () => {
    const followed = new Set(FOLLOWED_TOPICS);
    for (const chain of [buildFixtureChain(), buildV3Chain()]) {
      expect(chain.logs.length).toBeGreaterThan(0);
      for (const log of chain.logs) {
        expect(followed.has((log.topics[0] ?? '').toLowerCase())).toBe(true);
      }
    }
  });
});
