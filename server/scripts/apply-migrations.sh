#!/usr/bin/env bash
#
# TD-200 - APPLY PENDING DATABASE CHANGES, AS THE OWNER.
#
# The application connects as a user that may read and write rows but does not own the tables, so
# `npx prisma migrate deploy` fails with "must be owner of table ..." - and, worse, RECORDS that
# failure, which blocks every later migrate until somebody clears it by hand. Somebody meeting this
# for the first time, following Prisma's own documentation, ends up stuck.
#
# So this does the whole job: clears a previous blocked attempt, applies each pending migration as
# the database owner, and tells Prisma it is applied. Run it from the server; it is also
# `npm run db:migrate`, and scripts/deploy.sh names it when it refuses to deploy.
set -euo pipefail
cd "$(dirname "$0")/.."

DB=$(node -e "const u=new URL(process.env.DATABASE_URL||require('fs').readFileSync('.env','utf8').split('\n').find(l=>l.startsWith('DATABASE_URL=')).slice(13).replace(/^\"|\"$/g,''));console.log(u.pathname.slice(1).split('?')[0])")
echo "==> database: $DB"

if ! sudo -n -u postgres psql -d "$DB" -tAc "select 1" >/dev/null 2>&1; then
  echo "!! Cannot reach the database as its owner (postgres)."
  echo "!! Run this on the server as root, or ask whoever administers PostgreSQL to run it."
  exit 1
fi

# A blocked attempt from somebody following Prisma's documented command. Clear it first: nothing was
# applied - that is precisely why it failed - so it is recorded as rolled back, not as done.
FAILED=$(sudo -u postgres psql -d "$DB" -tAc \
  "select migration_name from _prisma_migrations where finished_at is null and rolled_back_at is null" | sed '/^$/d')
if [ -n "$FAILED" ]; then
  echo "==> clearing a previous blocked attempt: $FAILED"
  while read -r m; do [ -n "$m" ] && npx prisma migrate resolve --rolled-back "$m"; done <<< "$FAILED"
fi

APPLIED=$(sudo -u postgres psql -d "$DB" -tAc \
  "select migration_name from _prisma_migrations where finished_at is not null and rolled_back_at is null" | sed '/^$/d')
PENDING=""
for d in prisma/migrations/*/; do
  name=$(basename "$d")
  [ "$name" = "migration_lock.toml" ] && continue
  if ! printf '%s\n' "$APPLIED" | grep -qx "$name"; then PENDING="$PENDING $name"; fi
done

if [ -z "${PENDING// /}" ]; then echo "==> nothing to apply; the database is up to date."; exit 0; fi

echo "==> to apply:"; for m in $PENDING; do echo "     $m"; done
for m in $PENDING; do
  echo "==> applying $m"
  # ON_ERROR_STOP so a failure stops here rather than half-applying and reporting success.
  sudo -u postgres psql -d "$DB" -v ON_ERROR_STOP=1 -f "prisma/migrations/$m/migration.sql"
  npx prisma migrate resolve --applied "$m"
  echo "==> $m applied and recorded"
done
echo "==> done. Now run: bash scripts/deploy.sh"
