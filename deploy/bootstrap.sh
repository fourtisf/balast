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
apt-get install -y -qq curl git nginx certbot ca-certificates gnupg

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

echo "==> clone"
mkdir -p "$APP_DIR" /var/www/certbot /var/log/balast
chown -R "$APP_USER:$APP_USER" "$APP_DIR" /var/log/balast
if [[ -d "$APP_DIR/.git" ]]; then
  as_app git -C "$APP_DIR" fetch origin "$BRANCH"
  as_app git -C "$APP_DIR" checkout -B "$BRANCH" "origin/$BRANCH"
else
  as_app git clone --branch "$BRANCH" "$REPO" "$APP_DIR"
fi

echo "==> build"
cd "$APP_DIR"
as_app npm ci
as_app env DATA_SOURCE=sim npm run build

echo "==> pm2"
as_app pm2 start ecosystem.config.js --update-env || as_app pm2 reload balast-web
as_app pm2 save
# Run as root, pm2 installs and enables the systemd unit itself.
pm2 startup systemd -u "$APP_USER" --hp "/home/$APP_USER"

echo "==> nginx, HTTP only, so certbot has something to answer with"
install -m 644 deploy/upgrade-map.conf /etc/nginx/conf.d/upgrade-map.conf
install -m 644 deploy/nginx-bootstrap.conf /etc/nginx/sites-available/balast
ln -sf /etc/nginx/sites-available/balast /etc/nginx/sites-enabled/balast
rm -f /etc/nginx/sites-enabled/default
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
