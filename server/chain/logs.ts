/**
 * Walking a contract's logs backwards from head, at a width the endpoints
 * will actually serve.
 *
 * Every public endpoint caps `eth_getLogs` at a different block range and
 * none of them announce it: one says "exceeds defined limit", another
 * "invalid parameters", a third fails the HTTP request. The poller learned to
 * find the cap by hitting it once and halving (see poller.ts). The two
 * operator scripts did not — each asked for 5,000 blocks, was refused by all
 * four endpoints, gave up on the first refusal and reported "no events in the
 * last 0 blocks". `verify:chain` then told the operator not to start the sync
 * because of a failure that was the script's own.
 *
 * So the walk lives here, once, and adapts the same way the poller does. A
 * refusal narrows the window and retries the same range; it does not consume
 * one of the caller's windows and it does not skip anything.
 */

import { getAddress } from 'viem';
import { rpc } from './client';

export interface RawLog {
  address: string;
  topics: string[];
  data: `0x${string}`;
  blockNumber: bigint;
  logIndex: number;
}

export type LogFetcher = (from: bigint, to: bigint) => Promise<RawLog[]>;

export interface ScanOptions {
  address: string;
  /** Walk starts here and goes backwards. */
  head: bigint;
  /** Windows to visit before stopping. Refusals do not count. */
  maxWindows: number;
  /** First width tried. Optimistic on purpose: the first refusal teaches the cap. */
  startWindow?: bigint;
  /** Below this a refusal is given up on rather than halved again. */
  minWindow?: bigint;
  /**
   * Called per window with what it held. Return `false` to stop early — a
   * caller that has seen everything it wanted need not keep walking.
   */
  onWindow: (logs: RawLog[], from: bigint, to: bigint) => boolean | void;
  /** Told each time a width is refused, so the operator sees why the walk narrowed. */
  onRefusal?: (width: bigint, message: string) => void;
  /** Injectable for tests; defaults to the failover RPC client. */
  fetch?: LogFetcher;
}

export interface ScanResult {
  /** Blocks actually covered. Zero means nothing was served at any width. */
  scanned: bigint;
  windows: number;
  refusals: number;
  /** The width the walk settled at — what these endpoints will serve. */
  window: bigint;
  /** Set when the floor was reached and still refused: the message from the last refusal. */
  gaveUp: string | null;
}

function defaultFetcher(address: string): LogFetcher {
  const checksummed = getAddress(address);
  return async (from, to) =>
    (await rpc(
      (c) => c.getLogs({ address: checksummed, fromBlock: from, toBlock: to }),
      `getLogs(${from}-${to})`,
    )) as unknown as RawLog[];
}

export async function scanLogsBackwards(options: ScanOptions): Promise<ScanResult> {
  const minWindow = options.minWindow ?? 250n;
  let window = options.startWindow ?? 5_000n;
  if (window < minWindow) window = minWindow;
  const fetch = options.fetch ?? defaultFetcher(options.address);

  let to = options.head;
  let scanned = 0n;
  let windows = 0;
  let refusals = 0;

  while (windows < options.maxWindows && to >= 0n) {
    const from = to >= window ? to - window + 1n : 0n;
    let logs: RawLog[];
    try {
      logs = await fetch(from, to);
    } catch (error) {
      const message = (error as Error).message.split('\n')[0];
      refusals++;
      options.onRefusal?.(to - from + 1n, message);
      if (window <= minWindow) {
        return { scanned, windows, refusals, window, gaveUp: message };
      }
      // Narrow and retry the SAME range. `to` is unchanged, so nothing is
      // skipped; the cap is whatever width finally gets an answer.
      window = window / 2n < minWindow ? minWindow : window / 2n;
      continue;
    }

    windows++;
    scanned += to - from + 1n;
    if (options.onWindow(logs, from, to) === false) break;
    if (from === 0n) break;
    to = from - 1n;
  }

  return { scanned, windows, refusals, window, gaveUp: null };
}
