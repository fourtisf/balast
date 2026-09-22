'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { formatUnits } from 'viem';
import { useUi } from '@/components/providers/UiProvider';
import { useWalletChainId } from '@/components/providers/useWalletChainId';
import { CHAIN } from '@/lib/chain';
import type { UserPosition } from '@/lib/data/types';
import { readPositionFees, type FeeQuery } from '@/lib/v4/fees';
import { describeTxError, readClient } from '@/lib/v4/flow';
import { toPoolKey } from '@/lib/v4/pool';

/** Fees accrue on every trade; a half-minute cadence is fresh enough for a figure nobody signs on. */
const REFRESH_MS = 30_000;

export interface LiveFees {
  fees0: bigint;
  fees1: bigint;
  /** The chain's own figure for the position's liquidity, which the fees accrue on. */
  liquidity: bigint;
}

export interface LiveFeesState {
  /** By token id. A position the node did not answer for is absent, not zero (§7). */
  fees: Map<string, LiveFees>;
  /** True while the first read for this set of positions is in flight. */
  reading: boolean;
  error: string | null;
}

/**
 * Uncollected fees for the wallet's live positions, read from StateView.
 *
 * Fees are state, not events (lib/v4/fees.ts), so the indexer cannot know
 * them and the page asks the chain. Reads go through the wallet's own
 * connection while it is on this chain, else the public RPC; either way the
 * figure is the chain's now, not the indexer's then. `version` re-reads at
 * once — after a collect or a withdrawal, when the cadence is too slow to
 * show the row emptied.
 */
export function useLiveFees(positions: UserPosition[], version = 0): LiveFeesState {
  const { wallet } = useUi();
  const provider = wallet?.provider ?? null;
  const { chainId } = useWalletChainId(provider);
  const readVia = chainId === CHAIN.id ? provider : null;

  const live = useMemo(() => positions.filter((p) => p.live), [positions]);
  // Keyed on what the read depends on rather than on the objects: the live
  // provider rebuilds every position object on every snapshot push, and an
  // effect keyed on those would re-read the chain a few seconds apart for
  // positions that had not changed (§22, the builder had the same fault).
  const signature = live
    .map((p) => {
      const k = p.live!.key;
      return [p.tokenId, p.live!.tickLower, p.live!.tickUpper, k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks].join('|');
    })
    .join(',')
    .toLowerCase();
  const liveRef = useRef(live);
  liveRef.current = live;

  const [state, setState] = useState<LiveFeesState>({ fees: new Map(), reading: false, error: null });

  useEffect(() => {
    if (signature === '') {
      setState({ fees: new Map(), reading: false, error: null });
      return;
    }
    let cancelled = false;
    setState((s) => ({ ...s, reading: true }));
    const client = readClient(readVia);
    const queries: FeeQuery[] = liveRef.current.map((p) => ({
      tokenId: BigInt(p.tokenId),
      key: toPoolKey(p.live!.key),
      tickLower: p.live!.tickLower,
      tickUpper: p.live!.tickUpper,
    }));
    const tick = async () => {
      try {
        const answer = await readPositionFees(client, queries);
        if (cancelled) return;
        setState({ fees: answer, reading: false, error: null });
      } catch (e) {
        if (!cancelled) setState((s) => ({ fees: s.fees, reading: false, error: describeTxError(e) }));
      }
    };
    void tick();
    const id = setInterval(tick, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [signature, readVia, version]);

  return state;
}

/**
 * A position's uncollected fees in dollars: each side at the price the
 * portfolio was valued at (LivePosition.priceUsd0/1), so the fee figure and
 * the value figure beside it are in the same dollars. Null when the
 * position has no fee reading yet.
 */
export function feesUsd(position: UserPosition, fees: Map<string, LiveFees>): number | null {
  const entry = fees.get(position.tokenId);
  const live = position.live;
  if (!entry || !live) return null;
  return (
    Number(formatUnits(entry.fees0, live.key.decimals0)) * live.priceUsd0 +
    Number(formatUnits(entry.fees1, live.key.decimals1)) * live.priceUsd1
  );
}
