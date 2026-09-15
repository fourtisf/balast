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

---

## 16. The deploy bug that `.env` never being read caused

Recorded because it broke a real deploy and because the shape of the mistake
is worth keeping.

`deploy/bootstrap.sh` writes `/var/www/balast/.env` with the generated
database password and a slot for `USDG_ADDRESS`. **Nothing read it.** Node
does not read `.env` files — Next.js does, which is why the web process worked
— and PM2 does not either. The secrets deliberately do not go into
`ecosystem.config.js`, because that is in the repository. So the file was
written, nothing opened it, and `balast-api` and `balast-indexer` both died on
`DATABASE_URL is required` while pointing at a file sitting right there.

`ecosystem.config.js` even carried a comment saying ".env holds DATABASE_URL",
which was true and useless: it described where the value was, not how it would
arrive.

Fixed with `server/load-env.ts`, imported as the first line of every server
entry point. Three properties that matter:

- **The real environment always wins.** A variable already set by PM2, a
  shell, or CI is never overwritten, so `RATE_LIMIT_MAX=1 npm run api` does
  what it looks like it does.
- **The path resolves from the module, not from `cwd`.** PM2 sets a cwd, cron
  does not, and a deploy script may run from anywhere.
- **It is imported first in each entry point**, not only from `env.ts`,
  because several modules read `process.env` at their own top level and module
  evaluation order would otherwise decide whether they saw the file.

The parser is twenty lines rather than a dependency, and it keeps a `#` inside
a quoted value — the generated database password plausibly contains one, and
truncating it there produces an authentication failure that looks nothing like
its cause.

### And a second fault the same command exposed

`npm run verify:chain` failed on `DATABASE_URL is required` — a variable it
never uses. It imported `server/env.ts`, which validates every variable at
import, and the script's entire purpose is to check the chain **before** the
database matters.

The RPC endpoint list now lives in `server/chain/endpoints.ts`, which has no
database requirement; `env.ts` re-exports it so there is still one definition,
and `chain/client.ts` depends on it rather than on `env`. The verify script
imports neither `env` nor the database.

Eager validation at import is still the right default for the API and the
indexer — a typo'd variable should stop the process at boot rather than
produce an indexer quietly following the wrong chain. The lesson is narrower:
a module that validates everything should not be on the import path of
something that needs one thing.

### The test that guards the guard

`vitest.setup.ts` asserts `DATABASE_URL` is still the test database after the
loader has run. The suites truncate every table, and a developer with a real
`DATABASE_URL` in their `.env` must never have it win. The loader's
non-overwriting rule is what makes that safe today; the assertion is what
keeps it safe if the rule ever changes.

---

## 17. Deploy faults, and every token having a mark

Two deploy faults worth recording because of their shape, and the answer to
"every token must have a logo".

### A diagnostic that invented a failure

`doctor.sh` parsed `pm2 jlist` with grep, matching `"name":"x","pm2_env":{`.
PM2 puts `namespace`, `version`, `mode`, `pm_id` and `monit` between those two
keys, so the pattern never matched and the doctor reported **every process as
not running while the site was up and serving**. A tool that invents a failure
is worse than one that misses a real one: it sends you looking in the wrong
place. It parses the JSON with a JSON parser now.

### A repair tool that refused to repair

The doctor's `next` line pointed at `bootstrap.sh` when `.env` was missing.
`bootstrap.sh` then exited with "reset the password yourself", because the
database role already existed from an earlier run and the password was no
longer known anywhere. The one command meant to fix the box refused to fix the
most likely way it breaks.

It rotates the role's password and writes a fresh `.env` now. Rotating is safe
precisely BECAUSE the old password is lost — nothing can still be using it.

### Every token has a mark; some have logos

`lib/token-mark.ts` derives a badge from the token's own address: a
fixed-weight disc whose hue is unique to that address, carrying the ticker's
first two characters. Deterministic, so the server and the browser render the
same thing and a token never looks like a different token after a reload.

Saturation and lightness are fixed rather than derived. Deriving them
eventually produces a near-black token invisible on a near-black page, or one
close enough to the accent green that §5's colour rule stops meaning anything.

The ink is chosen per hue, and that is not fussiness: **yellow at this
lightness is far brighter than blue at the same lightness**, so no single ink
stays legible across the wheel. Measured, a fixed dark ink bottoms out at
1.72:1. Per-hue selection holds 4.26:1 across all 360 hues, and there is a
test that re-derives that number rather than trusting this paragraph.

That test caught a real bug in the first version: the ink luminances were
hardcoded, and wrong — 0.0106 against a true 0.0044 — which flipped the ink
choice on part of the wheel and quietly cost 0.3 of contrast. They are
computed from the hex now. A constant that has to agree with another constant
is a constant that will eventually disagree with it.

**Real logos** still come only from a token list, per §4. The change that
makes that usable: `TOKEN_LIST_URL` now accepts a local path, and
`config/tokens.json` ships with the repository. Robinhood Chain has no public
token list, so waiting for one meant no token would ever have a real logo;
now whoever knows the tokens can add them today, in the same Uniswap
token-list shape, and switching to a public list later is one line. Only
`logoURI` is read — not price, not supply, and not decimals, which are an
input to every price.

A listed logo that changes now replaces the recorded one, rather than only
filling a blank. A corrected logo should reach the site without anyone
truncating a table to make it happen.

### The hardcoded database port

`bootstrap.sh` created the role and database over postgres's **unix socket**,
which finds the default cluster whatever port it listens on, and then wrote a
`DATABASE_URL` with a hardcoded `5432`. Where those disagree the database
exists and the URL cannot reach it, and the error — `P1001: Can't reach
database server` — reads exactly like postgres being down.

This is not an edge case on a shared box. Debian puts a second cluster on
5433 when 5432 is taken, and this VPS already ran PostgreSQL for other sites.

Detecting the port turned out to be its own small problem: `psql` cannot
answer it, because its socket is named `.s.PGSQL.<port>` and it defaults to
5432 — asking the cluster its port over the socket requires already knowing
the port. `deploy/pg-port.sh` asks the system instead, in order of
authority: Debian's cluster registry, then the socket files, then a TCP
listener. Every socket `psql` call in bootstrap now passes `-p` for the same
reason.

Bootstrap also corrects the port in an existing `.env` rather than leaving it,
because the port is a fact about the machine and not a preference — verified
against a password containing `#` and `&`, where only the port changes.

### A verdict that ranked the wrong failure

The doctor ranked failures by dependency order alone, so with the database
unreachable AND `USDG_ADDRESS` empty it told the operator to go look up a
token address. Those are independent: an empty `USDG_ADDRESS` stops the
indexer and nothing else, while an unreachable database stops everything.

There are two tiers now. `first` is for a failure the rest of the box cannot
work around; `also` is for one that blocks only itself. The verdict prints
`next` and then `then`.

The database check also says **which** failure it is, rather than "cannot
connect": cluster down, wrong port in `.env`, `listen_addresses` refusing
127.0.0.1, or bad credentials. The generic message sent someone to check
whether postgres was running — and it was, on another port.

### An API that died instead of explaining

`start()` threw on a missing `USDG_ADDRESS` and refused to listen. On the real
box that produced 24 restarts, no explanation anywhere, and a front end that
could not even ask what was wrong — while the page it served said only
"waiting for the indexer", which was true and useless.

That is backwards. The API is the one process in a position to say what is
missing, and a configuration error should be loudly visible rather than fatal.
It starts now, and reports:

- `/api/health` → 503 with `status: "misconfigured"` and a message naming
  both the variable and the two commands that set it.
- `/api/snapshot` → 503 with the same reason rather than a bare "no data".

**Misconfiguration outranks `never-indexed`** in that status, deliberately: a
chain with no indexed blocks is the SYMPTOM of an indexer that cannot start,
and reporting the symptom sends whoever is looking to the wrong place.

The indexer still refuses to start without the anchor, and that stays right —
it would otherwise write rows priced at zero. PM2's `errored` state is the
visible signal there.

`components/providers/AwaitingIndexer.tsx` asks `/api/health` and shows the
reason under the honest-empty message. The waiting page now tells an operator
what to fix instead of leaving them to guess, which is the difference between
a blank wall and a diagnosis.

### The anchor finds itself

`USDG_ADDRESS` was the one value nothing could proceed without, and the only
one no machine could supply — §2 names USDG but not its address. So the
indexer refused to start, the API refused to start, and the site sat on a "not
configured" page waiting for a step only a person could take. For hours.

That was the wrong shape for the problem. **The indexer already reads every
token's symbol off its own contract while discovering pools.** The answer was
in its own tables the whole time.

`server/indexer/anchor.ts` looks: the token calling itself USDG that trades
against WETH, ranked by swaps. `USDG_ADDRESS` still overrides it, and a
*malformed* override is still refused — somebody meant to pin a specific token
and mistyped it, and quietly pricing the whole site off a different one cannot
be detected from anywhere downstream.

Where it will not guess: with two tokens claiming the symbol it picks the one
with real depth, **says which and why**, and reports both. `/api/health`
carries `usdgSource` and `usdgNote`, because the anchor is the single most
consequential value in the system — a wrong one makes every dollar figure
wrong — and it has to be auditable from outside the box.

The ordering works because of a decision made much earlier for a different
reason. Aggregates are REBUILT, never incremented (§14), so the indexer can
write raw rows with no anchor at all, discover it several passes later, and
the next rebuild prices everything retroactively. No second scan of the chain.
There is a test proving the early hours — indexed before any anchor was
known — end up carrying USD figures, and another proving the result is
identical to having configured the address up front.

`START_BLOCK` and `V3_FACTORY` remain genuinely optional rather than
discovered: the first is a performance choice, the second cannot be inferred
from logs the factory itself emits.

### The crash loop: a price computed and thrown away

With the anchor discovering itself the indexer finally reached the real chain
— and then stopped on every pass with "No price known for pool … the batch is
missing its Initialize", retrying the same range forever and indexing nothing.

Three of my own mistakes in a line:

1. `planIngest` computes `plan.states`, which carries the price from
   `Initialize`. **Nothing ever wrote it.** The field was built and never
   persisted.
2. `loadPriceState`'s fallback read `pool_state.sqrt_price_x96`, which
   `rebuildPoolState` takes from the pool's LAST SWAP — so a pool that has not
   traded yet has zero there and was filtered out by the `> 0` condition.
3. And skipping the aggregation when no anchor exists left `pool_state` empty
   regardless.

So a `ModifyLiquidity` for a pool created in an earlier pass had no price, and
v4 emits no token amounts on that event, so it could not be valued.

**The Initialize price now lives on the pool row** (`init_sqrt_price_x96`,
`init_tick`) — an immutable fact from the log, which makes the state loaded
from the database exactly what an in-memory replay would have had. §9 still
holds; there is a test for that alongside the fix.

The second half matters as much: it **threw**. One pool's reserves being
unvalued is a far smaller loss than every pool's data being frozen, and §7
already renders unknown depth as an em dash. Such an event is now recorded on
the plan and logged, and the pass completes.

### Starting from genesis

Left at `START_BLOCK=0` the indexer scans from block zero. On this chain that
is 62 million blocks of mostly nothing — some thirty thousand passes before
reaching anything worth indexing, and the observed run was at block 7,872
after several minutes.

`eth_getCode` is empty before a contract exists and non-empty after, which is
monotonic, so `server/chain/deployment.ts` bisects for the PoolManager's
deployment block in about 26 calls and starts there.

It needs an archive node, and a pruned one answers old blocks with empty —
which would look exactly like "deployed at head" and set a `START_BLOCK` above
every pool's creation, so each pool's funding mint would be missed and its
depth would read as unknown for good. That case is detected and the search
abandoned rather than trusted.

Writing the test for it found a real bug: the genesis probe sat outside the
bisection's try/catch, so a pruned node would have thrown at indexer startup
instead of falling back.

### Thirty-four hours of empty blocks

With the crash loop fixed the indexer ran, and the next problem was arithmetic:
block 47,000 of 62,644,703, at 2,000 blocks a pass. Some thirty thousand round
trips — about thirty-four hours — before reaching anything worth indexing.

The deployment-block bisection was supposed to skip that, and it correctly
refused to: **all four public endpoints are pruned**, so `eth_getCode` cannot
answer for an old block. It said so and fell back rather than guessing, which
is right — a `START_BLOCK` above a pool's creation means never seeing the mint
that funded it.

So the fix is on the other side: the range adapts. Empty ranges double toward
a ceiling, busy ones halve back, and once the indexer is following head it
returns to the floor, where a narrow window keeps latency low.

The ceiling is learned rather than configured. Endpoints cap `eth_getLogs`
differently and none announce it, so the poller starts optimistic, and the
first refusal — "query returned more than N results", "block range too large"
— halves the width and records a ceiling it stays under. The cursor does not
move on a refusal, so nothing is skipped.

The property this could not cost is §9. A window that changes size mid-sync is
a harder version of the block-zero-versus-incremental comparison that
criterion is built on, so there is a test producing byte-identical
`pool_fee_hourly` rows from an adaptive run and a fixed-window one.

The indexer also logs every pass while backfilling now, with percentage and
blocks remaining. It previously logged only passes that found something, and
on a chain that is mostly empty an hour of silence is indistinguishable from a
hang.

---

## 18. The anchor that was already indexed

Recorded because the site sat on **"looking for the USD anchor"** on every
page while the pool it was looking for was in its own tables.

### Uniswap v4 has no WETH

A v4 pool's currencies are a `PoolKey`, not a token pair, and a pool that
trades ether holds it **natively**: `currency0` is `address(0)`, not the
wrapper. §2 gives aeWETH's address and §4.3 says everything prices through
ether, so every currency comparison in the indexer was written against that
one address — the anchor search, `findAnchorPool`, the USD `CASE` in each of
the three aggregation steps, and the snapshot's listing filter.

So an ETH/USDG pool — the likeliest anchor this chain has — was indexed,
counted, and invisible to all four. The failure then cascaded exactly as it
was designed to: no anchor means `buildSnapshot` returns null (§14: hold
nothing rather than invent something), and null means all five pages show the
waiting panel. One unmatched address blanked the site.

The consequence was never limited to the anchor. Every ETH-quoted pool on
this chain was excluded from the listing by the same comparison, so pinning
`USDG_ADDRESS` by hand would have produced a working anchor and a still-empty
board.

`lib/chain.ts` now owns both spellings, and `isEtherSql` is the one SQL
comparison, exported for the same reason `tradedSide` is: the places that
answer "which side is ether" disagreed once already. Treating the two as one
asset is a statement about the wrapper rather than a convenience — aeWETH
mints one token per ether deposited, so pricing a native pool through the
wrapped anchor is exact, not an approximation. They stay separate rows in
`tokens`: different addresses hold different balances, and merging them would
make a pool's reserves unreconstructable from its own events.

Ether is also now **read** rather than probed. There is no contract at
`address(0)`, so `readToken` failed all four calls and fell back to a
truncated-address symbol and — the part that would have hidden this — to 18
decimals, which happens to be right. It answers from `CHAIN.nativeCurrency`
instead, with no supply, because ether's is not an ERC20 read and a fully
diluted value for it would be invented (§7). It is also excluded from the
supply-refresh queue, which is ordered nulls-first: left in, it would have
held one of the few slots a pass has, for ever.

`server/indexer/native-eth.test.ts` is the proof. It builds the same fixture
chain out of native-ether pools and runs the real poller, the real SQL and
the real snapshot over it; against the pre-fix comparison four of its six
assertions fail, starting with the anchor. The older suites could not have
caught this: their fixture is built from wrapped pools, so it proved the
wrapped path and assumed the native one did not exist.

### The waiting page could not tell waiting from stuck

"Looking for the USD anchor" is the same sentence in two situations that call
for opposite actions. A first sync that has not reached the pools yet needs
someone to wait. A sync that is caught up and found no ETH/USDG pool needs
someone to look at the addresses, and waiting is the one thing that cannot
help it. The page said the sentence and not the fact that separates them.

`/api/health` now carries the chain head, blocks behind, percentage and a
`syncing` flag, and the waiting page draws them. The head is recorded on the
cursor by the poller each pass (`indexer_cursors.head_block`, one migration),
so answering costs no RPC call and the endpoint cannot itself be the thing
that is stuck. `deploy/doctor.sh` learned the same distinction — it had no
case for `no-anchor` or `misconfigured` at all, and reported the one state
the box was actually in as "unexpected health body".

### A hardcoded pair of decimals, used by nothing

`PriceAnchors` carried `wethDecimals: 18` and `usdgDecimals: 6`. Every ratio
in the aggregation reads decimals from the `tokens` rows of the pool it is
pricing, which is the only place they are true, so these two were dead — and
a dead field that looks authoritative is one somebody eventually believes.
Had anything read them, a USDG with 18 decimals would have put every dollar
figure on the site out by twelve orders of magnitude. Removed.

### What this does not settle

Whether this chain's pools are native, wrapped, or both is now irrelevant to
the code — all three work — but the §2 addresses are **still unverified on
the explorer**, and a wrong `poolManager` produces the same blank site with a
different cause. `npm run verify:chain` answers that, and `npm run
find:tokens` lists what the chain actually trades (native ether included, now
that it is named rather than printed as an unknown address).

Unchanged and still open: `V3_FACTORY` and `LAUNCHPAD_HOOKS` (§14), the
six-hours-per-tick simulator clock and `/positions`'s forward-looking *Est.
fee yield* (§12), and the protocol fee's immutable cap before P2 deploys.

### Postscript: the deploy that deployed the wrong branch, and two tools that lied

The first deploy after §18 changed nothing on the site, and the reason is
worth keeping. `deploy.sh` on the box hardcoded the previous session's
branch, so `bash deploy.sh` fetched, built and reloaded that branch and
reported success. The version of `deploy.sh` that reads `BRANCH` from the
environment only helps once it is on disk — so the first deploy of any new
branch is a manual `git checkout` followed by `deploy.sh`, and the doc says
so now rather than assuming.

The same box then showed what the first sync actually looks like: block
3,079,887 of ~62.6 million, chain time seventy days behind head, 665 pools
and 44k swaps already in the tables. That is the `syncing` case §18 added
the progress bar for, and it means the anchor may simply not have been
reached yet — waiting is correct, and the native-ether fix is what makes the
wait end when it is.

Two operator tools then invented failures. `verify:chain` and `find:tokens`
each asked every endpoint for 5,000 blocks of logs, were refused by all four
— the caps differ and none are announced — gave up on the first refusal, and
reported "no events in the last 0 blocks" as a fact about the PoolManager
address. `verify:chain` also still failed on an unset `USDG_ADDRESS`, a
value the indexer had been discovering for itself since §17, and told the
operator not to start the sync. `deploy/doctor.sh` did the same. A
diagnostic that reports its own limitation as the patient's fault is the
worst kind (§17), and both did.

`server/chain/logs.ts` is now the one backwards walk, and it narrows on a
refusal the way the poller does — the same range, retried at half the width,
nothing skipped — with a test against a capped fake endpoint. Both scripts
use it, and a walk that is refused even at the floor is reported as an
endpoint problem, never as an address problem.

And a scan from head can only ever see pools *created* in the window it
scans; the anchor pool was created once, months ago. `npm run tokens:indexed`
reads the indexer's own tables instead — every token it has met, ranked the
way the anchor search ranks — and prints exactly the resolution the indexer
and the API would make. It touches no endpoint, so it works when every public
RPC is refusing, which on this chain is the normal state.

### The first real snapshot: TVL $0 everywhere, and a page that crashed on it

The branch reached the box, the anchor resolved, and the site rendered for
the first time against real data — with `TOTAL FEES $805`, `TVL $0`, and
`/pools` on the error boundary: *Reduce of empty array with no initial
value*. Three faults, each only visible with a late anchor.

**Flow was skipped along with the priced tables.** `pool_flow_hourly` is
token amounts, not dollars, and needs no anchor; but the poller skipped the
whole aggregation while the anchor was unknown. On the real chain that was
the first few million blocks. When the anchor finally resolved, the bounded
rebuild staged flow for the discovering pass's hours only, so every pool's
reserves were its recent swaps minus the mint that funded it: negative,
therefore *unknown depth* (§14), therefore TVL $0 on every row and in the
top bar. Flow is staged every pass now, anchor or not.

**"Retroactive" was bounded.** §17 says the pass that discovers USDG prices
history; the rebuild it ran was scoped to that pass's hours, so it did not.
A change of anchor — including none to found, and including a restart — now
runs one unbounded rebuild of every priced table. Once per anchor, and the
restart case is deliberate: it makes a repair on a live box a redeploy, not
a migration.

Neither was catchable by the existing fixtures, whose anchor pool is created
at block 1 — the anchor is known from the first pass and nothing is ever
skipped. `server/indexer/late-anchor.test.ts` creates it two thirds of the
way through the chain, syncs in windows small enough that several passes
complete before it exists, and asserts two things: every pool's depth is
known, and the rows match — as text — a sync that had the address configured
from the start. Against the old poller the first fails with exactly the box's
symptom (`expected 0 to be greater than 0`) and the flow table is missing
half its hours.

**The page crashed on an honest empty.** `MiniCards` ranked pools with
`reduce` and no initial value: an empty list throws, and the "highest fee
yield" card filters to pools with seven days of fees, which on a young chain
is none. A card that should have said "not yet" took the whole page to the
error boundary. Both rankings go through a `maxBy` that returns null, and
null renders a quiet card with the reason.

Smaller: the top bar read `5937929s behind`, which is honest and unreadable;
it reads `68d 17h behind` now (§7 wants the lag shown, not encoded).

### "Stalled" was measured on the wrong clock

With the site finally rendering, the deploy summary's last line read
`STALLED, 5876521s of chain time behind` — for an indexer that was writing
a pass every second. Health judged a stall by **chain lag**: how old the
newest indexed block is. During a first sync that is seventy days, by
definition, while nothing is wrong; and the monitor would have alerted the
whole forty hours, which is how a monitor gets muted.

Liveness is a different clock: wall seconds since the poller last wrote the
cursor (`idleSeconds`). `stalled` is that clock past the threshold — the
process is dead or stuck — and nothing else. Chain lag stays what it was,
the honest figure in the top bar (§7), and two states carry it without
paging anyone: `syncing` (writing, far from head — the first sync, with its
percentage) and `behind` (writing, near head in blocks, but the newest block
is older than the threshold — catching up). Both answer **200** with
`ok: false`; 503 is reserved for states a person has to act on. A pass that
finds head has not moved still touches the cursor, so a quiet chain cannot
read as a dead poller.

`pm2-logrotate` in the process list is deliberate (§15, log rotation): a
first sync logs every pass for forty hours, and without rotation the first
symptom of that is a full disk.

### The first board: dust, `0000…0000`, and three figures that claimed too much

With the boards rendering, the listing showed what a young chain's
PoolManager actually contains, and four things needed saying.

**The listing bar.** 2,343 pools, most of them launchpad dust with a few
dollars of depth, sorted by volume — the pools anyone would stake into were
buried. `LISTING_MIN_FDV_USD` (env, default $1M, `set-env.sh` to tune) is
the bar for a pool's token to be listed. Below it a pool stays indexed and
counted in `/api/health`, and reappears the moment it crosses. The
ether/USDG market is exempt: ether has no supply to read, so its FDV is zero
by construction (§15), not by size. The bar is applied in the snapshot query,
so the header still sums the pools it shows (§12). **This is ALFA's number**;
$1M is a first guess at "big", not a measurement.

**`0000…0000 / Unknown token` as the most-traded market.** That row is ether.
It was written by the version of `readToken` that did not know address(0)
(§18), and `tokens` rows are written once and left alone — right for a
contract's facts, wrong for a row that was wrong. `repairNativeToken` asserts
the constants on every start.

**Three claims about unknowns.** `$0 MC` for ether, where §15 says an em
dash; `▲ +0.0%` in green for a pool with no price a day ago — the anchor was
younger than a day in chain time, so *every* row said it — where the honest
figure is a dash in no colour; and the top bar clipping `$3,801,09x` to
`$3,801,09`, a number that is simply wrong. `change24hPct` is nullable now
and rendered as a dash, the headline average is weighted over the pools
whose change is known, and headline figures go compact past $1M.

**The panel said "no indexed blocks" over a line saying which block.** The
first page load can arrive before the first snapshot does; with the indexer
priced and syncing, the copy now says the snapshot is loading rather than
that nothing has been indexed.

**Logos.** Every token has its derived mark; real logos come only from a
token list (§4, §17). Robinhood Chain has none, and this session cannot
verify whether any aggregator carries the chain, so nothing is wired to a
guessed URL. With the bar in place the listed set is small enough to curate:
`config/tokens.json`, Uniswap token-list shape, `logoURI` only, picked up on
the indexer's next pass.

### One row per token, and a fixture that had been lying about NVDA

The first filtered board listed CASHCAT twice and the ether market twice.
A token on this chain routinely has several pools — fee tiers, hooked
variants — and the query returned one row per pool. The board is a token
listing (§6, and every row of the prototype), so a token's row is now its
deepest pool: the one the Stake button opens and the one a yield figure
honestly describes. Shallower pools stay indexed and unlisted, and the
header sums the rows it shows (§12).

Writing the test for it found a fixture bug that had been there since P1.
The fixture derives a log's tx hash from `(block, logIndex)`, rows are keyed
by exactly that (§4.1), and every pool's seed logs sat at indices 0 and 1 of
its init block — so two pools created in block 1 collided, and the second
pool's funding mint was silently dropped. **NVDA/WETH in the default chain
has had unknown depth all along**, and the suites tolerated it because the
yield-state assertions accept `insufficient` where they should not have had
to. Seed logs sit at index 1000+ now, above anything a block's swap counter
reaches. Nothing in the indexer changed; the fixture simply stopped
contradicting the chain it stands in for.

The `0000…0000 / Unknown token` row on that board is the ether market,
still carrying the row an earlier `readToken` wrote. `repairNativeToken`
runs on the indexer's first pass after a restart and logs when it does; the
pass is preceded by the deployment-block bisection and the full rebuild, so
the label lags a deploy by a minute or two.

### "Loading the snapshot" on every refresh, and logos from outside

**Every refresh waited on the expensive query.** Two things multiplied.
The API answered `/api/snapshot` from its cache only when the cache was
younger than the stream debounce — one second — and every websocket client
forced its own rebuild on every indexer tick, which during a first sync is
every second. So the query that prices, sums and sparklines every pool ran
continuously, page loads queued behind it, and the panel sat on screen for
as long as the queue was. And the query did all of that work for every pool
before applying the listing bar: 2,600 pools of correlated lookups for a
board of fifty.

The bar is a `listed` CTE now, in front of every per-pool CTE. And the
snapshot is served **stale-while-revalidate**: the last build is answered
immediately, a rebuild starts in the background at most once per
`SNAPSHOT_MIN_REBUILD_MS` (five seconds), and a socket is pushed only when
the revision changed. The first request after a start is the only one that
waits. A few seconds of staleness is invisible next to the lag the top bar
already shows (§7).

**Logos.** §4 permits them from outside, and the list in `config/tokens.json`
was never going to cover a launchpad chain. `server/indexer/logo-sources.ts`
asks CoinGecko, DexScreener and (with `CMC_API_KEY`) CoinMarketCap for one
image URL per token and nothing else — not price, not supply, not decimals.
One token every `LOGO_LOOKUP_MS`, listed tokens first, a miss not asked
again for a week (`logo_checked_at`, one migration), a source that does not
know this chain disabling itself and saying so once. CoinGecko's platform id
is discovered from its platform list by chainId 4663 rather than guessed.

**What is not verified:** the session that wrote this could not reach any
of those services, so the parsers are written to the documented shapes and
treat anything else as "not found". Whether CoinGecko or DexScreener has
this chain at all is a fact the indexer will discover on the first pass and
log. The token list remains the override, and the derived mark remains what
renders when nothing else does. Launchpad sources (Pons, Bags, Bottom.fun)
need an endpoint from someone who knows them — each is one function here.

### Depth, and a second typeface on the table

ALFA looked at the first real board and asked for something that reads as
premium. Two answers, one shipped and one offered.

**Shipped: materials.** Every surface is now lit from above — a one-pixel
highlight on the top edge, a faint gradient down the first third, a shadow
that falls away below — and the page has a soft vignette behind it. Token
badges have a sheen and an inner shadow, so a derived mark reads as a coin
rather than a sticker; the top bar is glass; the brand button has a gradient
and a glow. All of it is neutral light on neutral surfaces: the colour rule
(§5) is untouched, and green still means brand, positive, or active. Badges
paint their colour with `backgroundColor` now, because the `background`
shorthand wiped the sheen.

**Offered, not shipped: Inter for UI text.** §5 says JetBrains Mono
throughout, and the mono-everywhere look is the "terminal" in the terminal
aesthetic. `html.sans` is an opt-in class that sets labels, names and copy
in Inter and keeps every figure in tabular mono so columns still line up.
Both were rendered locally at the width ALFA actually sees — 1280 CSS px,
which is a 1920 display at 150% — and sent as screenshots. Enabling it is
one class on `<html>`; it stays off until ALFA picks.

Verified with Playwright against the built site and simulated data. On the
live site the largest difference is not CSS at all: monogram badges and
flat sparklines are what a first sync looks like, and real logos are what
change the feel most. See the logo-sources note above for where those come
from and what is still unverified.


---

## 19. The Journal: a light design system, chosen over §5

Added when ALFA looked at the first real board and asked for something that
reads as premium. §5's dark terminal was the approved prototype; ALFA chose
a different direction from a set of sketches (`design/directions/`, artboard
**B3 · Journal**), and this section records what that changed and what it
deliberately did not.

### What moved

**Paper, not a terminal.** Warm off-white page, white cards, ink-dark text,
one green. The tokens in `app/globals.css` are the whole palette; the names
§5 introduced (`--bg`, `--panel`, `--fg`, `--ac`, `--red`, and so on) are
kept so that no component changed a variable name, only its value. Every
foreground colour was measured against the paper rather than picked by eye:
`--fg-3`, the quietest text that carries a label, is 4.4:1; the accent is
4.3:1 on paper and 4.8:1 on white; `--fg-4` is decorative only.

**Three typefaces, each with one job.** Instrument Serif for headlines and
the rank numerals, DM Sans for everything read, IBM Plex Mono for everything
counted. The `.num` class now sets the mono face as well as tabular figures,
so a number is a number wherever it appears. §5's "JetBrains Mono
throughout" is the one rule of §5 this replaces outright.

**Navigation across the top.** The fixed sidebar and the 64px icon rail are
gone; `components/shell/TopNav.tsx` holds the brand, the five pages, search,
the freshness chip and the wallet. Below 900px it takes two rows, stops
being sticky, and the links row scrolls inside itself — the page never
scrolls sideways, which the shell test still asserts at 360px.

**A masthead on every page.** `components/shell/Masthead.tsx`: eyebrow,
serif headline, a line of copy, and the four global figures as a labelled
facts column on the right — Positions, Value locked, Paid to LPs all time,
ETH — over one heavy rule. §5 put those four figures in the top bar as
unlabelled pills; here they have room for their names. On `/pools` the
headline *is* the day's numbers: how many markets are listed and what they
paid in fees over the last 24 hours, both summed from the rows beneath it
(§12), and the dateline is chain time — now less the indexer's lag — because
a dateline is a claim about when (§7).

**One leaderboard, two rankings.** The prototype's Trending and Established
boards are one list with a facet: *By volume* ranks everything, *By fee
yield* ranks only pools with seven days of history (§10's assumption, kept).
The rows are an ordered list rather than a table — a leaderboard is exactly
what `<ol>` means — with a large serif rank, a 40px mark, the symbol over a
line of FDV, depth and name, the day's fees, a 24h pill and a wide fee
sparkline. The FLIP reorder, the value flash, the leader highlight and the
Stake button on hover are unchanged in behaviour and re-asserted by the
same e2e tests against the new elements. The featured card and the two
mini cards are gone; their figures are in the masthead.

**The column priorities changed with the columns.** §5's drop order (Vol
24h and Depth at 1780px, Age at 1560px) described a nine-column table.
The row now loses the sparkline below 900px, tightens below 640px, and
loses the rank numeral below 420px — the order says the rank. Depth moved
into the row's second line rather than out of the row.

**Token marks on paper.** `lib/token-mark.ts` draws a pastel disc with a
dark ink of the same hue, and the test walks all 360 hues: 5.06:1 at worst.
The badge no longer uses the provider's `logoColor` for a monogram — that
colour is a stored value derived by the previous palette, so a live row can
carry a disc the current ink was never measured against. It stays as the
backdrop under a real logo, where it does no harm.

### What did not move

The colour rule. Green still means brand, a positive number or an active
control, and red still means a negative number and nothing else; the pills,
segmented controls and the bin chart were rebuilt inside that rule. Every
honest-numbers rule in §7, with their tests. The `DataProvider` boundary —
no component reads data any differently. The waiting page, the drawer and
its focus trap, `prefers-reduced-motion`, and no horizontal overflow at
360px.

### Open, for ALFA

- **The default ranking is by volume**, as the chosen artboard shows. §1
  says every ranking defaults to fee yield. On the live chain the fee-yield
  facet is empty until a listed pool has seven days of fees, so a fee-yield
  default would open on an empty board for the first week; after that it
  is one click away. If §1's default is what is wanted, it is one line.
- **The favicon and the OG card** still carry the dark mark on black. They
  are brand assets, not the page, and were left alone until the mark itself
  is settled (§13).
- The §12 questions — the simulator's six-hours-per-tick clock and
  `/positions`'s *Est. fee yield* — and the §14 inputs remain open.

### First look at the live Journal: empties, logos, and where the project talks

ALFA looked at the deployed page and asked three things: why so much is
still empty, why the tokens still have no logos, and for X, Telegram and a
"CA · coming soon" line.

**What is empty, and why it stays honest.** Positions, vaults, stakes and
the portfolio are empty because the contracts that create them are P2 (§8);
nothing on the site invents them. What was wrong was how the pages said so:
an empty vault grid read "No vault matches — try a ticker", the portfolio
read "$0 · +0.0% all time" and "Best week so far", and the router promised
"Est. first route: 0.00 WETH → +$0 depth" and drew a rising projection from
nothing. Each of those is a claim about a history that does not exist (§7).
They now say what is true: no vaults yet and why, nothing staked yet, no
positions yet, dashes with a caption where a figure would be a claim, and a
projection only once a fee source is accruing. The ether row said "no supply
read", which is operator-speak for a fact about ether — it has no contract
and no supply — and now says "native asset".

**Logos: the chain's own explorer, asked first.** The three aggregators in
`logo-sources.ts` were written blind (§18) and there was still no way to
tell, from the box, what they answered. Two changes:

- `blockscout()` asks the explorer the ethereum-lists/chains registry names
  for chainId 4663 — `robinhoodchain.blockscout.com`, `EXPLORER_URL` in
  `lib/chain.ts`, `EXPLORER_API_URL` to override — for `/api/v2/tokens/{addr}`
  and reads `icon_url`, nothing else. It is native to this chain, so it is
  first in `LOGO_SOURCES`. A token the explorer has no icon for falls
  through to the aggregators as before.
- `npm run logos:probe` asks every configured source about the top listed
  tokens (or the addresses given) and prints, per source, the HTTP status
  it saw and the URL it yielded — or the error. It writes nothing. This is
  the answer to "why no logos" that the poller's log could not give.

Two consequences carried through. A miss is silent for a week
(`logo_checked_at`), which is right for a source that said no and wrong for
a source that did not exist when the question was asked — so the poller now
clears the mark for every logo-less token on restart, and a deploy becomes
the moment the new source gets its turn, one token per `LOGO_LOOKUP_MS`.
And ether, which no aggregator can be asked about by address, is in
`config/tokens.json` with an image this site serves itself
(`public/tokens/eth.svg`); that file is now the default `TOKEN_LIST_URL`,
so a box that never set the variable still gets ether right.

None of this could be verified from the session that wrote it: the sandbox
reaches GitHub and Google Fonts and nothing else. The explorer URL is the
registry's and the API shape is Blockscout's documented one; the probe
exists precisely so the first run on the box says what is true.

**X, Telegram, and the contract address.** `lib/site.ts` reads
`NEXT_PUBLIC_X_URL`, `NEXT_PUBLIC_TELEGRAM_URL` and `NEXT_PUBLIC_TOKEN_CA`
at build time. The icons sit in the navigation and, labelled, in the
footer; an unset one is an unlinked icon that says "coming soon" on hover
rather than a link to nowhere. The contract address is a fifth row in the
masthead facts on every page and a line in the footer, reading
"CA · coming soon" until it is set — with a tooltip saying that any address
circulating before it appears there is not ours, because a site that asks
people to connect a wallet should say so. Set them with `deploy/set-env.sh`
and deploy; Next.js inlines them when it builds.

### What the first probe said, and what it changed

`npm run logos:probe` ran on the box and answered the question. Three
things, two of them mine:

- **The explorer answered 403 in seventy milliseconds** — every token, every
  time. That is an edge rule refusing the client, not an answer about the
  token: Node's `fetch` identifies itself as `node`, which is what such rules
  look for. Every request now carries a named agent
  (`Mozilla/5.0 (compatible; Balast/1.0; +https://balast.xyz)`), and there is
  a test that it does. If the explorer still refuses, it is refusing servers
  as a matter of policy and the probe will show it.
- **CoinGecko: one 404 on the platform list, then 429 on everything.** The
  source asked for the platform list on every token because a failed answer
  was treated as transient, and the public tier allows a handful of calls a
  minute. A failed platform fetch now waits ten minutes; a 429 pauses the
  source for ninety seconds. One refusal costs one token, not the board.
- **DexScreener answered 200 and yielded nothing**, which is a shape
  question the old probe could not answer. The probe now prints every
  request's status, content type and the first line of the body, so the
  next run says whether the chain is unknown to it or the image is simply
  missing.

And the probe's own choice of tokens showed a fourth thing: it asked about
GLTCHT, USDG and bbqUSDGturbo — the largest FDVs in the table, which on a
launchpad chain are dust with absurd supplies — while ETH, VIRTUAL and Index
sat on the board without logos. The poller asked in the same order.
`logoCandidates()` now ranks by the pools' 24h volume, the board's own
order, and the probe uses the same function, so what it prints is exactly
what the poller asks about next.

### The stalled indexer, and logos that no longer wait on it

`logos:status` on the box answered the question the probe could not:
**"0 asked about — indexer cursor last written 9344s ago."** Every source
was answering, and no token was asked, because the lookup ran inside the
indexer's pass and the indexer had not finished a pass in two and a half
hours. Two faults, both structural.

**A restart cost a full rebuild, and deploys came faster than rebuilds.**
§18 made the unbounded rebuild of every priced table run on a change of
anchor *and on every restart* — "a cheap way to make a repair a no-op".
Cheap on a fixture. On the real tables, after 4.4 million blocks, it takes
longer than the gap between two deploys, and every deploy restarted it from
the beginning: a day of deploys was a day in which no pass wrote the cursor,
health said `stalled`, and nothing downstream moved. The anchor the tables
were last rebuilt for is now remembered (`indexer_state`, one migration),
so a restart with the same anchor does the bounded rebuild every pass does.
`npm run aggregates:rebuild` forgets the marker when a change to the
aggregation SQL needs the full one. The full rebuild also logs each step's
time, because a silent hour is indistinguishable from a hang.

**Logos are a process of their own.** `balast-logos` (`server/logos/main.ts`,
in the PM2 list, the doctor and the monitor) reads the token list, asks the
sources about one token every `LOGO_LOOKUP_MS`, records what it finds and
nudges the API. It re-asks every logo-less token on start, board first. The
poller no longer knows logos exist. A decoration must never wait on a block,
and it did.

Unverified from here, as before: whether the indexer on the box is stuck in
that rebuild or dead for another reason is in `pm2 logs balast-indexer`,
which the deploy summary and the doctor both point at.

### Two more sources: tokenised stocks, and GeckoTerminal

With logos flowing (Index and VIRTUAL were the first), the board showed
what the aggregators do not carry: Robinhood's tokenised stocks and the
launchpad coins.

**Tokenised stocks are knowable from the ticker.** "AMD • Robinhood Token"
names its kind, and a ticker is unique on its exchange, so the `tickers`
source maps such a token's symbol to a public repository of ticker icons
(nvstly/icons on GitHub, one PNG per ticker, verified for the board's
stocks; SPY, GLD, SLV and SPCX are not there). Only a token whose name says
"Robinhood Token" is looked up this way — a launchpad coin calling itself
GME must not wear GameStop's mark. Those icons are drawn for a dark theme,
so the badge paints them on an ink coin, inset.

**GeckoTerminal** for the rest: keyless, and the aggregator that reads what
launchpads publish. Its id for this chain is discovered from its network
list by name (`GECKOTERMINAL_NETWORK` pins it), a chain it does not list
disables the source once and audibly, and "missing.png" is read as none.
Unverified from here — the sandbox cannot reach it — and written to the
documented shape, as the others were; the probe says what it answers.

The default order is explorer, tickers, geckoterminal, dexscreener,
coingecko, coinmarketcap: chain-native first, the rate-limited one last.

### The token's own word: on-chain metadata

With the aggregators answering, the board still had launchpad coins none
of them carried (VLAD, MARIAN). One source is left that needs nobody to
have listed the token: its own contract. Launchpads that follow ERC-7572
publish `contractURI()`, home-grown ones `metadataURI()`, `image()`,
`imageUrl()` or `logoURI()` — a URI pointing at JSON with an `image`, or
at the image itself. The `onchain` source tries each (one `eth_call`; a
contract without the function reverts), resolves `ipfs://` through a
gateway (`IPFS_GATEWAY`), decodes an inline `data:` JSON in place, and
records only an https image URL.

It fetches metadata only over https and never from a bare IP or localhost.
A contract can name any host it likes and this process runs on the box next
to the API; the test pins that refusal. Whether this chain's launchpads
publish anything the source can read is, as with the others, a fact the
probe reports.

### An empty disc is not a logo

Four rows on the board — SPCX, AMD, TSLA, NVDA — showed a saturated disc
with nothing in it: a logo URL had been recorded, and the browser could
not fetch it. A source had named an image that answers only to its own
site, or over http, or with an html page. Three rules now stand between a
source's answer and the board:

- **A logo is recorded only once it has been seen to load** from the box:
  one GET, 2xx, and an image content type when the server states one. A
  source whose image does not load is logged and the next source gets its
  turn; the check is tested against a 404 and against `text/html`.
- **https only.** An http image on an https page is blocked by the browser
  silently, which is exactly the empty disc.
- **The badge falls back to the monogram** when the image errors, or is
  found complete with no pixels after mount — an image that fails before
  React attaches never fires the error event, so both are checked. Under a
  logo with a transparent background sits the pastel mark, not the stored
  brand colour from the old palette.

On start the logo process checks every logo already on record and forgets
the ones that do not load, so the tokens are asked about again under the
new rules.

### Logos served from here

The empty discs became monograms, and AMD and TSLA — whose ticker icons
exist and load — stayed monograms. That is the same fault one step later: a
URL on record that loads from the box and not from a browser, so the load
check passes, the source that would have worked never gets its turn, and
the page shows nothing. Two clients, two answers, and no way to reconcile
them from either side.

So there is one client now. `GET /api/logo/{address}` fetches the URL on
record the way the logo process did when it checked it, holds the bytes in
memory for a day, and answers 404 for anything that is not an image; the
badge asks that route and nothing else. "The box can load it" and "the page
shows it" are the same test. Only URLs on record are fetched — it is not an
open proxy — and the route is outside the rate limit, because a hundred
badges on one page load is normal, not a loop. `logos:status` now lists
the board's rows with the URL on record and whether it loads from the box;
`logos:probe` prints the URL on record beside each token.

### The issuer's bird, and a wallet dialog

**Every tokenised stock wore Robinhood's feather.** The explorer answers
with the issuer's mark for every one of its stock tokens — and it was asked
first, so NVDA, TSLA and AMD were the same bird. `tickers` now outranks the
explorer for a "Robinhood Token", and on start the logo process replaces
whatever such a token has on record with its ticker icon when one exists
and loads. The ETFs have no ticker icon in the repository and keep the
feather: Robinhood's mark on Robinhood's token is not wrong, just not what
a person wanted to see. SpaceX is the next subsection.

**Connect wallet is a dialog now** (`components/shell/WalletModal.tsx`,
`lib/wallet.ts`). EIP-6963: every installed extension announces itself with
a name, an icon and a provider, so the dialog lists what the person has —
MetaMask, Rabby, Coinbase Wallet — rather than one button that grabs
`window.ethereum` and hopes. Connecting asks for an account, then for
Robinhood Chain (switch, or add and switch; declining the switch is not an
error, nothing here signs), and remembers the wallet so a reload reconnects
quietly through `eth_accounts`. Connected, the button shows the address and
the dialog offers copy, explorer and disconnect. It traps focus and closes
on Escape like the drawer.

The list is a floor, not a filter: MetaMask, Rabby, Coinbase Wallet,
Phantom, OKX, Trust and Brave are always shown — installed ones with
Connect, the rest with an Install link — and any other wallet that announces
itself is added. WalletConnect, for a phone by QR, appears once
`NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` is set (a free project id from
cloud.reown.com); its provider is loaded only when chosen, because it is a
large one, and a session survives a reload. Until P2 nothing is signed from
any of them.

### A mark of our own, and wallets wearing theirs

**SPCX still wore the feather** after the ticker icons landed, and it
always would have: SpaceX is on no exchange, so no ticker repository
carries it, the `tickers` source answered null, and the explorer's answer
stood. The fix is the same shape as ether's (§19, *First look*): a mark
this site serves itself. `OWN_STOCK_MARKS` in `logo-sources.ts` maps a
"Robinhood Token" ticker to a file under `public/tokens/`, reached as an
absolute https URL on the canonical site so the same load check, the same
https rule and the same logo proxy apply as to any other source's answer.
The `tickers` source answers it before asking the repository, and
`upgradeStockLogos` replaces the feather with it on the logo process's
next start — once: a mark that is already on record is skipped rather
than rewritten and counted on every restart, which the query alone would
have done, since the URL is not under the repository's base. The SVG is
inset (`viewBox -4 -4 32 32`) because the badge is a circle and the
wordmark's ends sat outside it at full width.

Adding another private company is one line in that map and one file; the
token's address is not needed, which is why this is not an entry in
`config/tokens.json`.

**Every wallet in the dialog has its logo.** A wallet that is installed
announces its icon (EIP-6963); one that is not announces nothing, so its
row showed a letter on a coloured disc, and so did WalletConnect's. Each
entry on the known list now carries `icon`, a file under `public/wallets/`
(the marks RainbowKit ships, MIT), and `walletIcon()` picks the announced
icon when there is one and the known mark otherwise — an extension that
announces an empty icon gets the same fallback. A test asserts every file
exists, because a missing one is a broken image on the one dialog that
asks people to trust the site.

### Banners for X

Seven images under `brand/social/`, each an artboard in the Journal system:
`social.css` copies the tokens from `app/globals.css` rather than restyling
them, the brand lockup is the navigation's (ink mark, serif wordmark), the
masthead's eyebrow, serif headline with one italic green phrase, lede,
heavy rule and footer line are the site's, and the illustrations are the
site's own components drawn at banner scale: the leaderboard's serif rank
numerals, the masthead's facts column, the stake stream bar, the bin chart
in its bid-ask shape with the token side in the accent and the ether side
in the soft tint. Six are 1600 × 900 for a post (introduction, Stakes,
Positions, Router, honest numbers, contract address) and one is the
1500 × 500 profile header. `npm run brand:social` renders them at 2× with
Playwright, waiting for the three faces to load.

Two rules carried over from the site. **No number a reader could take as a
yield.** The stream shows a day of seven and the bin chart shows weights,
not dollars; §7 applies to a banner as much as to a row. **No handle.**
The owner asked that neither an X nor a Telegram handle be written on
them, so the only address on any banner is `balast.xyz`, and the
contract-address banner says what the site's masthead says: there is no
token yet, and any address circulating before it appears there is not
ours.

### X, and no Telegram

The account is **@Balastdotfi**. `lib/site.ts` carries the link as the
default rather than waiting on an environment variable, so a plain deploy
shows it; `NEXT_PUBLIC_X_URL` still overrides it. `X_HANDLE` is derived
from the link for the page's card metadata, so the two cannot disagree.
Telegram was removed at the owner's request: the icon, the variable and
the second row of the footer. `brand/social/COPY.md` holds the posts that
go with the banners, one per image, each under 280 characters and written
inside §7: no yield figure, no "APY", nothing the contracts cannot keep
yet, and the contract-address warning pinned before anything else goes out.

### The X link that read HANDLE_ANDA, and a logo on paper

**The live site linked to `x.com/HANDLE_ANDA`.** The code carried the real
account as the default and read `NEXT_PUBLIC_X_URL` over it; the box's
`.env` held a placeholder typed in by hand, and the placeholder won. A fact
this public is now a constant in `lib/site.ts`, the variable is gone from
`.env.example`, and nothing reads it — a stale value in `.env` can no
longer reach the page. `X_HANDLE` is still derived from the constant.

**The brand on paper.** Every file in `brand/` was the prototype's mark on
black, so the avatar on X and the link preview disagreed with the paper
site behind them. `brand/journal/` is the same mark and the navigation's
pairing — ink mark, "Balast" in Instrument Serif — drawn as outlines by
`scripts/build-brand-journal.py`: full-bleed paper icons for avatars (ink,
brand green, and paper-on-ink for dark grounds), a squircle, three lockups,
and a 1200 × 630 card on paper that now serves as `/og-card.png`. The paper
is the page's own: `--bg` lit faintly from the centre, `--raise` at the
corners. In the lockup the mark's ink stands 1.1 × the cap height, centred
on it, a touch larger than the navigation sets it, because a logo on its
own carries its weight in the mark. The three faces are fetched from the
google/fonts repository into an ignored `.fonts` folder on first run.

**The favicon is paper too.** The owner pointed at the tab, still showing
the green mark on black beside a paper site, and asked for the paper icon.
`app/icon.svg` — the file Next.js serves as `/icon.svg`, so also the icon
WalletConnect shows a phone — is now written by the same script: the
full-bleed cut on flat paper, because a gradient is invisible at 16px. It
was checked at 16 and 32px on a light and a dark tab strip; the ink mark
carries it on both. The dark favicon files stay in `brand/` for anyone who
wants them.

---

## 20. Mainnet through Uniswap, not through contracts of our own

ALFA's call, in four words: *lempar semua ke Uniswap*. No contract of
Balast's own goes to mainnet; every on-chain action runs through Uniswap
v4's deployed, audited contracts, and Balast's surface is the calldata it
builds and the honesty of what it shows. This section records what that
means product by product, what is built, and what it does not cover.

### The addresses are verified now

Uniswap's own registry — `sdks/sdk-core/src/addresses.ts` and
`universal-router-sdk/src/utils/constants.ts` in github.com/Uniswap/sdks —
lists Robinhood Chain (chainId 4663). Every v4 address in §2 matches it
byte for byte: PoolManager, StateView, V4Quoter, and the Universal Router
(v2.1.1, created at block 18127). It also supplied the two the handoff did
not have: the **PositionManager**, `0x58daEc3116aae6D93017bAaEA7749052E8a04FA7`,
and the **v3 factory**, `0x1F7d7550B1B028f7571E69A784071F0205fd2Efa`, which
§14 had been waiting on and the indexer now follows by default.

### Positions: built, through PositionManager

`/positions` mints for real. The shape builder's inputs — a deposit in the
quote, a range as a percentage around the token's price, a bin count and
a shape — become one `modifyLiquidities` transaction: one `MINT_POSITION`
per bin, each with the liquidity its weight of the deposit buys at the
live price, then `SETTLE_PAIR` to pay for all of them and, for an ether
pool, `SWEEP` to return the unspent ether. Each bin is a position NFT in
the person's wallet; Balast holds nothing at any point.

The pieces, all in `lib/v4/`:

- **Tick and liquidity maths.** `tick-math.ts` moved here from the
  indexer (which still imports it), and `liquidity.ts` sizes a bin by
  value: at sqrt price P one unit of liquidity in a range is worth
  `amount1 + amount0·P²` in currency1, linear in liquidity, so the
  liquidity for a share of the deposit is one division. Every amount that
  reaches a transaction is bigint from the sqrt price the chain reported.
- **The encoder.** `actions.ts` carries the action ids from
  `Actions.sol` and the parameter layouts from `PositionManager
  ._handleAction`. Its test builds the same actions with Uniswap's own
  `V4Planner` and asserts the bytes are identical, and `poolId` is
  asserted against the SDK's `Pool.getPoolId`. The SDK is a dev
  dependency only: it carries ethers v5 and would double the page.
- **The plan.** `mint.ts` maps the token's percent range onto pool ticks
  (mirrored when the token is currency1, whose price is the pool's
  inverse), splits the range into whole tick spacings as evenly as the
  arithmetic allows, reverses the shape's weights when the pool runs the
  other way, and caps every position at its own share plus one percent.
- **The flow.** `flow.ts` reads slot0 from StateView, balances from the
  tokens, and the two allowances PositionManager's `_pay` needs — the
  token's to Permit2 and Permit2's to PositionManager — then
  `eth_estimateGas` runs the exact calldata against the node before the
  wallet is asked to sign. A mint that would revert is refused before any
  signature, with the reason in words.

Two honest limits, both on screen. **The deposit is two-sided for now.**
A bin that straddles the price needs both currencies, and without a swap
the wallet has to hold both; the builder shows exactly how much of each
the plan takes and refuses if the wallet is short, naming the shortfall.
The single-token zap — a Universal Router swap of the token side in the
same transaction — is the next slice. **The price is the chain's, not the
indexer's.** The builder polls slot0 every twelve seconds and plans
against it; the indexer, which can be days behind (§7), supplies only the
trailing-yield estimate, labelled as before.

Nothing sends from simulated data: a pool with no on-chain key gets the
old button and a toast that says so.

### Stakes: what the model makes of them, for ALFA

Under "everything to Uniswap" a Stake is a position the person holds —
one full-range mint into the pool, fees accruing in the position, a
`DECREASE_LIQUIDITY` of zero to collect them, `BURN_POSITION` to leave.
Three things §3.3 promised do not survive that: the seven-day stream
(a vault's behaviour), the anti-snipe property the stream gave, and the
protocol fee taken at harvest. **Without a vault there is no protocol
revenue.** That is a product decision, not an engineering one, and
`/stakes` is unchanged until ALFA makes it: keep the honest empties, or
rebuild the page as self-custodied full-range positions with the
consequence above written on it.

### Router: cannot be delegated

A fee stream routed into permanent depth on a TWAP is logic no Uniswap
contract performs. `BalastRouter` stays P4 and stays a contract, with the
audit that implies; the page keeps its copy and its honest empty.

### Portfolio: next

PositionManager is an ERC721. The indexer will follow its `Transfer`
logs into the `positions` table and read each token's key and liquidity,
so `/portfolio` can show what a wallet holds with in-range status and
collected fees. Not built in this slice.

### What "fully audited" does and does not mean here

Uniswap's contracts are audited; Balast deploys none. What Balast can
still get wrong is the calldata, and that is guarded three ways: the
encoder is byte-compared with Uniswap's SDK, every plan is dry-run by the
node before signing, and each position's take is capped at its own
share. What this session could not do is run a fork test against the
real chain — the sandbox reaches no RPC — so **the first mint on the live
site should be a small one**, watched on the explorer, before anything is
announced. A pool with a hook can refuse outside liquidity; the dry run
catches that and says so, and `LAUNCHPAD_HOOKS` (§14) still needs
setting so such pools are not offered at all.

### The backfill that ran at the speed of the chain

The board on the box read *68d 2h behind* one night and *68d 15h behind*
the next noon: thirteen hours of wall time, thirteen hours of lag gained,
no net progress at all. The indexer was processing chain time at roughly
the rate the chain produced it, so nothing launched in the last two months
— every Pons token the owner asked for among them — had ever been read.

The pass was doing four things that scale with the size of the tables or
the busyness of the chain rather than with the window:

- **One `getBlock` per block that carried a log**, sixteen at a time. On a
  launchpad chain most blocks carry a log, so a 2000-block window was
  hundreds of sequential round trips to a public endpoint. `eth_getLogs`
  is now called raw, because a recent node stamps `blockTimestamp` on
  every log and viem's formatter drops it; what is still missing is
  fetched fifty blocks to one JSON-RPC batch, and an endpoint that refuses
  a batch is found out once and asked one call at a time from then on.
- **`rebuildPoolState` for every pool, every pass** — a `DISTINCT ON` over
  every pool's whole swap history and a sum over all its flow. It is
  scoped to the pools the window touched, with every pool redone once the
  pass reaches head and every sixtieth pass while it is far from it,
  because untouched pools still carry the anchor's price.
- **`classifyPools` walking every pool with a query each, every pass.**
  Once per run for every pool; after that, only the pools a pass found.
- **Four RPC calls per new token**, one token at a time. Missing tokens go
  through Multicall3 fifty at a time, with the old per-token path as the
  fallback when a multicall itself fails. `loadPriceState` is scoped to
  the batch's pools, and supplies are re-read every twentieth pass rather
  than every pass while backfilling.

None of it changes a row. §9's adaptive-versus-fixed comparison still
holds byte for byte, and the late-anchor and native-ether suites pass
unchanged.

**Every pass now says where its time went** — `logs`, `times`, `tokens`,
`ingest`, `rebuild`, and blocks per second — in the log line, and the last
pass is kept in `indexer_state` and shown by `/api/health` under
`indexed.lastPass`. The number to watch is blocks per second: at 2000-block
windows the chain makes ~10 blocks a second, so anything under that is a
backfill that will never finish, and the stage that dominates the line is
where to look next.

What this does not solve: a launchpad's **pre-graduation** trading happens
through its hook, not through plain pool swaps, and the indexer only
decodes what it knows. `LAUNCHPAD_HOOKS` (§14) still needs the hook
addresses; post-graduation pools appear on their own once the backfill
reaches them.

### The original logos: the issuer's own icon outranks the ticker repository

The board showed SPCX in Robinhood's own style — the SpaceX mark on the
issuer's lime — beside AMD and TSLA wearing white-on-ink icons from the
ticker repository. The owner asked for the originals. The history: the
explorer once answered one feather for every stock token, so the ticker
icon was made to outrank it (§19); the explorer has since begun serving
real per-stock icons, and the override was now hiding them.

Three changes, all in `logo-sources.ts` and the logo process's start:

- **The explorer refuses a generic icon.** `isGenericLogo` says an icon
  is the issuer's, not the token's, when it is on a remembered list or
  already on record for two other tokens. A picture shared by many tokens
  describes none of them. The explorer is asked first again
  (`LOGO_SOURCES` default), and the process logs a line if a box's `.env`
  still pins the old order.
- **Shared icons are forgotten on start.** `forgetSharedLogos` clears any
  URL three or more tokens carry (own-site marks exempt: ether and its
  wrapper share one file), remembers it under `generic_logo_urls` in
  `indexer_state`, and lets the tokens be asked again under the new rule.
- **Stocks are reconciled, not upgraded.** `reconcileStockLogos` replaces
  `upgradeStockLogos`: for every "Robinhood Token", the explorer's own
  specific icon if it has one, else the ticker icon, else this site's mark
  — whatever is on record, so a ticker icon gives way to an original that
  has since appeared. Tested for all three outcomes and for the no-change
  second run.

Unchanged: a token no source knows (GUH on that board) keeps its derived
mark, and `npm run logos:probe -- GUH` is how to see which sources were
asked and what they answered.

### Volume on the row, and a launchpad's own page as a source

**The board ranked by a number it did not show.** Every row now carries
the day's volume beside the day's fees — `vol · 24h`, then `fees · 24h` —
in both facets. Fees stay the headline (§1: they are what an LP earns;
volume is what produced them), so below 640px it is the volume column
that drops, after the sparkline. Verified at 1280, 800 and 390 with no
horizontal overflow.

**Pons.** The owner asked for the launchpad's tokens. Two facts first:
PONS graduated 63 days ago and the indexer is 68 days behind, so nothing
from that launchpad has been read yet — they arrive when the backfill
does, and the throughput work above is what makes that hours rather than
never. Graduated tokens trade in ordinary v4 pools and need nothing
special; pre-graduation trading goes through the launchpad's hook, which
still needs its address (`LAUNCHPAD_HOOKS`, §14).

What could be built now is the launchpad as a source. `launchpadPage`
asks a launchpad's own site for the token's page — `{base}/{address}`,
Pons at `ponsfamily.com/launchpad` — and reads the token image out of the
page's data: an `image`-like field in the JSON the app ships with the page,
escaped or not, and `og:image` only when it names an image file, because
on such sites `og:image` is as often a generated share card as the logo.
A source that answers is the launchpad the token came from, so the token
row records `launchpad` (metadata, which §4 allows from outside). `pons`
sits in `LOGO_SOURCES` after `onchain`; `PONS_LAUNCHPAD_URL` moves it.
Unverified from here, as every source was: the sandbox reaches no
launchpad, the parser accepts the common shapes, and `npm run logos:probe`
prints what the real page answers.

### The stall, read off the log: a floor the refusal could not pass

The first log after the throughput deploy said it in one line, repeated:
`endpoint refused 2000 blocks (getLogs(4408256-4410255) failed on all 4
endpoints) — range now 2000`. Every endpoint refused a 2000-block window
at that stretch of the chain, the refusal path narrowed to
`max(floor, width / 2)`, and the floor was 2000. So the same range was
asked for on every pass, refused on every pass, and the cursor sat at
block 4,408,287 — at two blocks a second, which is the re-scan of the
last 32 moving nowhere. The throughput work was right and beside the
point: no pass ever got past the fetch.

The floor (`INDEXER_BLOCK_RANGE`) is a preference for following head. A
refused width is a fact about the endpoint, and the window now narrows
past the floor on a refusal, to a hard minimum of 64 blocks — twice the
reorg depth, so a pass still advances — and never widens above what the
endpoints have shown they accept. The log line carries the endpoint's own
reason now rather than only the label, and a refused pass reports the
time the refused fetch took. There is a test that a cap below the floor
still lets a sync finish.

### The feather under a URL per token

The reconciliation above made the explorer's icon win for the stocks —
and every stock came back wearing the feather, SPCX included. What had
looked like a SpaceX icon in Robinhood's style was Robinhood's mark; and
the explorer serves it under a **different URL for every token**, so the
generic check, which compared URLs, saw nothing shared.

The bytes are what is compared now. `imageDigest` hashes the picture a
URL serves; the start-up audit that already fetches every recorded logo
keeps the hashes; `forgetSharedLogos` groups tokens by hash, forgets any
picture three or more wear, and remembers the hash as generic; and the
explorer source digests a candidate icon and refuses one whose bytes are
on that list. With that in place the reconciliation lands where it was
meant to: a stock the explorer has a real picture for wears it, AMD and
TSLA fall to their ticker icons, and SPCX to this site's own SpaceX mark.

GUH remains a monogram: no source answers for it. The Pons source is
asked from this deploy on; failing that, the token's address and an
image URL in `config/tokens.json` is the one honest way to give it one.


### Several windows a pass

With the floor fixed the box moved, and the first log said how fast:
`window 250`, five to nine seconds a pass, 27–45 blocks a second. Of a
seven-second pass the fetch was under two; the rest was the anchor query,
the aggregate rebuild, the cursor write — cost that does not scale with
the window at all. A 250-block window paid the whole of it for 250 blocks.

So a pass fetches **several windows at once** now (`INDEXER_CONCURRENCY`,
default 6): contiguous windows of the current width, one `eth_getLogs`
each, sent together, and the fixed cost paid once for all of them. The
log line says so — `window 1,500 = 6×250` — and blocks per second is the
figure to read. The windows are settled independently: the ones that
arrived ahead of the first refusal are ingested and the cursor moves to
the end of them, so a refused burst costs the refused windows and not
the pass. A later window that also arrived is fetched again next pass
rather than ingested out of order; the cursor is one number and it never
skips.

A refusal now says which of two things it is. A 429 or a timeout with
several windows in flight is the burst being too much: the concurrency
halves and the window stays, because narrowing the window for a rate
limit is learning the wrong lesson and keeping it. A rate limit with one
window in flight changes nothing, and the main loop waits a beat before
asking again. Anything else — "more than N results", "range too large" —
is the width, and narrows it as before. The busy threshold that halves a
dense window is judged per window, since the endpoint's cap is on one
request rather than on the pass.

And the ceiling is no longer only ever lowered. The 250 the box sat at
was learned in a dense stretch of the chain — "more than N results" — and
is far too low for the empty stretch after it, and a ceiling that can
only come down would have held the sync at 250 blocks a window for the
remaining fifty-eight million. After forty clean passes the poller asks
for more: first the concurrency back toward its configured value, then
the window's ceiling toward `INDEXER_MAX_BLOCK_RANGE`, only while the
window is pinned at it. A probe that is accepted is followed by another
next pass, so climbing back is a run of doublings rather than one every
forty passes; a probe that is refused costs one pass in forty and resets
the count. The tests cover both directions, and the §9 comparison is run
again in its hardest form yet: six windows a pass against one, with a
rate limit partway that truncates a pass to the windows that arrived,
byte for byte.

Two smaller things from the same log. The anchor line was printed every
pass, because the note it was compared against carries the anchor pool's
swap count, which changes every pass while syncing; it is compared on the
address now. And the v3 backfill — a newly discovered pool's own logs
from its creation block — was time the pass line did not account for; it
is a stage of its own in the line when it happened.

### The deploy that could not fetch

The deploy after the change above stopped on its first line: `error:
insufficient permission for adding an object to repository database
.git/objects`, then `fatal: unpack-objects failed`, and the box stayed on
the previous commit while the operator read a log that looked like
nothing had changed. The cause is §18's own instruction: the first deploy
of a new branch is a manual `git checkout`, and it was run as root, so the
object directories git wrote are root's — and every later fetch runs as
the app user, which cannot write into them.

`deploy.sh` now repairs ownership before it fetches: anything under the
tree not owned by the app user is chowned, and the count is printed with
the likely reason. Only what is wrong, not the whole tree, because
`node_modules` is large and chowning a tree that is already right is a
slow no-op. `doctor.sh` names the same fault ahead of its own fetch, which
had been swallowing it. The repair only helps once the new script is on
disk, so this one time the operator runs the chown by hand first — the
same shape as the wrong-branch deploy in §18, and the same lesson: a fix
in `deploy.sh` reaches the box one deploy after the fault.

### Depth, and a market cap from the chain

ALFA looked at a row reading `FDV $302.8K · depth $95.0K` and asked what
depth meant against so small an FDV, and for a market cap.

**Depth is the pool, FDV is the token.** Depth is the pool's liquidity
valued in dollars, both sides — what a swap trades against and what a
stake is a share of. FDV is the token's whole supply at its price. They
are independent, and for a launchpad token a depth that is a third of the
FDV is ordinary: a large part of the supply sits in the pool that
launched it. A depth of `—` is unknown depth (§14): the pool's own events
do not reconcile to a positive reserve, which on a young chain usually
means a hook doing its own accounting — and `LAUNCHPAD_HOOKS` (§14) is
still the missing input that would let the indexer say so.

**Market cap.** §15 recorded why the figure was FDV: a contract reports
its total supply and nothing about who holds it. That was too
conservative. A contract also answers `balanceOf`, and three holders are
tokens that cannot circulate by construction: the zero address, the
`dEaD` address, and the token contract itself. Total supply less those
is a circulating figure from on-chain reads alone, which §4 allows. It
is read in the same multicall as the supply (`tokens.non_circulating`,
one migration), and `pool_state.circ_mc_usd` is that figure at the
traded side's price beside the FDV. The row reads `MC` and shows `FDV`
next to it only when the two differ by more than a percent, because for
a token with nothing burned they are one number; a token whose holdings
have not been read yet shows the FDV alone, labelled; ether stays
`native asset`. The tooltip says what circulating means here and what it
cannot know: vesting and treasury holdings are indistinguishable on
chain, so the figure can overstate, never understate.

The supply refresh changed shape to make the backlog short. It reads
fifty tokens a pass through Multicall3 rather than five one call at a
time, every fifth pass while backfilling, ordered so that tokens with a
supply and no holdings read come first and the largest pools' tokens
among them — the board gains its market caps within minutes of the
deploy, the rest of the table over the following hour.

Smaller, from the same screenshot: a 24h change that rounds to `0.0%`
was drawn as `▼ −0.0%` in red — a negative sign on a number that is not
negative, and red means one thing here (§5). It is `0.0%` in the neutral
colour now.

Still ALFA's: the default ranking. The row that prompted the question
was third by volume with fees of $54, under a row with sixteen times the
fees; §1 says fee yield is the headline and volume is trivially washed.
`By fees · 24h` as the default facet is one line, offered and not
changed.

### "Liquidity", by ALFA's word, and the refresh in the board's order

ALFA looked at the first board with market caps on it and asked two
things: for the rows still reading `FDV` to read `MC`, and whether depth
meant liquidity — and if so, to call it that.

**Liquidity.** Yes: the figure is the pool's liquidity in dollars, both
sides. §13 kept "depth" as the domain term when the brand moved; the
owner has now chosen the plainer word for the page, so every user-facing
line says *liquidity* — the row, the drawer, the router's copy and
projection, the two mastheads. Identifiers are unchanged (`tvlUsd`,
`*DepthUsd`, `reorgDepth`, `design/depth.html`), and so are the banners
under `brand/social/`, which are rendered images and carry the old word
until they are rendered again.

**The rows that still read FDV** were the tokens whose non-circulating
holdings had not been read yet — the migration's backlog, drained fifty
tokens a refresh. VIRTUAL had flipped and world had not, and the reason
was the order: the backlog was worked largest-FDV-first, which on a
launchpad chain is dust with absurd supplies (§19 found the same for
logos). The refresh now takes the board's own order — the pools' 24h
volume, the same ranking `logoCandidates()` uses — so the listed rows
are the first fifty read, and the label flips on the board within a
refresh of the deploy. The `FDV` state remains for a token whose
holdings are genuinely unread, because labelling the whole supply as
market cap is the overstatement §15 refused; it is now a state that
lasts a minute rather than an hour.

### Ranked by market cap, by the owner's call

ALFA's words: *kita harus ambil dari MC paling gede biar project gede* —
the board should lead with the largest projects. So the default facet is
**By market cap**; volume and fee yield stay as the second and third.
This sets aside §1's "every ranking defaults to fee yield" and §19's
open question on the volume default, and it is the owner's decision to
set aside.

The key is the market cap, or the fully diluted figure while a token's
holdings are still unread, which is the same magnitude and the row says
which. A token with neither — ether above all, whose market cap is not a
figure this site can derive (§18) — follows the ranked rows, deepest
first. So the ETH market sits after the ranked tokens under this facet,
which is honest and will look odd; the ETH filter and the volume facet
both put it back in front.

A market-cap ranking has a failure mode the volume ranking did not: a
market cap is circulating supply times a price, and a price from a pool
with a few dollars in it supports nothing. On a launchpad chain such a
token can carry a supply that makes its "market cap" the largest on the
board. So there is a **liquidity floor** on the listing now
(`LISTING_MIN_LIQUIDITY_USD`, default $10,000, `set-env.sh` to tune)
beside the FDV bar — applied only to a *known* liquidity, so a pool
whose depth the indexer cannot reconstruct (§14) is still listed with
its dash, and the ether/USDG market is exempt as before. Like the FDV
bar, **this is ALFA's number**: $10K is a first guess at "a real pool",
not a measurement, and the first board under this ranking is what says
whether it is high enough.

Asked in the same message: what *fees · 24h* is. It is the swap fees
traders paid in that pool over the last 24 hours of chain time — the
pool's volume times its fee tier — and it is the pool's income, which
the LPs own. That is why §1 makes it the headline: volume is what
traders did, fees are what LPs earned.

### The first board by market cap: trillions, $0, and no liquidity

The failure mode the previous section named arrived on the first board:
catAI at `FDV $2,481.99B`, GLTCHT at `$1,759.51B`, sato at `$360.81M` —
each with `vol · 24h $0`, `fees · 24h $0`, `liquidity —`, and no logo.
The liquidity floor did not catch them because their liquidity was
*unknown* rather than small, and unknown was exempt so that GUH and Index
(hooked pools with real trading) stayed listed. The exemption was too
wide: a pool with unknown liquidity, a supply, and no trade at all is a
dead pool, and on a launchpad chain a dead pool with an absurd supply is
the largest "market cap" on the board.

Unknown liquidity is now forgiven only for a pool that has traded in the
yield window (seven days of chain time). A dead pool with unknown
liquidity is unlisted whatever its supply; GUH and Index, which trade,
stay. The test builds exactly that board — a token with a trillion
supply, a pool the indexer cannot reconstruct, no fee hours — asserts it
is unlisted, adds one trade, and asserts it appears with its liquidity
still honestly unknown.

Two questions asked in the same message, answered on the board rather
than in this file: `vol · 24h` is the dollar value of the swaps traded in
that pool over the last 24 hours of chain time, and `$0` means nobody
traded there — which is why such a row has no fees and no logo either:
no source lists a token nobody trades, and the logo process asks about
the board's rows by volume, so a $0 row is asked about last.

### The empties, and the sign Uniswap v4 puts on a swap

ALFA looked at the board ranked by market cap — USDe first with
`liquidity —`, WIF and BRODIE the same, the drawer reading `Pool
liquidity $0` and `Your share of pool 100.00%` — and asked for the empty
data to be filled in. Most of it had one cause, and it was mine.

**Uniswap v4's Swap event carries the trader's deltas, not the pool's.**
v4-core `Pool.sol` builds the emitted `swapDelta` from
`amountSpecified - amountSpecifiedRemaining`, which for an exact input is
negative, and `amountCalculated`, the positive output. v3's Swap is the
other way round: the pool's deltas, input positive. The decoder stored v4
rows as emitted, and everything downstream reads the pool's signs: the
reserves are the sum of the rows, the fee side is the positive one, the
volume is the positive one. So for every v4 pool the swaps were summed
backwards — each trade *removed* its input from the reserves and *added*
its output — and reserves fell with volume until they went negative,
which is unknown depth (§14), which is `liquidity —` on exactly the pools
that trade. The fee was attributed to the token the trader received. The
pools with a known liquidity were the v3 pools and the v4 pools that had
barely traded.

The fixture had been encoding v4 swaps with the pool's signs, so the
suites — §9's replay proof included — proved the indexer against a
convention the chain does not use. `swapLog` now takes the pool's signs
and encodes the trader's, as the PoolManager does; the decoder negates
v4 on the way in, so there is one convention in the tables and nothing
below the decoder changed. `server/indexer/v4-sign.test.ts` decodes a
log built the chain's way and asserts the pool's signs come out.

**The rows already on the box** were written wrong and are repaired by
a migration rather than a re-sync, which would have cost the days the
first sync took. It flips the v4 rows, re-derives the fee side, and
recomputes the fee from the true input: exactly for a static-fee pool,
whose swap fee is the pool's; by proportion for a dynamic-fee pool
(flag `0x800000`), whose per-swap fee the row does not keep — within a
wei of a fresh sync, and said so here rather than left to be discovered
by §9's comparison. v3 rows are untouched. The migration then forgets
the rebuilt-anchor marker, so the indexer's first pass after the deploy
rebuilds every priced table from the corrected rows — a full rebuild,
during which no pass completes (§19); the site shows the last snapshot
until it does. The test runs the migration's own statements against
rows stored the old way and asserts all three cases.

**The drawer** said `$0` for an unknown liquidity and `100.00%` for a
share of it — dividing by zero and calling the result a fact (§7). Both
are dashes now, the weekly estimate with them, and the `Max 4.18` beside
the amount, a prototype figure nothing on the live site backs, is gone.

What stays empty after this, honestly: fee yield until a pool has seven
days of fees in the window; the market cap for the tokens whose holdings
have not been read yet, which the refresh reaches in the board's order;
and the Stakes, Positions and Portfolio pages, which are the §20
decisions and not the indexer's.

### A dollar is not a project

ALFA asked why USDe and syrupUSDG were on the board at all. Ranked by
market cap they led it: a stablecoin's market cap is how much of it was
minted or bridged, which says nothing about a project, and on this
ranking it sits above every project there is.

Stablecoins get no row of their own now. The rule is the symbol —
`isStablecoinSymbol` in `lib/chain.ts`: `USD` anywhere in it, which
catches USDC, USDT, USDe and syrupUSDG, plus the few dollars that do not
carry the letters (DAI, FRAX, GHO, LUSD, MIM, TUSD, PYUSD) and the euro
pair — applied in the listing CTE on the traded side, with the same rule
as SQL kept beside it. USDG remains the quote that prices the whole
site; its pools stay indexed; the ether market is untouched.
`LISTING_STABLECOINS=true` lists them again. The test builds a
USDe/WETH pool with a $327M figure and asserts it is unlisted by
default, listed on request, and that the ether market stays either way.

### The stake that did nothing, a fee that did not exist, and the address

ALFA's message had four parts: SPCX wearing the feather again, fees and
volume that looked too small to be real, no contract address anywhere,
and *make it mainnet*.

**SPCX.** The explorer answers the issuer's feather for a private company
in that company's colour, under bytes unique to the token, so the
shared-icon rule could not call it generic and the explorer's answer
stood for a third time. A mark curated in `OWN_STOCK_MARKS` exists
because no source has the real one, so it now outranks every source in
the reconciliation. Tested against an explorer that answers a unique
icon.

**Fees and volume.** Three things, one of them the section before this:
the figures are chain time, sixty-eight days ago, while the sync catches
up; the v4 sign fault shrank every v4 pool's volume to the trader's
output side, and the deploy carrying the fix had not run; and a row like
WIF, `$44` of volume against `$43` of fees, is a pool whose hook takes
about 98% of every trade as its "fee" — a launchpad curve, not a market
anyone should add liquidity to.

**Which is why hooked pools are not offered any more.** `isStakeable`
used to say a hook we did not recognise was stakeable, the safe
direction for a listing (§14) and the wrong one the moment staking is
real (§20). A pool with a hook is offered only when the hook is on
`STAKEABLE_HOOKS`, an allowlist someone has to fill after looking; the
drawer says so, and names the hook. `LAUNCHPAD_HOOKS` still names the
launchpad on the row.

**The drawer lied twice.** Its Stake button showed a toast — *Staked ·
fees start streaming next harvest* — and did nothing, which on mainnet
is a fabrication; and it disclosed a *10% of fees earned* that no
contract takes, because under §20 there is no vault. Now: **Stake full
range** hands the pool to the builder with `?pool=…&range=full`, where
the real flow mints one full-range position through PositionManager to
the wallet after the node has dry-run it; the disclosure §7 asks for is
made and is honest — *Balast fee: none, every fee is yours; custody:
your wallet, as an NFT; lockup: none*; and the amount field with its
prototype `Max 4.18` is gone, since the builder reads the wallet.
**Without a vault there is no protocol revenue**, which §20 recorded as
ALFA's decision to make and which *make it mainnet* makes: this is what
mainnet through Uniswap means, and the drawer now says it to the person
about to sign.

**Full range in the builder.** `planMint` takes `fullRange`: the lowest
to the highest usable tick for the pool's spacing, one position, the
shape and bin inputs ignored; the builder has the tick box, hides the
shape, range and bin fields under it, estimates at the pool's own yield
with no concentration, and reads `?pool=` and `?range=full` from the
URL inside a Suspense boundary. Tested: one position from −887,220 to
887,220 at spacing 60, both sides taken.

**The contract address** is in the drawer under the header, in full,
with Copy and an explorer link; ether says it has no contract. A site
that asks people to trust a token should show them which token.

### The NFT, and where the volume comes from

ALFA asked two things off the drawer and the board: what *your wallet, as
an NFT* means, and why NVDA's and WIF's volume is tiny against their
market caps when DexScreener shows something else — where does the
volume come from.

**The NFT.** Uniswap represents every liquidity position as an ERC-721
token minted by the PositionManager: the NFT *is* the position — its
range, its liquidity, the fees it has earned — and whoever holds it is
the only one who can withdraw. Staking here mints that NFT to the
person's wallet; Balast holds nothing. The drawer says so in those words
now, with a *Balast holds: nothing* line beside custody.

**The volume** is the sum of the swaps in that pool over the 24 hours of
chain time before the last block indexed, valued in dollars, from the
chain and nothing else (§4). Three reasons it disagreed with DexScreener:

- **Sixty-eight days.** The last block indexed was July's; DexScreener
  shows today. Until the sync reaches head, every figure on the board is
  a day in July, and the top bar says so.
- **The v4 sign fault** (above) shrank every v4 pool's volume to the
  trader's output side. Fixed, awaiting its deploy.
- **The wrong pool.** DexScreener's WIF is a Uniswap **v3** pool with
  $111K in it. Balast's WIF row was a hooked v4 pool with $44 of trades,
  because the v3 pool was not in the tables at all: the factory was
  configured with the cursor millions of blocks in (§20), and every
  `PoolCreated` before that block was never read, so every older v3 pool
  — the pools §4 said existed — was invisible. The token's row is its
  deepest pool, and the deepest pool was missing.

**The factory's history is read now.** On its first pass a poller with a
factory walks the factory's `PoolCreated` logs from the start block to
the block the factory has been followed from (`v3_history_block` in
`indexer_state`, advanced by every pass since), writes the pools it
names, then walks those pools' own logs from creation to the cursor, all
of them in one adaptive window at a time; progress is remembered so a
restart resumes; the cursor is touched between windows so liveness stays
honest; and the priced tables are rebuilt in full once it has read
anything. On the box this is one long first pass — the factory's four
and a half million blocks, then the pools' — and the log says where it
is every twenty windows. The test gives a poller the factory late,
after another has synced without it, and asserts the pool appears, its
swaps and state with it, nothing is read twice on the next start, and
the fee rows equal a poller's that followed the factory throughout.

### Buys and sells, from the chain; and what the NFT is not

ALFA asked for the volume to be DexScreener's buy and sell volume, asked
again what the fee is, and asked whether a person without an NFT can
stake at all.

**Buys and sells are on the drawer now, and they are the chain's.** A
swap that pays the quote (ether or USDG) and takes the token is a buy;
the reverse is a sell. The side the fee was taken in — the input side,
which the v4 sign fix made right — says which, so the split comes from
the same rows as the volume: buys plus sells is the volume, and the two
counts are the trade count, and there is a test that says so for every
pool. `pool_fee_hourly` carries `buys`, `sells`, `buy_volume_usd` and
`sell_volume_usd` (one migration, filled by the next full rebuild); the
snapshot sums them over the day; the drawer shows both figures, both
counts and a bar. The bar is accent and neutral, not green and red:
red means a negative number and a sell is not one (§5).

**Not DexScreener's figures.** §4 bars a third-party number from the
critical path, and the reason is the whole product: every figure on
this site can be checked against the chain, and a figure taken from an
aggregator cannot. The disagreement ALFA saw had three causes, none of
them the source: the sync is in July, the v4 signs were wrong, and the
pool it compared was one Balast had not indexed — all three above, all
three fixed or in hand. Once the sync reaches the same day, the split
here and the split there are the same swaps counted the same way.

**The fee, once more, on the page.** Under *Fees 24h* the drawer now
says the pool's own tier — *1% of every trade, paid to the pool* — so the
figure explains itself: every trade pays that fraction into the pool,
and the pool's liquidity providers own it. Under *Volume 24h* it says
the trade count.

**The NFT is not a ticket.** Nobody needs one to start: the stake
*creates* it. The transaction mints the position as an NFT into the
wallet, and the NFT is how the wallet owns the position from then on.
The drawer says so in that sentence.

### "Stalled" over an indexer that was busy

The deploy summary after the v4-sign repair read `indexer: STALLED —
nothing written for 16818s`, with every process online and zero restarts.
Health judges liveness by the cursor's write time (§18), which is right for
a pass — a pass ends by writing the cursor — and wrong for the two stages a
first pass can spend hours in without one: the full rebuild of every priced
table, which the repair migrations force by forgetting the anchor marker,
and the v3 factory's history walk, which touched the cursor only every
twenty windows. Both are expected work after exactly this deploy, and the
monitor would have paged through all of it — the failure §18 describes as
how a monitor gets muted.

A stage that writes no block is now recorded (`server/indexer/working.ts`,
one `indexer_state` row): its name, where it is — `fees`, or `block
1,200,000 of 4,470,000` — when it started, and a heartbeat every ten
seconds from a timer while it runs. A large SQL statement is I/O to Node,
so the timer fires while it executes. Health reads the record and answers
**`working`** while the heartbeat is fresh: 200, `ok: false`, the stage and
its duration in the message and under `working`. A process killed
mid-stage stops beating, and past the threshold both clocks are stale and
the verdict is `stalled` as before; the record is also cleared on every
start so a leftover is never read as current. The deploy summary, the
doctor, the monitor, the waiting page and `logos:status` all know the
state. `stalled` still means what it did — dead or stuck — and nothing
else.

What this does not explain is the 16,818s itself: the summary is printed
seconds after the restart, so that idle belongs to the *previous* process,
and nothing in the code it ran is a known stage of that length. The log is
the only evidence; `pm2 logs balast-indexer --lines 100` from before the
restart says whether it was refused by every endpoint on every pass (the
one case that neither writes nor touches the cursor and is not a stage),
mid-rebuild, or something new.

### Twelve thousand nine hundred addresses in every request

The first log with the heartbeat in it said where the time went. Phase
one of the factory's history found **12,893 v3 pools**; phase two, their
own logs from block 9,490 to the cursor, had reached block 23,489 after
ten minutes — fourteen blocks a second, ninety hours to the cursor — and
the last remembered pass before the deploy had taken seventeen seconds to
be refused for a thousand-block window. One cause: every `eth_getLogs`
listed every followed pool's address, twelve thousand nine hundred of
them, a request the size of a small file that the endpoints answered
slowly when they answered at all. And the list only grows; on a chain
where a launchpad creates a v3 pool per token it would have reached the
main loop next and stayed there.

**The fetch is by signature now.** The indexer decodes seven events —
v4 `Initialize`, `Swap`, `ModifyLiquidity`; v3 `Swap`, `Mint`, `Burn`;
the factory's `PoolCreated` — and `FOLLOWED_TOPICS` in `server/chain/abi.ts`
is their selectors, checked in a test against the canonical Uniswap values
so a typo in an ABI string cannot pass every fixture and decode nothing on
the real chain. A pass asks for those topics and no address, and keeps
the logs whose contract it follows: the PoolManager, the factory, and
the v3 pools it knows — including one the factory names in the same
batch, since the logs are in chain order and a pool is created before it
is used. Anything else of the same signature, another DEX's v3 pool say,
is counted as `foreign` on the pass line and dropped. The history walk's
second phase does the same with the pending pools' addresses.

Two consequences. The per-pass **backfill** of a newly discovered v3
pool's own logs (§15) is gone: it existed because the pool's address was
not in the filter when its range was fetched, and there is no address in
the filter now. `server/indexer/v3.test.ts` builds a chain with a foreign
v3 pool beside the followed one and asserts the followed pool is whole in
one pass, the foreign one leaves no row, and every request named no
contract. And a response can now carry logs the poller does not want; a
chain with a busy v3 fork on it would narrow the window through the same
result caps as before, which is the trade for a request that stays small.

**A refused single window narrows, whatever the endpoint called it.** The
previous rule kept the width on a lone 429 — the endpoint asking for a
moment — and the box showed the other reading: a thousand-block window
refused every second for hours, the cursor never moving. Some endpoints
answer 429 to a heavy query, and from one window there is no telling
which. So a single refused window halves the width to the minimum, and
the main loop waits longer each time a whole pass is refused — doubling
from the poll interval to a minute (`refusedInARow` on the pass) — rather
than asking again in the same breath. The burst rule is unchanged: a 429
with several windows in flight still halves the concurrency and keeps the
width. A test refuses every window over 500 blocks with a 429 and
asserts the sync finishes, three refusals in a row and then none.

### The row shows volume and its buys and sells; the fee figure leaves it

ALFA's words on the first board after the history walk: *fee hapus dan vol
itu hitung buy sale aja* — take the fee figure off the row, and show the
volume as what it is made of. So the row now carries `vol · 24h` and, in
the column the fee figure held, the day's buys and sells with a bar for the
buy share — the same swaps split by which side paid, so the two always sum
to the volume beside them (there is a test for that in the snapshot
suite). The row's sparkline draws volume too, from a second series in the
same fourteen buckets, so nothing on the row is a fee figure in disguise.
Below 640px the split drops and the total stays.

This sets aside §1's "fee yield is the headline" **for the row only**, and
it is the owner's decision to set aside. Fees remain where they are what
is being said: the masthead's headline sums the fees the listed pools paid
in 24 hours, the drawer's *Fees 24h* line names the tier they came from,
and the *By fee yield* facet still ranks on them. Removing those too is one
line each, offered and not changed.

**Why NVDA's liquidity read $25.5K**, asked in the same message. The
liquidity figure is the pool's own reserves valued in dollars, and the
board that prompted the question was built before two things landed: the
v4 sign repair (§20), under which every v4 pool's reserves had been summed
backwards, and the 12,893 v3 pools the factory's history added, whose
tables had not yet been rebuilt. The rebuild runs after the history walk;
until it completes, the liquidity on the board is the old arithmetic. If
the figure stays thin after it, that is the pool's depth on this chain — a
token's market cap is its supply at a price, and says nothing about how
much sits in the pool.

The first live board with the split on it read `$0 buy · $0 sell` beside
`$459.7K vol`: the four columns arrived by migration with a default of zero
and are filled by the next rebuild, which had not run — each restart since
went into the history walk first. A split of zero beside a volume that is
not is a split that has not been computed, and the row draws it as a dash
with an empty bar until it has; a day with no trades shows `$0` and an
empty bar, not a half-full one.

### Live volume from DexScreener: the owner's exception to §4

Asked what API the volume came from, told none, and told why the figures
were weeks old, ALFA decided: *iya tapi harusnya vol-nya realtime pakai API
DexScreener aja*. §4 bars a third-party number from the critical path and
that concern was raised twice; the owner reaffirmed, and this records the
decision and its limits.

**What comes from DexScreener** (`server/api/market.ts`): for every token
on the board, the day's volume, its buys and sells as trade counts, the
24h price change, and the pair it came from — one request per thirty
tokens against `/latest/dex/tokens/{addresses}`, on a cadence
(`DEXSCREENER_REFRESH_MS`, 30s), held in the API's memory. The pair chosen
for a token is the pool on the row when DexScreener lists it — v3's pool
address, v4's pool id — else the deepest. A quote older than fifteen
minutes is dropped rather than shown as live; a 429 or a failure keeps
the last quotes and backs off, doubling to ten minutes. A refresh that
changed a quote rebuilds the snapshot and wakes every socket, so the row
moves on the aggregator's cadence even while the indexer is in a long
stage and publishes no tick.

**What stays the chain's**: everything that prices the site. The anchor,
the reserves and liquidity, the fees, the yield, the market cap, the
sparkline's history. `Pool.market` sits beside the chain's fields, never
in place of them, so the snapshot still carries the figure that can be
checked against the chain and a test asserts both are present.

**How the page says which is which**: the row's cap reads `vol · 24h ·
live` over a DexScreener figure and `vol · 24h · chain` when DexScreener
has no fresh quote for the token, with the source and the quote's age in
the tooltip; the split column shows trades by side (DexScreener's feed
does not split the dollars) under `buys` and `sells`, or the chain's
dollar split as before; the 24h pill follows the same source as the
volume beside it; the drawer's caption says *via DexScreener*, and a line
under its split says what is live and what is the chain's. Simulated data
has no feed and looks as it did.

**Unverified from here**: the sandbox cannot reach DexScreener. The parser
follows the documented response shape and reads anything else as no quote.
Two things say what is true on the box: `/api/health` carries `market` —
how many of the board's tokens are quoted, the last refresh, the last
error, and the chain ids seen — and `npm run market:probe -- 0xTOKEN`
prints the raw answer for a token. DexScreener's id for this chain is not
known; unset, every chain's pairs are accepted and the ids seen are
listed, and `DEXSCREENER_CHAIN` should then be set to the right one.
`DEXSCREENER_MARKET=false` turns the feed off and the board back to the
chain's figures alone.

The first probe on the box answered: DexScreener's id for this chain is
**`robinhood`**, now the default; the feed quoted 32 of the board's 76
tokens on its first refresh with no error; and the answer listed pairs on
`ramses` beside `uniswap` — a v3 fork trading here, whose pools emit the
same `Swap` signature and are what the poller now counts as `foreign`.
Whether Balast should index them is a product question, not a defect;
§4 names Uniswap and the launchpads.

**32 of 76, and NVDA among the unquoted.** The first board with the feed
on it showed NVDA at `vol · 24h · chain` while DexScreener's own page for
it read $21M on a v3 NVDA/USDG pair. Two things, one of them mine. The
feed had asked thirty tokens to a request and no error came back, which
is the shape of an answer capped in pairs: the tokens at the back of a
long batch get nothing and look unknown. Batches are ten now, a token
that came back without a pair is asked for alone before it counts as
unknown, and one DexScreener still answers nothing for is not asked again
for ten minutes; `/api/health` reports `unknown` beside `quoted`. Tested
against a fake that answers only the first three tokens of any
multi-token request. The other thing is the chain side: the row's pool
was NVDA/WETH at $25K because the v3 NVDA/USDG pool the history walk
found — the one DexScreener shows, with $7.1M in it — had not been
rebuilt into `pool_state` yet; the deepest-pool rule moves the row there
once it has.

---

## 21. Where the volume and the market cap come from

ALFA looked at the first board with the live feed on it — NVDA at `$17.9K`
of volume beside a DexScreener tab reading millions, WIF, BRODIE and
COOKWARE at `liquidity —`, half the rows labelled `FDV` — and asked the
right question: *vol sama market cap ini ambil dari sumber mana masih
banyak yg tidak valid perbaiki cari data api yang valid*. Which source are
these from, and find a valid one.

The answer is in three parts, and two of the three were my own defects
rather than a bad source.

### A row is a token; the quote was a pool's

§19 made the board a token listing — one row per token, its deepest pool —
and §20's feed then read the day off **one** pair: the row's pool when
DexScreener listed it, else the deepest. A token on this chain routinely has
several pools (fee tiers, hooked variants, a v3 pool beside a v4 one), so
NVDA's row showed the day of a shallow v4 pair while the token's own page
summed several. The figure was not wrong about that pair; it was answering a
question nobody had asked.

`aggregate` in `server/api/market-sources.ts` sums the token's pairs now, and
what it sums is exactly what a quantity is:

- **Summed** — the day's volume, its buys and sells, liquidity. A token's day
  is all of its pairs' days.
- **Read off the deepest pair** — price, 24h change, market cap, FDV. None of
  those is a quantity to add up; a market cap summed over three pools is three
  times the token's.
- **Never across chains.** A token address exists elsewhere too, and a sum
  over two chains belongs to no market. With no chain configured the deepest
  pair's chain decides and the rest are dropped; `/api/health` lists every id
  seen so the right one can be pinned.

### The market cap was a live supply at a two-month-old price

§15 derives the market cap on chain — circulating supply × price — and that
price is `pool_state`'s, which is the price **at the last indexed block**.
With the sync sixty-eight days behind, a correct supply was being multiplied
by July's price on every row. Nothing about it looked stale.

So the live figure is preferred when there is one, and the chain's is the
fallback, and both are labelled. Liquidity goes the other way round on
purpose: the chain's figure is the pool's own reserves, it is the pool the
Stake button opens and the one the yield is computed against, so a live
figure never displaces it. It fills the **dash** instead — unknown depth
(§14), which is what half that board was — from the aggregator's figure for
that same pair, or failing that the token's across its pools, which is a
different question and says so.

`lib/market-figures.ts` makes each of these choices **once**. The row, the
drawer and the ranking all read it, because the previous arrangement had the
ranking sorting on the chain's market cap while the row displayed the live
one: a board ordered by a number nobody could see. §12's rule that the header
cannot disagree with the table is the same rule one level down.

### A second source, because the first knew 32 of 76

DexScreener quoted 32 of the board's 76 tokens on the box. The other 44 rows
fell back to chain figures two months old — correct, labelled, and not what
anybody wanted to read. **GeckoTerminal** is asked for what DexScreener does
not answer: keyless, CoinGecko's DEX side, and the aggregator that reads what
launchpads publish, which is most of this chain. Its id for this chain is
discovered from its own network list by name (`GECKOTERMINAL_NETWORK` pins
it), exactly as the logo source already did.

It answers token-level totals directly — volume, reserve, FDV, market cap —
and the deepest of its included top pools gives the 24h change. It does not
split a day into buys and sells, and a partial count summed over its top
pools beside a whole-token volume would be a figure that does not add up, so
those rows show the **chain's** dollar split instead. The unit travels with
the figure rather than being assumed: one source splits trades, the other
dollars, and the row says which.

A refusal now backs off **the source that refused**, not the feed. One 429
used to freeze every row on the board.

### Two bugs found while writing the tests

- **The second source went unasked for fifteen minutes at a time.** After
  each source the feed dropped tokens that "have a quote" — and a token last
  answered by GeckoTerminal still held a fresh one when DexScreener's turn
  came round again, so GeckoTerminal was skipped until that quote went stale.
  A row updating every fifteen minutes on a feed that refreshes every thirty
  seconds. It is per-refresh now, and there is a test that fails against the
  old line.
- **A missing `txns` block read as zero trades.** DexScreener omitting the
  split is "this source did not say", not "nobody traded". It is null, and
  the row falls through to the chain's.

### What is still the chain's, and why that matters

Everything that prices the site: the anchor, the reserves, the fees, the
yield, the sparkline, and the listing bar's own thresholds. §4 bars a
third-party number from the critical path and this does not change that —
the exception is the owner's and it is bounded to the figures a person
compares against an aggregator. Every figure Balast makes a claim on is
still derived from logs and still checkable against the chain.

The deeper cause of the disagreement ALFA saw is unchanged and not a source
problem: **the sync is sixty-eight days behind**, and until it reaches head
every chain figure on the board is a day in July. The live feed is a patch
over that window, not a replacement for it.

### Unverified from here

The sandbox that wrote this reaches neither DexScreener nor GeckoTerminal —
the egress policy refuses both, as it refused every aggregator in §19. Both
parsers follow the documented response shapes and read anything else as "no
quote", which is the same discipline the logo sources were written under and
the same one that made them work on the first real run.

Two things say what is true on the box:

- `npm run market:probe -- 0xTOKEN …` asks **both** sources, prints every
  request and status, every pair behind the sum, and the quote each would
  build — so a figure on a row can be traced to the pairs it came from.
- `/api/health` carries `market.sources`: per source, how many of the
  board's tokens it quotes, its last error and its backoff.

If GeckoTerminal does not list this chain it disables itself, once and
audibly, and the board is exactly as it was.

### Still open

Unchanged: the §12 questions (the simulator's six-hours-per-tick clock,
`/positions`'s forward-looking *Est. fee yield*), `LAUNCHPAD_HOOKS` and
`STAKEABLE_HOOKS` (§14, §20), the listing bar's two numbers
(`LISTING_MIN_FDV_USD`, `LISTING_MIN_LIQUIDITY_USD` — still ALFA's guesses,
not measurements), and the protocol fee's immutable cap before P2 deploys.

### The first board after that deploy: every row read `chain`

Three faults, all mine, all visible in one screenshot.

**A miss was keyed by the token, not by the source that missed.** The singles
pass exists because a long DexScreener batch comes back capped in pairs, so a
token it does list can get nothing (§20); a token still unanswered when asked
alone is remembered and not asked alone again for ten minutes. With a second
source that remembering broke: `take()` cleared the mark whenever **any**
source answered, so a token GeckoTerminal knows and DexScreener does not had
its mark wiped on every refresh and was asked alone again on the next one, for
ever. On that board it was forty-odd extra single requests every thirty
seconds — which earns a 429, which backs DexScreener off for ten minutes,
which is a board with no live figure anywhere on it. The key is
`source|address` now. The test runs six refreshes over two tokens and asserts
two single requests; against the previous commit it makes twelve.

`/api/health`'s `unknown` changed with it: it was "missed recently", which
after the fix would have counted a token one source missed and the other
quoted. It is the set of tokens the last completed refresh could not place at
all.

**A restart left the board on `chain` for a minute.** Quotes were held until
the whole cycle ended, and a cycle is dozens of sequential requests across two
sources. `take()` publishes as each batch lands. The API coalesces those onto
the rebuild floor (`SNAPSHOT_MIN_REBUILD_MS`) — `rebuild()` only de-duplicates
calls that overlap, so a dozen batches would otherwise have run the expensive
query a dozen times back to back. The old trailing publish went with it: it
woke every socket a second time for a snapshot already sent.

**The waiting panel asserted "no indexed blocks yet" on every refresh.** Every
page load starts with no snapshot — the live provider is a fetch and a socket
— so the panel renders for a moment on a perfectly healthy site, and it spent
that moment making a claim about the chain before `/api/health` had been
asked, over a board that had been showing eighty markets a second earlier.
It draws nothing for the first 900ms now, and when it speaks with no answer
yet it says it is asking. An unanswered question is not evidence of an empty
chain, and §7 is exactly as much about the empty states as about the figures.

One thing this does not change: the buy/sell columns read `— BUY / — SELL`
because `pool_fee_hourly`'s four split columns arrived by migration and are
filled by the next full rebuild, which has not run — every restart since has
gone into the v3 factory's history walk first (§20). That is the dash working
as designed, not a fault.

### `followed: 0`: the feed was never told what to quote

`/api/health` on the box, with no error anywhere:

```
"enabled": true, "followed": 0, "quoted": 0,
"lastRefreshAt": null, "lastError": null, "chains": []
```

Not a refusal, not a parse — the feed had never run. `follow()`, the only way
it learns which tokens the board shows, runs inside a **successful**
`buildSnapshot`, and a snapshot was built only when a page asked for one or
the indexer published a tick. The indexer was 26 minutes into the v3 factory's
history walk, which writes no block and so publishes no tick; nobody had
loaded the page since the restart. So nothing ever called `follow()`, the feed
had nothing to do, and it did it perfectly.

The whole board was demand-started, and that is the wrong shape for a process
that is supposed to be quoting a market. `buildServer` now builds one snapshot
on start and retries every fifteen seconds until one succeeds — then stops,
because one success bootstraps the rest: the feed has its list and its own
timer, and its updates keep the snapshot rebuilding. An idle box is not polled
for ever (§19).

`server/api/self-start.test.ts` syncs a chain, starts a server, and never
requests `/api/snapshot`. Without the warm-up it fails with the box's own
symptom, `expected 0 to be greater than 0`.

**And the warm-up exposed a real fault in the cache.** `snapshot()` served
whatever was cached if it was younger than the rebuild floor — including a
cached *nothing*. The warm-up caches a null the instant the process starts, so
every request for the next five seconds answered 503 over a database that by
then had data. A suite caught it, which is the only reason it is not on the
box: `rate limiting > counts each client separately` began expecting 200 and
getting 503. Stale-while-revalidate trades freshness for latency and there is
no freshness to trade when the last build was empty, so a cached null now
rebuilds — cheaply, since `buildSnapshot` returns null at the cursor and
anchor checks, before any expensive query.

**A status of zeroes now says why.** `market.note` names the case: the feed is
disabled, or it has not been given the board, or it has the board and has not
refreshed yet, or every source answered and placed nothing (with the probe
command to run). Three zeroes and a null error sent me looking at DexScreener,
which was not involved.
