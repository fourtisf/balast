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
 * Community links and the token's contract address.
 *
 * Set at build time from the environment (NEXT_PUBLIC_*), because they are
 * facts about the project rather than about the code: a handle changes
 * without a commit. On the box: `deploy/set-env.sh NEXT_PUBLIC_X_URL https://x.com/…`
 * then a deploy, since Next.js inlines these when it builds.
 *
 * An unset link renders as "soon" rather than as a dead link, and an unset
 * contract address renders as "CA · coming soon" — the words the owner asked
 * for, and true until there is one.
 */
export const SOCIAL = {
  x: process.env.NEXT_PUBLIC_X_URL ?? '',
  telegram: process.env.NEXT_PUBLIC_TELEGRAM_URL ?? '',
} as const;

/** The token's contract address, once it exists. Empty until then. */
export const TOKEN_CA = process.env.NEXT_PUBLIC_TOKEN_CA ?? '';
