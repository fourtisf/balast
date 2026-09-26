# X Article: Introducing LockFi

Cover image: `x-article-cover.png` (1500 × 600, the 5:2 ratio X asks for).
Inline images are the six post banners; each is named where it goes.

Written inside the site's rules (CLAUDE.md §7): no yield figure, never
"APY", no promise of returns, and no contract address until it is announced.

---

**Title**

Introducing LockFi: Earn Real Swap Fees on Robinhood Chain, Without Giving Up Custody

**Other titles, if a shorter one is wanted**

- LockFi: The Liquidity Layer for Robinhood Chain
- Real Fees, Your Wallet: Why We Built LockFi

---

Robinhood Chain moves fast. New tokens launch every day, tokenised stocks trade around the clock, and every single one of those trades pays a fee. That fee does not disappear. It goes to the people who provide the liquidity the trade ran against.

Most people never collect it.

Providing liquidity on a young chain usually means reading raw contract interfaces, holding both sides of a pair before you can start, trusting a vault you have never heard of, and staring at yield figures nobody can explain. So the fees go to the few who can navigate all that, and everyone else watches.

LockFi exists to change that.

## What LockFi is

LockFi is the liquidity layer for Robinhood Chain. You pick a market, deposit, and earn a share of every swap that trades through it.

Three things make it different from what you have seen before:

- **Every position goes through Uniswap.** LockFi deploys no contract of its own. Your deposit goes into Uniswap v3 and v4 pools, through Uniswap's own audited contracts on Robinhood Chain.
- **Your position is yours.** It is minted as an NFT straight to your wallet. LockFi never holds your funds, not even for a single block.
- **The rewards are real.** Every fee your position earns was paid by a trader. No emissions, no points, no token printed to make the numbers look bigger.

That is the whole product in three lines. The rest of this article explains how each one works, and what it means for you.

[Image: 01-introduction.png]

## Why liquidity is worth providing

Every pool on Uniswap charges a fee on every trade: 0.3%, 1%, sometimes more. That fee is paid into the pool and belongs to the liquidity providers, in proportion to how much of the pool's liquidity they supply at the price the trade happens.

This is the simplest business model in DeFi, and the most honest one. When people trade, liquidity providers earn. When trading slows down, earnings slow down with it. There is nothing propping the number up, and nothing that can be switched off by a team deciding to stop paying incentives.

The hard part has never been the model. It has been the tooling. LockFi is that tooling, built specifically for Robinhood Chain.

## How it works, in five steps

**1. Find a market.** The Pools board lists every market on Robinhood Chain worth looking at: price, age, buys and sells, volume, 24h change, liquidity and market cap. It updates live, rows reorder as the market moves, and you can rank by market cap, volume or fee yield.

**2. Choose the pool.** Most tokens trade in more than one pool. LockFi separates the two questions that matter: which currency you pay with (ETH or USDG), and which fee tier. Each tier shows its own liquidity and the fees it actually paid its providers in the last 24 hours, and the most active one is marked.

**3. Deposit what you already hold.** A position needs both tokens of the pair, but you do not. If you only hold ETH, LockFi swaps the right amount through Uniswap and then mints your position. That is two transactions, and both are simulated against the chain before your wallet ever asks you to sign. If something would fail, you find out first.

**4. Shape your liquidity.** Go full range for the simplest position, or place your liquidity exactly where you want it with one of three shapes. More on that below.

**5. Collect, rebalance or withdraw, whenever you like.** Your positions live in your Portfolio with their status, value and fees. There is no lockup and no waiting period.

[Image: 04-one-token.png]

## The Pools board: every number says where it came from

Most dashboards show you numbers. LockFi shows you numbers and tells you where each one came from.

Pool data is read from the chain itself: the swap and liquidity events Uniswap emits on Robinhood Chain. Where a figure comes from an outside market feed, it is labelled as such. If our indexer is behind the chain, the top bar says so and says by how much, so you never mistake an old number for a live one.

The board also filters out noise. Stablecoins are not listed as projects, because a stablecoin's market cap says nothing about a project. And a pool with no real money behind it does not get a row, however large its "market cap" looks on paper. On a launchpad chain that single rule removes most of the fake-looking tokens you would otherwise have to scroll past.

[Image: 02-pools.png]

## Shapes: where your liquidity sits matters

Here is the one idea that makes concentrated liquidity make sense: **only the liquidity sitting at the current price earns fees.** Liquidity far away from the price just waits.

So LockFi lets you decide where yours sits:

- **Full range** covers every possible price. It is always in range and always earning something, and it is the simplest place to start.
- **Spot** spreads your liquidity evenly across the range you choose.
- **Curve** stacks most of it right at the current price, where fees are paid. More of the fees while the price stays close; less if it wanders.
- **Bid-ask** puts most of it at the edges of your range, like a ladder of orders waiting for the price to come to it.

The builder draws your position live as a bin chart, with the current price marked, so you can see exactly what you are about to mint before you mint it. It also shows an estimate of what the position would earn, worked out from the pool's actual fees today and how much of the liquidity at the price would be yours, with every assumption written out underneath. It is an estimate, and it says so.

[Image: 03-shapes.png]

## Fee tiers, explained properly

A fee tier looks like a simple percentage, and that is exactly why it confuses people.

Each tier is a **separate pool**, with its own traders and its own liquidity. You earn only from the pool you choose. A 3% pool sounds better than a 0.3% pool, but if nobody trades in the 3% pool, 3% of nothing is nothing.

That is why LockFi shows, for every tier, how much liquidity it holds and how much it actually paid its providers over the last 24 hours, and marks the busiest one. The right tier is almost always the one where the trading is.

## Your wallet, your position

When you mint a position through LockFi, Uniswap creates an NFT and sends it directly to your wallet. That NFT **is** the position: its range, its liquidity and the fees it has earned. Whoever holds it is the only one who can withdraw.

That has real consequences:

- There is **no vault**. Nothing you deposit ever sits in a contract LockFi controls.
- There is **no lockup**. Withdraw the moment you want to.
- There is **no admin key** over your funds. There is nothing for anyone to pause or drain.
- You are **never dependent on LockFi**. Your position is a standard Uniswap position. If LockFi went offline tomorrow, you could manage it on Uniswap's own interface.

Your Portfolio shows every position you hold: whether it is in range, what it is worth today, the fees waiting to be collected, the fees it has earned in total, and how its value compares with simply holding the tokens. From there you can collect fees and keep the position open, withdraw it completely, or rebalance a position that has drifted out of range.

[Image: 05-custody.png]

## Honest numbers, by design

DeFi has a credibility problem, and most of it comes from numbers. Four-digit APYs computed from one lucky hour. Yields paid in a token that is being printed. Losses hidden three menus deep.

LockFi follows a strict set of rules instead:

- **We never write "APY".** Every fee yield carries its basis next to it, so you know exactly what it was measured over.
- **No yield from too little data.** If a pool has less than 24 hours of history, you see a dash, not a flattering number.
- **Young pools are marked.** A figure from a pool less than a week old is labelled as an estimate, with the pool's age beside it.
- **Losses sit next to gains.** Impermanent loss is shown under its honest name, *price impact on holdings*, right next to fees earned, not buried.
- **Out of range means earning nothing, and we say so.** In the row, in red.
- **Stale data is labelled stale.** If the data behind the screen is behind the chain, the screen tells you.

[Image: 06-honest.png]

## The risks, in plain words

Providing liquidity is not free money, and anyone telling you otherwise is selling something. Here is what can go wrong:

- **Price impact on holdings.** When the price moves, your position rebalances between the two tokens. Compared with just holding them, you can end up with less. Fees can make up for it, or they may not.
- **Out of range.** A concentrated position whose range the price has left earns nothing until the price returns or you rebalance.
- **Token risk.** Many tokens on a young chain are new and volatile, and some will go to zero. A token appearing on the board is a listing, not an endorsement.
- **Pools with hooks.** Uniswap v4 pools can carry custom code called hooks. LockFi only offers staking into pools whose hook has been checked, and tells you when a pool is not offered and why.
- **Smart contract risk.** Uniswap's contracts are audited and battle-tested, but no code is risk-free.

Our advice is the same advice we would give a friend: **start small.** Make your first position a small one, watch it on the explorer, and grow from there.

## What LockFi charges

Nothing. LockFi takes no fee from your position. Every fee your position earns is yours.

## What comes next

- **The Router.** A tool for token teams to turn their creator fees into permanent liquidity for their own pool, so that depth grows as the project grows. It is the one piece Uniswap cannot do on its own, which means it needs its own contract, and it will not ship before that contract is externally audited.
- **Our contract address: coming soon.** The only official address will appear on lockfi.org first. Anything circulating before that is not ours.
- **More markets** as Robinhood Chain grows, with the same rules applied to every one of them.

## Start earning

1. Go to **lockfi.org**
2. Connect your wallet on Robinhood Chain
3. Pick a market, choose a shape, and mint your first position. Small is fine.

Follow @lockfiorg for updates.

Real fees. Your wallet. Nothing printed.

*This article is for information only and is not financial advice. Providing liquidity carries risk, including the loss of the funds you deposit.*
