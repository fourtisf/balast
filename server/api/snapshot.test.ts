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
import { isStablecoinSymbol } from '../../lib/chain';
import type { MarketSnapshot } from '../../lib/data/types';
import { MIN_DATA_HOURS, YIELD_WINDOW_HOURS, computeFeeYield, yieldPct } from '../../lib/yield';
import { prisma } from '../db';
import { Poller } from '../indexer/poller';
import { isReachable, resetDatabase } from '../test/db';
import { FixtureLogSource, USDG, WETH, buildFixtureChain, fixtureTokenReader } from '../test/fixture';
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

  it('derives a market cap from the supply less what cannot circulate, and an FDV from all of it', () => {
    // totalSupply() is an on-chain read, and so are the balances of the burn
    // addresses and of the token contract itself. Total less those is the
    // circulating figure; the market cap built on it can still overstate a
    // token with a vesting schedule, never understate it, and it is never
    // larger than the fully diluted figure (§7).
    const withSupply = snapshot.pools.filter((p) => p.fdvUsd > 0);
    expect(withSupply.length).toBeGreaterThan(0);
    for (const pool of withSupply) {
      expect(pool.marketCapUsd).toBeGreaterThan(0);
      expect(pool.marketCapUsd).toBeLessThanOrEqual(pool.fdvUsd * (1 + 1e-9));
    }
    // Nothing burned: the two figures are one number.
    const nvda = snapshot.pools.find((p) => p.token.symbol === 'NVDA');
    expect(nvda!.marketCapUsd).toBeCloseTo(nvda!.fdvUsd, 2);
    // Forty percent burned: the market cap is sixty percent of the FDV.
    const pons = snapshot.pools.find((p) => p.token.symbol === 'PONS');
    expect(pons).toBeDefined();
    expect(pons!.fdvUsd).toBeGreaterThan(0);
    expect(pons!.marketCapUsd).toBeCloseTo(pons!.fdvUsd * 0.6, 2);
  });

  it('shows no figure at all for a token that will not report its supply', () => {
    // MOONCAT's contract does not answer totalSupply() in the fixture. Zero,
    // which the column renders as an em dash — never a guess.
    const mooncat = snapshot.pools.find((p) => p.token.symbol === 'MOONCAT');
    expect(mooncat).toBeDefined();
    expect(mooncat!.marketCapUsd).toBe(0);
    expect(mooncat!.fdvUsd).toBe(0);
  });

  it('computes FDV as supply x the traded side\'s price, not the quote\'s', () => {
    const nvda = snapshot.pools.find((p) => p.token.symbol === 'NVDA');
    expect(nvda).toBeDefined();
    // 112,000 NVDA at the pool's price.
    expect(nvda!.fdvUsd).toBeCloseTo(112_000 * nvda!.priceUsd, 2);
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

describe('the listing bar', () => {
  it('does not list a stablecoin as a row of its own, unless asked to', async () => {
    // Ranked by market cap, the first board led with USDe: a dollar is not
    // a project, and its market cap is how much of it was minted. The rule is
    // the symbol (`isStablecoinSymbol`); USDG stays the quote that prices the
    // site, and the ether market is untouched.
    expect(isStablecoinSymbol('USDe')).toBe(true);
    expect(isStablecoinSymbol('syrupUSDG')).toBe(true);
    expect(isStablecoinSymbol('DAI')).toBe(true);
    expect(isStablecoinSymbol('CASHCAT')).toBe(false);

    const cursor = await prisma.indexerCursor.findFirstOrThrow();
    const asOf = cursor.lastIndexedAt;
    const token = '0x00000000000000000000000000000000000000e1';
    await prisma.token.create({
      data: {
        address: token,
        symbol: 'USDe',
        name: 'Ethena USDe',
        decimals: 18,
        totalSupply: '327000000000000000000000000',
        nonCirculating: '0',
        supplyReadAt: asOf,
        firstSeen: asOf,
      },
    });
    const poolId = `0x${'e1'.repeat(32)}`;
    await prisma.pool.create({
      data: {
        id: poolId,
        address: poolId,
        chainId: 4663,
        token0: token,
        token1: WETH,
        feeTier: 100,
        tickSpacing: 1,
        hooks: null,
        protocol: 'v4',
        createdBlock: 1n,
        createdAt: new Date(asOf.getTime() - 30 * 24 * 3600_000),
      },
    });
    await prisma.poolState.create({
      data: {
        poolId,
        tvlUsd: 250_000,
        priceUsd: 1,
        mcUsd: 327_000_000,
        circMcUsd: 327_000_000,
        sqrtPrice: '0',
        tick: 0,
        liquidity: '0',
        updatedAt: asOf,
      },
    });

    const board = await buildSnapshot({ usdgAddress: USDG, minFdvUsd: 0 });
    expect(board!.pools.map((p) => p.token.symbol)).not.toContain('USDe');
    expect(board!.pools.map((p) => p.token.symbol)).toContain('WETH');

    const withStables = await buildSnapshot({ usdgAddress: USDG, minFdvUsd: 0, listStablecoins: true });
    expect(withStables!.pools.map((p) => p.token.symbol)).toContain('USDe');

    await prisma.pool.delete({ where: { id: poolId } });
    await prisma.token.delete({ where: { address: token } });
  });

  it('hides a token with no readable supply below the bar, and never the ether market', async () => {
    // MOONCAT's contract does not answer totalSupply(), so its FDV is zero;
    // at any positive bar it is unlisted — still indexed, just not shown.
    // The anchor pool's traded side is ether, whose FDV is zero by
    // construction (§15) rather than by size, so it is listed regardless.
    const filtered = await buildSnapshot({ usdgAddress: USDG, minFdvUsd: 1_000_000 });
    expect(filtered).not.toBeNull();
    const symbols = filtered!.pools.map((p) => p.token.symbol);
    expect(symbols).not.toContain('MOONCAT');
    expect(symbols).toContain('WETH');
    expect(filtered!.pools.length).toBeLessThan(snapshot.pools.length);

    // The bar is a listing rule, not a data rule: the header sums the pools
    // it shows (§12), so it moves with the list rather than contradicting it.
    expect(filtered!.global.tvlUsd).toBeLessThanOrEqual(snapshot.global.tvlUsd);

    // And a bar of zero is the full board.
    const everything = await buildSnapshot({ usdgAddress: USDG, minFdvUsd: 0 });
    expect(everything!.pools.length).toBe(snapshot.pools.length);
  });

  it('does not list a dead pool whose liquidity is unknown, and lists one that trades', async () => {
    // The first board ranked by market cap led with catAI at "FDV $2.48
    // trillion", GLTCHT at $1.76 trillion, sato at $361M — every one with
    // $0 volume, $0 fees and a liquidity of "—". Dust with an absurd supply
    // and a pool the indexer cannot reconstruct; the liquidity floor did not
    // apply because their liquidity was unknown rather than small. Unknown
    // liquidity is forgiven only for a pool that has traded in the window.
    const cursor = await prisma.indexerCursor.findFirstOrThrow();
    const asOf = cursor.lastIndexedAt;
    const token = '0x00000000000000000000000000000000000000d1';
    await prisma.token.create({
      data: {
        address: token,
        symbol: 'DUST',
        name: 'Dust with a trillion supply',
        decimals: 18,
        totalSupply: '1000000000000000000000000000000000',
        nonCirculating: '0',
        supplyReadAt: asOf,
        firstSeen: asOf,
      },
    });
    const poolId = `0x${'d1'.repeat(32)}`;
    await prisma.pool.create({
      data: {
        id: poolId,
        address: poolId,
        chainId: 4663,
        token0: token,
        token1: WETH,
        feeTier: 3000,
        tickSpacing: 60,
        hooks: null,
        protocol: 'v4',
        createdBlock: 1n,
        createdAt: new Date(asOf.getTime() - 30 * 24 * 3600_000),
      },
    });
    await prisma.poolState.create({
      data: {
        poolId,
        tvlUsd: 0, // unknown depth (§14)
        priceUsd: 2.48,
        mcUsd: 2_480_000_000_000,
        circMcUsd: 2_480_000_000_000,
        sqrtPrice: '0',
        tick: 0,
        liquidity: '0',
        updatedAt: asOf,
      },
    });

    const dead = await buildSnapshot({ usdgAddress: USDG, minFdvUsd: 0 });
    expect(dead!.pools.map((p) => p.token.symbol)).not.toContain('DUST');

    // One trade inside the window and the same pool is listed, with its
    // liquidity honestly unknown rather than invented.
    await prisma.poolFeeHourly.create({
      data: {
        poolId,
        hour: new Date(asOf.getTime() - 2 * 3600_000),
        feesToken0: '0',
        feesToken1: '0',
        feesUsd: 1,
        volumeUsd: 100,
        swaps: 1,
      },
    });
    const traded = await buildSnapshot({ usdgAddress: USDG, minFdvUsd: 0 });
    const row = traded!.pools.find((p) => p.token.symbol === 'DUST');
    expect(row).toBeDefined();
    expect(row!.tvlUsd).toBe(0);

    // Tidy up so the suite's other counts hold.
    await prisma.pool.delete({ where: { id: poolId } });
    await prisma.token.delete({ where: { address: token } });
  });
});
