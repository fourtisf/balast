'use client';

import { useMarket } from '@/components/providers/MarketProvider';
import { useUi } from '@/components/providers/UiProvider';
import { FeeHeatmap } from '@/components/portfolio/FeeHeatmap';
import { PositionList } from '@/components/portfolio/PositionList';
import { TxHistory } from '@/components/portfolio/TxHistory';
import { feesUsd, useLiveFees } from '@/components/portfolio/useLiveFees';
import { usePositionActions } from '@/components/portfolio/usePositionActions';
import { getProvider } from '@/lib/data';
import { signedPct, usdExact, weth } from '@/lib/format';

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

  // Impermanent loss, under the name that tells the truth (§7): what the
  // position is worth against what holding its principal would be worth.
  // It cannot be positive in theory and can be by a cent in practice, so a
  // figure under half a dollar either way is a plain zero in no colour.
  const impact = portfolio.priceImpactUsd;
  const impactClass = empty ? '' : impact <= -0.5 ? ' down' : impact >= 0.5 ? ' up' : '';
  const impactText = empty
    ? '—'
    : impact <= -0.5
      ? `−${usdExact(Math.abs(impact))}`
      : impact >= 0.5
        ? `+${usdExact(impact)}`
        : '$0';

  const hasHeatmap = portfolio.dailyFeesWeth.length > 0 && !empty;

  return (
    <>
      <div className="grid g4" style={{ marginBottom: 16 }}>
        <div className="card stat">
          <div className="k">Net value</div>
          <div className="v num">{empty ? '—' : usdExact(portfolio.netValueUsd)}</div>
          <div className={`d${empty || live ? '' : ' up'}`}>
            {empty
              ? why
              : live
                ? `${positions.length} position${positions.length === 1 ? '' : 's'} · at the last indexed block`
                : `+${usdExact(portfolio.netChangeUsd)} · ${signedPct(portfolio.netChangePct)} all time`}
          </div>
        </div>
        {live ? (
          <div className="card stat">
            <div className="k">Uncollected fees</div>
            <div className={`v num${uncollectedUsd !== null && uncollectedUsd >= 0.5 ? ' up' : ''}`}>
              {empty ? '—' : uncollectedUsd !== null ? usdExact(uncollectedUsd) : '—'}
            </div>
            <div className="d">
              {empty
                ? why
                : uncollectedUsd !== null
                  ? readings.length === livePositions.length
                    ? 'read from the chain · collect from the row'
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
            <div className="v num">{empty || portfolio.feesEarnedWeth === null ? '—' : weth(portfolio.feesEarnedWeth)}</div>
            <div className="d">
              {empty ? why : portfolio.feesEarnedUsd === null ? 'not tracked' : usdExact(portfolio.feesEarnedUsd)}
            </div>
          </div>
        )}
        <div className="card stat">
          <div className="k">Price impact on holdings</div>
          <div className={`v num${impactClass}`}>{impactText}</div>
          <div className="d">{live ? 'vs holding the principal, at the same prices' : 'vs holding tokens'}</div>
        </div>
        {live ? (
          <div className="card stat">
            <div className="k">In range</div>
            <div className="v num">{empty ? '—' : `${inRange} of ${positions.length}`}</div>
            <div className="d">
              {empty
                ? why
                : positions.length - inRange === 0
                  ? 'every position is earning'
                  : `${positions.length - inRange} earning nothing`}
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
        <div className="card panel">
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
            <h2 className="sect-h">Daily fees · 8 weeks</h2>
            {hasHeatmap && (
              <span className="muted" style={{ fontSize: 12 }}>
                deeper green = more WETH
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
        <PositionList fees={fees} actions={actions} />
      </div>

      <TxHistory />
    </>
  );
}
