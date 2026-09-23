/**
 * The portfolio lists what the chain confirms the wallet holds (§30).
 *
 * A position that is not on the page cannot be withdrawn through the site.
 * The indexer is weeks behind during its backfill, so these tests pin the
 * rules that make the page complete and true regardless: every indexed v4
 * position is confirmed on chain before it is shown; a position the scanner
 * or the browser found is shown once confirmed, even in a pool the indexer has
 * never met; v3 positions are enumerated on chain; and a node that does not
 * answer degrades to the indexer's record, said out loud, never to silence.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Address } from 'viem';
import { prisma } from '../db';
import { isReachable, resetDatabase } from '../test/db';
import {
  FIXTURE_POOLS,
  FixtureLogSource,
  USDG,
  V3_FACTORY,
  V3_POOL,
  V3_POOL_ID,
  WETH,
  buildFixtureChain,
  buildV3Chain,
  fixtureTokenReader,
  positionMintLogs,
  withLogs,
} from '../test/fixture';
import { Poller } from '../indexer/poller';
import { buildPortfolio, forgetV3Reads, type ChainPortfolioReader } from './portfolio';
import type { V3OnchainPosition } from '../../lib/v3/positions';
import type { V4OnchainPosition } from '../../lib/v4/positions';
import { getSqrtRatioAtTick } from '../chain/tick-math';

const BOB = '0x0000000000000000000000000000000000000b0b' as Address;
const NVDA = FIXTURE_POOLS[1];
const TOKEN_ID = 41n;
const LIQUIDITY = 5n * 10n ** 20n;
const LOWER = NVDA.tick - 10 * NVDA.tickSpacing;
const UPPER = NVDA.tick + 10 * NVDA.tickSpacing;
const NVDA_KEY = {
  currency0: NVDA.currency0 as Address,
  currency1: NVDA.currency1 as Address,
  fee: NVDA.feePips,
  tickSpacing: NVDA.tickSpacing,
  hooks: NVDA.hooks as Address,
};

function fakeChain(over: Partial<ChainPortfolioReader> = {}): ChainPortfolioReader & { candidates: bigint[][] } {
  const candidates: bigint[][] = [];
  return {
    candidates,
    v3Positions: async () => [],
    v4Positions: async (_owner, ids) => {
      candidates.push(ids);
      return { positions: [], unconfirmed: 0 };
    },
    slot0s: async () => new Map(),
    v3PoolAddresses: async () => new Map(),
    tokens: async () => new Map(),
    ...over,
    ...(over.v4Positions
      ? {
          v4Positions: async (owner: Address, ids: bigint[]) => {
            candidates.push(ids);
            return over.v4Positions!(owner, ids);
          },
        }
      : {}),
  };
}

const held = (liquidity = LIQUIDITY): V4OnchainPosition => ({
  tokenId: TOKEN_ID,
  key: NVDA_KEY,
  tickLower: LOWER,
  tickUpper: UPPER,
  liquidity,
});

beforeAll(async () => {
  if (!(await isReachable())) throw new Error('These tests need a Postgres at TEST_DATABASE_URL. See README.');
});

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(() => forgetV3Reads());

describe('v4 positions, confirmed on chain', () => {
  beforeAll(async () => {
    await resetDatabase();
    const chain = withLogs(buildFixtureChain(2_500), [
      ...positionMintLogs({ pool: NVDA, owner: BOB, tokenId: TOKEN_ID, tickLower: LOWER, tickUpper: UPPER, liquidity: LIQUIDITY, block: 600, logIndex: 500 }),
    ]);
    const poller = new Poller({
      source: new FixtureLogSource(chain, chain.headBlock),
      usdgAddress: USDG,
      startBlock: 0n,
      blockRange: 500,
      tokenReader: fixtureTokenReader,
    });
    await poller.syncToHead();
  });

  it('shows an indexed position once the chain confirms it, with the principal the indexer recorded', async () => {
    const chain = fakeChain({ v4Positions: async () => ({ positions: [held()], unconfirmed: 0 }) });
    const portfolio = await buildPortfolio(BOB, USDG, { chain });
    expect(chain.candidates[0]).toContain(TOKEN_ID);
    expect(portfolio!.chain).toEqual({ status: 'read', unreadable: 0 });
    expect(portfolio!.positions).toHaveLength(1);
    const [p] = portfolio!.positions;
    expect(p.poolId).toBe(`v4:${NVDA.id}`);
    expect(p.live!.verified).toBe(true);
    expect(p.live!.unindexedPool).toBe(false);
    expect(p.live!.holdUsd).not.toBeNull();
    expect(Number.isFinite(p.priceImpactUsd)).toBe(true);
    expect(p.valueUsd).toBeGreaterThan(0);
  });

  /** Withdrawn, or sent away, since the indexer's last block: the row must not offer Withdraw on nothing. */
  it('drops a position the chain says this wallet no longer holds', async () => {
    const portfolio = await buildPortfolio(BOB, USDG, { chain: fakeChain() });
    expect(portfolio!.positions).toHaveLength(0);
    expect(portfolio!.netValueUsd).toBe(0);
  });

  it('keeps the chain’s liquidity and drops the principal when the two records disagree', async () => {
    const chain = fakeChain({ v4Positions: async () => ({ positions: [held(LIQUIDITY / 2n)], unconfirmed: 0 }) });
    const [p] = (await buildPortfolio(BOB, USDG, { chain }))!.positions;
    expect(p.live!.liquidity).toBe((LIQUIDITY / 2n).toString());
    expect(p.live!.holdUsd).toBeNull();
    expect(p.priceImpactUsd).toBeUndefined();
  });

  it('places the position against the pool’s price now, not the indexer’s', async () => {
    const above = UPPER + 600;
    const chain = fakeChain({
      v4Positions: async () => ({ positions: [held()], unconfirmed: 0 }),
      slot0s: async (pools) => {
        expect(pools.map((p) => p.id)).toEqual([`v4:${NVDA.id}`]);
        return new Map([[`v4:${NVDA.id}`, { sqrtPriceX96: getSqrtRatioAtTick(above), tick: above }]]);
      },
    });
    const [p] = (await buildPortfolio(BOB, USDG, { chain }))!.positions;
    expect(p.inRange).toBe(false);
    expect(p.rangeUnknown).toBeUndefined();
    // Out of range TODAY: a date from the backfill's swaps would be weeks wrong.
    expect(p.outOfRangeSinceHours).toBeUndefined();
    // Above the range a position is all currency1.
    expect(p.live!.amount0).toBe('0');
  });

  it('shows a position minted after the indexer’s last block, in a pool it has never met', async () => {
    // Token 0x02 is known from another pool; this 0.05% pool of it is not.
    const newKey = { ...FIXTURE_POOLS[2], feePips: 500, tickSpacing: 10 };
    const fresh: V4OnchainPosition = {
      tokenId: 900n,
      key: { currency0: newKey.currency0 as Address, currency1: newKey.currency1 as Address, fee: 500, tickSpacing: 10, hooks: newKey.hooks as Address },
      tickLower: newKey.tick - 200,
      tickUpper: newKey.tick + 200,
      liquidity: 10n ** 20n,
    };
    const asked: string[][] = [];
    const chain = fakeChain({
      v4Positions: async (_o, ids) => ({ positions: ids.includes(900n) ? [fresh] : [], unconfirmed: 0 }),
      slot0s: async (pools) =>
        new Map(pools.map((p) => [p.id, { sqrtPriceX96: getSqrtRatioAtTick(newKey.tick), tick: newKey.tick }])),
      tokens: async (addresses) => {
        asked.push(addresses);
        return new Map();
      },
    });
    const portfolio = await buildPortfolio(BOB, USDG, { chain, v4Candidates: [900n] });
    const [p] = portfolio!.positions;
    expect(p.tokenId).toBe('900');
    expect(p.live!.unindexedPool).toBe(true);
    expect(p.live!.key.fee).toBe(500);
    expect(p.live!.token.symbol).toBe('PONS');
    // Both tokens were already in the indexer's table: nothing asked of the chain.
    expect(asked).toEqual([]);
    // Priced through the token's other pool, and in range at the live price.
    expect(p.valueUnknown).toBeUndefined();
    expect(p.valueUsd).toBeGreaterThan(0);
    expect(p.inRange).toBe(true);
  });

  it('describes a token the indexer has never seen from its own contract, and counts one that will not answer', async () => {
    const stranger = '0x0000000000000000000000000000000000007777' as Address;
    const silent = '0x0000000000000000000000000000000000008888' as Address;
    const position = (tokenId: bigint, token: Address): V4OnchainPosition => ({
      tokenId,
      key: { currency0: token, currency1: WETH as Address, fee: 3000, tickSpacing: 60, hooks: '0x0000000000000000000000000000000000000000' },
      tickLower: -600,
      tickUpper: 600,
      liquidity: 10n ** 18n,
    });
    const chain = fakeChain({
      v4Positions: async () => ({ positions: [position(901n, stranger), position(902n, silent)], unconfirmed: 1 }),
      tokens: async (addresses) =>
        new Map(addresses.filter((a) => a === stranger).map((a) => [a, { symbol: 'NEW', name: 'New token', decimals: 18 }])),
    });
    const portfolio = await buildPortfolio(BOB, USDG, { chain, v4Candidates: [901n, 902n] });
    expect(portfolio!.positions.map((p) => p.tokenId)).toEqual(['901']);
    const [p] = portfolio!.positions;
    expect(p.live!.token.symbol).toBe('NEW');
    // No price anywhere for it: a dash, not $0, and no live slot0 either.
    expect(p.valueUnknown).toBe(true);
    expect(p.rangeUnknown).toBe(true);
    // One the chain would not confirm, one it would not describe.
    expect(portfolio!.chain.unreadable).toBe(2);
  });

  it('lists the indexer’s record, unverified, when the node does not answer — and says so without its URL', async () => {
    const chain = fakeChain({
      v4Positions: async () => {
        throw new Error('v4 positions failed on all 4 endpoints:\n  https://paid.example/rpc/SECRET-KEY: timeout');
      },
    });
    const portfolio = await buildPortfolio(BOB, USDG, { chain });
    expect(portfolio!.positions.map((p) => p.tokenId)).toEqual([TOKEN_ID.toString()]);
    expect(portfolio!.positions[0].live!.verified).toBe(false);
    expect(portfolio!.chain.status).toBe('unavailable');
    expect(portfolio!.chain.message).not.toContain('SECRET');
  });

  /** A v3 read that times out must not throw away the v4 answer — the positions found only on chain would vanish. */
  it('keeps the v4 answer when only the v3 read fails, and says v3 is missing', async () => {
    const fresh: V4OnchainPosition = { ...held(), tokenId: 777n };
    const chain = fakeChain({
      v4Positions: async () => ({ positions: [held(), fresh], unconfirmed: 0 }),
      v3Positions: async () => {
        throw new Error('v3 positions: the node did not answer within 8s');
      },
    });
    const portfolio = await buildPortfolio(BOB, USDG, { chain, v4Candidates: [777n] });
    expect(portfolio!.positions.map((p) => p.tokenId).sort()).toEqual(['41', '777']);
    expect(portfolio!.positions.every((p) => p.live!.verified)).toBe(true);
    expect(portfolio!.chain.status).toBe('read');
    expect(portfolio!.chain.v3Unavailable).toBe(true);
  });

  it('says the in-range status is the indexer’s when the pool prices cannot be read live', async () => {
    const chain = fakeChain({
      v4Positions: async () => ({ positions: [held()], unconfirmed: 0 }),
      slot0s: async () => {
        throw new Error('pool prices: the node did not answer within 5s');
      },
    });
    const portfolio = await buildPortfolio(BOB, USDG, { chain });
    expect(portfolio!.positions).toHaveLength(1);
    expect(portfolio!.chain.pricesStale).toBe(true);
  });

  /** Emptied by the indexer's last block and topped up since: money the indexer's filter would have hidden. */
  it('asks the chain about a position the indexer last saw empty', async () => {
    await prisma.position.update({ where: { tokenId: TOKEN_ID.toString() }, data: { liquidity: 0 } });
    try {
      const chain = fakeChain({ v4Positions: async () => ({ positions: [held()], unconfirmed: 0 }) });
      const portfolio = await buildPortfolio(BOB, USDG, { chain });
      expect(chain.candidates[0]).toContain(TOKEN_ID);
      expect(portfolio!.positions.map((p) => p.tokenId)).toEqual([TOKEN_ID.toString()]);
      // The indexer's principal described an empty position; not this one.
      expect(portfolio!.positions[0].priceImpactUsd).toBeUndefined();
      // Unchecked, the indexer's empty record is not offered.
      expect((await buildPortfolio(BOB, USDG))!.positions).toHaveLength(0);
    } finally {
      await prisma.position.update({ where: { tokenId: TOKEN_ID.toString() }, data: { liquidity: LIQUIDITY.toString() } });
    }
  });

  it('asks the chain about the ids the browser saw minted, and only well-formed ones', async () => {
    process.env.LOG_LEVEL = 'silent';
    const { buildServer } = await import('./server');
    const chain = fakeChain();
    const app = await buildServer({ portfolioChain: chain, v4Scanner: null });
    await app.ready();
    try {
      const response = await app.inject({ method: 'GET', url: `/api/portfolio/${BOB}?v4=900,abc,901,-1` });
      expect(response.statusCode).toBe(200);
      const asked = chain.candidates[0].map(String);
      expect(asked).toEqual(expect.arrayContaining(['41', '900', '901']));
      expect(asked).not.toContain('abc');
      expect(asked).not.toContain('-1');
      // The same parameter twice arrives as an array; it is read, not a 500.
      const twice = await app.inject({ method: 'GET', url: `/api/portfolio/${BOB}?v4=902&v4=903` });
      expect(twice.statusCode).toBe(200);
      expect(chain.candidates[1].map(String)).toEqual(expect.arrayContaining(['902', '903']));
      // A chain reader with no scan and no explorer behind it cannot vouch for completeness.
      expect(twice.json().chain.partial).toBe(true);
    } finally {
      await app.close();
    }
  });

  /** Positions minted long ago, or sent here, are on neither the scan's window nor the lagging indexer. */
  it('asks the chain about every v4 NFT the explorer says the wallet holds, and then vouches for the list', async () => {
    process.env.LOG_LEVEL = 'silent';
    const { buildServer } = await import('./server');
    const chain = fakeChain();
    const saved = process.env.PORTFOLIO_EXPLORER;
    delete process.env.PORTFOLIO_EXPLORER;
    const app = await buildServer({
      portfolioChain: chain,
      v4Scanner: null,
      explorerFetch: async () =>
        new Response(
          JSON.stringify({ items: [{ id: '1234567', token: { address_hash: '0x58daec3116aae6D93017bAAea7749052E8a04fA7' } }] }),
        ),
    });
    await app.ready();
    try {
      const response = await app.inject({ method: 'GET', url: `/api/portfolio/${BOB}` });
      expect(response.statusCode).toBe(200);
      expect(chain.candidates[0].map(String)).toEqual(expect.arrayContaining(['41', '1234567']));
      expect(response.json().chain.partial).toBeUndefined();
      const health = (await app.inject({ method: 'GET', url: '/api/health' })).json();
      expect(health.portfolioExplorer.lastError).toBeNull();
      expect(health.api.uptimeSeconds).toBeGreaterThanOrEqual(0);
    } finally {
      process.env.PORTFOLIO_EXPLORER = saved;
      await app.close();
    }
  });

  it('reads nothing from the chain, and says so, when it was given no reader', async () => {
    const portfolio = await buildPortfolio(BOB, USDG);
    expect(portfolio!.chain).toEqual({ status: 'off', unreadable: 0 });
    expect(portfolio!.positions).toHaveLength(1);
  });
});

describe('v3 positions, enumerated on chain', () => {
  const TICK = -25_920;
  const v3held: V3OnchainPosition = {
    tokenId: 5n,
    token0: '0x0000000000000000000000000000000000000001',
    token1: WETH as Address,
    fee: 3000,
    tickLower: TICK - 1200,
    tickUpper: TICK + 1200,
    liquidity: 10n ** 21n,
    owed0: 0n,
    owed1: 0n,
  };

  beforeAll(async () => {
    await resetDatabase();
    const chain = buildV3Chain();
    const poller = new Poller({
      source: new FixtureLogSource(chain, chain.headBlock),
      usdgAddress: USDG,
      startBlock: 0n,
      blockRange: 100,
      v3Factory: V3_FACTORY,
      tokenReader: fixtureTokenReader,
    });
    await poller.syncToHead();
  });

  it('is valued through the pool the indexer knows, with no principal rather than a zero one', async () => {
    const portfolio = await buildPortfolio(BOB, USDG, { chain: fakeChain({ v3Positions: async () => [v3held] }) });
    expect(portfolio!.positions).toHaveLength(1);
    const [p] = portfolio!.positions;
    expect(p.tokenId).toBe('5');
    expect(p.poolId).toBe(V3_POOL_ID);
    expect(p.live!.protocol).toBe('v3');
    expect(p.live!.poolAddress).toBe(V3_POOL.toLowerCase());
    expect(p.live!.quote).toBe('ETH');
    expect(p.valueUsd).toBeGreaterThan(0);
    expect(p.inRange).toBe(true);
    expect(p.priceImpactUsd).toBeUndefined();
    expect(p.live!.holdUsd).toBeNull();
  });

  it('takes the principal and the fees collected from the position’s own history, when it adds up', async () => {
    const asked: bigint[][] = [];
    const chain = fakeChain({
      v3Positions: async () => [v3held],
      v3History: async (positions) => {
        asked.push(positions.map((p) => p.liquidity));
        return new Map([
          ['5', { deposited0: 10n ** 18n, deposited1: 10n ** 17n, collectedFees0: 7n, collectedFees1: 9n, liquidity: v3held.liquidity, mintedAt: new Date('2026-09-20T00:00:00Z'), collectedKnown: true }],
        ]);
      },
    });
    const [p] = (await buildPortfolio(BOB, USDG, { chain }))!.positions;
    // Asked with the chain's liquidity, which the history is checked against.
    expect(asked).toEqual([[v3held.liquidity]]);
    expect(p.live!.holdUsd).not.toBeNull();
    expect(p.priceImpactUsd).toBeCloseTo(p.valueUsd - p.live!.holdUsd!, 6);
    expect(p.live!.collectedFees0).toBe('7');
    expect(p.live!.collectedFees1).toBe('9');
    expect(p.live!.mintedAt).toBe('2026-09-20T00:00:00.000Z');
  });

  it('keeps listing the last v3 read when the next one does not answer, marked unchecked', async () => {
    const first = (await buildPortfolio(BOB, USDG, { chain: fakeChain({ v3Positions: async () => [v3held] }) }))!;
    expect(first.positions).toHaveLength(1);
    const next = (await buildPortfolio(BOB, USDG, {
      chain: fakeChain({
        v3Positions: async () => {
          throw new Error('429');
        },
      }),
    }))!;
    // A rate limit right after a collect used to make the position vanish.
    expect(next.positions.map((p) => p.tokenId)).toEqual(['5']);
    expect(next.chain?.v3Unchecked).toBe(true);
    expect(next.chain?.v3Unavailable).toBeFalsy();
  });

  it('passes the browser’s transaction hints for a v3 position to the history reader, and drops unknown collected fees', async () => {
    const seen: unknown[] = [];
    const chain = fakeChain({
      v3Positions: async () => [v3held],
      v3History: async (positions) => {
        seen.push(positions.map((p) => p.hints));
        return new Map([
          ['5', { deposited0: 10n ** 18n, deposited1: 10n ** 17n, collectedFees0: 0n, collectedFees1: 0n, liquidity: v3held.liquidity, mintedAt: null, collectedKnown: false }],
        ]);
      },
    });
    const hint = `0x${'ab'.repeat(32)}` as `0x${string}`;
    const [p] = (await buildPortfolio(BOB, USDG, { chain, v3TxHints: new Map([['5', [hint]]]) }))!.positions;
    expect(seen).toEqual([[[hint]]]);
    expect(p.live!.holdUsd).not.toBeNull();
    expect(p.live!.collectedFees0 ?? null).toBeNull();
  });

  it('values a position at today’s price when the chain answered for the pool and ether is priced live', async () => {
    const at = async (ethUsd: number | null, tick: number) =>
      (
        await buildPortfolio(BOB, USDG, {
          chain: fakeChain({
            v3Positions: async () => [v3held],
            slot0s: async (pools) => new Map(pools.map((p) => [p.id, { sqrtPriceX96: getSqrtRatioAtTick(tick), tick }])),
          }),
          ethUsd,
        })
      )!;
    const today = await at(2000, TICK);
    expect(today.pricedToday).toBe(true);
    // The traded token is priced off the live tick: a higher token1-per-token0 price is worth more.
    const higher = await at(2000, TICK + 600);
    expect(higher.positions[0].live!.priceUsd0).toBeGreaterThan(today.positions[0].live!.priceUsd0);
    expect(today.positions[0].live!.priceUsd1).toBe(2000);
    // Without a live ether price the valuation is the indexer's, and says so.
    expect((await at(null, TICK)).pricedToday).toBe(false);
  });

  it('finds the pool on the factory when the indexer has not met it, and counts one the factory does not know', async () => {
    const other = { ...v3held, tokenId: 6n, fee: 500 };
    const nowhere = { ...v3held, tokenId: 7n, fee: 10_000 };
    const found = '0x0000000000000000000000000000000000003002';
    const chain = fakeChain({
      v3Positions: async () => [v3held, other, nowhere],
      v3PoolAddresses: async (keys) =>
        new Map(keys.map((k) => [`${k.token0.toLowerCase()}|${k.token1.toLowerCase()}|${k.fee}`, k.fee === 500 ? found : '0x0000000000000000000000000000000000000000'])),
    });
    const portfolio = await buildPortfolio(BOB, USDG, { chain });
    expect(portfolio!.positions.map((p) => p.tokenId).sort()).toEqual(['5', '6']);
    const six = portfolio!.positions.find((p) => p.tokenId === '6')!;
    expect(six.poolId).toBe(`v3:${found}`);
    expect(six.live!.poolAddress).toBe(found);
    expect(six.live!.key.tickSpacing).toBe(10);
    expect(six.live!.unindexedPool).toBe(true);
    expect(portfolio!.chain.unreadable).toBe(1);
  });

  /** A v3 pool is announced without a price; until the chain or the indexer gives one, the row must not say "earning nothing". */
  it('says range and value are unknown when neither the indexer nor the chain gave the pool a price', async () => {
    await prisma.poolState.deleteMany({ where: { poolId: V3_POOL_ID } });
    const noPrice = await buildPortfolio(BOB, USDG, { chain: fakeChain({ v3Positions: async () => [v3held] }) });
    expect(noPrice!.positions[0].rangeUnknown).toBe(true);
    expect(noPrice!.positions[0].valueUnknown).toBe(true);

    // The chain's slot0 answers the range even with no dollar price.
    const withSlot0 = await buildPortfolio(BOB, USDG, {
      chain: fakeChain({
        v3Positions: async () => [v3held],
        slot0s: async () => new Map([[V3_POOL_ID, { sqrtPriceX96: getSqrtRatioAtTick(TICK), tick: TICK }]]),
      }),
    });
    expect(withSlot0!.positions[0].rangeUnknown).toBeUndefined();
    expect(withSlot0!.positions[0].inRange).toBe(true);
    expect(withSlot0!.positions[0].valueUnknown).toBe(true);
  });
});
