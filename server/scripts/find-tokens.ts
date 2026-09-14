/**
 * Find the tokens this chain actually trades, from its own logs.
 *
 *   npm run find:tokens
 *
 * The indexer needs `USDG_ADDRESS` and does not start without it, because the
 * WETH/USDG pool is the only path to a USD figure (§4.3). The handoff names
 * USDG but not its address, and the obvious answer — "look it up on the
 * explorer" — is a manual step that can be got wrong silently: paste the
 * wrong address and every dollar figure on the site is quietly zero.
 *
 * So this reads it off the chain. It scans the PoolManager's `Initialize`
 * events backwards from head, collects every token that appears in a pool,
 * reads each one's symbol and decimals from its own contract, and ranks them
 * by how many pools reference them.
 *
 * It prints a ready-to-paste line for `.env`, and the earliest block it saw,
 * which is a lower bound for `START_BLOCK`.
 *
 * Needs no database — same reason as verify-chain.ts.
 */

import '../load-env';

import { decodeEventLog, getAddress } from 'viem';
import { CHAIN, CONTRACTS, NATIVE_ETH } from '../../lib/chain';
import { ERC20_ABI, POOL_MANAGER_ABI } from '../chain/abi';
import { rpc } from '../chain/client';
import { scanLogsBackwards } from '../chain/logs';
import { RPC_URLS } from '../chain/endpoints';

/**
 * First width asked for. Public endpoints cap `eth_getLogs` well below this
 * and none say where; the walk halves on each refusal until one answers.
 */
const WINDOW = 5_000n;
/** How many windows to walk back before giving up. */
const MAX_WINDOWS = Number(process.env.FIND_WINDOWS ?? 60);

interface TokenSeen {
  address: string;
  pools: number;
  firstBlock: bigint;
  symbol?: string;
  name?: string;
  decimals?: number;
}

async function main(): Promise<void> {
  process.stdout.write(`\nScanning ${CHAIN.name} for tokens (chainId ${CHAIN.id})\n`);
  process.stdout.write(`PoolManager ${CONTRACTS.poolManager}\n`);
  process.stdout.write(`Endpoints: ${RPC_URLS.length}\n\n`);

  const head = await rpc((c) => c.getBlockNumber(), 'getBlockNumber');
  const seen = new Map<string, TokenSeen>();
  let earliestInitialize: bigint | null = null;
  let scanned = 0n;
  let pools = 0;

  const walk = await scanLogsBackwards({
    address: CONTRACTS.poolManager,
    head,
    maxWindows: MAX_WINDOWS,
    startWindow: WINDOW,
    onRefusal: (width, message) =>
      process.stdout.write(`  endpoints refused ${width} blocks (${message}) — narrowing\n`),
    onWindow: (logs, from, to) => {
      for (const log of logs) {
        let decoded;
        try {
          decoded = decodeEventLog({
            abi: POOL_MANAGER_ABI,
            data: log.data,
            topics: log.topics as never,
          });
        } catch {
          continue;
        }
        if (decoded.eventName !== 'Initialize') continue;
        pools++;
        if (earliestInitialize === null || log.blockNumber < earliestInitialize) {
          earliestInitialize = log.blockNumber;
        }
        const args = decoded.args as Record<string, unknown>;
        for (const key of ['currency0', 'currency1'] as const) {
          const address = (args[key] as string).toLowerCase();
          const entry = seen.get(address);
          if (entry) {
            entry.pools++;
            if (log.blockNumber < entry.firstBlock) entry.firstBlock = log.blockNumber;
          } else {
            seen.set(address, { address, pools: 1, firstBlock: log.blockNumber });
          }
        }
      }
      scanned = head - from + 1n;
      process.stdout.write(
        `\r  scanned ${scanned} blocks (${from}-${to}), ${pools} pool(s), ${seen.size} token(s)   `,
      );
    },
  });
  process.stdout.write('\n\n');

  if (walk.gaveUp) {
    // Nothing was served at any width: a fact about the endpoints, and it
    // must not be reported as a fact about the chain.
    process.stdout.write(
      `Could not read logs from any endpoint even at the narrowest window: ${walk.gaveUp}\n` +
        'Set RPC_URLS to an endpoint that serves eth_getLogs and run this again.\n\n',
    );
    process.exitCode = 1;
    return;
  }
  if (seen.size === 0) {
    process.stdout.write(
      `No Initialize events in the last ${scanned} blocks.\n\n` +
        'Either the PoolManager address is wrong — run `npm run verify:chain` —\n' +
        'or no pool was CREATED in that window. This scan only sees pool creation;\n' +
        'once the indexer has run, `npm run tokens:indexed` lists every token it has\n' +
        'seen, from its own tables, without touching an endpoint.\n\n',
    );
    process.exitCode = 1;
    return;
  }

  // Read metadata for each token. Sequential in small groups: a public
  // endpoint that rate-limits will refuse a burst.
  const tokens = [...seen.values()].sort((a, b) => b.pools - a.pools);
  const GROUP = 8;
  for (let i = 0; i < tokens.length; i += GROUP) {
    await Promise.all(
      tokens.slice(i, i + GROUP).map(async (token) => {
        // Native ether is a currency here, not a contract: every read below
        // would fail and it would print as an unknown address, in the one
        // listing an operator uses to identify this chain's tokens.
        if (token.address === NATIVE_ETH) {
          token.symbol = CHAIN.nativeCurrency.symbol;
          token.name = CHAIN.nativeCurrency.name;
          token.decimals = CHAIN.nativeCurrency.decimals;
          return;
        }
        const read = async (fn: 'symbol' | 'name' | 'decimals') => {
          try {
            return await rpc((c) =>
              c.readContract({
                address: getAddress(token.address),
                abi: ERC20_ABI,
                functionName: fn,
              }),
            );
          } catch {
            return undefined;
          }
        };
        const [symbol, name, decimals] = await Promise.all([
          read('symbol'),
          read('name'),
          read('decimals'),
        ]);
        token.symbol = symbol as string | undefined;
        token.name = name as string | undefined;
        token.decimals = decimals === undefined ? undefined : Number(decimals);
      }),
    );
  }

  process.stdout.write('pools  symbol      decimals  address\n');
  process.stdout.write('-----  ----------  --------  ------------------------------------------\n');
  for (const token of tokens.slice(0, 40)) {
    process.stdout.write(
      `${String(token.pools).padStart(5)}  ${(token.symbol ?? '?').padEnd(10)}  ` +
        `${String(token.decimals ?? '?').padStart(8)}  ${token.address}\n`,
    );
  }

  const weth = CONTRACTS.weth.toLowerCase();
  const foundWeth = tokens.find((t) => t.address === weth);
  process.stdout.write('\n');
  if (foundWeth) {
    process.stdout.write(
      `WETH confirmed: ${foundWeth.symbol ?? '?'} in ${foundWeth.pools} pool(s)\n`,
    );
  } else {
    process.stdout.write(
      `WETH (${CONTRACTS.weth}) appears in NO pool in this window.\n` +
        '  Either the address in lib/chain.ts is wrong, or the window is too small.\n',
    );
  }

  // USDG by symbol, then by the stablecoin shape as a fallback.
  const byUsdg = tokens.filter((t) => (t.symbol ?? '').toUpperCase() === 'USDG');
  const stableish = tokens.filter(
    (t) => /^(USD|DAI|GUSD)/i.test(t.symbol ?? '') && !byUsdg.includes(t),
  );

  if (byUsdg.length === 1) {
    const usdg = byUsdg[0];
    process.stdout.write(
      `\nUSDG found: ${usdg.address} (${usdg.decimals} decimals, ${usdg.pools} pool(s))\n\n` +
        'Set it without opening an editor:\n\n' +
        `  cd /var/www/balast && ./deploy/set-env.sh USDG_ADDRESS ${usdg.address}\n`,
    );
  } else if (byUsdg.length > 1) {
    // Never pick for them: the wrong anchor makes every USD figure wrong in a
    // way nothing downstream can detect.
    process.stdout.write(
      `\n${byUsdg.length} tokens call themselves USDG. Pick the one with real depth:\n`,
    );
    for (const t of byUsdg) {
      process.stdout.write(`  ${t.address}  ${t.pools} pool(s), ${t.decimals} decimals\n`);
    }
  } else {
    process.stdout.write('\nNo token with symbol USDG in this window.\n');
    if (stableish.length > 0) {
      process.stdout.write('Stablecoin-looking candidates, for you to confirm:\n');
      for (const t of stableish.slice(0, 8)) {
        process.stdout.write(
          `  ${t.address}  ${t.symbol}  ${t.pools} pool(s), ${t.decimals} decimals\n`,
        );
      }
    }
    process.stdout.write('Widen the scan with FIND_WINDOWS=200 if the chain is quiet.\n');
  }

  if (earliestInitialize !== null) {
    process.stdout.write(
      `\nEarliest Initialize seen: block ${earliestInitialize}.\n` +
        'That is a LOWER BOUND for START_BLOCK, not the answer — pools created\n' +
        'before this window exist too, and starting above a pool\'s creation block\n' +
        'means the indexer never sees the mint that funded it, so its depth reads\n' +
        'as unknown for good. Widen the scan, or use the PoolManager deployment\n' +
        'block if you have it.\n\n',
    );
  }
}

main().catch((error) => {
  process.stderr.write(`${(error as Error).stack ?? error}\n`);
  process.exit(1);
});
