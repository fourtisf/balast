/**
 * The fee-history sparkline in a leaderboard row. Red only when the move
 * itself is negative (§5).
 *
 * Drawn in real pixels rather than stretched from a fixed viewBox: a
 * non-uniform stretch thickens the stroke horizontally, which reads as a
 * different line weight from one column width to the next.
 */
export function AreaSpark({
  values,
  negative,
  width = 240,
  height = 36,
  className,
}: {
  values: number[];
  negative: boolean;
  width?: number;
  height?: number;
  className?: string;
}) {
  const pad = 2;
  const max = Math.max(...values);
  const min = Math.min(...values);
  const range = max - min || 1;
  const steps = Math.max(1, values.length - 1);
  const points = values.map((v, i) => {
    const x = (i / steps) * width;
    const y = height - pad - ((v - min) / range) * (height - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const line = points.join(' ');
  const stroke = negative ? 'var(--red)' : 'var(--ac)';

  return (
    <svg
      className={className}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden="true"
    >
      {values.length > 1 && (
        <polygon points={`0,${height} ${line} ${width},${height}`} fill={stroke} opacity={0.12} />
      )}
      <polyline
        points={line}
        fill="none"
        stroke={stroke}
        strokeWidth={1.7}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}
