import { describe, expect, it } from 'vitest';
import { getAddress, isAddress } from 'viem';
import { SITE_URL, TOKEN_CA, ownSitePath } from './site';

describe('the token contract address', () => {
  it('is a valid, checksummed address', () => {
    // The site tells people any other address is not ours, so this one must
    // be exactly right: a mistyped digit would send them to a different token.
    expect(isAddress(TOKEN_CA, { strict: true })).toBe(true);
    expect(getAddress(TOKEN_CA)).toBe(TOKEN_CA);
  });
});

describe('ownSitePath', () => {
  it('reads a URL on the current domain as a path', () => {
    expect(SITE_URL).toBe('https://lockfi.org');
    expect(ownSitePath('https://lockfi.org/tokens/eth.svg')).toBe('/tokens/eth.svg');
  });

  it('still reads a URL recorded under the old domain as ours', () => {
    // The database holds logo URLs written while the site was balast.xyz.
    expect(ownSitePath('https://balast.xyz/tokens/spcx.svg')).toBe('/tokens/spcx.svg');
  });

  it('keeps a relative path and refuses everybody else', () => {
    expect(ownSitePath('/tokens/eth.svg')).toBe('/tokens/eth.svg');
    expect(ownSitePath('https://lockfi.com/tokens/eth.svg')).toBeNull();
    expect(ownSitePath('https://balast.xyz.evil.example/x.svg')).toBeNull();
    expect(ownSitePath(null)).toBeNull();
  });
});
