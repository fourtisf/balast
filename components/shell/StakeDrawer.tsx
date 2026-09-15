'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef } from 'react';
import { useMarket } from '@/components/providers/MarketProvider';
import { useUi } from '@/components/providers/UiProvider';
import { TokenBadge } from '@/components/ui/TokenBadge';
import { EXPLORER_URL, NATIVE_ETH, isEther } from '@/lib/chain';
import { ageLabel, usd } from '@/lib/format';
import { FEE_YIELD_LABEL, feeYieldQualifier, feeYieldTitle, feeYieldValue } from '@/lib/yield';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function StakeDrawer() {
  const { pools, global } = useMarket();
  const { stakePoolId, closeStake, showToast } = useUi();
  const router = useRouter();
  const drawerRef = useRef<HTMLElement | null>(null);
  const returnFocusTo = useRef<HTMLElement | null>(null);

  const pool = pools.find((p) => p.id === stakePoolId) ?? null;
  const open = pool !== null;

  // Escape closes, Tab cycles inside, focus returns where it came from.
  useEffect(() => {
    if (!open) return;
    returnFocusTo.current = document.activeElement as HTMLElement | null;
    const node = drawerRef.current;
    const first = node?.querySelector<HTMLElement>(FOCUSABLE);
    first?.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeStake();
        return;
      }
      if (e.key !== 'Tab' || !node) return;
      const items = Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null,
      );
      if (items.length === 0) return;
      const firstItem = items[0];
      const lastItem = items[items.length - 1];
      if (e.shiftKey && document.activeElement === firstItem) {
        e.preventDefault();
        lastItem.focus();
      } else if (!e.shiftKey && document.activeElement === lastItem) {
        e.preventDefault();
        firstItem.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      returnFocusTo.current?.focus();
    };
  }, [open, closeStake]);

  const ether = pool ? isEther(pool.token.address) : false;
  const hook = pool?.key?.hooks && pool.key.hooks.toLowerCase() !== NATIVE_ETH ? pool.key.hooks : null;
  const copyAddress = async () => {
    if (!pool) return;
    try {
      await navigator.clipboard.writeText(pool.token.address);
      showToast('Contract address copied');
    } catch {
      showToast('Could not copy — select the address instead');
    }
  };

  return (
    <>
      <div
        className={`overlay${open ? ' on' : ''}`}
        onClick={closeStake}
        aria-hidden="true"
      />
      <aside
        className={`drawer${open ? ' on' : ''}`}
        ref={drawerRef}
        role="dialog"
        aria-modal="true"
        aria-label={pool ? `Stake ${pool.token.symbol}` : 'Stake'}
        aria-hidden={!open}
      >
        {pool && (
          <>
            <div className="dr-h">
              <TokenBadge token={pool.token} />
              <div>
                <div style={{ fontWeight: 600, fontSize: 14 }}>{pool.token.symbol} / WETH</div>
                <div style={{ fontSize: 12 }} className="muted">
                  {pool.token.name}
                </div>
              </div>
              <button className="x" onClick={closeStake} aria-label="Close">
                ✕
              </button>
            </div>

            <div className="dr-b">
              <div className="kv">
                <div>
                  <div className="k">Fee yield</div>
                  <div
                    className={`v num${pool.feeYield.basis !== 'insufficient' ? ' up' : ' muted'}`}
                    title={feeYieldTitle(pool.feeYield)}
                  >
                    {feeYieldValue(pool.feeYield)}
                    {feeYieldQualifier(pool.feeYield, ageLabel(pool.ageHours)) && (
                      <span className="est">
                        {feeYieldQualifier(pool.feeYield, ageLabel(pool.ageHours))}
                      </span>
                    )}
                  </div>
                  <div className="k" style={{ marginTop: 6 }}>
                    {FEE_YIELD_LABEL}
                  </div>
                </div>
                <div>
                  <div className="k">Fees 24h</div>
                  <div className="v num">{usd(pool.fees24hUsd)}</div>
                  <div className="k" style={{ marginTop: 6 }}>
                    {(pool.feeTierBps / 100).toFixed(2).replace(/\.?0+$/, '')}% of every trade, paid to the pool
                  </div>
                </div>
                <div>
                  <div className="k">Pool liquidity</div>
                  <div className="v num">{pool.tvlUsd > 0 ? usd(pool.tvlUsd) : '—'}</div>
                </div>
                <div>
                  <div className="k">Volume 24h</div>
                  <div className="v num">{usd(pool.market ? pool.market.volume24hUsd : pool.volume24hUsd)}</div>
                  <div className="k" style={{ marginTop: 6 }}>
                    {pool.market
                      ? `${(pool.market.buys24h + pool.market.sells24h).toLocaleString()} trades · via DexScreener`
                      : `${pool.trades24h} trade${pool.trades24h === 1 ? '' : 's'}` +
                        (pool.market === null ? ' · from the chain' : '')}
                  </div>
                </div>
              </div>

              {/* The split a trader reads. Live from DexScreener when it has
                  a fresh quote — trades by side, since its feed does not
                  split the dollars — else from the indexed swaps, where a buy
                  pays the quote for the token and a sell the reverse. */}
              {pool.market ? (
                <div className="split" aria-label="Buys and sells in the last 24 hours, from DexScreener">
                  <div className="split-row">
                    <span>
                      <span className="k">Buys</span>{' '}
                      <b className="num">{pool.market.buys24h.toLocaleString()}</b>{' '}
                      <span className="muted">trades</span>
                    </span>
                    <span style={{ textAlign: 'right' }}>
                      <span className="k">Sells</span>{' '}
                      <b className="num">{pool.market.sells24h.toLocaleString()}</b>{' '}
                      <span className="muted">trades</span>
                    </span>
                  </div>
                  <div className="split-bar" aria-hidden="true">
                    <i
                      style={{
                        width: `${pool.market.buys24h + pool.market.sells24h > 0 ? (100 * pool.market.buys24h) / (pool.market.buys24h + pool.market.sells24h) : 0}%`,
                      }}
                    />
                  </div>
                  <p className="hint" style={{ marginTop: 8 }}>
                    Volume, trades and the 24h change here are DexScreener&rsquo;s live figures.
                    Liquidity, fees and yield are from the chain.
                  </p>
                </div>
              ) : (
                <div className="split" aria-label="Buys and sells in the last 24 hours">
                  <div className="split-row">
                    <span>
                      <span className="k">Buys</span>{' '}
                      <b className="num">{pool.buyVolume24hUsd + pool.sellVolume24hUsd > 0 || pool.volume24hUsd <= 0 ? usd(pool.buyVolume24hUsd) : '—'}</b>{' '}
                      <span className="muted num">· {pool.buys24h}</span>
                    </span>
                    <span style={{ textAlign: 'right' }}>
                      <span className="k">Sells</span>{' '}
                      <b className="num">{pool.buyVolume24hUsd + pool.sellVolume24hUsd > 0 || pool.volume24hUsd <= 0 ? usd(pool.sellVolume24hUsd) : '—'}</b>{' '}
                      <span className="muted num">· {pool.sells24h}</span>
                    </span>
                  </div>
                  <div className="split-bar" aria-hidden="true">
                    <i
                      style={{
                        width: `${pool.buyVolume24hUsd + pool.sellVolume24hUsd > 0 ? (100 * pool.buyVolume24hUsd) / (pool.buyVolume24hUsd + pool.sellVolume24hUsd) : 0}%`,
                      }}
                    />
                  </div>
                </div>
              )}

              <div className="sect-h" style={{ display: 'block', marginBottom: 8 }}>
                Contract address
              </div>
              {ether ? (
                <p className="hint">Ether is the chain&rsquo;s native asset: no contract.</p>
              ) : (
                <div className="ca">
                  <code className="num" title={pool.token.address}>
                    {pool.token.address}
                  </code>
                  <div className="ca-actions">
                    <button type="button" className="btn btn-ghost sm" onClick={copyAddress}>
                      Copy
                    </button>
                    <a
                      className="btn btn-ghost sm"
                      href={`${EXPLORER_URL}/token/${pool.token.address}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Explorer
                    </a>
                  </div>
                </div>
              )}

              {pool.stakeable ? (
                <>
                  <div className="sect-h" style={{ display: 'block', margin: '16px 0 8px' }}>
                    What a stake is
                  </div>
                  <p className="hint">
                    One full-range position in this pool, minted through Uniswap&rsquo;s
                    PositionManager straight to your wallet. Uniswap represents every liquidity
                    position as an NFT: the NFT <em>is</em> the position — its range, its liquidity
                    and the fees it has earned — and whoever holds it is the only one who can
                    withdraw. You do not need one to start: staking creates it. It earns this
                    pool&rsquo;s fee on every trade and is never out of range. You deposit both sides
                    at today&rsquo;s ratio — the builder shows exactly how much of each.
                  </p>
                  <div className="note">
                    {/* §7: the protocol fee is disclosed here, before signing. There is none:
                        nothing of Balast's stands between the position and its fees (§20). */}
                    <div className="disclose">
                      <span className="muted">Balast fee</span>
                      <b className="num">None · every fee is yours</b>
                    </div>
                    <div className="disclose">
                      <span className="muted">Custody</span>
                      <b>Your wallet, as an NFT</b>
                    </div>
                    <div className="disclose">
                      <span className="muted">Balast holds</span>
                      <b>Nothing</b>
                    </div>
                    <div className="disclose">
                      <span className="muted">Lockup</span>
                      <b>None</b>
                    </div>
                  </div>
                  <p className="hint" style={{ marginTop: 12 }}>
                    If the token drops, the value of your stake drops with it — fees soften that,
                    they don&rsquo;t remove it.
                  </p>
                </>
              ) : (
                <div className="note" style={{ marginTop: 16 }}>
                  <b>Not offered for staking</b>
                  <p className="hint">
                    {pool.token.launchpad
                      ? `${pool.token.symbol} is still on its ${pool.token.launchpad} curve, and pre-graduation liquidity cannot be staked until the pool graduates.`
                      : `This pool runs a hook${hook ? ` (${hook.slice(0, 6)}…${hook.slice(-4)})` : ''} that Balast has not verified. A hook can refuse liquidity, price it on its own curve, or take most of every trade as its fee — one on this chain takes about 98%. It is not offered until someone has looked.`}
                  </p>
                </div>
              )}
            </div>

            <div className="dr-f">
              <button
                className="btn btn-ghost"
                onClick={() => {
                  closeStake();
                  router.push(`/positions?pool=${encodeURIComponent(pool.id)}`);
                }}
              >
                Build custom
              </button>
              <button
                className="btn btn-brand"
                disabled={!pool.stakeable}
                onClick={() => {
                  // The real thing, through the builder's mint flow: full
                  // range, one position, dry-run by the node before the
                  // wallet is asked to sign (§20). It used to toast "Staked"
                  // and do nothing, which on mainnet is a lie.
                  closeStake();
                  router.push(`/positions?pool=${encodeURIComponent(pool.id)}&range=full`);
                }}
              >
                Stake full range
              </button>
            </div>
          </>
        )}
      </aside>
    </>
  );
}
