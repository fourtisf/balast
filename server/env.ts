/**
 * Server configuration. Read once, validated once, and never read from
 * `process.env` anywhere else — a typo'd variable name should stop the process
 * at boot, not produce an indexer that quietly follows the wrong chain.
 */

// Before any value below is read. Also imported first by each entry point,
// because other modules read process.env at their own top level and module
// evaluation order would otherwise decide whether they saw the file.
import './load-env';
import { RPC_URLS } from './chain/endpoints';
import { EXPLORER_URL } from '../lib/chain';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required. See .env.example.`);
  return value;
}

function list(name: string, fallback: string[]): string[] {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = raw.split(',').map((s) => s.trim()).filter(Boolean);
  return parsed.length > 0 ? parsed : fallback;
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got "${raw}"`);
  return Math.trunc(n);
}

export const env = {
  databaseUrl: required('DATABASE_URL'),
  /** Optional: without it the API fans out in-process and a second instance
   *  would not see the first one's ticks. Fine for one box (§2). */
  redisUrl: process.env.REDIS_URL ?? null,

  // Defined in chain/endpoints.ts, which has no database requirement — see
  // the note there. Re-exported so there is still one place to read it from.
  rpcUrls: RPC_URLS,

  /**
   * Block to start indexing from. 0 means "the pool manager's deployment",
   * which the indexer finds once and stores. Set it explicitly to avoid
   * scanning millions of empty blocks on first boot.
   */
  startBlock: BigInt(int('START_BLOCK', 0)),

  /**
   * Logs per request. Robinhood Chain runs ~100ms blocks (§2), so a range
   * that would be a day elsewhere is minutes here; most public endpoints cap
   * eth_getLogs well below 10k blocks.
   */
  blockRange: int('INDEXER_BLOCK_RANGE', 2_000),
  /**
   * Ceiling for the adaptive range during a first sync.
   *
   * The range above is the FLOOR, used once the indexer is following head.
   * Backfilling 62 million mostly-empty blocks at that width would be some
   * thirty thousand round trips; widening on empty ranges turns it into
   * hundreds. The poller lowers this itself the first time an endpoint
   * refuses a range, so the number only has to be optimistic, not correct.
   */
  maxBlockRange: int('INDEXER_MAX_BLOCK_RANGE', 50_000),
  /**
   * Windows fetched at once per pass.
   *
   * Most of a pass's time does not scale with the window — the anchor
   * query, the aggregate rebuild, the cursor write — so several windows a
   * pass divide that cost by as many. The poller halves this itself on a
   * rate limit or a timeout and climbs back after a stretch of clean
   * passes, so it only has to be generous, not correct.
   */
  fetchConcurrency: Math.max(1, int('INDEXER_CONCURRENCY', 6)),
  /** Seconds between passes when already caught up to head. */
  pollIntervalMs: int('INDEXER_POLL_MS', 1_000),

  /**
   * Minimum fully diluted value, in USD, for a pool's token to be listed.
   *
   * A young chain's PoolManager is mostly dust — thousands of launchpad
   * tokens with a few dollars of depth — and a board that lists all of it
   * buries the pools anyone would stake into. Pools below this are still
   * indexed, still counted in /api/health, and reappear the moment they
   * cross it. The ether/USDG pools are exempt: ether has no supply to read,
   * so its FDV is zero by construction (§15), and it is the chain's main
   * market. Set to 0 to list everything.
   */
  listingMinFdvUsd: int('LISTING_MIN_FDV_USD', 1_000_000),

  apiPort: int('API_PORT', 3001),
  apiHost: process.env.API_HOST ?? '127.0.0.1',

  /** §4.4: push on real events, debounced to about a second per pool. */
  streamDebounceMs: int('STREAM_DEBOUNCE_MS', 1_000),
  /**
   * How often the snapshot may be rebuilt. Requests are answered from the
   * last build immediately; this is the floor between builds, so a first
   * sync ticking every second cannot keep the expensive query running flat
   * out. See server.ts `snapshot()`.
   */
  snapshotMinRebuildMs: int('SNAPSHOT_MIN_REBUILD_MS', 5_000),

  /**
   * Requests per window per client, for the public API.
   *
   * Generous on purpose. The front end polls every 20s behind the websocket,
   * and a dozen tabs behind one NAT must not get throttled — this exists to
   * stop a loop hammering the snapshot query, not to ration users.
   */
  rateLimitMax: int('RATE_LIMIT_MAX', 120),
  rateLimitWindowMs: int('RATE_LIMIT_WINDOW_MS', 60_000),

  /**
   * Lag at which the indexer counts as stalled rather than behind.
   *
   * §8's P3 criterion names the failure this exists for: a process that dies
   * quietly while the site keeps showing its last numbers as though they were
   * live. The same applies to the indexer now, one phase early.
   *
   * Five minutes is roughly 3,000 blocks at this chain's ~100ms (§2), which a
   * healthy indexer clears in a couple of passes. Sustained lag past that is
   * a stall, not a busy moment.
   */
  stallSeconds: int('INDEXER_STALL_SECONDS', 300),

  /**
   * Per-token logo sources, in order of preference. `none` disables them.
   * Each reads one image URL and nothing else (§4); see logo-sources.ts.
   */
  logoSources: list('LOGO_SOURCES', [
    'explorer',
    'tickers',
    'onchain',
    'pons',
    'geckoterminal',
    'dexscreener',
    'coingecko',
    'coinmarketcap',
  ]),
  /**
   * The chain's own block explorer (Blockscout), asked for token icons before
   * any aggregator. The default is the explorer the ethereum-lists/chains
   * registry names for chainId 4663.
   */
  explorerApiUrl: process.env.EXPLORER_API_URL?.trim() || EXPLORER_URL,
  /** Milliseconds between logo lookups: one token per interval, every source. */
  logoLookupMs: int('LOGO_LOOKUP_MS', 6_000),

  /**
   * Pools to index first. Empty means "everything the PoolManager emits",
   * which is correct but slow on a first sync; naming a few gets the boards
   * populated while the rest catches up.
   */
  seedPools: list('SEED_POOLS', []),
} as const;

export type Env = typeof env;
