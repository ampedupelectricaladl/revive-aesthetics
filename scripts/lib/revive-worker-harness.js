/**
 * Runs the REAL Revive booking worker (worker/src/index.js) inside Node, for behavioural tests.
 *
 *   - D1 is a shim over node:sqlite (:memory:), with schema.sql applied
 *   - fetch is stubbed: Stripe, Telegram, Gmail and Meta calls are recorded, NOTHING hits the network
 *     (any other URL throws)
 *   - the clock is controllable: `Date` is replaced so Date.now() / new Date() read clock.now
 *   - ctx.waitUntil promises are collected and drained after every call
 *
 * REVIVE_WORKER_FILE points the harness at a different copy of the worker (mutation proofs).
 * The worker is copied to a temp .mjs and dynamically imported, so it runs as the ES module it is.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const nodeCrypto = require('crypto');
const { pathToFileURL } = require('url');

const origEmitWarning = process.emitWarning;
process.emitWarning = function (w, ...rest) {
  if (/SQLite is an experimental feature/.test(String(w && w.message || w))) return;
  return origEmitWarning.call(process, w, ...rest);
};
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.join(__dirname, '..', '..');
const WORKER_PATH = process.env.REVIVE_WORKER_FILE || path.join(ROOT, 'worker', 'src', 'index.js');
const SCHEMA = fs.readFileSync(path.join(ROOT, 'worker', 'schema.sql'), 'utf8');

// ---------- clock ----------
const RealDate = Date;
const clock = { now: RealDate.parse('2026-09-14T00:30:00.000Z') };
class FakeDate extends RealDate {
  constructor(...args) {
    if (args.length === 0) super(clock.now);
    else super(...args);
  }
  static now() { return clock.now; }
}
globalThis.Date = FakeDate;
const at = iso => RealDate.parse(iso);

// ---------- console capture (worker errors are asserted on, not printed) ----------
const logs = [];
const realError = console.error;
const realLog = console.log;
console.error = (...a) => { logs.push(a.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')); };
console.log = (...a) => {
  const s = a.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  if (/^meta capi/.test(s)) { logs.push(s); return; }
  realLog(...a);
};

// ---------- D1 shim ----------
function makeD1() {
  const sqlite = new DatabaseSync(':memory:');
  const norm = v => {
    if (v === undefined) throw new Error('D1_TYPE_ERROR: Type \'undefined\' not supported');
    if (typeof v === 'boolean') return v ? 1 : 0;
    return v;
  };
  const stmt = (text, params) => ({
    bind: (...p) => stmt(text, p.map(norm)),
    first: async col => {
      const r = sqlite.prepare(text).get(...params);
      if (r === undefined) return null;
      const o = { ...r };
      return col ? o[col] : o;
    },
    all: async () => ({ success: true, results: sqlite.prepare(text).all(...params).map(r => ({ ...r })) }),
    run: async () => {
      const i = sqlite.prepare(text).run(...params);
      return { success: true, meta: { changes: Number(i.changes), last_row_id: Number(i.lastInsertRowid) } };
    },
  });
  return {
    sqlite,
    prepare: text => stmt(text, []),
    exec: async text => { sqlite.exec(text); return { count: 1 }; },
    batch: async list => { const out = []; for (const s of list) out.push(await s.run()); return out; },
  };
}

// ---------- worker module ----------
let workerModule = null;
let internals = null;
async function loadWorker() {
  if (workerModule) return workerModule;
  const tmp = path.join(os.tmpdir(), `revive-worker-${process.pid}-${nodeCrypto.randomBytes(4).toString('hex')}.mjs`);
  fs.writeFileSync(tmp, fs.readFileSync(WORKER_PATH, 'utf8'));
  globalThis.REVIVE_WORKER_TEST_HOOKS = h => { internals = h; };
  try {
    workerModule = (await import(pathToFileURL(tmp).href)).default;
  } finally {
    try { fs.unlinkSync(tmp); } catch (_) { /* ignore */ }
  }
  if (!workerModule || typeof workerModule.fetch !== 'function') throw new Error('worker default export has no fetch');
  return workerModule;
}

const PHONE_BY_TAG = new Map();
const jsonResponse = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });

// ---------- a world: one database, one env, one set of stubs ----------
async function createWorld(opts) {
  opts = opts || {};
  const worker = await loadWorker();
  if (opts.clock) clock.now = opts.clock;
  const db = makeD1();
  db.sqlite.exec(SCHEMA);
  db.sqlite.exec(`CREATE TABLE IF NOT EXISTS client_flags (phone TEXT PRIMARY KEY, require_deposit INTEGER DEFAULT 1, note TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now')))`);
  db.sqlite.exec(`INSERT OR IGNORE INTO treatments (id, name, duration_min, price_aud, description, active, sort) VALUES
    ('lash-lift', 'Lash Lift', 60, 95, '', 1, 3), ('consultation', 'Free Consultation', 30, 0, '', 1, 4)`);

  const stripe = {
    pis: new Map(), refunds: [], seq: 0, createCalls: 0, getCalls: 0, createFails: false, refundFails: false,
    pi(id) { return JSON.parse(JSON.stringify(this.pis.get(id))); },
    succeed(id) { const p = this.pis.get(id); p.status = 'succeeded'; p.last_payment_error = null; return this.pi(id); },
    fail(id, message) {
      const p = this.pis.get(id);
      p.status = 'requires_payment_method';
      p.last_payment_error = { message: message || 'Your card was declined.' };
      return this.pi(id);
    },
    add(pi) { this.pis.set(pi.id, Object.assign({ object: 'payment_intent', currency: 'aud', client_secret: pi.id + '_secret' }, pi)); return this.pi(pi.id); },
  };
  const calls = { telegram: [], gmail: [], meta: [] };
  const world = { stripe, calls, metaThrows: false };

  world.fetch = async (url, init) => {
    url = String(url);
    init = init || {};
    const method = String(init.method || 'GET').toUpperCase();
    if (url === 'https://api.stripe.com/v1/payment_intents' && method === 'POST') {
      stripe.createCalls++;
      if (stripe.createFails) return jsonResponse(402, { error: { message: 'Stripe said no' } });
      const p = new URLSearchParams(String(init.body || ''));
      const id = 'pi_test_' + (++stripe.seq);
      stripe.add({ id, amount: Number(p.get('amount')), currency: p.get('currency'), status: 'requires_payment_method',
        metadata: { checkout_id: p.get('metadata[checkout_id]') } });
      return jsonResponse(200, stripe.pi(id));
    }
    const piGet = url.match(/^https:\/\/api\.stripe\.com\/v1\/payment_intents\/([^/?]+)$/);
    if (piGet && method === 'GET') {
      stripe.getCalls++;
      const pi = stripe.pis.get(decodeURIComponent(piGet[1]));
      return pi ? jsonResponse(200, stripe.pi(pi.id)) : jsonResponse(404, { error: { message: 'No such payment_intent' } });
    }
    if (url === 'https://api.stripe.com/v1/refunds' && method === 'POST') {
      const p = new URLSearchParams(String(init.body || ''));
      const headers = init.headers || {};
      stripe.refunds.push({ pi: p.get('payment_intent'), idempotencyKey: headers['Idempotency-Key'] || '' });
      if (stripe.refundFails) return jsonResponse(400, { error: { message: 'refund refused' } });
      return jsonResponse(200, { id: 're_' + stripe.refunds.length, status: 'succeeded' });
    }
    if (url.startsWith('https://api.telegram.org/')) {
      calls.telegram.push({ url, body: JSON.parse(String(init.body || '{}')) });
      return jsonResponse(200, { ok: true });
    }
    if (url === 'https://oauth2.googleapis.com/token') return jsonResponse(200, { access_token: 'test-access' });
    if (url.startsWith('https://gmail.googleapis.com/')) {
      const b = JSON.parse(String(init.body || '{}'));
      const raw = Buffer.from(String(b.raw || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
      const cut = raw.indexOf('\r\n\r\n');
      const head = raw.slice(0, cut);
      const html = raw.slice(cut + 4);
      const to = (head.match(/^To: (.*)$/m) || [])[1] || '';
      const sm = head.match(/^Subject: =\?UTF-8\?B\?(.*)\?=$/m);
      calls.gmail.push({ to: to.trim(), subject: sm ? Buffer.from(sm[1], 'base64').toString('utf8') : '', html });
      return jsonResponse(200, { id: 'msg_' + calls.gmail.length });
    }
    if (url.startsWith('https://graph.facebook.com/')) {
      calls.meta.push(url);
      if (world.metaThrows) throw new Error('meta is down');
      return jsonResponse(200, { events_received: 1 });
    }
    throw new Error('unexpected network call in test: ' + method + ' ' + url);
  };
  globalThis.fetch = world.fetch;

  const env = Object.assign({
    DB: db,
    STRIPE_SECRET_KEY: 'sk_test_harness',
    STRIPE_WEBHOOK_SECRET: 'whsec_harness_secret',
    TELEGRAM_BOT_TOKEN: '8882453395:HARNESS',
    TELEGRAM_CHAT_IDS: '8964116820',
    GMAIL_CLIENT_ID: 'cid', GMAIL_CLIENT_SECRET: 'csec', GMAIL_REFRESH_TOKEN: 'rtok',
    ADMIN_TOKEN: 'admin-harness',
    ALLOWED_ORIGINS: 'https://reviveaestheticsadl.com.au',
  }, opts.env || {});

  const pending = [];
  const errors = [];
  const ctx = { waitUntil(p) { pending.push(Promise.resolve(p).catch(e => errors.push(e))); }, passThroughOnException() {} };
  async function drain() {
    while (pending.length) await pending.shift();
  }

  async function call(method, p, body, headers) {
    globalThis.fetch = world.fetch;
    const init = { method, headers: Object.assign({ 'content-type': 'application/json' }, headers || {}) };
    if (body !== undefined) init.body = typeof body === 'string' ? body : JSON.stringify(body);
    const res = await worker.fetch(new Request('https://revive-booking.test' + p, init), env, ctx);
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch (_) { data = text; }
    await drain();
    return { status: res.status, data };
  }
  const admin = (method, p, body) => call(method, p, body, { Authorization: 'Bearer ' + env.ADMIN_TOKEN });

  async function cron(atMs) {
    globalThis.fetch = world.fetch;
    if (Number.isFinite(atMs)) clock.now = atMs;
    await worker.scheduled({ scheduledTime: clock.now, cron: '* * * * *' }, env, ctx);
    await drain();
  }

  let evSeq = 0;
  function evt(type, object, extra) {
    return Object.assign({ id: 'evt_' + type.replace(/\W/g, '_') + '_' + (++evSeq) + '_' + nodeCrypto.randomBytes(3).toString('hex'),
      object: 'event', type, created: Math.floor(clock.now / 1000), data: { object } }, extra || {});
  }
  // o: { secret, t, noHeader, header, bodyOverride, rotatedBadFirst }
  function webhook(event, o) {
    o = o || {};
    const raw = JSON.stringify(event);
    const t = Number.isFinite(o.t) ? o.t : Math.floor(clock.now / 1000);
    const secret = o.secret || env.STRIPE_WEBHOOK_SECRET || 'whsec_harness_secret';
    const sig = nodeCrypto.createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex');
    const headers = {};
    if (!o.noHeader) {
      headers['Stripe-Signature'] = o.header || (o.rotatedBadFirst ? `t=${t},v1=${'0'.repeat(64)},v1=${sig}` : `t=${t},v1=${sig}`);
    }
    return call('POST', '/api/webhooks/stripe', o.bodyOverride !== undefined ? o.bodyOverride : raw, headers);
  }

  const all = (sql, ...p) => db.sqlite.prepare(sql).all(...p).map(r => ({ ...r }));
  const one = (sql, ...p) => { const r = db.sqlite.prepare(sql).get(...p); return r ? { ...r } : null; };
  const row = id => one('SELECT * FROM bookings WHERE id = ?', id);

  const SLOT = { date: '2026-09-21', start_min: 600 };
  function person(tag) {
    // One distinct phone per tag for the whole process (a shared phone would make two
    // "people" the same customer, and the worker would rightly treat them as one).
    if (!PHONE_BY_TAG.has(tag)) PHONE_BY_TAG.set(tag, PHONE_BY_TAG.size + 101);
    return { name: 'Amy ' + tag, phone: '0400 111 ' + String(PHONE_BY_TAG.get(tag)).padStart(3, '0'), email: `amy.${tag.toLowerCase()}@example.com` };
  }
  async function startCheckout(who, over) {
    const body = Object.assign({ name: who.name, phone: who.phone, email: who.email, notes: 'first visit',
      treatment: 'lash-lift', addons: [], date: SLOT.date, start_min: SLOT.start_min }, over || {});
    const res = await call('POST', '/api/create-payment-intent', body);
    res.body = body;
    if (res.status === 200 && res.data.checkout_id) {
      const r = row(res.data.checkout_id);
      res.piId = r ? r.stripe_payment_intent_id : '';
    }
    return res;
  }
  function browserBook(checkout, piId) {
    const b = checkout.body;
    return call('POST', '/api/book', { treatment: b.treatment, addons: b.addons, date: b.date, start_min: b.start_min,
      name: b.name, phone: b.phone, email: b.email, notes: b.notes, website: '', payment_intent_id: piId || checkout.piId });
  }
  const emailsTo = addr => calls.gmail.filter(g => g.to === addr);
  const telegramsMatching = re => calls.telegram.filter(t => re.test(t.body.text));

  Object.assign(world, {
    worker, db, env, ctx, clock, call, admin, cron, drain, evt, webhook, all, one, row, SLOT, person,
    startCheckout, browserBook, emailsTo, telegramsMatching, errors,
    get internals() { return internals; },
  });
  return world;
}

module.exports = { createWorld, loadWorker, clock, at, logs, RealDate, get internals() { return internals; } };
