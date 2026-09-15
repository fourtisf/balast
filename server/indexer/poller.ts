/**
 * The log poller (§4.1).
 *
 * Reads logs in ranges, writes raw rows, tracks `last_indexed_block` per
 * contract, and re-scans the last 32 blocks every pass because reorg depth on
 * an Orbit L2 is shallow but not zero. The re-scan is safe because every row
 * is upserted by `(txHash, logIndex)` and every aggregate is rebuilt rather
 * than incremented — see ingest.ts and aggregate.ts.
 *
 * The RPC layer is injectable. That is not for neatness: §9 requires proving
 * that a block-zero re-run and an incremental run produce identical rows, and
 * that is only testable against a log source you can replay exactly.
 */

import { CHAIN, CONTRACTS } from '../../lib/chain';
import { FOLLOWED_TOPICS, POOL_MANAGER_ABI, V3_POOL_ABI } from '../chain/abi';
import { env } from '../env';
import type { PriceAnchors } from './aggregate';
import { rebuildAggregates, rebuildFlowHours, rebuildPoolState } from './aggregate';
import {
  classifyPools,
  ensureTokens,
  findAnchorPool,
  refreshSupplies,
  repairNativeToken,
  type TokenReader,
} from './discovery';
import {
  decodePoolManagerLog,
  decodeV3FactoryLog,
  decodeV3PoolLog,
  sortEvents,
  type ChainEvent,
} from './events';
import { resolveUsdg } from './anchor';
import { planIngest } from './ingest';
import { V3_HISTORY_KEY, backfillV3History, writeState } from './v3-history';
import { clearWork, withWork } from './working';
import { prisma } from '../db';
import {
  loadFeeTiers,
  loadKnownPools,
  loadPriceState,
  loadV3PoolAddresses,
  readCursor,
  touchCursor,
  writeCursor,
  writeLiquidity,
  writePools,
  writeSwaps,
} from './store';

/**
 * Logs in a pass above which the range is narrowed.
 *
 * Not about memory: it is the signal that the next window at this width would
 * likely be refused, and narrowing before that saves the wasted round trip.
 */
const BUSY_LOGS = 2_000;

/**
 * Clean passes between attempts to grow again after a refusal.
 *
 * A refused width or a rate limit teaches a ceiling, and a ceiling learned
 * in a dense stretch of chain — "more than N results" — is too low for the
 * empty stretch after it. So every so often the poller asks for more, and a
 * refusal there costs one pass in forty. A probe that succeeds is followed
 * by another on the next pass, so climbing back is quick once it starts.
 */
const PROBE_EVERY = 40;

/** An endpoint saying "not this many at once": halve the concurrency, keep the window. */
const RATE_LIMITED = /\b429\b|rate.?limit|too many requests/i;
/** Transient trouble that a burst makes likelier: a timeout, a reset, a gateway error. */
const TRANSIENT = /timeout|timed out|took too long|ETIMEDOUT|ECONNRESET|ECONNREFUSED|socket hang up|\b50[234]\b/i;

/** The cursor key for the one v4 contract every pool lives in. */
export const POOL_MANAGER_CURSOR = `v4:${CONTRACTS.poolManager.toLowerCase()}`;
/** `indexer_state` key: the anchor the priced tables were last fully rebuilt for. */
export const REBUILT_ANCHOR_KEY = 'rebuilt_anchor';

/**
 * What the poller needs from a chain. Satisfied by viem in production and by
 * a replayable fixture in the §9 test.
 */
export interface LogSource {
  getHeadBlock(): Promise<{ number: bigint; timestamp: Date }>;
  /** Block timestamps for a range, so an event carries chain time not wall time. */
  getBlockTimes(from: bigint, to: bigint): Promise<Map<bigint, Date>>;
  getLogs(args: {
    /** Contract(s) to ask for. Omitted, any contract — the pass asks by `topics` and keeps what it follows. */
    address?: string | string[];
    /** topic0 alternatives: only logs of these event signatures. */
    topics?: string[];
    fromBlock: bigint;
    toBlock: bigint;
  }): Promise<
    {
      address: string;
      topics: string[];
      data: string;
      blockNumber: bigint;
      logIndex: number;
      transactionHash: string;
    }[]
  >;
}

/** Where a pass spent its time, in milliseconds. Logged every pass and kept in `indexer_state` for /api/health. */
export interface PassTimings {
  logsMs: number;
  timesMs: number;
  tokensMs: number;
  ingestMs: number;
  rebuildMs: number;
  totalMs: number;
}

const NO_TIMINGS: PassTimings = {
  logsMs: 0,
  timesMs: 0,
  tokensMs: 0,
  ingestMs: 0,
  rebuildMs: 0,
  totalMs: 0,
};

/**
 * While backfilling: every Nth pass re-reads token supplies and holdings (one
 * multicall per fifty tokens, so the cadence is short), and rebuilds every
 * pool's state.
 */
const SUPPLY_EVERY = 5;
const FULL_STATE_EVERY = 60;
/**
 * The narrowest window a refusal can force. The configured floor is a
 * preference for following head; a refused range has to narrow past it or
 * the same range is asked for forever — which is exactly what the live box
 * did at block 4,408,287, all four endpoints refusing 2000 blocks and the
 * floor at 2000. Twice the reorg depth, so a pass still advances.
 */
const HARD_MIN_RANGE = 64n;

export interface PassResult {
  fromBlock: bigint;
  toBlock: bigint;
  headBlock: bigint;
  events: number;
  swapsWritten: number;
  liquidityWritten: number;
  poolsFound: number;
  tokensFound: number;
  /** Token supplies re-read this pass, for the fully diluted figure. */
  suppliesRefreshed: number;
  /** Blocks this pass covered, across every window it fetched. Visible so the adaptation is observable. */
  blockRange: number;
  /** Blocks per window this pass. */
  windowBlocks: number;
  /** Windows fetched and ingested this pass — fewer than asked for when a later one was refused. */
  windows: number;
  /** Windows the pass asked for at once. */
  concurrency: number;
  /** Every window was refused: nothing was ingested and the cursor did not move. */
  refused: boolean;
  /** Fully refused passes in a row, this one included; the main loop backs off on it. Zero when something arrived. */
  refusedInARow: number;
  /** Logs of a followed signature from a contract that is not followed — another DEX's v3 pool, say. Fetched and dropped. */
  foreign: number;
  /** Seconds between the last indexed block's time and head's. Shown in the top bar (§7). */
  lagSeconds: number;
  caughtUp: boolean;
  timings: PassTimings;
}

export interface PollerOptions {
  source: LogSource;
  /**
   * USDG's address, if someone pinned one. Optional: when it is absent the
   * anchor is discovered from the chain's own tokens (see anchor.ts), so the
   * indexer starts and indexes rather than waiting on a human.
   */
  usdgAddress?: string | null;
  /**
   * v3 pool addresses to follow. Usually empty: pools discovered through the
   * factory are followed automatically and reloaded from the database on
   * restart. Use it only to follow a pool whose `PoolCreated` predates
   * START_BLOCK.
   */
  v3Pools?: string[];
  /**
   * The v3 factory. Without it, v3 pools are only those listed above — and
   * §4 says some older pools on this chain are v3, so a hand-list silently
   * omits real ones.
   */
  v3Factory?: string | null;
  startBlock?: bigint;
  blockRange?: number;
  /** Override for tests; production uses §2's 32. */
  reorgDepth?: number;
  /** Ceiling for the adaptive range. Lowered on the first refusal. */
  maxBlockRange?: number;
  /** Windows fetched at once per pass. Lowered on a rate limit. */
  fetchConcurrency?: number;
  /** Where token symbol/name/decimals come from. Defaults to the token contract. */
  tokenReader?: TokenReader;
  log?: (message: string) => void;
  /** Per-token logo sources. Defaults to LOGO_SOURCES; tests pass their own with a fake fetch. */
}

export class Poller {
  private readonly source: LogSource;
  private readonly usdgAddress: string | null;
  /** Last resolution, so a change of anchor is logged once rather than every pass. */
  private lastAnchorLogged: string | null | undefined = undefined;
  /**
   * The anchor the aggregates were last built against. When it changes —
   * including from "none" to "found", which on a real chain happens some
   * passes into the first sync — every priced table is rebuilt in full
   * rather than for the hours this pass touched. See the pass body.
   */
  /**
   * The anchor the priced tables were last fully rebuilt for. Loaded from
   * `indexer_state` on the first pass (undefined until then), so a restart
   * with the same anchor does not redo a rebuild that on a large table is
   * longer than the gap between two deploys.
   */
  private lastAnchorAddress: string | null | undefined = undefined;
  /** The native-ether row is asserted once per process; see repairNativeToken. */
  private nativeRepaired = false;
  /** Wall clock of the last per-token logo lookup: one token per LOGO_LOOKUP_MS. */
  private readonly startBlock: bigint;
  /**
   * Blocks per pass, which ADAPTS as it goes.
   *
   * A fixed 2,000 is right once the indexer is following head and wrong by
   * four orders of magnitude during a first sync: this chain is 62 million
   * blocks deep and almost all of it is empty, so a fixed window meant some
   * thirty thousand round trips — about thirty-four hours — before reaching
   * anything worth indexing.
   *
   * Empty ranges widen, busy ranges narrow, and a range the endpoint refuses
   * lowers a learned ceiling. That last part is why this is adaptive rather
   * than just "set it larger": every endpoint caps `eth_getLogs` differently
   * and none of them say so up front, so the poller finds the cap by hitting
   * it once and then stays under it.
   */
  private blockRange: bigint;
  /** Never go below this: a busy range still has to make progress. */
  private readonly minRange: bigint;
  /**
   * Learned from refusals. Starts optimistic, comes down on a refusal, and
   * is probed upward again after a stretch of clean passes — a ceiling
   * learned in a dense stretch is too low for the empty one after it.
   */
  private maxRange: bigint;
  /** What the ceiling may be probed back up to. */
  private readonly configuredMaxRange: bigint;
  /**
   * Windows fetched at once per pass.
   *
   * The cost of a pass that does not scale with the window — the anchor
   * query, the aggregate rebuild, the cursor write — turned out to dominate
   * on the live box: at 250-block windows a pass took seven seconds, of
   * which the fetch was two. Several windows at once divide that fixed cost
   * by as many. An endpoint that objects to the burst says so with a 429
   * or a timeout, and that halves the concurrency rather than the window;
   * a refused width still narrows the window rather than the concurrency.
   */
  private concurrency: number;
  private readonly maxConcurrency: number;
  /** Passes since the last refusal of any kind. Drives the upward probe. */
  private cleanPasses = 0;
  /** Set by a probe that was accepted: the next clean pass probes again. */
  private probing = false;
  private readonly reorgDepth: bigint;
  private readonly log: (message: string) => void;
  private readonly tokenReader?: TokenReader;
  private readonly v3Factory: string | null;
  private v3Pools: string[];
  /** Set once the known v3 pools have been loaded from the database. */
  private v3Loaded = false;
  /** Passes this run. Drives the backfill cadences above. */
  private passes = 0;
  /** Every pool is classified once per run; after that, only the pools a pass discovers. */
  private classifiedAll = false;
  /** Fully refused passes in a row. */
  private refusedInARow = 0;

  constructor(options: PollerOptions) {
    this.source = options.source;
    this.usdgAddress = options.usdgAddress?.toLowerCase() ?? null;
    this.startBlock = options.startBlock ?? env.startBlock;
    this.minRange = BigInt(options.blockRange ?? env.blockRange);
    this.blockRange = this.minRange;
    // 50k is above what most public endpoints allow, deliberately: the first
    // refusal teaches the real ceiling, and one wasted call is worth hours.
    this.maxRange = BigInt(options.maxBlockRange ?? env.maxBlockRange);
    this.configuredMaxRange = this.maxRange;
    this.maxConcurrency = Math.max(1, options.fetchConcurrency ?? env.fetchConcurrency);
    this.concurrency = this.maxConcurrency;
    this.reorgDepth = BigInt(options.reorgDepth ?? CHAIN.reorgDepth);
    this.v3Pools = (options.v3Pools ?? []).map((a) => a.toLowerCase());
    this.v3Factory = options.v3Factory?.toLowerCase() ?? null;
    this.tokenReader = options.tokenReader;
    this.log = options.log ?? (() => {});
  }

  /**
   * Anchors for the SQL aggregation, resolved fresh each pass.
   *
   * Fresh, not cached, because on a first sync the anchor does not exist yet:
   * the indexer writes raw rows with no dollar figures, discovers USDG a few
   * passes later, and the next rebuild prices everything retroactively. That
   * only works because aggregates are rebuilt rather than incremented.
   */
  private async anchors(): Promise<PriceAnchors | null> {
    const resolved = await resolveUsdg(this.usdgAddress);
    // On the address, not the note: the note carries the anchor pool's swap
    // count, which changes every pass while syncing, and the line was being
    // logged every pass for it.
    if (resolved.address !== this.lastAnchorLogged) {
      this.log(`  anchor: ${resolved.note}`);
      this.lastAnchorLogged = resolved.address;
    }
    if (!resolved.address) return null;
    return {
      weth: CONTRACTS.weth.toLowerCase(),
      usdg: resolved.address,
      anchorPoolId: await findAnchorPool(resolved.address),
    };
  }

  /**
   * One pass: fetch a range, ingest it, rebuild the aggregates it touched,
   * move the cursor.
   *
   * The cursor is advanced only after the aggregates are rebuilt. A crash
   * between the two therefore re-does the range rather than skipping it,
   * which the upserts make harmless.
   */
  async runPass(): Promise<PassResult> {
    // v3 pools discovered on an earlier run have to be followed again after a
    // restart, or the process would stop indexing them without saying so.
    if (!this.v3Loaded) {
      // A stage record left by a process that was killed mid-stage is not
      // this process's; its heartbeat is stale, but say so rather than rely on it.
      await clearWork();
      this.followV3Pools(await loadV3PoolAddresses());
      // And the pools the factory named before it was followed at all: the
      // factory was configured with the cursor millions of blocks in, so
      // every PoolCreated before that block was never read (v3-history.ts).
      const cursorNow = await readCursor(POOL_MANAGER_CURSOR);
      if (this.v3Factory && cursorNow !== null) {
        const history = await backfillV3History({
          source: this.source,
          factory: this.v3Factory,
          startBlock: this.startBlock,
          toBlock: cursorNow,
          window: this.minRange,
          maxWindow: this.maxRange,
          tokenReader: this.tokenReader,
          log: this.log,
        });
        if (history.addresses.length > 0) this.followV3Pools(history.addresses);
        if (history.pools > 0 || history.events > 0) {
          // Their fees and reserves are history, so the priced tables are
          // rebuilt in full below rather than for this pass's hours.
          await prisma.indexerState.deleteMany({ where: { key: REBUILT_ANCHOR_KEY } });
          this.lastAnchorAddress = undefined;
          this.log(
            `  v3 history: ${history.pools} pool(s) and ${history.events} event(s) the factory ` +
              'had named before it was followed — rebuilding the priced tables',
          );
        }
      }
      this.v3Loaded = true;
    }

    this.passes++;
    const startedAt = Date.now();
    const head = await this.source.getHeadBlock();
    const cursor = await readCursor(POOL_MANAGER_CURSOR);

    // Re-scan the last 32 blocks (§4.1). On the very first pass there is
    // nothing to re-scan, so start where configured.
    const from =
      cursor === null
        ? this.startBlock
        : max(this.startBlock, cursor - this.reorgDepth + 1n);
    // Several windows a pass. The span is what the pass covers; each window
    // is one eth_getLogs call, and they go out together.
    const windowBlocks = this.blockRange;
    const concurrency = this.concurrency;
    let to = min(head.number, from + windowBlocks * BigInt(concurrency) - 1n);

    if (to < from) {
      // Head has not moved past what we already have. Still alive, though,
      // and the health check judges liveness by the cursor's write time.
      await touchCursor(POOL_MANAGER_CURSOR);
      return {
        fromBlock: from,
        toBlock: cursor ?? from,
        headBlock: head.number,
        events: 0,
        swapsWritten: 0,
        liquidityWritten: 0,
        poolsFound: 0,
        tokensFound: 0,
        // Caught up is exactly when there is room to spend an RPC call on
        // something other than logs.
        suppliesRefreshed: await refreshSupplies(head.timestamp, { read: this.tokenReader }),
        lagSeconds: 0,
        caughtUp: true,
        blockRange: Number(windowBlocks),
        windowBlocks: Number(windowBlocks),
        windows: 0,
        concurrency,
        refused: false,
        refusedInARow: 0,
        foreign: 0,
        timings: { ...NO_TIMINGS, totalMs: Date.now() - startedAt },
      };
    }

    const managerAddress = CONTRACTS.poolManager.toLowerCase();
    // By signature, not by address. v3 is one contract per pool and the
    // factory on this chain has named nearly thirteen thousand; a request
    // listing them all was answered in seventeen seconds when it was
    // answered at all, and the list only grows. The seven signatures never
    // do. What comes back from a contract this poller does not follow —
    // another DEX's v3 pool emits the same Swap — is dropped below.
    const windows = splitWindows(from, to, windowBlocks);
    const logsStarted = Date.now();
    const fetched = await Promise.allSettled(
      windows.map((w) => this.source.getLogs({ topics: FOLLOWED_TOPICS, fromBlock: w.from, toBlock: w.to })),
    );
    // The windows are contiguous, so the ones that succeeded up to the first
    // that did not are a range this pass can still ingest. A later window
    // that also succeeded is fetched again next pass rather than ingested
    // out of order: the cursor is one number and it never skips.
    const logs: Awaited<ReturnType<LogSource['getLogs']>> = [];
    let busiest = 0;
    let failedAt = -1;
    let failure: unknown = null;
    for (let i = 0; i < fetched.length; i++) {
      const outcome = fetched[i];
      if (outcome.status === 'rejected') {
        failedAt = i;
        failure = outcome.reason;
        break;
      }
      logs.push(...outcome.value);
      busiest = Math.max(busiest, outcome.value.length);
    }
    if (failedAt >= 0) {
      const failed = fetched.filter((o) => o.status === 'rejected').length;
      this.adaptToRefusal(failure, windows[failedAt], failed, windows.length);
      if (failedAt === 0) {
        // Nothing usable. The cursor does not move, so nothing is skipped;
        // the next pass asks again, narrower or fewer at a time — and after
        // a wait that grows with the streak (main.ts).
        this.refusedInARow++;
        return {
          fromBlock: from,
          toBlock: cursor ?? from,
          headBlock: head.number,
          events: 0,
          swapsWritten: 0,
          liquidityWritten: 0,
          poolsFound: 0,
          tokensFound: 0,
          suppliesRefreshed: 0,
          lagSeconds: 0,
          caughtUp: false,
          blockRange: Number(this.blockRange),
          windowBlocks: Number(windowBlocks),
          windows: 0,
          concurrency,
          refused: true,
          refusedInARow: this.refusedInARow,
          foreign: 0,
          timings: { ...NO_TIMINGS, logsMs: Date.now() - logsStarted, totalMs: Date.now() - startedAt },
        };
      }
      to = windows[failedAt - 1].to;
    }
    this.refusedInARow = 0;
    const ingestedWindows = failedAt >= 0 ? failedAt : windows.length;
    const logsMs = Date.now() - logsStarted;
    const timesStarted = Date.now();
    const blockTimes = await this.source.getBlockTimes(from, to);
    const timesMs = Date.now() - timesStarted;

    // The v3 pools this pass keeps: the ones followed before it, plus any
    // the factory names in these very logs. The logs are in chain order and
    // a pool is created before it is used, so its first Mint — its entire
    // starting liquidity — is kept without a second fetch.
    const followed = new Set(this.v3Pools);
    let foreign = 0;
    const events: ChainEvent[] = [];
    for (const raw of logs) {
      const blockTime = blockTimes.get(raw.blockNumber);
      if (!blockTime) continue; // A block we could not time is a block we skip.
      const log = {
        ...raw,
        address: raw.address as `0x${string}`,
        topics: raw.topics as [] | [`0x${string}`, ...`0x${string}`[]],
        data: raw.data as `0x${string}`,
        transactionHash: raw.transactionHash as `0x${string}`,
      };
      const source = raw.address.toLowerCase();
      let decoded: ChainEvent | null;
      if (source === managerAddress) {
        decoded = decodePoolManagerLog(log as never, blockTime);
      } else if (source === this.v3Factory) {
        decoded = decodeV3FactoryLog(log as never, blockTime);
        if (decoded?.kind === 'initialize') followed.add(decoded.contract.toLowerCase());
      } else if (followed.has(source)) {
        decoded = decodeV3PoolLog(log as never, blockTime);
      } else {
        foreign++;
        continue;
      }
      if (decoded) events.push(decoded);
    }

    const ordered = sortEvents(events);

    // Pools first: a swap row has a foreign key to its pool, and a pool
    // discovered in this very range has to exist before its swaps are written.
    const initializePlan = planIngest(
      ordered.filter((e) => e.kind === 'initialize'),
      { chainId: CHAIN.id, sqrtPriceByPool: new Map(), feePipsByPool: new Map() },
    );
    const tokenAddresses = initializePlan.pools.flatMap((p) => [p.token0, p.token1]);
    const tokensStarted = Date.now();
    const tokensFound = await ensureTokens(tokenAddresses, head.timestamp, this.tokenReader);
    const tokensMs = Date.now() - tokensStarted;
    await writePools(initializePlan);

    // A v3 pool the factory named in THIS range emits everything else from
    // its own address. Its logs in this range were kept above — the fetch is
    // by signature, so they arrived with the factory's — and from here on the
    // pool is followed by name, across passes and, through the database, across
    // restarts.
    const newV3 = initializePlan.pools.filter((p) => p.protocol === 'v3');
    if (newV3.length > 0) {
      this.followV3Pools(newV3.map((p) => p.address));
      this.log(`  discovered ${newV3.length} v3 pool(s); following ${this.v3Pools.length}`);
    }

    // Then the rest, with the carried price state loaded from the database so
    // a restart mid-chain resumes exactly where a full replay would be.
    const ingestStarted = Date.now();
    const known = await loadKnownPools();
    const usable = ordered.filter((e) => known.has(e.poolId));
    const skipped = ordered.length - usable.length;
    if (skipped > 0) {
      // Events for a pool whose Initialize predates our start block. Counting
      // their fees would attribute them to a pool that does not exist in our
      // tables; dropping them understates that pool. Say so rather than
      // silently doing either.
      this.log(
        `  ${skipped} event(s) for pools created before block ${this.startBlock} — ` +
          'lower START_BLOCK to include them',
      );
    }

    // The pools this batch touches: what the price state is loaded for and
    // what the pool-state rebuild below is scoped to.
    const touched = new Set(usable.map((e) => e.poolId));
    const plan = planIngest(usable, {
      chainId: CHAIN.id,
      sqrtPriceByPool: await loadPriceState(from, touched),
      feePipsByPool: await loadFeeTiers(),
    });

    if (plan.unpriced.length > 0) {
      // Should not happen now the Initialize price is stored on the pool row.
      // If it does, the pool's depth reads as unknown rather than wrong, and
      // this is how anyone finds out — it used to be a thrown error that
      // stopped the indexer on every pass instead.
      const pools = [...new Set(plan.unpriced.map((u) => u.poolId))];
      this.log(
        `  ${plan.unpriced.length} liquidity event(s) unvalued across ${pools.length} ` +
          `pool(s) — no price known at that point: ${pools.slice(0, 3).join(', ')}`,
      );
    }

    const swapsWritten = await writeSwaps(plan);
    const liquidityWritten = await writeLiquidity(plan);
    const ingestMs = Date.now() - ingestStarted;

    // Aggregates, in dependency order: the anchor price series, the staged
    // token flow, the fee hours valued through the anchor, then pool state
    // built on the flow. Scoped to the hours this range touched.
    const rebuildStarted = Date.now();
    const caughtUpNow = to >= head.number;
    const anchors = await this.anchors();
    // Supplies first: the FDV figure in pool_state is computed from them, so
    // refreshing after the rebuild would leave it a pass behind. While
    // backfilling they are re-read on a cadence rather than every pass: each
    // is RPC calls, and the figure only shows once the board is current.
    const suppliesRefreshed =
      caughtUpNow || this.passes % SUPPLY_EVERY === 1
        ? await refreshSupplies(head.timestamp, { read: this.tokenReader })
        : 0;
    const bounds = { fromBlock: from, toBlock: to };

    if (!this.nativeRepaired) {
      const rows = await repairNativeToken();
      if (rows > 0) this.log(`  native ether row asserted as ${CHAIN.nativeCurrency.symbol}`);
      this.nativeRepaired = true;
    }

    // Token flow needs no anchor — it is amounts, not dollars — so it is
    // staged every pass. It used to be skipped along with the priced tables
    // whenever the anchor was unknown, and on the real chain the anchor was
    // unknown for the first few million blocks: when it finally resolved,
    // only the hours of THAT pass had flow rows, so every pool's reserves
    // were its recent swaps without the mint that funded them. Negative
    // reserves read as unknown depth (§14), and the whole site showed TVL $0.
    await rebuildFlowHours(bounds);

    if (anchors) {
      if (this.lastAnchorAddress === undefined) {
        const remembered = await prisma.indexerState.findUnique({ where: { key: REBUILT_ANCHOR_KEY } });
        this.lastAnchorAddress = remembered?.value ?? null;
      }
      if (anchors.usdg !== this.lastAnchorAddress) {
        // A new anchor prices history, not just this window. §17 promised
        // that the pass discovering USDG reprices everything retroactively;
        // bounded to the touched hours it never did. Once per anchor, and
        // remembered: it used to run on every restart too, and once the raw
        // tables were a few million rows that took longer than the gap
        // between deploys, so no pass finished for a day. `npm run
        // aggregates:rebuild` forgets the marker when a repair needs one.
        this.log(`  anchor ${anchors.usdg}: rebuilding every priced table from the raw rows`);
        const started = Date.now();
        // Hours on the real tables, and no cursor write until it is done:
        // recorded as a stage with a heartbeat, so health reads `working`
        // rather than `stalled` while it runs (working.ts).
        await withWork('full rebuild', (note) => rebuildAggregates(anchors, undefined, this.log, undefined, note));
        await prisma.indexerState.upsert({
          where: { key: REBUILT_ANCHOR_KEY },
          create: { key: REBUILT_ANCHOR_KEY, value: anchors.usdg, updatedAt: new Date() },
          update: { value: anchors.usdg, updatedAt: new Date() },
        });
        this.lastAnchorAddress = anchors.usdg;
        this.log(`  rebuilt in ${((Date.now() - started) / 1000).toFixed(1)}s`);
      } else {
        await rebuildAggregates(anchors, bounds, undefined, touched);
        // Pool state depends on the latest anchor price as well as on each
        // pool's own flow, so the scoped rebuild above leaves untouched pools
        // priced at an older anchor. Every pool is redone once the pass
        // reaches head, and on a cadence while it is still far from it.
        if (caughtUpNow || this.passes % FULL_STATE_EVERY === 0) await rebuildPoolState(anchors);
      }
    }
    // No anchor yet means no dollar figure is derivable. The raw rows and the
    // flow above are still written; the full rebuild on the pass that first
    // finds USDG prices them. Skipping the priced tables here is not data loss.
    if (!this.classifiedAll) {
      await classifyPools();
      this.classifiedAll = true;
    } else {
      await classifyPools(initializePlan.pools.map((p) => p.id));
    }
    const rebuildMs = Date.now() - rebuildStarted;

    const lastBlockTime = blockTimes.get(to) ?? head.timestamp;
    await writeCursor(POOL_MANAGER_CURSOR, to, lastBlockTime, head.number);
    // The factory's PoolCreated logs have been read to here (v3-history.ts).
    if (this.v3Factory) await writeState(V3_HISTORY_KEY, to.toString());

    // Adapt for the next pass. Only while backfilling: once the indexer is
    // following head there is nothing to gain from a wider window and a
    // narrow one keeps latency low.
    const behind = head.number - to;
    if (behind > this.blockRange) {
      if (logs.length === 0) {
        // Empty. This is the case that matters — most of a 62-million-block
        // chain is empty, and doubling turns tens of thousands of passes into
        // hundreds.
        this.blockRange = min(this.maxRange, this.blockRange * 2n);
      } else if (busiest > BUSY_LOGS) {
        // Dense enough that the next window risks a refusal, and each pass is
        // doing real work anyway. Judged per window: the endpoint's cap is
        // on one request, not on the pass.
        this.blockRange = max(HARD_MIN_RANGE, this.blockRange / 2n);
      }
      if (failedAt < 0) this.probe();
    } else {
      this.blockRange = this.minRange;
    }
    // Never above what the endpoints have shown they accept.
    this.blockRange = min(this.blockRange, this.maxRange);

    const lagSeconds = Math.max(
      0,
      (head.timestamp.getTime() - lastBlockTime.getTime()) / 1000,
    );

    return {
      fromBlock: from,
      toBlock: to,
      headBlock: head.number,
      events: ordered.length,
      swapsWritten,
      liquidityWritten,
      poolsFound: initializePlan.pools.length,
      tokensFound,
      suppliesRefreshed,
      lagSeconds,
      caughtUp: to >= head.number,
      blockRange: Number(to - from + 1n),
      windowBlocks: Number(windowBlocks),
      windows: ingestedWindows,
      concurrency,
      refused: false,
      refusedInARow: 0,
      foreign,
      timings: {
        logsMs,
        timesMs,
        tokensMs,
        ingestMs,
        rebuildMs,
        totalMs: Date.now() - startedAt,
      },
    };
  }

  /**
   * What a refused window teaches.
   *
   * A rate limit or a timeout with several windows in flight is the burst
   * being too much: halve the concurrency and keep the window. A refused
   * single window is the width, whatever the endpoint called it — "more
   * than N results", "range too large", a timeout, or a 429 that some
   * endpoints answer to a heavy query: halve it, record the ceiling, and
   * let the next pass retry the same range narrower, after a wait that
   * grows with the streak (main.ts). A single 429 used to change nothing,
   * on the theory that the endpoint wanted a moment; on the box that was a
   * thousand-block window asked for every second for hours, refused every
   * time, and the cursor not moving once. Endpoints differ and none
   * announce their cap, so it is found by hitting it.
   */
  private adaptToRefusal(
    error: unknown,
    window: { from: bigint; to: bigint },
    failed: number,
    asked: number,
  ): void {
    this.cleanPasses = 0;
    this.probing = false;
    const width = window.to - window.from + 1n;
    const reasons = failoverReasons(error);
    const reason = reasons[0] ?? String(error);
    const rateLimited = reasons.length > 0 && reasons.every((r) => RATE_LIMITED.test(r));
    const transient = reasons.length > 0 && reasons.every((r) => RATE_LIMITED.test(r) || TRANSIENT.test(r));
    if (transient && this.concurrency > 1) {
      this.concurrency = Math.max(1, Math.floor(this.concurrency / 2));
      this.log(
        `  endpoint refused ${failed} of ${asked} windows in flight (${reason}) — ` +
          `${this.concurrency} at a time from here`,
      );
    } else if (width <= HARD_MIN_RANGE) {
      // Nothing narrower to try. The main loop waits longer each time.
      this.maxRange = HARD_MIN_RANGE;
      this.blockRange = HARD_MIN_RANGE;
      this.log(`  endpoint refused ${width} blocks (${reason}) — already at the minimum, backing off`);
    } else {
      // Below the configured floor if it must: the floor is for following
      // head, and a refused width is a fact about the endpoint.
      this.maxRange = max(HARD_MIN_RANGE, width / 2n);
      this.blockRange = this.maxRange;
      this.log(`  endpoint refused ${width} blocks (${reason}${rateLimited ? ', a single window' : ''}) — range now ${this.blockRange}`);
    }
  }

  /**
   * After a stretch of clean passes, ask for more again: first the
   * concurrency back toward its configured value, then the window's ceiling
   * toward its configured maximum — only when the window is pinned at the
   * ceiling, since a window kept narrow by dense logs would not use a higher
   * one. A probe that is accepted is followed by another next pass; one that
   * is refused resets the count.
   */
  private probe(): void {
    this.cleanPasses++;
    if (!this.probing && this.cleanPasses % PROBE_EVERY !== 0) return;
    if (this.concurrency < this.maxConcurrency) {
      this.concurrency = Math.min(this.maxConcurrency, this.concurrency * 2);
      this.probing = true;
      this.log(`  clean for ${this.cleanPasses} passes — trying ${this.concurrency} windows at a time`);
    } else if (this.maxRange < this.configuredMaxRange && this.blockRange === this.maxRange) {
      this.maxRange = min(this.configuredMaxRange, this.maxRange * 2n);
      this.blockRange = this.maxRange;
      this.probing = true;
      this.log(`  clean for ${this.cleanPasses} passes — trying ${this.blockRange}-block windows`);
    } else {
      this.probing = false;
    }
  }

  /** Run passes until caught up to head. Returns the passes it took. */
  async syncToHead(maxPasses = 100_000): Promise<PassResult[]> {
    const results: PassResult[] = [];
    for (let i = 0; i < maxPasses; i++) {
      const result = await this.runPass();
      results.push(result);
      if (result.caughtUp) break;
    }
    return results;
  }

  /** Add v3 pools to follow. v3 has one contract per pool, so this grows. */
  followV3Pools(addresses: string[]): void {
    const set = new Set(this.v3Pools);
    for (const a of addresses) set.add(a.toLowerCase());
    this.v3Pools = [...set];
  }
}

function max(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

/** Contiguous windows of `width` covering `from..to`; the last may be shorter. */
export function splitWindows(from: bigint, to: bigint, width: bigint): { from: bigint; to: bigint }[] {
  const windows: { from: bigint; to: bigint }[] = [];
  for (let start = from; start <= to; start += width) {
    windows.push({ from: start, to: min(to, start + width - 1n) });
  }
  return windows;
}

/**
 * Each endpoint's reason from a failover error, which lists them one per
 * line under a first line saying the call failed everywhere. A plain error
 * is its own one reason.
 */
function failoverReasons(error: unknown): string[] {
  const message = error instanceof Error ? error.message : String(error);
  const lines = message
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.length > 1 ? lines.slice(1) : lines;
}

function min(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

/** Topics the poller cares about, for an RPC that supports topic filters. */
export const WATCHED_TOPICS = { POOL_MANAGER_ABI, V3_POOL_ABI };
