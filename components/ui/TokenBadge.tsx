import type { TokenMeta } from '@/lib/data/types';

/**
 * The circular ticker badge.
 *
 * A logo image when a token list gave us one, and the derived colour with the
 * first two letters of the ticker otherwise. §4 allows logos and metadata from
 * external sources (never numbers), so the image is the one thing on this
 * component that did not come off the chain.
 *
 * The colour is always painted underneath, so a logo that fails to load
 * leaves the badge looking deliberate rather than blank — and because the
 * image is the only third-party asset the page requests, it is loaded lazily
 * and told not to send a referrer.
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
      {token.logoUrl ? (
        /* next/image would proxy these through our own server and needs every
           remote host whitelisted in `images.remotePatterns` up front. The
           host comes from a third-party token list, so it is not knowable in
           advance — and there is nothing to optimise about a 22px badge. */
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={token.logoUrl}
          alt=""
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
        />
      ) : (
        token.symbol.slice(0, 2)
      )}
    </span>
  );
}
