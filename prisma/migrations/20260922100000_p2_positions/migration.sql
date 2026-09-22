-- Positions minted through Uniswap's PositionManager (§20, §22).
--
-- PositionManager is an ERC-721 whose token IS the position. Its Transfer
-- log says who holds each token; the PoolManager's ModifyLiquidity log,
-- emitted with `sender = PositionManager` and `salt = bytes32(tokenId)`, says
-- which pool, which range, and how much liquidity. Both are raw rows keyed by
-- log coordinates, and `positions` is REBUILT from them, never incremented,
-- like every other aggregate (§14).

-- The salt a v4 liquidity change carries. For a PositionManager position it
-- is bytes32(tokenId), which is what ties the position to its own events.
ALTER TABLE "liquidity_events" ADD COLUMN "salt" TEXT;
CREATE INDEX "liquidity_events_salt_idx" ON "liquidity_events"("salt");

CREATE TABLE "position_transfers" (
  "tx_hash"    TEXT           NOT NULL,
  "log_index"  INTEGER        NOT NULL,
  "token_id"   DECIMAL(78,0)  NOT NULL,
  "salt"       TEXT           NOT NULL,
  "from_addr"  TEXT           NOT NULL,
  "to_addr"    TEXT           NOT NULL,
  "block_num"  BIGINT         NOT NULL,
  "block_time" TIMESTAMP(3)   NOT NULL,
  CONSTRAINT "position_transfers_pkey" PRIMARY KEY ("tx_hash", "log_index")
);
CREATE INDEX "position_transfers_salt_block_num_log_index_idx" ON "position_transfers"("salt", "block_num", "log_index");
CREATE INDEX "position_transfers_to_addr_idx" ON "position_transfers"("to_addr");
CREATE INDEX "position_transfers_block_num_idx" ON "position_transfers"("block_num");

-- What the position rebuild fills in beyond §4's sketch: the net principal
-- deposited (for "price impact on holdings", §7) and when it was minted.
ALTER TABLE "positions"
  ADD COLUMN "deposited0"   DECIMAL(78,0) NOT NULL DEFAULT 0,
  ADD COLUMN "deposited1"   DECIMAL(78,0) NOT NULL DEFAULT 0,
  ADD COLUMN "minted_block" BIGINT,
  ADD COLUMN "minted_at"    TIMESTAMP(3);
CREATE INDEX "positions_status_idx" ON "positions"("status");
