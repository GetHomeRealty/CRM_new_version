#!/usr/bin/env bash
#
# TD-195 - release the screens WITHOUT breaking tabs that are already open.
#
# A build deletes dist/ and writes new files with new names. A tab opened before the release still
# asks for the old names, and on 2026-09-17 every page it opened failed with "Failed to fetch
# dynamically imported module". So the page files of recent builds are copied back beside the new
# ones: an open tab keeps working on its own version until the app moves it to the new one.
#
# Use this instead of a bare `npm run build`.
set -euo pipefail
cd "$(dirname "$0")/.."

STAMP=$(date +%Y%m%d-%H%M%S)
if [ -d dist ]; then
  echo "==> backing up dist to dist.bak.$STAMP"
  cp -a dist "dist.bak.$STAMP"
fi

echo "==> building the screens (type-check + vite)"
npm run build

# Page files from builds of the last 14 days. -n never overwrites a file the new build made.
KEPT=0
for d in $(find . -maxdepth 1 -type d -name 'dist.bak.*' -mtime -14 | sort); do
  if [ -d "$d/assets" ]; then
    before=$(ls dist/assets | wc -l)
    cp -n "$d"/assets/* dist/assets/ 2>/dev/null || true
    after=$(ls dist/assets | wc -l)
    KEPT=$((KEPT + after - before))
  fi
done
echo "==> kept $KEPT page files from recent builds, so open tabs keep working"

if ! grep -q '/assets/index-' dist/index.html; then
  echo "!! dist/index.html does not reference a main bundle - restoring the previous build"
  rm -rf dist && cp -a "dist.bak.$STAMP" dist
  exit 1
fi
echo "==> screens released: $(grep -o '/assets/index-[A-Za-z0-9_-]*\.js' dist/index.html | head -1)"
