'use client';

import { useMemo, useState } from 'react';
import { useMarket, usePools } from '@/components/providers/MarketProvider';
import { useUi } from '@/components/providers/UiProvider';
import { Change } from '@/components/ui/Change';
import { Flash } from '@/components/ui/Flash';
import { AreaSpark } from '@/components/ui/Sparkline';
import { TokenBadge } from '@/components/ui/TokenBadge';
import { useFlip } from '@/hooks/useFlip';
import { useReducedMotion } from '@/hooks/useReducedMotion';
import type { Pool, Quote } from '@/lib/data/types';
import { ageLabel, quoteLabel, tokenPrice, usd } from '@/lib/format';
import {
  RANK_MIN_VOLUME_USD,
  ago,
  buyShare,
  rankByCap,
  rankByVolume,
  shownCap,
  shownChange,
  shownLiquidity,
  shownPrice,
  shownSplit,
  shownVolume,
  shownYield,
  sourceName,
  stalenessText,
  yieldCaption,
  yieldLabel,
  yieldTitle,
  yieldValue,
} from '@/lib/market-figures';
import { YIELD_WINDOW_HOURS } from '@/lib/yield';

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
  const { indexerLagSeconds } = useMarket();
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
    if (facet === 'volume') return rankByVolume(matching);
    return matching
      .filter((p) => p.ageHours >= YIELD_WINDOW_HOURS)
      .slice()
      .sort((a, b) => (shownYield(b).pct ?? -1) - (shownYield(a).pct ?? -1));
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
              ? `By market cap · tokens with ${usd(RANK_MIN_VOLUME_USD)}+ traded today first`
              : facet === 'volume'
                ? 'By 24h volume · today\u2019s figures ahead of older ones'
                : 'By fee yield · pools with seven days of history'}
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

      <div className="lb-cols" aria-hidden="true">
        <span className="c-rk">#</span>
        <span className="c-tok">Token</span>
        <span className="c-price">Price</span>
        <span className="c-age">Age</span>
        <span className="c-split">{facet === 'yield' ? 'Fee yield' : 'Buys / sells'}</span>
        <span className="c-vol">Volume</span>
        <span className="c-chg">24h</span>
        <span className="c-liq">Liquidity</span>
        <span className="c-mc">Mkt cap</span>
        <span className="c-spark">7d</span>
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
            indexerLagSeconds={indexerLagSeconds}
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
  indexerLagSeconds,
  registerRef,
  onOpen,
}: {
  pool: Pool;
  rank: number;
  leader: boolean;
  facet: Facet;
  indexerLagSeconds: number;
  registerRef: (el: HTMLElement | null) => void;
  onOpen: () => void;
}) {
  const age = ageLabel(pool.ageHours);
  const shownY = shownYield(pool);
  const qualifier = yieldCaption(shownY, age, stalenessText(indexerLagSeconds));
  const yieldText = yieldValue(shownY);
  const insufficient = shownY.pct === null;

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
  const price = shownPrice(pool);
  const priceTitle =
    price.value === null
      ? 'No source has a price for this token yet.'
      : price.basis === 'chain-now'
        ? "Price in this pool, from the chain's own head."
        : price.basis === 'live'
          ? 'Price from an aggregator, on the token\u2019s deepest pair.'
          : 'Price at the last indexed block.';
  const source = sourceName(pool);
  const quoted = pool.market ? `${source}, ${ago(pool.market.at)}` : 'indexed swaps';
  const across =
    pool.market && pool.market.pairs > 1
      ? ` across the token's ${pool.market.pairs} pairs on this chain`
      : pool.market
        ? " across the token's pools on this chain"
        : '';

  const capValue = cap.kind === 'mc' || cap.kind === 'fdv' ? usd(cap.value as number) : '—';
  const capTag =
    cap.kind === 'native'
      ? 'native asset'
      : cap.kind === 'fdv'
        ? 'fdv'
        : cap.kind === 'mc' && cap.fdvBeside
          ? `fdv ${usd(cap.fdvBeside)}`
          : null;
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
        #{rank}
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
          <span className="n">
            {pool.token.symbol}
            <span className="q"> / {quoteLabel(pool)}</span>
          </span>
          <span className="s" title={pool.token.name}>
            <span className="tok-name">{pool.token.name}</span>
            {/* On a phone the cap column is gone; the figure takes the name's place. */}
            <span className="tok-mc" title={capTitle}>
              MC {capValue}
            </span>
          </span>
        </span>
      </button>

      <div className="lb-fig lb-price" data-col="price" title={priceTitle}>
        <Flash as="div" className="big num" text={tokenPrice(price.value)} />
      </div>

      <div className="lb-fig lb-age" data-col="age" title={`Pool created ${age} ago`}>
        <span className="big num">{age}</span>
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
                : `${usd(split.buys)} bought and ${usd(split.sells)} sold over 24h in this pool, ` +
                  (split.basis === 'chain-now'
                    ? "from the chain's own head. It sums to the volume beside it."
                    : 'from indexed swaps')
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
        <div className="lb-fig lb-split lb-yield">
          <Flash
            as="div"
            className={`big num${insufficient ? ' muted' : ' up'}`}
            text={yieldText}
            title={yieldTitle(shownY)}
          >
            {yieldText}
            {qualifier && <span className="est">{qualifier}</span>}
          </Flash>
          <span className="cap">{yieldLabel(shownY)}</span>
        </div>
      )}

      {/* Volume is on the row whatever the ranking, and beside it the buys
          and sells it is made of. Live, both are the token's across its
          pairs — a token here has several pools, and reading the day off
          one of them was what put $17.9K on NVDA. The fee figure left the
          row at the owner's request; fees remain the yield's basis, the
          masthead's headline and the drawer's line. */}
      <div
        className="lb-fig lb-vol"
        title={
          volume.basis === 'chain-now'
            ? "Volume over the last 24 hours in this pool, from the chain's own head — the same arithmetic as every other figure here, over blocks minutes old rather than the backfill's."
            : volume.basis === 'live'
              ? `Volume over the last 24 hours from ${quoted}${across}` +
                (pool.market && pool.market.pairs > 0
                  ? ` (deepest: ${pool.market.dexId || 'pair'} ${pool.market.pairAddress.slice(0, 10)}…)`
                  : '')
              : pool.market === null
                ? "Volume over the last 24 hours of chain time in this pool, from indexed swaps. Neither the chain's head nor an aggregator has anything newer."
                : 'Volume over the last 24 hours of chain time in this pool, from indexed swaps.'
        }
      >
        <Flash as="div" className="big num" text={usd(volume.value)} />
        {/* Three words, because there are three answers and they are weeks
            apart: `now` is the chain's own head, `live` an aggregator, and
            `chain` the backfill's last indexed day (§25). */}
        <span className={`src src-${volume.basis === 'chain-now' ? 'now' : volume.basis === 'live' ? 'live' : 'chain'}`}>
          {volume.basis === 'chain-now' ? 'now' : volume.basis === 'live' ? 'live' : 'chain'}
        </span>
      </div>

      <Flash
        as="div"
        className="lb-chg"
        text={change.value === null ? '—' : change.value.toFixed(1)}
        title={
          change.basis === 'chain-now'
            ? "24h price change in this pool, from the chain's own head"
            : change.basis === 'live'
              ? `24h price change from ${quoted}, on the deepest pair`
              : '24h price change from indexed swaps, in this pool'
        }
      >
        <Change pct={change.value} />
      </Flash>

      {/* Unknown liquidity is a dash, not a zero (§14). */}
      <div className="lb-fig lb-liq" data-col="liq" title={liquidityTitle}>
        <Flash as="div" className="big num" text={liquidityText} />
        {liquidity.value !== null && liquidity.basis !== 'chain' && <span className="cap">live</span>}
      </div>

      <div className="lb-fig" data-col="mc" title={capTitle}>
        <Flash as="div" className="big num" text={capValue} />
        {capTag && <span className="cap">{capTag}</span>}
      </div>

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
