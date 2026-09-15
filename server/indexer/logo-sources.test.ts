/**
 * The per-token logo sources, against fake services.
 *
 * These are the only calls in `server/` that leave the chain and the
 * database, so what they read is pinned: one image URL per token, discarded
 * unless it is a safe https URL, and nothing else. The live services could
 * not be reached from the session that wrote this, so the shapes here are
 * the documented ones — and every parser treats anything else as "not
 * found" rather than as data.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CHAIN, NATIVE_ETH } from '../../lib/chain';
import { prisma } from '../db';
import { isReachable, resetDatabase } from '../test/db';
import {
  blockscout,
  coingecko,
  coinmarketcap,
  createSources,
  dexscreener,
  geckoterminal,
  onchain,
  tickers,
  forgetSharedLogos,
  imageFromPage,
  isGenericLogo,
  launchpadPage,
  reconcileStockLogos,
  GENERIC_LOGOS_KEY,
  lookupLogos,
  type Fetch,
  type LogoSource,
} from './logo-sources';

const TOKEN = '0x00000000000000000000000000000000000000a1';
const LOGO = 'https://cdn.example/a1.png';

/** A fake service: URL substring → JSON body. Records every call. */
function service(routes: Record<string, unknown>): { fetch: Fetch; calls: string[] } {
  const calls: string[] = [];
  const fetch: Fetch = async (url) => {
    calls.push(url);
    const hit = Object.keys(routes).find((key) => url.includes(key));
    if (hit === undefined) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => routes[hit] };
  };
  return { fetch, calls };
}

const quiet = () => {};
/** An explorer icon that is nobody's generic mark, for the tests that are not about that. */
const never = async () => false;

describe('blockscout', () => {
  it('reads icon_url from the explorer\'s token endpoint, at the configured base', async () => {
    const api = service({ '/api/v2/tokens/': { name: 'A1', symbol: 'A1', icon_url: LOGO } });
    const src = blockscout({ base: 'https://explorer.example/', isGeneric: never });
    expect(await src.lookup(TOKEN, { fetch: api.fetch, log: quiet })).toBe(LOGO);
    // One call, lowercased address, no double slash from a trailing one.
    expect(api.calls).toEqual([`https://explorer.example/api/v2/tokens/${TOKEN}`]);
  });

  it('defaults to the registry explorer for this chain', async () => {
    const api = service({ '/api/v2/tokens/': { icon_url: LOGO } });
    await blockscout({ isGeneric: never }).lookup(TOKEN, { fetch: api.fetch, log: quiet });
    expect(api.calls[0].startsWith('https://robinhoodchain.blockscout.com/api/v2/tokens/')).toBe(true);
  });

  it('is null for a token with no icon, an unsafe icon, an unknown token, or a dead explorer', async () => {
    const none = service({ '/api/v2/tokens/': { icon_url: null } });
    expect(await blockscout({ isGeneric: never }).lookup(TOKEN, { fetch: none.fetch, log: quiet })).toBeNull();
    const unsafe = service({ '/api/v2/tokens/': { icon_url: 'data:image/png;base64,AAAA' } });
    expect(await blockscout({ isGeneric: never }).lookup(TOKEN, { fetch: unsafe.fetch, log: quiet })).toBeNull();
    expect(await blockscout({ isGeneric: never }).lookup(TOKEN, { fetch: service({}).fetch, log: quiet })).toBeNull();
    const down: Fetch = async () => {
      throw new Error('ECONNRESET');
    };
    expect(await blockscout({ isGeneric: never }).lookup(TOKEN, { fetch: down, log: quiet })).toBeNull();
  });

  it('never asks about ether, which has no token contract', async () => {
    const api = service({ '/api/v2/tokens/': { icon_url: LOGO } });
    expect(await blockscout({ isGeneric: never }).lookup(NATIVE_ETH, { fetch: api.fetch, log: quiet })).toBeNull();
    expect(api.calls).toHaveLength(0);
  });

  it('refuses an icon the issuer serves for many tokens: a shared picture is nobody\'s logo', async () => {
    const api = service({ '/api/v2/tokens/': { icon_url: LOGO } });
    const shared = async (url: string) => url === LOGO;
    expect(await blockscout({ isGeneric: shared }).lookup(TOKEN, { fetch: api.fetch, log: quiet })).toBeNull();
    const specific = service({ '/api/v2/tokens/': { icon_url: 'https://cdn.example/spcx-own.png' } });
    expect(await blockscout({ isGeneric: shared }).lookup(TOKEN, { fetch: specific.fetch, log: quiet })).toBe(
      'https://cdn.example/spcx-own.png',
    );
  });
});

describe('every source', () => {
  it('identifies itself with a named user agent on every request', async () => {
    // Node's fetch says `node`, and the real explorer answered that with a
    // 403 in seventy milliseconds. A named agent with a URL is what an edge
    // rule expects from a well-behaved service.
    const seen: Record<string, string>[] = [];
    const fetch: Fetch = async (url, init) => {
      seen.push(init?.headers ?? {});
      return { ok: true, status: 200, json: async () => ({}) };
    };
    await blockscout({ isGeneric: never }).lookup(TOKEN, { fetch, log: quiet });
    await dexscreener().lookup(TOKEN, { fetch, log: quiet });
    await coingecko().lookup(TOKEN, { fetch, log: quiet });
    await coinmarketcap({ apiKey: 'k' }).lookup(TOKEN, { fetch, log: quiet });
    expect(seen.length).toBeGreaterThanOrEqual(4);
    for (const headers of seen) expect(headers['user-agent']).toMatch(/^Mozilla\/5\.0 \(compatible; Balast/);
  });
});

describe('launchpad page', () => {
  const page = (body: string) => {
    const calls: string[] = [];
    const fetch: Fetch = async (url) => {
      calls.push(url);
      return { ok: true, status: 200, json: async () => ({}), text: async () => body };
    };
    return { fetch, calls };
  };

  it('reads the token image out of the page data, escaped or not, and skips a share card', () => {
    expect(imageFromPage('<script>self.__next_f.push(["{\\"image\\":\\"https://cdn.pons.example/t/abc.png\\"}"])</script>')).toBe(
      'https://cdn.pons.example/t/abc.png',
    );
    expect(imageFromPage('{"imageUrl":"https://cdn.pons.example/t/abc.webp","name":"x"}')).toBe('https://cdn.pons.example/t/abc.webp');
    expect(
      imageFromPage('{"image":"https://www.pons.example/api/og?token=abc"}<meta property="og:image" content="https://cdn.pons.example/t/abc.png">'),
    ).toBe('https://cdn.pons.example/t/abc.png');
  });

  it('takes og:image only when it names an image file, never a generated card, never http', () => {
    expect(imageFromPage('<meta property="og:image" content="https://cdn.pons.example/t/abc.jpg">')).toBe('https://cdn.pons.example/t/abc.jpg');
    expect(imageFromPage('<meta content="https://cdn.pons.example/t/abc.jpg" property="og:image">')).toBe('https://cdn.pons.example/t/abc.jpg');
    expect(imageFromPage('<meta property="og:image" content="https://www.pons.example/api/og/abc">')).toBeNull();
    expect(imageFromPage('<meta property="og:image" content="http://cdn.pons.example/t/abc.png">')).toBeNull();
    expect(imageFromPage('<html>nothing here</html>')).toBeNull();
  });

  it('asks the launchpad for the token\'s own page and carries the launchpad\'s name', async () => {
    const api = page('{"image":"https://cdn.pons.example/t/abc.png"}');
    const src = launchpadPage({ name: 'pons', launchpad: 'Pons', base: 'https://pons.example/launchpad/' });
    expect(src.launchpad).toBe('Pons');
    expect(await src.lookup(TOKEN, { fetch: api.fetch, log: quiet })).toBe('https://cdn.pons.example/t/abc.png');
    expect(api.calls).toEqual([`https://pons.example/launchpad/${TOKEN}`]);
    expect(await src.lookup(NATIVE_ETH, { fetch: api.fetch, log: quiet })).toBeNull();
  });

  it('is null for a page that is missing or unreadable', async () => {
    const missing: Fetch = async () => ({ ok: false, status: 404, json: async () => ({}) });
    const src = launchpadPage({ name: 'pons', launchpad: 'Pons', base: 'https://pons.example/launchpad' });
    expect(await src.lookup(TOKEN, { fetch: missing, log: quiet })).toBeNull();
    const down: Fetch = async () => {
      throw new Error('ECONNRESET');
    };
    expect(await src.lookup(TOKEN, { fetch: down, log: quiet })).toBeNull();
  });
});

describe('tickers', () => {
  const facts = async (address: string) =>
    ({
      [TOKEN]: { symbol: 'AMD', name: 'AMD \u2022 Robinhood Token' },
      '0x00000000000000000000000000000000000000a2': { symbol: 'GME', name: 'GME' },
      '0x00000000000000000000000000000000000000a3': { symbol: 'SPCX', name: 'Space Exploration \u2022 Robinhood Token' },
      '0x00000000000000000000000000000000000000a4': { symbol: 'SPY', name: 'SPDR S&P 500 \u2022 Robinhood Token' },
    })[address] ?? null;

  it('maps a Robinhood stock token to its ticker icon when the icon exists', async () => {
    const api = service({ '/ticker_icons/AMD.png': {} });
    const src = tickers({ facts, base: 'https://icons.example/ticker_icons/' });
    expect(await src.lookup(TOKEN, { fetch: api.fetch, log: quiet })).toBe(
      'https://icons.example/ticker_icons/AMD.png',
    );
  });

  it('never dresses a token that is not a Robinhood stock token in a stock\'s mark', async () => {
    // A launchpad coin calling itself GME is not GameStop.
    const api = service({ '/ticker_icons/GME.png': {} });
    expect(
      await tickers({ facts }).lookup('0x00000000000000000000000000000000000000a2', { fetch: api.fetch, log: quiet }),
    ).toBeNull();
    expect(api.calls).toHaveLength(0);
  });

  it('is null when the repository has no icon for the ticker', async () => {
    const api = service({});
    expect(
      await tickers({ facts }).lookup('0x00000000000000000000000000000000000000a4', { fetch: api.fetch, log: quiet }),
    ).toBeNull();
    expect(api.calls[0]).toContain('/ticker_icons/SPY.png');
  });

  it('gives a private company\'s stock token the mark this site serves, without asking the repository', async () => {
    // SpaceX is on no exchange, so no ticker repository has it; without this
    // the row wears whatever the explorer answered — the issuer's feather.
    const api = service({ '/ticker_icons/SPCX.png': {} });
    expect(
      await tickers({ facts, site: 'https://site.example/' }).lookup('0x00000000000000000000000000000000000000a3', {
        fetch: api.fetch,
        log: quiet,
      }),
    ).toBe('https://site.example/tokens/spcx.svg');
    expect(api.calls).toHaveLength(0);
    // The mark is a real file in the repository, on the canonical site by default.
    expect(await tickers({ facts }).lookup('0x00000000000000000000000000000000000000a3', { fetch: api.fetch, log: quiet })).toBe(
      'https://balast.xyz/tokens/spcx.svg',
    );
    expect(existsSync(join(process.cwd(), 'public', 'tokens', 'spcx.svg'))).toBe(true);
  });
});

describe('onchain', () => {
  const answering = (table: Partial<Record<string, string | null>>) => async (_address: string, fn: string) =>
    table[fn] ?? null;

  it('reads contractURI, resolves ipfs:// through the gateway, and takes image from the JSON', async () => {
    const api = service({ '/ipfs/QmMeta': { name: 'VLAD', image: 'ipfs://QmImage/logo.png' } });
    const src = onchain({ read: answering({ contractURI: 'ipfs://QmMeta' }), gateway: 'https://gw.example/ipfs/' });
    expect(await src.lookup(TOKEN, { fetch: api.fetch, log: quiet })).toBe('https://gw.example/ipfs/QmImage/logo.png');
    expect(api.calls).toEqual(['https://gw.example/ipfs/QmMeta']);
  });

  it('takes a URI that is the image itself without fetching it, and falls through reverts', async () => {
    const api = service({});
    const src = onchain({ read: answering({ contractURI: null, metadataURI: null, image: 'https://cdn.example/vlad.png' }) });
    expect(await src.lookup(TOKEN, { fetch: api.fetch, log: quiet })).toBe('https://cdn.example/vlad.png');
    expect(api.calls).toHaveLength(0);
  });

  it('decodes an inline data: JSON URI in place', async () => {
    const json = Buffer.from(JSON.stringify({ image: 'https://cdn.example/inline.png' })).toString('base64');
    const src = onchain({ read: answering({ contractURI: `data:application/json;base64,${json}` }) });
    expect(await src.lookup(TOKEN, { fetch: service({}).fetch, log: quiet })).toBe('https://cdn.example/inline.png');
  });

  it('never fetches http, an IP literal or localhost, whatever the contract says', async () => {
    const api = service({ '/meta': { image: 'https://cdn.example/x.png' } });
    for (const uri of ['http://cdn.example/meta', 'https://127.0.0.1:3001/meta', 'https://localhost/meta', 'https://[::1]/meta']) {
      expect(await onchain({ read: answering({ contractURI: uri }) }).lookup(TOKEN, { fetch: api.fetch, log: quiet })).toBeNull();
    }
    expect(api.calls).toHaveLength(0);
    // And an image the metadata names over http is refused too.
    const insecure = service({ '/meta': { image: 'http://cdn.example/x.png' } });
    expect(await onchain({ read: answering({ contractURI: 'https://cdn.example/meta' }) }).lookup(TOKEN, { fetch: insecure.fetch, log: quiet })).toBeNull();
  });

  it('is null for a contract with none of the functions, and never asks about ether', async () => {
    const calls: string[] = [];
    const read = async (_a: string, fn: string) => {
      calls.push(fn);
      return null;
    };
    expect(await onchain({ read }).lookup(TOKEN, { fetch: service({}).fetch, log: quiet })).toBeNull();
    expect(calls).toEqual(['contractURI', 'metadataURI', 'image', 'imageUrl', 'logoURI']);
    expect(await onchain({ read }).lookup(NATIVE_ETH, { fetch: service({}).fetch, log: quiet })).toBeNull();
    expect(calls).toHaveLength(5);
  });
});

describe('geckoterminal', () => {
  const networks = {
    '/networks?page=1': { data: [{ id: 'eth', attributes: { name: 'Ethereum' } }, { id: 'base', attributes: { name: 'Base' } }] },
    '/networks?page=2': { data: [{ id: 'robinhood', attributes: { name: 'Robinhood Chain' } }] },
  };

  it('discovers the network by name, then reads image_url', async () => {
    const api = service({ ...networks, '/networks/robinhood/tokens/': { data: { attributes: { image_url: LOGO } } } });
    const said: string[] = [];
    const src = geckoterminal();
    expect(await src.lookup(TOKEN, { fetch: api.fetch, log: (m) => said.push(m) })).toBe(LOGO);
    expect(api.calls.slice(0, 3)).toEqual([
      'https://api.geckoterminal.com/api/v2/networks?page=1',
      'https://api.geckoterminal.com/api/v2/networks?page=2',
      `https://api.geckoterminal.com/api/v2/networks/robinhood/tokens/${TOKEN}`,
    ]);
    expect(said.some((m) => /knows this chain as "robinhood"/.test(m))).toBe(true);
    // Remembered: the next token costs one call.
    await src.lookup('0x00000000000000000000000000000000000000a2', { fetch: api.fetch, log: quiet });
    expect(api.calls.filter((c) => c.includes('/networks?page='))).toHaveLength(2);
  });

  it('treats missing.png as no image, and a pinned network skips discovery', async () => {
    const api = service({ '/networks/rh/tokens/': { data: { attributes: { image_url: 'https://x/missing.png' } } } });
    expect(await geckoterminal({ network: 'rh' }).lookup(TOKEN, { fetch: api.fetch, log: quiet })).toBeNull();
    expect(api.calls).toEqual([`https://api.geckoterminal.com/api/v2/networks/rh/tokens/${TOKEN}`]);
  });

  it('disables itself, once and audibly, when the chain is not listed', async () => {
    const api = service({ '/networks?page=1': { data: [{ id: 'eth', attributes: { name: 'Ethereum' } }] }, '/networks?page=2': { data: [] } });
    const said: string[] = [];
    const src = geckoterminal();
    expect(await src.lookup(TOKEN, { fetch: api.fetch, log: (m) => said.push(m) })).toBeNull();
    expect(await src.lookup(TOKEN, { fetch: api.fetch, log: (m) => said.push(m) })).toBeNull();
    expect(said.filter((m) => /does not list/.test(m))).toHaveLength(1);
    expect(api.calls.some((c) => c.includes('/tokens/'))).toBe(false);
  });
});

describe('coingecko', () => {
  it('does not ask for the platform list again for ten minutes after it fails', async () => {
    let clock = 1_000_000;
    const api = service({ '/asset_platforms': 'not a list' });
    const src = coingecko({ now: () => clock });
    expect(await src.lookup(TOKEN, { fetch: api.fetch, log: quiet })).toBeNull();
    expect(await src.lookup('0x00000000000000000000000000000000000000a2', { fetch: api.fetch, log: quiet })).toBeNull();
    expect(api.calls).toHaveLength(1);
    clock += 11 * 60_000;
    await src.lookup(TOKEN, { fetch: api.fetch, log: quiet });
    expect(api.calls).toHaveLength(2);
  });

  it('goes quiet for a minute and a half after a 429', async () => {
    let clock = 1_000_000;
    const calls: string[] = [];
    const fetch: Fetch = async (url) => {
      calls.push(url);
      if (url.includes('/asset_platforms')) {
        return { ok: true, status: 200, json: async () => [{ id: 'rh', chain_identifier: CHAIN.id }] };
      }
      return { ok: false, status: 429, json: async () => ({}) };
    };
    const src = coingecko({ now: () => clock });
    expect(await src.lookup(TOKEN, { fetch, log: quiet })).toBeNull();
    expect(calls).toHaveLength(2);
    // Paused: the next token costs no request at all.
    await src.lookup('0x00000000000000000000000000000000000000a2', { fetch, log: quiet });
    expect(calls).toHaveLength(2);
    clock += 2 * 60_000;
    await src.lookup(TOKEN, { fetch, log: quiet });
    expect(calls).toHaveLength(3);
  });

  it('discovers the platform by chainId, then reads image.large from the contract lookup', async () => {
    const api = service({
      '/asset_platforms': [
        { id: 'ethereum', chain_identifier: 1 },
        { id: 'robinhood-chain', chain_identifier: CHAIN.id },
      ],
      '/coins/robinhood-chain/contract/': { image: { thumb: 'https://x/t.png', large: LOGO } },
    });
    const src = coingecko();
    expect(await src.lookup(TOKEN, { fetch: api.fetch, log: quiet })).toBe(LOGO);
    expect(api.calls[0]).toContain('/asset_platforms');
    expect(api.calls[1]).toContain(`/coins/robinhood-chain/contract/${TOKEN}`);
    // The platform is remembered: a second token costs one call, not two.
    await src.lookup('0x00000000000000000000000000000000000000a2', { fetch: api.fetch, log: quiet });
    expect(api.calls.filter((c) => c.includes('/asset_platforms'))).toHaveLength(1);
  });

  it('disables itself, once and audibly, when the chain is not listed', async () => {
    const api = service({ '/asset_platforms': [{ id: 'ethereum', chain_identifier: 1 }] });
    const said: string[] = [];
    const src = coingecko();
    expect(await src.lookup(TOKEN, { fetch: api.fetch, log: (m) => said.push(m) })).toBeNull();
    expect(await src.lookup(TOKEN, { fetch: api.fetch, log: (m) => said.push(m) })).toBeNull();
    expect(said.filter((m) => /does not list chainId/.test(m))).toHaveLength(1);
    // And never asks for a contract it cannot address.
    expect(api.calls.some((c) => c.includes('/contract/'))).toBe(false);
  });

  it('asks for ethereum itself for native ether', async () => {
    const api = service({ '/coins/ethereum': { image: { large: 'https://x/eth.png' } } });
    expect(await coingecko().lookup(NATIVE_ETH, { fetch: api.fetch, log: quiet })).toBe('https://x/eth.png');
    expect(api.calls.some((c) => c.includes('/asset_platforms'))).toBe(false);
  });

  it('refuses an image that is not a safe https URL, and survives garbage', async () => {
    const bad = service({
      '/asset_platforms': [{ id: 'rh', chain_identifier: CHAIN.id }],
      '/contract/': { image: { large: 'javascript:alert(1)' } },
    });
    expect(await coingecko().lookup(TOKEN, { fetch: bad.fetch, log: quiet })).toBeNull();
    const garbage = service({ '/asset_platforms': 'not a list' });
    expect(await coingecko().lookup(TOKEN, { fetch: garbage.fetch, log: quiet })).toBeNull();
    const down: Fetch = async () => {
      throw new Error('ECONNRESET');
    };
    expect(await coingecko().lookup(TOKEN, { fetch: down, log: quiet })).toBeNull();
  });
});

describe('dexscreener', () => {
  it('takes the image from the pair whose base token is this address', async () => {
    const api = service({
      '/latest/dex/tokens/': {
        pairs: [
          { baseToken: { address: '0x00000000000000000000000000000000000000ff' }, info: { imageUrl: 'https://x/wrong.png' } },
          { baseToken: { address: TOKEN.toUpperCase() }, info: { imageUrl: LOGO } },
        ],
      },
    });
    expect(await dexscreener().lookup(TOKEN, { fetch: api.fetch, log: quiet })).toBe(LOGO);
  });

  it('is null for a token with pairs but no image, and never asks about ether', async () => {
    const api = service({ '/latest/dex/tokens/': { pairs: [{ baseToken: { address: TOKEN } }] } });
    expect(await dexscreener().lookup(TOKEN, { fetch: api.fetch, log: quiet })).toBeNull();
    expect(await dexscreener().lookup(NATIVE_ETH, { fetch: api.fetch, log: quiet })).toBeNull();
    expect(api.calls).toHaveLength(1);
  });
});

describe('coinmarketcap', () => {
  it('disables itself without a key, once', async () => {
    const api = service({});
    const said: string[] = [];
    const src = coinmarketcap({ apiKey: null });
    await src.lookup(TOKEN, { fetch: api.fetch, log: (m) => said.push(m) });
    await src.lookup(TOKEN, { fetch: api.fetch, log: (m) => said.push(m) });
    expect(api.calls).toHaveLength(0);
    expect(said.filter((m) => /CMC_API_KEY/.test(m))).toHaveLength(1);
  });

  it('reads data[id].logo with the key in the header', async () => {
    const api = service({ '/v2/cryptocurrency/info?address=': { data: { '123': { logo: LOGO } } } });
    const seen: Record<string, string>[] = [];
    const fetch: Fetch = (url, init) => {
      seen.push(init?.headers ?? {});
      return api.fetch(url, init);
    };
    expect(await coinmarketcap({ apiKey: 'k' }).lookup(TOKEN, { fetch, log: quiet })).toBe(LOGO);
    expect(seen[0]['X-CMC_PRO_API_KEY']).toBe('k');
  });
});

describe('createSources', () => {
  it('builds the named sources in order and ignores names it does not know', () => {
    expect(createSources(['dexscreener', 'none', 'coingecko']).map((s) => s.name)).toEqual([
      'dexscreener',
      'coingecko',
    ]);
    expect(createSources(['explorer', 'blockscout']).map((s) => s.name)).toEqual(['explorer', 'explorer']);
    expect(createSources(['tickers', 'geckoterminal', 'onchain']).map((s) => s.name)).toEqual([
      'tickers',
      'geckoterminal',
      'onchain',
    ]);
    expect(createSources(['none'])).toHaveLength(0);
  });
});

describe('lookupLogos', () => {
  beforeAll(async () => {
    if (!(await isReachable())) {
      throw new Error('These tests need a Postgres at TEST_DATABASE_URL. See README.');
    }
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function seedToken(address: string, symbol: string): Promise<void> {
    await prisma.token.create({
      data: { address, symbol, name: symbol, decimals: 18, firstSeen: new Date('2026-07-01') },
    });
  }

  function sourceAnswering(answers: Record<string, string | null>): LogoSource & { asked: string[] } {
    const asked: string[] = [];
    return {
      name: 'fake',
      asked,
      async lookup(address) {
        asked.push(address);
        return answers[address] ?? null;
      },
    };
  }

  it('records a found logo, and a miss, and does not re-ask within the retry window', async () => {
    await resetDatabase();
    await seedToken(TOKEN, 'A1');
    await seedToken('0x00000000000000000000000000000000000000a2', 'A2');
    const src = sourceAnswering({ [TOKEN]: LOGO });
    const now = new Date('2026-09-14T12:00:00Z');

    // Two calls, one token each: the first finds A1's logo, the second
    // misses A2 — and both are marked as checked.
    expect(await lookupLogos({ sources: [src], now, limit: 1, fetch: service({ 'cdn.example': {} }).fetch })).toBe(1);
    expect(await lookupLogos({ sources: [src], now, limit: 1, fetch: service({ 'cdn.example': {} }).fetch })).toBe(0);
    const rows = await prisma.token.findMany({ orderBy: { address: 'asc' } });
    expect(rows[0].logoUrl).toBe(LOGO);
    expect(rows[0].logoCheckedAt?.toISOString()).toBe(now.toISOString());
    expect(rows[1].logoUrl).toBeNull();
    expect(rows[1].logoCheckedAt?.toISOString()).toBe(now.toISOString());

    // A day later: nothing to ask. A week later: the miss is asked again.
    const asked = src.asked.length;
    await lookupLogos({ sources: [src], now: new Date(now.getTime() + 86_400_000), fetch: service({}).fetch });
    expect(src.asked.length).toBe(asked);
    await lookupLogos({ sources: [src], now: new Date(now.getTime() + 8 * 86_400_000), fetch: service({}).fetch });
    expect(src.asked.length).toBe(asked + 1);
    expect(src.asked[asked]).toBe('0x00000000000000000000000000000000000000a2');
  });

  it('tries sources in order and stops at the first that answers', async () => {
    await resetDatabase();
    await seedToken(TOKEN, 'A1');
    const first = sourceAnswering({});
    const second = sourceAnswering({ [TOKEN]: LOGO });
    const third = sourceAnswering({ [TOKEN]: 'https://x/never.png' });
    expect(await lookupLogos({ sources: [first, second, third], fetch: service({ 'cdn.example': {} }).fetch })).toBe(1);
    expect(third.asked).toHaveLength(0);
    expect((await prisma.token.findUniqueOrThrow({ where: { address: TOKEN } })).logoUrl).toBe(LOGO);
  });

  it('does not record an image that does not load, and lets the next source try', async () => {
    await resetDatabase();
    await seedToken(TOKEN, 'A1');
    const broken = sourceAnswering({ [TOKEN]: 'https://blocked.example/a1.png' });
    const good = sourceAnswering({ [TOKEN]: LOGO });
    const said: string[] = [];
    // blocked.example answers 404 to the load check; cdn.example answers ok.
    const fetch = service({ 'cdn.example': {} }).fetch;
    expect(await lookupLogos({ sources: [broken, good], fetch, log: (m) => said.push(m) })).toBe(1);
    expect((await prisma.token.findUniqueOrThrow({ where: { address: TOKEN } })).logoUrl).toBe(LOGO);
    expect(said.some((m) => /does not load: https:\/\/blocked.example/.test(m))).toBe(true);
    // Every source failing to load leaves the token without a logo, marked as asked.
    await resetDatabase();
    await seedToken(TOKEN, 'A1');
    expect(await lookupLogos({ sources: [broken], fetch })).toBe(0);
    const row = await prisma.token.findUniqueOrThrow({ where: { address: TOKEN } });
    expect(row.logoUrl).toBeNull();
    expect(row.logoCheckedAt).not.toBeNull();
  });

  it('refuses an image whose content type is not an image', async () => {
    await resetDatabase();
    await seedToken(TOKEN, 'A1');
    const html: Fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({}),
      headers: { get: (name: string) => (name === 'content-type' ? 'text/html; charset=utf-8' : null) },
    });
    expect(await lookupLogos({ sources: [sourceAnswering({ [TOKEN]: LOGO })], fetch: html })).toBe(0);
  });

  const stock = (address: string, symbol: string, name: string, logoUrl: string | null) =>
    prisma.token.create({ data: { address, symbol, name, decimals: 18, firstSeen: new Date('2026-07-01'), logoUrl } });
  const answering = (answers: Record<string, string | null>): LogoSource => ({
    name: 'fake',
    async lookup(address) {
      return answers[address] ?? null;
    },
  });

  it('gives a stock the ticker icon when the explorer has nothing of its own, and leaves other tokens alone', async () => {
    await resetDatabase();
    const feather = 'https://explorer.example/robinhood-feather.png';
    await stock(TOKEN, 'NVDA', 'NVIDIA \u2022 Robinhood Token', feather);
    await stock('0x00000000000000000000000000000000000000a2', 'GME', 'GME', feather);
    const facts = async (address: string) =>
      address === TOKEN ? { symbol: 'NVDA', name: 'NVIDIA \u2022 Robinhood Token' } : { symbol: 'GME', name: 'GME' };
    const fetch = service({ 'icons.example': {} }).fetch;
    const tickerSource = tickers({ facts, base: 'https://icons.example/ticker_icons/' });
    expect(await reconcileStockLogos({ explorer: answering({}), tickers: tickerSource, fetch })).toBe(1);
    expect((await prisma.token.findUniqueOrThrow({ where: { address: TOKEN } })).logoUrl).toBe(
      'https://icons.example/ticker_icons/NVDA.png',
    );
    // Not a stock token: untouched.
    expect((await prisma.token.findUniqueOrThrow({ where: { address: '0x00000000000000000000000000000000000000a2' } })).logoUrl).toBe(feather);
    // Already the best answer on record: nothing changes on the next start.
    expect(await reconcileStockLogos({ explorer: answering({}), tickers: tickerSource, fetch })).toBe(0);
  });

  it('prefers the issuer\'s own per-stock icon over a ticker icon already on record', async () => {
    await resetDatabase();
    await stock(TOKEN, 'AMD', 'AMD \u2022 Robinhood Token', 'https://icons.example/ticker_icons/AMD.png');
    const own = 'https://explorer.example/images/amd-robinhood.png';
    const fetch = service({ 'explorer.example': {}, 'icons.example': {} }).fetch;
    const facts = async () => ({ symbol: 'AMD', name: 'AMD \u2022 Robinhood Token' });
    const tickerSource = tickers({ facts, base: 'https://icons.example/ticker_icons/' });
    expect(await reconcileStockLogos({ explorer: answering({ [TOKEN]: own }), tickers: tickerSource, fetch })).toBe(1);
    expect((await prisma.token.findUniqueOrThrow({ where: { address: TOKEN } })).logoUrl).toBe(own);
    expect(await reconcileStockLogos({ explorer: answering({ [TOKEN]: own }), tickers: tickerSource, fetch })).toBe(0);
  });

  it('falls to this site\'s own mark for a private company the explorer and the repository both lack', async () => {
    await resetDatabase();
    await stock(TOKEN, 'SPCX', 'Space Exploration \u2022 Robinhood Token', 'https://explorer.example/robinhood-feather.png');
    const facts = async () => ({ symbol: 'SPCX', name: 'Space Exploration \u2022 Robinhood Token' });
    const tickerSource = tickers({ facts, base: 'https://icons.example/ticker_icons/', site: 'https://site.example' });
    const fetch = service({ 'site.example': {} }).fetch;
    expect(await reconcileStockLogos({ explorer: answering({}), tickers: tickerSource, fetch })).toBe(1);
    expect((await prisma.token.findUniqueOrThrow({ where: { address: TOKEN } })).logoUrl).toBe('https://site.example/tokens/spcx.svg');
    expect(await reconcileStockLogos({ explorer: answering({}), tickers: tickerSource, fetch })).toBe(0);
  });

  it('forgets an icon that three tokens share, remembers it as generic, and leaves a pair alone', async () => {
    await resetDatabase();
    const feather = 'https://explorer.example/robinhood-feather.png';
    const pair = 'https://cdn.example/pair.png';
    await stock(TOKEN, 'GLD', 'GLD \u2022 Robinhood Token', feather);
    await stock('0x00000000000000000000000000000000000000a2', 'SLV', 'SLV \u2022 Robinhood Token', feather);
    await stock('0x00000000000000000000000000000000000000a3', 'SPY', 'SPY \u2022 Robinhood Token', feather);
    await stock('0x00000000000000000000000000000000000000a4', 'X1', 'X1', pair);
    await stock('0x00000000000000000000000000000000000000a5', 'X2', 'X2', pair);
    expect(await forgetSharedLogos()).toBe(3);
    const rows = await prisma.token.findMany({ orderBy: { address: 'asc' }, select: { logoUrl: true } });
    expect(rows.map((r) => r.logoUrl)).toEqual([null, null, null, pair, pair]);
    const state = await prisma.indexerState.findUniqueOrThrow({ where: { key: GENERIC_LOGOS_KEY } });
    expect(JSON.parse(state.value).urls).toEqual([feather]);
    // And the explorer, asked about a fourth token with the same picture, now refuses it.
    const api = service({ '/api/v2/tokens/': { icon_url: feather } });
    expect(await blockscout().lookup('0x00000000000000000000000000000000000000a6', { fetch: api.fetch, log: quiet })).toBeNull();
  });

  it('recognises one picture served under a URL per token by its bytes, and refuses it under a fourth URL', async () => {
    await resetDatabase();
    // The explorer's feather: the same PNG under three token-specific URLs.
    const feather = Buffer.from('feather-png-bytes');
    const own = Buffer.from('a-real-logo');
    const bytes: Record<string, Buffer> = {
      'https://explorer.example/images/a1.png': feather,
      'https://explorer.example/images/a2.png': feather,
      'https://explorer.example/images/a3.png': feather,
      'https://explorer.example/images/a9.png': feather,
      'https://cdn.example/virtual.png': own,
    };
    const fetch: Fetch = async (url) => ({
      ok: url in bytes,
      status: url in bytes ? 200 : 404,
      json: async () => ({}),
      arrayBuffer: async () => bytes[url].buffer.slice(bytes[url].byteOffset, bytes[url].byteOffset + bytes[url].byteLength),
    });
    await stock(TOKEN, 'AMD', 'AMD \u2022 Robinhood Token', 'https://explorer.example/images/a1.png');
    await stock('0x00000000000000000000000000000000000000a2', 'TSLA', 'TSLA \u2022 Robinhood Token', 'https://explorer.example/images/a2.png');
    await stock('0x00000000000000000000000000000000000000a3', 'SPCX', 'SPCX \u2022 Robinhood Token', 'https://explorer.example/images/a3.png');
    await stock('0x00000000000000000000000000000000000000a4', 'VIRTUAL', 'Virtuals', 'https://cdn.example/virtual.png');
    expect(await forgetSharedLogos({ fetch })).toBe(3);
    const rows = await prisma.token.findMany({ orderBy: { address: 'asc' }, select: { logoUrl: true } });
    expect(rows.map((r) => r.logoUrl)).toEqual([null, null, null, 'https://cdn.example/virtual.png']);
    // A fourth token, a fourth URL, the same bytes: generic.
    expect(await isGenericLogo('https://explorer.example/images/a9.png', '0x00000000000000000000000000000000000000a9', fetch)).toBe(true);
    expect(await isGenericLogo('https://cdn.example/virtual.png', '0x00000000000000000000000000000000000000a9', fetch)).toBe(false);
    // So the explorer refuses it, and a stock falls through to its ticker icon.
    const api: Fetch = async (url, init) =>
      url.includes('/api/v2/tokens/')
        ? { ok: true, status: 200, json: async () => ({ icon_url: 'https://explorer.example/images/a9.png' }) }
        : fetch(url, init);
    expect(await blockscout().lookup('0x00000000000000000000000000000000000000a9', { fetch: api, log: quiet })).toBeNull();
  });

  it('records which launchpad a token came from when the launchpad\'s own page answered', async () => {
    await resetDatabase();
    await seedToken(TOKEN, 'BUN');
    const pons: LogoSource = {
      name: 'pons',
      launchpad: 'Pons',
      async lookup(address) {
        return address === TOKEN ? 'https://cdn.pons.example/t/bun.png' : null;
      },
    };
    expect(await lookupLogos({ sources: [pons], fetch: service({ 'cdn.pons.example': {} }).fetch })).toBe(1);
    const row = await prisma.token.findUniqueOrThrow({ where: { address: TOKEN } });
    expect(row.logoUrl).toBe('https://cdn.pons.example/t/bun.png');
    expect(row.launchpad).toBe('Pons');
  });

  it('does nothing with no sources', async () => {
    await resetDatabase();
    await seedToken(TOKEN, 'A1');
    expect(await lookupLogos({ sources: [], fetch: service({}).fetch })).toBe(0);
    expect((await prisma.token.findUniqueOrThrow({ where: { address: TOKEN } })).logoCheckedAt).toBeNull();
  });
});
