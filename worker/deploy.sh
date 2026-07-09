#!/usr/bin/env bash
# Revive Aesthetics booking — one-shot deploy.
# Prereq (once): npx wrangler login   (opens browser)
# Run: bash worker/deploy.sh   (from repo root or anywhere)
set -euo pipefail
cd "$(dirname "$0")"

echo "== 1/6 Checking Cloudflare auth =="
if ! npx wrangler whoami 2>&1 | grep -qi "associated with"; then
  echo "Not logged in. Run: npx wrangler login   — then re-run this script."
  exit 1
fi

echo "== 2/6 Ensuring D1 database 'revive-booking' =="
DB_ID=$(npx wrangler d1 list --json 2>/dev/null | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const a=JSON.parse(d);const m=a.find(x=>x.name==='revive-booking');process.stdout.write(m?(m.uuid||m.database_id||''):'')}catch(e){}})")
if [ -z "$DB_ID" ]; then
  npx wrangler d1 create revive-booking >/dev/null
  DB_ID=$(npx wrangler d1 list --json | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const a=JSON.parse(d);const m=a.find(x=>x.name==='revive-booking');process.stdout.write(m?(m.uuid||m.database_id||''):'')})")
fi
echo "   database_id: $DB_ID"
node -e "const fs=require('fs');let t=fs.readFileSync('wrangler.toml','utf8');t=t.replace(/database_id = \".*\"/, 'database_id = \"$DB_ID\"');fs.writeFileSync('wrangler.toml',t);"

echo "== 3/6 Applying schema + seed treatments =="
npx wrangler d1 execute revive-booking --remote --file=schema.sql -y

echo "== 4/6 Deploying worker =="
DEPLOY_OUT=$(npx wrangler deploy 2>&1) || { echo "$DEPLOY_OUT"; exit 1; }
echo "$DEPLOY_OUT"
API_URL=$(echo "$DEPLOY_OUT" | grep -oE 'https://[a-zA-Z0-9.-]+\.workers\.dev' | head -1)
echo "   API URL: $API_URL"

echo "== 5/6 Setting secrets =="
printf '%s' "$(cat ~/.openclaw/telegram.token)" | npx wrangler secret put TELEGRAM_BOT_TOKEN
if [ ! -f ~/.openclaw/revive-admin-token.txt ]; then
  node -e "console.log(require('crypto').randomBytes(24).toString('hex'))" > ~/.openclaw/revive-admin-token.txt
  echo "   generated admin token -> ~/.openclaw/revive-admin-token.txt"
fi
printf '%s' "$(cat ~/.openclaw/revive-admin-token.txt | tr -d '\r\n')" | npx wrangler secret put ADMIN_TOKEN

echo "== 6/6 Wiring API URL into book.html + publishing site =="
if [ -n "$API_URL" ]; then
  node -e "const fs=require('fs');const f='../book.html';let t=fs.readFileSync(f,'utf8');t=t.replace(/window\.REVIVE_API_BASE = \"[^\"]*\"/, 'window.REVIVE_API_BASE = \"$API_URL\"');fs.writeFileSync(f,t);"
  cd ..
  if ! git diff --quiet book.html; then
    git add book.html && git commit -m "Wire booking page to live API ($API_URL)" && git push
    echo "   Site pushed — live in ~1 min."
  else
    echo "   book.html already wired."
  fi
fi

echo ""
echo "DONE. Online booking is live:"
echo "  https://ampedupelectricaladl.github.io/revive-aesthetics/book.html"
echo "  API: $API_URL"
