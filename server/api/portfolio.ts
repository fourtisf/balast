/**
 * A wallet's positions, from the tables the indexer rebuilds (§22).
 *
 * `positions` says which PositionManager tokens the wallet holds, in which
 * pool and range and with how much liquidity; `pool_state` says where each
 * pool's price is now. From those two the position's two sides follow by
 * the same tick maths the indexer values a ModifyLiquidity with, and its
 * dollar value through the same one path (§4.3): the traded side at the
 * pool's price, the quote at $1 or at the anchor's ether price.
 *
 * Two things are deliberately not here. Uncollected fees need the pool's
 * fee-growth accumulators, which are state rather than events; the page
 * reads them from StateView. And a position's own history — what it has
 * collected over time — is not tracked, so the portfolio's "fees earned"
 * is null rather than a number that would be wrong (§7).
 *
 * Price impact on holdings IS here, and honestly: the net principal the
 * position was funded with, valued at today's prices, against what the
 * position is worth today. That is what holding would have been worth.
 */

import { CONTRACTS, NATIVE_ETH, isEther } from '../../lib/chain';
import type { LivePosition, Quote, UserPosition } from '../../lib/data/types';
import { maxUsableTick, minUsableTick } from '../../lib/v4/pool';
import { amountsForLiquidity } from '../chain/tick-math';
import { prisma } from '../db';
import { resolveUsdg } from '../indexer/anchor';
import { POOL_MANAGER_CURSOR } from '../indexer/poller';

export interface PortfolioResponse {
  wallet: string;
  /** Chain time of the last block indexed: what "now" means for every figure here. */
  asOf: string;
  positions: UserPosition[];
  netValueUsd: number;
  priceImpactUsd: number;
}

interface Row {
  token_id: string;
  pool_id: string;
  pool_address: string;
  protocol: string;
  fee_tier: number;
  tick_spacing: number;
  hooks: string | null;
  token0: string;
  token1: string;
  tick_lower: number;
  tick_upper: number;
  liquidity: string;
  deposited0: string;
  deposited1: string;
  minted_at: Date | null;
  d0: number;
  d1: number;
  s0: string;
  s1: string;
  n0: string;
  n1: string;
  c0: string | null;
  c1: string | null;
  l0: string | null;
  l1: string | null;
  sqrt: string;
  tick: number;
  price_usd: number;
}

/** Which side is the traded token: the rule in aggregate.ts `tradedSide`, in TypeScript. */
function tokenIsCurrency0(token0: string, token1: string, usdg: string): boolean {
  const a0 = token0.toLowerCase();
  const a1 = token1.toLowerCase();
  if (a1 === usdg) return true;
  if (a0 === usdg) return false;
  if (isEther(a1)) return true;
  if (isEther(a0)) return false;
  return true;
}

function human(raw: bigint, decimals: number): number {
  return Number(raw) / 10 ** decimals;
}

export async function buildPortfolio(wallet: string, usdgAddress?: string | null): Promise<PortfolioResponse | null> {
  const owner = wallet.toLowerCase();
  const cursor = await prisma.indexerCursor.findUnique({ where: { contract: POOL_MANAGER_CURSOR } });
  if (!cursor) return null;
  const anchor = await resolveUsdg(usdgAddress);
  if (!anchor.address) return null;
  const usdg = anchor.address.toLowerCase();

  const [ethRow] = await prisma.$queryRaw<{ price_usd: number }[]>`
    SELECT COALESCE(weth_usd, 0)::float8 AS price_usd FROM weth_usd_hourly ORDER BY hour DESC LIMIT 1
  `;
  const ethUsd = ethRow?.price_usd ?? 0;

  const rows = await prisma.$queryRaw<Row[]>`
    SELECT
      p.token_id, p.pool_id, pl.address AS pool_address, pl.protocol, pl.fee_tier, pl.tick_spacing, pl.hooks,
      pl.token0, pl.token1, p.tick_lower, p.tick_upper,
      p.liquidity::text AS liquidity, p.deposited0::text AS deposited0, p.deposited1::text AS deposited1, p.minted_at,
      t0.decimals AS d0, t1.decimals AS d1, t0.symbol AS s0, t1.symbol AS s1, t0.name AS n0, t1.name AS n1,
      t0.logo_color AS c0, t1.logo_color AS c1, t0.logo_url AS l0, t1.logo_url AS l1,
      COALESCE(ps.sqrt_price_x96, pl.init_sqrt_price_x96, 0)::text AS sqrt,
      COALESCE(ps.tick, pl.init_tick, 0) AS tick,
      COALESCE(ps.price_usd, 0)::float8 AS price_usd
    FROM positions p
    JOIN pools pl ON pl.id = p.pool_id
    JOIN tokens t0 ON lower(t0.address) = lower(pl.token0)
    JOIN tokens t1 ON lower(t1.address) = lower(pl.token1)
    LEFT JOIN pool_state ps ON ps.pool_id = p.pool_id
    WHERE lower(p.wallet) = ${owner} AND p.status = 'open' AND p.liquidity > 0
    ORDER BY p.minted_at ASC NULLS LAST, p.token_id ASC
  `;

  const positions: UserPosition[] = [];
  for (const row of rows) {
    const tokenFirst = tokenIsCurrency0(row.token0, row.token1, usdg);
    const priceOf = (address: string): number => {
      const a = address.toLowerCase();
      if (a === usdg) return 1;
      if (isEther(a)) return ethUsd;
      return row.price_usd;
    };
    const p0 = priceOf(row.token0);
    const p1 = priceOf(row.token1);
    const sqrt = BigInt(row.sqrt);
    const liquidity = BigInt(row.liquidity);
    const priced = sqrt > 0n;
    const amounts = priced
      ? amountsForLiquidity({ sqrtPriceX96: sqrt, tickLower: row.tick_lower, tickUpper: row.tick_upper, liquidityDelta: liquidity })
      : { amount0: 0n, amount1: 0n };
    const valueUsd = priced ? human(amounts.amount0, row.d0) * p0 + human(amounts.amount1, row.d1) * p1 : 0;
    const holdUsd = priced ? human(BigInt(row.deposited0), row.d0) * p0 + human(BigInt(row.deposited1), row.d1) * p1 : 0;
    const inRange = priced && row.tick >= row.tick_lower && row.tick < row.tick_upper;

    // The range as the builder describes it: around the token's price, so a
    // currency1 token's range is the pool's mirrored (lib/v4/mint.ts).
    const full = row.tick_lower <= minUsableTick(row.tick_spacing) && row.tick_upper >= maxUsableTick(row.tick_spacing);
    const pct = (ticks: number) => (1.0001 ** ticks - 1) * 100;
    const range = full
      ? ('full' as const)
      : tokenFirst
        ? { minPct: pct(row.tick_lower - row.tick), maxPct: pct(row.tick_upper - row.tick) }
        : { minPct: pct(row.tick - row.tick_upper), maxPct: pct(row.tick - row.tick_lower) };

    // How long it has been out of range: since the last swap whose tick was
    // inside it, else since the mint.
    let outOfRangeSinceHours: number | undefined;
    if (priced && !inRange) {
      const [last] = await prisma.$queryRaw<{ at: Date | null }[]>`
        SELECT MAX(block_time) AS at FROM swap_events
        WHERE pool_id = ${row.pool_id} AND tick >= ${row.tick_lower} AND tick < ${row.tick_upper}
      `;
      const since = last?.at ?? row.minted_at;
      if (since) outOfRangeSinceHours = Math.max(0, (cursor.lastIndexedAt.getTime() - new Date(since).getTime()) / 3_600_000);
    }

    const tokenAddress = tokenFirst ? row.token0 : row.token1;
    const quoteAddress = tokenFirst ? row.token1 : row.token0;
    const quote: Quote = quoteAddress.toLowerCase() === usdg ? 'USDG' : 'ETH';
    const live: LivePosition = {
      key: {
        currency0: row.token0,
        currency1: row.token1,
        fee: row.fee_tier,
        tickSpacing: row.tick_spacing,
        hooks: row.hooks ?? NATIVE_ETH,
        decimals0: row.d0,
        decimals1: row.d1,
      },
      poolAddress: row.pool_address,
      protocol: row.protocol === 'v3' ? 'v3' : 'v4',
      feeTierBps: Math.round(row.fee_tier / 100),
      token: {
        address: tokenAddress,
        symbol: tokenFirst ? row.s0 : row.s1,
        name: tokenFirst ? row.n0 : row.n1,
        decimals: tokenFirst ? row.d0 : row.d1,
        logoColor: (tokenFirst ? row.c0 : row.c1) ?? 'var(--fg-3)',
        logoUrl: (tokenFirst ? row.l0 : row.l1) ?? undefined,
      },
      quote,
      quoteAddress,
      quoteDecimals: tokenFirst ? row.d1 : row.d0,
      tokenIsCurrency0: tokenFirst,
      tickLower: row.tick_lower,
      tickUpper: row.tick_upper,
      liquidity: row.liquidity,
      amount0: amounts.amount0.toString(),
      amount1: amounts.amount1.toString(),
      holdUsd,
      priceUsd0: p0,
      priceUsd1: p1,
      mintedAt: row.minted_at ? new Date(row.minted_at).toISOString() : null,
    };

    positions.push({
      tokenId: row.token_id,
      poolId: row.pool_id,
      rangePct: range === 'full' ? 100 : Math.round(Math.max(Math.abs(range.minPct), Math.abs(range.maxPct))),
      range,
      inRange,
      outOfRangeSinceHours,
      valueUsd,
      priceImpactUsd: valueUsd - holdUsd,
      live,
    });
  }

  return {
    wallet: owner,
    asOf: cursor.lastIndexedAt.toISOString(),
    positions,
    netValueUsd: positions.reduce((a, p) => a + p.valueUsd, 0),
    priceImpactUsd: positions.reduce((a, p) => a + (p.priceImpactUsd ?? 0), 0),
  };
}

/** Which contract every position here was minted through. */
export const POSITION_MANAGER = CONTRACTS.positionManager;
