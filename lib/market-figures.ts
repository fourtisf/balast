/**
 * Which figure the board shows, and where it came from.
 *
 * Every number on a row now has two possible sources — the chain, from
 * indexed logs, and an aggregator, live (§20, §21) — and three consumers:
 * the row, the drawer, and the ranking the board sorts by. When those three
 * disagree about which source a figure came from, the board contradicts
 * itself: it sorts by a market cap it does not show, or shows a live volume
 * beside a chain-derived change. §12's rule that the header cannot disagree
 * with the table beneath it is the same rule one level down, so the choice
 * is made once, here, and everything reads it.
 *
 * `basis` is what the row prints as `live` or `chain`, and `scope` says what
 * the figure is about: the token across its pools, or the row's own pool.
 * The two differ — a token's liquidity is not the pool's — so nothing
 * silently swaps one for the other; a figure that changes scope says so.
 */

import { isEther } from './chain';
import type { MarketSourceName, Pool } from './data/types';
import { duration, usd } from './format';
import { MIN_DATA_HOURS, YIELD_WINDOW_HOURS } from './yield';

/**
 * Where a figure came from.
 *
 *   chain-now  the chain's own head: the last day of swaps, read by a second
 *              reader while the backfill is still weeks behind (§25). The
 *              chain's arithmetic, current.
 *   live       an aggregator's quote for the token (§20, §21).
 *   chain      the indexer's own tables, measured back from the last block it
 *              has read — during a first sync, a day weeks ago.
 */
export type Basis = 'live' | 'chain' | 'chain-now';
export type Scope = 'token' | 'pool';

export interface Shown<T> {
  value: T;
  basis: Basis;
  scope: Scope;
}

/**
 * The day's volume. Live, it is the token's across every pair the source
 * lists on this chain; from the chain, it is this pool's indexed swaps.
 */
export function shownVolume(pool: Pool): Shown<number> {
  // The chain's own head first, and deliberately: it is this pool's swaps,
  // derived the way every other figure on the site is derived, and current.
  // An aggregator's figure is the token across its pairs and comes from
  // outside (§4); it fills in for a pool the head reader has not seen trade.
  if (pool.now) return { value: pool.now.volume24hUsd, basis: 'chain-now', scope: 'pool' };
  return pool.market
    ? { value: pool.market.volume24hUsd, basis: 'live', scope: 'token' }
    : { value: pool.volume24hUsd, basis: 'chain', scope: 'pool' };
}

/** The 24h price change, from the same source as the volume beside it. */
export function shownChange(pool: Pool): Shown<number | null> {
  if (pool.now) return { value: pool.now.change24hPct, basis: 'chain-now', scope: 'pool' };
  return pool.market
    ? { value: pool.market.priceChange24hPct, basis: 'live', scope: 'token' }
    : { value: pool.change24hPct, basis: 'chain', scope: 'pool' };
}

export type CapKind = 'mc' | 'fdv' | 'native' | 'none';

export interface ShownCap {
  value: number | null;
  kind: CapKind;
  basis: Basis;
  /** The fully diluted figure, when it differs from the market cap by more than a percent. */
  fdvBeside: number | null;
}

/**
 * The market cap.
 *
 * The live figure is preferred over the chain's, and that is not a
 * preference for the aggregator: the chain's market cap is a supply read
 * multiplied by the price in `pool_state`, which is the price at the last
 * indexed block. During a first sync that is the price two months ago, so
 * the chain's figure is a correct supply at a stale price. The aggregator's
 * is today's. Both are labelled.
 *
 * Failing both, the fully diluted figure, labelled `FDV` — the whole supply
 * at a price — because presenting it as a market cap overstates every token
 * with a vesting schedule, always in the flattering direction (§15).
 *
 * Ether has no contract and no supply to read (§18): that is a fact about
 * ether, not a gap, and it says so.
 */
export function shownCap(pool: Pool): ShownCap {
  if (isEther(pool.token.address)) return { value: null, kind: 'native', basis: 'chain', fdvBeside: null };
  const live = pool.market;
  const pick = (mc: number | null, fdv: number | null, basis: Basis): ShownCap | null => {
    if (mc !== null && mc > 0) {
      return { value: mc, kind: 'mc', basis, fdvBeside: fdv !== null && fdv > mc * 1.01 ? fdv : null };
    }
    if (fdv !== null && fdv > 0) return { value: fdv, kind: 'fdv', basis, fdvBeside: null };
    return null;
  };
  return (
    (live ? pick(live.marketCapUsd, live.fdvUsd, 'live') : null) ??
    pick(pool.marketCapUsd, pool.fdvUsd, 'chain') ?? { value: null, kind: 'none', basis: 'chain', fdvBeside: null }
  );
}

export interface ShownLiquidity {
  value: number | null;
  basis: Basis;
  scope: Scope;
}

/**
 * Liquidity.
 *
 * The chain's figure first, and deliberately: it is the pool's own reserves,
 * derived from its events, and it is the pool the Stake button opens — the
 * one the drawer's share-of-pool and the yield are computed against. A live
 * figure is not swapped in over it.
 *
 * It fills a gap instead. A pool whose reserves the indexer cannot
 * reconstruct reads as unknown, not zero (§14), and those dashes are what
 * the owner saw on half the board. So: the aggregator's figure for that same
 * pool when it lists the pair, else the token's liquidity across its pools —
 * a different question, which `scope` names so the row can say so.
 */
/**
 * The floor under a live liquidity figure.
 *
 * `usd()` rounds to whole dollars, so an aggregator reporting thirty-four
 * cents rendered as `liquidity $0` — which reads as a measurement ("this pool
 * is empty") next to an FDV of $17.79M, when what it means is that the source
 * has effectively nothing for the pair and the chain could not reconstruct it
 * either. Under a dollar there is no figure worth printing, and §14's rule
 * applies: unknown is a dash, never a zero.
 */
const LIVE_LIQUIDITY_FLOOR_USD = 1;

/** Whether a quote's per-pool liquidity is this pool's. */
function describesPool(quote: NonNullable<Pool['market']>, pool: Pool): boolean {
  return !!quote.poolLiquidityPool && quote.poolLiquidityPool.toLowerCase() === pool.address.toLowerCase();
}

export function shownLiquidity(pool: Pool): ShownLiquidity {
  if (pool.tvlUsd > 0) return { value: pool.tvlUsd, basis: 'chain', scope: 'pool' };
  const live = pool.market;
  const usable = (n: number | null | undefined): n is number =>
    n !== null && n !== undefined && n >= LIVE_LIQUIDITY_FLOOR_USD;
  // The source's figure for THIS pool — not the board row's pool, which the
  // same token-wide quote also carries onto the token's other pools.
  if (usable(live?.poolLiquidityUsd) && describesPool(live!, pool)) {
    return { value: live!.poolLiquidityUsd as number, basis: 'live', scope: 'pool' };
  }
  if (usable(live?.liquidityUsd)) {
    return { value: live!.liquidityUsd as number, basis: 'live', scope: 'token' };
  }
  return { value: null, basis: 'chain', scope: 'pool' };
}

export type SplitUnit = 'trades' | 'usd';

export interface ShownSplit {
  buys: number;
  sells: number;
  unit: SplitUnit;
  basis: Basis;
  scope: Scope;
}

/**
 * The day's buys and sells.
 *
 * DexScreener splits a day into trade counts, not dollars, so the unit
 * travels with the figure rather than being assumed. GeckoTerminal does not
 * split at all, and a partial sum over its top pools beside a whole-token
 * volume would be a figure that does not add up — so the chain's dollar
 * split shows instead, labelled.
 *
 * Null when neither source has one. The chain's split is derived from the
 * same swaps as its volume and always sums to it, so a volume with a split
 * of zero is a split that has not been computed for those hours yet (the
 * columns arrived by migration and are filled by the next rebuild) — a dash,
 * not a $0 beside a volume that says otherwise.
 */
export function shownSplit(pool: Pool): ShownSplit | null {
  // The head's split is this pool's own dollars, and it sums to the volume
  // beside it — which the aggregator's trade counts cannot.
  if (pool.now) {
    return {
      buys: pool.now.buyVolume24hUsd,
      sells: pool.now.sellVolume24hUsd,
      unit: 'usd',
      basis: 'chain-now',
      scope: 'pool',
    };
  }
  const live = pool.market;
  if (live && live.buys24h !== null && live.sells24h !== null) {
    return { buys: live.buys24h, sells: live.sells24h, unit: 'trades', basis: 'live', scope: 'token' };
  }
  const known = pool.volume24hUsd <= 0 || pool.buyVolume24hUsd + pool.sellVolume24hUsd > 0;
  if (!known) return null;
  return {
    buys: pool.buyVolume24hUsd,
    sells: pool.sellVolume24hUsd,
    unit: 'usd',
    basis: 'chain',
    scope: 'pool',
  };
}

/** The buy side's share, for the split bar. Empty when there was neither. */
export function buyShare(buys: number, sells: number): number {
  const total = buys + sells;
  return total > 0 ? Math.round((buys / total) * 100) : 0;
}

/**
 * The figure the market-cap ranking sorts on: exactly what the row shows, so
 * the board's order cannot contradict its own numbers. Zero for a token with
 * neither figure, ether included — its market cap is not something this site
 * can derive (§18) — so those rows follow the ranked ones.
 */
export function capKey(pool: Pool): number {
  return shownCap(pool).value ?? 0;
}

/**
 * The live volume a token needs today to be ranked among the projects.
 *
 * ALFA's number, like the listing bar's (§19): a first guess at "a market
 * somebody is in", not a measurement. The board that set it had a $210M
 * market cap at rank 3 on $1.1K of volume — four buys, four sells.
 */
export const RANK_MIN_VOLUME_USD = 10_000;

/**
 * Which tier of the board a token ranks in (§24).
 *
 *   0  a live quote, and volume today of at least RANK_MIN_VOLUME_USD —
 *      a market somebody is in, measured today.
 *   1  some volume, but under the bar or only the chain's figure — which
 *      during a sync is weeks old, and is not a claim about today.
 *   2  none at all.
 *
 * A market cap alone put the dead tokens first: a launchpad token nobody
 * has traded carries its whole supply at the curve's floor, and an
 * aggregator reports that as a market cap of tens of millions beside a
 * day's volume of zero. A figure nobody has paid is not a project. So the
 * volume decides the tier and the cap decides the order within it, and a
 * quiet token is still on the board — at the end, visible rather than
 * hidden.
 */
export function rankTier(pool: Pool): 0 | 1 | 2 {
  const volume = shownVolume(pool);
  if (isCurrent(volume.basis) && volume.value >= RANK_MIN_VOLUME_USD) return 0;
  if (volume.value > 0) return 1;
  return 2;
}

/**
 * Whether a figure describes TODAY. The chain's own head and an aggregator's
 * quote both do; the backfill's last indexed day, during a first sync, does
 * not — and a ranking that mixes the two orders today's markets by a figure
 * from two months ago.
 */
export function isCurrent(basis: Basis): boolean {
  return basis === 'chain-now' || basis === 'live';
}

/** The market-cap ranking, as a list: by tier, then by cap, then by depth. */
export function rankByCap(pools: Pool[]): Pool[] {
  return pools.slice().sort((a, b) => rankTier(a) - rankTier(b) || capKey(b) - capKey(a) || b.tvlUsd - a.tvlUsd);
}

/**
 * The volume ranking: live figures ahead of the chain's, then by volume.
 * A chain figure during a sync is a day weeks ago; a live one is today's,
 * and today's is what a volume ranking claims to show.
 */
export function rankByVolume(pools: Pool[]): Pool[] {
  const live = (p: Pool): number => (isCurrent(shownVolume(p).basis) ? 0 : 1);
  return pools.slice().sort((a, b) => live(a) - live(b) || shownVolume(b).value - shownVolume(a).value);
}

/** `12s ago`, `4m ago` — how old a live quote is. */
export function ago(iso: string, now: number = Date.now()): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

/** How a tooltip names where a figure came from. */
export function sourceName(pool: Pool): string {
  if (!pool.market) return 'indexed swaps';
  return pool.market.source === 'dexscreener' ? 'DexScreener' : 'GeckoTerminal';
}

/**
 * The yield a person is shown, and what it is a claim about.
 *
 * `now24h` is what Uniswap's own interface shows: the fees a pool actually
 * took in the last 24 hours, annualised, over the liquidity behind them.
 * Both come from the chain — the head reader's own swaps for this pool
 * (§25), and the pool's reserves — so the figure describes the pool as it is
 * rather than as it was.
 *
 * **This sets aside §1's "never annualise a single day", and it is ALFA's
 * decision** (*saya ingin data yield-nya real seperti uniswap*), taken after
 * the alternative was put: the indexer's trailing-7d figure is honest
 * arithmetic and, while the backfill is seventy-four days behind, it is
 * July's fees over July's liquidity. A pool showed 1445% with nothing on
 * screen saying which day that was. §1's reason still stands — one day is
 * noisy — so the basis travels with the figure and the label never says
 * "trailing 7d" over a day, and never "APY" over anything.
 *
 * The fallback is unchanged: with no day from the head reader, or nothing to
 * divide by, it is the indexer's `feeYield` with its own three states (§7).
 */
export type YieldBasis = 'now24h' | 'trailing7d' | 'estimate' | 'insufficient';

export interface ShownYield {
  /** Null only when the basis is `insufficient`. */
  pct: number | null;
  basis: YieldBasis;
  /** How old the figure is: `now24h` is today, the rest are the indexer's. */
  current: boolean;
  /**
   * The pool has less than a week of history, so §7's `est.` and its age
   * ride with the figure. Carried here rather than asked of each caller:
   * four surfaces show this figure and any one of them could forget.
   */
  young: boolean;
  /** What went into a `now24h` figure, for the tooltip. */
  feesUsd: number | null;
  liquidityUsd: number | null;
  /** Where that liquidity was read: the pool's own balances on chain, or an aggregator's figure for this pool. */
  liquiditySource: 'chain' | MarketSourceName | null;
}

export function shownYield(pool: Pool): ShownYield {
  const now = pool.now;
  // Two things say a pool has less than a week behind it: its age, and the
  // indexer's own `estimate` basis, which it sets for exactly that reason.
  // Either is enough — §7's qualifier must not be dropped because one field
  // disagreed with the other.
  const young = pool.ageHours < YIELD_WINDOW_HOURS || pool.feeYield.basis === 'estimate';
  // The pool's liquidity NOW — the same moment as the fees above it. It used
  // to be `tvlUsd`, which is as old as the indexer's last block: seventy-four
  // days on the box, so today's fees were divided by July's liquidity and
  // VIRTUAL/ETH read 1897%. A yield whose numerator and denominator were
  // measured two months apart is not a yield. With no current liquidity the
  // figure falls back to the indexer's own, whose two halves are the same
  // day, and says how old that day is.
  const live = pool.liveLiquidity && pool.liveLiquidity.usd > 0 ? pool.liveLiquidity : null;
  // §7's floor, which ALFA's decision did not move: never a yield from fewer
  // than 24 hours of data. A pool three hours old has three hours of fees in
  // the head reader's window, and annualising them as if they were a day is
  // the "1-day-old pool showing 1200%" that rule exists to stop.
  const enough = pool.ageHours >= MIN_DATA_HOURS;
  if (now && enough && live !== null && Number.isFinite(now.fees24hUsd)) {
    return {
      pct: (now.fees24hUsd * 365) / live.usd * 100,
      basis: 'now24h',
      current: true,
      young,
      feesUsd: now.fees24hUsd,
      liquidityUsd: live.usd,
      liquiditySource: live.source,
    };
  }
  const y = pool.feeYield;
  return {
    pct: y.basis === 'insufficient' ? null : y.pct,
    basis: y.basis === 'insufficient' ? 'insufficient' : y.basis === 'estimate' ? 'estimate' : 'trailing7d',
    current: false,
    young,
    feesUsd: null,
    liquidityUsd: null,
    liquiditySource: null,
  };
}

/** "148%", or an em dash when nothing honest can be said. */
export function yieldValue(y: ShownYield): string {
  return y.pct === null ? '—' : `${y.pct.toFixed(0)}%`;
}

/**
 * What has to be said *beside* the figure, or null when nothing does.
 *
 * Only the qualifiers: the basis itself belongs to `yieldLabel`, which every
 * surface already prints under the number. Returning the basis here too put
 * `fees 24h · annualised` inline beside each figure on the board, over the
 * volume column to its left, saying what the line below it said.
 *
 * What is left is what §7 asks for and the label cannot carry: a pool with
 * less than a week of history (`est.` and its age), and a figure as old as
 * the sync.
 */
export function yieldCaption(y: ShownYield, ageText: string, lagText: string | null): string | null {
  if (y.basis === 'insufficient') return 'not enough data yet';
  const parts: string[] = [];
  if (y.young) parts.push(`est. · ${ageText}`);
  if (!y.current && lagText) parts.push(`${lagText} old`);
  return parts.length > 0 ? parts.join(' · ') : null;
}

/** Why the figure is what it is, for the title attribute. */
export function yieldTitle(y: ShownYield): string {
  switch (y.basis) {
    case 'now24h':
      return (
        `The fees this pool took in the last 24 hours of chain time, annualised: ` +
        `${usd(y.feesUsd ?? 0)} over ${usd(y.liquidityUsd ?? 0)} of liquidity. ` +
        'From the pool’s own swaps, not a forecast — one day is a noisy basis, ' +
        'and a quiet day or a busy one moves it a long way.'
      );
    case 'estimate':
      return 'Pool is younger than 7 days. Annualised from the fees it has — arithmetic, not a forecast.';
    case 'trailing7d':
      return (
        'Fees over the trailing 7 days, annualised, from the indexer. No trade has ' +
        'been read for this pool in the last day, so this is as old as the sync.'
      );
    default:
      return 'Less than 24h of fee data. No yield figure is honest yet.';
  }
}

/**
 * How old the indexer's figures are, in words, or null while it is current.
 *
 * §7 asks for the lag in the top bar. A yield is the one number on the page
 * that most reads as live, so where the figure is the indexer's it carries
 * the same lag beside it: `trailing 7d · 74d 2h old` cannot be mistaken for
 * today the way a bare `1445%` was.
 */
export function stalenessText(indexerLagSeconds: number): string | null {
  return indexerLagSeconds >= 86_400 ? duration(indexerLagSeconds) : null;
}

/** The figure's name, which is the basis: `fee yield · 24h`, or trailing 7d. */
export function yieldLabel(y: ShownYield): string {
  return y.basis === 'now24h' ? 'fee yield · 24h, annualised' : 'fee yield, trailing 7d';
}

/** The basis in two words, for a caption that already names a figure. */
export function yieldBasisShort(y: ShownYield): string {
  return y.basis === 'now24h' ? '24h' : 'trailing 7d';
}
