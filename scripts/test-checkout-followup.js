/**
 * Revive Aesthetics - the deposit-step protections, re-proven on the hold/lifecycle design (2026-09-14).
 *
 * Run: node scripts/test-checkout-followup.js
 *
 * Guards what costs real money or a real customer if it breaks:
 *   1. slot + 2-booking cap are checked BEFORE a Stripe PaymentIntent is created
 *   2. a paid deposit that cannot be booked is REFUNDED and Stefani is told
 *   3. the drop-off follow-up: one email per checkout, one per address per 7 days,
 *      8am-8pm Adelaide only, the approved copy with no offer or discount
 *
 * Executes the real worker (scripts/lib/revive-worker-harness.js). The lifecycle, webhook and
 * abandonment behaviour lives in test-stripe-lifecycle.js. REVIVE_WORKER_FILE overrides the path.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { createWorld, at } = require('./lib/revive-worker-harness');

const WORKER = fs.readFileSync(process.env.REVIVE_WORKER_FILE || path.join(__dirname, '..', 'worker', 'src', 'index.js'), 'utf8');

let pass = 0;
const fails = [];
function ok(cond, label) { if (cond) pass++; else fails.push(label); }

const MIN = 60000;
const T0 = at('2026-09-14T00:30:00.000Z'); // Monday 10:00am ACST
const dropOffs = (w, email) => w.emailsTo(email).filter(m => /isn't confirmed yet$/.test(m.subject));

async function failCheckout(w, who, over, failAt) {
  const co = await w.startCheckout(who, over);
  w.clock.now = failAt;
  w.stripe.fail(co.piId, 'Your card was declined.');
  await w.webhook(w.evt('payment_intent.payment_failed', w.stripe.pi(co.piId)));
  return co;
}

// ---------------------------------------------------------------------------
// 1. nothing touches Stripe until slot + cap have passed
// ---------------------------------------------------------------------------
async function part1() {
  const s = WORKER.indexOf("path === '/api/create-payment-intent'");
  const piBlock = s === -1 ? '' : WORKER.slice(s, WORKER.indexOf("if (path === '/api/book'", s));
  const blockerAt = piBlock.indexOf('await bookingBlocker(');
  const blockerReturn = piBlock.indexOf('if (blocker) return json({ error: blocker.error }, blocker.status, cors);');
  const insertAt = piBlock.indexOf('INSERT INTO bookings');
  const createAt = piBlock.indexOf("fetch('https://api.stripe.com/v1/payment_intents', {");
  const readAt = piBlock.indexOf('stripeGetPaymentIntent(');
  ok(blockerAt !== -1 && createAt !== -1 && blockerAt < createAt && blockerReturn !== -1 && blockerReturn < createAt,
    '1: slot + cap are checked BEFORE the Stripe payment_intents POST (source order)');
  ok(readAt === -1 || blockerAt < readAt, '1: ...and before even reading an existing PaymentIntent');
  ok(insertAt !== -1 && blockerAt < insertAt && insertAt < createAt, '1: the hold row is written after the check and before the PaymentIntent');

  const w = await createWorld({ clock: T0 });
  const A = w.person('A');
  for (const [over, err] of [[{ name: 'A' }, 'name_required'], [{ phone: '123' }, 'phone_required'], [{ email: '' }, 'email_required'],
    [{ email: 'nope' }, 'bad_email'], [{ date: 'soon' }, 'bad_slot']]) {
    const r = await w.startCheckout(A, over);
    ok(r.status === 400 && r.data.error === err, `1: ${err} refused`);
  }
  await w.admin('POST', '/api/admin/book', { date: '2026-09-21', start_min: 600, end_min: 660, name: 'Taken' });
  let r = await w.startCheckout(A);
  ok(r.status === 409 && r.data.error === 'slot_unavailable', '1: a taken slot -> 409');
  const B = w.person('B');
  await w.startCheckout(B, { start_min: 780 });
  r = await w.startCheckout(A, { start_min: 780 });
  ok(r.status === 409, "1: someone else's live hold -> 409");
  const ins = w.db.sqlite.prepare(`INSERT INTO bookings (id, treatment_id, date, start_min, end_min, name, phone, email, status, cancel_token, created_at, lifecycle)
    VALUES (?, 'lash-lift', ?, 600, 660, 'Cap', ?, '', 'confirmed', 't', '2026-09-01T00:00:00.000Z', 'booked_no_deposit')`);
  ins.run('cap1', '2026-09-28', A.phone);
  ins.run('cap2', '2026-09-29', A.phone);
  r = await w.startCheckout(A, { date: '2026-10-05' });
  ok(r.status === 429 && r.data.error === 'too_many_bookings', '1: at the 2-booking cap -> 429');
  ok(w.stripe.createCalls === 1 && w.stripe.getCalls === 0, '1: none of the refusals created or read a PaymentIntent (the one call is B\'s hold)');
}

// ---------------------------------------------------------------------------
// 2. paid but unbookable => refund + Stefani told
// ---------------------------------------------------------------------------
async function part2() {
  {
    // Legacy path: a paid PaymentIntent with no checkout row, at a taken slot.
    const w = await createWorld({ clock: T0 });
    const A = w.person('C');
    await w.admin('POST', '/api/admin/book', { date: '2026-09-21', start_min: 600, end_min: 660, name: 'Taken' });
    w.stripe.add({ id: 'pi_paid_1', amount: 2850, status: 'succeeded' });
    const body = { treatment: 'lash-lift', date: '2026-09-21', start_min: 600, name: A.name, phone: A.phone, email: A.email, payment_intent_id: 'pi_paid_1' };
    let r = await w.call('POST', '/api/book', body);
    ok(r.status === 409 && r.data.error === 'slot_unavailable' && r.data.refunded === true, '2: paid + slot taken -> 409 with refunded: true');
    ok(w.stripe.refunds.length === 1 && w.stripe.refunds[0].pi === 'pi_paid_1' && w.stripe.refunds[0].idempotencyKey === 'revive-refund-pi_paid_1',
      '2: refund POSTed for that payment with an idempotency key');
    ok(w.telegramsMatching(/refunded automatically/).length === 1, '2: Stefani told the refund went through');

    w.stripe.refundFails = true;
    w.stripe.add({ id: 'pi_paid_2', amount: 2850, status: 'succeeded' });
    r = await w.call('POST', '/api/book', Object.assign({}, body, { payment_intent_id: 'pi_paid_2' }));
    ok(r.status === 409 && r.data.refunded === false, '2: a failed refund reports refunded: false');
    ok(w.telegramsMatching(/refund it in Stripe/i).length === 1, '2: ...and Stefani is told plainly to refund it in Stripe');
    w.stripe.refundFails = false;

    w.stripe.add({ id: 'pi_unpaid', amount: 2850, status: 'requires_payment_method' });
    const n = w.stripe.refunds.length;
    r = await w.call('POST', '/api/book', Object.assign({}, body, { payment_intent_id: 'pi_unpaid' }));
    ok(r.status === 409 && w.stripe.refunds.length === n, '2: an unpaid PaymentIntent is never refunded');

    // Replay guard: a payment that already belongs to a confirmed booking.
    w.stripe.add({ id: 'pi_used', amount: 2850, status: 'succeeded' });
    const ok1 = await w.call('POST', '/api/book', Object.assign({}, body, { start_min: 720, payment_intent_id: 'pi_used' }));
    const replay = await w.call('POST', '/api/book', Object.assign({}, body, { payment_intent_id: 'pi_used' }));
    ok(ok1.status === 200 && replay.status === 200 && replay.data.id === ok1.data.id && w.stripe.refunds.length === n,
      '2: replaying a booked payment at a taken slot refunds nothing (it returns the booking it paid for)');

    // Cap.
    const P = w.person('D');
    const ins = w.db.sqlite.prepare(`INSERT INTO bookings (id, treatment_id, date, start_min, end_min, name, phone, email, status, cancel_token, created_at, lifecycle)
      VALUES (?, 'lash-lift', ?, 600, 660, 'Cap', ?, '', 'confirmed', 't', '2026-09-01T00:00:00.000Z', 'booked_no_deposit')`);
    ins.run('capd1', '2026-09-28', P.phone);
    ins.run('capd2', '2026-09-29', P.phone);
    w.stripe.add({ id: 'pi_cap', amount: 2850, status: 'succeeded' });
    r = await w.call('POST', '/api/book', { treatment: 'lash-lift', date: '2026-10-05', start_min: 600, name: P.name, phone: P.phone, email: P.email, payment_intent_id: 'pi_cap' });
    ok(r.status === 429 && r.data.error === 'too_many_bookings' && r.data.refunded === true, '2: paid + over the cap -> 429 with refunded: true');
  }
  {
    // Checkout path: the held row's time went, then the card was charged.
    const w = await createWorld({ clock: T0 });
    const A = w.person('E');
    const co = await w.startCheckout(A);
    await w.cron(T0 + 30 * MIN);
    w.clock.now = T0 + 31 * MIN;
    await w.admin('POST', '/api/admin/book', { date: '2026-09-21', start_min: 600, end_min: 660, name: 'Taken' });
    w.stripe.succeed(co.piId);
    const r = await w.browserBook(co);
    ok(r.status === 409 && r.data.refunded === true && w.stripe.refunds.length === 1 && w.row(co.data.checkout_id).lifecycle === 'refunded',
      '2: checkout path - paid after the slot went -> refunded, recorded, 409 refunded: true');
    ok(w.telegramsMatching(/Deposit refunded — booking could not be made/).length === 1, '2: checkout path - Stefani told');
  }
}

// ---------------------------------------------------------------------------
// 3. the follow-up
// ---------------------------------------------------------------------------
async function part3() {
  ok(/const HOLD_MIN = 30;/.test(WORKER), '3: holds last 30 minutes');
  ok(/const FOLLOWUP_DELAY_MS = 3 \* 60000;/.test(WORKER), '3: the follow-up waits 3 minutes after the drop-off');
  ok(/const FOLLOWUP_EMAIL_FROM_MIN = 8 \* 60;/.test(WORKER) && /const FOLLOWUP_EMAIL_TO_MIN = 20 \* 60;/.test(WORKER), '3: emails 8am-8pm only');
  ok(/const FOLLOWUP_EMAIL_PER_ADDRESS_DAYS = 7;/.test(WORKER), '3: one follow-up per address per 7 days');
  ok(/crons = \["\* \* \* \* \*"\]/.test(fs.readFileSync(path.join(__dirname, '..', 'worker', 'wrangler.toml'), 'utf8')), '3: the cron runs every minute');

  {
    // The copy, on the happy path.
    const w = await createWorld({ clock: T0 });
    const A = w.person('F');
    const co = await failCheckout(w, A, { addons: ['led'] }, T0 + MIN);
    await w.cron(T0 + 4 * MIN);
    const mails = dropOffs(w, A.email);
    ok(mails.length === 1, '3: a drop-off gets ONE follow-up email');
    const e = mails[0] || { html: '', subject: '', to: '' };
    ok(e.to === A.email, '3: to the checkout address');
    ok(e.subject === "Your Lash Lift booking isn't confirmed yet", '3: subject line is exactly the approved copy');
    ok(/Finish my booking/.test(e.html), '3: Finish my booking button');
    ok(e.html.includes('https://reviveaestheticsadl.com.au/book.html?t=lash-lift&amp;a=led&amp;d=2026-09-21&amp;m=600'),
      '3: Finish link carries treatment, add-ons, date and start minute');
    ok(/It looks like your booking for Lash Lift \+ LED Light Therapy on Monday 21 September at 10:00am didn't quite go through, so it isn't confirmed yet\./.test(e.html),
      '3: body uses the approved wording');
    ok(/Your \$36\.00 deposit holds the time for you and comes straight off your total on the day\./.test(e.html), '3: states the real deposit amount');
    ok(/0404 967 051/.test(e.html) && /Stefani/.test(e.html) && /Revive Aesthetics/.test(e.html), '3: signed by Stefani with her number');
    ok(new RegExp('Hi ' + A.name.split(' ')[0] + ',').test(e.html), '3: greets by first name');
    const text = e.html.replace(/style="[^"]*"/g, '').replace(/<[^>]+>/g, ' ');
    ok(!/%/.test(text) && !/\b(discount|% off|save|offer|promo|coupon|free)\b/i.test(text), '3: no discount or offer');
    for (let i = 5; i <= 12; i++) await w.cron(T0 + i * MIN);
    await w.internals.followupBackstopSweep(w.env, T0 + 13 * MIN);
    ok(dropOffs(w, A.email).length === 1, '3: never a second email for the same checkout');
    await w.cron(T0 + 30 * MIN);
    const tg = w.telegramsMatching(/Didn't finish booking/);
    ok(tg.length === 1 && tg[0].body.text.includes(A.name) && tg[0].body.text.includes(A.phone) && /Lash Lift \+ LED Light Therapy/.test(tg[0].body.text) &&
       /Your card was declined\./.test(tg[0].body.text), '3: Stefani is told who, what, and the decline reason when the hold lapses');
    ok(w.row(co.data.checkout_id).status === 'abandoned', '3: (abandoned)');
  }
  {
    // Slot taken => the see-available-times variant with no date/time in the link.
    const w = await createWorld({ clock: T0 });
    const A = w.person('G');
    await failCheckout(w, A, { addons: ['led'] }, T0 + MIN);
    await w.admin('POST', '/api/admin/book', { date: '2026-09-21', start_min: 600, end_min: 660, name: 'Walk-in' });
    await w.cron(T0 + 4 * MIN);
    const h = (dropOffs(w, A.email)[0] || {}).html || '';
    ok(/That time has since been taken, but there are other times available:/.test(h) && /See available times/.test(h), '3: a taken slot gets the see-available-times variant');
    ok(!/Finish my booking/.test(h) && h.includes('book.html?t=lash-lift&amp;a=led"'), '3: ...linking without date/time');
  }
  {
    // 7-day per-address cap.
    const w = await createWorld({ clock: T0 });
    const A = w.person('H');
    await failCheckout(w, A, {}, T0 + MIN);
    await w.cron(T0 + 4 * MIN);
    const second = await failCheckout(w, A, { date: '2026-09-22' }, T0 + 10 * MIN);
    await w.cron(T0 + 13 * MIN);
    ok(dropOffs(w, A.email).length === 1 && w.row(second.data.checkout_id).followup_result === 'skipped_recent_email',
      '3: no second follow-up to the same address inside 7 days');
  }
  {
    // 8am-8pm boundaries, via the dispatcher at exact instants.
    const at730 = at('2026-09-13T22:00:00.000Z'); // Mon 07:30 ACST
    const cases = [['2026-09-13T22:29:00.000Z', 0, '7:59am'], ['2026-09-13T22:30:00.000Z', 1, '8:00am'],
      ['2026-09-14T10:29:00.000Z', 1, '7:59pm'], ['2026-09-14T10:30:00.000Z', 0, '8:00pm']];
    for (const [iso, want, label] of cases) {
      const w = await createWorld({ clock: at730 });
      const A = w.person('I');
      const failAt = at(iso) - 5 * MIN;
      await failCheckout(w, A, {}, Math.max(failAt, at730));
      await w.internals.dispatchDueFollowups(w.env, at(iso));
      ok(dropOffs(w, A.email).length === want, `3: ${want ? 'email allowed' : 'no email'} at ${label} Adelaide`);
    }
  }
  {
    // Booked since, at the cap, no email address.
    const w = await createWorld({ clock: T0 });
    const A = w.person('J');
    const co = await failCheckout(w, A, {}, T0 + MIN);
    const other = await w.startCheckout(A, { date: '2026-09-22' });
    w.stripe.succeed(other.piId);
    await w.webhook(w.evt('payment_intent.succeeded', w.stripe.pi(other.piId)));
    await w.cron(T0 + 4 * MIN);
    ok(dropOffs(w, A.email).length === 0 && w.row(co.data.checkout_id).followup_result === 'skipped_booked_since', '3: someone who booked since is never chased');

    const B = w.person('K');
    const coB = await failCheckout(w, B, { date: '2026-09-28' }, T0 + 5 * MIN);
    const ins = w.db.sqlite.prepare(`INSERT INTO bookings (id, treatment_id, date, start_min, end_min, name, phone, email, status, cancel_token, created_at, lifecycle)
      VALUES (?, 'lash-lift', ?, 720, 780, 'Cap', ?, '', 'confirmed', 't', '2026-09-01T00:00:00.000Z', 'booked_no_deposit')`);
    ins.run('capk1', '2026-10-05', B.phone);
    ins.run('capk2', '2026-10-06', B.phone);
    await w.cron(T0 + 8 * MIN);
    ok(dropOffs(w, B.email).length === 0 && w.row(coB.data.checkout_id).followup_result === 'skipped_at_cap', '3: no follow-up to someone at the 2-booking cap');

    const C = w.person('L');
    const coC = await failCheckout(w, C, { date: '2026-09-29' }, T0 + 9 * MIN);
    w.db.sqlite.prepare("UPDATE bookings SET email = '' WHERE id = ?").run(coC.data.checkout_id);
    await w.cron(T0 + 12 * MIN);
    ok(w.row(coC.data.checkout_id).followup_result === 'skipped_no_email', '3: no email address -> nothing sent, recorded');
  }
}

(async () => {
  for (const [name, fn] of [['part1', part1], ['part2', part2], ['part3', part3]]) {
    try { await fn(); } catch (e) { fails.push(name + ' threw: ' + (e && e.stack || e)); }
  }
  console.log('\n' + pass + ' passed, ' + fails.length + ' failed');
  if (fails.length) { fails.forEach(f => console.log('  FAIL  ' + f)); process.exit(1); }
  console.log('checkout follow-up OK');
})();
