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
import { isEther } from '@/lib/chain';
import type { Pool, Quote } from '@/lib/data/types';
import { ageLabel, usd } from '@/lib/format';
import {
  YIELD_WINDOW_HOURS,
  feeYieldQualifier,
  feeYieldTitle,
  feeYieldValue,
  yieldPct,
} from '@/lib/yield';

/**
 * The two rankings the prototype kept on separate boards, as one list with
 * a facet. Volume ranks the whole listing; fee yield ranks the pools with a
 * real seven-day record (§10's assumption), and only those — a yield figure
 * from less data is not worth ranking on (§1, §7).
 */
type Facet = 'volume' | 'yield';

const FACETS: { id: Facet; label: string }[] = [
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
  const [facet, setFacet] = useState<Facet>('volume');
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

    if (facet === 'volume') {
      return matching.slice().sort((a, b) => b.volume24hUsd - a.volume24hUsd);
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
            {facet === 'volume'
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
                ? 'No pool has seven days of fees yet. Volume ranks everything.'
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

  // An FDV is marked, because calling it market cap overstates every token
  // with a vesting schedule (§7). Ether has no contract and no supply to
  // read (§18), which is a fact about ether, not a gap; any other token
  // with no supply read is a dash, not a guess (§15).
  const ether = isEther(pool.token.address);
  const capText = ether
    ? 'native asset'
    : pool.marketCapUsd > 0
      ? `${pool.marketCapIsFdv ? 'FDV' : 'MC'} ${usd(pool.marketCapUsd)}`
      : 'FDV —';
  const capTitle = ether
    ? "Ether is the chain's native asset: no token contract, no supply to read, so no FDV."
    : pool.marketCapUsd <= 0
      ? 'The token has not answered a supply read, so there is no figure to show.'
      : pool.marketCapIsFdv
        ? 'Fully diluted: total supply × price. Circulating supply is not ' +
          'distinguishable on chain, so locked and vested tokens are included.'
        : undefined;

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
              it already says. Unknown depth is a dash, not a zero (§14). */}
          <span className="s" title={pool.token.name}>
            <span title={capTitle}>{capText}</span> · depth{' '}
            {pool.tvlUsd > 0 ? usd(pool.tvlUsd) : '—'} · {pool.token.name}
          </span>
        </span>
      </button>

      {facet === 'volume' ? (
        <div className="lb-fig">
          <Flash as="div" className="big num" text={usd(pool.fees24hUsd)} />
          <span className="cap">fees · 24h</span>
        </div>
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
        text={pool.change24hPct === null ? '—' : pool.change24hPct.toFixed(1)}
      >
        <Change pct={pool.change24hPct} />
      </Flash>

      <div className="lb-spark">
        <AreaSpark values={pool.feeHistory} negative={(pool.change24hPct ?? 0) < 0} />
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
