import { isEther } from '@/lib/chain';
import { monogram, tokenMark } from '@/lib/token-mark';
import type { TokenMeta } from '@/lib/data/types';

/**
 * Logos drawn for a dark theme — the ticker icons Robinhood's stock tokens
 * get (server/indexer/logo-sources.ts, `tickers`) are white where a brand
 * is black — are painted on ink, inset, so they read as a coin rather than
 * vanish into the paper.
 */
const DARK_THEME_ICON_HOST = /raw\.githubusercontent\.com\/nvstly\/icons\//;

/**
 * Ether's own logo, served by this site. Ether has no contract for any
 * source to look up, so it is the one token whose logo the front end knows
 * without asking the indexer — and the ether market is on every board.
 */
const ETHER_LOGO = '/tokens/eth.svg';

/**
 * The circular token badge.
 *
 * A real logo when a token list or a logo source gave us one — §4 allows
 * logos and token metadata from external sources, and numbers from none —
 * and otherwise a mark derived from the token's own address: a pastel disc
 * whose hue is unique to that address, with the ticker's first two
 * characters on it in the same hue, dark.
 *
 * The derived mark is not a fallback in the apologetic sense. Most tokens on
 * a new chain are in no list and may never be, so this is what the badge will
 * usually be, and it is built to look deliberate: the hue comes from the
 * address so it never changes, and disc and ink are tuned as a pair so the
 * monogram is legible on every hue.
 *
 * That pairing is why the monogram never takes `logoColor`. The provider's
 * colour was itself derived by an earlier palette and is stored, so a live
 * row can carry a disc that the current ink was not measured against. It
 * stays painted underneath a real logo — so an image that fails to load
 * leaves something considered rather than a blank hole — and nowhere else.
 */
export function TokenBadge({
  token,
  className = 'logo',
}: {
  token: TokenMeta;
  className?: string;
}) {
  const mark = tokenMark(token.address);
  const logoUrl = token.logoUrl ?? (isEther(token.address) ? ETHER_LOGO : undefined);
  const onInk = logoUrl !== undefined && DARK_THEME_ICON_HOST.test(logoUrl);
  const background = onInk ? 'var(--fg)' : logoUrl ? token.logoColor || mark.bg : mark.bg;

  return (
    <span
      className={onInk ? `${className} inset` : className}
      // backgroundColor, not the shorthand: the stylesheet layers a sheen
      // (background-image) over the colour so the disc reads as a coin, and
      // the shorthand would wipe it.
      style={{ backgroundColor: background, color: mark.ink }}
      aria-hidden="true"
    >
      {logoUrl ? (
        /* next/image would proxy these through our own server and needs every
           remote host whitelisted in `images.remotePatterns` up front. The
           host comes from a third-party source, so it is not knowable in
           advance — and there is nothing to optimise about a 40px badge. */
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={logoUrl}
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
