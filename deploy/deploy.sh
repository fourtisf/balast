#!/usr/bin/env bash
#
# Every deploy after the first. Run as root:
#
#   bash /var/www/balast/deploy/deploy.sh
#
# Builds before it reloads, so a build that fails leaves the running version
# serving rather than taking the site down.
set -euo pipefail

APP_USER=balast
APP_DIR=/var/www/balast
BRANCH=claude/new-session-c0aptv

[[ $EUID -eq 0 ]] || { echo "run as root"; exit 1; }
cd "$APP_DIR"

runuser -u "$APP_USER" -- git fetch origin "$BRANCH"
runuser -u "$APP_USER" -- git checkout -B "$BRANCH" "origin/$BRANCH"
runuser -u "$APP_USER" -- npm ci
runuser -u "$APP_USER" -- env DATA_SOURCE=sim npm run build

runuser -u "$APP_USER" -- pm2 reload balast-web --update-env
runuser -u "$APP_USER" -- pm2 save

# Only touch nginx if the config in the repo changed.
if ! diff -q deploy/nginx.conf /etc/nginx/sites-available/balast >/dev/null 2>&1; then
  install -m 644 deploy/upgrade-map.conf /etc/nginx/conf.d/upgrade-map.conf
  install -m 644 deploy/nginx.conf /etc/nginx/sites-available/balast
  nginx -t && systemctl reload nginx
fi

runuser -u "$APP_USER" -- pm2 status balast-web
