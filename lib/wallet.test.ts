import { describe, expect, it } from 'vitest';
import { CHAIN } from './chain';
import {
  CHAIN_ID_HEX,
  CHAIN_PARAMS,
  KNOWN_WALLETS,
  connectWallet,
  describeWalletError,
  ensureChain,
  type Eip1193Provider,
} from './wallet';

/** A fake wallet: method → answer, or a thrown error. Records every call. */
function provider(answers: Record<string, unknown | (() => never)>): Eip1193Provider & { calls: { method: string; params?: unknown[] }[] } {
  const calls: { method: string; params?: unknown[] }[] = [];
  return {
    calls,
    async request({ method, params }) {
      calls.push({ method, params });
      const answer = answers[method];
      if (typeof answer === 'function') return (answer as () => never)();
      return answer;
    },
  };
}
const refuse = (code: number, message = '') => () => {
  throw Object.assign(new Error(message), { code });
};

describe('chain parameters', () => {
  it('spell chainId 4663 in hex, with the chain the wallet would add', () => {
    expect(CHAIN_ID_HEX).toBe('0x1237');
    expect(CHAIN_PARAMS.chainId).toBe(CHAIN_ID_HEX);
    expect(CHAIN_PARAMS.chainName).toBe(CHAIN.name);
    expect(CHAIN_PARAMS.nativeCurrency.decimals).toBe(18);
    expect(CHAIN_PARAMS.rpcUrls[0]).toMatch(/^https:\/\//);
  });
});

describe('ensureChain', () => {
  it('switches when the wallet knows the chain', async () => {
    const p = provider({ wallet_switchEthereumChain: null });
    await ensureChain(p);
    expect(p.calls.map((c) => c.method)).toEqual(['wallet_switchEthereumChain']);
  });

  it('adds the chain when the wallet does not know it, then is on it', async () => {
    const p = provider({ wallet_switchEthereumChain: refuse(4902), wallet_addEthereumChain: null });
    await ensureChain(p);
    expect(p.calls.map((c) => c.method)).toEqual(['wallet_switchEthereumChain', 'wallet_addEthereumChain']);
    expect(p.calls[1].params).toEqual([CHAIN_PARAMS]);
  });

  it('recognises "unrecognized chain" said in words', async () => {
    const p = provider({ wallet_switchEthereumChain: refuse(-32603, 'Unrecognized chain ID'), wallet_addEthereumChain: null });
    await ensureChain(p);
    expect(p.calls.map((c) => c.method)).toContain('wallet_addEthereumChain');
  });

  it('treats a declined switch as staying connected, and anything else as an error', async () => {
    await expect(ensureChain(provider({ wallet_switchEthereumChain: refuse(4001) }))).resolves.toBeUndefined();
    await expect(ensureChain(provider({ wallet_switchEthereumChain: refuse(-32000, 'boom') }))).rejects.toThrow('boom');
  });
});

describe('connectWallet', () => {
  const info = { uuid: 'u', name: 'Fake', icon: 'data:image/svg+xml,', rdns: 'test.fake' };

  it('asks for accounts, then the chain, and returns the checksummed address', async () => {
    const p = provider({
      eth_requestAccounts: ['0x0bd7d308f8e1639fab988df18a8011f41eacad73'],
      wallet_switchEthereumChain: null,
    });
    expect(await connectWallet({ info, provider: p })).toBe('0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73');
    expect(p.calls.map((c) => c.method)).toEqual(['eth_requestAccounts', 'wallet_switchEthereumChain']);
  });

  it('refuses a wallet that returns no account', async () => {
    await expect(connectWallet({ info, provider: provider({ eth_requestAccounts: [] }) })).rejects.toThrow(/no account/);
  });
});

describe('KNOWN_WALLETS', () => {
  it('lists distinct wallets with https install links', () => {
    const rdns = KNOWN_WALLETS.map((w) => w.rdns);
    expect(new Set(rdns).size).toBe(rdns.length);
    for (const w of KNOWN_WALLETS) expect(w.install).toMatch(/^https:\/\//);
    expect(rdns).toContain('io.metamask');
  });
});

describe('describeWalletError', () => {
  it('puts the standard refusals into words', () => {
    expect(describeWalletError({ code: 4001 })).toMatch(/rejected/);
    expect(describeWalletError({ code: -32002 })).toMatch(/already has a request/);
    expect(describeWalletError(new Error('Nope'))).toBe('Nope');
    expect(describeWalletError(undefined)).toMatch(/did not answer/);
  });
});
