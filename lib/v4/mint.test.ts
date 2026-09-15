import { describe, expect, it } from 'vitest';
import { decodeAbiParameters, hexToBytes } from 'viem';
import { Actions } from './actions';
import { amount0InCurrency1 } from './liquidity';
import { planMint, rangeTicks, splitRange } from './mint';
import { POOL_KEY_COMPONENTS, type PoolKey } from './pool';
import { getSqrtRatioAtTick } from './tick-math';

const ZERO = '0x0000000000000000000000000000000000000000' as const;
const TOKEN = '0x2222222222222222222222222222222222222222' as const;
const USDG = '0x1111111111111111111111111111111111111111' as const;
const OWNER = '0x000000000000000000000000000000000000dEaD' as const;

/** ETH/TOKEN: ether is currency0, the token currency1 — the common shape on this chain. */
const ETH_POOL: PoolKey = { currency0: ZERO, currency1: TOKEN, fee: 3000, tickSpacing: 60, hooks: ZERO };
/** USDG/TOKEN: two ERC20s, USDG the quote as currency0. */
const ERC20_POOL: PoolKey = { currency0: USDG, currency1: TOKEN, fee: 500, tickSpacing: 10, hooks: ZERO };

function decodeActions(unlockData: `0x${string}`) {
  const [actions, params] = decodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], unlockData);
  return { actions: Array.from(hexToBytes(actions)), params };
}

describe('rangeTicks', () => {
  it('maps a percent range around a currency0 token straight onto the pool', () => {
    expect(rangeTicks({ tick: 0, tickSpacing: 60, tokenIsCurrency0: true, minPct: -15, maxPct: 15 })).toEqual({
      tickLower: -1680,
      tickUpper: 1440,
    });
  });
  it('mirrors it for a currency1 token, whose price is the pool\'s inverse', () => {
    expect(rangeTicks({ tick: 0, tickSpacing: 60, tokenIsCurrency0: false, minPct: -15, maxPct: 15 })).toEqual({
      tickLower: -1440,
      tickUpper: 1680,
    });
  });
  it('never collapses to an empty range', () => {
    const r = rangeTicks({ tick: 7, tickSpacing: 60, tokenIsCurrency0: true, minPct: -0.001, maxPct: 0.001 });
    expect(r.tickUpper - r.tickLower).toBe(60);
  });
});

describe('splitRange', () => {
  it('covers the whole range in whole spacings, as evenly as it can, never more bins than spacings', () => {
    const bins = splitRange(-1680, 1440, 60, 24); // 52 spacings
    expect(bins).toHaveLength(24);
    expect(bins[0][0]).toBe(-1680);
    expect(bins[bins.length - 1][1]).toBe(1440);
    for (let i = 1; i < bins.length; i++) expect(bins[i][0]).toBe(bins[i - 1][1]);
    const widths = bins.map(([a, b]) => (b - a) / 60);
    expect(Math.max(...widths) - Math.min(...widths)).toBeLessThanOrEqual(1);
    expect(splitRange(0, 180, 60, 24)).toHaveLength(3);
  });
});

describe('planMint', () => {
  const sqrtPriceX96 = getSqrtRatioAtTick(-201_000); // 1 ETH ≈ 5.4e8 raw token units... a realistic-looking tick
  const deadline = 1_800_000_000n;

  it('spends the deposit: the positions are worth what was put in, at the live price', () => {
    const depositQuote = 10n ** 18n; // 1 ETH, currency0
    const plan = planMint({
      key: ETH_POOL,
      sqrtPriceX96,
      tick: -201_000,
      tokenIsCurrency0: false,
      depositQuote,
      minPct: -15,
      maxPct: 15,
      bins: 24,
      shape: 'spot',
      owner: OWNER,
      deadline,
    });
    const valueIn1 = plan.amount1 + amount0InCurrency1(plan.amount0, sqrtPriceX96);
    const target = amount0InCurrency1(depositQuote, sqrtPriceX96);
    // Within a tenth of a percent: per-bin rounding down, never up.
    expect(valueIn1 <= target).toBe(true);
    expect(Number(valueIn1) / Number(target)).toBeGreaterThan(0.999);
    expect(plan.positions.length).toBe(24);
    expect(plan.amount0 > 0n && plan.amount1 > 0n).toBe(true);
  });

  it('plans a full-range stake as one position from the lowest usable tick to the highest', () => {
    // A stake (§20): the whole price line, one NFT, never out of range. The
    // inputs a shaped range needs are ignored, and both sides are taken at
    // the current price.
    const sqrtPriceX96 = getSqrtRatioAtTick(-201_000);
    const plan = planMint({
      key: ETH_POOL,
      sqrtPriceX96,
      tick: -201_000,
      tokenIsCurrency0: false,
      depositQuote: 10n ** 18n,
      minPct: -15,
      maxPct: 15,
      bins: 24,
      shape: 'curve',
      fullRange: true,
      owner: OWNER,
      deadline: 1_800_000_000n,
    });
    expect(plan.positions).toHaveLength(1);
    expect(plan.tickLower).toBe(-887_220);
    expect(plan.tickUpper).toBe(887_220);
    expect(plan.positions[0].tickLower).toBe(-887_220);
    expect(plan.positions[0].tickUpper).toBe(887_220);
    expect(plan.amount0 > 0n && plan.amount1 > 0n).toBe(true);
  });

  it('sends ether as msg.value with a tolerance, and sweeps the rest back to the owner', () => {
    const plan = planMint({
      key: ETH_POOL,
      sqrtPriceX96,
      tick: -201_000,
      tokenIsCurrency0: false,
      depositQuote: 10n ** 18n,
      minPct: -10,
      maxPct: 10,
      bins: 6,
      shape: 'curve',
      owner: OWNER,
      slippageBps: 50,
      deadline,
    });
    expect(plan.value).toBe(plan.amount0Max);
    expect(plan.amount0Max > plan.amount0).toBe(true);
    expect(Number(plan.amount0Max) / Number(plan.amount0)).toBeCloseTo(1.005, 3);
    const { actions, params } = decodeActions(plan.unlockData);
    expect(actions).toEqual([...Array(plan.positions.length).fill(Actions.MINT_POSITION), Actions.SETTLE_PAIR, Actions.SWEEP]);
    const [currency, to] = decodeAbiParameters([{ type: 'address' }, { type: 'address' }], params[params.length - 1]);
    expect(currency).toBe(ZERO);
    expect(to.toLowerCase()).toBe(OWNER.toLowerCase());
  });

  it('mints every position to the owner, inside the range, with the pool\'s key', () => {
    const plan = planMint({
      key: ETH_POOL,
      sqrtPriceX96,
      tick: -201_000,
      tokenIsCurrency0: false,
      depositQuote: 10n ** 18n,
      minPct: -15,
      maxPct: 15,
      bins: 8,
      shape: 'bidask',
      owner: OWNER,
      deadline,
    });
    const { params } = decodeActions(plan.unlockData);
    for (let i = 0; i < plan.positions.length; i++) {
      const [key, lower, upper, liquidity, , , owner] = decodeAbiParameters(
        [
          { type: 'tuple', components: POOL_KEY_COMPONENTS },
          { type: 'int24' },
          { type: 'int24' },
          { type: 'uint256' },
          { type: 'uint128' },
          { type: 'uint128' },
          { type: 'address' },
          { type: 'bytes' },
        ],
        params[i],
      );
      expect(key).toEqual(ETH_POOL);
      expect(lower).toBe(plan.positions[i].tickLower);
      expect(upper).toBe(plan.positions[i].tickUpper);
      expect(lower >= plan.tickLower && upper <= plan.tickUpper).toBe(true);
      expect(liquidity).toBe(plan.positions[i].liquidity);
      expect(owner.toLowerCase()).toBe(OWNER.toLowerCase());
    }
  });

  it('puts the heavy bins where the shape says, along the token\'s price rather than the pool\'s tick', () => {
    // Bid-ask: heavy at both ends, light in the middle, whichever way the pool runs.
    const plan = planMint({
      key: ETH_POOL,
      sqrtPriceX96,
      tick: -201_000,
      tokenIsCurrency0: false,
      depositQuote: 10n ** 18n,
      minPct: -15,
      maxPct: 15,
      bins: 9,
      shape: 'bidask',
      owner: OWNER,
      deadline,
    });
    const values = plan.positions.map((p) => p.amount1 + amount0InCurrency1(p.amount0, sqrtPriceX96));
    const mid = values[4];
    expect(values[0] > mid && values[8] > mid).toBe(true);
  });

  it('needs no ether and no sweep for a pool of two ERC20s', () => {
    const plan = planMint({
      key: ERC20_POOL,
      sqrtPriceX96: getSqrtRatioAtTick(276_000), // USDG (6 dp) per 18-dp token
      tick: 276_000,
      tokenIsCurrency0: false,
      depositQuote: 1_000_000_000n, // 1000 USDG
      minPct: -20,
      maxPct: 20,
      bins: 12,
      shape: 'spot',
      owner: OWNER,
      deadline,
    });
    expect(plan.value).toBe(0n);
    const { actions } = decodeActions(plan.unlockData);
    expect(actions[actions.length - 1]).toBe(Actions.SETTLE_PAIR);
    expect(actions).not.toContain(Actions.SWEEP);
  });

  it('a range entirely above the token\'s price is all token, entirely below all quote', () => {
    const above = planMint({
      key: ETH_POOL, sqrtPriceX96, tick: -201_000, tokenIsCurrency0: false, depositQuote: 10n ** 18n,
      minPct: 5, maxPct: 20, bins: 4, shape: 'spot', owner: OWNER, deadline,
    });
    // Token is currency1; above its price is below the pool's tick: all currency1.
    expect(above.amount0).toBe(0n);
    expect(above.amount1 > 0n).toBe(true);
    const below = planMint({
      key: ETH_POOL, sqrtPriceX96, tick: -201_000, tokenIsCurrency0: false, depositQuote: 10n ** 18n,
      minPct: -20, maxPct: -5, bins: 4, shape: 'spot', owner: OWNER, deadline,
    });
    expect(below.amount1).toBe(0n);
    expect(below.amount0 > 0n).toBe(true);
  });

  it('refuses a deposit of nothing', () => {
    expect(() =>
      planMint({ key: ETH_POOL, sqrtPriceX96, tick: -201_000, tokenIsCurrency0: false, depositQuote: 0n, minPct: -1, maxPct: 1, bins: 2, shape: 'spot', owner: OWNER, deadline }),
    ).toThrow(/positive/);
  });
});
