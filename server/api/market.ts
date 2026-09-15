/**
 * Live market figures from DexScreener, for the board's volume.
 *
 * The owner's call, and a deliberate exception to §4: *vol-nya realtime
 * pakai API DexScreener aja*. The indexer's figures are the chain's and
 * will stay the chain's, but during a first sync they are weeks old, and
 * the owner wants today's volume on the row. So the API asks DexScreener
 * for the day's volume, buys, sells and price change of every listed token,
 * on a cadence, and the snapshot carries the answer beside the chain's
 * figures under `Pool.market`. The row and the drawer show it labelled with
 * its source; a token DexScreener does not know falls back to the chain's
 * figure, labelled as that.
 *
 * What is taken from it: the figures named above and nothing that prices
 * the site — not the anchor, not the reserves, not the fees. What is not
 * trusted: a quote older than STALE_MS is dropped rather than shown as live,
 * and a refusal keeps the last quotes while the feed backs off.
 *
 * One request per thirty tokens (the documented batch size), the batch
 * listing the board's tokens, so a board of fifty is two requests a
 * refresh. The pair chosen for a token is the one whose address is the
 * pool on the row — v3's pool address, v4's pool id — or else the deepest.
 *
 * Unverified from the session that wrote it: the sandbox cannot reach
 * DexScreener. The parser follows the documented response shape and treats
 * anything else as "no quote"; `npm run market:probe` prints what the real
 * endpoint answers, and `/api/health` reports how many tokens are quoted.
 */

import type { MarketQuote } from '../../lib/data/types';
import { USER_AGENT, type Fetch } from '../indexer/logo-sources';

export type { MarketQuote };

export interface MarketStatus {
  enabled: boolean;
  followed: number;
  quoted: number;
  lastRefreshAt: string | null;
  lastError: string | null;
  /** DexScreener's chain ids seen in answers; more than one means DEXSCREENER_CHAIN should be set. */
  chains: string[];
  backoffUntil: string | null;
}

export interface MarketFeedOptions {
  fetch?: Fetch;
  base?: string;
  /** DexScreener's id for this chain. Unset, every chain's pairs are accepted and the ids seen are reported. */
  chain?: string | null;
  refreshMs?: number;
  enabled?: boolean;
  log?: (line: string) => void;
  /** Called after a refresh that changed something, so the API can push. */
  onUpdate?: () => void;
  now?: () => number;
}

/** Tokens per request: DexScreener's documented batch size. */
const BATCH = 30;
/** A quote older than this is not live; it is dropped rather than shown. */
export const STALE_MS = 15 * 60_000;
const TIMEOUT_MS = 10_000;
const MAX_BACKOFF_MS = 10 * 60_000;

interface Followed {
  address: string;
  /** The pool on the row, to prefer its pair. */
  pool: string;
}

export class MarketFeed {
  private readonly fetch: Fetch;
  private readonly base: string;
  private readonly chain: string | null;
  private readonly refreshMs: number;
  private readonly log: (line: string) => void;
  private readonly onUpdate?: () => void;
  private readonly now: () => number;
  readonly enabled: boolean;

  private followed = new Map<string, Followed>();
  private quotes = new Map<string, MarketQuote>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private refreshing: Promise<number> | null = null;
  private lastRefreshAt: number | null = null;
  private lastError: string | null = null;
  private chains = new Set<string>();
  private backoffMs = 0;
  private backoffUntil = 0;
  private warnedChains = false;

  constructor(options: MarketFeedOptions = {}) {
    this.fetch = options.fetch ?? (globalThis.fetch as unknown as Fetch);
    this.base = (options.base ?? 'https://api.dexscreener.com').replace(/\/+$/, '');
    this.chain = options.chain?.trim().toLowerCase() || null;
    this.refreshMs = options.refreshMs ?? 30_000;
    this.enabled = options.enabled ?? true;
    this.log = options.log ?? (() => {});
    this.onUpdate = options.onUpdate;
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * The tokens to keep quoted: the board's. New addresses are fetched on the
   * next refresh, which is scheduled at once if none is running.
   */
  follow(tokens: Followed[]): void {
    if (!this.enabled) return;
    let added = false;
    const next = new Map<string, Followed>();
    for (const t of tokens) {
      const address = t.address.toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(address) || address === '0x0000000000000000000000000000000000000000') continue;
      next.set(address, { address, pool: t.pool.toLowerCase() });
      if (!this.followed.has(address)) added = true;
    }
    this.followed = next;
    if (added && !this.refreshing) this.schedule(0);
  }

  /** The live quote for a token, or null when there is none fresh enough. */
  quote(address: string): MarketQuote | null {
    const q = this.quotes.get(address.toLowerCase());
    if (!q) return null;
    if (this.now() - Date.parse(q.at) > STALE_MS) return null;
    return q;
  }

  status(): MarketStatus {
    let quoted = 0;
    for (const address of this.followed.keys()) if (this.quote(address)) quoted++;
    return {
      enabled: this.enabled,
      followed: this.followed.size,
      quoted,
      lastRefreshAt: this.lastRefreshAt === null ? null : new Date(this.lastRefreshAt).toISOString(),
      lastError: this.lastError,
      chains: [...this.chains].sort(),
      backoffUntil: this.backoffUntil > this.now() ? new Date(this.backoffUntil).toISOString() : null,
    };
  }

  start(): void {
    if (!this.enabled || this.timer) return;
    this.schedule(this.refreshMs);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(ms: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.refresh()
        .catch(() => {})
        .finally(() => {
          if (this.enabled) this.schedule(this.refreshMs);
        });
    }, ms);
    this.timer.unref?.();
  }

  /**
   * Ask about every followed token, thirty at a time. Returns how many
   * quotes changed. A refusal or a failure keeps the last quotes and backs
   * off, doubling to ten minutes; the next success clears it.
   */
  refresh(): Promise<number> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.doRefresh().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async doRefresh(): Promise<number> {
    if (!this.enabled || this.followed.size === 0) return 0;
    if (this.now() < this.backoffUntil) return 0;
    const addresses = [...this.followed.keys()];
    let changed = 0;
    let failed: string | null = null;
    for (let i = 0; i < addresses.length; i += BATCH) {
      const batch = addresses.slice(i, i + BATCH);
      const answer = await this.get(`${this.base}/latest/dex/tokens/${batch.join(',')}`);
      if (answer.status === 429) {
        failed = 'DexScreener answered 429 (rate limited)';
        break;
      }
      if (answer.status < 200 || answer.status >= 300) {
        failed = `DexScreener answered ${answer.status}`;
        break;
      }
      const pairs = parsePairs(answer.body);
      const at = new Date(this.now()).toISOString();
      for (const address of batch) {
        const pair = choosePair(pairs, address, this.followed.get(address)?.pool ?? '', this.chain);
        if (!pair) continue;
        this.chains.add(pair.chainId);
        const quote = toQuote(pair, at);
        const before = this.quotes.get(address);
        this.quotes.set(address, quote);
        if (!before || differs(before, quote)) changed++;
      }
    }
    if (failed) {
      this.lastError = failed;
      this.backoffMs = Math.min(MAX_BACKOFF_MS, this.backoffMs === 0 ? this.refreshMs : this.backoffMs * 2);
      this.backoffUntil = this.now() + this.backoffMs;
      this.log(`  market: ${failed} — keeping the last quotes, next try in ${Math.round(this.backoffMs / 1000)}s`);
    } else {
      this.lastError = null;
      this.backoffMs = 0;
      this.backoffUntil = 0;
      this.lastRefreshAt = this.now();
      if (this.chains.size > 1 && !this.warnedChains) {
        this.warnedChains = true;
        this.log(
          `  market: DexScreener answered pairs on ${[...this.chains].join(', ')} — ` +
            'set DEXSCREENER_CHAIN to the one that is Robinhood Chain',
        );
      }
    }
    if (changed > 0) this.onUpdate?.();
    return changed;
  }

  private async get(url: string): Promise<{ status: number; body: unknown }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await this.fetch(url, {
        headers: { accept: 'application/json', 'user-agent': USER_AGENT },
        signal: controller.signal,
      });
      if (!response.ok) return { status: response.status, body: null };
      return { status: response.status, body: await response.json() };
    } catch {
      // A timeout or a network failure: not an answer, and not a 429.
      return { status: 0, body: null };
    } finally {
      clearTimeout(timer);
    }
  }
}

// ----------------------------------------------------------------- parsing --

export interface DexPair {
  chainId: string;
  dexId: string;
  pairAddress: string;
  url: string;
  baseToken: string;
  quoteToken: string;
  priceUsd: number | null;
  volume24hUsd: number;
  buys24h: number;
  sells24h: number;
  priceChange24hPct: number | null;
  liquidityUsd: number | null;
  fdvUsd: number | null;
  marketCapUsd: number | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function num(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/** The pairs in a `/latest/dex/tokens` answer, leniently: anything malformed is left out. */
export function parsePairs(body: unknown): DexPair[] {
  const record = asRecord(body);
  const raw = Array.isArray(record?.pairs) ? record!.pairs : Array.isArray(body) ? body : [];
  const out: DexPair[] = [];
  for (const item of raw) {
    const pair = asRecord(item);
    if (!pair) continue;
    const base = asRecord(pair.baseToken);
    const quote = asRecord(pair.quoteToken);
    const pairAddress = String(pair.pairAddress ?? '').toLowerCase();
    const baseToken = String(base?.address ?? '').toLowerCase();
    if (!pairAddress || !baseToken) continue;
    const txns = asRecord(asRecord(pair.txns)?.h24);
    out.push({
      chainId: String(pair.chainId ?? '').toLowerCase(),
      dexId: String(pair.dexId ?? ''),
      pairAddress,
      url: typeof pair.url === 'string' ? pair.url : '',
      baseToken,
      quoteToken: String(quote?.address ?? '').toLowerCase(),
      priceUsd: num(pair.priceUsd),
      volume24hUsd: num(asRecord(pair.volume)?.h24) ?? 0,
      buys24h: Math.max(0, Math.round(num(txns?.buys) ?? 0)),
      sells24h: Math.max(0, Math.round(num(txns?.sells) ?? 0)),
      priceChange24hPct: num(asRecord(pair.priceChange)?.h24),
      liquidityUsd: num(asRecord(pair.liquidity)?.usd),
      fdvUsd: num(pair.fdv),
      marketCapUsd: num(pair.marketCap),
    });
  }
  return out;
}

/**
 * The pair that stands for a token: the pool on the row when DexScreener
 * has it, else the deepest, else the busiest. Only pairs where the token is
 * the base, and only on the configured chain when one is configured.
 */
export function choosePair(pairs: DexPair[], token: string, pool: string, chain: string | null): DexPair | null {
  const address = token.toLowerCase();
  const candidates = pairs.filter(
    (p) => p.baseToken === address && (chain === null || p.chainId === chain),
  );
  if (candidates.length === 0) return null;
  const exact = candidates.find((p) => p.pairAddress === pool.toLowerCase());
  if (exact) return exact;
  return candidates.slice().sort((a, b) => {
    const la = a.liquidityUsd ?? -1;
    const lb = b.liquidityUsd ?? -1;
    if (lb !== la) return lb - la;
    return b.volume24hUsd - a.volume24hUsd;
  })[0];
}

function toQuote(pair: DexPair, at: string): MarketQuote {
  return {
    source: 'dexscreener',
    chainId: pair.chainId,
    dexId: pair.dexId,
    pairAddress: pair.pairAddress,
    url: pair.url,
    priceUsd: pair.priceUsd,
    volume24hUsd: pair.volume24hUsd,
    buys24h: pair.buys24h,
    sells24h: pair.sells24h,
    priceChange24hPct: pair.priceChange24hPct,
    liquidityUsd: pair.liquidityUsd,
    fdvUsd: pair.fdvUsd,
    marketCapUsd: pair.marketCapUsd,
    at,
  };
}

function differs(a: MarketQuote, b: MarketQuote): boolean {
  return (
    a.volume24hUsd !== b.volume24hUsd ||
    a.buys24h !== b.buys24h ||
    a.sells24h !== b.sells24h ||
    a.priceChange24hPct !== b.priceChange24hPct ||
    a.priceUsd !== b.priceUsd ||
    a.pairAddress !== b.pairAddress
  );
}
