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
 *   POST /api/intake  {name,phone,email,booking_id,...answers}
 * Admin (Authorization: Bearer ADMIN_TOKEN):
 *   GET  /api/admin/bookings?from=&to=
 *   GET  /api/admin/clients          (now includes latest intake per client)
 *   GET  /api/admin/intake?id=|phone=
 *   GET  /api/admin/blocked
 *   POST /api/admin/block   {date,reason}
 *   POST /api/admin/unblock {date}
 *   POST /api/admin/cancel  {id}
 */

const TZ = 'Australia/Adelaide';
const OPEN_DAYS = [1, 2];        // Mon, Tue
const OPEN_MIN = 9 * 60;         // 9:00am
const CLOSE_MIN = 21 * 60;       // 9:00pm
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

// ---------- email (Gmail API, sender = Revive's Gmail) ----------

function b64url(str) {
  return btoa(unescape(encodeURIComponent(str))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sendEmail(env, to, subject, html) {
  if (!env.GMAIL_REFRESH_TOKEN || !to) return;
  const tr = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GMAIL_CLIENT_ID, client_secret: env.GMAIL_CLIENT_SECRET,
      refresh_token: env.GMAIL_REFRESH_TOKEN, grant_type: 'refresh_token',
    }),
  });
  const { access_token } = await tr.json();
  if (!access_token) return;
  const raw = [
    `From: ${env.MAIL_FROM || 'Revive Aesthetics <reviveaestheticsadl@gmail.com>'}`,
    ...(env.MAIL_REPLY_TO ? [`Reply-To: ${env.MAIL_REPLY_TO}`] : []),
    `To: ${to}`,
    `Subject: =?UTF-8?B?${btoa(unescape(encodeURIComponent(subject)))}?=`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=UTF-8',
    '', html,
  ].join('\r\n');
  await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + access_token, 'content-type': 'application/json' },
    body: JSON.stringify({ raw: b64url(raw) }),
  });
}

function emailShell(heading, inner) {
  return `<!doctype html><body style="margin:0;padding:0;background:#f7f0df;">
  <div style="max-width:560px;margin:0 auto;font-family:Georgia,'Times New Roman',serif;">
    <div style="background:#2B0F1A;text-align:center;padding:34px 20px 26px;">
      <div style="color:#F2E7CE;font-size:22px;letter-spacing:6px;">REVIVE AESTHETICS</div>
      <div style="color:#c2a878;font-size:11px;letter-spacing:4px;margin-top:6px;">ADELAIDE SKIN STUDIO</div>
    </div>
    <div style="background:#fbf6ea;padding:34px 30px;color:#2b0f1a;">
      <h1 style="font-size:24px;font-weight:normal;margin:0 0 18px;">${heading}</h1>
      ${inner}
    </div>
    <div style="background:#2B0F1A;color:#F2E7CE;text-align:center;padding:20px;font-size:12px;">
      Revive Aesthetics · 262 Pulteney St, Adelaide SA · <a href="tel:0404967051" style="color:#c2a878;text-decoration:none;">0404 967 051</a><br>
      <a href="https://reviveaestheticsadl.com.au" style="color:#c2a878;text-decoration:none;">reviveaestheticsadl.com.au</a>
    </div>
  </div></body>`;
}

function bookingDetailsHtml(b) {
  return `<table style="width:100%;border-collapse:collapse;background:#fff;border:1px solid #e5dcc3;margin:16px 0;">
    ${[['Treatment', b.what], ['When', `${b.dateLabel}, ${b.timeLabel}`], ['Duration', `${b.duration} min`],
       ['Price', b.price > 0 ? '$' + b.price : 'Complimentary'], ['Where', '262 Pulteney St, Adelaide SA 5000']]
      .map(([k, v]) => `<tr><td style="padding:10px 14px;color:#b58a90;font-size:11px;letter-spacing:2px;text-transform:uppercase;border-bottom:1px solid #f2ecd9;">${k}</td>
        <td style="padding:10px 14px;border-bottom:1px solid #f2ecd9;">${v}</td></tr>`).join('')}
  </table>`;
}

function confirmationEmail(b, cancelUrl, intakeUrl) {
  const intakeBlock = intakeUrl ? `
    <p style="line-height:1.7;margin:22px 0 12px;">One quick thing before your visit — please complete your short pre-treatment form so Stefani can tailor your treatment safely:</p>
    <p style="text-align:center;margin:0 0 8px;">
      <a href="${intakeUrl}" style="display:inline-block;background:#2B0F1A;color:#F2E7CE;text-decoration:none;padding:13px 30px;letter-spacing:2px;text-transform:uppercase;font-size:12px;">Complete pre-treatment form</a>
    </p>
    <p style="line-height:1.6;font-size:12px;color:#6f5b58;text-align:center;">Takes about 2 minutes · kept completely private</p>` : '';
  return emailShell(`You're booked in, ${b.name.split(' ')[0]}`,
    `<p style="line-height:1.7;margin:0;">Thank you for booking with Revive Aesthetics — here are your appointment details:</p>
    ${bookingDetailsHtml(b)}
    ${intakeBlock}
    <p style="line-height:1.7;font-size:14px;color:#6f5b58;">Need to change or cancel? No stress —
    <a href="${cancelUrl}" style="color:#2B0F1A;">manage your booking here</a> or call Stefani on
    <a href="tel:0404967051" style="color:#2B0F1A;">0404 967 051</a>.</p>
    <p style="line-height:1.7;">See you soon,<br><em style="color:#c2a878;font-size:20px;">Stefani</em></p>`);
}

function reminderEmail(b, cancelUrl) {
  return emailShell(`See you tomorrow, ${b.name.split(' ')[0]}`,
    `<p style="line-height:1.7;margin:0;">Just a gentle reminder about your appointment:</p>
    ${bookingDetailsHtml(b)}
    <p style="line-height:1.7;font-size:14px;color:#6f5b58;">Arrive with clean skin if you can (no makeup is perfect).
    Something come up? <a href="${cancelUrl}" style="color:#2B0F1A;">Change your booking</a> or call
    <a href="tel:0404967051" style="color:#2B0F1A;">0404 967 051</a>.</p>
    <p style="line-height:1.7;">Looking forward to it,<br><em style="color:#c2a878;font-size:20px;">Stefani</em></p>`);
}

function cancelledEmail(b) {
  return emailShell('Your booking is cancelled',
    `<p style="line-height:1.7;margin:0;">Your ${b.what} on ${b.dateLabel} has been cancelled — all done, nothing owing.</p>
    <p style="line-height:1.7;">Ready for another time? <a href="https://reviveaestheticsadl.com.au/book.html" style="color:#2B0F1A;">Book online</a> any time.</p>
    <p style="line-height:1.7;">Hope to see you soon,<br><em style="color:#c2a878;font-size:20px;">Stefani</em></p>`);
}

function isoToAdelaideAbs(iso) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(iso));
  const g = (t) => parts.find(p => p.type === t).value;
  return absMin(`${g('year')}-${g('month')}-${g('day')}`, parseInt(g('hour'), 10) * 60 + parseInt(g('minute'), 10));
}

const CANCEL_BASE = 'https://reviveaestheticsadl.com.au/book.html';

async function sendReminders(env) {
  const db = env.DB;
  const now = nowInAdelaide();
  const { results } = await db.prepare(
    `SELECT b.*, t.name AS tname FROM bookings b JOIN treatments t ON t.id = b.treatment_id
     WHERE b.status = 'confirmed' AND b.reminded = 0 AND b.email != '' AND b.date BETWEEN ? AND ?`
  ).bind(now.date, addDays(now.date, 2)).all();
  for (const r of results) {
    const startAbs = absMin(r.date, r.start_min);
    const minsAway = startAbs - now.abs;
    if (minsAway <= 0 || minsAway > 26 * 60) continue;      // remind within ~26h of the visit
    if (startAbs - isoToAdelaideAbs(r.created_at) < 20 * 60) { // booked late — confirmation already covers it
      await db.prepare('UPDATE bookings SET reminded = 1 WHERE id = ?').bind(r.id).run();
      continue;
    }
    const info = {
      name: r.name, what: r.tname + (r.addon_names ? ' + ' + r.addon_names : ''),
      dateLabel: fmtDate(r.date), timeLabel: fmtTime(r.start_min),
      duration: r.end_min - r.start_min, price: 0,
    };
    const priceOf = await makePriceOf(db);
    info.price = priceOf({ price_aud: (await db.prepare('SELECT price_aud FROM treatments WHERE id=?').bind(r.treatment_id).first()).price_aud, addon_ids: r.addon_ids });
    await sendEmail(env, r.email, `Reminder: ${info.what} ${fmtTime(r.start_min)} tomorrow — Revive Aesthetics`,
      reminderEmail(info, `${CANCEL_BASE}?cancel=${r.id}&token=${r.cancel_token}`));
    await db.prepare('UPDATE bookings SET reminded = 1 WHERE id = ?').bind(r.id).run();
  }
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
  async scheduled(event, env, ctx) {
    ctx.waitUntil(sendReminders(env));
  },
};

// ---------- public routes ----------

async function handlePublic(req, env, ctx, url, path, cors) {
  const db = env.DB;

  if (path === '/api/treatments' && req.method === 'GET') {
    const { results } = await db.prepare(
      'SELECT id, name, duration_min, price_aud, description FROM treatments WHERE active = 1 ORDER BY sort'
    ).all();
    const { results: addons } = await db.prepare(
      'SELECT id, name, duration_min, price_aud FROM addons WHERE active = 1 ORDER BY price_aud DESC, name'
    ).all();
    return json({ treatments: results, addons }, 200, cors);
  }

  if (path === '/api/availability' && req.method === 'GET') {
    const tId = url.searchParams.get('treatment');
    const t = await db.prepare('SELECT * FROM treatments WHERE id = ? AND active = 1').bind(tId).first();
    if (!t) return json({ error: 'unknown_treatment' }, 400, cors);
    const addons = await lookupAddons(db, url.searchParams.get('addon'));
    if (addons === undefined) return json({ error: 'unknown_addon' }, 400, cors);
    const duration = t.duration_min + addons.reduce((s, a) => s + a.duration_min, 0);
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
      const slots = await slotsForDate(db, d, duration, now.abs);
      if (slots.length) dates[d] = slots.map(m => ({ min: m, label: fmtTime(m) }));
    }
    return json({ treatment: t.id, duration_min: duration, dates }, 200, cors);
  }

  if (path === '/api/book' && req.method === 'POST') {
    const b = await req.json().catch(() => ({}));
    if (b.website) return json({ ok: true }, 200, cors); // honeypot: pretend success

    const t = await db.prepare('SELECT * FROM treatments WHERE id = ? AND active = 1').bind(b.treatment).first();
    const addons = await lookupAddons(db, b.addons ?? b.addon);
    if (addons === undefined) return json({ error: 'unknown_addon' }, 400, cors);
    const startMin = parseHHMM(b.time) ?? (Number.isInteger(b.start_min) ? b.start_min : null);
    const name = String(b.name || '').trim();
    const phone = String(b.phone || '').trim();
    const email = String(b.email || '').trim().toLowerCase();
    const notes = String(b.notes || '').trim().slice(0, 800);

    if (!t) return json({ error: 'unknown_treatment' }, 400, cors);
    if (!isDateStr(b.date) || startMin === null) return json({ error: 'bad_slot' }, 400, cors);
    if (name.length < 2) return json({ error: 'name_required' }, 400, cors);
    if (phone.replace(/\D/g, '').length < 8) return json({ error: 'phone_required' }, 400, cors);
    if (!email) return json({ error: 'email_required' }, 400, cors);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: 'bad_email' }, 400, cors);

    const duration = t.duration_min + addons.reduce((s, a) => s + a.duration_min, 0);
    const price = t.price_aud + addons.reduce((s, a) => s + a.price_aud, 0);
    const addonNames = addons.map(a => a.name).join(' + ');
    const now = nowInAdelaide();
    const open = await slotsForDate(db, b.date, duration, now.abs);
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
        `INSERT INTO bookings (id, treatment_id, addon_ids, addon_names, date, start_min, end_min, name, phone, email, notes, cancel_token, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(id, t.id, addons.map(a => a.id).join(','), addonNames, b.date, startMin, startMin + duration,
             name, phone, email, notes, cancelToken, new Date().toISOString()).run();
    } catch (e) {
      if (String(e.message || e).includes('UNIQUE')) return json({ error: 'slot_unavailable' }, 409, cors);
      throw e;
    }

    const what = t.name + (addonNames ? ' + ' + addonNames : '');
    const cancelUrl = `${CANCEL_BASE}?cancel=${id}&token=${cancelToken}`;
    ctx.waitUntil(Promise.allSettled([
      telegram(env,
        `\u{1F33F} <b>New Revive booking</b>\n` +
        `${what} — ${fmtDate(b.date)}, ${fmtTime(startMin)} (${duration} min · $${price})\n` +
        `${name} · ${phone}${email ? ' · ' + email : ''}` +
        (notes ? `\nNotes: ${notes}` : '') +
        `\nRef ${id}`
      ),
      sendEmail(env, email, `Booking confirmed: ${what}, ${fmtDate(b.date)} ${fmtTime(startMin)} — Revive Aesthetics`,
        confirmationEmail({ name, what, dateLabel: fmtDate(b.date), timeLabel: fmtTime(startMin), duration, price }, cancelUrl,
          `https://reviveaestheticsadl.com.au/intake.html?booking=${id}&name=${encodeURIComponent(name)}&phone=${encodeURIComponent(phone)}&email=${encodeURIComponent(email)}`)),
    ]));

    return json({
      ok: true, id, cancel_token: cancelToken,
      treatment: t.name, addon: addonNames || null,
      date: b.date, date_label: fmtDate(b.date),
      time_label: fmtTime(startMin), duration_min: duration,
      price_aud: price,
    }, 200, cors);
  }

  // Live calendar feed — subscribe in Google/Apple Calendar (key = admin token)
  if (path === '/api/feed.ics' && req.method === 'GET') {
    const key = url.searchParams.get('key') || '';
    if (!env.ADMIN_TOKEN || key !== env.ADMIN_TOKEN) return new Response('forbidden', { status: 403 });
    const now = nowInAdelaide();
    const { results } = await db.prepare(
      `SELECT b.*, t.name AS tname FROM bookings b JOIN treatments t ON t.id = b.treatment_id
       WHERE b.status = 'confirmed' AND b.date BETWEEN ? AND ? ORDER BY b.date, b.start_min`
    ).bind(addDays(now.date, -30), addDays(now.date, 90)).all();
    const pad = (n) => String(n).padStart(2, '0');
    const fmtIcs = (date, min) => date.replace(/-/g, '') + 'T' + pad(Math.floor(min / 60)) + pad(min % 60) + '00';
    const escIcs = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/[,;]/g, m => '\\' + m).replace(/\n/g, '\\n');
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Revive Aesthetics//Bookings//EN',
      'CALSCALE:GREGORIAN', 'X-WR-CALNAME:Revive Bookings', 'X-WR-TIMEZONE:Australia/Adelaide'];
    for (const b of results) {
      lines.push('BEGIN:VEVENT',
        `UID:${b.id}@revive-booking`,
        `DTSTAMP:${b.created_at.replace(/[-:]/g, '').slice(0, 15)}Z`,
        `DTSTART;TZID=Australia/Adelaide:${fmtIcs(b.date, b.start_min)}`,
        `DTEND;TZID=Australia/Adelaide:${fmtIcs(b.date, b.end_min)}`,
        `SUMMARY:${escIcs(b.name + ' — ' + b.tname + (b.addon_names ? ' + ' + b.addon_names : ''))}`,
        `DESCRIPTION:${escIcs(b.phone + (b.email ? ' · ' + b.email : '') + (b.notes ? '\n' + b.notes : ''))}`,
        'END:VEVENT');
    }
    lines.push('END:VCALENDAR');
    return new Response(lines.join('\r\n'), {
      headers: { 'content-type': 'text/calendar; charset=utf-8' },
    });
  }

  if (path === '/api/booking' && req.method === 'GET') {
    const row = await lookupBooking(db, url.searchParams.get('id'), url.searchParams.get('token'));
    if (!row) return json({ error: 'not_found' }, 404, cors);
    return json({
      id: row.id, status: row.status, treatment: row.tname + (row.aname ? ' + ' + row.aname : ''),
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
      ctx.waitUntil(Promise.allSettled([
        telegram(env,
          `❌ <b>Revive booking cancelled</b>\n${row.tname}${row.aname ? ' + ' + row.aname : ''} — ${fmtDate(row.date)}, ${fmtTime(row.start_min)}\n${row.name} · ${row.phone}\nRef ${row.id}`
        ),
        sendEmail(env, row.email, `Booking cancelled — Revive Aesthetics`,
          cancelledEmail({ what: row.tname + (row.aname ? ' + ' + row.aname : ''), dateLabel: fmtDate(row.date) })),
      ]));
    }
    return json({ ok: true, status: 'cancelled' }, 200, cors);
  }

  if (path === '/api/intake' && req.method === 'POST') {
    const body = await req.json().catch(() => ({}));
    if (body.website) return json({ ok: true }, 200, cors); // honeypot: pretend success
    const name = String(body.name || '').trim().slice(0, 120);
    const phone = String(body.phone || '').trim().slice(0, 40);
    const email = String(body.email || '').trim().toLowerCase().slice(0, 160);
    if (name.length < 2) return json({ error: 'name_required' }, 400, cors);

    const p = sanitiseIntake(body);
    if (!p.consent_accurate || !p.consent_course || !p.consent_aftercare || p.signature.length < 2) {
      return json({ error: 'consent_required' }, 400, cors);
    }
    const flags = intakeFlags(p);
    const summary = intakeSummary(p).slice(0, 240);
    const id = crypto.randomUUID().slice(0, 10);
    await db.prepare(
      `INSERT INTO intake_forms (id, booking_id, name, phone, email, summary, flags, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(id, String(body.booking_id || '').slice(0, 16) || null, name, phone, email,
           summary, flags.join(','), JSON.stringify(p), new Date().toISOString()).run();

    ctx.waitUntil(telegram(env,
      `\u{1F4CB} <b>New pre-treatment form</b>\n${name}${phone ? ' · ' + phone : ''}\n${summary || '—'}` +
      (flags.length ? `\n⚠️ <b>REVIEW: ${flags.join(', ').toUpperCase()}</b> — confirm suitability before treating` : '')));

    return json({ ok: true, id, flagged: flags.length > 0 }, 200, cors);
  }

  return json({ error: 'not_found' }, 404, cors);
}

async function lookupBooking(db, id, token) {
  if (!id || !token) return null;
  return db.prepare(
    `SELECT b.*, t.name AS tname, b.addon_names AS aname
     FROM bookings b JOIN treatments t ON t.id = b.treatment_id
     WHERE b.id = ? AND b.cancel_token = ?`
  ).bind(String(id), String(token)).first();
}

/** Accepts an array of ids or a CSV string. Returns [] for none,
 *  undefined if any requested addon is unknown/inactive. */
async function lookupAddons(db, ids) {
  const list = (Array.isArray(ids) ? ids : String(ids || '').split(','))
    .map(s => String(s).trim()).filter(Boolean);
  if (!list.length) return [];
  const out = [];
  for (const id of [...new Set(list)]) {
    const a = await db.prepare('SELECT * FROM addons WHERE id = ? AND active = 1').bind(id).first();
    if (!a) return undefined;
    out.push(a);
  }
  return out;
}

// ---------- admin routes ----------

async function handleAdmin(req, env, url, path, cors) {
  const db = env.DB;

  if (path === '/api/admin/bookings' && req.method === 'GET') {
    const from = isDateStr(url.searchParams.get('from')) ? url.searchParams.get('from') : nowInAdelaide().date;
    const to = isDateStr(url.searchParams.get('to')) ? url.searchParams.get('to') : addDays(from, 30);
    const { results } = await db.prepare(
      `SELECT b.id, b.date, b.start_min, b.end_min, b.status, b.name, b.phone, b.email, b.notes,
              b.created_at, b.addon_ids, t.name AS treatment, t.price_aud, b.addon_names AS addon
       FROM bookings b JOIN treatments t ON t.id = b.treatment_id
       WHERE b.date BETWEEN ? AND ? ORDER BY b.date, b.start_min`
    ).bind(from, to).all();
    const priceOf = await makePriceOf(db);
    return json({
      bookings: results.map(r => ({
        ...r, addon_ids: undefined, price_aud: priceOf(r),
        time_label: fmtTime(r.start_min), date_label: fmtDate(r.date),
      })),
    }, 200, cors);
  }

  if (path === '/api/admin/clients' && req.method === 'GET') {
    const { results } = await db.prepare(
      `SELECT b.name, b.phone, b.email, b.date, b.notes, b.addon_ids, b.status,
              t.name AS treatment, t.price_aud
       FROM bookings b JOIN treatments t ON t.id = b.treatment_id
       WHERE b.status = 'confirmed' ORDER BY b.date`
    ).all();
    const priceOf = await makePriceOf(db);
    const today = nowInAdelaide().date;
    const map = new Map();
    for (const r of results) {
      const key = r.phone.replace(/\D/g, '') || r.email;
      const c = map.get(key) || {
        name: r.name, phone: r.phone, email: '', visits: 0,
        first_visit: null, last_visit: null, next_booking: null,
        next_treatment: null, total_aud: 0, last_notes: '',
      };
      c.name = r.name;
      if (r.email) c.email = r.email;
      if (r.notes) c.last_notes = r.notes;
      if (!c.first_visit || r.date < c.first_visit) c.first_visit = r.date;
      if (r.date <= today) {
        c.visits++;
        c.total_aud += priceOf(r);
        if (!c.last_visit || r.date > c.last_visit) c.last_visit = r.date;
      } else if (!c.next_booking || r.date < c.next_booking) {
        c.next_booking = r.date;
        c.next_treatment = r.treatment;
      }
      map.set(key, c);
    }
    // attach the latest pre-treatment form per client (match by phone digits, then email)
    const { results: intakeRows } = await db.prepare(
      'SELECT phone, email, summary, flags, created_at FROM intake_forms ORDER BY created_at'
    ).all();
    const intakeByKey = new Map();
    for (const r of intakeRows) {
      const byPhone = String(r.phone || '').replace(/\D/g, '');
      const byEmail = String(r.email || '').toLowerCase();
      if (byPhone) intakeByKey.set('p:' + byPhone, r); // asc order => last write wins = latest
      if (byEmail) intakeByKey.set('e:' + byEmail, r);
    }
    for (const c of map.values()) {
      const it = intakeByKey.get('p:' + String(c.phone || '').replace(/\D/g, ''))
        || intakeByKey.get('e:' + String(c.email || '').toLowerCase());
      if (it) c.intake = { summary: it.summary, flags: it.flags ? it.flags.split(',').filter(Boolean) : [], date: (it.created_at || '').slice(0, 10) };
    }

    const clients = [...map.values()].sort((a, b) =>
      (b.next_booking || b.last_visit || '').localeCompare(a.next_booking || a.last_visit || ''));
    return json({ clients, total: clients.length }, 200, cors);
  }

  if (path === '/api/admin/intake' && req.method === 'GET') {
    const id = url.searchParams.get('id');
    const phone = url.searchParams.get('phone');
    let rows = [];
    if (id) {
      const r = await db.prepare('SELECT * FROM intake_forms WHERE id = ?').bind(String(id)).first();
      rows = r ? [r] : [];
    } else if (phone) {
      const digits = String(phone).replace(/\D/g, '');
      const { results } = await db.prepare(
        "SELECT * FROM intake_forms WHERE REPLACE(REPLACE(REPLACE(REPLACE(phone,' ',''),'-',''),'+',''),'(','') LIKE ? ORDER BY created_at DESC"
      ).bind('%' + digits + '%').all();
      rows = results;
    } else {
      const { results } = await db.prepare(
        'SELECT id, booking_id, name, phone, email, summary, flags, created_at FROM intake_forms ORDER BY created_at DESC LIMIT 200'
      ).all();
      rows = results;
    }
    return json({ intake: rows.map(r => ({ ...r, payload: r.payload ? JSON.parse(r.payload) : undefined })) }, 200, cors);
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

/** Returns a fn computing full price (treatment + add-ons) for a booking row
 *  that has price_aud (treatment) and addon_ids. */
async function makePriceOf(db) {
  const { results: addons } = await db.prepare('SELECT id, price_aud FROM addons').all();
  const priceMap = Object.fromEntries(addons.map(a => [a.id, a.price_aud]));
  return (r) => r.price_aud + String(r.addon_ids || '').split(',').filter(Boolean)
    .reduce((s, id) => s + (priceMap[id] || 0), 0);
}

// ---------- intake forms ----------

// Hard contraindications: a "yes" answer to any of these means Stefani must
// review suitability before treating. [payload key, admin label].
const INTAKE_FLAGS = [
  ['pregnant', 'pregnancy'],
  ['accutane', 'roaccutane'],
  ['keloid', 'keloid-scarring'],
  ['infection', 'active-infection'],
  ['healing', 'healing/immune'],
  ['coldsores', 'cold-sores'],
];

function intakeFlags(p) {
  return INTAKE_FLAGS
    .filter(([k]) => String(p[k] || '').toLowerCase() === 'yes')
    .map(([, label]) => label);
}

function intakeSummary(p) {
  const bits = [];
  if (Array.isArray(p.concerns) && p.concerns.length) bits.push('Concerns: ' + p.concerns.join(', '));
  if (p.skin_type) bits.push('Skin: ' + p.skin_type);
  if (p.meds) bits.push('Meds: ' + p.meds);
  if (p.allergies) bits.push('Allergies: ' + p.allergies);
  return bits.join(' · ');
}

/** Whitelist + size-cap the raw form body so we never store unbounded junk. */
function sanitiseIntake(b) {
  const str = (v, n = 200) => String(v == null ? '' : v).slice(0, n);
  const arr = (v) => (Array.isArray(v) ? v : []).slice(0, 30).map((x) => str(x, 80));
  const yn = (v) => { const s = String(v || '').toLowerCase(); return s === 'yes' ? 'yes' : s === 'no' ? 'no' : ''; };
  return {
    concerns: arr(b.concerns),
    skin_type: str(b.skin_type, 40),
    fitzpatrick: str(b.fitzpatrick, 60),
    routine: str(b.routine, 600),
    pregnant: yn(b.pregnant), accutane: yn(b.accutane), retinoids: yn(b.retinoids),
    keloid: yn(b.keloid), coldsores: yn(b.coldsores), infection: yn(b.infection), healing: yn(b.healing),
    meds: str(b.meds, 600), allergies: str(b.allergies, 400),
    recent_tx: arr(b.recent_tx), recent_when: str(b.recent_when, 300),
    sun: yn(b.sun), prior_reaction: str(b.prior_reaction, 400),
    smoker: yn(b.smoker), sun_habits: str(b.sun_habits, 300),
    consent_accurate: !!b.consent_accurate, consent_course: !!b.consent_course, consent_aftercare: !!b.consent_aftercare,
    photo_consent: yn(b.photo_consent), signature: str(b.signature, 120),
  };
}
