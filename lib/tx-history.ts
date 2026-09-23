/**
 * What this wallet has sent through the site, kept in the browser.
 *
 * A mint, an approval, a collect or a withdrawal used to be forgotten the
 * moment the page reloaded (§22). The chain remembers, but the chain does
 * not know which of a wallet's transactions came from here or what they
 * were for, so the browser keeps a short list per wallet: hash, kind, a
 * label, and whether it has been mined. It is a convenience, not a record
 * — `localStorage` is per browser and can be cleared — and the explorer
 * link on every row is the record.
 */

import type { Hex } from 'viem';

export type TxKind = 'approve' | 'wrap' | 'swap' | 'mint' | 'collect' | 'withdraw';
export type TxStatus = 'pending' | 'success' | 'reverted';

export interface TxRecord {
  hash: Hex;
  kind: TxKind;
  /** Lowercase. */
  wallet: string;
  /** Unix milliseconds when it was sent. */
  at: number;
  status: TxStatus;
  /** In words: "Mint 24 positions in NVDA / USDG". */
  label: string;
  poolId?: string;
  tokenId?: string;
  /**
   * A mint's receipt: the position NFTs it created and which manager created
   * them. The portfolio asks the chain about these ids, so a position is on
   * the page — and can be withdrawn — the moment its receipt is in, whatever
   * the indexer has read.
   */
  minted?: { protocol: 'v3' | 'v4'; tokenIds: string[] };
}

/** The subset of Storage this needs, so a test can hand in a Map. */
export interface TxStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const TX_HISTORY_KEY = 'balast:tx';
/** Per wallet; older entries fall off the end. */
export const TX_HISTORY_MAX = 50;
/** Dispatched on `window` after any change, so an open page re-reads. */
export const TX_CHANGED_EVENT = 'balast:tx-changed';

function storage(given?: TxStorage): TxStorage | null {
  if (given) return given;
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function readAll(store: TxStorage): TxRecord[] {
  try {
    const raw = store.getItem(TX_HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (r): r is TxRecord =>
        r !== null && typeof r === 'object' && typeof (r as TxRecord).hash === 'string' && typeof (r as TxRecord).wallet === 'string',
    );
  } catch {
    return [];
  }
}

function writeAll(store: TxStorage, records: TxRecord[]): void {
  try {
    store.setItem(TX_HISTORY_KEY, JSON.stringify(records));
  } catch {
    /* private mode, or full: the history is a convenience */
  }
  if (typeof window !== 'undefined' && store === (storage() as unknown)) {
    window.dispatchEvent(new Event(TX_CHANGED_EVENT));
  }
}

/** This wallet's transactions, newest first. */
export function listTx(wallet: string, store?: TxStorage): TxRecord[] {
  const s = storage(store);
  if (!s) return [];
  const w = wallet.toLowerCase();
  return readAll(s)
    .filter((r) => r.wallet === w)
    .sort((a, b) => b.at - a.at);
}

/** Add one, or replace the one with the same hash. */
export function recordTx(record: TxRecord, store?: TxStorage): void {
  const s = storage(store);
  if (!s) return;
  const wallet = record.wallet.toLowerCase();
  const all = readAll(s).filter((r) => r.hash.toLowerCase() !== record.hash.toLowerCase());
  const mine = all.filter((r) => r.wallet === wallet);
  const others = all.filter((r) => r.wallet !== wallet);
  const kept = [{ ...record, wallet }, ...mine].sort((a, b) => b.at - a.at).slice(0, TX_HISTORY_MAX);
  writeAll(s, [...others, ...kept]);
}

/** Mark a transaction mined, one way or the other. */
export function updateTx(hash: Hex, status: TxStatus, store?: TxStorage): void {
  const s = storage(store);
  if (!s) return;
  const all = readAll(s);
  const target = all.find((r) => r.hash.toLowerCase() === hash.toLowerCase());
  if (!target || target.status === status) return;
  target.status = status;
  writeAll(s, all);
}

/** Record the NFTs a mint created, from its receipt. */
export function recordMinted(hash: Hex, protocol: 'v3' | 'v4', tokenIds: bigint[], store?: TxStorage): void {
  const s = storage(store);
  if (!s || tokenIds.length === 0) return;
  const all = readAll(s);
  const target = all.find((r) => r.hash.toLowerCase() === hash.toLowerCase());
  if (!target) return;
  target.minted = { protocol, tokenIds: tokenIds.map((id) => id.toString()) };
  writeAll(s, all);
}

/**
 * The v4 token ids this browser saw minted to this wallet, newest first.
 * Hints for the portfolio, which confirms each on chain; a stale one (sent
 * away, burned) is simply not shown.
 */
export function mintedV4Ids(wallet: string, store?: TxStorage): string[] {
  const ids = listTx(wallet, store)
    .filter((r) => r.kind === 'mint' && r.status === 'success' && r.minted?.protocol === 'v4')
    .flatMap((r) => r.minted!.tokenIds)
    .filter((id) => /^\d{1,30}$/.test(id));
  return [...new Set(ids)].slice(0, 50);
}
