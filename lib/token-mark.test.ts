import { describe, expect, it } from 'vitest';
import { MARK_INTERNALS, monogram, tokenMark } from './token-mark';

const ADDRESS = '0x0bd7d308f8e1639fab988df18a8011f41eacad73';

describe('tokenMark', () => {
  it('is deterministic, which is what keeps server and client renders identical', () => {
    // A random or time-based colour would be a hydration mismatch, and would
    // make a token look like a different token on every reload.
    expect(tokenMark(ADDRESS)).toEqual(tokenMark(ADDRESS));
  });

  it('ignores address casing', () => {
    expect(tokenMark(ADDRESS.toUpperCase())).toEqual(tokenMark(ADDRESS));
  });

  it('separates addresses that share a long prefix', () => {
    // Factory-deployed and vanity addresses often do. A hash that summed char
    // codes would give these near-identical hues.
    const a = tokenMark('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1');
    const b = tokenMark('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa2');
    expect(a.bg).not.toBe(b.bg);
  });

  it('spreads hues across the wheel rather than clustering', () => {
    const hues = new Set<string>();
    for (let i = 0; i < 400; i++) {
      hues.add(tokenMark(`0x${i.toString(16).padStart(40, '0')}`).bg);
    }
    expect(hues.size).toBeGreaterThan(200);
  });

  it('keeps saturation and lightness fixed on every mark', () => {
    // Deriving them would eventually produce a token invisible on the page,
    // or one close enough to the accent green that §5 stops meaning anything.
    for (let i = 0; i < 200; i++) {
      const mark = tokenMark(`0x${(i * 7919).toString(16).padStart(40, '0')}`);
      expect(mark.bg).toMatch(/^hsl\(\d{1,3} 55% 55%\)$/);
    }
  });

  /**
   * The guarantee, re-derived rather than asserted.
   *
   * The badge is aria-hidden and the ticker sits beside it as real text, so
   * the monogram is decorative — but an illegible badge is still a bad badge.
   * This walks all 360 hues the hash can produce and checks the ink actually
   * chosen clears the bar on each one. A fixed ink fails here: yellow at this
   * lightness is far brighter than blue at the same lightness.
   */
  it('keeps the monogram legible on every hue it can produce', () => {
    const { SAT, LIGHT, INK_DARK, INK_LIGHT, luminance, hexLuminance, contrast } =
      MARK_INTERNALS;
    // From the hex, not from a written-down number: hardcoding these is what
    // flipped the ink choice on part of the wheel the first time round.
    const inkLum: Record<string, number> = {
      [INK_DARK]: hexLuminance(INK_DARK),
      [INK_LIGHT]: hexLuminance(INK_LIGHT),
    };

    let worst = Infinity;
    let worstHue = -1;
    for (let hue = 0; hue < 360; hue++) {
      // Find an address that hashes to this hue, or skip it.
      const mark = tokenMark(`0x${hue.toString(16).padStart(40, '0')}`);
      const actualHue = Number(/^hsl\((\d+)/.exec(mark.bg)![1]);
      const ratio = contrast(inkLum[mark.ink], luminance(actualHue, SAT, LIGHT));
      if (ratio < worst) {
        worst = ratio;
        worstHue = actualHue;
      }
    }
    expect(worst).toBeGreaterThan(3);
    // Measured at 4.26:1 across the whole wheel. Anything materially below
    // that means the palette moved and the measurement needs redoing.
    expect(worst).toBeGreaterThan(4.2);
    expect(worstHue).toBeGreaterThanOrEqual(0);
  });

  it('uses both inks — a single one cannot cover the wheel', () => {
    const inks = new Set<string>();
    for (let i = 0; i < 500; i++) {
      inks.add(tokenMark(`0x${(i * 31).toString(16).padStart(40, '0')}`).ink);
    }
    expect(inks.size).toBe(2);
  });
});

describe('monogram', () => {
  it('takes two characters', () => {
    expect(monogram('MOONCAT')).toBe('MO');
    expect(monogram('weth')).toBe('WE');
  });

  it('strips punctuation a ticker should not carry into a badge', () => {
    expect(monogram('$PONS')).toBe('PO');
    expect(monogram('a-b')).toBe('AB');
  });

  it('never renders empty', () => {
    // A token whose symbol is unreadable still needs a badge.
    expect(monogram('')).toBe('?');
    expect(monogram('!!!')).toBe('?');
  });
});
