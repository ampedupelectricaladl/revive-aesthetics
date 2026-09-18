/**
 * Revive Aesthetics - behavioural tests for the Stripe webhook, the booking lifecycle,
 * checkout holds, abandonment, the drop-off follow-up and the deposit report (2026-09-14).
 *
 * Run: node scripts/test-stripe-lifecycle.js
 *
 * The REAL worker runs in Node (scripts/lib/revive-worker-harness.js): D1 is node:sqlite,
 * fetch is stubbed (nothing touches the network), the clock is controlled so every boundary
 * is exact. REVIVE_WORKER_FILE points it at another copy of the worker (mutation proofs:
 * scripts/prove-stripe-lifecycle-mutations.js).
 */
'use strict';

const nodeCrypto = require('crypto');
const { createWorld, at, logs } = require('./lib/revive-worker-harness');

let pass = 0;
const fails = [];
function ok(cond, label) { if (cond) pass++; else fails.push(label); }

const MIN = 60000;
const T0 = at('2026-09-14T00:30:00.000Z'); // Monday 14 Sept 2026, 10:00am ACST

async function slotsOn(w, date) {
  const r = await w.call('GET', `/api/availability?treatment=lash-lift&from=${date}&days=1`);
  return ((r.data && r.data.dates && r.data.dates[date]) || []).map(s => s.min);
}
const confirmations = (w, email) => w.emailsTo(email).filter(m => /^Booking confirmed:/.test(m.subject));
const dropOffEmails = (w, email) => w.emailsTo(email).filter(m => /isn't confirmed yet$/.test(m.subject));
const bookingTelegrams = w => w.telegramsMatching(/New Revive booking/);

// ---------------------------------------------------------------------------
// a. signature
// ---------------------------------------------------------------------------
async function groupA() {
  const w = await createWorld({ clock: T0 });
  const A = w.person('A');
  const co = await w.startCheckout(A);
  ok(co.status === 200 && !!co.data.checkout_id && !!co.piId, 'a: a checkout creates its hold row and a PaymentIntent');
  w.stripe.succeed(co.piId);
  const ev = w.evt('payment_intent.succeeded', w.stripe.pi(co.piId));
  const snap = () => JSON.stringify([w.all('SELECT * FROM bookings ORDER BY id'), w.all('SELECT * FROM stripe_events ORDER BY id')]);
  const before = snap();
  const tg0 = w.calls.telegram.length;
  const gm0 = w.calls.gmail.length;
  const nowSec = Math.floor(w.clock.now / 1000);

  let r = await w.webhook(ev, { secret: 'whsec_not_the_real_one' });
  ok(r.status === 400, 'a: invalid signature -> 400');
  r = await w.webhook(ev, { noHeader: true });
  ok(r.status === 400, 'a: missing Stripe-Signature header -> 400');
  r = await w.webhook(ev, { t: nowSec - 301 });
  ok(r.status === 400 && r.data.reason === 'stale_timestamp', 'a: timestamp 301s old -> 400 stale');
  r = await w.webhook(ev, { header: 't=' + nowSec });
  ok(r.status === 400, 'a: header with no v1 signature -> 400');
  const tampered = JSON.stringify(Object.assign({}, ev, { data: { object: Object.assign({}, ev.data.object, { amount: 1 }) } }));
  r = await w.webhook(ev, { bodyOverride: tampered });
  ok(r.status === 400, 'a: body altered after signing -> 400');
  ok(snap() === before && w.calls.telegram.length === tg0 && w.calls.gmail.length === gm0,
    'a: every rejected delivery changed nothing in D1 and sent nothing');

  const secret = w.env.STRIPE_WEBHOOK_SECRET;
  delete w.env.STRIPE_WEBHOOK_SECRET;
  r = await w.webhook(ev, { secret });
  ok(r.status === 503, 'a: STRIPE_WEBHOOK_SECRET not configured -> refused');
  ok(snap() === before && w.calls.gmail.length === gm0, 'a: ...and nothing was processed');
  w.env.STRIPE_WEBHOOK_SECRET = secret;

  r = await w.webhook(ev, { t: nowSec - 299, rotatedBadFirst: true });
  ok(r.status === 200 && r.data.received === true, 'a: valid signature (299s old, the second v1 matches) -> 200');
  const er = w.one('SELECT * FROM stripe_events WHERE id = ?', ev.id);
  ok(!!er && er.processed_at != null && er.result === 'confirmed', 'a: the valid event was recorded and processed');
  const b = w.row(co.data.checkout_id);
  ok(b.status === 'confirmed' && b.lifecycle === 'deposit_paid' && b.deposit_paid === 1, 'a: the verified payment confirmed the booking');

  const I = w.internals;
  const body = '{"id":"evt_x"}';
  const t = 1800000000;
  const good = nodeCrypto.createHmac('sha256', 'whsec_k').update(`${t}.${body}`).digest('hex');
  const bad = good.slice(0, -1) + (good.endsWith('0') ? '1' : '0');
  ok((await I.verifyStripeSignature(body, `t=${t},v1=${good}`, 'whsec_k', t + 300)).ok === true, 'a: verifier accepts a signature exactly 300s old');
  ok((await I.verifyStripeSignature(body, `t=${t},v1=${good}`, 'whsec_k', t + 301)).ok === false, 'a: verifier rejects 301s old');
  ok((await I.verifyStripeSignature(body, `t=${t},v1=${bad}`, 'whsec_k', t)).ok === false, 'a: verifier rejects a one-character difference');
  ok((await I.verifyStripeSignature(body, `t=${t},v1=${good}`, '', t)).ok === false, 'a: verifier refuses without a secret');
  ok((await I.verifyStripeSignature(body + ' ', `t=${t},v1=${good}`, 'whsec_k', t)).ok === false, 'a: verifier covers the raw body byte for byte');
}

// ---------------------------------------------------------------------------
// b. the same event twice
// ---------------------------------------------------------------------------
async function groupB() {
  const w = await createWorld({ clock: T0 });
  const A = w.person('B');
  const co = await w.startCheckout(A);
  w.stripe.succeed(co.piId);
  const ev = w.evt('payment_intent.succeeded', w.stripe.pi(co.piId));
  const r1 = await w.webhook(ev);
  const r2 = await w.webhook(ev);
  ok(r1.status === 200 && !r1.data.duplicate, 'b: first delivery accepted');
  ok(r2.status === 200 && r2.data.duplicate === true, 'b: second delivery is a 200 no-op marked duplicate');
  ok(w.all('SELECT id FROM stripe_events WHERE id = ?', ev.id).length === 1, 'b: the event is stored once');
  ok(confirmations(w, A.email).length === 1, 'b: exactly one confirmation email');
  ok(bookingTelegrams(w).length === 1, 'b: exactly one booking Telegram');
  const processedAt = w.one('SELECT processed_at FROM stripe_events WHERE id = ?', ev.id).processed_at;

  // An event whose handling is NOT naturally idempotent: an unmatched payment alerts every time it is processed.
  const ghost = w.evt('payment_intent.succeeded', { id: 'pi_ghost_b', object: 'payment_intent', amount: 2850, currency: 'aud', status: 'succeeded' });
  await w.webhook(ghost);
  w.clock.now = T0 + 3 * MIN; // a Stripe retry after the cron's 2-minute reprocess window
  const r3 = await w.webhook(ghost);
  await w.cron(T0 + 4 * MIN);
  ok(r3.data.duplicate === true, 'b: a retry minutes later is still recognised as a duplicate');
  ok(w.telegramsMatching(/pi_ghost_b/).length === 1, 'b: duplicate deliveries of an unmatched event alert Stefani once');
  ok(w.one('SELECT processed_at FROM stripe_events WHERE id = ?', ev.id).processed_at === processedAt, 'b: the cron did not reprocess an already processed event');
  ok(confirmations(w, A.email).length === 1 && bookingTelegrams(w).length === 1, 'b: still one confirmation and one booking Telegram after the cron');
}

// ---------------------------------------------------------------------------
// c. succeeded for a PaymentIntent we know nothing about
// ---------------------------------------------------------------------------
async function groupC() {
  const w = await createWorld({ clock: T0 });
  await w.startCheckout(w.person('C')); // an unrelated real checkout exists
  const rowsBefore = w.all('SELECT * FROM bookings').length;
  const L0 = logs.length;
  const ev = w.evt('payment_intent.succeeded', { id: 'pi_unknown_c', object: 'payment_intent', amount: 4650, currency: 'aud', status: 'succeeded' });
  const r = await w.webhook(ev);
  ok(r.status === 200, 'c: unmatched event still acknowledged (Stripe must not retry forever)');
  const er = w.one('SELECT * FROM stripe_events WHERE id = ?', ev.id);
  ok(!!er && er.result === 'unmatched' && er.processed_at != null, "c: event row result is 'unmatched'");
  ok(logs.slice(L0).some(l => /NO MATCHING BOOKING/.test(l) && l.includes('pi_unknown_c') && l.includes(ev.id) && l.includes('payment_intent.succeeded')),
    'c: console.error names the event id, type and PaymentIntent');
  const tg = w.telegramsMatching(/no matching booking/);
  ok(tg.length === 1 && tg[0].body.text.includes('pi_unknown_c') && tg[0].body.text.includes('$46.50'),
    'c: Stefani Telegrammed once with the PaymentIntent and the amount');
  ok(w.all('SELECT * FROM bookings').length === rowsBefore, 'c: nothing was booked off the back of it');

  const refundEv = w.evt('charge.refunded', { id: 'ch_unknown', object: 'charge', payment_intent: 'pi_unknown_c2', amount: 2850, amount_refunded: 2850 });
  await w.webhook(refundEv);
  ok(w.one('SELECT result FROM stripe_events WHERE id = ?', refundEv.id).result === 'unmatched' && w.telegramsMatching(/pi_unknown_c2/).length === 1,
    'c: an unmatched refund is reported too');
}

// ---------------------------------------------------------------------------
// d. abandonment at exactly 30 minutes
// ---------------------------------------------------------------------------
async function groupD() {
  const w = await createWorld({ clock: T0 });
  const A = w.person('D');
  const B = w.person('DB');
  const co = await w.startCheckout(A);
  const id = co.data.checkout_id;
  let b = w.row(id);
  ok(b.status === 'pending' && b.lifecycle === 'deposit_pending' && b.pi_created_at === T0 && b.hold_until === T0 + 30 * MIN,
    'd: checkout is pending / deposit_pending, held for 30 minutes from the PaymentIntent');
  ok(!(await slotsOn(w, '2026-09-21')).includes(600), 'd: the held slot is not offered to others');
  const creates0 = w.stripe.createCalls;
  const other = await w.startCheckout(B);
  ok(other.status === 409 && other.data.error === 'slot_unavailable' && w.stripe.createCalls === creates0,
    'd: someone else is refused the held slot BEFORE any PaymentIntent');

  await w.cron(T0 + 30 * MIN - 1000);
  b = w.row(id);
  ok(b.status === 'pending' && b.lifecycle === 'deposit_pending', 'd: at 29:59 the checkout is NOT abandoned');
  ok((await w.startCheckout(B)).status === 409, 'd: at 29:59 the hold still blocks the slot');
  ok(w.telegramsMatching(/Didn't finish booking/).length === 0, 'd: no abandonment alert at 29:59');

  await w.cron(T0 + 30 * MIN);
  b = w.row(id);
  ok(b.status === 'abandoned' && b.lifecycle === 'abandoned' && b.abandoned_at === T0 + 30 * MIN && b.hold_until == null,
    'd: at 30:00 the checkout is abandoned and its hold cleared');
  ok((await slotsOn(w, '2026-09-21')).includes(600), 'd: the slot is offered again');
  const tg = w.telegramsMatching(/Didn't finish booking/);
  ok(tg.length === 1 && tg[0].body.text.includes(A.name) && tg[0].body.text.includes(A.phone) &&
     tg[0].body.text.includes('Lash Lift') && tg[0].body.text.includes('Monday 21 September') && tg[0].body.text.includes('10:00am') &&
     /no card payment was attempted/.test(tg[0].body.text),
    'd: Stefani told who, what, when, and that no card was tried');
  ok(w.calls.gmail.length === 0, 'd: NO customer email for an abandonment');
  ok((await w.startCheckout(B)).status === 200, 'd: someone else can now take the slot');
  await w.cron(T0 + 31 * MIN);
  ok(w.telegramsMatching(/Didn't finish booking/).length === 1, 'd: the abandonment alert is not repeated');

  const I = w.internals;
  const r = { status: 'pending', lifecycle: 'deposit_pending', hold_until: 5000 };
  ok(I.HOLD_MIN === 30, 'd: HOLD_MIN is 30');
  ok(!I.holdHasLapsed(r, 4999) && I.holdHasLapsed(r, 5000), 'd: holdHasLapsed is exact at the boundary');
  ok(!I.holdHasLapsed(Object.assign({}, r, { status: 'confirmed' }), 9e15), 'd: a confirmed booking never lapses');
}

// ---------------------------------------------------------------------------
// e. the drop-off follow-up goes exactly once
// ---------------------------------------------------------------------------
async function failCheckout(w, who, over, failAt) {
  const co = await w.startCheckout(who, over);
  w.clock.now = failAt;
  w.stripe.fail(co.piId, 'Your card was declined.');
  const r = await w.webhook(w.evt('payment_intent.payment_failed', w.stripe.pi(co.piId)));
  co.failResult = r;
  return co;
}

async function groupE() {
  // 1. event path first, then everything again
  {
    const w = await createWorld({ clock: T0 });
    const A = w.person('E');
    const co = await failCheckout(w, A, {}, T0 + MIN);
    let b = w.row(co.data.checkout_id);
    ok(co.failResult.status === 200 && b.status === 'pending' && b.lifecycle === 'deposit_failed' && b.last_payment_error === 'Your card was declined.',
      'e: payment_failed -> deposit_failed, hold kept, reason recorded');
    ok(b.followup_due_at === T0 + 4 * MIN, 'e: follow-up due exactly 3 minutes after the event time');
    await w.cron(T0 + 4 * MIN - 1000);
    ok(dropOffEmails(w, A.email).length === 0, 'e: nothing before the 3 minutes are up');
    await w.cron(T0 + 4 * MIN);
    const mails = dropOffEmails(w, A.email);
    ok(mails.length === 1, 'e: the follow-up email goes when due');
    ok(mails[0] && mails[0].subject === "Your Lash Lift booking isn't confirmed yet", 'e: approved subject line');
    ok(mails[0] && /Finish my booking/.test(mails[0].html) && mails[0].html.includes('d=2026-09-21&amp;m=600'),
      'e: her own hold does not make her time look taken in the email');
    b = w.row(co.data.checkout_id);
    ok(b.followup_result === 'sent' && b.followed_up_at === T0 + 4 * MIN, 'e: the send is recorded');
    const I = w.internals;
    for (const tt of [T0 + 5 * MIN, T0 + 6 * MIN]) {
      await I.dispatchDueFollowups(w.env, tt);
      await I.followupBackstopSweep(w.env, tt);
    }
    await w.cron(T0 + 30 * MIN);
    await w.cron(T0 + 60 * MIN); // 11:00 Adelaide: the hourly backstop runs inside the cron too
    ok(dropOffEmails(w, A.email).length === 1, 'e: dispatcher + backstop, repeated and on the hour -> still exactly one email');
    const w0 = await createWorld({ clock: T0 });
    const I0 = w0.internals;
    let hourly = 0;
    const origSweep = I0.followupBackstopSweep; // observe the gate through its effect: reminders at :00 only
    w0.db.sqlite.exec(`INSERT INTO bookings (id, treatment_id, date, start_min, end_min, name, phone, email, status, cancel_token, created_at)
      VALUES ('gate1', 'lash-lift', '2026-09-15', 720, 780, 'Gate', '0400000555', 'gate@example.com', 'confirmed', 't', '2026-09-01T00:00:00.000Z')`);
    await w0.cron(T0 + 59 * MIN + 59000); // 10:59:59
    hourly += w0.emailsTo('gate@example.com').length;
    ok(hourly === 0 && typeof origSweep === 'function', 'e: hourly work does not run off the Adelaide hour');
    await w0.cron(T0 + 60 * MIN); // 11:00
    ok(w0.emailsTo('gate@example.com').length === 1, 'e: hourly work (reminders) runs on the Adelaide hour');
    ok(w.row(co.data.checkout_id).status === 'abandoned', 'e: (the hold lapsed meanwhile)');
    const tg = w.telegramsMatching(/Didn't finish booking/);
    ok(tg.length === 1 && /card declined \/ payment failed: Your card was declined\./.test(tg[0].body.text) && /Follow-up email already sent/.test(tg[0].body.text),
      'e: the abandonment alert says the card was declined and the email already went');
  }
  // 2. backstop first, then the event path
  {
    const w = await createWorld({ clock: T0 });
    const A = w.person('F');
    await failCheckout(w, A, {}, T0 + MIN);
    const I = w.internals;
    await I.followupBackstopSweep(w.env, T0 + 4 * MIN);
    ok(dropOffEmails(w, A.email).length === 1, 'e: the backstop alone sends it once when due');
    await I.dispatchDueFollowups(w.env, T0 + 4 * MIN);
    await w.cron(T0 + 5 * MIN);
    ok(dropOffEmails(w, A.email).length === 1, 'e: the event path afterwards sends nothing more');
  }
  // 3. both paths at the same instant (overlapping cron runs)
  {
    const w = await createWorld({ clock: T0 });
    const A = w.person('G');
    await failCheckout(w, A, {}, T0 + MIN);
    const I = w.internals;
    const tt = T0 + 4 * MIN;
    await Promise.all([I.dispatchDueFollowups(w.env, tt), I.followupBackstopSweep(w.env, tt), I.dispatchDueFollowups(w.env, tt)]);
    ok(dropOffEmails(w, A.email).length === 1, 'e: dispatcher and backstop running concurrently -> exactly one email');
  }
  // 4. the event path missed it (no due time recorded): only the backstop can catch it, once
  {
    const w = await createWorld({ clock: T0 });
    const A = w.person('H');
    const co = await failCheckout(w, A, {}, T0 + MIN);
    w.db.sqlite.prepare('UPDATE bookings SET followup_due_at = NULL WHERE id = ?').run(co.data.checkout_id);
    await w.cron(T0 + 4 * MIN);
    ok(dropOffEmails(w, A.email).length === 0, 'e: with no due time the per-minute dispatcher sends nothing');
    const I = w.internals;
    await I.followupBackstopSweep(w.env, T0 + 4 * MIN);
    await I.followupBackstopSweep(w.env, T0 + 5 * MIN);
    await I.dispatchDueFollowups(w.env, T0 + 5 * MIN);
    ok(dropOffEmails(w, A.email).length === 1, 'e: the backstop catches the missed row, once');
  }
  // 5. abandoned WITHOUT a failed payment: never emailed by either path
  {
    const w = await createWorld({ clock: T0 });
    const A = w.person('I');
    await w.startCheckout(A);
    await w.cron(T0 + 30 * MIN);
    await w.cron(T0 + 60 * MIN);
    await w.internals.followupBackstopSweep(w.env, T0 + 61 * MIN);
    await w.internals.dispatchDueFollowups(w.env, T0 + 61 * MIN);
    ok(w.calls.gmail.length === 0, 'e: an abandoned checkout that never had a failed payment is never emailed');
  }
  // 6. failed, then paid before the email was due: no drop-off email
  {
    const w = await createWorld({ clock: T0 });
    const A = w.person('J');
    const co = await failCheckout(w, A, {}, T0 + MIN);
    w.clock.now = T0 + 2 * MIN;
    w.stripe.succeed(co.piId);
    await w.webhook(w.evt('payment_intent.succeeded', w.stripe.pi(co.piId)));
    await w.cron(T0 + 4 * MIN);
    await w.internals.followupBackstopSweep(w.env, T0 + 60 * MIN);
    ok(dropOffEmails(w, A.email).length === 0 && confirmations(w, A.email).length === 1, 'e: paid after a failure -> confirmation only, no drop-off email');
  }
  // 7. a cancellation of an already-abandoned checkout (our own abandonment) is not a drop-off
  {
    const w = await createWorld({ clock: T0 });
    const A = w.person('K');
    const co = await w.startCheckout(A);
    await w.cron(T0 + 30 * MIN);
    w.clock.now = T0 + 31 * MIN;
    const r = await w.webhook(w.evt('payment_intent.canceled', Object.assign(w.stripe.pi(co.piId), { status: 'canceled', cancellation_reason: 'abandoned' })));
    const b = w.row(co.data.checkout_id);
    await w.cron(T0 + 60 * MIN);
    ok(r.status === 200 && b.followup_due_at == null && w.calls.gmail.length === 0, 'e: canceled after our abandonment schedules no follow-up');
    // ...but a cancellation while the checkout is live IS a drop-off
    const w2 = await createWorld({ clock: T0 });
    const A2 = w2.person('L');
    const co2 = await w2.startCheckout(A2);
    w2.clock.now = T0 + 2 * MIN;
    await w2.webhook(w2.evt('payment_intent.canceled', Object.assign(w2.stripe.pi(co2.piId), { status: 'canceled' })));
    const b2 = w2.row(co2.data.checkout_id);
    await w2.cron(T0 + 5 * MIN);
    ok(b2.lifecycle === 'deposit_failed' && b2.followup_due_at === T0 + 5 * MIN && dropOffEmails(w2, A2.email).length === 1,
      'e: canceled while live -> deposit_failed and one follow-up');
  }
}

// ---------------------------------------------------------------------------
// f. migration backfill
// ---------------------------------------------------------------------------
async function groupF() {
  const w = await createWorld({ clock: T0 });
  // Production's bookings table as it stands (columns added by earlier migrations).
  for (const c of ['price_override INTEGER', 'stripe_payment_intent_id TEXT', 'deposit_paid INTEGER DEFAULT 0', 'deposit_cents INTEGER DEFAULT 0']) {
    w.db.sqlite.exec('ALTER TABLE bookings ADD COLUMN ' + c);
  }
  const ins = w.db.sqlite.prepare(
    `INSERT INTO bookings (id, treatment_id, date, start_min, end_min, name, phone, email, status, cancel_token, created_at, deposit_paid, deposit_cents, stripe_payment_intent_id)
     VALUES (?, 'lash-lift', ?, ?, ?, 'Old Client', '0400000999', '', ?, 'tok', ?, ?, ?, ?)`);
  const seed = [
    ['cancelled1', 'cancelled', 0, '2026-09-01', 600, 660, 'cancelled'],
    ['paidpast', 'confirmed', 1, '2026-09-08', 600, 660, 'completed'],
    ['paidfuture', 'confirmed', 1, '2026-09-21', 600, 660, 'deposit_paid'],
    ['unpaidpast', 'confirmed', 0, '2026-09-08', 720, 780, 'completed'],
    ['unpaidfuture', 'confirmed', 0, '2026-09-22', 600, 660, 'booked_no_deposit'],
    ['endsnow', 'confirmed', 0, '2026-09-14', 540, 600, 'completed'],        // ended 10:00, it is 10:00 Adelaide
    ['endslater', 'confirmed', 0, '2026-09-14', 600, 601, 'booked_no_deposit'],// ends 10:01
    ['legacyfmt', 'confirmed', 0, '2026-09-15', 600, 660, 'booked_no_deposit'],
  ];
  for (const [id, status, paid, date, s, e] of seed) {
    ins.run(id, date, s, e, status, id === 'legacyfmt' ? '2026-08-05 10:06:01' : '2026-08-01T00:00:00.000Z', paid, paid ? 2850 : 0, paid ? 'pi_old_' + id : '');
  }
  const r = await w.admin('POST', '/api/admin/migrate');
  ok(r.status === 200 && r.data.ok === true, 'f: /api/admin/migrate succeeds on the production-shaped table');
  for (const [id, , , , , , want] of seed) {
    const got = w.row(id) && w.row(id).lifecycle;
    ok(got === want, `f: backfill ${id} -> ${want} (got ${got})`);
  }
  ok(w.one('SELECT COUNT(*) AS n FROM bookings WHERE lifecycle IS NULL').n === 0, 'f: no row is left with a NULL lifecycle');
  const cols = w.all('PRAGMA table_info(bookings)').map(c => c.name);
  ok(['lifecycle', 'hold_until', 'followup_due_at', 'followed_up_at', 'refunded_cents', 'payment_failed_at'].every(c => cols.includes(c)),
    'f: the new columns exist');
  ok(w.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'stripe_events'").length === 1, 'f: stripe_events exists');
  const before = JSON.stringify(w.all('SELECT id, lifecycle FROM bookings ORDER BY id'));
  const r2 = await w.admin('POST', '/api/admin/migrate');
  ok(r2.status === 200 && r2.data.lifecycle_backfilled === 0 && JSON.stringify(w.all('SELECT id, lifecycle FROM bookings ORDER BY id')) === before,
    'f: migrate is idempotent');

  const I = w.internals;
  const now = I.nowInAdelaide(T0);
  for (const st of ['pending', 'abandoned', 'weird', '', null]) {
    ok(I.backfillLifecycle({ status: st, date: 'x', end_min: null }, now) != null, `f: backfillLifecycle never returns null (status ${st})`);
  }
}

// ---------------------------------------------------------------------------
// g. confirmation from either path, exactly once
// ---------------------------------------------------------------------------
async function groupG() {
  // webhook first, then the browser
  {
    const w = await createWorld({ clock: T0 });
    const A = w.person('M');
    const co = await w.startCheckout(A);
    w.stripe.succeed(co.piId);
    const wr = await w.webhook(w.evt('payment_intent.succeeded', w.stripe.pi(co.piId)));
    const br = await w.browserBook(co);
    const b = w.row(co.data.checkout_id);
    ok(wr.status === 200 && br.status === 200 && br.data.ok === true && br.data.id === co.data.checkout_id && br.data.cancel_token === b.cancel_token,
      'g: webhook first -> the browser still gets the normal success payload for the same booking');
    ok(br.data.treatment === 'Lash Lift' && br.data.date === '2026-09-21' && br.data.time_label === '10:00am' && br.data.duration_min === 60 && br.data.price_aud === 95,
      'g: success payload has the usual fields');
    ok(confirmations(w, A.email).length === 1 && bookingTelegrams(w).length === 1, 'g: webhook first -> one email, one Telegram');
    ok(b.status === 'confirmed' && b.lifecycle === 'deposit_paid' && b.deposit_paid === 1 && b.deposit_cents === 2850 && b.notes === 'first visit',
      'g: confirmed row carries deposit and the notes typed at checkout');
  }
  // browser first, then the webhook
  {
    const w = await createWorld({ clock: T0 });
    const A = w.person('N');
    const co = await w.startCheckout(A);
    w.stripe.succeed(co.piId);
    const br = await w.browserBook(co);
    const ev = w.evt('payment_intent.succeeded', w.stripe.pi(co.piId));
    await w.webhook(ev);
    ok(br.status === 200 && br.data.id === co.data.checkout_id, 'g: browser first -> confirmed');
    ok(w.one('SELECT result FROM stripe_events WHERE id = ?', ev.id).result === 'already_confirmed', 'g: the later webhook sees it confirmed');
    ok(confirmations(w, A.email).length === 1 && bookingTelegrams(w).length === 1, 'g: browser first -> one email, one Telegram');
  }
  // both at once
  {
    const w = await createWorld({ clock: T0 });
    const A = w.person('O');
    const co = await w.startCheckout(A);
    w.stripe.succeed(co.piId);
    const [wr, br] = await Promise.all([w.webhook(w.evt('payment_intent.succeeded', w.stripe.pi(co.piId))), w.browserBook(co)]);
    await w.drain();
    ok(wr.status === 200 && br.status === 200 && br.data.id === co.data.checkout_id, 'g: simultaneous webhook + browser both succeed');
    ok(confirmations(w, A.email).length === 1 && bookingTelegrams(w).length === 1, 'g: simultaneous -> still one email, one Telegram');
  }
  // true races: both paths read the row as pending before either writes
  {
    const w = await createWorld({ clock: T0 });
    const A = w.person('O2');
    const co = await w.startCheckout(A);
    w.stripe.succeed(co.piId);
    const [b1, b2] = await Promise.all([w.browserBook(co), w.browserBook(co)]);
    await w.drain();
    ok(b1.status === 200 && b2.status === 200 && b1.data.id === b2.data.id, 'g: a double-submitted /api/book returns the same booking twice');
    ok(confirmations(w, A.email).length === 1 && bookingTelegrams(w).length === 1, 'g: double-submitted /api/book -> one email, one Telegram');
  }
  {
    const w = await createWorld({ clock: T0 });
    const A = w.person('O3');
    const co = await w.startCheckout(A);
    w.stripe.succeed(co.piId);
    const e1 = w.evt('payment_intent.succeeded', w.stripe.pi(co.piId));
    const e2 = w.evt('payment_intent.succeeded', w.stripe.pi(co.piId));
    await Promise.all([w.webhook(e1), w.webhook(e2)]);
    await w.drain();
    const results = [e1, e2].map(e => w.one('SELECT result FROM stripe_events WHERE id = ?', e.id).result).sort().join(',');
    ok(results === 'already_confirmed,confirmed', `g: two distinct succeeded events processed together -> one confirms, one sees it confirmed (got ${results})`);
    ok(confirmations(w, A.email).length === 1 && bookingTelegrams(w).length === 1, 'g: two succeeded events at once -> one email, one Telegram');
  }
  // wrong amount is never confirmed
  {
    const w = await createWorld({ clock: T0 });
    const A = w.person('P');
    const co = await w.startCheckout(A);
    w.stripe.succeed(co.piId);
    w.stripe.pis.get(co.piId).amount = 100;
    const ev = w.evt('payment_intent.succeeded', w.stripe.pi(co.piId));
    await w.webhook(ev);
    ok(w.one('SELECT result FROM stripe_events WHERE id = ?', ev.id).result === 'amount_mismatch' && w.row(co.data.checkout_id).status === 'pending',
      'g: a succeeded amount different from the row deposit_cents does not confirm');
    ok(w.telegramsMatching(/does not match the booking/).length === 1 && confirmations(w, A.email).length === 0, 'g: ...Stefani is told, no confirmation sent');
    const br = await w.browserBook(co);
    ok(br.status === 402 && br.data.error === 'deposit_unverified', 'g: the browser path refuses it too');
  }
  // free booking and a legacy PaymentIntent with no checkout row
  {
    const w = await createWorld({ clock: T0 });
    const F = w.person('Q');
    const fr = await w.call('POST', '/api/book', { treatment: 'consultation', date: '2026-09-22', start_min: 600, name: F.name, phone: F.phone, email: F.email, notes: '' });
    ok(fr.status === 200 && w.row(fr.data.id).lifecycle === 'booked_no_deposit' && confirmations(w, F.email).length === 1,
      'g: a free booking confirms with lifecycle booked_no_deposit and one email');
    const L = w.person('R');
    w.stripe.add({ id: 'pi_legacy_g', amount: 2850, status: 'succeeded' });
    const lr = await w.call('POST', '/api/book', { treatment: 'lash-lift', date: '2026-09-21', start_min: 720, name: L.name, phone: L.phone, email: L.email, payment_intent_id: 'pi_legacy_g' });
    const lev = w.evt('payment_intent.succeeded', w.stripe.pi('pi_legacy_g'));
    await w.webhook(lev);
    ok(lr.status === 200 && w.row(lr.data.id).lifecycle === 'deposit_paid' && w.one('SELECT result FROM stripe_events WHERE id = ?', lev.id).result === 'already_confirmed' &&
       confirmations(w, L.email).length === 1, 'g: a PaymentIntent from before holds existed still books once, and its webhook is a no-op');
  }
  // the conversion cannot break a booking
  {
    const w = await createWorld({ clock: T0, env: { META_PIXEL_ID: '123', META_CAPI_TOKEN: 'tok' } });
    w.metaThrows = true;
    const A = w.person('S');
    const co = await w.startCheckout(A);
    w.stripe.succeed(co.piId);
    const br = await w.browserBook(co);
    ok(br.status === 200 && w.row(co.data.checkout_id).status === 'confirmed' && w.calls.meta.length === 1 && confirmations(w, A.email).length === 1,
      'g: Meta down -> the booking and its email still go through');
  }
}

// ---------------------------------------------------------------------------
// h. success after abandonment
// ---------------------------------------------------------------------------
async function groupH() {
  {
    const w = await createWorld({ clock: T0 });
    const A = w.person('T');
    const co = await w.startCheckout(A);
    await w.cron(T0 + 30 * MIN);
    ok(w.row(co.data.checkout_id).status === 'abandoned', 'h: setup - abandoned');
    w.clock.now = T0 + 35 * MIN;
    w.stripe.succeed(co.piId);
    const ev = w.evt('payment_intent.succeeded', w.stripe.pi(co.piId));
    await w.webhook(ev);
    const b = w.row(co.data.checkout_id);
    ok(b.status === 'confirmed' && b.lifecycle === 'deposit_paid' && w.one('SELECT result FROM stripe_events WHERE id = ?', ev.id).result === 'confirmed',
      'h: late payment with the slot still free -> confirmed');
    ok(confirmations(w, A.email).length === 1 && w.stripe.refunds.length === 0, 'h: ...with its confirmation, and no refund');
  }
  {
    const w = await createWorld({ clock: T0 });
    const A = w.person('U');
    const B = w.person('V');
    const coA = await w.startCheckout(A);
    await w.cron(T0 + 30 * MIN);
    w.clock.now = T0 + 31 * MIN;
    const coB = await w.startCheckout(B);
    w.stripe.succeed(coB.piId);
    await w.webhook(w.evt('payment_intent.succeeded', w.stripe.pi(coB.piId)));
    ok(w.row(coB.data.checkout_id).status === 'confirmed', 'h: setup - someone else booked the freed slot');
    w.clock.now = T0 + 40 * MIN;
    w.stripe.succeed(coA.piId);
    const ev = w.evt('payment_intent.succeeded', w.stripe.pi(coA.piId));
    await w.webhook(ev);
    const a = w.row(coA.data.checkout_id);
    ok(w.stripe.refunds.length === 1 && w.stripe.refunds[0].pi === coA.piId && w.stripe.refunds[0].idempotencyKey === 'revive-refund-' + coA.piId,
      'h: late payment for a taken slot -> refund call made (with idempotency key)');
    ok(a.status === 'abandoned' && a.lifecycle === 'refunded' && a.refunded_cents === 2850 && a.deposit_paid === 1 && a.unbookable_reason === 'slot_unavailable',
      'h: ...recorded as refunded');
    const tgRefund = w.telegramsMatching(/Deposit refunded — booking could not be made/);
    ok(tgRefund.length === 1 && tgRefund[0].body.text.includes(A.name), 'h: ...Stefani told');
    ok(confirmations(w, A.email).length === 0 && w.row(coB.data.checkout_id).status === 'confirmed', 'h: ...no confirmation for her, the other booking stands');
    const br = await w.browserBook(coA);
    ok(br.status === 409 && br.data.error === 'slot_unavailable' && br.data.refunded === true && w.stripe.refunds.length === 1,
      'h: the browser arriving later is told it was refunded, and nothing is refunded twice');
    const tgCount = w.calls.telegram.length;
    const rev = w.evt('charge.refunded', { id: 'ch_a', object: 'charge', payment_intent: coA.piId, amount: 2850, amount_refunded: 2850 });
    await w.webhook(rev);
    ok(w.one('SELECT result FROM stripe_events WHERE id = ?', rev.id).result === 'already_refunded' && w.calls.telegram.length === tgCount,
      "h: Stripe's charge.refunded for our own refund is a no-op");
    const partial = w.evt('charge.refunded', { id: 'ch_b', object: 'charge', payment_intent: coB.piId, amount: 2850, amount_refunded: 1000 });
    await w.webhook(partial);
    const bb = w.row(coB.data.checkout_id);
    ok(bb.lifecycle === 'refunded' && bb.refunded_cents === 1000 && bb.status === 'confirmed' &&
       w.telegramsMatching(/\$10\.00 refunded of the \$28\.50 deposit/).length === 1,
      'h: charge.refunded on a confirmed booking -> lifecycle refunded, refunded_cents stored, Stefani told, booking kept');
  }
  {
    const w = await createWorld({ clock: T0 });
    const A = w.person('W');
    const coA = await w.startCheckout(A);
    await w.cron(T0 + 30 * MIN);
    w.clock.now = T0 + 31 * MIN;
    await w.admin('POST', '/api/admin/book', { date: '2026-09-21', start_min: 600, end_min: 660, name: 'Walk-in' });
    w.stripe.refundFails = true;
    w.stripe.succeed(coA.piId);
    const ev = w.evt('payment_intent.succeeded', w.stripe.pi(coA.piId));
    await w.webhook(ev);
    const a = w.row(coA.data.checkout_id);
    ok(w.one('SELECT result FROM stripe_events WHERE id = ?', ev.id).result === 'unbookable_refund_failed' && a.lifecycle === 'deposit_paid' && a.deposit_paid === 1,
      'h: a refund Stripe refuses leaves the row as paid, not refunded');
    ok(w.telegramsMatching(/refund FAILED/).length === 1, 'h: ...and Stefani is told to refund it herself');
    const br = await w.browserBook(coA);
    ok(br.status === 409 && br.data.refunded === false, 'h: the browser is told refunded: false');
  }
}

// ---------------------------------------------------------------------------
// i. report
// ---------------------------------------------------------------------------
async function groupI() {
  const w = await createWorld({ clock: T0 });
  await w.admin('POST', '/api/admin/migrate');
  const ins = w.db.sqlite.prepare(
    `INSERT INTO bookings (id, treatment_id, addon_ids, date, start_min, end_min, name, phone, email, status, cancel_token, created_at,
       deposit_paid, deposit_cents, refunded_cents, stripe_payment_intent_id, lifecycle, payment_failed_at, abandoned_reason, price_override)
     VALUES (?, 'lash-lift', '', ?, ?, 660, 'X', '0400000000', '', ?, 'tok', ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  let slot = 600;
  const add = (id, created, o) => {
    o = Object.assign({ status: 'confirmed', paid: 0, dep: 0, ref: 0, pi: '', lc: 'booked_no_deposit', failed: null, reason: null, override: null, date: '2026-11-02' }, o);
    ins.run(id, o.date, slot++, o.status, created, o.paid, o.dep, o.ref, o.pi, o.lc, o.failed, o.reason, o.override);
  };
  // Monday 14 Sept, ACST (+9:30)
  add('s_before', '2026-09-13T14:29:00.000Z', { paid: 1, dep: 2850, pi: 'pi_1', lc: 'deposit_paid' });            // Sun 13th 23:59 - out
  add('s_start', '2026-09-13T14:30:00.000Z', { paid: 1, dep: 2850, pi: 'pi_2', lc: 'deposit_paid' });             // 14th 00:00 - in
  add('s_abandon', '2026-09-14T14:29:00.000Z', { status: 'abandoned', pi: 'pi_3', lc: 'abandoned', failed: 1, reason: 'hold_lapsed' }); // 14th 23:59 - in
  add('s_after', '2026-09-14T14:30:00.000Z', { paid: 1, dep: 2850, pi: 'pi_4', lc: 'deposit_paid' });             // 15th 00:00 - out
  add('s_legacy', '2026-09-14 05:00:00', { override: 120 });                                                       // UTC text, 14:30 Adelaide - in
  add('s_legacy_late', '2026-09-14 14:45:00', { paid: 1, dep: 2850, lc: 'deposit_paid' });                        // UTC text, 15th 00:15 Adelaide - out
  add('s_refund', '2026-09-14T02:00:00.000Z', { status: 'abandoned', paid: 1, dep: 2850, ref: 2850, pi: 'pi_5', lc: 'refunded', reason: 'unbookable' }); // in
  add('s_superseded', '2026-09-14T03:00:00.000Z', { status: 'abandoned', pi: 'pi_6', lc: 'abandoned', failed: 1, reason: 'superseded' }); // in, not counted as started/abandoned
  let r = await w.admin('GET', '/api/admin/report?from=2026-09-14&to=2026-09-14');
  const d = r.data;
  ok(r.status === 200 && d.from === '2026-09-14' && d.to === '2026-09-14', 'i: report route answers');
  ok(d.started === 3, `i: started = 3 (got ${d.started})`);
  ok(d.deposits_paid === 2, `i: deposits_paid = 2 (got ${d.deposits_paid})`);
  ok(d.deposits_failed === 2, `i: deposits_failed = 2 (got ${d.deposits_failed})`);
  ok(d.abandoned === 1, `i: abandoned = 1 (got ${d.abandoned})`);
  ok(d.refunded === 1, `i: refunded = 1 (got ${d.refunded})`);
  ok(d.collected_cents === 2850, `i: collected_cents = 2850 (got ${d.collected_cents})`);
  ok(d.outstanding_cents === 6650 + 12000, `i: outstanding_cents = 18650 (got ${d.outstanding_cents})`);
  ok(typeof d.note === 'string' && /in person/.test(d.note) && /does not record in-person payments/.test(d.note), 'i: note explains outstanding');

  // Across the 4 Oct 2026 DST change (ACST +9:30 -> ACDT +10:30 at 2am)
  add('d_before', '2026-10-03T14:29:00.000Z', { paid: 1, dep: 2850, pi: 'pi_7', lc: 'deposit_paid' });            // 3rd 23:59 ACST - out
  add('d_start', '2026-10-03T14:31:00.000Z', { paid: 1, dep: 2850, pi: 'pi_8', lc: 'deposit_paid' });             // 4th 00:01 ACST - in
  add('d_end', '2026-10-04T13:29:00.000Z', { status: 'abandoned', pi: 'pi_9', lc: 'abandoned', reason: 'hold_lapsed' }); // 4th 23:59 ACDT - in
  add('d_after', '2026-10-04T13:31:00.000Z', { status: 'abandoned', pi: 'pi_10', lc: 'abandoned', reason: 'hold_lapsed' }); // 5th 00:01 ACDT - out (23:01 on a fixed +9:30)
  r = await w.admin('GET', '/api/admin/report?from=2026-10-04&to=2026-10-04');
  ok(r.data.started === 2 && r.data.deposits_paid === 1 && r.data.abandoned === 1 && r.data.collected_cents === 2850 && r.data.outstanding_cents === 6650,
    `i: DST day counts by the real Adelaide day (got ${JSON.stringify(r.data)})`);
  r = await w.admin('GET', '/api/admin/report?from=2026-10-03&to=2026-10-05');
  ok(r.data.started === 4 && r.data.abandoned === 2 && r.data.deposits_paid === 2, 'i: an inclusive range across the change includes all four');
  ok((await w.admin('GET', '/api/admin/report?from=2026-10-05&to=2026-10-03')).status === 400, 'i: from after to -> 400');
  ok((await w.call('GET', '/api/admin/report?from=2026-10-03&to=2026-10-05')).status === 401, 'i: report needs the admin token');
  const agg = w.internals.aggregateDepositReport([{ created_at: '2026-10-04T13:29:00.000Z', status: 'confirmed', deposit_paid: 1, deposit_cents: 2000, refunded_cents: 500 }],
    '2026-10-04', '2026-10-04', () => 95);
  ok(agg.collected_cents === 1500 && agg.outstanding_cents === 9500 - 1500, 'i: aggregateDepositReport nets refunds out of collected and outstanding');
}

// ---------------------------------------------------------------------------
// j. Adelaide time
// ---------------------------------------------------------------------------
async function groupJ() {
  {
    const w = await createWorld({ clock: T0 });
    const A = w.person('X');
    const co = await w.startCheckout(A);
    w.stripe.succeed(co.piId);
    await w.webhook(w.evt('payment_intent.succeeded', w.stripe.pi(co.piId)));
    const B = w.person('Y');
    const coB = await w.startCheckout(B, { date: '2026-10-05' });
    w.stripe.succeed(coB.piId);
    await w.webhook(w.evt('payment_intent.succeeded', w.stripe.pi(coB.piId)));
    await w.cron(at('2026-09-21T01:29:00.000Z')); // 10:59 ACST
    ok(w.row(co.data.checkout_id).lifecycle === 'deposit_paid', 'j: 10:59 Adelaide - an appointment ending 11:00 is not completed');
    await w.cron(at('2026-09-21T01:30:00.000Z')); // 11:00 ACST
    const a = w.row(co.data.checkout_id);
    ok(a.lifecycle === 'completed' && a.completed_at === at('2026-09-21T01:30:00.000Z'), 'j: 11:00 Adelaide - completed');
    await w.cron(at('2026-10-05T00:29:00.000Z')); // 10:59 ACDT
    ok(w.row(coB.data.checkout_id).lifecycle === 'deposit_paid', 'j: after DST, 10:59 ACDT - not completed');
    await w.cron(at('2026-10-05T00:30:00.000Z')); // 11:00 ACDT (10:00 on a fixed +9:30)
    ok(w.row(coB.data.checkout_id).lifecycle === 'completed', 'j: after DST, 11:00 ACDT - completed');
  }
  {
    // Tuesday 15 Sept 07:50 ACST
    const w = await createWorld({ clock: at('2026-09-14T22:20:00.000Z') });
    const A = w.person('Z');
    await failCheckout(w, A, { date: '2026-09-22' }, at('2026-09-14T22:20:00.000Z'));
    await w.cron(at('2026-09-14T22:29:00.000Z')); // 07:59
    ok(dropOffEmails(w, A.email).length === 0, 'j: 07:59 Adelaide - the due follow-up waits');
    await w.cron(at('2026-09-14T22:30:00.000Z')); // 08:00
    ok(dropOffEmails(w, A.email).length === 1, 'j: 08:00 Adelaide - it goes');
  }
  {
    // 19:50 ACST failure -> due 19:53, allowed at 19:59; 19:58 failure -> due 20:01, waits until 8am
    const w = await createWorld({ clock: at('2026-09-15T10:20:00.000Z') });
    const A = w.person('ZA');
    const B = w.person('ZB');
    await failCheckout(w, A, { date: '2026-09-22' }, at('2026-09-15T10:20:00.000Z'));
    await failCheckout(w, B, { date: '2026-09-22', start_min: 780 }, at('2026-09-15T10:28:00.000Z'));
    await w.cron(at('2026-09-15T10:29:00.000Z')); // 19:59
    ok(dropOffEmails(w, A.email).length === 1, 'j: 19:59 Adelaide - allowed');
    await w.cron(at('2026-09-15T10:31:00.000Z')); // 20:01
    ok(dropOffEmails(w, B.email).length === 0, 'j: 20:01 Adelaide - held back');
    await w.cron(at('2026-09-15T22:29:00.000Z')); // Wed 07:59
    ok(dropOffEmails(w, B.email).length === 0, 'j: still held at 07:59 next morning');
    await w.cron(at('2026-09-15T22:30:00.000Z')); // Wed 08:00
    ok(dropOffEmails(w, B.email).length === 1 && w.row(w.one("SELECT id FROM bookings WHERE email = ?", B.email).id).status === 'abandoned',
      'j: sent at 08:00 next morning (the hold had lapsed overnight)');
    const I = w.internals;
    ok(!I.isInFollowupEmailHours(479) && I.isInFollowupEmailHours(480) && I.isInFollowupEmailHours(1199) && !I.isInFollowupEmailHours(1200),
      'j: isInFollowupEmailHours boundaries');
    ok(I.nowInAdelaide(at('2026-09-14T22:30:00.000Z')).min === 480 && I.nowInAdelaide(at('2026-10-04T21:30:00.000Z')).min === 480,
      'j: nowInAdelaide gives 8:00am on both sides of DST');
  }
}

// ---------------------------------------------------------------------------
// k. Telegram firewall
// ---------------------------------------------------------------------------
async function groupK() {
  const w = await createWorld({ clock: T0, env: { TELEGRAM_BOT_TOKEN: '7000000001:NOT_THE_REVIVE_BOT' } });
  const L0 = logs.length;
  const ev = w.evt('payment_intent.succeeded', { id: 'pi_nomatch_k', object: 'payment_intent', amount: 2850, currency: 'aud', status: 'succeeded' });
  await w.webhook(ev);
  ok(w.calls.telegram.length === 0, 'k: a non-Revive bot token is refused - no Telegram request made');
  ok(logs.slice(L0).some(l => /telegram refused/.test(l)), 'k: the refusal is logged');
  ok(w.one('SELECT result FROM stripe_events WHERE id = ?', ev.id).result === 'unmatched', 'k: the event is still recorded');
  const w2 = await createWorld({ clock: T0 });
  await w2.webhook(w2.evt('payment_intent.succeeded', { id: 'pi_nomatch_k2', object: 'payment_intent', amount: 2850, currency: 'aud', status: 'succeeded' }));
  ok(w2.calls.telegram.length === 1 && w2.calls.telegram[0].url.startsWith('https://api.telegram.org/bot8882453395:'),
    'k: the @ReviveAdlBot token is used (positive control)');
}

// ---------------------------------------------------------------------------
// l. pending / abandoned rows stay out of everything that means "appointment"
// ---------------------------------------------------------------------------
async function groupL() {
  {
    const w = await createWorld({ clock: T0 });
    await w.admin('POST', '/api/admin/migrate');
    w.db.sqlite.prepare(`INSERT INTO bookings (id, treatment_id, date, start_min, end_min, name, phone, email, status, cancel_token, created_at, lifecycle, hold_until, stripe_payment_intent_id)
      VALUES ('rem_pending', 'lash-lift', '2026-09-15', 600, 660, 'Pending Pia', '0400000777', 'rem.pending@example.com', 'pending', 'tok', '2026-09-01T00:00:00.000Z', 'deposit_pending', ?, 'pi_x')`).run(T0 + 999 * MIN);
    w.db.sqlite.prepare(`INSERT INTO bookings (id, treatment_id, date, start_min, end_min, name, phone, email, status, cancel_token, created_at, lifecycle)
      VALUES ('rem_real', 'lash-lift', '2026-09-15', 720, 780, 'Real Rita', '0400000778', 'rem.real@example.com', 'confirmed', 'tok2', '2026-09-01T00:00:00.000Z', 'booked_no_deposit')`).run();
    await w.cron(T0); // 10:00 Adelaide: reminders run
    ok(w.emailsTo('rem.real@example.com').length === 1, 'l: reminders still go to a confirmed booking (positive control)');
    ok(w.emailsTo('rem.pending@example.com').length === 0, 'l: reminders ignore a pending checkout');

    const B = w.person('LB');
    await w.startCheckout(B, { date: '2026-09-22' });
    await w.cron(T0 + 30 * MIN); // B abandoned
    w.clock.now = T0 + 31 * MIN;
    const A = w.person('LA');
    const co = await w.startCheckout(A);
    let r = await w.admin('GET', '/api/admin/bookings?from=2026-09-14&to=2026-09-30');
    ok(r.status === 200 && r.data.bookings.map(x => x.id).join() === 'rem_real', 'l: the admin diary shows only real appointments');
    r = await w.admin('GET', '/api/admin/bookings?from=2026-09-14&to=2026-09-30&include=all');
    ok(r.data.bookings.length === 4, 'l: include=all shows pending and abandoned deliberately');
    r = await w.admin('GET', '/api/admin/clients');
    ok(r.data.clients.every(c => c.name === 'Real Rita'), 'l: the client list ignores checkouts');
    const held = w.row(co.data.checkout_id);
    r = await w.call('GET', `/api/booking?id=${held.id}&token=${held.cancel_token}`);
    ok(r.status === 404, 'l: a pending checkout has no manage-booking page');
    r = await w.call('POST', '/api/cancel', { id: held.id, token: held.cancel_token });
    ok(r.status === 404 && w.row(held.id).status === 'pending', 'l: ...and cannot be cancelled through the client link');
    r = await w.call('GET', '/api/feed.ics?key=' + w.env.ADMIN_TOKEN);
    ok(typeof r.data === 'string' && r.data.includes('Real Rita') && !r.data.includes(A.name), 'l: the calendar feed ignores checkouts');
    await w.admin('POST', '/api/admin/cancel', { id: held.id });
    ok(w.row(held.id).status === 'pending', 'l: admin cancel does not touch a pending checkout');
  }
  {
    const w = await createWorld({ clock: T0 });
    const A = w.person('LC');
    // cap counts confirmed bookings only
    const c1 = await w.startCheckout(A, { date: '2026-09-21' });
    const c2 = await w.startCheckout(A, { date: '2026-09-22' });
    const c3 = await w.startCheckout(A, { date: '2026-09-28' });
    ok(c1.status === 200 && c2.status === 200 && c3.status === 200, 'l: pending holds do not count toward the 2-booking cap');
    for (const c of [c1, c2]) { w.stripe.succeed(c.piId); await w.webhook(w.evt('payment_intent.succeeded', w.stripe.pi(c.piId))); }
    const c4 = await w.startCheckout(A, { date: '2026-09-29' });
    ok(c4.status === 429, 'l: two confirmed bookings -> the cap applies (positive control)');
  }
  {
    const w = await createWorld({ clock: T0 });
    const A = w.person('LD');
    const co = await failCheckout(w, A, {}, T0 + MIN);
    const again = await w.startCheckout(A); // e.g. from the email link: no checkout_id
    const old = w.row(co.data.checkout_id);
    ok(again.status === 200 && again.data.checkout_id !== co.data.checkout_id, 'l: her own failed hold does not block her new attempt at the same time');
    ok(old.status === 'abandoned' && old.abandoned_reason === 'superseded' && old.followed_up_at != null, 'l: the old attempt is superseded');
    await w.cron(T0 + 5 * MIN);
    ok(dropOffEmails(w, A.email).length === 0, 'l: a superseded attempt is never chased');
    // resume with checkout_id: same PaymentIntent, hold moves
    const creates = w.stripe.createCalls;
    const resumed = await w.startCheckout(A, { checkout_id: again.data.checkout_id, start_min: 720 }); // clear of 600 plus the 15-min buffer
    const moved = w.row(again.data.checkout_id);
    ok(resumed.status === 200 && resumed.data.checkout_id === again.data.checkout_id && w.stripe.createCalls === creates &&
       resumed.data.client_secret === w.stripe.pi(again.piId).client_secret && moved.start_min === 720 && moved.hold_until === w.clock.now + 30 * MIN,
      'l: Back + Continue reuses the same PaymentIntent and moves the hold');
    ok((await slotsOn(w, '2026-09-21')).includes(600), 'l: ...and the time she left is free again');
  }
  {
    const w = await createWorld({ clock: T0 });
    w.stripe.createFails = true;
    const A = w.person('LE');
    const r = await w.startCheckout(A);
    ok(r.status === 502, 'l: Stripe refusing the PaymentIntent -> 502');
    const row = w.one('SELECT * FROM bookings WHERE email = ?', A.email);
    ok(row && row.status === 'pending' && row.lifecycle === 'started' && row.hold_until <= w.clock.now, 'l: ...its hold is released at once');
    await w.cron(T0 + MIN);
    ok(w.row(row.id).status === 'abandoned' && w.telegramsMatching(/payment step never opened/).length === 1, 'l: ...and Stefani hears about it from the cron');
  }
}

// ---------------------------------------------------------------------------
(async () => {
  const groups = [['a', groupA], ['b', groupB], ['c', groupC], ['d', groupD], ['e', groupE], ['f', groupF],
    ['g', groupG], ['h', groupH], ['i', groupI], ['j', groupJ], ['k', groupK], ['l', groupL]];
  for (const [name, fn] of groups) {
    try { await fn(); } catch (e) { fails.push(`group ${name} threw: ${e && e.stack || e}`); }
  }
  console.log('\n' + pass + ' passed, ' + fails.length + ' failed');
  if (fails.length) { fails.forEach(f => console.log('  FAIL  ' + f)); process.exit(1); }
  console.log('stripe lifecycle OK');
})();
