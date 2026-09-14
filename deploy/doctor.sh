#!/usr/bin/env bash
#
# What is actually wrong with this box?
#
#   bash /var/www/balast/deploy/doctor.sh
#
# Checks every layer in dependency order and stops describing symptoms once it
# finds the first thing that is actually broken, because everything downstream
# of a missing DATABASE_URL is going to look broken too.
#
# It ends with ONE next command. That is the point: three rounds of reading a
# stack trace, guessing, and trying again is worse than one command that says
# what to do.
#
# Read-only. It starts nothing, writes nothing and restarts nothing.
set -uo pipefail

APP_USER=${APP_USER:-balast}
APP_DIR=${APP_DIR:-/var/www/balast}
ENV_FILE="$APP_DIR/.env"
API=${API:-http://127.0.0.1:3001}
DOMAIN=${DOMAIN:-balast.xyz}

ok()   { printf '  \033[32mok\033[0m    %s\n' "$1"; }
bad()  { printf '  \033[31mBAD\033[0m   %s\n' "$1"; FAILED=1; }
warn() { printf '  \033[33mwarn\033[0m  %s\n' "$1"; }
head_() { printf '\n\033[1m%s\033[0m\n' "$1"; }

FAILED=0
NEXT=""
# The first failure is the real one. Later checks are noise until it is fixed.
first() { [[ -z "$NEXT" ]] && NEXT="$1"; }

as_app() { runuser -u "$APP_USER" -- "$@" 2>/dev/null; }
env_get() { grep -E "^$1=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"'; }

# `?schema=public` is Prisma's, not libpq's — psql refuses the whole URL over
# it and the check would report a healthy database as unreachable. Strip the
# query string for psql only; Prisma keeps the URL it was given.
pg_url() { printf '%s' "${1%%\?*}"; }

# ---------------------------------------------------------------- the code --
head_ "code"
if [[ -d "$APP_DIR/.git" ]]; then
  HEAD_SHA=$(git -C "$APP_DIR" rev-parse --short HEAD 2>/dev/null)
  BRANCH=$(git -C "$APP_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null)
  ok "$APP_DIR on $BRANCH at $HEAD_SHA"
  git -C "$APP_DIR" fetch --quiet origin "$BRANCH" 2>/dev/null || true
  BEHIND=$(git -C "$APP_DIR" rev-list --count "HEAD..origin/$BRANCH" 2>/dev/null || echo 0)
  if [[ "${BEHIND:-0}" -gt 0 ]]; then
    warn "$BEHIND commit(s) behind origin/$BRANCH"
    first "bash $APP_DIR/deploy/deploy.sh"
  else
    ok "up to date with origin"
  fi
else
  bad "$APP_DIR is not a git checkout"
  first "clone the repo to $APP_DIR — see README, Deploy"
fi

# ------------------------------------------------------------------- .env ---
head_ "configuration"
if [[ ! -f "$ENV_FILE" ]]; then
  bad "$ENV_FILE is missing"
  first "bash $APP_DIR/deploy/bootstrap.sh"
else
  ok "$ENV_FILE exists ($(stat -c '%U:%G %a' "$ENV_FILE"))"
  DB_URL=$(env_get DATABASE_URL)
  USDG=$(env_get USDG_ADDRESS)
  START_BLOCK=$(env_get START_BLOCK)
  V3_FACTORY=$(env_get V3_FACTORY)

  [[ -n "$DB_URL" ]] && ok "DATABASE_URL set" || {
    bad "DATABASE_URL is empty"
    first "bash $APP_DIR/deploy/bootstrap.sh   # rewrites .env"
  }

  if [[ -z "$USDG" ]]; then
    # Not a warning. The indexer will not start, by design.
    bad "USDG_ADDRESS is empty — the indexer refuses to start without it"
    first "cd $APP_DIR && npm run find:tokens   # then ./deploy/set-env.sh USDG_ADDRESS 0x..."
  elif [[ ! "$USDG" =~ ^0x[0-9a-fA-F]{40}$ ]]; then
    bad "USDG_ADDRESS is not an address: $USDG"
    first "cd $APP_DIR && ./deploy/set-env.sh USDG_ADDRESS 0x..."
  else
    ok "USDG_ADDRESS $USDG"
  fi

  if [[ "${START_BLOCK:-0}" == "0" || -z "${START_BLOCK:-}" ]]; then
    warn "START_BLOCK is 0 — the first sync scans from genesis, which on ~100ms blocks is a long wait"
  else
    ok "START_BLOCK $START_BLOCK"
  fi
  [[ -n "$V3_FACTORY" ]] && ok "V3_FACTORY $V3_FACTORY" \
    || warn "V3_FACTORY unset — v3 pools will only be those hand-listed in V3_POOLS (§4)"
fi

# --------------------------------------------------------------- database ---
head_ "database"
if [[ -n "${DB_URL:-}" ]]; then
  PSQL_URL=$(pg_url "$DB_URL")
  if psql "$PSQL_URL" -tAc 'select 1' >/dev/null 2>&1; then
    ok "postgres reachable"
    APPLIED=$(psql "$PSQL_URL" -tAc \
      "select count(*) from _prisma_migrations where finished_at is not null" 2>/dev/null || echo "")
    if [[ -z "$APPLIED" ]]; then
      bad "no _prisma_migrations table — migrations have never run"
      first "cd $APP_DIR && runuser -u $APP_USER -- env DATABASE_URL=\"\$(grep ^DATABASE_URL= .env | cut -d= -f2- | tr -d '\"')\" npx prisma migrate deploy"
    else
      ON_DISK=$(find "$APP_DIR/prisma/migrations" -maxdepth 1 -mindepth 1 -type d 2>/dev/null | wc -l)
      if [[ "$APPLIED" -lt "$ON_DISK" ]]; then
        bad "$APPLIED of $ON_DISK migration(s) applied"
        first "bash $APP_DIR/deploy/deploy.sh"
      else
        ok "$APPLIED migration(s) applied"
      fi
      for t in pools swap_events pool_fee_hourly; do
        N=$(psql "$PSQL_URL" -tAc "select count(*) from $t" 2>/dev/null || echo "?")
        printf '        %-18s %s row(s)\n' "$t" "$N"
      done
    fi
  else
    bad "cannot connect with the DATABASE_URL in .env"
    first "systemctl status postgresql"
  fi
else
  warn "skipped — no DATABASE_URL"
fi

if [[ -d "$APP_DIR/node_modules/.prisma/client" ]]; then
  ok "prisma client generated"
else
  bad "prisma client not generated — the API and indexer cannot import it"
  first "bash $APP_DIR/deploy/deploy.sh"
fi

# ------------------------------------------------------------- processes ----
head_ "processes"
if command -v pm2 >/dev/null; then
  JSON=$(as_app pm2 jlist)
  for app in balast-web balast-api balast-indexer; do
    LINE=$(printf '%s' "$JSON" | tr '}' '}\n' | grep -o "\"name\":\"$app\".*" | head -1)
    STATUS=$(printf '%s' "$JSON" \
      | grep -o "\"name\":\"$app\",\"pm2_env\":{[^}]*" | grep -o '"status":"[a-z]*"' \
      | cut -d'"' -f4 | head -1)
    RESTARTS=$(printf '%s' "$JSON" \
      | grep -o "\"name\":\"$app\",\"pm2_env\":{[^}]*" | grep -o '"restart_time":[0-9]*' \
      | cut -d: -f2 | head -1)
    case "${STATUS:-missing}" in
      online) ok "$app online (${RESTARTS:-0} restarts)" ;;
      errored|stopped)
        bad "$app is ${STATUS} after ${RESTARTS:-?} restart(s)"
        first "runuser -u $APP_USER -- pm2 logs $app --lines 30 --nostream"
        ;;
      *) bad "$app is ${STATUS:-not running}"; first "bash $APP_DIR/deploy/deploy.sh" ;;
    esac
  done
  systemctl is-enabled "pm2-$APP_USER" >/dev/null 2>&1 \
    && ok "pm2-$APP_USER enabled — survives a reboot" \
    || bad "pm2-$APP_USER NOT enabled — a reboot leaves nginx serving 502s"
else
  bad "pm2 is not installed"
fi

# -------------------------------------------------------------------- api ---
head_ "api"
BODY=$(curl -sS --max-time 10 "$API/api/health" 2>/dev/null)
if [[ -z "$BODY" ]]; then
  bad "no answer from $API/api/health"
else
  STATUS=$(printf '%s' "$BODY" | grep -o '"status":"[a-z-]*"' | head -1 | cut -d'"' -f4)
  LAG=$(printf '%s' "$BODY" | grep -o '"lagSeconds":[0-9.]*' | head -1 | cut -d: -f2)
  case "$STATUS" in
    ok) ok "indexer following head (lag ${LAG%.*}s)" ;;
    stalled)
      bad "indexer stalled — ${LAG%.*}s behind; the site is showing numbers that old"
      first "runuser -u $APP_USER -- pm2 logs balast-indexer --lines 30 --nostream"
      ;;
    never-indexed)
      bad "the indexer has never written a block"
      first "runuser -u $APP_USER -- pm2 logs balast-indexer --lines 30 --nostream"
      ;;
    *) bad "unexpected health body: ${BODY:0:160}" ;;
  esac
fi

# ------------------------------------------------------------------ nginx ---
head_ "nginx"
if nginx -t >/dev/null 2>&1; then
  ok "config test passes"
else
  bad "nginx -t FAILS — no site on this box can reload"
  first "nginx -t"
fi
[[ -L /etc/nginx/sites-enabled/balast || -f /etc/nginx/sites-enabled/balast ]] \
  && ok "balast site enabled" || bad "balast site not in sites-enabled"
grep -q '/api/' /etc/nginx/sites-available/balast 2>/dev/null \
  && ok "nginx proxies /api/" \
  || { bad "nginx has no /api/ block — the browser cannot reach the indexer"
       first "cd $APP_DIR && install -m 644 deploy/nginx.conf /etc/nginx/sites-available/balast && nginx -t && systemctl reload nginx"; }

CERT=/etc/letsencrypt/live/$DOMAIN/fullchain.pem
if [[ -f "$CERT" ]]; then
  DAYS=$(( ($(date -d "$(openssl x509 -enddate -noout -in "$CERT" | cut -d= -f2)" +%s) - $(date +%s)) / 86400 ))
  [[ "$DAYS" -gt 14 ]] && ok "certificate valid for $DAYS more day(s)" \
                       || bad "certificate expires in $DAYS day(s)"
else
  bad "no certificate for $DOMAIN"
fi

# ------------------------------------------------------------------- disk ---
head_ "disk"
USE=$(df -P "$APP_DIR" | awk 'NR==2{print $5}' | tr -d '%')
[[ "$USE" -lt 90 ]] && ok "${USE}% used on $(df -P "$APP_DIR" | awk 'NR==2{print $6}')" \
                    || bad "${USE}% used — writes will start failing"

# ----------------------------------------------------------------- verdict --
printf '\n\033[1mverdict\033[0m\n'
if [[ "$FAILED" -eq 0 ]]; then
  echo "  Everything checks out."
  exit 0
fi
echo "  Something above is broken. The first failure is the one that matters —"
echo "  everything downstream of it will look broken too."
if [[ -n "$NEXT" ]]; then
  printf '\n\033[1mnext\033[0m\n  %s\n\n' "$NEXT"
fi
exit 1
