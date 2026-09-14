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
BRANCH=claude/new-session-c0aptv

[[ $EUID -eq 0 ]] || { echo "run as root"; exit 1; }
cd "$APP_DIR"

as_app() { runuser -u "$APP_USER" -- "$@"; }

as_app git fetch origin "$BRANCH"
as_app git checkout -B "$BRANCH" "origin/$BRANCH"
as_app npm ci

# DATA_SOURCE comes from .env and ecosystem.config.js, not from here. Pinning
# it on the build line is how a box ends up serving simulated numbers because
# someone forgot to change one word in a script.
as_app npm run build

# Migrations before the reload: the new code may need the new columns, and
# `migrate deploy` only applies what is pending, so this is a no-op most runs.
as_app npx prisma migrate deploy

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
# The lag is the honest health check (§7): "ok" only means the API answered.
echo "indexer lag:"
curl -fsS localhost:3001/api/health | head -20 || echo "  API not answering yet"
