'use client';

import { useEffect, useState } from 'react';
import { DATA_SOURCE } from '@/lib/data';

/**
 * What the site shows when there is no snapshot.
 *
 * The honest state — §7 forbids placeholder numbers — but "waiting for the
 * indexer" on its own is a blank wall: true, and no use to whoever opens the
 * site to find out what is wrong. It had exactly that problem in production,
 * where the real answer was a missing USDG_ADDRESS and nothing on the page
 * said so.
 *
 * So it asks `/api/health`, which knows, and shows the reason. Three states
 * it can report, each meaning something different:
 *
 *   misconfigured   the indexer cannot start — the message says what to set
 *   never-indexed   configured, running, has not written its first block yet
 *   (no answer)     the API itself is down
 */

interface Health {
  status?: string;
  message?: string;
  indexed?: {
    lastBlock?: string;
    headBlock?: string | null;
    blocksBehind?: string | null;
    progressPct?: number | null;
    syncing?: boolean;
  } | null;
  pools?: number;
  swaps?: number;
  working?: { stage: string; detail?: string | null; seconds?: number | null } | null;
}

const API_BASE =
  (typeof process !== 'undefined' ? process.env.NEXT_PUBLIC_API_BASE : undefined) ?? '';

/** Long enough not to hammer a struggling API, short enough to notice a fix. */
const RETRY_MS = 15_000;

/**
 * How far through the chain the indexer is, when it is still working.
 *
 * §7 says an indexer that is behind must say so rather than let stale numbers
 * pass as live. The same argument applies to an empty page: "nothing to show
 * yet" and "nothing to show, and nothing more is coming" look identical
 * without this, and they call for opposite responses. The numbers come from
 * `/api/health`, which reads the head the poller recorded — so this costs no
 * RPC call and cannot itself be the thing that is stuck.
 */
function SyncProgress({ health }: { health: Health | null }) {
  const indexed = health?.indexed;
  if (!indexed?.lastBlock || !indexed.headBlock) return null;
  const pct = indexed.progressPct ?? null;
  const last = Number(indexed.lastBlock);
  const head = Number(indexed.headBlock);
  if (!Number.isFinite(last) || !Number.isFinite(head) || head <= 0) return null;

  return (
    <div className="aw-sync">
      <div className="aw-bar" role="presentation">
        <span style={{ width: `${Math.max(0.5, Math.min(100, pct ?? 0))}%` }} />
      </div>
      <p className="aw-nums">
        <span>
          block {last.toLocaleString()} of {head.toLocaleString()}
        </span>
        <span>{pct === null ? '—' : `${pct.toFixed(2)}%`}</span>
      </p>
      <p className="aw-nums">
        <span>{(health?.pools ?? 0).toLocaleString()} pools</span>
        <span>{(health?.swaps ?? 0).toLocaleString()} swaps</span>
      </p>
    </div>
  );
}

/**
 * How long the panel stays invisible before it says anything at all.
 *
 * Every page load starts with no snapshot — the live provider is a fetch and
 * a socket — so this component renders for a moment on every refresh of a
 * perfectly healthy site. It used to spend that moment asserting "no indexed
 * blocks yet": a claim about the chain made before the API had been asked, on
 * a page that had been showing eighty markets a second earlier.
 *
 * A normal load resolves well inside this, so a refresh now shows nothing
 * rather than something false.
 */
const QUIET_MS = 900;

export function AwaitingIndexer() {
  const [health, setHealth] = useState<Health | null>(null);
  const [unreachable, setUnreachable] = useState(false);
  const [speak, setSpeak] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setSpeak(true), QUIET_MS);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (DATA_SOURCE !== 'live') return;
    let cancelled = false;

    const check = async () => {
      try {
        const response = await fetch(`${API_BASE}/api/health`, { cache: 'no-store' });
        // 503 is the expected answer here, and it carries the reason — so the
        // body is read whether or not the status is ok.
        const body = (await response.json()) as Health;
        if (cancelled) return;
        setHealth(body);
        setUnreachable(false);
      } catch {
        if (cancelled) return;
        setUnreachable(true);
      }
    };

    void check();
    const timer = setInterval(check, RETRY_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  // Nothing is drawn until either the API has answered or the quiet period
  // has passed. Both conditions matter: the first keeps a slow API from
  // leaving a blank page, the second keeps a fast one from flashing a
  // sentence nobody needed to read.
  if (!speak && health === null && !unreachable) return null;

  // Waiting on the API is its own state: it is not knowledge about the
  // indexer, so it borrows no other state's words.
  const asking = DATA_SOURCE === 'live' && health === null && !unreachable;

  // Four states, and only one of them is somebody's mistake.
  const knownEyebrow =
    DATA_SOURCE !== 'live'
      ? 'Loading'
      : unreachable
        ? 'The API is not answering'
        : health?.status === 'misconfigured'
          ? 'The indexer is misconfigured'
          : // Indexing, but no WETH/USDG pool found yet, so nothing has a
            // dollar figure. Transient and self-healing: it resolves itself
            // the moment that pool is indexed.
            health?.status === 'no-anchor'
            ? 'Looking for the USD anchor'
            : // Blocks are indexed and priced; the page simply has not
              // received its first snapshot yet. Saying "no indexed blocks"
              // here contradicted the progress line directly beneath it.
              health?.status === 'syncing' || health?.status === 'behind' || health?.status === 'ok'
              ? 'Loading the snapshot'
              : // A stage that writes no block — a full rebuild, the factory's
                // history — with a live heartbeat. Busy, and the message
                // beneath says on what and for how long.
                health?.status === 'working'
                ? 'The indexer is busy'
                : 'Waiting for the indexer';

  const eyebrow = asking ? 'Loading' : knownEyebrow;

  return (
    <div className="awaiting" role="status">
      <div className="aw-in">
        <span className="eyebrow">{eyebrow}</span>
        <p>
          {health?.status === 'no-anchor'
            ? 'Blocks are being indexed, but no WETH/USDG pool has turned up yet, ' +
              'so nothing has a dollar figure. This resolves itself as soon as one ' +
              'is indexed — no placeholder numbers in the meantime.'
            : health?.status === 'syncing' || health?.status === 'behind' || health?.status === 'ok'
              ? 'The indexer has priced data; the first snapshot is on its way. The ' +
                'boards appear as soon as it arrives — no placeholder numbers in the meantime.'
              : health?.status === 'working'
                ? 'The indexer is rebuilding its tables or reading history, and writes no ' +
                  'block until that finishes. The boards appear when it does — no placeholder ' +
                  'numbers in the meantime.'
                : asking
                  ? // The API has not answered, so nothing is known about the
                    // indexer — and an unanswered question is not evidence of
                    // an empty chain (§7).
                    'Asking the API what state the indexer is in. The boards appear as ' +
                    'soon as the snapshot arrives — no placeholder numbers in the meantime.'
                  : 'No indexed blocks yet, so there is nothing honest to show. The boards ' +
                    'appear as soon as the first swap is attributed — no placeholder ' +
                    'numbers in the meantime.'}
        </p>
        {health?.message ? <p className="aw-why">{health.message}</p> : null}
        <SyncProgress health={health} />
        {unreachable ? (
          <p className="aw-why">
            The front end is up but the API behind it is not responding. On the
            server, <code>bash deploy/doctor.sh</code> says which process is
            down and why.
          </p>
        ) : null}
      </div>
    </div>
  );
}
