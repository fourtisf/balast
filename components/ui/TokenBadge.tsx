import { monogram, tokenMark } from '@/lib/token-mark';
import type { TokenMeta } from '@/lib/data/types';

/**
 * The circular token badge.
 *
 * A real logo when a token list gave us one — §4 allows logos and token
 * metadata from external sources, and numbers from none — and otherwise a
 * mark derived from the token's own address: a fixed-weight disc whose hue is
 * unique to that address, with the ticker's first two characters on it.
 *
 * The derived mark is not a fallback in the apologetic sense. Most tokens on
 * a new chain are in no list and may never be, so this is what the badge will
 * usually be, and it is built to look deliberate: the hue comes from the
 * address so it never changes, and the ink is chosen per hue because yellow
 * at this lightness is far brighter than blue at the same lightness and no
 * single ink stays legible across the wheel.
 *
 * The colour is always painted underneath the image too, so a logo that fails
 * to load leaves something considered rather than a blank hole.
 */
export function TokenBadge({
  token,
  className = 'logo',
}: {
  token: TokenMeta;
  className?: string;
}) {
  // `logoColor` is what the provider supplies — the simulator's seed palette,
  // or a colour the indexer derived. The address-derived mark is the default
  // when there is none, so a badge is never unstyled.
  const mark = tokenMark(token.address);
  const background = token.logoColor || mark.bg;

  return (
    <span
      className={className}
      // backgroundColor, not the shorthand: the stylesheet layers a sheen
      // (background-image) over the colour so the disc reads as a coin, and
      // the shorthand would wipe it.
      style={{ backgroundColor: background, color: mark.ink }}
      aria-hidden="true"
    >
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
        monogram(token.symbol)
      )}
    </span>
  );
}
