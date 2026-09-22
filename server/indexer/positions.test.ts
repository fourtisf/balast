/**
 * Positions minted through Uniswap's PositionManager (§22).
 *
 * The token IS the position: its Transfer says who holds it, and the
 * PoolManager's ModifyLiquidity with `sender = PositionManager` and
 * `salt = bytes32(tokenId)` says which pool, which range and how much. Both
 * are raw rows, and `positions` is rebuilt from them — so a mint, a move, a
 * partial withdrawal and a burn are asserted against what the table says,
 * and the incremental replay has to agree with the block-zero one (§9).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONTRACTS } from '../../lib/chain';
import { prisma } from '../db';
import { isReachable, resetDatabase } from '../test/db';
import {
  FIXTURE_POOLS,
  FixtureLogSource,
  POSITION_MANAGER,
  USDG,
  buildFixtureChain,
  fixtureTokenReader,
  modifyLiquidityLog,
  positionMintLogs,
  positionTransferLog,
  withLogs,
  type FixtureChain,
} from '../test/fixture';
import { rebuildPositions } from './aggregate';
import { saltForTokenId } from './events';
import { Poller } from './poller';
import { POSITION_HISTORY_KEY } from './position-history';

const ALICE = '0x000000000000000000000000000000000000a11c' as const;
const BOB = '0x0000000000000000000000000000000000000b0b' as const;
const ZERO = '0x0000000000000000000000000000000000000000' as const;
const TOKEN = 41n;
const NVDA = FIXTURE_POOLS[1]; // NVDA/WETH, tick spacing 60
const LIQUIDITY = 5n * 10n ** 20n;

function chainWithPosition(): FixtureChain {
  const base = buildFixtureChain(2_500);
  const lower = NVDA.tick - 10 * NVDA.tickSpacing;
  const upper = NVDA.tick + 10 * NVDA.tickSpacing;
  const salt = saltForTokenId(TOKEN) as `0x${string}`;
  return withLogs(base, [
    // Minted to Alice at block 600.
    ...positionMintLogs({ pool: NVDA, owner: ALICE, tokenId: TOKEN, tickLower: lower, tickUpper: upper, liquidity: LIQUIDITY, block: 600, logIndex: 500 }),
    // Alice sends it to Bob at block 900.
    positionTransferLog({ from: ALICE, to: BOB, tokenId: TOKEN, block: 900, logIndex: 500 }),
    // Bob takes half out at block 1200.
    modifyLiquidityLog({ poolId: NVDA.id, sender: POSITION_MANAGER, tickLower: lower, tickUpper: upper, liquidityDelta: -LIQUIDITY / 2n, block: 1_200, logIndex: 500, salt }),
    // And burns it at block 2000: the rest out, then the token to the zero address.
    modifyLiquidityLog({ poolId: NVDA.id, sender: POSITION_MANAGER, tickLower: lower, tickUpper: upper, liquidityDelta: -LIQUIDITY / 2n, block: 2_000, logIndex: 500, salt }),
    positionTransferLog({ from: BOB, to: ZERO, tokenId: TOKEN, block: 2_000, logIndex: 501 }),
  ]);
}

function poller(source: FixtureLogSource, blockRange: number): Poller {
  return new Poller({ source, usdgAddress: USDG, startBlock: 0n, blockRange, tokenReader: fixtureTokenReader });
}

async function positionRow() {
  return prisma.$queryRaw<
    { token_id: string; wallet: string; pool_id: string; tick_lower: number; tick_upper: number; liquidity: string; status: string; deposited0: string; deposited1: string; minted_block: bigint | null }[]
  >`
    SELECT token_id, wallet, pool_id, tick_lower, tick_upper, liquidity::text, status, deposited0::text, deposited1::text, minted_block
    FROM positions ORDER BY token_id
  `;
}

beforeAll(async () => {
  if (!(await isReachable())) throw new Error('These tests need a Postgres at TEST_DATABASE_URL. See README.');
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('a PositionManager position, from its logs', () => {
  const chain = chainWithPosition();

  it('is minted, moved, halved and burned — and the table says so at each step', async () => {
    await resetDatabase();
    const source = new FixtureLogSource(chain, 0);
    const p = poller(source, 500);

    source.setHead(700);
    await p.syncToHead();
    let [row] = await positionRow();
    expect(row).toBeDefined();
    expect(row.token_id).toBe(TOKEN.toString());
    expect(row.wallet).toBe(ALICE);
    expect(row.pool_id).toBe(`v4:${NVDA.id}`);
    expect(row.tick_lower).toBe(NVDA.tick - 10 * NVDA.tickSpacing);
    expect(row.tick_upper).toBe(NVDA.tick + 10 * NVDA.tickSpacing);
    expect(row.liquidity).toBe(LIQUIDITY.toString());
    expect(row.status).toBe('open');
    expect(row.minted_block).toBe(600n);
    // Both sides went in: the range straddles the price.
    expect(BigInt(row.deposited0) > 0n && BigInt(row.deposited1) > 0n).toBe(true);
    const deposited0 = BigInt(row.deposited0);

    source.setHead(1_000);
    await p.syncToHead();
    [row] = await positionRow();
    expect(row.wallet).toBe(BOB);
    expect(row.liquidity).toBe(LIQUIDITY.toString());

    source.setHead(1_500);
    await p.syncToHead();
    [row] = await positionRow();
    expect(row.liquidity).toBe((LIQUIDITY / 2n).toString());
    // Half the principal came back out, so the hold basis halved with it.
    expect(BigInt(row.deposited0) < deposited0).toBe(true);
    expect(BigInt(row.deposited0) > 0n).toBe(true);

    // What the portfolio endpoint makes of it, for Bob and for a stranger.
    const { buildPortfolio } = await import('../api/portfolio');
    const bob = await buildPortfolio(BOB, USDG);
    expect(bob).not.toBeNull();
    expect(bob!.positions).toHaveLength(1);
    const [held] = bob!.positions;
    expect(held.tokenId).toBe(TOKEN.toString());
    expect(held.poolId).toBe(`v4:${NVDA.id}`);
    expect(held.valueUsd).toBeGreaterThan(0);
    expect(Number.isFinite(held.priceImpactUsd)).toBe(true);
    expect(held.live!.liquidity).toBe((LIQUIDITY / 2n).toString());
    expect(held.live!.token.symbol).toBe('NVDA');
    expect(held.live!.quote).toBe('ETH');
    expect(held.live!.tokenIsCurrency0).toBe(true);
    expect(held.live!.holdUsd).toBeGreaterThan(0);
    expect(held.range).not.toBe('full');
    if (held.range !== 'full') expect(held.range!.minPct).toBeLessThan(held.range!.maxPct);
    if (!held.inRange) expect(held.outOfRangeSinceHours).toBeGreaterThanOrEqual(0);
    expect(bob!.netValueUsd).toBeCloseTo(held.valueUsd, 6);
    expect((await buildPortfolio(ALICE, USDG))!.positions).toHaveLength(0);

    // And the route: 400 for nonsense, 200 with the same answer for Bob.
    process.env.LOG_LEVEL = 'silent';
    const { buildServer } = await import('../api/server');
    const app = await buildServer();
    await app.ready();
    try {
      expect((await app.inject({ method: 'GET', url: '/api/portfolio/not-an-address' })).statusCode).toBe(400);
      const response = await app.inject({ method: 'GET', url: `/api/portfolio/${BOB.toUpperCase().replace('0X', '0x')}` });
      expect(response.statusCode).toBe(200);
      expect(response.json().positions).toHaveLength(1);
      expect(response.json().wallet).toBe(BOB);
    } finally {
      await app.close();
    }

    source.setHead(chain.headBlock);
    await p.syncToHead();
    [row] = await positionRow();
    expect(row.status).toBe('burned');
    expect(row.wallet).toBe(ZERO);
    expect(row.liquidity).toBe('0');
  });

  it('counts only open positions in the snapshot, and none once burned', async () => {
    const { buildSnapshot } = await import('../api/snapshot');
    const snapshot = await buildSnapshot({ usdgAddress: USDG });
    expect(snapshot!.global.totalPositions).toBe(0);
  });

  it('replays identically from block zero and incrementally (§9)', async () => {
    const incremental = await positionRow();
    await resetDatabase();
    await poller(new FixtureLogSource(chain), chain.headBlock + 1).syncToHead();
    expect(await positionRow()).toEqual(incremental);
  });

  it('asks for the transfers at the PositionManager address and nowhere else', async () => {
    const source = new FixtureLogSource(chain);
    await resetDatabase();
    await poller(source, chain.headBlock + 1).syncToHead();
    const addressed = source.calls.filter((c) => c.address !== undefined);
    expect(addressed.length).toBeGreaterThan(0);
    for (const call of addressed) expect(call.address).toBe(CONTRACTS.positionManager.toLowerCase());
    expect(await prisma.positionTransfer.count()).toBe(3);
    expect(await prisma.liquidityEvent.count({ where: { salt: saltForTokenId(TOKEN) } })).toBe(3);
  });

  it('reads the positions minted before PositionManager was followed, on the first pass after a deploy', async () => {
    // A box that indexed this chain before the poller knew PositionManager:
    // the cursor is at head, the liquidity rows are there without a salt,
    // and there is no transfer row at all. Exactly what a deploy of this
    // code finds, and a rebuild alone can make nothing of it.
    await resetDatabase();
    await poller(new FixtureLogSource(chain), chain.headBlock + 1).syncToHead();
    const expected = await positionRow();
    expect(expected).toHaveLength(1);
    await prisma.$executeRawUnsafe('DELETE FROM position_transfers');
    await prisma.$executeRawUnsafe('UPDATE liquidity_events SET salt = NULL');
    await prisma.$executeRawUnsafe('DELETE FROM positions');
    await prisma.indexerState.deleteMany({ where: { key: POSITION_HISTORY_KEY } });
    await rebuildPositions();
    expect(await positionRow()).toHaveLength(0);

    // The first pass of a new process walks the history and restores both.
    const source = new FixtureLogSource(chain);
    await poller(source, chain.headBlock + 1).syncToHead();
    expect(await positionRow()).toEqual(expected);
    expect(await prisma.positionTransfer.count()).toBe(3);
    expect(await prisma.liquidityEvent.count({ where: { salt: saltForTokenId(TOKEN) } })).toBe(3);
    const one = (a: string | string[] | undefined) => (Array.isArray(a) ? a[0] : a);
    const walked = source.calls.filter((c) => c.address !== undefined && c.from === 0n);
    expect(walked.map((c) => one(c.address)).sort()).toEqual(
      [CONTRACTS.poolManager.toLowerCase(), CONTRACTS.positionManager.toLowerCase()].sort(),
    );
    const state = await prisma.indexerState.findUnique({ where: { key: POSITION_HISTORY_KEY } });
    expect(state?.value).toBe(String(chain.headBlock));

    // And the next process does not walk it again.
    const again = new FixtureLogSource(chain);
    await poller(again, chain.headBlock + 1).syncToHead();
    expect(again.calls.filter((c) => one(c.address) === CONTRACTS.poolManager.toLowerCase())).toHaveLength(0);
    expect(await positionRow()).toEqual(expected);
  });
});

describe('the aggregate corrections (§22)', () => {
  const chain = buildFixtureChain(2_500);

  it('values liquidity as principal: the flow less every fee the pool earned', async () => {
    await resetDatabase();
    await poller(new FixtureLogSource(chain), chain.headBlock + 1).syncToHead();
    const rows = await prisma.$queryRaw<{ pool_id: string; tvl: number; expected: number }[]>`
      WITH flow AS (SELECT pool_id, SUM(delta0) AS r0, SUM(delta1) AS r1 FROM pool_flow_hourly GROUP BY pool_id),
      fees AS (SELECT pool_id, SUM(fees_token0) AS f0, SUM(fees_token1) AS f1 FROM pool_fee_hourly GROUP BY pool_id),
      weth AS (SELECT weth_usd FROM weth_usd_hourly ORDER BY hour DESC LIMIT 1)
      SELECT ps.pool_id, ps.tvl_usd::float8 AS tvl,
        (
          (flow.r0 - COALESCE(fees.f0, 0)) / power(10::numeric, t0.decimals)
            * CASE WHEN lower(p.token0) = ${USDG.toLowerCase()} THEN 1 ELSE ps.price_usd END
          + (flow.r1 - COALESCE(fees.f1, 0)) / power(10::numeric, t1.decimals) * (SELECT weth_usd FROM weth)
        )::float8 AS expected
      FROM pool_state ps
      JOIN pools p ON p.id = ps.pool_id
      JOIN tokens t0 ON lower(t0.address) = lower(p.token0)
      JOIN tokens t1 ON lower(t1.address) = lower(p.token1)
      JOIN flow ON flow.pool_id = ps.pool_id
      LEFT JOIN fees ON fees.pool_id = ps.pool_id
      WHERE ps.tvl_usd > 0
    `;
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      // The anchor pool's own token0 is USDG at $1; every other pool's
      // token0 is the traded side at pool_state's price. Either way the
      // TVL is the principal, not the principal plus the fees on it.
      expect(row.tvl, row.pool_id).toBeCloseTo(row.expected, 2);
    }
    const [fees] = await prisma.$queryRaw<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM pool_fee_hourly WHERE fees_token0 > 0 OR fees_token1 > 0`;
    expect(fees.n).toBeGreaterThan(0);
  });

  it('prices the anchor hour by the volume-weighted mean of its swaps, not by the last one', async () => {
    const [anchor] = await prisma.$queryRaw<{ id: string }[]>`
      SELECT p.id FROM pools p WHERE lower(p.token0) = ${USDG.toLowerCase()} LIMIT 1
    `;
    const hours = await prisma.$queryRaw<{ hour: Date; weth_usd: string; swaps: number }[]>`
      SELECT w.hour, w.weth_usd::text, COUNT(sw.*)::int AS swaps
      FROM weth_usd_hourly w
      JOIN swap_events sw ON date_trunc('hour', sw.block_time) = w.hour AND sw.pool_id = ${anchor.id}
      GROUP BY w.hour, w.weth_usd
      HAVING COUNT(sw.*) > 1
      ORDER BY w.hour
      LIMIT 20
    `;
    expect(hours.length).toBeGreaterThan(0);
    for (const hour of hours) {
      const swaps = await prisma.$queryRaw<{ sqrt: string; amount0: string; block_num: bigint; log_index: number }[]>`
        SELECT sqrt_price_x96::text AS sqrt, amount0::text, block_num, log_index FROM swap_events
        WHERE pool_id = ${anchor.id} AND date_trunc('hour', block_time) = ${hour.hour}
        ORDER BY block_num, log_index
      `;
      // USDG is token0 (6 dp), WETH token1 (18 dp): ratio is WETH per USDG, so
      // the dollar price of ether is its inverse, scaled by the decimals.
      const priceOf = (sqrt: string) => {
        const s = Number(sqrt) / 2 ** 96;
        return 1 / (s * s * 1e-12);
      };
      const weighted = swaps.reduce((acc, s) => acc + priceOf(s.sqrt) * Math.abs(Number(s.amount0)), 0);
      const weight = swaps.reduce((acc, s) => acc + Math.abs(Number(s.amount0)), 0);
      const vwap = weighted / weight;
      const last = priceOf(swaps[swaps.length - 1].sqrt);
      expect(Number(hour.weth_usd) / vwap).toBeCloseTo(1, 4);
      // And not simply the last swap, unless the hour happened to be flat.
      if (Math.abs(last / vwap - 1) > 1e-4) expect(Number(hour.weth_usd) / last).not.toBeCloseTo(1, 4);
    }
  });
});
