/**
 * The logo process.
 *
 *   npm run logos            (PM2: balast-logos)
 *
 * Token logos used to be looked up inside the indexer's pass — one token
 * per pass, on a clock. That tied a decoration to the sync's health: the
 * day the indexer sat in a long rebuild after a restart, no token was asked
 * about for hours, and the board showed monograms while the probe proved
 * every source was answering. A logo must never wait on a block, so this is
 * its own process: it reads the token list, asks the sources about one
 * token every LOGO_LOOKUP_MS, records what it finds, and tells the API a
 * snapshot input changed. It touches nothing numeric (§4).
 *
 * It does not exit on a failed lookup. Sources are public and rate-limited;
 * a refusal is logged and the next token is asked on the next beat.
 */

import '../load-env';

import { CHAIN } from '../../lib/chain';
import { publishTick } from '../api/bus';
import { prisma } from '../db';
import { env } from '../env';
import { createSources, imageLoads, lookupLogos, type Fetch } from '../indexer/logo-sources';
import { refreshLogos } from '../indexer/logos';

/** How often the token list is re-read. It is a file or a URL; an hour is plenty. */
const LIST_EVERY_MS = 60 * 60 * 1000;

function log(message: string): void {
  process.stdout.write(`${new Date().toISOString()} ${message}\n`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Tell the API a snapshot input changed. The tick carries the indexer's
 * own cursor, so nothing about lag is invented here.
 */
async function nudge(): Promise<void> {
  const cursor = await prisma.indexerCursor.findFirst();
  await publishTick({
    toBlock: cursor?.lastIndexedBlock.toString() ?? '0',
    lagSeconds: cursor ? Math.max(0, (Date.now() - cursor.lastIndexedAt.getTime()) / 1000) : 0,
  });
}

async function main(): Promise<void> {
  const sources = createSources(env.logoSources);
  log(
    `logo sources: ${sources.map((s) => s.name).join(', ') || 'none'} · ` +
      `one token every ${env.logoLookupMs}ms · explorer ${env.explorerApiUrl}`,
  );

  // A start is when the sources change — a deploy — so every token still
  // without a logo is asked about again, board first. A miss then goes quiet
  // for a week, as before.
  const reasked = await prisma.token.updateMany({
    where: { logoUrl: null, logoCheckedAt: { not: null } },
    data: { logoCheckedAt: null },
  });
  if (reasked.count > 0) log(`${reasked.count} token(s) without a logo will be asked about again`);

  let shuttingDown = false;
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      log(`${signal} — stopping after this lookup`);
      shuttingDown = true;
    });
  }

  // Every logo already on record is checked once, because the first ones
  // were recorded before anything checked that they load — and four discs
  // on the board were empty. One that does not load is forgotten, so the
  // token is asked about again with the load check in place.
  const recorded = await prisma.token.findMany({
    where: { logoUrl: { not: null } },
    select: { address: true, symbol: true, logoUrl: true },
  });
  let dropped = 0;
  for (const token of recorded) {
    if (shuttingDown) break;
    if (await imageLoads(globalThis.fetch as unknown as Fetch, token.logoUrl!)) continue;
    await prisma.token.update({
      where: { address: token.address },
      data: { logoUrl: null, logoCheckedAt: null },
    });
    dropped++;
    log(`forgot a logo for ${token.symbol} that does not load: ${token.logoUrl}`);
    await sleep(250);
  }
  if (recorded.length > 0) {
    log(`${recorded.length} recorded logo(s) checked, ${dropped} forgotten`);
    if (dropped > 0) await nudge();
  }

  let listReadAt = 0;
  let found = 0;
  let asked = 0;
  while (!shuttingDown) {
    const started = Date.now();
    try {
      if (started - listReadAt >= LIST_EVERY_MS) {
        listReadAt = started;
        if ((await refreshLogos({ chainId: CHAIN.id, log })) > 0) await nudge();
      }
      if (sources.length > 0) {
        const got = await lookupLogos({ sources, limit: 1, log });
        asked++;
        if (got > 0) {
          found += got;
          await nudge();
        }
        // A line every hundred beats, so a quiet log is distinguishable from a dead one.
        if (asked % 100 === 0) log(`${asked} lookups so far, ${found} logo(s) found`);
      }
    } catch (error) {
      log(`lookup failed: ${(error as Error).message}`);
    }
    // Sleep in short slices so a stop signal is honoured promptly.
    const until = started + env.logoLookupMs;
    while (!shuttingDown && Date.now() < until) await sleep(Math.min(500, until - Date.now()));
  }

  await prisma.$disconnect();
  log('stopped');
}

main().catch((error) => {
  process.stderr.write(`${(error as Error).stack ?? error}\n`);
  process.exit(1);
});
