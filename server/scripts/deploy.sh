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
echo "==> deployed."
