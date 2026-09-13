/**
 * The production `LogSource`: viem over the failover client.
 *
 * Block timestamps are the fiddly part. Every event needs chain time, not the
 * time we happened to read it — §7's whole point is that a stale number must
 * never look live — and Robinhood Chain's ~100ms blocks (§2) mean a 2000-block
 * range is 2000 timestamps and about three minutes of chain. Fetching each
 * block individually would be 2000 round trips a pass, so timestamps are
 * fetched only for the blocks that actually carry a log, cached, and reused.
 */

import { rpc } from '../chain/client';
import type { LogSource } from './poller';

export class ViemLogSource implements LogSource {
  /** Block number to timestamp. Blocks are immutable, so this never expires. */
  private readonly times = new Map<bigint, Date>();
  private readonly needed = new Set<bigint>();

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
        c.getLogs({
          address: addresses.length === 1 ? addresses[0] : addresses,
          fromBlock: args.fromBlock,
          toBlock: args.toBlock,
        }),
      `getLogs(${args.fromBlock}-${args.toBlock})`,
    );

    const out = [];
    for (const log of logs) {
      if (log.blockNumber === null || log.logIndex === null || log.transactionHash === null) {
        // A pending log has no position, so it has no primary key. Skip it;
        // the next pass sees it mined.
        continue;
      }
      // Remember which blocks we will need a timestamp for.
      this.needed.add(log.blockNumber);
      out.push({
        address: log.address,
        topics: log.topics as string[],
        data: log.data,
        blockNumber: log.blockNumber,
        logIndex: log.logIndex,
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
    // Sequential in small groups: a public endpoint that rate-limits will
    // refuse a 2000-way burst, and a refused timestamp means a dropped event.
    const GROUP = 16;
    for (let i = 0; i < missing.length; i += GROUP) {
      const group = missing.slice(i, i + GROUP);
      const blocks = await Promise.all(
        group.map((number) =>
          rpc((c) => c.getBlock({ blockNumber: number }), `getBlock(${number})`),
        ),
      );
      for (const block of blocks) {
        this.times.set(block.number, new Date(Number(block.timestamp) * 1000));
      }
    }

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
}
