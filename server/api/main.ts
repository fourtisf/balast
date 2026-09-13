/**
 * The API process (§2: PM2).
 *
 *   npm run api
 */

// First, so `.env` is in process.env before anything reads it. Without this
// the process dies on "DATABASE_URL is required" even though bootstrap.sh
// wrote the file — Node does not read `.env`, and PM2 does not either.
import '../load-env';

import { prisma } from '../db';
import { start } from './server';

start()
  .then((app) => {
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      process.on(signal, () => {
        void app
          .close()
          .then(() => prisma.$disconnect())
          .then(() => process.exit(0));
      });
    }
  })
  .catch((error) => {
    process.stderr.write(`${(error as Error).stack ?? error}\n`);
    process.exit(1);
  });
