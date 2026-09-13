/**
 * The API process (§2: PM2).
 *
 *   npm run api
 */

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
