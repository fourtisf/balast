/**
 * Uniswap v4's Swap event carries the trader's deltas, not the pool's.
 *
 * v4-core Pool.sol builds the emitted delta from `amountSpecified -
 * amountSpecifiedRemaining` (the exact input, negative) and `amountCalculated`
 * (the output, positive). v3's Swap is the other way round: the pool's
 * deltas, input positive. The indexer sums swap rows into reserves and reads
 * the positive side as the one the fee was taken in, so it needs one
 * convention in its tables — the pool's — and v4 has to be negated on the
 * way in. Stored as emitted, every v4 pool's reserves fell with its volume
 * and the live board read "liquidity —" on exactly the pools that trade.
 */

import { encodeAbiParameters, encodeEventTopics, parseAbiParameters } from 'viem';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { CONTRACTS } from '../../lib/chain';
import { POOL_MANAGER_ABI } from '../chain/abi';
import { swapInputSide } from '../chain/price';
import { prisma } from '../db';
import { isReachable, resetDatabase } from '../test/db';
import { decodePoolManagerLog } from './events';

const POOL = `0x${'ab'.repeat(32)}` as `0x${string}`;
const SENDER = `0x${'11'.repeat(20)}` as `0x${string}`;

/** A v4 Swap as the PoolManager emits it: the trader paid `amountIn` of token0 and received `amountOut` of token1. */
function traderPaysToken0(amountIn: bigint, amountOut: bigint, fee: number) {
  const topics = encodeEventTopics({
    abi: POOL_MANAGER_ABI,
    eventName: 'Swap',
    args: { id: POOL, sender: SENDER },
  });
  const data = encodeAbiParameters(
    parseAbiParameters(
      'int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee',
    ),
    [-amountIn, amountOut, 2n ** 96n, 10n ** 18n, 0, fee],
  );
  return {
    address: CONTRACTS.poolManager.toLowerCase() as `0x${string}`,
    topics: topics as [`0x${string}`, ...`0x${string}`[]],
    data,
    blockNumber: 100n,
    logIndex: 7,
    transactionHash: `0x${'cd'.repeat(32)}` as `0x${string}`,
  };
}

describe('the v4 Swap event', () => {
  it('is decoded to the pool\'s signs: the input positive, the output negative', () => {
    const event = decodePoolManagerLog(traderPaysToken0(1_000n, 990n, 3000) as never, new Date());
    expect(event?.kind).toBe('swap');
    if (event?.kind !== 'swap') return;
    // The pool RECEIVED 1,000 of token0 and PAID 990 of token1.
    expect(event.amount0).toBe(1_000n);
    expect(event.amount1).toBe(-990n);
    // So the fee was taken in token0, which is what the fee attribution reads.
    expect(swapInputSide(event.amount0, event.amount1)).toBe(0);
    expect(event.feePips).toBe(3000);
  });
});

describe('the repair of rows stored with the trader\'s signs', () => {
  beforeAll(async () => {
    if (!(await isReachable())) {
      throw new Error('These tests need a Postgres at TEST_DATABASE_URL. See README.');
    }
    await resetDatabase();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('flips v4 rows, leaves v3 rows, and recomputes the fee from the true input', async () => {
    const now = new Date('2026-01-01T00:00:00Z');
    const token = async (address: string, symbol: string) =>
      prisma.token.create({ data: { address, symbol, name: symbol, decimals: 18, firstSeen: now } });
    await token('0x00000000000000000000000000000000000000a0', 'A');
    await token('0x00000000000000000000000000000000000000b0', 'B');
    const pool = async (id: string, feeTier: number) =>
      prisma.pool.create({
        data: {
          id,
          address: id,
          chainId: 4663,
          token0: '0x00000000000000000000000000000000000000a0',
          token1: '0x00000000000000000000000000000000000000b0',
          feeTier,
          tickSpacing: 60,
          protocol: id.startsWith('v4:') ? 'v4' : 'v3',
          createdBlock: 1n,
          createdAt: now,
        },
      });
    await pool('v4:static', 3000);
    await pool('v4:dynamic', 8388608);
    await pool('v3:0xpool', 3000);
    const swap = async (txHash: string, poolId: string, amount0: bigint, amount1: bigint, feeAmount: bigint, feeToken: number) =>
      prisma.swapEvent.create({
        data: {
          txHash,
          logIndex: 0,
          poolId,
          blockNum: 10n,
          blockTime: now,
          amount0: amount0.toString(),
          amount1: amount1.toString(),
          sqrtPrice: (2n ** 96n).toString(),
          liquidity: '1',
          tick: 0,
          feeAmount: feeAmount.toString(),
          feeToken,
          sender: '0x0000000000000000000000000000000000000001',
        },
      });
    // As the old decoder stored them: the trader paid 1,000,000 of token0 and
    // received 990,000 of token1; the fee was read off the positive (output)
    // side, 990,000 × 0.3%.
    await swap('0x01', 'v4:static', -1_000_000n, 990_000n, 2_970n, 1);
    // A dynamic-fee pool that charged 1% on that swap: the row does not keep
    // the per-swap fee, so the repair scales the recorded one.
    await swap('0x02', 'v4:dynamic', -1_000_000n, 990_000n, 9_900n, 1);
    // A v3 row, already the pool's signs: untouched.
    await swap('0x03', 'v3:0xpool', 1_000_000n, -990_000n, 3_000n, 0);
    await prisma.indexerState.create({ data: { key: 'rebuilt_anchor', value: '0xanchor', updatedAt: now } });

    // The migration itself, statement by statement, so what is tested is the
    // repair a deploy actually runs.
    const sql = readFileSync('prisma/migrations/20260915110000_p1_v4_swap_sign/migration.sql', 'utf8')
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n');
    for (const statement of sql.split(';').map((s) => s.trim()).filter(Boolean)) {
      await prisma.$executeRawUnsafe(statement);
    }

    const rows = await prisma.$queryRaw<{ tx_hash: string; a0: string; a1: string; fee: string; side: number }[]>`
      SELECT tx_hash, amount0::text AS a0, amount1::text AS a1, fee_amount::text AS fee, fee_token AS side
      FROM swap_events ORDER BY tx_hash
    `;
    expect(rows).toEqual([
      // Static: the pool's signs, the fee on the input side, exactly 1,000,000 × 0.3%.
      { tx_hash: '0x01', a0: '1000000', a1: '-990000', fee: '3000', side: 0 },
      // Dynamic: scaled from the recorded 9,900 by input/output — 10,000 within a wei.
      { tx_hash: '0x02', a0: '1000000', a1: '-990000', fee: '10000', side: 0 },
      { tx_hash: '0x03', a0: '1000000', a1: '-990000', fee: '3000', side: 0 },
    ]);
    // And the priced tables are marked for a full rebuild from the corrected rows.
    expect(await prisma.indexerState.findUnique({ where: { key: 'rebuilt_anchor' } })).toBeNull();
  });
});
