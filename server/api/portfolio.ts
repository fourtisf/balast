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

import type { Address } from 'viem';
import { CONTRACTS, NATIVE_ETH, isEther } from '../../lib/chain';
import { feeTierBpsFromPips } from '../../lib/format';
import type { LivePosition, Quote, UserPosition } from '../../lib/data/types';
import type { V3OnchainPosition } from '../../lib/v3/positions';
import { maxUsableTick, minUsableTick } from '../../lib/v4/pool';
import { amountsForLiquidity } from '../chain/tick-math';
import { prisma } from '../db';
import { resolveUsdg } from '../indexer/anchor';
import { indexedAsOf } from '../indexer/as-of';
import { POOL_MANAGER_CURSOR } from '../indexer/poller';

export interface PortfolioResponse {
  wallet: string;
  /** Chain time of the last block indexed: what "now" means for every figure here. */
  asOf: string;
  positions: UserPosition[];
  netValueUsd: number;
  priceImpactUsd: number;
  /**
   * The v3 half, which is read from the chain rather than the indexer (see
   * `V3PositionReader`). `off` when this server was not given a reader;
   * `unavailable` when the node did not answer — the portfolio then lists v4
   * alone and says so, rather than implying the wallet holds no v3 position.
   * `unindexed` counts positions whose pool the indexer has not met, which
   * cannot be valued and are left out.
   */
  v3: { status: 'read' | 'unavailable' | 'off'; message?: string; unindexed: number };
}

/**
 * Reads a wallet's v3 positions from the NonfungiblePositionManager
 * (lib/v3/positions.ts). Injected, so a test never reaches a node and the
 * server bounds how long a slow one may hold a request.
 */
export type V3PositionReader = (owner: Address) => Promise<V3OnchainPosition[]>;

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
  /** Net principal. Null for a v3 position: read live, its funding history is not indexed. */
  deposited0: string | null;
  deposited1: string | null;
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

/** What a v3 position's pool row carries: everything in `Row` that is not the position's own. */
type PoolRow = Omit<Row, 'token_id' | 'tick_lower' | 'tick_upper' | 'liquidity' | 'deposited0' | 'deposited1' | 'minted_at'>;

/**
 * The v3 positions, as rows the valuation below already understands.
 *
 * Each on-chain position is matched to the pool the indexer knows by its
 * two tokens and fee — the three things that identify a v3 pool. A position
 * whose pool the indexer has not met cannot be valued or named, so it is
 * counted and left out rather than shown with invented figures (§7).
 */
async function v3Rows(onchain: V3OnchainPosition[]): Promise<{ rows: Row[]; unindexed: number }> {
  const rows: Row[] = [];
  let unindexed = 0;
  const pools = new Map<string, PoolRow | null>();
  for (const position of onchain) {
    const t0 = position.token0.toLowerCase();
    const t1 = position.token1.toLowerCase();
    const id = `${t0}|${t1}|${position.fee}`;
    if (!pools.has(id)) {
      const [pool] = await prisma.$queryRaw<PoolRow[]>`
        SELECT
          pl.id AS pool_id, pl.address AS pool_address, pl.protocol, pl.fee_tier, pl.tick_spacing, pl.hooks,
          pl.token0, pl.token1,
          t0.decimals AS d0, t1.decimals AS d1, t0.symbol AS s0, t1.symbol AS s1, t0.name AS n0, t1.name AS n1,
          t0.logo_color AS c0, t1.logo_color AS c1, t0.logo_url AS l0, t1.logo_url AS l1,
          COALESCE(ps.sqrt_price_x96, pl.init_sqrt_price_x96, 0)::text AS sqrt,
          COALESCE(ps.tick, pl.init_tick, 0) AS tick,
          COALESCE(ps.price_usd, 0)::float8 AS price_usd
        FROM pools pl
        JOIN tokens t0 ON lower(t0.address) = lower(pl.token0)
        JOIN tokens t1 ON lower(t1.address) = lower(pl.token1)
        LEFT JOIN pool_state ps ON ps.pool_id = pl.id
        WHERE pl.protocol = 'v3' AND lower(pl.token0) = ${t0} AND lower(pl.token1) = ${t1} AND pl.fee_tier = ${position.fee}
        LIMIT 1
      `;
      pools.set(id, pool ?? null);
    }
    const pool = pools.get(id);
    if (!pool) {
      unindexed += 1;
      continue;
    }
    rows.push({
      ...pool,
      token_id: position.tokenId.toString(),
      tick_lower: position.tickLower,
      tick_upper: position.tickUpper,
      liquidity: position.liquidity.toString(),
      deposited0: null,
      deposited1: null,
      minted_at: null,
    });
  }
  return { rows, unindexed };
}

export async function buildPortfolio(
  wallet: string,
  usdgAddress?: string | null,
  options: { readV3?: V3PositionReader | null } = {},
): Promise<PortfolioResponse | null> {
  const owner = wallet.toLowerCase();
  const cursor = await prisma.indexerCursor.findUnique({ where: { contract: POOL_MANAGER_CURSOR } });
  if (!cursor) return null;
  const anchor = await resolveUsdg(usdgAddress);
  if (!anchor.address) return null;
  const usdg = anchor.address.toLowerCase();
  const asOf = await indexedAsOf(cursor.lastIndexedAt);

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

  // The v3 half, from the chain. A node that does not answer costs the v3
  // rows and says so; it never costs the v4 ones.
  let v3: PortfolioResponse['v3'] = { status: 'off', unindexed: 0 };
  if (options.readV3) {
    let onchain: V3OnchainPosition[] | null = null;
    try {
      onchain = await options.readV3(owner as Address);
    } catch (e) {
      // The detail goes to the log, not to the page: an endpoint's error can
      // carry its URL, and a paid endpoint's URL carries its key.
      console.warn(`portfolio: v3 positions unreadable for ${owner}: ${(e as Error).message.split('\n')[0]}`);
      v3 = { status: 'unavailable', message: 'The chain did not answer for Uniswap v3 positions.', unindexed: 0 };
    }
    // A database fault here is a fault like any other query's, not a node
    // that did not answer, so it is outside the catch.
    if (onchain) {
      const read = await v3Rows(onchain);
      rows.push(...read.rows);
      v3 = { status: 'read', unindexed: read.unindexed };
    }
  }

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
    // What the principal would be worth held, at the same prices. Unknown for
    // a v3 position — its funding is not indexed — and unknown is not zero.
    const holdUsd =
      row.deposited0 === null || row.deposited1 === null
        ? null
        : priced
          ? human(BigInt(row.deposited0), row.d0) * p0 + human(BigInt(row.deposited1), row.d1) * p1
          : 0;
    const inRange = priced && row.tick >= row.tick_lower && row.tick < row.tick_upper;
    // No price for the pool, or no dollar price for one of its sides: the
    // figures above are zero because they are unknown, and say so.
    const valueUnknown = !priced || !(p0 > 0) || !(p1 > 0);

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
      if (since) outOfRangeSinceHours = Math.max(0, (asOf.getTime() - new Date(since).getTime()) / 3_600_000);
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
      feeTierBps: feeTierBpsFromPips(row.protocol, row.fee_tier),
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
      ...(priced ? {} : { rangeUnknown: true }),
      ...(valueUnknown ? { valueUnknown: true } : {}),
      valueUsd,
      // Unknown principal, or an unknown value: no figure, rather than a
      // difference of two numbers one of which is not real.
      priceImpactUsd: holdUsd === null || valueUnknown ? undefined : valueUsd - holdUsd,
      live,
    });
  }

  return {
    wallet: owner,
    asOf: asOf.toISOString(),
    positions,
    netValueUsd: positions.reduce((a, p) => a + p.valueUsd, 0),
    priceImpactUsd: positions.reduce((a, p) => a + (p.priceImpactUsd ?? 0), 0),
    v3,
  };
}

/** Which contracts the positions here were minted through: v4's PositionManager, v3's NonfungiblePositionManager. */
export const POSITION_MANAGERS = { v4: CONTRACTS.positionManager, v3: CONTRACTS.v3PositionManager } as const;
