/**
 * Live market figures for the board, from aggregators, beside the chain's.
 *
 * The owner's call, and a deliberate exception to §4: *vol-nya realtime
 * pakai API DexScreener aja*, and then, looking at a board where much of it
 * still read wrong: *vol sama market cap ini ambil dari sumber mana masih
 * banyak yg tidak valid*. The indexer's figures are the chain's and stay the
 * chain's, but during a first sync they are weeks old. So the API asks an
 * aggregator for the day's volume, its trades, the 24h change, liquidity,
 * FDV and market cap of every listed token, on a cadence, and the snapshot
 * carries the answer beside the chain's figures under `Pool.market`. The row
 * and the drawer show it labelled with its source and its age; a token no
 * aggregator knows falls back to the chain's figure, labelled as that.
 *
 * Three things this shape fixes, each of which put a wrong number on a row:
 *
 *   - **A token, not a pool.** The board is a token listing (§19), and a
 *     token here has several pools. The quote was taken from one pair, so
 *     NVDA showed $17.9K of volume off a shallow v4 pair. `aggregate` in
 *     market-sources.ts sums the token's pairs.
 *   - **Two sources.** DexScreener quoted 32 of the board's 76 tokens; the
 *     other 44 rows fell back to figures two months old. GeckoTerminal is
 *     asked for what DexScreener did not answer, and a refusal now backs off
 *     that source alone rather than freezing the board.
 *   - **Market cap and liquidity too, not only volume.** The chain's market
 *     cap is a supply read at the *indexed* price, which during a first sync
 *     is the price two months ago; and a pool whose reserves the indexer
 *     cannot reconstruct showed a dash where an aggregator has the figure.
 *
 * What is NOT taken from an aggregator: anything that prices the site — the
 * anchor, the reserves, the fees, the yield, the sparkline, and the listing
 * bar's own thresholds. Those stay derived from logs (§4) and checkable.
 *
 * What is not trusted: a quote older than STALE_MS is dropped rather than
 * shown as live, and a refusal keeps the last quotes while that source backs
 * off. `/api/health` reports per source how many tokens it quotes.
 */

import type { MarketQuote } from '../../lib/data/types';
import type { Fetch } from '../indexer/logo-sources';
import {
  type MarketAsk,
  type MarketSource,
  dexscreener,
  geckoterminal,
} from './market-sources';

export type { MarketQuote };
export { aggregate, parsePairs, parseGeckoTokens, dexscreener, geckoterminal } from './market-sources';

export interface MarketSourceStatus {
  name: string;
  /** Tokens on the board currently carrying a fresh quote from this source. */
  quoted: number;
  lastError: string | null;
  backoffUntil: string | null;
}

export interface MarketStatus {
  enabled: boolean;
  followed: number;
  quoted: number;
  /** Tokens no source answered for, alone; asked again after MISS_RETRY_MS. */
  unknown: number;
  lastRefreshAt: string | null;
  lastError: string | null;
  /** Chain ids seen in answers; more than one means DEXSCREENER_CHAIN should be set. */
  chains: string[];
  backoffUntil: string | null;
  sources: MarketSourceStatus[];
}

export interface MarketFeedOptions {
  fetch?: Fetch;
  /** Given, these replace the default DexScreener → GeckoTerminal order (tests). */
  sources?: MarketSource[];
  base?: string;
  /** DexScreener's id for this chain. Unset, every chain's pairs are accepted and the ids seen are reported. */
  chain?: string | null;
  /** GeckoTerminal's id for this chain. Unset, it is discovered from its network list. */
  geckoNetwork?: string | null;
  geckoBase?: string;
  refreshMs?: number;
  enabled?: boolean;
  log?: (line: string) => void;
  /** Called after a refresh that changed something, so the API can push. */
  onUpdate?: () => void;
  now?: () => number;
}

/** Tokens re-asked alone per refresh, so a board of unknowns cannot turn one refresh into a hundred requests. */
const SINGLES_PER_REFRESH = 40;
/** How long a token no source knew stays unasked on its own. */
export const MISS_RETRY_MS = 10 * 60_000;
/** A quote older than this is not live; it is dropped rather than shown. */
export const STALE_MS = 15 * 60_000;
const MAX_BACKOFF_MS = 10 * 60_000;

interface SourceState {
  source: MarketSource;
  backoffMs: number;
  backoffUntil: number;
  lastError: string | null;
}

export class MarketFeed {
  private readonly fetch: Fetch;
  private readonly refreshMs: number;
  private readonly log: (line: string) => void;
  private readonly onUpdate?: () => void;
  private readonly now: () => number;
  private readonly states: SourceState[];
  readonly enabled: boolean;

  private followed = new Map<string, MarketAsk>();
  private quotes = new Map<string, MarketQuote>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private refreshing: Promise<number> | null = null;
  private lastRefreshAt: number | null = null;
  private lastError: string | null = null;
  private chains = new Set<string>();
  /** Address → when no source answered for it, asked alone. */
  private misses = new Map<string, number>();
  private warnedChains = false;

  constructor(options: MarketFeedOptions = {}) {
    this.fetch = options.fetch ?? (globalThis.fetch as unknown as Fetch);
    this.refreshMs = options.refreshMs ?? 30_000;
    this.enabled = options.enabled ?? true;
    this.log = options.log ?? (() => {});
    this.onUpdate = options.onUpdate;
    this.now = options.now ?? (() => Date.now());
    const sources = options.sources ?? [
      dexscreener({ base: options.base, chain: options.chain ?? null }),
      geckoterminal({ base: options.geckoBase, network: options.geckoNetwork ?? null }),
    ];
    this.states = sources.map((source) => ({ source, backoffMs: 0, backoffUntil: 0, lastError: null }));
  }

  /**
   * The tokens to keep quoted: the board's. New addresses are fetched on the
   * next refresh, which is scheduled at once if none is running.
   */
  follow(tokens: MarketAsk[]): void {
    if (!this.enabled) return;
    let added = false;
    const next = new Map<string, MarketAsk>();
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
    let unknown = 0;
    const perSource = new Map<string, number>();
    for (const address of this.followed.keys()) {
      const q = this.quote(address);
      if (q) {
        quoted++;
        perSource.set(q.source, (perSource.get(q.source) ?? 0) + 1);
      } else if (this.missedRecently(address)) unknown++;
    }
    const backoffUntil = this.states
      .map((s) => s.backoffUntil)
      .filter((at) => at > this.now())
      .sort((a, b) => a - b)[0];
    return {
      enabled: this.enabled,
      followed: this.followed.size,
      quoted,
      unknown,
      lastRefreshAt: this.lastRefreshAt === null ? null : new Date(this.lastRefreshAt).toISOString(),
      lastError: this.lastError,
      chains: [...this.chains].sort(),
      backoffUntil: backoffUntil === undefined ? null : new Date(backoffUntil).toISOString(),
      sources: this.states.map((s) => ({
        name: s.source.name,
        quoted: perSource.get(s.source.name) ?? 0,
        lastError: s.lastError,
        backoffUntil: s.backoffUntil > this.now() ? new Date(s.backoffUntil).toISOString() : null,
      })),
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
   * Ask each source, in order, for the tokens the one before it did not
   * answer for. Returns how many quotes changed. A refusal keeps the last
   * quotes and backs that source off, doubling to ten minutes; the next
   * success clears it, and the other source is asked either way.
   */
  refresh(): Promise<number> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.doRefresh().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private missedRecently(address: string): boolean {
    const at = this.misses.get(address);
    return at !== undefined && this.now() - at < MISS_RETRY_MS;
  }

  private async doRefresh(): Promise<number> {
    if (!this.enabled || this.followed.size === 0) return 0;
    const ctx = { fetch: this.fetch, log: this.log, now: this.now };
    let pending = [...this.followed.values()];
    let changed = 0;
    let singles = 0;
    let answered = false;
    let lastRefusal: string | null = null;
    /**
     * Quoted in THIS refresh — not "has a quote". A token last answered by
     * the second source still holds a fresh quote when the first source's
     * turn comes round again, and filtering on that would leave the second
     * source unasked until the quote went stale: a row updating every
     * fifteen minutes on a feed that refreshes every thirty seconds.
     */
    const quotedNow = new Set<string>();

    const take = (quotes: Map<string, MarketQuote>): void => {
      for (const [address, quote] of quotes) {
        this.misses.delete(address);
        quotedNow.add(address);
        const before = this.quotes.get(address);
        this.quotes.set(address, quote);
        if (!before || differs(before, quote)) changed++;
      }
    };

    for (const state of this.states) {
      if (pending.length === 0) break;
      if (this.now() < state.backoffUntil) continue;
      const size = Math.max(1, state.source.batch);
      let refusal: string | null = null;
      const unanswered: MarketAsk[] = [];

      for (let i = 0; i < pending.length && !refusal; i += size) {
        const batch = pending.slice(i, i + size);
        const answer = await state.source.quotes(batch, ctx);
        for (const chain of answer.chains ?? []) if (chain) this.chains.add(chain);
        take(answer.quotes);
        if (answer.refusal) {
          refusal = answer.refusal;
          break;
        }
        for (const ask of batch) if (!answer.quotes.has(ask.address)) unanswered.push(ask);
      }

      // A token that got nothing in a batch is asked for alone: a long
      // batch's answer can be capped in pairs, and that says nothing about
      // the token (§20). Only worth doing for a source that batches.
      if (!refusal && size > 1) {
        for (const ask of unanswered) {
          if (singles >= SINGLES_PER_REFRESH) break;
          if (this.missedRecently(ask.address)) continue;
          singles++;
          const answer = await state.source.quotes([ask], ctx);
          for (const chain of answer.chains ?? []) if (chain) this.chains.add(chain);
          take(answer.quotes);
          if (answer.refusal) {
            refusal = answer.refusal;
            break;
          }
        }
      }

      if (refusal) {
        lastRefusal = refusal;
        state.lastError = refusal;
        state.backoffMs = Math.min(MAX_BACKOFF_MS, state.backoffMs === 0 ? this.refreshMs : state.backoffMs * 2);
        state.backoffUntil = this.now() + state.backoffMs;
        this.log(
          `  market: ${refusal} — keeping the last quotes, ${state.source.name} back in ` +
            `${Math.round(state.backoffMs / 1000)}s`,
        );
      } else {
        answered = true;
        state.lastError = null;
        state.backoffMs = 0;
        state.backoffUntil = 0;
      }

      pending = pending.filter((ask) => !quotedNow.has(ask.address));
    }

    // Nothing knew these. Remembered, so they are not asked alone again for
    // MISS_RETRY_MS; a batch still carries them, which costs nothing.
    if (answered) for (const ask of pending) this.misses.set(ask.address, this.now());

    if (answered) {
      this.lastRefreshAt = this.now();
      this.lastError = lastRefusal;
      if (this.chains.size > 1 && !this.warnedChains) {
        this.warnedChains = true;
        this.log(
          `  market: answers carried pairs on ${[...this.chains].join(', ')} — ` +
            'set DEXSCREENER_CHAIN to the one that is Robinhood Chain',
        );
      }
    } else if (lastRefusal) {
      this.lastError = lastRefusal;
    }
    if (changed > 0) this.onUpdate?.();
    return changed;
  }
}

function differs(a: MarketQuote, b: MarketQuote): boolean {
  return (
    a.source !== b.source ||
    a.volume24hUsd !== b.volume24hUsd ||
    a.buys24h !== b.buys24h ||
    a.sells24h !== b.sells24h ||
    a.priceChange24hPct !== b.priceChange24hPct ||
    a.priceUsd !== b.priceUsd ||
    a.liquidityUsd !== b.liquidityUsd ||
    a.poolLiquidityUsd !== b.poolLiquidityUsd ||
    a.marketCapUsd !== b.marketCapUsd ||
    a.fdvUsd !== b.fdvUsd ||
    a.pairs !== b.pairs ||
    a.pairAddress !== b.pairAddress
  );
}
