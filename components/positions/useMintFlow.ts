'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Address, Hex } from 'viem';
import { useUi } from '@/components/providers/UiProvider';
import { useWalletChainId } from '@/components/providers/useWalletChainId';
import { CHAIN, CONTRACTS, NATIVE_ETH } from '@/lib/chain';
import { getProvider } from '@/lib/data';
import type { Pool, PoolKeyInfo, ShapeId } from '@/lib/data/types';
import { quoteLabel } from '@/lib/format';
import { recordTx, updateTx } from '@/lib/tx-history';
import {
  approvalsNeeded,
  approve,
  describeTxError,
  readBalance,
  readClient,
  readSlot0,
  sendMint,
  sendWrap,
  simulateMint,
  simulateWrap,
  waitForMint,
  type ApprovalStep,
  type Slot0,
} from '@/lib/v4/flow';
import { amount as fmtAmount, toRaw } from '@/lib/v4/format';
import { planMint, type MintPlan } from '@/lib/v4/mint';
import { priceFromSqrt, toPoolKey, type PoolKey } from '@/lib/v4/pool';
import {
  approveV3,
  readV3Slot0,
  sendV3Mint,
  simulateV3Mint,
  v3ApprovalsNeeded,
  waitForV3Mint,
} from '@/lib/v3/flow';
import { planV3Mint } from '@/lib/v3/mint';
import { describeWalletError, ensureChain } from '@/lib/wallet';

/** Reads refresh on this cadence: the price for the plan, the balances for the check. */
const REFRESH_MS = 12_000;
/** The tolerance when the builder does not say: one percent. */
export const DEFAULT_SLIPPAGE_BPS = 100;
const DEADLINE_SECONDS = 20 * 60;
const PLACEHOLDER_OWNER = '0x0000000000000000000000000000000000000001';
/** Ether held back from a wrap so the mint that follows can still pay its gas. */
const WRAP_GAS_RESERVE_WEI = 1_000_000_000_000_000n; // 0.001 ETH

export type MintStep =
  | 'simulated' // no pool on chain to mint into
  | 'connect'
  /** A wallet is connected, and it is on another network. Nothing is sent until it switches. */
  | 'wrong-chain'
  | 'reading'
  | 'unavailable'
  /** The market is quoted in aeWETH and the wallet is short of it, but holds the ether to wrap. */
  | 'wrap'
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
  live: (Slot0 & { tokenPriceInQuote: number }) | null;
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
  const [live, setLive] = useState<(Slot0 & { tokenPriceInQuote: number }) | null>(null);
  const [liveError, setLiveError] = useState<string | null>(null);
  const [balances, setBalances] = useState<{ token: bigint; quote: bigint; native: bigint } | null>(null);
  const [approvals, setApprovals] = useState<ApprovalStep[]>([]);
  const [gas, setGas] = useState<bigint | null>(null);
  const [busyLabel, setBusyLabel] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ hash: `0x${string}`; minted: number } | null>(null);
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
        const slot0 = venue === 'v3' ? await readV3Slot0(client, v3Pool) : await readSlot0(client, key);
        if (cancelled) return;
        const p = priceFromSqrt(slot0.sqrtPriceX96, info.decimals0, info.decimals1);
        setLive({ ...slot0, tokenPriceInQuote: sides.tokenIsCurrency0 ? p : 1 / p });
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
   * Whether a v3 mint pays its wrapped-ether side in ether.
   *
   * The manager is payable and wraps what it is sent, all of it or none —
   * `_pay` cannot mix a balance with a wrap — so this is one decision for
   * the whole side. The wrapped balance is spent when it covers the mint,
   * because that costs no ether and needs no wrapping; ether pays when it
   * does not, which is what lets a wallet holding only ETH enter a v3 pair
   * at all (§27).
   */
  const v3PaysEther = useMemo(() => {
    if (venue !== 'v3' || !sides || !balances) return null;
    const wrapped = CONTRACTS.weth.toLowerCase();
    if (sides.quoteCurrency.toLowerCase() !== wrapped) return null;
    return balances.quote >= depositRaw ? null : (CONTRACTS.weth as Address);
  }, [venue, sides, balances, depositRaw]);

  const { plan, planError } = useMemo(() => {
    if (!key || !sides || !live || !valid || depositRaw <= 0n) return { plan: null, planError: null };
    const common = {
      sqrtPriceX96: live.sqrtPriceX96,
      tick: live.tick,
      tokenIsCurrency0: sides.tokenIsCurrency0,
      depositQuote: depositRaw,
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
      if (venue === 'v3' && info) {
        const v3 = planV3Mint({
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
        });
        return { plan: { ...v3, unlockData: '0x' as Hex }, planError: null };
      }
      return { plan: planMint({ ...common, key }), planError: null };
    } catch (e) {
      return { plan: null, planError: (e as Error).message };
    }
  }, [key, info, sides, live, valid, depositRaw, minPct, maxPct, bins, shape, fullRange, owner, slippageBps, venue, v3Pool, v3PaysEther]);

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
    if (!sides || !needs || !balances) return null;
    if (sides.quoteCurrency.toLowerCase() !== CONTRACTS.weth.toLowerCase()) return null;
    if (balances.quote >= needs.quote) return null;
    const shortfall = needs.quote - balances.quote;
    if (balances.native < shortfall + WRAP_GAS_RESERVE_WEI) return null;
    return { shortfall };
  }, [venue, sides, needs, balances]);

  /** One "your balance" for an ether market, whichever way the pool holds it. */
  const quoteSpendable = useMemo(() => {
    if (!sides || !balances) return null;
    if (sides.quoteCurrency.toLowerCase() !== CONTRACTS.weth.toLowerCase()) return balances.quote;
    const wrappable = balances.native > WRAP_GAS_RESERVE_WEI ? balances.native - WRAP_GAS_RESERVE_WEI : 0n;
    return balances.quote + wrappable;
  }, [sides, balances]);

  // Approvals and a dry run, whenever the plan or the wallet changes — and
  // only on this chain: an allowance read or an estimate on another network
  // is an answer about a different contract.
  useEffect(() => {
    setApprovals([]);
    setGas(null);
    if (!plan || !owner || !key || !onChain) return;
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
  }, [plan, owner, key, readVia, onChain, wrap, venue, v3PaysEther]);

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
        if (receipt.status !== 'success') throw new Error('The wrap reverted on chain.');
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
        if (receipt.status !== 'success') throw new Error('The approval reverted on chain.');
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
        depositQuote: depositRaw,
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
      updateTx(hash, done.ok ? 'success' : 'reverted');
      if (!done.ok) throw new Error('The transaction reverted on chain.');
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
  }, [step, plan, owner, provider, key, info, sides, onChain, approvals, wrap, live, depositRaw, minPct, maxPct, bins, shape, fullRange, slippageBps, pool, venue, v3Pool, v3PaysEther, refreshChainId, showToast, openWallet]);

  return { key, sides, live, liveError, plan, planError, needs, balances, wrap, quoteSpendable, step, busyLabel, approvals, gas, error, result, run };
}
