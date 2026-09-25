'use client';

import Link from 'next/link';
import { useMemo } from 'react';
import { useMarket } from '@/components/providers/MarketProvider';
import { useUi } from '@/components/providers/UiProvider';
import { TokenBadge } from '@/components/ui/TokenBadge';
import { DATA_SOURCE } from '@/lib/data';
import type { Pool } from '@/lib/data/types';
import { ageLabel, feeTierLabel, quoteLabel, usd } from '@/lib/format';
import { shownVolume, shownYield, stalenessText, yieldCaption, yieldLabel, yieldTitle, yieldValue } from '@/lib/market-figures';
import { isMintable, orderMarkets, poolLiquidityUsd } from '@/lib/markets';

/** How many pools the list offers: a stake list, not the whole board. */
const SHOWN = 30;

/**
 * Stakes, as they exist under §20: one full-range position per stake, minted
 * through Uniswap to the wallet. There is no vault to list, so the page lists
 * what can be staked into — every listed token's best market Balast can mint
 * into, ranked by the fee yield it shows (a pool without one sorts after,
 * deepest first) — with the button that opens the builder on full range.
 *
 * The same target the board's drawer opens: the row's own pool when it can be
 * minted into, else the token's best mintable market (native ether first).
 */
export function StakeList() {
  const { pools, otherPools, indexerLagSeconds } = useMarket();
  const { query } = useUi();
  const live = DATA_SOURCE === 'live';
  const lag = stalenessText(indexerLagSeconds);

  const targets = useMemo(() => {
    const seen = new Set<string>();
    const out: Pool[] = [];
    for (const pool of pools) {
      const address = pool.token.address.toLowerCase();
      if (seen.has(address)) continue;
      seen.add(address);
      if (isMintable(pool, live)) {
        out.push(pool);
        continue;
      }
      const other = orderMarkets((otherPools ?? []).filter((p) => p.token.address.toLowerCase() === address && isMintable(p, live)))[0];
      if (other) out.push(other);
    }
    const key = (p: Pool) => shownYield(p).pct;
    return out.sort((a, b) => {
      const ya = key(a);
      const yb = key(b);
      if (ya !== null && yb !== null && ya !== yb) return yb - ya;
      if ((ya === null) !== (yb === null)) return ya === null ? 1 : -1;
      return (poolLiquidityUsd(b) ?? -1) - (poolLiquidityUsd(a) ?? -1);
    });
  }, [pools, otherPools, live]);

  const q = query.trim().toLowerCase();
  const shown = targets
    .filter((p) => q === '' || p.token.symbol.toLowerCase().includes(q) || p.token.name.toLowerCase().includes(q))
    .slice(0, SHOWN);

  // The strip over the list: what these pools hold and paid today, summed
  // from the rows beneath it (§12).
  const totals = shown.reduce(
    (acc, p) => {
      acc.liquidity += poolLiquidityUsd(p) ?? 0;
      acc.volume += shownVolume(p).value;
      acc.fees += p.now?.fees24hUsd ?? p.fees24hUsd;
      return acc;
    },
    { liquidity: 0, volume: 0, fees: 0 },
  );

  return (
    <div className="card mine stake-board">
      <div className="sb-head">
        <div>
          <h2 className="sect-h">Pools to stake</h2>
          <p className="hint" style={{ marginTop: 4 }}>
            Full range · to your wallet · no lockup · no LockFi fee
          </p>
        </div>
        <dl className="ph-stats">
          <div>
            <dt>Pools</dt>
            <dd className="num">{shown.length}</dd>
          </div>
          <div>
            <dt>Liquidity</dt>
            <dd className="num">{usd(totals.liquidity)}</dd>
          </div>
          <div>
            <dt>Volume 24h</dt>
            <dd className="num">{usd(totals.volume)}</dd>
          </div>
          <div>
            <dt>Fees 24h</dt>
            <dd className="num">{usd(totals.fees)}</dd>
          </div>
        </dl>
      </div>
      <div className="tbl-wrap" style={{ maxHeight: 'none' }}>
        <table className="tbl stake-tbl" data-testid="stake-list">
          <thead>
            <tr>
              <th scope="col">Pool</th>
              <th scope="col" className="r">
                Liquidity
              </th>
              <th scope="col" className="r">
                Volume 24h
              </th>
              <th scope="col" className="r">
                Fees 24h
              </th>
              <th scope="col" className="r">
                Fee yield
              </th>
              <th scope="col" className="r">
                <span className="sr-only">Stake</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {shown.map((pool) => {
              const y = shownYield(pool);
              const caption = yieldCaption(y, ageLabel(pool.ageHours), lag);
              const liquidity = poolLiquidityUsd(pool);
              const fees = pool.now?.fees24hUsd ?? pool.fees24hUsd;
              return (
                <tr key={pool.id} className="static">
                  <td data-label="Pool">
                    <div className="tok">
                      <TokenBadge token={pool.token} />
                      <div>
                        <div className="n">
                          {pool.token.symbol} <span className="q">/ {quoteLabel(pool)}</span>
                        </div>
                        <div className="chips">
                          <span className="chip">{pool.protocol === 'v3' ? 'v3' : 'v4'}</span>
                          <span className="chip">{feeTierLabel(pool.feeTierBps)}</span>
                        </div>
                      </div>
                    </div>
                  </td>
                  <td className="r num" data-label="Liquidity">
                    {liquidity === null ? '—' : usd(liquidity)}
                  </td>
                  <td className="r num" data-label="Volume 24h">
                    {usd(shownVolume(pool).value)}
                  </td>
                  <td className="r num" data-label="Fees 24h">
                    {usd(fees)}
                  </td>
                  <td className={`r num${y.pct === null ? '' : ' up'}`} data-label="Fee yield" title={yieldTitle(y)}>
                    <b className="yv">{yieldValue(y)}</b>
                    <div className="hint" style={{ marginTop: 2 }}>
                      {yieldLabel(y)}
                      {caption ? ` · ${caption}` : ''}
                    </div>
                  </td>
                  <td className="r">
                    <Link className="btn btn-brand btn-sm" href={`/positions?pool=${encodeURIComponent(pool.id)}&range=full`}>
                      Stake
                    </Link>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {shown.length === 0 && (
          <div className="empty">
            {q ? (
              <>
                <b>No match</b>No stakeable pool matches that search.
              </>
            ) : (
              <>
                <b>Nothing to stake yet</b>No listed pool can be minted into here yet — either none clears the listing
                bar, or each runs a hook LockFi has not verified.
              </>
            )}
          </div>
        )}
      </div>
      <p className="hint" style={{ marginTop: 12 }}>
        Hold only ETH or USDG? That is enough: part of it is swapped for the token in the same pool first. Fee yield is
        what the pool paid its liquidity, not a promise.
      </p>
    </div>
  );
}
