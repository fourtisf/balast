-- Uniswap v4's Swap event carries the TRADER's deltas: the input negative,
-- the output positive (v4-core Pool.sol: `amountSpecified - amountSpecifiedRemaining`
-- is the negative exact-input, `amountCalculated` the positive output). v3's
-- Swap carries the pool's: input positive. The indexer stored v4 rows as
-- emitted and summed them as if they were the pool's, so every v4 pool's
-- reserves fell with its volume — "liquidity —" on exactly the pools that
-- trade — and the fee was attributed to the side the trader RECEIVED.
--
-- Flip the v4 rows to the pool's signs, re-derive the side the fee was taken
-- in, and recompute the fee from the true input: exactly for a static-fee pool
-- (the swap's fee is the pool's), and by proportion for a dynamic-fee pool
-- (flag 0x800000), whose per-swap fee the row does not keep — within a wei of
-- what a fresh sync writes. v3 rows are untouched.
UPDATE swap_events SET amount0 = -amount0, amount1 = -amount1 WHERE pool_id LIKE 'v4:%';

UPDATE swap_events sw
SET fee_token = CASE
      WHEN sw.amount0 > 0 AND sw.amount1 <= 0 THEN 0
      WHEN sw.amount1 > 0 AND sw.amount0 <= 0 THEN 1
      ELSE -1
    END,
    fee_amount = CASE
      WHEN sw.amount0 > 0 AND sw.amount1 <= 0 THEN
        CASE
          WHEN (p.fee_tier & 8388608) = 0 THEN floor(sw.amount0 * p.fee_tier / 1000000)
          WHEN sw.amount1 < 0 THEN floor(sw.fee_amount * sw.amount0 / -sw.amount1)
          ELSE 0
        END
      WHEN sw.amount1 > 0 AND sw.amount0 <= 0 THEN
        CASE
          WHEN (p.fee_tier & 8388608) = 0 THEN floor(sw.amount1 * p.fee_tier / 1000000)
          WHEN sw.amount0 < 0 THEN floor(sw.fee_amount * sw.amount1 / -sw.amount0)
          ELSE 0
        END
      ELSE 0
    END
FROM pools p
WHERE p.id = sw.pool_id AND sw.pool_id LIKE 'v4:%';

-- Every priced table is built from these rows. Forget the anchor they were
-- last rebuilt for, so the indexer's next start rebuilds all of them.
DELETE FROM indexer_state WHERE key = 'rebuilt_anchor';
