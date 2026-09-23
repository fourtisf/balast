#!/usr/bin/env bash
#
# Every deploy after the first. Run as root:
#
#   bash /var/www/balast/deploy/deploy.sh
#
# Builds and migrates before it reloads, so a build that fails leaves the
# running version serving rather than taking the site down.
set -euo pipefail

APP_USER=balast
APP_DIR=/var/www/balast
# The branch this deploys. Overridable — `BRANCH=... bash deploy.sh`.
#
# It is `main` and it should stay `main`. It was once a session branch name,
# and that is the §18 fault in its purest form: work moved to `main`, this
# line did not, and a bare `bash deploy.sh` fetched, built and reloaded a
# months-old branch while printing every line of a successful deploy. A
# default that has to be remembered is a default that will be forgotten, so
# the tracking branch is the default and the override is for the exception.
BRANCH="${BRANCH:-main}"

[[ $EUID -eq 0 ]] || { echo "run as root"; exit 1; }
cd "$APP_DIR"

as_app() { runuser -u "$APP_USER" -- "$@"; }

# ---------------------------------------------------------------------------
# Pull, then hand over to the version that was pulled.
#
# Bash reads a script incrementally, by byte offset. `git checkout` rewrites
# THIS FILE while bash is part-way through it, so execution continues at the
# same offset into the new, longer file — and what runs is a splice of the old
# script and the new one. That is not theoretical: it is why a deploy whose
# migration step had already been fixed still ran the unfixed line and failed
# on a missing DATABASE_URL.
#
# So the update is its own stage. Fetch, check out, then `exec` the new copy,
# which skips this block and runs start to finish from one file.
# ---------------------------------------------------------------------------
if [[ "${BALAST_DEPLOY_STAGE:-}" != "run" ]]; then
  # Everything under the tree belongs to $APP_USER, and a single git command
  # run as root in this directory — the manual checkout a new branch needs
  # the first time — leaves object directories under .git owned by root.
  # The next fetch as $APP_USER then fails with "insufficient permission for
  # adding an object to repository database", and the deploy stops before
  # it has pulled anything. Repair what is wrong rather than everything:
  # node_modules is large, and chowning a tree that is already right is a
  # slow no-op.
  STRAY=$(find "$APP_DIR" -not -user "$APP_USER" | wc -l)
  if [[ "$STRAY" -gt 0 ]]; then
    find "$APP_DIR" -not -user "$APP_USER" -exec chown "$APP_USER:$APP_USER" {} +
    echo "==> $STRAY path(s) under $APP_DIR were not owned by $APP_USER (a git command run as root?) — fixed"
  fi
  as_app git fetch origin "$BRANCH"
  as_app git checkout -B "$BRANCH" "origin/$BRANCH"
  export BALAST_DEPLOY_STAGE=run
  # As the owner: git refuses a repository owned by somebody else, and this
  # script runs as root against a tree owned by $APP_USER.
  echo "==> running $(as_app git rev-parse --short HEAD)"
  exec bash "$APP_DIR/deploy/deploy.sh" "$@"
fi

# Prisma's CLI does its own `.env` discovery, and it does not find the file
# when run through `runuser` — it reported "Environment variable not found:
# DATABASE_URL" against a file sitting in the working directory. Rather than
# work out whose fault that is, pass the value explicitly: a deploy should not
# depend on another tool's search path.
#
# Only DATABASE_URL is read. Sourcing the whole file would pull every other
# secret into this shell for no reason.
db_url() {
  grep -E '^DATABASE_URL=' "$APP_DIR/.env" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"'
}

DATABASE_URL=$(db_url)
if [[ -z "$DATABASE_URL" ]]; then
  echo "no DATABASE_URL in $APP_DIR/.env — the migration and the build need it"
  exit 1
fi
export DATABASE_URL

# postinstall runs `prisma generate`, which validates the schema and so needs
# DATABASE_URL present even though it never connects.
as_app env DATABASE_URL="$DATABASE_URL" npm ci

# DATA_SOURCE comes from .env and ecosystem.config.js, not from here. Pinning
# it on the build line is how a box ends up serving simulated numbers because
# someone forgot to change one word in a script.
as_app npm run build

# Migrations before the reload: the new code may need the new columns, and
# `migrate deploy` only applies what is pending, so this is a no-op most runs.
as_app env DATABASE_URL="$DATABASE_URL" npx prisma migrate deploy

# startOrReload, not reload.
#
# `pm2 reload <name>` does not reliably revive a process already in `errored`
# state — and that is exactly when a deploy is most needed, because the deploy
# is usually the fix. A crashed process would silently stay crashed through
# the one command meant to repair it. `startOrReload` against the ecosystem
# file starts whatever is not running and reloads whatever is.
as_app pm2 startOrReload ecosystem.config.js --update-env
as_app pm2 save

# Clear the restart counters, so `pm2 status` shows what happened since this
# deploy rather than a five-figure number from before the fix.
as_app pm2 reset all >/dev/null 2>&1 || true

# Only touch nginx if the config in the repo changed.
if ! diff -q deploy/nginx.conf /etc/nginx/sites-available/balast >/dev/null 2>&1; then
  # Don't install the map if something else on the box already defines
  # $connection_upgrade: a duplicate `map` fails `nginx -t`, and on a shared
  # server that takes every other site down on the next reload.
  if ! grep -rqs 'connection_upgrade' /etc/nginx/conf.d /etc/nginx/nginx.conf; then
    install -m 644 deploy/upgrade-map.conf /etc/nginx/conf.d/upgrade-map.conf
  fi
  install -m 644 deploy/nginx.conf /etc/nginx/sites-available/balast
  nginx -t && systemctl reload nginx
fi

as_app pm2 status

echo
# Say what is running, because the question after a deploy that changed
# nothing visible has been "did it actually deploy the branch I meant".
echo "running $(as_app git rev-parse --short HEAD) on $(as_app git rev-parse --abbrev-ref HEAD)"

# The API answers 503 for every state that is not "ok" — a first sync, no
# anchor yet, a stall — and carries the reason in the body. `curl -f` turned
# each of those into "API not answering yet", which was false and hid the one
# line that said what was going on. Read the body; explain the state.
echo "indexer:"
# The API was just restarted and takes a few seconds to listen; asking once,
# at once, reported a healthy restart as "did not answer". Give it a minute.
BODY=""
for _ in $(seq 1 30); do
  BODY=$(curl -sS --max-time 10 localhost:3001/api/health 2>/dev/null || true)
  [[ -n "$BODY" ]] && break
  sleep 2
done
if [[ -z "$BODY" ]]; then
  echo "  the API did not answer on :3001 — runuser -u $APP_USER -- pm2 logs balast-api --lines 30 --nostream"
else
  printf '%s' "$BODY" | node -e '
    let raw = "";
    process.stdin.on("data", (d) => (raw += d)).on("end", () => {
      let h;
      try { h = JSON.parse(raw); } catch { console.log("  unreadable health body: " + raw.slice(0, 160)); return; }
      const i = h.indexed || {};
      const pct = i.progressPct == null ? "" : ` (${Number(i.progressPct).toFixed(2)}% of the chain)`;
      const lag = i.lagSeconds == null ? "" : `, ${Math.round(i.lagSeconds)}s of chain time behind`;
      switch (h.status) {
        case "ok":
          console.log(`  ok — following head${lag}`); break;
        case "no-anchor":
          if (i.syncing) console.log(`  first sync running${pct}: block ${i.lastBlock} of ${i.headBlock}, ${h.pools} pool(s) so far.`);
          else if (i.headBlock == null) console.log(`  block ${i.lastBlock}, ${h.pools} pool(s); the indexer has not reported the chain head yet — check again in a minute.`);
          else console.log(`  caught up, and no ETH/USDG pool among ${h.pools} pool(s) — run: npm run tokens:indexed`);
          console.log("  no USD anchor yet, so the site shows the waiting panel with this progress. Not an error.");
          break;
        case "syncing":
          console.log(`  first sync running${pct}: block ${i.lastBlock} of ${i.headBlock}, ${h.pools} pool(s). The site is up and shows the lag. Not an error.`); break;
        case "behind":
          console.log(`  indexing, catching up${lag}.`); break;
        case "working": {
          // A stage that writes no block — the full rebuild after a repair
          // migration, or the history of the v3 factory — heartbeating. Busy, not dead.
          const w = h.working || {};
          const dur = Math.round((w.seconds || 0) / 60);
          console.log(`  busy: ${w.stage}${w.detail ? " — " + w.detail : ""}, ${dur} min so far, alive. No block is written until it finishes; not an error.`);
          break;
        }
        case "stalled":
          console.log(`  STALLED — nothing written for ${Math.round(i.idleSeconds || 0)}s. runuser -u balast -- pm2 logs balast-indexer --lines 30 --nostream`); break;
        case "never-indexed":
          console.log("  the indexer has never written a block — runuser -u balast -- pm2 logs balast-indexer --lines 30 --nostream"); break;
        case "misconfigured":
          console.log("  MISCONFIGURED: " + h.message); break;
        default:
          console.log("  " + (h.message || raw.slice(0, 160)));
      }
    });' || echo "  $BODY" | head -c 300
fi
