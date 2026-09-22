/**
 * Logs to typed events, and the pool identity scheme.
 *
 * Decoding is separated from ingesting on purpose. A decoded event is a plain
 * value with no clock, no database and no network in it, so the ingest step
 * below it is a pure function of an ordered list — which is the only reason
 * §9's "byte-identical replay" is provable rather than hoped for.
 */

import { decodeEventLog, toHex, type Log } from 'viem';
import { POOL_MANAGER_ABI, POSITION_MANAGER_EVENTS_ABI, V3_FACTORY_ABI, V3_POOL_ABI } from '../chain/abi';

export type Protocol = 'v4' | 'v3';

/**
 * A pool's identity, stable across replays.
 *
 * v4 has one contract for every pool, so the bytes32 pool id is the identity.
 * v3 has one contract per pool, so the address is. Prefixing keeps the two
 * namespaces from ever colliding in a table that holds both.
 */
export function poolKey(protocol: Protocol, identifier: string): string {
  return `${protocol}:${identifier.toLowerCase()}`;
}

export interface EventPosition {
  txHash: string;
  logIndex: number;
  blockNumber: bigint;
  blockTime: Date;
}

export interface InitializeEvent extends EventPosition {
  kind: 'initialize';
  poolId: string;
  protocol: Protocol;
  /** The pool's own address for v3; the PoolManager's for v4. */
  contract: string;
  currency0: string;
  currency1: string;
  feePips: number;
  tickSpacing: number;
  hooks: string | null;
  sqrtPriceX96: bigint;
  tick: number;
}

export interface SwapEventDecoded extends EventPosition {
  kind: 'swap';
  poolId: string;
  /** Pool-perspective and signed: positive entered the pool. */
  amount0: bigint;
  amount1: bigint;
  sqrtPriceX96: bigint;
  liquidity: bigint;
  tick: number;
  /**
   * Fee actually charged on this swap, in hundredths of a bip. v4 emits it,
   * so a dynamic-fee hook is attributed at what it charged; for v3 it is the
   * pool's immutable tier, filled in from the pool row.
   */
  feePips: number | null;
  sender: string;
}

export interface LiquidityEventDecoded extends EventPosition {
  kind: 'liquidity';
  poolId: string;
  tickLower: number;
  tickUpper: number;
  /** Signed: negative is a burn. */
  liquidityDelta: bigint;
  /**
   * v3 Mint/Burn carry the token amounts; v4 ModifyLiquidity does not, and
   * they are computed at ingest from the pool's price at this log's position.
   */
  amount0: bigint | null;
  amount1: bigint | null;
  owner: string;
  /**
   * v4's position salt, lowercase hex. PositionManager mints with
   * `salt = bytes32(tokenId)`, which is what ties a position NFT to its own
   * liquidity events (§22). Null for v3, which has no such thing.
   */
  salt: string | null;
}

/**
 * A PositionManager Transfer: the position token moved, or was minted (from
 * the zero address) or burned (to it). Not a pool event — it carries no pool
 * id; the position's pool comes from the liquidity event with the same salt.
 */
export interface PositionTransferEvent extends EventPosition {
  kind: 'position-transfer';
  tokenId: bigint;
  /** bytes32(tokenId), lowercase: joins to `LiquidityEventDecoded.salt`. */
  salt: string;
  from: string;
  to: string;
}

export type PoolEvent = InitializeEvent | SwapEventDecoded | LiquidityEventDecoded;
export type ChainEvent = PoolEvent | PositionTransferEvent;

export function isPoolEvent(event: ChainEvent): event is PoolEvent {
  return event.kind !== 'position-transfer';
}

/** The salt PositionManager gives a token's liquidity: the id as 32 bytes. */
export function saltForTokenId(tokenId: bigint): string {
  return toHex(tokenId, { size: 32 }).toLowerCase();
}

/**
 * Total order over the log stream: block, then position in the block.
 *
 * Every piece of carried state in the ingest step is a function of the prefix
 * under this order, which is what makes a re-run from block zero and an
 * incremental run produce the same rows.
 */
export function compareEvents(a: EventPosition, b: EventPosition): number {
  if (a.blockNumber !== b.blockNumber) return a.blockNumber < b.blockNumber ? -1 : 1;
  return a.logIndex - b.logIndex;
}

export function sortEvents<T extends EventPosition>(events: T[]): T[] {
  return [...events].sort(compareEvents);
}

interface RawLog extends Log {
  blockNumber: bigint;
  logIndex: number;
  transactionHash: `0x${string}`;
}

function position(log: RawLog, blockTime: Date): EventPosition {
  return {
    txHash: log.transactionHash.toLowerCase(),
    logIndex: log.logIndex,
    blockNumber: log.blockNumber,
    blockTime,
  };
}

/**
 * Decode one PoolManager log (§4: Initialize, Swap, ModifyLiquidity).
 * Returns null for anything else the contract emits — decoding is not the
 * place to decide what matters.
 */
export function decodePoolManagerLog(log: RawLog, blockTime: Date): ChainEvent | null {
  let decoded;
  try {
    decoded = decodeEventLog({ abi: POOL_MANAGER_ABI, data: log.data, topics: log.topics });
  } catch {
    return null;
  }
  const at = position(log, blockTime);
  const args = decoded.args as Record<string, unknown>;
  const poolId = poolKey('v4', args.id as string);

  switch (decoded.eventName) {
    case 'Initialize':
      return {
        kind: 'initialize',
        ...at,
        poolId,
        protocol: 'v4',
        contract: log.address.toLowerCase(),
        currency0: (args.currency0 as string).toLowerCase(),
        currency1: (args.currency1 as string).toLowerCase(),
        feePips: Number(args.fee),
        tickSpacing: Number(args.tickSpacing),
        hooks: (args.hooks as string).toLowerCase(),
        sqrtPriceX96: args.sqrtPriceX96 as bigint,
        tick: Number(args.tick),
      };
    case 'Swap':
      return {
        kind: 'swap',
        ...at,
        poolId,
        // v4 emits the TRADER's deltas — the input negative, the output
        // positive (Pool.sol: `amountSpecified - amountSpecifiedRemaining` is
        // the negative exact-input, `amountCalculated` the positive output).
        // v3 emits the pool's. Everything downstream — reserves summed from
        // the rows, the side the fee was taken in, volume — reads the pool's
        // signs, so v4 is negated here and there is one convention in the
        // tables. Stored as emitted, every traded v4 pool's reserves fell
        // with its volume, and the board read "liquidity —" on exactly the
        // pools that trade.
        amount0: -(args.amount0 as bigint),
        amount1: -(args.amount1 as bigint),
        sqrtPriceX96: args.sqrtPriceX96 as bigint,
        liquidity: args.liquidity as bigint,
        tick: Number(args.tick),
        feePips: Number(args.fee),
        sender: (args.sender as string).toLowerCase(),
      };
    case 'ModifyLiquidity':
      return {
        kind: 'liquidity',
        ...at,
        poolId,
        tickLower: Number(args.tickLower),
        tickUpper: Number(args.tickUpper),
        liquidityDelta: args.liquidityDelta as bigint,
        // Computed at ingest: v4 does not emit them.
        amount0: null,
        amount1: null,
        owner: (args.sender as string).toLowerCase(),
        salt: (args.salt as string).toLowerCase(),
      };
    default:
      return null;
  }
}

/**
 * Decode one PositionManager log: its ERC-721 Transfer, and nothing else.
 * An ERC-20 Transfer has the same selector and three topics rather than
 * four; it does not decode against this ABI and is ignored.
 */
export function decodePositionManagerLog(log: RawLog, blockTime: Date): PositionTransferEvent | null {
  let decoded;
  try {
    decoded = decodeEventLog({ abi: POSITION_MANAGER_EVENTS_ABI, data: log.data, topics: log.topics });
  } catch {
    return null;
  }
  if (decoded.eventName !== 'Transfer') return null;
  const args = decoded.args as Record<string, unknown>;
  const tokenId = args.id as bigint;
  return {
    kind: 'position-transfer',
    ...position(log, blockTime),
    tokenId,
    salt: saltForTokenId(tokenId),
    from: (args.from as string).toLowerCase(),
    to: (args.to as string).toLowerCase(),
  };
}

/**
 * Decode a v3 factory `PoolCreated`.
 *
 * v4 announces a pool with `Initialize` on the one PoolManager. v3 announces
 * it on its factory and then emits everything else from the pool's own
 * address — so a v3 pool is only discoverable through this event, and without
 * it every v3 pool has to be listed by hand. §4 says some older pools on this
 * chain are v3, so that hand-list would silently omit real pools.
 *
 * `PoolCreated` carries no initial price, so the pool is registered with
 * sqrtPrice 0 and priced from its first swap.
 */
export function decodeV3FactoryLog(log: RawLog, blockTime: Date): InitializeEvent | null {
  let decoded;
  try {
    decoded = decodeEventLog({ abi: V3_FACTORY_ABI, data: log.data, topics: log.topics });
  } catch {
    return null;
  }
  if (decoded.eventName !== 'PoolCreated') return null;
  const args = decoded.args as Record<string, unknown>;
  const poolAddress = (args.pool as string).toLowerCase();

  return {
    kind: 'initialize',
    ...position(log, blockTime),
    poolId: poolKey('v3', poolAddress),
    protocol: 'v3',
    contract: poolAddress,
    currency0: (args.token0 as string).toLowerCase(),
    currency1: (args.token1 as string).toLowerCase(),
    feePips: Number(args.fee),
    tickSpacing: Number(args.tickSpacing),
    // v3 has no hooks. Null rather than the zero address, so `launchpadFor`
    // cannot mistake it for an unrecognised hook.
    hooks: null,
    // Unknown until the pool's first swap. Zero reads as "not yet priced"
    // everywhere downstream, which is the honest state.
    sqrtPriceX96: 0n,
    tick: 0,
  };
}

/**
 * Decode one v3 pool log. The emitting address is the pool, and v3 has no fee
 * field on the event, so `feePips` is left null for the ingest step to fill
 * from the pool's tier.
 */
export function decodeV3PoolLog(log: RawLog, blockTime: Date): ChainEvent | null {
  let decoded;
  try {
    decoded = decodeEventLog({ abi: V3_POOL_ABI, data: log.data, topics: log.topics });
  } catch {
    return null;
  }
  const at = position(log, blockTime);
  const args = decoded.args as Record<string, unknown>;
  const poolId = poolKey('v3', log.address);

  switch (decoded.eventName) {
    case 'Swap':
      return {
        kind: 'swap',
        ...at,
        poolId,
        amount0: args.amount0 as bigint,
        amount1: args.amount1 as bigint,
        sqrtPriceX96: args.sqrtPriceX96 as bigint,
        liquidity: args.liquidity as bigint,
        tick: Number(args.tick),
        feePips: null,
        sender: (args.sender as string).toLowerCase(),
      };
    case 'Mint':
      return {
        kind: 'liquidity',
        ...at,
        poolId,
        tickLower: Number(args.tickLower),
        tickUpper: Number(args.tickUpper),
        liquidityDelta: args.amount as bigint,
        amount0: args.amount0 as bigint,
        amount1: args.amount1 as bigint,
        owner: (args.owner as string).toLowerCase(),
        salt: null,
      };
    case 'Burn':
      return {
        kind: 'liquidity',
        ...at,
        poolId,
        tickLower: Number(args.tickLower),
        tickUpper: Number(args.tickUpper),
        // A burn removes liquidity and returns tokens: every figure negative,
        // so summing the column gives reserves without a special case.
        liquidityDelta: -(args.amount as bigint),
        amount0: -(args.amount0 as bigint),
        amount1: -(args.amount1 as bigint),
        owner: (args.owner as string).toLowerCase(),
        salt: null,
      };
    default:
      return null;
  }
}
