/**
 * Which of a token's markets the position builder offers, and how they are
 * arranged.
 *
 * A token routinely has several pools on this chain — a different quote
 * currency, a different fee tier, a v3 pool beside a v4 one (§26). The board
 * shows one row per token; the builder has to show the markets, because the
 * pair is most of what a person is choosing there.
 */

import type { Pool } from './data/types';
import { quoteIsNativeEther, quoteLabel } from './format';

/**
 * A pool this site can actually mint a position into.
 *
 * Balast deploys no contract of its own (§20) and mints through Uniswap's
 * own periphery — v4 through the PositionManager, **v3 through the
 * NonfungiblePositionManager**, both deployed on this chain. So a pool needs
 * a key, which every live pool now has, and a hook Balast has verified.
 *
 * v3 was excluded for one commit, and it was a gap in what had been built
 * rather than a fact about the chain: a token's ether market here is often a
 * v3 pool, so VIRTUAL and CASHCAT were offered their USDG market and nothing
 * else. Before that the two were not even distinguished from a simulated
 * pool, which dropped the builder into its simulated branch on the live
 * site — a stand-in balance over a wallet it had never read, and a Mint
 * button whose only effect was a toast saying nothing had been minted.
 *
 * `live` is false for simulated data, where no pool has a key and the
 * builder's own simulated branch is the honest one.
 */
export function isMintable(pool: Pool, live: boolean): boolean {
  return pool.stakeable && (!live || Boolean(pool.key));
}

/**
 * This pool's own liquidity in dollars, or null when it is not known.
 *
 * **The chain's figure and nothing else.** An aggregator's quote is fetched
 * once per token and attached to every pool of it, so `market.liquidityUsd`
 * is the token summed across its pairs and `market.poolLiquidityUsd` is the
 * one pair the source picked — the board's row. Neither distinguishes this
 * pool from its siblings, which is the only thing this function is for.
 *
 * Taking the latter looked right and put the same figure on four of
 * CASHCAT's six ether pools: `0.46% $5.42M`, `0.66% $5.42M`, `0.96% $5.42M`,
 * `3% $5.42M`, a number belonging to none of them, ranked above the 2% pool
 * whose real depth the chain gives as $325.4K. The comment above this
 * function already said not to; the field name is what made it look like a
 * pool's figure.
 *
 * §14's rule holds: unknown is null, not zero. A pool whose reserves the
 * indexer cannot reconstruct is not an empty pool, and the builder draws
 * that as a dash and says why.
 */
export function poolLiquidityUsd(pool: Pool): number | null {
  return pool.tvlUsd > 0 ? pool.tvlUsd : null;
}

/** Deepest first, then the cheaper tier; an unknown depth sorts last. */
function byDepth(a: Pool, b: Pool): number {
  return (
    (poolLiquidityUsd(b) ?? -1) - (poolLiquidityUsd(a) ?? -1) ||
    a.feeTierBps - b.feeTierBps ||
    // Both are named ETH (§27), so this only settles which is picked first:
    // the native one, whose balance the wallet already shows.
    Number(quoteIsNativeEther(b)) - Number(quoteIsNativeEther(a))
  );
}

export interface QuoteGroup {
  /** `ETH`, `USDG` — what the pair is called (§27). */
  label: string;
  /** This quote's pools, deepest first. */
  markets: Pool[];
}

/**
 * A token's markets, grouped by what a wallet pays with.
 *
 * The builder asked one compound question and CASHCAT showed what that
 * costs: twelve pills reading `ETH · 2%`, `ETH · 0.5%`, `ETH · 0.46%`,
 * `ETH · 0.66%`, `ETH · 0.96%`, `ETH · 3%`, and six more in USDG. Uniswap
 * v4 lets a pool carry any fee its key names, so on a launchpad chain those
 * tiers are real and arbitrary — and a row of near-identical labels is not a
 * choice, it is noise.
 *
 * There are two questions, as there were for the token and the market (§26).
 * **Which currency do I pay with** decides whether the wallet can enter at
 * all, and there are only ever two or three answers. **Which pool** decides
 * what the position earns, and it is answerable only with the pool's own
 * liquidity beside it — which is why the fee tier is a control of its own,
 * ordered by depth, with that figure on each option.
 *
 * The ether group leads, per ALFA's rule that a pair is entered with this
 * chain's own ether (§27); everything after it is ordered by its deepest
 * pool.
 */
export function quoteGroups(markets: Pool[]): QuoteGroup[] {
  const byQuote = new Map<string, Pool[]>();
  for (const market of markets) {
    const label = quoteLabel(market);
    const list = byQuote.get(label);
    if (list) list.push(market);
    else byQuote.set(label, [market]);
  }
  return [...byQuote.entries()]
    .map(([label, list]) => ({ label, markets: list.slice().sort(byDepth) }))
    .sort(
      (a, b) =>
        Number(b.label === 'ETH') - Number(a.label === 'ETH') ||
        (poolLiquidityUsd(b.markets[0]) ?? -1) - (poolLiquidityUsd(a.markets[0]) ?? -1) ||
        a.label.localeCompare(b.label),
    );
}

/**
 * The same markets flat, in the order the groups put them.
 *
 * `[0]` is what the builder opens on and what the drawer hands over when the
 * row's own pool cannot be minted into: the ether group's deepest pool.
 */
export function orderMarkets(markets: Pool[]): Pool[] {
  return quoteGroups(markets).flatMap((g) => g.markets);
}
