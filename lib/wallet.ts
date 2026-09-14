/**
 * Connecting a browser wallet, without a wallet library.
 *
 * EIP-6963: every installed wallet extension announces itself with a name,
 * an icon and a provider the moment a page asks, so the "which wallet"
 * dialog lists what the person actually has — MetaMask, Rabby, Coinbase
 * Wallet, whichever — rather than one hard-coded button that grabs
 * `window.ethereum` and hopes. EIP-1193 does the rest: one request for
 * accounts, one to switch to Robinhood Chain, one to add it if the wallet
 * has never heard of it.
 *
 * This is the connection only. Nothing here signs a transaction; the
 * contracts that would want one are P2.
 */

import { getAddress } from 'viem';
import { CHAIN, EXPLORER_URL, PUBLIC_RPC_URL } from './chain';

export interface WalletInfo {
  uuid: string;
  name: string;
  /** A data: URI, per the standard. */
  icon: string;
  /** Reverse-DNS id, e.g. io.metamask — stable across sessions. */
  rdns: string;
}

export interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on?(event: string, handler: (payload: unknown) => void): void;
  removeListener?(event: string, handler: (payload: unknown) => void): void;
}

export interface AnnouncedWallet {
  info: WalletInfo;
  provider: Eip1193Provider;
}

export const CHAIN_ID_HEX = `0x${CHAIN.id.toString(16)}`;

/** What `wallet_addEthereumChain` needs, for a wallet that has never seen this chain. */
export const CHAIN_PARAMS = {
  chainId: CHAIN_ID_HEX,
  chainName: CHAIN.name,
  nativeCurrency: CHAIN.nativeCurrency,
  rpcUrls: [PUBLIC_RPC_URL],
  blockExplorerUrls: [EXPLORER_URL],
} as const;

/** Where the last connection is remembered, so a reload reconnects quietly. */
export const REMEMBERED_WALLET_KEY = 'balast:wallet';

/**
 * The wallets the dialog always lists, installed or not. An installed one
 * announces itself (EIP-6963) under this rdns and gets a Connect; the rest
 * get an Install link. Any wallet that announces itself and is not on this
 * list is shown too — the list is a floor, not a filter.
 */
export const KNOWN_WALLETS = [
  { name: 'MetaMask', rdns: 'io.metamask', install: 'https://metamask.io/download/' },
  { name: 'Rabby', rdns: 'io.rabby', install: 'https://rabby.io/' },
  { name: 'Coinbase Wallet', rdns: 'com.coinbase.wallet', install: 'https://www.coinbase.com/wallet/downloads' },
  { name: 'Phantom', rdns: 'app.phantom', install: 'https://phantom.com/download' },
  { name: 'OKX Wallet', rdns: 'com.okex.wallet', install: 'https://www.okx.com/web3' },
  { name: 'Trust Wallet', rdns: 'com.trustwallet.app', install: 'https://trustwallet.com/download' },
  { name: 'Brave Wallet', rdns: 'com.brave.wallet', install: 'https://brave.com/wallet/' },
] as const;

/** The rdns the dialog uses for a WalletConnect session. */
export const WALLETCONNECT_RDNS = 'walletconnect';

/**
 * WalletConnect needs a project id from cloud.reown.com (free). Inlined at
 * build time; without it the phone option is not offered rather than
 * offered and broken.
 */
export const WALLETCONNECT_PROJECT_ID = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? '';

/** WalletConnect's provider, loaded only when asked for: it is a large one. */
async function walletConnectProvider(): Promise<Eip1193Provider & { accounts: string[]; session?: unknown; connect(): Promise<void>; disconnect(): Promise<void> }> {
  const { EthereumProvider } = await import('@walletconnect/ethereum-provider');
  const provider = await EthereumProvider.init({
    projectId: WALLETCONNECT_PROJECT_ID,
    // Optional rather than required: a wallet that has never heard of this
    // chain can still open a session, and ensureChain() adds it after.
    optionalChains: [CHAIN.id],
    rpcMap: { [CHAIN.id]: PUBLIC_RPC_URL },
    showQrModal: true,
    metadata: {
      name: 'Balast',
      description: 'Liquidity layer for Robinhood Chain',
      url: typeof window !== 'undefined' ? window.location.origin : 'https://balast.xyz',
      icons: [`${typeof window !== 'undefined' ? window.location.origin : 'https://balast.xyz'}/icon.svg`],
    },
  });
  return provider as unknown as Eip1193Provider & {
    accounts: string[];
    session?: unknown;
    connect(): Promise<void>;
    disconnect(): Promise<void>;
  };
}

/** Open the QR modal and wait for a phone. Returns the announced-wallet shape the dialog uses. */
export async function connectWalletConnect(): Promise<AnnouncedWallet> {
  if (!WALLETCONNECT_PROJECT_ID) throw new Error('WalletConnect is not configured on this site.');
  const provider = await walletConnectProvider();
  await provider.connect();
  return {
    info: { uuid: WALLETCONNECT_RDNS, name: 'WalletConnect', icon: '', rdns: WALLETCONNECT_RDNS },
    provider,
  };
}

/** A WalletConnect session that survived a reload, with no QR shown. */
export async function restoreWalletConnect(): Promise<AnnouncedWallet | null> {
  if (!WALLETCONNECT_PROJECT_ID) return null;
  try {
    const provider = await walletConnectProvider();
    if (!provider.session || !provider.accounts?.[0]) return null;
    return {
      info: { uuid: WALLETCONNECT_RDNS, name: 'WalletConnect', icon: '', rdns: WALLETCONNECT_RDNS },
      provider,
    };
  } catch {
    return null;
  }
}

/**
 * Ask every installed wallet to announce itself. `onFound` is called once
 * per wallet, possibly immediately; the returned function stops listening.
 */
export function discoverWallets(onFound: (wallet: AnnouncedWallet) => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const seen = new Set<string>();
  const handler = (event: Event) => {
    const detail = (event as CustomEvent<AnnouncedWallet>).detail;
    if (!detail?.info?.uuid || !detail.provider || seen.has(detail.info.uuid)) return;
    seen.add(detail.info.uuid);
    onFound(detail);
  };
  window.addEventListener('eip6963:announceProvider', handler);
  window.dispatchEvent(new Event('eip6963:requestProvider'));
  return () => window.removeEventListener('eip6963:announceProvider', handler);
}

function errorCode(error: unknown): number | null {
  const code = (error as { code?: unknown })?.code;
  return typeof code === 'number' ? code : null;
}

/** The wallet's own words for a refusal, in ours. */
export function describeWalletError(error: unknown): string {
  if (errorCode(error) === 4001) return 'Request rejected in the wallet.';
  if (errorCode(error) === -32002) return 'The wallet already has a request open — look for its window.';
  const message = (error as { message?: unknown })?.message;
  return typeof message === 'string' && message.trim() !== '' ? message : 'The wallet did not answer.';
}

/**
 * Put the wallet on Robinhood Chain: switch, or add and switch. A person
 * declining the switch stays connected on whatever chain they were on —
 * nothing on the site sends a transaction yet, so that is not an error.
 */
export async function ensureChain(provider: Eip1193Provider): Promise<void> {
  try {
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: CHAIN_ID_HEX }] });
  } catch (error) {
    const code = errorCode(error);
    if (code === 4001) return;
    // 4902 is "unrecognized chain" in MetaMask's numbering; some wallets say
    // it in words instead.
    const unknownChain = code === 4902 || /unrecognized|not added|unknown chain|4902/i.test(String((error as Error)?.message ?? ''));
    if (!unknownChain) throw error;
    try {
      await provider.request({ method: 'wallet_addEthereumChain', params: [CHAIN_PARAMS] });
    } catch (addError) {
      if (errorCode(addError) === 4001) return;
      throw addError;
    }
  }
}

/** Connect: ask for an account, then for the chain. Returns the checksummed address. */
export async function connectWallet(wallet: AnnouncedWallet): Promise<string> {
  // A WalletConnect session already has its accounts; asking again would
  // open a second prompt on the phone.
  const alreadyConnected = (wallet.provider as { accounts?: string[] }).accounts;
  const accounts =
    wallet.info.rdns === WALLETCONNECT_RDNS && Array.isArray(alreadyConnected) && alreadyConnected.length > 0
      ? alreadyConnected
      : ((await wallet.provider.request({ method: 'eth_requestAccounts' })) as unknown);
  const first = Array.isArray(accounts) ? accounts[0] : undefined;
  if (typeof first !== 'string' || first === '') throw new Error('The wallet returned no account.');
  await ensureChain(wallet.provider);
  try {
    localStorage.setItem(REMEMBERED_WALLET_KEY, wallet.info.rdns);
  } catch {
    /* private mode: the reconnect is a convenience */
  }
  return getAddress(first);
}

/**
 * The account a remembered wallet already exposes, with no prompt. Null when
 * nothing is remembered or the wallet no longer exposes an account.
 */
export async function silentAccount(wallet: AnnouncedWallet): Promise<string | null> {
  try {
    const accounts = (await wallet.provider.request({ method: 'eth_accounts' })) as unknown;
    const first = Array.isArray(accounts) ? accounts[0] : undefined;
    return typeof first === 'string' && first !== '' ? getAddress(first) : null;
  } catch {
    return null;
  }
}

export function rememberedWallet(): string | null {
  try {
    return localStorage.getItem(REMEMBERED_WALLET_KEY);
  } catch {
    return null;
  }
}

export function forgetWallet(): void {
  try {
    localStorage.removeItem(REMEMBERED_WALLET_KEY);
  } catch {
    /* nothing to forget */
  }
}
