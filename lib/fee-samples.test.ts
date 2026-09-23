import { describe, expect, it } from 'vitest';
import { dailyEarnedUsd, recordEarned } from './fee-samples';

const DAY = 86_400_000;
const T0 = Date.parse('2026-09-20T12:00:00Z');
const r = (e0: bigint, e1: bigint, mintedAt: string | null = null) => ({ ref: 'v3:1', earned0: e0, earned1: e1, usdPerUnit0: 1, usdPerUnit1: 2, mintedAt });

describe('fees earned per day, as this browser measured them', () => {
  it('is each day’s growth since the previous day recorded, valued at today’s prices', () => {
    let store = recordEarned('0xAB', [r(10n, 1n)], T0, {});
    store = recordEarned('0xab', [r(15n, 3n)], T0 + DAY, store);
    store = recordEarned('0xab', [r(15n, 3n)], T0 + 2 * DAY, store);
    const out = dailyEarnedUsd('0xab', [r(15n, 3n)], { now: T0 + 2 * DAY, store });
    expect(out.since).toBe('2026-09-20');
    // Day one has no baseline: nothing is claimed for it. Day two: 5 + 2×2.
    expect(out.values).toEqual([0, 9, 0]);
  });

  it('counts the first day from zero when the position was minted that day', () => {
    const store = recordEarned('0xab', [r(4n, 0n, '2026-09-20T01:00:00Z')], T0, {});
    expect(dailyEarnedUsd('0xab', [r(4n, 0n, '2026-09-20T01:00:00Z')], { now: T0, store }).values).toEqual([4]);
  });

  it('never counts a fall as negative fees', () => {
    let store = recordEarned('0xab', [r(10n, 0n)], T0, {});
    store = recordEarned('0xab', [r(3n, 0n)], T0 + DAY, store);
    expect(dailyEarnedUsd('0xab', [r(3n, 0n)], { now: T0 + DAY, store }).values).toEqual([0, 0]);
  });

  it('draws nothing for a wallet it has never measured', () => {
    expect(dailyEarnedUsd('0xcd', [r(1n, 1n)], { now: T0, store: {} })).toEqual({ values: [], since: null });
  });
});
