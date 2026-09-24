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

  it('varies only the hue, and gives the ink the same hue as the disc', () => {
    // Deriving saturation or lightness would eventually produce a mark that
    // vanishes into the paper, or one close enough to the accent green that
    // §5 stops meaning anything.
    for (let i = 0; i < 200; i++) {
      const mark = tokenMark(`0x${(i * 7919).toString(16).padStart(40, '0')}`);
      const disc = /^hsl\((\d{1,3}) 40% 20%\)$/.exec(mark.bg);
      const ink = /^hsl\((\d{1,3}) 70% 80%\)$/.exec(mark.ink);
      expect(disc, mark.bg).not.toBeNull();
      expect(ink, mark.ink).not.toBeNull();
      expect(ink![1]).toBe(disc![1]);
    }
  });

  /**
   * The guarantee, re-derived rather than asserted.
   *
   * The badge is aria-hidden and the ticker sits beside it as real text, so
   * the monogram is decorative — but an illegible badge is still a bad badge.
   * This walks all 360 hues the hash can produce and checks the ink clears
   * the bar on each one. Blue is the hard case for a light ink: at the same
   * lightness it is the darkest hue, so it is where the pair is tuned.
   */
  it('keeps the monogram legible on every hue it can produce', () => {
    const { DISC_SAT, DISC_LIGHT, INK_SAT, INK_LIGHT, luminance, contrast } = MARK_INTERNALS;

    let worst = Infinity;
    let worstHue = -1;
    for (let hue = 0; hue < 360; hue++) {
      const ratio = contrast(
        luminance(hue, DISC_SAT, DISC_LIGHT),
        luminance(hue, INK_SAT, INK_LIGHT),
      );
      if (ratio < worst) {
        worst = ratio;
        worstHue = hue;
      }
    }
    // WCAG AA for body text, on every hue, not on average.
    expect(worst).toBeGreaterThan(4.5);
    // Measured at 7.12:1 across the whole wheel, worst at hue 240. Anything
    // materially below that means the palette moved and the measurement
    // needs redoing.
    expect(worst).toBeGreaterThan(7);
    expect(worstHue).toBe(240);
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
