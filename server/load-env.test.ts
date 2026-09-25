/**
 * The `.env` loader.
 *
 * This exists because its absence took the deploy down. `bootstrap.sh` wrote
 * `/var/www/balast/.env`, Node does not read `.env` files, PM2 does not
 * either, and the secrets must not go into `ecosystem.config.js` because that
 * is in the repository — so `lockfi-api` and `lockfi-indexer` both died on
 * "DATABASE_URL is required" pointing at a file that was sitting right there.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadEnv, parseEnv } from './load-env';

function envFile(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'balast-env-'));
  const path = join(dir, '.env');
  writeFileSync(path, contents);
  return path;
}

const touched: string[] = [];
afterEach(() => {
  for (const key of touched) delete process.env[key];
  touched.length = 0;
});

describe('parseEnv', () => {
  it('reads plain assignments', () => {
    expect(parseEnv('A=1\nB=two')).toEqual({ A: '1', B: 'two' });
  });

  it('strips one matching pair of quotes', () => {
    expect(parseEnv('A="quoted"\nB=\'single\'')).toEqual({ A: 'quoted', B: 'single' });
  });

  it('keeps a # inside a quoted value', () => {
    // A generated database password very plausibly contains one, and
    // truncating it there would produce an authentication failure that looks
    // nothing like its cause.
    expect(
      parseEnv('DATABASE_URL="postgresql://u:pa#ss@127.0.0.1:5432/db?schema=public"'),
    ).toEqual({ DATABASE_URL: 'postgresql://u:pa#ss@127.0.0.1:5432/db?schema=public' });
  });

  it('treats an unquoted trailing comment as a comment', () => {
    expect(parseEnv('A=1 # why')).toEqual({ A: '1' });
  });

  it('skips comments, blanks and malformed lines', () => {
    expect(parseEnv('# note\n\n  \nNOEQUALS\n=novalue\nA=1')).toEqual({ A: '1' });
  });

  it('ignores keys that are not valid variable names', () => {
    expect(parseEnv('1BAD=x\nBAD-KEY=x\nGOOD_KEY=x')).toEqual({ GOOD_KEY: 'x' });
  });

  it('keeps an = inside a value', () => {
    expect(parseEnv('URL=postgresql://h/db?a=1&b=2')).toEqual({
      URL: 'postgresql://h/db?a=1&b=2',
    });
  });

  it('handles CRLF, because the file may have been edited on Windows', () => {
    expect(parseEnv('A=1\r\nB=2\r\n')).toEqual({ A: '1', B: '2' });
  });
});

describe('loadEnv', () => {
  it('sets variables that are not already present', () => {
    touched.push('BALAST_TEST_NEW');
    const applied = loadEnv(envFile('BALAST_TEST_NEW=from-file'));
    expect(applied).toContain('BALAST_TEST_NEW');
    expect(process.env.BALAST_TEST_NEW).toBe('from-file');
  });

  it('never overwrites the real environment', () => {
    // `RATE_LIMIT_MAX=1 npm run api` has to do what it looks like it does,
    // and PM2's own env must win over a file on disk.
    touched.push('BALAST_TEST_EXISTING');
    process.env.BALAST_TEST_EXISTING = 'from-shell';
    const applied = loadEnv(envFile('BALAST_TEST_EXISTING=from-file'));
    expect(applied).not.toContain('BALAST_TEST_EXISTING');
    expect(process.env.BALAST_TEST_EXISTING).toBe('from-shell');
  });

  it('is silent when there is no file', () => {
    // Normal in CI and in tests, where everything comes from the real
    // environment. A missing variable then fails loudly in env.ts, by name.
    expect(loadEnv(join(tmpdir(), 'balast-does-not-exist', '.env'))).toEqual([]);
  });
});
