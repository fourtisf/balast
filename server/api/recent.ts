/**
 * Today, from the chain: the day's volume, its trade split and the 24h move,
 * out of `recent_swaps` (indexer/head.ts).
 *
 * Every other figure on the board is measured back from the last block the
 * backfill indexed, which during a first sync is weeks ago — honest, labelled,
 * and not what anybody means by "the day's volume". The aggregators patch over
 * it for the tokens they list (§21) and leave the rest on a figure two months
 * old. This is the chain's own answer, for every pool it knows.
 *
 * The arithmetic mirrors `rebuildFeeHourly` exactly, so a pool's live figure
 * and the same pool's figure once the backfill reaches these blocks are the
 * same number computed the same way:
 *
 *   - a swap's volume is the side that ENTERED the pool, at its USD price;
 *   - a token's USD price comes from whichever side of its pool is the quote,
 *     ether through the anchor and USDG at a dollar (§4.3);
 *   - a buy pays the quote for the token, which the fee's side says;
 *   - anything outside a sane bound is dropped rather than carried.
 *
 * What it does NOT do is touch reserves, liquidity, the fee yield or the
 * sparkline. Those are sums over a pool's whole history and a window of
 * recent blocks with a gap behind it cannot contribute to them (§14).
 */

import { CONTRACTS, isEther } from '../../lib/chain';
import { prisma } from '../db';
import { isEtherSql, tradedSide } from '../indexer/aggregate';

export interface RecentMarket {
  /** The day's volume in USD, from the chain's last 24 hours. */
  volume24hUsd: number;
  /** The fees those swaps actually paid, in USD. */
  fees24hUsd: number;
  trades24h: number;
  buys24h: number;
  sells24h: number;
  buyVolume24hUsd: number;
  sellVolume24hUsd: number;
  /** The traded side's price now, and its move over the day. Null with nothing to compare. */
  priceUsd: number | null;
  change24hPct: number | null;
  /** Chain time of the newest swap behind these figures. */
  at: string;
}

/** The newest block time in `recent_swaps`, or null when the follower has written nothing. */
export async function recentHead(): Promise<Date | null> {
  const row = await prisma.recentSwap.aggregate({ _max: { blockTime: true } });
  return row._max.blockTime ?? null;
}

interface Row {
  pool_id: string;
  volume_usd: number;
  fees_usd: number;
  trades: number;
  buys: number;
  sells: number;
  buy_volume_usd: number;
  sell_volume_usd: number;
  price_usd: number | null;
  change_pct: number | null;
  at: Date;
}

/**
 * One row per pool that traded in the last 24 hours of chain time.
 *
 * `usdg` is the anchor's address; ether is priced from the anchor pool's own
 * recent swaps, so this query needs nothing from the indexer's aggregates —
 * which is what lets it be current while they are weeks behind.
 */
export async function recentMarket(usdg: string): Promise<Map<string, RecentMarket>> {
  const out = new Map<string, RecentMarket>();
  const weth = CONTRACTS.weth.toLowerCase();
  const anchor = usdg.toLowerCase();
  if (!/^0x[0-9a-fA-F]{40}$/.test(anchor)) return out;

  const asOf = await recentHead();
  if (asOf === null) return out;

  const ratio = (sqrt: string, dec0: string, dec1: string): string => `(
    (power(${sqrt}::numeric, 2) * power(10::numeric, GREATEST(${dec0} - ${dec1}, 0)))
    / power(2::numeric, 192)
    / power(10::numeric, GREATEST(${dec1} - ${dec0}, 0))
  )`;
  const sane = (expr: string, bound: string): string =>
    `(CASE WHEN (${expr}) IS NOT NULL AND abs(${expr}) < ${bound}::numeric THEN (${expr}) ELSE NULL END)`;

  const sql = `
    WITH params AS (
      SELECT $1::timestamp AS as_of, $1::timestamp - interval '24 hours' AS since
    ),

    -- Ether in dollars, per hour, from the anchor pool's own recent swaps:
    -- the volume-weighted mean of the hour, as weth_usd_hourly takes it.
    anchor_swaps AS (
      SELECT
        date_trunc('hour', s.block_time) AS hour,
        CASE WHEN ${isEtherSql('p.token0', weth)}
             THEN ${ratio('s.sqrt_price_x96', 't0.decimals', 't1.decimals')}
             ELSE 1 / NULLIF(${ratio('s.sqrt_price_x96', 't0.decimals', 't1.decimals')}, 0)
        END AS weth_usd,
        abs(CASE WHEN ${isEtherSql('p.token0', weth)} THEN s.amount1 ELSE s.amount0 END) AS weight
      FROM recent_swaps s
      JOIN pools  p  ON p.id = s.pool_id
      JOIN tokens t0 ON lower(t0.address) = lower(p.token0)
      JOIN tokens t1 ON lower(t1.address) = lower(p.token1)
      WHERE (${isEtherSql('p.token0', weth)} AND lower(p.token1) = '${anchor}')
         OR (lower(p.token0) = '${anchor}' AND ${isEtherSql('p.token1', weth)})
    ),
    anchor_hourly AS (
      SELECT hour, SUM(weth_usd * weight) / NULLIF(SUM(weight), 0) AS weth_usd
      FROM anchor_swaps
      WHERE weth_usd IS NOT NULL AND weight > 0
      GROUP BY hour
    ),
    -- The most recent anchor price, for hours the anchor pool did not trade
    -- in. A quiet hour is not ether becoming worthless.
    anchor_now AS (
      SELECT weth_usd FROM anchor_hourly ORDER BY hour DESC LIMIT 1
    ),

    priced AS (
      SELECT
        s.pool_id,
        s.block_time,
        s.block_num,
        s.log_index,
        s.amount0,
        s.amount1,
        s.fee_amount,
        s.fee_token,
        t0.decimals AS dec0,
        t1.decimals AS dec1,
        ${ratio('s.sqrt_price_x96', 't0.decimals', 't1.decimals')} AS ratio,
        CASE
          WHEN s.fee_token = 0 THEN NOT ${tradedSide({ addr0: 'p.token0', addr1: 'p.token1', weth, usdg: anchor, whenToken0: 'true', whenToken1: 'false', otherwise: 'true' })}
          WHEN s.fee_token = 1 THEN ${tradedSide({ addr0: 'p.token0', addr1: 'p.token1', weth, usdg: anchor, whenToken0: 'true', whenToken1: 'false', otherwise: 'true' })}
          ELSE NULL
        END AS is_buy,
        CASE
          WHEN ${isEtherSql('p.token0', weth)} THEN COALESCE(ah.weth_usd, (SELECT weth_usd FROM anchor_now))
          WHEN lower(p.token0) = '${anchor}' THEN 1::numeric
          ELSE NULL
        END AS quote0_usd,
        CASE
          WHEN ${isEtherSql('p.token1', weth)} THEN COALESCE(ah.weth_usd, (SELECT weth_usd FROM anchor_now))
          WHEN lower(p.token1) = '${anchor}' THEN 1::numeric
          ELSE NULL
        END AS quote1_usd,
        ${tradedSide({ addr0: 'p.token0', addr1: 'p.token1', weth, usdg: anchor, whenToken0: 'true', whenToken1: 'false', otherwise: 'true' })} AS token_is_0
      FROM recent_swaps s
      JOIN pools  p  ON p.id = s.pool_id
      JOIN tokens t0 ON lower(t0.address) = lower(p.token0)
      JOIN tokens t1 ON lower(t1.address) = lower(p.token1)
      LEFT JOIN anchor_hourly ah ON ah.hour = date_trunc('hour', s.block_time)
      CROSS JOIN params pr
      WHERE s.block_time > pr.since AND s.block_time <= pr.as_of
    ),

    usd AS (
      SELECT *,
        ${sane('COALESCE(quote0_usd, CASE WHEN quote1_usd IS NOT NULL THEN ratio * quote1_usd END)', '1e12')} AS price0_usd,
        ${sane('COALESCE(quote1_usd, CASE WHEN quote0_usd IS NOT NULL AND ratio > 0 THEN quote0_usd / ratio END)', '1e12')} AS price1_usd
      FROM priced
    ),

    valued AS (
      SELECT *,
        CASE
          WHEN amount0 > 0 THEN amount0 / power(10::numeric, dec0) * COALESCE(price0_usd, 0)
          WHEN amount1 > 0 THEN amount1 / power(10::numeric, dec1) * COALESCE(price1_usd, 0)
          ELSE 0
        END AS volume_usd,
        -- The fee each swap actually paid, in the token it was taken in, at
        -- that token's USD price — rebuildFeeHourly's own expression, so a
        -- pool's fees today and its fees once the backfill arrives are one
        -- number reached twice. Never volume x tier: a dynamic-fee pool's
        -- per-swap fee is not its key's fee, and on this chain a hook can
        -- take most of a trade (§20).
        CASE
          WHEN fee_token = 0 THEN fee_amount / power(10::numeric, dec0) * COALESCE(price0_usd, 0)
          WHEN fee_token = 1 THEN fee_amount / power(10::numeric, dec1) * COALESCE(price1_usd, 0)
          ELSE 0
        END AS fees_usd,
        CASE WHEN token_is_0 THEN price0_usd ELSE price1_usd END AS token_usd
      FROM usd
    ),

    -- The traded side's price at each end of the window, for the 24h move.
    edges AS (
      SELECT
        pool_id,
        (array_agg(token_usd ORDER BY block_num DESC, log_index DESC)
           FILTER (WHERE token_usd IS NOT NULL))[1] AS price_now,
        (array_agg(token_usd ORDER BY block_num ASC, log_index ASC)
           FILTER (WHERE token_usd IS NOT NULL))[1] AS price_then,
        MAX(block_time) AS at
      FROM valued
      GROUP BY pool_id
    )

    SELECT
      v.pool_id,
      COALESCE(${sane('SUM(v.volume_usd)', '1e15')}, 0)::float8              AS volume_usd,
      COALESCE(${sane('SUM(v.fees_usd)', '1e15')}, 0)::float8                AS fees_usd,
      COUNT(*)::int                                                          AS trades,
      COUNT(*) FILTER (WHERE v.is_buy)::int                                  AS buys,
      COUNT(*) FILTER (WHERE v.is_buy = false)::int                          AS sells,
      COALESCE(${sane('SUM(v.volume_usd) FILTER (WHERE v.is_buy)', '1e15')}, 0)::float8        AS buy_volume_usd,
      COALESCE(${sane('SUM(v.volume_usd) FILTER (WHERE v.is_buy = false)', '1e15')}, 0)::float8 AS sell_volume_usd,
      e.price_now::float8                                                    AS price_usd,
      CASE
        WHEN e.price_now IS NULL OR e.price_then IS NULL OR e.price_then = 0 THEN NULL
        ELSE ((e.price_now / e.price_then) - 1) * 100
      END::float8                                                            AS change_pct,
      e.at
    FROM valued v
    JOIN edges e ON e.pool_id = v.pool_id
    GROUP BY v.pool_id, e.price_now, e.price_then, e.at
  `;

  const rows = await prisma.$queryRawUnsafe<Row[]>(sql, asOf);
  for (const row of rows) {
    out.set(row.pool_id, {
      volume24hUsd: row.volume_usd,
      fees24hUsd: row.fees_usd,
      trades24h: row.trades,
      buys24h: row.buys,
      sells24h: row.sells,
      buyVolume24hUsd: row.buy_volume_usd,
      sellVolume24hUsd: row.sell_volume_usd,
      priceUsd: row.price_usd,
      change24hPct: row.change_pct,
      at: row.at.toISOString(),
    });
  }
  return out;
}

/** Ether's dollar price now, from the anchor pool's own recent swaps. Null when none. */
export async function recentEthPrice(usdg: string): Promise<{ usd: number; at: string } | null> {
  const weth = CONTRACTS.weth.toLowerCase();
  const anchor = usdg.toLowerCase();
  if (!/^0x[0-9a-fA-F]{40}$/.test(anchor) || isEther(anchor)) return null;
  const ratio = `(
    (power(s.sqrt_price_x96::numeric, 2) * power(10::numeric, GREATEST(t0.decimals - t1.decimals, 0)))
    / power(2::numeric, 192)
    / power(10::numeric, GREATEST(t1.decimals - t0.decimals, 0))
  )`;
  const rows = await prisma.$queryRawUnsafe<{ usd: number | null; at: Date }[]>(`
    SELECT
      (CASE WHEN ${isEtherSql('p.token0', weth)} THEN ${ratio} ELSE 1 / NULLIF(${ratio}, 0) END)::float8 AS usd,
      s.block_time AS at
    FROM recent_swaps s
    JOIN pools  p  ON p.id = s.pool_id
    JOIN tokens t0 ON lower(t0.address) = lower(p.token0)
    JOIN tokens t1 ON lower(t1.address) = lower(p.token1)
    WHERE (${isEtherSql('p.token0', weth)} AND lower(p.token1) = '${anchor}')
       OR (lower(p.token0) = '${anchor}' AND ${isEtherSql('p.token1', weth)})
    ORDER BY s.block_num DESC, s.log_index DESC
    LIMIT 1
  `);
  const row = rows[0];
  if (!row || row.usd === null || !(row.usd > 0) || !Number.isFinite(row.usd)) return null;
  return { usd: row.usd, at: row.at.toISOString() };
}
