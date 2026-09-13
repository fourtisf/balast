/**
 * The Depth mark: two solid blocks tapering toward a central gap.
 *
 * Heavy at the edges, void in the middle — the bid-ask distribution
 * `DepthShaper` mints, drawn at brand scale. The meaning lives in a wide void
 * rather than a hairline, which is why this cut needs no small-size variant:
 * the gap is 5 of 32 units, still 2.5px at favicon size.
 *
 * Construction, on a 32 × 32 grid (32 halves cleanly to 16, so every even
 * coordinate lands on a whole pixel in the favicon):
 *
 *   outer edges    x = 5 and 27, full height from y = 6 to 26
 *   inner edges    x = 13.5 and 18.5, starting lower at y = 13
 *   central gap    5 units
 *   ink box        23.6 × 21.6, centred on (16, 16)
 *
 * The corners are softened by a same-colour stroke with round joins, which
 * matches the product's radius language without moving the silhouette.
 *
 * The distributable files in brand/ are generated from these same numbers by
 * scripts/build-brand.py — change one, rerun `npm run brand`.
 */

const BLOCK_NEAR = 'M 5 6 L 13.5 13 L 13.5 26 L 5 26 Z';
const BLOCK_FAR = 'M 27 6 L 18.5 13 L 18.5 26 L 27 26 Z';
const JOIN = 1.6;

export interface MarkProps {
  /** Rendered size in px. */
  size?: number;
  /**
   * `duo` is the primary: the near block in the accent, the far one in the
   * deep accent, so the pair reads as depth rather than as two bars. `mono`
   * is the one-colour version every token list and block explorer will use.
   */
  tone?: 'duo' | 'mono';
  /** Any CSS colour. Overrides both blocks. */
  color?: string;
  title?: string;
  className?: string;
}

export function Mark({ size = 32, tone = 'duo', color, title, className }: MarkProps) {
  const near = color ?? 'var(--ac)';
  const far = color ?? (tone === 'duo' ? 'var(--ac-3)' : 'var(--ac)');
  const labelled = title
    ? { role: 'img' as const, 'aria-label': title }
    : { 'aria-hidden': true };

  return (
    <svg width={size} height={size} viewBox="0 0 32 32" className={className} {...labelled}>
      {([[BLOCK_NEAR, near], [BLOCK_FAR, far]] as const).map(([d, fill]) => (
        <path
          key={d}
          d={d}
          fill={fill}
          stroke={fill}
          strokeWidth={JOIN}
          strokeLinejoin="round"
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
 * the mark's ink at 1.491 × the caps. The flex gap sits between the two boxes
 * and the mark carries 4.2 units of padding inside its own, so the optical
 * gap lands near 0.36 × the box.
 */
export function Lockup({
  size = 26,
  tone = 'duo',
  color,
  wordColor = 'var(--fg)',
}: {
  size?: number;
  tone?: 'duo' | 'mono';
  color?: string;
  wordColor?: string;
}) {
  return (
    <span
      className="lockup"
      style={{ display: 'inline-flex', alignItems: 'center', gap: size * 0.22 }}
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
