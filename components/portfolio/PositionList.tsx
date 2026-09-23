'use client';

import { useRouter } from 'next/navigation';
import { formatUnits } from 'viem';
import { useMarket } from '@/components/providers/MarketProvider';
import { useUi } from '@/components/providers/UiProvider';
import { TokenBadge } from '@/components/ui/TokenBadge';
import { EXPLORER_URL } from '@/lib/chain';
import { getProvider } from '@/lib/data';
import type { TokenMeta, UserPosition } from '@/lib/data/types';
import { countdown, quoteLabel, usdExact } from '@/lib/format';
import { positionRef } from '@/lib/position-ref';
import { SHAPES } from '@/lib/shapes';
import { amount as fmtAmount } from '@/lib/v4/format';
import { feesUsd, type LiveFeesState } from './useLiveFees';
import type { PositionActions } from './usePositionActions';

/** A signed percent for a range bound: −12.5% / +12.5%. */
function pct(n: number): string {
  const digits = Math.abs(n) >= 10 ? 0 : 1;
  const sign = n < 0 ? '−' : '+';
  return `${sign}${Math.abs(n).toFixed(digits)}%`;
}

function since(hours: number): string {
  if (hours < 1) return 'less than an hour ago';
  if (hours < 48) return `${Math.round(hours)}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function PositionList({ fees, actions }: { fees: LiveFeesState; actions: PositionActions }) {
  const { portfolio, pools } = useMarket();
  const { query, wallet } = useUi();
  const router = useRouter();
  const live = getProvider().kind === 'live';

  // A live position's pool can sit below the listing bar and still be
  // someone's; its token rides on the position when the board has no row.
  const tokenOf = (position: UserPosition): TokenMeta | null =>
    pools.find((p) => p.id === position.poolId)?.token ?? position.live?.token ?? null;
  const q = query.trim().toLowerCase();
  const matchesToken = (token: TokenMeta | null) =>
    q === '' || (token !== null && (token.symbol.toLowerCase().includes(q) || token.name.toLowerCase().includes(q)));
  const positions = portfolio.positions.filter((p) => matchesToken(tokenOf(p)));
  const stakes = portfolio.stakes.filter((s) => matchesToken(pools.find((p) => p.id === s.poolId)?.token ?? null));
  // Out of range, and known to be: a pool the indexer has no price for is not
  // "stranded", it is unread (UserPosition.rangeUnknown).
  const stranded = positions.find((p) => !p.inRange && !p.rangeUnknown);
  const strandedToken = stranded ? tokenOf(stranded) : null;
  const strandedOnBoard = stranded ? pools.find((p) => p.id === stranded.poolId && p.stakeable) : undefined;

  return (
    <div className="card panel">
      <h2 style={{ fontWeight: 600, fontSize: 17, letterSpacing: '-.02em', marginBottom: 6 }}>
        Positions
      </h2>

      {positions.map((position) => {
        const token = tokenOf(position);
        if (!token) return null;
        const lp = position.live;
        const quote = lp ? quoteLabel(lp) : quoteLabel(pools.find((p) => p.id === position.poolId)!);
        const shape = position.shape ? SHAPES.find((s) => s.id === position.shape) : undefined;
        const rangeText =
          position.range === 'full'
            ? 'Full range'
            : position.range
              ? `${pct(position.range.minPct)} / ${pct(position.range.maxPct)}`
              : `${shape?.label ?? 'Position'} · ±${position.rangePct}%`;

        // Uncollected fees, from the chain (useLiveFees), in the token and
        // the quote and in dollars at the prices the value beside them used.
        const ref = positionRef(position);
        const entry = lp ? fees.fees.get(ref) : undefined;
        const feeUsd = lp ? feesUsd(position, fees.fees) : null;
        const tokenFees = entry && lp ? (lp.tokenIsCurrency0 ? entry.fees0 : entry.fees1) : null;
        const quoteFees = entry && lp ? (lp.tokenIsCurrency0 ? entry.fees1 : entry.fees0) : null;
        const hasFees = tokenFees !== null && quoteFees !== null && (tokenFees > 0n || quoteFees > 0n);
        const busy = actions.busy?.ref === ref ? actions.busy : null;
        const error = actions.error?.ref === ref ? actions.error.message : null;
        const done = actions.done?.ref === ref ? actions.done : null;
        const canAct = Boolean(lp) && !actions.busy;

        return (
          <div className="pnl-row" key={ref} data-token-id={position.tokenId} data-position={ref}>
            <div className="tok">
              <TokenBadge token={token} />
              <div>
                <div className="n">
                  {token.symbol} / {quote}
                  {lp && (
                    <span className="muted num" style={{ fontWeight: 400, fontSize: 12, marginLeft: 8 }}>
                      {/* v3 and v4 number their NFTs independently; the manager is part of the name. */}
                      {lp.protocol === 'v3' ? 'v3 ' : ''}#{position.tokenId}
                    </span>
                  )}
                </div>
                <div className="s">
                  {rangeText} ·{' '}
                  {position.rangeUnknown ? (
                    'range status not known yet — the pool has no indexed price'
                  ) : position.inRange ? (
                    'in range'
                  ) : (
                    // §7: out of range earns nothing. Say exactly that, in red.
                    <span className="down">out of range — earning nothing</span>
                  )}
                </div>
              </div>
            </div>
            <div style={{ textAlign: 'right', flex: '0 1 auto', minWidth: 0 }}>
              <div className="num" style={{ fontWeight: 600 }} title={position.valueUnknown ? 'No indexed price for this pool yet' : undefined}>
                {position.valueUnknown ? '—' : usdExact(position.valueUsd)}
              </div>
              {lp ? (
                <div
                  className={`num${hasFees ? ' up' : ' muted'}`}
                  style={{ fontSize: 12 }}
                  title="Uncollected fees, read from the chain now and valued at the last indexed block's prices. Collect sends them to your wallet."
                >
                  {entry
                    ? `+${fmtAmount(tokenFees!, token.decimals)} ${token.symbol} · +${fmtAmount(quoteFees!, lp.quoteDecimals)} ${quote} fees` +
                      (feeUsd !== null && feeUsd >= 0.5 ? ` ≈ ${usdExact(feeUsd)}` : '')
                    : fees.reading
                      ? 'reading fees from the chain…'
                      : fees.error
                        ? 'fees unreadable right now'
                        : 'fees not read'}
                </div>
              ) : (
                <div className="up num" style={{ fontSize: 12 }}>
                  +{(position.feesWeth ?? 0).toFixed(2)} ETH fees
                </div>
              )}
              {lp && (
                <div className="row" style={{ justifyContent: 'flex-end', marginTop: 8, gap: 6 }}>
                  <button
                    className="btn btn-ghost btn-sm"
                    disabled={!canAct || (entry !== undefined && !hasFees)}
                    title={entry !== undefined && !hasFees ? 'Nothing to collect yet' : 'Send the uncollected fees to your wallet'}
                    onClick={() => void actions.collect(position)}
                  >
                    Collect fees
                  </button>
                  <button
                    className="btn btn-ghost btn-sm"
                    disabled={!canAct}
                    title="Burn the position: its liquidity and its fees go to your wallet in one transaction"
                    onClick={() => void actions.withdraw(position)}
                  >
                    Withdraw
                  </button>
                </div>
              )}
              {busy && (
                <p className="hint" style={{ marginTop: 6 }} aria-live="polite">
                  {busy.label}
                </p>
              )}
              {error && (
                <p className="hint down" style={{ marginTop: 6 }} role="alert">
                  {error}
                </p>
              )}
              {done && !busy && !error && (
                <p className="hint" style={{ marginTop: 6 }}>
                  {done.kind === 'collect' ? 'Fees collected.' : 'Withdrawn.'}{' '}
                  <a href={`${EXPLORER_URL}/tx/${done.hash}`} target="_blank" rel="noopener noreferrer" style={{ textDecoration: 'underline' }}>
                    View the transaction
                  </a>
                </p>
              )}
            </div>
          </div>
        );
      })}

      {stakes.map((stake) => {
        const pool = pools.find((p) => p.id === stake.poolId);
        if (!pool) return null;
        return (
          <div className="pnl-row" key={stake.vaultId}>
            <div className="tok">
              <TokenBadge token={pool.token} />
              <div>
                <div className="n">{pool.token.symbol} stake</div>
                <div className="s">
                  Streaming · {countdown(stake.streamRemainingSeconds)}
                </div>
              </div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div className="num" style={{ fontWeight: 600 }}>
                {usdExact(stake.stakedUsd)}
              </div>
              <div className="up num" style={{ fontSize: 12 }}>
                +{stake.earnedWeth.toFixed(2)} ETH fees
              </div>
            </div>
          </div>
        );
      })}

      {live && portfolio.chain?.status === 'unavailable' && (
        <p className="hint" role="status" style={{ margin: '10px 0' }}>
          The chain did not answer just now, so the Uniswap v4 positions here are the indexer&rsquo;s record, not
          checked against the chain, and any minted since its last block are missing. Withdraw still asks the chain
          first. The page asks again on its next refresh.
        </p>
      )}
      {live && portfolio.chain?.v3Unavailable && (
        <p className="hint" role="status" style={{ margin: '10px 0' }}>
          Uniswap v3 positions could not be read from the chain just now, so any this wallet holds are not listed.
          The page asks again on its next refresh.
        </p>
      )}
      {live && portfolio.chain?.pricesStale && (
        <p className="hint" style={{ margin: '10px 0' }}>
          Pool prices could not be read live, so in-range status and amounts are as of the indexer&rsquo;s last block.
        </p>
      )}
      {live && (portfolio.chain?.unreadable ?? 0) > 0 && (
        <p className="hint" style={{ margin: '10px 0' }}>
          {portfolio.chain!.unreadable} position{portfolio.chain!.unreadable === 1 ? '' : 's'} this wallet holds could
          not be described from the chain, so {portfolio.chain!.unreadable === 1 ? 'it is' : 'they are'} not listed.
          Manage {portfolio.chain!.unreadable === 1 ? 'it' : 'them'} on Uniswap&rsquo;s own site.
        </p>
      )}
      {live && portfolio.chain?.partial && (
        <p className="hint" style={{ margin: '10px 0' }}>
          The scan for Uniswap v4 positions the indexer has not reached yet is still running, so one minted or
          received since its last block may be missing for a few minutes. A position minted here shows at once.
        </p>
      )}

      {positions.length === 0 && stakes.length === 0 && (
        <div className="empty">
          {q !== '' ? (
            <>
              <b>No match</b>Nothing in your portfolio matches that search.
            </>
          ) : live && !wallet ? (
            <>
              <b>Connect a wallet</b>Its positions — the NFTs Uniswap&rsquo;s v3 and v4 position managers minted to
              it — appear here, marked to market, with their uncollected fees read from the chain.
            </>
          ) : live ? (
            <>
              <b>No positions yet</b>Mint one from Positions, or stake from a pool. A v3 position appears on the next
              read; a v4 one once the indexer has read the block it was minted in.
            </>
          ) : (
            <>
              <b>No positions yet</b>Positions you mint and stakes you open appear here,
              marked to market, with the fees they earned.
            </>
          )}
        </div>
      )}

      {stranded && strandedToken && (
        <div className="alert">
          {strandedToken.symbol} left its range{' '}
          {stranded.outOfRangeSinceHours !== undefined ? since(stranded.outOfRangeSinceHours) : ''} and has earned
          nothing since.{' '}
          {strandedOnBoard ? (
            <>
              <button className="link" onClick={() => router.push(`/positions?pool=${encodeURIComponent(strandedOnBoard.id)}`)}>
                Rebalance
              </button>{' '}
              to start earning again{stranded.live ? ': withdraw it here, then mint a range around today’s price' : ''}.
            </>
          ) : stranded.live ? (
            'Withdraw it here, then mint a range around today’s price to start earning again.'
          ) : (
            <>
              <button className="link" onClick={() => router.push('/positions')}>
                Rebalance
              </button>{' '}
              to start earning again.
            </>
          )}
        </div>
      )}
    </div>
  );
}
