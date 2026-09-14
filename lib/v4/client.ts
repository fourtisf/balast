/**
 * viem clients for Robinhood Chain: a public one for reads, a wallet one
 * over the EIP-1193 provider the dialog connected.
 */

import { createPublicClient, createWalletClient, custom, defineChain, http, type Address, type PublicClient } from 'viem';
import { CHAIN, EXPLORER_URL, PUBLIC_RPC_URL } from '../chain';
import type { Eip1193Provider } from '../wallet';

export const robinhoodChain = defineChain({
  id: CHAIN.id,
  name: CHAIN.name,
  nativeCurrency: CHAIN.nativeCurrency,
  rpcUrls: { default: { http: [PUBLIC_RPC_URL] } },
  blockExplorers: { default: { name: 'Blockscout', url: EXPLORER_URL } },
});

let shared: PublicClient | null = null;

/** Reads go to the public RPC, wallet or no wallet. */
export function publicClient(): PublicClient {
  if (!shared) shared = createPublicClient({ chain: robinhoodChain, transport: http(PUBLIC_RPC_URL) });
  return shared;
}

/** Writes go through the wallet the person connected. */
export function walletClient(provider: Eip1193Provider, account: Address) {
  return createWalletClient({ chain: robinhoodChain, account, transport: custom(provider) });
}
