# Revive Aesthetics — Website + Booking

Boutique Adelaide skin studio. Static site (GitHub Pages) + custom online booking
(Cloudflare Worker + D1, free tier).

- **Business:** Revive Aesthetics (Adelaide, SA) — Stefani
- **Services:** Chemical peels · Microneedling · Skin consultations
- **Hours:** Mon & Tue, 9am–5pm
- **Phone:** 0404 967 051 · **Email:** smatulin@yahoo.com · **IG:** @reviveaesthetics.adl
- **Palette:** aubergine `#2B0F1A` + cream `#F2E7CE` + gold `#c2a878` · Cormorant Garamond + Jost

## Structure
- `index.html` — landing page (GitHub Pages, push to `main` → live in ~1 min)
- `book.html` — online booking page (3-step: treatment → time → details; also handles
  cancel links `?cancel=<id>&token=<t>`). Shows a graceful "launching shortly" fallback
  until `window.REVIVE_API_BASE` is set by the deploy script.
- `worker/` — booking API (Cloudflare Worker + D1)
  - `src/index.js` — availability engine (Mon/Tue 9–5, 30-min grid, 15-min buffer,
    12h min notice, 60-day horizon), book/cancel, Telegram alerts, admin endpoints
  - `schema.sql` — tables + seed treatments (**prices are placeholders — confirm with Stefani**)
  - `deploy.sh` — one-shot deploy: D1 create → schema → deploy → secrets → wires the
    API URL into `book.html` → pushes the site

## Deploying the booking API
```bash
npx wrangler login          # once, interactive (opens browser)
bash worker/deploy.sh       # everything else
```
Secrets set by the script: `TELEGRAM_BOT_TOKEN` (from `~/.openclaw/telegram.token`),
`ADMIN_TOKEN` (generated → `~/.openclaw/revive-admin-token.txt`).
Booking/cancellation alerts go to the Telegram chat IDs in `worker/wrangler.toml`
(`TELEGRAM_CHAT_IDS` — add Stefani's once she messages @Ampelectricalbot).

Change a price without redeploying:
```bash
cd worker && npx wrangler d1 execute revive-booking --remote \
  --command "UPDATE treatments SET price_aud=149 WHERE id='peel'"
```

## Still to do
1. **Domain:** register `reviveaesthetics.com.au` (needs Stefani's ABN) → add `CNAME`
   file + DNS, update canonicals + `ALLOWED_ORIGINS` in `worker/wrangler.toml`.
2. **Phase 2:** confirmation/reminder/4-week-rebooking emails via Stefani's Gmail
   (OAuth) — scheduler in `~/amped-automations/scripts/`; simple admin page for
   Stefani (uses `/api/admin/*`).
3. **GBP:** create Google Business Profile under her business Gmail.
4. **Photos:** `assets/about.jpg` + treatment images; swap "coming soon" placeholders.
