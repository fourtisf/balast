/**
 * Formatting only. No maths that decides what a number *means* lives here —
 * that belongs in the provider (§4: compute it in SQL, never in the component).
 */

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

/** A signed percentage, e.g. +11.2% / −4.0%. */
export function signedPct(n: number, digits = 1): string {
  return `${n >= 0 ? '+' : '−'}${Math.abs(n).toFixed(digits)}%`;
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
