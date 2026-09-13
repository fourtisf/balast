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
// Never allow a test run to migrate or truncate a real database.
if (!/balast_test/.test(url)) {
  throw new Error(
    `Refusing to run tests against ${url}: the database name must contain ` +
      '"balast_test". Set TEST_DATABASE_URL.',
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
