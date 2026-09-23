/**
 * Point the Prisma client at a throwaway database before any test imports it.
 *
 * This runs in the test process ahead of the test module, which is the only
 * place `DATABASE_URL` can be set in time: `server/db.ts` constructs its
 * client at import, and `server/env.ts` requires the variable to exist.
 *
 * Default is a local Postgres on 5433 — see README, "Running the P1 tests".
 */

import { execFileSync } from 'node:child_process';

const url =
  process.env.TEST_DATABASE_URL ??
  'postgresql://postgres@127.0.0.1:5433/balast_test?schema=public';

process.env.DATABASE_URL = url;
// The fixture's tokens are small; the listing threshold is exercised by the
// one test that sets it, and must not silently thin every other suite's board.
process.env.LISTING_MIN_FDV_USD ??= '0';
// No external logo lookups from a test run: the one suite that exercises
// them hands the poller its own sources and a fake fetch.
process.env.LOGO_SOURCES ??= 'none';
// No portfolio reads against a real node: the suites that exercise them
// hand buildPortfolio their own reader.
process.env.PORTFOLIO_CHAIN ??= 'false';
// Never allow a test run to migrate or truncate a real database.
if (!/balast_test/.test(url)) {
  throw new Error(
    `Refusing to run tests against ${url}: the database name must contain ` +
      '"balast_test". Set TEST_DATABASE_URL.',
  );
}

/**
 * The server now loads `.env` at import (server/load-env.ts), and a developer
 * with a real `DATABASE_URL` in theirs must never have it win here — the
 * suites truncate every table. The loader does not overwrite an existing
 * variable, which is why this is safe; this assertion is what keeps it safe
 * if that ever changes.
 */
await import('./server/load-env');
if (process.env.DATABASE_URL !== url) {
  throw new Error(
    `Something overrode DATABASE_URL after the test setup set it ` +
      `(${process.env.DATABASE_URL}). The suite truncates every table, so it ` +
      'refuses to run against a database it did not choose.',
  );
}

/** Apply migrations once per run. Cheap when they are already applied. */
let migrated = false;
export function ensureMigrated(): void {
  if (migrated) return;
  execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'pipe',
  });
  migrated = true;
}

ensureMigrated();
