/**
 * The DexScreener market feed (market.ts): parsing its documented answer,
 * choosing a pair, keeping the last quotes through a refusal, and dropping a
 * quote that is no longer live. No database; a fake fetch answers.
 */

import { describe, expect, it } from 'vitest';
import { MarketFeed, STALE_MS, choosePair, parsePairs } from './market';
import type { Fetch } from '../indexer/logo-sources';

const TOKEN = '0x00000000000000000000000000000000000000a1';
const OTHER = '0x00000000000000000000000000000000000000b2';
const POOL = '0x0000000000000000000000000000000000009999';

function pair(overrides: Record<string, unknown> = {}) {
  return {
    chainId: 'robinhoodchain',
    dexId: 'uniswap',
    url: 'https://dexscreener.com/robinhoodchain/0x9999',
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

function fakeFetch(answer: () => { status: number; body: unknown }): Fetch & { calls: string[] } {
  const calls: string[] = [];
  const f = (async (url: string) => {
    calls.push(url);
    const { status, body } = answer();
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

describe('parsing', () => {
  it('reads the documented shape, strings and numbers alike', () => {
    const [p] = parsePairs({ schemaVersion: '1.0.0', pairs: [pair()] });
    expect(p.chainId).toBe('robinhoodchain');
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
    const [p] = parsePairs({ pairs: [pair({ volume: undefined, txns: undefined, priceChange: { h24: 'n/a' }, priceUsd: null })] });
    expect(p.volume24hUsd).toBe(0);
    expect(p.buys24h).toBe(0);
    expect(p.priceChange24hPct).toBeNull();
    expect(p.priceUsd).toBeNull();
  });
});

describe('choosing a pair', () => {
  it('takes the pool on the row when DexScreener has it, else the deepest', () => {
    const pairs = parsePairs({
      pairs: [
        pair({ pairAddress: '0x1', liquidity: { usd: 900_000 }, volume: { h24: 1 } }),
        pair({ pairAddress: POOL, liquidity: { usd: 10_000 }, volume: { h24: 2 } }),
        pair({ pairAddress: '0x3', liquidity: { usd: 500 }, volume: { h24: 99999 } }),
      ],
    });
    expect(choosePair(pairs, TOKEN, POOL, null)!.pairAddress).toBe(POOL);
    expect(choosePair(pairs, TOKEN, '0xnotlisted', null)!.pairAddress).toBe('0x1');
  });

  it('only counts pairs where the token is the base, and only on the configured chain', () => {
    const pairs = parsePairs({
      pairs: [
        pair({ pairAddress: '0x1', chainId: 'ethereum', liquidity: { usd: 9e9 } }),
        pair({ pairAddress: '0x2', chainId: 'robinhoodchain', liquidity: { usd: 5 } }),
        pair({ pairAddress: '0x3', baseToken: { address: OTHER }, quoteToken: { address: TOKEN }, liquidity: { usd: 9e9 } }),
      ],
    });
    // 0x3 is the deepest by far, and TOKEN is only its quote: never chosen for TOKEN.
    expect(choosePair(pairs, TOKEN, '', 'robinhoodchain')!.pairAddress).toBe('0x2');
    expect(choosePair(pairs, TOKEN, '', null)!.pairAddress).toBe('0x1');
    expect(choosePair(pairs, OTHER, '', null)!.pairAddress).toBe('0x3');
    expect(choosePair(pairs, OTHER, '', 'ethereum')).toBeNull();
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
    const feed = new MarketFeed({ fetch, now: () => clock, onUpdate: () => updates.push(clock) });
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
    expect(updates).toEqual([first]);

    const status = feed.status();
    expect(status.followed).toBe(36);
    expect(status.quoted).toBe(1);
    expect(status.chains).toEqual(['robinhoodchain']);
    expect(status.lastError).toBeNull();

    // The same answer again changes nothing and wakes nobody.
    expect(await feed.refresh()).toBe(0);
    expect(updates).toHaveLength(1);
    feed.stop();
  });

  it('quotes a token that a long batch starved, by asking for it alone', async () => {
    // The box: 32 of 76 quoted, no error, and a token DexScreener plainly
    // lists left unquoted. A fake that answers pairs only for the first
    // three tokens of any multi-token request, and everything for a single.
    const fetch = fakeFetch(() => ({ status: 200, body: null }));
    const capped = (async (url: string) => {
      fetch.calls.push(url);
      const asked = url.split('/').pop()!.split(',');
      const answered = asked.length > 1 ? asked.slice(0, 3) : asked;
      const pairs = answered.map((address, i) => pair({ baseToken: { address }, pairAddress: `0xp${address.slice(-4)}${i}` }));
      return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({ pairs }) };
    }) as unknown as Fetch;
    const feed = new MarketFeed({ fetch: capped });
    const tokens = Array.from({ length: 8 }, (_, i) => ({ address: `0x${(i + 1).toString(16).padStart(40, '0')}`, pool: '' }));
    feed.follow(tokens);
    await feed.refresh();
    for (const t of tokens) expect(feed.quote(t.address)).not.toBeNull();
    expect(feed.status().quoted).toBe(8);
    expect(feed.status().unknown).toBe(0);
    // One batch, then the five it starved, alone.
    expect(fetch.calls).toHaveLength(1 + 5);
    feed.stop();
  });

  it('keeps the last quotes through a refusal and backs off, and drops a quote once it is stale', async () => {
    let clock = 1_000_000;
    let status = 200;
    const fetch = fakeFetch(() => ({ status, body: { pairs: [pair()] } }));
    const lines: string[] = [];
    const feed = new MarketFeed({ fetch, now: () => clock, refreshMs: 30_000, log: (l) => lines.push(l) });
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
