import { describe, expect, it } from 'vitest';
import { CONTRACTS, NATIVE_ETH } from './chain';
import type { Pool } from './data/types';
import { byEntryCurrency, isMintable } from './markets';

const TOKEN = '0x2222222222222222222222222222222222222222';

function pool(over: Partial<Pool> & { quoteSide?: string; keyed?: boolean }): Pool {
  const { quoteSide = NATIVE_ETH, keyed = true, ...rest } = over;
  return {
    id: `p-${quoteSide}-${rest.feeTierBps ?? 3000}-${rest.tvlUsd ?? 0}`,
    address: '0xpool',
    token: { address: TOKEN, symbol: 'VIRTUAL', name: 'Virtual', decimals: 18, logoColor: 'var(--fg-3)' },
    quote: 'ETH',
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

describe('byEntryCurrency', () => {
  /**
   * The pair is entered with this chain's own ether, not the wrapper: a
   * native market spends the balance the wallet already shows, a wrapped one
   * needs an ERC-20 first.
   */
  it('puts the native ether market in front of a deeper wrapped one', () => {
    const native = pool({ quoteSide: NATIVE_ETH, tvlUsd: 10_000 });
    const wrapped = pool({ quoteSide: CONTRACTS.weth, tvlUsd: 900_000 });
    expect([wrapped, native].sort(byEntryCurrency)[0]).toBe(native);
  });

  it('orders everything else by depth, then by the cheaper fee tier', () => {
    const shallow = pool({ quoteSide: CONTRACTS.weth, tvlUsd: 1_000 });
    const deep = pool({ quoteSide: CONTRACTS.weth, tvlUsd: 50_000 });
    expect([shallow, deep].sort(byEntryCurrency)[0]).toBe(deep);

    const cheap = pool({ quoteSide: CONTRACTS.weth, tvlUsd: 1_000, feeTierBps: 30 });
    const dear = pool({ quoteSide: CONTRACTS.weth, tvlUsd: 1_000, feeTierBps: 100 });
    expect([dear, cheap].sort(byEntryCurrency)[0]).toBe(cheap);
  });

  it('is a total order — sorting the same set twice gives the same answer', () => {
    const set = [
      pool({ quoteSide: CONTRACTS.weth, tvlUsd: 50_000 }),
      pool({ quoteSide: NATIVE_ETH, tvlUsd: 1_000 }),
      pool({ quoteSide: NATIVE_ETH, tvlUsd: 80_000 }),
      pool({ quoteSide: CONTRACTS.weth, tvlUsd: 3_000 }),
    ];
    const once = [...set].sort(byEntryCurrency).map((p) => p.id);
    const again = [...set].reverse().sort(byEntryCurrency).map((p) => p.id);
    expect(again).toEqual(once);
    // Both native markets lead, deepest first.
    expect(once.slice(0, 2)).toEqual([
      `p-${NATIVE_ETH}-3000-80000`,
      `p-${NATIVE_ETH}-3000-1000`,
    ]);
  });
});
