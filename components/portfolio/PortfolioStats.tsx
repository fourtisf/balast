'use client';

import { useMarket } from '@/components/providers/MarketProvider';
import { FeeHeatmap } from '@/components/portfolio/FeeHeatmap';
import { PositionList } from '@/components/portfolio/PositionList';
import { signedPct, usdExact, weth } from '@/lib/format';

export function PortfolioBody() {
  const { portfolio } = useMarket();

  // No positions and no stakes is a portfolio with nothing in it, and a card
  // reading "$0 · +0.0% all time" is a claim about a history that does not
  // exist (§7). The figures are dashes and the captions say why.
  const empty = portfolio.positions.length === 0 && portfolio.stakes.length === 0;

  return (
    <>
      <div className="grid g4" style={{ marginBottom: 16 }}>
        <div className="card stat">
          <div className="k">Net value</div>
          <div className="v num">{empty ? '—' : usdExact(portfolio.netValueUsd)}</div>
          <div className={`d${empty ? '' : ' up'}`}>
            {empty
              ? 'no positions yet'
              : `+${usdExact(portfolio.netChangeUsd)} · ${signedPct(portfolio.netChangePct)} all time`}
          </div>
        </div>
        <div className="card stat">
          <div className="k">Fees earned</div>
          <div className="v num">{empty ? '—' : weth(portfolio.feesEarnedWeth)}</div>
          <div className="d">{empty ? 'nothing earned yet' : usdExact(portfolio.feesEarnedUsd)}</div>
        </div>
        <div className="card stat">
          {/* Impermanent loss, under the name that tells the truth (§7). */}
          <div className="k">Price impact on holdings</div>
          <div className={`v num${empty ? '' : ' down'}`}>
            {empty ? '—' : `−${usdExact(Math.abs(portfolio.priceImpactUsd))}`}
          </div>
          <div className="d">vs holding tokens</div>
        </div>
        <div className="card stat">
          <div className="k">Fees · last 7d</div>
          <div className={`v num${empty ? '' : ' up'}`}>
            {empty ? '—' : usdExact(portfolio.fees7dUsd)}
          </div>
          <div className="d">
            {empty ? 'nothing earned yet' : `of ${usdExact(portfolio.feesEarnedUsd)} all time`}
          </div>
        </div>
      </div>

      <div className="grid g2">
        <div className="card panel">
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
            <h2 className="sect-h">Daily fees · 8 weeks</h2>
            {!empty && (
              <span className="muted" style={{ fontSize: 12 }}>
                deeper green = more WETH
              </span>
            )}
          </div>
          {empty ? (
            <div className="empty">
              <b>No fees yet</b>The daily grid fills in as your positions earn.
            </div>
          ) : (
            <FeeHeatmap values={portfolio.dailyFeesWeth} />
          )}
        </div>
        <PositionList />
      </div>
    </>
  );
}
