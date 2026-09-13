/**
 * Verify the §2 addresses against the actual chain.
 *
 *   npm run verify:chain
 *
 * Run this on a box with network access to the RPC, BEFORE the first sync.
 *
 * The failure it exists to catch is quiet and expensive. If `poolManager` is
 * wrong, the indexer starts cleanly, subscribes to an address that emits
 * nothing, and reports a lag that climbs forever — a working-looking site
 * with an empty table and no error anywhere. Every address in `lib/chain.ts`
 * carries a comment saying it is unverified; this is how that comment gets
 * removed honestly.
 *
 * What it checks, in the order that matters:
 *
 *   the RPC is the chain we think it is        (chainId 4663, §2)
 *   every §2 address holds code               (not an EOA, not empty)
 *   PoolManager has emitted the v4 events we subscribe to
 *   WETH and USDG answer as ERC20s, with the decimals the maths assumes
 *   a WETH/USDG pool exists, because it is the only path to a USD figure
 *
 * Nothing here writes to the database.
 */

import { decodeEventLog, getAddress } from 'viem';
import { CHAIN, CONTRACTS } from '../../lib/chain';
import { ERC20_ABI, POOL_MANAGER_ABI, V3_FACTORY_ABI } from '../chain/abi';
import { rpc, withFailover } from '../chain/client';
import { env } from '../env';

const PASS = '  ok   ';
const FAIL = '  FAIL ';
const WARN = '  warn ';

let failures = 0;
let warnings = 0;

function pass(message: string): void {
  process.stdout.write(`${PASS}${message}\n`);
}
function fail(message: string): void {
  failures++;
  process.stdout.write(`${FAIL}${message}\n`);
}
function warn(message: string): void {
  warnings++;
  process.stdout.write(`${WARN}${message}\n`);
}

async function hasCode(address: string): Promise<boolean> {
  const code = await rpc((c) => c.getCode({ address: getAddress(address) }), `getCode(${address})`);
  return typeof code === 'string' && code.length > 2;
}

/**
 * Which of these events has the contract actually emitted?
 *
 * The logs are decoded rather than counted. An earlier version of this
 * function checked the event name against the ABI instead of against the log
 * and so reported every event as found the moment any log turned up — which
 * would have passed a wrong address that happened to emit something else.
 *
 * Scanned backwards from head in windows, because a range covering a whole
 * chain of ~100ms blocks (§2) in one call is larger than any public endpoint
 * allows.
 */
async function emitsAny(
  address: string,
  abi: readonly unknown[],
  eventNames: string[],
  windows = 40,
  windowSize = 5_000n,
): Promise<{ found: string[]; logs: number; scanned: bigint }> {
  const head = await rpc((c) => c.getBlockNumber(), 'getBlockNumber');
  const found = new Set<string>();
  let to = head;
  let scanned = 0n;
  let seen = 0;

  for (let i = 0; i < windows && to > 0n; i++) {
    const from = to > windowSize ? to - windowSize + 1n : 0n;
    let logs: { data: `0x${string}`; topics: string[] }[] = [];
    try {
      logs = (await rpc(
        (c) => c.getLogs({ address: getAddress(address), fromBlock: from, toBlock: to }),
        `getLogs(${from}-${to})`,
      )) as never;
    } catch (error) {
      warn(`getLogs failed for ${address} at ${from}-${to}: ${(error as Error).message}`);
      break;
    }

    scanned += to - from + 1n;
    seen += logs.length;
    for (const log of logs) {
      try {
        const decoded = decodeEventLog({
          abi: abi as never,
          data: log.data,
          topics: log.topics as never,
        });
        // `abi as never` loses the event-name type, so narrow it back here
        // rather than trusting it.
        const name = decoded.eventName as string | undefined;
        if (typeof name === 'string' && eventNames.includes(name)) found.add(name);
      } catch {
        // A log this contract emits that is not in our ABI. Not a problem —
        // it just is not one of the events we subscribe to.
      }
    }
    // Stop once every event we care about has been seen at least once.
    if (found.size === eventNames.length) break;
    if (from === 0n) break;
    to = from - 1n;
  }
  return { found: [...found], logs: seen, scanned };
}

async function main(): Promise<void> {
  process.stdout.write(`\nVerifying ${CHAIN.name} (chainId ${CHAIN.id})\n`);
  process.stdout.write(`Endpoints: ${env.rpcUrls.length}\n\n`);

  // 1. Are we even on the right chain? Everything below is meaningless if not.
  process.stdout.write('chain\n');
  try {
    const { value: id, endpoint } = await withFailover((c) => c.getChainId(), 'getChainId');
    if (id === CHAIN.id) pass(`chainId ${id} via ${endpoint}`);
    else {
      fail(`chainId is ${id}, expected ${CHAIN.id}. Indexing this would fill the database with another chain's logs.`);
      process.exitCode = 1;
      return;
    }
  } catch (error) {
    fail(`no endpoint answered: ${(error as Error).message}`);
    process.exitCode = 1;
    return;
  }

  const head = await rpc((c) => c.getBlock({ blockTag: 'latest' }), 'getBlock');
  pass(`head is block ${head.number} at ${new Date(Number(head.timestamp) * 1000).toISOString()}`);

  // 2. Does every §2 address hold code? An EOA here means a typo, and a typo
  //    in poolManager is the silent failure this script exists for.
  process.stdout.write('\n§2 addresses hold code\n');
  for (const [name, address] of Object.entries(CONTRACTS)) {
    try {
      if (await hasCode(address)) pass(`${name.padEnd(16)} ${address}`);
      else fail(`${name.padEnd(16)} ${address} — NO CODE. Wrong address, or not deployed on this chain.`);
    } catch (error) {
      warn(`${name.padEnd(16)} ${address} — could not read: ${(error as Error).message}`);
    }
  }

  // 3. The PoolManager is the one address the whole indexer depends on.
  process.stdout.write('\nPoolManager emits the v4 events we subscribe to\n');
  const wanted = ['Initialize', 'Swap', 'ModifyLiquidity'];
  const manager = await emitsAny(CONTRACTS.poolManager, POOL_MANAGER_ABI, wanted);
  if (manager.found.length === wanted.length) {
    pass(`all of ${wanted.join(', ')} seen in the last ${manager.scanned} blocks`);
  } else if (manager.found.length > 0) {
    pass(`${manager.found.join(', ')} seen in the last ${manager.scanned} blocks`);
    const missing = wanted.filter((n) => !manager.found.includes(n));
    warn(
      `${missing.join(', ')} not seen. Probably just a quiet window rather than a ` +
        'wrong address, since the other events decoded — widen the scan if unsure.',
    );
  } else if (manager.logs > 0) {
    fail(
      `${CONTRACTS.poolManager} emitted ${manager.logs} log(s) in ${manager.scanned} blocks ` +
        'but NONE of them decode as v4 PoolManager events. This is almost certainly ' +
        'the wrong contract.',
    );
  } else {
    fail(
      `no logs at all from ${CONTRACTS.poolManager} in the last ${manager.scanned} blocks. ` +
        'Either the address is wrong or there is no v4 activity — and the indexer ' +
        'cannot tell those apart: it would run forever with an empty table.',
    );
  }

  // 4. The two tokens every price is derived through.
  process.stdout.write('\nthe tokens the price path runs on\n');
  const usdg = process.env.USDG_ADDRESS;
  const tokens: [string, string, number][] = [['WETH', CONTRACTS.weth, 18]];
  if (usdg) tokens.push(['USDG', usdg, 6]);
  else
    fail(
      'USDG_ADDRESS is not set. The WETH/USDG pool is the only path to a USD ' +
        'figure (§4.3); without it every dollar amount on the site reads zero.',
    );

  for (const [label, address, expectedDecimals] of tokens) {
    try {
      const [symbol, decimals] = await Promise.all([
        rpc((c) => c.readContract({ address: getAddress(address), abi: ERC20_ABI, functionName: 'symbol' })),
        rpc((c) => c.readContract({ address: getAddress(address), abi: ERC20_ABI, functionName: 'decimals' })),
      ]);
      const dec = Number(decimals);
      if (dec === expectedDecimals) pass(`${label} is ${symbol} with ${dec} decimals`);
      else
        warn(
          `${label} is ${symbol} with ${dec} decimals, not the ${expectedDecimals} assumed. ` +
            'Decimals are an input to every price — check the aggregation before trusting a figure.',
        );
    } catch (error) {
      fail(`${label} at ${address} does not answer as an ERC20: ${(error as Error).message}`);
    }
  }

  // 5. The v3 factory, if one is configured. Optional, but its absence means
  //    v3 pools are only the hand-listed ones.
  process.stdout.write('\nv3 factory (optional)\n');
  const factory = process.env.V3_FACTORY;
  if (!factory) {
    warn('V3_FACTORY is not set — v3 pools will only be those named in V3_POOLS (§4).');
  } else if (await hasCode(factory)) {
    const result = await emitsAny(factory, V3_FACTORY_ABI, ['PoolCreated'], 10);
    if (result.found.length > 0) pass(`factory ${factory} has emitted PoolCreated`);
    else if (result.logs > 0)
      warn(
        `factory ${factory} emitted ${result.logs} log(s) but no PoolCreated decoded — ` +
          'possibly the wrong contract, possibly just an old factory.',
      );
    else warn(`factory ${factory} holds code but emitted nothing in ${result.scanned} blocks`);
  } else {
    fail(`V3_FACTORY ${factory} holds no code`);
  }

  process.stdout.write(`\n${failures} failure(s), ${warnings} warning(s)\n`);
  if (failures > 0) {
    process.stdout.write(
      '\nDo not start the first sync until the failures above are resolved. A wrong\n' +
        'address does not error — it produces a site that looks like it works and\n' +
        'has nothing in it.\n\n',
    );
    process.exitCode = 1;
  } else {
    process.stdout.write(
      '\nThe addresses check out. Update the comments in lib/chain.ts to say they\n' +
        'were verified, and against which endpoint.\n\n',
    );
  }
}

main().catch((error) => {
  process.stderr.write(`${(error as Error).stack ?? error}\n`);
  process.exit(1);
});
