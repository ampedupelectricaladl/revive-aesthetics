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
function loadTracking({ pixelId, pathname, search, storage }) {
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
  win.location = { pathname, search: search || '' };
  if (storage) win.localStorage = storage;
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
// 1. Ships with Revive's own pixel; an empty id still switches tracking off
// ---------------------------------------------------------------------------
{
  // Switched on 2026-09-18 with the pixel Stefani created in Events Manager.
  // Any other id (a typo, or another business's pixel) must fail here.
  const src = fs.readFileSync(TRACKING, 'utf8');
  ok(/var PIXEL_ID = '1124493476890951';/.test(src),
    "tracking.js ships with Revive's own pixel id and no other");

  const r = loadTracking({ pixelId: '', pathname: '/book.html' });
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

  // It must sit inside an allSettled([...]) array that is handed to waitUntil, so a CAPI
  // failure can neither delay nor break the booking response.
  // (The old check sliced from the FIRST `ctx.waitUntil(Promise.allSettled([` in the file;
  // on 14 Sept the cron handler gained one earlier in the file, so the slice read the cron
  // block and missed the booking's. The call site is now located directly instead.)
  const callSites = [];
  for (const m of wsrc.matchAll(/metaConversion\(env, \{/g)) {
    if (!/function\s+$/.test(wsrc.slice(Math.max(0, m.index - 20), m.index))) callSites.push(m.index);
  }
  ok(callSites.length === 1, 'exactly one metaConversion call site (found ' + callSites.length + ')');
  const callAt = callSites[0] === undefined ? -1 : callSites[0];
  const settledAt = callAt === -1 ? -1 : wsrc.lastIndexOf('Promise.allSettled([', callAt);
  ok(callAt !== -1 && settledAt !== -1 && !wsrc.slice(settledAt, callAt).includes(']);') &&
     wsrc.indexOf(']);', callAt) !== -1,
    'metaConversion runs inside allSettled([...]) so it cannot break a booking');
  const holder = callAt === -1 ? '' : wsrc.slice(wsrc.lastIndexOf('\nasync function ', callAt), callAt);
  const holderName = (holder.match(/^\nasync function (\w+)\(/) || [])[1] || '';
  const bkRoute = wsrc.slice(wsrc.indexOf("path === '/api/book' && req.method === 'POST'"));
  const bkBody = bkRoute.slice(0, bkRoute.indexOf("// One-tap Apple Calendar subscribe"));
  ok(holderName === 'notifyBookingConfirmed' &&
     new RegExp('ctx\\.waitUntil\\(' + holderName + '\\(').test(bkBody) &&
     !new RegExp('await ' + holderName + '\\(').test(bkBody),
    '/api/book hands the notifications (incl. the conversion) to waitUntil and never awaits them');

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
// ---------------------------------------------------------------------------
// 9. Traffic-source capture (utm_* / fbclid) - independent of the pixel
// ---------------------------------------------------------------------------
{
  function memStore() {
    const m = {};
    return { getItem: (k) => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); }, _m: m };
  }
  // Landing from the ad: captured even with NO pixel id.
  const store = memStore();
  const r1 = loadTracking({ pixelId: '', pathname: '/book.html', storage: store,
    search: '?utm_source=instagram&utm_medium=paid&utm_campaign=lashlift95&fbclid=abc123&junk=1' });
  ok(typeof r1.win.reviveAttribution === 'function', 'attribution: helper defined with pixel disabled');
  const got = r1.win.reviveAttribution();
  ok(got.utm_source === 'instagram' && got.utm_medium === 'paid' && got.utm_campaign === 'lashlift95',
    'attribution: utm source/medium/campaign captured from the landing URL');
  ok(got.fbclid === 'abc123', 'attribution: fbclid captured');
  ok(got.landing_page === '/book.html', 'attribution: landing page recorded');
  ok(!('junk' in got), 'attribution: unrelated query params are not captured');
  ok(r1.injected.length === 0 && r1.fbqCalls.length === 0, 'attribution: capturing loads/sends nothing');

  // Homepage (tagged) -> book.html (untagged) keeps the source.
  const r2 = loadTracking({ pathname: '/book.html', storage: store, search: '' });
  ok(r2.win.reviveAttribution().utm_campaign === 'lashlift95', 'attribution: an untagged later page keeps the saved source');

  // A new tagged visit replaces it (last touch).
  const r3 = loadTracking({ pathname: '/', storage: store, search: '?utm_source=google' });
  const g3 = r3.win.reviveAttribution();
  ok(g3.utm_source === 'google' && !g3.utm_campaign, 'attribution: a new tagged visit replaces the old one');

  // Expired after 30 days.
  const old = JSON.parse(store._m.revive_attr); old.at = Date.now() - 31 * 24 * 3600 * 1000;
  store.setItem('revive_attr', JSON.stringify(old));
  const r4 = loadTracking({ pathname: '/book.html', storage: store, search: '' });
  ok(Object.keys(r4.win.reviveAttribution()).length === 0, 'attribution: a source older than 30 days is dropped');

  // Storage that throws (private mode / in-app browsers) never breaks the page.
  const bad = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
  let threw = false, g5 = null;
  try {
    const r5 = loadTracking({ pathname: '/book.html', storage: bad, search: '?utm_source=instagram' });
    g5 = r5.win.reviveAttribution();
  } catch (e) { threw = true; }
  ok(!threw, 'attribution: throwing localStorage does not break the page');
  ok(g5 && g5.utm_source === 'instagram', 'attribution: falls back to in-memory for this page view');

  // book.html sends it on both booking requests; the worker stores it.
  const book = fs.readFileSync(path.join(ROOT, 'book.html'), 'utf8');
  ok(book.includes('attribution: attributionNow(),'), 'book.html: attribution added to the booking form data');
  ok(book.includes('attribution: state.formData.attribution,'), 'book.html: attribution sent to create-payment-intent');
  const w = fs.readFileSync(path.join(ROOT, 'worker', 'src', 'index.js'), 'utf8').replace(/\r\n/g, '\n');
  const cStart = w.indexOf('function cleanAttribution(raw) {');
  const cEnd = cStart < 0 ? -1 : w.indexOf('\n}\n', cStart);
  const cm = cStart >= 0 && cEnd > cStart ? [w.slice(cStart, cEnd + 2)] : null;
  const fm = w.match(/const ATTRIBUTION_FIELDS = \[[^\]]*\];/);
  ok(!!cm && !!fm, 'worker: cleanAttribution + ATTRIBUTION_FIELDS present');
  if (cm && fm) {
    const clean = new Function(fm[0] + cm[0] + '; return cleanAttribution;')();
    const c = clean({ utm_source: ' instagram<script> ', utm_campaign: 5, evil: 'x', fbclid: 'a'.repeat(400) });
    ok(c.utm_source === 'instagramscript', 'worker: markup characters stripped from attribution');
    ok(c.utm_campaign === '' && !('evil' in c), 'worker: non-string and unknown attribution fields dropped');
    ok(c.fbclid.length === 255, 'worker: attribution values length-capped');
    let t = false; try { clean(null); clean('x'); clean(undefined); } catch (e) { t = true; }
    ok(!t, 'worker: bad attribution payload never throws');
  }
  ok(w.split('...ATTRIBUTION_FIELDS.map(k => attr[k])').length - 1 === 2,
    'worker: attribution written on BOTH booking insert paths (checkout hold + direct booking)');
}

console.log('\n' + pass + ' passed, ' + fails.length + ' failed');
if (fails.length) {
  fails.forEach((f) => console.log('  FAIL  ' + f));
  process.exit(1);
}
console.log('tracking OK');
