/**
 * The log source's two shortcuts, against a fake node.
 *
 * On a busy chain the timestamps were the pass: one `getBlock` per block that
 * carried a log, sixteen at a time. A node that stamps `blockTimestamp` on
 * its logs makes that zero calls; one that accepts JSON-RPC batches makes it
 * one request per fifty blocks; one that refuses batches is found out once
 * and never asked again.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls = { getLogs: 0, getBlock: 0, batched: 0, plain: 0 };
let refuseBatches = false;
let stampLogs = false;

vi.mock('../chain/client', () => {
  const client = {
    request: async ({ params }: { method: string; params: [{ fromBlock: string; toBlock: string }] }) => {
      calls.getLogs++;
      const from = Number(BigInt(params[0].fromBlock));
      const to = Number(BigInt(params[0].toBlock));
      const logs = [];
      for (let b = from; b <= to; b++) {
        logs.push({
          address: '0xpool',
          topics: ['0xt'],
          data: '0x',
          blockNumber: `0x${b.toString(16)}`,
          logIndex: '0x0',
          transactionHash: `0x${b.toString(16).padStart(64, '0')}`,
          ...(stampLogs ? { blockTimestamp: `0x${(1_700_000_000 + b).toString(16)}` } : {}),
        });
      }
      return logs;
    },
    getBlock: async ({ blockNumber, blockTag }: { blockNumber?: bigint; blockTag?: string }) => {
      calls.getBlock++;
      const n = blockTag === 'latest' ? 999n : blockNumber!;
      return { number: n, timestamp: BigInt(1_700_000_000 + Number(n)) };
    },
  };
  return {
    RPC_BATCH_SIZE: 50,
    rpc: async (fn: (c: typeof client) => Promise<unknown>) => {
      calls.plain++;
      return fn(client);
    },
    rpcBatched: async (fn: (c: typeof client) => Promise<unknown>) => {
      calls.batched++;
      if (refuseBatches) throw new Error('batch requests are not supported');
      return fn(client);
    },
  };
});

import { ViemLogSource } from './viem-source';

beforeEach(() => {
  calls.getLogs = 0;
  calls.getBlock = 0;
  calls.batched = 0;
  calls.plain = 0;
  refuseBatches = false;
  stampLogs = false;
});

describe('ViemLogSource', () => {
  it('takes the timestamp off the log when the node stamps one, and asks for no blocks', async () => {
    stampLogs = true;
    const source = new ViemLogSource();
    const logs = await source.getLogs({ address: '0xpool', fromBlock: 100n, toBlock: 120n });
    expect(logs).toHaveLength(21);
    expect(logs[0].blockNumber).toBe(100n);
    expect(logs[0].logIndex).toBe(0);
    const times = await source.getBlockTimes(100n, 120n);
    expect(times.get(100n)?.getTime()).toBe((1_700_000_000 + 100) * 1000);
    expect(times.get(120n)).toBeDefined();
    expect(calls.getBlock).toBe(0);
    expect(source.timestampsFromLogs).toBe(21);
  });

  it('fetches what is missing fifty blocks to a batch', async () => {
    const source = new ViemLogSource();
    await source.getLogs({ address: '0xpool', fromBlock: 1n, toBlock: 120n });
    const times = await source.getBlockTimes(1n, 120n);
    expect(times.size).toBe(120);
    expect(calls.getBlock).toBe(120);
    // 120 blocks: three batches, no plain calls for timestamps.
    expect(calls.batched).toBe(3);
    expect(calls.plain).toBe(1); // the getLogs itself
  });

  it('drops to one call each when the endpoint refuses a batch, and stays there', async () => {
    refuseBatches = true;
    const notes: string[] = [];
    const source = new ViemLogSource((m) => notes.push(m));
    await source.getLogs({ address: '0xpool', fromBlock: 1n, toBlock: 40n });
    const times = await source.getBlockTimes(1n, 40n);
    expect(times.size).toBe(40);
    expect(calls.batched).toBe(1);
    expect(notes.join(' ')).toMatch(/refused a JSON-RPC batch/);
    // Second range: no batch attempted at all.
    await source.getLogs({ address: '0xpool', fromBlock: 41n, toBlock: 60n });
    await source.getBlockTimes(41n, 60n);
    expect(calls.batched).toBe(1);
    expect(notes).toHaveLength(1);
  });

  it('skips a pending log, which has no position to key on', async () => {
    const source = new ViemLogSource();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const clientModule = (await import('../chain/client')) as any;
    const original = clientModule.rpc;
    clientModule.rpc = async (fn: (c: unknown) => Promise<unknown>) =>
      fn({
        request: async () => [
          { address: '0xpool', topics: [], data: '0x', blockNumber: null, logIndex: null, transactionHash: null },
          { address: '0xpool', topics: [], data: '0x', blockNumber: '0x5', logIndex: '0x2', transactionHash: '0xabc' },
        ],
      });
    try {
      const logs = await source.getLogs({ address: '0xpool', fromBlock: 1n, toBlock: 10n });
      expect(logs).toHaveLength(1);
      expect(logs[0].logIndex).toBe(2);
    } finally {
      clientModule.rpc = original;
    }
  });
});
