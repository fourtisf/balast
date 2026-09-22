/**
 * Formatting only. No maths that decides what a number *means* lives here —
 * that belongs in the provider (§4: compute it in SQL, never in the component).
 */

import { CONTRACTS, NATIVE_ETH } from './chain';
import type { Pool } from './data/types';

/** $1.23B / $1.23M / $12.3K / $123 — the prototype's `fmt`. */
export function usd(n: number): string {
  if (!Number.isFinite(n)) return '—';
  const a = Math.abs(n);
  if (a >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

/** Exact dollars with separators, for headline figures. */
export function usdExact(n: number, fractionDigits = 0): string {
  return `$${n.toLocaleString('en-US', {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  })}`;
}

/** A signed percentage, e.g. +11.2% / −4.0%. Unknown is an em dash, never +0.0%. */
export function signedPct(n: number | null, digits = 1): string {
  if (n === null || !Number.isFinite(n)) return '—';
  return `${n >= 0 ? '+' : '−'}${Math.abs(n).toFixed(digits)}%`;
}

/**
 * A headline figure: exact with separators while it fits, compact once it
 * would not. The prototype's top bar is exact ("$4,912,440"); at $3.8M the
 * TVL stat clipped to "$3,801,09" in a 44px pill, which reads as a number
 * that is simply wrong.
 */
export function usdHeadline(n: number): string {
  return Math.abs(n) >= 1e6 ? usd(n) : usdExact(n);
}

export function count(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

export function weth(n: number, digits = 3): string {
  return `${n.toFixed(digits)} WETH`;
}

/** Token prices swing over orders of magnitude; sub-$1 tokens need 4 places. */
export function price(n: number): string {
  return `$${n.toLocaleString('en-US', { maximumFractionDigits: n < 1 ? 4 : 2 })}`;
}

/** 1656 -> "69d", 24 -> "1d", 1 -> "1h". Matches the prototype's age column. */
export function ageLabel(hours: number): string {
  if (hours < 24) return `${Math.max(1, Math.floor(hours))}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** 385_200 -> "4d 11h left" */
export function countdown(seconds: number): string {
  if (seconds <= 0) return 'complete';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h left`;
  if (h > 0) return `${h}h ${m}m left`;
  return `${m}m left`;
}

/**
 * 5_937_929 -> "68d 17h", 7_384 -> "2h 3m", 42 -> "42s".
 *
 * For the indexer lag in the top bar (§7). Seven digits of seconds is honest
 * and unreadable, and a first sync on this chain is measured in days.
 */
export function duration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

export function inHours(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  if (h >= 1) return `in ${h}h`;
  return `in ${Math.max(1, Math.floor(seconds / 60))}m`;
}

export function shortWallet(hex: string): string {
  return `${hex.slice(0, 6)}…${hex.slice(-4)}`;
}

/**
 * A pool's fee tier as a percentage, without trailing zeroes: `0.3%`, `1%`,
 * `6.9%`. The tier is what a position earns on every trade, so it names a
 * market as much as the pair does.
 */
export function feeTierLabel(feeTierBps: number): string {
  return `${(feeTierBps / 100).toFixed(2).replace(/\.?0+$/, '')}%`;
}

/**
 * The quote side of a pool's pair, as the page names it: `NVDA / USDG`,
 * `PONS / ETH`, `TSLA / WETH`.
 *
 * Every pair label used to be hardcoded `/ WETH`, which was the prototype's
 * one quote and is wrong for a third of the live board: the tokenised stocks
 * trade against USDG, and a v4 pool that holds ether holds it natively
 * (lib/chain.ts, NATIVE_ETH), not as the wrapper. A v3 pool always holds the
 * wrapper; a simulated pool has no key and keeps its nominal quote.
 */
export function quoteLabel(pool: QuoteSided): string {
  if (pool.quote !== 'ETH') return pool.quote;
  const currency = quoteCurrencyOf(pool);
  if (currency) return currency === NATIVE_ETH ? 'ETH' : 'WETH';
  return pool.protocol === 'v3' ? 'WETH' : 'ETH';
}

type QuoteSided = Pick<Pool, 'quote' | 'key' | 'token' | 'protocol'>;

/**
 * The address of the pool's quote side, lowercase, or null when the pool has
 * no key — a v3 pool or a simulated one.
 *
 * One function answers it because the places that ask have disagreed before:
 * §18's "which side is ether" was written out four times and one of them was
 * against the wrapper alone, which blanked the site. `quoteLabel` and the
 * builder's market ordering now read the same answer.
 */
export function quoteCurrencyOf(pool: QuoteSided): string | null {
  if (!pool.key) return null;
  const tokenIsCurrency0 = pool.token.address.toLowerCase() === pool.key.currency0.toLowerCase();
  return (tokenIsCurrency0 ? pool.key.currency1 : pool.key.currency0).toLowerCase();
}

/**
 * Whether this market is quoted in the chain's own ether rather than in the
 * aeWETH wrapper.
 *
 * It decides what a wallet has to hold to enter: a native market spends the
 * balance the wallet already shows, a wrapped one needs the ERC-20, which
 * has to be wrapped first. That is why the builder puts the native market
 * in front of the wrapped one.
 */
export function quoteIsNativeEther(pool: QuoteSided): boolean {
  return quoteCurrencyOf(pool) === NATIVE_ETH;
}

/** Quoted in aeWETH: the same asset, one token per ether, held as an ERC-20. */
export function quoteIsWrappedEther(pool: QuoteSided, weth: string = CONTRACTS.weth): boolean {
  return quoteCurrencyOf(pool) === weth.toLowerCase();
}
