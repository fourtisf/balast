-- The quote side of a pool's reserves, in dollars: the ether or USDG actually
-- sitting in it.
--
-- `tvl_usd` values BOTH sides at their own prices, and the token side's price
-- is derived from the pool's own ratio — so for a pool that holds most of a
-- token's supply, the token side's dollar value IS the token's fully diluted
-- value, and `tvl_usd` comes out equal to it. That is the artifact the board
-- showed: several launchpad tokens at an identical "MC $38.88M" beside an
-- identical "liquidity $38.88M", each pool holding a whole standard supply at
-- the launch tick with dust on the quote side. Nobody had paid any of it.
--
-- The quote side is the one figure that is not circular: ether and USDG are
-- priced outside the pool (§4.3), so this is how many dollars a swap can
-- actually take out of it, and it is what says whether a price — and the
-- market cap resting on it — is backed by anything.
-- Nullable, with no default, and that is the point: NULL means the rebuild
-- has not reached this pool yet, and zero means it has and the pool really
-- holds no quote. The listing bar below reads them differently — unknown is
-- never held against a pool (§14) — so a deploy does not thin the board for
-- as long as the rebuild takes. A default of zero would have unlisted every
-- pool on the box the moment this landed.
ALTER TABLE "pool_state"
  ADD COLUMN "quote_tvl_usd" DECIMAL(38,18);

-- Filled by the pool-state rebuild: forget the anchor marker so the next
-- start rebuilds every pool's state with the column.
DELETE FROM indexer_state WHERE key = 'rebuilt_anchor';
