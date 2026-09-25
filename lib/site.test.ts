import { describe, expect, it } from 'vitest';
import { SITE_URL, ownSitePath } from './site';

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
