'use client';

import { useRouter } from 'next/navigation';
import { Fragment, useEffect, useState } from 'react';
import { formatUnits } from 'viem';
import { useMarket } from '@/components/providers/MarketProvider';
import { useUi } from '@/components/providers/UiProvider';
import { AskPanel } from '@/components/ask/AskPanel';
import { useAskStatus } from '@/components/ask/useAskStatus';
import { TokenBadge } from '@/components/ui/TokenBadge';
import type { AskPosition } from '@/lib/ask';
import { EXPLORER_URL } from '@/lib/chain';
import { getProvider } from '@/lib/data';
import type { TokenMeta, UserPosition } from '@/lib/data/types';
import { countdown, quoteLabel, usdExact, usdFine } from '@/lib/format';
import { positionRef } from '@/lib/position-ref';
import { impactPctText, impactText } from '@/lib/price-impact';
import { SHAPES } from '@/lib/shapes';
import { amount as fmtAmount } from '@/lib/v4/format';
import { feesUsd, type LiveFeesState } from './useLiveFees';
import type { PositionActions } from './usePositionActions';

/** A signed percent for a range bound: −12.5% / +12.5%. */
function pct(n: number): string {
  const digits = Math.abs(n) >= 10 ? 0 : 1;
  const sign = n < 0 ? '−' : '+';
  return `${sign}${Math.abs(n).toFixed(digits)}%`;
}

function since(hours: number): string {
  if (hours < 1) return 'less than an hour ago';
  if (hours < 48) return `${Math.round(hours)}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** Suggested questions, by what the position is doing. */
function positionQuestions(position: UserPosition): string[] {
  if (position.rangeUnknown) {
    return ['Why is the range status not known?', 'What does my price impact mean?', 'What does Withdraw do?'];
  }
  if (!position.inRange) {
    return ['Why is this position earning nothing?', 'What does Rebalance do, and what does it cost?', 'What happens if I just wait?'];
  }
  return ['How does this position earn fees?', 'What does my price impact mean?', 'What happens when I collect fees?'];
}

const SPARK = (
  <svg viewBox="0 0 20 20" aria-hidden="true" className="ask-spark">
    <path d="M9 3.5c.5 2.8 1.7 4 4.5 4.5-2.8.5-4 1.7-4.5 4.5-.5-2.8-1.7-4-4.5-4.5 2.8-.5 4-1.7 4.5-4.5Z" />
    <path d="M15 12c.3 1.5.9 2.1 2.5 2.5-1.6.4-2.2 1-2.5 2.5-.3-1.5-.9-2.1-2.5-2.5 1.6-.4 2.2-1 2.5-2.5Z" />
  </svg>
);

/**
 * The builder, on the same pool and the same width, centred on today's price:
 * what a rebalance mints after the old position is withdrawn. A position whose
 * range is not known (the simulator's) keeps its half-width.
 */
function rebalanceHref(position: Pick<UserPosition, 'poolId' | 'range' | 'rangePct'>): string {
  const half =
    position.range && position.range !== 'full'
      ? Math.max(1, Math.round((position.range.maxPct - position.range.minPct) / 2))
      : Math.max(1, Math.round(position.rangePct));
  return `/positions?pool=${encodeURIComponent(position.poolId)}&min=${-half}&max=${half}`;
}

export function PositionList({
  fees,
  actions,
  tokenAddress,
  title = 'Positions',
}: {
  fees: LiveFeesState;
  actions: PositionActions;
  /**
   * Only this token's positions — the builder shows the ones in the token it
   * is minting, so a mint is followed on the same page and can be withdrawn
   * there. The search box does not apply then; stakes and empty states are
   * the Portfolio's.
   */
  tokenAddress?: string;
  title?: string;
}) {
  const { portfolio, pools, global } = useMarket();
  // Ask AI opens under one row at a time; the button shows only while the assistant is on.
  const askOn = useAskStatus()?.enabled === true;
  const [asking, setAsking] = useState<string | null>(null);
  const { query, wallet } = useUi();
  const router = useRouter();
  // Withdraw closes a position, so it asks twice: the first click says what
  // will happen, the second sends it to the wallet. Collect fees leaves the
  // position open and asks once. The question lapses after a few seconds, so
  // a stray click later does not land on a button already armed.
  const [confirming, setConfirming] = useState<{ ref: string; then: 'withdraw' | 'rebalance' } | null>(null);
  useEffect(() => {
    if (!confirming) return;
    const t = setTimeout(() => setConfirming(null), 8_000);
    return () => clearTimeout(t);
  }, [confirming]);
  const live = getProvider().kind === 'live';

  // A live position's pool can sit below the listing bar and still be
  // someone's; its token rides on the position when the board has no row.
  const tokenOf = (position: UserPosition): TokenMeta | null =>
    pools.find((p) => p.id === position.poolId)?.token ?? position.live?.token ?? null;
  const only = tokenAddress?.toLowerCase();
  const q = only ? '' : query.trim().toLowerCase();
  const matchesToken = (token: TokenMeta | null) =>
    only
      ? token !== null && token.address.toLowerCase() === only
      : q === '' || (token !== null && (token.symbol.toLowerCase().includes(q) || token.name.toLowerCase().includes(q)));
  const positions = portfolio.positions.filter((p) => matchesToken(tokenOf(p)));
  // Withdrawn v3 positions: the portfolio page lists them under the open
  // ones with what each earned and lost, so the totals above add up to rows.
  const closed = only
    ? []
    : (portfolio.closed ?? []).filter((c) => q === '' || c.token.symbol.toLowerCase().includes(q));
  const stakes = only ? [] : portfolio.stakes.filter((s) => matchesToken(pools.find((p) => p.id === s.poolId)?.token ?? null));
  // Out of range, and known to be: a pool the indexer has no price for is not
  // "stranded", it is unread (UserPosition.rangeUnknown).
  const stranded = positions.find((p) => !p.inRange && !p.rangeUnknown);
  const strandedToken = stranded ? tokenOf(stranded) : null;
  const strandedOnBoard = stranded ? pools.find((p) => p.id === stranded.poolId && p.stakeable) : undefined;

  // Filtered to one token with nothing in it, the builder shows nothing.
  if (only && positions.length === 0) return null;

  return (
    <div className="card panel" data-testid={only ? 'token-positions' : undefined}>
      <h2 style={{ fontWeight: 600, fontSize: 17, letterSpacing: '-.02em', marginBottom: 6 }}>
        {title}
      </h2>
      {only && (
        <p className="hint" style={{ marginBottom: 8 }}>
          Each is an NFT in your wallet, earning this pool&rsquo;s fees while the price is in its range. Collect the fees
          or withdraw the whole position at any time — no lockup, no LockFi fee.
        </p>
      )}

      {positions.map((position) => {
        const token = tokenOf(position);
        if (!token) return null;
        const lp = position.live;
        const impactPct =
          position.priceImpactUsd !== undefined && lp?.holdUsd && lp.holdUsd > 0
            ? impactPctText((position.priceImpactUsd / lp.holdUsd) * 100)
            : null;
        const quote = lp ? quoteLabel(lp) : quoteLabel(pools.find((p) => p.id === position.poolId)!);
        const shape = position.shape ? SHAPES.find((s) => s.id === position.shape) : undefined;
        const rangeText =
          position.range === 'full'
            ? 'Full range'
            : position.range
              ? `${pct(position.range.minPct)} / ${pct(position.range.maxPct)}`
              : `${shape?.label ?? 'Position'} · ±${position.rangePct}%`;

        // Uncollected fees, from the chain (useLiveFees), in the token and
        // the quote and in dollars at the prices the value beside them used.
        const ref = positionRef(position);
        const entry = lp ? fees.fees.get(ref) : undefined;
        const feeUsd = lp ? feesUsd(position, fees.fees) : null;
        const tokenFees = entry && lp ? (lp.tokenIsCurrency0 ? entry.fees0 : entry.fees1) : null;
        const quoteFees = entry && lp ? (lp.tokenIsCurrency0 ? entry.fees1 : entry.fees0) : null;
        const hasFees = tokenFees !== null && quoteFees !== null && (tokenFees > 0n || quoteFees > 0n);
        const busy = actions.busy?.ref === ref ? actions.busy : null;
        const error = actions.error?.ref === ref ? actions.error.message : null;
        const done = actions.done?.ref === ref ? actions.done : null;
        const canAct = Boolean(lp) && !actions.busy;

        const askPosition: AskPosition = {
          tokenId: position.tokenId,
          pair: `${token.symbol} / ${quote}`,
          protocol: lp?.protocol ?? null,
          range:
            position.range ?? (position.rangePct > 0 ? { minPct: -position.rangePct, maxPct: position.rangePct } : null),
          status: position.rangeUnknown ? 'unknown' : position.inRange ? 'in-range' : 'out-of-range',
          outOfRangeHours: position.outOfRangeSinceHours ?? null,
          valueUsd: position.valueUnknown ? null : position.valueUsd,
          uncollectedFeesUsd: lp ? feeUsd : position.feesWeth !== undefined ? position.feesWeth * global.ethPriceUsd : null,
          priceImpactUsd: position.priceImpactUsd ?? null,
          priceImpactPct:
            position.priceImpactUsd !== undefined && lp?.holdUsd && lp.holdUsd > 0
              ? (position.priceImpactUsd / lp.holdUsd) * 100
              : null,
        };

        return (
          <Fragment key={ref}>
          <div className="pnl-row" data-token-id={position.tokenId} data-position={ref}>
            <div className="tok">
              <TokenBadge token={token} />
              <div>
                <div className="n">
                  {token.symbol} / {quote}
                  {lp && (
                    <span className="muted num" style={{ fontWeight: 400, fontSize: 12, marginLeft: 8 }}>
                      {/* v3 and v4 number their NFTs independently; the manager is part of the name. */}
                      {lp.protocol === 'v3' ? 'v3 ' : ''}#{position.tokenId}
                    </span>
                  )}
                </div>
                <div className="s">
                  {rangeText} ·{' '}
                  {position.rangeUnknown ? (
                    'range status not known yet — the pool has no indexed price'
                  ) : position.inRange ? (
                    'in range'
                  ) : (
                    // §7: out of range earns nothing. Say exactly that, in red.
                    <span className="down">out of range — earning nothing</span>
                  )}
                </div>
              </div>
            </div>
            <div style={{ textAlign: 'right', flex: '0 1 auto', minWidth: 0 }}>
              <div className="num" style={{ fontWeight: 600 }} title={position.valueUnknown ? 'No indexed price for this pool yet' : undefined}>
                {position.valueUnknown ? '—' : usdExact(position.valueUsd)}
              </div>
              {lp ? (
                <div
                  className={`num${hasFees ? ' up' : ' muted'}`}
                  style={{ fontSize: 12 }}
                  title="Uncollected fees, read from the chain now and valued at the last indexed block's prices. Collect sends them to your wallet."
                >
                  {entry
                    ? `+${fmtAmount(tokenFees!, token.decimals)} ${token.symbol} · +${fmtAmount(quoteFees!, lp.quoteDecimals)} ${quote} fees` +
                      (feeUsd !== null && feeUsd >= 0.5 ? ` ≈ ${usdExact(feeUsd)}` : '')
                    : fees.reading
                      ? 'reading fees from the chain…'
                      : fees.error
                        ? 'fees unreadable right now'
                        : 'fees not read'}
                </div>
              ) : (
                <div className="up num" style={{ fontSize: 12 }}>
                  +{(position.feesWeth ?? 0).toFixed(2)} ETH fees
                </div>
              )}
              {lp && (
                <div
                  className={`num${position.priceImpactUsd !== undefined && position.priceImpactUsd < 0 ? ' down' : ' muted'}`}
                  style={{ fontSize: 12 }}
                  data-testid="position-impact"
                  title="Price impact on holdings: what this position is worth now against what holding the tokens put into it would be worth, both at today's prices. It is what providing liquidity has cost against simply holding, fees aside."
                >
                  {position.priceImpactUsd === undefined
                    ? 'price impact — principal not known'
                    : `price impact ${impactText(position.priceImpactUsd)}${impactPct ? ` (${impactPct})` : ''}`}
                </div>
              )}
              {(lp || askOn) && (
                <div className="row" style={{ justifyContent: 'flex-end', marginTop: 8, gap: 6, flexWrap: 'wrap' }}>
                  {askOn && (
                    <button
                      className={`btn btn-ghost btn-sm ask-btn${asking === ref ? ' on' : ''}`}
                      aria-expanded={asking === ref}
                      aria-controls={`ask-row-${ref}`}
                      data-testid="ask-position"
                      title="Ask LockFi AI about this position: why it is where it is, and what each action does"
                      onClick={() => setAsking(asking === ref ? null : ref)}
                    >
                      {SPARK}
                      Ask AI
                    </button>
                  )}
                  {lp && (
                  <>
                  <button
                    className="btn btn-ghost btn-sm"
                    disabled={!canAct || (entry !== undefined && !hasFees)}
                    title={entry !== undefined && !hasFees ? 'Nothing to collect yet' : 'Send the uncollected fees to your wallet'}
                    onClick={() => void actions.collect(position)}
                  >
                    Collect fees
                  </button>
                  {confirming?.ref === ref ? (
                    <>
                      <button className="btn btn-ghost btn-sm" onClick={() => setConfirming(null)}>
                        Keep it open
                      </button>
                      <button
                        className="btn btn-brand btn-sm"
                        disabled={!canAct}
                        data-testid="confirm-withdraw"
                        onClick={() => {
                          const then = confirming.then;
                          setConfirming(null);
                          void actions.withdraw(position).then((ok) => {
                            if (ok && then === 'rebalance') router.push(rebalanceHref(position));
                          });
                        }}
                      >
                        Yes, close the position
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        className="btn btn-ghost btn-sm"
                        disabled={!canAct}
                        title="Close the position: all of its liquidity and its fees go to your wallet, and it stops earning. Asks you to confirm first."
                        onClick={() => setConfirming({ ref, then: 'withdraw' })}
                      >
                        Withdraw
                      </button>
                      {!position.inRange && !position.rangeUnknown && position.range !== 'full' && (
                        <button
                          className="btn btn-brand btn-sm"
                          disabled={!canAct}
                          data-testid="rebalance"
                          title="Withdraw this position, then open the builder on the same pool and width, centred on today's price. The new mint is a second transaction you sign there."
                          onClick={() => setConfirming({ ref, then: 'rebalance' })}
                        >
                          Rebalance
                        </button>
                      )}
                    </>
                  )}
                  </>
                  )}
                </div>
              )}
              {confirming?.ref === ref && (
                <p className="hint" role="status" style={{ marginTop: 6, textAlign: 'right' }}>
                  This closes #{position.tokenId}: all of its {token.symbol} and {quote}, plus its fees, go back to your
                  wallet and it stops earning. To take only the fees and keep it open, use Collect fees.
                </p>
              )}
              {busy && (
                <p className="hint" style={{ marginTop: 6 }} aria-live="polite">
                  {busy.label}
                </p>
              )}
              {error && (
                <p className="hint down" style={{ marginTop: 6 }} role="alert">
                  {error}
                </p>
              )}
              {done && !busy && !error && (
                <p className="hint" style={{ marginTop: 6 }}>
                  {done.kind === 'collect' ? 'Fees collected.' : 'Withdrawn.'}{' '}
                  <a href={`${EXPLORER_URL}/tx/${done.hash}`} target="_blank" rel="noopener noreferrer" style={{ textDecoration: 'underline' }}>
                    View the transaction
                  </a>
                </p>
              )}
            </div>
          </div>
          {asking === ref && (
            <div className="pnl-ask" id={`ask-row-${ref}`}>
              <AskPanel
                poolId={position.poolId}
                position={askPosition}
                title={`Ask about ${token.symbol} / ${quote} #${position.tokenId}`}
                placeholder="Ask about this position"
                suggestions={positionQuestions(position)}
              />
            </div>
          )}
          </Fragment>
        );
      })}

      {stakes.map((stake) => {
        const pool = pools.find((p) => p.id === stake.poolId);
        if (!pool) return null;
        return (
          <div className="pnl-row" key={stake.vaultId}>
            <div className="tok">
              <TokenBadge token={pool.token} />
              <div>
                <div className="n">{pool.token.symbol} stake</div>
                <div className="s">
                  Streaming · {countdown(stake.streamRemainingSeconds)}
                </div>
              </div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div className="num" style={{ fontWeight: 600 }}>
                {usdExact(stake.stakedUsd)}
              </div>
              <div className="up num" style={{ fontSize: 12 }}>
                +{stake.earnedWeth.toFixed(2)} ETH fees
              </div>
            </div>
          </div>
        );
      })}

      {live && portfolio.chain?.status === 'unavailable' && (
        <p className="hint" role="status" style={{ margin: '10px 0' }}>
          The chain did not answer just now, so the Uniswap v4 positions here are the indexer&rsquo;s record, not
          checked against the chain, and any minted since its last block are missing. Withdraw still asks the chain
          first. The page asks again on its next refresh.
        </p>
      )}
      {live && portfolio.status === 'kept' && !only && (
        <p className="hint" role="status" style={{ margin: '10px 0' }}>
          Shown as this browser last read them
          {portfolio.keptAt
            ? ` (${new Date(portfolio.keptAt).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })} UTC)`
            : ''}
          , while the chain is asked again. Collect and Withdraw ask the chain first either way.
        </p>
      )}
      {live && portfolio.chain?.v3Unavailable && (
        <p className="hint" role="status" style={{ margin: '10px 0' }}>
          Uniswap v3 positions could not be read from the chain just now, so any this wallet holds are not listed.
          The page asks again on its next refresh.
        </p>
      )}
      {live && portfolio.chain?.v3Unchecked && (
        <p className="hint" role="status" style={{ margin: '10px 0' }}>
          The chain did not answer for Uniswap v3 just now, so these v3 positions are as of the last read that did.
          Collect and Withdraw still ask the chain first. The page asks again on its next refresh.
        </p>
      )}
      {live && portfolio.chain?.pricesStale && (
        <p className="hint" style={{ margin: '10px 0' }}>
          Pool prices could not be read live, so in-range status and amounts are as of the indexer&rsquo;s last block.
        </p>
      )}
      {live && (portfolio.chain?.unreadable ?? 0) > 0 && (
        <p className="hint" style={{ margin: '10px 0' }}>
          {portfolio.chain!.unreadable} position{portfolio.chain!.unreadable === 1 ? '' : 's'} this wallet holds could
          not be described from the chain, so {portfolio.chain!.unreadable === 1 ? 'it is' : 'they are'} not listed.
          Manage {portfolio.chain!.unreadable === 1 ? 'it' : 'them'} on Uniswap&rsquo;s own site.
        </p>
      )}
      {live && portfolio.chain?.partial && (
        <p className="hint" style={{ margin: '10px 0' }}>
          The scan for Uniswap v4 positions the indexer has not reached yet is still running, so one minted or
          received since its last block may be missing for a few minutes. A position minted here shows at once.
        </p>
      )}

      {positions.length === 0 && stakes.length === 0 && (
        <div className="empty">
          {q !== '' ? (
            <>
              <b>No match</b>Nothing in your portfolio matches that search.
            </>
          ) : live && wallet && portfolio.status === 'loading' ? (
            <>
              <b>Reading your positions…</b>Asking Uniswap&rsquo;s position managers what this wallet holds. On the free
              endpoints this can take a few seconds.
            </>
          ) : live && wallet && portfolio.status === 'error' ? (
            <>
              <b>Not read yet</b>The chain did not answer for this wallet just now. Nothing is wrong with the positions
              themselves; the page asks again shortly.
            </>
          ) : live && !wallet ? (
            <>
              <b>Connect a wallet</b>Its positions — the NFTs Uniswap&rsquo;s v3 and v4 position managers minted to
              it — appear here, marked to market, with their uncollected fees read from the chain.
            </>
          ) : live && closed.length > 0 ? (
            <>
              <b>No open positions</b>Every position this wallet opened here has been withdrawn; what each earned is
              listed below and counted in the totals.
            </>
          ) : live ? (
            <>
              <b>No positions yet</b>Mint one from Positions, or stake from a pool. A position minted here appears as
              soon as its transaction is confirmed.
            </>
          ) : (
            <>
              <b>No positions yet</b>Positions you mint and stakes you open appear here,
              marked to market, with the fees they earned.
            </>
          )}
        </div>
      )}

      {closed.length > 0 && (
        <div style={{ marginTop: 16 }} data-testid="closed-positions">
          <h3 className="sect-h" style={{ fontSize: 14, marginBottom: 8 }}>
            Closed
          </h3>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 10 }}>
            {closed.map((c) => {
              const pct = c.depositedUsd > 0 ? impactPctText((c.priceImpactUsd / c.depositedUsd) * 100) : null;
              return (
                <li key={`closed:${c.tokenId}`} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                  <span style={{ display: 'flex', gap: 10, alignItems: 'center', minWidth: 0 }}>
                    <TokenBadge token={{ address: c.token.address, symbol: c.token.symbol, name: c.token.symbol, decimals: 18, logoColor: c.token.logoColor, logoUrl: c.token.logoUrl }} />
                    <span>
                      <b>
                        {c.token.symbol} / {c.quote}
                      </b>{' '}
                      <span className="muted">v3 #{c.tokenId} · withdrawn</span>
                    </span>
                  </span>
                  <span className="num" style={{ fontSize: 12.5, textAlign: 'right' }}>
                    <span title="What went in and what came back out as principal, both at today's prices.">
                      {usdFine(c.depositedUsd)} in → {usdFine(c.withdrawnUsd)} out
                    </span>
                    <br />
                    <span className={c.feesUsd > 0 ? 'up' : 'muted'} title={c.feesComplete ? 'Fees paid out, from its own logs.' : 'Fees paid out through this browser; a collect sent from elsewhere is not counted.'}>
                      +{usdFine(c.feesUsd)} fees
                    </span>
                    {' · '}
                    <span className={c.priceImpactUsd < 0 ? 'down' : 'muted'}>
                      price impact {impactText(c.priceImpactUsd)}
                      {pct ? ` (${pct})` : ''}
                    </span>
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {stranded && strandedToken && (
        <div className="alert">
          {strandedToken.symbol} left its range{' '}
          {stranded.outOfRangeSinceHours !== undefined ? since(stranded.outOfRangeSinceHours) : ''} and has earned
          nothing since.{' '}
          {strandedOnBoard ? (
            <>
              <button className="link" onClick={() => router.push(rebalanceHref({ ...stranded, poolId: strandedOnBoard.id }))}>
                Rebalance
              </button>{' '}
              to start earning again{stranded.live ? ': withdraw it here, then mint a range around today’s price' : ''}.
            </>
          ) : stranded.live ? (
            'Withdraw it here, then mint a range around today’s price to start earning again.'
          ) : (
            <>
              <button className="link" onClick={() => router.push('/positions')}>
                Rebalance
              </button>{' '}
              to start earning again.
            </>
          )}
        </div>
      )}
    </div>
  );
}
