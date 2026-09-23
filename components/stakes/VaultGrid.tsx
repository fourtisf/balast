'use client';

import { useMarket } from '@/components/providers/MarketProvider';
import { useUi } from '@/components/providers/UiProvider';
import { StakeList } from '@/components/stakes/StakeList';
import { TokenBadge } from '@/components/ui/TokenBadge';
import { ageLabel, count, inHours, quoteLabel, usd } from '@/lib/format';
import { shownYield, stalenessText, yieldCaption, yieldLabel, yieldTitle, yieldValue } from '@/lib/market-figures';

export function VaultGrid() {
  const { vaults, pools, indexerLagSeconds } = useMarket();
  const { openStake, query } = useUi();

  const q = query.trim().toLowerCase();
  const matching = vaults.filter((vault) => {
    if (q === '') return true;
    const pool = pools.find((p) => p.id === vault.poolId);
    if (!pool) return false;
    return (
      pool.token.symbol.toLowerCase().includes(q) || pool.token.name.toLowerCase().includes(q)
    );
  });

  // No vaults at all is a different fact from no vault matching a search.
  // Under §20 a stake is a full-range position minted to the wallet and no
  // vault contract exists, so the page lists what can be staked into instead.
  if (vaults.length === 0) return <StakeList />;
  if (matching.length === 0) {
    return (
      <div className="card">
        <div className="empty">
          <b>No vault matches</b>Try a ticker, or clear the search.
        </div>
      </div>
    );
  }

  return (
    <div className="vaults">
      {matching.map((vault) => {
        const pool = pools.find((p) => p.id === vault.poolId);
        if (!pool) return null;
        const age = ageLabel(pool.ageHours);
        const shown = shownYield(pool);
        const qualifier = yieldCaption(shown, age, stalenessText(indexerLagSeconds));
        const none = shown.pct === null;

        return (
          <div className="card vault" key={vault.id}>
            <div className="top-r2">
              <div className="tok">
                <TokenBadge token={pool.token} />
                <div>
                  <div className="n">{pool.token.symbol} / {quoteLabel(pool)}</div>
                  <div className="s" title={pool.token.name}>
                    {pool.token.name}
                  </div>
                </div>
              </div>
              {pool.quote === 'USDG' ? (
                <span className="pill grey">Stock</span>
              ) : pool.ageHours < 10 * 24 ? (
                <span className="pill brand">New</span>
              ) : null}
            </div>

            <div className={`apr num${none ? ' none' : ''}`} title={yieldTitle(shown)}>
              {yieldValue(shown)}
              {qualifier && <span className="est">{qualifier}</span>}
              <small>{yieldLabel(shown)}</small>
            </div>

            <div className="meta">
              <span>
                Staked
                <b className="num">{usd(vault.totalStakedUsd)}</b>
              </span>
              <span>
                Fees 24h
                <b className="num">{usd(pool.fees24hUsd)}</b>
              </span>
              <span>
                Stakers
                <b className="num">{count(vault.stakers)}</b>
              </span>
              <span>
                Next harvest
                <b>{inHours(vault.nextHarvestInSeconds)}</b>
              </span>
            </div>

            <button
              className="btn btn-ghost"
              style={{ justifyContent: 'center' }}
              onClick={() => openStake(pool.id)}
            >
              Stake {pool.token.symbol}
            </button>
          </div>
        );
      })}
    </div>
  );
}
