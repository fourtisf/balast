import { describe, expect, it } from 'vitest';
import type { MarketQuote, Pool } from '../../lib/data/types';
import { LiveReserves, RESERVES_MAX_AGE_MS } from './live-reserves';
import { currentLiquidity } from './snapshot';

const TOKEN = '0x00000000000000000000000000000000000000a1';
const USDG = '0x00000000000000000000000000000000000000d6';

function v3Pool(overrides: Partial<Pool> = {}): Pool {
  return {
    id: 'v3:0xpool',
    address: '0xpool',
    protocol: 'v3',
    token: { address: TOKEN, symbol: 'VIRTUAL', name: 'Virtual', decimals: 18, logoColor: '#000' },
    key: { currency0: TOKEN, currency1: USDG, fee: 3000, tickSpacing: 60, hooks: '0x0000000000000000000000000000000000000000', decimals0: 18, decimals1: 6 },
    now: { priceUsd: 0.75 } as Pool['now'],
    market: null,
    ...overrides,
  } as Pool;
}

const priceNow = (pool: Pool, address: string): number | null =>
  address.toLowerCase() === USDG ? 1 : address.toLowerCase() === TOKEN ? (pool.now?.priceUsd ?? null) : null;

describe('a pool’s liquidity now', () => {
  it('values a v3 pool’s own balances at today’s prices', async () => {
    let now = 1_000;
    const reserves = new LiveReserves({
      now: () => now,
      // 100,000 VIRTUAL and 80,000 USDG in the pool.
      read: async (pools) => new Map(pools.map((p) => [p.id, { amount0: 100_000n * 10n ** 18n, amount1: 80_000n * 10n ** 6n }])),
    });
    reserves.follow([{ id: 'v3:0xpool', address: '0xpool', token0: TOKEN, token1: USDG }]);
    await reserves.refresh();
    const live = currentLiquidity(v3Pool(), reserves, priceNow);
    expect(live?.source).toBe('chain');
    expect(live?.usd).toBeCloseTo(100_000 * 0.75 + 80_000, 6);

    // A reading minutes old is not "now".
    now += RESERVES_MAX_AGE_MS + 1;
    expect(currentLiquidity(v3Pool(), reserves, priceNow)).toBeNull();
  });

  it('is unknown, not smaller, when a side has no price today', async () => {
    const reserves = new LiveReserves({
      read: async (pools) => new Map(pools.map((p) => [p.id, { amount0: 10n ** 18n, amount1: 10n ** 6n }])),
    });
    reserves.follow([{ id: 'v3:0xpool', address: '0xpool', token0: TOKEN, token1: USDG }]);
    await reserves.refresh();
    expect(currentLiquidity(v3Pool({ now: null }), reserves, priceNow)).toBeNull();
  });

  it('takes an aggregator’s figure only for the exact pool it describes', () => {
    const quote = { source: 'geckoterminal', poolLiquidityUsd: 50_000, poolLiquidityPool: '0xPOOL', at: 'x' } as unknown as MarketQuote;
    const v4 = v3Pool({ protocol: 'v4', market: quote });
    expect(currentLiquidity(v4, null, priceNow)).toEqual({ usd: 50_000, source: 'geckoterminal', at: 'x' });
    const sibling = v3Pool({ protocol: 'v4', address: '0xother', market: quote });
    expect(currentLiquidity(sibling, null, priceNow)).toBeNull();
  });

  it('reports a node that did not answer, and keeps no false reading', async () => {
    const reserves = new LiveReserves({
      read: async () => {
        throw new Error('pool reserves failed on all 4 endpoints:\n detail');
      },
    });
    reserves.follow([{ id: 'v3:0xpool', address: '0xpool', token0: TOKEN, token1: USDG }]);
    await reserves.refresh();
    expect(reserves.get('v3:0xpool')).toBeNull();
    expect(reserves.status().lastError).toBe('pool reserves failed on all 4 endpoints:');
  });

  it('asks for a rebuild once a read lands, and not after one that found nothing', async () => {
    let updates = 0;
    let answer = new Map<string, { amount0: bigint; amount1: bigint }>();
    const reserves = new LiveReserves({ read: async () => answer, onUpdate: () => updates++ });
    reserves.follow([{ id: 'v3:0xpool', address: '0xpool', token0: TOKEN, token1: USDG }]);
    await reserves.refresh();
    expect(updates).toBe(0);
    answer = new Map([['v3:0xpool', { amount0: 1n, amount1: 1n }]]);
    await reserves.refresh();
    expect(updates).toBe(1);
  });
});
