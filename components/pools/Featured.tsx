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
        {/* Balast's own pool, so it carries the mark rather than a monogram. */}
        <div className="fl" style={{ background: 'var(--ac)' }}>
          <Mark size={30} color="var(--on-ac)" title="Balast" />
        </div>
        <div className="fn">BALAST</div>
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

  // Both can be empty on a live chain — every pool unpriced during a first
  // sync, or none yet with seven days of fees — and `reduce` with no initial
  // value throws on an empty array. It did, and took the whole page down to
  // the error boundary over a card that should simply have said "not yet".
  const mostTraded = maxBy(pools, (p) => p.volume24hUsd);
  const bestYield = maxBy(
    pools.filter((p) => p.feeYield.basis === 'trailing7d'),
    (p) => yieldPct(p.feeYield),
  );

  if (!mostTraded) {
    return (
      <div className="mini-cards">
        <MiniEmpty label="Most traded · 24h" why="No priced pool yet." />
        <MiniEmpty label="Highest fee yield · trailing 7d" why="No pool with seven days of fees yet." />
      </div>
    );
  }

  return (
    <div className="mini-cards">
      <button className="card mc" onClick={() => openStake(mostTraded.id)}>
        <div className="lab">Most traded · 24h</div>
        <div className="r">
          <TokenBadge token={mostTraded.token} className="l" />
          <div>
            <div className="n">{mostTraded.token.symbol}</div>
            <div className="sub">
              <b>{count(mostTraded.trades24h)} trades</b> ·{' '}
              {usd(mostTraded.marketCapUsd)} {mostTraded.marketCapIsFdv ? 'FDV' : 'MC'}
            </div>
          </div>
        </div>
        <div className="spark">
          <AreaSpark values={mostTraded.feeHistory} negative={false} />
        </div>
      </button>

      {bestYield ? (
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
      ) : (
        // §7: a yield is trailing 7d or it is not shown. Until one pool has
        // seven days of fees, this card has nothing honest to rank.
        <MiniEmpty label="Highest fee yield · trailing 7d" why="No pool with seven days of fees yet." />
      )}
    </div>
  );
}

/** The largest by `key`, or null for an empty list — never a throw. */
function maxBy<T>(list: T[], key: (item: T) => number): T | null {
  let best: T | null = null;
  for (const item of list) {
    if (best === null || key(item) > key(best)) best = item;
  }
  return best;
}

/** A mini card with nothing to rank yet. Same frame, no button — there is nothing to open. */
function MiniEmpty({ label, why }: { label: string; why: string }) {
  return (
    <div className="card mc mc-empty" role="status">
      <div className="lab">{label}</div>
      <div className="sub">{why}</div>
    </div>
  );
}
