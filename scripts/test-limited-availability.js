/**
 * Revive Aesthetics - tests for "the public only sees the next few openings".
 *
 * Run: node scripts/test-limited-availability.js
 *
 * Decided 18 Nov 2026 (Marcus): the booking page listed every free time on every
 * open day for two months, so anyone could read the whole diary and see how quiet
 * it was. The public endpoint now returns a SHORT list and nothing else:
 *   - 48 hours notice, 13 weeks (91 days) ahead
 *   - at most 3 days and 6 times - for the next openings AND for any one week a
 *     client pages to with the week slider, so three months never lays out the diary
 *   - a day with bookings offers the times next to them (it fills back-to-back)
 *   - a day with none offers one daytime and one after-work time, fixed per date
 *   - Stefani's admin view still returns everything
 *   - /api/book refuses a time the rules would not have offered
 *   - nothing on the page claims demand ("booked", "only X left", ...)
 *
 * The worker is imported as an ES module and driven with a FAKE D1 and a FROZEN
 * clock - no network, no wrangler, no live worker, no real booking is ever made.
 * Every rule is then removed in a mutant copy of the worker to prove the test
 * that guards it really fails.
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
let quiet = false;
function ok(cond, label) {
  if (cond) { pass++; if (!quiet) console.log('  PASS  ' + label); }
  else { fail++; if (!quiet) console.log('  FAIL  ' + label); }
  return !!cond;
}

// ---------------------------------------------------------------------------
// frozen clock. The worker reads `new Date()`; Adelaide is UTC+10:30 in November.
// ---------------------------------------------------------------------------
const RealDate = Date;
function freezeAdelaide(dateStr, hhmm) {
  const fixed = new RealDate(dateStr + 'T' + hhmm + ':00+10:30').getTime();
  global.Date = class extends RealDate {
    constructor(...a) { if (a.length === 0) super(fixed); else super(...a); }
    static now() { return fixed; }
  };
}
function thaw() { global.Date = RealDate; }

// Wed 18 Nov 2026. Open days ahead: Mon 23, Tue 24, Mon 30 Nov, Tue 1 Dec, Mon 7 Dec.
const WED = '2026-11-18';
const SAT = '2026-11-21';
const SUN = '2026-11-22';
const MON1 = '2026-11-23';
const TUE1 = '2026-11-24';
const MON2 = '2026-11-30';
const TUE2 = '2026-12-01';
const MON3 = '2026-12-07';   // 19 days out - reachable with the week slider
const TUE3 = '2026-12-08';
const THU3 = '2026-12-10';   // a Thursday in that same week
const PINNED_SAT = '2026-12-12'; // a Saturday - only open because Stefani pinned it
const LAST_OPEN = '2027-02-16';  // Tue, 90 days out - the last open day inside the 91-day horizon
const PAST_MON = '2027-02-22';   // Mon, 96 days out - past the horizon

// ---------------------------------------------------------------------------
// fake D1
// ---------------------------------------------------------------------------
const TREATMENTS = {
  'lash-lift': { id: 'lash-lift', name: 'Korean Lash Lift & Tint', duration_min: 75, price_aud: 95, description: '', active: 1, sort: 1 },
  'lash-brow-combo': { id: 'lash-brow-combo', name: 'Korean Lash Lift + Brow Lamination', duration_min: 135, price_aud: 180, description: '', active: 1, sort: 2 },
  'consultation': { id: 'consultation', name: 'Consultation', duration_min: 15, price_aud: 0, description: '', active: 1, sort: 3 },
};

function fakeDb(opts) {
  opts = opts || {};
  const overrides = opts.overrides || {};
  const blocked = opts.blocked || [];
  const bookings = opts.bookings || {};
  const inserted = [];
  return {
    inserted,
    prepare(sql) {
      return {
        bind() {
          const args = Array.prototype.slice.call(arguments);
          const run = () => {
            if (sql.indexOf('INSERT INTO bookings') !== -1) { inserted.push(args); return { row: null, rows: [] }; }
            if (sql.indexOf('COUNT(*)') !== -1) return { row: { n: 0 }, rows: [] };
            if (sql.indexOf('FROM client_flags') !== -1) return { row: null, rows: [] };
            if (sql.indexOf('FROM treatments') !== -1) return { row: TREATMENTS[args[0]] || null, rows: [] };
            if (sql.indexOf('FROM addons') !== -1) return { row: null, rows: [] };
            if (sql.indexOf('FROM blocked_dates') !== -1) {
              return { row: blocked.indexOf(args[0]) !== -1 ? { hit: 1 } : null, rows: [] };
            }
            if (sql.indexOf('DISTINCT date FROM slot_overrides') !== -1) {
              const rows = Object.keys(overrides).filter((d) => d >= args[0] && d <= args[1]).map((d) => ({ date: d }));
              return { row: rows[0] || null, rows };
            }
            if (sql.indexOf('FROM slot_overrides') !== -1) {
              return { row: null, rows: (overrides[args[0]] || []).map((m) => ({ start_min: m })) };
            }
            if (sql.indexOf('FROM bookings') !== -1) return { row: null, rows: bookings[args[0]] || [] };
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

const ENV = () => ({ ALLOWED_ORIGINS: 'https://reviveaestheticsadl.com.au', ADMIN_TOKEN: 'test-admin' });
const CTX = { waitUntil() {} };

async function publicList(mod, dbOpts, query) {
  const env = ENV(); env.DB = fakeDb(dbOpts);
  const res = await mod.default.fetch(new Request('https://x/api/availability?' + (query || 'treatment=lash-lift')), env, CTX);
  return { status: res.status, body: await res.json() };
}
async function adminList(mod, dbOpts, query, token) {
  const env = ENV(); env.DB = fakeDb(dbOpts);
  const init = token === null ? undefined : { headers: { Authorization: 'Bearer ' + (token || 'test-admin') } };
  const res = await mod.default.fetch(new Request('https://x/api/admin/availability?' + query, init), env, CTX);
  return { status: res.status, body: await res.json() };
}
// Books the FREE consultation, so no Stripe call is ever attempted.
async function book(mod, dbOpts, date, startMin) {
  const env = ENV(); env.DB = fakeDb(dbOpts);
  const res = await mod.default.fetch(new Request('https://x/api/book', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ treatment: 'consultation', date, start_min: startMin, name: 'Test Client', phone: '0400 000 000', email: 'test@example.com' }),
  }), env, CTX);
  return { status: res.status, body: await res.json(), inserted: env.DB.inserted.length };
}

const mins = (body, d) => ((body.dates || {})[d] || []).map((s) => s.min);
const total = (body) => Object.keys(body.dates || {}).reduce((n, d) => n + body.dates[d].length, 0);

// ---------------------------------------------------------------------------
// the suite. Each group returns nothing; `groups` records which labels failed so
// the mutation proof can check the RIGHT group caught each removed rule.
// ---------------------------------------------------------------------------
async function runSuite(mod) {
  const failedGroups = {};
  const group = async (name, fn) => {
    const before = fail;
    await fn();
    if (fail > before) failedGroups[name] = fail - before;
  };

  await group('cap', async () => {
    freezeAdelaide(WED, '12:00');
    const r = await publicList(mod, {});
    const days = Object.keys(r.body.dates);
    ok(r.status === 200, 'cap. the public list answers 200');
    ok(days.length === 3, 'cap. an empty diary shows 3 days, not every open day (got ' + days.length + ': ' + days.join(' ') + ')');
    ok(total(r.body) <= 6, 'cap. no more than 6 times in total (got ' + total(r.body) + ')');
    ok(days.join(',') === [MON1, TUE1, MON2].join(','), 'cap. they are the NEXT three open days (got ' + days.join(',') + ')');
  });

  await group('quiet', async () => {
    freezeAdelaide(WED, '12:00');
    const r = await publicList(mod, {});
    const m = mins(r.body, MON1);
    ok(m.length === 2, 'quiet. a day with no bookings offers 2 times, not the whole grid (got ' + m.length + ')');
    ok(m[0] >= 600 && m[0] < 900 && m[1] >= 1020,
      'quiet. one daytime and one after-work time (got ' + m.join(',') + ')');
  });

  await group('horizon', async () => {
    freezeAdelaide(WED, '12:00');
    let r = await publicList(mod, {}, 'treatment=lash-lift&week=' + PAST_MON);
    ok(Object.keys(r.body.dates).length === 0,
      'horizon. a week past 13 weeks returns nothing (got ' + Object.keys(r.body.dates).join(' ') + ')');
    r = await publicList(mod, {}, 'treatment=lash-lift&week=' + LAST_OPEN);
    const last = Object.keys(r.body.dates);
    ok(last.length > 0 && last.every((d) => d <= LAST_OPEN),
      'horizon. the last week inside it still shows times (got ' + last.join(' ') + ')');
    const weeks = r.body.weeks || [];
    ok(weeks[0] === MON1 && weeks.length === 13 && weeks[weeks.length - 1] <= LAST_OPEN,
      'horizon. the slider offers 13 weeks from ' + MON1 + ', none past the horizon (got ' + weeks.length + ': ' + weeks[0] + '..' + weeks[weeks.length - 1] + ')');
  });

  await group('week', async () => {
    freezeAdelaide(WED, '12:00');
    let r = await publicList(mod, {}, 'treatment=lash-lift&week=' + MON3);
    const days = Object.keys(r.body.dates);
    ok(days.join(',') === [MON3, TUE3].join(','), 'week. picking a week shows that week only (got ' + days.join(',') + ')');
    ok(mins(r.body, MON3).length === 2 && mins(r.body, TUE3).length === 2,
      'week. and still only 2 times on a quiet day, never the whole day (got ' + mins(r.body, MON3).length + ' and ' + mins(r.body, TUE3).length + ')');
    const viaThursday = await publicList(mod, {}, 'treatment=lash-lift&week=' + THU3);
    ok(JSON.stringify(viaThursday.body.dates) === JSON.stringify(r.body.dates),
      'week. any date inside the week gives the same week (asked with a Thursday)');
    const a = JSON.stringify((await publicList(mod, {}, 'treatment=lash-lift&week=' + MON3)).body.dates);
    ok(a === JSON.stringify(r.body.dates), 'week. reloading a week returns the same times');
  });

  await group('notice', async () => {
    freezeAdelaide(SAT, '12:00');   // 48h later = Mon 23 Nov 12:00
    let r = await adminAndPublicMonday(mod);
    ok(r.publicMon.length > 0 && r.publicMon.every((t) => t >= 720),
      'notice. on Saturday midday, Monday is only offered from 12:00pm on (got ' + r.publicMon.join(',') + ')');
    freezeAdelaide(SUN, '15:00');   // 48h later = Tue 24 Nov 3:00pm
    r = await adminAndPublicMonday(mod);
    ok(r.publicMon.length === 0, 'notice. on Sunday afternoon, tomorrow (Monday) is not offered at all (got ' + r.publicMon.join(',') + ')');
    ok(r.publicTue.length > 0 && r.publicTue.every((t) => t >= 900),
      'notice. and Tuesday is only offered from 3:00pm on (got ' + r.publicTue.join(',') + ')');
  });

  await group('cluster', async () => {
    freezeAdelaide(WED, '12:00');
    // one booking Monday 1:00pm-2:15pm. A 75-min lash lift fits right before it at
    // 11:30am and right after it at 2:30pm (15-min turnover each side).
    const diary = { bookings: {} };
    diary.bookings[MON1] = [{ start_min: 780, end_min: 855 }];
    const r = await publicList(mod, diary);
    const m = mins(r.body, MON1);
    ok(m.indexOf(690) !== -1 && m.indexOf(870) !== -1,
      'cluster. the times either side of the booking are offered first (got ' + m.join(',') + ')');
    ok(m.length <= 3, 'cluster. a day with a booking offers at most 3 times (got ' + m.length + ')');
    ok(m.every((a, i) => m.every((b, j) => i === j || Math.abs(a - b) >= 90)),
      'cluster. no two offered times overlap each other (got ' + m.join(',') + ')');
    ok(m.indexOf(780) === -1, 'cluster. the booked time itself is never offered');
  });

  await group('stable', async () => {
    freezeAdelaide(WED, '12:00');
    const a = JSON.stringify((await publicList(mod, {})).body);
    const b = JSON.stringify((await publicList(mod, {})).body);
    const c = JSON.stringify((await publicList(mod, {})).body);
    ok(a === b && b === c, 'stable. three reloads return exactly the same times');
  });

  await group('admin', async () => {
    freezeAdelaide(WED, '12:00');
    let r = await adminList(mod, {}, 'treatment=lash-lift');
    const mon = mins(r.body, MON1);
    ok(r.status === 200 && mon.length === 18 && mon[0] === 600 && mon[17] === 1110,
      'admin. Stefani still sees the whole Monday, 10:00am..6:30pm (got ' + mon.length + ' times)');
    ok(mins(r.body, MON3).length === 18, 'admin. and every later day in full too (' + MON3 + ')');
    r = await adminList(mod, {}, 'treatment=lash-lift', null);
    ok(r.status === 401 && !r.body.dates, 'admin. the full diary is refused without her admin token (got ' + r.status + ')');
    r = await adminList(mod, {}, 'treatment=lash-lift', 'wrong');
    ok(r.status === 401, 'admin. and with a wrong token (got ' + r.status + ')');
  });

  await group('pinned', async () => {
    freezeAdelaide(WED, '12:00');
    const o = { overrides: {} };
    o.overrides[PINNED_SAT] = [480, 585, 690];
    const r = await publicList(mod, o);
    ok(mins(r.body, PINNED_SAT).join(',') === '480,585,690',
      'pinned. a Saturday Stefani pinned is shown exactly as pinned (got ' + mins(r.body, PINNED_SAT).join(',') + ')');
    ok(Object.keys(r.body.dates).length === 4, 'pinned. and it does not push out the three normal days (got ' + Object.keys(r.body.dates).length + ' days)');
  });

  await group('book', async () => {
    freezeAdelaide(SUN, '15:00');
    let r = await book(mod, {}, MON1, 600);   // tomorrow 10:00am - 19h away
    ok(r.status === 409 && r.body.error === 'too_soon' && r.inserted === 0,
      'book. a public booking inside the notice period is refused (got ' + r.status + ' ' + r.body.error + ')');
    freezeAdelaide(WED, '12:00');
    r = await book(mod, {}, PAST_MON, 600);   // 96 days away
    ok(r.status === 409 && r.body.error === 'too_far_ahead' && r.inserted === 0,
      'book. a public booking past the 13-week limit is refused (got ' + r.status + ' ' + r.body.error + ')');
    r = await book(mod, {}, MON3, 600);       // 19 days away - fine
    ok(r.status === 200 && r.body.ok === true, 'book. a time a few weeks out books (got ' + r.status + ' ' + (r.body.error || 'ok') + ')');
    r = await book(mod, {}, MON1, 600);       // 5 days away, free
    ok(r.status === 200 && r.body.ok === true && r.inserted === 1,
      'book. a time inside the rules still books (got ' + r.status + ' ' + (r.body.error || 'ok') + ')');
    const diary = { bookings: {} };
    diary.bookings[MON1] = [{ start_min: 600, end_min: 675 }];
    r = await book(mod, diary, MON1, 600);
    ok(r.status === 409 && r.body.error === 'slot_unavailable', 'book. a time that is already taken is still refused (got ' + r.status + ' ' + r.body.error + ')');
    // a client who was shown a time 20 minutes ago can still finish booking it
    freezeAdelaide(SAT, '10:20');             // Mon 10:00am is now 47h40m away
    r = await book(mod, {}, MON1, 600);
    ok(r.status === 200 && r.body.ok === true, 'book. a time that crossed the 48h line minutes ago can still be finished (got ' + r.status + ' ' + (r.body.error || 'ok') + ')');
    freezeAdelaide(SAT, '11:30');             // 46h30m away - past the one-hour grace
    r = await book(mod, {}, MON1, 600);
    ok(r.status === 409 && r.body.error === 'too_soon', 'book. but not once the hour of grace has gone (got ' + r.status + ' ' + r.body.error + ')');
  });

  thaw();
  return failedGroups;
}

async function adminAndPublicMonday(mod) {
  const r = await publicList(mod, {});
  return { publicMon: mins(r.body, MON1), publicTue: mins(r.body, TUE1) };
}

// ---------------------------------------------------------------------------
// the page: next openings only, and never a claim about demand
// ---------------------------------------------------------------------------
function pageChecks() {
  const book = fs.readFileSync(path.join(ROOT, 'book.html'), 'utf8');
  ok(book.indexOf('id="next-days"') !== -1, 'page. book.html has the next-openings list');
  ok(book.indexOf('date-chips') === -1 && book.indexOf('pickDate') === -1,
    'page. the old pick-any-date calendar is gone');
  ok(/id="ask-other"[\s\S]{0,400}tel:0404967051/.test(book), 'page. "none of these suit" points to Stefani (phone + Instagram)');
  const banned = /only\s+\d+\s+(spot|slot|time|place)s?\s+left|filling\s+fast|almost\s+(full|gone)|booked\s+out|nearly\s+full|selling\s+fast|high\s+demand|\d+\s+people\s+(are\s+)?(looking|viewing)/i;
  for (const f of ['book.html', 'lash.html']) {
    const html = fs.readFileSync(path.join(ROOT, f), 'utf8');
    const hit = banned.exec(html);
    ok(!hit, 'page. ' + f + ' makes no claim about demand' + (hit ? ' (found "' + hit[0] + '")' : ''));
  }
}

// ---------------------------------------------------------------------------
// mutation proof: remove each rule and confirm ITS group fails
// ---------------------------------------------------------------------------
const MUTATIONS = [
  { name: 'notice off', group: 'notice',
    from: 'const MIN_NOTICE_MIN = 48 * 60;', to: 'const MIN_NOTICE_MIN = 0;' },
  { name: 'horizon off', group: 'horizon',
    from: 'const HORIZON_DAYS = 91;', to: 'const HORIZON_DAYS = 900;' },
  { name: 'a picked week hands out the whole day', group: 'week',
    from: 'let offered = offeredSlots(d, picture, duration);',
    to: 'let offered = isDateStr(week) ? picture.slots : offeredSlots(d, picture, duration);' },
  { name: 'day and slot caps off', group: 'cap',
    from: 'const SHOW_MAX_DAYS = 3;', to: 'const SHOW_MAX_DAYS = 300;',
    from2: 'const SHOW_MAX_SLOTS = 6;', to2: 'const SHOW_MAX_SLOTS = 600;' },
  { name: 'whole day handed out again', group: 'cluster', alsoGroup: 'quiet',
    from: 'let offered = offeredSlots(d, picture, duration);', to: 'let offered = picture.slots;' },
  { name: 'anchors picked at random', group: 'stable',
    from: 'const h = stableHash(dateStr);', to: 'const h = Math.floor(Math.random() * 1e9);' },
  { name: 'booking rules not enforced', group: 'book',
    from: "if (b.date > addDays(now.date, HORIZON_DAYS)) return json({ error: 'too_far_ahead' }, 409, cors);", to: '',
    from2: 'if (!picture.pinned && absMin(b.date, startMin) >= now.abs &&', to2: 'if (false && absMin(b.date, startMin) >= now.abs &&' },
  { name: 'admin diary served without a token', group: 'admin',
    from: "if (!env.ADMIN_TOKEN || auth !== `Bearer ${env.ADMIN_TOKEN}`) {", to: 'if (false) {' },
  { name: 'pinned dates squeezed like normal days', group: 'pinned',
    from: 'if (picture.pinned || free.length === 0) return free;', to: 'if (free.length === 0) return free;' },
];

async function loadMutant(src, m, i) {
  let out = src;
  for (const [a, b] of [[m.from, m.to], [m.from2, m.to2]]) {
    if (!a) continue;
    if (out.indexOf(a) === -1) throw new Error('mutation "' + m.name + '" did not apply - worker source changed shape');
    out = out.replace(a, b);
  }
  const tmp = path.join(os.tmpdir(), 'revive-limited-mutant-' + process.pid + '-' + i + '.mjs');
  fs.writeFileSync(tmp, out);
  try { return await import(pathToFileURL(tmp).href); } finally { fs.unlinkSync(tmp); }
}

(async () => {
  console.log('Limited availability tests (frozen clock: Wed 18 Nov 2026)');
  const mod = await import(pathToFileURL(WORKER_PATH).href);

  console.log('');
  console.log('CURRENT worker source:');
  const realGroups = await runSuite(mod);
  pageChecks();
  const realPass = pass;
  const realFail = fail;

  console.log('');
  console.log('MUTATION PROOF - each rule removed in turn; its test group MUST fail:');
  // normalise line endings so the multi-line mutation matches on any checkout
  const src = fs.readFileSync(WORKER_PATH, 'utf8').replace(/\r\n/g, '\n');
  let proofFail = 0;
  for (let i = 0; i < MUTATIONS.length; i++) {
    const m = MUTATIONS[i];
    const mutant = await loadMutant(src, m, i);
    quiet = true;
    const groups = await runSuite(mutant);
    quiet = false;
    const caught = !!groups[m.group] && (!m.alsoGroup || !!groups[m.alsoGroup]);
    if (!caught) proofFail++;
    console.log((caught ? '  PASS  ' : '  FAIL  ') + 'mutant "' + m.name + '" is caught by [' + m.group +
      (m.alsoGroup ? ', ' + m.alsoGroup : '') + '] (failed groups: ' + (Object.keys(groups).join(', ') || 'none') + ')');
  }

  const good = realFail === 0 && proofFail === 0;
  console.log('');
  console.log((good ? 'ALL PASS' : 'FAILURES') + '  (' + realPass + ' passed, ' + realFail +
    ' failed against the real source; ' + (MUTATIONS.length - proofFail) + '/' + MUTATIONS.length + ' mutants caught)');
  if (Object.keys(realGroups).length) console.log('failing groups: ' + Object.keys(realGroups).join(', '));
  process.exit(good ? 0 : 1);
})();
