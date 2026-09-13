#!/usr/bin/env bash
#
# First-time server setup for balast.xyz. Run once, as root, on a fresh
# Ubuntu VPS whose DNS already points here.
#
#   bash deploy/bootstrap.sh
#
# Safe to re-run: it skips what already exists. It does not reboot and it does
# not apply system updates — do both yourself first.
set -euo pipefail

DOMAIN=balast.xyz
APP_USER=balast
APP_DIR=/var/www/balast
REPO=https://github.com/fourtisf/depth.git
BRANCH=claude/new-session-c0aptv
NODE_MAJOR=20

[[ $EUID -eq 0 ]] || { echo "run as root"; exit 1; }

# runuser rather than sudo: it is part of util-linux, so it is always present,
# and it is the right tool for root dropping to a service account.
as_app() { runuser -u "$APP_USER" -- "$@"; }

# A server with unrelated broken third-party repositories — an unsigned
# ClickHouse list, an expired GitHub CLI key — makes `apt-get update` exit
# non-zero. That is not this deploy's problem and not a reason to abort it, so
# report and carry on. `apt-get install` still fails loudly if a package we
# actually need is unavailable.
apt_update_tolerant() {
  local log=/tmp/balast-apt-update.log
  if apt-get update -qq >"$log" 2>&1; then return 0; fi
  echo "!! apt-get update reported errors — continuing anyway:"
  grep -E '^[EW]:' "$log" | sed 's/^/     /' || true
  echo "   (the Ubuntu archives are what this script needs; full log: $log)"
}

echo "==> packages"
apt_update_tolerant
apt-get install -y -qq curl git nginx certbot ca-certificates gnupg \
  postgresql postgresql-client redis-server

echo "==> node ${NODE_MAJOR}"
if ! command -v node >/dev/null || [[ "$(node -v)" != v${NODE_MAJOR}* ]]; then
  install -d -m 0755 /usr/share/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | gpg --dearmor --yes -o /usr/share/keyrings/nodesource.gpg
  echo "deb [signed-by=/usr/share/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" \
    > /etc/apt/sources.list.d/nodesource.list
  # Refresh ONLY the NodeSource list, so a broken repo elsewhere cannot
  # interfere with installing node.
  apt-get update -qq \
    -o Dir::Etc::sourcelist=/etc/apt/sources.list.d/nodesource.list \
    -o Dir::Etc::sourceparts=/dev/null \
    -o APT::Get::List-Cleanup=0
  apt-get install -y -qq nodejs
fi
command -v pm2 >/dev/null || npm install -g pm2 >/dev/null

echo "==> app user (the front-end does not run as root)"
id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --create-home --shell /bin/bash "$APP_USER"

echo "==> postgres"
# The cluster Ubuntu creates on install is fine; all this does is make the
# role and database, idempotently. The password is generated here and written
# only to the app's .env — it is never echoed and never in this repository.
systemctl enable --now postgresql
DB_NAME=balast
DB_USER=balast
if ! runuser -u postgres -- psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='$DB_USER'" | grep -q 1; then
  DB_PASS="$(openssl rand -hex 24)"
  runuser -u postgres -- psql -qc "CREATE ROLE $DB_USER LOGIN PASSWORD '$DB_PASS'"
  echo "   created role $DB_USER"
else
  DB_PASS=""
  echo "   role $DB_USER already exists — leaving its password alone"
fi
if ! runuser -u postgres -- psql -tAc "SELECT 1 FROM pg_database WHERE datname='$DB_NAME'" | grep -q 1; then
  runuser -u postgres -- createdb -O "$DB_USER" "$DB_NAME"
  echo "   created database $DB_NAME"
fi

echo "==> redis"
# Only on localhost. Redis with no password on a public interface is how a
# box gets owned; it carries nothing secret here, but it is still a shell.
systemctl enable --now redis-server
if ! grep -qE '^bind 127\.0\.0\.1' /etc/redis/redis.conf; then
  echo "   !! /etc/redis/redis.conf does not bind to 127.0.0.1 — check it"
fi

echo "==> clone"
mkdir -p "$APP_DIR" /var/www/certbot /var/log/balast
chown -R "$APP_USER:$APP_USER" "$APP_DIR" /var/log/balast
if [[ -d "$APP_DIR/.git" ]]; then
  as_app git -C "$APP_DIR" fetch origin "$BRANCH"
  as_app git -C "$APP_DIR" checkout -B "$BRANCH" "origin/$BRANCH"
else
  as_app git clone --branch "$BRANCH" "$REPO" "$APP_DIR"
fi

echo "==> env"
# Written once and then left alone: a redeploy must not regenerate the
# database password or wipe the USDG address someone looked up by hand.
if [[ ! -f "$APP_DIR/.env" ]]; then
  if [[ -z "$DB_PASS" ]]; then
    echo "!! $APP_DIR/.env is missing but the $DB_USER role already exists, so"
    echo "   its password is not known here. Reset it with:"
    echo "     sudo -u postgres psql -c \"ALTER ROLE $DB_USER PASSWORD '...'\""
    echo "   then write $APP_DIR/.env yourself from .env.example."
    exit 1
  fi
  cat > "$APP_DIR/.env" <<ENVEOF
DATA_SOURCE=live
DATABASE_URL="postgresql://$DB_USER:$DB_PASS@127.0.0.1:5432/$DB_NAME?schema=public"
REDIS_URL="redis://127.0.0.1:6379"
API_PORT=3001
API_HOST=127.0.0.1
START_BLOCK=0
INDEXER_BLOCK_RANGE=2000
# THE INDEXER WILL NOT START WITHOUT THIS.
# USDG is the day-one stablecoin on this chain, not USDC, and the WETH/USDG
# pool is the site's one USD anchor. Look it up on the explorer and set it.
USDG_ADDRESS=
LAUNCHPAD_HOOKS=
V3_POOLS=
ENVEOF
  chown "$APP_USER:$APP_USER" "$APP_DIR/.env"
  chmod 600 "$APP_DIR/.env"
  echo "   wrote $APP_DIR/.env"
else
  echo "   $APP_DIR/.env already exists — left alone"
fi

echo "==> build"
cd "$APP_DIR"
as_app npm ci
as_app npm run build

echo "==> migrate"
as_app npx prisma migrate deploy

echo "==> pm2"
# Rotate the logs. Three processes writing to six files with no rotation fills
# a disk eventually, and the first symptom is writes failing everywhere.
as_app pm2 install pm2-logrotate >/dev/null 2>&1 || true
as_app pm2 set pm2-logrotate:max_size 20M      >/dev/null 2>&1 || true
as_app pm2 set pm2-logrotate:retain 14         >/dev/null 2>&1 || true
as_app pm2 set pm2-logrotate:compress true     >/dev/null 2>&1 || true

as_app pm2 start ecosystem.config.js --update-env || as_app pm2 reload all
as_app pm2 save
# Run as root, pm2 installs and enables the systemd unit itself.
pm2 startup systemd -u "$APP_USER" --hp "/home/$APP_USER"
# ...and verify it took. Without this unit the box reboots into nginx serving
# 502s, because nothing brings the three processes back.
if systemctl is-enabled "pm2-$APP_USER" >/dev/null 2>&1; then
  echo "   pm2-$APP_USER is enabled — the processes survive a reboot"
else
  echo "   !! pm2-$APP_USER is NOT enabled. A reboot will leave nginx serving 502s."
  echo "      Run: pm2 startup systemd -u $APP_USER --hp /home/$APP_USER"
fi

echo "==> cron: backups and the indexer monitor"
# Both are idempotent: the marker comment is what makes re-running safe.
install -m 755 "$APP_DIR/deploy/backup.sh"  /usr/local/bin/balast-backup
install -m 755 "$APP_DIR/deploy/monitor.sh" /usr/local/bin/balast-monitor
mkdir -p /var/lib/balast /var/backups/balast
chmod 700 /var/backups/balast
cat > /etc/cron.d/balast <<'CRONEOF'
# Balast — installed by deploy/bootstrap.sh
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# Is the indexer actually indexing? §8's P3 failure mode, one phase early:
# a dead indexer leaves the site serving old numbers as though they were live.
# Set ALERT_CMD in /etc/default/balast to have it reach a person.
*/5 * * * * root [ -r /etc/default/balast ] && . /etc/default/balast; /usr/local/bin/balast-monitor >/dev/null 2>&1

# Nightly dump. Local only — see the note in deploy/backup.sh about getting
# it off the box.
0 4 * * * root /usr/local/bin/balast-backup >> /var/log/balast/backup.log 2>&1
CRONEOF
chmod 644 /etc/cron.d/balast
touch /etc/default/balast
chmod 600 /etc/default/balast
echo "   monitor every 5 min, dump at 04:00 UTC"
echo "   to be told when the indexer stalls, put ALERT_CMD in /etc/default/balast"

echo "==> nginx, HTTP only, so certbot has something to answer with"
# Only add the map if nothing else already defines $connection_upgrade —
# a duplicate makes `nginx -t` fail and would take every site on the box down
# on the next reload.
if ! grep -rqs 'connection_upgrade' /etc/nginx/conf.d /etc/nginx/nginx.conf; then
  install -m 644 deploy/upgrade-map.conf /etc/nginx/conf.d/upgrade-map.conf
else
  echo "   \$connection_upgrade already defined elsewhere — leaving it alone"
fi
install -m 644 deploy/nginx-bootstrap.conf /etc/nginx/sites-available/balast
ln -sf /etc/nginx/sites-available/balast /etc/nginx/sites-enabled/balast
# The default site is deliberately left alone. On a server with other vhosts,
# removing it moves every unmatched request somewhere new.
nginx -t && systemctl reload nginx

echo "==> certificate"
if [[ ! -s "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ]]; then
  certbot certonly --webroot -w /var/www/certbot \
    -d "$DOMAIN" -d "www.$DOMAIN" \
    --agree-tos --non-interactive --register-unsafely-without-email
fi

echo "==> nginx, real config with TLS"
install -m 644 deploy/nginx.conf /etc/nginx/sites-available/balast
nginx -t && systemctl reload nginx

echo
echo "done — https://$DOMAIN"
echo "prove the renewal path works:  certbot renew --dry-run"
echo
if ! grep -qE '^USDG_ADDRESS=.+' "$APP_DIR/.env"; then
  echo "!! USDG_ADDRESS is still blank in $APP_DIR/.env."
  echo "   balast-indexer will refuse to start until it is set — deliberately,"
  echo "   because without the WETH/USDG anchor every USD figure reads zero."
  echo "   Find USDG on the explorer, set it, then:"
  echo "     pm2 restart balast-indexer --update-env"
  echo
fi
echo "watch it index:   pm2 logs balast-indexer"
echo "check the lag:    curl -s localhost:3001/api/health | head -20"
