/**
 * The RPC endpoints, and nothing else.
 *
 * This is separate from `server/env.ts` for one concrete reason: `env.ts`
 * validates every variable at import, including `DATABASE_URL`, so anything
 * importing it needs a database. The RPC layer does not, and neither does
 * `npm run verify:chain` — whose entire purpose is to check the chain BEFORE
 * the database matters. It failed on a missing `DATABASE_URL` it never used.
 *
 * So the chain layer depends on this, and `env.ts` re-exports it, which keeps
 * one definition and one read.
 */

import '../load-env';
import { PUBLIC_RPC_URLS } from '../../lib/chain';

/**
 * Public endpoints for Robinhood Chain, from the chain registry
 * (ethereum-lists/chains, eip155-4663). Tried in the order listed; override
 * with RPC_URLS to put a paid endpoint first.
 */
const DEFAULT_RPC_URLS: string[] = [...PUBLIC_RPC_URLS];

function parse(raw: string | undefined): string[] {
  if (!raw) return DEFAULT_RPC_URLS;
  const parsed = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return parsed.length > 0 ? parsed : DEFAULT_RPC_URLS;
}

export const RPC_URLS: readonly string[] = parse(process.env.RPC_URLS);

/**
 * Which endpoint this process tries first (`RPC_START`, an index into the
 * list; default 0).
 *
 * Free endpoints rate-limit per IP, and every process on the box shares one
 * IP. With all of them starting on the first endpoint, the indexer's backfill
 * — which asks as fast as it is allowed — spent that endpoint's allowance and
 * the API's reads (a wallet's positions, a pool's reserves) queued behind it
 * for a 429. `ecosystem.config.js` starts the API and the logo process on
 * different endpoints, so the reads a person is waiting on go to one the
 * backfill is not pressing. Failover still walks the whole list from there.
 */
export function rpcStartIndex(count: number, raw: string | undefined = process.env.RPC_START): number {
  const n = Number(raw);
  if (!raw || !Number.isInteger(n) || n < 0 || count === 0) return 0;
  return n % count;
}
