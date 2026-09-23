/**
 * Managing a Uniswap **v3** position the wallet holds: collect its fees, or
 * take it out of the pool altogether. The v3 twin of lib/v4/manage.ts.
 *
 * §28 made `/positions` mint into v3 pools through Uniswap's own
 * NonfungiblePositionManager. Without this file that was a one-way door: the
 * position went to the wallet and the site could neither show it nor get the
 * money back out — exactly the fault §22 recorded for v4 and §23 closed.
 *
 * Both are one transaction on the same manager that minted the position —
 * several steps batched through its own `multicall`, a single step sent as
 * itself — laid out exactly the way Uniswap's own SDK lays them out
 * (`NonfungiblePositionManager.collectCallParameters` and
 * `removeCallParameters`); `lib/v3/manage.test.ts` compares the bytes.
 *
 *   collect   collect(max, max) — to the owner, or, when one side is the
 *             wrapped ether, to the manager itself followed by
 *             `unwrapWETH9` and `sweepToken`, so the ether side arrives as
 *             ETH (§27: an ether pair is ETH).
 *   withdraw  decreaseLiquidity(all) with minimums, the same collect, then
 *             `burn`. A burn only succeeds on an empty position with nothing
 *             owed, which the collect before it guarantees.
 *
 * The unwrap is only used when the manager's own `WETH9()` IS the wrapper
 * the site knows. The caller reads it and says so; if it were anything else,
 * `unwrapWETH9` would unwrap nothing and the wrapped side would sit in the
 * manager where anyone could sweep it. Collecting straight to the owner is
 * always safe, so that is what a mismatch or an unanswered read does.
 */

import { encodeFunctionData, parseAbi, type Address, type Hex } from 'viem';
import { burnAmountsWithSlippage } from './amounts';

export const MAX_UINT128 = 2n ** 128n - 1n;

export const V3_MANAGE_ABI = parseAbi([
  'struct DecreaseLiquidityParams { uint256 tokenId; uint128 liquidity; uint256 amount0Min; uint256 amount1Min; uint256 deadline; }',
  'struct CollectParams { uint256 tokenId; address recipient; uint128 amount0Max; uint128 amount1Max; }',
  'function decreaseLiquidity(DecreaseLiquidityParams params) payable returns (uint256 amount0, uint256 amount1)',
  'function collect(CollectParams params) payable returns (uint256 amount0, uint256 amount1)',
  'function burn(uint256 tokenId) payable',
  'function unwrapWETH9(uint256 amountMinimum, address recipient) payable',
  'function sweepToken(address token, uint256 amountMinimum, address recipient) payable',
  'function multicall(bytes[] data) payable returns (bytes[] results)',
  'function WETH9() view returns (address)',
  'function balanceOf(address owner) view returns (uint256)',
  'function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)',
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)',
]);

const ZERO: Address = '0x0000000000000000000000000000000000000000';

export interface V3ManagePlan {
  kind: 'collect' | 'withdraw';
  calldata: Hex;
  /** Nothing is paid in either way. */
  value: bigint;
  amount0Min: bigint;
  amount1Min: bigint;
}

interface CollectArgs {
  tokenId: bigint;
  token0: Address;
  token1: Address;
  owner: Address;
  /**
   * The wrapper, when one side is it AND the manager's own `WETH9()` was read
   * and matched. Null collects both sides as the ERC-20s they are.
   */
  unwrap: Address | null;
  /** What the caller expects each side to pay at least; the minimums of the unwrap and the sweep. */
  expected0: bigint;
  expected1: bigint;
}

/** The collect step, and the unwrap and sweep that follow it for an ether pair — `encodeCollect` in the SDK. */
function collectCalls(args: CollectArgs): Hex[] {
  const wrapped = args.unwrap?.toLowerCase() ?? null;
  const ether0 = wrapped !== null && args.token0.toLowerCase() === wrapped;
  const ether1 = wrapped !== null && !ether0 && args.token1.toLowerCase() === wrapped;
  const involvesEther = ether0 || ether1;
  const calls: Hex[] = [
    encodeFunctionData({
      abi: V3_MANAGE_ABI,
      functionName: 'collect',
      args: [
        {
          tokenId: args.tokenId,
          // address(0) is the manager's own spelling of itself: it holds the
          // proceeds for the unwrap and the sweep in the same transaction.
          recipient: involvesEther ? ZERO : args.owner,
          amount0Max: MAX_UINT128,
          amount1Max: MAX_UINT128,
        },
      ],
    }),
  ];
  if (involvesEther) {
    const [etherAmount, token, tokenAmount] = ether0
      ? [args.expected0, args.token1, args.expected1]
      : [args.expected1, args.token0, args.expected0];
    calls.push(
      encodeFunctionData({ abi: V3_MANAGE_ABI, functionName: 'unwrapWETH9', args: [etherAmount, args.owner] }),
      encodeFunctionData({ abi: V3_MANAGE_ABI, functionName: 'sweepToken', args: [token, tokenAmount, args.owner] }),
    );
  }
  return calls;
}

/** One call is sent as itself, several through `multicall` — the SDK's `encodeMulticall`. */
function batch(calls: Hex[]): Hex {
  return calls.length === 1 ? calls[0] : encodeFunctionData({ abi: V3_MANAGE_ABI, functionName: 'multicall', args: [calls] });
}

export function planV3Collect(args: CollectArgs): V3ManagePlan {
  return {
    kind: 'collect',
    calldata: batch(collectCalls(args)),
    value: 0n,
    amount0Min: 0n,
    amount1Min: 0n,
  };
}

export function planV3Withdraw(args: {
  tokenId: bigint;
  token0: Address;
  token1: Address;
  owner: Address;
  unwrap: Address | null;
  /** The pool's live price, read a moment before. */
  sqrtPriceX96: bigint;
  tickLower: number;
  tickUpper: number;
  /** The position's live liquidity. Zero skips the decrease: there is nothing to take out, only what is owed. */
  liquidity: bigint;
  /** Fees already owed to the position, as a collect would pay them now. */
  owed0: bigint;
  owed1: bigint;
  slippageBps?: number;
  /** Unix seconds (§2). */
  deadline: bigint;
}): V3ManagePlan {
  const slippageBps = BigInt(args.slippageBps ?? 100);
  const calls: Hex[] = [];
  let amount0Min = 0n;
  let amount1Min = 0n;
  if (args.liquidity > 0n) {
    // Uniswap's own guard: each side priced where it is worth least within
    // the tolerance, so a withdrawal that would pay less reverts instead.
    const min = burnAmountsWithSlippage({
      sqrtPriceX96: args.sqrtPriceX96,
      tickLower: args.tickLower,
      tickUpper: args.tickUpper,
      liquidity: args.liquidity,
      slippageBps,
    });
    amount0Min = min.amount0;
    amount1Min = min.amount1;
    calls.push(
      encodeFunctionData({
        abi: V3_MANAGE_ABI,
        functionName: 'decreaseLiquidity',
        args: [{ tokenId: args.tokenId, liquidity: args.liquidity, amount0Min, amount1Min, deadline: args.deadline }],
      }),
    );
  }
  calls.push(
    ...collectCalls({
      tokenId: args.tokenId,
      token0: args.token0,
      token1: args.token1,
      owner: args.owner,
      unwrap: args.unwrap,
      expected0: args.owed0 + amount0Min,
      expected1: args.owed1 + amount1Min,
    }),
  );
  // The NFT goes only once it is empty and owes nothing, which the collect
  // above has just made true.
  calls.push(encodeFunctionData({ abi: V3_MANAGE_ABI, functionName: 'burn', args: [args.tokenId] }));
  return {
    kind: 'withdraw',
    calldata: batch(calls),
    value: 0n,
    amount0Min,
    amount1Min,
  };
}
