/**
 * Token logos, from an external token list.
 *
 * §4 draws the line precisely: "logos and token metadata may come from
 * external sources, numbers may not." So this file is allowed to fetch, and
 * it is the ONLY file in `server/` that talks to anything other than a node
 * or the database. Two rules keep it on the right side of that line:
 *
 *   It reads `logoURI` and nothing else. Not price, not supply, not decimals
 *   — decimals are an input to every price, so they stay an on-chain read
 *   even though a token list would happily supply them.
 *
 *   A failure is silent and total. No list, an unreachable host, malformed
 *   JSON: every token keeps the colour derived from its address, and not one
 *   number on the site changes. A logo is decoration; the site works without
 *   one and must never wait on one.
 *
 * The list is opt-in via TOKEN_LIST_URL, because there is no canonical list
 * for this chain yet and guessing at one would be worse than no logos.
 */

import { prisma } from '../db';

/** Uniswap's token-list schema, reduced to the one field we are allowed. */
interface TokenListEntry {
  chainId?: number;
  address?: string;
  logoURI?: string;
}

interface TokenList {
  tokens?: TokenListEntry[];
}

const FETCH_TIMEOUT_MS = 10_000;
/** Data URIs and oversized strings do not belong in a database column. */
const MAX_URL_LENGTH = 512;

/**
 * Only http(s). A token list is third-party data, so a `javascript:` or
 * `data:` URI reaching an `img src` in the browser is an injection vector,
 * not a logo.
 */
export function isSafeLogoUrl(url: unknown): url is string {
  if (typeof url !== 'string' || url.length === 0 || url.length > MAX_URL_LENGTH) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

/**
 * Pull the list and record a logo for each token we already know about.
 *
 * Tokens we do not know are ignored rather than inserted: a token row exists
 * because a pool referenced it, and a list should not be able to invent one.
 */
export async function refreshLogos(
  options: { url?: string | null; chainId: number; log?: (m: string) => void } = {
    chainId: 0,
  },
): Promise<number> {
  const url = options.url ?? process.env.TOKEN_LIST_URL ?? null;
  const log = options.log ?? (() => {});
  if (!url) return 0;
  if (!isSafeLogoUrl(url)) {
    log(`TOKEN_LIST_URL is not an http(s) URL, ignoring it: ${url}`);
    return 0;
  }

  let list: TokenList;
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { accept: 'application/json' },
    });
    if (!response.ok) {
      log(`token list responded ${response.status}; keeping derived colours`);
      return 0;
    }
    list = (await response.json()) as TokenList;
  } catch (error) {
    // Silent and total: a logo is decoration and the site works without it.
    log(`token list unreachable (${(error as Error).message}); keeping derived colours`);
    return 0;
  }

  const entries = Array.isArray(list.tokens) ? list.tokens : [];
  const wanted = new Map<string, string>();
  for (const entry of entries) {
    if (typeof entry?.address !== 'string') continue;
    // A list covering several chains must not colour this one's tokens with
    // another chain's logos.
    if (typeof entry.chainId === 'number' && entry.chainId !== options.chainId) continue;
    if (!isSafeLogoUrl(entry.logoURI)) continue;
    wanted.set(entry.address.toLowerCase(), entry.logoURI);
  }
  if (wanted.size === 0) return 0;

  const known = await prisma.token.findMany({
    where: { address: { in: [...wanted.keys()] }, logoUrl: null },
    select: { address: true },
  });

  let updated = 0;
  for (const token of known) {
    await prisma.token.update({
      where: { address: token.address },
      data: { logoUrl: wanted.get(token.address.toLowerCase()) },
    });
    updated++;
  }
  if (updated > 0) log(`  ${updated} token logo(s) from the token list`);
  return updated;
}
