/**
 * Revive Aesthetics - tests for the lash-lift ad landing page and the
 * no-blank-state / attribution changes to book.html.
 *
 * Run: node scripts/test-lash-page.js
 *
 * WHY THIS EXISTS
 * ---------------
 * Instagram sent 394 taps to book.html. Two thirds died before the page
 * rendered, waiting on /api/treatments inside Instagram's in-app browser, and
 * the $95 lash lift was listed LAST behind a $299 treatment. Nothing on the way
 * to the live site would have caught either. This does.
 *
 * Every assertion below has been mutation-checked: the bug was reintroduced by
 * hand and the test was confirmed to fail before being kept.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const lash = fs.readFileSync(path.join(ROOT, 'lash.html'), 'utf8');
const book = fs.readFileSync(path.join(ROOT, 'book.html'), 'utf8');
const sitemap = fs.readFileSync(path.join(ROOT, 'sitemap.xml'), 'utf8');

let pass = 0;
const fails = [];
function ok(cond, label) {
  if (cond) { pass++; } else { fails.push(label); }
}

/** The page body with <script> and <style> blocks removed - what a client reads. */
function visibleText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ');
}

// ---------------------------------------------------------------------------
// 1. lash.html renders instantly - nothing is waiting on the API
// ---------------------------------------------------------------------------
{
  const text = visibleText(lash);
  ok(!/loading/i.test(text),
    'lash.html shows no "Loading" state anywhere in its visible copy');
  // loading="lazy" is an attribute, not a blank state - anything else is.
  ok(!/loading(?!=)/i.test(lash.replace(/<script[\s\S]*?<\/script>/gi, '')),
    'lash.html has no "Loading" markup outside its scripts either');

  // The headline, price and CTA must be in the served HTML, not built by JS.
  ok(/Korean[\s\S]{0,40}Lash Lift[\s\S]{0,20}Tint/i.test(lash),
    'lash.html headline "Korean Lash Lift & Tint" is in the static HTML');
  ok(text.includes('$95'), 'lash.html states $95 in static copy');
  ok(/75 minutes/.test(text), 'lash.html states 75 minutes in static copy');
  ok(/6.{0,8}8 weeks/.test(text), 'lash.html says the lift lasts 6-8 weeks');
  ok(/no extensions/i.test(text), 'lash.html says no extensions');
  ok(/Pulteney St/i.test(text), 'lash.html names the Pulteney St studio');
  ok(/Mondays? *(&amp;|&|and) *Tuesdays?/i.test(lash), 'lash.html states the Mon & Tue hours');
}

// ---------------------------------------------------------------------------
// 2. No discount framing. A "was $120" style price is not something we offer
//    and is not something a landing page may invent.
// ---------------------------------------------------------------------------
{
  ok(!/<(s|del|strike)[\s>]/i.test(lash), 'lash.html uses no <s>/<del>/<strike> element');
  ok(!/line-through/i.test(lash), 'lash.html has no line-through styling');
  ok(!/\bwas \$/i.test(lash), 'lash.html never writes "was $"');
  ok(!/\b(RRP|normally|usually) *\$/i.test(lash), 'lash.html has no other "was"-price framing');

  // No claims about the reader's own lashes.
  ok(!/your (sparse|short|thin|straight|flat|weak) lashes/i.test(lash),
    'lash.html makes no claim about the reader\'s own lashes');
}

// ---------------------------------------------------------------------------
// 3. The button goes to the booking page, on the lash lift
// ---------------------------------------------------------------------------
{
  ok(/book\.html\?t=lash-lift/.test(lash),
    'lash.html links to book.html?t=lash-lift');
  ok(/Book my lash lift/.test(visibleText(lash)),
    'lash.html has the "Book my lash lift" button text');
  ok(/index\.html#faq/.test(lash), 'lash.html links policies to index.html#faq');
  ok(/#faq/.test(fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8')),
    'the #faq anchor actually exists on index.html');
  ok(/Deposit 30% at booking/.test(visibleText(lash)) && /48h before/.test(visibleText(lash)),
    'lash.html states the 30% deposit and the 48h change window');
}

// ---------------------------------------------------------------------------
// 4. Ad parameters survive the hop to book.html
// ---------------------------------------------------------------------------
{
  ok(/new URLSearchParams\(location\.search\)/.test(lash),
    'lash.html reads the whole incoming query string');
  ok(/params\.set\('t',/.test(lash),
    'lash.html forces t=lash-lift onto the carried-through parameters');

  // Run the real function rather than trusting the source to mean what it says.
  const m = lash.match(/function bookUrl\(extra\) \{[\s\S]*?\n  \}/);
  ok(!!m, 'lash.html defines bookUrl()');
  if (m) {
    const make = (search) => new Function('location', 'URLSearchParams', 'TREATMENT',
      m[0] + '; return bookUrl(null);')({ search }, URLSearchParams, 'lash-lift');

    const out = make('?fbclid=ABC123&utm_source=ig&utm_campaign=lash_sep&src=story');
    ok(out.startsWith('book.html?'), 'bookUrl() targets book.html');
    const p = new URLSearchParams(out.slice(out.indexOf('?') + 1));
    ok(p.get('fbclid') === 'ABC123', 'fbclid is carried through to book.html');
    ok(p.get('utm_source') === 'ig', 'utm_source is carried through');
    ok(p.get('utm_campaign') === 'lash_sep', 'utm_campaign is carried through');
    ok(p.get('src') === 'story', 'src is carried through');
    ok(p.get('t') === 'lash-lift', 't=lash-lift is set');

    const bare = new URLSearchParams(make('').slice(make('').indexOf('?') + 1));
    ok(bare.get('t') === 'lash-lift' && bare.toString() === 't=lash-lift',
      'a visitor with no parameters still gets a clean book.html?t=lash-lift');

    // An incoming t= must not win over the page's own treatment.
    const forced = new URLSearchParams(make('?t=microneedling').split('?')[1]);
    ok(forced.get('t') === 'lash-lift', 'an incoming t= is overridden with lash-lift');
  }
}

// ---------------------------------------------------------------------------
// 5. Photos are whole, lazy and sized; the pixel fires like book.html's
// ---------------------------------------------------------------------------
{
  const imgs = lash.match(/<img[^>]*lash-lift-result-\d\.jpg[^>]*>/g) || [];
  ok(imgs.length === 3, 'lash.html shows exactly 3 lash result photos (got ' + imgs.length + ')');
  ok(imgs.every((t) => /loading="lazy"/.test(t)), 'every result photo is lazy-loaded');
  ok(imgs.every((t) => /width="\d+"/.test(t) && /height="\d+"/.test(t)),
    'every result photo carries width/height so the page does not jump');
  ok(!/object-fit *: *cover/i.test(lash) && !/\.shots img[^}]*height: *\d+px/i.test(lash),
    'result photos are not cropped to a strip');
  ok(/assets\/stefani\.jpg/.test(lash) && /Your lash artist, Stefani/.test(lash),
    'lash.html shows Stefani with "Your lash artist, Stefani"');

  ok(/<script src="assets\/tracking\.js" defer><\/script>/.test(lash),
    'lash.html loads the shared tracking.js (never an inline pixel)');
  ok(/typeof window\.reviveTrack === 'function'/.test(lash),
    'lash.html guards reviveTrack exactly the way book.html does');
  ok(/reviveTrack\('ViewContent'/.test(lash), 'lash.html fires ViewContent');
  ok(/font-display|display=swap/.test(lash), 'lash.html loads fonts with display=swap');
  ok(/<link rel="canonical" href="https:\/\/reviveaestheticsadl\.com\.au\/lash\.html"/.test(lash),
    'lash.html has a canonical link');
  ok(/<meta name="description"/.test(lash) && /<title>/.test(lash),
    'lash.html has a title and meta description');

  // The availability call must come AFTER paint and must fail silently.
  ok(/requestIdleCallback|addEventListener\('load'/.test(lash),
    'availability is fetched only after first paint');
  ok(/\.catch\(function \(\) \{ \/\* stay silent/.test(lash),
    'a failed availability call is swallowed so the page still looks complete');
  ok(/class="next" id="next-wrap"/.test(lash) && /\.next \{[^}]*display: none/.test(lash),
    'the Next available row is hidden until the fetch actually succeeds');
}

// ---------------------------------------------------------------------------
// 6. book.html - static fallback, lash lift first
// ---------------------------------------------------------------------------
{
  ok(/var FALLBACK_TREATMENTS = \[/.test(book),
    'book.html embeds a static treatment fallback');
  ['lash-lift', 'consultation', 'microneedling', 'lymphatic'].forEach((id) => {
    ok(new RegExp("id: '" + id + "'").test(book), 'fallback includes ' + id);
  });
  ok(/renderTreatments\(FALLBACK_TREATMENTS\)/.test(book),
    'book.html renders the fallback grid synchronously on first paint');

  // The fallback render must come BEFORE the API call in source order, or it is
  // not a first-paint render at all.
  const iFallback = book.indexOf('renderTreatments(FALLBACK_TREATMENTS)');
  const iApi = book.indexOf("api('/api/treatments')");
  ok(iFallback !== -1 && iApi !== -1 && iFallback < iApi,
    'the fallback grid is rendered before /api/treatments is called');

  // Run the real ordering function against the real live list.
  const om = book.match(/function orderTreatments\(list\) \{[\s\S]*?\n  \}/);
  ok(!!om, 'book.html defines orderTreatments()');
  if (om) {
    const cm = book.match(/var TREATMENT_ORDER = \[[^\]]*\];/);
    const order = new Function(cm[0] + om[0] + '; return orderTreatments;')();
    const live = [
      { id: 'consultation' }, { id: 'microneedling' }, { id: 'lymphatic' }, { id: 'lash-lift' }
    ];
    const out = order(live).map((t) => t.id);
    ok(out[0] === 'lash-lift', 'lash-lift is rendered FIRST (got ' + out[0] + ')');
    ok(out[1] === 'consultation', 'consultation is rendered second (got ' + out[1] + ')');
    ok(out.join(',') === 'lash-lift,consultation,microneedling,lymphatic',
      'the remaining treatments keep the order the server sent');
    ok(order(FALLBACK_ORDER_INPUT()).map((t) => t.id)[0] === 'lash-lift',
      'the static fallback grid also leads with lash-lift');
  }

  function FALLBACK_ORDER_INPUT() {
    const fm = book.match(/var FALLBACK_TREATMENTS = \[[\s\S]*?\n  \];/);
    return new Function(fm[0] + '; return FALLBACK_TREATMENTS;')();
  }

  ok(/\$\('t-loading'\)\.style\.display = 'none';\s*\n\s*renderTreatments\(FALLBACK_TREATMENTS\)/.test(book),
    'the "Loading treatments..." line is hidden before the first render');
}

// ---------------------------------------------------------------------------
// 7. book.html - attribution
// ---------------------------------------------------------------------------
{
  ok(/id="f-source"/.test(book), 'book.html has the how-did-you-hear select (id="f-source")');
  ['Instagram', 'Facebook', 'Google', 'A friend', 'Walked past the studio', 'Other']
    .forEach((o) => ok(new RegExp('<option value="' + o + '">').test(book),
      'f-source offers "' + o + '"'));
  ok(!/id="f-source"[^>]*required/.test(book), 'f-source is optional');
  // It must sit right after the email field.
  ok(book.indexOf('id="f-email"') < book.indexOf('id="f-source"') &&
     book.indexOf('id="f-source"') < book.indexOf('id="f-notes"'),
    'f-source sits between email and notes');

  ok(/qs\.get\('fbclid'\)|'fbclid'/.test(book), 'book.html reads fbclid from the URL');
  ['fbclid', 'utm_source', 'utm_campaign', 'src'].forEach((k) => {
    ok(new RegExp("'" + k + "'").test(book), 'book.html captures ' + k);
  });
  ok(/sessionStorage\.setItem\(ATTR_KEY/.test(book),
    'the captured parameters are stored in sessionStorage so they survive the steps');

  ok(/'Heard via: ' \+ heard \+ ' \| Source: ' \+ sourceLabel\(\)/.test(book),
    'book.html composes the "Heard via: ... | Source: ..." notes prefix');
  ok(/notes: notesWithAttribution\(\$\('f-notes'\)\.value\)/.test(book),
    'the prefix lands in the existing notes field sent to the API');

  // Run the real composer.
  const nm = book.match(/function notesWithAttribution\(clientNotes\) \{[\s\S]*?\n  \}/);
  const sm = book.match(/function sourceLabel\(\) \{[\s\S]*?\n  \}/);
  ok(!!nm && !!sm, 'book.html defines notesWithAttribution() and sourceLabel()');
  if (nm && sm) {
    const build = (attr, selValue) => new Function('readAttribution', '$',
      sm[0] + nm[0] + '; return notesWithAttribution;'
    )(() => attr, () => ({ value: selValue }));

    ok(build({ fbclid: 'X' }, 'Instagram')('dry eyes') ===
      'Heard via: Instagram | Source: Instagram ad (fbclid)\ndry eyes',
      'fbclid present -> "Instagram ad (fbclid)", client notes preserved below');
    ok(build({ utm_source: 'newsletter' }, '')('') ===
      'Heard via: not answered | Source: newsletter\n',
      'no answer and no fbclid -> "not answered" + utm_source');
    ok(build({ src: 'bio-link' }, 'A friend')('') ===
      'Heard via: A friend | Source: bio-link\n',
      'src is used when there is no fbclid or utm_source');
    ok(build({}, '')('') === 'Heard via: not answered | Source: direct\n',
      'a plain visit records Source: direct');
    ok(build({ fbclid: 'X' }, '')('n'.repeat(900)).length === 800,
      'the composed note is clamped to the 800 chars the API accepts');
  }

  // The deposit flow and the Schedule pixel event must be untouched.
  ok(/reviveTrack\('Schedule'/.test(book), 'the Schedule pixel event is still fired');
  ok(/api\('\/api\/create-payment-intent'/.test(book), 'the deposit flow is still in place');
  ok(!/notes:/.test(book.slice(book.indexOf("api('/api/create-payment-intent'"),
                               book.indexOf("api('/api/create-payment-intent'") + 400)),
    'the create-payment-intent call shape is unchanged');
}

// ---------------------------------------------------------------------------
// 8. sitemap
// ---------------------------------------------------------------------------
{
  ok(/<loc>https:\/\/reviveaestheticsadl\.com\.au\/lash\.html<\/loc>/.test(sitemap),
    'sitemap.xml lists lash.html');
  ok(/<loc>https:\/\/reviveaestheticsadl\.com\.au\/<\/loc>/.test(sitemap),
    'sitemap.xml still lists the home page');
}

// ---------------------------------------------------------------------------
console.log('\n' + pass + ' passed, ' + fails.length + ' failed');
if (fails.length) {
  fails.forEach((f) => console.log('  FAIL  ' + f));
  process.exit(1);
}
console.log('lash page OK');
