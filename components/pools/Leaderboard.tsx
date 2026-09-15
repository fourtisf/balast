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

/** The buy side's share of the day's volume, for the split bar. Empty when there was none. */
function buyShare(buy: number, sell: number): number {
  const total = buy + sell;
  return total > 0 ? Math.round((buy / total) * 100) : 0;
}

/**
 * Whether the day's buys and sells are known. The split is derived from the
 * same swaps as the volume and always sums to it — so a volume with a split
 * of zero is a split that has not been computed for those hours yet (the
 * columns arrived by migration and are filled by the next rebuild), and it
 * is drawn as a dash rather than as $0 beside a volume that says otherwise.
 */
function splitKnown(pool: { volume24hUsd: number; buyVolume24hUsd: number; sellVolume24hUsd: number }): boolean {
  return pool.volume24hUsd <= 0 || pool.buyVolume24hUsd + pool.sellVolume24hUsd > 0;
}

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

/**
 * The figure a market-cap ranking sorts on: the market cap, or the fully
 * diluted figure while the token's holdings are still unread — the same
 * magnitude, and the row says which it is. Zero for a token with neither,
 * ether included: its market cap is not a figure this site can derive (§18),
 * so those rows follow the ranked ones, deepest first.
 */
function capKey(pool: Pool): number {
  return pool.marketCapUsd > 0 ? pool.marketCapUsd : pool.fdvUsd;
}

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

    if (facet === 'mc') {
      return matching
        .slice()
        .sort((a, b) => capKey(b) - capKey(a) || b.tvlUsd - a.tvlUsd);
    }
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
            {facet === 'mc'
              ? 'Ranked by market cap · fee yield appears at seven days of history'
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

  // Market cap first, from the supply less what the chain shows cannot
  // circulate; the fully diluted figure beside it only when the two differ,
  // because for a token with nothing burned they are one number. A token
  // whose holdings have not been read yet shows the FDV alone, labelled
  // (§7). Ether has no contract and no supply to read (§18), which is a fact
  // about ether, not a gap; any other token with nothing read is a dash.
  const ether = isEther(pool.token.address);
  const mc = pool.marketCapUsd;
  const fdv = pool.fdvUsd;
  const fdvDiffers = mc > 0 && fdv > mc * 1.01;
  const capText = ether
    ? 'native asset'
    : mc > 0
      ? `MC ${usd(mc)}${fdvDiffers ? ` · FDV ${usd(fdv)}` : ''}`
      : fdv > 0
        ? `FDV ${usd(fdv)}`
        : 'MC —';
  const capTitle = ether
    ? "Ether is the chain's native asset: no token contract, no supply to read, so no market cap."
    : mc > 0
      ? 'Market cap: circulating supply on this chain × price. Circulating is total supply less ' +
        "burned tokens and the token contract's own balance; vesting and treasury holdings " +
        'cannot be told apart on chain, so this can overstate, never understate.' +
        (fdvDiffers ? ' FDV counts the whole supply.' : '')
      : fdv > 0
        ? 'Fully diluted: total supply × price. The holdings that cannot circulate have not been ' +
          'read yet, so there is no market cap figure.'
        : 'The token has not answered a supply read, so there is no figure to show.';

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
            <span title={capTitle}>{capText}</span> · liquidity{' '}
            {pool.tvlUsd > 0 ? usd(pool.tvlUsd) : '—'} · {pool.token.name}
          </span>
        </span>
      </button>

      {/* Volume is on the row whatever the ranking, and beside it the buys
          and sells it is made of — the same swaps, split by which side paid.
          The fee figure left the row at the owner's request; fees remain the
          yield's basis, the masthead's headline and the drawer's line. */}
      <div className="lb-fig lb-vol">
        <Flash as="div" className="big num" text={usd(pool.volume24hUsd)} />
        <span className="cap">vol · 24h</span>
      </div>

      {facet !== 'yield' ? (
        <div
          className="lb-fig lb-split"
          title={
            splitKnown(pool)
              ? `${pool.buys24h.toLocaleString()} buys, ${pool.sells24h.toLocaleString()} sells over 24h`
              : 'Buys and sells are not split for these hours yet; the next rebuild fills them in.'
          }
        >
          <span className="lb-side">
            <Flash as="span" className="num" text={splitKnown(pool) ? usd(pool.buyVolume24hUsd) : '—'} />
            <span className="cap">buy</span>
          </span>
          <span className="lb-side">
            <Flash as="span" className="num" text={splitKnown(pool) ? usd(pool.sellVolume24hUsd) : '—'} />
            <span className="cap">sell</span>
          </span>
          <span className="lb-bar" role="presentation">
            <i style={{ width: `${splitKnown(pool) ? buyShare(pool.buyVolume24hUsd, pool.sellVolume24hUsd) : 0}%` }} />
          </span>
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
        <AreaSpark values={pool.volumeHistory} negative={(pool.change24hPct ?? 0) < 0} />
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
