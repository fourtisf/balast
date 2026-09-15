/**
 * The adaptive block range.
 *
 * A fixed 2,000-block window is right once the indexer follows head and wrong
 * by four orders of magnitude during a first sync. On the real chain — 62
 * million blocks, almost all of them empty — it meant roughly thirty thousand
 * round trips, about thirty-four hours, before reaching anything worth
 * indexing. The observed run was at block 47,000 after ten minutes.
 *
 * The fix has to hold two things at once: collapse the pass count, and change
 * nothing about the rows produced. §9 compares a block-zero run against an
 * incremental one, and a window that changes size mid-sync is a harder
 * version of exactly that comparison.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../db';
import { isReachable, resetDatabase } from '../test/db';
import { FixtureLogSource, USDG, buildFixtureChain, fixtureTokenReader } from '../test/fixture';
import { Poller, splitWindows } from './poller';

const chain = buildFixtureChain();

/** A source with a long empty tail, like a chain whose contracts are recent. */
class SparseSource extends FixtureLogSource {
  readonly widths: bigint[] = [];
  /** Refuse any range wider than this, as a real endpoint does. Settable, so a test can lift it. */
  cap: bigint | null;
  constructor(
    chainData: ReturnType<typeof buildFixtureChain>,
    head: number,
    cap: bigint | null = null,
  ) {
    super(chainData, head);
    this.cap = cap;
  }

  override async getLogs(args: { address: string | string[]; fromBlock: bigint; toBlock: bigint }) {
    const width = args.toBlock - args.fromBlock + 1n;
    this.widths.push(width);
    if (this.cap !== null && width > this.cap) {
      throw new Error(`query returned more than 10000 results / range too large (${width})`);
    }
    return super.getLogs(args);
  }
}

/**
 * A source that objects to a burst rather than to a width: more than `limit`
 * requests in flight at once and the extra ones get a 429, as a public
 * endpoint's rate limiter answers.
 */
class BurstSource extends FixtureLogSource {
  readonly widths: bigint[] = [];
  private inFlight = 0;
  maxInFlight = 0;
  constructor(
    chainData: ReturnType<typeof buildFixtureChain>,
    head: number,
    public limit: number,
  ) {
    super(chainData, head);
  }

  override async getLogs(args: { address: string | string[]; fromBlock: bigint; toBlock: bigint }) {
    this.widths.push(args.toBlock - args.fromBlock + 1n);
    this.inFlight++;
    try {
      this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
      if (this.inFlight > this.limit) {
        throw new Error('HTTP request failed. Status: 429 Too Many Requests');
      }
      // Hold the slot across a tick, so calls made together overlap.
      await new Promise((resolve) => setTimeout(resolve, 1));
      return await super.getLogs(args);
    } finally {
      this.inFlight--;
    }
  }
}

beforeAll(async () => {
  if (!(await isReachable())) {
    throw new Error('These tests need a Postgres at TEST_DATABASE_URL. See README.');
  }
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('backfilling an empty chain', () => {
  it('widens the window, so an empty stretch costs passes not thousands', async () => {
    await resetDatabase();
    // A chain whose head is far past its last event: the shape of a real one.
    const source = new SparseSource(chain, 60_000);
    const passes = await new Poller({
      source,
      usdgAddress: USDG,
      startBlock: 0n,
      blockRange: 2_000,
      maxBlockRange: 50_000,
      // One window a pass, so what this measures is the window alone.
      fetchConcurrency: 1,
      tokenReader: fixtureTokenReader,
    }).syncToHead();

    // 60,000 blocks at a fixed 2,000 is 30 passes. Widening should beat that
    // comfortably; the exact number depends on where the events sit.
    expect(passes.length).toBeLessThan(20);
    // And it must actually have widened, not just got lucky.
    expect(source.widths.some((w) => w > 2_000n)).toBe(true);
    expect(await prisma.swapEvent.count()).toBeGreaterThan(500);
  });

  it('finds an endpoint\'s cap by hitting it, then stays under it', async () => {
    // No endpoint announces its limit, so the only way to learn it is to be
    // refused once. What must not happen is refusing forever.
    await resetDatabase();
    const source = new SparseSource(chain, 60_000, 8_000n);
    const passes = await new Poller({
      source,
      usdgAddress: USDG,
      startBlock: 0n,
      blockRange: 2_000,
      maxBlockRange: 50_000,
      fetchConcurrency: 1,
      tokenReader: fixtureTokenReader,
    }).syncToHead();

    const refused = source.widths.filter((w) => w > 8_000n);
    expect(refused.length).toBeGreaterThan(0);
    // Having learned it, it must not keep asking for more — not for the next
    // forty clean passes, at least, and this sync is shorter than that.
    const afterFirstRefusal = source.widths.slice(source.widths.indexOf(refused[0]) + 1);
    expect(afterFirstRefusal.every((w) => w <= 8_000n)).toBe(true);
    // And it still finished.
    expect(passes[passes.length - 1].caughtUp).toBe(true);
    expect(await prisma.swapEvent.count()).toBeGreaterThan(500);
  });

  it('narrows past the configured floor when every endpoint refuses it, instead of asking forever', async () => {
    // The live box sat at one block for a day: all four endpoints refused
    // 2000 blocks and the floor was 2000, so the same range was asked for
    // on every pass. A refused width is a fact about the endpoint; the
    // floor is a preference for following head.
    await resetDatabase();
    const source = new SparseSource(chain, 60_000, 500n);
    const passes = await new Poller({
      source,
      usdgAddress: USDG,
      startBlock: 0n,
      blockRange: 2_000,
      maxBlockRange: 50_000,
      fetchConcurrency: 1,
      tokenReader: fixtureTokenReader,
    }).syncToHead();
    const firstRefusal = source.widths.findIndex((w) => w > 500n);
    expect(firstRefusal).toBeGreaterThanOrEqual(0);
    const after = source.widths.slice(firstRefusal + 1).filter((w) => w > 500n);
    // Narrowing takes a refusal per halving (2000 → 1000 → 500). After that
    // the only wider request is the probe every forty clean passes, which
    // asks for one doubling and no more.
    expect(after.every((w) => w <= 1_000n)).toBe(true);
    expect(after.length).toBeLessThanOrEqual(2 + Math.ceil(passes.length / 40));
    expect(passes[passes.length - 1].caughtUp).toBe(true);
    expect(await prisma.swapEvent.count()).toBeGreaterThan(500);
  });

  it('narrows again once it is following head', async () => {
    // A wide window costs latency when there is nothing to catch up on.
    await resetDatabase();
    const source = new SparseSource(chain, 60_000);
    const poller = new Poller({
      source,
      usdgAddress: USDG,
      startBlock: 0n,
      blockRange: 2_000,
      maxBlockRange: 50_000,
      tokenReader: fixtureTokenReader,
    });
    await poller.syncToHead();
    const atHead = await poller.runPass();
    expect(atHead.windowBlocks).toBeLessThanOrEqual(2_000);
    expect(atHead.blockRange).toBeLessThanOrEqual(2_000);
  });

  it('asks for a wider window again once the endpoint has been accepting for a while', async () => {
    // A ceiling learned in a dense stretch — "more than N results" — is too
    // low for the empty stretch after it, and the live box sat at 250-block
    // windows for that reason. So the ceiling is probed upward after forty
    // clean passes, and a probe that is accepted is followed by another.
    await resetDatabase();
    const source = new SparseSource(chain, 120_000, 500n);
    const poller = new Poller({
      source,
      usdgAddress: USDG,
      startBlock: 0n,
      blockRange: 2_000,
      maxBlockRange: 50_000,
      fetchConcurrency: 1,
      tokenReader: fixtureTokenReader,
    });
    const passes = [];
    for (let i = 0; i < 1_000; i++) {
      // The endpoint's answer changes ten passes in: the cap is gone.
      if (i === 10) source.cap = null;
      const result = await poller.runPass();
      passes.push(result);
      if (result.caughtUp) break;
    }
    expect(passes[passes.length - 1].caughtUp).toBe(true);
    // It narrowed to the cap first…
    expect(passes.slice(3, 10).every((p) => p.windowBlocks <= 500)).toBe(true);
    // …and climbed back well past it, not one doubling but a run of them.
    const widest = passes.reduce((acc, p) => Math.max(acc, p.windowBlocks), 0);
    expect(widest).toBeGreaterThanOrEqual(4_000);
    expect(await prisma.swapEvent.count()).toBeGreaterThan(500);
  });

  it('produces byte-identical rows to a fixed window', async () => {
    // The requirement the speed-up must not have cost. §9 compares a
    // block-zero run against an incremental one; a window that changes size
    // mid-sync is a harder version of the same comparison.
    await resetDatabase();
    await new Poller({
      source: new SparseSource(chain, 60_000),
      usdgAddress: USDG,
      startBlock: 0n,
      blockRange: 2_000,
      maxBlockRange: 50_000,
      fetchConcurrency: 6,
      tokenReader: fixtureTokenReader,
    }).syncToHead();
    const adaptive = await prisma.$queryRaw<Record<string, string>[]>`
      SELECT pool_id, to_char(hour, 'YYYY-MM-DD HH24:MI') AS hour,
             fees_token0::text AS f0, fees_token1::text AS f1,
             fees_usd::text AS usd, swaps::text AS n
      FROM pool_fee_hourly ORDER BY pool_id, hour
    `;

    await resetDatabase();
    await new Poller({
      source: new SparseSource(chain, 60_000),
      usdgAddress: USDG,
      startBlock: 0n,
      // Floor and ceiling equal, one window a pass: no adaptation at all.
      blockRange: 2_000,
      maxBlockRange: 2_000,
      fetchConcurrency: 1,
      tokenReader: fixtureTokenReader,
    }).syncToHead();
    const fixed = await prisma.$queryRaw<Record<string, string>[]>`
      SELECT pool_id, to_char(hour, 'YYYY-MM-DD HH24:MI') AS hour,
             fees_token0::text AS f0, fees_token1::text AS f1,
             fees_usd::text AS usd, swaps::text AS n
      FROM pool_fee_hourly ORDER BY pool_id, hour
    `;

    expect(adaptive.length).toBeGreaterThan(50);
    expect(adaptive).toEqual(fixed);
  });
});

describe('several windows a pass', () => {
  it('splits a span into contiguous windows with nothing missing and nothing twice', () => {
    expect(splitWindows(0n, 9n, 4n)).toEqual([
      { from: 0n, to: 3n },
      { from: 4n, to: 7n },
      { from: 8n, to: 9n },
    ]);
    expect(splitWindows(5n, 5n, 4n)).toEqual([{ from: 5n, to: 5n }]);
    expect(splitWindows(0n, 7n, 4n)).toEqual([
      { from: 0n, to: 3n },
      { from: 4n, to: 7n },
    ]);
  });

  it('covers several windows a pass, so the fixed cost of a pass is paid once for all of them', async () => {
    await resetDatabase();
    const source = new SparseSource(chain, 60_000, 2_000n);
    const passes = await new Poller({
      source,
      usdgAddress: USDG,
      startBlock: 0n,
      blockRange: 2_000,
      maxBlockRange: 2_000,
      fetchConcurrency: 6,
      tokenReader: fixtureTokenReader,
    }).syncToHead();
    // 60,000 blocks at 2,000 a window is 30 windows; six at a time is five
    // passes, plus the one that finds head.
    expect(passes.length).toBeLessThanOrEqual(7);
    expect(passes.some((p) => p.windows === 6 && p.blockRange === 12_000)).toBe(true);
    // Every window stayed under the endpoint's cap: it is the window that is
    // capped, not the pass.
    expect(source.widths.every((w) => w <= 2_000n)).toBe(true);
    expect(passes[passes.length - 1].caughtUp).toBe(true);
    expect(await prisma.swapEvent.count()).toBeGreaterThan(500);
  });

  it('halves the concurrency on a rate limit and keeps the window, ingesting what did arrive', async () => {
    // A 429 is the endpoint objecting to the burst, not to the width. The
    // window must not narrow for it — that would be learning the wrong
    // lesson and keeping it for good.
    await resetDatabase();
    const source = new BurstSource(chain, 60_000, 2);
    const lines: string[] = [];
    const passes = await new Poller({
      source,
      usdgAddress: USDG,
      startBlock: 0n,
      blockRange: 2_000,
      maxBlockRange: 2_000,
      fetchConcurrency: 6,
      tokenReader: fixtureTokenReader,
      log: (line) => lines.push(line),
    }).syncToHead();

    expect(passes[passes.length - 1].caughtUp).toBe(true);
    expect(await prisma.swapEvent.count()).toBeGreaterThan(500);
    // It backed off to what the endpoint allows and said so.
    expect(passes.some((p) => p.concurrency === 6)).toBe(true);
    expect(passes[passes.length - 1].concurrency).toBeLessThanOrEqual(2);
    expect(lines.some((l) => /windows in flight .* at a time from here/.test(l))).toBe(true);
    // The window was never narrowed: no "range now" line, and no request
    // narrower than the window except the one that reached head.
    expect(lines.some((l) => l.includes('range now'))).toBe(false);
    expect(source.widths.slice(0, -1).every((w) => w === 2_000n)).toBe(true);
    // The pass that was refused still ingested the windows ahead of the
    // refusal rather than throwing them away: it moved the cursor.
    const partial = passes.find((p) => p.windows > 0 && p.windows < p.concurrency && !p.caughtUp);
    expect(partial).toBeDefined();
    expect(partial!.refused).toBe(false);
    expect(partial!.toBlock).toBeGreaterThan(partial!.fromBlock);
  });

  it('tries more windows at once again after a stretch of clean passes', async () => {
    await resetDatabase();
    const source = new BurstSource(chain, 200_000, 1);
    const poller = new Poller({
      source,
      usdgAddress: USDG,
      startBlock: 0n,
      blockRange: 2_000,
      maxBlockRange: 2_000,
      fetchConcurrency: 4,
      tokenReader: fixtureTokenReader,
    });
    const passes = [];
    for (let i = 0; i < 1_000; i++) {
      // Ten passes in, the rate limiter relents.
      if (i === 10) source.limit = 100;
      const result = await poller.runPass();
      passes.push(result);
      if (result.caughtUp) break;
    }
    expect(passes[passes.length - 1].caughtUp).toBe(true);
    // Down to one after the 429s…
    expect(passes.slice(3, 10).every((p) => p.concurrency === 1)).toBe(true);
    // …and back up once the endpoint had been accepting for long enough.
    const later = passes.slice(10);
    expect(later.some((p) => p.concurrency === 4)).toBe(true);
    expect(await prisma.swapEvent.count()).toBeGreaterThan(500);
  });

  it('produces byte-identical rows to one window at a time', async () => {
    // §9 again, in its hardest form: several windows a pass, a rate limit
    // partway that truncates one pass to the windows that arrived, and a
    // one-window run must agree to the byte.
    await resetDatabase();
    await new Poller({
      source: new BurstSource(chain, 60_000, 3),
      usdgAddress: USDG,
      startBlock: 0n,
      blockRange: 2_000,
      maxBlockRange: 2_000,
      fetchConcurrency: 6,
      tokenReader: fixtureTokenReader,
    }).syncToHead();
    const concurrent = await prisma.$queryRaw<Record<string, string>[]>`
      SELECT pool_id, to_char(hour, 'YYYY-MM-DD HH24:MI') AS hour,
             fees_token0::text AS f0, fees_token1::text AS f1,
             fees_usd::text AS usd, swaps::text AS n
      FROM pool_fee_hourly ORDER BY pool_id, hour
    `;

    await resetDatabase();
    await new Poller({
      source: new SparseSource(chain, 60_000),
      usdgAddress: USDG,
      startBlock: 0n,
      blockRange: 2_000,
      maxBlockRange: 2_000,
      fetchConcurrency: 1,
      tokenReader: fixtureTokenReader,
    }).syncToHead();
    const single = await prisma.$queryRaw<Record<string, string>[]>`
      SELECT pool_id, to_char(hour, 'YYYY-MM-DD HH24:MI') AS hour,
             fees_token0::text AS f0, fees_token1::text AS f1,
             fees_usd::text AS usd, swaps::text AS n
      FROM pool_fee_hourly ORDER BY pool_id, hour
    `;

    expect(concurrent.length).toBeGreaterThan(50);
    expect(concurrent).toEqual(single);
  });
});
