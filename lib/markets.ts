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
 * Balast deploys no contract of its own and mints through Uniswap v4's
 * PositionManager (§20), so only a v4 pool — one with a `key` — can be
 * minted into. `key` is absent for a v3 pool and for a simulated one, and
 * the two were treated alike: on the live site, picking a token's v3 market
 * dropped the builder into its simulated branch, showing a stand-in balance
 * of "Max 4.18" over a wallet it had never read and a Mint button whose only
 * effect was a toast saying nothing had been minted. A fabricated balance
 * and a button that does nothing is what §7 exists to prevent, and on
 * mainnet it is worse than an empty state.
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
 * Deliberately the pool's figure and never the token's. An aggregator can
 * answer "how much liquidity does this token have across its pairs", which
 * is the same number for every pool of that token and therefore ranks none
 * of them. §14's rule holds: unknown is null, not zero, because a pool whose
 * reserves the indexer cannot reconstruct is not an empty pool.
 */
export function poolLiquidityUsd(pool: Pool): number | null {
  if (pool.tvlUsd > 0) return pool.tvlUsd;
  const live = pool.market?.poolLiquidityUsd;
  return live !== null && live !== undefined && live > 0 ? live : null;
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
