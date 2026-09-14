/**
 * The chain side of minting: reads, approvals, simulation, the send.
 *
 * Everything a position needs from the chain is read live — the price from
 * StateView, balances and allowances from the tokens — never from the
 * indexer, which can be hours behind (§7). Nothing is sent that was not
 * first estimated against the node with the same calldata: a mint that
 * would revert is refused before the wallet is asked to sign.
 */

import { createPublicClient, custom, http, parseAbi, type Address, type Hex, type Log, type PublicClient } from 'viem';
import { CONTRACTS, NATIVE_ETH, PUBLIC_RPC_URL } from '../chain';
import type { Eip1193Provider } from '../wallet';
import { POSITION_MANAGER_ABI } from './actions';
import { robinhoodChain, walletClient } from './client';
import type { MintPlan } from './mint';
import { ERC20_ABI, MAX_UINT160, MAX_UINT256, PERMIT2_ABI, PERMIT2_EXPIRATION_SECONDS } from './permit2';
import { poolId, type PoolKey } from './pool';

export const STATE_VIEW_ABI = parseAbi([
  'function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
]);

/** Reads go through the wallet's own connection when there is one (no CORS to negotiate), else the public RPC. */
export function readClient(provider?: Eip1193Provider | null): PublicClient {
  return createPublicClient({ chain: robinhoodChain, transport: provider ? custom(provider) : http(PUBLIC_RPC_URL) });
}

export interface Slot0 {
  sqrtPriceX96: bigint;
  tick: number;
}

export async function readSlot0(client: PublicClient, key: PoolKey): Promise<Slot0> {
  const [sqrtPriceX96, tick] = await client.readContract({
    address: CONTRACTS.stateView,
    abi: STATE_VIEW_ABI,
    functionName: 'getSlot0',
    args: [poolId(key)],
  });
  if (sqrtPriceX96 === 0n) throw new Error('This pool has not been initialised on chain.');
  return { sqrtPriceX96, tick };
}

export function isNative(currency: string): boolean {
  return currency.toLowerCase() === NATIVE_ETH;
}

export async function readBalance(client: PublicClient, owner: Address, currency: Address): Promise<bigint> {
  if (isNative(currency)) return client.getBalance({ address: owner });
  return client.readContract({ address: currency, abi: ERC20_ABI, functionName: 'balanceOf', args: [owner] });
}

export interface ApprovalStep {
  kind: 'erc20' | 'permit2';
  token: Address;
}

/**
 * Which approvals the mint still needs, in the order they have to happen:
 * the token's allowance to Permit2, then Permit2's allowance to
 * PositionManager. Ether needs none.
 */
export async function approvalsNeeded(
  client: PublicClient,
  owner: Address,
  key: PoolKey,
  amounts: { amount0Max: bigint; amount1Max: bigint },
  nowSeconds: number,
): Promise<ApprovalStep[]> {
  const steps: ApprovalStep[] = [];
  const sides: [Address, bigint][] = [
    [key.currency0, amounts.amount0Max],
    [key.currency1, amounts.amount1Max],
  ];
  for (const [currency, amount] of sides) {
    if (isNative(currency) || amount === 0n) continue;
    const erc20 = await client.readContract({
      address: currency,
      abi: ERC20_ABI,
      functionName: 'allowance',
      args: [owner, CONTRACTS.permit2],
    });
    if (erc20 < amount) steps.push({ kind: 'erc20', token: currency });
    const [allowed, expiration] = await client.readContract({
      address: CONTRACTS.permit2,
      abi: PERMIT2_ABI,
      functionName: 'allowance',
      args: [owner, currency, CONTRACTS.positionManager],
    });
    if (allowed < amount || Number(expiration) <= nowSeconds) steps.push({ kind: 'permit2', token: currency });
  }
  return steps;
}

/** Send one approval. Both are the SDK's own shapes: unlimited to Permit2, thirty days to PositionManager. */
export async function approve(provider: Eip1193Provider, owner: Address, step: ApprovalStep, nowSeconds: number): Promise<Hex> {
  const wallet = walletClient(provider, owner);
  if (step.kind === 'erc20') {
    return wallet.writeContract({
      address: step.token,
      abi: ERC20_ABI,
      functionName: 'approve',
      args: [CONTRACTS.permit2, MAX_UINT256],
    });
  }
  return wallet.writeContract({
    address: CONTRACTS.permit2,
    abi: PERMIT2_ABI,
    functionName: 'approve',
    args: [step.token, CONTRACTS.positionManager, MAX_UINT160, nowSeconds + PERMIT2_EXPIRATION_SECONDS],
  });
}

/** The node runs the exact transaction; a revert surfaces here, before any signature. Returns the gas it would take. */
export async function simulateMint(client: PublicClient, owner: Address, plan: MintPlan): Promise<bigint> {
  return client.estimateGas({ account: owner, to: CONTRACTS.positionManager, data: plan.calldata, value: plan.value });
}

export async function sendMint(provider: Eip1193Provider, owner: Address, plan: MintPlan, gas?: bigint): Promise<Hex> {
  return walletClient(provider, owner).sendTransaction({
    to: CONTRACTS.positionManager,
    data: plan.calldata,
    value: plan.value,
    gas: gas ? (gas * 12n) / 10n : undefined,
  });
}

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

/** Wait for the receipt and read the token ids PositionManager minted to the owner. */
export async function waitForMint(client: PublicClient, hash: Hex, owner: Address): Promise<{ ok: boolean; tokenIds: bigint[] }> {
  const receipt = await client.waitForTransactionReceipt({ hash });
  const tokenIds = receipt.logs
    .filter(
      (l: Log) =>
        l.address.toLowerCase() === CONTRACTS.positionManager.toLowerCase() &&
        l.topics[0] === TRANSFER_TOPIC &&
        l.topics.length === 4 &&
        BigInt(l.topics[1] as Hex) === 0n &&
        (`0x${(l.topics[2] as string).slice(26)}`).toLowerCase() === owner.toLowerCase(),
    )
    .map((l) => BigInt(l.topics[3] as Hex));
  return { ok: receipt.status === 'success', tokenIds };
}

/** How many positions this wallet holds, straight from the NFT contract. */
export async function positionCount(client: PublicClient, owner: Address): Promise<bigint> {
  return client.readContract({ address: CONTRACTS.positionManager, abi: POSITION_MANAGER_ABI, functionName: 'balanceOf', args: [owner] });
}

/** A wallet's refusal, an empty balance or a revert, in a sentence. */
export function describeTxError(error: unknown): string {
  const e = error as { code?: number; shortMessage?: string; message?: string; details?: string; cause?: { code?: number; shortMessage?: string } };
  const code = e?.code ?? e?.cause?.code;
  const text = `${e?.shortMessage ?? ''} ${e?.details ?? ''} ${e?.message ?? ''}`;
  if (code === 4001 || /user rejected|user denied/i.test(text)) return 'You declined in the wallet. Nothing was sent.';
  if (/insufficient funds/i.test(text)) return 'Not enough ETH in the wallet for the deposit plus gas.';
  if (/deadline/i.test(text)) return 'The transaction expired before it was mined. Try again.';
  if (/MaximumAmountExceeded|amount.*exceed/i.test(text)) return 'The price moved more than the tolerance while you were signing. Try again.';
  if (/HookNotImplemented|Hook/i.test(text)) return 'This pool\'s hook refused the position. It may not accept outside liquidity yet.';
  const short = e?.shortMessage ?? e?.cause?.shortMessage;
  return short ? short.replace(/\s+/g, ' ').slice(0, 200) : 'The transaction could not be prepared.';
}
