/**
 * The market feed (market.ts) and its sources (market-sources.ts): parsing
 * each documented answer, summing a token's pairs, falling through to the
 * second source, keeping the last quotes through a refusal, and dropping a
 * quote that is no longer live. No database; fake fetches answer.
 */

import { describe, expect, it } from 'vitest';
import { MISS_RETRY_MS, MarketFeed, STALE_MS } from './market';
import { aggregate, dexscreener, geckoterminal, parseGeckoTokens, parsePairs } from './market-sources';
import type { Fetch } from '../indexer/logo-sources';

const TOKEN = '0x00000000000000000000000000000000000000a1';
const OTHER = '0x00000000000000000000000000000000000000b2';
const POOL = '0x0000000000000000000000000000000000009999';

function pair(overrides: Record<string, unknown> = {}) {
  return {
    chainId: 'robinhood',
    dexId: 'uniswap',
    url: 'https://dexscreener.com/robinhood/0x9999',
    pairAddress: POOL,
    baseToken: { address: TOKEN, name: 'Token', symbol: 'TKN' },
    quoteToken: { address: '0x0bd7d308f8e1639fab988df18a8011f41eacad73', name: 'Wrapped Ether', symbol: 'WETH' },
    priceNative: '0.0000123',
    priceUsd: '0.0512',
    txns: { m5: { buys: 1, sells: 0 }, h1: { buys: 12, sells: 8 }, h6: { buys: 40, sells: 31 }, h24: { buys: 120, sells: 95 } },
    volume: { h24: 45812.33, h6: 9000, h1: 1200, m5: 50 },
    priceChange: { m5: 0.1, h1: -1.2, h6: 3.4, h24: 12.5 },
    liquidity: { usd: 111234.5, base: 1_000_000, quote: 20 },
    fdv: 5_120_000,
    marketCap: 4_900_000,
    pairCreatedAt: 1720000000000,
    ...overrides,
  };
}

function fakeFetch(answer: (url: string) => { status: number; body: unknown }): Fetch & { calls: string[] } {
  const calls: string[] = [];
  const f = (async (url: string) => {
    calls.push(url);
    const { status, body } = answer(url);
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => 'application/json' },
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  }) as unknown as Fetch & { calls: string[] };
  f.calls = calls;
  return f;
}

/** A feed with one source, so a test says which answer it is exercising. */
function feedWith(source: ReturnType<typeof dexscreener>, options: Record<string, unknown> = {}) {
  return new MarketFeed({ sources: [source], ...options });
}

describe('parsing DexScreener', () => {
  it('reads the documented shape, strings and numbers alike', () => {
    const [p] = parsePairs({ schemaVersion: '1.0.0', pairs: [pair()] });
    expect(p.chainId).toBe('robinhood');
    expect(p.baseToken).toBe(TOKEN);
    expect(p.priceUsd).toBe(0.0512);
    expect(p.volume24hUsd).toBe(45812.33);
    expect(p.buys24h).toBe(120);
    expect(p.sells24h).toBe(95);
    expect(p.priceChange24hPct).toBe(12.5);
    expect(p.liquidityUsd).toBe(111234.5);
    expect(p.marketCapUsd).toBe(4_900_000);
  });

  it('leaves out what it cannot read and never throws', () => {
    expect(parsePairs(null)).toEqual([]);
    expect(parsePairs({ pairs: null })).toEqual([]);
    expect(parsePairs({ pairs: [null, 42, { baseToken: {} }] })).toEqual([]);
    const [p] = parsePairs({
      pairs: [pair({ volume: undefined, txns: undefined, priceChange: { h24: 'n/a' }, priceUsd: null })],
    });
    expect(p.volume24hUsd).toBe(0);
    // No txns object at all is "this source did not split the day", not zero trades.
    expect(p.buys24h).toBeNull();
    expect(p.priceChange24hPct).toBeNull();
    expect(p.priceUsd).toBeNull();
  });
});

describe("summing a token's pairs", () => {
  // The defect this replaced: NVDA read $17.9K of volume off one shallow v4
  // pair while its own page summed several. The board is a token listing, so
  // the token's day is all of its pairs' days.
  const pairs = parsePairs({
    pairs: [
      pair({ pairAddress: '0x1', liquidity: { usd: 900_000 }, volume: { h24: 21_000_000 }, txns: { h24: { buys: 900, sells: 700 } }, priceChange: { h24: -3.8 }, marketCap: 22_920_000, fdv: 22_530_000 }),
      pair({ pairAddress: POOL, liquidity: { usd: 25_500 }, volume: { h24: 17_900 }, txns: { h24: { buys: 27, sells: 83 } }, priceChange: { h24: 40 }, marketCap: 99, fdv: 99 }),
      pair({ pairAddress: '0x3', liquidity: { usd: 500 }, volume: { h24: 100 }, txns: { h24: { buys: 1, sells: 2 } } }),
    ],
  });

  it('sums the quantities and reads the rest off the deepest pair', () => {
    const q = aggregate(pairs, TOKEN, POOL, null, 'dexscreener', '2026-09-15T00:00:00.000Z')!;
    expect(q.pairs).toBe(3);
    expect(q.volume24hUsd).toBe(21_018_000);
    expect(q.buys24h).toBe(928);
    expect(q.sells24h).toBe(785);
    expect(q.liquidityUsd).toBe(926_000);
    // Not summed: a market cap added over three pools would be three times
    // the token's. The change and the price come from the deepest pair too.
    expect(q.marketCapUsd).toBe(22_920_000);
    expect(q.fdvUsd).toBe(22_530_000);
    expect(q.priceChange24hPct).toBe(-3.8);
    expect(q.pairAddress).toBe('0x1');
    // The row's own pool keeps its own liquidity, for the row's dash.
    expect(q.poolLiquidityUsd).toBe(25_500);
  });

  it('reports no pool liquidity when the source does not list the row’s pool', () => {
    const q = aggregate(pairs, TOKEN, '0xnotlisted', null, 'dexscreener', '2026-09-15T00:00:00.000Z')!;
    expect(q.poolLiquidityUsd).toBeNull();
    expect(q.volume24hUsd).toBe(21_018_000);
  });

  it('only counts pairs where the token is the base, and only on the configured chain', () => {
    const mixed = parsePairs({
      pairs: [
        pair({ pairAddress: '0x1', chainId: 'ethereum', liquidity: { usd: 9e9 }, volume: { h24: 7 } }),
        pair({ pairAddress: '0x2', chainId: 'robinhood', liquidity: { usd: 5 }, volume: { h24: 11 } }),
        pair({ pairAddress: '0x3', baseToken: { address: OTHER }, quoteToken: { address: TOKEN }, liquidity: { usd: 9e9 }, volume: { h24: 13 } }),
      ],
    });
    // 0x3 is the deepest by far and TOKEN is only its quote: never counted.
    expect(aggregate(mixed, TOKEN, '', 'robinhood', 'dexscreener', 'x')!.volume24hUsd).toBe(11);
    expect(aggregate(mixed, OTHER, '', null, 'dexscreener', 'x')!.volume24hUsd).toBe(13);
    expect(aggregate(mixed, OTHER, '', 'ethereum', 'dexscreener', 'x')).toBeNull();
  });

  it('never sums across chains, even with no chain configured', () => {
    // A token address exists on other chains too. Summing the day over two
    // of them produces a figure that belongs to no market, so the deepest
    // pair's chain decides and the rest are left out; /api/health lists
    // every id seen so the right one can be pinned.
    const mixed = parsePairs({
      pairs: [
        pair({ pairAddress: '0x1', chainId: 'ethereum', liquidity: { usd: 9e9 }, volume: { h24: 7 } }),
        pair({ pairAddress: '0x2', chainId: 'robinhood', liquidity: { usd: 5 }, volume: { h24: 11 } }),
      ],
    });
    const q = aggregate(mixed, TOKEN, '', null, 'dexscreener', 'x')!;
    expect(q.chainId).toBe('ethereum');
    expect(q.pairs).toBe(1);
    expect(q.volume24hUsd).toBe(7);
  });

  it('carries a null trade split rather than inventing zeroes', () => {
    const noSplit = parsePairs({ pairs: [pair({ txns: undefined })] });
    const q = aggregate(noSplit, TOKEN, '', null, 'geckoterminal', 'x')!;
    expect(q.buys24h).toBeNull();
    expect(q.sells24h).toBeNull();
  });
});

describe('parsing GeckoTerminal', () => {
  const body = {
    data: [
      {
        id: 'robinhood_a1',
        type: 'token',
        attributes: {
          address: TOKEN,
          symbol: 'TKN',
          decimals: 18,
          total_supply: '1000000000000000000000000',
          price_usd: '0.0512',
          fdv_usd: '5120000',
          market_cap_usd: '4900000',
          total_reserve_in_usd: '926000.0',
          volume_usd: { h24: '21018000.5' },
        },
      },
    ],
    included: [
      {
        id: 'robinhood_pool1',
        type: 'pool',
        attributes: {
          address: '0x1',
          reserve_in_usd: '900000',
          volume_usd: { h24: '21000000' },
          price_change_percentage: { h24: '-3.8' },
        },
        relationships: { base_token: { data: { id: `robinhood_${TOKEN}` } }, dex: { data: { id: 'uniswap-v3' } } },
      },
      {
        id: 'robinhood_pool2',
        type: 'pool',
        attributes: { address: POOL, reserve_in_usd: '25500', price_change_percentage: { h24: '40' } },
        relationships: { base_token: { data: { id: `robinhood_${TOKEN}` } }, dex: { data: { id: 'uniswap-v4' } } },
      },
    ],
  };

  it('takes the token-level totals and the change off the deepest included pool', () => {
    const [t] = parseGeckoTokens(body, 'robinhood');
    expect(t.baseToken).toBe(TOKEN);
    expect(t.volume24hUsd).toBe(21_018_000.5);
    expect(t.liquidityUsd).toBe(926_000);
    expect(t.marketCapUsd).toBe(4_900_000);
    expect(t.fdvUsd).toBe(5_120_000);
    expect(t.priceChange24hPct).toBe(-3.8);
    expect(t.pairAddress).toBe('0x1');
    // It does not split a day into buys and sells; the row shows the chain's.
    expect(t.buys24h).toBeNull();
  });

  it('leaves out what it cannot read and never throws', () => {
    expect(parseGeckoTokens(null, 'x')).toEqual([]);
    expect(parseGeckoTokens({ data: [{ attributes: { address: 'nope' } }] }, 'x')).toEqual([]);
    const [t] = parseGeckoTokens({ data: [{ attributes: { address: TOKEN } }] }, 'x');
    expect(t.volume24hUsd).toBe(0);
    expect(t.marketCapUsd).toBeNull();
  });

  it('discovers the network id by name and disables itself when the chain is absent', async () => {
    const lines: string[] = [];
    const ctx = { fetch: fakeFetch(() => ({ status: 200, body: { data: [{ id: 'robinhood', attributes: { name: 'Robinhood Chain' } }] } })), log: (l: string) => lines.push(l), now: Date.now };
    const found = geckoterminal();
    await found.quotes([{ address: TOKEN, pool: '' }], ctx);
    expect(found.network()).toBe('robinhood');
    expect(lines.some((l) => l.includes('knows this chain as "robinhood"'))).toBe(true);

    const absent = geckoterminal();
    const none = { fetch: fakeFetch(() => ({ status: 200, body: { data: [{ id: 'eth', attributes: { name: 'Ethereum' } }] } })), log: (l: string) => lines.push(l), now: Date.now };
    const answer = await absent.quotes([{ address: TOKEN, pool: '' }], none);
    expect(absent.network()).toBeNull();
    expect(answer.quotes.size).toBe(0);
    expect(answer.refusal).toBeNull();
    expect(lines.some((l) => l.includes('does not list'))).toBe(true);
  });
});

describe('the feed', () => {
  it('quotes the tokens it follows, ten to a request, re-asks the rest alone, and says what it did', async () => {
    let clock = 1_000_000;
    const first = clock;
    // Answers only for TOKEN, whatever is asked: every other address is
    // asked again alone, misses, and is remembered as unknown.
    const fetch = fakeFetch(() => ({ status: 200, body: { pairs: [pair()] } }));
    const updates: number[] = [];
    const feed = feedWith(dexscreener(), { fetch, now: () => clock, onUpdate: () => updates.push(clock) });
    const many = Array.from({ length: 35 }, (_, i) => ({
      address: `0x${(i + 1).toString(16).padStart(40, '0')}`,
      pool: '',
    }));
    feed.follow([{ address: TOKEN, pool: POOL }, ...many]);
    expect(await feed.refresh()).toBe(1);
    // Four batches of ten, then each of the 35 unquoted alone.
    expect(fetch.calls).toHaveLength(4 + 35);
    expect(fetch.calls[0]).toContain(`/latest/dex/tokens/${TOKEN}`);
    expect(fetch.calls[0].split(',').length).toBe(10);
    expect(fetch.calls[4].split(',').length).toBe(1);
    expect(feed.status().unknown).toBe(35);
    // The next refresh within ten minutes asks the batches only.
    const before = fetch.calls.length;
    clock += 30_000;
    await feed.refresh();
    expect(fetch.calls.length - before).toBe(4);

    const q = feed.quote(TOKEN.toUpperCase());
    expect(q).not.toBeNull();
    expect(q!.source).toBe('dexscreener');
    expect(q!.volume24hUsd).toBe(45812.33);
    expect(q!.buys24h).toBe(120);
    expect(feed.quote(OTHER)).toBeNull();
    // Published as the batch landed, and once — not again at the end of the
    // cycle, which woke every socket a second time for the same snapshot.
    expect(updates).toEqual([first]);

    const status = feed.status();
    expect(status.followed).toBe(36);
    expect(status.quoted).toBe(1);
    expect(status.chains).toEqual(['robinhood']);
    expect(status.lastError).toBeNull();
    expect(status.sources).toEqual([
      { name: 'dexscreener', quoted: 1, lastError: null, backoffUntil: null },
    ]);

    // The same answer again changes nothing and wakes nobody.
    expect(await feed.refresh()).toBe(0);
    expect(updates).toHaveLength(1);
    feed.stop();
  });

  it('quotes a token that a long batch starved, by asking for it alone', async () => {
    // The box: 32 of 76 quoted, no error, and a token DexScreener plainly
    // lists left unquoted. A fake that answers pairs only for the first
    // three tokens of any multi-token request, and everything for a single.
    const fetch = fakeFetch((url) => {
      const asked = url.split('/').pop()!.split(',');
      const answered = asked.length > 1 ? asked.slice(0, 3) : asked;
      return {
        status: 200,
        body: {
          pairs: answered.map((address, i) =>
            pair({ baseToken: { address }, pairAddress: `0xp${address.slice(-4)}${i}` }),
          ),
        },
      };
    });
    const feed = feedWith(dexscreener(), { fetch });
    const tokens = Array.from({ length: 8 }, (_, i) => ({
      address: `0x${(i + 1).toString(16).padStart(40, '0')}`,
      pool: '',
    }));
    feed.follow(tokens);
    await feed.refresh();
    for (const t of tokens) expect(feed.quote(t.address)).not.toBeNull();
    expect(feed.status().quoted).toBe(8);
    expect(feed.status().unknown).toBe(0);
    // One batch, then the five it starved, alone.
    expect(fetch.calls).toHaveLength(1 + 5);
    feed.stop();
  });

  it('asks the second source only for what the first did not answer', async () => {
    // The box: DexScreener quoted 32 of 76. The other 44 rows fell back to
    // figures two months old; GeckoTerminal is asked for exactly those.
    const fetch = fakeFetch((url) => {
      if (url.includes('/latest/dex/tokens/')) {
        return { status: 200, body: { pairs: [pair()] } };
      }
      if (url.includes('/networks?page=')) {
        return { status: 200, body: { data: [{ id: 'robinhood', attributes: { name: 'Robinhood Chain' } }] } };
      }
      return {
        status: 200,
        body: {
          data: [
            {
              attributes: {
                address: OTHER,
                price_usd: '2',
                fdv_usd: '17790000',
                total_reserve_in_usd: '54000',
                volume_usd: { h24: '660' },
              },
            },
          ],
        },
      };
    });
    const feed = new MarketFeed({ fetch });
    feed.follow([{ address: TOKEN, pool: POOL }, { address: OTHER, pool: '' }]);
    await feed.refresh();

    expect(feed.quote(TOKEN)!.source).toBe('dexscreener');
    const other = feed.quote(OTHER)!;
    expect(other.source).toBe('geckoterminal');
    expect(other.volume24hUsd).toBe(660);
    expect(other.fdvUsd).toBe(17_790_000);
    expect(other.liquidityUsd).toBe(54_000);
    // A token-level answer itemises no pairs.
    expect(other.pairs).toBe(0);

    // GeckoTerminal was asked for OTHER and not for TOKEN.
    const multi = fetch.calls.find((c) => c.includes('/tokens/multi/'))!;
    expect(multi).toContain(OTHER);
    expect(multi).not.toContain(TOKEN);
    expect(feed.status().sources.map((s) => [s.name, s.quoted])).toEqual([
      ['dexscreener', 1],
      ['geckoterminal', 1],
    ]);
    feed.stop();
  });

  it('asks the second source again on the next refresh, not once its quote goes stale', async () => {
    // A token last answered by the second source still holds a fresh quote
    // when the first source's turn comes round again. Filtering the second
    // source's work on "has a quote" left it unasked until that quote went
    // stale — a row moving every fifteen minutes on a thirty-second feed.
    let clock = 1_000_000;
    const fetch = fakeFetch((url) => {
      if (url.includes('/latest/dex/tokens/')) return { status: 200, body: { pairs: [] } };
      if (url.includes('/networks?page=')) {
        return { status: 200, body: { data: [{ id: 'robinhood', attributes: { name: 'Robinhood Chain' } }] } };
      }
      return {
        status: 200,
        body: { data: [{ attributes: { address: TOKEN, price_usd: '1', volume_usd: { h24: String(clock) } } }] },
      };
    });
    const feed = new MarketFeed({ fetch, now: () => clock });
    feed.follow([{ address: TOKEN, pool: POOL }]);
    await feed.refresh();
    expect(feed.quote(TOKEN)!.volume24hUsd).toBe(1_000_000);

    clock += 30_000;
    expect(await feed.refresh()).toBe(1);
    expect(feed.quote(TOKEN)!.volume24hUsd).toBe(1_030_000);
    feed.stop();
  });

  it('stops asking a source alone about a token the OTHER source answers', async () => {
    // The defect: `misses` was keyed by address, and any source answering
    // cleared it. So a token GeckoTerminal knows but DexScreener does not was
    // single-asked of DexScreener on every refresh, for ever — forty extra
    // requests every thirty seconds, which earns a 429, which backs the
    // source off, which leaves every row on the board reading `chain`.
    let clock = 1_000_000;
    const fetch = fakeFetch((url) => {
      if (url.includes('/latest/dex/tokens/')) return { status: 200, body: { pairs: [] } };
      if (url.includes('/networks?page=')) {
        return { status: 200, body: { data: [{ id: 'robinhood', attributes: { name: 'Robinhood Chain' } }] } };
      }
      return {
        status: 200,
        body: {
          data: [TOKEN, OTHER].map((address) => ({
            attributes: { address, price_usd: '1', volume_usd: { h24: '99' } },
          })),
        },
      };
    });
    const feed = new MarketFeed({ fetch, now: () => clock });
    feed.follow([{ address: TOKEN, pool: POOL }, { address: OTHER, pool: '' }]);

    // Two tokens, so a batch URL carries a comma and a single one does not.
    const singles = () =>
      fetch.calls.filter((c) => c.includes('/latest/dex/tokens/') && !c.includes(',')).length;

    await feed.refresh();
    expect(feed.quote(TOKEN)!.source).toBe('geckoterminal');
    expect(feed.quote(OTHER)!.source).toBe('geckoterminal');
    expect(singles()).toBe(2);

    // Every refresh for the next ten minutes: batched, never asked alone.
    for (let i = 0; i < 5; i++) {
      clock += 30_000;
      await feed.refresh();
    }
    expect(singles()).toBe(2);

    // Past the retry window each is worth one more ask — DexScreener may have
    // started listing it since.
    clock += MISS_RETRY_MS;
    await feed.refresh();
    expect(singles()).toBe(4);
    feed.stop();
  });

  it('backs off the source that refused, not the board', async () => {
    let clock = 1_000_000;
    const fetch = fakeFetch((url) => {
      if (url.includes('/latest/dex/tokens/')) return { status: 429, body: null };
      if (url.includes('/networks?page=')) {
        return { status: 200, body: { data: [{ id: 'robinhood', attributes: { name: 'Robinhood Chain' } }] } };
      }
      return {
        status: 200,
        body: { data: [{ attributes: { address: TOKEN, price_usd: '1', volume_usd: { h24: '99' } } }] },
      };
    });
    const feed = new MarketFeed({ fetch, now: () => clock, refreshMs: 30_000 });
    feed.follow([{ address: TOKEN, pool: POOL }]);
    await feed.refresh();
    // DexScreener refused; the row still got a live figure from the other.
    expect(feed.quote(TOKEN)!.source).toBe('geckoterminal');
    const status = feed.status();
    expect(status.sources[0].lastError).toMatch(/429/);
    expect(status.sources[0].backoffUntil).not.toBeNull();
    expect(status.sources[1].lastError).toBeNull();

    // Inside its backoff the refused source is not asked; the other still is.
    const before = fetch.calls.length;
    clock += 1_000;
    await feed.refresh();
    expect(fetch.calls.slice(before).some((c) => c.includes('/latest/dex/tokens/'))).toBe(false);
    feed.stop();
  });

  it('keeps the last quotes through a refusal and drops a quote once it is stale', async () => {
    let clock = 1_000_000;
    let status = 200;
    const fetch = fakeFetch(() => ({ status, body: { pairs: [pair()] } }));
    const lines: string[] = [];
    const feed = feedWith(dexscreener(), { fetch, now: () => clock, refreshMs: 30_000, log: (l: string) => lines.push(l) });
    feed.follow([{ address: TOKEN, pool: POOL }]);
    await feed.refresh();
    expect(feed.quote(TOKEN)).not.toBeNull();

    status = 429;
    clock += 30_000;
    await feed.refresh();
    expect(feed.quote(TOKEN)).not.toBeNull();
    expect(feed.status().lastError).toMatch(/429/);
    expect(feed.status().backoffUntil).not.toBeNull();
    expect(lines.some((l) => l.includes('rate limited'))).toBe(true);
    // Inside the backoff nothing is asked.
    const calls = fetch.calls.length;
    clock += 1_000;
    await feed.refresh();
    expect(fetch.calls.length).toBe(calls);

    // A quote that is no longer live is not shown as live.
    clock += STALE_MS + 1;
    expect(feed.quote(TOKEN)).toBeNull();
    expect(feed.status().quoted).toBe(0);

    // The next success clears the backoff.
    status = 200;
    await feed.refresh();
    expect(feed.quote(TOKEN)).not.toBeNull();
    expect(feed.status().lastError).toBeNull();
    expect(feed.status().backoffUntil).toBeNull();
    feed.stop();
  });

  it('does nothing when disabled, and ignores ether and malformed addresses', async () => {
    const fetch = fakeFetch(() => ({ status: 200, body: { pairs: [pair()] } }));
    const off = new MarketFeed({ fetch, enabled: false });
    off.follow([{ address: TOKEN, pool: POOL }]);
    expect(await off.refresh()).toBe(0);
    expect(fetch.calls).toHaveLength(0);
    expect(off.status().enabled).toBe(false);

    const on = new MarketFeed({ fetch });
    on.follow([
      { address: '0x0000000000000000000000000000000000000000', pool: '' },
      { address: 'not-an-address', pool: '' },
    ]);
    expect(await on.refresh()).toBe(0);
    expect(fetch.calls).toHaveLength(0);
    on.stop();
  });
});
