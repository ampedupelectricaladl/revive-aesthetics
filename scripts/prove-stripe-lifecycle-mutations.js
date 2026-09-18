/**
 * Mutation proof for scripts/test-stripe-lifecycle.js (and test-checkout-followup.js).
 *
 * Run: node scripts/prove-stripe-lifecycle-mutations.js
 *
 * Copies worker/src/index.js to a sandbox, reintroduces one regression at a time, asserts the
 * mutation actually LANDED on disk, and runs the suite against the sandbox via REVIVE_WORKER_FILE.
 * An unmutated control runs first and must pass - otherwise a "caught" result proves nothing.
 * Never touches the real worker file.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'worker', 'src', 'index.js'), 'utf8');
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'revive-mutations-'));
const SUITES = (process.env.SUITES || 'test-stripe-lifecycle.js').split(',');

const MUTATIONS = [
  { name: 'skip the signature check', find: 'if (!check.ok) {', replace: 'if (false) {' },
  { name: 'drop the event-id dedupe',
    edits: [
      { find: 'if (changesOf(inserted) === 0) return reply(200, { received: true, duplicate: true });', replace: '' },
      { find: 'INSERT OR IGNORE INTO stripe_events', replace: 'INSERT OR REPLACE INTO stripe_events' },
    ] },
  { name: 'abandon at 29 minutes', find: 'const HOLD_MIN = 30;', replace: 'const HOLD_MIN = 29;' },
  { name: 'remove the followed_up guard on the follow-up claim',
    find: "WHERE id = ? AND followed_up_at IS NULL AND status IN ('pending', 'abandoned') AND COALESCE(deposit_paid, 0) = 0",
    replace: 'WHERE id = ?' },
  { name: 'backfill leaves NULL', find: "return passed ? 'completed' : 'booked_no_deposit';", replace: "return passed ? 'completed' : null;" },
  { name: 'swallow unmatched events',
    find: 'async function reportUnmatchedStripeEvent(env, event, piId, amount) {',
    replace: "async function reportUnmatchedStripeEvent(env, event, piId, amount) { return 'ignored';" },
  { name: 'accept stale timestamps', find: 'if (nowSec - ts > tolerance)', replace: 'if (false)' },
  { name: 'remove the pending guard on confirmation',
    find: "WHERE id = ? AND status IN ('pending', 'abandoned') AND stripe_payment_intent_id = ?",
    replace: 'WHERE id = ? AND stripe_payment_intent_id = ?' },
  { name: 'skip the refund when a late payment finds the slot taken',
    find: 'const refund = await refundPaymentIntent(env, pi.id);', replace: "const refund = { ok: true, id: '' };" },
  { name: 'stop checking the paid amount against the row',
    find: 'Number(pi.amount) !== Number(row.deposit_cents)', replace: 'false' },
  { name: 'holds do not block other people',
    find: "OR (status = 'pending' AND lifecycle IN ('started', 'deposit_pending', 'deposit_failed') AND hold_until > ?))",
    replace: "OR (status = 'never' AND hold_until > ?))" },
  { name: 'follow-up email hours read in UTC',
    find: 'const inEmailHours = isInFollowupEmailHours(nowInAdelaide(nowMs).min);',
    replace: 'const inEmailHours = isInFollowupEmailHours(new Date(nowMs).getUTCHours() * 60 + new Date(nowMs).getUTCMinutes());' },
  { name: 'completed marking uses a fixed +9:30 offset',
    find: '  const now = nowInAdelaide(nowMs);\n  const res = await env.DB.prepare(',
    replace: '  const fixed = new Date(nowMs + 570 * 60000); const now = { date: fixed.toISOString().slice(0, 10), min: fixed.getUTCHours() * 60 + fixed.getUTCMinutes() };\n  const res = await env.DB.prepare(' },
  { name: 'remove the Telegram firewall', find: 'if (!String(env.TELEGRAM_BOT_TOKEN).startsWith(REVIVE_BOT_TOKEN_PREFIX)) {', replace: 'if (false) {' },
  { name: 'hourly gate compares minutes-since-midnight to 0', find: 'if (nowInAdelaide(nowMs).min % 60 === 0) {', replace: 'if (nowInAdelaide(nowMs).min === 0) {' },
];

function count(hay, needle) {
  let n = 0;
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + 1)) n++;
  return n;
}

function runSuites(file) {
  const results = [];
  for (const suite of SUITES) {
    const r = spawnSync(process.execPath, [path.join(__dirname, suite)], {
      env: Object.assign({}, process.env, { REVIVE_WORKER_FILE: file }), encoding: 'utf8', timeout: 600000,
    });
    const out = (r.stdout || '') + (r.stderr || '');
    const summary = (out.match(/(\d+) passed, (\d+) failed/) || [])[0] || 'no summary';
    const firstFail = (out.match(/ {2}FAIL {2}(.*)/) || [])[1] || '';
    results.push({ suite, code: r.status, summary, firstFail });
  }
  return results;
}

const controlFile = path.join(SANDBOX, 'control.js');
fs.writeFileSync(controlFile, SRC);
const control = runSuites(controlFile);
console.log('control (unmutated sandbox copy): ' + control.map(c => `${c.suite} exit ${c.code} ${c.summary}`).join(' | '));
if (control.some(c => c.code !== 0)) {
  console.log('CONTROL FAILED - the harness is broken, no mutation result can be trusted');
  process.exit(2);
}

const rows = [];
for (const m of MUTATIONS) {
  const edits = m.edits || [{ find: m.find, replace: m.replace }];
  let mutated = SRC;
  let landed = true;
  for (const e of edits) {
    if (count(mutated, e.find) !== 1) { landed = false; break; }
    mutated = mutated.replace(e.find, () => e.replace);
  }
  const file = path.join(SANDBOX, 'mutant-' + rows.length + '.js');
  if (landed) {
    fs.writeFileSync(file, mutated);
    const onDisk = fs.readFileSync(file, 'utf8');
    landed = onDisk !== SRC && edits.every(e => !e.replace || onDisk.includes(e.replace));
  }
  if (!landed) {
    rows.push({ name: m.name, verdict: 'NOT LANDED', detail: 'anchor missing or not unique' });
    continue;
  }
  const res = runSuites(file);
  const caught = res.some(r => r.code !== 0);
  rows.push({ name: m.name, verdict: caught ? 'CAUGHT' : 'MISSED',
    detail: res.map(r => `${r.summary}${r.firstFail ? ' - first: ' + r.firstFail.slice(0, 110) : ''}`).join(' | ') });
}

console.log('');
for (const r of rows) console.log(`${r.verdict.padEnd(10)} ${r.name}\n           ${r.detail}`);
const missed = rows.filter(r => r.verdict !== 'CAUGHT');
console.log(`\n${rows.length - missed.length}/${rows.length} mutations caught`);
try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch (_) { /* ignore */ }
process.exit(missed.length ? 1 : 0);
