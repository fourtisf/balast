import type { TokenMeta } from '@/lib/data/types';

/**
 * The circular ticker badge. The fill is token metadata (§4 allows logos and
 * metadata from external sources) — it is data, not a palette decision.
 */
export function TokenBadge({
  token,
  className = 'logo',
}: {
  token: TokenMeta;
  className?: string;
}) {
  return (
    <span className={className} style={{ background: token.logoColor }} aria-hidden="true">
      {token.symbol.slice(0, 2)}
    </span>
  );
}
