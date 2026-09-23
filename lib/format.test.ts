import { describe, expect, it } from 'vitest';
import { CONTRACTS, NATIVE_ETH } from './chain';
import type { Pool } from './data/types';
import {
  ageLabel,
  countdown,
  duration,
  feeTierLabel,
  feeTierBpsFromPips,
  DYNAMIC_FEE_FLAG,
  inHours,
  price,
  quoteCurrencyOf,
  quoteIsNativeEther,
  quoteIsWrappedEther,
  ether,
  quoteLabel,
  signedPct,
  usd,
  usdExact,
} from './format';

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

describe('ether and usdExact', () => {
  it('formats to a fixed number of places', () => {
    expect(ether(2.183)).toBe('2.183 ETH');
    expect(ether(0.88, 2)).toBe('0.88 ETH');
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

  /**
   * A v4 pool whose hook sets the fee carries a flag in its key, not a tier.
   * Read as a tier it is 8,388,608 pips — "838.86%" on the board.
   */
  it('names a v4 dynamic-fee pool "dynamic" rather than reading its flag as a tier', () => {
    expect(feeTierBpsFromPips('v4', DYNAMIC_FEE_FLAG)).toBeNull();
    expect(feeTierBpsFromPips('v4', 3000)).toBe(30);
    // v3 has no such flag; its fee is always a tier.
    expect(feeTierBpsFromPips('v3', 10_000)).toBe(100);
    expect(feeTierLabel(feeTierBpsFromPips('v4', DYNAMIC_FEE_FLAG))).toBe('dynamic');
  });
});

/**
 * Which side of a pool is the quote, and whether it is this chain's own
 * ether or the aeWETH wrapper.
 *
 * It decides what a wallet has to hold to enter a market — the builder puts
 * the native one first because that is the balance the wallet already
 * shows — so the answer is given once and asserted here. §18 is what
 * happens when several places answer it separately.
 */
const TOKEN = '0x2222222222222222222222222222222222222222';
type QuoteSided = Pick<Pool, 'quote' | 'key' | 'token' | 'protocol'>;

function market(quoteSide: string, protocol: 'v3' | 'v4' = 'v4', withKey = true): QuoteSided {
  // currency0 is the lower address, as a PoolKey always is; the token here
  // sorts above both quote sides used below.
  return {
    quote: 'ETH',
    protocol,
    token: { address: TOKEN } as Pool['token'],
    key: withKey
      ? { currency0: quoteSide, currency1: TOKEN, fee: 3000, tickSpacing: 60, hooks: NATIVE_ETH, decimals0: 18, decimals1: 18 }
      : undefined,
  };
}

describe('the quote side of a pair', () => {
  it('reads native ether and the wrapper apart', () => {
    expect(quoteCurrencyOf(market(NATIVE_ETH))).toBe(NATIVE_ETH);
    expect(quoteIsNativeEther(market(NATIVE_ETH))).toBe(true);
    expect(quoteIsWrappedEther(market(NATIVE_ETH))).toBe(false);

    expect(quoteIsNativeEther(market(CONTRACTS.weth))).toBe(false);
    expect(quoteIsWrappedEther(market(CONTRACTS.weth))).toBe(true);
  });

  it('answers whichever side the token is not', () => {
    const tokenIsCurrency0: QuoteSided = {
      quote: 'ETH',
      protocol: 'v4',
      token: { address: '0x0000000000000000000000000000000000000abc' } as Pool['token'],
      key: {
        currency0: '0x0000000000000000000000000000000000000abc',
        currency1: CONTRACTS.weth,
        fee: 3000,
        tickSpacing: 60,
        hooks: NATIVE_ETH,
        decimals0: 18,
        decimals1: 18,
      },
    };
    expect(quoteCurrencyOf(tokenIsCurrency0)).toBe(CONTRACTS.weth.toLowerCase());
    expect(quoteIsWrappedEther(tokenIsCurrency0)).toBe(true);
  });

  /**
   * One name for one asset (§27). aeWETH mints one token per ether, so the
   * pair is ETH whichever way the pool holds it; what the wrapper changes is
   * what the wallet must hold, and that is `quoteIsWrappedEther`'s job.
   */
  it('names an ether pair ETH however the pool holds it', () => {
    expect(quoteLabel(market(NATIVE_ETH))).toBe('ETH');
    expect(quoteLabel(market(CONTRACTS.weth))).toBe('ETH');
    expect(quoteLabel(market(NATIVE_ETH, 'v3', false))).toBe('ETH');
    expect(quoteLabel(market(NATIVE_ETH, 'v4', false))).toBe('ETH');
  });

  it('still knows which pools hold the wrapper, including the keyless v3 ones', () => {
    // No key: Uniswap v3 has no native-ether pool, so a v3 ether pair is
    // always the wrapper; a simulated pool has nothing on chain either way.
    expect(quoteCurrencyOf(market(NATIVE_ETH, 'v3', false))).toBeNull();
    expect(quoteIsNativeEther(market(NATIVE_ETH, 'v3', false))).toBe(false);
    expect(quoteIsWrappedEther(market(NATIVE_ETH, 'v3', false))).toBe(true);
    expect(quoteIsWrappedEther(market(NATIVE_ETH, 'v4', false))).toBe(false);
  });

  it('leaves a pair quoted in anything else alone', () => {
    const usdg: QuoteSided = { ...market(CONTRACTS.weth), quote: 'USDG' };
    expect(quoteLabel(usdg)).toBe('USDG');
    expect(quoteIsNativeEther(usdg)).toBe(false);
    // A USDG pool is not "the wrapper" even though the address matches the
    // fixture's: the quote decides first.
    expect(quoteIsWrappedEther(usdg)).toBe(false);
  });
});
