/**
 * The API starts the board on its own.
 *
 * `follow()` — the only way the market feed learns which tokens the board
 * shows — runs inside a SUCCESSFUL buildSnapshot, and a snapshot used to be
 * built only when a page asked for one or the indexer published a tick.
 * During a long indexer stage (a full rebuild, the v3 factory's history)
 * there are no ticks, so on a box nobody happened to be looking at, the feed
 * never started at all: `followed: 0`, `lastRefreshAt: null`, no error
 * anywhere, and every row reading `chain` for whoever loaded the page next.
 * That is exactly what the live box reported, and nothing in the status said
 * why.
 *
 * So nothing here requests `/api/snapshot`. `/api/health` is read because it
 * reports the feed and does not build one.
 */

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../db';
import { Poller } from '../indexer/poller';
import { isReachable, resetDatabase } from '../test/db';
import { FixtureLogSource, USDG, buildFixtureChain, fixtureTokenReader } from '../test/fixture';
import type { Fetch } from '../indexer/logo-sources';

const chain = buildFixtureChain(3_000);
let app: FastifyInstance;

/** Answers every source politely with nothing, so no test reaches a network. */
const silent = (async () => ({
  ok: true,
  status: 200,
  headers: { get: () => 'application/json' },
  json: async () => ({ pairs: [], data: [] }),
  text: async () => '{}',
})) as unknown as Fetch;

/**
 * Poll rather than sleep a fixed time: the warm-up is a promise chain.
 *
 * Unhurried on purpose — the health route is rate limited like any other, and
 * a tight loop here answers 429 and turns a clear failure into a confusing
 * one about a missing field.
 */
async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, ms = 8_000): Promise<T> {
  const deadline = Date.now() + ms;
  let last = await read();
  while (!done(last) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    last = await read();
  }
  return last;
}

interface MarketStatusBody {
  followed: number;
  quoted: number;
  note: string | null;
}

async function market(): Promise<MarketStatusBody> {
  const response = await app.inject({ method: 'GET', url: '/api/health' });
  let body: { market?: MarketStatusBody };
  try {
    body = JSON.parse(response.body);
  } catch {
    throw new Error(`/api/health answered ${response.statusCode} with ${response.body.slice(0, 120)}`);
  }
  if (!body.market) {
    throw new Error(`/api/health answered ${response.statusCode} without a market status`);
  }
  return body.market;
}

beforeAll(async () => {
  process.env.USDG_ADDRESS = USDG;
  process.env.LISTING_MIN_FDV_USD = '0';
  process.env.LOG_LEVEL = 'silent';

  if (!(await isReachable())) {
    throw new Error('These tests need a Postgres at TEST_DATABASE_URL. See README.');
  }
  await resetDatabase();
  await new Poller({
    source: new FixtureLogSource(chain),
    usdgAddress: USDG,
    startBlock: 0n,
    blockRange: chain.headBlock + 1,
    tokenReader: fixtureTokenReader,
  }).syncToHead();

  const { buildServer } = await import('./server');
  app = await buildServer({ marketFetch: silent });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
});

describe('a freshly started API', () => {
  it('builds its first snapshot unasked, so the feed is given the board', async () => {
    const status = await until(market, (m) => m.followed > 0);
    expect(status.followed).toBeGreaterThan(0);
    expect(status.note).not.toMatch(/No tokens followed/);
  });

  it('says why there are no live figures rather than reporting three zeroes', async () => {
    // This suite's sources answer nothing, which is the one case a status of
    // zeroes used to leave unexplained.
    const status = await until(market, (m) => m.note !== null && !/No tokens followed/.test(m.note));
    expect(status.note).toMatch(/probe|refresh/i);
  });
});
