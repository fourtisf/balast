/**
 * SQL to `MarketSnapshot`. The one place the database meets the UI's contract.
 *
 * Two rules from the handoff shape everything here.
 *
 * §4.2 — fee yield is computed in SQL, never in a component. The arithmetic
 * below is `fees_window / tvl_now * (365*24 / window_hours) * 100`, done in
 * Postgres. What stays in TypeScript is only the *classification* into §7's
 * three states, and it reuses `lib/yield.ts` so the live boards and the
 * simulator cannot drift apart. There is a test asserting the SQL and
 * `computeFeeYield` agree.
 *
 * §7 — the trailing window ends at the last block we have indexed, not at
 * wall-clock now. If the indexer is an hour behind, wall-clock would count
 * that hour as zero fees and quietly deflate every yield on the board. So the
 * window is honest and the lag is reported separately, which is what the top
 * bar shows.
 *
 * Anything P1 genuinely cannot know is zero or empty, never invented. There
 * are no vault contracts until P2, so there are no stakes, no positions and
 * no harvest payouts — the components already have empty states for that.
 */

import { CONTRACTS, PROTOCOL_FEE_BPS, REWARD_WINDOW_SECONDS, NATIVE_ETH, isEther, isStablecoinSql } from '../../lib/chain';
import { feeTierBpsFromPips } from '../../lib/format';
import type { MarketFeed } from './market';
import type { LiveReserves } from './live-reserves';
import type {
  FeeYield,
  MarketSnapshot,
  Pool,
  Portfolio,
  Quote,
  RouterPlan,
  Vault,
} from '../../lib/data/types';
import { MIN_DATA_HOURS, YIELD_WINDOW_HOURS } from '../../lib/yield';
import { prisma } from '../db';
import { env } from '../env';
import { resolveUsdg } from '../indexer/anchor';
import { indexedAsOf } from '../indexer/as-of';
import { isEtherSql, tradedSide } from '../indexer/aggregate';
import { POOL_MANAGER_CURSOR } from '../indexer/poller';
import { recentEthPrice, recentMarket } from './recent';

/** Buckets in a row's fee sparkline, and therefore hours per bucket. */
const SPARK_BUCKETS = 14;
const SPARK_BUCKET_HOURS = YIELD_WINDOW_HOURS / SPARK_BUCKETS; // 12h

export interface SnapshotOptions {
  /** Wallet to build the portfolio for. Without one the portfolio is empty. */
  wallet?: string | null;
  /**
   * Live market figures (market.ts). Given, every listed pool carries its
   * token's quote under `market` and the feed is told which tokens to keep
   * quoting. Absent — tests, scripts — `market` is null on every pool.
   */
  market?: MarketFeed | null;
  /**
   * The listed v3 pools' own balances, read from the chain a minute ago
   * (live-reserves.ts): the liquidity a current fee yield is divided by.
   * Absent — tests, scripts — no pool has a live liquidity from the chain.
   */
  reserves?: LiveReserves | null;
  /**
   * USDG's address. Optional: when absent it is discovered from the chain's
   * own tokens, the same way the indexer does it.
   */
  usdgAddress?: string | null;
  /**
   * Minimum fully diluted value for a pool's token to be listed. Defaults to
   * `LISTING_MIN_FDV_USD`; ether/USDG pools are always listed (see env.ts).
   */
  minFdvUsd?: number;
  /**
   * Minimum known liquidity for a pool to be listed. Defaults to
   * `LISTING_MIN_LIQUIDITY_USD`; unknown liquidity is not held against a pool.
   */
  minLiquidityUsd?: number;
  /**
   * Minimum dollars behind a row — quote-side reserves, or volume traded
   * through the pool in the yield window. Defaults to
   * `LISTING_MIN_BACKING_USD`; ether/USDG pools are always listed.
   */
  minBackingUsd?: number;
  /** Whether stablecoins get rows of their own. Defaults to `LISTING_STABLECOINS`. */
  listStablecoins?: boolean;
}

interface PoolQueryRow {
  id: string;
  address: string;
  protocol: string;
  fee_tier: number;
  token0: string;
  token1: string;
  tick_spacing: number;
  hooks: string | null;
  decimals0: number;
  decimals1: number;
  stakeable: boolean;
  token_address: string;
  symbol: string;
  name: string;
  decimals: number;
  logo_color: string | null;
  logo_url: string | null;
  launchpad: string | null;
  quote_symbol: string | null;
  age_hours: number;
  tvl_usd: number;
  quote_tvl_usd: number;
  price_usd: number;
  mc_usd: number;
  circ_mc_usd: number;
  change_24h_pct: number | null;
  fees_24h_usd: number;
  fees_window_usd: number;
  window_hours: number;
  volume_24h_usd: number;
  trades_24h: number;
  buy_volume_24h_usd: number;
  sell_volume_24h_usd: number;
  buys_24h: number;
  sells_24h: number;
  /** Computed in SQL (§4.2). Null when there is no depth to divide by. */
  fee_yield_pct: number | null;
  spark: number[];
  vol_spark: number[];
}

/**
 * The main query.
 *
 * `as_of` is the chain time of the last block indexed. Everything trailing is
 * measured back from it, so the figures describe a consistent moment rather
 * than a mixture of chain time and wall time.
 */
async function queryPools(
  usdg: string,
  asOf: Date,
  minFdvUsd: number,
  minLiquidityUsd: number,
  minBackingUsd: number,
  listStablecoins: boolean,
): Promise<PoolQueryRow[]> {
  const weth = CONTRACTS.weth.toLowerCase();
  const usdgLower = usdg.toLowerCase();
  if (!/^0x[0-9a-fA-F]{40}$/.test(usdgLower)) {
    throw new Error(`USDG_ADDRESS is not an address: ${JSON.stringify(usdg)}`);
  }
  if (!Number.isFinite(minFdvUsd) || minFdvUsd < 0) {
    throw new Error(`minFdvUsd must be a non-negative number, got ${String(minFdvUsd)}`);
  }
  if (!Number.isFinite(minLiquidityUsd) || minLiquidityUsd < 0) {
    throw new Error(`minLiquidityUsd must be a non-negative number, got ${String(minLiquidityUsd)}`);
  }
  if (!Number.isFinite(minBackingUsd) || minBackingUsd < 0) {
    throw new Error(`minBackingUsd must be a non-negative number, got ${String(minBackingUsd)}`);
  }

  /** Pick a column from whichever side of the pool is the traded one. */
  const side = (whenToken0: string, whenToken1: string): string =>
    tradedSide({
      addr0: 'p.token0',
      addr1: 'p.token1',
      weth,
      usdg: usdgLower,
      whenToken0,
      whenToken1,
      // A pool with neither quote is filtered out by the WHERE below, so this
      // branch is unreachable; token0 keeps the column non-null regardless.
      otherwise: whenToken0,
    });

  // Built as a string rather than a tagged template, because the traded-side
  // rule above is SQL, and a tagged template would bind it as a text
  // parameter instead of injecting it. `asOf` stays a real bound parameter;
  // the two addresses are regex-checked before they reach the string.
  const sql = `
    WITH params AS (
      SELECT
        $1::timestamp                                       AS as_of,
        $1::timestamp - interval '24 hours'                 AS since_24h,
        $1::timestamp - (${YIELD_WINDOW_HOURS} * interval '1 hour') AS since_window
    ),

    -- Which pools the board will show, decided FIRST. Every per-pool CTE
    -- below used to run for all of them — correlated price lookups, fee
    -- sums, fourteen sparkline buckets — and the bar was applied at the very
    -- end. On the real chain that was 2,600 pools of work for a board of
    -- fifty, on every request, and the page waited on it.
    listed AS (
      SELECT p.id
      FROM pools p
      LEFT JOIN pool_state ps ON ps.pool_id = p.id
      JOIN tokens lt0 ON lower(lt0.address) = lower(p.token0)
      JOIN tokens lt1 ON lower(lt1.address) = lower(p.token1)
      -- A pool with neither WETH nor USDG on a side cannot be priced through
      -- the one allowed path, so it is not listed rather than listed at zero.
      WHERE (${isEtherSql('p.token0', weth)} OR lower(p.token0) = '${usdgLower}'
         OR ${isEtherSql('p.token1', weth)} OR lower(p.token1) = '${usdgLower}')
        -- A dollar is not a project (LISTING_STABLECOINS): a stablecoin on
        -- the traded side is not a row, whatever its market cap. It remains
        -- a quote, and its pools stay indexed.
        AND (${listStablecoins ? 'true' : `NOT ${isStablecoinSql(side('lt0.symbol', 'lt1.symbol'))}`})
        -- The listing bar (env.ts LISTING_MIN_FDV_USD): dust stays indexed and
        -- unlisted. The ether/USDG market is exempt — ether's FDV is zero by
        -- construction, not by size.
        AND (
          COALESCE(ps.mc_usd, 0) >= ${minFdvUsd}
          OR (${isEtherSql('p.token0', weth)} AND lower(p.token1) = '${usdgLower}')
          OR (lower(p.token0) = '${usdgLower}' AND ${isEtherSql('p.token1', weth)})
        )
        -- The liquidity floor (LISTING_MIN_LIQUIDITY_USD), on a KNOWN
        -- liquidity only: a pool whose reserves the indexer cannot
        -- reconstruct reads as unknown, not small (§14), and that is not held
        -- against it here — the backing test below is what such a pool has to
        -- pass. The ether/USDG market is exempt.
        AND (
          ps.tvl_usd >= ${minLiquidityUsd}
          OR COALESCE(ps.tvl_usd, 0) = 0
          OR (${isEtherSql('p.token0', weth)} AND lower(p.token1) = '${usdgLower}')
          OR (lower(p.token0) = '${usdgLower}' AND ${isEtherSql('p.token1', weth)})
        )
        -- The backing test (LISTING_MIN_BACKING_USD): real dollars, either
        -- sitting in the pool or traded through it.
        --
        -- The floor above values BOTH sides, and the token side's price comes
        -- from the pool's own ratio — so a pool holding most of a token's
        -- supply reports a liquidity equal to that token's fully diluted
        -- value and clears any both-sides floor with dust on the quote side.
        -- That is what put three launchpad tokens on the board at an
        -- identical "MC $38.88M · liquidity $38.88M" with a day's volume of
        -- nothing, and a fourth with unknown depth on a dollar of trading.
        --
        -- The quote side is priced outside the pool (§4.3), so it is the one
        -- figure here that is not circular: it is the dollars a swap can
        -- take out. Volume through the pool is the other way to show real
        -- money, and it is what keeps a hooked pool whose reserves cannot be
        -- reconstructed on the board. Either will do; neither is a dead pool
        -- with a supply. The ether/USDG market is exempt again.
        AND (
          -- Null while the rebuild has not reached the pool: unknown, and
          -- unknown is not held against it (§14). Zero is a measurement.
          ps.quote_tvl_usd IS NULL
          OR ps.quote_tvl_usd >= ${minBackingUsd}
          OR COALESCE((
            SELECT SUM(f.volume_usd) FROM pool_fee_hourly f, params pr
            WHERE f.pool_id = p.id AND f.hour >= pr.since_window
          ), 0) >= ${minBackingUsd}
          OR (${isEtherSql('p.token0', weth)} AND lower(p.token1) = '${usdgLower}')
          OR (lower(p.token0) = '${usdgLower}' AND ${isEtherSql('p.token1', weth)})
        )
    ),

    -- The anchor's price at two moments, for an honest 24h change (§4.3).
    anchor_pool AS (
      SELECT p.id, p.token0, p.token1
      FROM pools p
      LEFT JOIN pool_state ps ON ps.pool_id = p.id
      WHERE (${isEtherSql('p.token0', weth)} AND lower(p.token1) = '${usdgLower}')
         OR (lower(p.token0) = '${usdgLower}' AND ${isEtherSql('p.token1', weth)})
      ORDER BY COALESCE(ps.liquidity, 0) DESC, p.created_block ASC
      LIMIT 1
    ),

    moments AS (
      SELECT as_of AS moment FROM params
      UNION ALL
      SELECT since_24h FROM params
    ),

    -- Last swap in a pool at or before a moment: its price at that moment.
    ratio_at AS (
      SELECT
        p.id AS pool_id,
        m.moment,
        (SELECT (power(sw.sqrt_price_x96::numeric, 2)
                   * power(10::numeric, GREATEST(t0.decimals - t1.decimals, 0)))
                / power(2::numeric, 192)
                / power(10::numeric, GREATEST(t1.decimals - t0.decimals, 0))
         FROM swap_events sw
         WHERE sw.pool_id = p.id AND sw.block_time <= m.moment
         ORDER BY sw.block_num DESC, sw.log_index DESC
         LIMIT 1) AS ratio
      FROM pools p
      JOIN (SELECT id FROM listed UNION SELECT id FROM anchor_pool) want ON want.id = p.id
      JOIN tokens t0 ON lower(t0.address) = lower(p.token0)
      JOIN tokens t1 ON lower(t1.address) = lower(p.token1)
      CROSS JOIN moments m
    ),

    -- WETH in USD at each moment, from the anchor pool and nothing else.
    anchor_usd AS (
      SELECT r.moment,
        CASE
          WHEN lower(ap.token1) = '${usdgLower}' THEN r.ratio
          WHEN lower(ap.token0) = '${usdgLower}' THEN 1 / NULLIF(r.ratio, 0)
          ELSE NULL
        END AS weth_usd
      FROM anchor_pool ap
      JOIN ratio_at r ON r.pool_id = ap.id
    ),

    -- Each pool's traded-side USD price at both moments, through the one
    -- allowed path and the one traded-side rule.
    priced AS (
      SELECT
        p.id AS pool_id,
        r.moment,
        ${tradedSide({
          addr0: 'p.token0',
          addr1: 'p.token1',
          weth,
          usdg: usdgLower,
          // token0 is traded: the ratio already reads in quote terms.
          whenToken0: `r.ratio * (CASE WHEN lower(p.token1) = '${usdgLower}' THEN 1 ELSE au.weth_usd END)`,
          // token1 is traded: invert the ratio first.
          whenToken1: `(CASE WHEN lower(p.token0) = '${usdgLower}' THEN 1 ELSE au.weth_usd END) / NULLIF(r.ratio, 0)`,
        })} AS price_usd
      FROM pools p
      JOIN ratio_at r ON r.pool_id = p.id
      LEFT JOIN anchor_usd au ON au.moment = r.moment
    ),

    -- Trailing sums straight out of pool_fee_hourly (§4.2).
    fees AS (
      SELECT
        p.id AS pool_id,
        COALESCE(SUM(CASE WHEN f.hour >= pr.since_24h THEN f.fees_usd END), 0)    AS fees_24h_usd,
        COALESCE(SUM(CASE WHEN f.hour >= pr.since_window THEN f.fees_usd END), 0) AS fees_window_usd,
        COALESCE(SUM(CASE WHEN f.hour >= pr.since_24h THEN f.volume_usd END), 0)  AS volume_24h_usd,
        COALESCE(SUM(CASE WHEN f.hour >= pr.since_24h THEN f.swaps END), 0)::int  AS trades_24h,
        COALESCE(SUM(CASE WHEN f.hour >= pr.since_24h THEN f.buy_volume_usd END), 0)  AS buy_volume_24h_usd,
        COALESCE(SUM(CASE WHEN f.hour >= pr.since_24h THEN f.sell_volume_usd END), 0) AS sell_volume_24h_usd,
        COALESCE(SUM(CASE WHEN f.hour >= pr.since_24h THEN f.buys END), 0)::int  AS buys_24h,
        COALESCE(SUM(CASE WHEN f.hour >= pr.since_24h THEN f.sells END), 0)::int AS sells_24h
      FROM pools p
      JOIN listed l ON l.id = p.id
      CROSS JOIN params pr
      LEFT JOIN pool_fee_hourly f ON f.pool_id = p.id AND f.hour >= pr.since_window
      GROUP BY p.id
    ),

    -- 14 buckets of 12 hours across the trailing window, for the sparklines:
    -- fees for the masthead's chart, volume for the row's.
    spark AS (
      SELECT p.id AS pool_id,
        array_agg(COALESCE(b.total, 0)::float8 ORDER BY b.bucket) AS spark,
        array_agg(COALESCE(b.vol, 0)::float8 ORDER BY b.bucket) AS vol_spark
      FROM pools p
      JOIN listed l ON l.id = p.id
      CROSS JOIN params pr
      CROSS JOIN LATERAL (
        SELECT g.bucket, b2.total, b2.vol
        FROM generate_series(0, ${SPARK_BUCKETS - 1}) AS g(bucket)
        CROSS JOIN LATERAL (
          SELECT SUM(f.fees_usd) AS total, SUM(f.volume_usd) AS vol FROM pool_fee_hourly f
            WHERE f.pool_id = p.id
              AND f.hour >= pr.as_of - ((${SPARK_BUCKETS} - g.bucket) * ${SPARK_BUCKET_HOURS} * interval '1 hour')
              AND f.hour <  pr.as_of - ((${SPARK_BUCKETS} - g.bucket - 1) * ${SPARK_BUCKET_HOURS} * interval '1 hour')
        ) b2
      ) b
      GROUP BY p.id
    )

    SELECT
      p.id,
      p.address,
      p.protocol,
      p.fee_tier,
      p.token0,
      p.token1,
      p.tick_spacing,
      p.hooks,
      t0.decimals AS decimals0,
      t1.decimals AS decimals1,
      p.stakeable,
      -- The traded side, by the one rule in aggregate.ts. Using a different
      -- rule here is how the WETH/USDG row once read "WETH · $1.00".
      ${side('t0.address', 't1.address')}       AS token_address,
      ${side('t0.symbol', 't1.symbol')}         AS symbol,
      ${side('t0.name', 't1.name')}             AS name,
      ${side('t0.decimals', 't1.decimals')}     AS decimals,
      ${side('t0.logo_color', 't1.logo_color')} AS logo_color,
      ${side('t0.logo_url', 't1.logo_url')}     AS logo_url,
      ${side('t0.launchpad', 't1.launchpad')}   AS launchpad,
      -- USDG outranks WETH as the quote, matching the rule above.
      CASE
        WHEN lower(p.token0) = '${usdgLower}' OR lower(p.token1) = '${usdgLower}' THEN 'USDG'
        WHEN ${isEtherSql('p.token0', weth)} OR ${isEtherSql('p.token1', weth)} THEN 'ETH'
        ELSE NULL
      END AS quote_symbol,

      GREATEST(0, EXTRACT(EPOCH FROM (pr.as_of - p.created_at)) / 3600)::float8 AS age_hours,
      COALESCE(ps.tvl_usd, 0)::float8   AS tvl_usd,
      COALESCE(ps.quote_tvl_usd, 0)::float8 AS quote_tvl_usd,
      COALESCE(ps.price_usd, 0)::float8 AS price_usd,
      COALESCE(ps.mc_usd, 0)::float8    AS mc_usd,
      COALESCE(ps.circ_mc_usd, 0)::float8 AS circ_mc_usd,

      -- 24h move, both prices through the same path so the ratio is honest.
      CASE
        WHEN pnow.price_usd IS NULL OR pthen.price_usd IS NULL OR pthen.price_usd = 0 THEN NULL
        ELSE ((pnow.price_usd / pthen.price_usd) - 1) * 100
      END::float8 AS change_24h_pct,

      f.fees_24h_usd::float8    AS fees_24h_usd,
      f.fees_window_usd::float8 AS fees_window_usd,
      -- The window is capped at the pool's own age: a 30-hour-old pool is
      -- annualised over 30 hours, not over 168 it never had (§7).
      LEAST(
        ${YIELD_WINDOW_HOURS}::numeric,
        GREATEST(1, EXTRACT(EPOCH FROM (pr.as_of - p.created_at)) / 3600)
      )::float8 AS window_hours,
      f.volume_24h_usd::float8  AS volume_24h_usd,
      f.trades_24h,
      f.buy_volume_24h_usd::float8  AS buy_volume_24h_usd,
      f.sell_volume_24h_usd::float8 AS sell_volume_24h_usd,
      f.buys_24h,
      f.sells_24h,

      -- §4.2: the yield arithmetic, in SQL.
      CASE
        WHEN COALESCE(ps.tvl_usd, 0) <= 0 THEN NULL
        ELSE (
          f.fees_window_usd / ps.tvl_usd
          * ((365 * 24)::numeric / LEAST(
              ${YIELD_WINDOW_HOURS}::numeric,
              GREATEST(1, EXTRACT(EPOCH FROM (pr.as_of - p.created_at)) / 3600)))
          * 100
        )
      END::float8 AS fee_yield_pct,

      s.spark,
      s.vol_spark
    FROM pools p
    JOIN listed l ON l.id = p.id
    CROSS JOIN params pr
    JOIN tokens t0 ON lower(t0.address) = lower(p.token0)
    JOIN tokens t1 ON lower(t1.address) = lower(p.token1)
    LEFT JOIN pool_state ps ON ps.pool_id = p.id
    LEFT JOIN fees  f ON f.pool_id = p.id
    LEFT JOIN spark s ON s.pool_id = p.id
    LEFT JOIN priced pnow  ON pnow.pool_id  = p.id AND pnow.moment  = pr.as_of
    LEFT JOIN priced pthen ON pthen.pool_id = p.id AND pthen.moment = pr.since_24h
    ORDER BY COALESCE(ps.tvl_usd, 0) DESC
  `;

  return prisma.$queryRawUnsafe<PoolQueryRow[]>(sql, asOf);
}

/**
 * §7's three states, from the SQL figure.
 *
 * The thresholds are `lib/yield.ts`'s, not copies of them, so the live boards
 * and the simulator can never disagree about when a number is honest.
 */
export function classifyYield(row: {
  fee_yield_pct: number | null;
  age_hours: number;
  window_hours: number;
  tvl_usd: number;
}): FeeYield {
  if (row.fee_yield_pct === null || row.age_hours < MIN_DATA_HOURS || row.tvl_usd <= 0) {
    return { basis: 'insufficient' };
  }
  if (row.age_hours < YIELD_WINDOW_HOURS) {
    return { basis: 'estimate', pct: row.fee_yield_pct, windowHours: row.window_hours };
  }
  return { basis: 'trailing7d', pct: row.fee_yield_pct };
}

function toPool(row: PoolQueryRow): Pool {
  return {
    id: row.id,
    address: row.address,
    token: {
      address: row.token_address,
      symbol: row.symbol,
      name: row.name,
      decimals: row.decimals,
      logoColor: row.logo_color ?? 'var(--fg-3)',
      logoUrl: row.logo_url ?? undefined,
      launchpad: row.launchpad ?? undefined,
    },
    quote: (row.quote_symbol ?? 'ETH') as Quote,
    // Pool fees are in hundredths of a bip on chain; the UI wants bips.
    feeTierBps: feeTierBpsFromPips(row.protocol, row.fee_tier),
    // The on-chain key, so /positions can mint into the pool.
    //
    // Both protocols now: Balast mints v4 through the PositionManager and
    // v3 through Uniswap's NonfungiblePositionManager, which is deployed on
    // this chain. A v3 pool has no hook, which is what the zero address
    // means in a v4 key too, and `protocol` is what the flow branches on.
    key: {
      currency0: row.token0,
      currency1: row.token1,
      fee: row.fee_tier,
      tickSpacing: row.tick_spacing,
      hooks: row.hooks ?? NATIVE_ETH,
      decimals0: row.decimals0,
      decimals1: row.decimals1,
    },
    protocol: row.protocol === 'v3' ? 'v3' : 'v4',
    stakeable: row.stakeable,
    ageHours: row.age_hours,
    priceUsd: row.price_usd,
    // Circulating supply x price, where circulating is the total less what
    // the chain shows cannot circulate; zero until those holdings are read,
    // and the row then shows the FDV alone, labelled (§7). Neither read: an
    // em dash.
    marketCapUsd: row.circ_mc_usd,
    fdvUsd: row.mc_usd,
    tvlUsd: row.tvl_usd,
    // The quote side of those reserves alone: the dollars actually in the
    // pool. The figure above values the token side at a price derived from
    // the pool's own ratio, so for a pool holding most of a supply it equals
    // that token's FDV whatever is really there. Zero when the reserves do
    // not reconstruct, the same unknown as `tvlUsd`.
    quoteTvlUsd: row.quote_tvl_usd,
    // Null stays null: no price a day ago is "unknown", and the row says so.
    change24hPct: row.change_24h_pct,
    fees24hUsd: row.fees_24h_usd,
    feesWindowUsd: row.fees_window_usd,
    feeWindowHours: row.window_hours,
    volume24hUsd: row.volume_24h_usd,
    trades24h: row.trades_24h,
    buyVolume24hUsd: row.buy_volume_24h_usd,
    sellVolume24hUsd: row.sell_volume_24h_usd,
    buys24h: row.buys_24h,
    sells24h: row.sells_24h,
    feeHistory: row.spark.length > 0 ? row.spark : new Array(SPARK_BUCKETS).fill(0),
    volumeHistory: row.vol_spark.length > 0 ? row.vol_spark : new Array(SPARK_BUCKETS).fill(0),
    market: null,
    feeYield: classifyYield(row),
  };
}

/** Vaults, once P2 deploys them. Until then this is empty and honest. */
async function queryVaults(): Promise<Vault[]> {
  const rows = await prisma.vault.findMany({
    include: { pool: { select: { id: true } } },
  });
  const now = Date.now();
  return rows.map((v) => ({
    id: `vault-${v.poolId}`,
    poolId: v.poolId,
    address: v.address,
    totalStakedUsd: Number(v.totalStakedUsd),
    stakers: v.stakers,
    rewardRate: Number(v.rewardRate) / 1e18,
    nextHarvestInSeconds: Math.max(0, (v.periodFinish.getTime() - now) / 1000),
    protocolFeeBps: v.protocolFeeBps,
  }));
}

/**
 * The connected wallet's portfolio.
 *
 * There is no wallet connector and no vault until P2, so this is zeros and
 * empty lists. The components have empty states for exactly this; inventing a
 * position would be the dishonest alternative.
 */
async function queryPortfolio(wallet: string | null): Promise<Portfolio> {
  const empty: Portfolio = {
    netValueUsd: 0,
    netChangeUsd: 0,
    netChangePct: 0,
    feesEarnedWeth: 0,
    feesEarnedUsd: 0,
    priceImpactUsd: 0,
    fees7dUsd: 0,
    dailyFeesWeth: new Array(56).fill(0),
    stakes: [],
    positions: [],
    claimableWeth: 0,
  };
  if (!wallet) return empty;

  const [stakes, positions] = await Promise.all([
    prisma.stake.findMany({
      where: { wallet: wallet.toLowerCase() },
      include: { vault: true },
    }),
    prisma.position.findMany({ where: { wallet: wallet.toLowerCase() } }),
  ]);

  const now = Date.now();
  return {
    ...empty,
    stakes: stakes.map((s) => {
      const remaining = Math.max(0, (s.vault.periodFinish.getTime() - now) / 1000);
      return {
        vaultId: `vault-${s.vaultId}`,
        poolId: s.vaultId,
        stakedUsd: 0,
        earnedWeth: 0,
        streamProgressPct: 100 - (remaining / REWARD_WINDOW_SECONDS) * 100,
        streamRemainingSeconds: remaining,
      };
    }),
    positions: positions.map((p) => ({
      tokenId: p.tokenId,
      poolId: p.poolId,
      shape: (p.shape as 'spot' | 'curve' | 'bidask') ?? 'spot',
      rangePct: 0,
      inRange: p.status === 'in-range',
      valueUsd: 0,
      feesWeth: 0,
    })),
  };
}

/**
 * The router plan.
 *
 * `BalastRouter` is P4, so nothing has accrued and nothing has been routed.
 * The current depth is real — it is the pool's own — and everything that
 * depends on a fee stream is zero.
 */
async function queryRouter(pools: Pool[]): Promise<RouterPlan> {
  const config = await prisma.routerConfig.findFirst({ orderBy: { updatedAt: 'desc' } });
  const target = pools.find((p) => p.stakeable) ?? pools[0];

  return {
    tokenSymbol: target?.token.symbol ?? '—',
    feeSourceAddress: config?.feeSource ?? '—',
    accruedWeth: 0,
    accruedUsd: 0,
    currentDepthUsd: target?.tvlUsd ?? 0,
    projectedDepthUsd: target?.tvlUsd ?? 0,
    slippageNowPct: 0,
    slippageLaterPct: 0,
    firstRouteWeth: 0,
    firstRouteDepthUsd: 0,
    twapMinutes: 30,
  };
}

/**
 * One row per token: its deepest pool.
 *
 * The board is a TOKEN listing (§6, and the prototype's rows), and a token
 * on this chain routinely has several pools — fee tiers, hooked variants —
 * which listed CASHCAT twice and the ether market twice on the first real
 * board. The row is the pool with the most depth, because that is the pool
 * the Stake button opens and the one a yield figure honestly describes;
 * the shallower pools stay indexed and unlisted. The header sums the rows
 * it shows (§12), so it moves with this rule rather than contradicting it.
 *
 * Rows arrive ordered by TVL descending, so the first seen per token wins.
 */
function onePoolPerToken(pools: Pool[]): { board: Pool[]; rest: Pool[] } {
  const seen = new Set<string>();
  const board: Pool[] = [];
  const rest: Pool[] = [];
  for (const pool of pools) {
    const key = pool.token.address.toLowerCase();
    if (seen.has(key)) {
      rest.push(pool);
      continue;
    }
    seen.add(key);
    board.push(pool);
  }
  return { board, rest };
}

/**
 * The snapshot's revision, and why it starts at the clock rather than at
 * zero.
 *
 * The live provider takes a snapshot only if its revision is above the one it
 * holds (lib/data/live-provider.ts), so the poll and the socket cannot make
 * the boards jump backwards. Started at zero, every API restart restarted the
 * count — and every page already open kept the old, higher number and
 * discarded every push and every poll until the new count climbed past it:
 * at one rebuild per five seconds, hours of a board frozen on the last
 * snapshot the previous process served, lag figure included (§7). The clock
 * is monotonic across restarts, and a process cannot rebuild faster than
 * once a millisecond, so a fresh start always exceeds the last count.
 */
let revision = Date.now();

/**
 * Build the whole snapshot.
 *
 * Returns null when there is nothing honest to render yet — no indexed blocks
 * at all. The `DataProvider` interface has always allowed that ("null if none
 * has arrived yet"); this is the case that produces it.
 */
export async function buildSnapshot(
  options: SnapshotOptions,
): Promise<MarketSnapshot | null> {
  const cursor = await prisma.indexerCursor.findUnique({
    where: { contract: POOL_MANAGER_CURSOR },
  });
  if (!cursor) return null;

  // The anchor: pinned by configuration, or discovered from indexed tokens.
  // Without one nothing has a dollar figure, so there is nothing honest to
  // render — the same null the UI already handles.
  const anchor = await resolveUsdg(options.usdgAddress);
  if (!anchor.address) return null;

  // The newest row indexed, or the cursor's time if later (indexer/as-of.ts):
  // a cursor moved back for a repair must not empty the board's windows.
  const asOf = await indexedAsOf(cursor.lastIndexedAt);
  const [rows, vaults, portfolio] = await Promise.all([
    queryPools(
      anchor.address,
      asOf,
      options.minFdvUsd ?? env.listingMinFdvUsd,
      options.minLiquidityUsd ?? env.listingMinLiquidityUsd,
      options.minBackingUsd ?? env.listingMinBackingUsd,
      options.listStablecoins ?? env.listStablecoins,
    ),
    queryVaults(),
    queryPortfolio(options.wallet ?? null),
  ]);

  // The board is a token listing — one row per token, its deepest pool (§20).
  // The token's OTHER pools are kept rather than dropped: a person choosing
  // where to provide liquidity is choosing a market, and which currency it is
  // quoted in decides whether they can enter it at all. Collapsed away, a
  // wallet holding ether was offered a token's USDG pool and nothing else,
  // with "Balance 0" beside the deposit box and no way to pick the ether
  // market that was indexed all along.
  const { board: pools, rest: otherPools } = onePoolPerToken(rows.map(toPool));
  // No sparklines on the ones that are not on the board: nothing draws them,
  // and fourteen buckets apiece over a few hundred pools is payload the page
  // polls every twenty seconds for nothing.
  for (const pool of otherPools) {
    pool.feeHistory = [];
    pool.volumeHistory = [];
  }

  // Today, from the chain's own head (recent.ts). The figures above are
  // measured back from the last block the backfill indexed, which during a
  // first sync is weeks ago; this is the same arithmetic over the last day of
  // blocks, for every pool rather than only the ones an aggregator lists.
  const now = await recentMarket(anchor.address);
  if (now.size > 0) {
    for (const pool of pools) pool.now = now.get(pool.id) ?? null;
    for (const pool of otherPools) pool.now = now.get(pool.id) ?? null;
  }

  if (options.market) {
    for (const pool of pools) pool.market = options.market.quote(pool.token.address);
    // The same token's quote on its other pools, so a builder opened on one
    // of them shows the same figures the board showed.
    for (const pool of otherPools) pool.market = options.market.quote(pool.token.address);
    // And the wrapper, for the masthead's ETH price: with the ether market's
    // own pool when it is on the board, so the feed reports that pool's
    // liquidity beside the token's.
    const etherRow = pools.find((p) => isEther(p.token.address));
    options.market.follow([
      ...pools.map((p) => ({ address: p.token.address, pool: p.address, symbol: p.token.symbol })),
      { address: CONTRACTS.weth, pool: etherRow?.address ?? '', symbol: 'ETH' },
    ]);
  }
  const router = await queryRouter(pools);

  // Every figure that can be summed from the pools is summed from them, so
  // the top bar cannot contradict the table beneath it (§12).
  const tvlUsd = pools.reduce((a, p) => a + p.tvlUsd, 0);
  const fees24hUsd = pools.reduce((a, p) => a + p.fees24hUsd, 0);
  const volume24hUsd = pools.reduce((a, p) => a + p.volume24hUsd, 0);
  const stakers = vaults.reduce((a, v) => a + v.stakers, 0);
  // Depth-weighted over the pools whose change is KNOWN. A pool with no
  // price a day ago is left out of the average rather than counted as 0%.
  const known = pools.filter((p) => p.change24hPct !== null);
  const knownTvl = known.reduce((a, p) => a + p.tvlUsd, 0);
  const change24hPct =
    knownTvl > 0
      ? known.reduce((a, p) => a + (p.change24hPct as number) * p.tvlUsd, 0) / knownTvl
      : 0;

  const [totals] = await prisma.$queryRaw<{ fees_usd: number; positions: number }[]>`
    SELECT
      COALESCE((SELECT SUM(fees_usd) FROM pool_fee_hourly), 0)::float8 AS fees_usd,
      COALESCE((SELECT COUNT(*) FROM positions WHERE status = 'open'), 0)::int AS positions
  `;

  // ETH in USD: the latest row of the anchor series, and nothing else (§4.3).
  //
  // Not "the deepest pool containing WETH", which is what this used to read.
  // `pool_state.price_usd` is the TRADED side's price, so the deepest
  // WETH pool — NVDA/WETH — reported NVDA's price as the price of ether.
  // `weth_usd_hourly` exists precisely so there is one answer to this.
  const [ethRow] = await prisma.$queryRaw<{ price_usd: number }[]>`
    SELECT COALESCE(weth_usd, 0)::float8 AS price_usd
    FROM weth_usd_hourly
    ORDER BY hour DESC
    LIMIT 1
  `;

  // Chain share needs the chain's total liquidity, and the PoolManager is the
  // chain's v4 liquidity — so our share of what we index is 100% and
  // meaningless. It stays at zero until there is a figure to compare against.
  const featuredHistory = bucketSum(pools.map((p) => p.feeHistory));

  // Live over chain for the masthead's ETH figure (the owner's exception to
  // §4, §20): the anchor row is the price at the last indexed block, which
  // during a sync is weeks old, and a headline price that is weeks old is
  // wrong however honestly it was derived. The chain's figure still prices
  // every dollar on the site; this only decides what the ETH row reads, and
  // the row says which it is.
  const liveEth = options.market?.ethPrice() ?? null;
  // Failing an aggregator, the anchor pool's own price at the chain's head,
  // which is the same derivation as the row below over blocks minutes old
  // rather than weeks (§25).
  const nowEth = liveEth ? null : await recentEthPrice(anchor.address);

  // Each pool's liquidity NOW, for a yield whose two halves are the same day
  // (Pool.liveLiquidity). Valued at today's prices: the token at the head
  // reader's price, ether at the live or head price, USDG at a dollar — never
  // the indexer's, which are as old as its last block.
  const usdg = anchor.address.toLowerCase();
  const ethNow = liveEth?.usd ?? nowEth?.usd ?? null;
  const priceNow = (pool: Pool, address: string): number | null => {
    const a = address.toLowerCase();
    if (a === usdg) return 1;
    if (isEther(a)) return ethNow;
    if (a === pool.token.address.toLowerCase()) return pool.now?.priceUsd ?? null;
    return null;
  };
  for (const pool of [...pools, ...otherPools]) pool.liveLiquidity = currentLiquidity(pool, options.reserves ?? null, priceNow);
  options.reserves?.follow(
    [...pools, ...otherPools]
      .filter((p) => p.protocol === 'v3' && p.key)
      .map((p) => ({ id: p.id, address: p.address, token0: p.key!.currency0, token1: p.key!.currency1 })),
  );

  return {
    pools,
    otherPools,
    vaults,
    portfolio,
    global: {
      totalPositions: totals?.positions ?? 0,
      totalFeesUsd: totals?.fees_usd ?? 0,
      tvlUsd,
      ethPriceUsd: liveEth?.usd ?? nowEth?.usd ?? ethRow?.price_usd ?? 0,
      ethPriceBasis: liveEth ? 'live' : nowEth ? 'chain-now' : 'chain',
      ethPriceSource: liveEth?.source,
      ethPriceAt: liveEth?.at ?? nowEth?.at ?? asOf.toISOString(),
    },
    featured: {
      fees24hUsd,
      change24hPct,
      volume24hUsd,
      liquidityUsd: tvlUsd,
      stakers,
      chainSharePct: 0,
      history: featuredHistory,
    },
    router,
    // Harvest payouts need a vault (P2). No invented feed.
    payouts: [],
    payoutTotalUsd: 0,
    indexerLagSeconds: Math.max(0, (Date.now() - asOf.getTime()) / 1000),
    revision: ++revision,
    builtAt: new Date().toISOString(),
  };
}

/**
 * The next revision, for a snapshot this process did not build — the one
 * persisted by the previous process and served until the first build here
 * succeeds (snapshot-store.ts). Taken from the same counter, so the first
 * build's revision is above it and the page accepts the build.
 */
export function nextRevision(): number {
  return ++revision;
}

/** Element-wise sum of equal-length series, for the featured chart. */
function bucketSum(series: number[][]): number[] {
  const out = new Array(SPARK_BUCKETS).fill(0);
  for (const row of series) {
    for (let i = 0; i < Math.min(row.length, SPARK_BUCKETS); i++) out[i] += row[i];
  }
  return out;
}

/**
 * A pool's liquidity now, or null. A v3 pool's own balances from the chain
 * first — the chain's answer, a minute old; else an aggregator's figure for
 * exactly this pool (a v4 pool holds nothing of its own to read). A side whose
 * price is not known today makes the whole figure unknown rather than smaller.
 */
export function currentLiquidity(
  pool: Pool,
  reserves: LiveReserves | null,
  priceNow: (pool: Pool, address: string) => number | null,
): Pool['liveLiquidity'] {
  const reading = pool.protocol === 'v3' && pool.key ? reserves?.get(pool.id) ?? null : null;
  if (reading && pool.key) {
    const sides: [bigint, string, number][] = [
      [reading.amount0, pool.key.currency0, pool.key.decimals0],
      [reading.amount1, pool.key.currency1, pool.key.decimals1],
    ];
    let usd = 0;
    let known = true;
    for (const [amount, address, decimals] of sides) {
      if (amount === 0n) continue;
      const price = priceNow(pool, address);
      if (price === null || !(price > 0)) {
        known = false;
        break;
      }
      usd += (Number(amount) / 10 ** decimals) * price;
    }
    if (known && usd > 0 && Number.isFinite(usd)) return { usd, source: 'chain', at: new Date(reading.at).toISOString() };
  }
  const quote = pool.market;
  if (
    quote &&
    quote.poolLiquidityUsd !== null &&
    quote.poolLiquidityUsd >= 1 &&
    quote.poolLiquidityPool &&
    quote.poolLiquidityPool.toLowerCase() === pool.address.toLowerCase()
  ) {
    return { usd: quote.poolLiquidityUsd, source: quote.source, at: quote.at };
  }
  return null;
}
