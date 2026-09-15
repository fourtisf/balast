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
import rateLimit from '@fastify/rate-limit';
import { CONTRACTS } from '../../lib/chain';
import type { MarketSnapshot } from '../../lib/data/types';
import { prisma } from '../db';
import { env } from '../env';
import { POOL_MANAGER_CURSOR } from '../indexer/poller';
import { USER_AGENT } from '../indexer/logo-sources';
import { resolveUsdg } from '../indexer/anchor';
import { readWork } from '../indexer/working';
import { busKind, subscribeTicks } from './bus';
import { MarketFeed } from './market';
import { buildSnapshot } from './snapshot';

const USDG = process.env.USDG_ADDRESS ?? '';

/**
 * Blocks behind head past which the indexer is BACKFILLING rather than
 * following. At ~100ms blocks a lag of a few thousand is seconds of chain, so
 * the threshold is high enough not to call a brief catch-up a first sync.
 */
const SYNCING_BLOCKS = 50_000n;

/**
 * The sentence that tells an operator which of two situations they are in.
 *
 * "No USD anchor yet" is the same message whether the indexer is at block
 * 400k of 62m — where the only correct action is to wait — or has caught up
 * and genuinely found no ETH/USDG pool, where waiting is the one thing that
 * will not help. The page showed the first sentence and not this one, so the
 * dead end was indistinguishable from progress.
 */
/** `4h 12m`, `37m`, `50s` — a duration a person reads at a glance. */
function humanSeconds(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

function syncingNote(args: {
  syncing: boolean;
  progress: number | null;
  behind: bigint | null;
  pools: number;
}): string {
  const { syncing, progress, behind, pools } = args;
  const found = `${pools.toLocaleString()} pool(s) discovered so far.`;
  if (behind === null) {
    return `${found} The indexer has not reported the chain head yet.`;
  }
  if (syncing) {
    const pct = progress === null ? '' : ` (${progress.toFixed(2)}% of the chain)`;
    return (
      `The first sync is still running${pct}: ${behind.toLocaleString()} blocks behind head, ` +
      `${found} It may simply not have reached the pool yet.`
    );
  }
  return (
    `The indexer is caught up (${behind.toLocaleString()} blocks behind head) and ${found} ` +
    'Being caught up means waiting will not fix this: check that POOL_MANAGER and WETH in ' +
    'lib/chain.ts are the addresses this chain actually uses, or set USDG_ADDRESS.'
  );
}

/**
 * What, if anything, makes this API unable to serve real numbers.
 *
 * The API used to THROW on a missing USDG_ADDRESS and refuse to start, which
 * is backwards: it is the one process that could say what is wrong, and
 * instead it crash-looped — 24 restarts, no explanation anywhere, and a
 * front end that could not even ask. A configuration error should be loudly
 * visible, not fatal.
 *
 * So it starts, answers, and reports this. `/api/health` returns it with a
 * 503 so a monitor still catches it, and `/api/snapshot` refuses with the
 * same reason, which the waiting page then shows the operator.
 */
function configurationProblem(): string | null {
  // An UNSET address is no longer a problem: the anchor is discovered from
  // the chain's own tokens. A malformed one still is — someone meant to pin a
  // specific token and mistyped it, and quietly discovering a different one
  // would be worse than saying so.
  if (USDG && !/^0x[0-9a-fA-F]{40}$/.test(USDG)) {
    return (
      `USDG_ADDRESS is set but is not an address: ${JSON.stringify(USDG)}. ` +
      'Fix or remove it — left unset, the anchor is discovered from the ' +
      'tokens the indexer finds.'
    );
  }
  return null;
}

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

/** The subset of `fetch` the logo route uses, so a test can hand in a fake. */
export type LogoFetch = (
  url: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

/** A logo the API is holding, or the memory that there is none to hold. */
type CachedLogo = { at: number; type: string; body: Buffer } | { at: number; miss: true };
const LOGO_TTL_MS = 24 * 60 * 60 * 1000;
const LOGO_MISS_TTL_MS = 10 * 60 * 1000;
const LOGO_CACHE_MAX = 2_000;
const LOGO_MAX_BYTES = 2 * 1024 * 1024;

export async function buildServer(options: { logoFetch?: LogoFetch } = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });

  await app.register(cors, {
    // The browser reaches the API through nginx on the same origin, so CORS
    // is only for local development against `next dev`.
    origin: process.env.CORS_ORIGIN ?? true,
  });

  /**
   * Rate limit, because `/api/snapshot` is the expensive query and this is a
   * public endpoint in front of one Postgres. Without it, one person with a
   * loop takes the site down for everyone.
   *
   * The allowance is deliberately generous: the front end polls every 20s as
   * a safety net behind the websocket, and a page open in a dozen tabs behind
   * one NAT must not get throttled. This is here to stop a loop, not to
   * ration users.
   *
   * `X-Forwarded-For` is trusted because nginx sets it and nothing else can
   * reach the port — the API binds 127.0.0.1.
   */
  await app.register(rateLimit, {
    max: env.rateLimitMax,
    timeWindow: env.rateLimitWindowMs,
    // The websocket is one request that then stays open for hours. Counting
    // it against a per-minute budget would drop reconnects after a restart,
    // which is exactly when every client reconnects at once.
    // The logo route is one request per badge on the board, served from
    // memory after the first: a hundred of them on one page load is normal,
    // not a loop.
    allowList: (request) =>
      request.url.startsWith('/api/stream') || request.url.startsWith('/api/logo/'),
    keyGenerator: (request) =>
      (request.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ??
      request.ip,
    // The object returned here is THROWN by the plugin, so it needs a
    // statusCode of its own — without one Fastify's error handler treats it
    // as an unhandled error and answers 500, which tells a client to retry
    // instead of to back off. Caught by the test below.
    errorResponseBuilder: (_request, context) => ({
      statusCode: 429,
      error: 'rate-limited',
      message: `Too many requests. Try again in ${Math.ceil(context.ttl / 1000)}s.`,
    }),
  });

  await app.register(websocket);

  /**
   * The snapshot is cached for as long as a tick has not arrived. Every
   * connected client on a quiet chain then costs one query, not one per
   * client per poll.
   */
  let cached: { snapshot: MarketSnapshot | null; at: number } | null = null;
  let building: Promise<MarketSnapshot | null> | null = null;

  /**
   * Live market figures (market.ts): DexScreener, then GeckoTerminal for what
   * it does not list. A refresh that changed a quote rebuilds the snapshot
   * and wakes every socket, so the row moves on the aggregator's cadence even
   * while the indexer is in a long stage and publishes no tick.
   */
  const marketListeners = new Set<() => void>();
  /**
   * Coalesce the feed's updates onto the rebuild floor.
   *
   * The feed publishes as each batch of quotes lands rather than when the
   * whole cycle ends, so the board fills in after a restart instead of
   * reading `chain` for a minute. `rebuild()` only de-duplicates calls that
   * overlap, so a dozen batches would have run the expensive query a dozen
   * times back to back. This runs it at most once per SNAPSHOT_MIN_REBUILD_MS
   * and always runs a last one, so nothing published is left unseen.
   */
  let marketPublish: ReturnType<typeof setTimeout> | null = null;
  const publishMarket = (): void => {
    if (marketPublish) return;
    const since = cached ? Date.now() - cached.at : Infinity;
    marketPublish = setTimeout(
      () => {
        marketPublish = null;
        void rebuild()
          .then(() => {
            for (const wake of marketListeners) wake();
          })
          .catch((error) => app.log.warn({ err: error }, 'snapshot rebuild after a market refresh failed'));
      },
      Math.max(0, env.snapshotMinRebuildMs - since),
    );
    marketPublish.unref?.();
  };
  const market = new MarketFeed({
    base: env.dexscreenerUrl,
    chain: env.dexscreenerChain,
    geckoBase: env.geckoterminalUrl,
    geckoNetwork: env.geckoterminalNetwork,
    refreshMs: env.dexscreenerRefreshMs,
    enabled: env.dexscreenerMarket,
    log: (line) => app.log.info(line.trim()),
    onUpdate: publishMarket,
  });
  market.start();
  app.addHook('onClose', async () => {
    market.stop();
    if (marketPublish) clearTimeout(marketPublish);
  });

  /** One query at a time, whoever asks. */
  function rebuild(): Promise<MarketSnapshot | null> {
    if (!building) {
      building = buildSnapshot({ usdgAddress: USDG || null, market })
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

  /**
   * The snapshot, served stale and refreshed behind the request.
   *
   * It used to be rebuilt for any request older than the stream debounce —
   * one second — and every websocket client forced its own rebuild on every
   * indexer tick, which during a first sync is every second. The expensive
   * query ran continuously, page loads queued behind it, and "loading the
   * snapshot" sat on screen on every refresh.
   *
   * Now the last built snapshot is answered immediately, and a rebuild is
   * started in the background at most once per SNAPSHOT_MIN_REBUILD_MS. The
   * first request after a start is the only one that waits. A few seconds
   * of staleness is invisible next to the lag figure the top bar already
   * shows (§7), and the snapshot carries its own as-of time.
   */
  function snapshot(): Promise<MarketSnapshot | null> {
    if (!cached) return rebuild();
    if (Date.now() - cached.at >= env.snapshotMinRebuildMs) {
      void rebuild().catch((error) => app.log.warn({ err: error }, 'snapshot rebuild failed'));
    }
    return Promise.resolve(cached.snapshot);
  }

  /**
   * Health, and the one thing an uptime monitor can act on.
   *
   * A 200 here used to mean only "the API answered", which is useless as an
   * alert: the indexer can be dead for a day while this endpoint cheerfully
   * returns ok. §8's P3 criterion names that exact failure — a process that
   * dies quietly while the site shows its last numbers as though they were
   * live — and it applies to the indexer now, a phase early.
   *
   * So a stalled or never-started indexer returns **503**. Any uptime check
   * that watches a status code catches it with no extra plumbing, and the
   * body says which of the two it is.
   */
  app.get('/api/health', async (_request, reply) => {
    const cursor = await prisma.indexerCursor.findUnique({
      where: { contract: POOL_MANAGER_CURSOR },
    });
    // The poller's last pass — blocks, events, and seconds per stage — so a
    // slow backfill can be read from outside the box, not only from its log.
    const lastPassRow = await prisma.indexerState.findUnique({ where: { key: 'last_pass' } });
    let lastPass: unknown = null;
    try {
      lastPass = lastPassRow ? JSON.parse(lastPassRow.value) : null;
    } catch {
      lastPass = null;
    }
    // Two different clocks, and they answer two different questions.
    //
    // `lagSeconds` is CHAIN time: how old the newest indexed block is. It is
    // what the top bar shows (§7) and during a first sync it is enormous by
    // definition — seventy days, on this chain — while nothing is wrong.
    //
    // `idleSeconds` is WALL time since the poller last wrote the cursor. That
    // is liveness: a poller that has not written in five minutes is dead or
    // stuck, whatever the chain lag says. "Stalled" used to be judged on the
    // first clock, so a healthy backfill read as a stall for two days and the
    // monitor would have alerted the whole way.
    const lagSeconds = cursor
      ? Math.max(0, (Date.now() - cursor.lastIndexedAt.getTime()) / 1000)
      : null;
    const idleSeconds = cursor
      ? Math.max(0, (Date.now() - cursor.updatedAt.getTime()) / 1000)
      : null;
    // A third clock, for the stages that write no block at all: the full
    // rebuild of every priced table and the factory's history, hours each
    // on the real tables. Both heartbeat while they run (indexer/working.ts).
    // A fresh heartbeat is an indexer that is alive and busy, and says on
    // what and for how long; a stale one is ignored, so a process killed
    // mid-stage reads as stalled once the threshold passes, as before.
    const work = await readWork();
    const heartbeatSeconds = work ? (Date.now() - Date.parse(work.heartbeatAt)) / 1000 : null;
    const working =
      work !== null &&
      heartbeatSeconds !== null &&
      Number.isFinite(heartbeatSeconds) &&
      heartbeatSeconds <= env.stallSeconds;
    const workSeconds = work ? Math.max(0, (Date.now() - Date.parse(work.startedAt)) / 1000) : null;
    const [counts] = await prisma.$queryRaw<{ pools: number; swaps: number }[]>`
      SELECT (SELECT COUNT(*) FROM pools)::int AS pools,
             (SELECT COUNT(*) FROM swap_events)::int AS swaps
    `;
    // Which token is pricing the whole site, and how that was decided. This
    // is the single most consequential value in the system — a wrong anchor
    // makes every dollar figure wrong — so it is auditable from outside.
    const anchor = await resolveUsdg(USDG || null);

    // How far through the chain the indexer is.
    //
    // Without this the waiting page could say only "no anchor yet", which is
    // true in two situations that need opposite responses: a first sync still
    // grinding through empty blocks (wait), and a finished sync that found no
    // ETH/USDG pool (look at the addresses). The head is recorded by the
    // poller each pass, so answering costs no RPC call.
    const head = cursor?.headBlock ?? null;
    const behind = head !== null && cursor ? head - cursor.lastIndexedBlock : null;
    const syncing = behind !== null && behind > SYNCING_BLOCKS;
    const progress =
      head !== null && head > 0n && cursor
        ? Math.min(100, Number((cursor.lastIndexedBlock * 10000n) / head) / 100)
        : null;

    // Misconfiguration outranks everything: a never-indexed chain is the
    // SYMPTOM when the indexer cannot start, and reporting the symptom sends
    // whoever is looking to the wrong place.
    const problem = configurationProblem();
    const stalled = idleSeconds !== null && idleSeconds > env.stallSeconds && !working;
    const status = problem
      ? 'misconfigured'
      : working
        ? 'working'
        : cursor === null
          ? 'never-indexed'
          : stalled
            ? 'stalled'
            : !anchor.address
              ? 'no-anchor'
              : syncing
                ? 'syncing'
                : lagSeconds !== null && lagSeconds > env.stallSeconds
                  ? 'behind'
                  : 'ok';
    // 503 is for states a person has to act on. A first sync and a catch-up
    // are the indexer doing its job with the lag on screen; a monitor that
    // pages for forty hours of expected work is a monitor that gets muted.
    const needsSomeone =
      status === 'misconfigured' ||
      status === 'never-indexed' ||
      status === 'stalled' ||
      status === 'no-anchor';

    const body = {
      // Kept for anything already reading it, but `status` is the field to
      // watch: "ok" here has never meant the numbers are current.
      ok: status === 'ok',
      status,
      stallThresholdSeconds: env.stallSeconds,
      indexed: cursor
        ? {
            lastBlock: cursor.lastIndexedBlock.toString(),
            at: cursor.lastIndexedAt,
            lagSeconds,
            /** Wall seconds since the poller last wrote. Liveness, not lag. */
            idleSeconds,
            headBlock: head === null ? null : head.toString(),
            blocksBehind: behind === null ? null : behind.toString(),
            progressPct: progress,
            syncing,
            lastPass,
          }
        : null,
      /** The stage in progress that writes no block, with its heartbeat; null between stages. */
      working:
        work && working
          ? {
              stage: work.stage,
              detail: work.detail ?? null,
              startedAt: work.startedAt,
              seconds: workSeconds,
              heartbeatSeconds,
            }
          : null,
      pools: counts?.pools ?? 0,
      swaps: counts?.swaps ?? 0,
      bus: busKind(),
      /** The DexScreener feed: how many of the board's tokens it quotes, and what it last said. */
      market: market.status(),
      weth: CONTRACTS.weth,
      usdg: anchor.address,
      usdgSource: anchor.source,
      usdgNote: anchor.note,
      message:
        status === 'misconfigured'
          ? problem!
          : status === 'never-indexed'
            ? 'The indexer has never written a block. Check `pm2 logs balast-indexer`.'
            : status === 'no-anchor'
              ? // The anchor's own reason, and then the fact that decides what
                // to do about it: a sync that has not reached the pools yet is
                // not the same problem as one that has and found none.
                `${anchor.note} ${syncingNote({ syncing, progress, behind, pools: counts?.pools ?? 0 })}`
              : status === 'working'
              ? `The indexer is busy: ${work!.stage}` +
                (work!.detail ? ` — ${work!.detail}` : '') +
                `, ${humanSeconds(workSeconds ?? 0)} so far, alive ${Math.round(heartbeatSeconds ?? 0)}s ago. ` +
                'No block is written until this finishes' +
                (lagSeconds === null ? '.' : `; the site is showing numbers ${humanSeconds(lagSeconds)} old.`)
              : status === 'stalled'
              ? `The indexer has not written a block for ${Math.round(idleSeconds ?? 0)}s, past the ` +
                `${env.stallSeconds}s threshold. It is dead or stuck; the site is showing numbers ` +
                `${Math.round(lagSeconds ?? 0)}s old.`
              : status === 'syncing'
                ? `First sync: block ${cursor!.lastIndexedBlock} of ${head}` +
                  (progress === null ? '' : ` (${progress.toFixed(2)}%)`) +
                  `, ${counts?.pools ?? 0} pool(s) so far. Numbers on the site are ` +
                  `${Math.round(lagSeconds ?? 0)}s of chain time behind and say so.`
                : status === 'behind'
                  ? `Indexing, but the newest block is ${Math.round(lagSeconds ?? 0)}s old — catching up.`
                  : undefined,
    };

    return reply.code(needsSomeone ? 503 : 200).send(body);
  });

  /**
   * A token's logo, served from here.
   *
   * The board once showed four empty discs: logo URLs that loaded from the
   * box and not from a browser, or the reverse — a host that answers one
   * client and refuses another. The browser now asks this route, this
   * route fetches the URL on record exactly as the logo process did when it
   * checked that the image loads, and the two tests become one. The bytes
   * are held in memory for a day, so a hundred badges cost the source one
   * request; a URL that stops serving an image is remembered as a miss for
   * ten minutes rather than asked about on every page load.
   *
   * Only URLs on record are fetched — this is not an open proxy — and only
   * an image comes back: anything else is a 404, and the badge falls back
   * to the monogram.
   */
  const logoCache = new Map<string, CachedLogo>();
  const logoFetch = options.logoFetch ?? (globalThis.fetch as unknown as LogoFetch);

  app.get<{ Params: { address: string } }>('/api/logo/:address', async (request, reply) => {
    const address = request.params.address.toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(address)) {
      return reply.code(400).send({ statusCode: 400, error: 'bad-address', message: 'Not an address.' });
    }

    const now = Date.now();
    const held = logoCache.get(address);
    if (held && now - held.at < ('miss' in held ? LOGO_MISS_TTL_MS : LOGO_TTL_MS)) {
      if ('miss' in held) return reply.code(404).send();
      return reply
        .type(held.type)
        .header('cache-control', 'public, max-age=86400')
        .send(held.body);
    }

    const remember = (entry: CachedLogo) => {
      if (logoCache.size >= LOGO_CACHE_MAX) {
        const oldest = logoCache.keys().next().value;
        if (oldest !== undefined) logoCache.delete(oldest);
      }
      logoCache.set(address, entry);
    };

    const token = await prisma.token.findUnique({ where: { address }, select: { logoUrl: true } });
    if (!token?.logoUrl) {
      remember({ at: now, miss: true });
      return reply.code(404).send();
    }

    try {
      const upstream = await logoFetch(token.logoUrl, {
        headers: { accept: 'image/*,*/*;q=0.5', 'user-agent': USER_AGENT },
        signal: AbortSignal.timeout(10_000),
      });
      const type = upstream.headers.get('content-type')?.split(';')[0].trim() ?? '';
      const isImage = /^image\//i.test(type) || /octet-stream/i.test(type);
      if (!upstream.ok || !isImage) {
        app.log.warn(`logo for ${address} does not serve an image (${upstream.status} ${type || 'no type'}): ${token.logoUrl}`);
        remember({ at: now, miss: true });
        return reply.code(404).send();
      }
      const body = Buffer.from(await upstream.arrayBuffer());
      if (body.length === 0 || body.length > LOGO_MAX_BYTES) {
        remember({ at: now, miss: true });
        return reply.code(404).send();
      }
      remember({ at: now, type, body });
      return reply.type(type).header('cache-control', 'public, max-age=86400').send(body);
    } catch (error) {
      app.log.warn({ err: error }, `logo for ${address} could not be fetched: ${token.logoUrl}`);
      remember({ at: now, miss: true });
      return reply.code(404).send();
    }
  });

  app.get('/api/snapshot', async (_request, reply) => {
    const problem = configurationProblem();
    if (problem) {
      // Not "no data yet": a reason. The waiting page shows this verbatim, so
      // whoever opens the site sees what to fix instead of a blank panel.
      return reply.code(503).send({ error: 'misconfigured', message: problem });
    }
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

    // Push only what changed: the same revision is not sent twice, so a
    // tick that arrives before the next rebuild costs this socket nothing.
    let sentRevision = -1;
    const send = async () => {
      timer = null;
      if (closed) return;
      const value = await snapshot();
      if (closed || !value || value.revision === sentRevision) return;
      try {
        connection.send(serialise(value));
        sentRevision = value.revision;
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
    marketListeners.add(schedule);

    connection.on('close', () => {
      closed = true;
      if (timer) clearTimeout(timer);
      marketListeners.delete(schedule);
      void unsubscribePromise.then((unsubscribe) => unsubscribe());
    });
    connection.on('error', () => {
      closed = true;
    });
  });

  return app;
}

export async function start(): Promise<FastifyInstance> {
  const app = await buildServer();
  await app.listen({ port: env.apiPort, host: env.apiHost });

  // Loud, and still serving. The old behaviour was to throw here, which took
  // the process down and left nothing able to report the cause.
  const problem = configurationProblem();
  if (problem) app.log.error(`NOT SERVING REAL DATA: ${problem}`);

  if (busKind() === 'in-process') {
    app.log.warn(
      'No REDIS_URL: the tick bus is in-process. Fine for one API instance; ' +
        'a second one would not see the indexer\'s ticks and would only ever ' +
        'push on its own poll.',
    );
  }
  return app;
}
