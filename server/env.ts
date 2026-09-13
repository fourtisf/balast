/**
 * Server configuration. Read once, validated once, and never read from
 * `process.env` anywhere else — a typo'd variable name should stop the process
 * at boot, not produce an indexer that quietly follows the wrong chain.
 */

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

/**
 * Public endpoints for Robinhood Chain, from the chain registry
 * (ethereum-lists/chains, eip155-4663). Listed in the order they are tried;
 * override with RPC_URLS to put a paid endpoint first.
 */
const DEFAULT_RPC_URLS = [
  'https://rpc.mainnet.chain.robinhood.com',
  'https://robinhood-rpc.publicnode.com',
  'https://rpc.arrowrpc.com',
  'https://rpc.ordofi.network',
];

export const env = {
  databaseUrl: required('DATABASE_URL'),
  /** Optional: without it the API fans out in-process and a second instance
   *  would not see the first one's ticks. Fine for one box (§2). */
  redisUrl: process.env.REDIS_URL ?? null,

  rpcUrls: list('RPC_URLS', DEFAULT_RPC_URLS),

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
  /** Seconds between passes when already caught up to head. */
  pollIntervalMs: int('INDEXER_POLL_MS', 1_000),

  apiPort: int('API_PORT', 3001),
  apiHost: process.env.API_HOST ?? '127.0.0.1',

  /** §4.4: push on real events, debounced to about a second per pool. */
  streamDebounceMs: int('STREAM_DEBOUNCE_MS', 1_000),

  /**
   * Pools to index first. Empty means "everything the PoolManager emits",
   * which is correct but slow on a first sync; naming a few gets the boards
   * populated while the rest catches up.
   */
  seedPools: list('SEED_POOLS', []),
} as const;

export type Env = typeof env;
