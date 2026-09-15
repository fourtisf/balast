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

// First, so `.env` is in process.env before anything reads it. See
// server/load-env.ts — Node does not read `.env` files and neither does PM2.
import '../load-env';

import { CONTRACTS } from '../../lib/chain';
import { assertChainId, getHead } from '../chain/client';
import { findDeploymentBlock } from '../chain/deployment';
import { env } from '../env';
import { prisma } from '../db';
import { publishTick } from '../api/bus';
import { Poller, type PassResult } from './poller';
import { ViemLogSource } from './viem-source';

/** `indexer_state` key holding the last pass's timings. */
export const LAST_PASS_KEY = 'last_pass';

const USDG = process.env.USDG_ADDRESS;

function log(message: string): void {
  process.stdout.write(`${new Date().toISOString()} ${message}\n`);
}

async function main(): Promise<void> {
  // No USDG_ADDRESS is no longer fatal. The anchor is discovered from the
  // chain's own tokens once pools are indexed (see indexer/anchor.ts) — the
  // indexer refusing to start meant the site sat on a "not configured" page
  // waiting for a step only a person could take.
  if (!USDG) {
    log('USDG_ADDRESS not set — the USD anchor will be discovered from indexed tokens');
  }

  log(`chain check against ${env.rpcUrls.length} endpoint(s)`);
  await assertChainId();
  const head = await getHead();
  log(`head is block ${head.number} at ${head.timestamp.toISOString()}`);

  // Uniswap's registry names the v3 factory on this chain (lib/chain.ts);
  // V3_FACTORY still overrides it, and an explicit empty value disables it.
  const v3Factory = process.env.V3_FACTORY === undefined ? CONTRACTS.v3Factory : process.env.V3_FACTORY || null;
  if (!v3Factory) {
    log(
      'V3_FACTORY is empty — v3 pools will only be those named in V3_POOLS. ' +
        '§4 says some older pools on this chain are v3, so this will omit real pools.',
    );
  }

  // Where to start. Left at 0 this scans from genesis — 62 million blocks of
  // mostly nothing on this chain — so if it is unset, find the PoolManager's
  // deployment block by bisection first. About 26 calls against an archive
  // node, against thirty thousand passes of empty range.
  let startBlock = env.startBlock;
  if (startBlock === 0n) {
    log('START_BLOCK is 0 — looking for the PoolManager\'s deployment block');
    const found = await findDeploymentBlock(CONTRACTS.poolManager, head.number);
    log(`  ${found.note}`);
    if (found.block !== null && found.block > 0n) {
      startBlock = found.block;
      log(`  starting at ${startBlock}; set START_BLOCK=${startBlock} to skip this next time`);
    } else {
      log('  starting from 0. This will take a long time — set START_BLOCK to shorten it.');
    }
  }

  const poller = new Poller({
    source: new ViemLogSource(log),
    usdgAddress: USDG,
    startBlock,
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
      // Every pass while backfilling, not only the ones that found something:
      // on a 62-million-block chain most ranges are empty, and silence for an
      // hour is indistinguishable from a hang.
      const behind = Number(result.headBlock - result.toBlock);
      if (result.events > 0 || result.poolsFound > 0 || !result.caughtUp) {
        const pct = ((Number(result.toBlock) / Number(result.headBlock)) * 100).toFixed(2);
        log(
          `blocks ${result.fromBlock}-${result.toBlock} of ${result.headBlock} (${pct}%, ` +
            `${behind.toLocaleString()} behind, window ${windowLine(result)}): ` +
            `${result.events} events, +${result.swapsWritten} swaps, ` +
            `+${result.liquidityWritten} liquidity, +${result.poolsFound} pools, ` +
            `+${result.tokensFound} tokens · ${timingLine(result)}`,
        );
        await rememberPass(result);
        // Tell the API something changed; it debounces before pushing (§4.4).
        await publishTick({ toBlock: result.toBlock.toString(), lagSeconds: result.lagSeconds });
      }
      if (result.caughtUp || result.refused) {
        // Refused too: the endpoint said no to every window, and asking again
        // in the same breath is how a rate limit becomes a ban.
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

/** `1,500 = 6×250` when a pass fetched several windows; the plain width when it fetched one. */
function windowLine(result: PassResult): string {
  const span = result.blockRange.toLocaleString();
  if (result.windows <= 1) return span;
  return `${span} = ${result.windows}×${result.windowBlocks.toLocaleString()}`;
}

/** Seconds per stage, so a slow pass says which stage it is. */
function timingLine(result: PassResult): string {
  const t = result.timings;
  const s = (ms: number) => (ms / 1000).toFixed(1);
  const blocks = Number(result.toBlock - result.fromBlock + 1n);
  const rate = t.totalMs > 0 ? Math.round((blocks * 1000) / t.totalMs) : 0;
  const backfill = t.backfillMs > 0 ? `, backfill ${s(t.backfillMs)}` : '';
  return (
    `${s(t.totalMs)}s (logs ${s(t.logsMs)}, times ${s(t.timesMs)}, tokens ${s(t.tokensMs)}${backfill}, ` +
    `ingest ${s(t.ingestMs)}, rebuild ${s(t.rebuildMs)}) · ${rate.toLocaleString()} blocks/s`
  );
}

/** The last pass's shape, for /api/health and the doctor: throughput is a fact worth reading from outside. */
async function rememberPass(result: PassResult): Promise<void> {
  const value = JSON.stringify({
    at: new Date().toISOString(),
    fromBlock: result.fromBlock.toString(),
    toBlock: result.toBlock.toString(),
    blocks: Number(result.toBlock - result.fromBlock + 1n),
    windows: result.windows,
    windowBlocks: result.windowBlocks,
    events: result.events,
    poolsFound: result.poolsFound,
    tokensFound: result.tokensFound,
    timings: result.timings,
  });
  try {
    await prisma.indexerState.upsert({
      where: { key: LAST_PASS_KEY },
      create: { key: LAST_PASS_KEY, value, updatedAt: new Date() },
      update: { value, updatedAt: new Date() },
    });
  } catch {
    /* telemetry must never stop a pass */
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  process.stderr.write(`${(error as Error).stack ?? error}\n`);
  process.exit(1);
});
