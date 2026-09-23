/**
 * Which Uniswap v4 position NFTs a wallet holds, asked of the chain's explorer.
 *
 * On the box `nextTokenId` is past three million, and the indexer's record of
 * who holds which is as far behind as its backfill (§30). The id scan covers
 * the newest 50,000 ids — a day or two of this chain — so a position minted on
 * another device a week ago, or sent to this wallet, was on neither list, and
 * a position not on the page cannot be withdrawn through the site.
 *
 * Blockscout keeps exactly that list: the ERC-721s an address holds, by
 * contract (`/api/v2/addresses/{address}/nft?type=ERC-721`). §4 allows an
 * outside source for metadata and never for a number, and this is neither a
 * price nor an amount — it is a list of CANDIDATES. Every id it names is then
 * confirmed on chain by `readV4Positions` (owner, pool, range, liquidity), so
 * a stale or wrong answer can only fail to add a row, never add a false one.
 * A failure is silent in effect: the scan and the indexer still answer.
 */

import { CONTRACTS } from '../../lib/chain';
import { USER_AGENT } from '../indexer/logo-sources';

export type ExplorerFetch = (url: string, init?: RequestInit) => Promise<Response>;

/** Pages of fifty; a wallet with more NFTs than this is a contract, not a person. */
const MAX_PAGES = 10;
const TIMEOUT_MS = 6_000;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** The token contract an item belongs to. Blockscout has spelled it `address_hash` and, earlier, `address`. */
function itemContract(item: Record<string, unknown>): string | null {
  const token = asRecord(item.token);
  const address = token?.address_hash ?? token?.address;
  return typeof address === 'string' ? address.toLowerCase() : null;
}

/**
 * The v4 PositionManager token ids the explorer says `owner` holds.
 * Throws when the explorer cannot be asked at all, so the caller can say so.
 */
export async function explorerPositionIds(
  owner: string,
  options: { base: string; fetch?: ExplorerFetch; manager?: string; maxPages?: number; timeoutMs?: number },
): Promise<bigint[]> {
  const fetchFn = options.fetch ?? fetch;
  const manager = (options.manager ?? CONTRACTS.positionManager).toLowerCase();
  const base = options.base.replace(/\/+$/, '');
  const ids = new Set<string>();
  let params: Record<string, unknown> | null = { type: 'ERC-721' };
  for (let page = 0; params && page < (options.maxPages ?? MAX_PAGES); page++) {
    const query = new URLSearchParams(
      Object.entries(params)
        .filter(([, v]) => v !== null && v !== undefined)
        .map(([k, v]) => [k, String(v)]),
    );
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? TIMEOUT_MS);
    let body: Record<string, unknown> | null;
    try {
      const response = await fetchFn(`${base}/api/v2/addresses/${owner.toLowerCase()}/nft?${query}`, {
        headers: { accept: 'application/json', 'user-agent': USER_AGENT },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`explorer answered ${response.status}`);
      body = asRecord(await response.json());
    } finally {
      clearTimeout(timer);
    }
    const items = Array.isArray(body?.items) ? body!.items : [];
    for (const raw of items) {
      const item = asRecord(raw);
      if (!item || itemContract(item) !== manager) continue;
      const id = item.id;
      if ((typeof id === 'string' && /^\d{1,78}$/.test(id)) || typeof id === 'number') ids.add(String(id));
    }
    const next = asRecord(body?.next_page_params);
    params = next ? { type: 'ERC-721', ...next } : null;
  }
  return [...ids].map((id) => BigInt(id));
}

/**
 * The same, remembered per wallet for half a minute (the page polls every
 * twenty seconds), with its state kept for `/api/health`.
 */
export class ExplorerPositions {
  private cache = new Map<string, { at: number; ids: bigint[] }>();
  private lastOkAt: number | null = null;
  private lastError: string | null = null;

  constructor(
    private readonly options: { base: string; fetch?: ExplorerFetch; ttlMs?: number; now?: () => number },
  ) {}

  /** Candidate ids, or null when the explorer could not be asked. */
  async owned(owner: string): Promise<bigint[] | null> {
    const now = (this.options.now ?? Date.now)();
    const key = owner.toLowerCase();
    const hit = this.cache.get(key);
    if (hit && now - hit.at < (this.options.ttlMs ?? 30_000)) return hit.ids;
    try {
      const ids = await explorerPositionIds(key, { base: this.options.base, fetch: this.options.fetch });
      this.cache.set(key, { at: now, ids });
      if (this.cache.size > 1_000) this.cache.delete(this.cache.keys().next().value!);
      this.lastOkAt = now;
      this.lastError = null;
      return ids;
    } catch (e) {
      this.lastError = (e as Error).name === 'AbortError' ? 'the explorer did not answer in time' : (e as Error).message.slice(0, 200);
      return hit?.ids ?? null;
    }
  }

  status(): { lastOkAt: string | null; lastError: string | null } {
    return { lastOkAt: this.lastOkAt === null ? null : new Date(this.lastOkAt).toISOString(), lastError: this.lastError };
  }
}
