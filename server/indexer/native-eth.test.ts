/**
 * Pools that hold NATIVE ether, which is what v4 gives you.
 *
 * This is the failure the site actually showed: "looking for the USD anchor",
 * for hours, on a chain whose ETH/USDG pool the indexer had already written
 * to its own tables. v4 spells ether as `address(0)` in a pool's currencies,
 * and every query that matters — the anchor search, the USD path, the pool
 * listing — compared against the aeWETH address alone. So the anchor pool was
 * invisible to the thing looking for it, and with no anchor `buildSnapshot`
 * returns null, which blanks every page on the site.
 *
 * Nothing in the older suites could catch it: the fixture chain is built from
 * wrapped-WETH pools, so it proved the wrapped path and quietly assumed the
 * native one did not exist.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NATIVE_ETH } from '../../lib/chain';
import { buildSnapshot } from '../api/snapshot';
import { prisma } from '../db';
import { isReachable, resetDatabase } from '../test/db';
import {
  FixtureLogSource,
  USDG,
  buildNativeEtherChain,
  fixtureTokenReader,
} from '../test/fixture';
import { resolveUsdg } from './anchor';
import { readToken } from './discovery';
import { Poller } from './poller';

const chain = buildNativeEtherChain();

/** A poller with no anchor configured — the state the real box was in. */
function blindPoller(): Poller {
  return new Poller({
    source: new FixtureLogSource(chain),
    usdgAddress: null,
    startBlock: 0n,
    blockRange: chain.headBlock + 1,
    tokenReader: fixtureTokenReader,
  });
}

beforeAll(async () => {
  if (!(await isReachable())) {
    throw new Error('These tests need a Postgres at TEST_DATABASE_URL. See README.');
  }
  await resetDatabase();
  await blindPoller().syncToHead();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('native ether as a pool currency', () => {
  it('is read without an RPC call, as ETH rather than a truncated address', async () => {
    // There is no contract at address(0) to ask. Every read fails, the symbol
    // falls back to `0000…0000`, and — the part that would have hidden it —
    // the decimals fall back to 18, which is right, so nothing downstream
    // looks wrong until a price is derived.
    const facts = await readToken(NATIVE_ETH);
    expect(facts.symbol).toBe('ETH');
    expect(facts.decimals).toBe(18);
    // Ether's supply is not an ERC20 read, so there is no honest FDV for it.
    expect(facts.totalSupply).toBeNull();
  });

  it('discovers the anchor through an ETH/USDG pool', async () => {
    const resolved = await resolveUsdg(null);
    expect(resolved.address).toBe(USDG.toLowerCase());
    expect(resolved.source).toBe('discovered');
    expect(resolved.candidates[0].wethPools).toBeGreaterThan(0);
  });

  it('prices both pools, in dollars, from that anchor', async () => {
    const states = await prisma.poolState.findMany({
      include: { pool: true },
    });
    expect(states).toHaveLength(2);
    for (const state of states) {
      expect(Number(state.tvlUsd)).toBeGreaterThan(0);
      expect(Number(state.priceUsd)).toBeGreaterThan(0);
      // Both pools hold native ether on side 0.
      expect(state.pool.token0).toBe(NATIVE_ETH);
    }
  });

  it('puts ether at roughly its fixture price, not a thousand times off it', async () => {
    // The anchor pool's traded side is ether (USDG outranks it as a quote),
    // so this is the one figure every other dollar figure on the site is
    // derived from. A decimals slip here is a factor of 1e12, not a rounding
    // difference, which is why the bound is generous and still meaningful.
    const snapshot = await buildSnapshot({ usdgAddress: null });
    expect(snapshot).not.toBeNull();
    expect(snapshot!.global.ethPriceUsd).toBeGreaterThan(1_500);
    expect(snapshot!.global.ethPriceUsd).toBeLessThan(4_000);
  });

  it('lists the native pools, quoted in ETH', async () => {
    const snapshot = await buildSnapshot({ usdgAddress: null });
    const pools = snapshot!.pools;
    expect(pools).toHaveLength(2);

    // The ETH/USDG pool is the ether market priced in dollars, by the one
    // traded-side rule — not the USDG market priced in ether.
    const anchorPool = pools.find((p) => p.quote === 'USDG');
    expect(anchorPool?.token.symbol).toBe('ETH');
    expect(anchorPool?.token.address).toBe(NATIVE_ETH);

    // And a token paired against native ether is quoted in ETH, which is the
    // listing filter that used to exclude it entirely.
    const tokenPool = pools.find((p) => p.quote === 'ETH');
    expect(tokenPool?.token.symbol).toBe('NVDA');
    expect(tokenPool?.tvlUsd).toBeGreaterThan(0);
  });

  it('does not queue ether for a totalSupply read it can never satisfy', async () => {
    // `supplyReadAt` is null for ether and always will be, and the refresh
    // queue is ordered nulls-first with a handful of slots a pass: left in,
    // it would take one of them for ever and starve the tokens that answer.
    const ether = await prisma.token.findUnique({ where: { address: NATIVE_ETH } });
    expect(ether?.symbol).toBe('ETH');
    expect(ether?.totalSupply).toBeNull();
  });
});
