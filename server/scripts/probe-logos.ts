/**
 * Ask every configured logo source about a few tokens, and print exactly
 * what each one answered.
 *
 *   npm run logos:probe                    the next tokens the poller would ask about
 *   npm run logos:probe -- VLAD 0xdef…     specific tokens, by symbol or address
 *
 * The indexer asks these sources quietly, one token every LOGO_LOOKUP_MS,
 * and records only the answer. When a board has no logos the question is
 * WHY — the explorer refuses the client, an aggregator does not list this
 * chain, a host is unreachable from the box — and the poller's log does not
 * say. This does: every request each source made, with the status, the
 * content type and the first line of the body, so a "none" can be told
 * apart from another "none". It writes nothing.
 */

import '../load-env';

import { CHAIN } from '../../lib/chain';
import { prisma } from '../db';
import { env } from '../env';
import { createSources, logoCandidates, type Fetch } from '../indexer/logo-sources';

/** Enough of a body to see its shape, on one line. */
const SNIPPET = 260;

function shortUrl(url: string): string {
  const u = new URL(url);
  return `${u.host}${u.pathname}${u.search ? '?…' : ''}`;
}

/**
 * Arguments are addresses or symbols. A symbol names the token of that
 * symbol with the most 24h volume — the one on the board — so the row a
 * person is looking at is the row the probe asks about.
 */
async function named(args: string[]): Promise<{ address: string; symbol: string }[]> {
  const out: { address: string; symbol: string }[] = [];
  for (const arg of args) {
    if (/^0x[0-9a-fA-F]{40}$/.test(arg)) {
      out.push({ address: arg.toLowerCase(), symbol: '' });
      continue;
    }
    const rows = await prisma.$queryRaw<{ address: string; symbol: string }[]>`
      WITH latest AS (SELECT MAX(hour) AS newest FROM pool_fee_hourly),
      volume AS (
        SELECT f.pool_id, SUM(f.volume_usd) AS volume
        FROM pool_fee_hourly f, latest
        WHERE f.hour > latest.newest - interval '24 hours'
        GROUP BY f.pool_id
      )
      SELECT t.address, t.symbol
      FROM tokens t
      LEFT JOIN pools p ON lower(p.token0) = lower(t.address) OR lower(p.token1) = lower(t.address)
      LEFT JOIN volume v ON v.pool_id = p.id
      WHERE lower(t.symbol) = lower(${arg})
      GROUP BY t.address, t.symbol
      ORDER BY MAX(COALESCE(v.volume, 0)) DESC NULLS LAST, t.first_seen ASC
      LIMIT 1
    `;
    if (rows.length === 0) process.stdout.write(`\nno token called ${arg} in the indexer's tables\n`);
    else out.push(rows[0]);
  }
  return out;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((a) => a.trim() !== '');
  const tokens = args.length ? await named(args) : await logoCandidates(6, null);

  const sources = createSources(env.logoSources);
  process.stdout.write(
    `\n${CHAIN.name} · logo sources: ${env.logoSources.join(', ')} · explorer ${env.explorerApiUrl}\n`,
  );
  if (tokens.length === 0) {
    process.stdout.write('Every token the indexer knows already has a logo.\n');
    return;
  }

  for (const token of tokens) {
    const symbol =
      token.symbol ||
      (await prisma.token.findUnique({ where: { address: token.address } }))?.symbol ||
      '?';
    process.stdout.write(`\n${symbol}  ${token.address}\n`);

    for (const source of sources) {
      // A fetch that keeps a transcript: URL, status, content type and the
      // start of the body, for every request the source makes.
      const transcript: string[] = [];
      const traced: Fetch = async (url, init) => {
        try {
          const response = await fetch(url, init);
          let snippet = '';
          try {
            const text = (await response.clone().text()).replace(/\s+/g, ' ').trim();
            snippet = text.length > SNIPPET ? `${text.slice(0, SNIPPET)}…` : text;
          } catch {
            snippet = '(unreadable body)';
          }
          const type = response.headers.get('content-type')?.split(';')[0] ?? '?';
          transcript.push(`${response.status} ${type}  ${shortUrl(url)}\n${''.padEnd(19)}↳ ${snippet}`);
          return response;
        } catch (error) {
          transcript.push(`unreachable  ${shortUrl(url)}  (${(error as Error).message})`);
          throw error;
        }
      };

      const notes: string[] = [];
      const started = Date.now();
      const found = await source.lookup(token.address, {
        fetch: traced,
        log: (m) => notes.push(m.trim()),
      });
      const ms = Date.now() - started;
      process.stdout.write(`  ${source.name.padEnd(14)} ${found ? `found  ${found}` : 'none'}  · ${ms}ms\n`);
      if (transcript.length === 0) process.stdout.write(`  ${''.padEnd(14)} no request made\n`);
      for (const line of transcript) process.stdout.write(`  ${''.padEnd(14)} ${line}\n`);
      for (const note of notes) process.stdout.write(`  ${''.padEnd(14)} note: ${note}\n`);
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
