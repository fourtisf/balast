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

import { CONTRACTS, isEther } from '../../lib/chain';
import type { MarketQuote, MarketSourceName } from '../../lib/data/types';
import type { Fetch } from '../indexer/logo-sources';
import {
  type MarketAsk,
  type MarketSource,
  dexscreener,
  geckoterminal,
} from './market-sources';

export type { MarketQuote };
export { aggregate, parsePairs, parseGeckoTokens, parseGeckoPools, dexscreener, geckoterminal } from './market-sources';

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
  /**
   * Which ones, by ticker, up to thirty.
   *
   * A count alone cannot tell "no aggregator lists these tokens" from "our
   * feed is not asking about them", and those need opposite actions. Named,
   * `npm run market:probe -- <symbol's address>` answers it in one command.
   */
  unknownTokens: string[];
  lastRefreshAt: string | null;
  lastError: string | null;
  /** Chain ids seen in answers; more than one means DEXSCREENER_CHAIN should be set. */
  chains: string[];
  backoffUntil: string | null;
  sources: MarketSourceStatus[];
  /**
   * Why there are no live figures, when there are none.
   *
   * `followed: 0, quoted: 0, lastError: null` is three zeroes and no
   * explanation, and it was what the box reported while the feed had simply
   * never been told which tokens to quote. A status that cannot distinguish
   * "nothing to do" from "nothing working" sends whoever reads it to the
   * wrong place (§17).
   */
  note: string | null;
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

/** How long a token no source knew stays unasked on its own. */
export const MISS_RETRY_MS = 10 * 60_000;
/** A quote older than this is not live; it is dropped rather than shown. */
export const STALE_MS = 15 * 60_000;
const MAX_BACKOFF_MS = 10 * 60_000;
/** Ether's address for an aggregator: the wrapper's. */
const WETH = CONTRACTS.weth.toLowerCase();

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
  /**
   * `source|address` → when that source, asked about that token alone, came
   * back with nothing.
   *
   * Per source, and that is the whole point. Keyed by address alone, a token
   * GeckoTerminal answers for clears the mark DexScreener earned, so
   * DexScreener is asked about it alone again on the very next refresh — and
   * on every refresh after that, for ever. On the board that was forty extra
   * single requests every thirty seconds, which earns a 429, which backs the
   * source off for ten minutes, which leaves every row reading `chain`.
   */
  private misses = new Map<string, number>();
  /** Addresses no source answered for in the last completed refresh. */
  private unknown = new Set<string>();
  private warnedChains = false;
  /** Last logged quoted count, so the summary line is printed on a change. */
  private lastQuoted = -1;

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
    // Ether is asked for as its wrapper: no aggregator can be asked about
    // address(0), and aeWETH is one token per ether (§18), so the wrapper's
    // price is ether's. The board asks for the wrapper itself too, for the
    // masthead's ETH price (ethPrice), whether or not ether is on it.
    for (const t of tokens) {
      const address = isEther(t.address) ? WETH : t.address.toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(address)) continue;
      const pool = t.pool.toLowerCase();
      const before = next.get(address);
      next.set(address, {
        address,
        pool: pool || before?.pool || '',
        symbol: t.symbol || before?.symbol,
      });
      if (!this.followed.has(address)) added = true;
    }
    this.followed = next;
    if (added && !this.refreshing) this.schedule(0);
  }

  /** The live quote for a token, or null when there is none fresh enough. Ether answers as its wrapper. */
  quote(address: string): MarketQuote | null {
    const q = this.quotes.get(isEther(address) ? WETH : address.toLowerCase());
    if (!q) return null;
    if (this.now() - Date.parse(q.at) > STALE_MS) return null;
    return q;
  }

  /**
   * Ether in dollars, live: the wrapper's quote, when there is a fresh one
   * with a price on it. The masthead shows this over the chain's anchor
   * price, which is the price at the last indexed block and during a sync
   * is weeks old. Null when no source has answered, and the chain's figure
   * shows, labelled as the chain's.
   */
  ethPrice(): { usd: number; at: string; source: MarketSourceName } | null {
    const q = this.quote(WETH);
    if (!q || q.priceUsd === null || !(q.priceUsd > 0)) return null;
    return { usd: q.priceUsd, at: q.at, source: q.source };
  }

  status(): MarketStatus {
    let quoted = 0;
    let unknown = 0;
    const unknownTokens: string[] = [];
    const perSource = new Map<string, number>();
    for (const [address, ask] of this.followed) {
      const q = this.quote(address);
      if (q) {
        quoted++;
        perSource.set(q.source, (perSource.get(q.source) ?? 0) + 1);
      } else if (this.unknown.has(address)) {
        unknown++;
        if (unknownTokens.length < 30) unknownTokens.push(ask.symbol || address);
      }
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
      unknownTokens,
      lastRefreshAt: this.lastRefreshAt === null ? null : new Date(this.lastRefreshAt).toISOString(),
      lastError: this.lastError,
      chains: [...this.chains].sort(),
      backoffUntil: backoffUntil === undefined ? null : new Date(backoffUntil).toISOString(),
      note: !this.enabled
        ? 'DEXSCREENER_MARKET=false — the board shows the chain\'s own figures only.'
        : this.followed.size === 0
          ? 'No tokens followed yet: the board is learnt from the first snapshot the API ' +
            'builds, and none has been built since this process started.'
          : this.lastRefreshAt === null
            ? 'Following the board, but no refresh has completed yet.'
            : quoted === 0
              ? 'Every source answered without placing a token. Run `npm run market:probe -- ' +
                '0xTOKEN` to see what they return.'
              : null,
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

  private missedRecently(source: string, address: string): boolean {
    const at = this.misses.get(`${source}|${address}`);
    return at !== undefined && this.now() - at < MISS_RETRY_MS;
  }

  private async doRefresh(): Promise<number> {
    if (!this.enabled || this.followed.size === 0) return 0;
    const ctx = { fetch: this.fetch, log: this.log, now: this.now };
    let pending = [...this.followed.values()];
    let changed = 0;
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

    const take = (source: string, quotes: Map<string, MarketQuote>): void => {
      let moved = 0;
      for (const [address, quote] of quotes) {
        this.misses.delete(`${source}|${address}`);
        this.unknown.delete(address);
        quotedNow.add(address);
        const before = this.quotes.get(address);
        this.quotes.set(address, quote);
        if (!before || differs(before, quote)) moved++;
      }
      changed += moved;
      // Publish as the answers land, not when the whole cycle ends. A board
      // of eighty tokens is dozens of sequential requests across two sources;
      // holding every quote until the last one returned left every row
      // reading `chain` for the length of it after each restart.
      if (moved > 0) this.onUpdate?.();
    };

    for (const state of this.states) {
      if (pending.length === 0) break;
      if (this.now() < state.backoffUntil) continue;
      const name = state.source.name;
      const size = Math.max(1, state.source.batch);
      let refusal: string | null = null;
      let note: string | null = null;
      let singles = 0;
      const unanswered: MarketAsk[] = [];

      for (let i = 0; i < pending.length && !refusal; i += size) {
        const batch = pending.slice(i, i + size);
        const answer = await state.source.quotes(batch, ctx);
        for (const chain of answer.chains ?? []) if (chain) this.chains.add(chain);
        take(name, answer.quotes);
        if (answer.note) note = answer.note;
        if (answer.refusal) {
          refusal = answer.refusal;
          break;
        }
        for (const ask of batch) if (!answer.quotes.has(ask.address)) unanswered.push(ask);
      }

      // A token that got nothing in a batch is asked for alone: a long
      // batch's answer can be capped in pairs, and that says nothing about
      // the token (§20). Only worth doing for a source that batches, and only
      // for a token THIS source has not recently drawn a blank on.
      if (!refusal && size > 1 && state.source.singles > 0) {
        for (const ask of unanswered) {
          if (singles >= state.source.singles) break;
          if (this.missedRecently(name, ask.address)) continue;
          singles++;
          const answer = await state.source.quotes([ask], ctx);
          for (const chain of answer.chains ?? []) if (chain) this.chains.add(chain);
          take(name, answer.quotes);
          if (answer.refusal) {
            refusal = answer.refusal;
            break;
          }
          // Asked on its own and still nothing: this source does not list it.
          if (!answer.quotes.has(ask.address)) this.misses.set(`${name}|${ask.address}`, this.now());
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
        // A note is not a refusal: the source is not backed off for it, and
        // it stands as the reason under a source quoting nothing.
        state.lastError = note;
        state.backoffMs = 0;
        state.backoffUntil = 0;
      }

      pending = pending.filter((ask) => !quotedNow.has(ask.address));
    }

    // Nothing placed these. `unknown` is what /api/health reports, and it is
    // the last refresh's answer rather than a running total — a token that
    // starts being listed stops being unknown on the pass that finds it.
    if (answered) {
      this.unknown = new Set(pending.map((ask) => ask.address));
    }

    if (answered) {
      this.lastRefreshAt = this.now();
      this.lastError = lastRefusal;
      // One line whenever the picture changes, so `pm2 logs lockfi-api`
      // answers "why does every row read chain" without anyone guessing.
      const summary = this.status();
      const per = summary.sources.map((x) => `${x.name} ${x.quoted}`).join(', ');
      if (summary.quoted !== this.lastQuoted || lastRefusal !== null) {
        this.lastQuoted = summary.quoted;
        this.log(
          `  market: ${summary.quoted}/${summary.followed} tokens quoted (${per})` +
            `, ${summary.unknown} unknown` +
            (lastRefusal ? ` — ${lastRefusal}` : ''),
        );
      }
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
    // No publish here: `take` does it as each batch lands, so a trailing one
    // would wake every socket a second time for a snapshot already sent.
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
