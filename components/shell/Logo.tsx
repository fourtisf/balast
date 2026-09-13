/**
 * The Depth mark: bathymetric contours.
 *
 * Three nested contours hanging from a common surface line — how depth is
 * drawn on a chart of a seabed, and the same shape the `curve` generator in
 * the position builder produces. The mark and the product's core control are
 * the same drawing.
 *
 * Construction, on a 32 × 32 grid (32 halves cleanly to 16, so every even
 * coordinate lands on a whole pixel in the favicon):
 *
 *   surface line   y = 12.5, terminals rise to y = 7.5
 *   radii          12 · 7.8 · 3.6   — offset 4.2 apart, so the gap between
 *                  strokes is identical everywhere by construction
 *   stroke         2.6, round caps
 *   ink box        26.6 × 19.6, centred on (16, 16)
 *
 * Each contour is a vertical terminal, a true semicircle, and a second
 * vertical terminal. A circle's tangent at its leftmost and rightmost point
 * is vertical, so the straight terminals meet the arc without a kink.
 *
 * The mark does not survive 16px as three strokes — 1.6 units of gap is
 * 0.8px there — so it steps down in three cuts rather than blurring shut.
 * Pick one with `variant`, or let `size` choose.
 */

export type MarkVariant = 'full' | 'compact' | 'minimal';

/** Below this a two-contour cut reads better than three. */
const COMPACT_BELOW = 32;
/** Below this only a solid silhouette holds. */
const MINIMAL_BELOW = 20;

export function variantForSize(size: number): MarkVariant {
  if (size < MINIMAL_BELOW) return 'minimal';
  if (size < COMPACT_BELOW) return 'compact';
  return 'full';
}

/** Three contours. The primary mark, for anything 32px and up. */
const FULL = [
  'M 4 7.5 L 4 12.5 A 12 12 0 0 0 28 12.5 L 28 7.5',
  'M 8.2 7.5 L 8.2 12.5 A 7.8 7.8 0 0 0 23.8 12.5 L 23.8 7.5',
  'M 12.4 7.5 L 12.4 12.5 A 3.6 3.6 0 0 0 19.6 12.5 L 19.6 7.5',
];

/** Two contours, heavier and further apart, for 20–32px. */
const COMPACT = [
  'M 4 7.5 L 4 12.5 A 12 12 0 0 0 28 12.5 L 28 7.5',
  'M 10 7.5 L 10 12.5 A 6 6 0 0 0 22 12.5 L 22 7.5',
];

/**
 * One solid band, outer edge at r=12 and inner edge at r=6 — six units of
 * unbroken ink, which is 3px at favicon size. The inner edge is traversed
 * back the other way, hence the flipped sweep flag.
 */
const MINIMAL =
  'M 4 7.5 L 4 12.5 A 12 12 0 0 0 28 12.5 L 28 7.5 L 22 7.5 L 22 12.5 A 6 6 0 0 1 10 12.5 L 10 7.5 Z';

export interface MarkProps {
  /** Rendered size in px. Also picks the cut unless `variant` is given. */
  size?: number;
  variant?: MarkVariant;
  /**
   * `mono` is the primary: one colour, which is how every token list, block
   * explorer and wallet picker will render it. `graduated` fades the outer
   * contours back so the nesting reads as shallow to deep — for a hero, not
   * for a favicon.
   */
  tone?: 'mono' | 'graduated';
  /** Any CSS colour. Defaults to the accent. */
  color?: string;
  title?: string;
  className?: string;
}

export function Mark({
  size = 32,
  variant,
  tone = 'mono',
  color = 'var(--ac)',
  title,
  className,
}: MarkProps) {
  const cut = variant ?? variantForSize(size);
  const labelled = title ? { role: 'img' as const, 'aria-label': title } : { 'aria-hidden': true };

  if (cut === 'minimal') {
    return (
      <svg width={size} height={size} viewBox="0 0 32 32" className={className} {...labelled}>
        {/* A hairline stroke on the same fill softens the corners without
            changing the silhouette. */}
        <path
          d={MINIMAL}
          fill={color}
          stroke={color}
          strokeWidth={1.2}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      </svg>
    );
  }

  const paths = cut === 'compact' ? COMPACT : FULL;
  const width = cut === 'compact' ? 3.2 : 2.6;
  // Shallow to deep. Stepping the opacity of one colour rather than picking
  // three greens keeps the hue honest, keeps every contour visible on a dark
  // ground as well as a light one, and adds nothing to §5's palette.
  const fade = cut === 'compact' ? [0.6, 1] : [0.52, 0.76, 1];

  return (
    <svg width={size} height={size} viewBox="0 0 32 32" className={className} {...labelled}>
      {paths.map((d, i) => (
        <path
          key={d}
          d={d}
          fill="none"
          stroke={color}
          strokeOpacity={tone === 'graduated' ? fade[i] : 1}
          strokeWidth={width}
          strokeLinecap="round"
        />
      ))}
    </svg>
  );
}

/**
 * Mark plus wordmark.
 *
 * At a font size of 0.62 × the mark's box, JetBrains Mono's cap height puts
 * the mark's ink at 1.353 × the caps — measured, not guessed. The flex gap
 * sits between the two boxes, and the mark carries 2.7 units of padding
 * inside its own, so the optical gap lands near 0.5 × the box.
 *
 * The distributable files in brand/ are built from the same numbers by
 * scripts/build-brand.py, with the wordmark converted to outlines.
 */
export function Lockup({
  size = 26,
  tone = 'mono',
  color = 'var(--ac)',
  wordColor = 'var(--fg)',
}: {
  size?: number;
  tone?: 'mono' | 'graduated';
  color?: string;
  wordColor?: string;
}) {
  return (
    <span
      className="lockup"
      style={{ display: 'inline-flex', alignItems: 'center', gap: size * 0.42 }}
    >
      <Mark size={size} tone={tone} color={color} />
      <span
        style={{
          fontSize: size * 0.62,
          fontWeight: 700,
          letterSpacing: '.14em',
          color: wordColor,
          lineHeight: 1,
        }}
      >
        DEPTH
      </span>
    </span>
  );
}
