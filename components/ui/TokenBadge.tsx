'use client';

import { useEffect, useRef, useState } from 'react';
import { isEther } from '@/lib/chain';
import { SITE_URL, logoProxy } from '@/lib/site';
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
 * A real logo when a source gave us one — §4 allows logos and token
 * metadata from external sources, and numbers from none — and otherwise a
 * mark derived from the token's own address: a pastel disc whose hue is
 * unique to that address, with the ticker's first two characters on it in
 * the same hue, dark. Disc and ink are tuned as a pair, so the monogram is
 * legible on every hue, and the pastel disc is also what sits under a logo
 * with a transparent background.
 *
 * A logo that does not load falls back to the monogram. The first real
 * board showed four saturated discs with nothing in them: a URL had been
 * recorded that the browser could not fetch, and an empty coloured circle
 * is the one thing this badge must never be. The image is checked after
 * mount as well as on its error event, because an image that failed before
 * React attached never fires the event.
 */
/**
 * The same-origin path for a logo this site serves, or null for anything
 * else. A stored absolute URL on our own domain becomes a path so the browser
 * never leaves the origin it is already on.
 */
function ownMarkPath(url: string | null | undefined): string | null {
  if (!url) return null;
  if (url.startsWith('/')) return url;
  const site = SITE_URL.replace(/\/+$/, '');
  return url.startsWith(`${site}/`) ? url.slice(site.length) : null;
}

export function TokenBadge({
  token,
  className = 'logo',
}: {
  token: TokenMeta;
  className?: string;
}) {
  const mark = tokenMark(token.address);
  // A recorded logo is loaded through our own API (lib/site.ts, logoProxy),
  // so what the page shows is exactly what the box could fetch.
  //
  // A mark this site serves itself is the exception, and not a cosmetic one:
  // proxying it makes the API fetch our own public hostname from inside the
  // box and hand the bytes back, so a box that cannot reach itself shows a
  // monogram for a file sitting on its own disk. Same origin, served directly.
  const own = ownMarkPath(token.logoUrl);
  const candidate = own
    ? own
    : token.logoUrl
      ? logoProxy(token.address)
      : isEther(token.address)
        ? ETHER_LOGO
        : undefined;
  const [failed, setFailed] = useState<string | null>(null);
  const image = useRef<HTMLImageElement | null>(null);

  useEffect(() => {
    const el = image.current;
    if (el && candidate && el.complete && el.naturalWidth === 0) setFailed(candidate);
  }, [candidate]);

  const logoUrl = candidate !== undefined && failed !== candidate ? candidate : undefined;
  // The ink decision is about where the image came from, not how it is served.
  const onInk = logoUrl !== undefined && DARK_THEME_ICON_HOST.test(token.logoUrl ?? '');

  return (
    <span
      className={onInk ? `${className} inset` : className}
      // backgroundColor, not the shorthand: the stylesheet layers a sheen
      // (background-image) over the colour so the disc reads as a coin, and
      // the shorthand would wipe it.
      style={{ backgroundColor: onInk ? 'var(--fg)' : mark.bg, color: mark.ink }}
      aria-hidden="true"
    >
      {logoUrl ? (
        /* next/image would proxy these through our own server and needs every
           remote host whitelisted in `images.remotePatterns` up front. The
           host comes from a third-party source, so it is not knowable in
           advance — and there is nothing to optimise about a 40px badge. */
        // eslint-disable-next-line @next/next/no-img-element
        <img
          ref={image}
          src={logoUrl}
          alt=""
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setFailed(logoUrl)}
        />
      ) : (
        monogram(token.symbol)
      )}
    </span>
  );
}
