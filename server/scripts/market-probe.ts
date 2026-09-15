/**
 * What the market sources actually answer for a token (api/market-sources.ts).
 *
 *   npm run market:probe -- 0xTOKEN [0xTOKEN ...]
 *
 * Asks every configured source in turn and prints, per source: the request,
 * the status, every pair in the raw answer, and the quote the feed would
 * build from it — the token's summed volume and trades, its liquidity, its
 * market cap. The session that wrote the feed could not reach either host,
 * so this is how the box says whether this chain is known to them and under
 * what id, which is what DEXSCREENER_CHAIN and GECKOTERMINAL_NETWORK want.
 *
 * It writes nothing and touches no database.
 */

import '../load-env';

import { USER_AGENT, type Fetch } from '../indexer/logo-sources';
import { aggregate, dexscreener, geckoterminal, parsePairs } from '../api/market-sources';

const money = (n: number | null): string => (n === null ? '—' : `$${Math.round(n).toLocaleString()}`);

/** The same fetch the feed uses, with every request and answer printed. */
function loudFetch(): Fetch {
  return (async (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => {
    process.stdout.write(`  GET ${url}\n`);
    const response = await fetch(url, init as RequestInit);
    process.stdout.write(`    ${response.status} ${response.headers.get('content-type') ?? ''}\n`);
    return response;
  }) as unknown as Fetch;
}

async function main(): Promise<void> {
  const addresses = process.argv.slice(2).map((a) => a.trim().toLowerCase()).filter(Boolean);
  if (addresses.length === 0) {
    process.stderr.write('usage: npm run market:probe -- 0xTOKEN [0xTOKEN ...]\n');
    process.exit(2);
  }

  const chain = process.env.DEXSCREENER_CHAIN?.trim().toLowerCase() || null;
  const network = process.env.GECKOTERMINAL_NETWORK?.trim() || null;
  const asks = addresses.map((address) => ({ address, pool: '' }));
  const ctx = { fetch: loudFetch(), log: (line: string) => process.stdout.write(`${line}\n`), now: Date.now };

  // --- DexScreener, raw, so the pairs behind the sum are visible -----------
  process.stdout.write('\nDexScreener\n');
  const base = (process.env.DEXSCREENER_URL?.trim() || 'https://api.dexscreener.com').replace(/\/+$/, '');
  const url = `${base}/latest/dex/tokens/${addresses.join(',')}`;
  process.stdout.write(`  GET ${url}\n`);
  try {
    const response = await fetch(url, { headers: { accept: 'application/json', 'user-agent': USER_AGENT } });
    const text = await response.text();
    process.stdout.write(`    ${response.status} ${response.headers.get('content-type') ?? ''}\n`);
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {
      process.stdout.write(`    not JSON: ${text.slice(0, 200)}\n`);
    }
    const pairs = parsePairs(body);
    process.stdout.write(`    ${pairs.length} pair(s) in the answer\n`);
    for (const p of pairs) {
      process.stdout.write(
        `    ${p.chainId.padEnd(14)} ${p.dexId.padEnd(10)} ${p.pairAddress}  base ${p.baseToken.slice(0, 10)}…  ` +
          `vol24h ${money(p.volume24hUsd)}  buys ${p.buys24h ?? '—'}  sells ${p.sells24h ?? '—'}  ` +
          `liq ${money(p.liquidityUsd)}  mc ${money(p.marketCapUsd)}  chg ${p.priceChange24hPct ?? '—'}%\n`,
      );
    }
    const at = new Date().toISOString();
    for (const address of addresses) {
      const q = aggregate(pairs, address, '', chain, 'dexscreener', at);
      process.stdout.write(
        `    ${address}: ` +
          (q
            ? `${q.pairs} pair(s) → vol ${money(q.volume24hUsd)}, ${q.buys24h ?? '—'} buys / ${q.sells24h ?? '—'} sells, ` +
              `liq ${money(q.liquidityUsd)}, mc ${money(q.marketCapUsd)}, fdv ${money(q.fdvUsd)}`
            : 'no pair') +
          (chain ? `  (DEXSCREENER_CHAIN=${chain})` : '') +
          '\n',
      );
    }
    const chains = [...new Set(pairs.map((p) => p.chainId))];
    if (chains.length > 1 && !chain) {
      process.stdout.write(`    pairs on ${chains.join(', ')} — set DEXSCREENER_CHAIN to Robinhood Chain's id\n`);
    }
  } catch (error) {
    process.stdout.write(`    failed: ${(error as Error).message}\n`);
  }

  // --- GeckoTerminal, through the source, which discovers the network id ---
  process.stdout.write('\nGeckoTerminal\n');
  try {
    const source = geckoterminal({ network });
    const answer = await source.quotes(asks, ctx);
    process.stdout.write(
      `    network ${source.network() ?? 'not found — source disabled'}` +
        (answer.refusal ? `, ${answer.refusal}` : '') +
        '\n',
    );
    for (const address of addresses) {
      const q = answer.quotes.get(address);
      process.stdout.write(
        `    ${address}: ` +
          (q
            ? `vol ${money(q.volume24hUsd)}, liq ${money(q.liquidityUsd)}, mc ${money(q.marketCapUsd)}, ` +
              `fdv ${money(q.fdvUsd)}, chg ${q.priceChange24hPct ?? '—'}%`
            : 'no answer') +
          '\n',
      );
    }
  } catch (error) {
    process.stdout.write(`    failed: ${(error as Error).message}\n`);
  }

  // What the feed would end up showing, source by source, in its own order.
  process.stdout.write('\nThe board would show\n');
  const sources = [dexscreener({ chain }), geckoterminal({ network })];
  const left = new Map(asks.map((a) => [a.address, a]));
  for (const source of sources) {
    if (left.size === 0) break;
    const answer = await source.quotes([...left.values()], ctx);
    for (const [address, q] of answer.quotes) {
      left.delete(address);
      process.stdout.write(
        `    ${address}: vol ${money(q.volume24hUsd)} · mc ${money(q.marketCapUsd ?? q.fdvUsd)} · ` +
          `liq ${money(q.liquidityUsd)} · via ${q.source}\n`,
      );
    }
    if (answer.refusal) process.stdout.write(`    ${source.name}: ${answer.refusal}\n`);
  }
  for (const address of left.keys()) {
    process.stdout.write(`    ${address}: no source — the row keeps the chain's figures\n`);
  }
}

main().catch((error) => {
  process.stderr.write(`${(error as Error).stack ?? error}\n`);
  process.exit(1);
});
