/** A 24h move. Green up, red down — the only two colours a number gets (§5). */
export function Change({ pct }: { pct: number }) {
  const up = pct >= 0;
  return (
    <span className={`chg ${up ? 'up' : 'down'}`}>
      {up ? '▲' : '▼'} {up ? '+' : '−'}
      {Math.abs(pct).toFixed(1)}%
    </span>
  );
}
