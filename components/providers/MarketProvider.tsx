'use client';

import { createContext, useCallback, useContext, useMemo, useSyncExternalStore, type ReactNode } from 'react';
import { DATA_SOURCE, getProvider } from '@/lib/data';
import type { MarketSnapshot, Pool, Vault } from '@/lib/data/types';

const MarketContext = createContext<MarketSnapshot | null>(null);

/**
 * The bridge between the DataProvider and the tree.
 *
 * `getSnapshot()` has always been allowed to return null — "null if none has
 * arrived yet (live, pre-connect)", in the interface P0 shipped. SimProvider
 * is synchronous so it never did; the live provider is a fetch and a socket,
 * so it does, on every first paint and whenever the indexer has not written a
 * block yet.
 *
 * That case gets its own state rather than zeros. A page of zeroed cards is
 * indistinguishable from a chain where nothing is happening, and §7 does not
 * allow the site to be ambiguous about whether a number is real.
 */
export function MarketProvider({ children }: { children: ReactNode }) {
  const provider = getProvider();

  const subscribe = useCallback(
    (onChange: () => void) => provider.subscribe(() => onChange()),
    [provider],
  );
  const read = useCallback(() => provider.getSnapshot(), [provider]);

  // Server and client read the same first snapshot — the simulator's
  // deterministic one, or null for live — so the tick is the only thing that
  // ever changes the numbers.
  const snapshot = useSyncExternalStore(subscribe, read, read);

  if (!snapshot) return <AwaitingIndexer />;

  return <MarketContext.Provider value={snapshot}>{children}</MarketContext.Provider>;
}

/**
 * Shown while the live provider has nothing to render: either the first fetch
 * is still in flight, or the indexer has not written its first block.
 *
 * It says which, and it does not draw a single figure.
 */
function AwaitingIndexer() {
  return (
    <div className="awaiting" role="status">
      <div className="aw-in">
        <span className="eyebrow">
          {DATA_SOURCE === 'live' ? 'Waiting for the indexer' : 'Loading'}
        </span>
        <p>
          No indexed blocks yet, so there is nothing honest to show. The boards
          appear as soon as the first swap is attributed — no placeholder
          numbers in the meantime.
        </p>
      </div>
    </div>
  );
}

export function useMarket(): MarketSnapshot {
  const snapshot = useContext(MarketContext);
  if (!snapshot) {
    throw new Error('useMarket must be used inside <MarketProvider>');
  }
  return snapshot;
}

export function usePools(): Pool[] {
  return useMarket().pools;
}

export function usePool(poolId: string | null): Pool | undefined {
  const pools = usePools();
  return useMemo(() => pools.find((p) => p.id === poolId), [pools, poolId]);
}

export function useVaults(): Vault[] {
  return useMarket().vaults;
}
