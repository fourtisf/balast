# Balast — engineering handoff

Liquidity layer for Robinhood Chain. Users deposit into a token pool and collect a
proportional share of swap fees, paid in WETH. Two products: **Stakes** (passive,
one-token deposit, fees streamed over 7 days) and **Positions** (active, shaped
concentrated liquidity minted straight to the user's wallet). A third surface,
**Router**, lets token teams convert creator fees into permanent pool depth.

`depth.html` is the approved design prototype and the source of truth for layout,
copy, colour and interaction. Port its logic; do not redesign it. Where this doc
and the prototype disagree, this doc wins.

Read this file in full before writing any code. Build P0 only, then stop and report.

---

## 1. What is not negotiable

**Balast never takes custody.** Position NFTs are minted to the user's wallet.
Staked positions sit in a vault contract that only the depositing wallet can
withdraw from. There is no admin withdraw path, no pause that traps funds, no
upgradeable proxy on the vault.

**Rewards come from real swap fees only.** No token emissions, ever. If volume
slows, displayed yield slows with it. Never display a projected or subsidised APR.

**Fee yield is the headline metric, not volume.** Volume is trivially washed; fee
yield is what an LP actually earns. Every ranking defaults to fee yield.

**Displayed yield is trailing, never forward.** Label it `fee yield, trailing 7d`
everywhere. Never write "APY", never annualise a single day.

---

## 2. Stack

| Layer | Choice | Why |
|---|---|---|
| Frontend | Next.js 14 App Router, TypeScript | matches existing Fourtis projects |
| API | Fastify | same |
| DB | PostgreSQL + Prisma | same |
| Cache / streams | Redis | pending-harvest buffer, websocket fan-out |
| Indexer | viem + own log poller | Robinhood Chain has ~100ms blocks; see §4 |
| Contracts | Foundry, Solidity 0.8.26 | v4 hooks tooling is Foundry-first |
| Deploy | Hostinger VPS, PM2, Nginx | same as the rest of the stack |

Chain: **Robinhood Chain, chainId 4663**, EVM L2 (Arbitrum Orbit), native gas ETH.
Sequencer is first-come-first-served with ~100ms blocks, so **use timestamps, not
block numbers, for transaction deadlines**.

Known addresses to seed config (verify each on the explorer before mainnet):

```
WETH (aeWETH proxy)  0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73
UniversalRouter      0x8876789976dEcBfCbBbe364623C63652db8C0904
PoolManager (v4)     0x8366a39CC670B4001A1121B8F6A443A643e40951
V4Quoter             0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94
StateView            0xF3334192D15450CdD385c8B70e03f9A6bD9E673b
Permit2              0x000000000022D473030F116dDEE9F6B43aC78BA3
Multicall3           0xcA11bde05977b3631167028862bE2a173976CA11
```

Day-one stablecoin on this chain is **USDG**, not USDC. There is no Aave deployment.

---

## 3. Contracts

Four contracts. Keep them small and separately auditable.

### 3.1 `BalastZap`

Single-token entry. Takes ETH or one side of a pair, swaps the correct fraction,
mints the position, returns dust.

```
function zapMint(
  PoolKey  calldata key,
  int24    tickLower,
  int24    tickUpper,
  uint256  amountIn,
  address  tokenIn,
  uint256  minLiquidity,
  uint256  deadline
) external payable returns (uint256 tokenId);
```

- Swap fraction is computed off-chain and passed in; the contract enforces
  `minLiquidity` so a bad quote reverts rather than executing badly.
- Deadline is a **timestamp**.
- Dust below one wei-equivalent of gas is left in the contract; anything above is
  returned to the caller. Never silently keep dust.

### 3.2 `BalastShaper`

Builds a shaped position across N bins in one transaction. Uniswap v4 has ticks,
not bins, so a "bin" is one tick-range sub-position with its own weight.

```
struct Bin { int24 lower; int24 upper; uint128 weightBps; }
function mintShaped(PoolKey calldata key, Bin[] calldata bins, ...) external payable;
```

- `sum(weightBps) == 10_000` enforced on-chain.
- Max 60 bins per transaction — past that, gas and calldata make it worse than two
  transactions. Reject with a clear revert, do not silently truncate.
- Three shapes in the UI (spot / curve / bid-ask) are **weight generators in the
  frontend**, not contract modes. Keep the contract shape-agnostic so new shapes
  ship without a contract change.

### 3.3 `BalastVault`

One vault per pool. Holds staked LP, harvests fees, streams rewards.

Reward accounting is the Synthetix `StakingRewards` pattern, not a claim-on-demand
pool. The 7-day drip is what stops a wallet from depositing right before a harvest,
claiming, and leaving.

```
rewardRate        = pendingWeth / 7 days
rewardPerToken   += (now - lastUpdate) * rewardRate * 1e18 / totalSupply
earned(account)   = balance * (rewardPerToken - userPaid) / 1e18 + rewards[account]
```

- `notifyReward(uint256 amount)` extends the stream: leftover from the current
  window is folded into the new rate. Standard Synthetix `notifyRewardAmount` logic.
- `withdraw()` is always available, no lockup, no exit fee, no timelock.
- Protocol fee is taken **at harvest, from fees earned** — never from principal:

```
protocolFeeBps = 1000   // 10% of harvested fees
max allowed    = 2000   // hard cap in the constructor, cannot be raised
```

  The cap is constructor-immutable. A governance setter that can raise it to 100%
  is the single most common rug in this product category; do not ship one.

### 3.4 `BalastRouter`

For token teams: converts an accruing fee stream into pool liquidity.

- Trigger modes: `CADENCE` (every N seconds) or `MILESTONE` (at market-cap steps,
  each fires once, in ascending order).
- Pricing uses a **30-minute TWAP**, not spot, or the keeper call is a free sandwich.
- Slippage guard on every route; revert rather than route at a bad price.
- Keeper only *triggers*. Funds never leave the contract to the keeper. The keeper
  address is rotatable; the destination pool is not.
- `pause()` stops future routes and lets the owner withdraw **unrouted** fees only.
  Already-routed liquidity is not recoverable by anyone — say so in the UI.

### 3.5 Invariants for the test suite

- Vault: `sum(balances) == totalSupply`, always.
- Vault: a user who never claims and withdraws at time T receives exactly the same
  WETH as a user who claimed every hour. (Drip must not leak.)
- Vault: `protocolFeeBps` can never exceed the constructor cap.
- Vault: withdraw path works when `rewardRate == 0` and when the reward token
  balance is zero.
- Shaper: `sum(weightBps) != 10_000` reverts.
- Shaper: a 60-bin mint fits under the block gas limit.
- Zap: a quote that degrades between build and execution reverts, never partially
  fills.
- Router: a milestone fires at most once; milestones out of order revert at config
  time, not at route time.
- Router: routing at spot price when TWAP deviates more than the guard reverts.

---

## 4. Indexer

All pool data comes from on-chain events. No third-party price API in the critical
path — logos and token metadata may come from external sources, numbers may not.

**Sources**
- `PoolManager` v4: `Initialize`, `Swap`, `ModifyLiquidity`.
- v3 `UniswapV3Pool`: `Swap`, `Mint`, `Burn` — some older pools on this chain are v3.
- Launchpad hooks (Pons, Bags, Bottom.fun) emit their own swap events *before*
  graduation. Pre-graduation liquidity is not stakeable; index it for the listing
  but mark `stakeable: false`.

**Pipeline**
1. Poller reads logs in ranges, writes raw rows, tracks `last_indexed_block` per
   contract. Reorg depth on an Orbit L2 is shallow but non-zero: re-scan the last
   32 blocks each pass and upsert by `(txHash, logIndex)`.
2. Fee attribution per pool per hour into `pool_fee_hourly`. Fee yield is
   `fees_7d / tvl_now * 365/7 * 100` — compute it in SQL, never in the component.
3. Prices: derive from pool reserves and `sqrtPriceX96`, anchored to WETH, then to
   USD via the WETH/USDG pool. One anchor, one path, no averaging across venues.
4. Websocket pushes deltas to the client. The prototype's 3.2s tick is simulating
   this; in production, push on actual events and debounce to ~1s per pool.

**Schema sketch**

```
pools(id, address, chain_id, token0, token1, fee_tier, tick_spacing,
      hooks, protocol, created_block, stakeable)
tokens(address, symbol, name, decimals, logo_url, launchpad, first_seen)
pool_fee_hourly(pool_id, hour, fees_token0, fees_token1, fees_usd, volume_usd, swaps)
pool_state(pool_id, tvl_usd, price_usd, mc_usd, updated_at)     -- latest snapshot
vaults(pool_id, address, total_staked, reward_rate, period_finish, stakers)
stakes(wallet, vault_id, shares, claimed_weth, updated_at)
positions(token_id, wallet, pool_id, tick_lower, tick_upper, liquidity, shape, status)
router_configs(token, fee_source, mode, cadence_s, milestones_json, paused)
router_routes(config_id, tx_hash, weth_in, liquidity_added, twap_price, routed_at)
```

Rule: components read from a `DataProvider` interface. P0 ships a `SimProvider`
reproducing the prototype's generated data; P1 swaps in the live one. No component
imports data directly, so the swap is one file.

---

## 5. Design system

Take these from `depth.html` into `globals.css` as custom properties. Never
hardcode a colour in a component.

```css
--bg:      #050807;   /* page */
--panel:   #080D0B;   /* cards, table surface */
--panel-2: #0B120F;   /* row hover */
--raise:   #0E1714;   /* inset tracks, segmented control active */

--bd:      rgba(61,214,140,.12);   /* green-tinted border, pills and inputs */
--bd-2:    rgba(61,214,140,.26);   /* focus, active outline */
--bd-n:    rgba(255,255,255,.06);  /* neutral hairline, table rows and cards */

--fg:   #E6F2EC;  --fg-2: #8FA79B;  --fg-3: #5E7268;  --fg-4: #3D4D45;

--ac:     #3DD68C;  /* the one accent */
--ac-2:   #6FE8AC;
--ac-dim: rgba(61,214,140,.10);
--red:    #E5484D;  /* negative change only */
```

**Colour rule.** Green is the only accent and it means one of three things: brand,
a positive number, or an active control. Red means exactly one thing: a negative
number. Nothing else is coloured. Earlier iterations of this design failed because
colour was sprayed across the whole surface.

**Type.** JetBrains Mono throughout, Inter as the fallback stack only.
- Column headers, field labels, eyebrows: `10px / 600 / letter-spacing .16em / uppercase`
- Numbers: `font-variant-numeric: tabular-nums`, always
- Row values: 13px / 500. Token ticker: 14px / 700.
- Big figures (vault APR, stat cards): 24–38px / 700

**Components.** Card radius 14px, control radius 8–10px, pills 99px. Row hover is a
background lift to `--panel-2` plus a 2px green bar on the left edge. Transitions
150ms for hover, 450ms `cubic-bezier(.2,.7,.3,1)` for row reordering.

**Layout.** Fixed 232px labelled sidebar collapsing to a 64px icon rail below
1180px. Sticky top bar, 69px, holds search + the four global stats + wallet.
Columns drop by priority as width shrinks: `Vol 24h` and `Depth` at 1780px, `Age`
at 1560px. A table must never overflow its card.

---

## 6. Pages

### `/pools` — the listing
Featured pool card with 6 metrics and a full-bleed area chart; two smaller cards
(Most traded, Highest fee yield); then two live boards, Trending (sorted by volume)
and Established (sorted by fee yield), each with All / ETH / USDG quote filters.

Live behaviour, all visible in the prototype:
- values update in place, flashing green or red for ~1.1s on change
- rows reorder with a FLIP transform, never a jump
- row 1 carries a leader highlight
- a `Stake` button fades in on row hover and opens the drawer without navigating

### `/stakes`
Vault grid: trailing-7d fee yield as the headline figure, staked total, fees 24h,
staker count, next harvest countdown. Below it, the user's own stakes with a
7-day stream progress bar, claimable amount, and Claim / Compound.

### `/positions`
The shape builder. Left panel: token, deposit amount, shape (spot / curve /
bid-ask), range as ± percent, bin count. Right panel: live bin chart with the
current price marked, plus range, estimated fee yield, split at mint, fee tier.
Mint is one transaction and the NFT goes to the user.

### `/router`
Token-team surface. Fee source, trigger mode, destination range, then a plain
timeline of what will happen and a depth projection. Copy must state that routed
liquidity is permanent.

### `/portfolio`
Net value, fees earned, price impact vs holding, daily fee heatmap, position list
with in-range / out-of-range status and a rebalance prompt.

---

## 7. Honest-numbers rules

These are product rules, not style preferences. Breaking one makes the site
dishonest and it is the fastest way to lose LPs.

- Fee yield on a pool younger than 7 days is labelled `est.` and carries the pool
  age next to it. A 1-day-old pool showing 1200% is arithmetic, not an opportunity.
- Never display a yield figure computed from fewer than 24 hours of data. Show `—`.
- `Price impact on holdings` in the portfolio is the honest name for impermanent
  loss. Show it as a negative number next to fees earned, not buried.
- Out-of-range positions earn nothing. Say exactly that, in the row, in red.
- The protocol fee (10% of fees earned) is disclosed in the stake drawer before the
  user signs, not in a docs page.
- If the indexer is behind, show the lag in the top bar. Never render stale numbers
  as if they were live.

---

## 8. Build phases

**P0 — shell and simulated data.** Next.js scaffold, design tokens, all five pages
rendering against `SimProvider` with the prototype's generated data, including the
live tick, flash and FLIP reorder. Deploy. Nothing below changes a component.

**P1 — indexer.** Log poller, pool and token discovery, fee attribution, price
derivation, websocket. `/pools`, `/stakes`, `/portfolio` read real data. Still no
contracts.

**P2 — contracts on testnet.** `BalastZap`, `BalastShaper`, `BalastVault` with the
full invariant suite. `/positions` mints for real; `/stakes` stakes for real.

**P3 — keeper.** Harvest scheduler, WETH conversion, `notifyReward`. Monitoring and
alerting on missed harvests: a keeper that dies silently is a vault paying zero
while displaying a yield.

**P4 — router.** `BalastRouter` plus the token-team onboarding flow.

**P5 — audit, then mainnet.** No mainnet deployment of the vault before an external
audit. This is the one phase that cannot be compressed.

---

## 9. Acceptance criteria for the hard parts

**P1 is done when** re-running the indexer from block zero on a fresh database
produces byte-identical `pool_fee_hourly` rows to the incremental run, and a forced
32-block reorg replay changes no row count.

**P2 is done when** the vault invariant suite passes under fuzzing with 10k runs,
including: random deposit / withdraw / claim orderings across 50 wallets never
leave the vault unable to pay `sum(earned)`.

**P3 is done when** killing the keeper for 48 hours and restarting it distributes
exactly the fees accrued in that window, with no double-payment and no loss, and
the UI showed the harvest lag the whole time.

---

## 10. Open decisions for ALFA, not for the developer

- **Protocol fee rate.** 10% is in the spec and the prototype. Meteora runs ~10%
  and returns 90% to LPs. Going higher looks fine on a spreadsheet and loses the
  supply side. Confirm before the constructor is deployed, because the cap is
  immutable.
- **Minimum pool age before a pool appears in Established.** 7 days is assumed.
- **Whether Balast seeds its own liquidity in launch pools.** Affects whether the
  displayed TVL is honest as "user liquidity" or needs a separate line.
- **Domain and token.** ~~`Depth` is the working name.~~ **Decided: the product is `Balast`, on `balast.xyz`.** The token is still open — see §12.

---

## 11. Kickoff prompt for Claude Code

Paste this to start:

> Read `CLAUDE.md` in full before writing any code. Build P0 only, then stop and
> report.
>
> Scaffold a Next.js 14 App Router project in TypeScript for Balast, a liquidity
> platform on Robinhood Chain (chainId 4663). Put the design tokens from §5 into
> `globals.css` and build the five pages from `depth.html`: `/pools`, `/stakes`,
> `/positions`, `/router`, `/portfolio`, plus the fixed labelled sidebar and the
> sticky top bar with global stats.
>
> All data comes from a `DataProvider` interface with a `SimProvider`
> implementation that reproduces the prototype's generated pools, vaults and
> positions, including the 3.2 second market tick. No component may import data
> directly — everything goes through the provider so P1 swaps one file. Read
> `DATA_SOURCE` from env; `live` throws "not implemented" for now.
>
> Port these interactions exactly as they behave in the prototype: value flash on
> change (green up, red down, ~1.1s), FLIP row reordering on rank change, leader
> row highlight, Stake button revealed on row hover opening the drawer, the shape
> builder's live bin chart responding to shape / range / bin count, and the
> responsive column dropping from §5.
>
> Rules: no hardcoded colours, tokens only. Green means brand, positive or active;
> red means negative; nothing else is coloured. Every number uses tabular-nums.
> Yield is labelled trailing 7d and never annualised from one day. Responsive to
> 360px with no horizontal table overflow at any width. Respect
> `prefers-reduced-motion` — that disables the flash and FLIP, it does not disable
> the data updates. Visible keyboard focus on every control, and the drawer traps
> focus and closes on Escape.
>
> When P0 runs and deploys, stop and list what you need from me for P1: RPC
> endpoint, starting block, and the pool addresses you want to index first.

---

## 12. P0 implementation notes

Added by the P0 build. Everything above this line is ALFA's handoff and is
unchanged; this section records where the implementation had to make a call, so
the next phase is not left guessing.

### Deviations from the prototype

The prototype contradicts itself or this document in four places. Per the rule
at the top of this file, this document won.

1. **Yield basis.** `depth.html` computes `fee*365/tvl` — 24h fees annualised,
   which §1 forbids. Implemented as `fees_window / tvl_now * 365/7 * 100`, with
   the window capped at the pool's own age, and the three states from §7
   (`—` under 24h, `est.` plus age under 7d, plain above).
2. **Bin-chart legend.** The prototype's legend and its fill code disagree on
   which side of the price is the token side. The code was taken as correct and
   the legend corrected to match it.
3. **Fee heatmap colour.** The prototype fills the portfolio heatmap with
   `rgba(124,140,255)` — a purple, which breaks the colour rule in §5. It is
   green, and the caption reads "brighter = more" because that is what it draws.
4. **Standalone totals.** The prototype's top-bar TVL ($4.91M) and featured
   fees ($318K) contradict the sum of its own pool rows ($15.1M and $108K).
   Every figure that can be summed from the pools is now summed from them, so
   the header cannot disagree with the table beneath it.

### The simulated clock

`SimProvider` advances **six hours of chain time per 3.2s tick**
(`SIM_HOURS_PER_TICK`). A trailing-7d figure is deliberately slow-moving: with
a real-time clock, measured over four minutes, the boards never reordered once,
so the FLIP reorder that §8 requires in P0 was not observable. Six hours a tick
rolls the window in about ninety seconds of watching. Only the simulated clock
is compressed; the displayed metric and its arithmetic are unchanged.

**This needs ALFA's sign-off**, because it is the one place P0 does not behave
like the approved prototype.

### Decisions taken on §10's assumptions

- **Established shows pools with 7+ days of fees.** §10 lists this as assumed;
  it is implemented and labelled `7d+` in the board header. Consequence: young
  pools appear only in Trending, so the `est.` and `—` states are visible in
  the stake drawer and the vault cards rather than on the boards.
- **Protocol fee is 10%**, with the cap constant at 2000 bps in `lib/chain.ts`.
  Still needs confirming before the constructor is deployed — the cap is
  immutable.

### One open product question

`/positions` shows an **Est. fee yield** for a range the user has not entered
yet: this pool's trailing-7d yield scaled by how tightly the range concentrates
it, capped at 6×. It is labelled `est. · from N% trailing` so the basis is on
screen, but it is still a forward-looking number, which sits awkwardly against
§1's "never display a projected APR". Options are to keep it as is, cap it
harder, or drop the figure and show only the concentration multiple. **ALFA's
call.**

### Not in P0

No indexer, no contracts, no keeper, no wallet connector — the wallet button is
a placeholder until P2. `lib/chain.ts` holds the §2 addresses, all of them still
unverified on the explorer. Deploy configuration (`ecosystem.config.js`,
`deploy/nginx.conf`) is committed, but nothing has been deployed: that needs
credentials for the VPS.


---

## 13. Naming and domain

**The product is `Balast`. The domain is `balast.xyz`.** §10 left this open; it
is now settled, and this section records what moved and what did not.

`Depth` was too generic to own: every short `depth.*` on a mainstream TLD is
registered and in use — `.com` `.org` `.io` `.so` `.xyz` `.fi` `.trade`
`.exchange` `.network` `.finance` `.ai` `.co` all checked and all taken.
`Ballast` was chosen for its meaning — weight carried low in a hull that gives
a vessel stability, which is what this product sells: stability from real fees,
not from emissions — and registered in its Indonesian spelling.

**The word "depth" stays wherever it is the domain term rather than the brand.**
Pool depth, market depth, the `Depth` column in the Established board,
`permanent depth` in the router copy, the `*DepthUsd` fields, `.depth-bar`,
`reorgDepth`, and `design/depth.html` are all unchanged. Only the brand moved.

The four contracts in §3 are renamed `BalastZap`, `BalastShaper`,
`BalastVault`, `BalastRouter`. None is deployed, so this costs nothing now and
would have cost an audit later.

### Still open

- **The token.** §1 forbids emissions, so a token cannot be a reward. That
  leaves governance or fee-share, and fee-share creates pressure on the one
  number §3.3 made immutable to protect LPs. Recommendation: ship without one.
- **`ballast.xyz`** — the English spelling on the same TLD — is registered and
  parked for sale by a third party. For a front-end that asks people to connect
  a wallet, a confusable domain someone else controls is a phishing domain
  pointed at our users. `ballast.fi` and `balast.fi` were both still free at the
  time of writing; registering them and 301'ing to the apex closes most of the
  exposure. `deploy/nginx.conf` carries the redirect stanza, commented out.
- **The mark reads as the letter M.** It was chosen while the product was called
  Depth, and it is now a mismatch for a B name. Recorded in `brand/README.md`.

---

## 14. P1 implementation notes

Added by the P1 build. §12 and §13 are unchanged. This section records what the
indexer can know, what it refuses to guess, and the two things it needs from
ALFA before it can index the real chain.

### What ALFA has to supply

**`USDG_ADDRESS`. The indexer will not start without it.** §2 names USDG as the
day-one stablecoin and §4.3 allows exactly one path to a USD figure: the
WETH/USDG pool prices WETH, and everything else prices through WETH. The
address is not in the handoff. With it unset every USD figure on the site would
be zero, so the process stops with that explanation rather than running and
reporting zeros.

**`START_BLOCK`.** The PoolManager's deployment block. Left at 0 the first sync
scans from genesis, which on ~100ms blocks is a very long time. Worse, a
`START_BLOCK` set *above* a pool's creation block means the indexer sees that
pool's outflows without the mint that funded them — see *unknown depth* below.

**`LAUNCHPAD_HOOKS`.** §4 says pre-graduation launchpad liquidity is listed but
not stakeable, and names Pons, Bags and Bottom.fun. Their hook addresses are
not in the handoff, so the variable is empty and every pool is currently
classified stakeable. That is the safe direction for a listing and the **wrong**
direction for a vault: P2 must not deploy a vault against a pool discovered
while this was blank.

The chain's own details were verifiable and are configured: chainId 4663 is
confirmed, and the four public RPC endpoints in `.env.example` come from the
`ethereum-lists/chains` registry. The §2 contract addresses in `lib/chain.ts`
are still unverified on the explorer.

### Rebuilt, never incremented

Every aggregate table is recomputed from the raw rows rather than added to.
This is the single decision the rest of P1 hangs off, and it is what makes §9's
acceptance criterion reachable at all: §4.1 requires re-scanning the last 32
blocks every pass, and an incremented total would double-count every one of
those rows. A rebuild over rows keyed `(tx_hash, log_index)` gives the same
answer however many times the same logs arrive, in what order, or in what
range sizes.

The consequence is a staging chain, because rebuilding everything from the raw
tables on each pass is a full scan:

```
swap_events, liquidity_events     raw, append-only, keyed by log coordinates
  -> weth_usd_hourly              the one USD anchor
  -> pool_flow_hourly             signed token flow, which gives reserves
  -> pool_fee_hourly              fees and volume per pool per hour
  -> pool_state                   latest price, reserves, TVL
```

`pool_flow_hourly` is not in §4's schema sketch and exists for a measured
reason. On v4 the PoolManager holds every pool's tokens in one balance, so
reserves can only be derived by summing the pool's own signed event amounts.
Summing the raw tables directly took 5-9 seconds a pass on a four-thousand-swap
fixture; staging it hourly brought a full sync to under a second.

**§9 is proven, not asserted.** `server/indexer/replay.test.ts` runs a
deterministic fixture chain of ABI-encoded logs through the real decoder, the
real ingest and the real SQL against a real Postgres, and compares every
numeric column **as text** — comparing Postgres `numeric` through a JavaScript
float would hide exactly the drift the criterion exists to catch. A block-zero
run and an incremental run produce identical rows; a forced 32-block reorg
replay changes not one row, let alone the count; ten replays of a 500-block
window change nothing.

### v4 emits no amounts for a liquidity change

`ModifyLiquidity` carries a liquidity delta, a tick range and no token amounts,
and those amounts are what a TVL figure is made of. They are computed at ingest
from the delta, the range and the pool's price — and the price used is the one
carried forward from the most recent `Swap` at or before that log's position in
the `(block, logIndex)` order, loaded from the database rather than held in
memory. That is deliberate: it makes the derived amounts a pure function of the
log prefix, so a restart mid-chain resumes with exactly the state a full replay
would have reached. Held in memory, the two runs would disagree and §9 would be
unprovable.

The tick maths is the TickMath constant table, ported exactly, with a test
comparing every constant against `sqrt(1.0001^t) * 2^96` computed
independently — a mistyped hex digit fails there rather than as a wrong TVL on
the site.

### What P1 does not know, and says so

- **Market cap.** Needs a circulating supply, which is not in the log stream.
  It is zero and the column shows an em dash. The prototype's MC figures were
  generated; there is no honest live equivalent without a token-supply source,
  and §4 bars a third-party API from the critical path.
- **Chain share.** The featured card's figure needs the chain's total
  liquidity to compare against. The PoolManager *is* the chain's v4 liquidity,
  so our share of what we index is 100% and meaningless. Zero until there is
  something real to divide by.
- **Vaults, stakes, positions, harvest payouts.** All need contracts, which are
  P2. The tables exist and are empty, the snapshot reports them empty, and the
  components already had empty states for it. Nothing is invented to fill the
  page.
- **Unknown depth.** A pool whose reserves sum negative means we never saw its
  funding mint — `START_BLOCK` was above its creation block. Its depth is
  *unknown*, not zero. Zero is recorded, and the deliberate consequence is that
  the yield shows as an em dash (§7) rather than a number divided by a divisor
  we know is wrong. The poller logs how many events it dropped for pools it
  does not know, so the cause is findable.
- **An absurd price.** Nothing stops someone initialising a pool at a tick that
  derives a price near 1e24 USD. Such a figure is discarded and the pool left
  unpriced, rather than clamped — a clamped value renders as a real TVL of ten
  quintillion dollars. It is also why it is discarded rather than allowed to
  overflow: an overflow throws inside the aggregation and stops the pass for
  *every* pool.

### Two honest-numbers rules P1 had to add

Neither is in §7, and both follow from it.

**The trailing window ends at the last block indexed, not at wall-clock now.**
If the indexer is an hour behind, wall clock counts that hour as zero fees and
quietly deflates every yield on the board. So the window is measured back from
chain time and the lag is reported separately, which is what the top bar shows.

**`LiveProvider` holds nothing rather than something invented.** If the API is
down or no block has been indexed, the snapshot stays null and the UI says
*waiting for the indexer*. It never falls back to `SimProvider`. A site that
silently swaps generated numbers in when the indexer dies is the exact
dishonesty §7 is about, and it is the failure mode §8's P3 criterion warns of
one phase early.

That null state is the one place P1 touched a component. The `DataProvider`
interface has allowed `getSnapshot()` to return null since P0 — "null if none
has arrived yet (live, pre-connect)" — but `SimProvider` is synchronous and
never did, so `MarketProvider` never handled it. It does now. No page changed.

### Still open

- **The §12 questions are still open.** The six-hours-per-tick simulator clock
  needs sign-off, and `/positions`'s forward-looking *Est. fee yield* still
  needs a decision. P1 changed neither.
- **`/stakes`, `/positions` and `/portfolio` have real but empty data.** §8
  lists `/stakes` and `/portfolio` as reading real data in P1, but both are
  about vault contracts that do not exist until P2. They read real data in the
  sense that they read the indexer and honestly report nothing in it.
- **Protocol fee at 10%, cap at 2000 bps.** Unchanged from §12, and the cap is
  still constructor-immutable, so it still needs confirming before P2 deploys.

---

## 15. P1 follow-up: the gaps §14 recorded, closed

Added after an audit of the P1 build. §14 is unchanged; this records what was
wrong with it and what is now true instead. Four of the six items were defects
in my own work rather than missing inputs.

### Market cap: §14 was wrong, and it mattered

§14 said market cap "needs a circulating supply, which is not in the log
stream". True but incomplete: `totalSupply()` is an ERC20 read, it is on chain,
and `server/chain/abi.ts` already declared it. The figure was available and I
left it at zero.

It mattered beyond a blank column. **§3.4's `MILESTONE` trigger mode fires at
market-cap steps**, so with the figure at zero `BalastRouter` could not work in
that mode at all — a P4 blocker created by being too conservative in P1.

It is now derived, with one honesty consequence carried through: total supply
includes locked, vested and treasury-held tokens, and none of that is
distinguishable on chain. That makes the figure **fully diluted value, not
market cap**, and presenting FDV as market cap overstates every token with a
vesting schedule, always in the flattering direction. So:

- `pool_state.mc_usd` is `totalSupply x price` of the traded side.
- `Pool.marketCapIsFdv` says which figure it is.
- The row marks it `fdv`, and the cell's title explains what is included.
- A token that will not report a supply shows an em dash, not a guess.
- Supply is re-read on a cadence, oldest first, a few tokens per pass — a
  mintable token's supply changes, and a stale supply is wrong in the
  flattering direction again.

**This is the one place P1's follow-up touched a component.** §8 says the
phases after P0 do not change components; §7 says a displayed number must be
labelled for what it is. Where those conflict §7 wins, because §7 is a product
rule and §8 is about implementation sequencing. The change is a qualifier and a
tooltip. **ALFA should know the MC column now reads as FDV** — if the intent
was circulating market cap, that needs a supply source, and §4 bars a
third-party API from the critical path.

### v3 pools were undiscoverable

`V3_FACTORY_ABI` existed and nothing listened for `PoolCreated`, so v3 pools
had to be hand-listed in `V3_POOLS`. §4 says some older pools on this chain are
v3, so the hand-list would have silently omitted every pool nobody thought to
add. The factory is now followed, discovered pools are reloaded from the
database on restart, and `V3_FACTORY` needs an address from ALFA.

Finding it surfaced a second bug that the test caught rather than production.
A v3 pool announced at block 20 whose `Mint` lands at block 30 has both in
blocks already read past — its own address was not in the log filter when they
were fetched — and the 32-block re-scan cannot reach back far enough. That mint
is the pool's entire starting liquidity: miss it and the reserves sum negative
and the depth is unknown for good. A newly discovered v3 pool is now backfilled
from its own creation block in the same pass.

### The API was unprotected, and health said nothing useful

`/api/snapshot` is the expensive query and it sat on a public endpoint in front
of one Postgres; one loop would have taken the site down. It is rate limited
now, generously — the front end polls every 20s behind the websocket and a
dozen tabs behind one NAT must not be throttled. The websocket is exempt,
because after a restart every client reconnects at once and those are exactly
the clients that most need to get back on.

`/api/health` returned 200 whenever the API answered, which is useless as an
alert: the indexer could be dead for a day and the endpoint would say ok. It
**returns 503 when the indexer is stalled or has never started**, so any uptime
check watching a status code catches it. `deploy/monitor.sh` runs from cron and
checks the same thing plus PM2, alerting on a change of state rather than every
five minutes for two days.

This is §8's P3 criterion arriving a phase early. It names the failure
precisely — "a keeper that dies silently is a vault paying zero while
displaying a yield" — and the indexer has exactly that shape now.

### Operational gaps that would have bitten

- **Log rotation.** Three processes, six log files, no rotation. The first
  symptom of a full disk is writes failing everywhere.
- **Backups.** `deploy/backup.sh`, nightly, 14 days. §9's determinism means
  the database can be rebuilt from chain, but that is a full re-sync from
  `START_BLOCK` — hours of climbing lag. The dumps are local, which protects
  against a bad migration and not against losing the box; getting them off the
  machine needs credentials, so `BACKUP_SYNC_CMD` is left for whoever has them.
- **Boot survival.** `bootstrap.sh` now verifies `pm2-balast` is actually
  enabled and says so loudly if not. Without that unit a reboot leaves nginx
  serving 502s.

### Verifying the addresses

`npm run verify:chain` checks every §2 address holds code, that the
PoolManager has emitted the v4 events we subscribe to — **decoded, not
counted** — and that WETH and USDG answer as ERC20s with the decimals the
price maths assumes. Run it before the first sync.

The check is worth the script because the failure is invisible: a wrong
`poolManager` starts cleanly, subscribes to an address that emits nothing, and
reports a lag that climbs forever. A site that looks like it works and has
nothing in it.

An earlier version of that script checked the event name against the ABI
instead of against the log, so it reported every event as found the moment any
log appeared — it would have passed a wrong address that happened to emit
something else. It decodes now.

### Token logos

`logo_url` existed and was never populated. §4 permits external sources for
logos and metadata and forbids them for numbers, so `server/indexer/logos.ts`
is the only file in `server/` that talks to anything but a node or the
database, and it reads `logoURI` and nothing else — not price, not supply, and
not decimals, which are an input to every price. A failure is silent and
total: no list, an unreachable host or malformed JSON leaves every badge on its
derived colour and changes not one number. It is opt-in via `TOKEN_LIST_URL`,
because there is no canonical list for this chain and guessing at one would be
worse than no logos.

### What is still not built, and is not a defect

P2's contracts, P3's keeper and P4's router are phases, not gaps. §8 orders
them and §8's P5 puts an external audit in front of any mainnet vault
deployment. Nothing in this section brings them closer.

The §12 questions are also still open: the six-hours-per-tick simulator clock
needs sign-off, and `/positions`'s forward-looking *Est. fee yield* needs a
keep, cap or drop. P1 and this follow-up changed neither.
