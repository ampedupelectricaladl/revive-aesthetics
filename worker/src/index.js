/**
 * Revive Aesthetics — booking API
 * Cloudflare Worker + D1. Zero dependencies.
 *
 * Public:
 *   GET  /api/treatments
 *   GET  /api/availability?treatment=<id>&from=YYYY-MM-DD&days=N
 *   POST /api/book    {treatment,date,time,name,phone,email,notes}
 *   GET  /api/booking?id=&token=
 *   POST /api/cancel  {id,token}
 * Admin (Authorization: Bearer ADMIN_TOKEN):
 *   GET  /api/admin/bookings?from=&to=
 *   GET  /api/admin/blocked
 *   POST /api/admin/block   {date,reason}
 *   POST /api/admin/unblock {date}
 *   POST /api/admin/cancel  {id}
 */

const TZ = 'Australia/Adelaide';
const OPEN_DAYS = [1, 2];        // Mon, Tue
const OPEN_MIN = 9 * 60;         // 9:00
const CLOSE_MIN = 17 * 60;       // 17:00
const GRID_MIN = 30;             // slot start times every 30 min
const BUFFER_MIN = 15;           // turnover between clients
const MIN_NOTICE_MIN = 12 * 60;  // bookings need 12h notice
const HORIZON_DAYS = 60;         // how far ahead clients can book

// ---------- time helpers (all wall-clock in Adelaide) ----------

function nowInAdelaide() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date());
  const get = t => parts.find(p => p.type === t).value;
  const date = `${get('year')}-${get('month')}-${get('day')}`;
  const min = parseInt(get('hour'), 10) * 60 + parseInt(get('minute'), 10);
  return { date, min, abs: absMin(date, min) };
}

function absMin(dateStr, min) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / 60000 + min;
}

function dayOfWeek(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}

function fmtTime(min) {
  const h24 = Math.floor(min / 60), mm = String(min % 60).padStart(2, '0');
  const ap = h24 < 12 ? 'am' : 'pm';
  const h = ((h24 + 11) % 12) + 1;
  return `${h}:${mm}${ap}`;
}

function fmtDate(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
}

function parseHHMM(t) {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(t || ''));
  return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : null;
}

const isDateStr = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

// ---------- availability ----------

async function slotsForDate(db, dateStr, durationMin, nowAbs) {
  if (!OPEN_DAYS.includes(dayOfWeek(dateStr))) return [];
  const blocked = await db.prepare('SELECT 1 FROM blocked_dates WHERE date = ?').bind(dateStr).first();
  if (blocked) return [];
  const { results: taken } = await db.prepare(
    "SELECT start_min, end_min FROM bookings WHERE date = ? AND status = 'confirmed'"
  ).bind(dateStr).all();
  const slots = [];
  for (let t = OPEN_MIN; t + durationMin <= CLOSE_MIN; t += GRID_MIN) {
    if (absMin(dateStr, t) < nowAbs + MIN_NOTICE_MIN) continue;
    const clash = taken.some(b => t < b.end_min + BUFFER_MIN && b.start_min < t + durationMin + BUFFER_MIN);
    if (!clash) slots.push(t);
  }
  return slots;
}

// ---------- telegram ----------

async function telegram(env, text) {
  if (!env.TELEGRAM_BOT_TOKEN) return;
  const ids = String(env.TELEGRAM_CHAT_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
  await Promise.allSettled(ids.map(chat_id =>
    fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id, text, parse_mode: 'HTML' }),
    })
  ));
}

// ---------- http plumbing ----------

function corsHeaders(req, env) {
  const origin = req.headers.get('Origin') || '';
  const allowed = String(env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim());
  const ok = allowed.includes(origin) || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  return {
    'Access-Control-Allow-Origin': ok ? origin : allowed[0] || '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Vary': 'Origin',
  };
}

const json = (data, status, cors) => new Response(JSON.stringify(data), {
  status, headers: { 'content-type': 'application/json', ...cors },
});

export default {
  async fetch(req, env, ctx) {
    const cors = corsHeaders(req, env);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    const url = new URL(req.url);
    const path = url.pathname;
    try {
      if (path.startsWith('/api/admin/')) {
        const auth = req.headers.get('Authorization') || '';
        if (!env.ADMIN_TOKEN || auth !== `Bearer ${env.ADMIN_TOKEN}`) {
          return json({ error: 'unauthorised' }, 401, cors);
        }
        return await handleAdmin(req, env, url, path, cors);
      }
      return await handlePublic(req, env, ctx, url, path, cors);
    } catch (e) {
      return json({ error: 'server_error', detail: String(e.message || e) }, 500, cors);
    }
  },
};

// ---------- public routes ----------

async function handlePublic(req, env, ctx, url, path, cors) {
  const db = env.DB;

  if (path === '/api/treatments' && req.method === 'GET') {
    const { results } = await db.prepare(
      'SELECT id, name, duration_min, price_aud, description FROM treatments WHERE active = 1 ORDER BY sort'
    ).all();
    return json({ treatments: results }, 200, cors);
  }

  if (path === '/api/availability' && req.method === 'GET') {
    const tId = url.searchParams.get('treatment');
    const t = await db.prepare('SELECT * FROM treatments WHERE id = ? AND active = 1').bind(tId).first();
    if (!t) return json({ error: 'unknown_treatment' }, 400, cors);
    const now = nowInAdelaide();
    let from = url.searchParams.get('from');
    if (!isDateStr(from) || from < now.date) from = now.date;
    const days = Math.min(parseInt(url.searchParams.get('days') || '60', 10) || 60, HORIZON_DAYS);
    const lastAllowed = addDays(now.date, HORIZON_DAYS);
    const dates = {};
    for (let i = 0; i < days; i++) {
      const d = addDays(from, i);
      if (d > lastAllowed) break;
      if (!OPEN_DAYS.includes(dayOfWeek(d))) continue; // cheap skip before hitting D1
      const slots = await slotsForDate(db, d, t.duration_min, now.abs);
      if (slots.length) dates[d] = slots.map(m => ({ min: m, label: fmtTime(m) }));
    }
    return json({ treatment: t.id, duration_min: t.duration_min, dates }, 200, cors);
  }

  if (path === '/api/book' && req.method === 'POST') {
    const b = await req.json().catch(() => ({}));
    if (b.website) return json({ ok: true }, 200, cors); // honeypot: pretend success

    const t = await db.prepare('SELECT * FROM treatments WHERE id = ? AND active = 1').bind(b.treatment).first();
    const startMin = parseHHMM(b.time) ?? (Number.isInteger(b.start_min) ? b.start_min : null);
    const name = String(b.name || '').trim();
    const phone = String(b.phone || '').trim();
    const email = String(b.email || '').trim().toLowerCase();
    const notes = String(b.notes || '').trim().slice(0, 800);

    if (!t) return json({ error: 'unknown_treatment' }, 400, cors);
    if (!isDateStr(b.date) || startMin === null) return json({ error: 'bad_slot' }, 400, cors);
    if (name.length < 2) return json({ error: 'name_required' }, 400, cors);
    if (phone.replace(/\D/g, '').length < 8) return json({ error: 'phone_required' }, 400, cors);
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: 'bad_email' }, 400, cors);

    const now = nowInAdelaide();
    const open = await slotsForDate(db, b.date, t.duration_min, now.abs);
    if (!open.includes(startMin)) return json({ error: 'slot_unavailable' }, 409, cors);

    // gentle abuse cap: max 2 upcoming bookings per phone/email
    const dup = await db.prepare(
      "SELECT COUNT(*) AS n FROM bookings WHERE status='confirmed' AND date >= ? AND (phone = ? OR (email != '' AND email = ?))"
    ).bind(now.date, phone, email || ' ').first();
    if (dup.n >= 2) return json({ error: 'too_many_bookings' }, 429, cors);

    const id = crypto.randomUUID().slice(0, 8);
    const cancelToken = crypto.randomUUID();
    try {
      await db.prepare(
        `INSERT INTO bookings (id, treatment_id, date, start_min, end_min, name, phone, email, notes, cancel_token, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(id, t.id, b.date, startMin, startMin + t.duration_min, name, phone, email, notes,
             cancelToken, new Date().toISOString()).run();
    } catch (e) {
      if (String(e.message || e).includes('UNIQUE')) return json({ error: 'slot_unavailable' }, 409, cors);
      throw e;
    }

    ctx.waitUntil(telegram(env,
      `\u{1F33F} <b>New Revive booking</b>\n` +
      `${t.name} — ${fmtDate(b.date)}, ${fmtTime(startMin)} (${t.duration_min} min)\n` +
      `${name} · ${phone}${email ? ' · ' + email : ''}` +
      (notes ? `\nNotes: ${notes}` : '') +
      `\nRef ${id}`
    ));

    return json({
      ok: true, id, cancel_token: cancelToken,
      treatment: t.name, date: b.date, date_label: fmtDate(b.date),
      time_label: fmtTime(startMin), duration_min: t.duration_min, price_aud: t.price_aud,
    }, 200, cors);
  }

  if (path === '/api/booking' && req.method === 'GET') {
    const row = await lookupBooking(db, url.searchParams.get('id'), url.searchParams.get('token'));
    if (!row) return json({ error: 'not_found' }, 404, cors);
    return json({
      id: row.id, status: row.status, treatment: row.tname,
      date: row.date, date_label: fmtDate(row.date), time_label: fmtTime(row.start_min), name: row.name,
    }, 200, cors);
  }

  if (path === '/api/cancel' && req.method === 'POST') {
    const b = await req.json().catch(() => ({}));
    const row = await lookupBooking(db, b.id, b.token);
    if (!row) return json({ error: 'not_found' }, 404, cors);
    if (row.status === 'confirmed') {
      await db.prepare("UPDATE bookings SET status='cancelled', cancelled_at=? WHERE id=?")
        .bind(new Date().toISOString(), row.id).run();
      ctx.waitUntil(telegram(env,
        `❌ <b>Revive booking cancelled</b>\n${row.tname} — ${fmtDate(row.date)}, ${fmtTime(row.start_min)}\n${row.name} · ${row.phone}\nRef ${row.id}`
      ));
    }
    return json({ ok: true, status: 'cancelled' }, 200, cors);
  }

  return json({ error: 'not_found' }, 404, cors);
}

async function lookupBooking(db, id, token) {
  if (!id || !token) return null;
  return db.prepare(
    `SELECT b.*, t.name AS tname FROM bookings b JOIN treatments t ON t.id = b.treatment_id
     WHERE b.id = ? AND b.cancel_token = ?`
  ).bind(String(id), String(token)).first();
}

// ---------- admin routes ----------

async function handleAdmin(req, env, url, path, cors) {
  const db = env.DB;

  if (path === '/api/admin/bookings' && req.method === 'GET') {
    const from = isDateStr(url.searchParams.get('from')) ? url.searchParams.get('from') : nowInAdelaide().date;
    const to = isDateStr(url.searchParams.get('to')) ? url.searchParams.get('to') : addDays(from, 30);
    const { results } = await db.prepare(
      `SELECT b.id, b.date, b.start_min, b.end_min, b.status, b.name, b.phone, b.email, b.notes,
              b.created_at, t.name AS treatment
       FROM bookings b JOIN treatments t ON t.id = b.treatment_id
       WHERE b.date BETWEEN ? AND ? ORDER BY b.date, b.start_min`
    ).bind(from, to).all();
    return json({ bookings: results.map(r => ({ ...r, time_label: fmtTime(r.start_min) })) }, 200, cors);
  }

  if (path === '/api/admin/blocked' && req.method === 'GET') {
    const { results } = await db.prepare('SELECT * FROM blocked_dates ORDER BY date').all();
    return json({ blocked: results }, 200, cors);
  }

  if (path === '/api/admin/block' && req.method === 'POST') {
    const b = await req.json().catch(() => ({}));
    if (!isDateStr(b.date)) return json({ error: 'bad_date' }, 400, cors);
    await db.prepare('INSERT OR REPLACE INTO blocked_dates (date, reason) VALUES (?, ?)')
      .bind(b.date, String(b.reason || '')).run();
    return json({ ok: true }, 200, cors);
  }

  if (path === '/api/admin/unblock' && req.method === 'POST') {
    const b = await req.json().catch(() => ({}));
    await db.prepare('DELETE FROM blocked_dates WHERE date = ?').bind(String(b.date || '')).run();
    return json({ ok: true }, 200, cors);
  }

  if (path === '/api/admin/cancel' && req.method === 'POST') {
    const b = await req.json().catch(() => ({}));
    await db.prepare("UPDATE bookings SET status='cancelled', cancelled_at=? WHERE id=?")
      .bind(new Date().toISOString(), String(b.id || '')).run();
    return json({ ok: true }, 200, cors);
  }

  return json({ error: 'not_found' }, 404, cors);
}
