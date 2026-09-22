-- The last day of swaps, read from the chain's head while the backfill is
-- still weeks behind it.
--
-- The indexer reads the chain in order from `START_BLOCK`, which is correct
-- and, on a chain of sixty million blocks, slow: every figure on the board is
-- a day two months old, and an aggregator only patches over the tokens it
-- happens to list. This table is the other half — the chain's own answer for
-- the one question that has to be current, which is what traded today.
--
-- It is deliberately NOT part of the indexer's pipeline. Reserves are the sum
-- of a pool's whole event history, so a window of recent blocks with a gap
-- behind it cannot contribute to them without making every liquidity figure
-- wrong; §9's replay proof rests on the same completeness. So these rows feed
-- the day's volume, its trade split and the 24h price move, and nothing else.
-- When the backfill reaches these blocks it writes them into `swap_events` as
-- usual, and this table is pruned behind the window.
CREATE TABLE "recent_swaps" (
  "tx_hash"        TEXT           NOT NULL,
  "log_index"      INTEGER        NOT NULL,
  "pool_id"        TEXT           NOT NULL,
  "block_num"      BIGINT         NOT NULL,
  "block_time"     TIMESTAMP(3)   NOT NULL,
  "amount0"        DECIMAL(78,0)  NOT NULL,
  "amount1"        DECIMAL(78,0)  NOT NULL,
  "sqrt_price_x96" DECIMAL(78,0)  NOT NULL,
  "fee_amount"     DECIMAL(78,0)  NOT NULL,
  "fee_token"      INTEGER        NOT NULL,

  CONSTRAINT "recent_swaps_pkey" PRIMARY KEY ("tx_hash","log_index")
);

-- No foreign key to `pools` on purpose: the head runs ahead of the backfill,
-- so it meets pools the indexer has not created yet. Their rows are kept and
-- simply do not join until the backfill names the pool.
CREATE INDEX "recent_swaps_block_time_idx" ON "recent_swaps" ("block_time");
CREATE INDEX "recent_swaps_pool_time_idx"  ON "recent_swaps" ("pool_id", "block_time");
