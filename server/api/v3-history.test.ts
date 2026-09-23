import { encodeAbiParameters, encodeEventTopics, type Hex, type PublicClient } from 'viem';
import { describe, expect, it } from 'vitest';
import { CONTRACTS } from '../../lib/chain';
import { V3_MANAGER_EVENTS, explorerHistoryTxs, historyFromReceipts } from './v3-history';

const MANAGER = CONTRACTS.v3PositionManager.toLowerCase() as Hex;
const ID = 1_284_575n;
const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as Hex;

function log(event: 'IncreaseLiquidity' | 'DecreaseLiquidity' | 'Collect', values: bigint[], tokenId = ID, address: Hex = MANAGER) {
  const topics = encodeEventTopics({ abi: V3_MANAGER_EVENTS, eventName: event, args: { tokenId } }) as Hex[];
  const data =
    event === 'Collect'
      ? encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }], ['0x000000000000000000000000000000000000dEaD', values[0], values[1]])
      : encodeAbiParameters([{ type: 'uint128' }, { type: 'uint256' }, { type: 'uint256' }], [values[0], values[1], values[2]]);
  return { address, topics, data, logIndex: 0 };
}

function fakeClient(receipts: Record<string, { block: bigint; logs: ReturnType<typeof log>[] }>): PublicClient {
  return {
    getTransactionReceipt: async ({ hash: h }: { hash: Hex }) => ({ status: 'success', blockNumber: receipts[h].block, logs: receipts[h].logs }),
    getBlock: async ({ blockNumber }: { blockNumber: bigint }) => ({ timestamp: 1_790_000_000n + blockNumber }),
  } as unknown as PublicClient;
}

describe('a v3 position’s history, from its own logs', () => {
  const receipts = {
    [hash(1)]: { block: 10n, logs: [log('IncreaseLiquidity', [1000n, 500n, 7n])] },
    [hash(2)]: { block: 20n, logs: [log('IncreaseLiquidity', [500n, 250n, 3n]), log('IncreaseLiquidity', [999n, 1n, 1n], 42n)] },
    // A partial withdrawal: principal released, then collected along with 11 and 2 of fees.
    [hash(3)]: { block: 30n, logs: [log('DecreaseLiquidity', [300n, 150n, 2n]), log('Collect', [161n, 4n])] },
  };

  it('is principal in less principal out, and fees collected less principal released', async () => {
    const h = await historyFromReceipts(fakeClient(receipts), ID, [hash(1), hash(2), hash(3)], 1200n);
    expect(h).toEqual({
      deposited0: 600n,
      deposited1: 8n,
      collectedFees0: 11n,
      collectedFees1: 2n,
      liquidity: 1200n,
      mintedAt: new Date((1_790_000_000 + 10) * 1000),
    });
  });

  it('is not used when it does not add up to the liquidity the chain holds', async () => {
    // The explorer left out the second increase: 700 ≠ 1200.
    expect(await historyFromReceipts(fakeClient(receipts), ID, [hash(1), hash(3)], 1200n)).toBeNull();
  });

  it('asks the explorer where the logs are, for each event, and takes only transaction hashes', async () => {
    const asked: string[] = [];
    const txs = await explorerHistoryTxs(ID, {
      base: 'https://explorer.test/',
      fetch: async (url) => {
        asked.push(String(url));
        return new Response(JSON.stringify({ status: '1', result: [{ transactionHash: hash(1).toUpperCase().replace('0X', '0x') }, { transactionHash: 'junk' }] }));
      },
    });
    expect(asked).toHaveLength(3);
    expect(asked[0]).toContain('module=logs');
    expect(asked[0]).toContain(`topic1=0x${ID.toString(16).padStart(64, '0')}`);
    expect(txs).toEqual([hash(1)]);
  });
});
