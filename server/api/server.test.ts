/**
 * The API's behaviour at its edges: what it answers when the indexer is
 * stalled, and what it answers when someone loops on the expensive query.
 *
 * Both are things an operator or a monitor acts on, so the status codes
 * matter more than the bodies.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';

/**
 * Every import here is dynamic, and that is not stylistic.
 *
 * `server/env.ts` reads `process.env` exactly once, at import — which is the
 * behaviour we want in production, because a typo'd variable then stops the
 * process at boot rather than producing an indexer quietly following the
 * wrong chain. The cost is that a test wanting a different limit has to set
 * it before anything pulls that module in, and a static import would be
 * hoisted above the assignment.
 */
const RATE_LIMIT_MAX = 4;
const USDG_ADDRESS = '0x00000000000000000000000000000000000000d6';

let app: FastifyInstance;
let prisma: PrismaClient;
let chain: Awaited<ReturnType<typeof loadFixture>>;

async function loadFixture() {
  const { buildFixtureChain } = await import('../test/fixture');
  return buildFixtureChain();
}

beforeAll(async () => {
  process.env.USDG_ADDRESS = USDG_ADDRESS;
  process.env.RATE_LIMIT_MAX = String(RATE_LIMIT_MAX);
  process.env.RATE_LIMIT_WINDOW_MS = '60000';
  process.env.INDEXER_STALL_SECONDS = '300';
  // The suite deliberately makes hundreds of refused requests; logging each
  // one buries the actual test output.
  process.env.LOG_LEVEL = 'silent';

  ({ prisma } = await import('../db'));
  const { isReachable, resetDatabase } = await import('../test/db');
  if (!(await isReachable())) {
    throw new Error('These tests need a Postgres at TEST_DATABASE_URL. See README.');
  }
  await resetDatabase();

  chain = await loadFixture();
  const { buildServer } = await import('./server');
  app = await buildServer();
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
});

describe('/api/health', () => {
  it('answers 503 before the indexer has ever written a block', async () => {
    // A 200 here would tell an uptime monitor everything is fine while the
    // indexer has never started — which is the failure §8's P3 criterion is
    // about, and the reason this endpoint carries a status code at all.
    const response = await app.inject({ method: 'GET', url: '/api/health' });
    expect(response.statusCode).toBe(503);
    const body = response.json();
    expect(body.status).toBe('never-indexed');
    expect(body.ok).toBe(false);
    expect(body.message).toMatch(/USDG_ADDRESS|never written/i);
  });

  it('answers 503 with "stalled" once the lag passes the threshold', async () => {
    // The fixture's chain time is months in the past, so a full sync leaves
    // the indexer legitimately, enormously behind — which is exactly the
    // state that must not read as healthy.
    const { Poller } = await import('../indexer/poller');
    const { FixtureLogSource, USDG, fixtureTokenReader } = await import('../test/fixture');
    await new Poller({
      source: new FixtureLogSource(chain),
      usdgAddress: USDG,
      startBlock: 0n,
      blockRange: chain.headBlock + 1,
      tokenReader: fixtureTokenReader,
    }).syncToHead();

    const response = await app.inject({ method: 'GET', url: '/api/health' });
    expect(response.statusCode).toBe(503);
    const body = response.json();
    expect(body.status).toBe('stalled');
    expect(body.indexed.lagSeconds).toBeGreaterThan(body.stallThresholdSeconds);
    expect(body.pools).toBe(4);
  });

  it('answers 200 when the last indexed block is recent', async () => {
    // Move the cursor's timestamp to now: the same data, freshly indexed.
    const cursor = await prisma.indexerCursor.findFirstOrThrow();
    await prisma.indexerCursor.update({
      where: { contract: cursor.contract },
      data: { lastIndexedAt: new Date() },
    });

    const response = await app.inject({ method: 'GET', url: '/api/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe('ok');
  });
});

describe('rate limiting', () => {
  it('answers 429, not 500, once the budget is spent', async () => {
    // 500 would be wrong in a way that matters: it tells a client the server
    // broke and to retry, rather than to back off. The plugin THROWS the
    // object from errorResponseBuilder, so it needs its own statusCode —
    // without one Fastify answers 500. That is what this pins.
    const codes: number[] = [];
    for (let i = 0; i < RATE_LIMIT_MAX + 6; i++) {
      const response = await app.inject({
        method: 'GET',
        url: '/api/snapshot',
        headers: { 'x-forwarded-for': '203.0.113.7' },
      });
      codes.push(response.statusCode);
    }
    expect(codes.filter((c) => c === 429).length).toBeGreaterThan(0);
    expect(codes).not.toContain(500);

    const refused = await app.inject({
      method: 'GET',
      url: '/api/snapshot',
      headers: { 'x-forwarded-for': '203.0.113.7' },
    });
    expect(refused.statusCode).toBe(429);
    expect(refused.json().error).toBe('rate-limited');
    expect(refused.json().message).toMatch(/try again/i);
  });

  it('counts each client separately', async () => {
    // One loop must not lock everyone else out — which a shared bucket would.
    const response = await app.inject({
      method: 'GET',
      url: '/api/snapshot',
      headers: { 'x-forwarded-for': '198.51.100.22' },
    });
    expect(response.statusCode).toBe(200);
  });

  it('never rate-limits the websocket', async () => {
    // After a restart every client reconnects at once. Counting the stream
    // against a per-minute budget would refuse exactly the clients that most
    // need to get back on.
    for (let i = 0; i < 12; i++) {
      const response = await app.inject({
        method: 'GET',
        url: '/api/stream',
        headers: { 'x-forwarded-for': '203.0.113.7' },
      });
      // Not a websocket handshake through inject, so it will not be 101 —
      // what matters is that it is never refused as rate-limited.
      expect(response.statusCode).not.toBe(429);
    }
  });
});
