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

echo "==> building"
npm run build

echo "==> gate (about 90 seconds)"
node scripts/test-gate.cjs

echo "==> restarting crm-api"
pm2 restart crm-api
sleep 6

CODE=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:8000/api/dashboard/commissions || echo "000")
echo "==> API answered HTTP $CODE"
if [ "$CODE" = "000" ]; then
  echo "!! THE API DID NOT COME BACK. Restore with:  rm -rf dist && mv dist.bak.$STAMP dist && pm2 restart crm-api"
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
