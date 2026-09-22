'use client';

import { useMarket } from '@/components/providers/MarketProvider';
import { useUi } from '@/components/providers/UiProvider';
import { TokenBadge } from '@/components/ui/TokenBadge';
import { ageLabel, count, inHours, quoteLabel, usd } from '@/lib/format';
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

  // No vaults at all is a different fact from no vault matching a search.
  // Under §20 a stake is a full-range position minted to the wallet from the
  // board's drawer, and no vault contract streams anything — so this card
  // says where staking is, rather than promising a vault that is not coming.
  if (vaults.length === 0) {
    return (
      <div className="card">
        <div className="empty">
          <b>Stake from the board</b>Open any pool on the Pools page and use Stake: one full-range
          position, minted through Uniswap&rsquo;s PositionManager to your wallet, earning the
          pool&rsquo;s fee on every trade. No vault pools deposits and nothing here streams, so
          nothing is promised.
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
