/**
 * What DexScreener actually answers for a token (api/market.ts).
 *
 *   npm run market:probe -- 0xTOKEN [0xTOKEN ...]
 *
 * Prints every pair in the raw answer — chain id, dex, pair address, the
 * day's volume, buys and sells, liquidity — and which pair the feed would
 * choose. The session that wrote the feed could not reach DexScreener, so
 * this is how the box says whether the chain is known to it and under what
 * id, which is what DEXSCREENER_CHAIN wants.
 */

import '../load-env';

import { USER_AGENT } from '../indexer/logo-sources';
import { choosePair, parsePairs } from '../api/market';

async function main(): Promise<void> {
  const addresses = process.argv.slice(2).map((a) => a.trim().toLowerCase()).filter(Boolean);
  if (addresses.length === 0) {
    process.stderr.write('usage: npm run market:probe -- 0xTOKEN [0xTOKEN ...]\n');
    process.exit(2);
  }
  const base = (process.env.DEXSCREENER_URL?.trim() || 'https://api.dexscreener.com').replace(/\/+$/, '');
  const chain = process.env.DEXSCREENER_CHAIN?.trim().toLowerCase() || null;
  const url = `${base}/latest/dex/tokens/${addresses.join(',')}`;
  process.stdout.write(`GET ${url}\n`);
  const response = await fetch(url, { headers: { accept: 'application/json', 'user-agent': USER_AGENT } });
  process.stdout.write(`  ${response.status} ${response.headers.get('content-type') ?? ''}\n`);
  const text = await response.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    process.stdout.write(`  not JSON: ${text.slice(0, 200)}\n`);
    return;
  }
  const pairs = parsePairs(body);
  process.stdout.write(`  ${pairs.length} pair(s) in the answer\n`);
  for (const p of pairs) {
    process.stdout.write(
      `  ${p.chainId.padEnd(16)} ${p.dexId.padEnd(12)} ${p.pairAddress}  base ${p.baseToken.slice(0, 10)}…  ` +
        `vol24h $${p.volume24hUsd.toLocaleString()}  buys ${p.buys24h}  sells ${p.sells24h}  ` +
        `liq ${p.liquidityUsd === null ? '—' : `$${p.liquidityUsd.toLocaleString()}`}  chg24h ${p.priceChange24hPct ?? '—'}%\n`,
    );
  }
  for (const address of addresses) {
    const chosen = choosePair(pairs, address, '', chain);
    process.stdout.write(
      `  ${address}: ${chosen ? `would quote ${chosen.pairAddress} on ${chosen.chainId}` : 'no pair — the row keeps the chain figure'}` +
        (chain ? ` (DEXSCREENER_CHAIN=${chain})` : '') +
        '\n',
    );
  }
  const chains = [...new Set(pairs.map((p) => p.chainId))];
  if (chains.length > 1 && !chain) {
    process.stdout.write(`  pairs on ${chains.join(', ')} — set DEXSCREENER_CHAIN to the one that is Robinhood Chain\n`);
  }
}

main().catch((error) => {
  process.stderr.write(`${(error as Error).stack ?? error}\n`);
  process.exit(1);
});
