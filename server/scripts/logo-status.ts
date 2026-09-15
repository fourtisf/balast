/**
 * Where the logos are, end to end.
 *
 *   npm run logos:status
 *
 * `logos:probe` shows what the sources ANSWER. This shows what became of the
 * answers: how many tokens carry a logo in the database, when the poller
 * last asked, the latest ones it found, and whether the API's snapshot —
 * the thing the browser actually reads — carries them. A board of marks
 * while the probe finds logos means the gap is in one of those three
 * places, and this says which. It writes nothing.
 */

import '../load-env';

import type { MarketSnapshot } from '../../lib/data/types';
import { prisma } from '../db';
import { env } from '../env';
import { imageLoads, type Fetch } from '../indexer/logo-sources';
import { readWork } from '../indexer/working';

interface Counts {
  with_logo: number;
  without: number;
  checked: number;
  newest_check: Date | null;
}

const ago = (date: Date | null): string =>
  date === null ? 'never' : `${Math.round((Date.now() - date.getTime()) / 1000)}s ago`;

async function main(): Promise<void> {
  const cursor = await prisma.indexerCursor.findFirst();
  const [counts] = await prisma.$queryRaw<Counts[]>`
    SELECT
      COUNT(*) FILTER (WHERE logo_url IS NOT NULL)::int        AS with_logo,
      COUNT(*) FILTER (WHERE logo_url IS NULL)::int            AS without,
      COUNT(*) FILTER (WHERE logo_checked_at IS NOT NULL)::int AS checked,
      MAX(logo_checked_at)                                     AS newest_check
    FROM tokens
  `;
  const recent = await prisma.token.findMany({
    where: { logoUrl: { not: null } },
    orderBy: [{ logoCheckedAt: 'desc' }, { address: 'asc' }],
    take: 8,
    select: { symbol: true, address: true, logoUrl: true, logoCheckedAt: true },
  });

  process.stdout.write('\nDatabase\n');
  process.stdout.write(
    `  ${counts.with_logo} token(s) with a logo, ${counts.without} without; ` +
      `${counts.checked} asked about, the newest ${ago(counts.newest_check)}\n`,
  );
  process.stdout.write(
    `  indexer cursor last written ${cursor ? ago(cursor.updatedAt) : 'never'}` +
      (cursor ? ` (block ${cursor.lastIndexedBlock})` : '') +
      '\n',
  );
  for (const token of recent) {
    process.stdout.write(`  ${token.symbol.padEnd(12)} ${token.logoUrl}\n`);
  }

  // The API: what the browser reads. The snapshot is cached and rebuilt on
  // the indexer's ticks, so a logo can be in the table and not on the page
  // for a few seconds — or, if the API is stuck, indefinitely.
  process.stdout.write('\nAPI snapshot\n');
  let snapshot: MarketSnapshot | null = null;
  try {
    const response = await fetch(`http://${env.apiHost}:${env.apiPort}/api/snapshot`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(20_000),
    });
    if (response.ok) snapshot = (await response.json()) as MarketSnapshot;
    else process.stdout.write(`  /api/snapshot answered ${response.status}\n`);
  } catch (error) {
    process.stdout.write(`  /api/snapshot unreachable: ${(error as Error).message}\n`);
  }

  let listedWithout: { symbol: string; inDb: boolean }[] = [];
  if (snapshot) {
    const listed = snapshot.pools.map((p) => p.token);
    const withLogo = listed.filter((t) => t.logoUrl).length;
    process.stdout.write(
      `  revision ${snapshot.revision}: ${withLogo} of ${listed.length} listed tokens carry a logo\n`,
    );
    // The board's first rows, with the URL on record and whether it loads
    // from here — the two facts a "still no logo" needs.
    process.stdout.write('  the board, top to bottom:\n');
    for (const t of listed.slice(0, 24)) {
      const loads = t.logoUrl ? await imageLoads(globalThis.fetch as unknown as Fetch, t.logoUrl) : null;
      process.stdout.write(
        `    ${t.symbol.padEnd(12)} ${t.logoUrl ? `${loads ? 'loads ' : 'FAILS '} ${t.logoUrl}` : '(no logo on record)'}\n`,
      );
    }
    const missing = listed.filter((t) => !t.logoUrl);
    if (missing.length > 0) {
      const rows = await prisma.token.findMany({
        where: { address: { in: missing.map((t) => t.address.toLowerCase()) } },
        select: { address: true, logoUrl: true },
      });
      const inDb = new Set(rows.filter((r) => r.logoUrl).map((r) => r.address.toLowerCase()));
      listedWithout = missing.map((t) => ({ symbol: t.symbol, inDb: inDb.has(t.address.toLowerCase()) }));
      process.stdout.write(
        `  without: ${listedWithout
          .map((t) => `${t.symbol}${t.inDb ? ' (in the database, not in the snapshot yet)' : ''}`)
          .join(', ')}\n`,
      );
    }
  }

  // The verdict: which of the three places the gap is in.
  process.stdout.write('\nVerdict\n');
  const idleSeconds = cursor ? (Date.now() - cursor.updatedAt.getTime()) / 1000 : null;
  if (counts.checked === 0) {
    process.stdout.write(
      `  No token has been asked about yet. balast-logos asks one every ${env.logoLookupMs}ms from ` +
        'the moment it starts; if this stays at zero: pm2 status, then pm2 logs balast-logos --lines 50\n',
    );
    if (idleSeconds !== null && idleSeconds > 300) {
      const work = await readWork();
      process.stdout.write(
        work
          ? `  Separately: the indexer cursor has not moved for ${Math.round(idleSeconds)}s — it is on ` +
              `"${work.stage}"${work.detail ? ` (${work.detail})` : ''} since ${work.startedAt}, which writes no block.\n`
          : `  Separately: the indexer cursor has not moved for ${Math.round(idleSeconds)}s. Logos no ` +
              'longer depend on it, but the numbers do: pm2 logs balast-indexer --lines 100\n',
      );
    }
  } else if (counts.with_logo === 0) {
    process.stdout.write(
      `  ${counts.checked} token(s) asked about, none found. npm run logos:probe shows what each source answered.\n`,
    );
  } else if (snapshot && listedWithout.some((t) => t.inDb)) {
    process.stdout.write(
      '  The database has logos the snapshot does not. The API rebuilds on the indexer’s ticks; ' +
        'if this persists past a minute: pm2 restart balast-api\n',
    );
  } else if (snapshot) {
    process.stdout.write(
      '  The snapshot carries every logo the database has. If the page still shows marks, ' +
        'reload it (Ctrl+Shift+R): the browser holds the last snapshot it received.\n',
    );
  } else {
    process.stdout.write('  The database has logos but the API could not be read. bash deploy/doctor.sh\n');
  }
}

main()
  .catch((error) => {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
