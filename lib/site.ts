/**
 * Where this front-end lives. One place, because the canonical URL shows up in
 * metadata, Open Graph cards, the nginx config and every link we ever print.
 */

/**
 * The product's name, in one place: the navigation, the footer, page titles
 * and link previews read it from here (§39).
 */
export const BRAND = 'LockFi';

/** The apex domain. No protocol, no trailing slash. */
export const DOMAIN = 'lockfi.org';

export const SITE_URL = `https://${DOMAIN}`;

/**
 * Where the site used to live. balast.xyz 301s to DOMAIN (deploy/nginx.conf),
 * and the database still holds logo URLs recorded under it, so a URL on one
 * of these is still one of our own files (§39).
 */
export const LEGACY_SITE_URLS = ['https://balast.xyz'] as const;

/**
 * The same-origin path of a URL on this site, the current domain or a former
 * one; null for anybody else's URL. A relative path is already one.
 */
export function ownSitePath(url: string | null | undefined): string | null {
  if (!url) return null;
  if (url.startsWith('/')) return url;
  for (const origin of [SITE_URL, ...LEGACY_SITE_URLS]) {
    if (url.startsWith(`${origin}/`)) return url.slice(origin.length);
  }
  return null;
}

/**
 * Hosts that 301 to DOMAIN. An unowned confusable is a phishing domain
 * someone else gets to point at a wallet drainer.
 *
 * `lockfi.com` is NOT ours: it is parked for sale by a third party, and it is
 * what a person typing the name reaches by default. Acquiring it is the one
 * real gap in the setup. See deploy/nginx.conf.
 */
export const DEFENSIVE_DOMAINS = ['www.lockfi.org', 'balast.xyz', 'www.balast.xyz'] as const;

/**
 * Where the project talks, and the token's contract address.
 *
 * X is the one channel: @Balastdotfi, the account the owner named. Telegram
 * was offered as a second icon and removed at the owner's request.
 *
 * The link is a constant, deliberately not an environment variable. It was
 * one, and the live site went out pointing at `x.com/HANDLE_ANDA` — a
 * placeholder typed into the box's .env by hand — while the code carried
 * the real account as a default the placeholder overrode. A fact this
 * public belongs in the repository, where a change is a reviewed commit.
 *
 * The contract address is a constant for the same reason. It was an
 * environment variable read at build time, and a blank or stale value in
 * the box's .env would have shown "coming soon", or the wrong address, on
 * a site that tells people any other address is not ours.
 */
export const SOCIAL = {
  x: 'https://x.com/Balastdotfi',
} as const;

/** The X handle, for the site's own metadata; derived so it cannot disagree with the link. */
export const X_HANDLE = `@${SOCIAL.x.replace(/\/+$/, '').split('/').pop()}`;

/**
 * $BLST, launched on Pons (ponsfamily.com), 23 September 2026. The address
 * the owner gave, checksummed; a test asserts it stays valid. Empty would
 * render "CA · coming soon".
 */
export const TOKEN_CA: string = '0xe8f7E3d2D4B9733E13aBb173F4c1BDDBEAFbEE83';
export const TOKEN_TICKER = 'BLST';

/**
 * Where the API lives, from the browser's point of view. Empty means the
 * same origin, which is the deployed shape: nginx proxies `/api/` to the
 * Fastify process. Set only for local development against `next dev`.
 */
export const API_BASE =
  (typeof process !== 'undefined' ? process.env.NEXT_PUBLIC_API_BASE : undefined) ?? '';

/**
 * A token's logo, served by our own API rather than fetched by the browser
 * from wherever the source found it.
 *
 * The board once showed four empty discs: URLs that loaded from the box and
 * not from a browser — a host that answers a server and refuses a page, or
 * the other way round. Routing every logo through `/api/logo/{address}`
 * makes "the box can load it" and "the page shows it" the same test, and
 * lets the API cache the bytes so a hundred badges cost the source nothing.
 */
export function logoProxy(address: string): string {
  return `${API_BASE}/api/logo/${address.toLowerCase()}`;
}
