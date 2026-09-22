/**
 * Where a live market figure comes from, and how a token's pairs are summed.
 *
 * The board is a token listing (§19: one row per token), so a market figure
 * on it is a fact about the token, not about one of its pools. A token on
 * this chain routinely has several — fee tiers, hooked variants, a v3 pool
 * beside a v4 one — and reading the day off whichever pair the row happened
 * to point at is what put $17.9K of volume on NVDA while its own page summed
 * several pairs. So a source answers with the token's pairs and the figures
 * are summed here, once, in `aggregate`.
 *
 * Two sources, asked in order:
 *
 *   dexscreener    the day's volume, its buys and sells, liquidity, FDV and
 *                  market cap, per pair. The only one that splits trades.
 *   geckoterminal  CoinGecko's DEX side, keyless. Answers token-level totals
 *                  (volume, reserve, FDV, market cap) directly, and the
 *                  deepest of its top pools gives the 24h change. It has no
 *                  trade split, so the row falls back to the chain's.
 *
 * The second exists because the first quoted 32 of the board's 76 tokens.
 * A token neither knows keeps the chain's figures, labelled as the chain's.
 *
 * What is NOT taken from either: anything that prices the site — the anchor,
 * the reserves the liquidity figure is built from, the fees, the yield, the
 * sparkline. Those stay derived from logs (§4) and stay checkable.
 *
 * Unverified from the session that wrote this: the sandbox reaches neither
 * host. Both parsers follow the documented response shape and read anything
 * else as "no quote"; `npm run market:probe` prints what each really answers.
 */

import type { MarketQuote, MarketSourceName } from '../../lib/data/types';
import { CHAIN, CONTRACTS, isEther } from '../../lib/chain';
import { USER_AGENT, type Fetch, type Log } from '../indexer/logo-sources';

/** A token to quote, and the pool its row points at. */
export interface MarketAsk {
  /** Lowercase token address. */
  address: string;
  /** Lowercase pool address (v3) or pool id (v4) — to report that pool's own liquidity. */
  pool: string;
  /** The row's ticker, so a status can name the tokens no source placed. */
  symbol?: string;
}

/** What a source answered. A token it does not know is simply absent from `quotes`. */
export interface SourceAnswer {
  quotes: Map<string, MarketQuote>;
  /**
   * Set when the source refused rather than answered — a rate limit, an
   * error, a timeout. The feed keeps its last quotes and backs this source
   * off; the other source is still asked.
   */
  refusal: string | null;
  /** Chain ids seen in the answer, for the health report and the DEXSCREENER_CHAIN hint. */
  chains?: string[];
  /**
   * Why this source answered nothing, when it did so without refusing — it
   * does not know the chain, say. It becomes the source's `lastError` in
   * `/api/health` and does NOT back the source off, because a source that
   * cannot ask has not been refused.
   */
  note?: string | null;
}

export interface MarketSource {
  name: MarketSourceName;
  /** How many tokens one request may carry. */
  batch: number;
  /**
   * How many tokens this source tolerates being asked about ALONE in one
   * refresh, when a batch came back without them.
   *
   * It is a rate-limit budget, so it belongs to the source rather than to
   * the feed: DexScreener answers hundreds of requests a minute and needs
   * the retries, because its batch answer is capped in pairs and the tokens
   * at the back get nothing (§20). GeckoTerminal is keyless and allows a
   * few dozen a minute, and its batch answer is per token rather than
   * capped — what its token index does not carry is asked for by the pool
   * instead, inside the same batch. A generous budget there would spend the
   * whole minute's allowance on retries and earn a 429.
   */
  singles: number;
  quotes(asks: MarketAsk[], ctx: { fetch: Fetch; log: Log; now: () => number }): Promise<SourceAnswer>;
}

const TIMEOUT_MS = 10_000;

interface Answer {
  status: number;
  body: unknown;
}

async function get(fetch: Fetch, url: string, headers: Record<string, string>): Promise<Answer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: { accept: 'application/json', 'user-agent': USER_AGENT, ...headers },
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

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function num(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/** A refusal's words, for the log and for `/api/health`. */
function refusalFor(source: string, status: number): string {
  if (status === 429) return `${source} answered 429 (rate limited)`;
  if (status === 0) return `${source} did not answer (timeout or network)`;
  return `${source} answered ${status}`;
}

// ---------------------------------------------------------------- summing --

/** One pair of a token, as a source reports it. */
export interface MarketPair {
  chainId: string;
  dexId: string;
  pairAddress: string;
  url: string;
  baseToken: string;
  quoteToken: string;
  /** The BASE token's price. A source's `priceUsd` is always about the base. */
  priceUsd: number | null;
  /**
   * The QUOTE token's price, where the source reports it. Ether is the quote
   * of most pairs on this chain, so without this the wrapper — which is how
   * the masthead's ETH price is asked for (§24) — could be priced only from
   * the rare pair it is the base of.
   */
  quotePriceUsd?: number | null;
  volume24hUsd: number;
  /** Null from a source that does not split trades. */
  buys24h: number | null;
  sells24h: number | null;
  priceChange24hPct: number | null;
  liquidityUsd: number | null;
  fdvUsd: number | null;
  marketCapUsd: number | null;
}

/**
 * The token's figures from its pairs.
 *
 * Summed: the day's volume, its buys and sells, and liquidity — those are
 * quantities, and a token's day is all of its pairs' days.
 *
 * Taken from the deepest pair: price, 24h change, FDV and market cap. Those
 * are not quantities to add up; each is one number about the token, and the
 * deepest pair is the one whose price is worth reading. Summing a market cap
 * over pairs would multiply it by the number of pools the token has.
 *
 * Null when no pair is on the wanted chain.
 *
 * A pair counts whichever side of it our token is on. A source names one
 * side the base and the other the quote, and which way round it puts a pair
 * is its own decision — so matching only the base silently dropped every
 * pair where it chose the other way, and the row fell back to a figure two
 * months old as though nobody listed the token. What such a pair may be read
 * for is narrower, though: `priceUsd`, `fdv` and `marketCap` describe the
 * BASE token, so a pair our token is the quote of contributes its volume,
 * its trade split and its liquidity, and never a price or a cap. Taking
 * those would have put another token's market cap on this row.
 */
export function aggregate(
  pairs: MarketPair[],
  token: string,
  pool: string,
  chain: string | null,
  source: MarketSourceName,
  at: string,
): MarketQuote | null {
  const address = token.toLowerCase();
  const byDepth = (a: MarketPair, b: MarketPair): number => {
    const la = a.liquidityUsd ?? -1;
    const lb = b.liquidityUsd ?? -1;
    if (lb !== la) return lb - la;
    return b.volume24hUsd - a.volume24hUsd;
  };
  // filter() copies, so this sorts the copy and never the caller's array.
  const candidates = pairs
    .filter(
      (p) =>
        (p.baseToken === address || p.quoteToken === address) &&
        (chain === null || p.chainId === chain),
    )
    .sort(byDepth);
  if (candidates.length === 0) return null;

  // One chain's pairs, always. A token address exists on other chains too,
  // and a sum across them belongs to no market — so with no chain configured
  // the deepest pair's chain decides, and /api/health reports every id seen
  // so the right one can be pinned.
  const deepest = candidates[0];
  const onChain = candidates.filter((p) => p.chainId === deepest.chainId);
  // The pairs this token is the base of: the only ones whose price and cap
  // are about it.
  const based = onChain.filter((p) => p.baseToken === address);

  // Which pairs count toward the quantities. Both sides, except for ether,
  // which is the chain's quote asset: it quotes nearly every pair here, a
  // source's answer is capped at a page of them, and summing that page would
  // put "most of the chain's volume, as far as we were told" on the ether row
  // as though it were a total. Ether's own markets are the pairs it is the
  // base of; its PRICE still comes from the quote side below, which is the
  // half of this that the masthead needs (§24).
  const quoteAsset = isEther(address) || address === CONTRACTS.weth.toLowerCase();
  const mine = quoteAsset && based.length > 0 ? based : onChain;
  // The deepest pair worth reading a price off. Failing that, the deepest
  // pair we are the QUOTE of, whose quote-side price is ours where the
  // source reports one.
  const priced = based[0] ?? null;
  const asQuote = priced ? null : (onChain.find((p) => (p.quotePriceUsd ?? null) !== null) ?? null);

  let volume = 0;
  let buys: number | null = null;
  let sells: number | null = null;
  let liquidity: number | null = null;
  for (const p of mine) {
    volume += p.volume24hUsd;
    if (p.buys24h !== null) buys = (buys ?? 0) + p.buys24h;
    if (p.sells24h !== null) sells = (sells ?? 0) + p.sells24h;
    if (p.liquidityUsd !== null) liquidity = (liquidity ?? 0) + p.liquidityUsd;
  }

  // The row's own pool, when the source lists that pair: a v3 pool's address
  // or a v4 pool's id. It fills the row's liquidity when the chain could not
  // reconstruct the reserves (§14), where the token-wide sum would answer a
  // different question.
  const own = pool ? mine.find((p) => p.pairAddress === pool.toLowerCase()) : undefined;

  // A cap read off the deepest pair this token is the BASE of; if it has
  // none, the deepest that does. Never off a pair it is the quote of: that
  // cap belongs to the other token.
  const hasCap = (p: MarketPair): boolean => p.marketCapUsd !== null || p.fdvUsd !== null;
  const withCap = priced && hasCap(priced) ? priced : based.find(hasCap);

  return {
    source,
    chainId: deepest.chainId,
    pairs: mine.length,
    dexId: deepest.dexId,
    pairAddress: deepest.pairAddress,
    url: deepest.url,
    priceUsd: priced ? priced.priceUsd : (asQuote?.quotePriceUsd ?? null),
    volume24hUsd: volume,
    buys24h: buys,
    sells24h: sells,
    // A pair's 24h change is the base token's, so it is read only from a
    // pair this token is the base of.
    priceChange24hPct: priced?.priceChange24hPct ?? null,
    liquidityUsd: liquidity,
    poolLiquidityUsd: own?.liquidityUsd ?? null,
    fdvUsd: withCap?.fdvUsd ?? null,
    marketCapUsd: withCap?.marketCapUsd ?? null,
    at,
  };
}

// ----------------------------------------------------------- DexScreener --

/**
 * The pairs in a `/latest/dex/tokens` answer, leniently: anything malformed
 * is left out rather than failing the batch.
 */
export function parsePairs(body: unknown): MarketPair[] {
  const record = asRecord(body);
  const raw = Array.isArray(record?.pairs) ? record!.pairs : Array.isArray(body) ? body : [];
  const out: MarketPair[] = [];
  for (const item of raw) {
    const pair = asRecord(item);
    if (!pair) continue;
    const base = asRecord(pair.baseToken);
    const quote = asRecord(pair.quoteToken);
    const pairAddress = String(pair.pairAddress ?? '').toLowerCase();
    const baseToken = String(base?.address ?? '').toLowerCase();
    if (!pairAddress || !baseToken) continue;
    const txns = asRecord(asRecord(pair.txns)?.h24);
    // DexScreener prices the BASE token two ways: in dollars and in the
    // quote. One divided by the other is the QUOTE token's price in dollars,
    // exactly — which is how the wrapper gets a price at all, since ether is
    // the quote of almost every pair here and the base of almost none.
    const usd = num(pair.priceUsd);
    const native = num(pair.priceNative);
    out.push({
      chainId: String(pair.chainId ?? '').toLowerCase(),
      dexId: String(pair.dexId ?? ''),
      pairAddress,
      url: typeof pair.url === 'string' ? pair.url : '',
      baseToken,
      quoteToken: String(quote?.address ?? '').toLowerCase(),
      priceUsd: usd,
      quotePriceUsd: usd !== null && native !== null && native > 0 ? usd / native : null,
      volume24hUsd: num(asRecord(pair.volume)?.h24) ?? 0,
      buys24h: txns ? Math.max(0, Math.round(num(txns.buys) ?? 0)) : null,
      sells24h: txns ? Math.max(0, Math.round(num(txns.sells) ?? 0)) : null,
      priceChange24hPct: num(asRecord(pair.priceChange)?.h24),
      liquidityUsd: num(asRecord(pair.liquidity)?.usd),
      fdvUsd: num(pair.fdv),
      marketCapUsd: num(pair.marketCap),
    });
  }
  return out;
}

/**
 * DexScreener. Ten tokens to a request: the endpoint takes thirty, but a
 * long batch's answer comes back capped in pairs and the tokens at the back
 * get nothing, which reads as "not listed" when it is not (§20). The feed
 * asks a token that came back empty on its own before believing that.
 */
export function dexscreener(options: { base?: string; chain?: string | null } = {}): MarketSource {
  const base = (options.base ?? 'https://api.dexscreener.com').replace(/\/+$/, '');
  const chain = options.chain?.trim().toLowerCase() || null;
  return {
    name: 'dexscreener',
    batch: 10,
    singles: 40,
    async quotes(asks, { fetch, now }) {
      const quotes = new Map<string, MarketQuote>();
      const answer = await get(fetch, `${base}/latest/dex/tokens/${asks.map((a) => a.address).join(',')}`, {});
      if (answer.status < 200 || answer.status >= 300) {
        return { quotes, refusal: refusalFor('DexScreener', answer.status) };
      }
      const pairs = parsePairs(answer.body);
      const at = new Date(now()).toISOString();
      for (const ask of asks) {
        const quote = aggregate(pairs, ask.address, ask.pool, chain, 'dexscreener', at);
        if (quote) quotes.set(ask.address, quote);
      }
      return { quotes, refusal: null, chains: [...new Set(pairs.map((p) => p.chainId))] };
    },
  };
}

// --------------------------------------------------------- GeckoTerminal --

/** How long a failed network-list lookup is left alone. */
export const NETWORK_RETRY_MS = 10 * 60_000;

/**
 * The tokens and the top pools in a `/tokens/multi/{addresses}?include=top_pools`
 * answer. Token attributes carry the chain-wide totals directly — volume,
 * reserve, FDV, market cap — so nothing is summed for those; the included
 * pools supply the 24h change and the row's own pool's liquidity.
 */
export function parseGeckoTokens(body: unknown, network: string): MarketPair[] {
  const record = asRecord(body);
  const data = Array.isArray(record?.data) ? record!.data : [];
  const included = Array.isArray(record?.included) ? record!.included : [];

  // Pools by base-token address, for the change and the per-pool liquidity.
  const pools = new Map<string, { address: string; dexId: string; liquidity: number | null; change: number | null; volume: number }[]>();
  for (const item of included) {
    const pool = asRecord(item);
    if (!pool || String(pool.type ?? '') !== 'pool') continue;
    const attrs = asRecord(pool.attributes);
    if (!attrs) continue;
    const baseId = String(asRecord(asRecord(asRecord(pool.relationships)?.base_token)?.data)?.id ?? '');
    const base = baseId.includes('_') ? baseId.slice(baseId.indexOf('_') + 1).toLowerCase() : baseId.toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(base)) continue;
    const list = pools.get(base) ?? [];
    list.push({
      address: String(attrs.address ?? '').toLowerCase(),
      dexId: String(asRecord(asRecord(asRecord(pool.relationships)?.dex)?.data)?.id ?? ''),
      liquidity: num(attrs.reserve_in_usd),
      change: num(asRecord(attrs.price_change_percentage)?.h24),
      volume: num(asRecord(attrs.volume_usd)?.h24) ?? 0,
    });
    pools.set(base, list);
  }

  const out: MarketPair[] = [];
  for (const item of data) {
    const token = asRecord(item);
    const attrs = asRecord(token?.attributes);
    if (!attrs) continue;
    const address = String(attrs.address ?? '').toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(address)) continue;
    const mine = (pools.get(address) ?? []).slice().sort((a, b) => (b.liquidity ?? -1) - (a.liquidity ?? -1));
    const deepest = mine[0];
    // One synthetic "pair" carrying the token's own totals: `aggregate` sums
    // a single row to itself, so the totals arrive unchanged.
    out.push({
      chainId: network,
      dexId: deepest?.dexId ?? '',
      pairAddress: deepest?.address ?? '',
      url: `https://www.geckoterminal.com/${network}/tokens/${address}`,
      baseToken: address,
      quoteToken: '',
      priceUsd: num(attrs.price_usd),
      volume24hUsd: num(asRecord(attrs.volume_usd)?.h24) ?? 0,
      // GeckoTerminal does not split a token's day into buys and sells; the
      // row shows the chain's split rather than a partial one from top pools.
      buys24h: null,
      sells24h: null,
      priceChange24hPct: deepest?.change ?? null,
      liquidityUsd: num(attrs.total_reserve_in_usd),
      fdvUsd: num(attrs.fdv_usd),
      marketCapUsd: num(attrs.market_cap_usd),
    });
  }
  return out;
}

/**
 * The pools in a `/networks/{network}/pools/multi/{addresses}` answer.
 *
 * GeckoTerminal indexes POOLS first and derives its token pages from them,
 * so a launchpad token missing from `/tokens/multi` can still have its pool
 * here — which is the whole reason this second lookup exists. A pool answer
 * also carries a trade split, which the token answer does not.
 *
 * Base and quote are whichever way round GeckoTerminal has the pool, which
 * for a Uniswap pool follows the currencies' address order rather than which
 * one anybody would call the token. `aggregate` matches either side.
 */
export function parseGeckoPools(body: unknown, network: string): MarketPair[] {
  const record = asRecord(body);
  const data = Array.isArray(record?.data) ? record!.data : [];
  const out: MarketPair[] = [];
  for (const item of data) {
    const pool = asRecord(item);
    const attrs = asRecord(pool?.attributes);
    if (!attrs) continue;
    const rel = asRecord(pool?.relationships);
    const side = (key: string): string => {
      const id = String(asRecord(asRecord(rel?.[key])?.data)?.id ?? '');
      const address = (id.includes('_') ? id.slice(id.indexOf('_') + 1) : id).toLowerCase();
      return /^0x[0-9a-f]{40}$/.test(address) ? address : '';
    };
    const baseToken = side('base_token');
    if (!baseToken) continue;
    const address = String(attrs.address ?? '').toLowerCase();
    const txns = asRecord(asRecord(attrs.transactions)?.h24);
    out.push({
      chainId: network,
      dexId: String(asRecord(asRecord(rel?.dex)?.data)?.id ?? ''),
      pairAddress: address,
      url: `https://www.geckoterminal.com/${network}/pools/${address}`,
      baseToken,
      quoteToken: side('quote_token'),
      priceUsd: num(attrs.base_token_price_usd),
      quotePriceUsd: num(attrs.quote_token_price_usd),
      volume24hUsd: num(asRecord(attrs.volume_usd)?.h24) ?? 0,
      buys24h: txns ? Math.max(0, Math.round(num(txns.buys) ?? 0)) : null,
      sells24h: txns ? Math.max(0, Math.round(num(txns.sells) ?? 0)) : null,
      priceChange24hPct: num(asRecord(attrs.price_change_percentage)?.h24),
      liquidityUsd: num(attrs.reserve_in_usd),
      fdvUsd: num(attrs.fdv_usd),
      marketCapUsd: num(attrs.market_cap_usd),
    });
  }
  return out;
}

/** The liquidity GeckoTerminal reports for one named pool, out of the same answer. */
export function geckoPoolLiquidity(body: unknown, pool: string): number | null {
  const included = asRecord(body)?.included;
  if (!Array.isArray(included) || !pool) return null;
  for (const item of included) {
    const record = asRecord(item);
    const attrs = asRecord(record?.attributes);
    if (!attrs) continue;
    if (String(attrs.address ?? '').toLowerCase() === pool.toLowerCase()) return num(attrs.reserve_in_usd);
  }
  return null;
}

/**
 * GeckoTerminal. Keyless, and the aggregator that reads what the launchpads
 * publish, so it reaches tokens DexScreener does not list. Its id for this
 * chain is discovered from its network list by name rather than guessed
 * (`GECKOTERMINAL_NETWORK` pins it); a chain it does not list disables the
 * source, once and audibly.
 */
export function geckoterminal(
  options: { base?: string; network?: string | null } = {},
): MarketSource & { network(): string | null | undefined } {
  const base = (options.base ?? 'https://api.geckoterminal.com/api/v2').replace(/\/+$/, '');
  const headers = { accept: 'application/json;version=20230302' };
  /** undefined = not asked yet; null = asked, and this chain is not there. */
  let network: string | null | undefined = options.network?.trim() || undefined;
  let retryAt = 0;
  let said = false;

  async function networkId(fetch: Fetch, log: Log, now: () => number): Promise<string | null> {
    if (network !== undefined) return network;
    if (now() < retryAt) return null;
    for (let page = 1; page <= 20; page++) {
      const { status, body } = await get(fetch, `${base}/networks?page=${page}`, headers);
      const rows = asRecord(body)?.data;
      if (!Array.isArray(rows)) {
        // Not an answer about this chain: try again later rather than
        // deciding the chain is absent on one bad response.
        retryAt = now() + NETWORK_RETRY_MS;
        void status;
        return null;
      }
      if (rows.length === 0) break;
      const hit = rows.map(asRecord).find((row) => {
        const attrs = asRecord(row?.attributes);
        return /robinhood/i.test(String(attrs?.name ?? '')) || /robinhood/i.test(String(row?.id ?? ''));
      });
      if (hit && typeof hit.id === 'string') {
        network = hit.id;
        log(`  market: GeckoTerminal knows this chain as "${network}"`);
        return network;
      }
    }
    network = null;
    if (!said) {
      said = true;
      log(`  market: GeckoTerminal does not list ${CHAIN.name}; source disabled`);
    }
    return null;
  }

  return {
    name: 'geckoterminal',
    // The documented cap for /tokens/multi.
    batch: 30,
    // Keyless, a few dozen calls a minute, and each single ask here costs
    // two of them once the by-pool lookup runs. The batch answers per token
    // and the pool lookup covers what its token index lacks, so this is an
    // edge case — a token with no pool recorded — not the main path.
    singles: 4,
    network: () => network,
    async quotes(asks, { fetch, log, now }) {
      const quotes = new Map<string, MarketQuote>();
      const id = await networkId(fetch, log, now);
      // Not a refusal and not an answer: the source cannot ask until it
      // knows the chain's id. Said out loud, because a source reporting no
      // quotes, no error and no reason is the status that sends whoever
      // reads it to the wrong place (§21).
      if (!id) {
        return {
          quotes,
          refusal: null,
          note:
            network === null
              ? `GeckoTerminal does not list ${CHAIN.name}`
              : 'GeckoTerminal: the network list did not answer; retrying shortly',
        };
      }
      const at = new Date(now()).toISOString();
      const url = `${base}/networks/${id}/tokens/multi/${asks.map((a) => a.address).join(',')}?include=top_pools`;
      const answer = await get(fetch, url, headers);
      if (answer.status < 200 || answer.status >= 300) {
        return { quotes, refusal: refusalFor('GeckoTerminal', answer.status) };
      }
      const tokens = parseGeckoTokens(answer.body, id);
      for (const ask of asks) {
        const quote = aggregate(tokens, ask.address, ask.pool, id, 'geckoterminal', at);
        if (!quote) continue;
        // A token-level answer itemises no pairs; `pairs: 0` is what the row
        // reads to say "the token's total" rather than "across N pairs".
        quote.pairs = 0;
        quote.poolLiquidityUsd = geckoPoolLiquidity(answer.body, ask.pool);
        quotes.set(ask.address, quote);
      }

      // The tokens that answer did not place, asked for again BY THEIR POOL.
      // GeckoTerminal indexes pools and derives its token pages from them, so
      // a launchpad token its token index does not carry can still have its
      // pool here — and a pool answer carries a trade split the token answer
      // does not. One extra request per batch, and only when something was
      // missed.
      const missing = asks.filter((a) => a.pool && !quotes.has(a.address));
      if (missing.length > 0) {
        const byPool = await get(
          fetch,
          `${base}/networks/${id}/pools/multi/${missing.map((a) => a.pool).join(',')}`,
          headers,
        );
        if (byPool.status < 200 || byPool.status >= 300) {
          // A note, not a refusal. The token lookup answered, so the source
          // is working; and how this chain's v4 pools are addressed here
          // could not be checked from the session that wrote it, so a
          // refusal would back the whole source off every refresh over a
          // lookup that is only a fallback — losing the coverage it does
          // have. It says what happened and the quotes it made stand.
          return {
            quotes,
            refusal: null,
            chains: [id],
            note: `${refusalFor('GeckoTerminal', byPool.status)} when asked by pool`,
          };
        }
        const pools = parseGeckoPools(byPool.body, id);
        for (const ask of missing) {
          const quote = aggregate(pools, ask.address, ask.pool, id, 'geckoterminal', at);
          if (quote) quotes.set(ask.address, quote);
        }
      }
      return { quotes, refusal: null, chains: [id] };
    },
  };
}
