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
 * Only the hue varies. Saturation and lightness are fixed, not derived.
 *
 * Deriving them would eventually produce a mark that vanishes into the paper,
 * or one close enough to the accent green that §5's colour rule stops
 * meaning anything. Fixing them means every mark carries the same weight in
 * a listing and the ink's contrast is knowable in advance.
 *
 * The disc is a pastel tint — light enough to sit on paper without shouting —
 * and the ink is the same hue, dark, so the monogram reads as one object
 * rather than black text stamped on a coloured circle. The numbers were
 * measured, not chosen by eye: across all 360 hues this pair keeps the
 * monogram at 5.06:1 or better, with yellow (hue 60) the hardest case, as it
 * is for any light disc.
 */
const DISC_SAT = 60;
const DISC_LIGHT = 86;
const INK_SAT = 45;
const INK_LIGHT = 28;

export interface TokenMark {
  /** Disc fill. */
  bg: string;
  /** Monogram colour: the disc's own hue, dark enough to read on it. */
  ink: string;
}

/** sRGB relative luminance of an HSL colour, for the contrast test. */
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

function contrast(a: number, b: number): number {
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

export function tokenMark(address: string): TokenMark {
  const hue = hash(address.toLowerCase()) % 360;
  return {
    bg: `hsl(${hue} ${DISC_SAT}% ${DISC_LIGHT}%)`,
    ink: `hsl(${hue} ${INK_SAT}% ${INK_LIGHT}%)`,
  };
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
  DISC_SAT,
  DISC_LIGHT,
  INK_SAT,
  INK_LIGHT,
  luminance,
  contrast,
};
