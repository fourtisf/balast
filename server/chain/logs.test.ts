/**
 * The backwards log walk narrows on a refusal instead of giving up.
 *
 * This is the behaviour both operator scripts lacked: asked for 5,000 blocks,
 * refused by every endpoint, they reported "no events in the last 0 blocks"
 * and `verify:chain` blocked the first sync on it. A fake fetcher with a hard
 * cap reproduces exactly that endpoint.
 */

import { describe, expect, it } from 'vitest';
import { scanLogsBackwards, type RawLog } from './logs';

/** An endpoint that refuses any range wider than `cap`, and serves one log per block otherwise. */
function cappedEndpoint(cap: bigint) {
  const calls: { from: bigint; to: bigint }[] = [];
  const fetch = async (from: bigint, to: bigint): Promise<RawLog[]> => {
    calls.push({ from, to });
    if (to - from + 1n > cap) throw new Error('Request exceeds defined limit.');
    const logs: RawLog[] = [];
    for (let b = from; b <= to; b++) {
      logs.push({ address: '0x0', topics: [], data: '0x', blockNumber: b, logIndex: 0 });
    }
    return logs;
  };
  return { fetch, calls };
}

describe('scanLogsBackwards', () => {
  it('halves until the endpoint answers, without skipping a block', async () => {
    const endpoint = cappedEndpoint(1_000n);
    const seen: bigint[] = [];
    const result = await scanLogsBackwards({
      address: '0x0000000000000000000000000000000000000001',
      head: 9_999n,
      maxWindows: 3,
      startWindow: 5_000n,
      fetch: endpoint.fetch,
      onWindow: (logs) => {
        for (const log of logs) seen.push(log.blockNumber);
      },
    });

    // 5000 -> 2500 -> 1250 refused, 625 served.
    expect(result.refusals).toBe(3);
    expect(result.window).toBe(625n);
    expect(result.windows).toBe(3);
    expect(result.scanned).toBe(3n * 625n);
    expect(result.gaveUp).toBeNull();
    // Contiguous from head downwards, nothing missing between windows and
    // nothing visited twice.
    const sorted = [...seen].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    expect(sorted[sorted.length - 1]).toBe(9_999n);
    expect(sorted[0]).toBe(9_999n - 3n * 625n + 1n);
    expect(new Set(seen).size).toBe(seen.length);
    expect(BigInt(seen.length)).toBe(result.scanned);
    // The refused ranges all ended at head: the same range was retried narrower.
    expect(endpoint.calls.slice(0, 4).every((c) => c.to === 9_999n)).toBe(true);
  });

  it('gives up at the floor and says so, rather than looping', async () => {
    const endpoint = cappedEndpoint(10n);
    const result = await scanLogsBackwards({
      address: '0x0000000000000000000000000000000000000001',
      head: 500n,
      maxWindows: 5,
      startWindow: 400n,
      minWindow: 100n,
      fetch: endpoint.fetch,
      onWindow: () => {},
    });
    expect(result.scanned).toBe(0n);
    expect(result.gaveUp).toMatch(/exceeds/);
    // 400, 200, 100 — and 100 is the floor, so it stops there.
    expect(result.refusals).toBe(3);
  });

  it('stops early when the caller has seen enough, and at genesis', async () => {
    const endpoint = cappedEndpoint(10_000n);
    let visits = 0;
    const early = await scanLogsBackwards({
      address: '0x0000000000000000000000000000000000000001',
      head: 100_000n,
      maxWindows: 50,
      fetch: endpoint.fetch,
      onWindow: () => {
        visits++;
        return visits < 2;
      },
    });
    expect(early.windows).toBe(2);

    const genesis = await scanLogsBackwards({
      address: '0x0000000000000000000000000000000000000001',
      head: 7_000n,
      maxWindows: 50,
      fetch: endpoint.fetch,
      onWindow: () => {},
    });
    // 7001 blocks: one full window of 5000, then 0..2000 — and no wrap below zero.
    expect(genesis.windows).toBe(2);
    expect(genesis.scanned).toBe(7_001n);
  });
});
