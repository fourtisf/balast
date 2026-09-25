/**
 * Ask the indexer for a full rebuild of every priced table on its next pass.
 *
 *   npm run aggregates:rebuild
 *
 * A full rebuild runs when the USD anchor changes and — until this existed —
 * on every restart. Now the anchor the tables were last rebuilt for is
 * remembered (`indexer_state`), so a restart costs the bounded rebuild every
 * pass does. This forgets that, which is how to repair a live box after a
 * change to the aggregation SQL: run it, then `pm2 restart lockfi-indexer`
 * or simply wait for the next pass.
 */

import '../load-env';

import { prisma } from '../db';
import { REBUILT_ANCHOR_KEY } from '../indexer/poller';

async function main(): Promise<void> {
  const deleted = await prisma.indexerState.deleteMany({ where: { key: REBUILT_ANCHOR_KEY } });
  process.stdout.write(
    deleted.count > 0
      ? 'The indexer will rebuild every priced table from the raw rows on its next pass.\n'
      : 'No rebuild marker was set; the next pass with an anchor rebuilds everything anyway.\n',
  );
}

main()
  .catch((error) => {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
