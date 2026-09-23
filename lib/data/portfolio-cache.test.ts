import { describe, expect, it } from 'vitest';
import { MAX_AGE_MS, restorePortfolio, storePortfolio } from './portfolio-cache';
import type { Portfolio } from './types';

function memory() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
}

const WALLET = '0x90cB000000000000000000000000000000000dAC';
const portfolio = (over: Partial<Portfolio> = {}): Portfolio =>
  ({
    netValueUsd: 27.2,
    netChangeUsd: 0,
    netChangePct: 0,
    feesEarnedWeth: null,
    feesEarnedUsd: null,
    priceImpactUsd: 0,
    fees7dUsd: null,
    dailyFeesWeth: [],
    stakes: [],
    positions: [{ tokenId: '1285056' }],
    claimableWeth: 0,
    wallet: WALLET.toLowerCase(),
    ...over,
  }) as unknown as Portfolio;

describe('the portfolio kept across a reload', () => {
  it('comes back for the same wallet, marked as kept with when', () => {
    const store = memory();
    storePortfolio(store, WALLET, portfolio(), 1_000);
    const back = restorePortfolio(store, WALLET.toLowerCase(), 5_000)!;
    expect(back.positions).toHaveLength(1);
    expect(back.status).toBe('kept');
    expect(back.keptAt).toBe(new Date(1_000).toISOString());
  });

  it('is not another wallet’s, and is not restored once too old', () => {
    const store = memory();
    storePortfolio(store, WALLET, portfolio(), 1_000);
    expect(restorePortfolio(store, '0x0000000000000000000000000000000000000001', 2_000)).toBeNull();
    expect(restorePortfolio(store, WALLET, 1_000 + MAX_AGE_MS + 1)).toBeNull();
  });

  it('does not store what was said about a read, only the read', () => {
    const store = memory();
    storePortfolio(store, WALLET, portfolio({ status: 'kept', keptAt: 'x' }), 1_000);
    const back = restorePortfolio(store, WALLET, 2_000)!;
    expect(back.keptAt).toBe(new Date(1_000).toISOString());
  });

  it('treats a missing or broken store as nothing kept', () => {
    expect(restorePortfolio(null, WALLET)).toBeNull();
    expect(restorePortfolio({ getItem: () => '{not json', setItem: () => undefined }, WALLET)).toBeNull();
  });
});
