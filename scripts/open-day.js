#!/usr/bin/env node
/**
 * Revive Aesthetics — open (or close) a single date for booking.
 *
 * Decided 20 Sept 2026: the studio's open days are Mon + Tue. To trial a Saturday,
 * pin the exact start times you are willing to work. The worker treats a date that
 * has rows in `slot_overrides` as open even when its weekday is not an open day —
 * and shows ONLY those times.
 *
 *   node scripts/open-day.js 2026-10-10 8:00 9:45 11:30
 *   node scripts/open-day.js 2026-10-10 --clear      (back to normal availability)
 *
 * A blocked date stays closed no matter what this script pins.
 *
 * Auth: the admin bearer token at C:\Users\derba\.openclaw\revive-admin-token.txt
 * (the same value deploy.sh uploads as the worker's ADMIN_TOKEN secret).
 */
'use strict';

const fs = require('fs');
const path = require('path');

const TOKEN_FILE = 'C:\\Users\\derba\\.openclaw\\revive-admin-token.txt';
const ROOT = path.join(__dirname, '..');

function apiBase() {
  if (process.env.REVIVE_API_BASE) return process.env.REVIVE_API_BASE.replace(/\/+$/, '');
  // Single source of truth: whatever the live booking page is wired to.
  const book = fs.readFileSync(path.join(ROOT, 'book.html'), 'utf8');
  const m = book.match(/window\.REVIVE_API_BASE = "([^"]+)"/);
  if (!m) die('could not read REVIVE_API_BASE from book.html');
  return m[1].replace(/\/+$/, '');
}

function die(msg) {
  console.error('open-day: ' + msg);
  process.exit(1);
}

function usage() {
  console.log('Usage:');
  console.log('  node scripts/open-day.js <YYYY-MM-DD> <H:MM> [H:MM ...]   pin these start times');
  console.log('  node scripts/open-day.js <YYYY-MM-DD> --clear             restore normal availability');
  process.exit(1);
}

function todayAdelaide() {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Australia/Adelaide', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const g = (t) => p.find((x) => x.type === t).value;
  return g('year') + '-' + g('month') + '-' + g('day');
}

// "8:00" / "08:00" / "13:30" -> minutes from midnight. The worker stores start_min.
function toMinutes(t) {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(t).trim());
  if (!m) die('not a 24-hour time: "' + t + '" (use 8:00, 09:45, 13:30)');
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

function label(min) {
  const h24 = Math.floor(min / 60);
  const mm = String(min % 60).padStart(2, '0');
  const h = ((h24 + 11) % 12) + 1;
  return h + ':' + mm + (h24 < 12 ? 'am' : 'pm');
}

(async () => {
  const args = process.argv.slice(2).filter(Boolean);
  if (!args.length || args[0] === '--help' || args[0] === '-h') usage();

  const date = args[0];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) die('first argument must be a date as YYYY-MM-DD');

  const today = todayAdelaide();
  if (date < today) die('refusing to touch ' + date + ' — that date is in the past (today in Adelaide is ' + today + ')');

  const rest = args.slice(1);
  const clear = rest.some((a) => a === '--clear');
  const times = rest.filter((a) => a !== '--clear');
  if (!clear && times.length === 0) usage();
  if (clear && times.length) die('--clear takes no times');

  if (!fs.existsSync(TOKEN_FILE)) die('no admin token at ' + TOKEN_FILE);
  const token = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  if (!token) die('the admin token file is empty: ' + TOKEN_FILE);

  const base = apiBase();
  const endpoint = clear ? '/api/admin/clear-allowed-slots' : '/api/admin/set-allowed-slots';
  const slots = times.map(toMinutes).sort((a, b) => a - b);
  const body = clear ? { date } : { date, slots };

  console.log((clear ? 'Clearing' : 'Opening') + ' ' + date + (clear ? '' : ' — ' + slots.map(label).join(', ')));
  console.log('POST ' + base + endpoint);

  const res = await fetch(base + endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  console.log('HTTP ' + res.status);
  console.log(text);
  if (!res.ok) process.exit(1);
  console.log(clear
    ? 'Done — ' + date + ' is back on normal availability.'
    : 'Done — ' + date + ' now shows exactly ' + slots.length + ' slot(s) on book.html.');
})().catch((e) => die(String((e && e.message) || e)));
