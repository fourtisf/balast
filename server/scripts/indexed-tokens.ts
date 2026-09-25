/**
 * What this chain trades, from the indexer's own tables.
 *
 *   npm run tokens:indexed
 *
 * `find:tokens` scans the chain from head and can only see pools CREATED in
 * the window it scans — and the anchor pool was created once, long ago. The
 * indexer, meanwhile, has read every pool's tokens off their own contracts
 * as it went. Its tables are the authoritative answer to "is there a USDG
 * here, and does it trade against ether", and reading them touches no
 * endpoint, so this works when every public RPC is refusing.
 *
 * Ranked the way the anchor search ranks (indexer/anchor.ts): by pools that
 * pair the token with ether — wrapped or native — and then by swaps.
 */

import '../load-env';

import { CHAIN, STABLECOIN_SYMBOL, etherCurrencies, isEther } from '../../lib/chain';
import { prisma } from '../db';
import { resolveUsdg } from '../indexer/anchor';

interface Row {
  address: string;
  symbol: string;
  decimals: number;
  pools: number;
  ether_pools: number;
  swaps: number;
}

async function main(): Promise<void> {
  const cursor = await prisma.indexerCursor.findFirst();
  if (!cursor) {
    process.stdout.write('The indexer has never written a block, so there is nothing to list yet.\n');
    process.exitCode = 1;
    return;
  }
  const behind = cursor.headBlock === null ? null : cursor.headBlock - cursor.lastIndexedBlock;
  process.stdout.write(
    `\n${CHAIN.name}: indexed to block ${cursor.lastIndexedBlock}` +
      (behind === null ? '' : ` (${behind.toLocaleString()} behind head)`) +
      `, chain time ${cursor.lastIndexedAt.toISOString()}\n\n`,
  );

  const eth = [...etherCurrencies()];
  const rows = await prisma.$queryRaw<Row[]>`
    SELECT
      t.address,
      t.symbol,
      t.decimals,
      COUNT(DISTINCT p.id)::int AS pools,
      COUNT(DISTINCT p.id) FILTER (
        WHERE lower(p.token0) = ANY(${eth}) OR lower(p.token1) = ANY(${eth})
      )::int AS ether_pools,
      COALESCE(SUM(s.swaps), 0)::int AS swaps
    FROM tokens t
    JOIN pools p ON lower(p.token0) = lower(t.address) OR lower(p.token1) = lower(t.address)
    LEFT JOIN (SELECT pool_id, COUNT(*)::int AS swaps FROM swap_events GROUP BY pool_id) s
      ON s.pool_id = p.id
    GROUP BY t.address, t.symbol, t.decimals
    ORDER BY ether_pools DESC, swaps DESC, pools DESC, t.address ASC
  `;

  process.stdout.write('pools  w/ether  swaps    symbol      dec  address\n');
  process.stdout.write('-----  -------  -------  ----------  ---  ------------------------------------------\n');
  for (const row of rows.slice(0, 50)) {
    const tag = isEther(row.address) ? ' <- ether' : '';
    process.stdout.write(
      `${String(row.pools).padStart(5)}  ${String(row.ether_pools).padStart(7)}  ` +
        `${String(row.swaps).padStart(7)}  ${row.symbol.padEnd(10)}  ${String(row.decimals).padStart(3)}  ` +
        `${row.address}${tag}\n`,
    );
  }
  if (rows.length > 50) process.stdout.write(`… and ${rows.length - 50} more\n`);

  // The same resolution the indexer and the API use, so this prints exactly
  // what they would decide, not a second opinion.
  const anchor = await resolveUsdg(process.env.USDG_ADDRESS || null);
  process.stdout.write(`\nanchor: ${anchor.note}\n`);

  if (!anchor.address) {
    const stableish = rows.filter(
      (r) => /^(USD|DAI|GUSD|EUR)/i.test(r.symbol) && r.symbol.toUpperCase() !== STABLECOIN_SYMBOL,
    );
    if (stableish.length > 0) {
      process.stdout.write('\nStablecoin-looking tokens that are NOT called USDG — for you to confirm, never guessed at:\n');
      for (const r of stableish.slice(0, 8)) {
        process.stdout.write(
          `  ${r.address}  ${r.symbol}  ${r.pools} pool(s), ${r.ether_pools} with ether, ${r.decimals} decimals\n`,
        );
      }
      process.stdout.write('\nTo pin one:  ./deploy/set-env.sh USDG_ADDRESS 0x…  then  pm2 restart lockfi-indexer lockfi-api\n');
    }
    if (behind !== null && behind > 50_000n) {
      process.stdout.write(
        `\nThe first sync is still ${behind.toLocaleString()} blocks behind head. ` +
          'The anchor may simply not have been reached yet.\n',
      );
    }
  }
  process.stdout.write('\n');
  await prisma.$disconnect();
}

main().catch((error) => {
  process.stderr.write(`${(error as Error).stack ?? error}\n`);
  process.exit(1);
});
