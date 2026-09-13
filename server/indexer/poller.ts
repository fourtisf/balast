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
import { POOL_MANAGER_ABI, V3_POOL_ABI } from '../chain/abi';
import { env } from '../env';
import type { PriceAnchors } from './aggregate';
import { rebuildAggregates } from './aggregate';
import { classifyPools, ensureTokens, findAnchorPool, type TokenReader } from './discovery';
import {
  decodePoolManagerLog,
  decodeV3PoolLog,
  sortEvents,
  type ChainEvent,
} from './events';
import { planIngest } from './ingest';
import {
  loadFeeTiers,
  loadKnownPools,
  loadPriceState,
  readCursor,
  writeCursor,
  writeLiquidity,
  writePools,
  writeSwaps,
} from './store';

/** The cursor key for the one v4 contract every pool lives in. */
export const POOL_MANAGER_CURSOR = `v4:${CONTRACTS.poolManager.toLowerCase()}`;

/**
 * What the poller needs from a chain. Satisfied by viem in production and by
 * a replayable fixture in the §9 test.
 */
export interface LogSource {
  getHeadBlock(): Promise<{ number: bigint; timestamp: Date }>;
  /** Block timestamps for a range, so an event carries chain time not wall time. */
  getBlockTimes(from: bigint, to: bigint): Promise<Map<bigint, Date>>;
  getLogs(args: {
    address: string | string[];
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

export interface PassResult {
  fromBlock: bigint;
  toBlock: bigint;
  headBlock: bigint;
  events: number;
  swapsWritten: number;
  liquidityWritten: number;
  poolsFound: number;
  tokensFound: number;
  /** Seconds between the last indexed block's time and head's. Shown in the top bar (§7). */
  lagSeconds: number;
  caughtUp: boolean;
}

export interface PollerOptions {
  source: LogSource;
  /** USDG's address. Required for the one USD anchor path (§4.3). */
  usdgAddress: string;
  /** v3 pool addresses to follow, if any. v4 needs only the manager. */
  v3Pools?: string[];
  startBlock?: bigint;
  blockRange?: number;
  /** Override for tests; production uses §2's 32. */
  reorgDepth?: number;
  /** Where token symbol/name/decimals come from. Defaults to the token contract. */
  tokenReader?: TokenReader;
  log?: (message: string) => void;
}

export class Poller {
  private readonly source: LogSource;
  private readonly usdgAddress: string;
  private readonly startBlock: bigint;
  private readonly blockRange: bigint;
  private readonly reorgDepth: bigint;
  private readonly log: (message: string) => void;
  private readonly tokenReader?: TokenReader;
  private v3Pools: string[];

  constructor(options: PollerOptions) {
    this.source = options.source;
    this.usdgAddress = options.usdgAddress.toLowerCase();
    this.startBlock = options.startBlock ?? env.startBlock;
    this.blockRange = BigInt(options.blockRange ?? env.blockRange);
    this.reorgDepth = BigInt(options.reorgDepth ?? CHAIN.reorgDepth);
    this.v3Pools = (options.v3Pools ?? []).map((a) => a.toLowerCase());
    this.tokenReader = options.tokenReader;
    this.log = options.log ?? (() => {});
  }

  /** Anchors for the SQL aggregation, resolved fresh each pass. */
  private async anchors(): Promise<PriceAnchors> {
    return {
      weth: CONTRACTS.weth.toLowerCase(),
      usdg: this.usdgAddress,
      wethDecimals: 18,
      usdgDecimals: 6,
      anchorPoolId: await findAnchorPool(this.usdgAddress),
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
    const head = await this.source.getHeadBlock();
    const cursor = await readCursor(POOL_MANAGER_CURSOR);

    // Re-scan the last 32 blocks (§4.1). On the very first pass there is
    // nothing to re-scan, so start where configured.
    const from =
      cursor === null
        ? this.startBlock
        : max(this.startBlock, cursor - this.reorgDepth + 1n);
    const to = min(head.number, from + this.blockRange - 1n);

    if (to < from) {
      // Head has not moved past what we already have.
      return {
        fromBlock: from,
        toBlock: cursor ?? from,
        headBlock: head.number,
        events: 0,
        swapsWritten: 0,
        liquidityWritten: 0,
        poolsFound: 0,
        tokensFound: 0,
        lagSeconds: 0,
        caughtUp: true,
      };
    }

    const addresses = [CONTRACTS.poolManager.toLowerCase(), ...this.v3Pools];
    const logs = await this.source.getLogs({ address: addresses, fromBlock: from, toBlock: to });
    const blockTimes = await this.source.getBlockTimes(from, to);

    const managerAddress = CONTRACTS.poolManager.toLowerCase();
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
      const decoded =
        raw.address.toLowerCase() === managerAddress
          ? decodePoolManagerLog(log as never, blockTime)
          : decodeV3PoolLog(log as never, blockTime);
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
    const tokensFound = await ensureTokens(tokenAddresses, head.timestamp, this.tokenReader);
    await writePools(initializePlan);

    // Then the rest, with the carried price state loaded from the database so
    // a restart mid-chain resumes exactly where a full replay would be.
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

    const plan = planIngest(usable, {
      chainId: CHAIN.id,
      sqrtPriceByPool: await loadPriceState(from),
      feePipsByPool: await loadFeeTiers(),
    });

    const swapsWritten = await writeSwaps(plan);
    const liquidityWritten = await writeLiquidity(plan);

    // Aggregates, in dependency order: the anchor price series, the staged
    // token flow, the fee hours valued through the anchor, then pool state
    // built on the flow. Scoped to the hours this range touched.
    const anchors = await this.anchors();
    await rebuildAggregates(anchors, { fromBlock: from, toBlock: to });
    await classifyPools();

    const lastBlockTime = blockTimes.get(to) ?? head.timestamp;
    await writeCursor(POOL_MANAGER_CURSOR, to, lastBlockTime);

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
      lagSeconds,
      caughtUp: to >= head.number,
    };
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

function min(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

/** Topics the poller cares about, for an RPC that supports topic filters. */
export const WATCHED_TOPICS = { POOL_MANAGER_ABI, V3_POOL_ABI };
