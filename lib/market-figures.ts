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
import type { Pool } from './data/types';

export type Basis = 'live' | 'chain';
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
  return pool.market
    ? { value: pool.market.volume24hUsd, basis: 'live', scope: 'token' }
    : { value: pool.volume24hUsd, basis: 'chain', scope: 'pool' };
}

/** The 24h price change, from the same source as the volume beside it. */
export function shownChange(pool: Pool): Shown<number | null> {
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

export function shownLiquidity(pool: Pool): ShownLiquidity {
  if (pool.tvlUsd > 0) return { value: pool.tvlUsd, basis: 'chain', scope: 'pool' };
  const live = pool.market;
  const usable = (n: number | null | undefined): n is number =>
    n !== null && n !== undefined && n >= LIVE_LIQUIDITY_FLOOR_USD;
  if (usable(live?.poolLiquidityUsd)) {
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
 * The market-cap ranking, as a list.
 *
 * A cap alone put the dead tokens first (§24): a launchpad token nobody has
 * traded carries its whole supply at the curve's floor, and an aggregator
 * reports that as a market cap and a liquidity of tens of millions — beside
 * a day's volume of zero. A figure nobody has paid is not a project. So a
 * token with no volume today ranks after every token with some, whatever
 * its cap; within each tier the cap decides, then depth. The zero-volume
 * tokens stay on the board, at the end, where a quiet day is visible
 * rather than hidden.
 */
export function rankByCap(pools: Pool[]): Pool[] {
  const traded = (p: Pool): number => (shownVolume(p).value > 0 ? 1 : 0);
  return pools.slice().sort((a, b) => traded(b) - traded(a) || capKey(b) - capKey(a) || b.tvlUsd - a.tvlUsd);
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
