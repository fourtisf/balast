import { describe, expect, it } from 'vitest';
import { getAddress, isAddress } from 'viem';
import { TOKEN_CA } from './site';

describe('the token contract address', () => {
  it('is a valid, checksummed address', () => {
    // The site tells people any other address is not ours, so this one must
    // be exactly right: a mistyped digit would send them to a different token.
    expect(isAddress(TOKEN_CA, { strict: true })).toBe(true);
    expect(getAddress(TOKEN_CA)).toBe(TOKEN_CA);
  });
});
