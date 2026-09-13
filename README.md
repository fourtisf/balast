# Depth

Liquidity layer for Robinhood Chain (chainId 4663). Users deposit into a token pool
and collect a proportional share of swap fees, paid in WETH.

`CLAUDE.md` is the engineering handoff and the source of truth. `design/depth.html`
is the approved design prototype. Where the two disagree, `CLAUDE.md` wins.

**This repository currently contains P0 only: the shell and simulated data.**
No indexer, no contracts, no keeper. See *Build phases* in `CLAUDE.md` §8.

## Run it

```bash
npm install
npm run dev          # http://localhost:3000
npm run build && npm start
npm run typecheck
npm run lint
```

## What P0 ships

Five pages against a simulated data source, with the prototype's live behaviour:

| Route | What it is |
|---|---|
| `/pools` | Featured pool, most-traded and highest-yield cards, two live boards (Trending by volume, Established by fee yield), live fee payouts |
| `/stakes` | Vault grid with trailing-7d fee yield, staked total, fees 24h, stakers, next harvest; your stakes with the 7-day stream |
| `/positions` | The shape builder: token, deposit, shape, range, bin count, live bin chart |
| `/router` | Token-team surface: fee source, trigger mode, destination, timeline, depth projection |
| `/portfolio` | Net value, fees earned, price impact on holdings, daily fee heatmap, position list |

Ported interactions: value flash on change (green up, red down, ~1.1s), FLIP row
reordering on rank change, leader row highlight, `Stake` revealed on row hover,
the bin chart responding to shape / range / bin count, and the responsive column
drops from §5.

## Data

Every component reads through the `DataProvider` interface in
`lib/data/types.ts`. Nothing imports data directly, so P1 is one file.

```
DATA_SOURCE=sim   # default — lib/data/sim-provider.ts, the prototype's market
DATA_SOURCE=live  # P1 — lib/data/live-provider.ts, throws "not implemented"
```

`SimProvider` is deterministic on its first snapshot (seeded PRNG, ages stored as
hours rather than derived from the clock) so the server and the browser render
the same first paint. It ticks the market every 3.2s and the payout feed every
2.6s, exactly as the prototype does. One tick stands in for an hour of chain time.

Derived figures — fee yield above all — are computed in the provider, never in a
component, so P1 can move the same arithmetic into SQL (§4).

## Rules the code enforces

These are product rules, not preferences (§1, §7). They live in
`lib/yield.ts` and are applied by the provider:

- Fee yield is **trailing 7 days**, labelled `fee yield, trailing 7d`. Never
  "APY", never "APR", never a forward or subsidised figure.
- A pool with fewer than 24h of data shows `—`, not a number.
- A pool younger than 7 days is labelled `est.` and carries its age.
- Pre-graduation launchpad liquidity is listed but not stakeable.
- Out-of-range positions say, in the row, in red, that they earn nothing.
- The 10% protocol fee is disclosed in the stake drawer, before signing.
- Indexer lag is shown in the top bar whenever the indexer is behind head.

## Design

All tokens live in `app/globals.css`. No component hardcodes a colour. Green is
the only accent — brand, a positive number, or an active control. Red means
exactly one thing: a negative number. Token logo colours arrive as token
metadata, which is data rather than a palette decision.

`prefers-reduced-motion` disables the flash and the FLIP transform. It does not
disable the data updates.

## Layout

```
app/                  routes + globals.css (the whole design system)
components/
  providers/          MarketProvider (DataProvider → React), UiProvider
  shell/              sidebar, top bar, stake drawer, footer
  pools/ stakes/ positions/ router/ portfolio/
  ui/                 badges, sparklines, flashing cell, toast
hooks/                useFlip, useFlash, useReducedMotion
lib/
  data/               types.ts (the interface), sim-provider, live-provider, seed
  yield.ts            the honest-numbers rules
  shapes.ts           spot / curve / bid-ask weight generators
  format.ts rng.ts
design/depth.html     the approved prototype
```
