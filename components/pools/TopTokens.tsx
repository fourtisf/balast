'use client';

import { usePools } from '@/components/providers/MarketProvider';
import { useUi } from '@/components/providers/UiProvider';
import { Change } from '@/components/ui/Change';
import { Flash } from '@/components/ui/Flash';
import { AreaSpark } from '@/components/ui/Sparkline';
import { TokenBadge } from '@/components/ui/TokenBadge';
import { quoteLabel, tokenPrice, usd } from '@/lib/format';
import { rankByCap, shownCap, shownChange, shownLiquidity, shownPrice, shownVolume } from '@/lib/market-figures';

/** How many cards lead the page. */
const TOP = 4;

/**
 * The page's opening row: the largest tokens as cards, the way a launchpad
 * leads with its biggest names. The order is the board's own market-cap
 * ranking (`rankByCap`), so a card never disagrees with the row beneath it,
 * and every figure comes from the same helpers the row uses.
 */
export function TopTokens() {
  const pools = usePools();
  const { openStake } = useUi();
  const top = rankByCap(pools).slice(0, TOP);
  if (top.length === 0) return null;

  return (
    <section className="tops" aria-label="Largest tokens">
      {top.map((pool, i) => {
        const cap = shownCap(pool);
        const change = shownChange(pool);
        const liquidity = shownLiquidity(pool);
        const capText = cap.value === null ? '—' : usd(cap.value);
        return (
          <button key={pool.id} className="top-card" onClick={() => openStake(pool.id)}>
            <span className="top-h">
              <TokenBadge token={pool.token} className="logo xl" />
              <span className="top-id">
                <span className="top-rank">#{i + 1}</span>
                <span className="top-sym">
                  {pool.token.symbol}
                  <span className="q"> / {quoteLabel(pool)}</span>
                </span>
                <span className="top-name">{pool.token.name}</span>
              </span>
              <Change pct={change.value} />
            </span>
            <span className="top-cap">
              <small>{cap.kind === 'fdv' ? 'FDV' : 'Market cap'}</small>
              <Flash as="span" className="num top-v" text={capText} />
            </span>
            <span className="top-spark" aria-hidden="true">
              <AreaSpark values={pool.volumeHistory} negative={(change.value ?? 0) < 0} width={260} height={44} />
            </span>
            <span className="top-grid">
              <span>
                <small>Price</small>
                <b className="num">{tokenPrice(shownPrice(pool).value)}</b>
              </span>
              <span>
                <small>Vol 24h</small>
                <b className="num">{usd(shownVolume(pool).value)}</b>
              </span>
              <span>
                <small>Liquidity</small>
                <b className="num">{liquidity.value === null ? '—' : usd(liquidity.value)}</b>
              </span>
            </span>
          </button>
        );
      })}
    </section>
  );
}
