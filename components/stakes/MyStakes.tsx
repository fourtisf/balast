'use client';

import { useMarket } from '@/components/providers/MarketProvider';
import { useUi } from '@/components/providers/UiProvider';
import { TokenBadge } from '@/components/ui/TokenBadge';
import { countdown, usd, usdExact, weth } from '@/lib/format';

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

  // Nothing staked is not a failed search. Until the vaults exist and a
  // wallet is connected there is nothing here, and the card says that.
  if (portfolio.stakes.length === 0 && q === '') {
    return (
      <div className="card mine" style={{ marginTop: 22 }}>
        <h2 className="sect-h">Your stakes</h2>
        <div className="empty">
          <b>Nothing staked yet</b>Once vaults open and a wallet is connected, your stakes and
          their 7-day streams appear here.
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
          Claimable {portfolio.claimableWeth.toFixed(3)} WETH ·{' '}
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
                      <div className="n">{pool.token.symbol} / WETH</div>
                    </div>
                  </td>
                  <td className="r num" data-label="Staked">
                    {usd(stake.stakedUsd)}
                  </td>
                  <td className="r num up" data-label="Earned">
                    {weth(stake.earnedWeth, 2)}
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
                        onClick={() => showToast('Claimed to wallet')}
                      >
                        Claim
                      </button>
                      <button
                        className="btn btn-ghost btn-sm"
                        onClick={() => showToast('Compounded into stake')}
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
