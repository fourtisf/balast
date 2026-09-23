'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Address, Hex } from 'viem';
import { useUi } from '@/components/providers/UiProvider';
import { useWalletChainId } from '@/components/providers/useWalletChainId';
import { CHAIN, CONTRACTS, NATIVE_ETH } from '@/lib/chain';
import { getProvider } from '@/lib/data';
import type { Pool, PoolKeyInfo, ShapeId } from '@/lib/data/types';
import { quoteLabel } from '@/lib/format';
import { recordMinted, recordTx, updateTx } from '@/lib/tx-history';
import {
  approvalsNeeded,
  approve,
  describeTxError,
  readBalance,
  readActiveLiquidity,
  readClient,
  readSlot0,
  sendCall,
  sendMint,
  sendWrap,
  ShownError,
  simulateMint,
  simulateWrap,
  waitForMint,
  wrapShortfall,
  type ApprovalStep,
  type Slot0,
} from '@/lib/v4/flow';
import { amount as fmtAmount, toRaw } from '@/lib/v4/format';
import { planMint, type MintPlan } from '@/lib/v4/mint';
import { priceFromSqrt, toPoolKey, type PoolKey } from '@/lib/v4/pool';
import {
  approveV3,
  readV3ActiveLiquidity,
  readV3Slot0,
  sendV3Mint,
  simulateV3Mint,
  v3ApprovalsNeeded,
  waitForV3Mint,
} from '@/lib/v3/flow';
import { planV3Mint } from '@/lib/v3/mint';
import { readV3Weth9 } from '@/lib/v3/positions';
import {
  FIT_AFTER_ZAP_BPS,
  MAX_ZAP_LOSS_BPS,
  coverBps,
  encodeV3Swap,
  encodeV4Swap,
  fitBps as fitToHoldings,
  quoteV3,
  quoteV4,
  sizeZap,
  zapApprovalsNeeded,
  zapCandidate,
  type SwapCall,
  type ZapQuote,
} from '@/lib/zap';
import { describeWalletError, ensureChain } from '@/lib/wallet';

/** Reads refresh on this cadence: the price for the plan, the balances for the check. */
const REFRESH_MS = 12_000;
/** The tolerance when the builder does not say: one percent. */
export const DEFAULT_SLIPPAGE_BPS = 100;
const DEADLINE_SECONDS = 20 * 60;
const PLACEHOLDER_OWNER = '0x0000000000000000000000000000000000000001';
/** Ether held back from a wrap so the mint that follows can still pay its gas. */
const WRAP_GAS_RESERVE_WEI = 1_000_000_000_000_000n; // 0.001 ETH
/** Ether a native-quoted plan leaves in the wallet for gas: the swap's, the approvals' and the mint's. */
export const GAS_RESERVE_WEI = 500_000_000_000_000n; // 0.0005 ETH

export type MintStep =
  | 'simulated' // no pool on chain to mint into
  | 'connect'
  /** A wallet is connected, and it is on another network. Nothing is sent until it switches. */
  | 'wrong-chain'
  | 'reading'
  | 'unavailable'
  /** The market is quoted in aeWETH and the wallet is short of it, but holds the ether to wrap. */
  | 'wrap'
  /**
   * The wallet holds one side and not the other: step 1 of 2 swaps part of
   * what it holds, in this same pool, and the mint follows (§33).
   */
  | 'zap'
  | 'approve'
  | 'ready'
  | 'busy';

export interface MintSides {
  /** Which side of the key is the token the builder is about; the other is the quote. */
  tokenIsCurrency0: boolean;
  tokenDecimals: number;
  quoteDecimals: number;
  tokenCurrency: Address;
  quoteCurrency: Address;
}

export interface MintFlow {
  key: PoolKey | null;
  sides: MintSides | null;
  /**
   * The live price, and the liquidity active at it — what a new position's
   * share of each swap's fee is measured against. `activeLiquidity` is null
   * when the node did not answer that read; the price still stands.
   */
  live: (Slot0 & { tokenPriceInQuote: number; activeLiquidity: bigint | null }) | null;
  liveError: string | null;
  plan: MintPlan | null;
  planError: string | null;
  /** The two amounts the plan takes, in the builder's terms. */
  needs: { token: bigint; quote: bigint } | null;
  balances: { token: bigint; quote: bigint; native: bigint } | null;
  /**
   * What is missing to enter a market quoted in the wrapper, when the wallet
   * holds the ether to cover it. Null everywhere else — a native market
   * spends the balance directly, and a wallet without the ether is short
   * whatever it wraps.
   */
  wrap: { shortfall: bigint } | null;
  /**
   * The ether this wallet could put into this market, as one figure.
   *
   * The page names both a native and a wrapped market ETH, because one
   * aeWETH is one ether (§18), so "your balance" has to mean the same thing
   * on both. For a wrapped market that is the wrapped balance plus the
   * ether that could be wrapped for it, less the gas the mint still has to
   * pay for. Null until the balances have been read.
   */
  quoteSpendable: bigint | null;
  /**
   * The swap that comes before the mint, when the wallet holds only one side.
   * `quote` is null while it is being priced; `problem` says why it cannot be
   * offered (too thin a pool, not enough to swap from) — the page shows it
   * instead of a button that would fail.
   */
  zap: {
    direction: ZapQuote['direction'];
    quote: ZapQuote | null;
    approvals: ApprovalStep[];
    gas: bigint | null;
    problem: string | null;
    /** The swap's input is sent as ether rather than pulled as a token. */
    payWithEther: boolean;
  } | null;
  /**
   * The plan was scaled to what the wallet holds: `bps` of the deposit typed.
   * Only a small shortfall is fitted — 2%, or 15% right after a swap, whose
   * fee and impact are exactly that — and the page says so.
   */
  fitted: { bps: number } | null;
  step: MintStep;
  busyLabel: string | null;
  approvals: ApprovalStep[];
  gas: bigint | null;
  error: string | null;
  result: { hash: `0x${string}`; minted: number } | null;
  run: () => Promise<void>;
}

/**
 * A pool key's identity as a string, so the flow can tell "the same pool"
 * from "the same pool, in a new snapshot".
 *
 * The live provider replaces the whole snapshot on every push, and the
 * snapshot query builds a fresh `key` object for every pool each time. Keyed
 * on the object, every effect below re-ran on every push — a few seconds
 * apart on a live box — resetting the price to "Reading the pool…", the
 * approvals, the dry run, and a mint's own result while the person was
 * looking at it. The pool did not change; only the object did.
 */
function keyIdentity(info: PoolKeyInfo | undefined): string | null {
  if (!info) return null;
  return [info.currency0, info.currency1, info.fee, info.tickSpacing, info.hooks, info.decimals0, info.decimals1]
    .join('|')
    .toLowerCase();
}

export function useMintFlow(args: {
  pool: Pool;
  deposit: string;
  minPct: number;
  maxPct: number;
  bins: number;
  shape: ShapeId;
  /** One full-range position — a stake — instead of a shaped range. */
  fullRange?: boolean;
  /** How much more than the plan's amounts the mint may take before it reverts. */
  slippageBps?: number;
  valid: boolean;
}): MintFlow {
  const { pool, deposit, minPct, maxPct, bins, shape, valid } = args;
  const fullRange = args.fullRange ?? false;
  const slippageBps = args.slippageBps ?? DEFAULT_SLIPPAGE_BPS;
  const { wallet, openWallet, showToast } = useUi();
  const [live, setLive] = useState<(Slot0 & { tokenPriceInQuote: number; activeLiquidity: bigint | null }) | null>(null);
  const [liveError, setLiveError] = useState<string | null>(null);
  const [balances, setBalances] = useState<{ token: bigint; quote: bigint; native: bigint } | null>(null);
  const [approvals, setApprovals] = useState<ApprovalStep[]>([]);
  const [gas, setGas] = useState<bigint | null>(null);
  const [busyLabel, setBusyLabel] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ hash: `0x${string}`; minted: number } | null>(null);
  // The pool this browser just swapped into, so the mint that follows may be
  // fitted to what the swap delivered — and so a second swap is not offered
  // for the few wei the first one's fee left short.
  const [zappedKey, setZappedKey] = useState<string | null>(null);
  // Bumped after a transaction so the reads run again without waiting for the cadence.
  const [refreshTick, setRefreshTick] = useState(0);

  // One key object per pool identity, whatever the snapshot does.
  const keyId = keyIdentity(pool.key);
  const stable = useRef<{ id: string | null; key: PoolKey | null; info: PoolKeyInfo | null }>({
    id: null,
    key: null,
    info: null,
  });
  if (stable.current.id !== keyId) {
    stable.current = { id: keyId, key: pool.key ? toPoolKey(pool.key) : null, info: pool.key ?? null };
  }
  const key = stable.current.key;
  const info = stable.current.info;
  const tokenAddress = pool.token.address.toLowerCase();
  /**
   * Which of Uniswap's position managers this pool is minted through.
   *
   * A token's ether market on this chain is often a v3 pool — VIRTUAL's is —
   * and for three rounds of questions the builder answered by not offering
   * it. v3's NonfungiblePositionManager is deployed here; the planner and
   * the encoder for it are byte-compared with Uniswap's own SDK in
   * `lib/v3/mint.test.ts`.
   */
  const venue: 'v3' | 'v4' = pool.protocol === 'v3' ? 'v3' : 'v4';
  const v3Pool = pool.address as Address;

  const sides = useMemo<MintSides | null>(() => {
    if (!key || !info) return null;
    const tokenIsCurrency0 = tokenAddress === key.currency0.toLowerCase();
    return {
      tokenIsCurrency0,
      tokenDecimals: tokenIsCurrency0 ? info.decimals0 : info.decimals1,
      quoteDecimals: tokenIsCurrency0 ? info.decimals1 : info.decimals0,
      tokenCurrency: tokenIsCurrency0 ? key.currency0 : key.currency1,
      quoteCurrency: tokenIsCurrency0 ? key.currency1 : key.currency0,
    };
  }, [key, info, tokenAddress]);

  const provider = wallet?.provider ?? null;
  const owner = (wallet?.address ?? null) as Address | null;

  // Which network the wallet is on, and every switch it makes afterwards
  // (useWalletChainId): nothing is sent until it is on this chain.
  const { chainId, refresh: refreshChainId } = useWalletChainId(provider);
  const onChain = chainId === CHAIN.id;
  // Reads go through the wallet only while it is on this chain. On another
  // network its provider would answer for the wrong chain — StateView is not
  // there — so the public RPC answers instead and the price still shows.
  const readVia = onChain ? provider : null;

  // A different pool: the last mint's outcome belongs to the old one.
  useEffect(() => {
    setResult(null);
    setError(null);
  }, [key]);

  // The live price, from the chain, on a cadence.
  useEffect(() => {
    setLive(null);
    setLiveError(null);
    if (!key || !sides || !info) return;
    let cancelled = false;
    const client = readClient(readVia);
    const tick = async () => {
      try {
        const [slot0, activeLiquidity] = await Promise.all([
          venue === 'v3' ? readV3Slot0(client, v3Pool) : readSlot0(client, key),
          venue === 'v3' ? readV3ActiveLiquidity(client, v3Pool) : readActiveLiquidity(client, key),
        ]);
        if (cancelled) return;
        const p = priceFromSqrt(slot0.sqrtPriceX96, info.decimals0, info.decimals1);
        setLive({ ...slot0, activeLiquidity, tokenPriceInQuote: sides.tokenIsCurrency0 ? p : 1 / p });
        setLiveError(null);
      } catch (e) {
        if (!cancelled) setLiveError(describeTxError(e));
      }
    };
    void tick();
    const id = setInterval(tick, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [key, sides, info, readVia, refreshTick, venue, v3Pool]);

  // Balances, when there is a wallet to read for.
  useEffect(() => {
    setBalances(null);
    if (!owner || !sides) return;
    let cancelled = false;
    const client = readClient(readVia);
    const tick = async () => {
      try {
        const [token, quote, native] = await Promise.all([
          readBalance(client, owner, sides.tokenCurrency),
          readBalance(client, owner, sides.quoteCurrency),
          // What the wallet shows as its balance. It is the quote for a
          // native market, and what a wrapped one has to be wrapped from.
          readBalance(client, owner, NATIVE_ETH as Address),
        ]);
        if (!cancelled) setBalances({ token, quote, native });
      } catch {
        /* the check simply waits for the next read */
      }
    };
    void tick();
    const id = setInterval(tick, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [owner, sides, readVia, refreshTick]);

  // The plan, at the live price. Owner is only stamped in at send time.
  const depositRaw = sides ? toRaw(deposit, sides.quoteDecimals) : 0n;

  /**
   * The v3 manager's own wrapper. Paying the wrapped side in ether relies on
   * the manager wrapping what it is sent, which it does only for its own
   * `WETH9()`. Uniswap's registry names aeWETH for this chain, and the dry
   * run would refuse a mismatch anyway; this makes a known mismatch a plain
   * "hold the wrapped token" rather than a mint that cannot be prepared.
   * Unknown (not yet read, or unanswered) is left to the dry run.
   */
  const [v3Weth9, setV3Weth9] = useState<string | null>(null);
  useEffect(() => {
    if (venue !== 'v3') return;
    let cancelled = false;
    void readV3Weth9(readClient(readVia)).then((address) => {
      if (!cancelled && address) setV3Weth9(address.toLowerCase());
    });
    return () => {
      cancelled = true;
    };
  }, [venue, readVia]);
  const v3WrapsEther = v3Weth9 === null || v3Weth9 === CONTRACTS.weth.toLowerCase();

  const v3PoolInfo = useMemo(
    () =>
      key && info
        ? {
            address: v3Pool,
            token0: key.currency0,
            token1: key.currency1,
            fee: key.fee,
            tickSpacing: key.tickSpacing,
            decimals0: info.decimals0,
            decimals1: info.decimals1,
          }
        : null,
    [key, info, v3Pool],
  );

  /**
   * The plan, and — for a v3 pool quoted in the wrapper — whether it pays that
   * side in ether.
   *
   * The v3 manager is payable and wraps what it is sent, all of it or none:
   * `pay` cannot mix a wrapped balance with a wrap, so it is one decision for
   * the whole side. The wrapped balance is spent when it covers what the
   * plan takes, because that costs no ether; ether pays when it does not,
   * which is what lets a wallet holding only ETH enter a v3 pair at all
   * (§27). The decision is made against the plan's own quote amount — the
   * amount the manager will pull — not the deposit figure, which it can
   * exceed by the rounding of each bin.
   */
  const makePlanned = useCallback((depositQuote: bigint) => {
    if (!key || !sides || !live || !valid || depositQuote <= 0n) return null;
    const common = {
      sqrtPriceX96: live.sqrtPriceX96,
      tick: live.tick,
      tokenIsCurrency0: sides.tokenIsCurrency0,
      depositQuote,
      minPct,
      maxPct,
      bins,
      shape,
      fullRange,
      owner: (owner ?? PLACEHOLDER_OWNER) as Address,
      slippageBps,
      deadline: BigInt(Math.floor(Date.now() / 1000) + DEADLINE_SECONDS),
    };
    try {
      if (venue === 'v3' && v3PoolInfo) {
        const base = planV3Mint({ ...common, pool: v3PoolInfo });
        const quoteIsWrapped = sides.quoteCurrency.toLowerCase() === CONTRACTS.weth.toLowerCase();
        return {
          base: { ...base, unlockData: '0x' as Hex } as MintPlan,
          // The same plan paid in ether: same amounts, a value and a refund.
          withEther: quoteIsWrapped && v3WrapsEther
            ? ({ ...planV3Mint({ ...common, pool: v3PoolInfo, payWithEtherFor: CONTRACTS.weth as Address }), unlockData: '0x' as Hex } as MintPlan)
            : null,
          quoteNeed: sides.tokenIsCurrency0 ? base.amount1 : base.amount0,
          error: null,
        };
      }
      return { base: planMint({ ...common, key }), withEther: null, quoteNeed: 0n, error: null };
    } catch (e) {
      return { base: null, withEther: null, quoteNeed: 0n, error: (e as Error).message };
    }
  }, [key, sides, live, valid, minPct, maxPct, bins, shape, fullRange, owner, slippageBps, venue, v3PoolInfo, v3WrapsEther]);

  const planned0 = useMemo(() => makePlanned(depositRaw), [makePlanned, depositRaw]);

  /** What the wallet can put against each side, with gas kept back from native ether. */
  const quoteIsNative = sides ? sides.quoteCurrency.toLowerCase() === NATIVE_ETH : false;
  const quoteAvailable = useMemo(() => {
    if (!sides || !balances) return null;
    const wrappable = balances.native > WRAP_GAS_RESERVE_WEI ? balances.native - WRAP_GAS_RESERVE_WEI : 0n;
    let spendable = balances.quote;
    if (sides.quoteCurrency.toLowerCase() === CONTRACTS.weth.toLowerCase()) {
      spendable = venue === 'v3' ? (!v3WrapsEther || balances.quote > wrappable ? balances.quote : wrappable) : balances.quote + wrappable;
    }
    if (quoteIsNative) return spendable > GAS_RESERVE_WEI ? spendable - GAS_RESERVE_WEI : 0n;
    return spendable;
  }, [sides, balances, venue, v3WrapsEther, quoteIsNative]);

  const zapped = zappedKey !== null && zappedKey === keyId;
  const holdings = useMemo(() => {
    const base = planned0?.base;
    if (!base || !sides || !balances || quoteAvailable === null) return null;
    return {
      needToken: sides.tokenIsCurrency0 ? base.amount0 : base.amount1,
      needQuote: sides.tokenIsCurrency0 ? base.amount1 : base.amount0,
      haveToken: balances.token,
      haveQuote: quoteAvailable,
    };
  }, [planned0, sides, balances, quoteAvailable]);

  // A small shortfall is fitted rather than refused (see `fitted`).
  const fit = holdings ? fitToHoldings(holdings, zapped) : null;
  const planned = useMemo(
    () => (fit ? makePlanned((depositRaw * BigInt(fit)) / 10_000n) : planned0),
    [fit, makePlanned, depositRaw, planned0],
  );

  /**
   * The zap, when the wallet holds one side and has more of it than the plan
   * takes — in every venue: a v4 pool quoted in the wrapper is swapped into
   * with ETH wrapped inside the same router call (§35). Not twice in a row.
   */
  const candidate = useMemo(() => {
    if (!holdings || fit || zapped || !owner) return null;
    if (coverBps(holdings) >= 10_000) return null;
    return zapCandidate(holdings);
  }, [holdings, fit, zapped, owner]);
  const candidateId = candidate ? `${candidate.direction}|${candidate.want}` : null;

  // A primitive, so a balance re-read that changes nothing about the
  // decision does not produce a new plan (and a new dry run) every cadence.
  const v3PaysEther: Address | null =
    planned?.withEther && balances && balances.quote < planned.quoteNeed ? (CONTRACTS.weth as Address) : null;
  const plan: MintPlan | null = planned ? (v3PaysEther ? planned.withEther : planned.base) : null;
  const planError = planned?.error ?? null;

  const needs = useMemo(() => {
    if (!plan || !sides) return null;
    return sides.tokenIsCurrency0
      ? { token: plan.amount0, quote: plan.amount1 }
      : { token: plan.amount1, quote: plan.amount0 };
  }, [plan, sides]);

  /**
   * Wrapping, when the market is quoted in aeWETH and the wallet is short.
   *
   * ALFA's rule is that a pair is entered with this chain's own ether, not
   * with the wrapper. A v4 pool that holds ether natively already does that;
   * one quoted in aeWETH cannot, unless the shortfall is wrapped first — one
   * `deposit()`, one token per ether, no price and nothing to slip. The gas
   * reserve is held back so wrapping never leaves the wallet unable to pay
   * for the mint that follows it.
   */
  const wrap = useMemo(() => {
    // Not for v3: its manager is payable and wraps what it is sent, in the
    // mint itself, so a separate transaction would only cost a signature.
    if (venue === 'v3') return null;
    // The swap comes first when one is due: it is paid from the ether, and
    // the wrap for the mint is sized once the swap has landed.
    if (candidateId) return null;
    if (!sides || !needs || !plan || !balances) return null;
    if (sides.quoteCurrency.toLowerCase() !== CONTRACTS.weth.toLowerCase()) return null;
    const shortfall = wrapShortfall({
      planned: needs.quote,
      cap: sides.tokenIsCurrency0 ? plan.amount1Max : plan.amount0Max,
      positions: plan.positions.length,
      wrappedBalance: balances.quote,
      nativeBalance: balances.native,
      reserve: WRAP_GAS_RESERVE_WEI,
    });
    if (shortfall === null) return null;
    return { shortfall };
  }, [venue, sides, needs, plan, balances, candidateId]);

  /** One "your balance" for an ether market, whichever way the pool holds it. */
  const quoteSpendable = useMemo(() => {
    if (!sides || !balances) return null;
    if (sides.quoteCurrency.toLowerCase() !== CONTRACTS.weth.toLowerCase()) return balances.quote;
    const wrappable = balances.native > WRAP_GAS_RESERVE_WEI ? balances.native - WRAP_GAS_RESERVE_WEI : 0n;
    // A v3 mint pays the side in the wrapped token OR in ether, never a mix
    // (see `v3PaysEther`), so what it can spend is the larger of the two —
    // not their sum, which would pass a deposit neither could cover alone.
    if (venue === 'v3') return !v3WrapsEther || balances.quote > wrappable ? balances.quote : wrappable;
    return balances.quote + wrappable;
  }, [sides, balances, venue, v3WrapsEther]);

  // Approvals and a dry run, whenever the plan or the wallet changes — and
  // only on this chain: an allowance read or an estimate on another network
  // is an answer about a different contract.
  useEffect(() => {
    setApprovals([]);
    setGas(null);
    // While a swap is still to come the mint cannot be dry-run: the wallet
    // does not hold what it takes yet, and the node would say so.
    if (!plan || !owner || !key || !onChain || candidateId) return;
    let cancelled = false;
    const client = readClient(readVia);
    void (async () => {
      try {
        const steps =
          venue === 'v3'
            ? (
                await v3ApprovalsNeeded(
                  client,
                  owner,
                  {
                    token0: key.currency0,
                    token1: key.currency1,
                    amount0: plan.amount0,
                    amount1: plan.amount1,
                  },
                  v3PaysEther,
                )
              ).map((a) => ({ kind: 'erc20' as const, token: a.token }))
            : await approvalsNeeded(client, owner, key, plan, Math.floor(Date.now() / 1000));
        if (cancelled) return;
        setApprovals(steps);
        if (steps.length === 0 && !wrap) {
          const estimate =
            venue === 'v3'
              ? await simulateV3Mint(client, owner, plan)
              : await simulateMint(client, owner, plan);
          if (!cancelled) {
            setGas(estimate);
            setError(null);
          }
        }
      } catch (e) {
        if (!cancelled) setError(describeTxError(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [plan, owner, key, readVia, onChain, wrap, venue, v3PaysEther, candidateId]);

  // ------------------------------------------------------------ the zap --
  const quoteSymbol = quoteLabel(pool);
  const [zapState, setZapState] = useState<{
    id: string;
    quote: ZapQuote | null;
    approvals: ApprovalStep[];
    gas: bigint | null;
    problem: string | null;
    payWithEther: boolean;
  } | null>(null);

  /** The swap's two currencies and whether its input goes as ether. */
  const zapRoute = useCallback(
    (direction: ZapQuote['direction'], amountIn: bigint) => {
      if (!sides || !key || !balances) return null;
      const tokenIn = direction === 'quote-to-token' ? sides.quoteCurrency : sides.tokenCurrency;
      const tokenOut = direction === 'quote-to-token' ? sides.tokenCurrency : sides.quoteCurrency;
      const zeroForOne = tokenIn.toLowerCase() === key.currency0.toLowerCase();
      // v3 holds wrapped ether; SwapRouter02 wraps ether it is sent, so a
      // wallet short of the wrapper pays in ETH — the same rule as the mint.
      const inIsWeth = tokenIn.toLowerCase() === CONTRACTS.weth.toLowerCase();
      const spareEther = balances.native > GAS_RESERVE_WEI ? balances.native - GAS_RESERVE_WEI : 0n;
      // v4 quoted in the wrapper: the Universal Router wraps the ETH sent and
      // swaps it in one call (encodeV4Swap's `wrapEtherIn`), no approval —
      // preferred whenever the ether covers it.
      const payWithEther =
        venue === 'v3'
          ? inIsWeth && v3WrapsEther && balances.quote < amountIn && spareEther >= amountIn
          : inIsWeth && spareEther >= amountIn;
      return { tokenIn, tokenOut, zeroForOne, payWithEther };
    },
    [sides, key, balances, venue, v3WrapsEther],
  );

  const buildSwap = useCallback(
    (q: ZapQuote, route: NonNullable<ReturnType<typeof zapRoute>>, recipient: Address): SwapCall | null => {
      if (!key) return null;
      const deadline = BigInt(Math.floor(Date.now() / 1000) + DEADLINE_SECONDS);
      return venue === 'v3'
        ? encodeV3Swap({
            tokenIn: route.tokenIn,
            tokenOut: route.tokenOut,
            fee: key.fee,
            recipient,
            amountIn: q.amountIn,
            amountOutMinimum: q.minOut,
            deadline,
            payWithEther: route.payWithEther,
          })
        : encodeV4Swap({ key, zeroForOne: route.zeroForOne, amountIn: q.amountIn, amountOutMinimum: q.minOut, deadline, wrapEtherIn: route.payWithEther });
    },
    [key, venue],
  );

  // Price the swap, check what it costs and that the mint after it can be
  // made, read its approvals and dry-run it — on the same cadence as the price.
  useEffect(() => {
    if (!candidate || !candidateId || !holdings || !sides || !key || !live || !owner) {
      setZapState(null);
      return;
    }
    let cancelled = false;
    const client = readClient(readVia);
    setZapState((z) => (z && z.id === candidateId ? z : { id: candidateId, quote: null, approvals: [], gas: null, problem: null, payWithEther: false }));
    void (async () => {
      const fail = (problem: string) => {
        if (!cancelled) setZapState({ id: candidateId, quote: null, approvals: [], gas: null, problem, payWithEther: false });
      };
      try {
        const surplus =
          candidate.direction === 'quote-to-token' ? holdings.haveQuote - holdings.needQuote : holdings.haveToken - holdings.needToken;
        const firstRoute = zapRoute(candidate.direction, 0n);
        if (!firstRoute) return;
        const quote = sizeZap({
          direction: candidate.direction,
          want: candidate.want,
          surplus,
          sqrtPriceX96: live.sqrtPriceX96,
          tokenIsCurrency0: sides.tokenIsCurrency0,
          feePips: key.fee,
          slippageBps,
          quote: (amountIn) =>
            venue === 'v3'
              ? quoteV3(client, { tokenIn: firstRoute.tokenIn, tokenOut: firstRoute.tokenOut, fee: key.fee, amountIn })
              : quoteV4(client, { key, zeroForOne: firstRoute.zeroForOne, amountIn }),
        });
        const q = await quote;
        if (cancelled) return;
        if (q.lossBps > MAX_ZAP_LOSS_BPS) {
          fail(
            `Swapping for the other side here would lose ${(q.lossBps / 100).toFixed(1)}% to the pool's fee and price impact — too thin to swap in. Hold both sides, or deposit less.`,
          );
          return;
        }
        // After the swap: does the wallet cover enough of the plan for the
        // mint to be fitted to it? If not, the deposit is simply too large.
        const after =
          candidate.direction === 'quote-to-token'
            ? { ...holdings, haveToken: holdings.haveToken + q.expectedOut, haveQuote: holdings.haveQuote - q.amountIn }
            : { ...holdings, haveToken: holdings.haveToken - q.amountIn, haveQuote: holdings.haveQuote + q.expectedOut };
        const cover = coverBps(after);
        if (cover < 10_000 - FIT_AFTER_ZAP_BPS) {
          const most = (depositRaw * BigInt(cover)) / 10_000n;
          fail(
            `Even after swapping, the wallet covers only ${(cover / 100).toFixed(0)}% of this deposit. Try about ${fmtAmount(most, sides.quoteDecimals)} ${quoteSymbol}.`,
          );
          return;
        }
        const route = zapRoute(candidate.direction, q.amountIn)!;
        const approvalsNow = onChain
          ? await zapApprovalsNeeded(client, owner, venue, route.tokenIn, q.amountIn, route.payWithEther || route.tokenIn.toLowerCase() === NATIVE_ETH, Math.floor(Date.now() / 1000))
          : [];
        let gasNow: bigint | null = null;
        let problem: string | null = null;
        if (onChain && approvalsNow.length === 0) {
          const call = buildSwap(q, route, owner)!;
          try {
            gasNow = await client.estimateGas({ account: owner, to: call.to, data: call.calldata, value: call.value });
          } catch (e) {
            problem = `The swap could not be prepared: ${describeTxError(e)}`;
          }
        }
        if (!cancelled) {
          setZapState({ id: candidateId, quote: q, approvals: approvalsNow, gas: gasNow, problem, payWithEther: route.payWithEther });
        }
      } catch (e) {
        fail(`This pool could not quote the swap: ${describeTxError(e)} Hold both sides for now.`);
      }
    })();
    return () => {
      cancelled = true;
    };
    // `live` is on the price cadence, so the quote is refreshed with it.
  }, [candidate, candidateId, holdings, sides, key, live, owner, readVia, onChain, venue, slippageBps, zapRoute, buildSwap, depositRaw, quoteSymbol]);

  const zap = useMemo(() => {
    if (!candidate) return null;
    const current = zapState?.id === candidateId ? zapState : null;
    return {
      direction: candidate.direction,
      quote: current?.quote ?? null,
      approvals: current?.approvals ?? [],
      gas: current?.gas ?? null,
      problem: current?.problem ?? null,
      payWithEther: current?.payWithEther ?? false,
    };
  }, [candidate, candidateId, zapState]);

  const step: MintStep = !key
    ? 'simulated'
    : !wallet
      ? 'connect'
      : busyLabel
        ? 'busy'
        : chainId === null
          ? 'reading'
          : !onChain
            ? 'wrong-chain'
            : liveError
              ? 'unavailable'
              : !live
                ? 'reading'
                : zap
                  ? 'zap'
                  : wrap
                    ? 'wrap'
                  : approvals.length > 0
                    ? 'approve'
                    : 'ready';

  const run = useCallback(async () => {
    if (step === 'simulated') {
      showToast('Simulated data. Nothing was minted.');
      return;
    }
    if (step === 'connect') {
      openWallet();
      return;
    }
    if (step === 'wrong-chain') {
      if (!provider) return;
      setError(null);
      setBusyLabel('Switching network…');
      try {
        await ensureChain(provider);
        const id = await refreshChainId();
        if (id !== CHAIN.id) setError(`Switch the wallet to ${CHAIN.name} to mint. Nothing was sent.`);
      } catch (e) {
        setError(describeWalletError(e));
      } finally {
        setBusyLabel(null);
      }
      return;
    }
    if (!plan || !owner || !provider || !key || !sides || !onChain) return;
    setError(null);
    setResult(null);
    const client = readClient(provider);
    const pair = `${pool.token.symbol} / ${quoteLabel(pool)}`;
    try {
      // Step 1 of 2: the swap, in this same pool, through Uniswap's router.
      if (step === 'zap') {
        if (!zap?.quote || zap.problem) return;
        const inSymbol = zap.direction === 'quote-to-token' ? quoteLabel(pool) : pool.token.symbol;
        if (zap.approvals.length > 0) {
          const next = zap.approvals[0];
          setBusyLabel('Approve in the wallet…');
          const hash =
            venue === 'v3'
              ? await approveV3(provider, owner, { token: next.token, spender: CONTRACTS.swapRouter02 as Address })
              : await approve(provider, owner, next, Math.floor(Date.now() / 1000));
          recordTx({
            hash,
            kind: 'approve',
            wallet: owner,
            at: Date.now(),
            status: 'pending',
            label:
              venue === 'v3'
                ? `Approve ${inSymbol} for Uniswap's swap router`
                : next.kind === 'erc20'
                  ? `Approve ${inSymbol} for Permit2`
                  : `Allow Uniswap's Universal Router to use ${inSymbol}`,
            poolId: pool.id,
          });
          setBusyLabel('Waiting for the approval…');
          const receipt = await client.waitForTransactionReceipt({ hash });
          updateTx(hash, receipt.status === 'success' ? 'success' : 'reverted');
          if (receipt.status !== 'success') throw new ShownError('The approval reverted on chain.');
          setRefreshTick((n) => n + 1);
          return;
        }
        const route = zapRoute(zap.direction, zap.quote.amountIn);
        const call = route ? buildSwap(zap.quote, route, owner) : null;
        if (!call) return;
        setBusyLabel('Checking the swap with the chain…');
        const estimate = await client.estimateGas({ account: owner, to: call.to, data: call.calldata, value: call.value });
        setBusyLabel('Confirm the swap in the wallet…');
        const hash = await sendCall(provider, owner, { calldata: call.calldata, value: call.value }, estimate, call.to);
        const outSymbol = zap.direction === 'quote-to-token' ? pool.token.symbol : quoteLabel(pool);
        recordTx({
          hash,
          kind: 'swap',
          wallet: owner,
          at: Date.now(),
          status: 'pending',
          label: `Swap ${fmtAmount(zap.quote.amountIn, zap.direction === 'quote-to-token' ? sides.quoteDecimals : sides.tokenDecimals)} ${inSymbol} for ${outSymbol} · ${pair}`,
          poolId: pool.id,
        });
        setBusyLabel('Swapping…');
        const receipt = await client.waitForTransactionReceipt({ hash });
        updateTx(hash, receipt.status === 'success' ? 'success' : 'reverted');
        if (receipt.status !== 'success') throw new ShownError('The swap reverted on chain. Nothing was taken but gas.');
        setZappedKey(keyId);
        showToast(`Swapped. Step 2 of 2: mint the position.`);
        setRefreshTick((n) => n + 1);
        return;
      }
      // Ether into aeWETH, so a market quoted in the wrapper is entered with
      // the ether the wallet holds. Estimated first, like everything else
      // here: a wrapper that will not take a direct deposit says so before a
      // signature is asked for.
      if (wrap) {
        setBusyLabel('Checking with the chain…');
        const estimate = await simulateWrap(client, owner, wrap.shortfall);
        setBusyLabel('Confirm the wrap in the wallet…');
        const hash = await sendWrap(provider, owner, wrap.shortfall, estimate);
        recordTx({
          hash,
          kind: 'wrap',
          wallet: owner,
          at: Date.now(),
          status: 'pending',
          label: `Wrap ${fmtAmount(wrap.shortfall, 18)} ETH to aeWETH`,
          poolId: pool.id,
        });
        setBusyLabel('Wrapping…');
        const receipt = await client.waitForTransactionReceipt({ hash });
        updateTx(hash, receipt.status === 'success' ? 'success' : 'reverted');
        if (receipt.status !== 'success') throw new ShownError('The wrap reverted on chain.');
        setRefreshTick((n) => n + 1);
        return;
      }
      if (approvals.length > 0) {
        const next = approvals[0];
        const symbol = next.token.toLowerCase() === sides.tokenCurrency.toLowerCase() ? pool.token.symbol : quoteLabel(pool);
        setBusyLabel('Approve in the wallet…');
        const hash =
          venue === 'v3'
            ? await approveV3(provider, owner, { token: next.token, spender: CONTRACTS.v3PositionManager as Address })
            : await approve(provider, owner, next, Math.floor(Date.now() / 1000));
        recordTx({
          hash,
          kind: 'approve',
          wallet: owner,
          at: Date.now(),
          status: 'pending',
          label:
            venue === 'v3'
              ? `Approve ${symbol} for Uniswap v3`
              : next.kind === 'erc20'
                ? `Approve ${symbol} for Permit2`
                : `Allow PositionManager to use ${symbol}`,
          poolId: pool.id,
        });
        setBusyLabel('Waiting for the approval…');
        const receipt = await client.waitForTransactionReceipt({ hash });
        updateTx(hash, receipt.status === 'success' ? 'success' : 'reverted');
        if (receipt.status !== 'success') throw new ShownError('The approval reverted on chain.');
        setApprovals((s) => s.slice(1));
        setRefreshTick((n) => n + 1);
        return;
      }
      setBusyLabel('Checking with the chain…');
      // Re-plan at send time with a fresh deadline and the real owner.
      const common = {
        sqrtPriceX96: live!.sqrtPriceX96,
        tick: live!.tick,
        tokenIsCurrency0: sides.tokenIsCurrency0,
        depositQuote: fit ? (depositRaw * BigInt(fit)) / 10_000n : depositRaw,
        minPct,
        maxPct,
        bins,
        shape,
        fullRange,
        owner,
        slippageBps,
        deadline: BigInt(Math.floor(Date.now() / 1000) + DEADLINE_SECONDS),
      };
      const fresh =
        venue === 'v3' && info
          ? planV3Mint({
              ...common,
              pool: {
                address: v3Pool,
                token0: key.currency0,
                token1: key.currency1,
                fee: key.fee,
                tickSpacing: key.tickSpacing,
                decimals0: info.decimals0,
                decimals1: info.decimals1,
              },
              payWithEtherFor: v3PaysEther ?? undefined,
            })
          : planMint({ ...common, key });
      const estimate =
        venue === 'v3' ? await simulateV3Mint(client, owner, fresh) : await simulateMint(client, owner, fresh);
      setBusyLabel('Confirm in the wallet…');
      const hash =
        venue === 'v3'
          ? await sendV3Mint(provider, owner, fresh, estimate)
          : await sendMint(provider, owner, fresh, estimate);
      recordTx({
        hash,
        kind: 'mint',
        wallet: owner,
        at: Date.now(),
        status: 'pending',
        label: fullRange
          ? `Stake full range · ${pair}`
          : `Mint ${fresh.positions.length} position${fresh.positions.length === 1 ? '' : 's'} · ${pair}`,
        poolId: pool.id,
      });
      setBusyLabel('Minting…');
      const done = venue === 'v3' ? await waitForV3Mint(client, hash, owner) : await waitForMint(client, hash, owner);
      // The NFTs it created, so the portfolio can ask the chain about them at
      // once rather than wait for the indexer to reach this block.
      recordMinted(hash, venue, done.tokenIds);
      updateTx(hash, done.ok ? 'success' : 'reverted');
      if (!done.ok) throw new ShownError('The transaction reverted on chain.');
      // The outcome stays on screen: the re-read below refreshes the price
      // and the balances, and must not take the receipt with it. It did —
      // the effect that re-read them also cleared this, so the "minted,
      // view the transaction" line never survived its own success.
      setResult({ hash, minted: done.tokenIds.length });
      showToast(`${done.tokenIds.length} position${done.tokenIds.length === 1 ? '' : 's'} minted to your wallet`);
      setRefreshTick((n) => n + 1);
      // The portfolio shows it once the indexer has read the block; ask now
      // rather than waiting for the poll, and again on the poll's cadence.
      void getProvider().refreshPortfolio?.();
    } catch (e) {
      setError(describeTxError(e));
    } finally {
      setBusyLabel(null);
    }
  }, [step, plan, owner, provider, key, info, sides, onChain, approvals, wrap, zap, zapRoute, buildSwap, keyId, fit, live, depositRaw, minPct, maxPct, bins, shape, fullRange, slippageBps, pool, venue, v3Pool, v3PaysEther, refreshChainId, showToast, openWallet]);

  const fitted = fit ? { bps: fit } : null;
  return { key, sides, live, liveError, plan, planError, needs, balances, wrap, quoteSpendable, zap, fitted, step, busyLabel, approvals, gas, error, result, run };
}
