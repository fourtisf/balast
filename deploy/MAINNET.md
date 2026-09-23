# Mainnet checklist

What has to be true before Balast is announced as live on Robinhood Chain, in
order. Balast deploys **no contract of its own** (§20): every action is a
transaction to Uniswap's audited contracts, built and dry-run by the page. So
"mainnet" here means the site on `balast.xyz`, pointed at chain 4663, with a
first round of real transactions watched on the explorer.

Commands run on the VPS as root.

## 1. Deploy and check the box

```bash
bash /var/www/balast/deploy/deploy.sh
bash /var/www/balast/deploy/doctor.sh
```

The doctor's last lines say what to do next. `indexer: syncing` or `working`
is normal while the backfill runs; `stalled` or `misconfigured` is not.

## 2. Inputs only a person can supply

| What | Why | How |
|---|---|---|
| A paid RPC endpoint | The public endpoints rate-limit the backfill; it has been ~74 days behind. A paid endpoint (Alchemy, QuickNode, dRPC…) is the one thing that makes it catch up. | `bash deploy/set-env.sh RPC_URLS "https://your-endpoint,https://rpc.mainnet.chain.robinhood.com"` then deploy |
| WalletConnect project id | Phone wallets by QR. Free at cloud.reown.com. | `bash deploy/set-env.sh NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID <id>` then deploy (it is built into the page) |
| `STAKEABLE_HOOKS` | v4 pools with a hook are not offered until their hook is looked at and allowed. Empty is the safe default. | `bash deploy/set-env.sh STAKEABLE_HOOKS 0xhook1,0xhook2` |
| `LAUNCHPAD_HOOKS` | Names launchpad pools (Pons, Bags, Bottom.fun) and keeps them unstakeable before graduation. | `bash deploy/set-env.sh LAUNCHPAD_HOOKS "Pons:0x…,Bags:0x…"` |

## 3. Verify the addresses once

```bash
cd /var/www/balast && npm run verify:chain
```

Every Uniswap address in `lib/chain.ts` was matched against Uniswap's own
registry for chain 4663; this checks each one holds code on the chain itself.

## 4. The first real transactions — small, watched

Use a fresh wallet with about **0.02 ETH**. After each step, open the
transaction on https://robinhoodchain.blockscout.com and check what is listed.

1. **Zap into a v4 ETH pool.** `/positions`, pick a token whose market is
   `ETH` on Uniswap v4, full range, deposit **0.005**. The wallet holds only
   ETH, so the button reads *Step 1 of 2 · Swap*. Sign it.
   - Explorer: the swap went to the Universal Router `0x8876…0904`; you
     received the token; the router holds nothing afterwards.
2. **Mint (step 2).** The button now reads *Mint 1 position*. Sign it.
   - Explorer: a Transfer of a new NFT from `0x0…0` to your wallet, from the
     PositionManager `0x58da…4fA7`.
   - `/portfolio` lists it within a minute.
3. **Zap into a v3 ETH pool** (VIRTUAL / ETH is one), deposit **0.005**.
   - The swap goes to SwapRouter02 `0xCaf6…5cb2`, paid in ETH; the mint to
     the v3 manager `0x7399…E0D3`, paid in ETH; the unspent ether is refunded
     in the same transaction (`refundETH`).
4. **Collect fees** on one position (after some trading), then **Withdraw**
   each one.
   - Explorer: the ether side arrives as ETH (no aeWETH left in the wallet),
     the NFT is burned, and the manager holds nothing.
5. Check `/portfolio` shows the positions gone and the Activity list shows
   every transaction as confirmed.

If any step's dry run refuses, the page says why before the wallet opens —
send that sentence and the pool link, and nothing needs to be signed.

## 5. Only then announce

Post the thread in `brand/social/THREAD.md`. Pin the contract-address warning
first: Balast has no token, and any address circulating as one is not ours.

## Not part of mainnet

- **The Router** (`/router`) needs a contract of its own and an external audit
  (§3.4, §8 P5). The page shows the design and sends nothing.
- **Vaults with a 7-day stream and a protocol fee** (§3.3) are the same: a
  contract, an audit. Under §20 a stake is a full-range position in the
  wallet and Balast takes no fee.
