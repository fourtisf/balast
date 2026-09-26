'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef } from 'react';
import { useMarket } from '@/components/providers/MarketProvider';
import { useUi } from '@/components/providers/UiProvider';
import { AskPanel } from '@/components/ask/AskPanel';
import { TokenBadge } from '@/components/ui/TokenBadge';
import { EXPLORER_URL, NATIVE_ETH, isEther } from '@/lib/chain';
import { DATA_SOURCE } from '@/lib/data';
import { ageLabel, feeTierLabel, quoteLabel, usd } from '@/lib/format';
import { isMintable, orderMarkets } from '@/lib/markets';
import {
  buyShare,
  shownLiquidity,
  shownSplit,
  shownVolume,
  shownYield,
  sourceName,
  stalenessText,
  yieldCaption,
  yieldLabel,
  yieldTitle,
  yieldValue,
} from '@/lib/market-figures';
import { FEE_YIELD_LABEL, feeYieldQualifier, feeYieldTitle, feeYieldValue } from '@/lib/yield';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function StakeDrawer() {
  const { pools, otherPools, global, indexerLagSeconds } = useMarket();
  const { stakePoolId, closeStake, showToast } = useUi();
  const router = useRouter();
  const drawerRef = useRef<HTMLElement | null>(null);
  const returnFocusTo = useRef<HTMLElement | null>(null);

  const pool = pools.find((p) => p.id === stakePoolId) ?? null;
  const open = pool !== null;

  /**
   * Which market the Stake button actually opens.
   *
   * The row's pool is the token's deepest (§20), and the deepest can be a
   * pool running a hook Balast has not verified, which is not offered (§20).
   * The token's other markets ride beside the board (§26), so the button
   * opens the best one it can mint into. Nothing is substituted silently —
   * when the target is not the row, the drawer says which pool it will open
   * and why.
   */
  const stakeTarget = useMemo(() => {
    if (!pool) return null;
    const live = DATA_SOURCE === 'live';
    // The row's own pool first, always. It is the pool this drawer's figures
    // describe, and handing over a different one because some rule preferred
    // it is a substitution nobody asked for.
    if (isMintable(pool, live)) return pool;
    const address = pool.token.address.toLowerCase();
    const others = (otherPools ?? []).filter((p) => p.token.address.toLowerCase() === address);
    return orderMarkets(others.filter((p) => isMintable(p, live)))[0] ?? null;
  }, [pool, otherPools]);

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
  // The same source choice the row makes (lib/market-figures.ts), so the
  // drawer a person opens off a row cannot show a different day.
  const liquidity = pool ? shownLiquidity(pool) : null;
  const volume = pool ? shownVolume(pool) : null;
  const split = pool ? shownSplit(pool) : null;
  const source = pool ? sourceName(pool) : '';
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
        {pool && liquidity && volume && (
          <>
            <div className="dr-h">
              <TokenBadge token={pool.token} />
              <div>
                <div style={{ fontWeight: 600, fontSize: 14 }}>{pool.token.symbol} / {quoteLabel(pool)}</div>
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
                    className={`v num${shownYield(pool).pct !== null ? ' up' : ' muted'}`}
                    title={yieldTitle(shownYield(pool))}
                  >
                    {yieldValue(shownYield(pool))}
                    {yieldCaption(shownYield(pool), ageLabel(pool.ageHours), stalenessText(indexerLagSeconds)) && (
                      <span className="est">
                        {yieldCaption(shownYield(pool), ageLabel(pool.ageHours), stalenessText(indexerLagSeconds))}
                      </span>
                    )}
                  </div>
                  <div className="k" style={{ marginTop: 6 }}>
                    {yieldLabel(shownYield(pool))}
                  </div>
                </div>
                <div>
                  <div className="k">Fees 24h</div>
                  <div className="v num">{usd(pool.fees24hUsd)}</div>
                  <div className="k" style={{ marginTop: 6 }}>
                    {pool.feeTierBps === null
                      ? 'a fee its hook sets on every trade, paid to the pool'
                      : `${feeTierLabel(pool.feeTierBps)} of every trade, paid to the pool`}
                  </div>
                </div>
                <div>
                  <div className="k">
                    {liquidity.scope === 'token' ? 'Token liquidity' : 'Pool liquidity'}
                  </div>
                  <div className="v num">{liquidity.value === null ? '—' : usd(liquidity.value)}</div>
                  <div className="k" style={{ marginTop: 6 }}>
                    {liquidity.value === null
                      ? "this pool's events do not reconcile"
                      : liquidity.basis === 'chain'
                        ? /* Both sides, and then the side that is priced
                             outside the pool: the dollars a swap can take
                             out. The other side is the token at a price
                             derived from the pool's own ratio, so for a pool
                             holding most of a supply the total is that
                             token's FDV however little is really there (§24).
                             Under a dollar there is no figure worth printing:
                             `usd()` rounds to whole dollars, and "$0 of it in
                             ETH" reads as an empty pool rather than as a pool
                             with change in it (§21). */
                          pool.quoteTvlUsd >= 1
                          ? `both sides · ${usd(pool.quoteTvlUsd)} of it in ${quoteLabel(pool)}`
                          : 'both sides, from the chain'
                        : liquidity.scope === 'pool'
                          ? `both sides · via ${source}`
                          : `across its pools · via ${source}`}
                  </div>
                </div>
                <div>
                  <div className="k">Volume 24h</div>
                  <div className="v num">{usd(volume.value)}</div>
                  <div className="k" style={{ marginTop: 6 }}>
                    {volume.basis === 'chain-now'
                      ? `${pool.now!.trades24h} trade${pool.now!.trades24h === 1 ? '' : 's'} · this pool, ` +
                        "from the chain's head"
                      : volume.basis === 'live'
                        ? (split && split.unit === 'trades'
                            ? `${(split.buys + split.sells).toLocaleString()} trades · `
                            : '') + `the token, via ${source}`
                        : `${pool.trades24h} trade${pool.trades24h === 1 ? '' : 's'} · this pool` +
                          (pool.market === null ? ', from the chain' : '')}
                  </div>
                </div>
              </div>

              {/* The split a trader reads. Live when an aggregator has a
                  fresh quote — trades by side, since its feed splits trades
                  and not dollars — else from the indexed swaps, where a buy
                  pays the quote for the token and a sell the reverse. The
                  choice is lib/market-figures.ts's, the same one the row
                  makes, so the two cannot disagree. */}
              {split === null ? (
                <div className="split" aria-label="Buys and sells in the last 24 hours">
                  <div className="split-row">
                    <span>
                      <span className="k">Buys</span> <b className="num">—</b>
                    </span>
                    <span style={{ textAlign: 'right' }}>
                      <span className="k">Sells</span> <b className="num">—</b>
                    </span>
                  </div>
                  <div className="split-bar" aria-hidden="true">
                    <i style={{ width: '0%' }} />
                  </div>
                  <p className="hint" style={{ marginTop: 8 }}>
                    The day is not split into buys and sells for these hours yet.
                  </p>
                </div>
              ) : (
                <div className="split" aria-label="Buys and sells in the last 24 hours">
                  <div className="split-row">
                    <span>
                      <span className="k">Buys</span>{' '}
                      <b className="num">
                        {split.unit === 'trades' ? split.buys.toLocaleString() : usd(split.buys)}
                      </b>{' '}
                      <span className="muted num">
                        {split.unit === 'trades' ? 'trades' : `· ${split.basis === 'chain-now' ? pool.now!.buys24h : pool.buys24h}`}
                      </span>
                    </span>
                    <span style={{ textAlign: 'right' }}>
                      <span className="k">Sells</span>{' '}
                      <b className="num">
                        {split.unit === 'trades' ? split.sells.toLocaleString() : usd(split.sells)}
                      </b>{' '}
                      <span className="muted num">
                        {split.unit === 'trades' ? 'trades' : `· ${split.basis === 'chain-now' ? pool.now!.sells24h : pool.sells24h}`}
                      </span>
                    </span>
                  </div>
                  <div className="split-bar" aria-hidden="true">
                    <i style={{ width: `${buyShare(split.buys, split.sells)}%` }} />
                  </div>
                  {split.basis === 'chain-now' && (
                    <p className="hint" style={{ marginTop: 8 }}>
                      Volume, the split and the 24h change here are this pool&rsquo;s own swaps over the
                      last 24 hours, read from the chain&rsquo;s head. Fees, yield and liquidity are sums
                      over its whole history and come from the indexer, which is still catching up.
                    </p>
                  )}
                  {split.basis === 'live' && (
                    <p className="hint" style={{ marginTop: 8 }}>
                      Volume, trades and the 24h change here are {source}&rsquo;s live figures for the
                      token, summed over its pools. Fees, yield and the chain figures beside them are
                      derived from this pool&rsquo;s own swaps.
                    </p>
                  )}
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

              {stakeTarget ? (
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
                      <span className="muted">LockFi fee</span>
                      <b className="num">None · every fee is yours</b>
                    </div>
                    <div className="disclose">
                      <span className="muted">Custody</span>
                      <b>Your wallet, as an NFT</b>
                    </div>
                    <div className="disclose">
                      <span className="muted">LockFi holds</span>
                      <b>Nothing</b>
                    </div>
                    <div className="disclose">
                      <span className="muted">Lockup</span>
                      <b>None</b>
                    </div>
                  </div>
                  {stakeTarget && stakeTarget.id !== pool.id && (
                    <p className="hint" style={{ marginTop: 12 }}>
                      This row is {pool.token.symbol}&rsquo;s deepest market, and it runs a hook
                      LockFi has not verified. Staking opens{' '}
                      <b>
                        {pool.token.symbol} / {quoteLabel(stakeTarget)} · {feeTierLabel(stakeTarget.feeTierBps)}
                      </b>{' '}
                      instead — a different pool, with its own liquidity and its own fees.
                    </p>
                  )}
                  <p className="hint" style={{ marginTop: 12 }}>
                    If the token drops, the value of your stake drops with it — fees soften that,
                    they don&rsquo;t remove it.
                  </p>
                </>
              ) : (
                <div className="note" style={{ marginTop: 16 }}>
                  <b>Not offered for staking</b>
                  <p className="hint">
                    {pool.token.launchpad && !pool.stakeable
                      ? `${pool.token.symbol} is still on its ${pool.token.launchpad} curve, and pre-graduation liquidity cannot be staked until the pool graduates.`
                      : !pool.stakeable
                        ? `This pool runs a hook${hook ? ` (${hook.slice(0, 6)}…${hook.slice(-4)})` : ''} that LockFi has not verified. A hook can refuse liquidity, price it on its own curve, or take most of every trade as its fee — one on this chain takes about 98%. It is not offered until someone has looked.`
                        : `No ${pool.token.symbol} market that clears the listing bar runs a hook LockFi has verified, so none is offered for staking yet.`}
                  </p>
                </div>
              )}
              <AskPanel
                poolId={pool.id}
                suggestions={[
                  'What does this fee tier mean?',
                  'What are the risks of staking here?',
                  'How is full range different from Curve?',
                ]}
              />
            </div>

            <div className="dr-f">
              <button
                className="btn btn-ghost"
                disabled={!stakeTarget}
                onClick={() => {
                  if (!stakeTarget) return;
                  closeStake();
                  router.push(`/positions?pool=${encodeURIComponent(stakeTarget.id)}`);
                }}
              >
                Build custom
              </button>
              <button
                className="btn btn-brand"
                disabled={!stakeTarget}
                onClick={() => {
                  // The real thing, through the builder's mint flow: full
                  // range, one position, dry-run by the node before the
                  // wallet is asked to sign (§20). It used to toast "Staked"
                  // and do nothing, which on mainnet is a lie.
                  if (!stakeTarget) return;
                  closeStake();
                  router.push(`/positions?pool=${encodeURIComponent(stakeTarget.id)}&range=full`);
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
