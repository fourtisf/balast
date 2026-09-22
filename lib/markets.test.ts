import { describe, expect, it } from 'vitest';
import { CONTRACTS, NATIVE_ETH } from './chain';
import type { Pool } from './data/types';
import { isMintable, orderMarkets, poolLiquidityUsd, quoteGroups } from './markets';

const TOKEN = '0x2222222222222222222222222222222222222222';
const USDG = '0x1111111111111111111111111111111111111111';

function pool(over: Partial<Pool> & { quoteSide?: string; keyed?: boolean }): Pool {
  const { quoteSide = NATIVE_ETH, keyed = true, ...rest } = over;
  return {
    id: `p-${quoteSide}-${rest.feeTierBps ?? 30}-${rest.tvlUsd ?? 0}`,
    address: '0xpool',
    token: { address: TOKEN, symbol: 'VIRTUAL', name: 'Virtual', decimals: 18, logoColor: 'var(--fg-3)' },
    quote: quoteSide.toLowerCase() === USDG ? 'USDG' : 'ETH',
    feeTierBps: 30,
    key: keyed
      ? { currency0: quoteSide, currency1: TOKEN, fee: 3000, tickSpacing: 60, hooks: NATIVE_ETH, decimals0: 18, decimals1: 18 }
      : undefined,
    protocol: keyed ? 'v4' : 'v3',
    stakeable: true,
    ageHours: 900,
    priceUsd: 1,
    marketCapUsd: 0,
    fdvUsd: 0,
    tvlUsd: 0,
    quoteTvlUsd: 0,
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
    feeYield: { basis: 'trailing7d', pct: 10 },
    spark: [],
    volumeSpark: [],
    ...rest,
  } as unknown as Pool;
}

describe('isMintable', () => {
  /**
   * Balast mints through Uniswap v4's PositionManager and deploys no contract
   * of its own (§20), so a v3 pool — no key — cannot be minted into here. It
   * used to be offered anyway, which put the builder in its simulated branch
   * on the live site: a stand-in balance and a Mint button that minted
   * nothing.
   */
  it('refuses a keyless pool on live data', () => {
    expect(isMintable(pool({ keyed: false }), true)).toBe(false);
    expect(isMintable(pool({ keyed: true }), true)).toBe(true);
  });

  it('keeps every simulated pool, which has no key by design', () => {
    expect(isMintable(pool({ keyed: false }), false)).toBe(true);
  });

  it('refuses an unverified hook whatever the data source (§20)', () => {
    expect(isMintable(pool({ stakeable: false }), true)).toBe(false);
    expect(isMintable(pool({ stakeable: false, keyed: false }), false)).toBe(false);
  });
});

describe('quoteGroups', () => {
  /**
   * CASHCAT on the live board had twelve markets — six in ether at 2%, 0.5%,
   * 0.46%, 0.66%, 0.96% and 3%, six more in USDG — and the builder showed
   * them as twelve near-identical pills. v4 lets a pool carry any fee its
   * key names, so those tiers are real; a row of them is still not a choice
   * anybody can make.
   */
  const cashcat = [
    pool({ quoteSide: NATIVE_ETH, feeTierBps: 200, tvlUsd: 4_000 }),
    pool({ quoteSide: NATIVE_ETH, feeTierBps: 50, tvlUsd: 900_000 }),
    pool({ quoteSide: NATIVE_ETH, feeTierBps: 46, tvlUsd: 2_500 }),
    pool({ quoteSide: USDG, feeTierBps: 83, tvlUsd: 120_000 }),
    pool({ quoteSide: USDG, feeTierBps: 200, tvlUsd: 3_000 }),
  ];

  it('asks the two questions separately: what you pay with, then which pool', () => {
    const groups = quoteGroups(cashcat);
    expect(groups.map((g) => g.label)).toEqual(['ETH', 'USDG']);
    expect(groups[0].markets).toHaveLength(3);
    expect(groups[1].markets).toHaveLength(2);
  });

  it('orders each currency deepest first, so the board\u2019s own pool leads', () => {
    const [eth, usdg] = quoteGroups(cashcat);
    expect(eth.markets.map((m) => m.tvlUsd)).toEqual([900_000, 4_000, 2_500]);
    expect(usdg.markets.map((m) => m.tvlUsd)).toEqual([120_000, 3_000]);
  });

  it('leads with ether, which is what a wallet on this chain holds (§27)', () => {
    // Even where the USDG side is deeper than every ether pool.
    const deepUsdg = [
      pool({ quoteSide: USDG, feeTierBps: 30, tvlUsd: 9_000_000 }),
      pool({ quoteSide: NATIVE_ETH, feeTierBps: 30, tvlUsd: 5_000 }),
    ];
    expect(quoteGroups(deepUsdg)[0].label).toBe('ETH');
    expect(orderMarkets(deepUsdg)[0].tvlUsd).toBe(5_000);
  });

  it('puts a native and a wrapped pool in one group, because both are ETH', () => {
    const groups = quoteGroups([
      pool({ quoteSide: CONTRACTS.weth, feeTierBps: 30, tvlUsd: 10_000 }),
      pool({ quoteSide: NATIVE_ETH, feeTierBps: 30, tvlUsd: 50_000 }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe('ETH');
    // Deepest first; the wrapper is not preferred or penalised for being one.
    expect(groups[0].markets[0].tvlUsd).toBe(50_000);
  });

  it('sorts an unknown depth last rather than treating it as empty (§14)', () => {
    const groups = quoteGroups([
      pool({ quoteSide: NATIVE_ETH, feeTierBps: 100, tvlUsd: 0 }),
      pool({ quoteSide: NATIVE_ETH, feeTierBps: 30, tvlUsd: 1 }),
    ]);
    expect(groups[0].markets.map((m) => m.feeTierBps)).toEqual([30, 100]);
    expect(poolLiquidityUsd(groups[0].markets[1])).toBeNull();
  });

  it('is a total order — the same set sorts the same whichever way it arrives', () => {
    const once = orderMarkets(cashcat).map((p) => p.id);
    const again = orderMarkets([...cashcat].reverse()).map((p) => p.id);
    expect(again).toEqual(once);
  });
});

describe('poolLiquidityUsd', () => {
  /**
   * Never the token's figure. An aggregator's token-wide liquidity is the
   * same number for every pool of that token, so ranking pools by it ranks
   * nothing — and it was the figure the board's own liquidity column falls
   * back to.
   */
  it('takes the chain\u2019s own figure for the pool', () => {
    expect(poolLiquidityUsd(pool({ tvlUsd: 1_234 }))).toBe(1_234);
  });

  /**
   * An aggregator's quote is fetched once per token and attached to every
   * pool of it, so neither of its liquidity fields describes one pool.
   * Reading `poolLiquidityUsd` off it put an identical $5.42M on four of
   * CASHCAT's six ether pools and ranked them above the one whose real
   * depth the chain knew.
   */
  it('never takes a figure from the token-wide quote, by either name', () => {
    const p = pool({ tvlUsd: 0 });
    (p as { market?: unknown }).market = { liquidityUsd: 5_420_000, poolLiquidityUsd: 5_420_000 };
    expect(poolLiquidityUsd(p)).toBeNull();
  });

  it('does not let that figure decide the order', () => {
    const shared = { liquidityUsd: 5_420_000, poolLiquidityUsd: 5_420_000 };
    const unknown = pool({ feeTierBps: 46, tvlUsd: 0 });
    const known = pool({ feeTierBps: 200, tvlUsd: 325_400 });
    (unknown as { market?: unknown }).market = shared;
    (known as { market?: unknown }).market = shared;
    expect(orderMarkets([unknown, known])[0]).toBe(known);
  });

  it('is null for an unreconstructable pool, not zero', () => {
    expect(poolLiquidityUsd(pool({ tvlUsd: 0 }))).toBeNull();
  });
});
