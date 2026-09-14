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

export function AwaitingIndexer() {
  const [health, setHealth] = useState<Health | null>(null);
  const [unreachable, setUnreachable] = useState(false);

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

  // Four states, and only one of them is somebody's mistake.
  const eyebrow =
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
            : 'Waiting for the indexer';

  return (
    <div className="awaiting" role="status">
      <div className="aw-in">
        <span className="eyebrow">{eyebrow}</span>
        <p>
          {health?.status === 'no-anchor'
            ? 'Blocks are being indexed, but no WETH/USDG pool has turned up yet, ' +
              'so nothing has a dollar figure. This resolves itself as soon as one ' +
              'is indexed — no placeholder numbers in the meantime.'
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
