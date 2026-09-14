'use client';

import { useMarket } from '@/components/providers/MarketProvider';
import { FeeHeatmap } from '@/components/portfolio/FeeHeatmap';
import { PositionList } from '@/components/portfolio/PositionList';
import { signedPct, usdExact, weth } from '@/lib/format';

export function PortfolioBody() {
  const { portfolio } = useMarket();

  return (
    <>
      <div className="grid g4" style={{ marginBottom: 16 }}>
        <div className="card stat">
          <div className="k">Net value</div>
          <div className="v num">{usdExact(portfolio.netValueUsd)}</div>
          <div className="d up">
            +{usdExact(portfolio.netChangeUsd)} · {signedPct(portfolio.netChangePct)} all time
          </div>
        </div>
        <div className="card stat">
          <div className="k">Fees earned</div>
          <div className="v num">{weth(portfolio.feesEarnedWeth)}</div>
          <div className="d">{usdExact(portfolio.feesEarnedUsd)}</div>
        </div>
        <div className="card stat">
          {/* Impermanent loss, under the name that tells the truth (§7). */}
          <div className="k">Price impact on holdings</div>
          <div className="v num down">−{usdExact(Math.abs(portfolio.priceImpactUsd))}</div>
          <div className="d">vs holding tokens</div>
        </div>
        <div className="card stat">
          <div className="k">Fees · last 7d</div>
          <div className="v num up">{usdExact(portfolio.fees7dUsd)}</div>
          <div className="d up">Best week so far</div>
        </div>
      </div>

      <div className="grid g2">
        <div className="card panel">
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
            <h2 className="sect-h">Daily fees · 8 weeks</h2>
            <span className="muted" style={{ fontSize: 12 }}>
              deeper green = more WETH
            </span>
          </div>
          <FeeHeatmap values={portfolio.dailyFeesWeth} />
        </div>
        <PositionList />
      </div>
    </>
  );
}
