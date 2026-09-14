'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Address } from 'viem';
import { useUi } from '@/components/providers/UiProvider';
import type { Pool, ShapeId } from '@/lib/data/types';
import {
  approvalsNeeded,
  approve,
  describeTxError,
  readBalance,
  readClient,
  readSlot0,
  sendMint,
  simulateMint,
  waitForMint,
  type ApprovalStep,
  type Slot0,
} from '@/lib/v4/flow';
import { toRaw } from '@/lib/v4/format';
import { planMint, type MintPlan } from '@/lib/v4/mint';
import { priceFromSqrt, toPoolKey, type PoolKey } from '@/lib/v4/pool';

/** Reads refresh on this cadence: the price for the plan, the balances for the check. */
const REFRESH_MS = 12_000;
const SLIPPAGE_BPS = 100;
const DEADLINE_SECONDS = 20 * 60;
const PLACEHOLDER_OWNER = '0x0000000000000000000000000000000000000001';

export type MintStep =
  | 'simulated' // no pool on chain to mint into
  | 'connect'
  | 'reading'
  | 'unavailable'
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
  balances: { token: bigint; quote: bigint } | null;
  step: MintStep;
  busyLabel: string | null;
  approvals: ApprovalStep[];
  gas: bigint | null;
  error: string | null;
  result: { hash: `0x${string}`; minted: number } | null;
  run: () => Promise<void>;
}

export function useMintFlow(args: {
  pool: Pool;
  deposit: string;
  minPct: number;
  maxPct: number;
  bins: number;
  shape: ShapeId;
  valid: boolean;
}): MintFlow {
  const { pool, deposit, minPct, maxPct, bins, shape, valid } = args;
  const { wallet, openWallet, showToast } = useUi();
  const [live, setLive] = useState<(Slot0 & { tokenPriceInQuote: number }) | null>(null);
  const [liveError, setLiveError] = useState<string | null>(null);
  const [balances, setBalances] = useState<{ token: bigint; quote: bigint } | null>(null);
  const [approvals, setApprovals] = useState<ApprovalStep[]>([]);
  const [gas, setGas] = useState<bigint | null>(null);
  const [busyLabel, setBusyLabel] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ hash: `0x${string}`; minted: number } | null>(null);
  // Bumped after a transaction so the reads run again without waiting for the cadence.
  const [refreshTick, setRefreshTick] = useState(0);

  const key = useMemo(() => (pool.key ? toPoolKey(pool.key) : null), [pool.key]);
  const sides = useMemo<MintSides | null>(() => {
    if (!key || !pool.key) return null;
    const tokenIsCurrency0 = pool.token.address.toLowerCase() === key.currency0.toLowerCase();
    return {
      tokenIsCurrency0,
      tokenDecimals: tokenIsCurrency0 ? pool.key.decimals0 : pool.key.decimals1,
      quoteDecimals: tokenIsCurrency0 ? pool.key.decimals1 : pool.key.decimals0,
      tokenCurrency: tokenIsCurrency0 ? key.currency0 : key.currency1,
      quoteCurrency: tokenIsCurrency0 ? key.currency1 : key.currency0,
    };
  }, [key, pool.key, pool.token.address]);

  const provider = wallet?.provider ?? null;
  const owner = (wallet?.address ?? null) as Address | null;

  // The live price, from the chain, on a cadence. A new pool resets it.
  useEffect(() => {
    setLive(null);
    setLiveError(null);
    setResult(null);
    setError(null);
    if (!key || !sides) return;
    let cancelled = false;
    const client = readClient(provider);
    const tick = async () => {
      try {
        const slot0 = await readSlot0(client, key);
        if (cancelled) return;
        const p = priceFromSqrt(slot0.sqrtPriceX96, pool.key!.decimals0, pool.key!.decimals1);
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
  }, [key, sides, provider, refreshTick, pool.key]);

  // Balances, when there is a wallet to read for.
  useEffect(() => {
    setBalances(null);
    if (!owner || !sides) return;
    let cancelled = false;
    const client = readClient(provider);
    const tick = async () => {
      try {
        const [token, quote] = await Promise.all([
          readBalance(client, owner, sides.tokenCurrency),
          readBalance(client, owner, sides.quoteCurrency),
        ]);
        if (!cancelled) setBalances({ token, quote });
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
  }, [owner, sides, provider, refreshTick]);

  // The plan, at the live price. Owner is only stamped in at send time.
  const depositRaw = sides ? toRaw(deposit, sides.quoteDecimals) : 0n;
  const { plan, planError } = useMemo(() => {
    if (!key || !sides || !live || !valid || depositRaw <= 0n) return { plan: null, planError: null };
    try {
      return {
        plan: planMint({
          key,
          sqrtPriceX96: live.sqrtPriceX96,
          tick: live.tick,
          tokenIsCurrency0: sides.tokenIsCurrency0,
          depositQuote: depositRaw,
          minPct,
          maxPct,
          bins,
          shape,
          owner: (owner ?? PLACEHOLDER_OWNER) as Address,
          slippageBps: SLIPPAGE_BPS,
          deadline: BigInt(Math.floor(Date.now() / 1000) + DEADLINE_SECONDS),
        }),
        planError: null,
      };
    } catch (e) {
      return { plan: null, planError: (e as Error).message };
    }
  }, [key, sides, live, valid, depositRaw, minPct, maxPct, bins, shape, owner]);

  const needs = useMemo(() => {
    if (!plan || !sides) return null;
    return sides.tokenIsCurrency0
      ? { token: plan.amount0, quote: plan.amount1 }
      : { token: plan.amount1, quote: plan.amount0 };
  }, [plan, sides]);

  // Approvals and a dry run, whenever the plan or the wallet changes.
  useEffect(() => {
    setApprovals([]);
    setGas(null);
    if (!plan || !owner || !key) return;
    let cancelled = false;
    const client = readClient(provider);
    void (async () => {
      try {
        const steps = await approvalsNeeded(client, owner, key, plan, Math.floor(Date.now() / 1000));
        if (cancelled) return;
        setApprovals(steps);
        if (steps.length === 0) {
          const estimate = await simulateMint(client, owner, plan);
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
  }, [plan, owner, key, provider]);

  const step: MintStep = !key
    ? 'simulated'
    : !wallet
      ? 'connect'
      : busyLabel
        ? 'busy'
        : liveError
          ? 'unavailable'
          : !live
            ? 'reading'
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
    if (!plan || !owner || !provider || !key || !sides) return;
    setError(null);
    setResult(null);
    const client = readClient(provider);
    try {
      if (approvals.length > 0) {
        const next = approvals[0];
        setBusyLabel('Approve in the wallet…');
        const hash = await approve(provider, owner, next, Math.floor(Date.now() / 1000));
        setBusyLabel('Waiting for the approval…');
        await client.waitForTransactionReceipt({ hash });
        setApprovals((s) => s.slice(1));
        setRefreshTick((n) => n + 1);
        return;
      }
      setBusyLabel('Checking with the chain…');
      // Re-plan at send time with a fresh deadline and the real owner.
      const fresh = planMint({
        key,
        sqrtPriceX96: live!.sqrtPriceX96,
        tick: live!.tick,
        tokenIsCurrency0: sides.tokenIsCurrency0,
        depositQuote: depositRaw,
        minPct,
        maxPct,
        bins,
        shape,
        owner,
        slippageBps: SLIPPAGE_BPS,
        deadline: BigInt(Math.floor(Date.now() / 1000) + DEADLINE_SECONDS),
      });
      const estimate = await simulateMint(client, owner, fresh);
      setBusyLabel('Confirm in the wallet…');
      const hash = await sendMint(provider, owner, fresh, estimate);
      setBusyLabel('Minting…');
      const done = await waitForMint(client, hash, owner);
      if (!done.ok) throw new Error('The transaction reverted on chain.');
      setResult({ hash, minted: done.tokenIds.length });
      showToast(`${done.tokenIds.length} position${done.tokenIds.length === 1 ? '' : 's'} minted to your wallet`);
      setRefreshTick((n) => n + 1);
    } catch (e) {
      setError(describeTxError(e));
    } finally {
      setBusyLabel(null);
    }
  }, [step, plan, owner, provider, key, sides, approvals, live, depositRaw, minPct, maxPct, bins, shape, showToast, openWallet]);

  return { key, sides, live, liveError, plan, planError, needs, balances, step, busyLabel, approvals, gas, error, result, run };
}

