/**
 * A v3 position's own history: what was put in, what was taken out, and what
 * was collected — from the chain's logs.
 *
 * The portfolio lists v3 positions from the chain (§29), and their funding was
 * never indexed, so *price impact on holdings* read "0 of 1 positions
 * measured" and fees ever collected were unknown. The v3
 * NonfungiblePositionManager emits all three facts, each indexed by token id:
 *
 *   IncreaseLiquidity(tokenId, liquidity, amount0, amount1)   money in
 *   DecreaseLiquidity(tokenId, liquidity, amount0, amount1)   principal out
 *   Collect(tokenId, recipient, amount0, amount1)             paid out
 *
 * The principal is Σincrease − Σdecrease. Collect pays out both the principal
 * a decrease released and the fees, so the fees collected are
 * Σcollect − Σdecrease.
 *
 * Finding those logs means a range to search, and a free endpoint will not
 * search sixty million blocks. The explorer is asked only WHERE they are —
 * which transactions — and every number is then read from that
 * transaction's receipt on chain (§4: an outside source may locate, never
 * count). And the history is checked before it is used: the liquidity it adds
 * up to must equal the liquidity the chain says the position holds now. A
 * history the explorer served incompletely fails that and is not used, so the
 * page shows a dash rather than a principal that is wrong.
 */

import { decodeEventLog, parseAbi, toEventSelector, type Hex, type PublicClient } from 'viem';
import { CONTRACTS } from '../../lib/chain';
import { USER_AGENT } from '../indexer/logo-sources';
import type { ExplorerFetch } from './explorer-positions';

export const V3_MANAGER_EVENTS = parseAbi([
  'event IncreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)',
  'event DecreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)',
  'event Collect(uint256 indexed tokenId, address recipient, uint256 amount0, uint256 amount1)',
]);

const TOPICS = {
  increase: toEventSelector('IncreaseLiquidity(uint256,uint128,uint256,uint256)'),
  decrease: toEventSelector('DecreaseLiquidity(uint256,uint128,uint256,uint256)'),
  collect: toEventSelector('Collect(uint256,address,uint256,uint256)'),
};

export interface V3History {
  /** Net principal: Σincrease − Σdecrease, per side. */
  deposited0: bigint;
  deposited1: bigint;
  /** Fees already paid out to the owner: Σcollect − Σdecrease, per side, never below zero. */
  collectedFees0: bigint;
  collectedFees1: bigint;
  /** Net liquidity the history adds up to; must equal the chain's. */
  liquidity: bigint;
  /** When the first IncreaseLiquidity landed. */
  mintedAt: Date | null;
}

const TIMEOUT_MS = 6_000;

function tokenTopic(tokenId: bigint): Hex {
  return `0x${tokenId.toString(16).padStart(64, '0')}`;
}

/**
 * The transactions the explorer says carry one of the three events for a
 * token id, through its Etherscan-compatible logs API. Candidates only.
 */
export async function explorerHistoryTxs(
  tokenId: bigint,
  options: { base: string; fetch?: ExplorerFetch; manager?: string; timeoutMs?: number },
): Promise<Hex[]> {
  const fetchFn = options.fetch ?? fetch;
  const base = options.base.replace(/\/+$/, '');
  const manager = (options.manager ?? CONTRACTS.v3PositionManager).toLowerCase();
  const hashes = new Set<Hex>();
  for (const topic0 of Object.values(TOPICS)) {
    const query = new URLSearchParams({
      module: 'logs',
      action: 'getLogs',
      fromBlock: '0',
      toBlock: 'latest',
      address: manager,
      topic0,
      topic1: tokenTopic(tokenId),
      topic0_1_opr: 'and',
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? TIMEOUT_MS);
    try {
      const response = await fetchFn(`${base}/api?${query}`, {
        headers: { accept: 'application/json', 'user-agent': USER_AGENT },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`explorer answered ${response.status}`);
      const body = (await response.json()) as { result?: unknown };
      // "No logs found" arrives as status 0 with an empty result, not an error.
      for (const row of Array.isArray(body.result) ? body.result : []) {
        const hash = (row as { transactionHash?: unknown }).transactionHash;
        if (typeof hash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(hash)) hashes.add(hash.toLowerCase() as Hex);
      }
    } finally {
      clearTimeout(timer);
    }
  }
  return [...hashes];
}

/**
 * Sum a token id's history from the receipts of the transactions named, and
 * check it against the liquidity the chain holds. Null when it does not add
 * up — an incomplete list is not a history.
 */
export async function historyFromReceipts(
  client: PublicClient,
  tokenId: bigint,
  txs: Hex[],
  liquidityNow: bigint,
  manager: string = CONTRACTS.v3PositionManager,
): Promise<V3History | null> {
  const topic1 = tokenTopic(tokenId).toLowerCase();
  const wanted = manager.toLowerCase();
  const h = { inc0: 0n, inc1: 0n, dec0: 0n, dec1: 0n, col0: 0n, col1: 0n, liq: 0n };
  let firstIncrease: { block: bigint; index: number } | null = null;
  for (const hash of txs) {
    const receipt = await client.getTransactionReceipt({ hash });
    if (receipt.status !== 'success') continue;
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== wanted || (log.topics[1] ?? '').toLowerCase() !== topic1) continue;
      let decoded;
      try {
        decoded = decodeEventLog({ abi: V3_MANAGER_EVENTS, data: log.data, topics: log.topics });
      } catch {
        continue;
      }
      if (decoded.eventName === 'IncreaseLiquidity') {
        h.inc0 += decoded.args.amount0;
        h.inc1 += decoded.args.amount1;
        h.liq += decoded.args.liquidity;
        const at = { block: receipt.blockNumber, index: log.logIndex ?? 0 };
        if (!firstIncrease || at.block < firstIncrease.block) firstIncrease = at;
      } else if (decoded.eventName === 'DecreaseLiquidity') {
        h.dec0 += decoded.args.amount0;
        h.dec1 += decoded.args.amount1;
        h.liq -= decoded.args.liquidity;
      } else {
        h.col0 += decoded.args.amount0;
        h.col1 += decoded.args.amount1;
      }
    }
  }
  if (!firstIncrease || h.liq !== liquidityNow) return null;
  const block = await client.getBlock({ blockNumber: firstIncrease.block }).catch(() => null);
  const pos = (n: bigint) => (n > 0n ? n : 0n);
  return {
    deposited0: pos(h.inc0 - h.dec0),
    deposited1: pos(h.inc1 - h.dec1),
    collectedFees0: pos(h.col0 - h.dec0),
    collectedFees1: pos(h.col1 - h.dec1),
    liquidity: h.liq,
    mintedAt: block ? new Date(Number(block.timestamp) * 1000) : null,
  };
}

/** Answers kept per token id: a history changes only when its owner acts. */
const CACHE_MS = 60_000;

export class V3HistoryReader {
  private readonly cache = new Map<string, { at: number; liquidity: bigint; value: V3History | null }>();

  constructor(
    private readonly options: {
      base: string;
      fetch?: ExplorerFetch;
      /** The chain, for the receipts. */
      withClient: <T>(fn: (client: PublicClient) => Promise<T>) => Promise<T>;
    },
  ) {}

  /** Histories for the positions given, by token id. A position whose history cannot be read or checked is absent. */
  async read(positions: { tokenId: bigint; liquidity: bigint }[]): Promise<Map<string, V3History>> {
    const out = new Map<string, V3History>();
    const now = Date.now();
    await Promise.all(
      positions.slice(0, 30).map(async ({ tokenId, liquidity }) => {
        const key = tokenId.toString();
        const hit = this.cache.get(key);
        if (hit && hit.liquidity === liquidity && now - hit.at < CACHE_MS) {
          if (hit.value) out.set(key, hit.value);
          return;
        }
        try {
          const txs = await explorerHistoryTxs(tokenId, { base: this.options.base, fetch: this.options.fetch });
          const value = await this.options.withClient((c) => historyFromReceipts(c, tokenId, txs, liquidity));
          this.cache.set(key, { at: now, liquidity, value });
          if (value) out.set(key, value);
        } catch {
          /* unknown, not zero: the page shows a dash */
        }
      }),
    );
    return out;
  }
}
