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
```

## Check it

```bash
npm run typecheck
npm run lint
npm test             # unit — the honest-numbers rules and the bin maths
npm run test:e2e     # browser — flash, FLIP, focus trap, overflow, the §7 rules
```

`npm test` covers `lib/yield.ts` (the §7 rules), `lib/shapes.ts` (bin weights
must sum to exactly 10,000 or `DepthShaper` reverts), `lib/format.ts`, and
`SimProvider` (determinism, derived totals, the three yield states).

`npm run test:e2e` builds the app, starts it and drives Chromium. It asserts the
things a unit test cannot see: values flashing on change, rows animating to a
new rank, the drawer trapping focus and restoring it on Escape, no horizontal
overflow at 360 / 760 / 1180 / 1600px, and that the word "APY" appears nowhere.
CI runs it in a separate job because it needs a browser binary.

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

## Deploy

Nothing is deployed yet — that needs credentials for the box. The configuration
is here:

- `ecosystem.config.js` — PM2 process definition, expects the app at `/var/www/depth`
- `deploy/nginx.conf` — reverse proxy, security headers, immutable caching for
  `/_next/static`, and the `Upgrade` header P1's websocket will need
- `.nvmrc` — Node version, also used by CI

```bash
# on the VPS, once
npm ci && npm run build
pm2 start ecosystem.config.js && pm2 save
sudo cp deploy/nginx.conf /etc/nginx/sites-available/balast
sudo ln -s /etc/nginx/sites-available/balast /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d balast.xyz -d www.balast.xyz
```

The domain is **balast.xyz**, set in `lib/site.ts` and `deploy/nginx.conf`.
`www` 301s to the apex so there is one canonical host.

**Open gap:** `ballast.xyz` — the English spelling on the same TLD — is
registered and parked for sale by a third party. For a front-end that asks
people to connect a wallet, an unowned confusable is a phishing domain someone
else controls. `ballast.fi` and `balast.fi` are both still free; registering
them and 301'ing to the apex closes most of it. `deploy/nginx.conf` has the
redirect stanza ready, commented out.

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
                      error.tsx / loading.tsx / not-found.tsx
components/
  providers/          MarketProvider (DataProvider → React), UiProvider
  shell/              sidebar, top bar, stake drawer, footer
  pools/ stakes/ positions/ router/ portfolio/
  ui/                 badges, sparklines, flashing cell, toast
hooks/                useFlip, useFlash, useReducedMotion
lib/
  chain.ts            chainId 4663 and the §2 addresses (all unverified)
  data/               types.ts (the interface), sim-provider, live-provider, seed
  yield.ts            the honest-numbers rules
  shapes.ts           spot / curve / bid-ask weight generators
  format.ts rng.ts
  *.test.ts           unit tests, run by `npm test`
e2e/                  browser tests, run by `npm run test:e2e`
deploy/nginx.conf     reverse proxy for the VPS
design/depth.html     the approved prototype
```

## Where the implementation made a call

`CLAUDE.md` §12 records every deviation from the prototype, the compressed
simulator clock (and why it needs sign-off), the §10 assumptions that were
implemented, and the one open product question on `/positions`.
