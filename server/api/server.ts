/**
 * The API (§2: Fastify).
 *
 *   GET  /api/health    — is the indexer alive, and how far behind is it
 *   GET  /api/snapshot  — the whole MarketSnapshot
 *   GET  /api/stream    — websocket, pushing the snapshot on real events
 *
 * §4.4: in production we push on actual events, debounced to about a second.
 * The indexer publishes a tick when a pass wrote something; this server
 * debounces those, rebuilds the snapshot once, and fans it out. That is the
 * real version of the prototype's 3.2s interval — a quiet chain pushes
 * nothing rather than pushing the same numbers every few seconds.
 */

import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import cors from '@fastify/cors';
import { CONTRACTS } from '../../lib/chain';
import type { MarketSnapshot } from '../../lib/data/types';
import { prisma } from '../db';
import { env } from '../env';
import { POOL_MANAGER_CURSOR } from '../indexer/poller';
import { busKind, subscribeTicks } from './bus';
import { buildSnapshot } from './snapshot';

const USDG = process.env.USDG_ADDRESS ?? '';

/**
 * JSON cannot carry a bigint, and every amount that crosses this boundary has
 * already been converted to a number by the SQL. This is the guard for the
 * one that has not: it throws rather than silently emitting `null`.
 */
function serialise(snapshot: MarketSnapshot): string {
  return JSON.stringify(snapshot, (_key, value) => {
    if (typeof value === 'bigint') {
      throw new Error('A bigint reached the API boundary; convert it in SQL.');
    }
    return value;
  });
}

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });

  await app.register(cors, {
    // The browser reaches the API through nginx on the same origin, so CORS
    // is only for local development against `next dev`.
    origin: process.env.CORS_ORIGIN ?? true,
  });
  await app.register(websocket);

  /**
   * The snapshot is cached for as long as a tick has not arrived. Every
   * connected client on a quiet chain then costs one query, not one per
   * client per poll.
   */
  let cached: { snapshot: MarketSnapshot | null; at: number } | null = null;
  let building: Promise<MarketSnapshot | null> | null = null;

  async function snapshot(force = false): Promise<MarketSnapshot | null> {
    if (!force && cached && Date.now() - cached.at < env.streamDebounceMs) {
      return cached.snapshot;
    }
    // Coalesce concurrent requests into one query.
    if (!building) {
      building = buildSnapshot({ usdgAddress: USDG })
        .then((value) => {
          cached = { snapshot: value, at: Date.now() };
          return value;
        })
        .finally(() => {
          building = null;
        });
    }
    return building;
  }

  app.get('/api/health', async () => {
    const cursor = await prisma.indexerCursor.findUnique({
      where: { contract: POOL_MANAGER_CURSOR },
    });
    const lagSeconds = cursor
      ? Math.max(0, (Date.now() - cursor.lastIndexedAt.getTime()) / 1000)
      : null;
    const [counts] = await prisma.$queryRaw<{ pools: number; swaps: number }[]>`
      SELECT (SELECT COUNT(*) FROM pools)::int AS pools,
             (SELECT COUNT(*) FROM swap_events)::int AS swaps
    `;
    return {
      // "ok" means the API answered. Whether the numbers are current is the
      // lag figure's job to say, and the top bar shows it (§7).
      ok: true,
      indexed: cursor
        ? { lastBlock: cursor.lastIndexedBlock.toString(), at: cursor.lastIndexedAt, lagSeconds }
        : null,
      pools: counts?.pools ?? 0,
      swaps: counts?.swaps ?? 0,
      bus: busKind(),
      weth: CONTRACTS.weth,
      usdg: USDG || null,
    };
  });

  app.get('/api/snapshot', async (_request, reply) => {
    const value = await snapshot();
    if (!value) {
      // Nothing indexed yet. 503 rather than an empty snapshot: the client
      // must show "waiting for the indexer", not zeros that look like data.
      return reply.code(503).send({
        error: 'no-data',
        message: 'The indexer has not written a block yet.',
      });
    }
    return reply.type('application/json').send(serialise(value));
  });

  app.get('/api/stream', { websocket: true }, (connection) => {
    let closed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const send = async () => {
      timer = null;
      if (closed) return;
      const value = await snapshot(true);
      if (closed || !value) return;
      try {
        connection.send(serialise(value));
      } catch {
        /* the socket went away between the query and the send */
      }
    };

    // §4.4: debounce to about a second so a burst of blocks is one push.
    const schedule = () => {
      if (closed || timer) return;
      timer = setTimeout(send, env.streamDebounceMs);
    };

    void send();
    const unsubscribePromise = subscribeTicks(schedule);

    connection.on('close', () => {
      closed = true;
      if (timer) clearTimeout(timer);
      void unsubscribePromise.then((unsubscribe) => unsubscribe());
    });
    connection.on('error', () => {
      closed = true;
    });
  });

  return app;
}

export async function start(): Promise<FastifyInstance> {
  if (!USDG) {
    throw new Error(
      'USDG_ADDRESS is required: it is the site\'s one USD anchor (§4.3). ' +
        'Without it every USD figure would read zero.',
    );
  }
  const app = await buildServer();
  await app.listen({ port: env.apiPort, host: env.apiHost });
  if (busKind() === 'in-process') {
    app.log.warn(
      'No REDIS_URL: the tick bus is in-process. Fine for one API instance; ' +
        'a second one would not see the indexer\'s ticks and would only ever ' +
        'push on its own poll.',
    );
  }
  return app;
}
