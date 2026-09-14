#!/usr/bin/env bash
#
# Which port is this box's PostgreSQL cluster actually on?
#
# Sourced by bootstrap.sh and doctor.sh. Not obvious enough to inline twice.
#
# `psql` cannot answer this. Its unix socket is named `.s.PGSQL.<port>` and it
# defaults to 5432, so asking the cluster its port over the socket requires
# already knowing the port. Debian also puts a SECOND cluster on 5433 when
# 5432 is taken, which on a box already running PostgreSQL for something else
# is the normal case — and the symptom is a DATABASE_URL that points at a
# database which exists and cannot be reached.
#
# So: ask the system, in order of how authoritative it is.

# Prints the port, or nothing if no cluster can be found.
pg_detect_port() {
  local port=""

  # 1. Debian's own cluster registry, which knows about every version
  #    installed side by side. Prefer an online cluster.
  if command -v pg_lsclusters >/dev/null 2>&1; then
    port=$(pg_lsclusters --no-header 2>/dev/null | awk '$4 == "online" {print $3; exit}')
    [[ -n "$port" ]] && { printf '%s' "$port"; return 0; }
  fi

  # 2. The socket files themselves. A socket exists only for a running
  #    cluster, and its name carries the port.
  for dir in /var/run/postgresql /tmp; do
    [[ -d "$dir" ]] || continue
    # -a, because the socket is a dotfile: .s.PGSQL.<port>
    port=$(ls -a "$dir" 2>/dev/null | sed -n 's/^\.s\.PGSQL\.\([0-9]\+\)$/\1/p' | sort -n | head -1)
    [[ -n "$port" ]] && { printf '%s' "$port"; return 0; }
  done

  # 3. A TCP listener owned by postgres. Last because a cluster can be up on
  #    its socket while refusing TCP, which is its own distinct fault.
  if command -v ss >/dev/null 2>&1; then
    port=$(ss -lntp 2>/dev/null | awk '/postgres/ {split($4, a, ":"); print a[length(a)]; exit}')
    [[ -n "$port" ]] && { printf '%s' "$port"; return 0; }
  fi

  return 1
}

# Does the cluster accept TCP on 127.0.0.1 at that port? A cluster whose
# listen_addresses is unset answers on its socket and refuses 127.0.0.1, which
# looks exactly like postgres being down.
pg_listen_addresses() {
  local port=$1
  runuser -u postgres -- psql -p "$port" -tAc 'show listen_addresses' 2>/dev/null | tr -d '[:space:]'
}
