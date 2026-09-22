/**
 * The last snapshot the API built, kept across restarts.
 *
 * A deploy restarts the API, and the page that loads next used to wait on
 * the first build of the new process: the expensive query, run while the
 * indexer is often mid-repair or mid-rebuild after the same deploy, and
 * returning nothing at all while the anchor or the cursor is being put
 * right. The site sat on the loading panel for as long as that took, over
 * tables that had a perfectly good board in them a minute earlier.
 *
 * So each successful build is written to `indexer_state` (one row, a few
 * hundred kilobytes of JSON, at most once every PERSIST_MS), and a starting
 * process serves it from the first request while its own first build runs.
 * What is served is aged, not passed off as fresh: the lag figure gains the
 * time since the snapshot was built, so the top bar says exactly how old the
 * board is (§7). Past MAX_AGE_MS it is not served at all — a day-old board
 * is a claim about a chain that has moved on, and the loading panel is the
 * honest state again.
 */

import type { MarketSnapshot } from '../../lib/data/types';
import { prisma } from '../db';

export const SNAPSHOT_STATE_KEY = 'last_snapshot';
/** How often a successful build is written down. */
export const PERSIST_MS = 30_000;
/** Older than this, a kept snapshot is not served. */
export const MAX_AGE_MS = 24 * 60 * 60_000;

let lastPersistedAt = 0;

export async function persistSnapshot(snapshot: MarketSnapshot, now = Date.now()): Promise<boolean> {
  if (now - lastPersistedAt < PERSIST_MS) return false;
  lastPersistedAt = now;
  // The per-wallet portfolio is never in the shared snapshot; what is here is
  // the empty default, and it stays that way on disk.
  const value = JSON.stringify(snapshot);
  await prisma.indexerState.upsert({
    where: { key: SNAPSHOT_STATE_KEY },
    create: { key: SNAPSHOT_STATE_KEY, value, updatedAt: new Date(now) },
    update: { value, updatedAt: new Date(now) },
  });
  return true;
}

/** The kept snapshot, or null when there is none or it is too old to serve. */
export async function loadPersistedSnapshot(now = Date.now()): Promise<MarketSnapshot | null> {
  const row = await prisma.indexerState.findUnique({ where: { key: SNAPSHOT_STATE_KEY } });
  if (!row) return null;
  let parsed: MarketSnapshot;
  try {
    parsed = JSON.parse(row.value) as MarketSnapshot;
  } catch {
    return null;
  }
  if (!parsed || !Array.isArray(parsed.pools) || typeof parsed.builtAt !== 'string') return null;
  if (!isServable(parsed, now)) return null;
  return parsed;
}

/** Whether a snapshot built at `builtAt` is still young enough to stand in for a fresh one. */
export function isServable(snapshot: MarketSnapshot, now = Date.now()): boolean {
  const built = snapshot.builtAt ? Date.parse(snapshot.builtAt) : NaN;
  return Number.isFinite(built) && now - built >= 0 && now - built <= MAX_AGE_MS;
}

/**
 * A snapshot as of now: the same figures, with the lag grown by the time
 * since it was built, and the revision this process hands it.
 */
export function agedSnapshot(snapshot: MarketSnapshot, revision: number, now = Date.now()): MarketSnapshot {
  const built = snapshot.builtAt ? Date.parse(snapshot.builtAt) : now;
  const since = Number.isFinite(built) ? Math.max(0, (now - built) / 1000) : 0;
  return { ...snapshot, indexerLagSeconds: snapshot.indexerLagSeconds + since, revision };
}

/** Test seam: forget when the last write was, so the next call writes. */
export function resetPersistClock(): void {
  lastPersistedAt = 0;
}
