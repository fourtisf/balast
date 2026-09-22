'use client';

import { useMemo, useState } from 'react';
import { usePools } from '@/components/providers/MarketProvider';
import { useUi } from '@/components/providers/UiProvider';
import { Change } from '@/components/ui/Change';
import { Flash } from '@/components/ui/Flash';
import { AreaSpark } from '@/components/ui/Sparkline';
import { TokenBadge } from '@/components/ui/TokenBadge';
import { useFlip } from '@/hooks/useFlip';
import { useReducedMotion } from '@/hooks/useReducedMotion';
import type { Pool, Quote } from '@/lib/data/types';
import { ageLabel, usd } from '@/lib/format';
import { ago, buyShare, rankByCap, shownCap, shownChange, shownLiquidity, shownSplit, shownVolume, sourceName } from '@/lib/market-figures';
import {
  YIELD_WINDOW_HOURS,
  feeYieldQualifier,
  feeYieldTitle,
  feeYieldValue,
  yieldPct,
} from '@/lib/yield';

/**
 * Three rankings as one list with a facet. Market cap is the default, by the
 * owner's call: the board should lead with the largest projects. Volume ranks
 * the whole listing too; fee yield ranks the pools with a real seven-day
 * record (§10's assumption), and only those — a yield figure from less data
 * is not worth ranking on (§1, §7).
 */
type Facet = 'mc' | 'volume' | 'yield';

const FACETS: { id: Facet; label: string }[] = [
  { id: 'mc', label: 'By market cap' },
  { id: 'volume', label: 'By volume' },
  { id: 'yield', label: 'By fee yield' },
];

const FILTERS: { id: 'all' | Quote; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'ETH', label: 'ETH' },
  { id: 'USDG', label: 'USDG' },
];

export function Leaderboard() {
  const pools = usePools();
  const { query, openStake } = useUi();
  const [facet, setFacet] = useState<Facet>('mc');
  const [filter, setFilter] = useState<'all' | Quote>('all');
  const reduced = useReducedMotion();
  const register = useFlip(!reduced);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matching = pools
      .filter((p) => filter === 'all' || p.quote === filter)
      .filter(
        (p) =>
          q === '' ||
          p.token.symbol.toLowerCase().includes(q) ||
          p.token.name.toLowerCase().includes(q),
      );

    if (facet === 'mc') return rankByCap(matching);
    if (facet === 'volume') {
      return matching.slice().sort((a, b) => shownVolume(b).value - shownVolume(a).value);
    }
    return matching
      .filter((p) => p.ageHours >= YIELD_WINDOW_HOURS)
      .slice()
      .sort((a, b) => yieldPct(b.feeYield) - yieldPct(a.feeYield));
  }, [pools, filter, query, facet]);

  return (
    <section className="lb" aria-labelledby="lb-title">
      <div className="lb-h">
        <div>
          <h2 className="lb-title" id="lb-title">
            Leaderboard
          </h2>
          <p className="lb-sub">
            {facet === 'mc'
              ? 'Ranked by market cap · tokens with no volume today rank last · fee yield appears at seven days of history'
              : facet === 'volume'
                ? 'Ranked by 24h volume · fee yield appears at seven days of history'
                : 'Ranked by fee yield, trailing 7d · only pools with seven days of history'}
          </p>
        </div>
        <div className="row">
          <div className="seg" role="group" aria-label="Rank by">
            {FACETS.map((f) => (
              <button
                key={f.id}
                className={facet === f.id ? 'on' : undefined}
                aria-pressed={facet === f.id}
                onClick={() => setFacet(f.id)}
              >
                {f.label}
              </button>
            ))}
          </div>
          <div className="seg" role="group" aria-label="Quote filter">
            {FILTERS.map((f) => (
              <button
                key={f.id}
                className={filter === f.id ? 'on' : undefined}
                aria-pressed={filter === f.id}
                onClick={() => setFilter(f.id)}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <ol className="lb-rows">
        {rows.length === 0 && (
          <li className="lb-empty">
            <div className="empty">
              <b>{facet === 'yield' && query.trim() === '' ? 'Nothing to rank yet' : 'No match'}</b>
              {facet === 'yield' && query.trim() === ''
                ? 'No pool has seven days of fees yet. Market cap and volume rank everything.'
                : 'Try a ticker, or clear the search.'}
            </div>
          </li>
        )}
        {rows.map((pool, i) => (
          <Row
            key={pool.id}
            pool={pool}
            rank={i + 1}
            leader={i === 0}
            facet={facet}
            registerRef={register(pool.id)}
            onOpen={() => openStake(pool.id)}
          />
        ))}
      </ol>
    </section>
  );
}

function Row({
  pool,
  rank,
  leader,
  facet,
  registerRef,
  onOpen,
}: {
  pool: Pool;
  rank: number;
  leader: boolean;
  facet: Facet;
  registerRef: (el: HTMLElement | null) => void;
  onOpen: () => void;
}) {
  const age = ageLabel(pool.ageHours);
  const qualifier = feeYieldQualifier(pool.feeYield, age);
  const yieldText = feeYieldValue(pool.feeYield);
  const insufficient = pool.feeYield.basis === 'insufficient';

  // Market cap, liquidity and the day's figures: which source each comes
  // from is decided once in lib/market-figures.ts, so the row, the drawer
  // and the ranking cannot disagree about it. What the row adds is the
  // words — every figure says, in its tooltip, which source answered and
  // how old the answer is (§7).
  const cap = shownCap(pool);
  const liquidity = shownLiquidity(pool);
  const volume = shownVolume(pool);
  const change = shownChange(pool);
  const split = shownSplit(pool);
  const source = sourceName(pool);
  const quoted = pool.market ? `${source}, ${ago(pool.market.at)}` : 'indexed swaps';
  const across =
    pool.market && pool.market.pairs > 1
      ? ` across the token's ${pool.market.pairs} pairs on this chain`
      : pool.market
        ? " across the token's pools on this chain"
        : '';

  const capText =
    cap.kind === 'native'
      ? 'native asset'
      : cap.kind === 'mc'
        ? `MC ${usd(cap.value as number)}${cap.fdvBeside ? ` · FDV ${usd(cap.fdvBeside)}` : ''}`
        : cap.kind === 'fdv'
          ? `FDV ${usd(cap.value as number)}`
          : 'MC —';
  const capTitle =
    cap.kind === 'native'
      ? "Ether is the chain's native asset: no token contract, no supply to read, so no market cap."
      : cap.kind === 'mc'
        ? (cap.basis === 'live'
            ? `Market cap from ${quoted}: circulating supply × today's price.`
            : 'Market cap from the chain: circulating supply × the price at the last indexed block. ' +
              'Circulating is total supply less burned tokens and the token contract\'s own balance; ' +
              'vesting and treasury holdings cannot be told apart on chain, so this can overstate, never understate.') +
          (cap.fdvBeside ? ' FDV counts the whole supply.' : '')
        : cap.kind === 'fdv'
          ? `Fully diluted: total supply × price, from ${quoted}. There is no circulating figure for this token, ` +
            'and the whole supply presented as a market cap would overstate it.'
          : 'No source has a supply for this token, so there is no figure to show.';

  const liquidityText = liquidity.value === null ? '—' : usd(liquidity.value);
  const liquidityTitle =
    liquidity.value === null
      ? "This pool's own events do not reconcile to a positive reserve — usually a hook keeping its own " +
        'accounting — so its liquidity is unknown rather than zero, and no source has it either.'
      : liquidity.basis === 'chain'
        ? "This pool's liquidity, both sides, from its own indexed events."
        : liquidity.scope === 'pool'
          ? `This pool's liquidity from ${quoted}. The chain's own events do not reconcile to a positive reserve.`
          : `The token's liquidity across its pools, from ${quoted} — not this pool's, which the chain's ` +
            'own events do not reconcile to a positive reserve.';

  return (
    <li ref={registerRef} className={`lb-row${leader ? ' lead' : ''}`} onClick={onOpen}>
      <span className="rk" aria-hidden="true">
        {String(rank).padStart(2, '0')}
      </span>

      {/* A button, so every row is keyboard-reachable at every width — the
          Stake button's column is hidden on a phone. */}
      <button
        className="tok tok-btn"
        onClick={(e) => {
          e.stopPropagation();
          onOpen();
        }}
      >
        <TokenBadge token={pool.token} className="logo lg" />
        <span className="tok-id">
          <span className="n">{pool.token.symbol}</span>
          {/* Figures first, name last: the line clips at the end when the
              column is narrow, and the name is the one part the symbol above
              it already says. Unknown liquidity is a dash, not a zero (§14). */}
          <span className="s" title={pool.token.name}>
            <span title={capTitle}>{capText}</span> ·{' '}
            <span title={liquidityTitle}>liquidity {liquidityText}</span> · {pool.token.name}
          </span>
        </span>
      </button>

      {/* Volume is on the row whatever the ranking, and beside it the buys
          and sells it is made of. Live, both are the token's across its
          pairs — a token here has several pools, and reading the day off
          one of them was what put $17.9K on NVDA. The fee figure left the
          row at the owner's request; fees remain the yield's basis, the
          masthead's headline and the drawer's line. */}
      <div
        className="lb-fig lb-vol"
        title={
          volume.basis === 'live'
            ? `Volume over the last 24 hours from ${quoted}${across}` +
              (pool.market && pool.market.pairs > 0
                ? ` (deepest: ${pool.market.dexId || 'pair'} ${pool.market.pairAddress.slice(0, 10)}…)`
                : '')
            : pool.market === null
              ? "Volume over the last 24 hours of chain time in this pool, from indexed swaps. No aggregator has a fresh quote for this token."
              : 'Volume over the last 24 hours of chain time in this pool, from indexed swaps.'
        }
      >
        <Flash as="div" className="big num" text={usd(volume.value)} />
        <span className="cap">
          vol · 24h{volume.basis === 'live' ? ' · live' : pool.market === null ? ' · chain' : ''}
        </span>
      </div>

      {facet !== 'yield' ? (
        split === null ? (
          // The chain's split is derived from the same swaps as its volume
          // and always sums to it, so a volume with no split is a split not
          // yet computed for those hours — a dash, not a $0 that disagrees
          // with the figure beside it.
          <div
            className="lb-fig lb-split"
            title="Buys and sells are not split for these hours yet; the next rebuild fills them in."
          >
            <span className="lb-side">
              <span className="num">—</span>
              <span className="cap">buy</span>
            </span>
            <span className="lb-side">
              <span className="num">—</span>
              <span className="cap">sell</span>
            </span>
            <span className="lb-bar" role="presentation">
              <i style={{ width: '0%' }} />
            </span>
          </div>
        ) : (
          <div
            className="lb-fig lb-split"
            title={
              split.unit === 'trades'
                ? `${split.buys.toLocaleString()} buys and ${split.sells.toLocaleString()} sells over 24h ` +
                  `from ${quoted}${across}. The feed splits the day into trades, not dollars.`
                : `${usd(split.buys)} bought and ${usd(split.sells)} sold over 24h in this pool, from indexed swaps`
            }
          >
            <span className="lb-side">
              <Flash
                as="span"
                className="num"
                text={split.unit === 'trades' ? split.buys.toLocaleString() : usd(split.buys)}
              />
              <span className="cap">{split.unit === 'trades' ? 'buys' : 'buy'}</span>
            </span>
            <span className="lb-side">
              <Flash
                as="span"
                className="num"
                text={split.unit === 'trades' ? split.sells.toLocaleString() : usd(split.sells)}
              />
              <span className="cap">{split.unit === 'trades' ? 'sells' : 'sell'}</span>
            </span>
            <span className="lb-bar" role="presentation">
              <i style={{ width: `${buyShare(split.buys, split.sells)}%` }} />
            </span>
          </div>
        )
      ) : (
        <div className="lb-fig">
          <Flash
            as="div"
            className={`big num${insufficient ? ' muted' : ' up'}`}
            text={yieldText}
            title={feeYieldTitle(pool.feeYield)}
          >
            {yieldText}
            {qualifier && <span className="est">{qualifier}</span>}
          </Flash>
          <span className="cap">fee yield · trailing 7d</span>
        </div>
      )}

      <Flash
        as="div"
        className="lb-chg"
        text={change.value === null ? '—' : change.value.toFixed(1)}
        title={
          change.basis === 'live'
            ? `24h price change from ${quoted}, on the deepest pair`
            : '24h price change from indexed swaps, in this pool'
        }
      >
        <Change pct={change.value} />
      </Flash>

      <div className="lb-spark" title="Volume by 12-hour bucket over the trailing week, from indexed swaps">
        <AreaSpark values={pool.volumeHistory} negative={(change.value ?? 0) < 0} />
        <button
          className="stake-btn"
          onClick={(e) => {
            e.stopPropagation();
            onOpen();
          }}
        >
          {pool.stakeable ? 'Stake' : 'View'}
          <span className="sr-only"> {pool.token.symbol}</span>
        </button>
      </div>
    </li>
  );
}
