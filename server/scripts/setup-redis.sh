#!/usr/bin/env bash
#
# Install and configure Redis for this application, on the Linux server it runs on.
#
# Implements docs/REDIS-SETUP.md exactly. Written as a script rather than a list of commands
# because three of the steps are easy to get wrong by hand and one of them fails silently:
#
#   * the VERSION GATE. bullmq@5 refuses to start below Redis 5.0.0, and this application is worse
#     off with an old Redis than with none — ioredis connects, RedisService.enabled() becomes true,
#     QueueService switches to the BullMQ driver, BullMQ then rejects the version, and the
#     in-process fallback is no longer in the path. This script refuses below 6.2.
#   * maxmemory-policy noeviction. Any other policy means an evicted job is a job that silently
#     never runs.
#   * the PASSWORD. Generated here, on this machine, from the system CSPRNG. It is never typed,
#     pasted, or sent anywhere — which is the only way a secret stays one.
#
# Idempotent: re-running detects an existing install and an existing password and leaves both alone.
#
#   sudo bash scripts/setup-redis.sh                 # install + configure + verify
#   sudo bash scripts/setup-redis.sh --verify-only   # check an existing install, change nothing
#
set -euo pipefail

VERIFY_ONLY=0
[[ "${1:-}" == "--verify-only" ]] && VERIFY_ONLY=1

CONF=/etc/redis/redis.conf
MIN_MAJOR=6
MIN_MINOR=2

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  \033[32mok\033[0m    %s\n' "$*"; }
warn() { printf '  \033[33mwarn\033[0m  %s\n' "$*"; }
die()  { printf '  \033[31mFAIL\033[0m  %s\n\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "run with sudo — this installs a package and edits $CONF"

# ------------------------------------------------------------------ install
if [[ $VERIFY_ONLY -eq 0 ]]; then
  say "1. Installing redis-server"
  if command -v redis-server >/dev/null 2>&1; then
    ok "already installed — $(redis-server --version | awk '{print $1, $2, $3}')"
  else
    apt-get update -qq
    apt-get install -y -qq redis-server
    ok "installed"
  fi
fi

command -v redis-server >/dev/null 2>&1 || die "redis-server is not installed"

# ------------------------------------------------------------------ version gate
say "2. Version gate (>= ${MIN_MAJOR}.${MIN_MINOR}, because bullmq@5 requires it)"
VER=$(redis-server --version | sed -n 's/.*v=\([0-9.]*\).*/\1/p')
[[ -n "$VER" ]] || die "could not read the Redis version"
MAJ=${VER%%.*}; REST=${VER#*.}; MIN=${REST%%.*}
if (( MAJ < MIN_MAJOR || (MAJ == MIN_MAJOR && MIN < MIN_MINOR) )); then
  die "Redis $VER is below ${MIN_MAJOR}.${MIN_MINOR}. Do NOT point the application at it — an old
        Redis is worse than none here. Install a newer one from the distribution repository."
fi
ok "Redis $VER"

if [[ $VERIFY_ONLY -eq 1 ]]; then
  say "3. Verifying the running configuration"
  PASS=$(sed -n 's/^requirepass \(.*\)$/\1/p' "$CONF" | tail -1)
  [[ -n "$PASS" ]] || die "no requirepass in $CONF"
  R() { redis-cli --no-auth-warning -a "$PASS" "$@"; }
  [[ "$(R ping)" == "PONG" ]] || die "no PONG — is the service running?"
  ok "PONG"
  POL=$(R config get maxmemory-policy | tail -1)
  [[ "$POL" == "noeviction" ]] && ok "maxmemory-policy noeviction" || die "maxmemory-policy is '$POL', must be noeviction"
  AOF=$(R config get appendonly | tail -1)
  [[ "$AOF" == "yes" ]] && ok "appendonly yes" || warn "appendonly is '$AOF'"
  ok "bind: $(R config get bind | tail -1)"
  printf '\n'
  exit 0
fi

# ------------------------------------------------------------------ password
say "3. Password"
EXISTING=$(sed -n 's/^requirepass \(.*\)$/\1/p' "$CONF" | tail -1 || true)
if [[ -n "$EXISTING" ]]; then
  PASS="$EXISTING"
  ok "keeping the password already in $CONF"
else
  # 32 bytes from the system CSPRNG, base64, stripped of characters that need percent-encoding in a
  # URL. Generated here so the secret never leaves this machine.
  PASS=$(head -c 48 /dev/urandom | base64 | tr -d '/+=@:?#' | head -c 44)
  ok "generated a new 44-character password"
fi

# ------------------------------------------------------------------ configure
say "4. Writing $CONF"
cp -a "$CONF" "${CONF}.bak.$(date +%Y%m%d-%H%M%S)"
ok "backed up the existing config"

set_directive() {           # replace the directive if present, else append it
  local key="$1" val="$2"
  if grep -qE "^[# ]*${key} " "$CONF"; then
    sed -i -E "s|^[# ]*${key} .*|${key} ${val}|" "$CONF"
  else
    printf '%s %s\n' "$key" "$val" >> "$CONF"
  fi
}

set_directive bind              "127.0.0.1 -::1"
set_directive protected-mode    "yes"
set_directive port              "6379"
set_directive requirepass       "$PASS"
set_directive maxmemory         "512mb"
set_directive maxmemory-policy  "noeviction"
set_directive appendonly        "yes"
set_directive appendfsync       "everysec"
ok "bind localhost · requirepass · maxmemory 512mb · noeviction · appendonly"

chown redis:redis "$CONF" 2>/dev/null || true
chmod 640 "$CONF"
ok "config is 640 root-readable only (it holds the password)"

# ------------------------------------------------------------------ start
say "5. Starting the service"
systemctl enable --now redis-server >/dev/null 2>&1
systemctl restart redis-server
sleep 1
systemctl is-active --quiet redis-server || die "redis-server did not start — journalctl -u redis-server"
ok "running and enabled at boot"

# ------------------------------------------------------------------ verify
say "6. Verifying"
R() { redis-cli --no-auth-warning -a "$PASS" "$@"; }
[[ "$(R ping)" == "PONG" ]] || die "no PONG"
ok "PONG"
[[ "$(R config get maxmemory-policy | tail -1)" == "noeviction" ]] || die "maxmemory-policy is not noeviction"
ok "maxmemory-policy noeviction"
if redis-cli ping 2>&1 | grep -qi "NOAUTH\|Authentication"; then ok "unauthenticated access refused"; else warn "an unauthenticated PING was not refused — check requirepass"; fi

# ------------------------------------------------------------------ hand off
say "7. Add these two lines to server/.env, then restart the application"
cat <<EOF

REDIS_URL=redis://:${PASS}@127.0.0.1:6379
REDIS_PREFIX=ghr-prod

EOF
echo "  Then confirm the application picked it up:"
echo "      node scripts/verify-redis.cjs"
echo
echo "  Expected in the boot log, replacing the two 'not set / in-process' lines:"
echo '      [RedisService] Redis is connected (prefix "ghr-prod:").'
echo
echo "  Rollback at any time: comment out REDIS_URL and restart. Nothing is stored only in Redis."
echo
