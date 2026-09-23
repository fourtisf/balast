/**
 * What a Uniswap v3 pool holds right now, read from the chain.
 *
 * The fee yield on the board divides the fees a pool took in the last 24
 * hours — the head reader's, current (§25) — by the pool's liquidity. That
 * liquidity was the indexer's, as of its last block: 74 days ago on the box.
 * Today's fees over July's liquidity produced `1897%` for VIRTUAL/ETH, a
 * figure whose top and bottom were measured two months apart and which
 * therefore meant nothing.
 *
 * A v3 pool is its own contract and holds its own tokens, so its reserves now
 * are two `balanceOf` calls — the chain's own answer, as current as the fees.
 * The balance includes fees not yet collected, as Uniswap's own analytics
 * count it; that makes the yield a shade conservative, never flattering. A v4
 * pool holds nothing of its own (the PoolManager holds every pool's tokens
 * together), so it has no such reading and the snapshot looks elsewhere.
 *
 * One multicall a minute over the listed v3 pools. A pool the node did not
 * answer for has no reading, never a zero.
 */

import { parseAbi, type Address } from 'viem';
import { CONTRACTS } from '../../lib/chain';
import { rpc } from '../chain/client';

export const RESERVES_REFRESH_MS = 60_000;
/** A reading older than this is not "now" and is not used. */
export const RESERVES_MAX_AGE_MS = 5 * 60_000;
const MAX_POOLS = 600;

const ERC20 = parseAbi(['function balanceOf(address) view returns (uint256)']);

export interface PoolRef {
  id: string;
  /** The v3 pool contract. */
  address: string;
  token0: string;
  token1: string;
}

export interface Reserves {
  amount0: bigint;
  amount1: bigint;
  /** Unix milliseconds of the read. */
  at: number;
}

export type ReservesReader = (pools: PoolRef[]) => Promise<Map<string, { amount0: bigint; amount1: bigint }>>;

/** The chain's reader: two balances per pool, in one multicall. */
export const chainReservesReader: ReservesReader = (pools) =>
  rpc(async (c) => {
    const results = await c.multicall({
      contracts: pools.flatMap((p) => [
        { address: p.token0 as Address, abi: ERC20, functionName: 'balanceOf' as const, args: [p.address as Address] as const },
        { address: p.token1 as Address, abi: ERC20, functionName: 'balanceOf' as const, args: [p.address as Address] as const },
      ]),
      allowFailure: true,
      multicallAddress: CONTRACTS.multicall3 as Address,
    });
    const out = new Map<string, { amount0: bigint; amount1: bigint }>();
    pools.forEach((p, i) => {
      const [a, b] = [results[2 * i], results[2 * i + 1]];
      if (a.status === 'success' && b.status === 'success') out.set(p.id, { amount0: a.result as bigint, amount1: b.result as bigint });
    });
    return out;
  }, 'pool reserves');

export class LiveReserves {
  private pools: PoolRef[] = [];
  private readings = new Map<string, Reserves>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastError: string | null = null;
  private lastReadAt: number | null = null;
  private running = false;

  constructor(
    private readonly options: {
      read?: ReservesReader;
      now?: () => number;
      log?: (line: string) => void;
      /**
       * Called after a read that produced readings, so the snapshot can be
       * rebuilt with them. Without it the first reading waited for some other
       * rebuild to be used at all.
       */
      onUpdate?: () => void;
    } = {},
  ) {}

  /** The v3 pools the snapshot lists; the next refresh reads these. */
  follow(pools: PoolRef[]): void {
    const first = this.pools.length === 0 && pools.length > 0;
    this.pools = pools.slice(0, MAX_POOLS);
    if (first) void this.refresh();
  }

  start(intervalMs = RESERVES_REFRESH_MS): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.refresh(), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async refresh(): Promise<void> {
    if (this.running || this.pools.length === 0) return;
    this.running = true;
    try {
      const now = (this.options.now ?? Date.now)();
      const read = await (this.options.read ?? chainReservesReader)(this.pools);
      for (const [id, r] of read) this.readings.set(id, { ...r, at: now });
      this.lastReadAt = now;
      if (this.lastError) this.options.log?.('pool reserves: recovered');
      this.lastError = null;
      if (read.size > 0) this.options.onUpdate?.();
    } catch (e) {
      const reason = (e as Error).message.split('\n')[0].slice(0, 200);
      if (reason !== this.lastError) this.options.log?.(`pool reserves: ${reason}`);
      this.lastError = reason;
    } finally {
      this.running = false;
    }
  }

  /** The pool's reserves, when read recently enough to be called now. */
  get(id: string): Reserves | null {
    const r = this.readings.get(id);
    if (!r) return null;
    return (this.options.now ?? Date.now)() - r.at <= RESERVES_MAX_AGE_MS ? r : null;
  }

  status(): { pools: number; read: number; lastReadAt: string | null; lastError: string | null } {
    return {
      pools: this.pools.length,
      read: this.readings.size,
      lastReadAt: this.lastReadAt === null ? null : new Date(this.lastReadAt).toISOString(),
      lastError: this.lastError,
    };
  }
}
