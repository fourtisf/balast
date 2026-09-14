/**
 * Ask every configured logo source about a few tokens, and print exactly
 * what each one answered.
 *
 *   npm run logos:probe                 the top listed tokens without a logo
 *   npm run logos:probe -- 0xabc… 0xdef…   specific tokens
 *
 * The indexer asks these sources quietly, one token every LOGO_LOOKUP_MS,
 * and records only the answer. When a board has no logos the question is
 * WHY — the explorer has no icon, an aggregator does not list this chain,
 * a host is unreachable from the box — and the poller's log does not say.
 * This does: for each token and each source, the HTTP status the source
 * returned and the URL it yielded, or the error. It writes nothing.
 */

import '../load-env';

import { CHAIN } from '../../lib/chain';
import { prisma } from '../db';
import { env } from '../env';
import { createSources, type Fetch } from '../indexer/logo-sources';

interface Candidate {
  address: string;
  symbol: string;
}

async function candidates(limit: number): Promise<Candidate[]> {
  // The same order the poller asks in: listed tokens first, by the largest
  // FDV among their pools, without a logo yet.
  return prisma.$queryRaw<Candidate[]>`
    SELECT t.address, t.symbol
    FROM tokens t
    LEFT JOIN (
      SELECT p.token0 AS token, MAX(ps.mc_usd) AS mc FROM pools p JOIN pool_state ps ON ps.pool_id = p.id GROUP BY p.token0
      UNION ALL
      SELECT p.token1 AS token, MAX(ps.mc_usd) AS mc FROM pools p JOIN pool_state ps ON ps.pool_id = p.id GROUP BY p.token1
    ) m ON lower(m.token) = lower(t.address)
    WHERE t.logo_url IS NULL
    GROUP BY t.address, t.symbol, t.first_seen
    ORDER BY MAX(m.mc) DESC NULLS LAST, t.first_seen ASC
    LIMIT ${limit}
  `;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((a) => /^0x[0-9a-fA-F]{40}$/.test(a));
  const tokens: Candidate[] = args.length
    ? args.map((address) => ({ address: address.toLowerCase(), symbol: '' }))
    : await candidates(6);

  const sources = createSources(env.logoSources);
  process.stdout.write(
    `\n${CHAIN.name} · logo sources: ${env.logoSources.join(', ')} · explorer ${env.explorerApiUrl}\n`,
  );
  if (tokens.length === 0) {
    process.stdout.write('Every token the indexer knows already has a logo.\n');
    return;
  }

  for (const token of tokens) {
    const symbol = token.symbol || (await prisma.token.findUnique({ where: { address: token.address } }))?.symbol || '?';
    process.stdout.write(`\n${symbol}  ${token.address}\n`);
    for (const source of sources) {
      // A fetch that remembers the last status it saw, so a null answer can
      // be told apart: 404 (not there), 429 (rate limited), 200 with no
      // image, or no connection at all.
      const seen: string[] = [];
      const fetchWithTrace: Fetch = async (url, init) => {
        try {
          const response = await fetch(url, init);
          seen.push(`${response.status} ${new URL(url).host}`);
          return response;
        } catch (error) {
          seen.push(`unreachable ${new URL(url).host} (${(error as Error).message})`);
          throw error;
        }
      };
      const notes: string[] = [];
      const started = Date.now();
      const found = await source.lookup(token.address, { fetch: fetchWithTrace, log: (m) => notes.push(m.trim()) });
      const ms = Date.now() - started;
      const trace = seen.length ? seen.join(' → ') : 'no request made';
      const verdict = found ? `found  ${found}` : 'none';
      process.stdout.write(`  ${source.name.padEnd(14)} ${verdict}\n`);
      process.stdout.write(`  ${''.padEnd(14)} ${trace} · ${ms}ms${notes.length ? ` · ${notes.join(' / ')}` : ''}\n`);
    }
  }
  process.stdout.write(
    '\nNothing was written. The indexer asks the same sources itself, one token every ' +
      `${env.logoLookupMs}ms, and records what it finds.\n`,
  );
}

main()
  .catch((error) => {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
