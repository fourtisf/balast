'use client';

import { useEffect, useMemo, useState } from 'react';
import { formatUnits } from 'viem';
import { useMarket } from '@/components/providers/MarketProvider';
import { useUi } from '@/components/providers/UiProvider';
import { FeeHeatmap } from '@/components/portfolio/FeeHeatmap';
import { PositionList } from '@/components/portfolio/PositionList';
import { TxHistory } from '@/components/portfolio/TxHistory';
import { feesUsd, useLiveFees } from '@/components/portfolio/useLiveFees';
import { usePositionActions } from '@/components/portfolio/usePositionActions';
import { getProvider } from '@/lib/data';
import type { UserPosition } from '@/lib/data/types';
import { dailyEarnedUsd, recordEarned, type EarnedReading } from '@/lib/fee-samples';
import { signedPct, usdExact, usdFine, ether } from '@/lib/format';
import { positionRef } from '@/lib/position-ref';
import { impactPctText, impactText, priceImpactOf } from '@/lib/price-impact';

/**
 * What a live position has earned so far: the fees it has already paid out
 * (a v3 position's own Collect logs, server/api/v3-history.ts) plus what is
 * uncollected now (read from the chain by the page). `complete` is false when
 * the collected half is not known — every v4 position, since v4 emits no
 * amounts for a collect — and the figure is then its uncollected fees alone.
 */
function earnedOf(position: UserPosition, fees: ReturnType<typeof useLiveFees>['fees']) {
  const live = position.live;
  const entry = fees.get(positionRef(position));
  if (!live || !entry) return null;
  const known = live.collectedFees0 != null && live.collectedFees1 != null;
  const e0 = entry.fees0 + (known ? BigInt(live.collectedFees0!) : 0n);
  const e1 = entry.fees1 + (known ? BigInt(live.collectedFees1!) : 0n);
  const perUnit0 = live.priceUsd0 / 10 ** live.key.decimals0;
  const perUnit1 = live.priceUsd1 / 10 ** live.key.decimals1;
  const usd = Number(formatUnits(e0, live.key.decimals0)) * live.priceUsd0 + Number(formatUnits(e1, live.key.decimals1)) * live.priceUsd1;
  const reading: EarnedReading = { ref: positionRef(position), earned0: e0, earned1: e1, usdPerUnit0: perUnit0, usdPerUnit1: perUnit1, mintedAt: live.mintedAt };
  return { usd, complete: known, reading };
}

export function PortfolioBody() {
  const { portfolio } = useMarket();
  const { wallet } = useUi();
  const live = getProvider().kind === 'live';
  const actions = usePositionActions();
  const fees = useLiveFees(portfolio.positions, actions.version);

  const positions = portfolio.positions;
  // No positions and no stakes is a portfolio with nothing in it, and a card
  // reading "$0 · +0.0% all time" is a claim about a history that does not
  // exist (§7). The figures are dashes and the captions say why.
  const empty = positions.length === 0 && portfolio.stakes.length === 0;
  const noWallet = live && !wallet;
  const why = noWallet ? 'connect a wallet' : 'no positions yet';

  // Uncollected fees across the live positions, from the chain. Summed only
  // over positions with a reading; a position the node did not answer for
  // is left out and the caption says how many were read.
  const livePositions = positions.filter((p) => p.live);
  const readings = livePositions.map((p) => feesUsd(p, fees.fees)).filter((n): n is number => n !== null);
  const uncollectedUsd = readings.length > 0 ? readings.reduce((a, b) => a + b, 0) : null;
  const inRange = positions.filter((p) => p.inRange).length;
  // A position whose pool has no indexed price is neither earning nor idle as
  // far as the page can tell, so it is not counted as "earning nothing".
  const rangeKnown = positions.filter((p) => !p.rangeUnknown).length;

  // Impermanent loss, under the name that tells the truth (§7): what the
  // position is worth against what holding its principal would be worth.
  // Positions whose principal is known are summed; one without is left out
  // and the caption says so — a dash, not a $0 that reads as "no loss".
  // Live, the figure is shown to the cent with its share of the held value:
  // on a small position minted recently it is cents, and rounding that to
  // "$0" read as unmeasured (lib/price-impact.ts).
  const impact = portfolio.priceImpactUsd;
  const summary = priceImpactOf(positions);
  const measured = summary.measured;
  const unknownImpact = empty || (live && measured === 0);
  const impactClass = unknownImpact ? '' : live ? (summary.usd < 0 ? ' down' : '') : impact <= -0.5 ? ' down' : impact >= 0.5 ? ' up' : '';
  const impactTextShown = unknownImpact
    ? '—'
    : live
      ? impactText(summary.usd)
      : impact <= -0.5
        ? `−${usdExact(Math.abs(impact))}`
        : impact >= 0.5
          ? `+${usdExact(impact)}`
          : '$0';
  const impactPct = live && !unknownImpact ? impactPctText(summary.pct) : null;

  const hasHeatmap = portfolio.dailyFeesWeth.length > 0 && !empty;

  // Live: fees earned so far, per position and in total, and the day-by-day
  // record this browser keeps of it (lib/fee-samples.ts).
  const earned = useMemo(
    () => livePositions.map((p) => ({ position: p, earned: earnedOf(p, fees.fees) })),
    [livePositions, fees.fees],
  );
  const earnedKnown = earned.filter((e) => e.earned !== null);
  const earnedUsd = earnedKnown.length > 0 ? earnedKnown.reduce((a, e) => a + e.earned!.usd, 0) : null;
  const earnedPartial = earnedKnown.some((e) => !e.earned!.complete);
  const walletAddress = portfolio.wallet ?? wallet?.address ?? null;
  const [daily, setDaily] = useState<{ values: number[]; since: string | null }>({ values: [], since: null });
  useEffect(() => {
    if (!live || !walletAddress) return;
    const readings = earnedKnown.map((e) => e.earned!.reading);
    if (readings.length > 0) recordEarned(walletAddress, readings);
    setDaily(dailyEarnedUsd(walletAddress, readings));
    // Re-recorded on every fee reading: the latest reading of a day wins.
  }, [live, walletAddress, fees.fees]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <div className="grid g4" style={{ marginBottom: 16 }}>
        <div className="card stat">
          <div className="k">Net value</div>
          <div className="v num">{empty ? '—' : live ? usdFine(portfolio.netValueUsd) : usdExact(portfolio.netValueUsd)}</div>
          <div className={`d${empty || live ? '' : ' up'}`}>
            {empty
              ? why
              : live
                ? `${positions.length} position${positions.length === 1 ? '' : 's'} · ${portfolio.pricedToday ? 'at today’s pool prices' : 'at the last indexed block'}`
                : `+${usdExact(portfolio.netChangeUsd)} · ${signedPct(portfolio.netChangePct)} all time`}
          </div>
        </div>
        {live ? (
          <div className="card stat">
            <div className="k">Fees earned</div>
            <div className={`v num${earnedUsd !== null && earnedUsd > 0 ? ' up' : ''}`}>
              {empty ? '—' : earnedUsd !== null ? usdFine(earnedUsd) : '—'}
            </div>
            <div className="d">
              {empty
                ? why
                : uncollectedUsd !== null
                  ? readings.length === livePositions.length
                    ? `${usdFine(uncollectedUsd)} uncollected · collect from the row${earnedPartial ? ' · v4: uncollected only' : ''}`
                    : `${readings.length} of ${livePositions.length} positions read`
                  : fees.reading
                    ? 'reading from the chain…'
                    : fees.error
                      ? 'the chain did not answer'
                      : 'not read'}
            </div>
          </div>
        ) : (
          <div className="card stat">
            <div className="k">Fees earned</div>
            <div className="v num">{empty || portfolio.feesEarnedWeth === null ? '—' : ether(portfolio.feesEarnedWeth)}</div>
            <div className="d">
              {empty ? why : portfolio.feesEarnedUsd === null ? 'not tracked' : usdExact(portfolio.feesEarnedUsd)}
            </div>
          </div>
        )}
        <div className="card stat">
          <div className="k">Price impact on holdings</div>
          <div className={`v num${impactClass}`}>{impactTextShown}</div>
          <div className="d">
            {!live
              ? 'vs holding tokens'
              : measured < positions.length && !empty
                ? // A v3 position is read live, and its funding is not indexed;
                  // a pool with no indexed price has no value. No figure for
                  // those — said, not summed as zero.
                  `${measured} of ${positions.length} positions measured`
                : impactPct
                  ? `${impactPct} vs holding the principal, at the same prices`
                  : 'vs holding the principal, at the same prices'}
          </div>
        </div>
        {live ? (
          <div className="card stat">
            <div className="k">In range</div>
            <div className="v num">{empty ? '—' : `${inRange} of ${rangeKnown}`}</div>
            <div className="d">
              {empty
                ? why
                : rangeKnown - inRange === 0
                  ? rangeKnown < positions.length
                    ? `${positions.length - rangeKnown} not known yet`
                    : 'every position is earning'
                  : `${rangeKnown - inRange} earning nothing`}
            </div>
          </div>
        ) : (
          <div className="card stat">
            <div className="k">Fees · last 7d</div>
            <div className={`v num${empty || portfolio.fees7dUsd === null ? '' : ' up'}`}>
              {empty || portfolio.fees7dUsd === null ? '—' : usdExact(portfolio.fees7dUsd)}
            </div>
            <div className="d">
              {empty
                ? why
                : portfolio.feesEarnedUsd === null
                  ? 'not tracked'
                  : `of ${usdExact(portfolio.feesEarnedUsd)} all time`}
            </div>
          </div>
        )}
      </div>

      <div className="grid g2">
        {live && !empty ? (
          <div className="card panel">
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
              <h2 className="sect-h">Fees earned · by day</h2>
              {daily.values.length > 0 && (
                <span className="muted" style={{ fontSize: 12 }}>
                  deeper green = more
                </span>
              )}
            </div>
            {daily.values.length > 0 ? (
              <FeeHeatmap values={daily.values} format={usdFine} caption="Fees earned per day, oldest first, as this browser measured them" />
            ) : (
              <p className="hint">Reading each position&rsquo;s fees from the chain…</p>
            )}
            <ul style={{ listStyle: 'none', margin: '12px 0 0', padding: 0, display: 'grid', gap: 8 }} data-testid="fees-earned">
              {earned.map(({ position, earned: e }) => {
                const lp = position.live!;
                const since = lp.mintedAt ? new Date(lp.mintedAt) : null;
                const days = since ? Math.max(1, (Date.now() - since.getTime()) / 86_400_000) : null;
                return (
                  <li key={positionRef(position)} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 13.5 }}>
                    <span>
                      {lp.token.symbol} {lp.protocol === 'v3' ? 'v3 ' : ''}#{position.tokenId}
                      <span className="muted">
                        {since ? ` · since ${since.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}` : ''}
                      </span>
                    </span>
                    <span className="num" title={e && !e.complete ? 'Uncollected fees only: a Uniswap v4 collect emits no amounts, so fees already collected are not known here.' : 'Collected so far plus uncollected, read from the chain.'}>
                      {e ? usdFine(e.usd) : '—'}
                      {e && days ? <span className="muted"> · ≈ {usdFine(e.usd / days)}/day</span> : null}
                      {e && !e.complete ? <span className="muted"> · uncollected</span> : null}
                    </span>
                  </li>
                );
              })}
            </ul>
            <p className="hint" style={{ marginTop: 10 }}>
              Earned so far is what each position has paid out plus what it holds uncollected, read from the chain. A past
              day&rsquo;s fees cannot be read back from a free endpoint, so the grid is measured by this browser from{' '}
              {daily.since ?? 'today'} and fills in day by day.
            </p>
          </div>
        ) : (
        <div className="card panel">
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
            <h2 className="sect-h">Daily fees · 8 weeks</h2>
            {hasHeatmap && (
              <span className="muted" style={{ fontSize: 12 }}>
                deeper green = more ETH
              </span>
            )}
          </div>
          {hasHeatmap ? (
            <FeeHeatmap values={portfolio.dailyFeesWeth} />
          ) : (
            <div className="empty">
              {empty ? (
                <>
                  <b>No fees yet</b>The daily grid fills in as your positions earn.
                </>
              ) : (
                // A live position's collections are not indexed yet (§22);
                // what it has not collected is read from the chain on the row.
                <>
                  <b>No fee history yet</b>Collections are not indexed, so there is no day-by-day record to draw. Each
                  position&rsquo;s uncollected fees are read from the chain on its row.
                </>
              )}
            </div>
          )}
        </div>
        )}
        <PositionList fees={fees} actions={actions} />
      </div>

      <TxHistory />
    </>
  );
}
