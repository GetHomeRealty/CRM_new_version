#!/usr/bin/env bash
#
# TD-165 - THE DEPLOY RUNS THE GATE, SO NOBODY HAS TO REMEMBER TO.
#
# Every step below was already being done by hand, one pasted command at a time, with the test run
# as an optional extra that depended on somebody thinking of it. On 2026-09-10 that habit was found
# to have let eighteen tests go red unnoticed - two of them commission parity gates holding
# 21,723.45 and 131,544.00 between them.
#
# set -e is doing the real work here: if the gate fails, pm2 restart is never reached. The build
# will already have replaced dist/, but the RUNNING process keeps the old code in memory until it
# is restarted, so a failed gate leaves production exactly as it was.
set -euo pipefail
cd "$(dirname "$0")/.."

STAMP=$(date +%Y%m%d-%H%M%S)
echo "==> backing up dist to dist.bak.$STAMP"
cp -r dist "dist.bak.$STAMP"

# TD-192 - put the build that was running back. Used whenever this script stops after building.
restore_build() {
  echo "!! putting the previous build back (dist.bak.$STAMP)"
  rm -rf dist && cp -r "dist.bak.$STAMP" dist
}

echo "==> building"
npm run build

# F-1 - stamp the build so /api/health can name the commit serving traffic. Written INSIDE dist/
# so restore_build() brings back the stamp of the build it restores; a stamp kept beside the
# folder would go on naming a version that is no longer running, which is worse than none.
COMMIT=$(git rev-parse --short HEAD 2>/dev/null || echo unknown)
printf '{"commit":"%s","built_at":"%s"}\n' "$COMMIT" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > dist/build-info.json
echo "==> build stamped $COMMIT"

# TD-192, 2026-09-16 - the gate passed and crm-api could not start: no test ever assembled the whole
# application. boot-check does, from the build just made, before anything is restarted.
echo "==> boot check (does the whole application assemble?)"
node scripts/boot-check.cjs || { restore_build; exit 1; }

echo "==> gate (about 90 seconds)"
node scripts/test-gate.cjs || { restore_build; exit 1; }

echo "==> restarting crm-api"
pm2 restart crm-api
# TD-192, 2026-09-16 - the old check compared the answer with exactly "000", but `curl -w ... || echo "000"`
# prints "000000" when nothing answers, so a crash-looping API was reported as deployed and the site
# stayed down. It also asked a route that needs a login. Now: wait up to a minute for the public
# liveness probe to say 200, and if it never does, put the previous build back and restart onto it.
# (Applied 2026-09-17: the first attempt matched nothing because of a blank line, and said nothing.)
CODE=000
for _ in $(seq 1 20); do
  sleep 3
  CODE=$(curl -s -o /dev/null -m 5 -w "%{http_code}" http://localhost:8000/api/health 2>/dev/null || true)
  [ "$CODE" = "200" ] && break
done
echo "==> API answered HTTP $CODE"
if [ "$CODE" != "200" ]; then
  echo "!! THE API DID NOT COME BACK on the new build."
  restore_build
  pm2 restart crm-api
  echo "   restarted onto the previous build. crm-worker was not restarted and still runs it too."
  echo "   Why it failed:  pm2 logs crm-api --lines 80 --nostream"
  exit 1
fi
# TD-187, 2026-09-15 - crm-worker runs the SAME dist/main.js and was never restarted here, so every
# fix to the reminder sweep, lead follow-ups, invoice chasers, calendar retry, IMAP sync or
# retention shipped into dist/ and waited while the old code ran on in memory. It cost six emails:
# a19c0a7 stopped leases being chased for lawyer details on 2026-09-13, and the sweep sent them
# anyway at 2026-09-14 04:05 because the worker still held the pre-fix build.
#
# UNCONDITIONAL ON PURPOSE. transaction_reminders carries
# @@unique([transaction_id, kind, scheduled_for, delivery_method]) - a second run on the same day
# cannot send a second copy - and main.ts handles SIGTERM/SIGINT with onModuleDestroy across every
# scheduler. So there is no window to avoid, and a rule with a window is one somebody deploys outside.
echo "==> restarting crm-worker"
pm2 restart crm-worker
sleep 5
WSTATE=$(pm2 jlist | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const w=JSON.parse(s).find(x=>x.name==='crm-worker');console.log(w&&w.pm2_env?w.pm2_env.status:'missing')})")
echo "==> crm-worker is $WSTATE"
if [ "$WSTATE" != "online" ]; then
  echo "!! THE WORKER DID NOT COME BACK. The API is live on the new code; background jobs are not."
  echo "   Reminders, mail sync and invoice chasing are stopped until it runs."
  echo "   Check:  pm2 logs crm-worker --lines 50     then:  pm2 restart crm-worker"
  exit 1
fi

echo "==> deployed."
