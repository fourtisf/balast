/**
 * A visual identity for every token, whether or not anyone published a logo.
 *
 * Most tokens on a new chain are in no token list, and §4 allows logos from
 * external sources but numbers from none — so for the majority there is no
 * real logo to fetch and there may never be. The honest answer is not a blank
 * circle: it is a mark *derived* from the token's address, so it is unique,
 * stable forever, and identical on the server and in the browser.
 *
 * It is a monogram, the way a contact without a photo gets their initials —
 * recognisable, clearly generated, and never mistaken for a brand's own
 * artwork. A real logo replaces it the moment one is available.
 *
 * Deterministic on purpose. A random or time-based colour would differ
 * between the server render and the client's — which React reports as a
 * hydration mismatch — and would make a token look like a different token on
 * every reload.
 */

/**
 * FNV-1a. Small, fast, and — unlike a sum of char codes — it spreads
 * addresses that share a prefix, which matters because factory-deployed and
 * vanity addresses often do.
 */
function hash(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    // The FNV prime as shifts, so this stays in 32-bit integer arithmetic.
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

/**
 * Saturation and lightness are fixed, not derived.
 *
 * Deriving them would eventually produce a near-black token invisible on a
 * near-black page, or one close enough to the accent green that §5's colour
 * rule stops meaning anything. Fixing them means only the hue varies, every
 * mark carries the same weight in a listing, and the ink's contrast is
 * knowable in advance rather than hoped for.
 *
 * 55/55 was measured, not chosen by eye: across all 360 hues it is the
 * saturation and lightness that keeps the monogram at 4.26:1 or better while
 * still matching the weight of the prototype's own badges.
 */
const SAT = 55;
const LIGHT = 55;

/** The two inks. Whichever contrasts better with a given hue is used. */
const INK_DARK = '#0A0F0D';
const INK_LIGHT = '#F4F9F6';

export interface TokenMark {
  /** Disc fill. */
  bg: string;
  /** Monogram colour, picked per hue so it is legible on that fill. */
  ink: string;
}

/** sRGB relative luminance of an HSL colour, for the contrast decision. */
function luminance(h: number, s: number, l: number): number {
  const sat = s / 100;
  const light = l / 100;
  const a = sat * Math.min(light, 1 - light);
  const channel = (n: number) => {
    const k = (n + h / 30) % 12;
    return light - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)));
  };
  const linear = [channel(0), channel(8), channel(4)].map((v) =>
    v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

/** sRGB relative luminance of a #rrggbb colour. */
function hexLuminance(hex: string): number {
  const linear = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

/**
 * Computed, not written down.
 *
 * These were hardcoded once, and the numbers were wrong — 0.0106 against a
 * true 0.0044 — which flipped the ink choice on part of the wheel and quietly
 * cost about 0.3 of contrast. A constant that has to agree with another
 * constant is a constant that will eventually disagree with it.
 */
const INK_DARK_LUM = hexLuminance(INK_DARK);
const INK_LIGHT_LUM = hexLuminance(INK_LIGHT);

function contrast(a: number, b: number): number {
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

export function tokenMark(address: string): TokenMark {
  const hue = hash(address.toLowerCase()) % 360;
  const bgLum = luminance(hue, SAT, LIGHT);
  // Yellow at this lightness is far brighter than blue at the same lightness,
  // so no single ink is readable across the wheel. Pick per hue.
  const ink =
    contrast(INK_DARK_LUM, bgLum) >= contrast(INK_LIGHT_LUM, bgLum)
      ? INK_DARK
      : INK_LIGHT;
  return { bg: `hsl(${hue} ${SAT}% ${LIGHT}%)`, ink };
}

/**
 * One or two characters for the monogram.
 *
 * Two is the prototype's choice and it is the right one: one collides
 * constantly across a listing, three stops fitting at 22px.
 */
export function monogram(symbol: string): string {
  const clean = symbol.replace(/[^A-Za-z0-9]/g, '');
  return (clean || '?').slice(0, 2).toUpperCase();
}

/** Exported for the contrast test, which re-derives the guarantee. */
export const MARK_INTERNALS = {
  SAT,
  LIGHT,
  INK_DARK,
  INK_LIGHT,
  luminance,
  hexLuminance,
  contrast,
};
