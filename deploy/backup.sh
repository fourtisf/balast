#!/usr/bin/env bash
#
# Nightly database dump.
#
#   0 4 * * * /var/www/balast/deploy/backup.sh
#
# The database can in principle be rebuilt from the chain — that is what §9's
# determinism buys — but a rebuild is a full re-sync from START_BLOCK, which
# on ~100ms blocks (§2) is hours of catching up while the site shows a
# climbing lag. A dump turns that into a restore.
#
# Dumps are local. That protects against a bad migration or a dropped table,
# NOT against losing the box: for that they have to leave the machine, and
# where to is a decision with credentials attached, so BACKUP_SYNC_CMD is
# left for whoever makes it.
set -euo pipefail

DIR=${BACKUP_DIR:-/var/backups/balast}
KEEP_DAYS=${BACKUP_KEEP_DAYS:-14}
ENV_FILE=${ENV_FILE:-/var/www/balast/.env}

[[ -f "$ENV_FILE" ]] || { echo "no $ENV_FILE"; exit 1; }
# DATABASE_URL only. Sourcing the whole file would pull every other secret
# into this shell's environment for no reason.
DATABASE_URL=$(grep -E '^DATABASE_URL=' "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '"')
[[ -n "$DATABASE_URL" ]] || { echo "no DATABASE_URL in $ENV_FILE"; exit 1; }

mkdir -p "$DIR"
chmod 700 "$DIR"
OUT="$DIR/balast-$(date -u +%Y%m%dT%H%M%SZ).sql.gz"

# --clean so the dump can be restored over an existing database.
pg_dump --clean --if-exists --no-owner --no-privileges "$DATABASE_URL" | gzip -9 > "$OUT.part"
mv "$OUT.part" "$OUT"
chmod 600 "$OUT"

# A zero-length or tiny dump means pg_dump failed while gzip still succeeded —
# the pipe hides the exit code, so check the result instead.
SIZE=$(stat -c%s "$OUT")
if [[ "$SIZE" -lt 2000 ]]; then
  echo "dump is only ${SIZE}B — treating as failed, keeping it for inspection" >&2
  exit 1
fi

find "$DIR" -name 'balast-*.sql.gz' -mtime "+$KEEP_DAYS" -delete
echo "$(date -Is) wrote $OUT ($((SIZE / 1024)) KiB), keeping $KEEP_DAYS days"

# Off-box copy, if someone has configured one. Without this a dump survives a
# bad migration but not a lost server.
if [[ -n "${BACKUP_SYNC_CMD:-}" ]]; then
  sh -c "$BACKUP_SYNC_CMD" "$OUT" || echo "BACKUP_SYNC_CMD failed" >&2
fi
