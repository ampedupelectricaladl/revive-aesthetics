/**
 * Revive Aesthetics - tests for assets/tracking.js and the pixel call sites.
 *
 * Run: node scripts/test-tracking.js
 *
 * Tests BOTH directions, which is the whole point:
 *   - disabled (no pixel id)  -> loads nothing, sends nothing, still safe to call
 *   - enabled  (pixel id set) -> actually injects and actually fires
 *   - blocked pages           -> stay silent even WITH a pixel id
 * A tracking file only ever shown to be quiet proves nothing about whether it
 * works, and one only shown to fire proves nothing about whether it is safe.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const TRACKING = path.join(ROOT, 'assets', 'tracking.js');

let pass = 0;
const fails = [];

function ok(cond, label) {
  if (cond) { pass++; } else { fails.push(label); }
}

/**
 * Load tracking.js in a throwaway fake DOM.
 * Returns what it tried to do, so we can assert on real behaviour rather than
 * on the presence of source strings.
 */
function loadTracking({ pixelId, pathname }) {
  let src = fs.readFileSync(TRACKING, 'utf8');
  if (pixelId !== undefined) {
    const before = src;
    src = src.replace(/var PIXEL_ID = '[^']*';/, "var PIXEL_ID = '" + pixelId + "';");
    if (src === before) throw new Error('could not substitute PIXEL_ID - has the line changed?');
  }

  const injected = [];
  const fbqCalls = [];

  const win = {};
  win.window = win;
  win.location = { pathname };
  win.document = {
    createElement: () => {
      const el = {};
      injected.push(el);
      return el;
    },
    getElementsByTagName: () => [{ parentNode: { insertBefore: () => {} } }]
  };

  // Run the IIFE with `window`/`document`/`location` bound to our fake page.
  new Function('window', 'document', 'location', src)(win, win.document, win.location);

  // Stand in for the real fbevents.js having loaded.
  if (win.fbq) {
    const queued = (win.fbq.queue || []).slice();
    win.fbq = (...args) => fbqCalls.push(args);
    queued.forEach((a) => fbqCalls.push(Array.from(a)));
  }

  return { win, injected, fbqCalls, track: win.reviveTrack };
}

// ---------------------------------------------------------------------------
// 1. Disabled by default
// ---------------------------------------------------------------------------
{
  const src = fs.readFileSync(TRACKING, 'utf8');
  ok(/var PIXEL_ID = '';/.test(src),
    'tracking.js ships with an EMPTY pixel id (never commit a live id by accident)');

  const r = loadTracking({ pathname: '/book.html' });
  ok(r.injected.length === 0, 'disabled: injects no script tag');
  ok(typeof r.track === 'function', 'disabled: reviveTrack is still defined');
  let threw = false;
  try { r.track('Schedule', { value: 95, currency: 'AUD' }); } catch (e) { threw = true; }
  ok(!threw, 'disabled: calling reviveTrack does not throw');
  ok(r.fbqCalls.length === 0, 'disabled: sends no events');
}

// ---------------------------------------------------------------------------
// 2. Enabled - it must actually work
// ---------------------------------------------------------------------------
{
  const r = loadTracking({ pixelId: '123456789012345', pathname: '/book.html' });
  ok(r.injected.length === 1, 'enabled: injects exactly one script tag');
  const inits = r.fbqCalls.filter((c) => c[0] === 'init');
  const views = r.fbqCalls.filter((c) => c[0] === 'track' && c[1] === 'PageView');
  ok(inits.length === 1 && inits[0][1] === '123456789012345', 'enabled: inits with the pixel id');
  ok(views.length === 1, 'enabled: fires exactly one PageView');

  r.track('Schedule', { value: 95, currency: 'AUD' });
  const sched = r.fbqCalls.filter((c) => c[1] === 'Schedule');
  ok(sched.length === 1, 'enabled: reviveTrack forwards Schedule to fbq');
  ok(sched[0] && sched[0][2] && sched[0][2].value === 95 && sched[0][2].currency === 'AUD',
    'enabled: Schedule carries value + currency');
}

// ---------------------------------------------------------------------------
// 3. Blocked pages stay silent even WITH a pixel id
//    These collect medical history or are Stefani's admin tooling.
// ---------------------------------------------------------------------------
for (const p of ['/admin.html', '/intake.html', '/face-consent.html', '/pdrn-consent.html',
                 '/lash-consent.html', '/body-consent.html', '/lash-survey.html',
                 '/microneedling-prep.html']) {
  const r = loadTracking({ pixelId: '123456789012345', pathname: p });
  ok(r.injected.length === 0 && r.fbqCalls.length === 0, 'blocked page stays silent: ' + p);
  ok(typeof r.track === 'function', 'blocked page still defines reviveTrack: ' + p);
}

// ...and the pages we DO want tracked are not accidentally blocked.
for (const p of ['/', '/index.html', '/book.html']) {
  const r = loadTracking({ pixelId: '123456789012345', pathname: p });
  ok(r.injected.length === 1, 'tracked page fires: ' + p);
}

// ---------------------------------------------------------------------------
// 4. The call sites in book.html
// ---------------------------------------------------------------------------
{
  const book = fs.readFileSync(path.join(ROOT, 'book.html'), 'utf8');
  const index = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

  ok(/<script src="assets\/tracking\.js" defer><\/script>/.test(book),
    'book.html includes tracking.js');
  ok(/<script src="assets\/tracking\.js" defer><\/script>/.test(index),
    'index.html includes tracking.js');

  ok((book.match(/reviveTrack\('Schedule'/g) || []).length === 1,
    'exactly ONE Schedule call site (both booking paths funnel through showBookingSuccess)');
  ok((book.match(/reviveTrack\('ViewContent'/g) || []).length === 1,
    'exactly ONE ViewContent call site');

  // Ordering is the load-bearing part: the client must see her confirmation
  // whether or not tracking works. Assert the success screen renders FIRST.
  const fn = book.slice(book.indexOf('function showBookingSuccess'));
  const body = fn.slice(0, fn.indexOf('\n  }'));
  const showAt = body.indexOf("show('p-done'");
  const trackAt = body.indexOf("reviveTrack('Schedule'");
  ok(showAt !== -1 && trackAt !== -1 && showAt < trackAt,
    'success screen is shown BEFORE the Schedule event is fired');

  // Both call sites must be individually wrapped so a tracking fault cannot
  // propagate into the booking flow.
  const guarded = (book.match(/try \{\s*if \(typeof window\.reviveTrack === 'function'\)/g) || []).length;
  ok(guarded === 2, 'both call sites are wrapped in try/catch (found ' + guarded + ')');

  // No pixel snippet may be inlined into a page - one definition only.
  ok(!/connect\.facebook\.net/.test(book) && !/connect\.facebook\.net/.test(index),
    'no inline pixel snippet in any page (tracking.js is the only definition)');

  // ASCII quotes only in the code we added.
  const smart = (book.match(/[‘’“”]/g) || []);
  ok(smart.length === 0, 'book.html contains no curly quotes (' + smart.length + ' found)');
}

// ---------------------------------------------------------------------------
// 5. Deduplication - browser eventID must reach fbq, and book.html must pass
//    the booking id. Without this every booking is counted TWICE.
// ---------------------------------------------------------------------------
{
  const r = loadTracking({ pixelId: '123456789012345', pathname: '/book.html' });
  r.track('Schedule', { value: 95 }, 'bk_abc123');
  const sched = r.fbqCalls.filter((c) => c[1] === 'Schedule')[0];
  ok(sched && sched[3] && sched[3].eventID === 'bk_abc123',
    'reviveTrack forwards eventID to fbq for deduplication');

  r.track('ViewContent', { value: 95 });
  const vc = r.fbqCalls.filter((c) => c[1] === 'ViewContent')[0];
  ok(vc && vc.length === 3, 'reviveTrack omits the options arg when no eventID is given');

  const book = fs.readFileSync(path.join(ROOT, 'book.html'), 'utf8');
  ok(/reviveTrack\('Schedule',[\s\S]{0,240}\}, b\.id\)/.test(book),
    'book.html passes the booking id as the Schedule dedupe key');
}

// ---------------------------------------------------------------------------
// 6. Worker Conversions API - normalisation and the off-by-default contract.
//    The worker is a Cloudflare module and cannot be require()d, so the helper
//    is extracted textually. Never require() it.
// ---------------------------------------------------------------------------
{
  const wsrc = fs.readFileSync(path.join(ROOT, 'worker', 'src', 'index.js'), 'utf8');

  ok(/if \(!env\.META_PIXEL_ID \|\| !env\.META_CAPI_TOKEN\) return;/.test(wsrc),
    'worker CAPI is off unless BOTH secrets are set');
  ok(/event_id: eventId/.test(wsrc), 'worker sends event_id for deduplication');
  ok(/metaConversion\(env, \{/.test(wsrc), 'worker calls metaConversion on booking');

  // It must sit inside the existing waitUntil/allSettled block, so a CAPI
  // failure can neither delay nor break the booking response.
  const wu = wsrc.slice(wsrc.indexOf('ctx.waitUntil(Promise.allSettled(['));
  const block = wu.slice(0, wu.indexOf(']));'));
  ok(block.includes('metaConversion('),
    'metaConversion runs inside waitUntil(allSettled(...)) so it cannot break a booking');

  // Raw PII must never be sent - email/phone/name go through sha256Hex.
  const fn = wsrc.slice(wsrc.indexOf('async function metaConversion'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  ok(/userData\.em = \[await sha256Hex\(/.test(body), 'email is hashed before sending');
  ok(/userData\.ph = \[await sha256Hex\(/.test(body), 'phone is hashed before sending');
  ok(/userData\.fn = \[await sha256Hex\(/.test(body), 'first name is hashed before sending');
  ok(!/userData\.em = \[em\]/.test(body) && !/user_data: \{ em: email/.test(body),
    'no raw email is placed in user_data');

  // Extract and exercise the phone normaliser for real.
  const m = wsrc.match(/function normalisePhoneForMeta\(phone\) \{[\s\S]*?\n\}/);
  ok(!!m, 'normalisePhoneForMeta is present');
  if (m) {
    const norm = new Function(m[0] + '; return normalisePhoneForMeta;')();
    ok(norm('0404 967 051') === '61404967051', 'AU mobile 0404 967 051 -> 61404967051');
    ok(norm('0404967051') === '61404967051', 'AU mobile without spaces normalises');
    ok(norm('+61 404 967 051') === '61404967051', 'already-international number is not double-prefixed');
    ok(norm('61404967051') === '61404967051', 'bare 61... is left alone');
    ok(norm('404967051') === '61404967051', '9-digit number gains the country code');
    ok(norm('') === '' && norm(null) === '' && norm(undefined) === '',
      'empty/null phone returns empty rather than a bogus country code');
    ok(norm('(08) 8123 4567') === '61881234567', 'landline with punctuation normalises');
  }
}

// ---------------------------------------------------------------------------
console.log('\n' + pass + ' passed, ' + fails.length + ' failed');
if (fails.length) {
  fails.forEach((f) => console.log('  FAIL  ' + f));
  process.exit(1);
}
console.log('tracking OK');
