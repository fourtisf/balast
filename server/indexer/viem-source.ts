/**
 * The production `LogSource`: viem over the failover client.
 *
 * Block timestamps are the fiddly part. Every event needs chain time, not the
 * time we happened to read it — §7's whole point is that a stale number must
 * never look live — and Robinhood Chain's ~100ms blocks (§2) mean a 2000-block
 * range is 2000 timestamps and about three minutes of chain. Fetching each
 * block individually would be 2000 round trips a pass, so timestamps are
 * fetched only for the blocks that actually carry a log, cached, and reused.
 *
 * Two things make that cheap on a busy chain. A recent node puts
 * `blockTimestamp` on every log it returns, which is the whole answer for
 * free, so `eth_getLogs` is called raw rather than through viem's formatter
 * (which drops the field). What is still missing is fetched fifty blocks
 * per JSON-RPC batch; an endpoint that refuses batches is detected once and
 * the source drops back to small concurrent groups for the rest of the run.
 */

import { RPC_BATCH_SIZE, rpc, rpcBatched } from '../chain/client';
import type { LogSource } from './poller';

interface RawLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string | null;
  logIndex: string | null;
  transactionHash: string | null;
  /** Present on nodes that carry the field (geth ≥ 1.14.11 and its forks). */
  blockTimestamp?: string;
}

export class ViemLogSource implements LogSource {
  /** Block number to timestamp. Blocks are immutable, so this never expires. */
  private readonly times = new Map<bigint, Date>();
  private readonly needed = new Set<bigint>();
  /** Whether the endpoints accept a JSON-RPC batch. Assumed until one refuses. */
  private batching = true;
  /** How many timestamps the logs themselves supplied, for the pass log. */
  timestampsFromLogs = 0;

  constructor(private readonly log: (message: string) => void = () => {}) {}

  async getHeadBlock(): Promise<{ number: bigint; timestamp: Date }> {
    const block = await rpc((c) => c.getBlock({ blockTag: 'latest' }), 'getBlock(latest)');
    const timestamp = new Date(Number(block.timestamp) * 1000);
    this.times.set(block.number, timestamp);
    return { number: block.number, timestamp };
  }

  async getLogs(args: {
    address: string | string[];
    fromBlock: bigint;
    toBlock: bigint;
  }) {
    const addresses = (Array.isArray(args.address) ? args.address : [args.address]).map(
      (a) => a as `0x${string}`,
    );
    const logs = await rpc(
      (c) =>
        c.request({
          method: 'eth_getLogs',
          params: [
            {
              address: addresses.length === 1 ? addresses[0] : addresses,
              fromBlock: `0x${args.fromBlock.toString(16)}`,
              toBlock: `0x${args.toBlock.toString(16)}`,
            },
          ],
        }) as Promise<RawLog[]>,
      `getLogs(${args.fromBlock}-${args.toBlock})`,
    );

    const out = [];
    for (const log of logs) {
      if (log.blockNumber === null || log.logIndex === null || log.transactionHash === null) {
        // A pending log has no position, so it has no primary key. Skip it;
        // the next pass sees it mined.
        continue;
      }
      const blockNumber = BigInt(log.blockNumber);
      if (log.blockTimestamp && !this.times.has(blockNumber)) {
        this.times.set(blockNumber, new Date(Number(BigInt(log.blockTimestamp)) * 1000));
        this.timestampsFromLogs++;
      }
      // Remember which blocks we will need a timestamp for.
      this.needed.add(blockNumber);
      out.push({
        address: log.address,
        topics: log.topics,
        data: log.data,
        blockNumber,
        logIndex: Number(BigInt(log.logIndex)),
        transactionHash: log.transactionHash,
      });
    }
    return out;
  }

  /**
   * Timestamps for the blocks in a range that carry logs, plus the range's own
   * end block so the cursor has an honest time to record.
   */
  async getBlockTimes(from: bigint, to: bigint): Promise<Map<bigint, Date>> {
    const wanted = new Set<bigint>([to]);
    for (const block of this.needed) {
      if (block >= from && block <= to) wanted.add(block);
    }
    this.needed.clear();

    const missing = [...wanted].filter((b) => !this.times.has(b));
    if (this.batching && missing.length > 1) {
      try {
        await this.fetchBatched(missing);
      } catch (error) {
        // A refused batch is a fact about the endpoint, not about the blocks.
        this.batching = false;
        this.log(
          `  endpoint refused a JSON-RPC batch (${(error as Error).message.split('\n')[0]}) — ` +
            'reading block times one call each from here on',
        );
      }
    }
    const still = missing.filter((b) => !this.times.has(b));
    await this.fetchPlain(still);

    const result = new Map<bigint, Date>();
    for (const block of wanted) {
      const time = this.times.get(block);
      if (time) result.set(block, time);
    }
    // Keep the cache from growing without bound over a long run.
    if (this.times.size > 50_000) {
      const keep = [...this.times.keys()].sort((a, b) => (a > b ? -1 : 1)).slice(0, 10_000);
      const kept = new Map(keep.map((k) => [k, this.times.get(k)!]));
      this.times.clear();
      for (const [k, v] of kept) this.times.set(k, v);
    }
    return result;
  }

  /** One HTTP request per RPC_BATCH_SIZE blocks. */
  private async fetchBatched(blocks: bigint[]): Promise<void> {
    for (let i = 0; i < blocks.length; i += RPC_BATCH_SIZE) {
      const group = blocks.slice(i, i + RPC_BATCH_SIZE);
      const found = await rpcBatched(
        (c) => Promise.all(group.map((number) => c.getBlock({ blockNumber: number }))),
        `getBlock×${group.length}`,
      );
      for (const block of found) this.times.set(block.number, new Date(Number(block.timestamp) * 1000));
    }
  }

  /** Sequential in small groups: a rate-limited endpoint refuses a 2000-way burst, and a refused timestamp is a dropped event. */
  private async fetchPlain(blocks: bigint[]): Promise<void> {
    const GROUP = 16;
    for (let i = 0; i < blocks.length; i += GROUP) {
      const group = blocks.slice(i, i + GROUP);
      const found = await Promise.all(
        group.map((number) => rpc((c) => c.getBlock({ blockNumber: number }), `getBlock(${number})`)),
      );
      for (const block of found) this.times.set(block.number, new Date(Number(block.timestamp) * 1000));
    }
  }
}
