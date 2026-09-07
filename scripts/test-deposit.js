/**
 * Revive Aesthetics - tests for the 30% booking deposit.
 *
 * Run: node scripts/test-deposit.js
 *
 * This guards real money, so it tests the two things that actually cost something
 * if they break:
 *   1. the AMOUNT is right (30%, capped at $50, $0 for a free consultation)
 *   2. the amount is decided by the SERVER and cannot be influenced by the browser
 *
 * The worker is a Cloudflare module and cannot be require()d, so the helpers are
 * extracted textually and executed for real. Never require() the worker.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const WORKER = fs.readFileSync(path.join(ROOT, 'worker', 'src', 'index.js'), 'utf8');
const BOOK = fs.readFileSync(path.join(ROOT, 'book.html'), 'utf8');

let pass = 0;
const fails = [];
function ok(cond, label) { if (cond) pass++; else fails.push(label); }

function extract(sig) {
  const re = new RegExp('function ' + sig + '\\([\\s\\S]*?\\n\\}');
  const m = WORKER.match(re);
  if (!m) throw new Error('could not extract ' + sig + ' from the worker');
  return m[0];
}

// ---------------------------------------------------------------------------
// 1. The amount
// ---------------------------------------------------------------------------
{
  const src = extract('depositCentsFor') + '\n' +
    (WORKER.match(/const DEPOSIT_PCT = \d+;/) || [''])[0] + '\n' +
    (WORKER.match(/const DEPOSIT_CAP_CENTS = \d+;/) || [''])[0];
  const dep = new Function(src + '; return depositCentsFor;')();

  ok(dep(95) === 2850, 'lash lift $95 -> $28.50');
  ok(dep(70) === 2100, 'lash lift intro $70 -> $21.00');
  ok(dep(99) === 2970, 'lymphatic $99 -> $29.70');
  ok(dep(299) === 5000, 'microneedling $299 -> capped at $50 (30% would be $89.70)');
  ok(dep(115) === 3450, '$115 (lash lift + LED add-on) -> $34.50');

  // A free consultation must take NOTHING - there is nothing to take 30% of, and
  // demanding a card for a $0 appointment would kill the easiest booking she has.
  // NOTE: this assertion does NOT discriminate on its own - 30% of $0 is $0 by
  // arithmetic, so it passes whether or not the `p <= 0` guard exists. The guard's
  // real job is stopping NEGATIVE amounts (a mistyped price in D1), which is what
  // the -50 case and the invariant below actually catch. Kept because it documents
  // the intended behaviour, not because it proves it.
  ok(dep(0) === 0, 'free consultation -> no deposit');

  // Junk must never become a charge.
  ok(dep(-50) === 0, 'negative price -> no deposit');
  ok(dep(null) === 0, 'null price -> no deposit');
  ok(dep(undefined) === 0, 'undefined price -> no deposit');
  ok(dep('abc') === 0, 'non-numeric price -> no deposit');
  ok(dep(NaN) === 0, 'NaN price -> no deposit');
  ok(dep(Infinity) === 0, 'Infinity price -> no deposit');

  // Rounding must land on whole cents - Stripe rejects fractional amounts.
  for (const p of [33, 66.66, 99.99, 1, 0.5, 150.05]) {
    ok(Number.isInteger(dep(p)), 'whole cents for $' + p + ' (got ' + dep(p) + ')');
  }
  ok(dep(0.5) === 15, '$0.50 -> 15 cents, still an integer');

  // The invariant that actually matters, and the one the `p <= 0` guard exists for:
  // NO input may ever produce a negative charge. A mistyped price in D1 (a stray
  // minus on an admin price edit) must not turn into a refund-shaped charge.
  const inputs = [0, -0.01, -1, -95, -1e9, null, undefined, NaN, Infinity, -Infinity,
                  'abc', '', '-95', {}, [], true, false];
  ok(inputs.every(v => dep(v) >= 0), 'no input can ever produce a negative deposit');
  ok(inputs.every(v => Number.isInteger(dep(v))), 'no input can produce a fractional deposit');
  ok(dep('-95') === 0, 'a negative price as a STRING is still refused');

  // The cap must bind at exactly the right place: 30% hits $50 at $166.67.
  ok(dep(166) === 4980, '$166 -> $49.80, just under the cap');
  ok(dep(167) === 5000, '$167 -> capped');
  ok(dep(100000) === 5000, 'absurd price -> still capped at $50');
}

// ---------------------------------------------------------------------------
// 2. The total the percentage is taken from
// ---------------------------------------------------------------------------
{
  const total = new Function(extract('totalPriceAud') + '; return totalPriceAud;')();
  ok(total({ price_aud: 95 }, []) === 95, 'treatment alone');
  ok(total({ price_aud: 95 }, [{ price_aud: 20 }]) === 115, 'treatment + LED add-on');
  ok(total({ price_aud: 95 }, [{ price_aud: 20 }, { price_aud: 15 }]) === 130, 'treatment + two add-ons');
  ok(total({ price_aud: 0 }, [{ price_aud: 0 }]) === 0, 'free treatment + free add-on = 0');
  ok(total(null, null) === 0, 'missing treatment does not throw');
  ok(total({ price_aud: 95 }, [{}]) === 95, 'add-on with no price is treated as free, not NaN');
}

// ---------------------------------------------------------------------------
// 3. Server authority - the browser must never be able to name the amount
// ---------------------------------------------------------------------------
{
  // /api/create-payment-intent must price from D1, not from the request body.
  const pi = WORKER.slice(WORKER.indexOf("path === '/api/create-payment-intent'"));
  const piBlock = pi.slice(0, pi.indexOf("if (path === '/api/book'"));
  ok(/SELECT \* FROM treatments WHERE id = \? AND active = 1/.test(piBlock),
    'create-payment-intent looks the treatment up in D1');
  ok(/depositCentsFor\(totalPriceAud\(/.test(piBlock),
    'create-payment-intent derives the amount from the D1 rows');
  ok(/params\.set\('amount', String\(depositCents\)\)/.test(piBlock),
    'create-payment-intent charges the derived amount');
  ok(!/params\.set\('amount', String\(body\./.test(piBlock) && !/body\.amount/.test(piBlock),
    'create-payment-intent NEVER reads an amount from the request body');

  // /api/book must re-derive and compare, not trust.
  const bk = WORKER.slice(WORKER.indexOf("path === '/api/book' && req.method === 'POST'"));
  const bkBlock = bk.slice(0, bk.indexOf('// ---------- admin routes'));
  ok(/const depositCents = depositCentsFor\(price\);/.test(bkBlock),
    '/api/book recomputes the expected deposit from its own price figure');
  ok(/pi\.amount !== depositCents/.test(bkBlock),
    '/api/book verifies the paid amount against the recomputed figure');
  ok(!/pi\.amount !== DEPOSIT_CENTS/.test(WORKER),
    'the old flat $25 constant is no longer used for verification');
  ok(!/const DEPOSIT_CENTS = /.test(WORKER),
    'the flat DEPOSIT_CENTS constant is gone entirely');
  ok(/pi\.currency !== 'aud'/.test(bkBlock), '/api/book still checks the currency');
  ok(/pi\.status !== 'succeeded'/.test(bkBlock), '/api/book still requires a succeeded payment');

  // A paid booking with no payment intent must be refused outright, or the whole
  // deposit step can be skipped by POSTing straight to the API.
  ok(/error: 'deposit_required'/.test(bkBlock),
    '/api/book refuses a payable booking that arrives with no deposit');
  ok(/depositCents > 0 && env\.STRIPE_SECRET_KEY && !pid/.test(bkBlock),
    'the refusal is gated on a deposit being owed AND payments working');

  // Graceful degradation: if Stripe is misconfigured, take the booking rather
  // than lose it. Silence costs more than a missing deposit.
  ok(/env\.STRIPE_SECRET_KEY && !pid/.test(bkBlock),
    'no Stripe key configured => booking still allowed (fails open, not shut)');

  // The amount taken is recorded, so a refund can be made correctly.
  ok(/deposit_cents\)/.test(bkBlock) && /depositPaidCents\)\.run\(\)/.test(bkBlock),
    'the amount actually taken is stored on the booking');
  ok(/ALTER TABLE bookings ADD COLUMN deposit_cents INTEGER DEFAULT 0/.test(WORKER),
    'the deposit_cents column is created by migrate');
}

// ---------------------------------------------------------------------------
// 4. The booking page
// ---------------------------------------------------------------------------
{
  ok(/if \(hasDeposit\(\)\) \{ goToDeposit\(\); return; \}/.test(BOOK),
    'step 3 routes a payable booking to the deposit step (it was bypassed before)');
  ok(/function hasDeposit\(\)/.test(BOOK), 'hasDeposit() exists');

  // The page must NOT carry a second copy of the 30% rule or the cap.
  ok(!/0\.3\b/.test(BOOK) && !/\* 30\b/.test(BOOK) && !/DEPOSIT_PCT/.test(BOOK),
    'book.html contains no copy of the 30% calculation');
  ok(!/5000/.test(BOOK.replace(/[\d.]+s|z-index[^;]*;/g, '')) || !/DEPOSIT_CAP/.test(BOOK),
    'book.html contains no copy of the $50 cap');
  ok(/state\.depositCents = r\.data\.deposit_cents/.test(BOOK),
    'the page displays the amount the SERVER returned');
  ok(/treatment: state\.formData\.treatment/.test(BOOK) && /addons: state\.formData\.addons/.test(BOOK),
    'the page sends treatment + add-ons so the worker can price it');
  ok(!/body: JSON\.stringify\(\{[^}]*amount/.test(BOOK),
    'the page never sends an amount to the server');

  // No stale hardcoded $25 anywhere.
  ok(!/\$25/.test(BOOK), 'no hardcoded $25 left in book.html');
  ok(/btn\.textContent = payLabel;/.test(BOOK), 'the pay button label is dynamic');

  // The terms must be shown AND actively agreed to.
  ok(/id="dep-agree"/.test(BOOK), 'there is an agree checkbox');
  ok(/if \(!\$\('dep-agree'\)\.checked\)/.test(BOOK),
    'the payment is blocked until the terms are agreed');
  const agreeAt = BOOK.indexOf("if (!$('dep-agree').checked)");
  const chargeAt = BOOK.indexOf('confirmCardPayment');
  ok(agreeAt !== -1 && chargeAt !== -1 && agreeAt < chargeAt,
    'the agreement is checked BEFORE the card is charged');
  ok(/48 hours/.test(BOOK) && /24 hours/.test(BOOK),
    'the 48h / 24h policy is visible on the page');

  ok((BOOK.match(/[‘’“”]/g) || []).length === 0, 'no curly quotes in book.html');
}

// ---------------------------------------------------------------------------
// 5. The policy travels with the booking
// ---------------------------------------------------------------------------
{
  ok(/const CANCELLATION_POLICY =/.test(WORKER), 'the policy has one definition in the worker');
  ok((WORKER.match(/CANCELLATION_POLICY/g) || []).length >= 3,
    'the policy is reused (payment intent response + confirmation email), not retyped');
  ok(/48 hours/.test(WORKER) && /24 hours/.test(WORKER),
    'the worker policy states both notice periods');
  ok(!/\$25 deposit has been received/.test(WORKER),
    'the confirmation email no longer hardcodes $25');
  ok(/depositLabel/.test(WORKER) && /balanceLabel/.test(WORKER),
    'the confirmation email shows the real amount and the balance');
}

console.log('\n' + pass + ' passed, ' + fails.length + ' failed');
if (fails.length) { fails.forEach(f => console.log('  FAIL  ' + f)); process.exit(1); }
console.log('deposit OK');
