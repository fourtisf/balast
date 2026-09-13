'use client';

import { useMarket } from '@/components/providers/MarketProvider';
import { useUi } from '@/components/providers/UiProvider';
import { Mark } from '@/components/shell/Logo';
import { AreaChart, AreaSpark } from '@/components/ui/Sparkline';
import { TokenBadge } from '@/components/ui/TokenBadge';
import { count, signedPct, usd, usdExact } from '@/lib/format';
import { yieldPct } from '@/lib/yield';

export function Featured() {
  const { featured } = useMarket();

  const metrics = [
    { k: 'Fees paid · 24h', v: usdExact(featured.fees24hUsd) },
    { k: '24h', v: signedPct(featured.change24hPct), up: featured.change24hPct >= 0 },
    { k: 'Vol 24h', v: usd(featured.volume24hUsd) },
    { k: 'Liquidity', v: usd(featured.liquidityUsd) },
    { k: 'Stakers', v: count(featured.stakers) },
    { k: 'Chain share', v: `${featured.chainSharePct.toFixed(1)}%` },
  ];

  return (
    <div className="card feat">
      <div className="fh">
        {/* Depth's own pool, so it carries the mark rather than a monogram. */}
        <div className="fl" style={{ background: 'var(--ac)' }}>
          <Mark size={30} color="var(--on-ac)" title="Depth" />
        </div>
        <div className="fn">DEPTH</div>
      </div>
      <div className="fg">
        {metrics.map((m) => (
          <div key={m.k}>
            <div className="k">{m.k}</div>
            <div className={`v num${m.up === undefined ? '' : m.up ? ' up' : ' down'}`}>{m.v}</div>
          </div>
        ))}
      </div>
      <AreaChart values={featured.history} className="spark" />
    </div>
  );
}

/** Most traded and highest fee yield — both open the stake drawer. */
export function MiniCards() {
  const { pools } = useMarket();
  const { openStake } = useUi();

  const mostTraded = pools.reduce((a, b) => (b.volume24hUsd > a.volume24hUsd ? b : a));
  const bestYield = pools
    .filter((p) => p.feeYield.basis === 'trailing7d')
    .reduce((a, b) => (yieldPct(b.feeYield) > yieldPct(a.feeYield) ? b : a));

  return (
    <div className="mini-cards">
      <button className="card mc" onClick={() => openStake(mostTraded.id)}>
        <div className="lab">Most traded · 24h</div>
        <div className="r">
          <TokenBadge token={mostTraded.token} className="l" />
          <div>
            <div className="n">{mostTraded.token.symbol}</div>
            <div className="sub">
              <b>{count(mostTraded.trades24h)} trades</b> · {usd(mostTraded.marketCapUsd)} MC
            </div>
          </div>
        </div>
        <div className="spark">
          <AreaSpark values={mostTraded.feeHistory} negative={false} />
        </div>
      </button>

      <button className="card mc" onClick={() => openStake(bestYield.id)}>
        <div className="lab">Highest fee yield · trailing 7d</div>
        <div className="r">
          <TokenBadge token={bestYield.token} className="l" />
          <div>
            <div className="n">{bestYield.token.symbol}</div>
            <div className="sub">
              <b>{usd(bestYield.fees24hUsd)} fees</b> · {usd(bestYield.volume24hUsd)} vol
            </div>
          </div>
        </div>
        <div className="spark">
          <AreaSpark values={bestYield.feeHistory} negative={false} />
        </div>
      </button>
    </div>
  );
}
