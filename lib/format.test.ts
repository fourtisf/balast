import { describe, expect, it } from 'vitest';
import { ageLabel, countdown, duration, feeTierLabel, inHours, price, signedPct, usd, usdExact, weth } from './format';

describe('usd', () => {
  it('scales to B / M / K / plain', () => {
    expect(usd(1.234e9)).toBe('$1.23B');
    expect(usd(52.5e6)).toBe('$52.50M');
    expect(usd(7710)).toBe('$7.7K');
    expect(usd(251)).toBe('$251');
  });

  it('scales negatives by magnitude, not by sign', () => {
    expect(usd(-52.5e6)).toBe('$-52.50M');
  });

  it('shows an em dash rather than NaN', () => {
    expect(usd(Number.NaN)).toBe('—');
    expect(usd(Number.POSITIVE_INFINITY)).toBe('—');
  });
});

describe('signedPct', () => {
  it('uses a real minus sign, not a hyphen', () => {
    expect(signedPct(-4)).toBe('−4.0%');
    expect(signedPct(11.2)).toBe('+11.2%');
    expect(signedPct(0)).toBe('+0.0%');
  });
});

describe('price', () => {
  it('gives sub-dollar tokens four decimals and the rest two', () => {
    expect(price(0.00115)).toBe('$0.0012');
    expect(price(187.2)).toBe('$187.2');
    expect(price(2521.08)).toBe('$2,521.08');
  });
});

describe('ageLabel', () => {
  it('reads hours under a day and days above', () => {
    expect(ageLabel(1)).toBe('1h');
    expect(ageLabel(23.9)).toBe('23h');
    expect(ageLabel(24)).toBe('1d');
    expect(ageLabel(69 * 24)).toBe('69d');
  });

  it('never shows a zero-hour age', () => {
    expect(ageLabel(0.2)).toBe('1h');
  });
});

describe('countdown', () => {
  it('matches the prototype phrasing', () => {
    expect(countdown(4 * 86400 + 11 * 3600)).toBe('4d 11h left');
    expect(countdown(2 * 3600 + 30 * 60)).toBe('2h 30m left');
    expect(countdown(45 * 60)).toBe('45m left');
  });

  it('says complete rather than a negative time', () => {
    expect(countdown(0)).toBe('complete');
    expect(countdown(-10)).toBe('complete');
  });
});

describe('inHours', () => {
  it('falls back to minutes under an hour', () => {
    expect(inHours(3 * 3600)).toBe('in 3h');
    expect(inHours(20 * 60)).toBe('in 20m');
    expect(inHours(5)).toBe('in 1m');
  });
});

describe('weth and usdExact', () => {
  it('formats to a fixed number of places', () => {
    expect(weth(2.183)).toBe('2.183 WETH');
    expect(weth(0.88, 2)).toBe('0.88 WETH');
    expect(usdExact(5_142_908)).toBe('$5,142,908');
    expect(usdExact(2521.08, 2)).toBe('$2,521.08');
  });
});

describe('duration', () => {
  it('reads as days and hours once the lag is days, and never as seven digits of seconds', () => {
    expect(duration(5_937_929)).toBe('68d 17h');
    expect(duration(7_384)).toBe('2h 3m');
    expect(duration(125)).toBe('2m 5s');
    expect(duration(42)).toBe('42s');
    expect(duration(-3)).toBe('0s');
  });
});

describe('feeTierLabel', () => {
  it('names a fee tier without trailing zeroes', () => {
    // The tier is part of what names a market in the builder's picker, and a
    // token on this chain has several: 0.05%, 0.3%, 1%, and a launchpad
    // curve's 6.9%.
    expect(feeTierLabel(30)).toBe('0.3%');
    expect(feeTierLabel(100)).toBe('1%');
    expect(feeTierLabel(500)).toBe('5%');
    expect(feeTierLabel(690)).toBe('6.9%');
    expect(feeTierLabel(5)).toBe('0.05%');
  });
});
