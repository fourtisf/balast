/**
 * Which of a token's markets the position builder offers, and in what order.
 *
 * A token routinely has several pools on this chain — a different quote
 * currency, a different fee tier, a v3 pool beside a v4 one (§26). The board
 * shows one row per token; the builder has to show the markets, because the
 * pair is most of what a person is choosing there. These two rules decide
 * which of them it may offer and which it opens on.
 */

import type { Pool } from './data/types';
import { quoteIsNativeEther } from './format';

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
 * Order a token's markets: the chain's own ether first, then the deepest.
 *
 * ALFA's rule is that a pair is entered with Robinhood Chain's ether rather
 * than with the aeWETH wrapper. The difference is not cosmetic — a native
 * market spends the balance the wallet already shows, a wrapped one needs
 * an ERC-20 the wallet probably does not hold — so the native market goes
 * in front and is the one the builder opens on. Everything after it keeps
 * depth order, since the deepest market is the one the board's own row is.
 */
export function byEntryCurrency(a: Pool, b: Pool): number {
  return (
    Number(quoteIsNativeEther(b)) - Number(quoteIsNativeEther(a)) ||
    b.tvlUsd - a.tvlUsd ||
    a.feeTierBps - b.feeTierBps
  );
}
