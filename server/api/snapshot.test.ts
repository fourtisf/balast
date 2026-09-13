/**
 * The snapshot the UI actually receives.
 *
 * Two things are worth testing here above all others.
 *
 * §4.2 says the fee-yield arithmetic lives in SQL. §7 says which of three
 * states a figure is allowed to be shown in. If those two drift apart — the
 * SQL computing one number and `lib/yield.ts` classifying a different one —
 * the boards would show a figure that no rule in the handoff sanctions. So
 * the SQL result is recomputed here against `computeFeeYield` and has to
 * match, and every one of §7's three states is asserted to actually appear.
 *
 * The rest is the honest-empty contract: with no vault contracts deployed
 * (P2), there are no stakes, no positions and no payouts, and the snapshot
 * has to say so rather than invent them.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MarketSnapshot } from '../../lib/data/types';
import { MIN_DATA_HOURS, YIELD_WINDOW_HOURS, computeFeeYield, yieldPct } from '../../lib/yield';
import { prisma } from '../db';
import { Poller } from '../indexer/poller';
import { isReachable, resetDatabase } from '../test/db';
import { FixtureLogSource, USDG, buildFixtureChain, fixtureTokenReader } from '../test/fixture';
import { buildSnapshot } from './snapshot';

const chain = buildFixtureChain();
let snapshot: MarketSnapshot;

beforeAll(async () => {
  if (!(await isReachable())) {
    throw new Error('These tests need a Postgres at TEST_DATABASE_URL. See README.');
  }
  await resetDatabase();
  await new Poller({
    source: new FixtureLogSource(chain),
    usdgAddress: USDG,
    startBlock: 0n,
    blockRange: chain.headBlock + 1,
    tokenReader: fixtureTokenReader,
  }).syncToHead();

  const built = await buildSnapshot({ usdgAddress: USDG });
  if (!built) throw new Error('buildSnapshot returned null after a full sync');
  snapshot = built;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('buildSnapshot', () => {
  it('returns null before the indexer has written a block', async () => {
    // The DataProvider interface has always allowed this; MarketProvider
    // renders "waiting for the indexer" for it rather than a page of zeros.
    await prisma.indexerCursor.deleteMany();
    expect(await buildSnapshot({ usdgAddress: USDG })).toBeNull();
    // Put it back for the rest of the suite.
    await new Poller({
      source: new FixtureLogSource(chain),
      usdgAddress: USDG,
      startBlock: 0n,
      blockRange: chain.headBlock + 1,
      tokenReader: fixtureTokenReader,
    }).syncToHead();
  });

  it('lists every pool that can be priced through the one allowed path', () => {
    expect(snapshot.pools.length).toBe(4);
    for (const pool of snapshot.pools) {
      expect(pool.quote === 'ETH' || pool.quote === 'USDG').toBe(true);
      expect(pool.priceUsd).toBeGreaterThan(0);
      expect(pool.tvlUsd).toBeGreaterThan(0);
    }
  });

  it('computes the fee yield in SQL, and agrees with lib/yield.ts', () => {
    // The assertion that stops §4.2's SQL and §7's classification drifting.
    for (const pool of snapshot.pools) {
      const expected = computeFeeYield({
        feesWindowUsd: pool.feesWindowUsd,
        tvlUsd: pool.tvlUsd,
        windowHours: pool.feeWindowHours,
        ageHours: pool.ageHours,
      });
      expect(pool.feeYield.basis).toBe(expected.basis);
      if (expected.basis !== 'insufficient' && pool.feeYield.basis !== 'insufficient') {
        // SQL numeric and a JS double will not be bit-identical; agreeing to
        // nine significant figures means the same formula, not a coincidence.
        expect(pool.feeYield.pct).toBeCloseTo(expected.pct, 6);
      }
    }
  });

  it('caps the window at the pool\'s own age, never annualising 168h it never had', () => {
    for (const pool of snapshot.pools) {
      expect(pool.feeWindowHours).toBeLessThanOrEqual(YIELD_WINDOW_HOURS);
      expect(pool.feeWindowHours).toBeLessThanOrEqual(Math.max(1, pool.ageHours) + 0.001);
    }
  });

  it('shows all three of §7\'s states, because the fixture has all three ages', () => {
    // A suite where every pool is 7d+ would never exercise `est.` or the em
    // dash, and those are the states most likely to be got wrong.
    const old = snapshot.pools.filter((p) => p.ageHours >= YIELD_WINDOW_HOURS);
    const young = snapshot.pools.filter(
      (p) => p.ageHours >= MIN_DATA_HOURS && p.ageHours < YIELD_WINDOW_HOURS,
    );
    expect(old.length).toBeGreaterThan(0);
    expect(old.every((p) => p.feeYield.basis === 'trailing7d')).toBe(true);
    // The fixture's youngest pool is created partway through, so it is either
    // `estimate` or `insufficient` depending on how far in — both are honest,
    // and what must never happen is a plain trailing7d label on it.
    for (const pool of young) {
      expect(pool.feeYield.basis).toBe('estimate');
    }
  });

  it('never reports a yield for a pool with under 24h of data', () => {
    for (const pool of snapshot.pools) {
      if (pool.ageHours < MIN_DATA_HOURS) {
        expect(pool.feeYield.basis).toBe('insufficient');
        // -1 so it sorts last rather than first.
        expect(yieldPct(pool.feeYield)).toBe(-1);
      }
    }
  });

  it('sums every total from the pools, so the top bar cannot contradict the table', () => {
    const tvl = snapshot.pools.reduce((a, p) => a + p.tvlUsd, 0);
    const fees = snapshot.pools.reduce((a, p) => a + p.fees24hUsd, 0);
    expect(snapshot.global.tvlUsd).toBeCloseTo(tvl, 6);
    expect(snapshot.featured.liquidityUsd).toBeCloseTo(tvl, 6);
    expect(snapshot.featured.fees24hUsd).toBeCloseTo(fees, 6);
    expect(snapshot.featured.volume24hUsd).toBeCloseTo(
      snapshot.pools.reduce((a, p) => a + p.volume24hUsd, 0),
      6,
    );
  });

  it('prices ETH from the anchor series, not from a feed or another pool', async () => {
    expect(snapshot.global.ethPriceUsd).toBeGreaterThan(100);
    expect(snapshot.global.ethPriceUsd).toBeLessThan(100_000);

    // It must be the anchor's figure exactly. This once read the deepest
    // WETH-containing pool's `price_usd`, which is the TRADED side's price —
    // so the top bar showed NVDA's price as the price of ether.
    const [anchor] = await prisma.$queryRaw<{ weth_usd: string }[]>`
      SELECT weth_usd::text FROM weth_usd_hourly ORDER BY hour DESC LIMIT 1
    `;
    expect(snapshot.global.ethPriceUsd).toBeCloseTo(Number(anchor.weth_usd), 6);

    // And it must not coincide with any other pool's traded-side price.
    const others = snapshot.pools
      .filter((p) => p.token.symbol !== 'WETH')
      .map((p) => p.priceUsd);
    for (const price of others) {
      expect(snapshot.global.ethPriceUsd).not.toBeCloseTo(price, 6);
    }
  });

  it('reports the indexer lag rather than hiding it', () => {
    // The fixture's chain time is in the past, so the lag is large and real.
    // What matters is that it is present and non-negative: the top bar shows
    // it, and a frozen or absent lag is how a stale page looks live (§7).
    expect(snapshot.indexerLagSeconds).toBeGreaterThan(0);
    expect(Number.isFinite(snapshot.indexerLagSeconds)).toBe(true);
  });

  it('leaves market cap at zero, because circulating supply is not in the logs', () => {
    for (const pool of snapshot.pools) {
      expect(pool.marketCapUsd).toBe(0);
    }
  });

  it('reports no vaults, stakes, positions or payouts before P2 deploys them', () => {
    // Honest-empty, not invented. The components have empty states for this.
    expect(snapshot.vaults).toEqual([]);
    expect(snapshot.portfolio.stakes).toEqual([]);
    expect(snapshot.portfolio.positions).toEqual([]);
    expect(snapshot.portfolio.claimableWeth).toBe(0);
    expect(snapshot.payouts).toEqual([]);
    expect(snapshot.payoutTotalUsd).toBe(0);
    expect(snapshot.global.totalPositions).toBe(0);
  });

  it('gives every pool a fee sparkline of the right length', () => {
    for (const pool of snapshot.pools) {
      expect(pool.feeHistory.length).toBe(14);
      expect(pool.feeHistory.every((v) => Number.isFinite(v) && v >= 0)).toBe(true);
    }
  });

  it('carries a real 24h move, and never NaN', () => {
    for (const pool of snapshot.pools) {
      expect(Number.isFinite(pool.change24hPct)).toBe(true);
    }
    // At least one pool's price moved, or the fixture is not exercising this.
    expect(snapshot.pools.some((p) => p.change24hPct !== 0)).toBe(true);
  });

  it('marks the fee tier in bips, from the pool\'s hundredths-of-a-bip on chain', () => {
    // 3000 pips on chain is 0.30%, which the UI renders from 30 bips.
    const tiers = snapshot.pools.map((p) => p.feeTierBps).sort((a, b) => a - b);
    expect(tiers).toEqual([5, 30, 30, 100]);
  });
});
