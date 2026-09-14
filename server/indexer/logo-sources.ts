/**
 * Token logos from public sources, one token at a time.
 *
 * §4 permits logos and token metadata from external sources and forbids
 * numbers from them. `logos.ts` reads a token LIST; this reads per-token
 * lookups from the aggregators that have logos for tokens on this chain —
 * CoinGecko, DexScreener, CoinMarketCap — and it reads ONE FIELD from each:
 * an image URL. Not price, not supply, not decimals, not anything that could
 * become a figure on the site. A source can fail, lie, or vanish and not
 * one number changes.
 *
 * Three rules follow from the sources being public and rate-limited:
 *
 *   One token per call, on a clock the poller keeps (LOGO_LOOKUP_MS). Ten
 *   tokens a minute finds a board's worth of logos in minutes and stays
 *   under every free tier.
 *
 *   A token that was asked about is not asked again for a week
 *   (`logo_checked_at`), found or not. Most tokens on a launchpad chain are
 *   listed nowhere, and asking about them on every pass would spend the
 *   whole budget on the ones that will never answer.
 *
 *   Listed tokens first. Candidates are ordered by the largest fully
 *   diluted value of the pools they trade in, so the tokens on the board get
 *   their logos before the dust does.
 *
 * Whether a source knows this chain at all is discovered, not assumed:
 * CoinGecko is asked for its platform list and matched on chainId 4663, and
 * a source that does not know the chain disables itself and says so once.
 * None of these calls could be verified against the live services from the
 * session that wrote this — the response shapes are the ones the services
 * document, and every parser treats a shape it does not recognise as "not
 * found".
 */

import { getAddress } from 'viem';
import { CHAIN, EXPLORER_URL, NATIVE_ETH } from '../../lib/chain';
import { rpc } from '../chain/client';
import { prisma } from '../db';
import { isSafeLogoUrl } from './logos';

export type Log = (message: string) => void;

/** The subset of `fetch` these sources use, so a test can hand in a fake. */
export type Fetch = (
  url: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface LogoSource {
  readonly name: string;
  /**
   * An https image URL for the token, or null: not found, not supported, or
   * the source is unavailable. Never throws — a logo must never take a pass
   * down with it.
   */
  lookup(address: string, deps: { fetch: Fetch; log: Log }): Promise<string | null>;
}

const TIMEOUT_MS = 10_000;

/**
 * Sent with every request. Node's fetch identifies itself as `node`, and
 * the first run against the real explorer answered every such request with
 * a 403 in seventy milliseconds — an edge rule refusing an unknown client,
 * not an answer about the token. A named, browser-shaped agent with a URL
 * to look up is what those rules expect from a well-behaved service.
 */
export const USER_AGENT = 'Mozilla/5.0 (compatible; Balast/1.0; +https://balast.xyz)';

interface Answer {
  status: number;
  /** Parsed JSON for a 2xx; null for anything else. */
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
  } finally {
    clearTimeout(timer);
  }
}

async function getJson(fetch: Fetch, url: string, headers: Record<string, string>): Promise<unknown> {
  return (await get(fetch, url, headers)).body;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** The one field that may cross §4's line, and only when it is a safe URL. */
function image(value: unknown): string | null {
  return isSafeLogoUrl(value) ? value : null;
}

// ------------------------------------------------------------ Blockscout --

/**
 * The chain's own block explorer.
 *
 * Blockscout keeps an icon per token — supplied by the deployer, the
 * explorer's operators or its own upstream lists — and serves it from
 * `/api/v2/tokens/{address}` as `icon_url`. It is the one source native to
 * this chain rather than an aggregator that may or may not have heard of
 * it, so it is asked first. The base URL is the registry's (lib/chain.ts);
 * `EXPLORER_API_URL` overrides it for another explorer of the same shape.
 */
export function blockscout(options: { base?: string } = {}): LogoSource {
  const base = (options.base ?? EXPLORER_URL).replace(/\/+$/, '');
  return {
    name: 'explorer',
    async lookup(address, { fetch }) {
      // Ether has no token contract for the explorer to hold an entry for.
      if (address.toLowerCase() === NATIVE_ETH) return null;
      try {
        const token = asRecord(await getJson(fetch, `${base}/api/v2/tokens/${address.toLowerCase()}`, {}));
        return image(token?.icon_url);
      } catch {
        return null;
      }
    },
  };
}

// ------------------------------------------------- tokenised stocks --

/**
 * Robinhood's tokenised stocks — "AMD • Robinhood Token" — are the one
 * kind of token whose logo is knowable from the symbol alone: the ticker is
 * unique on its exchange, and the name says which kind of token it is. No
 * aggregator lists them, but a public repository of ticker icons does
 * (nvstly/icons on GitHub, one PNG per ticker). Only tokens whose name says
 * "Robinhood Token" are looked up this way: a launchpad coin that happens
 * to call itself GME must not wear GameStop's mark.
 *
 * The icons are drawn for a dark theme, so the badge paints them on ink
 * (see components/ui/TokenBadge.tsx).
 */
export const TICKER_ICON_BASE = 'https://raw.githubusercontent.com/nvstly/icons/main/ticker_icons';
const STOCK_TOKEN_NAME = /robinhood\s+token/i;

export function tickers(
  options: {
    base?: string;
    /** Symbol and name for an address; the database by default. */
    facts?: (address: string) => Promise<{ symbol: string; name: string } | null>;
  } = {},
): LogoSource {
  const base = (options.base ?? TICKER_ICON_BASE).replace(/\/+$/, '');
  const facts =
    options.facts ??
    (async (address: string) =>
      prisma.token.findUnique({
        where: { address: address.toLowerCase() },
        select: { symbol: true, name: true },
      }));
  return {
    name: 'tickers',
    async lookup(address, { fetch }) {
      try {
        const token = await facts(address);
        if (!token || !STOCK_TOKEN_NAME.test(token.name)) return null;
        const ticker = token.symbol.trim().toUpperCase();
        if (!/^[A-Z][A-Z0-9.]{0,9}$/.test(ticker)) return null;
        const url = `${base}/${ticker}.png`;
        const response = await fetch(url, { headers: { 'user-agent': USER_AGENT } });
        return response.ok ? url : null;
      } catch {
        return null;
      }
    },
  };
}

// ----------------------------------------------------------- on-chain --

/**
 * The token's own contract.
 *
 * Launchpads that follow ERC-7572 publish a `contractURI()`; home-grown
 * ones a `metadataURI()`, `image()`, `imageUrl()` or `logoURI()` — a URI
 * pointing at JSON with an `image`, or at the image itself. It is the one
 * source that is the launchpad's own word rather than an aggregator's copy
 * of it, and it needs nobody to have listed the token. Each candidate is
 * one `eth_call`; a contract without the function reverts, which costs the
 * call and nothing else.
 *
 * IPFS URIs resolve through a public gateway (`IPFS_GATEWAY`); a `data:`
 * JSON URI is decoded in place. Metadata is fetched only over https and
 * never from a bare IP or localhost, because a contract can name any host
 * it likes and this process runs on the box. Only an https image URL
 * crosses §4's line.
 */
const METADATA_FUNCTIONS = ['contractURI', 'metadataURI', 'image', 'imageUrl', 'logoURI'] as const;
type MetadataFunction = (typeof METADATA_FUNCTIONS)[number];
const METADATA_ABI = METADATA_FUNCTIONS.map((name) => ({
  type: 'function' as const,
  name,
  stateMutability: 'view' as const,
  inputs: [],
  outputs: [{ type: 'string' as const }],
}));
export const DEFAULT_IPFS_GATEWAY = 'https://ipfs.io/ipfs/';
const IMAGE_EXTENSION = /\.(png|jpe?g|gif|webp|svg|avif)(\?.*)?$/i;

/** An https URL on a named host, or null: never http, an IP literal or localhost. */
function publicHttps(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return null;
    const host = parsed.hostname;
    if (host === 'localhost' || host.endsWith('.local') || /^[\d.]+$/.test(host) || host.includes(':')) return null;
    return url;
  } catch {
    return null;
  }
}

/** ipfs://… and bare CIDs through the gateway; https as it is; anything else null. */
function resolveUri(uri: string, gateway: string): string | null {
  const trimmed = uri.trim();
  const ipfs = /^ipfs:\/\/(?:ipfs\/)?(.+)$/i.exec(trimmed);
  if (ipfs) return publicHttps(`${gateway}${ipfs[1]}`);
  if (/^(Qm[1-9A-HJ-NP-Za-km-z]{44}|bafy[a-z2-7]{50,})(\/.*)?$/.test(trimmed)) {
    return publicHttps(`${gateway}${trimmed}`);
  }
  return publicHttps(trimmed);
}

function imageFromMetadata(meta: unknown, gateway: string): string | null {
  const record = asRecord(meta);
  if (!record) return null;
  for (const key of ['image', 'image_url', 'imageUrl', 'logo', 'logoURI', 'icon']) {
    const value = record[key];
    if (typeof value === 'string' && value.trim() !== '') {
      const resolved = resolveUri(value, gateway);
      if (resolved && isSafeLogoUrl(resolved)) return resolved;
    }
  }
  return null;
}

export function onchain(
  options: {
    /** The string a view function returns, or null if the call reverts. */
    read?: (address: string, functionName: MetadataFunction) => Promise<string | null>;
    gateway?: string;
  } = {},
): LogoSource {
  const gateway = (options.gateway ?? process.env.IPFS_GATEWAY?.trim() ?? DEFAULT_IPFS_GATEWAY).replace(/\/*$/, '/');
  const read =
    options.read ??
    (async (address: string, functionName: MetadataFunction) => {
      try {
        const value = await rpc(
          (c) => c.readContract({ address: getAddress(address), abi: METADATA_ABI, functionName }),
          `${functionName}(${address})`,
        );
        return typeof value === 'string' ? value : null;
      } catch {
        return null;
      }
    });

  return {
    name: 'onchain',
    async lookup(address, { fetch }) {
      if (address.toLowerCase() === NATIVE_ETH) return null;
      try {
        for (const functionName of METADATA_FUNCTIONS) {
          const value = await read(address, functionName);
          if (!value || value.trim() === '') continue;
          const uri = value.trim();

          // Inline JSON: decoded here, no request made.
          const inline = /^data:application\/json(;base64)?,(.*)$/i.exec(uri);
          if (inline) {
            const text = inline[1] ? Buffer.from(inline[2], 'base64').toString('utf8') : decodeURIComponent(inline[2]);
            const found = imageFromMetadata(JSON.parse(text), gateway);
            if (found) return found;
            continue;
          }

          const resolved = resolveUri(uri, gateway);
          if (!resolved) continue;
          // The URI is the image itself, or JSON that names one.
          if (IMAGE_EXTENSION.test(new URL(resolved).pathname)) return isSafeLogoUrl(resolved) ? resolved : null;
          const found = imageFromMetadata(await getJson(fetch, resolved, {}), gateway);
          if (found) return found;
        }
        return null;
      } catch {
        return null;
      }
    },
  };
}

// ---------------------------------------------------------- GeckoTerminal --

/**
 * GeckoTerminal, CoinGecko's DEX side. Keyless, and the aggregator most
 * likely to carry a launchpad token's image, since it reads what the
 * launchpads publish. The network id for this chain is discovered from its
 * network list by name rather than guessed (`GECKOTERMINAL_NETWORK` pins
 * it), and a network that is not there disables the source and says so
 * once. `image_url` is the one field read; "missing.png" is its way of
 * saying none.
 */
export function geckoterminal(
  options: { base?: string; network?: string | null; now?: () => number } = {},
): LogoSource {
  const base = options.base ?? 'https://api.geckoterminal.com/api/v2';
  const headers = { accept: 'application/json;version=20230302' };
  const now = options.now ?? Date.now;
  /** undefined = not asked yet; null = asked, and this chain is not there. */
  let network: string | null | undefined = options.network || undefined;
  let retryAt = 0;
  let pausedUntil = 0;
  let said = false;

  async function networkId(fetch: Fetch, log: Log): Promise<string | null> {
    if (network !== undefined) return network;
    if (now() < retryAt) return null;
    // A handful of pages; the list is a few hundred networks.
    for (let page = 1; page <= 20; page++) {
      const { status, body } = await get(fetch, `${base}/networks?page=${page}`, headers);
      if (status === 429) pausedUntil = now() + RATE_LIMIT_PAUSE_MS;
      const rows = asRecord(body)?.data;
      if (!Array.isArray(rows)) {
        retryAt = now() + PLATFORM_RETRY_MS;
        return null;
      }
      if (rows.length === 0) break;
      const hit = rows.map(asRecord).find((row) => {
        const attrs = asRecord(row?.attributes);
        return /robinhood/i.test(String(attrs?.name ?? '')) || /robinhood/i.test(String(row?.id ?? ''));
      });
      if (hit && typeof hit.id === 'string') {
        network = hit.id;
        log(`  logos: GeckoTerminal knows this chain as "${network}"`);
        return network;
      }
    }
    network = null;
    if (!said) {
      said = true;
      log(`  logos: GeckoTerminal does not list ${CHAIN.name}; source disabled`);
    }
    return null;
  }

  return {
    name: 'geckoterminal',
    async lookup(address, { fetch, log }) {
      if (address.toLowerCase() === NATIVE_ETH) return null;
      if (now() < pausedUntil) return null;
      try {
        const id = await networkId(fetch, log);
        if (!id) return null;
        const answer = await get(fetch, `${base}/networks/${id}/tokens/${address.toLowerCase()}`, headers);
        if (answer.status === 429) pausedUntil = now() + RATE_LIMIT_PAUSE_MS;
        const attrs = asRecord(asRecord(asRecord(answer.body)?.data)?.attributes);
        const url = attrs?.image_url;
        if (typeof url !== 'string' || /missing\.png$/i.test(url)) return null;
        return image(url);
      } catch {
        return null;
      }
    },
  };
}

// ------------------------------------------------------------- CoinGecko --

/**
 * CoinGecko. Keyless at a few calls a minute; `COINGECKO_API_KEY` (a demo
 * key) raises that. The platform id for this chain is discovered from
 * `/asset_platforms` by chainId rather than guessed from a name.
 */
export function coingecko(
  options: { apiKey?: string | null; base?: string; now?: () => number } = {},
): LogoSource {
  const base = options.base ?? 'https://api.coingecko.com/api/v3';
  const headers: Record<string, string> = options.apiKey ? { 'x-cg-demo-api-key': options.apiKey } : {};
  const now = options.now ?? Date.now;
  /** undefined = not asked yet; null = asked, and this chain is not there. */
  let platform: string | null | undefined;
  let saidUnsupported = false;
  /**
   * The public API is rate-limited to a handful of calls a minute, and the
   * first real run showed what asking on every token does to that: one 404
   * on the platform list, then 429 on everything after. A failed platform
   * fetch is not retried for ten minutes and a 429 pauses the source for a
   * minute and a half, so one refusal costs one token, not the whole board.
   */
  let platformRetryAt = 0;
  let pausedUntil = 0;
  let saidPlatformFailed = false;

  function noteStatus(status: number): void {
    if (status === 429) pausedUntil = now() + RATE_LIMIT_PAUSE_MS;
  }

  async function platformId(fetch: Fetch, log: Log): Promise<string | null> {
    if (platform !== undefined) return platform;
    if (now() < platformRetryAt) return null;
    const { status, body: list } = await get(fetch, `${base}/asset_platforms`, headers);
    if (!Array.isArray(list)) {
      // Transient, or a refusal: either way not again for a while.
      platformRetryAt = now() + PLATFORM_RETRY_MS;
      noteStatus(status);
      if (!saidPlatformFailed) {
        saidPlatformFailed = true;
        log(`  logos: CoinGecko's platform list answered ${status}; asking again in 10 minutes`);
      }
      return null;
    }
    const match = list
      .map(asRecord)
      .find((row) => row && Number(row.chain_identifier) === CHAIN.id && typeof row.id === 'string');
    platform = match ? (match.id as string) : null;
    if (platform === null && !saidUnsupported) {
      saidUnsupported = true;
      log(`  logos: CoinGecko does not list chainId ${CHAIN.id}; source disabled`);
    }
    return platform;
  }

  return {
    name: 'coingecko',
    async lookup(address, { fetch, log }) {
      if (now() < pausedUntil) return null;
      try {
        // Ether is not a contract anywhere; it is CoinGecko's `ethereum`.
        const url =
          address.toLowerCase() === NATIVE_ETH
            ? `${base}/coins/ethereum?localization=false&tickers=false&market_data=false&community_data=false&developer_data=false`
            : await (async () => {
                const id = await platformId(fetch, log);
                return id ? `${base}/coins/${id}/contract/${address.toLowerCase()}` : null;
              })();
        if (!url) return null;
        const answer = await get(fetch, url, headers);
        noteStatus(answer.status);
        const coin = asRecord(answer.body);
        const img = asRecord(coin?.image);
        return image(img?.large) ?? image(img?.small) ?? image(img?.thumb);
      } catch {
        return null;
      }
    },
  };
}

// ----------------------------------------------------------- DexScreener --

/**
 * DexScreener. Keyless, address-keyed across every chain it indexes, and
 * the source most likely to know a launchpad token. The pair whose base
 * token is this address supplies the image; a pair on another chain at the
 * same address is the same deployer's same project, so the logo is right.
 */
export function dexscreener(options: { base?: string } = {}): LogoSource {
  const base = options.base ?? 'https://api.dexscreener.com';
  return {
    name: 'dexscreener',
    async lookup(address, { fetch }) {
      if (address.toLowerCase() === NATIVE_ETH) return null;
      try {
        const body = asRecord(await getJson(fetch, `${base}/latest/dex/tokens/${address.toLowerCase()}`, {}));
        const pairs = Array.isArray(body?.pairs) ? body!.pairs.map(asRecord) : [];
        for (const pair of pairs) {
          const baseToken = asRecord(pair?.baseToken);
          if (String(baseToken?.address ?? '').toLowerCase() !== address.toLowerCase()) continue;
          const found = image(asRecord(pair?.info)?.imageUrl);
          if (found) return found;
        }
        return null;
      } catch {
        return null;
      }
    },
  };
}

// --------------------------------------------------------- CoinMarketCap --

/** CoinMarketCap. Needs `CMC_API_KEY`; without one the source disables itself. */
export function coinmarketcap(options: { apiKey?: string | null; base?: string } = {}): LogoSource {
  const base = options.base ?? 'https://pro-api.coinmarketcap.com';
  let saidNoKey = false;
  return {
    name: 'coinmarketcap',
    async lookup(address, { fetch, log }) {
      if (!options.apiKey) {
        if (!saidNoKey) {
          saidNoKey = true;
          log('  logos: CMC_API_KEY is not set; CoinMarketCap source disabled');
        }
        return null;
      }
      try {
        const query =
          address.toLowerCase() === NATIVE_ETH ? 'slug=ethereum' : `address=${address.toLowerCase()}`;
        const body = asRecord(
          await getJson(fetch, `${base}/v2/cryptocurrency/info?${query}`, {
            'X-CMC_PRO_API_KEY': options.apiKey,
          }),
        );
        const data = asRecord(body?.data);
        for (const entry of Object.values(data ?? {})) {
          const found = image(asRecord(entry)?.logo);
          if (found) return found;
        }
        return null;
      } catch {
        return null;
      }
    },
  };
}

// ------------------------------------------------------------ the lookup --

/** Sources by name, in the order given; unknown names are ignored. */
export function createSources(names: readonly string[]): LogoSource[] {
  const sources: LogoSource[] = [];
  for (const name of names) {
    switch (name.trim().toLowerCase()) {
      case 'explorer':
      case 'blockscout':
        sources.push(blockscout({ base: process.env.EXPLORER_API_URL?.trim() || undefined }));
        break;
      case 'tickers':
      case 'stocks':
        sources.push(tickers());
        break;
      case 'onchain':
      case 'contract':
        sources.push(onchain());
        break;
      case 'geckoterminal':
        sources.push(geckoterminal({ network: process.env.GECKOTERMINAL_NETWORK?.trim() || null }));
        break;
      case 'coingecko':
        sources.push(coingecko({ apiKey: process.env.COINGECKO_API_KEY }));
        break;
      case 'dexscreener':
        sources.push(dexscreener());
        break;
      case 'coinmarketcap':
        sources.push(coinmarketcap({ apiKey: process.env.CMC_API_KEY }));
        break;
      default:
        break;
    }
  }
  return sources;
}

export const RETRY_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
/** After CoinGecko's platform list fails: how long before it is asked again. */
export const PLATFORM_RETRY_MS = 10 * 60 * 1000;
/** After a 429 from CoinGecko: how long the source stays quiet. */
export const RATE_LIMIT_PAUSE_MS = 90 * 1000;

/**
 * The tokens to ask about next, in the order the board shows them.
 *
 * Listed tokens first, by the 24h volume of their pools — the board's own
 * ranking — then by the largest FDV among them, then never-asked before
 * asked-and-missed. The first real run ordered by FDV alone and spent its
 * first three lookups on dust with absurd supplies while the tokens on the
 * board waited; the board is what people see, so it is what gets asked
 * about first. `retryBefore` null ignores the retry window (the probe).
 */
export async function logoCandidates(
  limit: number,
  retryBefore: Date | null,
): Promise<{ address: string; symbol: string }[]> {
  return prisma.$queryRaw<{ address: string; symbol: string }[]>`
    WITH latest AS (SELECT MAX(hour) AS newest FROM pool_fee_hourly),
    volume AS (
      SELECT f.pool_id, SUM(f.volume_usd) AS volume
      FROM pool_fee_hourly f, latest
      WHERE f.hour > latest.newest - interval '24 hours'
      GROUP BY f.pool_id
    ),
    by_token AS (
      SELECT side.token, MAX(COALESCE(v.volume, 0)) AS volume, MAX(COALESCE(ps.mc_usd, 0)) AS mc
      FROM pools p
      CROSS JOIN LATERAL (VALUES (p.token0), (p.token1)) AS side(token)
      LEFT JOIN volume v ON v.pool_id = p.id
      LEFT JOIN pool_state ps ON ps.pool_id = p.id
      GROUP BY side.token
    )
    SELECT t.address, t.symbol
    FROM tokens t
    LEFT JOIN by_token m ON lower(m.token) = lower(t.address)
    WHERE t.logo_url IS NULL
      AND (${retryBefore}::timestamptz IS NULL OR t.logo_checked_at IS NULL OR t.logo_checked_at < ${retryBefore})
    ORDER BY m.volume DESC NULLS LAST, m.mc DESC NULLS LAST,
             t.logo_checked_at ASC NULLS FIRST, t.first_seen ASC, t.address ASC
    LIMIT ${limit}
  `;
}

export interface LookupOptions {
  sources: LogoSource[];
  now?: Date;
  /** Tokens to ask about in this call. One, on the poller's clock. */
  limit?: number;
  fetch?: Fetch;
  log?: Log;
  retryAfterMs?: number;
}

/**
 * Ask the sources about the next tokens without a logo, best pool first.
 * Returns how many logos were found.
 */
export async function lookupLogos(options: LookupOptions): Promise<number> {
  const { sources } = options;
  if (sources.length === 0) return 0;
  const now = options.now ?? new Date();
  const limit = options.limit ?? 1;
  const fetch = options.fetch ?? (globalThis.fetch as unknown as Fetch);
  const log = options.log ?? (() => {});
  const retryBefore = new Date(now.getTime() - (options.retryAfterMs ?? RETRY_AFTER_MS));

  const candidates = await logoCandidates(limit, retryBefore);

  let found = 0;
  for (const token of candidates) {
    let url: string | null = null;
    let via = '';
    for (const source of sources) {
      url = await source.lookup(token.address, { fetch, log });
      if (url) {
        via = source.name;
        break;
      }
    }
    await prisma.token.update({
      where: { address: token.address },
      data: { logoCheckedAt: now, ...(url ? { logoUrl: url } : {}) },
    });
    if (url) {
      found++;
      log(`  logo for ${token.symbol} from ${via}`);
    }
  }
  return found;
}
