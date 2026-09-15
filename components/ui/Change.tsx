/**
 * A 24h move. Green up, red down — the only two colours a number gets (§5).
 *
 * Unknown is neither. A pool with no price a day ago used to render as
 * "▲ +0.0%" in green, which is a claim — "unchanged" — about a figure that
 * does not exist. It is an em dash in the neutral colour, like every other
 * figure the site cannot honestly show (§7).
 */
export function Change({ pct }: { pct: number | null }) {
  if (pct === null || !Number.isFinite(pct)) {
    return <span className="chg none">—</span>;
  }
  const magnitude = Math.abs(pct).toFixed(1);
  if (magnitude === '0.0') {
    // A move that rounds to nothing is not a move: no arrow and no colour.
    // "▼ −0.0%" in red put a negative sign on a number that is not negative,
    // and red means exactly one thing here (§5).
    return <span className="chg none">0.0%</span>;
  }
  const up = pct > 0;
  return (
    <span className={`chg ${up ? 'up' : 'down'}`}>
      {up ? '▲' : '▼'} {up ? '+' : '−'}
      {magnitude}%
    </span>
  );
}
