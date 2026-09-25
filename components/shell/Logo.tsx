/**
 * The LockFi mark: the pin arch.
 *
 * A padlock's shackle and its tumbler pins drawn as one bar chart, tallest in
 * the middle — the curve shape the position builder draws. A lock made of
 * liquidity. One colour only, so it sits on the white brand tile, on the dark
 * page and on paper without a variant.
 *
 * Construction, on a 64 × 64 grid:
 *
 *   shackle    a 6.5-unit stroke, legs at x = 23 and 41, arc radius 9,
 *              from the baseline y = 53.5 up to the arc's centre at y = 22.5
 *   pins       6.5 wide, centred on x = 13, 32 and 51; the outer two 12
 *              tall, the middle one 21, all standing on the baseline
 *   ink box    44.5 × 43.25, centred on (32, 31.9)
 *
 * The distributable files (brand/lockfi/, app/icon.svg, public/og-card.png)
 * are written from these same numbers by scripts/build-brand-lockfi.mjs —
 * change one here, change it there, rerun `npm run brand:lockfi`.
 */

export const MARK_SHACKLE = 'M23 53.5V22.5a9 9 0 0 1 18 0v31';
export const MARK_STROKE = 6.5;
export const MARK_PINS = [
  { x: 9.75, y: 41.5, h: 12 },
  { x: 28.75, y: 32.5, h: 21 },
  { x: 47.75, y: 41.5, h: 12 },
] as const;
export const MARK_PIN_WIDTH = 6.5;
export const MARK_PIN_RADIUS = 1.5;

export interface MarkProps {
  /** Rendered size in px. */
  size?: number;
  /** Any CSS colour. Defaults to the page's foreground. */
  color?: string;
  title?: string;
  className?: string;
}

export function Mark({ size = 32, color = 'currentColor', title, className }: MarkProps) {
  const labelled = title
    ? { role: 'img' as const, 'aria-label': title }
    : { 'aria-hidden': true };

  return (
    <svg width={size} height={size} viewBox="0 0 64 64" className={className} {...labelled}>
      <path d={MARK_SHACKLE} fill="none" stroke={color} strokeWidth={MARK_STROKE} />
      {MARK_PINS.map((p) => (
        <rect
          key={p.x}
          x={p.x}
          y={p.y}
          width={MARK_PIN_WIDTH}
          height={p.h}
          rx={MARK_PIN_RADIUS}
          fill={color}
        />
      ))}
    </svg>
  );
}

/** Mark plus wordmark, set in the page's sans at the mark's optical weight. */
export function Lockup({
  size = 26,
  color = 'var(--fg)',
  wordColor = 'var(--fg)',
}: {
  size?: number;
  color?: string;
  wordColor?: string;
}) {
  return (
    <span
      className="lockup"
      style={{ display: 'inline-flex', alignItems: 'center', gap: size * 0.3 }}
    >
      <Mark size={size} color={color} />
      <span
        style={{
          fontSize: size * 0.82,
          fontWeight: 700,
          letterSpacing: '-.04em',
          color: wordColor,
          lineHeight: 1,
        }}
      >
        LockFi
      </span>
    </span>
  );
}
