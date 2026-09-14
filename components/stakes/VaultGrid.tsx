'use client';

import { useMarket } from '@/components/providers/MarketProvider';
import { useUi } from '@/components/providers/UiProvider';
import { TokenBadge } from '@/components/ui/TokenBadge';
import { ageLabel, count, inHours, usd } from '@/lib/format';
import { FEE_YIELD_LABEL, feeYieldQualifier, feeYieldTitle, feeYieldValue } from '@/lib/yield';

export function VaultGrid() {
  const { vaults, pools } = useMarket();
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

  // No vaults at all is a different fact from no vault matching a search:
  // the contracts are not deployed yet (§8, P2), and the page should say so
  // rather than suggest clearing a search that is not the reason.
  if (vaults.length === 0) {
    return (
      <div className="card">
        <div className="empty">
          <b>No vaults yet</b>Staking opens when the vault contracts deploy. Until then every
          pool is listed and nothing is staked or promised.
        </div>
      </div>
    );
  }
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
        const qualifier = feeYieldQualifier(pool.feeYield, age);
        const none = pool.feeYield.basis === 'insufficient';

        return (
          <div className="card vault" key={vault.id}>
            <div className="top-r2">
              <div className="tok">
                <TokenBadge token={pool.token} />
                <div>
                  <div className="n">{pool.token.symbol} / WETH</div>
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

            <div className={`apr num${none ? ' none' : ''}`} title={feeYieldTitle(pool.feeYield)}>
              {feeYieldValue(pool.feeYield)}
              {qualifier && <span className="est">{qualifier}</span>}
              <small>{FEE_YIELD_LABEL} · paid in WETH</small>
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
