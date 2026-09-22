import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, type PublicClient } from 'viem';
import { CONTRACTS } from '../chain';
import { approvalsNeeded, describeTxError, simulateWrap, waitForMint, WRAP_CALLDATA } from './flow';
import type { PoolKey } from './pool';

const ZERO = '0x0000000000000000000000000000000000000000' as const;
const TOKEN = '0x2222222222222222222222222222222222222222' as const;
const USDG = '0x1111111111111111111111111111111111111111' as const;
const OWNER = '0x000000000000000000000000000000000000dEaD' as const;
const ETH_POOL: PoolKey = { currency0: ZERO, currency1: TOKEN, fee: 3000, tickSpacing: 60, hooks: ZERO };
const ERC20_POOL: PoolKey = { currency0: USDG, currency1: TOKEN, fee: 500, tickSpacing: 10, hooks: ZERO };

/** A fake node: allowances by (token, spender) and Permit2 allowances by (token). */
function fakeClient(state: {
  erc20: Record<string, bigint>;
  permit2: Record<string, [bigint, number]>;
}): PublicClient {
  return {
    readContract: async ({ address, functionName, args }: { address: string; functionName: string; args: readonly unknown[] }) => {
      if (functionName === 'allowance' && address.toLowerCase() === CONTRACTS.permit2.toLowerCase()) {
        const [, token] = args as [string, string, string];
        const [amount, exp] = state.permit2[token.toLowerCase()] ?? [0n, 0];
        return [amount, exp, 0];
      }
      if (functionName === 'allowance') {
        const [, spender] = args as [string, string];
        return state.erc20[`${address.toLowerCase()}:${spender.toLowerCase()}`] ?? 0n;
      }
      throw new Error(`unexpected read ${functionName}`);
    },
  } as unknown as PublicClient;
}

describe('approvalsNeeded', () => {
  it('needs nothing for ether, and both steps for a token never approved', async () => {
    const client = fakeClient({ erc20: {}, permit2: {} });
    const steps = await approvalsNeeded(client, OWNER, ETH_POOL, { amount0Max: 10n ** 18n, amount1Max: 5n }, 1_000);
    expect(steps).toEqual([
      { kind: 'erc20', token: TOKEN },
      { kind: 'permit2', token: TOKEN },
    ]);
  });

  it('skips a side the plan does not touch, and asks again when Permit2\'s allowance has expired', async () => {
    const client = fakeClient({
      erc20: { [`${TOKEN.toLowerCase()}:${CONTRACTS.permit2.toLowerCase()}`]: 2n ** 200n },
      permit2: { [TOKEN.toLowerCase()]: [2n ** 100n, 999] },
    });
    // amount1Max 0: the token side is not used at all.
    expect(await approvalsNeeded(client, OWNER, ETH_POOL, { amount0Max: 1n, amount1Max: 0n }, 1_000)).toEqual([]);
    // Used, ERC20 side fine, Permit2 expired at 999 < now 1000.
    expect(await approvalsNeeded(client, OWNER, ETH_POOL, { amount0Max: 1n, amount1Max: 5n }, 1_000)).toEqual([{ kind: 'permit2', token: TOKEN }]);
  });

  it('checks both sides of a two-token pool, in order', async () => {
    const client = fakeClient({ erc20: {}, permit2: {} });
    const steps = await approvalsNeeded(client, OWNER, ERC20_POOL, { amount0Max: 1n, amount1Max: 1n }, 1_000);
    expect(steps.map((s) => `${s.kind}:${s.token}`)).toEqual([`erc20:${USDG}`, `permit2:${USDG}`, `erc20:${TOKEN}`, `permit2:${TOKEN}`]);
  });
});

describe('waitForMint', () => {
  it('reads the minted token ids off PositionManager\'s Transfer logs, and only those to the owner', async () => {
    const transfer = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
    const pad = (a: string) => encodeAbiParameters([{ type: 'address' }], [a as `0x${string}`]);
    const id = (n: bigint) => encodeAbiParameters([{ type: 'uint256' }], [n]);
    const client = {
      waitForTransactionReceipt: async () => ({
        status: 'success',
        logs: [
          { address: CONTRACTS.positionManager, topics: [transfer, pad(ZERO), pad(OWNER), id(41n)] },
          { address: CONTRACTS.positionManager.toLowerCase(), topics: [transfer, pad(ZERO), pad(OWNER), id(42n)] },
          // Someone else's mint in the same block, and an ERC20 Transfer (three topics): both ignored.
          { address: CONTRACTS.positionManager, topics: [transfer, pad(ZERO), pad(TOKEN), id(43n)] },
          { address: TOKEN, topics: [transfer, pad(OWNER), pad(CONTRACTS.poolManager)] },
        ],
      }),
    } as unknown as PublicClient;
    expect(await waitForMint(client, '0x01', OWNER)).toEqual({ ok: true, tokenIds: [41n, 42n] });
  });
});

describe('describeTxError', () => {
  it('puts the common failures into words', () => {
    expect(describeTxError({ code: 4001 })).toMatch(/declined/);
    expect(describeTxError({ shortMessage: 'insufficient funds for gas * price + value' })).toMatch(/Not enough ETH/);
    expect(describeTxError({ shortMessage: 'execution reverted: MaximumAmountExceeded(1,2)' })).toMatch(/price moved/);
    expect(describeTxError(new Error('something odd'))).toBe('The transaction could not be prepared.');
  });
});

/**
 * Wrapping ether for a market quoted in aeWETH.
 *
 * ALFA's rule is that a pair is entered with this chain's own ether. A pool
 * that holds ether natively already does; one quoted in the wrapper needs
 * the shortfall wrapped first, and that call has to go to the wrapper with
 * the ether as its value — not as an argument, which would wrap nothing and
 * still take the gas.
 */
describe('wrapping ether', () => {
  it('is deposit(), with the amount as the transaction value', async () => {
    // keccak("deposit()")[0..4] — the canonical WETH9 selector.
    expect(WRAP_CALLDATA).toBe('0xd0e30db0');

    let seen: { to?: string; data?: string; value?: bigint; account?: string } = {};
    const client = {
      estimateGas: async (args: { to: string; data: string; value: bigint; account: string }) => {
        seen = args;
        return 40_000n;
      },
    } as unknown as PublicClient;

    const gas = await simulateWrap(client, OWNER, 1_500_000_000_000_000_000n);
    expect(gas).toBe(40_000n);
    expect(seen.to?.toLowerCase()).toBe(CONTRACTS.weth.toLowerCase());
    expect(seen.data).toBe('0xd0e30db0');
    expect(seen.value).toBe(1_500_000_000_000_000_000n);
    expect(seen.account).toBe(OWNER);
  });

  it('surfaces a wrapper that will not take a direct deposit as a revert, not a signature', async () => {
    const client = {
      estimateGas: async () => {
        throw Object.assign(new Error('execution reverted'), { shortMessage: 'execution reverted' });
      },
    } as unknown as PublicClient;
    await expect(simulateWrap(client, OWNER, 1n)).rejects.toThrow(/reverted/);
  });
});
