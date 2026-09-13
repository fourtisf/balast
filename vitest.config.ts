import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('.', import.meta.url)) },
  },
  test: {
    environment: 'node',
    include: ['lib/**/*.test.ts', 'server/**/*.test.ts'],
    // Points Prisma at a throwaway database before any test imports it.
    setupFiles: ['./vitest.setup.ts'],
    /**
     * One file at a time.
     *
     * The P1 suites drive a real Postgres and each starts from a truncated
     * database, which is what "on a fresh database" in §9 means. Run in
     * parallel they truncate each other's rows mid-assertion — which showed
     * up as the snapshot suite failing only when the whole suite ran.
     *
     * The alternative is a schema per worker, which means migrating per
     * worker. Not worth it: the whole suite is under ten seconds.
     */
    fileParallelism: false,
    // A real Postgres and a migration are slower than a pure unit test and
    // must not be cut off half way through.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
