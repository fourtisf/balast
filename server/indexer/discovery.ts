/**
 * Token and pool discovery.
 *
 * §4 draws a hard line: numbers come from chain events, but logos and token
 * metadata may come from elsewhere. Symbol, name and decimals are read from
 * the token contract — on-chain, and the only place a string the site displays
 * comes from outside our own tables.
 */

import { Prisma } from '@prisma/client';
import { getAddress } from 'viem';
import { CHAIN, CONTRACTS, NATIVE_ETH, etherCurrencies } from '../../lib/chain';
import { tokenMark } from '../../lib/token-mark';
import { ERC20_ABI } from '../chain/abi';
import { rpc } from '../chain/client';
import { prisma } from '../db';

/**
 * Hook addresses belonging to launchpads (§4: Pons, Bags, Bottom.fun).
 *
 * A pool whose hook is one of these is pre-graduation: index it for the
 * listing, but never offer it as a stake. The addresses are configuration
 * because they are not in the handoff and inventing them would silently mark
 * real pools unstakeable, or worse, mark launchpad pools stakeable.
 *
 *   LAUNCHPAD_HOOKS=Pons:0xabc…,Bags:0xdef…,Bottom.fun:0x123…
 *
 * With none configured every pool is stakeable, which is the conservative
 * direction for a listing and the wrong direction for a vault — so P2 must
 * not deploy a vault against a pool discovered while this was empty.
 */
function parseLaunchpadHooks(): Map<string, string> {
  const raw = process.env.LAUNCHPAD_HOOKS;
  const map = new Map<string, string>();
  if (!raw) return map;
  for (const entry of raw.split(',')) {
    const [name, address] = entry.split(':').map((s) => s?.trim());
    if (!name || !address || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
      throw new Error(`LAUNCHPAD_HOOKS entry is malformed: ${JSON.stringify(entry)}`);
    }
    map.set(address.toLowerCase(), name);
  }
  return map;
}

export const LAUNCHPAD_HOOKS = parseLaunchpadHooks();

const ZERO_HOOK = '0x0000000000000000000000000000000000000000';

/** Which launchpad a pool's hook belongs to, if any. */
export function launchpadFor(hooks: string | null): string | null {
  if (!hooks || hooks.toLowerCase() === ZERO_HOOK) return null;
  return LAUNCHPAD_HOOKS.get(hooks.toLowerCase()) ?? null;
}

/**
 * Pre-graduation launchpad liquidity is listed but not stakeable (§4).
 * A pool with no hook, or a hook we do not recognise, is stakeable.
 */
export function isStakeable(hooks: string | null): boolean {
  return launchpadFor(hooks) === null;
}

/**
 * Deterministic badge colour for a token, so a row's badge is stable across
 * reloads without needing a logo service in the critical path.
 *
 * Shares `lib/token-mark.ts` with the client rather than hashing separately:
 * the saturation and lightness there were measured to keep the monogram
 * legible on every hue, and a second implementation would drift off that
 * guarantee without anything failing. It also means a token looks the same
 * whether the colour came from the indexer or was derived in the browser.
 */
export function brandColor(address: string): string {
  return tokenMark(address).bg;
}

export interface TokenFacts {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  /**
   * `totalSupply()`, in the token's smallest units, or null if the contract
   * did not answer.
   *
   * TOTAL, not circulating — locked, vested and treasury-held tokens are all
   * in it and none of that is distinguishable on chain. What it produces is
   * fully diluted value, which is why it is labelled that way rather than
   * called market cap (§7).
   */
  totalSupply?: bigint | null;
  /**
   * Tokens that cannot circulate, in the smallest units: the balances of the
   * burn addresses and of the token contract itself. Total supply less this
   * is what the market cap is computed from. Null when the supply is null;
   * a balance that could not be read counts as zero, which errs toward the
   * fully diluted figure rather than inventing a burn.
   */
  nonCirculating?: bigint | null;
}

/** Where burned tokens sit: the zero address and the conventional dead address. */
export const BURN_ADDRESSES = [
  '0x0000000000000000000000000000000000000000',
  '0x000000000000000000000000000000000000dEaD',
] as const;

/** The holders whose balances cannot circulate: the burn addresses and the token itself. */
function nonCirculatingHolders(token: `0x${string}`): `0x${string}`[] {
  return [...BURN_ADDRESSES, token];
}

/** Sum of the balances that were read; one that was not counts as zero. */
function sumHeld(values: unknown[]): bigint {
  return values.reduce<bigint>((acc, v) => (typeof v === 'bigint' ? acc + v : acc), 0n);
}

/**
 * Read a token's metadata from its own contract.
 *
 * A token that does not answer is recorded under a truncated-address symbol
 * rather than skipped: a pool with an unreadable token still has real fees,
 * and dropping it would understate the chain totals.
 */
export async function readToken(address: string): Promise<TokenFacts> {
  // Native ether has no contract to ask, and asking anyway returns nothing:
  // the symbol falls back to a truncated address, and — worse — the decimals
  // fall back silently to 18, which happens to be right and would hide the
  // omission. A v4 pool trading native ETH is one of the most likely pools on
  // this chain, so it is named rather than left as `0000…0000`.
  //
  // No total supply: ether's is not an ERC20 read, and a fully diluted value
  // for it would be an invented number (§7 — an em dash instead).
  if (address.toLowerCase() === NATIVE_ETH) {
    return {
      address: NATIVE_ETH,
      symbol: CHAIN.nativeCurrency.symbol,
      name: CHAIN.nativeCurrency.name,
      decimals: CHAIN.nativeCurrency.decimals,
      totalSupply: null,
      nonCirculating: null,
    };
  }

  const checksummed = getAddress(address);
  const fallback = `${address.slice(2, 6)}…${address.slice(-4)}`.toUpperCase();

  const read = async <T>(
    functionName: 'symbol' | 'name' | 'decimals' | 'totalSupply',
  ): Promise<T | null> => {
    try {
      return (await rpc(
        (c) => c.readContract({ address: checksummed, abi: ERC20_ABI, functionName }),
        `${functionName}(${address})`,
      )) as T;
    } catch {
      return null;
    }
  };

  const balance = async (holder: `0x${string}`): Promise<bigint | null> => {
    try {
      return (await rpc(
        (c) =>
          c.readContract({ address: checksummed, abi: ERC20_ABI, functionName: 'balanceOf', args: [holder] }),
        `balanceOf(${address})`,
      )) as bigint;
    } catch {
      return null;
    }
  };

  const [symbol, name, decimals, totalSupply, ...held] = await Promise.all([
    read<string>('symbol'),
    read<string>('name'),
    read<number>('decimals'),
    read<bigint>('totalSupply'),
    ...nonCirculatingHolders(checksummed).map(balance),
  ]);
  const supply = typeof totalSupply === 'bigint' && totalSupply > 0n ? totalSupply : null;

  return {
    address: address.toLowerCase(),
    totalSupply: supply,
    nonCirculating: supply === null ? null : sumHeld(held),
    // Trim: a token whose symbol is padded or absurdly long would break the
    // table layout, and the ticker is 14px/700 in a fixed column (§5).
    symbol: (symbol ?? fallback).trim().slice(0, 16) || fallback,
    name: (name ?? 'Unknown token').trim().slice(0, 64) || 'Unknown token',
    decimals: typeof decimals === 'number' && decimals >= 0 && decimals <= 36 ? decimals : 18,
  };
}

/**
 * Put the native ether row right, whatever an earlier version wrote there.
 *
 * Rows in `tokens` are written once and left alone (`ensureTokens`), which
 * is correct for a contract's own facts and wrong for a row that was written
 * by a `readToken` that did not know address(0) is ether: that version
 * recorded `0000…0000 / Unknown token`, and the live site showed exactly that
 * as its most-traded market. The facts here are constants, not reads, so
 * they are asserted on every start rather than fetched once.
 */
export async function repairNativeToken(): Promise<number> {
  const { count } = await prisma.token.updateMany({
    where: { address: NATIVE_ETH },
    data: {
      symbol: CHAIN.nativeCurrency.symbol,
      name: CHAIN.nativeCurrency.name,
      decimals: CHAIN.nativeCurrency.decimals,
      totalSupply: null,
      nonCirculating: null,
    },
  });
  return count;
}

/** How a token's facts are obtained. Injectable for the same reason the log
 *  source is: §9's replay proof needs a chain it can reproduce exactly, token
 *  decimals included — and decimals are an input to every price. */
export type TokenReader = (address: string) => Promise<TokenFacts>;

/**
 * Every missing token's four facts in one Multicall3 round trip per fifty
 * tokens, falling back to one token at a time if the multicall itself fails.
 *
 * A launchpad chain creates dozens of tokens in a 2000-block window, and
 * `readToken` is four RPC calls each; at public-endpoint latency that alone
 * was a large share of a pass. A token whose call reverts (a bytes32 symbol,
 * say) gets the same fallback `readToken` would have given it.
 */
export async function readTokensBatch(addresses: string[]): Promise<TokenFacts[]> {
  const out: TokenFacts[] = [];
  // Four facts and three balances per token: the holdings that cannot
  // circulate are read in the same round trip as the supply they qualify.
  const CALLS = 7;
  const contractsFor = (address: string) => {
    const token = getAddress(address);
    return [
      ...(['symbol', 'name', 'decimals', 'totalSupply'] as const).map((functionName) => ({
        address: token,
        abi: ERC20_ABI,
        functionName,
      })),
      ...nonCirculatingHolders(token).map((holder) => ({
        address: token,
        abi: ERC20_ABI,
        functionName: 'balanceOf' as const,
        args: [holder] as const,
      })),
    ];
  };
  // Seven calls a token: a smaller chunk keeps one multicall a modest eth_call.
  const CHUNK = 25;
  for (let i = 0; i < addresses.length; i += CHUNK) {
    const chunk = addresses.slice(i, i + CHUNK);
    const erc20 = chunk.filter((a) => a.toLowerCase() !== NATIVE_ETH);
    for (const a of chunk) if (a.toLowerCase() === NATIVE_ETH) out.push(await readToken(a));
    if (erc20.length === 0) continue;
    let results: { status: string; result?: unknown }[] | null = null;
    try {
      results = (await rpc(
        (c) =>
          c.multicall({
            contracts: erc20.flatMap(contractsFor),
            allowFailure: true,
            multicallAddress: CONTRACTS.multicall3,
          }),
        `readTokens×${erc20.length}`,
      )) as { status: string; result?: unknown }[];
    } catch {
      results = null;
    }
    if (!results || results.length !== erc20.length * CALLS) {
      for (const a of erc20) out.push(await readToken(a));
      continue;
    }
    erc20.forEach((address, j) => {
      const at = (k: number) =>
        results![j * CALLS + k].status === 'success' ? results![j * CALLS + k].result : null;
      const symbol = at(0) as string | null;
      const name = at(1) as string | null;
      const decimals = at(2) as number | null;
      const totalSupply = at(3) as bigint | null;
      const supply = typeof totalSupply === 'bigint' && totalSupply > 0n ? totalSupply : null;
      const fallback = `${address.slice(2, 6)}…${address.slice(-4)}`.toUpperCase();
      out.push({
        address: address.toLowerCase(),
        totalSupply: supply,
        nonCirculating: supply === null ? null : sumHeld([at(4), at(5), at(6)]),
        symbol: (typeof symbol === 'string' ? symbol : fallback).trim().slice(0, 16) || fallback,
        name: (typeof name === 'string' ? name : 'Unknown token').trim().slice(0, 64) || 'Unknown token',
        decimals: typeof decimals === 'number' && decimals >= 0 && decimals <= 36 ? decimals : 18,
      });
    });
  }
  return out;
}

/** Upsert tokens we have not seen. Existing rows are left alone. */
export async function ensureTokens(
  addresses: Iterable<string>,
  seenAt: Date,
  read?: TokenReader,
): Promise<number> {
  const wanted = [...new Set([...addresses].map((a) => a.toLowerCase()))];
  if (wanted.length === 0) return 0;

  const existing = await prisma.token.findMany({
    where: { address: { in: wanted } },
    select: { address: true },
  });
  const known = new Set(existing.map((t) => t.address.toLowerCase()));
  const missing = wanted.filter((a) => !known.has(a));

  // The chain's own reader goes through Multicall3; an injected one (the
  // test fixture's) is called per token, as before.
  const all = read ? await Promise.all(missing.map((a) => read(a))) : await readTokensBatch(missing);
  for (const facts of all) {
    await prisma.token.upsert({
      where: { address: facts.address },
      create: {
        address: facts.address,
        symbol: facts.symbol,
        name: facts.name,
        decimals: facts.decimals,
        totalSupply: facts.totalSupply ? new Prisma.Decimal(facts.totalSupply.toString()) : null,
        nonCirculating: nonCirculatingOf(facts),
        supplyReadAt: facts.totalSupply ? seenAt : null,
        logoColor: brandColor(facts.address),
        launchpad: null,
        firstSeen: seenAt,
      },
      update: {},
    });
  }
  return missing.length;
}

/**
 * Re-read `totalSupply()` for the tokens whose figure is most stale.
 *
 * Supply is not immutable — a mintable token's changes, and a fully diluted
 * value computed from a stale supply is wrong in the direction that flatters
 * the token. But it is also one RPC call per token, so this refreshes a
 * bounded few per pass rather than all of them, oldest first.
 *
 * A token that stops answering keeps its last known supply and its old
 * timestamp, so the staleness is recorded rather than reset.
 */
export async function refreshSupplies(
  now: Date,
  options: { maxAgeMinutes?: number; limit?: number; read?: TokenReader } = {},
): Promise<number> {
  const maxAge = options.maxAgeMinutes ?? 60;
  const limit = options.limit ?? 50;
  const cutoff = new Date(now.getTime() - maxAge * 60_000);

  // Native ether has no `totalSupply()` and never will, so it would sit at
  // the head of this queue for ever — nulls first — and take one of the
  // slots a pass has, starving the tokens that do answer.
  //
  // Order: tokens whose supply is known but whose non-circulating holdings
  // are not — the backlog a fresh migration leaves — come first, so the
  // board gains a market cap before the rest of the table does; within
  // that, the largest pools' tokens first, which is the board's own order;
  // then the most stale.
  const stale = await prisma.$queryRaw<{ address: string }[]>`
    SELECT t.address
    FROM tokens t
    WHERE t.address <> ${NATIVE_ETH}
      AND (t.supply_read_at IS NULL OR t.supply_read_at < ${cutoff}
           OR (t.total_supply IS NOT NULL AND t.non_circulating IS NULL))
    ORDER BY
      (t.total_supply IS NOT NULL AND t.non_circulating IS NULL) DESC,
      (SELECT MAX(ps.mc_usd) FROM pools p JOIN pool_state ps ON ps.pool_id = p.id
        WHERE lower(p.token0) = t.address OR lower(p.token1) = t.address) DESC NULLS LAST,
      t.supply_read_at ASC NULLS FIRST
    LIMIT ${limit}
  `;
  if (stale.length === 0) return 0;

  // The chain's own reader goes through Multicall3, one round trip per
  // chunk; an injected one (the test fixture's) is called per token.
  const addresses = stale.map((t) => t.address);
  const all = options.read
    ? await Promise.all(addresses.map((a) => options.read!(a)))
    : await readTokensBatch(addresses);

  let updated = 0;
  for (const facts of all) {
    if (!facts.totalSupply) continue;
    await prisma.token.update({
      where: { address: facts.address },
      data: {
        totalSupply: new Prisma.Decimal(facts.totalSupply.toString()),
        nonCirculating: nonCirculatingOf(facts),
        supplyReadAt: now,
      },
    });
    updated++;
  }
  return updated;
}

/** The non-circulating figure as stored: null unless both it and the supply were read. */
function nonCirculatingOf(facts: TokenFacts): Prisma.Decimal | null {
  if (!facts.totalSupply || facts.nonCirculating === null || facts.nonCirculating === undefined) return null;
  return new Prisma.Decimal(facts.nonCirculating.toString());
}

/**
 * Apply the launchpad classification to pools. Separate from the ingest write
 * because it depends on configuration rather than on the log stream, and a
 * re-scan must not undo it.
 */
export async function classifyPools(poolIds?: string[]): Promise<number> {
  // Scoped to the pools given — a pass classifies what it discovered — or
  // every pool when called without: on start, and when LAUNCHPAD_HOOKS may
  // have changed. It used to walk every pool with a query each, every pass.
  if (poolIds && poolIds.length === 0) return 0;
  const pools = await prisma.pool.findMany({
    where: poolIds ? { id: { in: poolIds } } : undefined,
    select: { id: true, hooks: true, token0: true, token1: true },
  });
  let changed = 0;
  for (const pool of pools) {
    const launchpad = launchpadFor(pool.hooks);
    const stakeable = launchpad === null;
    const updated = await prisma.pool.updateMany({
      where: { id: pool.id, stakeable: { not: stakeable } },
      data: { stakeable },
    });
    changed += updated.count;
    if (launchpad) {
      // The launchpad belongs on the token, which is what the row displays.
      await prisma.token.updateMany({
        where: { address: { in: [pool.token0, pool.token1] }, launchpad: null },
        data: { launchpad },
      });
    }
  }
  return changed;
}

/**
 * The WETH/USDG pool, which is the site's one USD anchor (§4.3).
 *
 * Chosen by depth, not by recency: if two WETH/USDG pools exist, the deeper
 * one is the honest anchor. Null when there is none, and every USD figure
 * downstream then reads zero rather than being guessed.
 */
export async function findAnchorPool(usdgAddress: string): Promise<string | null> {
  // Either spelling of ether: a v4 pool holding it natively carries
  // address(0), and on this chain that is the likelier anchor of the two.
  const eth = [...etherCurrencies()];
  const usdg = usdgAddress.toLowerCase();
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT p.id
    FROM pools p
    LEFT JOIN pool_state ps ON ps.pool_id = p.id
    WHERE (lower(p.token0) = ANY(${eth}) AND lower(p.token1) = ${usdg})
       OR (lower(p.token0) = ${usdg} AND lower(p.token1) = ANY(${eth}))
    ORDER BY COALESCE(ps.liquidity, 0) DESC, p.created_block ASC
    LIMIT 1
  `;
  return rows[0]?.id ?? null;
}
