'use client';

import { useCallback, useRef, useState } from 'react';
import type { Address, Hex } from 'viem';
import { useUi } from '@/components/providers/UiProvider';
import { useWalletChainId } from '@/components/providers/useWalletChainId';
import { CHAIN, CONTRACTS } from '@/lib/chain';
import { getProvider } from '@/lib/data';
import type { UserPosition } from '@/lib/data/types';
import { quoteLabel } from '@/lib/format';
import { positionRef } from '@/lib/position-ref';
import { burnAmountsWithSlippage } from '@/lib/v3/amounts';
import { readV3Slot0 } from '@/lib/v3/flow';
import { planV3Collect, planV3Withdraw } from '@/lib/v3/manage';
import { readV3Fees, readV3Weth9 } from '@/lib/v3/positions';
import { recordTx, updateTx, type TxKind } from '@/lib/tx-history';
import { readPositionFees } from '@/lib/v4/fees';
import { describeTxError, readClient, readSlot0, sendCall, ShownError, simulateCall, type PositionCall } from '@/lib/v4/flow';
import { planCollect, planWithdraw } from '@/lib/v4/manage';
import { toPoolKey } from '@/lib/v4/pool';
import { describeWalletError, ensureChain } from '@/lib/wallet';

const DEADLINE_SECONDS = 20 * 60;
/** How much less than the chain's own figure a withdrawal may pay before it reverts. */
const WITHDRAW_SLIPPAGE_BPS = 100;

export type ActionKind = Extract<TxKind, 'collect' | 'withdraw'>;

export interface PositionActions {
  /**
   * The position a transaction is in flight for, and what the wallet is being
   * asked. `ref` is `positionRef` — manager and token id, since v3 and v4
   * number their NFTs independently.
   */
  busy: { ref: string; label: string } | null;
  /** The last failure, on the row it belongs to. Cleared by the next attempt on that row. */
  error: { ref: string; message: string } | null;
  /** The last transaction that landed, for the row's "view" link. */
  done: { ref: string; kind: ActionKind; hash: Hex } | null;
  /** Bumped when a transaction lands, so the fee reader re-reads at once. */
  version: number;
  /** Whether the connected wallet is on this chain. Null while unanswered, or with no wallet. */
  onChain: boolean | null;
  collect: (position: UserPosition) => Promise<void>;
  withdraw: (position: UserPosition) => Promise<void>;
}

/**
 * Collect a live position's fees, or withdraw it, through the Uniswap manager
 * that minted it: one `modifyLiquidities` on v4's PositionManager
 * (lib/v4/manage.ts), or one `multicall` on v3's NonfungiblePositionManager
 * (lib/v3/manage.ts). Proceeds go to the wallet in the same transaction —
 * an ether side as ETH — and nothing is held by Balast at any point (§20).
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
  // Set synchronously on the click, so a double-click cannot open two wallet
  // prompts for one position before React has re-rendered with `busy`.
  const inFlight = useRef(false);

  const run = useCallback(
    async (kind: ActionKind, position: UserPosition) => {
      const live = position.live;
      if (!live) return;
      if (!wallet || !provider || !owner) {
        openWallet();
        return;
      }
      if (busy || inFlight.current) return;
      inFlight.current = true;
      const tokenId = position.tokenId;
      const ref = positionRef(position);
      const fail = (message: string) => setError({ ref, message });
      setError(null);
      try {
        // On this chain first. Declining the switch is not an error; it is
        // the reason nothing was sent, and the row says so.
        if (chainId !== CHAIN.id) {
          setBusy({ ref, label: 'Switching network…' });
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
        setBusy({ ref, label: 'Checking with the chain…' });
        const client = readClient(provider);
        const key = toPoolKey(live.key);
        const id = BigInt(tokenId);
        const deadline = BigInt(Math.floor(Date.now() / 1000) + DEADLINE_SECONDS);
        const manager = (live.protocol === 'v3' ? CONTRACTS.v3PositionManager : CONTRACTS.positionManager) as Address;
        let plan: PositionCall;
        if (live.protocol === 'v3') {
          // Everything from the chain, now: the pool's price, what the
          // position holds and what a collect would pay. And the manager's
          // own wrapper, so the ether side is only unwrapped by the contract
          // that will actually unwrap it (lib/v3/manage.ts).
          const [slot0, read, weth9] = await Promise.all([
            readV3Slot0(client, live.poolAddress as Address),
            readV3Fees(client, owner, [id]),
            readV3Weth9(client),
          ]);
          const onChain = read.get(tokenId);
          if (!onChain) {
            throw new ShownError(
              'The chain would not say what this position holds — a collect on it did not simulate. Nothing was sent; manage it on Uniswap if this persists.',
            );
          }
          const wrapped = CONTRACTS.weth.toLowerCase();
          const unwrap =
            weth9 !== null &&
            weth9.toLowerCase() === wrapped &&
            (key.currency0.toLowerCase() === wrapped || key.currency1.toLowerCase() === wrapped)
              ? (weth9 as Address)
              : null;
          plan =
            kind === 'collect'
              ? planV3Collect({
                  tokenId: id,
                  token0: key.currency0,
                  token1: key.currency1,
                  owner,
                  unwrap,
                  expected0: onChain.fees0,
                  expected1: onChain.fees1,
                })
              : planV3Withdraw({
                  tokenId: id,
                  token0: key.currency0,
                  token1: key.currency1,
                  owner,
                  unwrap,
                  sqrtPriceX96: slot0.sqrtPriceX96,
                  tickLower: live.tickLower,
                  tickUpper: live.tickUpper,
                  liquidity: onChain.liquidity,
                  // The fees a collect pays now. The withdrawal's own minimums
                  // guard the principal; these only floor the unwrap and sweep.
                  owed0: onChain.fees0,
                  owed1: onChain.fees1,
                  slippageBps: WITHDRAW_SLIPPAGE_BPS,
                  deadline,
                });
        } else if (kind === 'collect') {
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
          if (liquidity === 0n) {
            throw new ShownError('The chain says this position is already empty. Nothing was sent; the page will refresh.');
          }
          // Uniswap's own guard, as the v3 withdrawal uses it: each side priced
          // at the end of the tolerance where it is worth least. A flat cut off
          // today's amounts reverted a position near the edge of its range on
          // an ordinary tick of movement, because there one side shrinks far
          // faster than the price moves.
          const amounts = burnAmountsWithSlippage({
            sqrtPriceX96: slot0.sqrtPriceX96,
            tickLower: live.tickLower,
            tickUpper: live.tickUpper,
            liquidity,
            slippageBps: BigInt(WITHDRAW_SLIPPAGE_BPS),
          });
          plan = planWithdraw({
            key,
            tokenId: id,
            owner,
            amount0: amounts.amount0,
            amount1: amounts.amount1,
            // Already applied, by price rather than by amount.
            slippageBps: 0,
            deadline,
          });
        }
        const gas = await simulateCall(client, owner, plan, manager);
        setBusy({ ref, label: 'Confirm in the wallet…' });
        const hash = await sendCall(provider, owner, plan, gas, manager);
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
        setBusy({ ref, label: kind === 'collect' ? 'Collecting…' : 'Withdrawing…' });
        const receipt = await client.waitForTransactionReceipt({ hash });
        const ok = receipt.status === 'success';
        updateTx(hash, ok ? 'success' : 'reverted');
        if (!ok) throw new ShownError('The transaction reverted on chain.');
        setDone({ ref, kind, hash });
        showToast(kind === 'collect' ? 'Fees collected to your wallet' : 'Position withdrawn to your wallet');
        setVersion((v) => v + 1);
        // The indexer sees the burn or the fee settlement a block later; the
        // portfolio re-reads now and again on its own cadence.
        await getProvider().refreshPortfolio?.();
      } catch (e) {
        fail(describeTxError(e));
        // Whatever failed, the list re-reads what the chain says now, so a
        // row for a position already withdrawn or moved does not linger.
        void getProvider().refreshPortfolio?.();
      } finally {
        inFlight.current = false;
        setBusy(null);
      }
    },
    [wallet, provider, owner, busy, chainId, refresh, openWallet, showToast],
  );

  const collect = useCallback((position: UserPosition) => run('collect', position), [run]);
  const withdraw = useCallback((position: UserPosition) => run('withdraw', position), [run]);

  return { busy, error, done, version, onChain, collect, withdraw };
}
