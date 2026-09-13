/**
 * The indexer and the API are separate processes (§2: PM2), so "something
 * changed" has to cross a process boundary. Redis does it when configured;
 * without it the bus is in-process, which is correct for one API instance on
 * one box and silently wrong for two — hence the warning at startup rather
 * than a surprise later.
 */

import { env } from '../env';

export interface Tick {
  toBlock: string;
  lagSeconds: number;
}

const CHANNEL = 'balast:tick';

type Handler = (tick: Tick) => void;
const local = new Set<Handler>();

/** Lazily created, so a process that never publishes never connects. */
let publisher: import('ioredis').Redis | null = null;
let subscriber: import('ioredis').Redis | null = null;

async function redis(): Promise<typeof import('ioredis') | null> {
  if (!env.redisUrl) return null;
  return import('ioredis');
}

export async function publishTick(tick: Tick): Promise<void> {
  for (const handler of local) handler(tick);

  const mod = await redis();
  if (!mod) return;
  if (!publisher) {
    publisher = new mod.Redis(env.redisUrl!, { maxRetriesPerRequest: 2, lazyConnect: false });
    publisher.on('error', () => {
      // A dead Redis must not take the indexer down with it: the aggregates
      // are already written, and the API will pick them up on its next poll.
    });
  }
  try {
    await publisher.publish(CHANNEL, JSON.stringify(tick));
  } catch {
    /* see above */
  }
}

export async function subscribeTicks(handler: Handler): Promise<() => void> {
  local.add(handler);

  const mod = await redis();
  if (mod && !subscriber) {
    subscriber = new mod.Redis(env.redisUrl!, { maxRetriesPerRequest: 2 });
    subscriber.on('error', () => {});
    await subscriber.subscribe(CHANNEL);
    subscriber.on('message', (_channel, payload) => {
      try {
        const tick = JSON.parse(payload) as Tick;
        for (const h of local) h(tick);
      } catch {
        /* a malformed message is not worth crashing the stream over */
      }
    });
  }

  return () => {
    local.delete(handler);
  };
}

export function busKind(): 'redis' | 'in-process' {
  return env.redisUrl ? 'redis' : 'in-process';
}

export async function closeBus(): Promise<void> {
  await publisher?.quit().catch(() => {});
  await subscriber?.quit().catch(() => {});
  publisher = null;
  subscriber = null;
  local.clear();
}
