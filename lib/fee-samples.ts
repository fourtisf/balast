/**
 * Fees earned per day, measured by this browser.
 *
 * A position's fees are state, not events (lib/v4/fees.ts): what it has
 * earned is readable now — collected so far plus uncollected — and what it
 * earned on a given day in the past is not, without an archive node the free
 * endpoints are not. So the page records the figure it reads, at most once a
 * reading, per day, and a day's fees are the growth since the previous day it
 * recorded. The grid starts the first day this browser saw the position and
 * fills from there; it says so, and never draws a day it did not measure.
 *
 * Amounts are stored in the chain's raw units, per side, and valued at
 * today's prices when drawn, so a price move is not counted as fees.
 */

const KEY = 'balast.feeSamples.v1';
const KEEP_DAYS = 70;

export interface EarnedReading {
  /** positionRef: manager and token id. */
  ref: string;
  /** Collected so far plus uncollected, raw units, per side. */
  earned0: bigint;
  earned1: bigint;
  /** Raw-unit to dollar, per side, for drawing: 10^-decimals × price. */
  usdPerUnit0: number;
  usdPerUnit1: number;
  /** When it was minted, if known: fees measured on that very day count from zero. */
  mintedAt?: string | null;
}

type Store = Record<string, Record<string, [string, string]>>;

export function dayOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function load(): Store {
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    return parsed && typeof parsed === 'object' ? (parsed as Store) : {};
  } catch {
    return {};
  }
}

function save(store: Store): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(store));
  } catch {
    /* a private window or a full store is not an error */
  }
}

/** Record today's readings for a wallet. The latest reading of a day wins. */
export function recordEarned(wallet: string, readings: EarnedReading[], now: number = Date.now(), store: Store = load()): Store {
  const day = dayOf(now);
  const cutoff = dayOf(now - KEEP_DAYS * 86_400_000);
  for (const r of readings) {
    const id = `${wallet.toLowerCase()}|${r.ref}`;
    const days = (store[id] ??= {});
    days[day] = [r.earned0.toString(), r.earned1.toString()];
    for (const d of Object.keys(days)) if (d < cutoff) delete days[d];
  }
  save(store);
  return store;
}

/**
 * Dollars earned per day across the readings' positions, oldest first, from
 * the first day any of them was measured to today (at most `days`). A day's
 * figure is each position's growth since its previous recorded day, per side,
 * never below zero — a collect is inside the earned figure already, so a fall
 * can only be a withdrawal, which earns nothing.
 *
 * A position's first recorded day counts from zero: the earned figure is
 * everything since the mint, so on the mint day that is exactly the day's
 * fees. For a position minted before this browser first saw it — or whose
 * mint day is not known — the first day also carries everything earned
 * before it, and `firstIncludesEarlier` says so, so the caption can.
 * (It used to count from the second recorded day, and a position minted
 * today read "$0 over 1 day" with fees plainly on the row beside it.)
 */
export function dailyEarnedUsd(
  wallet: string,
  readings: EarnedReading[],
  options: { days?: number; now?: number; store?: Store } = {},
): { values: number[]; since: string | null; firstIncludesEarlier: boolean } {
  const store = options.store ?? load();
  const now = options.now ?? Date.now();
  const span = options.days ?? 56;
  const perDay = new Map<string, number>();
  let first: string | null = null;
  let firstIncludesEarlier = false;
  for (const r of readings) {
    const days = store[`${wallet.toLowerCase()}|${r.ref}`];
    if (!days) continue;
    const sorted = Object.keys(days).sort();
    if (sorted.length === 0) continue;
    if (!first || sorted[0] < first) first = sorted[0];
    const minted = r.mintedAt ? dayOf(Date.parse(r.mintedAt)) : null;
    if (!minted || minted < sorted[0]) firstIncludesEarlier = true;
    let prev: [bigint, bigint] = [0n, 0n];
    for (const d of sorted) {
      const cur: [bigint, bigint] = [BigInt(days[d][0]), BigInt(days[d][1])];
      const g0 = cur[0] > prev[0] ? cur[0] - prev[0] : 0n;
      const g1 = cur[1] > prev[1] ? cur[1] - prev[1] : 0n;
      perDay.set(d, (perDay.get(d) ?? 0) + Number(g0) * r.usdPerUnit0 + Number(g1) * r.usdPerUnit1);
      prev = cur;
    }
  }
  if (!first) return { values: [], since: null, firstIncludesEarlier: false };
  const values: number[] = [];
  const today = dayOf(now);
  const start = Math.max(Date.parse(first), Date.parse(today) - (span - 1) * 86_400_000);
  for (let t = start; dayOf(t) <= today; t += 86_400_000) values.push(perDay.get(dayOf(t)) ?? 0);
  return { values, since: dayOf(start), firstIncludesEarlier: firstIncludesEarlier && dayOf(start) === first };
}
