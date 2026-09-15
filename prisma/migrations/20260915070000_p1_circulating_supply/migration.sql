-- Market cap, from the chain and nothing else.
--
-- The board showed only a fully diluted value, because circulating supply is
-- not a figure a contract reports. What a contract does report is where the
-- tokens are: the balances of the burn addresses (0x0, 0xdEaD) and of the
-- token contract itself are tokens that cannot circulate, and total supply
-- less those is a circulating figure derived from on-chain reads alone (§4).
-- Vesting and treasury holdings cannot be told apart on chain, so the market
-- cap built on it can still overstate, never understate; the row says so.
ALTER TABLE "tokens" ADD COLUMN "non_circulating" DECIMAL(78,0);
ALTER TABLE "pool_state" ADD COLUMN "circ_mc_usd" DECIMAL(38,18) NOT NULL DEFAULT 0;
