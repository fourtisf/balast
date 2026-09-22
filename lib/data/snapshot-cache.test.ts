import { beforeEach, describe, expect, it } from 'vitest';
import { SimProvider } from './sim-provider';
import { MAX_AGE_MS, SNAPSHOT_CACHE_KEY, resetStoreClock, restoreSnapshot, storeSnapshot } from './snapshot-cache';
import type { MarketSnapshot } from './types';

function memory() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    map,
  };
}

function snapshot(): MarketSnapshot {
  const s = new SimProvider().getSnapshot()!;
  return { ...s, indexerLagSeconds: 100, revision: 77, builtAt: new Date(1_000_000_000_000).toISOString() };
}

describe('the browser-side snapshot cache', () => {
  beforeEach(() => resetStoreClock());

  it('restores the board with its lag grown by the time it sat, and a revision anything beats', () => {
    const store = memory();
    const built = 1_000_000_000_000;
    expect(storeSnapshot(store, snapshot(), built + 5_000)).toBe(true);
    const back = restoreSnapshot(store, built + 65_000);
    expect(back).not.toBeNull();
    expect(back!.pools.length).toBe(snapshot().pools.length);
    // 100s of lag at build, plus the 65s since.
    expect(back!.indexerLagSeconds).toBeCloseTo(165, 6);
    expect(back!.revision).toBe(0);
  });

  it('keeps the shared board and not the wallet’s positions', () => {
    const store = memory();
    storeSnapshot(store, snapshot(), 1_000_000_000_000);
    const kept = JSON.parse(store.map.get(SNAPSHOT_CACHE_KEY)!).snapshot as MarketSnapshot;
    expect(kept.portfolio.positions).toEqual([]);
    expect(kept.portfolio.stakes).toEqual([]);
  });

  it('does not restore one that is too old, missing, malformed, or from the future', () => {
    const built = 1_000_000_000_000;
    const store = memory();
    storeSnapshot(store, snapshot(), built);
    expect(restoreSnapshot(store, built + MAX_AGE_MS + 1)).toBeNull();
    expect(restoreSnapshot(store, built - 1)).toBeNull();
    expect(restoreSnapshot(memory(), built)).toBeNull();
    const bad = memory();
    bad.setItem(SNAPSHOT_CACHE_KEY, '{not json');
    expect(restoreSnapshot(bad, built)).toBeNull();
    bad.setItem(SNAPSHOT_CACHE_KEY, JSON.stringify({ storedAt: built, snapshot: { pools: 'no' } }));
    expect(restoreSnapshot(bad, built)).toBeNull();
    expect(restoreSnapshot(null, built)).toBeNull();
  });

  it('writes at most once every ten seconds and never throws on a refusing store', () => {
    const store = memory();
    const t = 1_000_000_000_000;
    expect(storeSnapshot(store, snapshot(), t)).toBe(true);
    expect(storeSnapshot(store, snapshot(), t + 1_000)).toBe(false);
    expect(storeSnapshot(store, snapshot(), t + 11_000)).toBe(true);
    const refusing = { getItem: () => null, setItem: () => { throw new Error('QuotaExceededError'); } };
    resetStoreClock();
    expect(storeSnapshot(refusing, snapshot(), t)).toBe(false);
  });
});
