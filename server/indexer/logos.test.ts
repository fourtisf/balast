/**
 * The logo fetcher is the only thing in `server/` that talks to something
 * other than a node or the database, so it is the one place §4's line — logos
 * from outside, numbers never — can be crossed. These tests pin the line.
 */

import { describe, expect, it } from 'vitest';
import { isSafeLogoUrl, refreshLogos } from './logos';

describe('isSafeLogoUrl', () => {
  it('accepts http and https', () => {
    expect(isSafeLogoUrl('https://example.com/a.png')).toBe(true);
    expect(isSafeLogoUrl('http://example.com/a.png')).toBe(true);
  });

  it('rejects every scheme that could execute or embed', () => {
    // A token list is third-party data. One of these reaching an `img src`
    // is an injection vector, not a logo.
    for (const url of [
      'javascript:alert(1)',
      // eslint-disable-next-line no-script-url
      'JavaScript:alert(1)',
      'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
      'file:///etc/passwd',
      'vbscript:msgbox(1)',
    ]) {
      expect(isSafeLogoUrl(url)).toBe(false);
    }
  });

  it('rejects anything that is not a parseable absolute URL', () => {
    for (const url of ['', '/relative.png', 'example.com/a.png', 'not a url']) {
      expect(isSafeLogoUrl(url)).toBe(false);
    }
  });

  it('rejects a non-string and an oversized string', () => {
    expect(isSafeLogoUrl(undefined)).toBe(false);
    expect(isSafeLogoUrl(null)).toBe(false);
    expect(isSafeLogoUrl(42)).toBe(false);
    // A data URI smuggled in as a very long "URL" does not belong in a column.
    expect(isSafeLogoUrl(`https://example.com/${'a'.repeat(600)}.png`)).toBe(false);
  });
});

describe('refreshLogos', () => {
  it('does nothing at all when no list is configured', async () => {
    // The default state. Every badge uses the colour derived from its
    // address, and no network call is made.
    expect(await refreshLogos({ url: null, chainId: 4663 })).toBe(0);
  });

  it('ignores a configured URL that is not http(s)', async () => {
    const messages: string[] = [];
    // eslint-disable-next-line no-script-url
    const count = await refreshLogos({
      url: 'javascript:alert(1)',
      chainId: 4663,
      log: (m) => messages.push(m),
    });
    expect(count).toBe(0);
    expect(messages.join(' ')).toMatch(/not an http/i);
  });

  it('fails silently when the list is unreachable', async () => {
    // A logo is decoration. The site works without one and must never wait
    // on one, so an unreachable host is a log line and a zero — not a throw
    // that would take the indexer pass down with it.
    const messages: string[] = [];
    const count = await refreshLogos({
      // Reserved for documentation examples, so it cannot resolve to anything.
      url: 'https://255.255.255.255/token-list.json',
      chainId: 4663,
      log: (m) => messages.push(m),
    });
    expect(count).toBe(0);
    expect(messages.join(' ')).toMatch(/unreachable|responded/i);
  });
});
