/**
 * The last portfolio this browser read for a wallet, so a reload shows the
 * wallet's positions at once instead of "no positions yet".
 *
 * A wallet's portfolio is read from the chain on every load (server/api/
 * portfolio.ts) and that read can take many seconds on the free endpoints.
 * Until it answered, the page showed the snapshot's empty portfolio — which
 * says "no positions yet", a claim about the wallet the page had not checked
 * (§7). The last answer is kept here, per wallet, and shown on the next load
 * marked as kept; the first fresh answer replaces it. One older than
 * MAX_AGE_MS is not restored.
 *
 * Pure over a Storage-like object, so it is tested without a browser.
 */

import type { Portfolio } from './types';

export interface PortfolioStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const PREFIX = 'balast:portfolio:v1:';
/** Older than this, a kept portfolio is not restored: a week-old list of positions is a guess. */
export const MAX_AGE_MS = 7 * 24 * 60 * 60_000;

interface Stored {
  storedAt: number;
  portfolio: Portfolio;
}

export function storePortfolio(store: PortfolioStorage | null, wallet: string, portfolio: Portfolio, now = Date.now()): void {
  if (!store) return;
  try {
    // What was said about this read (kept, loading) is not part of it.
    const { status: _status, keptAt: _keptAt, ...plain } = portfolio;
    store.setItem(PREFIX + wallet.toLowerCase(), JSON.stringify({ storedAt: now, portfolio: plain } satisfies Stored));
  } catch {
    /* a private window or a full store is not an error */
  }
}

/** The kept portfolio for this wallet, marked as kept, or null. */
export function restorePortfolio(store: PortfolioStorage | null, wallet: string, now = Date.now()): Portfolio | null {
  if (!store) return null;
  let parsed: Stored;
  try {
    const raw = store.getItem(PREFIX + wallet.toLowerCase());
    if (!raw) return null;
    parsed = JSON.parse(raw) as Stored;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed.storedAt !== 'number' || !parsed.portfolio || !Array.isArray(parsed.portfolio.positions)) return null;
  const age = now - parsed.storedAt;
  if (!(age >= 0 && age <= MAX_AGE_MS)) return null;
  if ((parsed.portfolio.wallet ?? '').toLowerCase() !== wallet.toLowerCase()) return null;
  return { ...parsed.portfolio, status: 'kept', keptAt: new Date(parsed.storedAt).toISOString() };
}
