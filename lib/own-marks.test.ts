/**
 * Every mark this site claims to serve is a file this repository ships.
 *
 * `reconcileStockLogos` used to adopt an own mark only if the box could fetch
 * it back from its own public hostname — out through DNS, the internet and
 * nginx. When that failed it failed silently and SPCX wore the issuer's
 * feather, with nothing in any log. The fetch is not the right check for our
 * own files; this is, and it runs before a deploy rather than after one.
 *
 * Same discipline as the wallet icons: a missing file is a broken image on a
 * page that asks people to trust the site.
 */

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { OWN_STOCK_MARKS } from '../server/indexer/logo-sources';

const root = fileURLToPath(new URL('..', import.meta.url));

describe('marks this site serves itself', () => {
  it('each name a file under public/', () => {
    const missing = Object.entries(OWN_STOCK_MARKS).filter(
      ([, path]) => !existsSync(`${root}public${path}`),
    );
    expect(missing).toEqual([]);
  });

  it('are site-absolute paths, so the badge can serve them same-origin', () => {
    for (const [ticker, path] of Object.entries(OWN_STOCK_MARKS)) {
      expect(path, ticker).toMatch(/^\/[\w./-]+\.(svg|png)$/);
    }
  });

  it('cover the token list images this site serves', async () => {
    const list = await import('../config/tokens.json');
    const own = (list.default.tokens as { logoURI?: string }[])
      .map((t) => t.logoURI ?? '')
      .filter((uri) => uri.startsWith('/') || uri.includes('balast.xyz/'));
    expect(own.length).toBeGreaterThan(0);
    for (const uri of own) {
      const path = uri.startsWith('/') ? uri : uri.slice(uri.indexOf('balast.xyz/') + 'balast.xyz'.length);
      expect(existsSync(`${root}public${path}`), uri).toBe(true);
    }
  });
});
