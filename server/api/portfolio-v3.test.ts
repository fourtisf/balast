/**
 * The v3 half of a wallet's portfolio (§29).
 *
 * `/positions` mints into v3 pools through Uniswap's NonfungiblePositionManager
 * (§28). Those positions are read from the chain, not the indexer, so the
 * portfolio is given a reader; these tests hand it a fake one and assert what
 * the portfolio makes of the answer — valued through the pool the indexer
 * knows, honest about the principal it cannot know, and never losing the v4
 * rows to a node that did not answer.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Address } from 'viem';
import { prisma } from '../db';
import { isReachable, resetDatabase } from '../test/db';
import { FixtureLogSource, USDG, V3_FACTORY, V3_POOL, V3_POOL_ID, WETH, buildV3Chain, fixtureTokenReader } from '../test/fixture';
import { Poller } from '../indexer/poller';
import { buildPortfolio, type V3PositionReader } from './portfolio';
import type { V3OnchainPosition } from '../../lib/v3/positions';

const BOB = '0x0000000000000000000000000000000000000b0b' as Address;
const TOKEN = '0x0000000000000000000000000000000000000001' as Address;
const TICK = -25_920;

const held: V3OnchainPosition = {
  tokenId: 5n,
  token0: TOKEN,
  token1: WETH as Address,
  fee: 3000,
  tickLower: TICK - 1200,
  tickUpper: TICK + 1200,
  liquidity: 10n ** 21n,
  owed0: 0n,
  owed1: 0n,
};

beforeAll(async () => {
  if (!(await isReachable())) throw new Error('These tests need a Postgres at TEST_DATABASE_URL. See README.');
  await resetDatabase();
  const chain = buildV3Chain();
  const source = new FixtureLogSource(chain, chain.headBlock);
  const poller = new Poller({
    source,
    usdgAddress: USDG,
    startBlock: 0n,
    blockRange: 100,
    v3Factory: V3_FACTORY,
    tokenReader: fixtureTokenReader,
  });
  await poller.syncToHead();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('a v3 position in the portfolio', () => {
  it('is valued through the pool the indexer knows, and its principal is unknown rather than zero', async () => {
    const pool = await prisma.pool.findUnique({ where: { id: V3_POOL_ID } });
    expect(pool?.address).toBe(V3_POOL.toLowerCase());

    const asked: string[] = [];
    const reader: V3PositionReader = async (owner) => {
      asked.push(owner);
      return [held];
    };
    const portfolio = await buildPortfolio(BOB, USDG, { readV3: reader });
    expect(asked).toEqual([BOB.toLowerCase()]);
    expect(portfolio!.v3).toEqual({ status: 'read', unindexed: 0 });
    expect(portfolio!.positions).toHaveLength(1);

    const [position] = portfolio!.positions;
    expect(position.tokenId).toBe('5');
    expect(position.poolId).toBe(V3_POOL_ID);
    expect(position.valueUsd).toBeGreaterThan(0);
    expect(position.inRange).toBe(true);
    // The funding history of a live-read v3 position is not indexed: no
    // hold basis, so no price impact — absent, not a zero that reads as "none".
    expect(position.priceImpactUsd).toBeUndefined();
    expect(position.live!.holdUsd).toBeNull();
    expect(position.live!.protocol).toBe('v3');
    expect(position.live!.poolAddress).toBe(V3_POOL.toLowerCase());
    expect(position.live!.key.fee).toBe(3000);
    expect(position.live!.quote).toBe('ETH');
    expect(portfolio!.netValueUsd).toBeCloseTo(position.valueUsd, 6);
    expect(portfolio!.priceImpactUsd).toBe(0);
  });

  it('counts a position in a pool the indexer has not met, and does not invent it', async () => {
    const stranger: V3OnchainPosition = { ...held, tokenId: 6n, fee: 500 };
    const portfolio = await buildPortfolio(BOB, USDG, { readV3: async () => [held, stranger] });
    expect(portfolio!.positions.map((p) => p.tokenId)).toEqual(['5']);
    expect(portfolio!.v3).toEqual({ status: 'read', unindexed: 1 });
  });

  it('answers with the rest and says so when the node does not answer', async () => {
    const portfolio = await buildPortfolio(BOB, USDG, {
      readV3: async () => {
        throw new Error('v3 positions failed on all 4 endpoints:\n  https://paid.example/rpc/SECRET-KEY: timeout');
      },
    });
    expect(portfolio).not.toBeNull();
    expect(portfolio!.positions).toHaveLength(0);
    expect(portfolio!.v3.status).toBe('unavailable');
    // A fixed sentence: an endpoint's own error can carry its URL, and a paid
    // endpoint's URL carries its key.
    expect(portfolio!.v3.message).toBe('The chain did not answer for Uniswap v3 positions.');
  });

  /**
   * A v3 pool is announced by the factory without a price; it gets one at its
   * first swap. Until then a position in it cannot be valued or placed in or
   * out of range — and the row must not say "earning nothing".
   */
  it('says the range and value are unknown for a pool the indexer has no price for', async () => {
    await prisma.poolState.deleteMany({ where: { poolId: V3_POOL_ID } });
    const portfolio = await buildPortfolio(BOB, USDG, { readV3: async () => [held] });
    const [position] = portfolio!.positions;
    expect(position.rangeUnknown).toBe(true);
    expect(position.valueUnknown).toBe(true);
    expect(position.valueUsd).toBe(0);
    expect(position.priceImpactUsd).toBeUndefined();
    expect(position.outOfRangeSinceHours).toBeUndefined();
  });

  it('is off, and says so, when the server was given no reader', async () => {
    const portfolio = await buildPortfolio(BOB, USDG);
    expect(portfolio!.v3).toEqual({ status: 'off', unindexed: 0 });
  });
});
