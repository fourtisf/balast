import type { DataProvider, MarketListener, MarketSnapshot, Unsubscribe } from './types';

/**
 * P1. Reads the indexer described in §4 — log poller, fee attribution in
 * `pool_fee_hourly`, prices derived from `sqrtPriceX96` anchored to WETH, and
 * a websocket pushing deltas debounced to ~1s per pool.
 *
 * It is deliberately a stub: DATA_SOURCE=live must fail loudly rather than
 * quietly render simulated numbers as if they came off-chain.
 */
export class LiveProvider implements DataProvider {
  readonly kind = 'live' as const;

  getSnapshot(): MarketSnapshot | null {
    throw new Error('LiveProvider: not implemented (P1). Set DATA_SOURCE=sim.');
  }

  subscribe(_listener: MarketListener): Unsubscribe {
    throw new Error('LiveProvider: not implemented (P1). Set DATA_SOURCE=sim.');
  }
}
