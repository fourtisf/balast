-- Buys and sells, the way a trader reads a pool: a swap that pays the quote
-- (ether or USDG) and takes the token is a buy, the reverse a sell. Both are
-- derived from the swap rows already in the tables — the side the fee was
-- taken in says which — so the split is the chain's, not an aggregator's,
-- and matches theirs once the sync reaches the same day.
ALTER TABLE "pool_fee_hourly"
  ADD COLUMN "buys"            INTEGER       NOT NULL DEFAULT 0,
  ADD COLUMN "sells"           INTEGER       NOT NULL DEFAULT 0,
  ADD COLUMN "buy_volume_usd"  DECIMAL(38,18) NOT NULL DEFAULT 0,
  ADD COLUMN "sell_volume_usd" DECIMAL(38,18) NOT NULL DEFAULT 0;

-- Filled by the fee-hours rebuild: forget the anchor marker so the next
-- start rebuilds every hour with the split.
DELETE FROM indexer_state WHERE key = 'rebuilt_anchor';
