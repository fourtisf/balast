/**
 * Which source each figure on the board comes from (market-figures.ts).
 *
 * These are honesty rules, not formatting: a market cap from a two-month-old
 * price, a dash where a figure exists, a ranking that sorts on a number the
 * row does not show. Each case here is one the live board got wrong.
 */

import { describe, expect, it } from 'vitest';
import { NATIVE_ETH } from './chain';
import type { MarketQuote, Pool } from './data/types';
import { RANK_MIN_VOLUME_USD, capKey, rankByCap, rankByVolume, rankTier, shownCap, shownChange, shownLiquidity, shownSplit, shownVolume } from './market-figures';

function quote(overrides: Partial<MarketQuote> = {}): MarketQuote {
  return {
    source: 'dexscreener',
    chainId: 'robinhood',
    pairs: 3,
    dexId: 'uniswap',
    pairAddress: '0x1',
    url: '',
    priceUsd: 1,
    volume24hUsd: 21_018_000,
    buys24h: 928,
    sells24h: 785,
    priceChange24hPct: -3.8,
    liquidityUsd: 926_000,
    poolLiquidityUsd: 25_500,
    fdvUsd: 22_530_000,
    marketCapUsd: 22_920_000,
    at: new Date().toISOString(),
    ...overrides,
  };
}

function pool(overrides: Partial<Pool> = {}): Pool {
  return {
    id: 'p1',
    address: '0x9999',
    token: { address: '0x00000000000000000000000000000000000000a1', symbol: 'NVDA', name: 'NVIDIA', decimals: 18, logoColor: '#000' },
    quote: 'ETH',
    feeTierBps: 100,
    protocol: 'v4',
    stakeable: true,
    ageHours: 900,
    priceUsd: 1,
    marketCapUsd: 0,
    fdvUsd: 0,
    tvlUsd: 0,
    change24hPct: null,
    fees24hUsd: 0,
    feesWindowUsd: 0,
    feeWindowHours: 168,
    volume24hUsd: 0,
    trades24h: 0,
    buyVolume24hUsd: 0,
    sellVolume24hUsd: 0,
    buys24h: 0,
    sells24h: 0,
    feeHistory: [],
    volumeHistory: [],
    market: null,
    feeYield: { pct: 0, basis: 'full' },
    ...overrides,
  } as Pool;
}

describe('volume and change', () => {
  it("shows the token's summed day when a source has one, and says so", () => {
    const live = shownVolume(pool({ volume24hUsd: 17_900, market: quote() }));
    expect(live).toEqual({ value: 21_018_000, basis: 'live', scope: 'token' });
    const chain = shownVolume(pool({ volume24hUsd: 17_900 }));
    expect(chain).toEqual({ value: 17_900, basis: 'chain', scope: 'pool' });
  });

  it('takes the change from the same source as the volume beside it', () => {
    expect(shownChange(pool({ change24hPct: 40, market: quote() })).value).toBe(-3.8);
    expect(shownChange(pool({ change24hPct: 40 })).value).toBe(40);
    // No price a day ago is a dash, never a green +0.0% (§7).
    expect(shownChange(pool()).value).toBeNull();
  });
});

describe('market cap', () => {
  it("prefers the live figure: the chain's is a supply at the last indexed block's price", () => {
    const p = pool({ marketCapUsd: 9_000_000, fdvUsd: 9_000_000, market: quote() });
    expect(shownCap(p)).toEqual({ value: 22_920_000, kind: 'mc', basis: 'live', fdvBeside: null });
    // The FDV is only shown beside it when the two actually differ.
    const wide = pool({ market: quote({ marketCapUsd: 10_000_000, fdvUsd: 40_000_000 }) });
    expect(shownCap(wide).fdvBeside).toBe(40_000_000);
  });

  it('falls back to the chain, then to FDV, and labels which it is', () => {
    expect(shownCap(pool({ marketCapUsd: 9_000_000, fdvUsd: 12_000_000 }))).toEqual({
      value: 9_000_000,
      kind: 'mc',
      basis: 'chain',
      fdvBeside: 12_000_000,
    });
    // Holdings unread: the whole supply, labelled FDV rather than passed off
    // as a market cap, which would overstate every vesting token (§15).
    expect(shownCap(pool({ fdvUsd: 17_790_000 }))).toMatchObject({ value: 17_790_000, kind: 'fdv', basis: 'chain' });
    // A live source with only an FDV outranks the chain's stale one.
    expect(shownCap(pool({ marketCapUsd: 1, market: quote({ marketCapUsd: null, fdvUsd: 500 }) }))).toMatchObject({
      value: 500,
      kind: 'fdv',
      basis: 'live',
    });
    expect(shownCap(pool()).kind).toBe('none');
  });

  it('says ether is the native asset rather than showing it a cap', () => {
    const eth = pool({
      token: { address: NATIVE_ETH, symbol: 'ETH', name: 'Ether', decimals: 18, logoColor: '#000' },
      market: quote({ marketCapUsd: 5e11 }),
    });
    expect(shownCap(eth)).toEqual({ value: null, kind: 'native', basis: 'chain', fdvBeside: null });
  });

  it('ranks on exactly what the row shows, so the order cannot contradict it', () => {
    // Before this, the ranking read the chain's figure while the row showed
    // the live one, and the board sorted by a number nobody could see.
    const live = pool({ marketCapUsd: 1_000, market: quote({ marketCapUsd: 22_920_000 }) });
    const chain = pool({ marketCapUsd: 5_000_000 });
    expect(capKey(live)).toBe(22_920_000);
    expect(capKey(chain)).toBe(5_000_000);
    expect(capKey(pool())).toBe(0);
  });

  it('ranks a token nobody traded today after every token somebody did, whatever its cap', () => {
    // The live board at rank 9 to 15: seven launchpad tokens at an identical
    // "MC $38.88M" — a whole supply sitting at the curve's floor — with a
    // day's volume of $0 each, above tokens people were actually trading.
    const dead = pool({ id: 'dead', market: quote({ marketCapUsd: 38_880_000, volume24hUsd: 0 }) });
    const small = pool({ id: 'small', market: quote({ marketCapUsd: 2_000_000, volume24hUsd: 1_500 }) });
    const big = pool({ id: 'big', market: quote({ marketCapUsd: 9_000_000, volume24hUsd: 40_000 }) });
    const chainOnly = pool({ id: 'chain', marketCapUsd: 3_000_000, volume24hUsd: 10 });
    expect(rankByCap([dead, small, big, chainOnly]).map((p) => p.id)).toEqual(['big', 'chain', 'small', 'dead']);
    // And still on the board, last, rather than hidden.
    expect(rankByCap([dead])).toHaveLength(1);
  });

  it('ranks among the projects only a token with live volume over the bar today', () => {
    // Rank 3 on the live board was a $210M cap on $1.1K of volume — four
    // buys, four sells — and rank 5 an $81M cap on one dollar of chain
    // volume from a day weeks ago. Neither is a market somebody is in.
    const thin = pool({ id: 'thin', market: quote({ marketCapUsd: 210_000_000, volume24hUsd: 1_100 }) });
    const stale = pool({ id: 'stale', marketCapUsd: 81_000_000, volume24hUsd: 1 });
    const real = pool({ id: 'real', market: quote({ marketCapUsd: 39_000_000, volume24hUsd: 5_460_000 }) });
    const atBar = pool({ id: 'bar', market: quote({ marketCapUsd: 1_000_000, volume24hUsd: RANK_MIN_VOLUME_USD }) });
    expect(rankTier(real)).toBe(0);
    expect(rankTier(atBar)).toBe(0);
    expect(rankTier(thin)).toBe(1);
    expect(rankTier(stale)).toBe(1);
    expect(rankTier(pool())).toBe(2);
    expect(rankByCap([thin, stale, real, atBar]).map((p) => p.id)).toEqual(['real', 'bar', 'thin', 'stale']);
  });

  it('ranks live volume ahead of the chain’s, then by volume', () => {
    // A chain figure during a sync is a day weeks ago; a volume ranking
    // claims to show today, so the figures measured today come first.
    const chainBig = pool({ id: 'chain-big', volume24hUsd: 232_300 });
    const liveSmall = pool({ id: 'live-small', market: quote({ volume24hUsd: 1_100 }) });
    const liveBig = pool({ id: 'live-big', market: quote({ volume24hUsd: 20_730_000 }) });
    expect(rankByVolume([chainBig, liveSmall, liveBig]).map((p) => p.id)).toEqual(['live-big', 'live-small', 'chain-big']);
  });
});

describe('liquidity', () => {
  it("keeps the chain's figure when it has one: it is the pool the Stake button opens", () => {
    const p = pool({ tvlUsd: 25_500, market: quote({ poolLiquidityUsd: 99, liquidityUsd: 926_000 }) });
    expect(shownLiquidity(p)).toEqual({ value: 25_500, basis: 'chain', scope: 'pool' });
  });

  it('fills an unknown depth from the same pool first, then the token, and says which', () => {
    // Unknown depth (§14) is what half the board's dashes were.
    expect(shownLiquidity(pool({ market: quote() }))).toEqual({ value: 25_500, basis: 'live', scope: 'pool' });
    expect(shownLiquidity(pool({ market: quote({ poolLiquidityUsd: null }) }))).toEqual({
      value: 926_000,
      basis: 'live',
      scope: 'token',
    });
    // Nothing knows it: a dash, not a zero.
    expect(shownLiquidity(pool()).value).toBeNull();
    expect(shownLiquidity(pool({ market: quote({ poolLiquidityUsd: null, liquidityUsd: null }) })).value).toBeNull();
  });

  it('will not print a sub-dollar figure as $0, which reads as a measurement', () => {
    // The live board: `FDV $17.79M · liquidity $0`. usd() rounds to whole
    // dollars, so thirty-four cents became a hard zero beside an FDV in the
    // millions — a claim the source had not made (§14: unknown is a dash).
    expect(shownLiquidity(pool({ market: quote({ poolLiquidityUsd: 0.34, liquidityUsd: 0.4 }) })).value).toBeNull();
    expect(shownLiquidity(pool({ market: quote({ poolLiquidityUsd: 0, liquidityUsd: 0 }) })).value).toBeNull();
    // A dollar is a figure.
    expect(shownLiquidity(pool({ market: quote({ poolLiquidityUsd: 1 }) })).value).toBe(1);
  });
});

describe('the buy/sell split', () => {
  it('carries its unit, because one source splits trades and the other dollars', () => {
    expect(shownSplit(pool({ market: quote() }))).toEqual({
      buys: 928,
      sells: 785,
      unit: 'trades',
      basis: 'live',
      scope: 'token',
    });
    const chain = pool({ volume24hUsd: 100, buyVolume24hUsd: 60, sellVolume24hUsd: 40, buys24h: 6, sells24h: 4 });
    expect(shownSplit(chain)).toEqual({ buys: 60, sells: 40, unit: 'usd', basis: 'chain', scope: 'pool' });
  });

  it("falls back to the chain's dollars for a source that does not split, rather than a partial count", () => {
    const p = pool({
      volume24hUsd: 100,
      buyVolume24hUsd: 60,
      sellVolume24hUsd: 40,
      market: quote({ source: 'geckoterminal', buys24h: null, sells24h: null }),
    });
    expect(shownSplit(p)).toMatchObject({ buys: 60, unit: 'usd', basis: 'chain' });
  });

  it('is a dash when the hours are not split yet, not a $0 beside a volume', () => {
    // The columns arrived by migration and are filled by the next rebuild; a
    // $0 · $0 split beside $459.7K of volume was the board saying two things.
    expect(shownSplit(pool({ volume24hUsd: 459_700 }))).toBeNull();
    // A genuinely quiet day is $0 and $0, not a dash.
    expect(shownSplit(pool({ volume24hUsd: 0 }))).toMatchObject({ buys: 0, sells: 0, unit: 'usd' });
  });
});
