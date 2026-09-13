import { PROTOCOL_FEE_BPS, REWARD_WINDOW_SECONDS } from '../chain';
import { mulberry32, SIM_SEED, type Rng } from '../rng';
import { computeFeeYield, yieldPct } from '../yield';
import {
  SEED_FEATURED,
  SEED_GLOBAL,
  SEED_POOLS,
  SEED_ROUTER,
  SEED_VAULT_SYMBOLS,
  quoteFor,
  type SeedPool,
} from './seed';
import type {
  DataProvider,
  MarketListener,
  MarketSnapshot,
  Payout,
  Pool,
  Portfolio,
  Unsubscribe,
  Vault,
} from './types';

/** The prototype's market tick. Production pushes on real events (§4). */
const MARKET_TICK_MS = 3200;
/**
 * The simulated clock runs fast: each tick advances six hours of chain time.
 * A trailing-7d figure is deliberately slow-moving — at real-time speed the
 * boards would never reorder, and P0 has to show the reorder. Six hours a tick
 * rolls the whole window in about a minute and a half of watching.
 */
const SIM_HOURS_PER_TICK = 6;
const SIM_SECONDS_PER_TICK = SIM_HOURS_PER_TICK * 3600;
/** Fee payouts arrive on their own cadence. */
const PAYOUT_TICK_MS = 2600;

function addr(rng: Rng): string {
  let s = '0x';
  for (let i = 0; i < 40; i++) s += Math.floor(rng() * 16).toString(16);
  return s;
}

/**
 * P0 data source. Reproduces the prototype's generated market, including the
 * 3.2s tick, and computes every derived figure — fee yield above all — here
 * rather than in a component, so P1 can move the same maths into SQL.
 */
export class SimProvider implements DataProvider {
  readonly kind = 'sim' as const;

  private rng: Rng;
  private pools: Pool[];
  private vaults: Vault[];
  private portfolio: Portfolio;
  private router = { ...SEED_ROUTER };
  private global = { ...SEED_GLOBAL };
  private featuredHistory: number[];
  private payouts: Payout[] = [];
  private payoutTotalUsd = 0;
  private lagSeconds = 1.2;
  private ticks = 0;
  private revision = 0;

  private listeners = new Set<MarketListener>();
  private marketTimer: ReturnType<typeof setInterval> | null = null;
  private payoutTimer: ReturnType<typeof setInterval> | null = null;
  private snapshot: MarketSnapshot;

  constructor(seed = SIM_SEED) {
    this.rng = mulberry32(seed);
    this.pools = SEED_POOLS.map((s) => this.buildPool(s));
    this.vaults = this.buildVaults();
    const fees24h = this.pools.reduce((a, p) => a + p.fees24hUsd, 0);
    this.featuredHistory = Array.from({ length: 14 }, (_, i) =>
      fees24h * (0.55 + (i / 13) * 0.5) * (0.9 + this.rng() * 0.2),
    );
    this.portfolio = this.buildPortfolio();
    // Seed the payout feed so the first paint is not an empty box.
    for (let i = 0; i < 5; i++) this.pushPayout();
    this.snapshot = this.compose();
  }

  getSnapshot(): MarketSnapshot {
    return this.snapshot;
  }

  subscribe(listener: MarketListener): Unsubscribe {
    this.listeners.add(listener);
    listener(this.snapshot);
    this.start();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.stop();
    };
  }

  // ---------------------------------------------------------------- build --

  private buildPool(s: SeedPool): Pool {
    const rng = this.rng;
    const ageHours = s.ageHours;
    // Fees over the trailing 7d, or over the pool's whole life if it is younger.
    const windowHours = Math.min(ageHours, 168);
    const feesWindowUsd = (s.fees24hUsd * windowHours) / 24 * (0.82 + rng() * 0.32);
    return {
      id: `${s.symbol}-WETH`,
      address: addr(rng),
      token: {
        address: addr(rng),
        symbol: s.symbol,
        name: s.name,
        decimals: 18,
        logoColor: s.logoColor,
        launchpad: s.launchpad,
      },
      quote: quoteFor(s.kind),
      feeTierBps: 30,
      protocol: s.protocol ?? 'v4',
      stakeable: s.stakeable ?? true,
      ageHours,
      priceUsd: s.priceUsd,
      marketCapUsd: s.marketCapUsd,
      tvlUsd: s.tvlUsd,
      change24hPct: s.change24hPct,
      fees24hUsd: s.fees24hUsd,
      feesWindowUsd,
      feeWindowHours: windowHours,
      volume24hUsd: s.volume24hUsd,
      trades24h: Math.round(s.volume24hUsd / (120 + rng() * 90)),
      feeHistory: Array.from({ length: 14 }, (_, i) =>
        Math.max(2, s.fees24hUsd * (0.5 + rng()) * (i / 14 + 0.4)),
      ),
      feeYield: computeFeeYield({ feesWindowUsd, tvlUsd: s.tvlUsd, windowHours, ageHours }),
    };
  }

  private buildVaults(): Vault[] {
    return SEED_VAULT_SYMBOLS.map((sym) => {
      const pool = this.pools.find((p) => p.token.symbol === sym)!;
      const stakedUsd = pool.tvlUsd * 0.62;
      // rewardRate = pendingWeth / 7 days, the Synthetix window (§3.3).
      const weeklyWeth =
        (pool.feesWindowUsd * (1 - PROTOCOL_FEE_BPS / 10_000)) / this.global.ethPriceUsd;
      return {
        id: `vault-${sym}`,
        poolId: pool.id,
        address: addr(this.rng),
        totalStakedUsd: stakedUsd,
        stakers: Math.round(pool.tvlUsd / 1900),
        rewardRate: weeklyWeth / REWARD_WINDOW_SECONDS,
        nextHarvestInSeconds: (1 + Math.floor(this.rng() * 5)) * 3600,
        protocolFeeBps: PROTOCOL_FEE_BPS,
      };
    });
  }

  private buildPortfolio(): Portfolio {
    const rng = this.rng;
    const dailyFeesWeth = Array.from({ length: 56 }, () => Math.pow(rng(), 1.6) * 0.12);
    return {
      netValueUsd: 18_940,
      netChangeUsd: 1204,
      netChangePct: 6.8,
      feesEarnedWeth: 2.183,
      feesEarnedUsd: 5503,
      priceImpactUsd: -1101,
      fees7dUsd: 412,
      dailyFeesWeth,
      claimableWeth: 0.412,
      stakes: [
        {
          vaultId: 'vault-HOODR',
          poolId: 'HOODR-WETH',
          stakedUsd: 3410,
          earnedWeth: 0.88,
          streamProgressPct: 62,
          streamRemainingSeconds: 4 * 86400 + 11 * 3600,
        },
        {
          vaultId: 'vault-PONS',
          poolId: 'PONS-WETH',
          stakedUsd: 2050,
          earnedWeth: 0.24,
          streamProgressPct: 18,
          streamRemainingSeconds: 6 * 86400 + 2 * 3600,
        },
      ],
      positions: [
        { tokenId: '1841', poolId: 'NVDA-WETH', shape: 'curve', rangePct: 12, inRange: true, valueUsd: 6120, feesWeth: 0.41 },
        { tokenId: '1902', poolId: 'SPY-WETH', shape: 'spot', rangePct: 3, inRange: true, valueUsd: 4880, feesWeth: 0.19 },
        { tokenId: '2044', poolId: 'MOONCAT-WETH', shape: 'bidask', rangePct: 40, inRange: false, outOfRangeSinceHours: 9, valueUsd: 2130, feesWeth: 0.71 },
      ],
    };
  }

  // ----------------------------------------------------------------- tick --

  private start() {
    if (typeof window === 'undefined' || this.marketTimer) return;
    this.marketTimer = setInterval(() => this.tickMarket(), MARKET_TICK_MS);
    this.payoutTimer = setInterval(() => {
      this.pushPayout();
      this.emit();
    }, PAYOUT_TICK_MS);
  }

  private stop() {
    if (this.marketTimer) clearInterval(this.marketTimer);
    if (this.payoutTimer) clearInterval(this.payoutTimer);
    this.marketTimer = null;
    this.payoutTimer = null;
  }

  private tickMarket() {
    const rng = this.rng;
    this.ticks++;
    // The prototype moves a handful of pools per tick rather than all of them,
    // which keeps the surface calm; a slightly wider touch keeps ranks crossing
    // often enough that the board actually reorders.
    const touched = 3 + Math.floor(rng() * 4);
    for (let i = 0; i < touched; i++) {
      const p = this.pools[Math.floor(rng() * this.pools.length)];
      const volatile = p.quote === 'ETH';
      p.change24hPct = Math.max(-95, p.change24hPct + (rng() - 0.48) * (volatile ? 4 : 0.6));
      p.volume24hUsd = Math.max(1e3, p.volume24hUsd * (1 + (rng() - 0.45) * 0.06));
      p.fees24hUsd = Math.max(10, p.fees24hUsd * (1 + (rng() - 0.45) * 0.09));
      // The trailing window takes on fresh fees and drops the hours that aged
      // out, so it tracks the fee rate with a real seven-day lag.
      p.feesWindowUsd = Math.max(
        10,
        p.feesWindowUsd +
          ((p.fees24hUsd / 24) * SIM_HOURS_PER_TICK -
            (p.feesWindowUsd / p.feeWindowHours) * SIM_HOURS_PER_TICK),
      );
      // Depth moves too, with price and with LPs arriving and leaving. Yield is
      // fees over depth, so this is half of why the board reorders at all.
      p.tvlUsd = Math.max(1e4, p.tvlUsd * (1 + (rng() - 0.5) * 0.012));
      p.feeYield = computeFeeYield({
        feesWindowUsd: p.feesWindowUsd,
        tvlUsd: p.tvlUsd,
        windowHours: p.feeWindowHours,
        ageHours: p.ageHours,
      });
      p.feeHistory = p.feeHistory
        .slice(1)
        .concat(Math.max(2, p.feeHistory[p.feeHistory.length - 1] * (1 + (rng() - 0.47) * 0.25)));
    }

    this.global.ethPriceUsd = Math.max(100, this.global.ethPriceUsd * (1 + (rng() - 0.5) * 0.004));
    // Cumulative fees grow on the same simulated clock as everything else.
    this.global.totalFeesUsd +=
      (this.pools.reduce((a, p) => a + p.fees24hUsd, 0) * SIM_HOURS_PER_TICK) / 24;

    for (const v of this.vaults) {
      v.nextHarvestInSeconds -= SIM_SECONDS_PER_TICK;
      if (v.nextHarvestInSeconds <= 0) {
        // The harvest landed. notifyReward folds whatever is left of the
        // current window into a new one and the next harvest is scheduled.
        v.nextHarvestInSeconds = (4 + Math.floor(rng() * 4)) * 3600;
      }
    }

    for (const stake of this.portfolio.stakes) {
      const pool = this.pools.find((p) => p.id === stake.poolId);
      if (pool) {
        // Fees accrue to the staker continuously, net of the protocol's cut.
        const annualUsd = stake.stakedUsd * (Math.max(0, yieldPct(pool.feeYield)) / 100) * 0.9;
        stake.earnedWeth +=
          (annualUsd * (SIM_HOURS_PER_TICK / (365 * 24))) / this.global.ethPriceUsd;
      }
      stake.streamRemainingSeconds -= SIM_SECONDS_PER_TICK;
      // A stream that runs out is replaced by the next harvest's window.
      if (stake.streamRemainingSeconds <= 0) stake.streamRemainingSeconds = REWARD_WINDOW_SECONDS;
      stake.streamProgressPct = Math.min(
        100,
        Math.max(0, 100 - (stake.streamRemainingSeconds / REWARD_WINDOW_SECONDS) * 100),
      );
    }
    this.portfolio.claimableWeth = this.portfolio.stakes.reduce((a, s) => a + s.earnedWeth, 0);

    // The indexer is not always at head. Every so often it falls behind, so the
    // top bar's lag state is a thing you can actually see in P0 (§7).
    const lagging = this.ticks % 37 === 0;
    this.lagSeconds = lagging ? 42 + rng() * 50 : Math.max(0.6, 1 + rng() * 1.4);

    this.emit();
  }

  private pushPayout() {
    const rng = this.rng;
    const stakeable = this.pools.filter((p) => p.stakeable);
    const p = stakeable[Math.floor(rng() * stakeable.length)];
    const amount = rng() * 0.09 + 0.004;
    this.payoutTotalUsd += amount * this.global.ethPriceUsd;
    this.payouts = [
      {
        id: `${this.revision}-${this.payouts.length}-${p.id}`,
        poolId: p.id,
        weth: amount,
        wallet: `0x${Math.floor(rng() * 0xffff)
          .toString(16)
          .padStart(4, '0')}`,
      },
      ...this.payouts,
    ].slice(0, 5);
  }

  /**
   * Everything the top bar and the featured card show that can be summed from
   * the pools is summed from the pools. Two places showing different totals
   * for the same thing is exactly the kind of dishonesty §7 is about.
   */
  private deriveTotals() {
    const tvlUsd = this.pools.reduce((a, p) => a + p.tvlUsd, 0);
    const fees24hUsd = this.pools.reduce((a, p) => a + p.fees24hUsd, 0);
    const volume24hUsd = this.pools.reduce((a, p) => a + p.volume24hUsd, 0);
    const stakers = this.vaults.reduce((a, v) => a + v.stakers, 0);
    // The headline 24h move is depth-weighted: a $6M pool moves the number
    // more than a $90K one.
    const change24hPct =
      tvlUsd > 0
        ? this.pools.reduce((a, p) => a + p.change24hPct * p.tvlUsd, 0) / tvlUsd
        : 0;
    return { tvlUsd, fees24hUsd, volume24hUsd, stakers, change24hPct };
  }

  private compose(): MarketSnapshot {
    const totals = this.deriveTotals();
    return {
      pools: this.pools.map((p) => ({ ...p })),
      vaults: this.vaults.map((v) => ({ ...v })),
      portfolio: {
        ...this.portfolio,
        stakes: this.portfolio.stakes.map((s) => ({ ...s })),
        positions: this.portfolio.positions.map((p) => ({ ...p })),
      },
      global: {
        totalPositions: this.global.totalPositions,
        totalFeesUsd: this.global.totalFeesUsd,
        ethPriceUsd: this.global.ethPriceUsd,
        tvlUsd: totals.tvlUsd,
      },
      featured: {
        ...SEED_FEATURED,
        fees24hUsd: totals.fees24hUsd,
        change24hPct: totals.change24hPct,
        volume24hUsd: totals.volume24hUsd,
        liquidityUsd: totals.tvlUsd,
        stakers: totals.stakers,
        history: this.featuredHistory.slice(),
      },
      router: { ...this.router },
      payouts: this.payouts.slice(),
      payoutTotalUsd: this.payoutTotalUsd,
      indexerLagSeconds: this.lagSeconds,
      revision: this.revision,
    };
  }

  private emit() {
    this.revision++;
    this.snapshot = this.compose();
    this.listeners.forEach((l) => l(this.snapshot));
  }
}
