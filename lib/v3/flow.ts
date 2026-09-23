/**
 * The chain side of minting into a Uniswap v3 pool.
 *
 * The same discipline as the v4 flow: the price is read live from the pool
 * itself, the allowances from the tokens, and `eth_estimateGas` runs the
 * exact calldata against the node before the wallet is asked to sign.
 *
 * Two things differ from v4 and both are simpler. The manager pulls tokens
 * with `transferFrom`, so an approval goes **straight to it** rather than
 * through Permit2. And a v3 pool holds wrapped ether, never native — but the
 * manager is payable and wraps what it is sent, so the person still pays in
 * ETH, which is the point (§27).
 */

import type { Address, Hex, PublicClient } from 'viem';
import { CONTRACTS } from '../chain';
import type { Eip1193Provider } from '../wallet';
import { walletClient } from '../v4/client';
import { ERC20_ABI, MAX_UINT256 } from '../v4/permit2';
import type { Slot0 } from '../v4/flow';
import { V3_POOL_ABI, V3_POSITION_MANAGER_ABI } from './mint';

/** slot0 from the pool contract, which is where a v3 price lives. */
export async function readV3Slot0(client: PublicClient, pool: Address): Promise<Slot0> {
  const [sqrtPriceX96, tick] = await client.readContract({
    address: pool,
    abi: V3_POOL_ABI,
    functionName: 'slot0',
  });
  if (sqrtPriceX96 === 0n) throw new Error('This pool has not been initialised on chain.');
  return { sqrtPriceX96, tick };
}

/** The pool's in-range liquidity (`liquidity()`), or null when the node does not answer. */
export async function readV3ActiveLiquidity(client: PublicClient, pool: Address): Promise<bigint | null> {
  try {
    return await client.readContract({ address: pool, abi: V3_POOL_ABI, functionName: 'liquidity' });
  } catch {
    return null;
  }
}

export interface V3Approval {
  token: Address;
  /** Always the NonfungiblePositionManager: v3's periphery does not use Permit2. */
  spender: Address;
}

/**
 * Which allowances the mint still needs.
 *
 * The side being paid in ether needs none — it is sent as `msg.value` and
 * the manager wraps it, so nothing is pulled from the wallet.
 */
export async function v3ApprovalsNeeded(
  client: PublicClient,
  owner: Address,
  sides: { token0: Address; token1: Address; amount0: bigint; amount1: bigint },
  paidInEther: Address | null,
): Promise<V3Approval[]> {
  const spender = CONTRACTS.v3PositionManager as Address;
  const steps: V3Approval[] = [];
  for (const [token, amount] of [
    [sides.token0, sides.amount0],
    [sides.token1, sides.amount1],
  ] as [Address, bigint][]) {
    if (amount === 0n) continue;
    if (paidInEther && token.toLowerCase() === paidInEther.toLowerCase()) continue;
    const allowed = await client.readContract({
      address: token,
      abi: ERC20_ABI,
      functionName: 'allowance',
      args: [owner, spender],
    });
    if (allowed < amount) steps.push({ token, spender });
  }
  return steps;
}

export async function approveV3(provider: Eip1193Provider, owner: Address, step: V3Approval): Promise<Hex> {
  return walletClient(provider, owner).writeContract({
    address: step.token,
    abi: ERC20_ABI,
    functionName: 'approve',
    args: [step.spender, MAX_UINT256],
  });
}

export interface V3Call {
  calldata: Hex;
  value: bigint;
}

/** The node runs the exact transaction; a revert surfaces before any signature. */
export async function simulateV3Mint(client: PublicClient, owner: Address, call: V3Call): Promise<bigint> {
  return client.estimateGas({
    account: owner,
    to: CONTRACTS.v3PositionManager as Address,
    data: call.calldata,
    value: call.value,
  });
}

export async function sendV3Mint(
  provider: Eip1193Provider,
  owner: Address,
  call: V3Call,
  gas?: bigint,
): Promise<Hex> {
  return walletClient(provider, owner).sendTransaction({
    to: CONTRACTS.v3PositionManager as Address,
    data: call.calldata,
    value: call.value,
    gas: gas ? (gas * 12n) / 10n : undefined,
  });
}

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

/** Wait for the receipt and read the token ids the manager minted to the owner. */
export async function waitForV3Mint(
  client: PublicClient,
  hash: Hex,
  owner: Address,
): Promise<{ ok: boolean; tokenIds: bigint[] }> {
  const receipt = await client.waitForTransactionReceipt({ hash });
  const manager = CONTRACTS.v3PositionManager.toLowerCase();
  const tokenIds = receipt.logs
    .filter(
      (l) =>
        l.address.toLowerCase() === manager &&
        l.topics[0] === TRANSFER_TOPIC &&
        l.topics.length === 4 &&
        BigInt(l.topics[1] as Hex) === 0n &&
        `0x${(l.topics[2] as string).slice(26)}`.toLowerCase() === owner.toLowerCase(),
    )
    .map((l) => BigInt(l.topics[3] as Hex));
  return { ok: receipt.status === 'success', tokenIds };
}

export { V3_POSITION_MANAGER_ABI };
