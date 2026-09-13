/**
 * The indexer process (§4, §8 P1).
 *
 *   npm run indexer
 *
 * Runs passes until caught up, then keeps polling. Every pass re-scans the
 * last 32 blocks, so a shallow reorg is absorbed without a special case.
 *
 * It does not exit on an RPC failure. An indexer that dies quietly is the
 * failure mode §7 and the P3 criterion both warn about: the site keeps showing
 * the last numbers it had as though they were live. Instead it logs, backs
 * off, and keeps the lag figure honest — the top bar shows how far behind it
 * is, and the number grows until someone looks.
 */

import { assertChainId, getHead } from '../chain/client';
import { env } from '../env';
import { prisma } from '../db';
import { publishTick } from '../api/bus';
import { Poller } from './poller';
import { ViemLogSource } from './viem-source';

const USDG = process.env.USDG_ADDRESS;

function log(message: string): void {
  process.stdout.write(`${new Date().toISOString()} ${message}\n`);
}

async function main(): Promise<void> {
  if (!USDG) {
    throw new Error(
      'USDG_ADDRESS is required: it is the site\'s one USD anchor (§4.3). ' +
        'Find the USDG token on the explorer and set it. Without it every USD ' +
        'figure would read zero.',
    );
  }

  log(`chain check against ${env.rpcUrls.length} endpoint(s)`);
  await assertChainId();
  const head = await getHead();
  log(`head is block ${head.number} at ${head.timestamp.toISOString()}`);

  const v3Factory = process.env.V3_FACTORY ?? null;
  if (!v3Factory) {
    log(
      'V3_FACTORY is not set — v3 pools will only be those named in V3_POOLS. ' +
        '§4 says some older pools on this chain are v3, so this will omit real pools.',
    );
  }

  const poller = new Poller({
    source: new ViemLogSource(),
    usdgAddress: USDG,
    v3Factory,
    v3Pools: (process.env.V3_POOLS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    log,
  });

  let backoffMs = 1_000;
  let shuttingDown = false;
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      log(`${signal} — finishing the current pass then stopping`);
      shuttingDown = true;
    });
  }

  while (!shuttingDown) {
    try {
      const result = await poller.runPass();
      backoffMs = 1_000;
      if (result.events > 0 || result.poolsFound > 0) {
        log(
          `blocks ${result.fromBlock}-${result.toBlock} of ${result.headBlock}: ` +
            `${result.events} events, +${result.swapsWritten} swaps, ` +
            `+${result.liquidityWritten} liquidity, +${result.poolsFound} pools, ` +
            `+${result.tokensFound} tokens, lag ${result.lagSeconds.toFixed(1)}s`,
        );
        // Tell the API something changed; it debounces before pushing (§4.4).
        await publishTick({ toBlock: result.toBlock.toString(), lagSeconds: result.lagSeconds });
      }
      if (result.caughtUp) {
        await sleep(env.pollIntervalMs);
      }
    } catch (error) {
      // Log and keep going. The lag figure in the top bar is what tells a
      // user the numbers are behind; dying would leave them looking live.
      log(`pass failed: ${(error as Error).message}`);
      await sleep(backoffMs);
      backoffMs = Math.min(backoffMs * 2, 60_000);
    }
  }

  await prisma.$disconnect();
  log('stopped');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  process.stderr.write(`${(error as Error).stack ?? error}\n`);
  process.exit(1);
});
