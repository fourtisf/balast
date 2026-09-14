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

import { CHAIN, EXPLORER_URL, NATIVE_ETH } from '../../lib/chain';
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

async function getJson(fetch: Fetch, url: string, headers: Record<string, string>): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: { accept: 'application/json', ...headers },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
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

// ------------------------------------------------------------- CoinGecko --

/**
 * CoinGecko. Keyless at a few calls a minute; `COINGECKO_API_KEY` (a demo
 * key) raises that. The platform id for this chain is discovered from
 * `/asset_platforms` by chainId rather than guessed from a name.
 */
export function coingecko(options: { apiKey?: string | null; base?: string } = {}): LogoSource {
  const base = options.base ?? 'https://api.coingecko.com/api/v3';
  const headers: Record<string, string> = options.apiKey ? { 'x-cg-demo-api-key': options.apiKey } : {};
  /** undefined = not asked yet; null = asked, and this chain is not there. */
  let platform: string | null | undefined;
  let saidUnsupported = false;

  async function platformId(fetch: Fetch, log: Log): Promise<string | null> {
    if (platform !== undefined) return platform;
    const list = await getJson(fetch, `${base}/asset_platforms`, headers);
    if (!Array.isArray(list)) return null; // transient: ask again next time
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
        const coin = asRecord(await getJson(fetch, url, headers));
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

  // Listed tokens first: ordered by the largest FDV among the token's pools,
  // which is what the listing bar ranks on. Never-asked before asked-and-
  // missed, oldest first among equals.
  const candidates = await prisma.$queryRaw<{ address: string; symbol: string }[]>`
    SELECT t.address, t.symbol
    FROM tokens t
    LEFT JOIN (
      SELECT p.token0 AS token, MAX(ps.mc_usd) AS mc FROM pools p JOIN pool_state ps ON ps.pool_id = p.id GROUP BY p.token0
      UNION ALL
      SELECT p.token1 AS token, MAX(ps.mc_usd) AS mc FROM pools p JOIN pool_state ps ON ps.pool_id = p.id GROUP BY p.token1
    ) m ON lower(m.token) = lower(t.address)
    WHERE t.logo_url IS NULL
      AND (t.logo_checked_at IS NULL OR t.logo_checked_at < ${retryBefore})
    GROUP BY t.address, t.symbol, t.first_seen, t.logo_checked_at
    ORDER BY MAX(m.mc) DESC NULLS LAST, t.logo_checked_at ASC NULLS FIRST, t.first_seen ASC, t.address ASC
    LIMIT ${limit}
  `;

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
