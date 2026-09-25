/**
 * Load `.env` into `process.env`, for side effect.
 *
 *   import './load-env';   // FIRST, before anything that reads process.env
 *
 * Node does not read `.env` files. Next.js does, which is why the web
 * process worked while `lockfi-api` and `lockfi-indexer` crash-looped on
 * "DATABASE_URL is required" — `bootstrap.sh` wrote the file and nothing
 * opened it. PM2 does not read one either, and the secrets must not go into
 * `ecosystem.config.js`, because that is in the repository.
 *
 * Two properties that matter:
 *
 *   The real environment always wins. A variable already set — by PM2, by a
 *   shell, by CI — is never overwritten, so `RATE_LIMIT_MAX=1 npm run api`
 *   still does what it looks like it does.
 *
 *   The path is resolved from this file, not from `cwd`. PM2 sets a cwd, cron
 *   does not, and a deploy script may run from anywhere; `.env` lives next to
 *   `package.json` regardless.
 *
 * Imported as the first line of each entry point rather than only from
 * `env.ts`, because several modules read `process.env` at their own top level
 * and module evaluation order would otherwise decide whether they saw it.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** `server/` -> the app root, wherever the process was started from. */
function appRoot(): string {
  try {
    return dirname(dirname(fileURLToPath(import.meta.url)));
  } catch {
    // tsx transpiles to CJS in some configurations, where import.meta is not
    // available. __dirname is, and means the same thing here.
    return dirname(typeof __dirname === 'string' ? __dirname : process.cwd());
  }
}

/**
 * Minimal `.env` parser: `KEY=value`, `#` comments, optional quotes.
 *
 * Deliberately not a dependency. The file it reads is written by our own
 * `bootstrap.sh`, and a parser small enough to read in full is worth more
 * here than one that handles syntax we never emit.
 */
export function parseEnv(contents: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;

    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    let value = line.slice(eq + 1).trim();
    // Strip one matching pair of quotes, and only then treat `#` as a comment
    // — a quoted value may legitimately contain one, and a database password
    // very well might.
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    } else {
      const hash = value.indexOf(' #');
      if (hash >= 0) value = value.slice(0, hash).trim();
    }
    out[key] = value;
  }
  return out;
}

/** Returns the names it set, so a caller can report what was loaded. */
export function loadEnv(path = join(appRoot(), '.env')): string[] {
  let contents: string;
  try {
    contents = readFileSync(path, 'utf8');
  } catch {
    // No .env is a normal state: in CI and in tests everything comes from the
    // real environment. Silence here, and a missing variable fails loudly
    // later in env.ts with the name of what is missing.
    return [];
  }

  const applied: string[] = [];
  for (const [key, value] of Object.entries(parseEnv(contents))) {
    // The real environment wins, always.
    if (process.env[key] === undefined) {
      process.env[key] = value;
      applied.push(key);
    }
  }
  return applied;
}

loadEnv();
