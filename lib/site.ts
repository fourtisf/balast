/**
 * Where this front-end lives. One place, because the canonical URL shows up in
 * metadata, Open Graph cards, the nginx config and every link we ever print.
 */

/** The apex domain. No protocol, no trailing slash. */
export const DOMAIN = 'balast.xyz';

export const SITE_URL = `https://${DOMAIN}`;

/**
 * Spellings a user might type instead. Each one should be registered and
 * 301'd to DOMAIN — an unowned confusable is a phishing domain someone else
 * gets to point at a wallet drainer.
 *
 * `ballast.xyz`, the English spelling on this same TLD, is NOT ours: it is
 * registered and parked for sale by a third party. Until that is acquired,
 * this is the one real gap in the setup. See deploy/nginx.conf.
 */
export const DEFENSIVE_DOMAINS = ['www.balast.xyz'] as const;

/**
 * Where the project talks, and the token's contract address.
 *
 * X is the one channel: @Balastdotfi, the account the owner named. Telegram
 * was offered as a second icon and removed at the owner's request. The URL
 * can still be overridden at build time (`NEXT_PUBLIC_X_URL`, via
 * `deploy/set-env.sh` then a deploy) so a move costs no commit.
 *
 * An unset contract address renders as "CA · coming soon" — the words the
 * owner asked for, and true until there is one.
 */
export const SOCIAL = {
  x: process.env.NEXT_PUBLIC_X_URL || 'https://x.com/Balastdotfi',
} as const;

/** The X handle, for the site's own metadata; derived so it cannot disagree with the link. */
export const X_HANDLE = `@${SOCIAL.x.replace(/\/+$/, '').split('/').pop()}`;

/** The token's contract address, once it exists. Empty until then. */
export const TOKEN_CA = process.env.NEXT_PUBLIC_TOKEN_CA ?? '';

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
