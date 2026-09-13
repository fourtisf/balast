/** The 14-bar fee history in a pool row. */
export function BarSpark({ values }: { values: number[] }) {
  const max = Math.max(...values, 1);
  return (
    <svg className="mini" viewBox="0 0 88 26" aria-hidden="true">
      {values.map((v, i) => (
        <rect
          key={i}
          x={i * 6.2}
          y={26 - (v / max) * 24}
          width={4.4}
          height={(v / max) * 24}
          rx={1}
          fill="var(--ac)"
          opacity={0.3 + (i / values.length) * 0.7}
        />
      ))}
    </svg>
  );
}

/** The last-24h area sparkline. Red only when the move itself is negative. */
export function AreaSpark({ values, negative }: { values: number[]; negative: boolean }) {
  const max = Math.max(...values);
  const min = Math.min(...values);
  const range = max - min || 1;
  const points = values
    .map((v, i) => `${(i / (values.length - 1)) * 100},${34 - ((v - min) / range) * 28 - 3}`)
    .join(' ');
  const stroke = negative ? 'var(--red)' : 'var(--ac)';

  return (
    <svg className="mini" viewBox="0 0 100 34" preserveAspectRatio="none" aria-hidden="true">
      <polyline points={points} fill="none" stroke={stroke} strokeWidth={1.4} />
      <polygon points={`0,34 ${points} 100,34`} fill={stroke} opacity={0.12} />
    </svg>
  );
}

/** The full-bleed area behind the featured card. */
export function AreaChart({ values, className }: { values: number[]; className?: string }) {
  const max = Math.max(...values);
  const min = Math.min(...values);
  const range = max - min || 1;
  const points = values
    .map((v, i) => `${(i / (values.length - 1)) * 300},${92 - ((v - min) / range) * 80}`)
    .join(' ');
  const gid = `spark-${className ?? 'a'}`;

  return (
    <svg className={className} viewBox="0 0 300 100" preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient id={gid} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="var(--ac)" stopOpacity=".28" />
          <stop offset="1" stopColor="var(--ac)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points={`0,100 ${points} 300,100`} fill={`url(#${gid})`} />
      <polyline points={points} fill="none" stroke="var(--ac)" strokeWidth={1.6} />
    </svg>
  );
}
