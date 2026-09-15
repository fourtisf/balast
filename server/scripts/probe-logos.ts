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
import { resolveTokens } from './resolve-tokens';
import { env } from '../env';
import { createSources, logoCandidates, type Fetch } from '../indexer/logo-sources';

/** Enough of a body to see its shape, on one line. */
const SNIPPET = 260;

function shortUrl(url: string): string {
  const u = new URL(url);
  return `${u.host}${u.pathname}${u.search ? '?…' : ''}`;
}

async function main(): Promise<void> {
  // Arguments are addresses or symbols (resolve-tokens.ts): a symbol names
  // the token of that symbol with the most 24h volume — the one on the board
  // — so the row a person is looking at is the row the probe asks about.
  const args = process.argv.slice(2).filter((a) => a.trim() !== '');
  const tokens = args.length ? await resolveTokens(args) : await logoCandidates(6, null);

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
    const recorded = (await prisma.token.findUnique({ where: { address: token.address } }))?.logoUrl;
    process.stdout.write(`\n${symbol}  ${token.address}\n`);
    process.stdout.write(`  ${'recorded'.padEnd(14)} ${recorded ?? 'none'}\n`);

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
