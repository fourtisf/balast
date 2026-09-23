/**
 * viem clients for Robinhood Chain: a public one for reads, a wallet one
 * over the EIP-1193 provider the dialog connected.
 */

import { createPublicClient, createWalletClient, custom, defineChain, fallback, http, type Address, type PublicClient, type Transport } from 'viem';
import { CHAIN, CONTRACTS, EXPLORER_URL, PUBLIC_RPC_URL, PUBLIC_RPC_URLS } from '../chain';
import type { Eip1193Provider } from '../wallet';

export const robinhoodChain = defineChain({
  id: CHAIN.id,
  name: CHAIN.name,
  nativeCurrency: CHAIN.nativeCurrency,
  rpcUrls: { default: { http: [PUBLIC_RPC_URL] } },
  blockExplorers: { default: { name: 'Blockscout', url: EXPLORER_URL } },
  // Multicall3 is at its canonical address on this chain (§2), so a page
  // can read every position's fees in one round trip.
  contracts: { multicall3: { address: CONTRACTS.multicall3 } },
});

/**
 * The free public endpoints, one after another: an endpoint that refuses
 * (a rate limit, a timeout, a CORS answer) hands the call to the next. On
 * free RPC a single endpoint refusing a busy browser is the normal failure,
 * and it used to read as "Pool unreadable".
 */
export function publicTransport(first?: Transport): Transport {
  const endpoints = PUBLIC_RPC_URLS.map((url) => http(url, { timeout: 10_000, retryCount: 1, retryDelay: 300 }));
  return fallback(first ? [first, ...endpoints] : endpoints, { rank: false, retryCount: 1 });
}

let shared: PublicClient | null = null;

/** Reads go to the public RPC, wallet or no wallet. */
export function publicClient(): PublicClient {
  if (!shared) shared = createPublicClient({ chain: robinhoodChain, transport: publicTransport() });
  return shared;
}

/** Writes go through the wallet the person connected. */
export function walletClient(provider: Eip1193Provider, account: Address) {
  return createWalletClient({ chain: robinhoodChain, account, transport: custom(provider) });
}
