/**
 * The chain side of minting: reads, approvals, simulation, the send.
 *
 * Everything a position needs from the chain is read live — the price from
 * StateView, balances and allowances from the tokens — never from the
 * indexer, which can be hours behind (§7). Nothing is sent that was not
 * first estimated against the node with the same calldata: a mint that
 * would revert is refused before the wallet is asked to sign.
 */

import {
  createPublicClient,
  custom,
  encodeFunctionData,
  http,
  parseAbi,
  type Address,
  type Hex,
  type Log,
  type PublicClient,
  toFunctionSelector,
} from 'viem';
import { CONTRACTS, NATIVE_ETH, PUBLIC_RPC_URL } from '../chain';
import type { Eip1193Provider } from '../wallet';
import { POSITION_MANAGER_ABI } from './actions';
import { robinhoodChain, walletClient } from './client';
import type { MintPlan } from './mint';
import { ERC20_ABI, MAX_UINT160, MAX_UINT256, PERMIT2_ABI, PERMIT2_EXPIRATION_SECONDS } from './permit2';
import { poolId, type PoolKey } from './pool';

export const STATE_VIEW_ABI = parseAbi([
  'function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
  'function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)',
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

/**
 * The liquidity trading at the pool's current price: what every swap's fee is
 * shared across. Null when the node does not answer — an estimate built on it
 * then says it cannot be made, rather than guessing.
 */
export async function readActiveLiquidity(client: PublicClient, key: PoolKey): Promise<bigint | null> {
  try {
    return await client.readContract({
      address: CONTRACTS.stateView,
      abi: STATE_VIEW_ABI,
      functionName: 'getLiquidity',
      args: [poolId(key)],
    });
  } catch {
    return null;
  }
}

export function isNative(currency: string): boolean {
  return currency.toLowerCase() === NATIVE_ETH;
}

/**
 * aeWETH's own two calls. The wrapper mints one token per ether deposited
 * and burns one per ether withdrawn (§18), so wrapping is not a trade and
 * has no price to guard — the amount in is the amount out.
 */
export const WETH_ABI = parseAbi(['function deposit() payable', 'function withdraw(uint256 amount)']);

/** `deposit()` — the selector, so the estimate and the send are the same bytes. */
export const WRAP_CALLDATA: Hex = encodeFunctionData({ abi: WETH_ABI, functionName: 'deposit' });

/**
 * Wrap ether into aeWETH, so a market quoted in the wrapper can be entered
 * with the chain's own ether.
 *
 * A v4 pool that holds ether holds it natively, but not every pool does:
 * some are quoted in the wrapper, and a wallet holding ether cannot enter
 * one without this. As everywhere else here, the node runs the call before
 * the wallet is asked to sign — a wrapper that does not take a direct
 * deposit reverts in the estimate rather than after a signature.
 */
export async function simulateWrap(client: PublicClient, owner: Address, amount: bigint): Promise<bigint> {
  return client.estimateGas({
    account: owner,
    to: CONTRACTS.weth as Address,
    data: WRAP_CALLDATA,
    value: amount,
  });
}

export async function sendWrap(provider: Eip1193Provider, owner: Address, amount: bigint, gas?: bigint): Promise<Hex> {
  return walletClient(provider, owner).sendTransaction({
    to: CONTRACTS.weth as Address,
    data: WRAP_CALLDATA,
    value: amount,
    gas: gas ? (gas * 12n) / 10n : undefined,
  });
}

/**
 * How much ether to wrap so a market quoted in the wrapper can be minted, or
 * null when nothing needs wrapping or the wallet cannot cover it.
 *
 * What Permit2 is asked to move is the pool's own figure, which rounds UP from
 * the planned amount — by a wei a position — and can grow by the tolerance if
 * the price moves. Wrapping exactly the planned amount left the dry run one
 * wei short and the person stuck on a mint that could not be prepared. So:
 * never less than the planned amount plus that rounding (the floor), and up
 * to the plan's cap as far as the spare ether allows. `reserve` is kept back
 * for the mint's own gas.
 */
export function wrapShortfall(args: {
  /** The plan's quote amount at the live price. */
  planned: bigint;
  /** The plan's cap on the quote side, slippage included. */
  cap: bigint;
  positions: number;
  wrappedBalance: bigint;
  nativeBalance: bigint;
  reserve: bigint;
}): bigint | null {
  if (args.planned === 0n) return null;
  const floor = args.planned + BigInt(args.positions);
  if (args.wrappedBalance >= floor) return null;
  const spare = args.nativeBalance > args.reserve ? args.nativeBalance - args.reserve : 0n;
  const toFloor = floor - args.wrappedBalance;
  const toCap = args.cap > args.wrappedBalance ? args.cap - args.wrappedBalance : 0n;
  const upTo = toCap < spare ? toCap : spare;
  const shortfall = upTo > toFloor ? upTo : toFloor;
  return shortfall > 0n && spare >= shortfall ? shortfall : null;
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

/** Any position-manager transaction the site builds: a mint, a collect, a withdrawal. */
export interface PositionCall {
  calldata: Hex;
  value: bigint;
}

/**
 * The node runs the exact transaction; a revert surfaces here, before any
 * signature. Returns the gas it would take. `to` is v4's PositionManager
 * unless the caller names v3's manager.
 */
export async function simulateCall(
  client: PublicClient,
  owner: Address,
  call: PositionCall,
  to: Address = CONTRACTS.positionManager,
): Promise<bigint> {
  return client.estimateGas({ account: owner, to, data: call.calldata, value: call.value });
}

export async function sendCall(
  provider: Eip1193Provider,
  owner: Address,
  call: PositionCall,
  gas?: bigint,
  to: Address = CONTRACTS.positionManager,
): Promise<Hex> {
  return walletClient(provider, owner).sendTransaction({
    to,
    data: call.calldata,
    value: call.value,
    gas: gas ? (gas * 12n) / 10n : undefined,
  });
}

// Typed on the call rather than on `MintPlan`: both are a target, calldata
// and a value, and the caller branches on which manager it is sending to.
export const simulateMint = (client: PublicClient, owner: Address, plan: PositionCall): Promise<bigint> =>
  simulateCall(client, owner, plan);

export const sendMint = (provider: Eip1193Provider, owner: Address, plan: PositionCall, gas?: bigint): Promise<Hex> =>
  sendCall(provider, owner, plan, gas);

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

const PRICE_MOVED = 'The price moved more than the tolerance while you were signing. Nothing was sent or taken. Try again.';
const NOT_HELD = 'This wallet no longer holds this position — it may already have been withdrawn. Nothing was sent.';
const EXPIRED = 'The transaction expired before it was mined. Try again.';

/**
 * Uniswap's custom errors, by selector. The site's ABIs do not declare them,
 * so a node's answer carries the four bytes and not the name — matching the
 * name alone never matched a real revert. From v4-periphery's
 * `SlippageCheck.sol` and `IPositionManager.sol`.
 */
const REVERT_SELECTORS: Record<string, string> = {
  [toFunctionSelector('MinimumAmountInsufficient(uint128,uint128)')]: PRICE_MOVED,
  [toFunctionSelector('MaximumAmountExceeded(uint128,uint128)')]: PRICE_MOVED,
  [toFunctionSelector('NotApproved(address)')]: NOT_HELD,
  [toFunctionSelector('DeadlinePassed(uint256)')]: EXPIRED,
};

/** Every string on the error and its causes: messages, details and raw revert data. */
function errorText(error: unknown): string {
  const parts: string[] = [];
  let e = error as Record<string, unknown> | undefined;
  for (let depth = 0; e && typeof e === 'object' && depth < 8; depth++) {
    for (const field of ['shortMessage', 'details', 'message', 'data', 'reason']) {
      const v = e[field];
      if (typeof v === 'string') parts.push(v);
      else if (v && typeof v === 'object' && typeof (v as { data?: unknown }).data === 'string') parts.push((v as { data: string }).data);
    }
    e = e.cause as Record<string, unknown> | undefined;
  }
  return parts.join(' ');
}

/**
 * An error whose message is already written for the person reading the page:
 * `describeTxError` shows it as it is. A plain `Error` is treated as an
 * internal fault and summarised, which swallowed every message the flows
 * wrote themselves ("the chain says this position is already empty").
 */
export class ShownError extends Error {}

/** A wallet's refusal, an empty balance or a revert, in a sentence. */
export function describeTxError(error: unknown): string {
  if (error instanceof ShownError) return error.message;
  const e = error as { code?: number; shortMessage?: string; message?: string; details?: string; cause?: { code?: number; shortMessage?: string } };
  const code = e?.code ?? e?.cause?.code;
  const text = errorText(error);
  for (const selector of text.toLowerCase().match(/0x[0-9a-f]{8}/g) ?? []) {
    const known = REVERT_SELECTORS[selector];
    if (known && !(code === 4001)) return known;
  }
  if (code === 4001 || /user rejected|user denied/i.test(text)) return 'You declined in the wallet. Nothing was sent.';
  if (/insufficient funds/i.test(text)) return 'Not enough ETH in the wallet for the deposit plus gas.';
  if (/deadline|Transaction too old/i.test(text)) return EXPIRED;
  // Named, not guessed: "transfer amount exceeds balance" is a balance, not a price.
  if (/MaximumAmountExceeded|MinimumAmountInsufficient|Price slippage check/i.test(text)) return PRICE_MOVED;
  if (/exceeds balance|insufficient balance|TRANSFER_FROM_FAILED|\bSTF\b/i.test(text))
    return 'The wallet does not hold enough of one of the tokens for this. Nothing was sent.';
  // v4's NotApproved, v3's "Not approved", an ERC-721's missing token: the
  // wallet does not hold this position any more — most often it was already
  // withdrawn, in another tab or on Uniswap's own site.
  if (/NotApproved|Not approved|NOT_MINTED|nonexistent token|invalid token ID/i.test(text)) return NOT_HELD;
  if (/HookNotImplemented|Hook/i.test(text)) return 'This pool\'s hook refused the position. It may not accept outside liquidity yet.';
  const short = e?.shortMessage ?? e?.cause?.shortMessage;
  return short ? short.replace(/\s+/g, ' ').slice(0, 200) : 'The transaction could not be prepared.';
}
