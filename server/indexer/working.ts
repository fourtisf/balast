/**
 * A heartbeat for the stages that do not advance the cursor.
 *
 * `/api/health` judges liveness by the cursor's write time: a poller that
 * has not written in five minutes is "stalled", and the monitor pages. That
 * is right for a pass, which writes the cursor at its end. It is wrong for
 * the two stages a first pass can run for hours without one — the factory's
 * history (v3-history.ts) and the full rebuild of every priced table after
 * an anchor change or a repair migration — and the deploy summary after the
 * v4-sign repair read `STALLED — nothing written for 16818s` over an indexer
 * that was busy the whole time. A monitor that alerts through expected work
 * is a monitor that gets muted (§18).
 *
 * So a long stage is recorded here, under one `indexer_state` key: its name,
 * what it is on, when it started, and a heartbeat written every few seconds
 * by a timer while it runs. A big SQL statement is I/O to Node, so the timer
 * fires while it executes. Health reads the record and reports `working` —
 * alive, on a named stage, for this long — as long as the heartbeat is
 * fresh; a process that dies mid-stage stops beating, and past the threshold
 * both clocks are stale and the verdict is `stalled` as before. The stage's
 * duration is on the record, so a rebuild that is taking too long is visible
 * rather than hidden behind a green light.
 */

import { prisma } from '../db';

/** `indexer_state` key holding the stage in progress. */
export const WORKING_KEY = 'working';

/** Seconds between heartbeats. Well under the stall threshold (300s default). */
export const HEARTBEAT_MS = 10_000;

export interface Working {
  /** What the indexer is doing, e.g. `full rebuild`, `v3 history: pools`. */
  stage: string;
  /** Where it is in the stage, e.g. `fees` or `block 1,200,000 of 4,470,000`. */
  detail?: string;
  startedAt: string;
  /** Written by the timer; the liveness signal for the stage. */
  heartbeatAt: string;
}

interface Options {
  /** For tests: a faster beat. */
  heartbeatMs?: number;
}

/**
 * Run `fn` as a named stage, heartbeating until it settles. `note` updates
 * the detail the next beat will carry; it is cheap and never touches the
 * database itself, so it can be called from inside a tight loop.
 *
 * The record is removed when the stage ends, however it ends. Telemetry
 * never stops the work: a failed heartbeat write is swallowed.
 */
export async function withWork<T>(
  stage: string,
  fn: (note: (detail: string) => void) => Promise<T>,
  options: Options = {},
): Promise<T> {
  const startedAt = new Date().toISOString();
  let detail: string | undefined;
  const beat = async () => {
    const record: Working = { stage, detail, startedAt, heartbeatAt: new Date().toISOString() };
    try {
      const value = JSON.stringify(record);
      await prisma.indexerState.upsert({
        where: { key: WORKING_KEY },
        create: { key: WORKING_KEY, value, updatedAt: new Date() },
        update: { value, updatedAt: new Date() },
      });
    } catch {
      /* telemetry must never stop the stage */
    }
  };
  await beat();
  // A beat that is still in flight when the next is due is skipped rather
  // than queued: a slow database must not pile up upserts behind itself.
  let inFlight: Promise<void> | null = null;
  const timer = setInterval(() => {
    if (inFlight) return;
    inFlight = beat().finally(() => {
      inFlight = null;
    });
  }, options.heartbeatMs ?? HEARTBEAT_MS);
  // Never the reason the process stays up.
  timer.unref();
  try {
    return await fn((d) => {
      detail = d;
    });
  } finally {
    clearInterval(timer);
    // A beat still in flight would land AFTER the clear below and resurrect
    // the record — with a fresh heartbeat, so health would read `working`
    // for a stage that had already ended, for up to the stall threshold.
    // The suite caught it as a leftover row; on the box it would have been
    // five minutes of a wrong status after every rebuild.
    await inFlight;
    await clearWork();
  }
}

/** Forget the stage. Also run at start-up, so a record left by a killed process is not read as current. */
export async function clearWork(): Promise<void> {
  try {
    await prisma.indexerState.deleteMany({ where: { key: WORKING_KEY } });
  } catch {
    /* as above */
  }
}

/** The stage in progress, or null. Parsed leniently: a malformed record is no record. */
export async function readWork(): Promise<Working | null> {
  const row = await prisma.indexerState.findUnique({ where: { key: WORKING_KEY } });
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.value) as Partial<Working>;
    if (typeof parsed.stage !== 'string' || typeof parsed.startedAt !== 'string' || typeof parsed.heartbeatAt !== 'string') {
      return null;
    }
    return {
      stage: parsed.stage,
      detail: typeof parsed.detail === 'string' ? parsed.detail : undefined,
      startedAt: parsed.startedAt,
      heartbeatAt: parsed.heartbeatAt,
    };
  } catch {
    return null;
  }
}
