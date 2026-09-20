/**
 * Revive Aesthetics - tests for "a pinned date opens even on a non-open day".
 *
 * Run: node scripts/test-open-days.js
 *
 * Decided 20 Sept 2026: Stefani wants to trial ONE Saturday morning. The studio's
 * OPEN_DAYS are [1,2] (Mon, Tue), so the only way to open a Saturday is to pin the
 * exact slots with POST /api/admin/set-allowed-slots. This test proves:
 *   (a) a Saturday with no overrides stays closed
 *   (b) a Saturday WITH overrides returns exactly those slots
 *   (c) blocked_dates still wins over an override
 *   (d) a normal Monday is unaffected
 *   (e) the /api/availability loop does not cheap-skip a pinned non-open day
 *
 * The worker is a Cloudflare ES module (export default { fetch }). It is imported
 * with await import(pathToFileURL(...)) and driven with a FAKE D1 - no network,
 * no wrangler, no live worker is ever touched.
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..');
const WORKER_PATH = path.join(ROOT, 'worker', 'src', 'index.js');

let pass = 0;
let fail = 0;
function ok(cond, label) {
  if (cond) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label); }
  return !!cond;
}

// ---------------------------------------------------------------------------
// date helpers - same UTC-anchored arithmetic the worker uses
// ---------------------------------------------------------------------------
function todayAdelaide() {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Australia/Adelaide', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const g = (t) => p.find((x) => x.type === t).value;
  return g('year') + '-' + g('month') + '-' + g('day');
}
function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
function dow(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}
// Well inside the 60-day horizon, well past the 12h minimum notice.
function nextWeekday(target, minAhead) {
  let d = addDays(todayAdelaide(), minAhead);
  for (let i = 0; i < 8; i++) { if (dow(d) === target) return d; d = addDays(d, 1); }
  throw new Error('no such weekday');
}

const SATURDAY = nextWeekday(6, 14);
const MONDAY = nextWeekday(1, 14);

// ---------------------------------------------------------------------------
// fake D1 - answers from an in-memory map keyed on SQL fragments
// ---------------------------------------------------------------------------
const TREATMENTS = {
  'lash-lift': {
    id: 'lash-lift', name: 'Korean Lash Lift & Tint', duration_min: 75,
    price_aud: 95, description: 'Korean lash lift and tint.', active: 1, sort: 1,
  },
};

function fakeDb(opts) {
  const overrides = opts.overrides || {};   // { 'YYYY-MM-DD': [start_min, ...] }
  const blocked = opts.blocked || [];       // [ 'YYYY-MM-DD' ]
  const bookings = opts.bookings || {};     // { 'YYYY-MM-DD': [ {start_min,end_min} ] }
  const seen = [];

  return {
    seen,
    prepare(sql) {
      return {
        bind() {
          const args = Array.prototype.slice.call(arguments);
          const run = () => {
            seen.push(sql);
            if (sql.indexOf('FROM treatments') !== -1) {
              return { row: TREATMENTS[args[0]] || null, rows: Object.keys(TREATMENTS).map((k) => TREATMENTS[k]) };
            }
            if (sql.indexOf('FROM addons') !== -1) return { row: null, rows: [] };
            if (sql.indexOf('FROM blocked_dates') !== -1) {
              return { row: blocked.indexOf(args[0]) !== -1 ? { hit: 1 } : null, rows: [] };
            }
            if (sql.indexOf('DISTINCT date FROM slot_overrides') !== -1) {
              const lo = args[0], hi = args[1];
              const rows = Object.keys(overrides)
                .filter((d) => d >= lo && d <= hi && overrides[d].length)
                .map((d) => ({ date: d }));
              return { row: rows[0] || null, rows };
            }
            if (sql.indexOf('FROM slot_overrides') !== -1) {
              const rows = (overrides[args[0]] || []).map((m) => ({ start_min: m }));
              return { row: rows[0] || null, rows };
            }
            if (sql.indexOf('FROM bookings') !== -1) {
              return { row: null, rows: bookings[args[0]] || [] };
            }
            return { row: null, rows: [] };
          };
          return {
            async all() { return { results: run().rows }; },
            async first() { return run().row; },
            async run() { run(); return { success: true }; },
          };
        },
      };
    },
  };
}

async function availability(mod, dbOpts, from, days) {
  const db = fakeDb(dbOpts);
  const env = { DB: db, ALLOWED_ORIGINS: 'https://reviveaesthetics.com.au' };
  const ctx = { waitUntil() {} };
  const url = 'https://x/api/availability?treatment=lash-lift&from=' + from + '&days=' + days;
  const res = await mod.default.fetch(new Request(url), env, ctx);
  const body = await res.json();
  return { status: res.status, body, db };
}

// ---------------------------------------------------------------------------
async function runSuite(mod, label) {
  console.log('');
  console.log(label);

  const overridesOnSat = {};
  overridesOnSat[SATURDAY] = [480, 585, 690];

  // (a) Saturday, no overrides -> closed
  let r = await availability(mod, {}, SATURDAY, 1);
  ok(r.status === 200, 'a. availability responds 200 (' + SATURDAY + ')');
  ok(Object.keys(r.body.dates).length === 0,
    'a. Saturday with NO overrides returns no dates (got ' + JSON.stringify(Object.keys(r.body.dates)) + ')');

  // (b) Saturday with overrides -> exactly those three slots
  r = await availability(mod, { overrides: overridesOnSat }, SATURDAY, 1);
  const mins = (r.body.dates[SATURDAY] || []).map((s) => s.min);
  ok(mins.join(',') === '480,585,690',
    'b. Saturday WITH overrides [480,585,690] returns exactly those slots (got [' + mins.join(',') + '])');

  // (c) overrides + blocked_dates -> blocked wins
  r = await availability(mod, { overrides: overridesOnSat, blocked: [SATURDAY] }, SATURDAY, 1);
  ok(Object.keys(r.body.dates).length === 0,
    'c. a blocked Saturday stays closed even with overrides pinned');

  // (d) a normal Monday still works with no overrides
  r = await availability(mod, {}, MONDAY, 1);
  const monday = (r.body.dates[MONDAY] || []).map((s) => s.min);
  ok(monday.length > 0, 'd. Monday with no overrides still returns slots (got ' + monday.length + ')');
  ok(monday[0] === 600 && monday[monday.length - 1] === 1110,
    'd. Monday slots run the normal 10:00-8:00 grid, 10:00am..6:30pm (got ' +
    monday[0] + '..' + monday[monday.length - 1] + ')');

  // (e) the availability LOOP must not skip a pinned non-open day found mid-range
  const satOnly = {};
  satOnly[SATURDAY] = [480];
  const start = addDays(SATURDAY, -3);
  r = await availability(mod, { overrides: satOnly }, start, 6);
  ok(Array.isArray(r.body.dates[SATURDAY]) && r.body.dates[SATURDAY].length === 1,
    'e. a pinned Saturday inside a multi-day range is not cheap-skipped');
  const distinct = r.db.seen.filter((s) => s.indexOf('DISTINCT date FROM slot_overrides') !== -1);
  ok(distinct.length === 1,
    'e. the pinned-date lookup is ONE query for the whole range (got ' + distinct.length + ')');
}

// ---------------------------------------------------------------------------
// Mutation proof: put the original early-return back and confirm (b) and (e) fail.
// ---------------------------------------------------------------------------
function mutantSource() {
  const src = fs.readFileSync(WORKER_PATH, 'utf8');
  let out = src.replace(
    'async function slotsForDate(db, dateStr, durationMin, nowAbs) {',
    'async function slotsForDate(db, dateStr, durationMin, nowAbs) {\n  if (!OPEN_DAYS.includes(dayOfWeek(dateStr))) return []; // MUTATION'
  );
  out = out.replace(
    'if (!OPEN_DAYS.includes(dayOfWeek(d)) && !pinnedDates.has(d)) continue;',
    'if (!OPEN_DAYS.includes(dayOfWeek(d))) continue; // MUTATION'
  );
  if (out === src) throw new Error('mutation did not apply - worker source changed shape');
  return out;
}

(async () => {
  console.log('Open-days / pinned-Saturday tests');
  console.log('  Saturday under test: ' + SATURDAY + '   Monday under test: ' + MONDAY);

  const mod = await import(pathToFileURL(WORKER_PATH).href);
  ok(!!mod.default && typeof mod.default.fetch === 'function',
    'worker is an ES module exporting default { fetch }');
  if (!mod.default || typeof mod.default.fetch !== 'function') process.exit(1);

  await runSuite(mod, 'CURRENT worker source:');
  const realFail = fail;
  const realPass = pass;

  // --- discrimination check -------------------------------------------------
  const tmp = path.join(os.tmpdir(), 'revive-open-days-mutant-' + process.pid + '.mjs');
  fs.writeFileSync(tmp, mutantSource());
  const mutant = await import(pathToFileURL(tmp).href);
  await runSuite(mutant, 'MUTANT worker (original early-return restored) - (b) and (e) MUST fail:');
  const mutantFails = fail - realFail;
  fs.unlinkSync(tmp);

  console.log('');
  const discriminates = mutantFails >= 2;
  console.log((discriminates ? '  PASS  ' : '  FAIL  ') +
    'discrimination check: the mutant failed ' + mutantFails + ' assertions (expected >= 2)');

  const good = realFail === 0 && discriminates;
  console.log('');
  console.log((good ? 'ALL PASS' : 'FAILURES') + '  (' + realPass + ' passed, ' +
    realFail + ' failed against the real source)');
  process.exit(good ? 0 : 1);
})();
