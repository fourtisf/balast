'use client';

import Link from 'next/link';
import { useMarket } from '@/components/providers/MarketProvider';
import { useUi } from '@/components/providers/UiProvider';
import { TokenBadge } from '@/components/ui/TokenBadge';
import { countdown, quoteLabel, usd, usdExact, ether } from '@/lib/format';

export function MyStakes() {
  const { portfolio, pools, global } = useMarket();
  const { showToast, query } = useUi();

  const q = query.trim().toLowerCase();
  const stakes = portfolio.stakes.filter((stake) => {
    if (q === '') return true;
    const pool = pools.find((p) => p.id === stake.poolId);
    if (!pool) return false;
    return (
      pool.token.symbol.toLowerCase().includes(q) || pool.token.name.toLowerCase().includes(q)
    );
  });

  // Nothing staked is not a failed search. A live stake is a position NFT in
  // the wallet (§20), read back from the chain on the Portfolio page, which is
  // where its fees are collected and it is withdrawn.
  if (portfolio.stakes.length === 0 && q === '') {
    const full = portfolio.positions.filter((p) => p.range === 'full');
    return (
      <div className="card mine" style={{ marginTop: 22 }}>
        <h2 className="sect-h">Your stakes</h2>
        <div className="empty">
          <b>{full.length > 0 ? `${full.length} full-range position${full.length === 1 ? '' : 's'} in this wallet` : 'Nothing staked from this wallet yet'}</b>
          A stake is a position NFT in your wallet, read back from the chain. Its uncollected fees, Collect and Withdraw
          are on the <Link href="/portfolio">Portfolio</Link> page.
        </div>
      </div>
    );
  }

  return (
    <div className="card mine" style={{ marginTop: 22 }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 12,
          marginBottom: 6,
          flexWrap: 'wrap',
        }}
      >
        <h2 className="sect-h">Your stakes</h2>
        <span className="pill weth">
          Claimable {portfolio.claimableWeth.toFixed(3)} ETH ·{' '}
          {usdExact(portfolio.claimableWeth * global.ethPriceUsd)}
        </span>
      </div>

      <div className="tbl-wrap" style={{ maxHeight: 'none' }}>
        <table className="tbl">
          <thead>
            <tr>
              <th scope="col">Pool</th>
              <th scope="col" className="r">
                Staked
              </th>
              <th scope="col" className="r">
                Earned
              </th>
              <th scope="col">Stream</th>
              <th scope="col" className="r">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {stakes.map((stake) => {
              const pool = pools.find((p) => p.id === stake.poolId);
              if (!pool) return null;
              return (
                <tr key={stake.vaultId} className="static">
                  <td data-label="Pool">
                    <div className="tok">
                      <TokenBadge token={pool.token} />
                      <div className="n">{pool.token.symbol} / {quoteLabel(pool)}</div>
                    </div>
                  </td>
                  <td className="r num" data-label="Staked">
                    {usd(stake.stakedUsd)}
                  </td>
                  <td className="r num up" data-label="Earned">
                    {ether(stake.earnedWeth, 2)}
                  </td>
                  <td style={{ minWidth: 180 }} data-label="Stream">
                    <div
                      className="stream"
                      role="progressbar"
                      aria-valuenow={Math.round(stake.streamProgressPct)}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-label={`${pool.token.symbol} 7-day stream`}
                    >
                      <i style={{ width: `${stake.streamProgressPct}%` }} />
                    </div>
                    <div className="hint" style={{ marginTop: 4 }}>
                      {countdown(stake.streamRemainingSeconds)}
                    </div>
                  </td>
                  <td className="r">
                    <div className="row" style={{ justifyContent: 'flex-end' }}>
                      <button
                        className="btn btn-ghost btn-sm"
                        onClick={() => showToast('Simulated data. Nothing was claimed.')}
                      >
                        Claim
                      </button>
                      <button
                        className="btn btn-ghost btn-sm"
                        onClick={() => showToast('Simulated data. Nothing was compounded.')}
                      >
                        Compound
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {stakes.length === 0 && (
          <div className="empty">
            <b>No match</b>None of your stakes match that search.
          </div>
        )}
      </div>
    </div>
  );
}
