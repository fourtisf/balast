'use client';

import { createContext, useCallback, useContext, useMemo, useSyncExternalStore, type ReactNode } from 'react';
import { getProvider } from '@/lib/data';
import type { MarketSnapshot, Pool, Vault } from '@/lib/data/types';

const MarketContext = createContext<MarketSnapshot | null>(null);

export function MarketProvider({ children }: { children: ReactNode }) {
  const provider = getProvider();

  const subscribe = useCallback(
    (onChange: () => void) => provider.subscribe(() => onChange()),
    [provider],
  );
  const read = useCallback(() => provider.getSnapshot(), [provider]);

  // Server and client read the same deterministic first snapshot, so the tick
  // is the only thing that ever changes the numbers.
  const snapshot = useSyncExternalStore(subscribe, read, read);

  return <MarketContext.Provider value={snapshot}>{children}</MarketContext.Provider>;
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
