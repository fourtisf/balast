'use client';

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

interface UiState {
  query: string;
  setQuery: (q: string) => void;
  wallet: string | null;
  connect: () => void;
  toast: string | null;
  showToast: (message: string) => void;
  stakePoolId: string | null;
  openStake: (poolId: string) => void;
  closeStake: () => void;
}

const UiContext = createContext<UiState | null>(null);

export function UiProvider({ children }: { children: ReactNode }) {
  const [query, setQuery] = useState('');
  const [wallet, setWallet] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [stakePoolId, setStakePoolId] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = useCallback((message: string) => {
    setToast(message);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2200);
  }, []);

  // P0 has no wallet connector; the address is a placeholder until P2.
  const connect = useCallback(() => {
    setWallet('0x3F8A…C21D');
    showToast('Wallet connected');
  }, [showToast]);

  const value = useMemo<UiState>(
    () => ({
      query,
      setQuery,
      wallet,
      connect,
      toast,
      showToast,
      stakePoolId,
      openStake: setStakePoolId,
      closeStake: () => setStakePoolId(null),
    }),
    [query, wallet, connect, toast, showToast, stakePoolId],
  );

  return <UiContext.Provider value={value}>{children}</UiContext.Provider>;
}

export function useUi(): UiState {
  const ctx = useContext(UiContext);
  if (!ctx) throw new Error('useUi must be used inside <UiProvider>');
  return ctx;
}
