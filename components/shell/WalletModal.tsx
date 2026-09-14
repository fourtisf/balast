'use client';

import { useEffect, useRef, useState } from 'react';
import { useUi } from '@/components/providers/UiProvider';
import { EXPLORER_URL } from '@/lib/chain';
import { shortWallet } from '@/lib/format';
import {
  connectWallet,
  describeWalletError,
  discoverWallets,
  forgetWallet,
  rememberedWallet,
  silentAccount,
  type AnnouncedWallet,
} from '@/lib/wallet';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * The wallet dialog.
 *
 * Lists every wallet the browser announces (EIP-6963), connects to the one
 * chosen, and — once connected — shows the address with copy, explorer and
 * disconnect. A reload reconnects quietly to the remembered wallet if it
 * still exposes an account; nothing prompts without a click. Traps focus
 * and closes on Escape, like the stake drawer, because a dialog that asks
 * for a wallet is the last place to lose the keyboard.
 */
export function WalletModal() {
  const { walletOpen, closeWallet, wallet, setWallet, showToast } = useUi();
  const [wallets, setWallets] = useState<AnnouncedWallet[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dialog = useRef<HTMLDivElement | null>(null);
  const returnFocusTo = useRef<HTMLElement | null>(null);

  // Discover once, on the client, and keep listening: an extension can
  // announce itself after the page is up.
  useEffect(() => {
    const stop = discoverWallets((found) => {
      setWallets((prev) => (prev.some((w) => w.info.uuid === found.info.uuid) ? prev : [...prev, found]));
    });
    return stop;
  }, []);

  // Quiet reconnect to the remembered wallet, and follow its account changes.
  useEffect(() => {
    const rdns = rememberedWallet();
    if (!rdns || wallet) return;
    const found = wallets.find((w) => w.info.rdns === rdns);
    if (!found) return;
    let cancelled = false;
    void silentAccount(found).then((address) => {
      if (!cancelled && address) setWallet({ address, name: found.info.name, rdns });
    });
    return () => {
      cancelled = true;
    };
  }, [wallets, wallet, setWallet]);

  useEffect(() => {
    if (!wallet) return;
    const found = wallets.find((w) => w.info.rdns === wallet.rdns);
    if (!found?.provider.on || !found.provider.removeListener) return;
    const onAccounts = (payload: unknown) => {
      const next = Array.isArray(payload) && typeof payload[0] === 'string' ? (payload[0] as string) : null;
      if (!next) {
        forgetWallet();
        setWallet(null);
        showToast('Wallet disconnected');
      } else if (next.toLowerCase() !== wallet.address.toLowerCase()) {
        setWallet({ ...wallet, address: next });
      }
    };
    found.provider.on('accountsChanged', onAccounts);
    return () => found.provider.removeListener?.('accountsChanged', onAccounts);
  }, [wallet, wallets, setWallet, showToast]);

  // Escape closes, Tab cycles inside, focus returns where it came from.
  useEffect(() => {
    if (!walletOpen) return;
    returnFocusTo.current = document.activeElement as HTMLElement | null;
    const node = dialog.current;
    node?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeWallet();
        return;
      }
      if (e.key !== 'Tab' || !node) return;
      const items = Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.offsetParent !== null);
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      returnFocusTo.current?.focus();
    };
  }, [walletOpen, closeWallet]);

  if (!walletOpen) return null;

  const choose = async (candidate: AnnouncedWallet) => {
    setBusy(candidate.info.uuid);
    setError(null);
    try {
      const address = await connectWallet(candidate);
      setWallet({ address, name: candidate.info.name, rdns: candidate.info.rdns });
      showToast(`Connected to ${candidate.info.name}`);
      closeWallet();
    } catch (e) {
      setError(describeWalletError(e));
    } finally {
      setBusy(null);
    }
  };

  const disconnect = () => {
    forgetWallet();
    setWallet(null);
    showToast('Wallet disconnected');
    closeWallet();
  };

  const copy = async () => {
    if (!wallet) return;
    try {
      await navigator.clipboard.writeText(wallet.address);
      showToast('Address copied');
    } catch {
      showToast(wallet.address);
    }
  };

  return (
    <div className="modal-scrim" onClick={closeWallet} role="presentation">
      <div
        className="modal"
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="wallet-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-h">
          <h2 id="wallet-title">{wallet ? 'Your wallet' : 'Connect a wallet'}</h2>
          <button className="x" onClick={closeWallet} aria-label="Close">
            ✕
          </button>
        </div>

        {wallet ? (
          <>
            <p className="lede">Connected with {wallet.name}.</p>
            <div className="wallet-addr num" title={wallet.address}>
              {wallet.address}
            </div>
            <div className="row" style={{ marginTop: 14 }}>
              <button className="btn btn-ghost btn-sm" onClick={copy}>
                Copy
              </button>
              <a
                className="btn btn-ghost btn-sm"
                href={`${EXPLORER_URL}/address/${wallet.address}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                Explorer
              </a>
              <button className="btn btn-ghost btn-sm" onClick={disconnect}>
                Disconnect
              </button>
            </div>
            <p className="hint" style={{ marginTop: 14 }}>
              Nothing on this site asks you to sign yet. Staking and minting arrive with the
              contracts.
            </p>
          </>
        ) : (
          <>
            <p className="lede">
              Pick one of the wallets in this browser. Balast never takes custody: your
              positions stay in your wallet.
            </p>
            {wallets.length === 0 ? (
              <div className="wallet-empty">
                <b>No wallet extension found.</b> Install{' '}
                <a href="https://metamask.io/download/" target="_blank" rel="noopener noreferrer">
                  MetaMask
                </a>{' '}
                or{' '}
                <a href="https://rabby.io/" target="_blank" rel="noopener noreferrer">
                  Rabby
                </a>
                , then reload this page.
              </div>
            ) : (
              <div className="wallet-list">
                {wallets.map((w) => (
                  <button
                    key={w.info.uuid}
                    className="wallet-opt"
                    onClick={() => choose(w)}
                    disabled={busy !== null}
                  >
                    {/* The icon is the wallet's own, as a data: URI per the standard. */}
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={w.info.icon} alt="" />
                    <span>
                      <span className="n">{w.info.name}</span>
                      <span className="s">
                        {busy === w.info.uuid ? 'Waiting for the wallet…' : w.info.rdns}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            )}
            {error && (
              <p className="hint down" role="alert" style={{ marginTop: 12 }}>
                {error}
              </p>
            )}
            <p className="hint" style={{ marginTop: 14 }}>
              The wallet is asked to switch to Robinhood Chain, and to add it if it has never seen
              it. Nothing is signed.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
