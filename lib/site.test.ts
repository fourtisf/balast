import { getAddress, isAddress } from 'viem';
import { describe, expect, it } from 'vitest';
import { SITE_URL, SOCIAL, TOKEN_CA, X_HANDLE, ownSitePath } from './site';

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

describe('where the project talks', () => {
  it('links the X account the owner named, and derives the handle from it', () => {
    expect(SOCIAL.x).toBe('https://x.com/lockfiorg');
    expect(X_HANDLE).toBe('@lockfiorg');
  });

  it('carries a contract address only when it is a valid, checksummed one', () => {
    // null reads "CA · coming soon". A set value must be exactly what a
    // person would paste into a wallet: valid and in its checksummed case.
    if (TOKEN_CA === null) return;
    expect(isAddress(TOKEN_CA)).toBe(true);
    expect(TOKEN_CA).toBe(getAddress(TOKEN_CA));
  });
});
