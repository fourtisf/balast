import { describe, expect, it } from 'vitest';
import type { UserPosition } from './data/types';
import { impactPctText, impactText, priceImpactOf } from './price-impact';

const pos = (impact: number | undefined, hold: number | null) =>
  ({ priceImpactUsd: impact, live: hold === undefined ? undefined : { holdUsd: hold } }) as unknown as UserPosition;

describe('price impact on holdings', () => {
  it('shows cents rather than rounding them to $0', () => {
    expect(impactText(-0.03)).toBe('−$0.03');
    expect(impactText(-0.004)).toBe('−<$0.01');
    expect(impactText(0)).toBe('$0');
    expect(impactText(0.02)).toBe('+$0.02');
    expect(impactText(-1234.5)).toBe('−$1,235');
  });

  it('sums the measured positions and gives the share of what holding would be worth', () => {
    const r = priceImpactOf([pos(-0.03, 27.38), pos(-1, 100), pos(undefined, null)]);
    expect(r.measured).toBe(2);
    expect(r.usd).toBeCloseTo(-1.03);
    expect(r.pct).toBeCloseTo((-1.03 / 127.38) * 100);
  });

  it('has no percentage when a measured position has no held value', () => {
    expect(priceImpactOf([pos(-0.5, null)]).pct).toBeNull();
    expect(priceImpactOf([]).pct).toBeNull();
  });

  it('prints the percentage small figures honestly', () => {
    expect(impactPctText(-0.1096)).toBe('−0.11%');
    expect(impactPctText(-0.004)).toBe('−<0.01%');
    expect(impactPctText(-3.456)).toBe('−3.5%');
    expect(impactPctText(null)).toBeNull();
  });
});
