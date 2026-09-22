/**
 * The contract between the UI and whatever is producing the numbers.
 *
 * P0 satisfies it with SimProvider (generated data, §8). P1 swaps in an
 * indexer-backed provider and nothing above this file changes — that is the
 * whole point of §4's rule: no component imports data directly.
 */

export type Quote = 'ETH' | 'USDG';
export type Protocol = 'v4' | 'v3';
export type ShapeId = 'spot' | 'curve' | 'bidask';

export interface TokenMeta {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  /** Brand colour from token metadata. Data, not a design decision (§5). */
  logoColor: string;
  /**
   * Logo image, when a token list supplied one.
   *
   * §4 permits external sources for logos and metadata but not for numbers,
   * so this is the one field on this type that did not come from a node. The
   * colour above is always present and is what renders without it.
   */
  logoUrl?: string;
  /** Launchpad that minted it, when it came from one. */
  launchpad?: string;
}

/**
 * Fee yield, trailing. Never forward, never annualised from a single day
 * without saying so (§1, §7). The provider decides which case applies; the
 * component only renders it.
 */
export type FeeYield =
  /** Fewer than 24h of data. Display "—", never a number (§7). */
  | { basis: 'insufficient' }
  /** Pool younger than 7d: annualised over what exists, labelled est. + age. */
  | { basis: 'estimate'; pct: number; windowHours: number }
  /** The real thing: fees_7d / tvl_now * 365/7. */
  | { basis: 'trailing7d'; pct: number };

/**
 * A v4 pool's identity on chain: what PositionManager needs to mint into it.
 *
 * `currency0 < currency1` by address, native ether as the zero address, fee
 * in hundredths of a bip (pips), hooks as the zero address for none. The
 * decimals ride along because both sides are needed to size a deposit.
 */
export interface PoolKeyInfo {
  currency0: string;
  currency1: string;
  fee: number;
  tickSpacing: number;
  hooks: string;
  decimals0: number;
  decimals1: number;
}

/**
 * A live market figure for a TOKEN, beside the chain's own figures.
 *
 * The owner's exception to §4 (CLAUDE.md §20, §21): during a first sync the
 * chain's figures are weeks old, and the board shows today's from an
 * aggregator instead, labelled. Only what is named here is taken from one;
 * nothing that prices the site — not the anchor, not the reserves, not the
 * fees, not the yield. Absent (undefined) on simulated data; null when no
 * aggregator has a fresh quote for the token, in which case the chain's
 * figure shows, labelled as the chain's.
 *
 * The figures are the token's across every pair the source lists on this
 * chain, not one pool's. A token here routinely has several pools, and a
 * quote taken from one of them was the defect this shape replaced: NVDA read
 * $17.9K of volume off a shallow v4 pair while its own page summed several.
 */
export interface MarketQuote {
  /** Which aggregator answered. The row and the drawer name it. */
  source: MarketSourceName;
  chainId: string;
  /** How many pairs on this chain the summed figures cover. */
  pairs: number;
  /** The deepest pair: what the price, the change and the cap are read from. */
  dexId: string;
  pairAddress: string;
  url: string;
  priceUsd: number | null;
  /** The token's day, summed over its pairs on this chain. */
  volume24hUsd: number;
  /** Trade counts over 24h, summed. Null from a source that does not split them. */
  buys24h: number | null;
  sells24h: number | null;
  /** From the deepest pair — the one whose price is worth reading. */
  priceChange24hPct: number | null;
  /** The token's liquidity on this chain: summed over its pairs. */
  liquidityUsd: number | null;
  /** The row's own pool, when the source lists that pair. Null when it does not. */
  poolLiquidityUsd: number | null;
  fdvUsd: number | null;
  marketCapUsd: number | null;
  /** When it was fetched, ISO. */
  at: string;
}

export type MarketSourceName = 'dexscreener' | 'geckoterminal';

export interface Pool {
  id: string;
  address: string;
  token: TokenMeta;
  quote: Quote;
  feeTierBps: number;
  /**
   * Present for a live v4 pool, so /positions can mint into it through
   * Uniswap's PositionManager. Absent for v3 pools and for simulated ones,
   * which have nothing on chain to mint into.
   */
  key?: PoolKeyInfo;
  protocol: Protocol;
  /** Pre-graduation launchpad liquidity is listed but cannot be staked (§4). */
  stakeable: boolean;
  ageHours: number;

  priceUsd: number;
  /**
   * Market cap: circulating supply × price.
   *
   * The live indexer's circulating figure is total supply less what the
   * chain shows cannot circulate — the burn addresses' balances and the
   * token contract's own. Vesting and treasury holdings cannot be told
   * apart on chain, so this can overstate, never understate, and the row's
   * tooltip says so (§7). Zero when it could not be derived; the row then
   * shows `fdvUsd` alone, labelled, or an em dash when that is zero too.
   */
  marketCapUsd: number;
  /** Fully diluted: total supply × price. Zero when the supply has not been read. */
  fdvUsd: number;
  tvlUsd: number;
  /**
   * Null when there is no price 24h ago to compare with — a pool younger
   * than a day, or an anchor that did not exist yet. Rendered as an em dash;
   * coercing it to zero painted "+0.0%" in green over an unknown (§7).
   */
  change24hPct: number | null;
  fees24hUsd: number;
  /** Fees over the trailing 7d, or over the pool's whole life if younger. */
  feesWindowUsd: number;
  feeWindowHours: number;
  volume24hUsd: number;
  trades24h: number;
  /**
   * The split a trader reads: a swap that pays the quote for the token is a
   * buy, the reverse a sell. Derived from the same swaps as the volume, so
   * buys + sells is the volume and buys24h + sells24h is trades24h.
   */
  buyVolume24hUsd: number;
  sellVolume24hUsd: number;
  buys24h: number;
  sells24h: number;
  /** 14 buckets of recent fee revenue: the masthead's chart. */
  feeHistory: number[];
  /** The same 14 buckets of volume: the row's sparkline, since the row shows volume. */
  volumeHistory: number[];
  /** See MarketQuote. */
  market?: MarketQuote | null;
  feeYield: FeeYield;
}

export interface Vault {
  id: string;
  poolId: string;
  address: string;
  totalStakedUsd: number;
  stakers: number;
  /** WETH per second currently streaming out of the 7-day window. */
  rewardRate: number;
  nextHarvestInSeconds: number;
  protocolFeeBps: number;
}

export interface UserStake {
  vaultId: string;
  poolId: string;
  stakedUsd: number;
  earnedWeth: number;
  /** 0–100, how far through the 7-day stream this position is. */
  streamProgressPct: number;
  streamRemainingSeconds: number;
}

/**
 * What a live position carries beyond the simulator's shape: enough to
 * render, value and manage it without its pool being on the board. A
 * position's pool can sit below the listing bar and still be someone's.
 */
export interface LivePosition {
  /** The pool's key, for the collect and withdraw transactions. */
  key: PoolKeyInfo;
  poolAddress: string;
  protocol: Protocol;
  feeTierBps: number;
  token: TokenMeta;
  quote: Quote;
  /** The quote side's address (ether as the zero address, or the wrapper, or USDG). */
  quoteAddress: string;
  quoteDecimals: number;
  tokenIsCurrency0: boolean;
  tickLower: number;
  tickUpper: number;
  /** Raw units, as decimal strings: JSON carries no bigint. */
  liquidity: string;
  amount0: string;
  amount1: string;
  /** What the net principal put in would be worth today, in USD. */
  holdUsd: number;
  /**
   * Each currency's USD price at the last indexed block — the same one path
   * the value above was priced through (§4.3) — so the page can value what
   * it reads from the chain (uncollected fees) in the same dollars.
   */
  priceUsd0: number;
  priceUsd1: number;
  mintedAt: string | null;
}

export interface UserPosition {
  tokenId: string;
  poolId: string;
  /** The shape chosen at mint. The simulator knows it; a live position's is not on chain. */
  shape?: ShapeId;
  /** Half-width of a symmetric range, in percent — the simulator's figure. */
  rangePct: number;
  /** The range around the token's price, or the whole line. */
  range?: { minPct: number; maxPct: number } | 'full';
  inRange: boolean;
  /** Set when inRange is false: how long it has been earning nothing. */
  outOfRangeSinceHours?: number;
  valueUsd: number;
  /** Simulated data only: fees in WETH. A live position's fees are read from the chain by the page. */
  feesWeth?: number;
  /** Price impact on holdings for this one position (§7). Negative when the position is worth less than holding. */
  priceImpactUsd?: number;
  live?: LivePosition;
}

export interface Portfolio {
  netValueUsd: number;
  netChangeUsd: number;
  netChangePct: number;
  /** Null when the site cannot know it: the live portfolio reads uncollected fees from the chain, not history. */
  feesEarnedWeth: number | null;
  feesEarnedUsd: number | null;
  /** Impermanent loss, under its honest name (§7). Negative. */
  priceImpactUsd: number;
  fees7dUsd: number | null;
  /** 56 days of WETH fees, oldest first. Empty when not tracked. */
  dailyFeesWeth: number[];
  stakes: UserStake[];
  positions: UserPosition[];
  claimableWeth: number;
  /** Live: the wallet these positions belong to. */
  wallet?: string | null;
}

export interface GlobalStats {
  totalPositions: number;
  totalFeesUsd: number;
  tvlUsd: number;
  ethPriceUsd: number;
  /**
   * Where the ETH figure came from: an aggregator's quote for the wrapper,
   * live, or the chain's anchor price at the last indexed block. Absent on
   * simulated data. The masthead labels it, because during a sync the two
   * are weeks apart (§7).
   */
  ethPriceBasis?: 'live' | 'chain';
  ethPriceSource?: MarketSourceName;
  /** When that price was read, ISO. */
  ethPriceAt?: string;
}

export interface Payout {
  id: string;
  poolId: string;
  weth: number;
  wallet: string;
}

export interface FeaturedStats {
  fees24hUsd: number;
  change24hPct: number;
  volume24hUsd: number;
  liquidityUsd: number;
  stakers: number;
  chainSharePct: number;
  /** 14 points, for the full-bleed area chart. */
  history: number[];
}

export interface RouterPlan {
  tokenSymbol: string;
  feeSourceAddress: string;
  accruedWeth: number;
  accruedUsd: number;
  currentDepthUsd: number;
  projectedDepthUsd: number;
  /** Slippage on a $5K buy, now and after 30 days at the current fee rate. */
  slippageNowPct: number;
  slippageLaterPct: number;
  firstRouteWeth: number;
  firstRouteDepthUsd: number;
  twapMinutes: number;
}

export interface MarketSnapshot {
  pools: Pool[];
  vaults: Vault[];
  portfolio: Portfolio;
  global: GlobalStats;
  featured: FeaturedStats;
  router: RouterPlan;
  /** Last few fee payouts, newest first. */
  payouts: Payout[];
  payoutTotalUsd: number;
  /** How far behind head the indexer is. Shown in the top bar (§7). */
  indexerLagSeconds: number;
  /** Monotonic counter so consumers can cheaply detect a new snapshot. */
  revision: number;
  /**
   * When this snapshot was built, ISO. `indexerLagSeconds` is as of then: a
   * snapshot served or restored later has the time since added to it, so a
   * page never shows a stale board as fresher than it is (§7). Absent on
   * simulated data.
   */
  builtAt?: string;
}

export type MarketListener = (snapshot: MarketSnapshot) => void;
export type Unsubscribe = () => void;

export type ProviderKind = 'sim' | 'live';

export interface DataProvider {
  readonly kind: ProviderKind;
  /** Latest snapshot, or null if none has arrived yet (live, pre-connect). */
  getSnapshot(): MarketSnapshot | null;
  /** Push deltas. The returned function detaches and may stop the stream. */
  subscribe(listener: MarketListener): Unsubscribe;
  /** The wallet whose positions the portfolio should carry. The simulator has no wallet and ignores it. */
  setWallet?(address: string | null): void;
  /** Re-read the wallet's positions now — after a mint, a collect or a withdrawal. */
  refreshPortfolio?(): Promise<void>;
}
