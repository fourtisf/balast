/**
 * The page's side of Ask LockFi (server/api/ask.ts).
 *
 * Only the question, the conversation so far, the pool's id and the
 * builder's plan are sent. The pool's figures are the server's to supply,
 * from its own snapshot, so nothing on this side can put a number in the
 * model's mouth.
 */

import type { ShapeId } from './data/types';
import { API_BASE } from './site';

/**
 * Simulated data has no API behind it, so the assistant is not asked about
 * at all there: a request to a route that does not exist would hang the page
 * on Next.js's 404. `localStorage['lockfi:ask'] = 'on'` turns the panel on
 * anyway, for a demo or a test that answers `/api/ask` itself.
 */
export function askReachable(live: boolean): boolean {
  if (live) return true;
  try {
    return typeof window !== 'undefined' && window.localStorage.getItem('lockfi:ask') === 'on';
  } catch {
    return false;
  }
}

export interface AskPlan {
  fullRange: boolean;
  shape: ShapeId;
  minPct: number;
  maxPct: number;
  bins: number;
  deposit: number | null;
}

/** One of the person's positions, as the portfolio row shows it (server/api/ask.ts `AskPosition`). */
export interface AskPosition {
  tokenId: string;
  pair: string;
  protocol: 'v3' | 'v4' | null;
  range: 'full' | { minPct: number; maxPct: number } | null;
  status: 'in-range' | 'out-of-range' | 'unknown';
  outOfRangeHours: number | null;
  valueUsd: number | null;
  uncollectedFeesUsd: number | null;
  priceImpactUsd: number | null;
  priceImpactPct: number | null;
}

export interface AskTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface AskStatus {
  enabled: boolean;
  provider: string;
}

export type AskResult = { ok: true; answer: string } | { ok: false; message: string };

/** Whether the assistant is on. False on simulated data, where there is no API. */
export async function askStatus(fetchImpl: typeof fetch = fetch): Promise<AskStatus> {
  try {
    const res = await fetchImpl(`${API_BASE}/api/ask`, { cache: 'no-store', signal: AbortSignal.timeout(8_000) });
    if (!res.ok) return { enabled: false, provider: '' };
    const json = (await res.json()) as Partial<AskStatus>;
    return { enabled: json.enabled === true, provider: typeof json.provider === 'string' ? json.provider : '' };
  } catch {
    return { enabled: false, provider: '' };
  }
}

export async function ask(
  body: { question: string; history: AskTurn[]; poolId: string | null; plan: AskPlan | null; position?: AskPosition | null },
  fetchImpl: typeof fetch = fetch,
): Promise<AskResult> {
  try {
    const res = await fetchImpl(`${API_BASE}/api/ask`, {
      method: 'POST',
      signal: AbortSignal.timeout(45_000),
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => null)) as { answer?: unknown; message?: unknown } | null;
    if (res.ok && typeof json?.answer === 'string') return { ok: true, answer: json.answer };
    if (res.status === 429 && typeof json?.message !== 'string') {
      return { ok: false, message: 'Too many questions at once. Wait a minute and ask again.' };
    }
    return {
      ok: false,
      message: typeof json?.message === 'string' ? json.message : 'The assistant could not answer just now.',
    };
  } catch {
    return { ok: false, message: 'Could not reach the assistant. Check your connection and try again.' };
  }
}
