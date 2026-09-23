/**
 * The single-token zap: enter a pair holding only one side of it (§3.1).
 *
 * Balast deploys no contract (§20), so the zap is two transactions through
 * Uniswap's own, each estimated against the node before the wallet is asked
 * to sign:
 *
 *   1. **Swap** the side the wallet holds into the side it lacks, in the very
 *      pool the position goes into — v3 through SwapRouter02, v4 through the
 *      Universal Router. The minimum out is the quoter's own answer less the
 *      tolerance, so a price that moves between the quote and the block
 *      reverts the swap rather than filling it badly.
 *   2. **Mint**, planned again at the price the swap left behind and fitted to
 *      what the wallet then holds (`fitBps`): the swap's fee and price impact
 *      are paid in the swapped side, so the plan is shrunk by exactly that
 *      much rather than asking for tokens the wallet does not have.
 *
 * Two transactions rather than one because one would need a contract of our
 * own to hold the swapped tokens between the swap and the mint, and §20 is
 * that there is none. The cost is one extra signature; the gain is that
 * nothing sits in a contract Balast wrote, even for one call.
 *
 * Every encoder here is compared as bytes with Uniswap's own in the test.
 */

import {
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionData,
  parseAbi,
  toHex,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { CONTRACTS, NATIVE_ETH } from './chain';
import type { ApprovalStep } from './v4/flow';
import { ERC20_ABI, PERMIT2_ABI } from './v4/permit2';
import { POOL_KEY_COMPONENTS, type PoolKey } from './v4/pool';

const Q192 = 1n << 192n;

/** Whether a swap goes from the pool's currency0 to its currency1. */
export type ZapDirection = 'quote-to-token' | 'token-to-quote';

/**
 * `amount` of one side, valued in the other at the pool's price, rounded down.
 * `zeroForOne`: `amount` is currency0 and the answer is currency1.
 */
export function valueInOther(amount: bigint, sqrtPriceX96: bigint, zeroForOne: boolean): bigint {
  const p2 = sqrtPriceX96 * sqrtPriceX96;
  if (p2 === 0n) return 0n;
  return zeroForOne ? (amount * p2) / Q192 : (amount * Q192) / p2;
}

/** A plan's two sides and what the wallet can put against each. */
export interface Holdings {
  needToken: bigint;
  needQuote: bigint;
  haveToken: bigint;
  haveQuote: bigint;
}

/**
 * How much of the plan the wallet can pay for, in basis points of it, capped
 * at 10,000. A side the plan does not use does not limit it.
 */
export function coverBps(h: Holdings): number {
  let bps = 10_000n;
  if (h.needToken > 0n) {
    const t = (h.haveToken * 10_000n) / h.needToken;
    if (t < bps) bps = t;
  }
  if (h.needQuote > 0n) {
    const q = (h.haveQuote * 10_000n) / h.needQuote;
    if (q < bps) bps = q;
  }
  return Number(bps < 0n ? 0n : bps);
}

/**
 * A short wallet is fitted — the plan scaled to what it holds — only when the
 * shortfall is small: 2% on its own, or up to 15% right after a zap, whose
 * fee and price impact are exactly that kind of shortfall. Anything larger is
 * a deposit the wallet cannot make, and the page says so rather than quietly
 * minting a smaller one.
 */
export const FIT_QUIET_BPS = 200;
export const FIT_AFTER_ZAP_BPS = 1_500;

/**
 * The scale to plan at, in basis points, or null when the plan fits as it is
 * or cannot be fitted. Rounded down to a step of ten, a hair under the cover,
 * so a price that moves by a tick does not re-plan (and re-dry-run) the mint
 * every read, and the rounding of each position cannot tip it over.
 */
export function fitBps(h: Holdings, zapped: boolean): number | null {
  const cover = coverBps(h);
  if (cover >= 10_000) return null;
  const limit = zapped ? FIT_AFTER_ZAP_BPS : FIT_QUIET_BPS;
  if (cover < 10_000 - limit) return null;
  const fitted = Math.floor((cover - 10) / 10) * 10;
  return fitted > 0 ? fitted : null;
}

/**
 * Which way to swap, and how much of the lacking side is wanted from it.
 * Null when the wallet covers the plan, when it lacks both sides, or when the
 * side it holds has nothing to spare.
 */
export function zapCandidate(h: Holdings): { direction: ZapDirection; want: bigint } | null {
  const tokenShort = h.needToken > h.haveToken;
  const quoteShort = h.needQuote > h.haveQuote;
  if (tokenShort && !quoteShort && h.haveQuote > h.needQuote) return { direction: 'quote-to-token', want: h.needToken - h.haveToken };
  if (quoteShort && !tokenShort && h.haveToken > h.needToken) return { direction: 'token-to-quote', want: h.needQuote - h.haveQuote };
  return null;
}

/** The loss a swap may take to the pool's fee and its price impact before it is not offered. */
export const MAX_ZAP_LOSS_BPS = 500;

export interface ZapQuote {
  direction: ZapDirection;
  amountIn: bigint;
  /** The quoter's answer for `amountIn`. */
  expectedOut: bigint;
  /** What the swap reverts below: the expected output less the tolerance. */
  minOut: bigint;
  /** Fee plus price impact against the pool's price before the swap, in basis points. */
  lossBps: number;
}

/**
 * Size the swap so it delivers `want`: a quote at the naive amount (the value
 * of `want` at the pool's price, grossed up by the fee tier), then up to three
 * more, each scaled by how short the last came up. The last is what is sent,
 * and its minimum is the quoter's answer less `slippageBps`. `quote` is the
 * venue's quoter; it throws when the pool cannot fill the amount.
 */
export async function sizeZap(args: {
  direction: ZapDirection;
  want: bigint;
  /** The side the swap spends, as the wallet holds it; the swap never spends more than the surplus. */
  surplus: bigint;
  sqrtPriceX96: bigint;
  tokenIsCurrency0: boolean;
  /** Hundredths of a bip; a dynamic-fee flag is read as 1%. */
  feePips: number;
  slippageBps: number;
  quote: (amountIn: bigint) => Promise<bigint>;
}): Promise<ZapQuote> {
  const inIsCurrency0 = args.direction === 'quote-to-token' ? !args.tokenIsCurrency0 : args.tokenIsCurrency0;
  // What the input side is worth of the output side, and the output's worth in input.
  const outInInput = (out: bigint) => valueInOther(out, args.sqrtPriceX96, !inIsCurrency0);
  const fee = BigInt(args.feePips >= 0x800000 || args.feePips >= 1_000_000 ? 10_000 : args.feePips);
  let naive = (outInInput(args.want) * 1_000_000n) / (1_000_000n - fee) + 1n;
  if (naive > args.surplus) naive = args.surplus;
  if (naive <= 0n) throw new Error('Nothing to swap.');
  const firstOut = await args.quote(naive);
  if (firstOut <= 0n) throw new Error('The pool returns nothing for this swap.');
  // Price impact is convex, so a linear correction lands a hair short; a
  // cushion of five hundredths of a percent and at most two more rounds close
  // it. Whatever is left is fitted by the mint (`fitBps`).
  let amountIn = naive;
  let expectedOut = firstOut;
  for (let round = 0; round < 3 && expectedOut < args.want && amountIn < args.surplus; round++) {
    amountIn = (amountIn * args.want * 10_005n) / (expectedOut * 10_000n) + 1n;
    if (amountIn > args.surplus) amountIn = args.surplus;
    expectedOut = await args.quote(amountIn);
  }
  const fair = valueInOther(amountIn, args.sqrtPriceX96, inIsCurrency0);
  const lossBps = fair > 0n && expectedOut < fair ? Number(((fair - expectedOut) * 10_000n) / fair) : 0;
  const minOut = (expectedOut * BigInt(10_000 - args.slippageBps)) / 10_000n;
  return { direction: args.direction, amountIn, expectedOut, minOut, lossBps };
}

// ---------------------------------------------------------------- v3 ------

/** SwapRouter02's calls, from `@uniswap/swap-router-contracts`' own ABI (compared in the test). */
export const SWAP_ROUTER02_ABI = parseAbi([
  'struct ExactInputSingleParams { address tokenIn; address tokenOut; uint24 fee; address recipient; uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96; }',
  'function exactInputSingle(ExactInputSingleParams params) payable returns (uint256 amountOut)',
  'function multicall(uint256 deadline, bytes[] data) payable returns (bytes[] results)',
  'function refundETH() payable',
]);

export const QUOTER_V2_ABI = parseAbi([
  'struct QuoteExactInputSingleParams { address tokenIn; address tokenOut; uint256 amountIn; uint24 fee; uint160 sqrtPriceLimitX96; }',
  'function quoteExactInputSingle(QuoteExactInputSingleParams params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
]);

export interface SwapCall {
  to: Address;
  calldata: Hex;
  value: bigint;
}

/**
 * One v3 swap through SwapRouter02, deadline enforced by its `multicall`.
 *
 * Paying in ether (`payWithEther`, only when `tokenIn` is the router's
 * WETH9) sends the amount as value: the router wraps exactly what the pool
 * pulls, and `refundETH` returns anything it did not — without it, unspent
 * ether would stay in the router for anyone to take.
 */
export function encodeV3Swap(args: {
  tokenIn: Address;
  tokenOut: Address;
  fee: number;
  recipient: Address;
  amountIn: bigint;
  amountOutMinimum: bigint;
  deadline: bigint;
  payWithEther: boolean;
}): SwapCall {
  const swap = encodeFunctionData({
    abi: SWAP_ROUTER02_ABI,
    functionName: 'exactInputSingle',
    args: [
      {
        tokenIn: args.tokenIn,
        tokenOut: args.tokenOut,
        fee: args.fee,
        recipient: args.recipient,
        amountIn: args.amountIn,
        amountOutMinimum: args.amountOutMinimum,
        sqrtPriceLimitX96: 0n,
      },
    ],
  });
  const calls: Hex[] = [swap];
  if (args.payWithEther) calls.push(encodeFunctionData({ abi: SWAP_ROUTER02_ABI, functionName: 'refundETH' }));
  return {
    to: CONTRACTS.swapRouter02 as Address,
    calldata: encodeFunctionData({ abi: SWAP_ROUTER02_ABI, functionName: 'multicall', args: [args.deadline, calls] }),
    value: args.payWithEther ? args.amountIn : 0n,
  };
}

/** QuoterV2's answer for an exact-input swap in one v3 pool. */
export async function quoteV3(
  client: PublicClient,
  args: { tokenIn: Address; tokenOut: Address; fee: number; amountIn: bigint },
): Promise<bigint> {
  const data = encodeFunctionData({
    abi: QUOTER_V2_ABI,
    functionName: 'quoteExactInputSingle',
    args: [{ tokenIn: args.tokenIn, tokenOut: args.tokenOut, amountIn: args.amountIn, fee: args.fee, sqrtPriceLimitX96: 0n }],
  });
  const result = await client.call({ to: CONTRACTS.v3QuoterV2 as Address, data });
  if (!result.data) throw new Error('The quoter did not answer.');
  const [amountOut] = decodeFunctionResult({ abi: QUOTER_V2_ABI, functionName: 'quoteExactInputSingle', data: result.data });
  return amountOut;
}

// ---------------------------------------------------------------- v4 ------

/** Universal Router: one command, V4_SWAP. */
export const UNIVERSAL_ROUTER_ABI = parseAbi(['function execute(bytes commands, bytes[] inputs, uint256 deadline) payable']);
export const V4_SWAP_COMMAND = 0x10;

/** v4-periphery `Actions.sol`, the three a single exact-input swap uses. */
export const SwapActions = { SWAP_EXACT_IN_SINGLE: 0x06, SETTLE: 0x0b, SETTLE_ALL: 0x0c, TAKE_ALL: 0x0f } as const;

/** Universal Router `WRAP_ETH`: wraps the ether sent into the router's own WETH9. */
export const WRAP_ETH_COMMAND = 0x0b;
/** The router's own address, as its commands spell it (`ActionConstants.ADDRESS_THIS`). */
export const UR_ADDRESS_THIS = '0x0000000000000000000000000000000000000002' as Address;

/**
 * Which layout the router decodes a single swap with. The router on this
 * chain is v2.1.1 per Uniswap's registry, whose struct carries
 * `minHopPriceX36` (zero disables it; the minimum out is the guard here).
 * 'v2.0' is the older layout, used only by the local end-to-end run, whose
 * router is the 2.1.0 on npm.
 */
export type UrVersion = 'v2.0' | 'v2.1.1';

const POOL_KEY = { type: 'tuple', components: POOL_KEY_COMPONENTS } as const;

export function encodeV4SwapInput(args: {
  key: PoolKey;
  zeroForOne: boolean;
  amountIn: bigint;
  amountOutMinimum: bigint;
  version?: UrVersion;
  /**
   * The input is already in the router — wrapped from the ether sent, by
   * `WRAP_ETH` just before — so it is settled from the router's own balance
   * (`SETTLE`, payer the router) rather than pulled from the caller.
   */
  inputInRouter?: boolean;
}): Hex {
  const version = args.version ?? 'v2.1.1';
  const [currencyIn, currencyOut] = args.zeroForOne
    ? [args.key.currency0, args.key.currency1]
    : [args.key.currency1, args.key.currency0];
  const swap =
    version === 'v2.1.1'
      ? encodeAbiParameters(
          [
            {
              type: 'tuple',
              components: [
                { name: 'poolKey', ...POOL_KEY },
                { name: 'zeroForOne', type: 'bool' },
                { name: 'amountIn', type: 'uint128' },
                { name: 'amountOutMinimum', type: 'uint128' },
                { name: 'minHopPriceX36', type: 'uint256' },
                { name: 'hookData', type: 'bytes' },
              ],
            },
          ],
          [{ poolKey: args.key, zeroForOne: args.zeroForOne, amountIn: args.amountIn, amountOutMinimum: args.amountOutMinimum, minHopPriceX36: 0n, hookData: '0x' }],
        )
      : encodeAbiParameters(
          [
            {
              type: 'tuple',
              components: [
                { name: 'poolKey', ...POOL_KEY },
                { name: 'zeroForOne', type: 'bool' },
                { name: 'amountIn', type: 'uint128' },
                { name: 'amountOutMinimum', type: 'uint128' },
                { name: 'hookData', type: 'bytes' },
              ],
            },
          ],
          [{ poolKey: args.key, zeroForOne: args.zeroForOne, amountIn: args.amountIn, amountOutMinimum: args.amountOutMinimum, hookData: '0x' }],
        );
  // SETTLE_ALL pays the input from the caller (Permit2, or the value sent for
  // ether), capped at the exact amount; TAKE_ALL sends the output to the
  // caller and reverts below the minimum.
  const settle = args.inputInRouter
    ? encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'bool' }], [currencyIn, args.amountIn, false])
    : encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [currencyIn, args.amountIn]);
  const take = encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [currencyOut, args.amountOutMinimum]);
  const actions = toHex(
    Uint8Array.from([SwapActions.SWAP_EXACT_IN_SINGLE, args.inputInRouter ? SwapActions.SETTLE : SwapActions.SETTLE_ALL, SwapActions.TAKE_ALL]),
  );
  return encodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], [actions, [swap, settle, take]]);
}

/**
 * One v4 swap through the Universal Router. Ether in is sent as value, and
 * exactly the amount the swap settles — anything more would stay in the
 * router, which anyone can sweep.
 *
 * `wrapEtherIn`: the pool's input side is aeWETH and the wallet pays in ETH.
 * The router wraps exactly the value sent (`WRAP_ETH` to itself), then the
 * swap settles that from the router's balance — one transaction, no approval,
 * and nothing left in the router, since the wrap and the settle are the same
 * amount. This is what lets a v4 pool quoted in the wrapper be entered with
 * ETH alone (§27, §35).
 */
export function encodeV4Swap(args: {
  key: PoolKey;
  zeroForOne: boolean;
  amountIn: bigint;
  amountOutMinimum: bigint;
  deadline: bigint;
  version?: UrVersion;
  wrapEtherIn?: boolean;
}): SwapCall {
  const currencyIn = args.zeroForOne ? args.key.currency0 : args.key.currency1;
  if (args.wrapEtherIn && currencyIn.toLowerCase() === NATIVE_ETH) throw new Error('wrapEtherIn is for a pool quoted in the wrapper, not native ether.');
  const input = encodeV4SwapInput({ ...args, inputInRouter: args.wrapEtherIn });
  const commands = args.wrapEtherIn ? [WRAP_ETH_COMMAND, V4_SWAP_COMMAND] : [V4_SWAP_COMMAND];
  const inputs = args.wrapEtherIn
    ? [encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [UR_ADDRESS_THIS, args.amountIn]), input]
    : [input];
  return {
    to: CONTRACTS.universalRouter as Address,
    calldata: encodeFunctionData({
      abi: UNIVERSAL_ROUTER_ABI,
      functionName: 'execute',
      args: [toHex(Uint8Array.from(commands)), inputs, args.deadline],
    }),
    value: args.wrapEtherIn || currencyIn.toLowerCase() === NATIVE_ETH ? args.amountIn : 0n,
  };
}

export const V4_QUOTER_ABI = parseAbi([
  'struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }',
  'struct QuoteExactSingleParams { PoolKey poolKey; bool zeroForOne; uint128 exactAmount; bytes hookData; }',
  'function quoteExactInputSingle(QuoteExactSingleParams params) returns (uint256 amountOut, uint256 gasEstimate)',
]);

/** The V4Quoter's answer for an exact-input swap in one v4 pool. */
export async function quoteV4(client: PublicClient, args: { key: PoolKey; zeroForOne: boolean; amountIn: bigint }): Promise<bigint> {
  const data = encodeFunctionData({
    abi: V4_QUOTER_ABI,
    functionName: 'quoteExactInputSingle',
    args: [{ poolKey: args.key, zeroForOne: args.zeroForOne, exactAmount: args.amountIn, hookData: '0x' }],
  });
  const result = await client.call({ to: CONTRACTS.v4Quoter as Address, data });
  if (!result.data) throw new Error('The quoter did not answer.');
  const [amountOut] = decodeFunctionResult({ abi: V4_QUOTER_ABI, functionName: 'quoteExactInputSingle', data: result.data });
  return amountOut;
}

// ---------------------------------------------------------- approvals ------

/**
 * What the swap's input still needs approved. Ether needs nothing. A v3 swap
 * pulls the token straight into SwapRouter02; a v4 swap pulls it through
 * Permit2, which the Universal Router is then allowed to use — the same two
 * steps as a v4 mint, with the router in PositionManager's place.
 */
export async function zapApprovalsNeeded(
  client: PublicClient,
  owner: Address,
  venue: 'v3' | 'v4',
  tokenIn: Address,
  amount: bigint,
  paidInEther: boolean,
  nowSeconds: number,
): Promise<ApprovalStep[]> {
  if (paidInEther || tokenIn.toLowerCase() === NATIVE_ETH || amount === 0n) return [];
  if (venue === 'v3') {
    const spender = CONTRACTS.swapRouter02 as Address;
    const allowed = await client.readContract({ address: tokenIn, abi: ERC20_ABI, functionName: 'allowance', args: [owner, spender] });
    return allowed < amount ? [{ kind: 'erc20', token: tokenIn, spender }] : [];
  }
  const steps: ApprovalStep[] = [];
  const router = CONTRACTS.universalRouter as Address;
  const erc20 = await client.readContract({ address: tokenIn, abi: ERC20_ABI, functionName: 'allowance', args: [owner, CONTRACTS.permit2] });
  if (erc20 < amount) steps.push({ kind: 'erc20', token: tokenIn, spender: router });
  const [allowed, expiration] = await client.readContract({
    address: CONTRACTS.permit2,
    abi: PERMIT2_ABI,
    functionName: 'allowance',
    args: [owner, tokenIn, router],
  });
  if (allowed < amount || Number(expiration) <= nowSeconds) steps.push({ kind: 'permit2', token: tokenIn, spender: router });
  return steps;
}
