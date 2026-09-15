/**
 * The v3 pools created before the factory was followed.
 *
 * v4 announces every pool on one PoolManager, which the poller has read from
 * the start block. v3 announces a pool on the factory and then emits
 * everything from the pool's own address — and the factory was only
 * configured once the cursor was millions of blocks in (§20), so every
 * `PoolCreated` before that block was never read, and every pool it named
 * was never followed. On the live board that was WIF: its real market, a v3
 * pool with a hundred thousand dollars in it, absent, while a hooked v4
 * pool with forty dollars of trades stood for the token.
 *
 * So the first pass walks the factory's history from the start block to the
 * block the factory has been followed from (`v3_history_block`, advanced by
 * every pass since), writes the pools it names, and then walks those pools'
 * own logs from their creation to the cursor, all of them in one window at a
 * time. Windows adapt the way the poller's do — halved on a refusal, doubled
 * when empty — progress is remembered, so a restart resumes rather than
 * repeats, and each phase is a recorded stage with a heartbeat (working.ts),
 * so health reads `working` with the block it has reached rather than
 * `stalled` while it runs (§19).
 */

import { CHAIN } from '../../lib/chain';
import { V3_POOL_TOPICS } from '../chain/abi';
import { prisma } from '../db';
import { ensureTokens, type TokenReader } from './discovery';
import { decodeV3FactoryLog, decodeV3PoolLog, sortEvents, type ChainEvent } from './events';
import { planIngest } from './ingest';
import type { LogSource } from './poller';
import {
  loadFeeTiers,
  loadKnownPools,
  loadPriceState,
  writeLiquidity,
  writePools,
  writeSwaps,
} from './store';
import { withWork } from './working';

/** `indexer_state`: the block up to which the factory's PoolCreated logs have been read. */
export const V3_HISTORY_KEY = 'v3_history_block';
/** `indexer_state`: pools whose own history is still being read, and how far. */
const V3_PENDING_KEY = 'v3_history_pending';

const HARD_MIN_RANGE = 64n;
const BUSY_LOGS = 2_000;

type RawLog = Awaited<ReturnType<LogSource['getLogs']>>[number];

interface Pending {
  addresses: string[];
  /** The next block to read the pools' own logs from. */
  from: string;
  to: string;
}

export interface V3HistoryResult {
  /** Pools the factory named in the range that were not in the tables. */
  pools: number;
  events: number;
  addresses: string[];
}

export async function backfillV3History(args: {
  source: LogSource;
  factory: string;
  startBlock: bigint;
  /** The block the factory has been followed from; the cursor on a box that never followed it. */
  toBlock: bigint;
  window: bigint;
  maxWindow: bigint;
  tokenReader?: TokenReader;
  log?: (message: string) => void;
}): Promise<V3HistoryResult> {
  const log = args.log ?? (() => {});
  const factory = args.factory.toLowerCase();
  const scanned = await readState(V3_HISTORY_KEY);
  const from = scanned === null ? args.startBlock : max(args.startBlock, BigInt(scanned) + 1n);

  // Phase 1: the factory, for the pools it named.
  const found: { address: string; createdBlock: bigint }[] = [];
  let windows = 0;
  if (from <= args.toBlock) {
    log(`  v3 history: reading the factory from block ${from} to ${args.toBlock}`);
    const known = await loadKnownPools();
    await withWork('v3 history: factory', (note) => walk(args.source, { address: [factory] }, from, args.toBlock, args.window, args.maxWindow, async (logs, w) => {
      windows++;
      note(`block ${w.to.toLocaleString()} of ${args.toBlock.toLocaleString()}, ${found.length} pool(s) so far`);
      if (logs.length > 0) {
        const times = await args.source.getBlockTimes(w.from, w.to);
        const events: ChainEvent[] = [];
        for (const raw of logs) {
          const time = times.get(raw.blockNumber);
          if (!time) continue;
          const decoded = decodeV3FactoryLog(asLog(raw), time);
          if (decoded) events.push(decoded);
        }
        const plan = planIngest(sortEvents(events), {
          chainId: CHAIN.id,
          sqrtPriceByPool: new Map(),
          feePipsByPool: new Map(),
        });
        const fresh = plan.pools.filter((p) => !known.has(p.id));
        if (fresh.length > 0) {
          await ensureTokens(fresh.flatMap((p) => [p.token0, p.token1]), times.get(w.to) ?? new Date(), args.tokenReader);
          await writePools(plan);
          for (const p of fresh) {
            known.add(p.id);
            found.push({ address: p.address.toLowerCase(), createdBlock: p.createdBlock });
          }
        }
      }
      await writeState(V3_HISTORY_KEY, w.to.toString());
      if (windows % 20 === 0) {
        log(`  v3 history: factory read to block ${w.to} of ${args.toBlock}, ${found.length} pool(s) so far`);
      }
    }));
    if (found.length > 0) {
      const earliest = found.reduce((a, p) => (p.createdBlock < a ? p.createdBlock : a), found[0].createdBlock);
      const pending: Pending = {
        addresses: found.map((p) => p.address),
        from: earliest.toString(),
        to: args.toBlock.toString(),
      };
      await writeState(V3_PENDING_KEY, JSON.stringify(pending));
    }
  }

  // Phase 2: the pools' own logs, from creation to the cursor — resumable,
  // because on a real chain this is the long part.
  const pendingRaw = await readState(V3_PENDING_KEY);
  let events = 0;
  let addresses: string[] = [];
  if (pendingRaw) {
    const pending = JSON.parse(pendingRaw) as Pending;
    addresses = pending.addresses;
    const pfrom = BigInt(pending.from);
    const pto = BigInt(pending.to);
    if (addresses.length > 0 && pfrom <= pto) {
      log(`  v3 history: reading ${addresses.length} pool(s) from block ${pfrom} to ${pto}`);
      const feePips = await loadFeeTiers();
      const ids = addresses.map((a) => `v3:${a}`);
      // By signature, with the pools' addresses checked here: a request
      // naming twelve thousand contracts was answered in seventeen seconds
      // when it was answered at all (poller.ts).
      const wanted = new Set(addresses.map((a) => a.toLowerCase()));
      let walked = 0;
      await withWork('v3 history: pools', (note) => walk(args.source, { topics: V3_POOL_TOPICS }, pfrom, pto, args.window, args.maxWindow, async (logs, w) => {
        walked++;
        note(`${addresses.length} pool(s), block ${w.to.toLocaleString()} of ${pto.toLocaleString()}, ${events} event(s) so far`);
        const ours = logs.filter((raw) => wanted.has(raw.address.toLowerCase()));
        if (ours.length > 0) {
          const times = await args.source.getBlockTimes(w.from, w.to);
          const decoded: ChainEvent[] = [];
          for (const raw of ours) {
            const time = times.get(raw.blockNumber);
            if (!time) continue;
            const event = decodeV3PoolLog(asLog(raw), time);
            if (event) decoded.push(event);
          }
          const plan = planIngest(sortEvents(decoded), {
            chainId: CHAIN.id,
            sqrtPriceByPool: await loadPriceState(w.from, new Set(ids)),
            feePipsByPool: feePips,
          });
          events += (await writeSwaps(plan)) + (await writeLiquidity(plan));
        }
        await writeState(V3_PENDING_KEY, JSON.stringify({ ...pending, from: (w.to + 1n).toString() }));
        if (walked % 20 === 0) {
          log(`  v3 history: pools read to block ${w.to} of ${pto}, ${events} event(s) so far`);
        }
      }));
    }
    await prisma.indexerState.deleteMany({ where: { key: V3_PENDING_KEY } });
  }

  return { pools: found.length, events, addresses };
}

/** Sequential windows over a range, adapting the width the way the poller does. */
async function walk(
  source: LogSource,
  filter: { address?: string[]; topics?: string[] },
  from: bigint,
  to: bigint,
  window: bigint,
  maxWindow: bigint,
  onWindow: (logs: RawLog[], w: { from: bigint; to: bigint }) => Promise<void>,
): Promise<void> {
  let width = max(HARD_MIN_RANGE, min(window, maxWindow));
  let cursor = from;
  while (cursor <= to) {
    const end = min(to, cursor + width - 1n);
    let logs: RawLog[];
    try {
      logs = await source.getLogs({ ...filter, fromBlock: cursor, toBlock: end });
    } catch (error) {
      // A refused width, as in the poller: halve and ask again for the same
      // range. At the hard minimum there is nothing left to try.
      if (width <= HARD_MIN_RANGE) throw error;
      width = max(HARD_MIN_RANGE, width / 2n);
      continue;
    }
    await onWindow(logs, { from: cursor, to: end });
    cursor = end + 1n;
    if (logs.length === 0) width = min(maxWindow, width * 2n);
    else if (logs.length > BUSY_LOGS) width = max(HARD_MIN_RANGE, width / 2n);
  }
}

function asLog(raw: RawLog) {
  return {
    ...raw,
    address: raw.address as `0x${string}`,
    topics: raw.topics as [] | [`0x${string}`, ...`0x${string}`[]],
    data: raw.data as `0x${string}`,
    transactionHash: raw.transactionHash as `0x${string}`,
  } as never;
}

async function readState(key: string): Promise<string | null> {
  const row = await prisma.indexerState.findUnique({ where: { key } });
  return row?.value ?? null;
}

export async function writeState(key: string, value: string): Promise<void> {
  await prisma.indexerState.upsert({
    where: { key },
    create: { key, value, updatedAt: new Date() },
    update: { value, updatedAt: new Date() },
  });
}

function min(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}
function max(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}
