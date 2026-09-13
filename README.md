# Balast

Liquidity layer for Robinhood Chain (chainId 4663), at **balast.xyz**. Users
deposit into a token pool and collect a proportional share of swap fees, paid
in WETH.

`CLAUDE.md` is the engineering handoff and the source of truth. `design/depth.html`
is the approved design prototype. Where the two disagree, `CLAUDE.md` wins.

**This repository contains P0 and P1: the shell, and the indexer that replaces
its simulated data with real chain data.** No contracts, no keeper, no wallet
connector — those are P2 and P3. See *Build phases* in `CLAUDE.md` §8.

## Run it

```bash
npm install
npm run dev          # http://localhost:3000, simulated data
npm run build && npm start
```

Three processes in production, and P1 adds the last two:

| Process | What it is |
|---|---|
| `npm start` | the Next.js front end |
| `npm run api` | Fastify: `/api/snapshot` and the `/api/stream` websocket |
| `npm run indexer` | the log poller |

## Run it against the real chain

```bash
cp .env.example .env
# Set DATABASE_URL, and USDG_ADDRESS — the indexer refuses to start without it.
npm run db:migrate
npm run indexer      # in one terminal
npm run api          # in another
DATA_SOURCE=live npm run dev
```

`USDG_ADDRESS` is the one thing that has to be looked up by hand. USDG is the
day-one stablecoin on this chain, not USDC (§2), and the WETH/USDG pool is the
site's single USD anchor (§4.3) — without it every USD figure on the site is
zero. The indexer stops with an explanation rather than running and reporting
zeros.

## Check it

```bash
npm run typecheck
npm run lint
npm test             # unit + the §9 acceptance criterion (needs Postgres)
npm run test:e2e     # browser — flash, FLIP, focus trap, overflow, the §7 rules
```

`npm test` covers the honest-numbers rules (`lib/yield.ts`), the bin weights
(`lib/shapes.ts` — they must sum to exactly 10,000 or `BalastShaper` reverts),
`SimProvider`'s determinism, the tick and price maths, and P1's whole pipeline.

### Running the P1 tests

The P1 suite drives a real Postgres through the real SQL, because §9's
criterion is about what the database actually contains. Point it at a
throwaway database:

```bash
export TEST_DATABASE_URL="postgresql://postgres@127.0.0.1:5433/balast_test?schema=public"
npm test
```

The name must contain `balast_test` or the suite refuses to start — it
truncates every table on each run. CI brings up a `postgres:16` service for
this; skipping it would leave the one test that proves the indexer replays
deterministically running only on whichever laptop happened to have a
database.

`npm run test:e2e` builds the app, starts it and drives Chromium. It asserts
the things a unit test cannot see: values flashing on change, rows animating to
a new rank, the drawer trapping focus and restoring it on Escape, no horizontal
overflow at 360 / 760 / 1180 / 1600px, and that the word "APY" appears nowhere.

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
DATA_SOURCE=sim   # lib/data/sim-provider.ts, the prototype's generated market
DATA_SOURCE=live  # lib/data/live-provider.ts, the indexer through the API
```

`SimProvider` is deterministic on its first snapshot (seeded PRNG, ages stored as
hours rather than derived from the clock) so the server and the browser render
the same first paint. It ticks the market every 3.2s and the payout feed every
2.6s, exactly as the prototype does. One tick stands in for an hour of chain time.

Derived figures — fee yield above all — are never computed in a component. In
`sim` they are computed in the provider; in `live` they arrive settled from SQL
(§4.2). Both go through the same classification in `lib/yield.ts`, and there is
a test asserting the SQL and that function agree, so the boards and the
simulator cannot drift apart.

`LiveProvider` will hold nothing rather than something invented. If the API is
down or the indexer has not written a block, the snapshot stays null and the UI
says *waiting for the indexer* — it never falls back to simulated numbers.

### What the indexer does

```
PoolManager v4 + v3 pools  --Initialize, Swap, ModifyLiquidity/Mint/Burn-->
  swap_events, liquidity_events     raw rows, keyed (tx_hash, log_index)
    -> weth_usd_hourly              the one USD anchor (WETH/USDG)
    -> pool_flow_hourly             signed token flow, which gives reserves
    -> pool_fee_hourly              fees and volume per pool per hour
    -> pool_state                   latest price, reserves, TVL
```

Every table is **rebuilt by aggregation, never incremented**. That is the whole
reason §9's criterion is reachable: an increment is order-dependent and
double-counts on replay, so re-scanning the last 32 blocks every pass (§4.1)
would corrupt the totals. Re-aggregating rows keyed by their log coordinates
gives the same answer however many times the same logs arrive.

Each pass rebuilds only the hours its block range touched, but rebuilds them
from every row in those hours — so the result is identical to a full rebuild,
which is exactly what the test compares.

Two things the indexer will not invent. **Market cap** needs a circulating
supply, which is not in the log stream, so it is zero and the column shows an
em dash. **A pool with neither WETH nor USDG on one side** cannot be priced
through the one allowed path, so it is not listed at all rather than listed at
zero.

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
- The trailing window ends at the **last block indexed**, not at wall-clock
  now. Using wall clock would count an hour the indexer had not reached as zero
  fees and quietly deflate every yield on the board; instead the window is
  honest and the lag is reported next to it.
- A pool whose derived depth is unknown — reserves that sum negative, because
  `START_BLOCK` was above its creation block and we never saw its funding mint
  — shows no yield figure at all, rather than a number divided by a divisor we
  know is wrong.
- A derived price outside a sane bound leaves the pool **unpriced**, not
  clamped. A clamp would render as a real TVL of ten quintillion dollars.

## Deploy

```bash
# first time, as root, on a box whose DNS already points here
bash deploy/bootstrap.sh

# every time after
bash /var/www/balast/deploy/deploy.sh
```

`bootstrap.sh` installs Node, Postgres, Redis and nginx, creates the role and
database, writes `/var/www/balast/.env` with a generated database password,
runs the migrations, starts the three PM2 processes and obtains the
certificate. It is safe to re-run: it skips what exists and never regenerates
the password or overwrites `.env`.

It will finish with `USDG_ADDRESS` still blank and tell you so. Set it, then
`pm2 restart balast-indexer --update-env`.

The pieces:

| File | What it is |
|---|---|
| `ecosystem.config.js` | PM2: `balast-web`, `balast-api`, `balast-indexer` |
| `deploy/nginx.conf` | TLS, security headers, `/api/` (never cached), `/api/stream` (websocket, 1h timeout), immutable `/_next/static` |
| `deploy/nginx-bootstrap.conf` | HTTP-only first pass, so certbot has something to answer with |
| `deploy/upgrade-map.conf` | the `$connection_upgrade` map — only install it if nothing else on the box defines one |
| `.nvmrc` | Node version, also used by CI |

Two things that bit us on a shared box, recorded so they don't again. Do not
remove `/etc/nginx/sites-enabled/default` and do not leave a **dangling**
symlink there: the include is a wildcard, so a missing file is fine but a
broken link fails `nginx -t` and blocks reloads for every site on the machine.
And check for an existing `$connection_upgrade` before installing the map — a
duplicate `map` fails the same test.

Watching it work:

```bash
pm2 logs balast-indexer
curl -s localhost:3001/api/health | head -20
```

`ok: true` there only means the API answered. Whether the numbers are current
is the `lagSeconds` field's job to say, and the top bar shows it.

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
server/               P1 — nothing here is imported by a component
  env.ts db.ts        config read once, one Prisma client per process
  chain/              abi, viem client with failover, price and tick maths
  indexer/            events, ingest (pure), aggregate (SQL), poller, discovery
  api/                Fastify server, the snapshot query, the tick bus
  test/               the deterministic fixture chain and db helpers
prisma/schema.prisma  the §4 schema, plus the raw-row tables §9 needs
e2e/                  browser tests, run by `npm run test:e2e`
deploy/               bootstrap.sh, deploy.sh, nginx configs
design/depth.html     the approved prototype
```

## Where the implementation made a call

`CLAUDE.md` §12 records P0's deviations from the prototype, the compressed
simulator clock (and why it needs sign-off), the §10 assumptions that were
implemented, and the one open product question on `/positions`. §14 records
P1's: what the indexer cannot know, what it refuses to guess, and what it
needs from ALFA before it can index the real chain.
