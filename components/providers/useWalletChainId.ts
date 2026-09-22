'use client';

import { useCallback, useEffect, useState } from 'react';
import { currentChainId, onChainChanged, type Eip1193Provider } from '@/lib/wallet';

/**
 * The network the wallet is on, and every switch it makes afterwards.
 *
 * The dialog asks the wallet to switch on connect, but a person can decline
 * that and stay connected, or switch away later; a transaction sent from
 * another network would be refused by viem with a message nobody should
 * have to read. So every flow that sends something knows first, and says
 * so. Null until the wallet has answered, or when it will not.
 *
 * `refresh` re-reads on demand — after `ensureChain`, so a flow does not
 * have to wait for the wallet's own `chainChanged` to arrive.
 */
export function useWalletChainId(provider: Eip1193Provider | null): { chainId: number | null; refresh: () => Promise<number | null> } {
  const [chainId, setChainId] = useState<number | null>(null);

  useEffect(() => {
    setChainId(null);
    if (!provider) return;
    let cancelled = false;
    void currentChainId(provider).then((id) => {
      if (!cancelled) setChainId(id);
    });
    const stop = onChainChanged(provider, (id) => {
      if (!cancelled) setChainId(id);
    });
    return () => {
      cancelled = true;
      stop();
    };
  }, [provider]);

  const refresh = useCallback(async () => {
    if (!provider) return null;
    const id = await currentChainId(provider);
    setChainId(id);
    return id;
  }, [provider]);

  return { chainId, refresh };
}
