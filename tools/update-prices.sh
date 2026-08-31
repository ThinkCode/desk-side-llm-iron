#!/usr/bin/env bash
# Refresh prices from PA-API and push to GitHub if anything actually changed.
# Designed for launchd/cron: quiet when nothing moved, loud on failure.
set -euo pipefail

cd "$(dirname "$0")/.."
NODE="${NODE_BIN:-$(command -v node)}"
LOG() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

[ -f .env ] || { LOG "FATAL: no .env — see tools/README.md"; exit 1; }

LOG "fetching PA-API prices"
if ! "$NODE" tools/paapi-fetch.mjs; then
  LOG "fetch failed — keeping the previous data/prices.json"
  exit 1
fi

# Only the timestamp changing is not a change worth a commit.
if git diff --quiet -- data/prices.json 2>/dev/null; then
  LOG "no price movement; nothing to commit"
  exit 0
fi
CHANGED=$("$NODE" -e '
  const {execSync}=require("child_process");
  const now=JSON.parse(require("fs").readFileSync("data/prices.json","utf8"));
  let old={items:{}};
  try{ old=JSON.parse(execSync("git show HEAD:data/prices.json",{encoding:"utf8"})); }catch(e){}
  const moved=Object.entries(now.items).filter(([a,v])=>
    !old.items[a] || old.items[a].price !== v.price);
  console.log(moved.length ? moved.map(([a,v])=>
    `${a} ${old.items[a]?"$"+old.items[a].price+"->":""}$${v.price}`).join(", ") : "");
')

if [ -z "$CHANGED" ]; then
  LOG "only the timestamp moved; restoring file"
  git checkout -- data/prices.json
  exit 0
fi

LOG "changed: $CHANGED"
git add data/prices.json
git commit -q -m "prices: $(date '+%Y-%m-%d %H:%M') — ${CHANGED:0:180}"
git push -q origin HEAD
LOG "pushed"
