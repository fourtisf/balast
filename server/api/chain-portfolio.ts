/**
 * The portfolio's reads from the chain, through the same RPC failover as
 * every other read (server/chain/client.ts), each bounded so a slow node costs
 * a request its chain half and never hangs it.
 */

import { parseAbi, type Address } from 'viem';
import { CONTRACTS } from '../../lib/chain';
import { V3_POOL_ABI } from '../../lib/v3/mint';
import { readV3Positions } from '../../lib/v3/positions';
import { STATE_VIEW_ABI } from '../../lib/v4/flow';
import { poolId } from '../../lib/v4/pool';
import { readNextTokenId, readOwners, readV4Positions } from '../../lib/v4/positions';
import { rpc } from '../chain/client';
import type { ChainPortfolioReader } from './portfolio';
import { V3HistoryReader } from './v3-history';
import type { ExplorerFetch } from './explorer-positions';
import type { ScannerSource } from './v4-scanner';

const FACTORY_ABI = parseAbi(['function getPool(address, address, uint24) view returns (address)']);
const ERC20_META_ABI = parseAbi([
  'function symbol() view returns (string)',
  'function name() view returns (string)',
  'function decimals() view returns (uint8)',
]);
const multicallAddress = CONTRACTS.multicall3 as Address;

function bounded<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what}: the node did not answer within ${ms / 1000}s`)), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** The positions themselves: long enough for a multicall or two on a public endpoint. */
const POSITIONS_MS = 8_000;
/** Prices and descriptions: nice to have, so shorter. */
const EXTRAS_MS = 5_000;

/** A v3 position's history: the explorer locates it, receipts on chain count it. */
const HISTORY_MS = 10_000;

export function chainPortfolioReader(options: { explorerBase?: string | null; explorerFetch?: ExplorerFetch } = {}): ChainPortfolioReader {
  const history = options.explorerBase
    ? new V3HistoryReader({
        base: options.explorerBase,
        fetch: options.explorerFetch,
        withClient: (fn) => rpc((c) => fn(c as never), 'v3 position history'),
      })
    : null;
  return {
    ...(history ? { v3History: (positions) => bounded(history.read(positions), HISTORY_MS, 'v3 position history') } : {}),
    v3Positions: (owner) => bounded(rpc((c) => readV3Positions(c, owner), 'v3 positions'), POSITIONS_MS, 'v3 positions'),
    v4Positions: (owner, candidates) =>
      bounded(rpc((c) => readV4Positions(c, owner, candidates), 'v4 positions'), POSITIONS_MS, 'v4 positions'),
    slot0s: (pools) =>
      bounded(
        rpc(async (c) => {
          const results = await c.multicall({
            contracts: pools.map((p) =>
              p.protocol === 'v3'
                ? { address: p.address as Address, abi: V3_POOL_ABI, functionName: 'slot0' as const }
                : {
                    address: CONTRACTS.stateView as Address,
                    abi: STATE_VIEW_ABI,
                    functionName: 'getSlot0' as const,
                    args: [poolId(p.key)] as const,
                  },
            ),
            allowFailure: true,
            multicallAddress,
          });
          const out = new Map<string, { sqrtPriceX96: bigint; tick: number }>();
          pools.forEach((p, i) => {
            const r = results[i];
            if (r.status !== 'success') return;
            const [sqrtPriceX96, tick] = r.result as unknown as readonly [bigint, number];
            if (sqrtPriceX96 > 0n) out.set(p.id, { sqrtPriceX96, tick: Number(tick) });
          });
          return out;
        }, 'pool prices'),
        EXTRAS_MS,
        'pool prices',
      ),
    v3PoolAddresses: (keys) =>
      bounded(
        rpc(async (c) => {
          const results = await c.multicall({
            contracts: keys.map((k) => ({
              address: CONTRACTS.v3Factory as Address,
              abi: FACTORY_ABI,
              functionName: 'getPool' as const,
              args: [k.token0 as Address, k.token1 as Address, k.fee] as const,
            })),
            allowFailure: true,
            multicallAddress,
          });
          const out = new Map<string, string>();
          keys.forEach((k, i) => {
            const r = results[i];
            if (r.status === 'success') out.set(`${k.token0.toLowerCase()}|${k.token1.toLowerCase()}|${k.fee}`, (r.result as string).toLowerCase());
          });
          return out;
        }, 'v3 pool addresses'),
        EXTRAS_MS,
        'v3 pool addresses',
      ),
    tokens: (addresses) =>
      bounded(
        rpc(async (c) => {
          const results = await c.multicall({
            contracts: addresses.flatMap((a) =>
              (['symbol', 'name', 'decimals'] as const).map((functionName) => ({
                address: a as Address,
                abi: ERC20_META_ABI,
                functionName,
              })),
            ),
            allowFailure: true,
            multicallAddress,
          });
          const out = new Map<string, { symbol: string; name: string; decimals: number }>();
          addresses.forEach((a, i) => {
            const [symbol, name, decimals] = [results[3 * i], results[3 * i + 1], results[3 * i + 2]];
            // Decimals are an input to every amount on the row; a token that
            // will not state them is not described at all.
            if (decimals.status !== 'success') return;
            out.set(a.toLowerCase(), {
              symbol: symbol.status === 'success' ? String(symbol.result) : `${a.slice(0, 6)}…`,
              name: name.status === 'success' ? String(name.result) : 'Unknown token',
              decimals: Number(decimals.result),
            });
          });
          return out;
        }, 'token metadata'),
        EXTRAS_MS,
        'token metadata',
      ),
  };
}

/** Where the v4 scanner reads: the chain. */
export function chainScannerSource(): ScannerSource {
  return {
    next: () => rpc((c) => readNextTokenId(c), 'nextTokenId'),
    owners: (from, to) => rpc((c) => readOwners(c, from, to), 'v4 owners'),
  };
}
