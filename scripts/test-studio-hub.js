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
const TOKEN_FILE = process.env.REVIVE_ADMIN_TOKEN_FILE
  || path.join(require('os').homedir(), '.openclaw', 'revive-admin-token.txt');
if (!fs.existsSync(TOKEN_FILE)) {
  console.log('SKIPPED - no admin token at ' + TOKEN_FILE + '. Nothing was verified.');
  process.exit(2);
}
const TOKEN = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
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
