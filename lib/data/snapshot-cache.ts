/**
 * The last snapshot this browser saw, so a reload shows the board at once.
 *
 * The live provider starts every page load with nothing and waits for the
 * API — and after a deploy the API itself may have nothing for a while. The
 * board that was on screen a moment ago is kept here, per browser, and
 * restored on the next load with its lag grown by the time it sat: the top
 * bar then says how old the numbers are, which is the whole of §7's rule
 * about stale figures. It is a convenience layer under the real fetch, never
 * a substitute for it: the first snapshot the API answers replaces it, and
 * one older than MAX_AGE_MS is not restored at all.
 *
 * Pure over a Storage-like object, so it is tested without a browser.
 */

import type { MarketSnapshot } from './types';

export interface SnapshotStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

export const SNAPSHOT_CACHE_KEY = 'balast:snapshot:v1';
/** Older than this, a kept snapshot is not restored. */
export const MAX_AGE_MS = 24 * 60 * 60_000;
/** A snapshot arrives every few seconds; the store is written at most this often. */
export const STORE_EVERY_MS = 10_000;

interface Stored {
  storedAt: number;
  snapshot: MarketSnapshot;
}

/**
 * The kept snapshot, aged to now, or null. The revision is zeroed so that
 * whatever the API answers first — over the socket or the poll — is newer
 * than it and replaces it.
 */
export function restoreSnapshot(store: SnapshotStorage | null, now = Date.now()): MarketSnapshot | null {
  if (!store) return null;
  let parsed: Stored;
  try {
    const raw = store.getItem(SNAPSHOT_CACHE_KEY);
    if (!raw) return null;
    parsed = JSON.parse(raw) as Stored;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed.storedAt !== 'number' || !parsed.snapshot || !Array.isArray(parsed.snapshot.pools)) return null;
  const built = parsed.snapshot.builtAt ? Date.parse(parsed.snapshot.builtAt) : parsed.storedAt;
  const since = Number.isFinite(built) ? now - built : NaN;
  if (!(since >= 0 && since <= MAX_AGE_MS)) return null;
  return {
    ...parsed.snapshot,
    indexerLagSeconds: parsed.snapshot.indexerLagSeconds + since / 1000,
    revision: 0,
  };
}

let lastStoredAt = 0;

/** Keep a snapshot for the next load. Throttled; a full store or a private window is not an error. */
export function storeSnapshot(store: SnapshotStorage | null, snapshot: MarketSnapshot, now = Date.now()): boolean {
  if (!store) return false;
  if (now - lastStoredAt < STORE_EVERY_MS) return false;
  try {
    // The wallet's portfolio is personal and re-fetched; what is kept is the shared board.
    const kept: MarketSnapshot = { ...snapshot, portfolio: { ...snapshot.portfolio, positions: [], stakes: [], wallet: undefined } };
    store.setItem(SNAPSHOT_CACHE_KEY, JSON.stringify({ storedAt: now, snapshot: kept } satisfies Stored));
    lastStoredAt = now;
    return true;
  } catch {
    return false;
  }
}

/** Test seam. */
export function resetStoreClock(): void {
  lastStoredAt = 0;
}
