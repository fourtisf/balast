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

/** A v3 pool's own Mint log: Mint(sender, owner indexed, tickLower indexed, tickUpper indexed, amount, amount0, amount1). */
const POOL_MINT_TOPIC = toEventSelector('Mint(address,address,int24,int24,uint128,uint256,uint256)');

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
  /** Gross, per side: everything ever put in, and every principal ever taken out. A closed position's net is zero; these are what it did. */
  in0: bigint;
  in1: bigint;
  out0: bigint;
  out1: bigint;
  /** Net liquidity the history adds up to; must equal the chain's. */
  liquidity: bigint;
  /** When the first IncreaseLiquidity landed. */
  mintedAt: Date | null;
  /**
   * The v3 pools the position's own receipts minted into (the pool's `Mint`
   * log with the manager as owner), and who sent those transactions. A
   * closed position is told apart by what the browser says (its pool, its
   * wallet), and these are what that is checked against.
   */
  pools: string[];
  senders: string[];
  /**
   * False when the explorer did not answer and the history was summed from
   * the browser's own transaction hints alone: the liquidity check still
   * proves the principal, but a collect sent from somewhere else would be
   * missing from the fees collected, so that figure is not claimed.
   */
  collectedKnown: boolean;
}

const TIMEOUT_MS = 6_000;
/** A position's own transactions: a mint, some collects, a withdrawal. More than this is not a position a page lists. */
const MAX_TXS = 60;

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
  // The three questions are independent, so they are asked together; any
  // one failing fails the answer, since a missing event cannot be told from
  // an event that never happened.
  const answers = await Promise.all(
    Object.values(TOPICS).map(async (topic0) => {
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
        return (await response.json()) as { result?: unknown };
      } finally {
        clearTimeout(timer);
      }
    }),
  );
  for (const body of answers) {
    // "No logs found" arrives as status 0 with an empty result, not an error.
    for (const row of Array.isArray(body.result) ? body.result : []) {
      const hash = (row as { transactionHash?: unknown }).transactionHash;
      if (typeof hash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(hash)) hashes.add(hash.toLowerCase() as Hex);
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
  collectedKnown = true,
): Promise<V3History | null> {
  const topic1 = tokenTopic(tokenId).toLowerCase();
  const wanted = manager.toLowerCase();
  const h = { inc0: 0n, inc1: 0n, dec0: 0n, dec1: 0n, col0: 0n, col1: 0n, liq: 0n };
  let firstIncrease: { block: bigint; index: number } | null = null;
  const pools = new Set<string>();
  const senders = new Set<string>();
  const managerTopic = `0x${wanted.slice(2).padStart(64, '0')}`;
  const unique = [...new Set(txs.map((t) => t.toLowerCase() as Hex))].slice(0, MAX_TXS);
  const receipts = await Promise.all(unique.map((hash) => client.getTransactionReceipt({ hash })));
  for (const receipt of receipts) {
    if (receipt.status !== 'success') continue;
    let touches = false;
    for (const log of receipt.logs) {
      if ((log.topics[0] ?? '').toLowerCase() === POOL_MINT_TOPIC && (log.topics[1] ?? '').toLowerCase() === managerTopic) {
        pools.add(log.address.toLowerCase());
      }
      if (log.address.toLowerCase() === wanted && (log.topics[1] ?? '').toLowerCase() === topic1) touches = true;
    }
    if (touches && typeof receipt.from === 'string') senders.add(receipt.from.toLowerCase());
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
    in0: h.inc0,
    in1: h.inc1,
    out0: h.dec0,
    out1: h.dec1,
    liquidity: h.liq,
    mintedAt: block ? new Date(Number(block.timestamp) * 1000) : null,
    collectedKnown,
    pools: [...pools],
    senders: [...senders],
  };
}

/** A verified history is re-read after this; until then it is served as is. */
const FRESH_MS = 60_000;
/** Histories kept, across restarts too. */
const KEEP = 500;

export interface HistoryStore {
  load(): Promise<Record<string, SerializedHistory>>;
  save(all: Record<string, SerializedHistory>): Promise<void>;
}

export interface SerializedHistory {
  d0: string;
  d1: string;
  c0: string;
  c1: string;
  i0?: string;
  i1?: string;
  o0?: string;
  o1?: string;
  liquidity: string;
  mintedAt: string | null;
  collectedKnown: boolean;
  at: number;
  txs?: string[];
  pools?: string[];
  senders?: string[];
}

function serialize(h: V3History, at: number, txs: string[]): SerializedHistory {
  return {
    d0: h.deposited0.toString(),
    d1: h.deposited1.toString(),
    c0: h.collectedFees0.toString(),
    c1: h.collectedFees1.toString(),
    i0: h.in0.toString(),
    i1: h.in1.toString(),
    o0: h.out0.toString(),
    o1: h.out1.toString(),
    liquidity: h.liquidity.toString(),
    mintedAt: h.mintedAt ? h.mintedAt.toISOString() : null,
    collectedKnown: h.collectedKnown,
    at,
    txs,
    pools: h.pools,
    senders: h.senders,
  };
}

function deserialize(s: SerializedHistory): Kept | null {
  try {
    return {
      value: {
        deposited0: BigInt(s.d0),
        deposited1: BigInt(s.d1),
        collectedFees0: BigInt(s.c0),
        collectedFees1: BigInt(s.c1),
        // Kept before the gross figures were: in is the net, out is nothing.
        in0: BigInt(s.i0 ?? s.d0),
        in1: BigInt(s.i1 ?? s.d1),
        out0: BigInt(s.o0 ?? '0'),
        out1: BigInt(s.o1 ?? '0'),
        liquidity: BigInt(s.liquidity),
        mintedAt: s.mintedAt ? new Date(s.mintedAt) : null,
        collectedKnown: s.collectedKnown !== false,
        pools: s.pools ?? [],
        senders: s.senders ?? [],
      },
      at: Number(s.at) || 0,
      txs: new Set((s.txs ?? []).map((t) => t.toLowerCase())),
    };
  } catch {
    return null;
  }
}

interface Kept {
  value: V3History;
  at: number;
  /** The transactions it was summed from. */
  txs: Set<string>;
}

export interface HistoryRequest {
  tokenId: bigint;
  liquidity: bigint;
  /** Transactions the browser sent for this token id (lib/tx-history.ts): candidates, checked like the explorer's. */
  hints?: Hex[];
}

/**
 * Reads histories and keeps the last one that checked out.
 *
 * The first version asked the explorer on every portfolio request and showed
 * a dash whenever the answer was slow or refused — so the same position read
 * `$0` measured on one load and `—` on the next. Now a verified history is
 * kept (in memory and, through `store`, across restarts) and served while it
 * still describes the position: same liquidity, since a history is only
 * valid for the liquidity it adds up to. It is re-read in the background
 * after a minute, and a failed re-read keeps the last good one. The browser's
 * own transaction hashes are a second way to find the logs, so a position
 * minted here is measured even when the explorer does not answer.
 */
export class V3HistoryReader {
  private readonly good = new Map<string, Kept>();
  private readonly inflight = new Map<string, Promise<V3History | null>>();
  private loaded: Promise<void> | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly options: {
      base: string | null;
      fetch?: ExplorerFetch;
      /** The chain, for the receipts. */
      withClient: <T>(fn: (client: PublicClient) => Promise<T>) => Promise<T>;
      store?: HistoryStore;
      now?: () => number;
    },
  ) {}

  private now(): number {
    return this.options.now ? this.options.now() : Date.now();
  }

  private load(): Promise<void> {
    if (!this.loaded) {
      this.loaded = (async () => {
        if (!this.options.store) return;
        try {
          const all = await this.options.store.load();
          for (const [key, raw] of Object.entries(all)) {
            const parsed = deserialize(raw);
            if (parsed && !this.good.has(key)) this.good.set(key, parsed);
          }
        } catch {
          /* nothing kept is the same as a fresh start */
        }
      })();
    }
    return this.loaded;
  }

  private persist(): void {
    const store = this.options.store;
    if (!store || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      const entries = [...this.good.entries()].sort((a, b) => b[1].at - a[1].at).slice(0, KEEP);
      const all: Record<string, SerializedHistory> = {};
      for (const [key, { value, at, txs }] of entries) all[key] = serialize(value, at, [...txs]);
      void store.save(all).catch(() => undefined);
    }, 1_000);
    this.saveTimer.unref?.();
  }

  /** One fresh read, shared by concurrent callers. Null when it could not be read or did not check out. */
  private fresh(req: HistoryRequest): Promise<V3History | null> {
    const key = req.tokenId.toString();
    const running = this.inflight.get(key);
    if (running) return running;
    const work = (async () => {
      let located: Hex[] = [];
      let explorerAnswered = false;
      if (this.options.base) {
        try {
          located = await explorerHistoryTxs(req.tokenId, { base: this.options.base, fetch: this.options.fetch });
          explorerAnswered = true;
        } catch {
          /* the browser's hints may still find it */
        }
      }
      const txs = [...located, ...(req.hints ?? [])];
      if (txs.length === 0) return null;
      const value = await this.options.withClient((c) =>
        historyFromReceipts(c, req.tokenId, txs, req.liquidity, CONTRACTS.v3PositionManager, explorerAnswered),
      );
      if (value) {
        this.good.set(key, { value, at: this.now(), txs: new Set(txs.map((t) => t.toLowerCase())) });
        this.persist();
      }
      return value;
    })()
      .catch(() => null)
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, work);
    return work;
  }

  /** Histories for the positions given, by token id. A position whose history cannot be read or checked is absent. */
  async read(positions: HistoryRequest[]): Promise<Map<string, V3History>> {
    await this.load();
    const out = new Map<string, V3History>();
    const now = this.now();
    await Promise.all(
      positions.slice(0, 30).map(async (req) => {
        const key = req.tokenId.toString();
        const kept = this.good.get(key);
        // A hint the kept history was not summed from is a transaction sent
        // since — a collect, most likely — so it is read again now rather
        // than served without it.
        const newHint = (req.hints ?? []).some((h) => kept && !kept.txs.has(h.toLowerCase()));
        const usable = kept && kept.value.liquidity === req.liquidity && !newHint ? kept : null;
        if (usable) {
          out.set(key, usable.value);
          // Served now; re-read behind the answer so a collect sent since shows up.
          if (now - usable.at >= FRESH_MS) void this.fresh(req);
          return;
        }
        const value = await this.fresh(req);
        if (value) out.set(key, value);
        // A fresh read that failed still leaves the last good one, if it
        // describes this liquidity.
        else if (kept && kept.value.liquidity === req.liquidity) out.set(key, kept.value);
      }),
    );
    return out;
  }
}
