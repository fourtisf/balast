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

/**
 * Public endpoints for Robinhood Chain, from the chain registry
 * (ethereum-lists/chains, eip155-4663). Tried in the order listed; override
 * with RPC_URLS to put a paid endpoint first.
 */
const DEFAULT_RPC_URLS = [
  'https://rpc.mainnet.chain.robinhood.com',
  'https://robinhood-rpc.publicnode.com',
  'https://rpc.arrowrpc.com',
  'https://rpc.ordofi.network',
];

function parse(raw: string | undefined): string[] {
  if (!raw) return DEFAULT_RPC_URLS;
  const parsed = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return parsed.length > 0 ? parsed : DEFAULT_RPC_URLS;
}

export const RPC_URLS: readonly string[] = parse(process.env.RPC_URLS);
