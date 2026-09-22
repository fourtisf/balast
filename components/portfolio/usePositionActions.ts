'use client';

import { useCallback, useState } from 'react';
import type { Address, Hex } from 'viem';
import { useUi } from '@/components/providers/UiProvider';
import { useWalletChainId } from '@/components/providers/useWalletChainId';
import { CHAIN } from '@/lib/chain';
import { getProvider } from '@/lib/data';
import type { UserPosition } from '@/lib/data/types';
import { quoteLabel } from '@/lib/format';
import { recordTx, updateTx, type TxKind } from '@/lib/tx-history';
import { readPositionFees } from '@/lib/v4/fees';
import { describeTxError, readClient, readSlot0, sendCall, simulateCall } from '@/lib/v4/flow';
import { planCollect, planWithdraw, type ManagePlan } from '@/lib/v4/manage';
import { toPoolKey } from '@/lib/v4/pool';
import { amountsForLiquidity } from '@/lib/v4/tick-math';
import { describeWalletError, ensureChain } from '@/lib/wallet';

const DEADLINE_SECONDS = 20 * 60;
/** How much less than the chain's own figure a withdrawal may pay before it reverts. */
const WITHDRAW_SLIPPAGE_BPS = 100;

export type ActionKind = Extract<TxKind, 'collect' | 'withdraw'>;

export interface PositionActions {
  /** The position a transaction is in flight for, and what the wallet is being asked. */
  busy: { tokenId: string; label: string } | null;
  /** The last failure, on the row it belongs to. Cleared by the next attempt on that row. */
  error: { tokenId: string; message: string } | null;
  /** The last transaction that landed, for the row's "view" link. */
  done: { tokenId: string; kind: ActionKind; hash: Hex } | null;
  /** Bumped when a transaction lands, so the fee reader re-reads at once. */
  version: number;
  /** Whether the connected wallet is on this chain. Null while unanswered, or with no wallet. */
  onChain: boolean | null;
  collect: (position: UserPosition) => Promise<void>;
  withdraw: (position: UserPosition) => Promise<void>;
}

/**
 * Collect a live position's fees, or withdraw it: one `modifyLiquidities`
 * each through PositionManager (lib/v4/manage.ts), proceeds to the wallet in
 * the same transaction, nothing held by Balast at any point (§20).
 *
 * The same guards as the mint: the wallet has to be on this chain, the node
 * dry-runs the exact calldata before any signature, and a withdrawal's
 * minimums come from the chain's own liquidity and price read a moment
 * before — not from the indexer's figures, which can be days old (§7).
 * Every send is recorded in the browser's history and the portfolio is
 * re-read once the receipt is in.
 */
export function usePositionActions(): PositionActions {
  const { wallet, openWallet, showToast } = useUi();
  const provider = wallet?.provider ?? null;
  const owner = (wallet?.address ?? null) as Address | null;
  const { chainId, refresh } = useWalletChainId(provider);
  const onChain = provider ? chainId === CHAIN.id : null;

  const [busy, setBusy] = useState<PositionActions['busy']>(null);
  const [error, setError] = useState<PositionActions['error']>(null);
  const [done, setDone] = useState<PositionActions['done']>(null);
  const [version, setVersion] = useState(0);

  const run = useCallback(
    async (kind: ActionKind, position: UserPosition) => {
      const live = position.live;
      if (!live) return;
      if (!wallet || !provider || !owner) {
        openWallet();
        return;
      }
      if (busy) return;
      const tokenId = position.tokenId;
      const fail = (message: string) => setError({ tokenId, message });
      setError(null);
      if (live.protocol !== 'v4') {
        fail('This position was not minted through PositionManager; manage it on Uniswap.');
        return;
      }
      try {
        // On this chain first. Declining the switch is not an error; it is
        // the reason nothing was sent, and the row says so.
        if (chainId !== CHAIN.id) {
          setBusy({ tokenId, label: 'Switching network…' });
          try {
            await ensureChain(provider);
          } catch (e) {
            fail(describeWalletError(e));
            return;
          }
          const id = await refresh();
          if (id !== CHAIN.id) {
            fail(`Switch the wallet to ${CHAIN.name} first. Nothing was sent.`);
            return;
          }
        }
        setBusy({ tokenId, label: 'Checking with the chain…' });
        const client = readClient(provider);
        const key = toPoolKey(live.key);
        const id = BigInt(tokenId);
        const deadline = BigInt(Math.floor(Date.now() / 1000) + DEADLINE_SECONDS);
        let plan: ManagePlan;
        if (kind === 'collect') {
          plan = planCollect({ key, tokenId: id, owner, deadline });
        } else {
          // The minimums are what the position holds NOW, by the chain's
          // liquidity at the chain's price, less a tolerance. The indexer's
          // amounts are as of its last block, which during a sync is weeks
          // old: a minimum from those would revert on every withdrawal
          // after a rally, or guard nothing after a fall.
          const [slot0, info] = await Promise.all([
            readSlot0(client, key),
            readPositionFees(client, [{ tokenId: id, key, tickLower: live.tickLower, tickUpper: live.tickUpper }]),
          ]);
          const liquidity = info.get(tokenId)?.liquidity ?? 0n;
          const amounts = amountsForLiquidity({
            sqrtPriceX96: slot0.sqrtPriceX96,
            tickLower: live.tickLower,
            tickUpper: live.tickUpper,
            liquidityDelta: liquidity,
          });
          plan = planWithdraw({
            key,
            tokenId: id,
            owner,
            amount0: amounts.amount0,
            amount1: amounts.amount1,
            slippageBps: WITHDRAW_SLIPPAGE_BPS,
            deadline,
          });
        }
        const gas = await simulateCall(client, owner, plan);
        setBusy({ tokenId, label: 'Confirm in the wallet…' });
        const hash = await sendCall(provider, owner, plan, gas);
        const pair = `${live.token.symbol} / ${quoteLabel(live)}`;
        recordTx({
          hash,
          kind,
          wallet: owner,
          at: Date.now(),
          status: 'pending',
          label: kind === 'collect' ? `Collect fees · ${pair} #${tokenId}` : `Withdraw · ${pair} #${tokenId}`,
          poolId: position.poolId,
          tokenId,
        });
        setBusy({ tokenId, label: kind === 'collect' ? 'Collecting…' : 'Withdrawing…' });
        const receipt = await client.waitForTransactionReceipt({ hash });
        const ok = receipt.status === 'success';
        updateTx(hash, ok ? 'success' : 'reverted');
        if (!ok) throw new Error('The transaction reverted on chain.');
        setDone({ tokenId, kind, hash });
        showToast(kind === 'collect' ? 'Fees collected to your wallet' : 'Position withdrawn to your wallet');
        setVersion((v) => v + 1);
        // The indexer sees the burn or the fee settlement a block later; the
        // portfolio re-reads now and again on its own cadence.
        await getProvider().refreshPortfolio?.();
      } catch (e) {
        fail(describeTxError(e));
      } finally {
        setBusy(null);
      }
    },
    [wallet, provider, owner, busy, chainId, refresh, openWallet, showToast],
  );

  const collect = useCallback((position: UserPosition) => run('collect', position), [run]);
  const withdraw = useCallback((position: UserPosition) => run('withdraw', position), [run]);

  return { busy, error, done, version, onChain, collect, withdraw };
}
