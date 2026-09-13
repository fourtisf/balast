#!/usr/bin/env bash
#
# First-time server setup for balast.xyz. Run once, as root, on a fresh
# Ubuntu VPS whose DNS already points here.
#
#   bash deploy/bootstrap.sh
#
# Idempotent enough to re-run: it skips what already exists. It does NOT
# reboot, and it does not apply system updates — do both yourself first.
set -euo pipefail

DOMAIN=balast.xyz
APP_USER=balast
APP_DIR=/var/www/balast
REPO=https://github.com/fourtisf/depth.git
BRANCH=claude/new-session-c0aptv
NODE_MAJOR=20

[[ $EUID -eq 0 ]] || { echo "run as root"; exit 1; }

echo "==> packages"
apt-get update -qq
apt-get install -y -qq curl git nginx certbot ca-certificates

echo "==> node ${NODE_MAJOR}"
if ! command -v node >/dev/null || [[ "$(node -v)" != v${NODE_MAJOR}* ]]; then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y -qq nodejs
fi
npm install -g pm2 >/dev/null

echo "==> app user (the front-end does not run as root)"
id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --create-home --shell /bin/bash "$APP_USER"

echo "==> clone"
mkdir -p "$APP_DIR" /var/www/certbot /var/log/balast
chown -R "$APP_USER:$APP_USER" "$APP_DIR" /var/log/balast
if [[ -d "$APP_DIR/.git" ]]; then
  sudo -u "$APP_USER" git -C "$APP_DIR" fetch origin "$BRANCH"
  sudo -u "$APP_USER" git -C "$APP_DIR" checkout -B "$BRANCH" "origin/$BRANCH"
else
  sudo -u "$APP_USER" git clone --branch "$BRANCH" "$REPO" "$APP_DIR"
fi

echo "==> build"
cd "$APP_DIR"
sudo -u "$APP_USER" npm ci
sudo -u "$APP_USER" env DATA_SOURCE=sim npm run build

echo "==> pm2"
sudo -u "$APP_USER" pm2 start ecosystem.config.js --update-env || sudo -u "$APP_USER" pm2 reload balast-web
sudo -u "$APP_USER" pm2 save
pm2 startup systemd -u "$APP_USER" --hp "/home/$APP_USER" | tail -1 | bash

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
echo "renewal: certbot renews from /var/www/certbot; check with 'certbot renew --dry-run'"
