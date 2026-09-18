/**
 * test-studio-hub.js - signs in to the REAL admin.html against the LIVE worker.
 *
 * Run this before pushing any change to admin.html:
 *     node scripts/test-studio-hub.js
 *
 * Needs Playwright and the admin token file. If Playwright isn't installed it
 * SKIPS loudly rather than passing quietly - a green run must mean it really ran.
 * scripts/check-pages.js is the cheap always-on guard; this is the deep one.
 */
let chromium;
try {
  chromium = require('playwright').chromium;
} catch (e) {
  try {
    chromium = require('C:/Users/derba/.openclaw/workspace/node_modules/playwright').chromium;
  } catch (e2) {
    console.log('SKIPPED - Playwright is not installed (npm i -D playwright). Nothing was verified.');
    process.exit(2);
  }
}
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = process.env.HUB_ROOT || path.resolve(__dirname, '..');
// HUB_ONLY_COLLECT=1 runs just the mocked "what to collect" section (no live API,
// no token needed) - used to prove those assertions fail on reintroduced bugs.
const ONLY_COLLECT = process.env.HUB_ONLY_COLLECT === '1';
const TOKEN_FILE = process.env.REVIVE_ADMIN_TOKEN_FILE
  || path.join(require('os').homedir(), '.openclaw', 'revive-admin-token.txt');
if (!ONLY_COLLECT && !fs.existsSync(TOKEN_FILE)) {
  console.log('SKIPPED - no admin token at ' + TOKEN_FILE + '. Nothing was verified.');
  process.exit(2);
}
const TOKEN = ONLY_COLLECT ? '' : fs.readFileSync(TOKEN_FILE, 'utf8').trim();
const PORT = Number(process.env.HUB_PORT || 8971);

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '  [' + detail + ']' : '')); }
}

// tiny static server - assert 200 + real body, never trust a silent 404 (see harness lesson)
const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0].split('#')[0]).replace(/^\/+/, '') || 'index.html';
  const file = path.resolve(ROOT, rel);
  if (!file.startsWith(path.resolve(ROOT))) { res.writeHead(403); return res.end('no'); }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('missing'); }
  res.writeHead(200, { 'content-type': rel.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/plain' });
  res.end(fs.readFileSync(file));
});

const URL_ = 'http://localhost:' + PORT + '/admin.html';

(async () => {
  await new Promise(r => server.listen(PORT, r));

  // sanity: the harness itself serves a real page
  const probe = await new Promise(r => http.get(URL_, res => {
    let b = ''; res.on('data', d => b += d); res.on('end', () => r({ status: res.statusCode, len: b.length }));
  }));
  console.log('harness probe: HTTP ' + probe.status + ', ' + probe.len + ' bytes');
  if (probe.status !== 200 || probe.len < 5000) { console.log('HARNESS BROKEN - aborting'); process.exit(1); }

  const browser = await chromium.launch();

  async function fresh(opts) {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e.message)));
    if (opts && opts.seed !== undefined) {
      await page.goto(URL_);
      await page.evaluate(v => localStorage.setItem('revive_admin_token', v), opts.seed);
    }
    return { ctx, page, errors };
  }
  const vis = (p, sel) => p.$eval(sel, el => getComputedStyle(el).display !== 'none').catch(() => false);
  const msg = p => p.$eval('#lock-msg', el => el.textContent.trim()).catch(() => '');
  const stored = p => p.evaluate(() => localStorage.getItem('revive_admin_token'));

  // --- 0. WHAT TO COLLECT (mocked API - never touches real bookings) -------
  // 14 Sept 2026: a client booked before online deposits existed had paid NO deposit,
  // the card only showed the full price, and Stefani charged just the balance.
  console.log('\n0. Deposit status + what to collect (mocked bookings)');
  {
    // Adelaide-anchored, matching admin.html adlToday() - a UTC base reads as yesterday before 9:30am.
    const adl = new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Adelaide', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()).split('-');
    const day = n => new Date(Date.UTC(+adl[0], +adl[1] - 1, +adl[2]) + n * 864e5).toISOString().slice(0, 10);
    const bk = (id, o) => Object.assign({ id, status: 'confirmed', time_label: '10:00am', date: day(2), date_label: day(2),
      addon: '', notes: '', email: '', deposit_paid: false, deposit_cents: 0, stripe_payment_intent_id: null }, o);
    const bookings = [
      bk('a1', { treatment: 'Lash Lift', price_aud: 95, deposit_paid: true, deposit_cents: 2850, stripe_payment_intent_id: 'pi_test', name: 'Paid Penny', phone: '0400 000 001' }),
      bk('b1', { treatment: 'Lash Lift', price_aud: 95, name: 'Nodep Nora', phone: '0400 000 002' }),
      bk('c1', { treatment: 'Intro Facial', price_aud: 70, date: day(3), name: 'Intro Ivy', phone: '0400 000 003' }),
      bk('d1', { treatment: 'Free Consultation', price_aud: 0, date: day(3), name: 'Free Fiona', phone: '0400 000 004' }),
      bk('e1', { treatment: 'Lash Lift', price_aud: 95, status: 'cancelled', date: day(4), name: 'Cancelled Cara', phone: '0400 000 005' }),
      bk('f1', { treatment: 'Brow Tint', price_aud: 50, deposit_paid: true, deposit_cents: 5000, date: day(4), name: 'Full Fran', phone: '0400 000 006' }),
    ];
    const clients = bookings.map(b => ({ name: b.name, phone: b.phone, email: '', visits: 1, total_aud: b.price_aud, next_booking: b.date, next_treatment: b.treatment }));
    const { ctx, page, errors } = await fresh();
    const hits = [];
    await ctx.route('**/revive-booking.ampedup.workers.dev/**', r => {
      const u = r.request().url(); hits.push(u);
      let body = { error: 'unmocked' }, status = 200;
      if (/\/api\/admin\/blocked/.test(u)) body = { blocked: [] };
      else if (/\/api\/admin\/bookings/.test(u)) body = { bookings };
      else if (/\/api\/admin\/clients/.test(u)) body = { clients, total: clients.length };
      else if (/\/api\/admin\/survey/.test(u)) body = { count: 0, responses: [] };
      else status = 404;
      return r.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
    });
    await page.goto(URL_);
    await page.evaluate(() => localStorage.setItem('revive_admin_token', 'mock-token-for-collect-test'));
    await page.reload({ waitUntil: 'domcontentloaded' });
    const ok = await page.waitForSelector('#stat-collect', { timeout: 15000 }).then(() => true, () => false);
    check('diary rendered from mocked API', ok);
    const txt = (sel) => page.$eval(sel, el => el.textContent.trim()).catch(() => null);
    const count = (sel) => page.$$eval(sel, els => els.length).catch(() => -1);
    check('paid deposit: shows deposit paid and collects price minus deposit',
      (await txt('#bk-a1 .collect.paid')) === 'Deposit $28.50 paid · collect $66.50', await txt('#bk-a1 .collect'));
    check('paid deposit: NO warning badge', (await count('#bk-a1 .collect.nodep')) === 0);
    check('no deposit $95: NO DEPOSIT badge rendered', (await txt('#bk-b1 .collect.nodep')) === 'No deposit · collect $95', await txt('#bk-b1 .collect'));
    check('no deposit badge is visible (not hidden)', await vis(page, '#bk-b1 .collect.nodep'));
    check('no deposit $70 intro: collect full $70', (await txt('#bk-c1 .collect.nodep')) === 'No deposit · collect $70', await txt('#bk-c1 .collect'));
    check('free consultation: no collect line at all', (await count('#bk-d1 .collect')) === 0);
    check('deposit covers the price: nothing to collect', (await txt('#bk-f1 .collect.paid')) === 'Deposit $50 paid · nothing to collect', await txt('#bk-f1 .collect'));
    check('whole-dollar price still reads $95 (not $95.00)', (await txt('#bk-b1 .bk-price')) === '$95', await txt('#bk-b1 .bk-price'));
    check('To collect stat = 66.50 + 95 + 70 + 0 = $231.50', (await txt('#stat-collect .n')) === '$231.50', await txt('#stat-collect .n'));
    check('cancelled booking not in diary', (await count('#bk-e1')) === 0);
    // clients tab: booking history includes the cancelled one
    await page.waitForSelector('#cl-list .card', { timeout: 15000 }).catch(() => {});
    const hist = await page.$$eval('#cl-list .card', cards => cards.map(c => ({
      name: c.querySelector('.bk-name') ? c.querySelector('.bk-name').textContent : '',
      cancelled: /CANCELLED/.test(c.textContent),
      collects: Array.from(c.querySelectorAll('.collect')).map(x => x.className + '|' + x.textContent.trim()),
    }))).catch(() => []);
    const cara = hist.find(h => /Cancelled Cara/.test(h.name));
    const nora = hist.find(h => /Nodep Nora/.test(h.name));
    const fiona = hist.find(h => /Free Fiona/.test(h.name));
    check('client history lists the cancelled booking', !!cara && cara.cancelled, JSON.stringify(cara));
    check('cancelled booking: no collect badge in history', !!cara && cara.collects.length === 0, JSON.stringify(cara));
    check('client history: no-deposit badge shown', !!nora && nora.collects.length === 1 && /nodep\|No deposit · collect \$95/.test(nora.collects[0]), JSON.stringify(nora));
    check('client history: free consultation shows nothing', !!fiona && fiona.collects.length === 0, JSON.stringify(fiona));
    check('only mocked endpoints were called', hits.length > 0 && hits.every(u => /\/api\/admin\/(blocked|bookings|clients|survey)/.test(u)), hits.join(' '));
    check('no uncaught errors (collect section)', errors.length === 0, errors[0]);
    await ctx.close();
  }
  if (ONLY_COLLECT) {
    await browser.close(); server.close();
    console.log('\n=== ' + pass + ' passed, ' + fail + ' failed ===');
    process.exit(fail ? 1 : 0);
  }

  // --- 1. page executes at all (this is what was broken) -------------------
  console.log('\n1. Page runs without a JavaScript error');
  {
    const { ctx, page, errors } = await fresh();
    await page.goto(URL_, { waitUntil: 'networkidle' });
    check('no uncaught page error', errors.length === 0, errors[0]);
    check('lock screen visible', await vis(page, '#lock'));
    check('app hidden', !(await vis(page, '#app')));
    await ctx.close();
  }

  // --- 2. wrong code ------------------------------------------------------
  console.log('\n2. Wrong access code');
  {
    const { ctx, page } = await fresh();
    await page.goto(URL_, { waitUntil: 'networkidle' });
    await page.fill('#code', 'definitely-not-the-code');
    await page.click('#unlock');
    await page.waitForFunction(() => document.getElementById('lock-msg').textContent.length > 0, { timeout: 15000 });
    check('says the code is wrong', /isn.t right/i.test(await msg(page)), await msg(page));
    check('bad code NOT left in storage', (await stored(page)) === null, String(await stored(page)));
    check('app still hidden', !(await vis(page, '#app')));
    await ctx.close();
  }

  // --- 3. correct code ----------------------------------------------------
  console.log('\n3. Correct access code');
  {
    const { ctx, page, errors } = await fresh();
    await page.goto(URL_, { waitUntil: 'networkidle' });
    await page.fill('#code', TOKEN);
    await page.click('#unlock');
    await page.waitForSelector('#app', { state: 'visible', timeout: 20000 });
    check('app opens', await vis(page, '#app'));
    check('token saved after success', (await stored(page)) === TOKEN);
    await page.waitForFunction(() => !/Loading your diary/.test(document.getElementById('v-diary').textContent), { timeout: 20000 });
    const diary = await page.$eval('#v-diary', el => el.textContent);
    check('diary rendered (not stuck loading)', !/Loading your diary/.test(diary));
    check('diary shows real bookings', /Upcoming/.test(diary), diary.slice(0, 80));
    await page.click('.tab[data-t="clients"]');
    await page.waitForFunction(() => !/Loading clients/.test(document.getElementById('v-clients').textContent), { timeout: 20000 });
    const clients = await page.$eval('#v-clients', el => el.textContent);
    check('clients rendered', /client/i.test(clients) && !/Loading clients/.test(clients));
    check('no uncaught errors during load', errors.length === 0, errors[0]);
    await ctx.close();
  }

  // --- 4. THE LOCKOUT: stale bad token + correct magic link ---------------
  console.log('\n4. Stale wrong code saved, then she opens the correct magic link');
  {
    const { ctx, page } = await fresh({ seed: 'stale-wrong-token-from-a-typo' });
    await page.goto(URL_ + '#' + TOKEN); await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('#app', { state: 'visible', timeout: 20000 });
    check('magic link overrides the stale saved code', await vis(page, '#app'));
    check('storage replaced with the good code', (await stored(page)) === TOKEN);
    check('code stripped from the address bar', !(await page.evaluate(() => location.hash)));
    await ctx.close();
  }

  // --- 5. remembered across visits ----------------------------------------
  console.log('\n5. Stays signed in on the next visit');
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(URL_);
    await page.evaluate(v => localStorage.setItem('revive_admin_token', v), TOKEN);
    await page.goto(URL_, { waitUntil: 'networkidle' });
    await page.waitForSelector('#app', { state: 'visible', timeout: 20000 });
    check('opens straight into the hub', await vis(page, '#app'));
    await page.click('#signout');
    check('sign out returns to lock', await vis(page, '#lock'));
    check('sign out clears the code', (await stored(page)) === null);
    await ctx.close();
  }

  // --- 6. service down / offline is NOT reported as a wrong code -----------
  console.log('\n6. Studio system unreachable');
  {
    const { ctx, page } = await fresh({ seed: TOKEN });
    await ctx.route('**/revive-booking.ampedup.workers.dev/**', r => r.abort());
    await page.goto(URL_, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.getElementById('lock-msg').textContent.length > 0, { timeout: 15000 });
    const m = await msg(page);
    check('blames the connection, not her code', /reach the studio system/i.test(m), m);
    check('does NOT say the code is wrong', !/isn.t right/i.test(m), m);
    check('keeps her saved code', (await stored(page)) === TOKEN);
    await ctx.close();
  }

  // --- 7. server error is NOT reported as a wrong code ---------------------
  console.log('\n7. Studio system returns an error');
  {
    const { ctx, page } = await fresh({ seed: TOKEN });
    await ctx.route('**/api/admin/**', r => r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"server_error"}' }));
    await page.goto(URL_, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.getElementById('lock-msg').textContent.length > 0, { timeout: 15000 });
    const m = await msg(page);
    check('reports a system fault', /isn.t answering/i.test(m), m);
    check('names the actual HTTP status', /\(500\)/.test(m), m);
    check('does NOT say the code is wrong', !/isn.t right/i.test(m), m);
    check('keeps her saved code', (await stored(page)) === TOKEN);
    await ctx.close();
  }

  // --- 8. messy paste -----------------------------------------------------
  console.log('\n8. Code pasted messily');
  for (const [label, val] of [
    ['whole magic link', URL_ + '#' + TOKEN],
    ['with Bearer prefix', 'Bearer ' + TOKEN],
    ['wrapped in quotes', '"' + TOKEN + '"'],
    ['with a stray space', ' ' + TOKEN + ' '],
  ]) {
    const { ctx, page } = await fresh();
    await page.goto(URL_, { waitUntil: 'networkidle' });
    await page.fill('#code', val);
    await page.click('#unlock');
    let ok = true;
    await page.waitForSelector('#app', { state: 'visible', timeout: 20000 }).catch(() => { ok = false; });
    check(label, ok);
    await ctx.close();
  }

  // --- 9. wrong code typed while offline must not be remembered -----------
  console.log('\n9. Wrong code typed while the connection is down');
  {
    const { ctx, page } = await fresh();
    await ctx.route('**/revive-booking.ampedup.workers.dev/**', r => r.abort());
    await page.goto(URL_, { waitUntil: 'domcontentloaded' });
    await page.fill('#code', 'a-wrong-code-typed-on-the-train');
    await page.click('#unlock');
    await page.waitForFunction(() => document.getElementById('lock-msg').textContent.length > 0, { timeout: 15000 });
    check('unchecked code is NOT saved', (await stored(page)) === null, String(await stored(page)));
    await ctx.close();
  }

  // --- 10. a saved code that the server later rejects (code rotated) -------
  console.log('\n10. Saved code no longer accepted by the server');
  {
    const { ctx, page } = await fresh({ seed: 'a-code-that-used-to-work' });
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForFunction(() => document.getElementById('lock-msg').textContent.length > 0, { timeout: 15000 });
    const m = await msg(page);
    check('says the code is wrong', /isn.t right/i.test(m), m);
    check('dead code is cleared so she can enter a new one', (await stored(page)) === null, String(await stored(page)));
    await ctx.close();
  }

  await browser.close();
  server.close();
  console.log('\n=== ' + pass + ' passed, ' + fail + ' failed ===');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });
