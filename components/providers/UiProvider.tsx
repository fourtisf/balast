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

export interface ConnectedWallet {
  /** Checksummed. */
  address: string;
  /** The wallet's own name, e.g. MetaMask. */
  name: string;
  /** EIP-6963 reverse-DNS id, for the quiet reconnect on reload. */
  rdns: string;
}

interface UiState {
  query: string;
  setQuery: (q: string) => void;
  wallet: ConnectedWallet | null;
  setWallet: (wallet: ConnectedWallet | null) => void;
  walletOpen: boolean;
  openWallet: () => void;
  closeWallet: () => void;
  toast: string | null;
  showToast: (message: string) => void;
  stakePoolId: string | null;
  openStake: (poolId: string) => void;
  closeStake: () => void;
}

const UiContext = createContext<UiState | null>(null);

export function UiProvider({ children }: { children: ReactNode }) {
  const [query, setQuery] = useState('');
  const [wallet, setWallet] = useState<ConnectedWallet | null>(null);
  const [walletOpen, setWalletOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [stakePoolId, setStakePoolId] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = useCallback((message: string) => {
    setToast(message);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2200);
  }, []);

  const value = useMemo<UiState>(
    () => ({
      query,
      setQuery,
      wallet,
      setWallet,
      walletOpen,
      openWallet: () => setWalletOpen(true),
      closeWallet: () => setWalletOpen(false),
      toast,
      showToast,
      stakePoolId,
      openStake: setStakePoolId,
      closeStake: () => setStakePoolId(null),
    }),
    [query, wallet, walletOpen, toast, showToast, stakePoolId],
  );

  return <UiContext.Provider value={value}>{children}</UiContext.Provider>;
}

export function useUi(): UiState {
  const ctx = useContext(UiContext);
  if (!ctx) throw new Error('useUi must be used inside <UiProvider>');
  return ctx;
}
