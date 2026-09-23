/**
 * A wallet's positions: what the chain says it holds, valued through the
 * indexer's prices.
 *
 * WHICH positions, and what is in them, is the chain's answer, read live on
 * every request (§30). The indexer is weeks behind during its backfill, so a
 * portfolio built from its tables alone missed every position minted in that
 * gap — including every one minted through this site — and kept offering
 * Withdraw on positions already withdrawn. A position that is not on the
 * page cannot be withdrawn through the site; that was the fault.
 *
 *   v3  enumerated on the NonfungiblePositionManager (lib/v3/positions.ts).
 *   v4  candidates from the indexer, from the scan of ids minted since the
 *       indexer's last one (v4-scanner.ts) and from ids the browser saw
 *       minted — each confirmed on chain: owner, pool, range, liquidity
 *       (lib/v4/positions.ts).
 *
 * Where each pool's price sits is read live too (slot0), so in-range and
 * the two amounts are today's. DOLLAR prices remain the indexer's, through
 * the one path §4.3 allows: the traded side at its pool's price, the quote at
 * $1 or at the anchor's ether price.
 *
 * If the node does not answer, the v4 positions the indexer knows are listed
 * unverified and the page says so; the v3 ones cannot be listed. A pool the
 * indexer has not met is described from the chain (its key and its tokens'
 * own symbol and decimals) and is still withdrawable; its value is unknown
 * unless its token is priced elsewhere, and says so.
 *
 * Not here: uncollected fees (state, read by the page), collected history
 * (not indexed, so "fees earned" is null rather than wrong — §7). Price
 * impact on holdings needs the principal, which only the indexer's own
 * record of a v4 position carries, and only while that record is current.
 */

import type { Address, Hex } from 'viem';
import { CHAIN, NATIVE_ETH, isEther } from '../../lib/chain';
import { feeTierBpsFromPips } from '../../lib/format';
import type { ClosedPosition, LivePosition, Quote, UserPosition } from '../../lib/data/types';
import type { V3OnchainPosition } from '../../lib/v3/positions';
import type { V3History } from './v3-history';
import type { V4OnchainPosition, V4Read } from '../../lib/v4/positions';
import { indexerPoolId, maxUsableTick, minUsableTick, poolId as v4PoolId, type PoolKey } from '../../lib/v4/pool';
import { amountsForLiquidity } from '../chain/tick-math';
import { prisma } from '../db';
import { resolveUsdg } from '../indexer/anchor';
import { indexedAsOf } from '../indexer/as-of';
import { POOL_MANAGER_CURSOR } from '../indexer/poller';

export interface ChainStatus {
  /**
   * `read`: every position listed was confirmed on chain just now.
   * `unavailable`: the node did not answer — v4 positions are the indexer's,
   * unverified, and v3 positions could not be listed. `off`: this server
   * reads nothing from the chain (tests, or PORTFOLIO_CHAIN=false).
   */
  status: 'read' | 'unavailable' | 'off';
  message?: string;
  /** Positions the chain answered for that could not be described or confirmed. Expected to be zero. */
  unreadable: number;
  /**
   * The scan for v4 positions the indexer has not reached is not complete —
   * it has not finished a pass, its last pass failed, or the chain has more
   * ids than it covers — so a v4 position minted or received since the
   * indexer's last block may be missing.
   */
  partial?: boolean;
  /** v3 positions could not be read just now; v4 ones are listed as usual. */
  v3Unavailable?: boolean;
  /** v3 positions could not be read just now, so the last read that answered is listed. */
  v3Unchecked?: boolean;
  /** Pool prices could not be read live; in-range status and amounts are the indexer's, as of its last block. */
  pricesStale?: boolean;
}

export interface PortfolioResponse {
  wallet: string;
  /** Chain time of the last block indexed: the basis of every dollar price here. */
  asOf: string;
  positions: UserPosition[];
  netValueUsd: number;
  priceImpactUsd: number;
  /** v3 positions this wallet withdrew, from their own logs. */
  closed?: ClosedPosition[];
  /** Every position was valued at today's prices (live slot0, live ether) rather than the indexer's. */
  pricedToday?: boolean;
  chain: ChainStatus;
}

/**
 * Everything the portfolio reads from the chain. Injected, so a test never
 * reaches a node, and the server bounds how long a slow one may hold a
 * request (server.ts).
 */
export interface ChainPortfolioReader {
  v3Positions(owner: Address): Promise<V3OnchainPosition[]>;
  v4Positions(owner: Address, candidates: bigint[]): Promise<V4Read>;
  /** Live slot0 per pool id (`v4:0x…` / `v3:0x…`). A pool missing from the answer was not read. */
  slot0s(pools: LivePoolRef[]): Promise<Map<string, { sqrtPriceX96: bigint; tick: number }>>;
  /** v3 pool addresses for (token0, token1, fee) keys the indexer has not met; zero address for none. */
  v3PoolAddresses(keys: { token0: string; token1: string; fee: number }[]): Promise<Map<string, string>>;
  /** Symbol, name and decimals for tokens the indexer has not met. A token that does not answer is absent. */
  tokens(addresses: string[]): Promise<Map<string, { symbol: string; name: string; decimals: number }>>;
  /**
   * v3 positions' own history — principal, fees collected, minted when —
   * checked against the liquidity each holds now (v3-history.ts). Absent
   * when there is no explorer to locate it; a position missing from the
   * answer has no history the page can trust.
   */
  v3History?(positions: { tokenId: bigint; liquidity: bigint; hints?: Hex[] }[]): Promise<Map<string, V3History>>;
}

export interface LivePoolRef {
  id: string;
  protocol: 'v3' | 'v4';
  /** v3: the pool contract. v4: the pool id. */
  address: string;
  key: PoolKey;
}

/** A pool, as the valuation needs it: the indexer's row, or the chain's description of one it has not met. */
interface PoolMeta {
  id: string;
  address: string;
  protocol: 'v3' | 'v4';
  feeTier: number;
  tickSpacing: number;
  hooks: string;
  token0: string;
  token1: string;
  d0: number;
  d1: number;
  s0: string;
  s1: string;
  n0: string;
  n1: string;
  c0: string | null;
  c1: string | null;
  l0: string | null;
  l1: string | null;
  /** The indexer's last price for the pool; 0n when it has none. */
  sqrt: bigint;
  tick: number;
  /** USD price of the traded side; 0 when unknown. */
  priceUsd: number;
  indexed: boolean;
}

/** One position, from whichever source found it, before it is valued. */
interface Entry {
  tokenId: string;
  pool: PoolMeta;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
  /** Net principal, when the indexer's record of it is current; null otherwise. */
  deposited: { d0: bigint; d1: bigint } | null;
  /** Fees already collected, from a v3 position's own history; null when not known. */
  collected?: { c0: bigint; c1: bigint } | null;
  mintedAt: Date | null;
  /** Confirmed on chain on this read; false for the indexer's record, unchecked. */
  verified: boolean;
}

interface PoolRow {
  pool_id: string;
  pool_address: string;
  protocol: string;
  fee_tier: number;
  tick_spacing: number;
  hooks: string | null;
  token0: string;
  token1: string;
  d0: number;
  d1: number;
  s0: string;
  s1: string;
  n0: string;
  n1: string;
  c0: string | null;
  c1: string | null;
  l0: string | null;
  l1: string | null;
  sqrt: string;
  tick: number;
  price_usd: number;
}

interface IndexedRow extends PoolRow {
  token_id: string;
  tick_lower: number;
  tick_upper: number;
  liquidity: string;
  deposited0: string;
  deposited1: string;
  minted_at: Date | null;
}

const POOL_COLUMNS = `
  pl.id AS pool_id, pl.address AS pool_address, pl.protocol, pl.fee_tier, pl.tick_spacing, pl.hooks,
  pl.token0, pl.token1,
  t0.decimals AS d0, t1.decimals AS d1, t0.symbol AS s0, t1.symbol AS s1, t0.name AS n0, t1.name AS n1,
  t0.logo_color AS c0, t1.logo_color AS c1, t0.logo_url AS l0, t1.logo_url AS l1,
  COALESCE(ps.sqrt_price_x96, pl.init_sqrt_price_x96, 0)::text AS sqrt,
  COALESCE(ps.tick, pl.init_tick, 0) AS tick,
  COALESCE(ps.price_usd, 0)::float8 AS price_usd`;

function metaFromRow(row: PoolRow): PoolMeta {
  return {
    id: row.pool_id,
    address: row.pool_address,
    protocol: row.protocol === 'v3' ? 'v3' : 'v4',
    feeTier: row.fee_tier,
    tickSpacing: row.tick_spacing,
    hooks: row.hooks ?? NATIVE_ETH,
    token0: row.token0,
    token1: row.token1,
    d0: row.d0,
    d1: row.d1,
    s0: row.s0,
    s1: row.s1,
    n0: row.n0,
    n1: row.n1,
    c0: row.c0,
    c1: row.c1,
    l0: row.l0,
    l1: row.l1,
    sqrt: BigInt(row.sqrt),
    tick: row.tick,
    priceUsd: row.price_usd,
    indexed: true,
  };
}

async function poolsById(ids: string[]): Promise<Map<string, PoolMeta>> {
  const out = new Map<string, PoolMeta>();
  if (ids.length === 0) return out;
  const rows = await prisma.$queryRawUnsafe<PoolRow[]>(
    `SELECT ${POOL_COLUMNS}
     FROM pools pl
     JOIN tokens t0 ON lower(t0.address) = lower(pl.token0)
     JOIN tokens t1 ON lower(t1.address) = lower(pl.token1)
     LEFT JOIN pool_state ps ON ps.pool_id = pl.id
     WHERE pl.id = ANY($1::text[])`,
    ids,
  );
  for (const row of rows) out.set(row.pool_id, metaFromRow(row));
  return out;
}

async function v3PoolByKey(token0: string, token1: string, fee: number): Promise<PoolMeta | null> {
  const [row] = await prisma.$queryRawUnsafe<PoolRow[]>(
    `SELECT ${POOL_COLUMNS}
     FROM pools pl
     JOIN tokens t0 ON lower(t0.address) = lower(pl.token0)
     JOIN tokens t1 ON lower(t1.address) = lower(pl.token1)
     LEFT JOIN pool_state ps ON ps.pool_id = pl.id
     WHERE pl.protocol = 'v3' AND lower(pl.token0) = $1 AND lower(pl.token1) = $2 AND pl.fee_tier = $3
     LIMIT 1`,
    token0.toLowerCase(),
    token1.toLowerCase(),
    fee,
  );
  return row ? metaFromRow(row) : null;
}

/** Which side is the traded token: the rule in aggregate.ts `tradedSide`, in TypeScript. */
function tokenIsCurrency0(token0: string, token1: string, usdg: string): boolean {
  const a0 = token0.toLowerCase();
  const a1 = token1.toLowerCase();
  if (a1 === usdg) return true;
  if (a0 === usdg) return false;
  if (isEther(a1)) return true;
  if (isEther(a0)) return false;
  return true;
}

function human(raw: bigint, decimals: number): number {
  return Number(raw) / 10 ** decimals;
}

/**
 * Describe from the chain the pools the indexer has not met, so a position in
 * one can still be shown and withdrawn. Token facts come from the indexer's
 * `tokens` table when it has met the token in another pool, else from the
 * token's own contract; the traded side's dollar price from its deepest priced
 * pool, when it has one.
 */
async function describeUnindexed(
  wanted: { id: string; protocol: 'v3' | 'v4'; address: string; key: PoolKey }[],
  chain: ChainPortfolioReader,
  usdg: string,
): Promise<Map<string, PoolMeta>> {
  const out = new Map<string, PoolMeta>();
  if (wanted.length === 0) return out;
  const addresses = [...new Set(wanted.flatMap((w) => [w.key.currency0.toLowerCase(), w.key.currency1.toLowerCase()]))];
  const known = await prisma.token.findMany({ where: { address: { in: addresses } } });
  const facts = new Map<string, { symbol: string; name: string; decimals: number; logoColor: string | null; logoUrl: string | null }>();
  for (const t of known) facts.set(t.address.toLowerCase(), { symbol: t.symbol, name: t.name, decimals: t.decimals, logoColor: t.logoColor, logoUrl: t.logoUrl });
  facts.set(NATIVE_ETH, { ...CHAIN.nativeCurrency, logoColor: null, logoUrl: facts.get(NATIVE_ETH)?.logoUrl ?? null });
  const missing = addresses.filter((a) => !facts.has(a));
  if (missing.length > 0) {
    const read = await chain.tokens(missing);
    for (const [address, t] of read) facts.set(address.toLowerCase(), { ...t, logoColor: null, logoUrl: null });
  }
  for (const w of wanted) {
    const t0 = facts.get(w.key.currency0.toLowerCase());
    const t1 = facts.get(w.key.currency1.toLowerCase());
    if (!t0 || !t1) continue;
    const traded = tokenIsCurrency0(w.key.currency0, w.key.currency1, usdg) ? w.key.currency0 : w.key.currency1;
    const [priced] = await prisma.$queryRaw<{ price_usd: number }[]>`
      SELECT ps.price_usd::float8 AS price_usd
      FROM pool_state ps JOIN pools pl ON pl.id = ps.pool_id
      WHERE (lower(pl.token0) = ${traded.toLowerCase()} OR lower(pl.token1) = ${traded.toLowerCase()}) AND ps.price_usd > 0
      ORDER BY ps.tvl_usd DESC NULLS LAST LIMIT 1
    `;
    out.set(w.id, {
      id: w.id,
      address: w.address,
      protocol: w.protocol,
      feeTier: w.key.fee,
      tickSpacing: w.key.tickSpacing,
      hooks: w.key.hooks,
      token0: w.key.currency0.toLowerCase(),
      token1: w.key.currency1.toLowerCase(),
      d0: t0.decimals,
      d1: t1.decimals,
      s0: t0.symbol,
      s1: t1.symbol,
      n0: t0.name,
      n1: t1.name,
      c0: t0.logoColor,
      c1: t1.logoColor,
      l0: t0.logoUrl,
      l1: t1.logoUrl,
      sqrt: 0n,
      tick: 0,
      priceUsd: priced?.price_usd ?? 0,
      indexed: false,
    });
  }
  return out;
}

/** v3 tick spacing by fee tier, for a pool the indexer has not met. The factory's four, fixed at deployment. */
const V3_TICK_SPACING: Record<number, number> = { 100: 1, 500: 10, 3000: 60, 10000: 200 };

/** Each wallet's last v3 read that answered, served when the next one does not. */
const lastV3Reads = new Map<string, { at: number; positions: V3OnchainPosition[] }>();
const V3_KEEP_MS = 30 * 60_000;
/** For tests: each starts with no earlier read. */
export function forgetV3Reads(): void {
  lastV3Reads.clear();
}

export async function buildPortfolio(
  wallet: string,
  usdgAddress?: string | null,
  options: {
    chain?: ChainPortfolioReader | null;
    /** v4 token ids to check beyond the indexer's: the scanner's and the browser's. Only what the chain confirms is shown. */
    v4Candidates?: bigint[];
    /** Per v3 token id, transactions the browser sent for it: a second way to find its history. */
    v3TxHints?: Map<string, Hex[]>;
    /** v3 token ids this browser withdrew, with the pool each was in: listed as closed positions once their logs check out. */
    v3Closed?: Map<string, string>;
    /** The v4 scanner could not reach back to the indexer's last id. */
    scanPartial?: boolean;
    /**
     * Ether in dollars now — the snapshot's live figure (§24). With it and a
     * pool's live slot0 every position is valued at today's prices; without
     * it, at the indexer's, and the response says which.
     */
    ethUsd?: number | null;
  } = {},
): Promise<PortfolioResponse | null> {
  const owner = wallet.toLowerCase() as Address;
  const cursor = await prisma.indexerCursor.findUnique({ where: { contract: POOL_MANAGER_CURSOR } });
  if (!cursor) return null;
  const anchor = await resolveUsdg(usdgAddress);
  if (!anchor.address) return null;
  const usdg = anchor.address.toLowerCase();
  const asOf = await indexedAsOf(cursor.lastIndexedAt);

  const [ethRow] = await prisma.$queryRaw<{ price_usd: number }[]>`
    SELECT COALESCE(weth_usd, 0)::float8 AS price_usd FROM weth_usd_hourly ORDER BY hour DESC LIMIT 1
  `;
  const liveEth = options.ethUsd && options.ethUsd > 0 ? options.ethUsd : null;
  const ethUsd = liveEth ?? ethRow?.price_usd ?? 0;

  // The indexer's record for this wallet: candidates to confirm, the only
  // source of a principal, and the fallback when the node does not answer.
  const indexed = await prisma.$queryRawUnsafe<IndexedRow[]>(
    `SELECT
       p.token_id, p.tick_lower, p.tick_upper,
       p.liquidity::text AS liquidity, p.deposited0::text AS deposited0, p.deposited1::text AS deposited1, p.minted_at,
       ${POOL_COLUMNS}
     FROM positions p
     JOIN pools pl ON pl.id = p.pool_id
     JOIN tokens t0 ON lower(t0.address) = lower(pl.token0)
     JOIN tokens t1 ON lower(t1.address) = lower(pl.token1)
     LEFT JOIN pool_state ps ON ps.pool_id = p.pool_id
     -- Every token the indexer last saw this wallet holding, emptied or not:
     -- one topped up again since the indexer's last block still holds money,
     -- and the chain says which ones do.
     WHERE lower(p.wallet) = $1 AND p.status = 'open'
     ORDER BY p.minted_at ASC NULLS LAST, p.token_id ASC`,
    owner,
  );
  const indexedById = new Map(indexed.map((r) => [r.token_id, r]));
  const fromIndex = (r: IndexedRow): Entry => ({
    tokenId: r.token_id,
    pool: metaFromRow(r),
    tickLower: r.tick_lower,
    tickUpper: r.tick_upper,
    liquidity: BigInt(r.liquidity),
    deposited: { d0: BigInt(r.deposited0), d1: BigInt(r.deposited1) },
    mintedAt: r.minted_at,
    verified: false,
  });

  let entries: Entry[];
  let chainStatus: ChainStatus = { status: 'off', unreadable: 0 };
  let live = new Map<string, { sqrtPriceX96: bigint; tick: number }>();

  const chain = options.chain ?? null;
  // The two managers are read independently: a v3 read that times out (a
  // blip, or a wallet with very many v3 NFTs) must not throw away a v4 answer,
  // or a position found only by the scan or a hint would vanish from the page.
  let v4Read: V4Read | null = null;
  let v3Read: V3OnchainPosition[] | null = null;
  let v3Unchecked = false;
  if (chain) {
    const candidates = [...indexed.map((r) => BigInt(r.token_id)), ...(options.v4Candidates ?? [])];
    const [v4, v3] = await Promise.allSettled([chain.v4Positions(owner, candidates), chain.v3Positions(owner)]);
    // The detail goes to the log, not the page: an endpoint's error can carry
    // its URL, and a paid endpoint's URL carries its key.
    if (v4.status === 'fulfilled') v4Read = v4.value;
    else console.warn(`portfolio: v4 positions unreadable on chain for ${owner}: ${(v4.reason as Error).message.split('\n')[0]}`);
    if (v3.status === 'fulfilled') {
      v3Read = v3.value;
      lastV3Reads.set(owner.toLowerCase(), { at: Date.now(), positions: v3.value });
      if (lastV3Reads.size > 2_000) lastV3Reads.delete(lastV3Reads.keys().next().value!);
    } else {
      console.warn(`portfolio: v3 positions unreadable on chain for ${owner}: ${(v3.reason as Error).message.split('\n')[0]}`);
      // A free endpoint that does not answer once — a rate limit right after a
      // collect, say — used to make the wallet's v3 positions vanish from the
      // page. The last read that answered is listed instead, marked as not
      // re-checked; Collect and Withdraw still ask the chain before anything
      // is signed, so a stale row cannot send what the chain would refuse.
      const kept = lastV3Reads.get(owner.toLowerCase());
      if (kept && Date.now() - kept.at < V3_KEEP_MS) {
        v3Read = kept.positions;
        v3Unchecked = true;
      }
    }
  }
  const readPositions = chain ? { v4: v4Read, v3: v3Read } : null;

  // The histories of the v3 positions this wallet withdrew, asked for now
  // rather than after every other read: they do not depend on anything
  // below, and on the free endpoints a read left for last is a read the
  // page waits on (closedPositions, further down).
  const closedIds = (() => {
    const wanted = options.v3Closed;
    if (!chain?.v3History || !wanted || wanted.size === 0) return [];
    const open = new Set((v3Read ?? []).map((p) => p.tokenId.toString()));
    return [...wanted.keys()].filter((id) => !open.has(id)).slice(0, 30);
  })();
  const closedHistories =
    closedIds.length > 0
      ? chain!
          .v3History!(closedIds.map((id) => ({ tokenId: BigInt(id), liquidity: 0n, hints: options.v3TxHints?.get(id) })))
          .catch(() => new Map<string, V3History>())
      : Promise.resolve(new Map<string, V3History>());

  // The indexer's record, where the chain could not be asked: unchecked, and
  // only what it last saw holding liquidity.
  const unchecked = (): Entry[] => indexed.filter((r) => BigInt(r.liquidity) > 0n).map(fromIndex);

  if (!readPositions) {
    entries = unchecked();
  } else {
    let unreadable = readPositions.v4?.unconfirmed ?? 0;
    entries = readPositions.v4 ? [] : unchecked();
    const wanted: LivePoolRef[] = [];
    const pending: { ref: LivePoolRef; make: (pool: PoolMeta) => Entry }[] = [];

    // v4: confirmed on chain. The principal is the indexer's only while its
    // record matches the chain's liquidity; after a change it no longer
    // describes this position.
    // The pool: the indexer's record of this token names it when there is one
    // (the same id as the key's, by construction); otherwise the key's own.
    const v4PoolOf = (p: V4OnchainPosition): string => indexedById.get(p.tokenId.toString())?.pool_id ?? indexerPoolId(p.key);
    const v4Held = readPositions.v4?.positions ?? [];
    const v4Pools = await poolsById([...new Set(v4Held.map(v4PoolOf))]);
    for (const p of v4Held) {
      const id = v4PoolOf(p);
      const record = indexedById.get(p.tokenId.toString());
      const make = (pool: PoolMeta): Entry => ({
        tokenId: p.tokenId.toString(),
        pool,
        tickLower: p.tickLower,
        tickUpper: p.tickUpper,
        liquidity: p.liquidity,
        deposited:
          record && BigInt(record.liquidity) === p.liquidity
            ? { d0: BigInt(record.deposited0), d1: BigInt(record.deposited1) }
            : null,
        mintedAt: record?.minted_at ?? null,
        verified: true,
      });
      const pool = v4Pools.get(id);
      if (pool) entries.push(make(pool));
      else {
        const ref: LivePoolRef = { id, protocol: 'v4', address: v4PoolId(p.key).toLowerCase(), key: p.key };
        wanted.push(ref);
        pending.push({ ref, make });
      }
    }

    // v3: enumerated on chain; the pool matched by its tokens and fee.
    const unknownV3: { position: V3OnchainPosition; key: PoolKey }[] = [];
    for (const position of readPositions.v3 ?? []) {
      const make = (pool: PoolMeta): Entry => ({
        tokenId: position.tokenId.toString(),
        pool,
        tickLower: position.tickLower,
        tickUpper: position.tickUpper,
        liquidity: position.liquidity,
        deposited: null,
        mintedAt: null,
        verified: true,
      });
      const pool = await v3PoolByKey(position.token0, position.token1, position.fee);
      if (pool) {
        entries.push(make(pool));
        continue;
      }
      const spacing = V3_TICK_SPACING[position.fee];
      if (!spacing) {
        unreadable += 1;
        continue;
      }
      unknownV3.push({
        position,
        key: { currency0: position.token0, currency1: position.token1, fee: position.fee, tickSpacing: spacing, hooks: NATIVE_ETH as Address },
      });
    }
    if (unknownV3.length > 0) {
      const addresses = await chain!
        .v3PoolAddresses(unknownV3.map((u) => ({ token0: u.position.token0, token1: u.position.token1, fee: u.position.fee })))
        .catch(() => new Map<string, string>());
      for (const u of unknownV3) {
        const address = addresses.get(`${u.position.token0.toLowerCase()}|${u.position.token1.toLowerCase()}|${u.position.fee}`);
        if (!address || /^0x0{40}$/i.test(address)) {
          unreadable += 1;
          continue;
        }
        const ref: LivePoolRef = { id: `v3:${address.toLowerCase()}`, protocol: 'v3', address: address.toLowerCase(), key: u.key };
        wanted.push(ref);
        const position = u.position;
        pending.push({
          ref,
          make: (pool) => ({
            tokenId: position.tokenId.toString(),
            pool,
            tickLower: position.tickLower,
            tickUpper: position.tickUpper,
            liquidity: position.liquidity,
            deposited: null,
            mintedAt: null,
            verified: true,
          }),
        });
      }
    }

    const described = await describeUnindexed(wanted, chain!, usdg).catch(() => new Map<string, PoolMeta>());
    for (const { ref, make } of pending) {
      const pool = described.get(ref.id);
      if (pool) entries.push(make(pool));
      else unreadable += 1;
    }

    // Where every pool's price is now. Best effort: a pool the node did not
    // answer for falls back to the indexer's last price, and says so by
    // carrying the indexer's out-of-range history rather than today's.
    const refs = new Map<string, LivePoolRef>();
    for (const e of entries) {
      refs.set(e.pool.id, {
        id: e.pool.id,
        protocol: e.pool.protocol,
        address: e.pool.address,
        key: {
          currency0: e.pool.token0 as Address,
          currency1: e.pool.token1 as Address,
          fee: e.pool.feeTier,
          tickSpacing: e.pool.tickSpacing,
          hooks: e.pool.hooks as Address,
        },
      });
    }
    let pricesStale = false;
    live = await chain!.slot0s([...refs.values()]).catch(() => {
      pricesStale = refs.size > 0;
      return new Map();
    });
    // A v3 position's principal and the fees it has already paid out, from
    // its own logs (v3-history.ts). Best effort: without them the page shows
    // a dash, as it did, never a guess.
    const v3Unknown = entries.filter((e) => e.pool.protocol === 'v3' && e.deposited === null);
    if (v3Unknown.length > 0 && chain!.v3History) {
      const histories = await chain!
        .v3History(
          v3Unknown.map((e) => ({ tokenId: BigInt(e.tokenId), liquidity: e.liquidity, hints: options.v3TxHints?.get(e.tokenId) })),
        )
        .catch(() => new Map<string, V3History>());
      for (const e of v3Unknown) {
        const h = histories.get(e.tokenId);
        if (!h) continue;
        e.deposited = { d0: h.deposited0, d1: h.deposited1 };
        if (h.collectedKnown) e.collected = { c0: h.collectedFees0, c1: h.collectedFees1 };
        e.mintedAt = e.mintedAt ?? h.mintedAt;
      }
    }

    chainStatus = {
      status: readPositions.v4 ? 'read' : 'unavailable',
      ...(readPositions.v4
        ? {}
        : { message: 'The chain did not answer, so the Uniswap v4 positions are the indexer’s and were not checked just now.' }),
      unreadable,
      ...(options.scanPartial ? { partial: true } : {}),
      ...(readPositions.v3 ? {} : { v3Unavailable: true }),
      ...(v3Unchecked ? { v3Unchecked: true } : {}),
      ...(pricesStale ? { pricesStale: true } : {}),
    };
  }

  // Oldest first, as the indexer ordered them; ids break ties.
  entries.sort((a, b) => {
    const ta = a.mintedAt ? new Date(a.mintedAt).getTime() : Number.MAX_SAFE_INTEGER;
    const tb = b.mintedAt ? new Date(b.mintedAt).getTime() : Number.MAX_SAFE_INTEGER;
    if (ta !== tb) return ta - tb;
    if (a.pool.protocol !== b.pool.protocol) return a.pool.protocol === 'v4' ? -1 : 1;
    return BigInt(a.tokenId) < BigInt(b.tokenId) ? -1 : 1;
  });

  const positions: UserPosition[] = [];
  // How many positions were valued at today's prices; the page says which.
  let todayCount = 0;
  // Each side's dollar price for a pool: the traded side at the pool's own
  // price NOW when the chain answered and the quote's dollar price is today's
  // — USDG, or ether from the live feed — else at the indexer's. The same one
  // path (§4.3); only its date moves.
  const pricesFor = (pool: PoolMeta, now: { sqrtPriceX96: bigint } | undefined) => {
    const tokenFirst = tokenIsCurrency0(pool.token0, pool.token1, usdg);
    const traded = (tokenFirst ? pool.token0 : pool.token1).toLowerCase();
    const priceOf = (address: string): number => {
      const a = address.toLowerCase();
      if (a === usdg) return 1;
      if (isEther(a)) return ethUsd;
      // The pool's price is the TRADED side's. In a pool of two tokens with
      // neither dollar nor ether, the other side has no price here — unknown,
      // not the traded token's price borrowed.
      return a === traded ? pool.priceUsd : 0;
    };
    let p0 = priceOf(pool.token0);
    let p1 = priceOf(pool.token1);
    const quoteToday = (address: string) => address.toLowerCase() === usdg || (isEther(address) && liveEth !== null);
    let pricedToday = false;
    if (now && now.sqrtPriceX96 > 0n) {
      const ratio = (Number(now.sqrtPriceX96) / 2 ** 96) ** 2 * 10 ** (pool.d0 - pool.d1);
      if (Number.isFinite(ratio) && ratio > 0) {
        if (tokenFirst && quoteToday(pool.token1)) {
          p0 = ratio * p1;
          pricedToday = true;
        } else if (!tokenFirst && quoteToday(pool.token0)) {
          p1 = p0 / ratio;
          pricedToday = true;
        }
      }
    }
    return { tokenFirst, p0, p1, pricedToday };
  };

  for (const entry of entries) {
    const pool = entry.pool;
    // Today's price when the chain answered for the pool, else the indexer's.
    const now = live.get(pool.id);
    const sqrt = now?.sqrtPriceX96 ?? pool.sqrt;
    const tick = now?.tick ?? pool.tick;
    const { tokenFirst, p0, p1, pricedToday } = pricesFor(pool, now);
    if (pricedToday) todayCount += 1;
    const priced = sqrt > 0n;
    const amounts = priced
      ? amountsForLiquidity({ sqrtPriceX96: sqrt, tickLower: entry.tickLower, tickUpper: entry.tickUpper, liquidityDelta: entry.liquidity })
      : { amount0: 0n, amount1: 0n };
    const valueUsd = priced ? human(amounts.amount0, pool.d0) * p0 + human(amounts.amount1, pool.d1) * p1 : 0;
    // What the principal would be worth held, at the same prices. Unknown
    // when the indexer's record does not describe this position as it is now.
    const holdUsd = entry.deposited
      ? priced
        ? human(entry.deposited.d0, pool.d0) * p0 + human(entry.deposited.d1, pool.d1) * p1
        : 0
      : null;
    const inRange = priced && tick >= entry.tickLower && tick < entry.tickUpper;
    // No price for the pool, or no dollar price for one of its sides: the
    // figures above are zero because they are unknown, and say so.
    const valueUnknown = !priced || !(p0 > 0) || !(p1 > 0);

    // The range as the builder describes it: around the token's price, so a
    // currency1 token's range is the pool's mirrored (lib/v4/mint.ts).
    const full = entry.tickLower <= minUsableTick(pool.tickSpacing) && entry.tickUpper >= maxUsableTick(pool.tickSpacing);
    const pct = (ticks: number) => (1.0001 ** ticks - 1) * 100;
    const range = full
      ? ('full' as const)
      : tokenFirst
        ? { minPct: pct(entry.tickLower - tick), maxPct: pct(entry.tickUpper - tick) }
        : { minPct: pct(tick - entry.tickUpper), maxPct: pct(tick - entry.tickLower) };

    // How long it has been out of range — from the indexer's swaps, so only
    // when the status itself is the indexer's. Measured against a live tick,
    // a date from the backfill would be weeks wrong.
    let outOfRangeSinceHours: number | undefined;
    if (priced && !inRange && !now && pool.indexed) {
      const [last] = await prisma.$queryRaw<{ at: Date | null }[]>`
        SELECT MAX(block_time) AS at FROM swap_events
        WHERE pool_id = ${pool.id} AND tick >= ${entry.tickLower} AND tick < ${entry.tickUpper}
      `;
      const since = last?.at ?? entry.mintedAt;
      if (since) outOfRangeSinceHours = Math.max(0, (asOf.getTime() - new Date(since).getTime()) / 3_600_000);
    }

    const tokenAddress = tokenFirst ? pool.token0 : pool.token1;
    const quoteAddress = tokenFirst ? pool.token1 : pool.token0;
    const quote: Quote = quoteAddress.toLowerCase() === usdg ? 'USDG' : 'ETH';
    const livePosition: LivePosition = {
      key: {
        currency0: pool.token0,
        currency1: pool.token1,
        fee: pool.feeTier,
        tickSpacing: pool.tickSpacing,
        hooks: pool.hooks,
        decimals0: pool.d0,
        decimals1: pool.d1,
      },
      poolAddress: pool.address,
      protocol: pool.protocol,
      feeTierBps: feeTierBpsFromPips(pool.protocol, pool.feeTier),
      token: {
        address: tokenAddress,
        symbol: tokenFirst ? pool.s0 : pool.s1,
        name: tokenFirst ? pool.n0 : pool.n1,
        decimals: tokenFirst ? pool.d0 : pool.d1,
        logoColor: (tokenFirst ? pool.c0 : pool.c1) ?? 'var(--fg-3)',
        logoUrl: (tokenFirst ? pool.l0 : pool.l1) ?? undefined,
      },
      quote,
      quoteAddress,
      quoteDecimals: tokenFirst ? pool.d1 : pool.d0,
      tokenIsCurrency0: tokenFirst,
      tickLower: entry.tickLower,
      tickUpper: entry.tickUpper,
      liquidity: entry.liquidity.toString(),
      amount0: amounts.amount0.toString(),
      amount1: amounts.amount1.toString(),
      holdUsd,
      priceUsd0: p0,
      priceUsd1: p1,
      collectedFees0: entry.collected ? entry.collected.c0.toString() : null,
      collectedFees1: entry.collected ? entry.collected.c1.toString() : null,
      mintedAt: entry.mintedAt ? new Date(entry.mintedAt).toISOString() : null,
      verified: entry.verified,
      unindexedPool: !pool.indexed,
    };

    positions.push({
      tokenId: entry.tokenId,
      poolId: pool.id,
      rangePct: range === 'full' ? 100 : Math.round(Math.max(Math.abs(range.minPct), Math.abs(range.maxPct))),
      range,
      inRange,
      outOfRangeSinceHours,
      ...(priced ? {} : { rangeUnknown: true }),
      ...(valueUnknown ? { valueUnknown: true } : {}),
      valueUsd,
      // Unknown principal, or an unknown value: no figure, rather than a
      // difference of two numbers one of which is not real.
      priceImpactUsd: holdUsd === null || valueUnknown ? undefined : valueUsd - holdUsd,
      live: livePosition,
    });
  }

  // v3 positions this wallet withdrew (the browser names them, with the pool
  // each was in). Read from their own logs with a net liquidity of zero, so
  // what is listed as closed is closed; and checked against the receipts —
  // the pool the mint went into, and a transaction this wallet sent — so a
  // position is never valued in the wrong pool, or claimed for a wallet that
  // did not hold it.
  const closedPositions = async (): Promise<ClosedPosition[]> => {
    const wanted = options.v3Closed;
    if (!chain || !wanted || closedIds.length === 0) return [];
    // A position the chain says is open is not closed, whatever the browser remembers.
    const open = new Set(positions.filter((p) => p.live?.protocol === 'v3').map((p) => p.tokenId));
    const ids = closedIds.filter((id) => !open.has(id));
    if (ids.length === 0) return [];
    const histories = await closedHistories;
    const metas = await poolsById([...new Set(ids.map((id) => wanted.get(id)!))]);
    const unread = [...metas.values()].filter((m) => m.protocol === 'v3' && !live.has(m.id));
    const extra =
      unread.length > 0
        ? await chain
            .slot0s(
              unread.map((m) => ({
                id: m.id,
                protocol: m.protocol,
                address: m.address,
                key: { currency0: m.token0 as Address, currency1: m.token1 as Address, fee: m.feeTier, tickSpacing: m.tickSpacing, hooks: m.hooks as Address },
              })),
            )
            .catch(() => new Map<string, { sqrtPriceX96: bigint; tick: number }>())
        : new Map<string, { sqrtPriceX96: bigint; tick: number }>();
    const out: ClosedPosition[] = [];
    for (const id of ids) {
      const h = histories.get(id);
      const pool = metas.get(wanted.get(id)!);
      if (!h || !pool || pool.protocol !== 'v3') continue;
      if (!h.pools.includes(pool.address.toLowerCase()) || !h.senders.includes(owner)) continue;
      const { tokenFirst, p0, p1 } = pricesFor(pool, live.get(pool.id) ?? extra.get(pool.id));
      if (!(p0 > 0) || !(p1 > 0)) continue;
      const usd = (a0: bigint, a1: bigint) => human(a0, pool.d0) * p0 + human(a1, pool.d1) * p1;
      const depositedUsd = usd(h.in0, h.in1);
      const withdrawnUsd = usd(h.out0, h.out1);
      const quoteAddress = tokenFirst ? pool.token1 : pool.token0;
      out.push({
        tokenId: id,
        poolId: pool.id,
        protocol: 'v3',
        token: {
          address: tokenFirst ? pool.token0 : pool.token1,
          symbol: tokenFirst ? pool.s0 : pool.s1,
          logoColor: (tokenFirst ? pool.c0 : pool.c1) ?? 'var(--fg-3)',
          logoUrl: (tokenFirst ? pool.l0 : pool.l1) ?? undefined,
        },
        quote: quoteAddress.toLowerCase() === usdg ? 'USDG' : 'ETH',
        tokenIsCurrency0: tokenFirst,
        decimals0: pool.d0,
        decimals1: pool.d1,
        priceUsd0: p0,
        priceUsd1: p1,
        in0: h.in0.toString(),
        in1: h.in1.toString(),
        out0: h.out0.toString(),
        out1: h.out1.toString(),
        fees0: h.collectedFees0.toString(),
        fees1: h.collectedFees1.toString(),
        depositedUsd,
        withdrawnUsd,
        feesUsd: usd(h.collectedFees0, h.collectedFees1),
        priceImpactUsd: withdrawnUsd - depositedUsd,
        feesComplete: h.collectedKnown,
        mintedAt: h.mintedAt ? h.mintedAt.toISOString() : null,
      });
    }
    return out;
  };
  const closed = await closedPositions();

  return {
    wallet: owner,
    asOf: asOf.toISOString(),
    positions,
    ...(closed.length > 0 ? { closed } : {}),
    netValueUsd: positions.reduce((a, p) => a + (p.valueUnknown ? 0 : p.valueUsd), 0),
    priceImpactUsd: positions.reduce((a, p) => a + (p.priceImpactUsd ?? 0), 0),
    pricedToday: positions.length > 0 && todayCount === positions.length,
    chain: chainStatus,
  };
}
