import { describe, expect, it } from 'vitest';
import type { Address, PublicClient } from 'viem';
import { CONTRACTS } from '../chain';
import { poolId, type PoolKey } from './pool';
import { decodePositionInfo, readOwners, readV4Positions } from './positions';

const OWNER = '0x0000000000000000000000000000000000000b0b' as Address;
const OTHER = '0x0000000000000000000000000000000000000c0c' as Address;
const KEY: PoolKey = {
  currency0: '0x0000000000000000000000000000000000000000',
  currency1: '0x2222222222222222222222222222222222222222',
  fee: 3000,
  tickSpacing: 60,
  hooks: '0x0000000000000000000000000000000000000000',
};

/** PositionInfoLibrary's layout, built the other way round: prefix | tickUpper | tickLower | subscriber. */
function pack(key: PoolKey, tickLower: number, tickUpper: number, subscriber = 0): bigint {
  const prefix = (BigInt(poolId(key)) >> 56n) << 56n;
  return prefix | (BigInt.asUintN(24, BigInt(tickUpper)) << 32n) | (BigInt.asUintN(24, BigInt(tickLower)) << 8n) | BigInt(subscriber);
}

describe('decodePositionInfo', () => {
  it('reads negative and positive ticks, the subscriber flag and the pool-id prefix', () => {
    const info = pack(KEY, -887_220, 120, 1);
    const d = decodePositionInfo(info);
    expect(d.tickLower).toBe(-887_220);
    expect(d.tickUpper).toBe(120);
    expect(d.hasSubscriber).toBe(true);
    expect(d.poolIdPrefix).toBe(poolId(KEY).slice(0, 52));
    expect(decodePositionInfo(pack(KEY, -60, -1)).tickUpper).toBe(-1);
  });
});

interface Token {
  owner?: Address;
  key?: PoolKey;
  info?: bigint;
  liquidity?: bigint;
  /** What StateView answers for the decoded range. */
  poolRecord?: bigint;
}

/** A multicall that answers from a table, the way PositionManager and StateView would. */
function fakeClient(tokens: Map<bigint, Token>): Pick<PublicClient, 'multicall'> {
  return {
    multicall: (async ({ contracts }: { contracts: { functionName: string; args: readonly unknown[]; address: string }[] }) =>
      contracts.map((c) => {
        const fail = { status: 'failure' as const, error: new Error('revert') };
        if (c.functionName === 'getPositionInfo') {
          expect(c.address).toBe(CONTRACTS.stateView);
          const salt = BigInt(c.args[4] as string);
          const t = tokens.get(salt);
          return t?.poolRecord === undefined ? fail : { status: 'success' as const, result: [t.poolRecord, 0n, 0n] };
        }
        const t = tokens.get(c.args[0] as bigint);
        if (!t?.owner) return fail; // burned: every read reverts
        if (c.functionName === 'ownerOf') return { status: 'success' as const, result: t.owner };
        if (c.functionName === 'getPoolAndPositionInfo') return { status: 'success' as const, result: [t.key, t.info] };
        if (c.functionName === 'getPositionLiquidity') return { status: 'success' as const, result: t.liquidity };
        return fail;
      })) as unknown as PublicClient['multicall'],
  };
}

describe('readV4Positions', () => {
  it('shows only what the chain confirms this wallet holds, with liquidity, at a range the pool itself confirms', async () => {
    const good = { owner: OWNER, key: KEY, info: pack(KEY, -600, 600), liquidity: 1000n, poolRecord: 1000n };
    const tokens = new Map<bigint, Token>([
      [1n, good],
      [2n, { ...good, owner: OTHER }], // sent away
      [3n, {}], // burned
      [4n, { ...good, liquidity: 0n, poolRecord: 0n }], // emptied
      [5n, { ...good, poolRecord: 0n }], // the pool does not know this range: a wrong decode
      [6n, { ...good, info: pack({ ...KEY, fee: 500 }, -600, 600) }], // prefix of another pool
    ]);
    const read = await readV4Positions(fakeClient(tokens), OWNER, [1n, 2n, 3n, 4n, 5n, 6n, 1n]);
    expect(read.positions.map((p) => p.tokenId)).toEqual([1n]);
    expect(read.positions[0]).toMatchObject({ tickLower: -600, tickUpper: 600, liquidity: 1000n });
    expect(read.unconfirmed).toBe(2);
  });
});

describe('readOwners', () => {
  it('maps every live id in the window to its holder, lowercase, and leaves burned ones out', async () => {
    const tokens = new Map<bigint, Token>([
      [10n, { owner: '0x00000000000000000000000000000000000000AA' as Address }],
      [12n, { owner: OWNER }],
    ]);
    const owners = await readOwners(fakeClient(tokens), 10n, 13n);
    expect([...owners.entries()]).toEqual([
      [10n, '0x00000000000000000000000000000000000000aa'],
      [12n, OWNER.toLowerCase()],
    ]);
  });
});
