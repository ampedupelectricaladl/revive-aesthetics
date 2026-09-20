#!/usr/bin/env bash
# Revive Aesthetics — apply Stefani's 20 Sept 2026 decisions and publish.
#
# Prereq (once): npx wrangler login   (opens browser)
# Run: bash worker/apply-decisions-2026-09-20.sh
#
# Secrets are NOT re-uploaded here. worker/deploy.sh puts TELEGRAM_BOT_TOKEN and
# ADMIN_TOKEN on the worker; a plain `wrangler deploy` keeps them in place.
#
# The site commit is expected to exist locally already — step 5 only pushes it.
set -euo pipefail
cd "$(dirname "$0")"

echo "== 1/5 Checking Cloudflare auth =="
if ! npx wrangler whoami 2>&1 | grep -qi "associated with"; then
  echo "Not logged in. Run: npx wrangler login   — then re-run this script."
  exit 1
fi

echo "== 2/5 Applying decisions-2026-09-20.sql to D1 (remote) =="
npx wrangler d1 execute revive-booking --remote --file decisions-2026-09-20.sql

echo "== 3/5 Deploying worker =="
npx wrangler deploy

echo "== 4/5 Verifying the live menu =="
API="https://revive-booking.ampedup.workers.dev/api/treatments"
BODY=$(curl -fsS "$API")
FAILED=0
for NEEDLE in "brow-lamination" "Keratin Lash Infusion"; do
  if printf '%s' "$BODY" | grep -qF "$NEEDLE"; then
    echo "   OK      found: $NEEDLE"
  else
    echo "   MISSING: $NEEDLE"
    FAILED=1
  fi
done
if printf '%s' "$BODY" | grep -qiF "Botox"; then
  echo "   BAD:     the word Botox is still on the live menu"
  FAILED=1
else
  echo "   OK      no mention of Botox"
fi
if [ "$FAILED" -ne 0 ]; then
  echo ""
  echo "VERIFICATION FAILED — the live menu is not what was decided. Site NOT pushed."
  echo "Response was:"
  printf '%s\n' "$BODY"
  exit 1
fi

echo "== 5/5 Pushing the site =="
cd ..
git push origin main

echo ""
echo "DONE. Menu updated, worker deployed, site pushed (live in ~1 min)."
