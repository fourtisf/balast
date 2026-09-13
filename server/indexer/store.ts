/**
 * Writing an ingest plan to Postgres.
 *
 * Every write is an upsert keyed by `(tx_hash, log_index)`, which is what
 * lets §4.1's "re-scan the last 32 blocks each pass" cost nothing and change
 * nothing. There is no INSERT here that could fail on a second pass, and no
 * UPDATE that adds to an existing value.
 */

import { Prisma } from '@prisma/client';
import { prisma } from '../db';
import type { IngestPlan } from './ingest';

/** Chunked so a large first sync does not build a single enormous statement. */
const CHUNK = 500;

function chunk<T>(items: T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** bigint to a Prisma Decimal, exactly — never through a float. */
function dec(value: bigint): Prisma.Decimal {
  return new Prisma.Decimal(value.toString());
}

export async function writePools(plan: IngestPlan): Promise<void> {
  for (const pool of plan.pools) {
    await prisma.pool.upsert({
      where: { id: pool.id },
      create: {
        id: pool.id,
        address: pool.address,
        chainId: pool.chainId,
        token0: pool.token0,
        token1: pool.token1,
        feeTier: pool.feeTier,
        tickSpacing: pool.tickSpacing,
        hooks: pool.hooks,
        protocol: pool.protocol,
        createdBlock: pool.createdBlock,
        createdAt: pool.createdAt,
      },
      // A pool's immutable facts cannot change, so a replay rewrites the same
      // values. `stakeable` is deliberately not touched: it is set by
      // discovery from the pool's hook, and a re-scan must not reset it.
      update: {
        feeTier: pool.feeTier,
        tickSpacing: pool.tickSpacing,
        hooks: pool.hooks,
        createdBlock: pool.createdBlock,
        createdAt: pool.createdAt,
      },
    });
  }
}

export async function writeSwaps(plan: IngestPlan): Promise<number> {
  let written = 0;
  for (const batch of chunk(plan.swaps)) {
    const rows = batch.map((s) => ({
      txHash: s.txHash,
      logIndex: s.logIndex,
      poolId: s.poolId,
      blockNum: s.blockNum,
      blockTime: s.blockTime,
      amount0: dec(s.amount0),
      amount1: dec(s.amount1),
      sqrtPrice: dec(s.sqrtPrice),
      liquidity: dec(s.liquidity),
      tick: s.tick,
      feeAmount: dec(s.feeAmount),
      feeToken: s.feeToken,
      sender: s.sender,
    }));
    // createMany + skipDuplicates is the right shape here: the primary key is
    // the log's own coordinates, so a duplicate is by definition the identical
    // row. Skipping it is not lossy, and it keeps the re-scan cheap.
    const result = await prisma.swapEvent.createMany({ data: rows, skipDuplicates: true });
    written += result.count;
  }
  return written;
}

export async function writeLiquidity(plan: IngestPlan): Promise<number> {
  let written = 0;
  for (const batch of chunk(plan.liquidity)) {
    const rows = batch.map((l) => ({
      txHash: l.txHash,
      logIndex: l.logIndex,
      poolId: l.poolId,
      blockNum: l.blockNum,
      blockTime: l.blockTime,
      tickLower: l.tickLower,
      tickUpper: l.tickUpper,
      liquidityDelta: dec(l.liquidityDelta),
      amount0: dec(l.amount0),
      amount1: dec(l.amount1),
      owner: l.owner,
    }));
    const result = await prisma.liquidityEvent.createMany({ data: rows, skipDuplicates: true });
    written += result.count;
  }
  return written;
}

/** Where the poller resumes from, per contract. */
export async function readCursor(contract: string): Promise<bigint | null> {
  const row = await prisma.indexerCursor.findUnique({ where: { contract } });
  return row?.lastIndexedBlock ?? null;
}

export async function writeCursor(
  contract: string,
  block: bigint,
  blockTime: Date,
): Promise<void> {
  await prisma.indexerCursor.upsert({
    where: { contract },
    create: {
      contract,
      lastIndexedBlock: block,
      lastIndexedAt: blockTime,
      updatedAt: new Date(),
    },
    update: { lastIndexedBlock: block, lastIndexedAt: blockTime, updatedAt: new Date() },
  });
}

/**
 * The sqrtPrice each pool was last seen at, at or before a given block.
 *
 * Loaded from the database rather than carried in memory, so a restart
 * mid-chain resumes with exactly the state a full replay would have reached —
 * which is half of why §9's two runs agree. The other half is that the query
 * is ordered by the same `(block, logIndex)` total order the ingest uses.
 */
export async function loadPriceState(
  beforeBlock: bigint,
): Promise<Map<string, bigint>> {
  const rows = await prisma.$queryRaw<{ pool_id: string; sqrt_price_x96: string }[]>`
    SELECT DISTINCT ON (pool_id) pool_id, sqrt_price_x96::text
    FROM swap_events
    WHERE block_num < ${beforeBlock}
    ORDER BY pool_id, block_num DESC, log_index DESC
  `;
  const map = new Map<string, bigint>();
  for (const row of rows) map.set(row.pool_id, BigInt(row.sqrt_price_x96));

  // A pool that has never traded still has the price its Initialize set, and
  // a ModifyLiquidity before the first swap has to be valued at it.
  const created = await prisma.$queryRaw<{ id: string; sqrt_price_x96: string }[]>`
    SELECT p.id, ps.sqrt_price_x96::text
    FROM pools p
    JOIN pool_state ps ON ps.pool_id = p.id
    WHERE ps.sqrt_price_x96 > 0
  `;
  for (const row of created) {
    if (!map.has(row.id)) map.set(row.id, BigInt(row.sqrt_price_x96));
  }
  return map;
}

/** Fee tier per pool, for v3 swaps whose event carries no fee (§4). */
export async function loadFeeTiers(): Promise<Map<string, number>> {
  const rows = await prisma.pool.findMany({ select: { id: true, feeTier: true } });
  return new Map(rows.map((r) => [r.id, r.feeTier]));
}

/** Pool ids already known, so a batch can skip events for unknown pools. */
export async function loadKnownPools(): Promise<Set<string>> {
  const rows = await prisma.pool.findMany({ select: { id: true } });
  return new Set(rows.map((r) => r.id));
}

/**
 * Addresses of the v3 pools we already know about.
 *
 * v3 emits from each pool's own contract, so the poller has to name every one
 * of them in its log filter. Loading them from the database on startup is
 * what stops a restart quietly ceasing to index pools it discovered earlier.
 */
export async function loadV3PoolAddresses(): Promise<string[]> {
  const rows = await prisma.pool.findMany({
    where: { protocol: 'v3' },
    select: { address: true },
  });
  return rows.map((r) => r.address.toLowerCase());
}
