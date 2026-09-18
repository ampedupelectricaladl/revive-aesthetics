/**
 * Revive Aesthetics — booking API
 * Cloudflare Worker + D1. Zero dependencies.
 *
 * Public:
 *   GET  /api/treatments
 *   GET  /api/availability?treatment=<id>&from=YYYY-MM-DD&days=N
 *   POST /api/create-payment-intent  {name,phone,email,notes,treatment,addons,date,start_min,checkout_id?}
 *        → {client_secret, deposit_cents, checkout_id, policy}   (409 slot_unavailable / 429 too_many_bookings BEFORE any card)
 *        Writes a status='pending' bookings row that HOLDS the slot for HOLD_MIN minutes; checkout_id is its id.
 *   POST /api/book    {treatment,date,time,name,phone,email,notes,payment_intent_id}
 *        (confirms the held row; idempotent with the webhook. A paid deposit that cannot be booked is refunded: {error, refunded:true|false})
 *   POST /api/webhooks/stripe  (Stripe-Signature verified against STRIPE_WEBHOOK_SECRET; payment_intent.succeeded |
 *        payment_intent.payment_failed | payment_intent.canceled | charge.refunded)
 *   GET  /api/booking?id=&token=
 *   POST /api/cancel  {id,token}
 *   POST /api/intake  {name,phone,email,booking_id,...answers}
 *   POST /api/consent {form,name,phone,email,booking_id,...answers}  (sculpt consent forms: body-sculpt | face-sculpt)
 *   POST /api/survey  {survey,...answers}   (mini market-research polls, e.g. lash lifts)
 * Admin (Authorization: Bearer ADMIN_TOKEN):
 *   GET  /api/admin/bookings?from=&to=
 *   GET  /api/admin/clients          (now includes latest intake per client)
 *   GET  /api/admin/intake?id=|phone=
 *   GET  /api/admin/survey?survey=lash-lift
 *   GET  /api/admin/blocked
 *   POST /api/admin/block   {date,reason}
 *   POST /api/admin/unblock {date}
 *   POST /api/admin/book    {date,start_min,end_min,name?,notes?}  (silent — no email/Telegram)
 *   POST /api/admin/cancel  {id}
 *   POST /api/admin/send-confirmation {id, price_override?, intro?}  (re/send booking email, e.g. manual bookings)
 *   POST /api/admin/set-allowed-slots {date,slots:[start_min,...]}  (pin exact public slots for a date)
 *   POST /api/admin/clear-allowed-slots {date}  (restore normal availability for a date)
 *   POST /api/admin/migrate  (idempotent: create any missing tables/columns, backfill bookings.lifecycle)
 *   GET  /api/admin/report?from=YYYY-MM-DD&to=YYYY-MM-DD  (deposit funnel + money, by Adelaide day the booking was started)
 *   GET  /api/admin/bookings?...&include=all  (default: confirmed + cancelled only; pending/abandoned checkouts excluded)
 * Cron (every minute): stuck Stripe events, lapsed holds, due drop-off follow-ups, completed marking;
 *   at Adelaide minute 0 also day-before reminders and the follow-up backstop sweep.
 *   GET  /api/admin/client-flags               (list phones flagged as requiring deposit)
 *   POST /api/admin/flag-client {phone, require_deposit, note?}  (flag/unflag a client)
 */

const TZ = 'Australia/Adelaide';
const OPEN_DAYS = [1, 2];        // Mon, Tue
const OPEN_MIN = 10 * 60;        // 10:00am
const CLOSE_MIN = 20 * 60;       // 8:00pm
const GRID_MIN = 30;             // slot start times every 30 min
const BUFFER_MIN = 15;           // turnover between clients (setup/cleanup)
const MIN_NOTICE_MIN = 12 * 60;  // bookings need 12h notice
const HORIZON_DAYS = 60;         // how far ahead clients can book

// ---------- time helpers (all wall-clock in Adelaide) ----------

const ADELAIDE_WALL_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

// The Adelaide wall clock at an instant (epoch ms). DST is Intl's job, never ours.
function adelaideWall(ms) {
  const parts = ADELAIDE_WALL_FMT.formatToParts(new Date(ms));
  const get = t => parts.find(p => p.type === t).value;
  const date = `${get('year')}-${get('month')}-${get('day')}`;
  const min = parseInt(get('hour'), 10) * 60 + parseInt(get('minute'), 10);
  return { date, min, abs: absMin(date, min) };
}

// nowMs is injectable so cron runs and tests evaluate "now" at one fixed instant.
function nowInAdelaide(nowMs) {
  return adelaideWall(Number.isFinite(nowMs) ? nowMs : Date.now());
}

// created_at is ISO ("2026-09-14T00:30:00.000Z") on rows the worker wrote, but rows
// inserted by hand with datetime('now') read "2026-08-05 10:06:01" - that is UTC too,
// and must not be parsed as local time. Returns epoch ms, or NaN.
function parseStoredInstant(value) {
  if (typeof value === 'number') return value;
  const s = String(value || '').trim();
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s)) return Date.parse(s.replace(' ', 'T') + 'Z');
  return s ? Date.parse(s) : NaN;
}

// The Adelaide calendar date an instant falls on, or null.
function adelaideDateOfInstant(value) {
  const ms = parseStoredInstant(value);
  return Number.isFinite(ms) ? adelaideWall(ms).date : null;
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

// What occupies a date: confirmed bookings PLUS active checkout holds (status 'pending',
// a hold lifecycle, hold_until still in the future). opts.excludeId drops one row (the
// checkout being resumed or confirmed); a hold belonging to the same person (phone digits
// or email) never blocks them, so a customer retrying from the follow-up email is not told
// her own abandoned attempt has taken the time.
async function takenForDate(db, dateStr, opts) {
  opts = opts || {};
  const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
  let rows;
  try {
    ({ results: rows } = await db.prepare(
      `SELECT id, start_min, end_min, status, phone, email FROM bookings
       WHERE date = ? AND (status = 'confirmed'
         OR (status = 'pending' AND lifecycle IN ('started', 'deposit_pending', 'deposit_failed') AND hold_until > ?))`
    ).bind(dateStr, nowMs).all());
  } catch (e) {
    // Never let the hold columns take availability down: fall back to confirmed bookings.
    console.error('hold-aware availability query failed, using confirmed bookings only:', String(e && e.message || e).slice(0, 200));
    ({ results: rows } = await db.prepare(
      "SELECT id, start_min, end_min, status, phone, email FROM bookings WHERE date = ? AND status = 'confirmed'"
    ).bind(dateStr).all());
  }
  const holderPhone = String(opts.holderPhone || '').replace(/\D/g, '');
  const holderEmail = String(opts.holderEmail || '').trim().toLowerCase();
  return rows.filter(r => {
    if (opts.excludeId && r.id === opts.excludeId) return false;
    if (r.status !== 'pending') return true;
    if (holderPhone && String(r.phone || '').replace(/\D/g, '') === holderPhone) return false;
    if (holderEmail && String(r.email || '').trim().toLowerCase() === holderEmail) return false;
    return true;
  });
}

// opts: { excludeId, holderPhone, holderEmail, nowMs, noticeMin } - all optional.
async function slotsForDate(db, dateStr, durationMin, nowAbs, opts) {
  opts = opts || {};
  const noticeMin = Number.isFinite(opts.noticeMin) ? opts.noticeMin : MIN_NOTICE_MIN;
  if (!OPEN_DAYS.includes(dayOfWeek(dateStr))) return [];
  const blocked = await db.prepare('SELECT 1 FROM blocked_dates WHERE date = ?').bind(dateStr).first();
  if (blocked) return [];
  const taken = await takenForDate(db, dateStr, opts);

  // Slot overrides: if any rows exist for this date, only those start_min values are candidates.
  let allowedSet = null;
  try {
    const { results: overrides } = await db.prepare(
      'SELECT start_min FROM slot_overrides WHERE date = ?'
    ).bind(dateStr).all();
    if (overrides.length > 0) allowedSet = new Set(overrides.map(o => o.start_min));
  } catch (_) { /* table not yet migrated — treat as no overrides */ }

  const slots = [];
  if (allowedSet) {
    // Admin has pinned exact slots for this date — iterate those directly,
    // honouring off-grid times and late starts without enforcing CLOSE_MIN.
    // No minimum notice: if Stefani pinned a slot, it's intentionally bookable now.
    for (const t of [...allowedSet].sort((a, b) => a - b)) {
      if (absMin(dateStr, t) < nowAbs) continue;  // only skip slots already past
      const clash = taken.some(b => t < b.end_min + BUFFER_MIN && b.start_min < t + durationMin + BUFFER_MIN);
      if (!clash) slots.push(t);
    }
  } else {
    for (let t = OPEN_MIN; t + durationMin <= CLOSE_MIN; t += GRID_MIN) {
      if (absMin(dateStr, t) < nowAbs + noticeMin) continue;
      const clash = taken.some(b => t < b.end_min + BUFFER_MIN && b.start_min < t + durationMin + BUFFER_MIN);
      if (!clash) slots.push(t);
    }
  }
  return slots;
}

// ---------- meta conversions api ----------
// Server-side copy of the booking conversion. Far more reliable than the browser
// pixel (ad blockers, iOS, closed tabs), and the worker is the only place that
// knows for certain the booking was actually written.
//
// TO SWITCH ON, set both secrets:
//   npx wrangler secret put META_PIXEL_ID
//   npx wrangler secret put META_CAPI_TOKEN
// Until then this is a no-op: it makes no request and logs nothing.
//
// Deduplication: the browser fires Schedule with eventID = booking id and this
// sends the same event_id, so Meta counts ONE conversion, not two. If you change
// the id on one side you must change it on the other.

const META_API_VERSION = 'v21.0';

async function sha256Hex(value) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// Meta wants E.164 digits with country code and no punctuation or leading +.
// Australian mobiles are stored locally as 0404 967 051 -> 61404967051.
function normalisePhoneForMeta(phone) {
  let d = String(phone || '').replace(/\D/g, '');
  if (!d) return '';
  if (d.startsWith('61')) return d;
  if (d.startsWith('0')) return '61' + d.slice(1);
  if (d.length === 9) return '61' + d;
  return d;
}

async function metaConversion(env, { eventName, eventId, email, phone, name, value, contentName, sourceUrl, clientIp, userAgent }) {
  if (!env.META_PIXEL_ID || !env.META_CAPI_TOKEN) return;

  const userData = {};
  const em = String(email || '').trim().toLowerCase();
  if (em) userData.em = [await sha256Hex(em)];
  const ph = normalisePhoneForMeta(phone);
  if (ph) userData.ph = [await sha256Hex(ph)];
  const first = String(name || '').trim().split(/\s+/)[0];
  if (first) userData.fn = [await sha256Hex(first.toLowerCase())];
  if (clientIp) userData.client_ip_address = clientIp;
  if (userAgent) userData.client_user_agent = userAgent;

  const payload = {
    data: [{
      event_name: eventName,
      event_time: Math.floor(Date.now() / 1000),
      event_id: eventId,
      action_source: 'website',
      event_source_url: sourceUrl || CANCEL_BASE,
      user_data: userData,
      custom_data: { currency: 'AUD', value: value, content_name: contentName },
    }],
  };

  try {
    const res = await fetch(
      `https://graph.facebook.com/${META_API_VERSION}/${env.META_PIXEL_ID}/events?access_token=${encodeURIComponent(env.META_CAPI_TOKEN)}`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }
    );
    if (!res.ok) {
      // Loud enough to find in `wrangler tail`, never loud enough to affect a booking.
      console.log('meta capi failed', res.status, (await res.text()).slice(0, 300));
    }
  } catch (e) {
    console.log('meta capi error', String(e && e.message || e).slice(0, 200));
  }
}

// ---------- telegram ----------

// ⚠️ FIREWALL: this worker may only ever speak through @ReviveAdlBot. Its numeric bot id
// is public (it is the part of every token before the colon), so the check costs nothing
// and stops a wrong token - another business's bot - from ever being used from here.
const REVIVE_BOT_TOKEN_PREFIX = '8882453395:';

async function telegram(env, text) {
  if (!env.TELEGRAM_BOT_TOKEN) return;
  if (!String(env.TELEGRAM_BOT_TOKEN).startsWith(REVIVE_BOT_TOKEN_PREFIX)) {
    console.error('telegram refused: TELEGRAM_BOT_TOKEN is not the @ReviveAdlBot token - nothing sent');
    return;
  }
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
  const resp = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + access_token, 'content-type': 'application/json' },
    body: JSON.stringify({ raw: b64url(raw) }),
  });
  return resp.ok;
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

function confirmationEmail(b, cancelUrl, forms) {
  forms = forms || {};
  let formsBlock = '';
  if (forms.prep && forms.form) {
    formsBlock = `
    <p style="line-height:1.7;margin:22px 0 14px;">Before your visit, please read your prep guide and complete your pre-treatment form:</p>
    <table style="width:100%;border-collapse:collapse;margin-bottom:8px;">
      <tr>
        <td style="width:50%;padding-right:6px;text-align:center;vertical-align:top;">
          <a href="${forms.prep}" style="display:block;background:#c2a878;color:#2B0F1A;text-decoration:none;padding:13px 10px;letter-spacing:1px;text-transform:uppercase;font-size:11px;font-weight:500;">Prep Guide</a>
          <p style="font-size:11px;color:#6f5b58;margin-top:4px;">What to do before you arrive</p>
        </td>
        <td style="width:50%;padding-left:6px;text-align:center;vertical-align:top;">
          <a href="${forms.form}" style="display:block;background:#2B0F1A;color:#F2E7CE;text-decoration:none;padding:13px 10px;letter-spacing:1px;text-transform:uppercase;font-size:11px;">Pre-Treatment Form</a>
          <p style="font-size:11px;color:#6f5b58;margin-top:4px;">Health &amp; consent · takes 2 min</p>
        </td>
      </tr>
    </table>`;
  } else if (forms.prep) {
    formsBlock = `
    <p style="line-height:1.7;margin:22px 0 12px;">Please read your prep guide before your visit — it has everything you need to know:</p>
    <p style="text-align:center;margin:0 0 8px;">
      <a href="${forms.prep}" style="display:inline-block;background:#2B0F1A;color:#F2E7CE;text-decoration:none;padding:13px 30px;letter-spacing:2px;text-transform:uppercase;font-size:12px;">View Prep Guide</a>
    </p>`;
  } else if (forms.form) {
    formsBlock = `
    <p style="line-height:1.7;margin:22px 0 12px;">One quick thing before your visit — please complete your short pre-treatment form so Stefani can tailor your treatment safely:</p>
    <p style="text-align:center;margin:0 0 8px;">
      <a href="${forms.form}" style="display:inline-block;background:#2B0F1A;color:#F2E7CE;text-decoration:none;padding:13px 30px;letter-spacing:2px;text-transform:uppercase;font-size:12px;">Complete pre-treatment form</a>
    </p>
    <p style="line-height:1.6;font-size:12px;color:#6f5b58;text-align:center;">Takes about 2 minutes · kept completely private</p>`;
  }
  // The policy is repeated here on purpose. A term the client only saw once at
  // checkout is far weaker than one confirmed in writing, and this is the copy
  // she will still have in her inbox if she needs to move the appointment.
  const depositNote = b.deposit
    ? `<p style="line-height:1.7;font-size:13px;background:#f9f4ec;border-left:3px solid #c2a878;padding:10px 14px;margin:16px 0 0;">💳 Your ${b.depositLabel || 'deposit'} has been received${b.balanceLabel ? `, with ${b.balanceLabel} due on the day` : ''}.<br><span style="color:#6f5b58;">${CANCELLATION_POLICY}</span></p>`
    : '';
  return emailShell(`You're booked in, ${b.name.split(' ')[0]}`,
    `<p style="line-height:1.7;margin:0;">${b.intro || 'Thank you for booking with Revive Aesthetics — here are your appointment details:'}</p>
    ${bookingDetailsHtml(b)}
    ${depositNote}
    ${formsBlock}
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
  const ms = parseStoredInstant(iso);
  return Number.isFinite(ms) ? adelaideWall(ms).abs : NaN;
}

const CANCEL_BASE = 'https://reviveaestheticsadl.com.au/book.html';
const SITE = 'https://reviveaestheticsadl.com.au';
// ---------- deposit ----------
// 30% of the treatment total, capped at $50. The cap exists because 30% of the
// $299 microneedling is $90, which is a heavy ask from a first-time client; the
// cap keeps a lash lift at $28.50 without the expensive treatment scaring people
// off. A $0 treatment (the free consultation) takes NO deposit.
//
// ⚠️ THESE TWO FUNCTIONS ARE THE ONLY DEFINITION OF WHAT A DEPOSIT COSTS.
// Both /api/create-payment-intent and the /api/book verification call them, so
// the amount charged and the amount checked can never drift apart. The price is
// always read from the D1 treatment/addon rows - NEVER from the request body.
// If the browser could name the amount, a client could pay $1 and pass the check.
const DEPOSIT_PCT = 30;
const DEPOSIT_CAP_CENTS = 5000; // $50.00 AUD

function totalPriceAud(treatment, addons) {
  return (treatment?.price_aud || 0) + (addons || []).reduce((s, a) => s + (a.price_aud || 0), 0);
}

function depositCentsFor(priceAud) {
  const p = Number(priceAud);
  if (!Number.isFinite(p) || p <= 0) return 0;
  return Math.min(Math.round(p * 100 * (DEPOSIT_PCT / 100)), DEPOSIT_CAP_CENTS);
}

function fmtMoneyCents(cents) {
  return '$' + (cents / 100).toFixed(2);
}

// ⚠️ THIS MUST MATCH THE PUBLISHED POLICY AT /#cancellation-policy ON THE HOMEPAGE.
// That policy already existed and is the canonical one: 48h+ no charge, 24-48h 50%
// of the treatment, same-day/no-show the full cost. The deposit does not replace it
// and must not restate it more leniently - two versions of a cancellation term is
// worse than either alone, and under the ACL an ambiguity is read against the
// business that drafted it. The deposit is simply the part of that policy that is
// actually collectable, since nothing else gives us money to keep.
//
// Under the ACL a forfeited amount must be a genuine pre-estimate of loss, which is
// why it varies with the notice given rather than being flatly non-refundable.
const CANCELLATION_POLICY =
  'Your deposit confirms your appointment and comes off the total on the day. ' +
  'Cancel or reschedule with 48 hours notice or more and the deposit is fully refunded or moved to your new time. ' +
  'Between 24 and 48 hours the deposit is kept toward the 50% cancellation fee. ' +
  'For same-day cancellations and missed appointments the deposit is kept - the slot cannot be filled at that notice. ' +
  'Full terms: ' + SITE + '/#cancellation-policy';

const PREP_FORMS = {
  'lash-lift':       { prep: 'lash-prep.html',          form: 'lash-consent.html' },
  'lash-lift-intro': { prep: 'lash-prep.html',          form: 'lash-consent.html' },
  'microneedling':   { prep: 'microneedling-prep.html', form: 'pdrn-consent.html' },
  'lymphatic':       { prep: 'lymphatic-prep.html',     form: 'body-consent.html' },
  'lymphatic-intro': { prep: 'lymphatic-prep.html',     form: 'body-consent.html' },
  'consultation':    { prep: null,                       form: 'skin-consult-prep.html' },
};

function treatmentForms(treatmentId, bookingId, name, phone, email) {
  const t = PREP_FORMS[treatmentId] || {};
  const qs = `?booking=${encodeURIComponent(bookingId)}&name=${encodeURIComponent(name)}&phone=${encodeURIComponent(phone)}&email=${encodeURIComponent(email)}`;
  return {
    prep: t.prep ? `${SITE}/${t.prep}` : null,
    form: t.form ? `${SITE}/${t.form}${qs}` : null,
  };
}

async function sendReminders(env, nowMs) {
  const db = env.DB;
  const now = nowInAdelaide(nowMs);
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

// ---------- the deposit step: holds, lifecycle, Stripe webhook (rebuilt 2026-09-14) ----------
// A customer who reaches the deposit step has already told us who she is, what she wants
// and when. That checkout is now a row in `bookings` from the moment she clicks Continue,
// so it can hold the slot, be confirmed by EITHER the browser or Stripe's webhook (whichever
// arrives first), be followed up if the card fails, and be reported on.
//
// `status` KEEPS ITS ORIGINAL MEANING and every existing query still keys on it:
//   confirmed  - a real appointment in the diary (the UNIQUE slot index applies)
//   cancelled  - a real appointment that was cancelled
//   pending    - a checkout in progress: a HOLD on the slot, NOT an appointment
//   abandoned  - a checkout that never became an appointment (hold released)
// Only 'confirmed' rows are appointments. pending/abandoned rows must never reach the diary,
// reminders, the calendar feed, the client list, the cancel link or the booking cap.
//
// `lifecycle` is where the row is in the money journey:
//   started           - row written, PaymentIntent not created yet (or Stripe refused to create it)
//   deposit_pending   - PaymentIntent exists, card not charged yet; the slot is held
//   deposit_failed    - a card attempt failed or the PaymentIntent was cancelled; the hold stays until it lapses
//   abandoned         - no successful payment within HOLD_MIN of the PaymentIntent; hold released
//   deposit_paid      - deposit received and the booking confirmed (or paid but unbookable and the refund failed)
//   completed         - a confirmed booking whose appointment end has passed, in Adelaide time (set by the cron)
//   refunded          - the deposit was refunded, fully or partly (refunded_cents holds the amount)
//   cancelled         - a booking cancelled by the client or by Stefani
//   booked_no_deposit - a confirmed booking that took no online deposit (free treatment, manual/admin entry, pre-deposit era)
//
// New timestamp columns are INTEGER epoch milliseconds; created_at / cancelled_at stay ISO text.

const BOOK_URL = CANCEL_BASE; // the booking page and the manage-booking page are the same book.html
const HOLD_MIN = 30;                             // a checkout holds its slot this long after its PaymentIntent is created
const HOLD_MS = HOLD_MIN * 60000;
const HOLD_LIFECYCLES = ['started', 'deposit_pending', 'deposit_failed'];
const FOLLOWUP_DELAY_MS = 3 * 60000;             // drop-off email goes 3 minutes after the failed/cancelled payment
const FOLLOWUP_MAX_AGE_MS = 48 * 3600000;        // never chase a drop-off older than this
const FOLLOWUP_EMAIL_FROM_MIN = 8 * 60;          // 8:00am Adelaide
const FOLLOWUP_EMAIL_TO_MIN = 20 * 60;           // 8:00pm Adelaide
const FOLLOWUP_EMAIL_PER_ADDRESS_DAYS = 7;
const STRIPE_SIGNATURE_TOLERANCE_S = 300;
const STUCK_EVENT_AFTER_MS = 2 * 60000;          // the cron reprocesses an event not processed after this
const STRIPE_EVENT_MAX_ATTEMPTS = 5;

const changesOf = res => Number((res && res.meta && res.meta.changes) || 0);
const digitsOf = s => String(s || '').replace(/\D/g, '');
const lowerOf = s => String(s || '').trim().toLowerCase();

function newBookingId() {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 12);
}

// ⚠️ THE ONE DEFINITION OF "this checkout has run out of time". Pure: nowMs is passed in.
// hold_until is set to (PaymentIntent created + HOLD_MIN). Not lapsed at 29:59, lapsed at 30:00.
function holdHasLapsed(row, nowMs) {
  if (!row || row.status !== 'pending' || !HOLD_LIFECYCLES.includes(row.lifecycle)) return false;
  const until = row.hold_until == null ? 0 : Number(row.hold_until);
  return !Number.isFinite(until) || nowMs >= until;
}

// Customer emails only between 8:00am and 7:59pm ADELAIDE time. adelaideMin comes from nowInAdelaide().
function isInFollowupEmailHours(adelaideMin) {
  return adelaideMin >= FOLLOWUP_EMAIL_FROM_MIN && adelaideMin < FOLLOWUP_EMAIL_TO_MIN;
}

// ---------- schema: lazy migration + backfill ----------

const BOOKING_COLUMNS = [
  ['price_override', 'INTEGER'],
  ['stripe_payment_intent_id', 'TEXT'],
  ['deposit_paid', 'INTEGER DEFAULT 0'],
  ['deposit_cents', 'INTEGER DEFAULT 0'],
  ['lifecycle', 'TEXT'],
  ['hold_until', 'INTEGER'],
  ['pi_created_at', 'INTEGER'],
  ['confirmed_at', 'INTEGER'],
  ['abandoned_at', 'INTEGER'],
  ['abandoned_reason', 'TEXT'],           // hold_lapsed | superseded | unbookable
  ['payment_failed_at', 'INTEGER'],
  ['last_payment_error', 'TEXT'],
  ['followup_due_at', 'INTEGER'],
  ['followed_up_at', 'INTEGER'],
  ['followup_result', 'TEXT'],            // sending | sent | send_failed | skipped_* | superseded
  ['refunded_cents', 'INTEGER DEFAULT 0'],
  ['refunded_at', 'INTEGER'],
  ['completed_at', 'INTEGER'],
  ['unbookable_reason', 'TEXT'],
  ['client_ip', 'TEXT'],
  ['user_agent', 'TEXT'],
  ['updated_at', 'INTEGER'],
  // Traffic source, captured by assets/tracking.js from the landing URL (added 2026-09-16).
  // Written once when the checkout row / booking is created; never used for pricing or access.
  ['utm_source', 'TEXT'],
  ['utm_medium', 'TEXT'],
  ['utm_campaign', 'TEXT'],
  ['utm_content', 'TEXT'],
  ['utm_term', 'TEXT'],
  ['fbclid', 'TEXT'],
  ['landing_page', 'TEXT'],
];

// The attribution fields a booking may carry, in column order. ONE list, used by both
// INSERT paths and the admin read, so they cannot drift.
const ATTRIBUTION_FIELDS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'fbclid', 'landing_page'];

// Pure. Untrusted browser input -> an object with exactly ATTRIBUTION_FIELDS, each a short
// printable string or ''. Anything missing, non-string or malformed becomes ''. Never throws,
// so a bad attribution payload can never stop a booking.
function cleanAttribution(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  for (const k of ATTRIBUTION_FIELDS) {
    const v = typeof src[k] === 'string' ? src[k] : '';
    const max = k === 'fbclid' ? 255 : k === 'landing_page' ? 200 : 120;
    out[k] = v.replace(/[ -<>"'`]/g, '').trim().slice(0, max);
  }
  return out;
}

const schemaReadyFor = new WeakSet();

// Pure. The lifecycle an existing row should carry. Never returns null.
function backfillLifecycle(row, now) {
  const status = String((row && row.status) || '');
  if (status === 'cancelled') return 'cancelled';
  if (status === 'pending') return row.stripe_payment_intent_id ? 'deposit_pending' : 'started';
  if (status === 'abandoned') return 'abandoned';
  const end = Number(row.end_min);
  const passed = isDateStr(row.date) && Number.isFinite(end) && absMin(row.date, end) <= now.abs;
  if (Number(row.deposit_paid) === 1) return passed ? 'completed' : 'deposit_paid';
  return passed ? 'completed' : 'booked_no_deposit';
}

async function backfillLifecycles(db, nowMs) {
  const now = nowInAdelaide(nowMs);
  const { results } = await db.prepare(
    'SELECT id, status, deposit_paid, date, end_min, stripe_payment_intent_id FROM bookings WHERE lifecycle IS NULL'
  ).all();
  let n = 0;
  for (const r of results) {
    const res = await db.prepare('UPDATE bookings SET lifecycle = ? WHERE id = ? AND lifecycle IS NULL')
      .bind(backfillLifecycle(r, now), r.id).run();
    n += changesOf(res);
  }
  return n;
}

// Adds any missing columns (one PRAGMA when there is nothing to do), creates stripe_events and
// backfills lifecycle. Memoised per D1 binding. Returns the number of rows backfilled.
async function ensureBookingSchema(db, nowMs, force) {
  if (!force && schemaReadyFor.has(db)) return 0;
  const { results: cols } = await db.prepare('PRAGMA table_info(bookings)').all();
  const have = new Set(cols.map(c => c.name));
  for (const [name, type] of BOOKING_COLUMNS) {
    if (!have.has(name)) {
      await db.exec(`ALTER TABLE bookings ADD COLUMN ${name} ${type}`)
        .catch(e => console.error('bookings migration failed for column', name, String(e && e.message || e).slice(0, 200)));
    }
  }
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS stripe_events (
      id                TEXT PRIMARY KEY,
      type              TEXT NOT NULL,
      payment_intent_id TEXT,
      payload           TEXT NOT NULL,
      received_at       INTEGER NOT NULL,
      claimed_at        INTEGER,
      attempts          INTEGER NOT NULL DEFAULT 0,
      processed_at      INTEGER,
      result            TEXT
    )`
  ).run();
  await db.prepare('CREATE INDEX IF NOT EXISTS ix_stripe_events_open ON stripe_events(processed_at, received_at)').run();
  await db.prepare('CREATE INDEX IF NOT EXISTS ix_bookings_pi ON bookings(stripe_payment_intent_id)').run();
  await db.prepare('CREATE INDEX IF NOT EXISTS ix_bookings_status_lifecycle ON bookings(status, lifecycle)').run();
  const n = await backfillLifecycles(db, Number.isFinite(nowMs) ? nowMs : Date.now());
  schemaReadyFor.add(db);
  return n;
}

// ---------- shared helpers ----------

function escHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function stripeGetPaymentIntent(env, pid) {
  if (!env.STRIPE_SECRET_KEY || !pid) return null;
  try {
    const r = await fetch(`https://api.stripe.com/v1/payment_intents/${encodeURIComponent(pid)}`, {
      headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
    });
    if (!r.ok) return null;
    return await r.json();
  } catch (_) {
    return null;
  }
}

async function refundPaymentIntent(env, pid) {
  try {
    const r = await fetch('https://api.stripe.com/v1/refunds', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Idempotency-Key': `revive-refund-${pid}`,
      },
      body: new URLSearchParams({ payment_intent: pid }).toString(),
    });
    const data = await r.json().catch(() => ({}));
    return { ok: r.ok, id: data.id || '', error: r.ok ? '' : (data.error?.message || `HTTP ${r.status}`) };
  } catch (e) {
    return { ok: false, id: '', error: String(e && e.message || e).slice(0, 200) };
  }
}

async function atBookingCap(db, phone, email, now) {
  const dup = await db.prepare(
    "SELECT COUNT(*) AS n FROM bookings WHERE status='confirmed' AND date >= ? AND (phone = ? OR (email != '' AND email = ?))"
  ).bind(now.date, phone, email || ' ').first();
  return dup.n >= 2;
}

// ⚠️ THE ONE DEFINITION OF "can this person book this slot right now?".
// /api/create-payment-intent, /api/book and the paid-checkout confirmation all call it, so
// the check made before the card is touched and the check made before the booking is
// written cannot drift. Active holds count as taken (except this person's own, and the row
// named in opts.excludeId).
async function bookingBlocker(db, dateStr, startMin, durationMin, phone, email, now, opts) {
  const open = await slotsForDate(db, dateStr, durationMin, now.abs,
    Object.assign({}, opts || {}, { holderPhone: phone, holderEmail: email }));
  if (!open.includes(startMin)) return { error: 'slot_unavailable', status: 409 };
  if (await atBookingCap(db, phone, email, now)) return { error: 'too_many_bookings', status: 429 };
  return null;
}

const UNBOOKABLE_REASON = {
  slot_unavailable: 'that time was taken before the booking could be saved',
  too_many_bookings: 'they already have 2 upcoming bookings (the online limit)',
};

function unbookableRefundMessage(o, refund, amountCents) {
  const amount = fmtMoneyCents(amountCents || 0);
  const who = `${escHtml(o.name)} · ${escHtml(o.phone)}${o.email ? ' · ' + escHtml(o.email) : ''}`;
  const when = `${escHtml(o.what)} — ${fmtDate(o.date)}, ${fmtTime(o.startMin)}`;
  const reason = UNBOOKABLE_REASON[o.error] || o.error;
  return refund.ok
    ? `↩️ <b>Deposit refunded — booking could not be made</b>\n${who}\n${when}\n` +
      `${amount} refunded automatically because ${reason}.\nStripe ref ${escHtml(o.pid)}`
    : `⚠️ <b>Deposit taken but NO booking made — refund FAILED</b>\n${who}\n${when}\n` +
      `${amount} was charged, but ${reason} and Stripe would not refund it automatically (${escHtml(refund.error)}).\n` +
      `<b>Please refund it in Stripe yourself</b>: ${escHtml(o.pid)}`;
}

// Legacy /api/book path (a PaymentIntent with no checkout row, e.g. one created before this
// deploy): the card was charged, then the booking could not be written. Refund it and tell
// Stefani. Returns a Response, or null when there is nothing to refund (no key, the payment
// never succeeded, or this payment already belongs to a confirmed booking).
async function refundUnbookable(env, ctx, db, o) {
  if (!env.STRIPE_SECRET_KEY || !o.pid) return null;
  const pi = o.pi || await stripeGetPaymentIntent(env, o.pid);
  if (!pi || pi.status !== 'succeeded') return null;
  // A payment already attached to a CONFIRMED booking is never refunded here - otherwise
  // replaying a paid booking's id at a taken slot would refund a deposit whose booking stands.
  const used = await db.prepare("SELECT id FROM bookings WHERE stripe_payment_intent_id = ? AND status = 'confirmed'")
    .bind(o.pid).first().catch(() => null);
  if (used) return null;

  const refund = await refundPaymentIntent(env, o.pid);
  ctx.waitUntil(telegram(env, unbookableRefundMessage(o, refund, pi.amount || 0)));
  return json({ error: o.error, refunded: refund.ok }, o.status, o.cors);
}

function bookingLinkFor(treatmentId, addonIds, date, startMin) {
  const ids = String(addonIds || '').split(',').map(s => s.trim()).filter(Boolean);
  let u = `${BOOK_URL}?t=${encodeURIComponent(treatmentId)}`;
  if (ids.length) u += `&a=${ids.map(encodeURIComponent).join(',')}`;
  if (date) u += `&d=${encodeURIComponent(date)}&m=${encodeURIComponent(String(startMin))}`;
  return u;
}

function checkoutFollowupEmail(c) {
  const first = escHtml(String(c.name || '').trim().split(/\s+/)[0]);
  const button = (href, label) => `<p style="text-align:center;margin:18px 0;">
      <a href="${escHtml(href)}" style="display:inline-block;background:#2B0F1A;color:#F2E7CE;text-decoration:none;padding:13px 30px;letter-spacing:2px;text-transform:uppercase;font-size:12px;">${label}</a>
    </p>`;
  const middle = c.slotOpen
    ? `<p style="line-height:1.7;">If you'd still like that time, you can finish in under a minute:</p>
    ${button(c.link, 'Finish my booking')}`
    : `<p style="line-height:1.7;">That time has since been taken, but there are other times available:</p>
    ${button(c.link, 'See available times')}`;
  return emailShell(`Hi ${first},`,
    `<p style="line-height:1.7;margin:0;">It looks like your booking for ${escHtml(c.what)} on ${c.dateLabel} at ${c.timeLabel} didn't quite go through, so it isn't confirmed yet.</p>
    ${middle}
    <p style="line-height:1.7;">Your ${c.depositLabel} deposit holds the time for you and comes straight off your total on the day.</p>
    <p style="line-height:1.7;font-size:14px;color:#6f5b58;">If the payment gave you trouble, or another time suits better, just reply to this email or text me on
    <a href="tel:0404967051" style="color:#2B0F1A;">0404 967 051</a> and I'll sort it for you.</p>
    <p style="line-height:1.7;"><em style="color:#c2a878;font-size:20px;">Stefani</em><br>Revive Aesthetics</p>`);
}

async function rowForPaymentIntent(db, piId) {
  if (!piId) return null;
  return db.prepare('SELECT * FROM bookings WHERE stripe_payment_intent_id = ? ORDER BY created_at DESC')
    .bind(String(piId)).first();
}

// Treatment name, display "what", duration and full price for a bookings row.
async function describeBooking(db, row) {
  const t = await db.prepare('SELECT id, name, price_aud, duration_min FROM treatments WHERE id = ?')
    .bind(String(row.treatment_id || '')).first();
  const priceOf = await makePriceOf(db);
  const override = row.price_override;
  const price = override !== null && override !== undefined && Number.isFinite(Number(override))
    ? Number(override)
    : priceOf({ price_aud: t ? t.price_aud : 0, addon_ids: row.addon_ids });
  const tname = t ? t.name : String(row.treatment_id || 'treatment');
  return { t, tname, what: tname + (row.addon_names ? ' + ' + row.addon_names : ''), duration: row.end_min - row.start_min, price };
}

// The same JSON /api/book has always returned, built from a bookings row.
async function bookingSuccessPayload(db, row) {
  const d = await describeBooking(db, row);
  return {
    ok: true, id: row.id, cancel_token: row.cancel_token,
    treatment: d.tname, addon: row.addon_names || null,
    date: row.date, date_label: fmtDate(row.date),
    time_label: fmtTime(row.start_min), duration_min: d.duration,
    price_aud: d.price,
  };
}

// Confirmation email + Stefani's booking Telegram + the Meta conversion. Called EXACTLY ONCE
// per booking, by whichever path's guarded write actually confirmed it. Returns the
// allSettled promise so a caller can hand it to waitUntil: a tracking or email failure can
// never undo or delay a booking that is already written.
async function notifyBookingConfirmed(env, db, row, meta) {
  let d;
  try {
    d = await describeBooking(db, row);
  } catch (e) {
    console.error('booking confirmed but its details could not be read for notifications', row && row.id, String(e && e.message || e).slice(0, 200));
    return [];
  }
  meta = meta || {};
  const id = row.id;
  const depositPaidCents = Number(row.deposit_paid) === 1 ? Number(row.deposit_cents || 0) : 0;
  const dateLabel = fmtDate(row.date);
  const timeLabel = fmtTime(row.start_min);
  const cancelUrl = `${CANCEL_BASE}?cancel=${id}&token=${row.cancel_token}`;
  return Promise.allSettled([
    telegram(env,
      `\u{1F33F} <b>New Revive booking</b>\n` +
      `${d.what} — ${dateLabel}, ${timeLabel} (${d.duration} min · $${d.price})\n` +
      `${row.name} · ${row.phone}${row.email ? ' · ' + row.email : ''}` +
      (row.notes ? `\nNotes: ${row.notes}` : '') +
      (depositPaidCents ? `\n💳 ${fmtMoneyCents(depositPaidCents)} deposit paid · ${fmtMoneyCents(d.price * 100 - depositPaidCents)} due on the day` : '') +
      `\nRef ${id}`
    ),
    sendEmail(env, row.email, `Booking confirmed: ${d.what}, ${dateLabel} ${timeLabel} — Revive Aesthetics`,
      confirmationEmail({ name: row.name, what: d.what, dateLabel, timeLabel, duration: d.duration, price: d.price,
        deposit: depositPaidCents > 0,
        depositLabel: depositPaidCents ? `${fmtMoneyCents(depositPaidCents)} deposit` : '',
        balanceLabel: depositPaidCents ? fmtMoneyCents(d.price * 100 - depositPaidCents) : '' }, cancelUrl,
        treatmentForms(row.treatment_id, id, row.name, row.phone, row.email))),
    // Server-side conversion. event_id === booking id, matching the browser pixel, so Meta
    // dedupes the pair into one conversion. No-op unless META_PIXEL_ID + META_CAPI_TOKEN are set.
    metaConversion(env, {
      eventName: 'Schedule',
      eventId: id,
      email: row.email, phone: row.phone, name: row.name,
      value: d.price,
      contentName: d.what,
      sourceUrl: CANCEL_BASE,
      clientIp: meta.clientIp || row.client_ip || '',
      userAgent: meta.userAgent || row.user_agent || '',
    }),
  ]);
}

// Release an older checkout row that a new attempt replaces. A row whose payment is going
// through (or cannot be read) is left alone so its money stays traceable. A row that never
// had a card attempt is deleted - it is noise; one that did is kept as abandoned/superseded
// (and marked followed up, so the drop-off email never chases an attempt she has replaced).
async function supersedeHold(env, db, row, livePi, nowMs) {
  if (!row || row.status !== 'pending') return 'not_pending';
  if (row.stripe_payment_intent_id) {
    if (!livePi) return 'left_unreadable';
    if (['succeeded', 'processing', 'requires_capture', 'requires_action'].includes(livePi.status)) return 'left_in_flight';
  }
  if (row.payment_failed_at == null) {
    await db.prepare("DELETE FROM bookings WHERE id = ? AND status = 'pending' AND payment_failed_at IS NULL").bind(row.id).run();
    return 'deleted';
  }
  await db.prepare(
    `UPDATE bookings SET status = 'abandoned', lifecycle = 'abandoned', abandoned_at = ?, abandoned_reason = 'superseded',
       hold_until = NULL, followed_up_at = COALESCE(followed_up_at, ?), followup_result = COALESCE(followup_result, 'superseded'), updated_at = ?
     WHERE id = ? AND status = 'pending'`
  ).bind(nowMs, nowMs, nowMs, row.id).run();
  return 'superseded';
}

// The same person's other live holds on this date that overlap the new time.
async function supersedeOwnHolds(env, db, o) {
  const { results } = await db.prepare(
    "SELECT * FROM bookings WHERE status = 'pending' AND date = ? AND id != ? AND start_min < ? AND end_min > ?"
  ).bind(o.date, o.keepId || '', o.endMin, o.startMin).all();
  const phone = digitsOf(o.phone);
  const email = lowerOf(o.email);
  for (const row of results) {
    const same = (phone && digitsOf(row.phone) === phone) || (email && lowerOf(row.email) === email);
    if (!same) continue;
    const livePi = row.stripe_payment_intent_id ? await stripeGetPaymentIntent(env, row.stripe_payment_intent_id) : null;
    await supersedeHold(env, db, row, livePi, o.nowMs);
  }
}

// ⚠️ THE ONE PLACE A PAID CHECKOUT BECOMES A BOOKING. Both the Stripe webhook and the
// browser's /api/book call it; the conditional UPDATE (status still pending/abandoned) is
// what makes the confirmation email, Stefani's Telegram and the Meta conversion fire EXACTLY
// ONCE whichever arrives first. o: { nowMs, defer(promise), clientIp?, userAgent? }.
async function confirmPaidCheckout(env, db, row, pi, o) {
  const nowMs = o.nowMs;
  if (row.status === 'confirmed') return { state: 'already_confirmed', row };
  if (!['pending', 'abandoned'].includes(row.status)) return { state: 'ignored', row };
  if (row.unbookable_reason) {
    return { state: 'unbookable', error: row.unbookable_reason, status: row.unbookable_reason === 'too_many_bookings' ? 429 : 409,
      refunded: row.lifecycle === 'refunded', row };
  }
  // The amount taken must be the amount this checkout was priced at when its PaymentIntent was made.
  if (!pi || pi.status !== 'succeeded' || Number(pi.amount) !== Number(row.deposit_cents) ||
      String(pi.currency || '').toLowerCase() !== 'aud' || pi.id !== row.stripe_payment_intent_id) {
    return { state: 'amount_mismatch', row };
  }

  // The slot is re-checked now: a late payment on an abandoned checkout is only honoured if
  // the time is still free. Minimum notice is not re-applied - it was met when the hold began.
  const now = nowInAdelaide(nowMs);
  const blocker = await bookingBlocker(db, row.date, row.start_min, row.end_min - row.start_min, row.phone, row.email, now,
    { excludeId: row.id, noticeMin: 0, nowMs });
  if (!blocker) {
    let res = null;
    try {
      res = await db.prepare(
        `UPDATE bookings SET status = 'confirmed', lifecycle = 'deposit_paid', deposit_paid = 1, confirmed_at = ?, hold_until = NULL, updated_at = ?
         WHERE id = ? AND status IN ('pending', 'abandoned') AND stripe_payment_intent_id = ?`
      ).bind(nowMs, nowMs, row.id, pi.id).run();
    } catch (e) {
      if (!/UNIQUE/i.test(String(e && e.message || e))) throw e;
      res = null; // someone confirmed the exact same start time in the instant between check and write
    }
    if (res && changesOf(res) === 1) {
      const fresh = await db.prepare('SELECT * FROM bookings WHERE id = ?').bind(row.id).first();
      o.defer(notifyBookingConfirmed(env, db, fresh, { clientIp: o.clientIp, userAgent: o.userAgent }));
      return { state: 'confirmed', row: fresh };
    }
    if (res) {
      const fresh = await db.prepare('SELECT * FROM bookings WHERE id = ?').bind(row.id).first();
      if (fresh && fresh.status === 'confirmed') return { state: 'already_confirmed', row: fresh };
      if (fresh && fresh.unbookable_reason) return confirmPaidCheckout(env, db, fresh, pi, o);
      return { state: 'ignored', row: fresh || row };
    }
  }
  return refundUnbookableCheckout(env, db, row, pi,
    blocker ? blocker.error : 'slot_unavailable', blocker ? blocker.status : 409, nowMs);
}

// A checkout was paid but its time is gone (or the cap bites). Claim the refund with a guarded
// write so only one path ever refunds, refund in full, tell Stefani, record it.
async function refundUnbookableCheckout(env, db, row, pi, error, status, nowMs) {
  const claim = await db.prepare(
    `UPDATE bookings SET status = 'abandoned', lifecycle = 'deposit_paid', deposit_paid = 1, hold_until = NULL,
       unbookable_reason = ?, abandoned_at = COALESCE(abandoned_at, ?), abandoned_reason = COALESCE(abandoned_reason, 'unbookable'), updated_at = ?
     WHERE id = ? AND status IN ('pending', 'abandoned') AND (unbookable_reason IS NULL OR unbookable_reason = '')`
  ).bind(error, nowMs, nowMs, row.id).run();
  if (changesOf(claim) !== 1) {
    const fresh = await db.prepare('SELECT * FROM bookings WHERE id = ?').bind(row.id).first();
    if (fresh && fresh.status === 'confirmed') return { state: 'already_confirmed', row: fresh };
    return { state: 'unbookable', error: (fresh && fresh.unbookable_reason) || error, status,
      refunded: !!fresh && fresh.lifecycle === 'refunded', row: fresh || row };
  }
  const refund = await refundPaymentIntent(env, pi.id);
  if (refund.ok) {
    await db.prepare(
      "UPDATE bookings SET lifecycle = 'refunded', refunded_cents = ?, refunded_at = COALESCE(refunded_at, ?), updated_at = ? WHERE id = ?"
    ).bind(Number(pi.amount) || 0, nowMs, nowMs, row.id).run();
  }
  let what = String(row.treatment_id || 'treatment');
  try { what = (await describeBooking(db, row)).what; } catch (_) { /* the alert still goes */ }
  await telegram(env, unbookableRefundMessage({
    pid: pi.id, name: row.name, phone: row.phone, email: row.email, what, date: row.date, startMin: row.start_min, error,
  }, refund, Number(pi.amount) || 0));
  const fresh = await db.prepare('SELECT * FROM bookings WHERE id = ?').bind(row.id).first();
  return { state: 'unbookable', error, status, refunded: refund.ok, row: fresh || row };
}

// /api/book for a checkout that already has its row.
async function bookHeldCheckout(env, ctx, db, req, held, pid, cors) {
  const nowMs = Date.now();
  if (held.status === 'confirmed') return json(await bookingSuccessPayload(db, held), 200, cors);
  if (held.status === 'cancelled') return json({ error: 'booking_cancelled' }, 409, cors);
  // Verify with Stripe itself - the browser saying "paid" is not evidence.
  const pi = await stripeGetPaymentIntent(env, pid);
  if (!pi || pi.status !== 'succeeded' || pi.amount !== Number(held.deposit_cents) || pi.currency !== 'aud') {
    return json({ error: 'deposit_unverified' }, 402, cors);
  }
  const outcome = await confirmPaidCheckout(env, db, held, pi, {
    nowMs,
    defer: p => ctx.waitUntil(p),
    clientIp: req.headers.get('cf-connecting-ip') || '',
    userAgent: req.headers.get('user-agent') || '',
  });
  if (outcome.state === 'confirmed' || outcome.state === 'already_confirmed') {
    return json(await bookingSuccessPayload(db, outcome.row), 200, cors);
  }
  if (outcome.state === 'unbookable') return json({ error: outcome.error, refunded: outcome.refunded }, outcome.status, cors);
  return json({ error: 'deposit_unverified' }, 402, cors);
}

// ---------- Stripe webhook ----------

function timingSafeEqualStr(a, b) {
  a = String(a); b = String(b);
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

// Stripe-Signature: t=<unix>,v1=<hex hmac>[,v1=...]. HMAC-SHA256 over `${t}.${rawBody}`.
async function verifyStripeSignature(rawBody, header, secret, nowSec, toleranceSec) {
  const tolerance = Number.isFinite(toleranceSec) ? toleranceSec : STRIPE_SIGNATURE_TOLERANCE_S;
  if (!secret) return { ok: false, reason: 'no_secret' };
  if (!header) return { ok: false, reason: 'missing_header' };
  let t = null;
  const v1 = [];
  for (const part of String(header).split(',')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === 't' && t === null) t = v;
    else if (k === 'v1' && v) v1.push(v.toLowerCase());
  }
  if (!t || !/^\d+$/.test(t) || !v1.length) return { ok: false, reason: 'malformed_header' };
  const ts = Number(t);
  if (nowSec - ts > tolerance) return { ok: false, reason: 'stale_timestamp' };
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = Array.from(new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(`${t}.${rawBody}`))))
    .map(x => x.toString(16).padStart(2, '0')).join('');
  let matched = false;
  for (const sig of v1) matched = timingSafeEqualStr(sig, mac) || matched;
  return matched ? { ok: true, timestamp: ts } : { ok: false, reason: 'signature_mismatch' };
}

function stripeEventPaymentIntentId(event) {
  const o = (event && event.data && event.data.object) || {};
  if (o.object === 'payment_intent' && typeof o.id === 'string') return o.id;
  if (typeof o.payment_intent === 'string') return o.payment_intent;
  return null;
}

async function handleStripeWebhook(req, env, ctx) {
  // RAW text first: the signature covers these exact bytes, not a re-serialised object.
  const rawBody = await req.text();
  const reply = (status, data) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
  if (!env.STRIPE_WEBHOOK_SECRET) {
    console.error('stripe webhook: STRIPE_WEBHOOK_SECRET is not set - event refused, nothing processed');
    return reply(503, { error: 'webhook_not_configured' });
  }
  const nowMs = Date.now();
  const check = await verifyStripeSignature(rawBody, req.headers.get('Stripe-Signature'), env.STRIPE_WEBHOOK_SECRET, Math.floor(nowMs / 1000));
  if (!check.ok) {
    console.error('stripe webhook: rejected -', check.reason);
    return reply(400, { error: 'bad_signature', reason: check.reason });
  }
  let event;
  try { event = JSON.parse(rawBody); } catch (_) { return reply(400, { error: 'bad_payload' }); }
  if (!event || typeof event.id !== 'string' || !event.id || typeof event.type !== 'string') return reply(400, { error: 'bad_payload' });

  const db = env.DB;
  await ensureBookingSchema(db, nowMs);
  // Recorded BEFORE the 2xx, so an event whose async processing dies is still on disk for
  // the cron to reprocess. The primary key is the dedupe: Stripe retries arrive as no-ops.
  const inserted = await db.prepare(
    'INSERT OR IGNORE INTO stripe_events (id, type, payment_intent_id, payload, received_at, attempts) VALUES (?, ?, ?, ?, ?, 0)'
  ).bind(event.id.slice(0, 255), event.type.slice(0, 100), stripeEventPaymentIntentId(event), rawBody, nowMs).run();
  if (changesOf(inserted) === 0) return reply(200, { received: true, duplicate: true });
  ctx.waitUntil(processStripeEvent(env, event.id, nowMs));
  return reply(200, { received: true });
}

// Claims an event (so an overlapping cron run cannot process it too), applies it, records the result.
async function processStripeEvent(env, eventId, nowMs) {
  const db = env.DB;
  nowMs = Number.isFinite(nowMs) ? nowMs : Date.now();
  const claim = await db.prepare(
    `UPDATE stripe_events SET claimed_at = ?, attempts = COALESCE(attempts, 0) + 1
     WHERE id = ? AND processed_at IS NULL AND (claimed_at IS NULL OR claimed_at <= ?)`
  ).bind(nowMs, eventId, nowMs - STUCK_EVENT_AFTER_MS).run();
  if (changesOf(claim) !== 1) return 'not_claimed';
  const ev = await db.prepare('SELECT * FROM stripe_events WHERE id = ?').bind(eventId).first();
  const deferred = [];
  let result;
  try {
    const event = JSON.parse(ev.payload);
    result = await applyStripeEvent(env, db, event, nowMs, p => deferred.push(p));
    await Promise.allSettled(deferred);
  } catch (e) {
    const msg = String(e && e.message || e).slice(0, 300);
    console.error('stripe webhook: processing failed', eventId, ev && ev.type, msg);
    if (Number(ev && ev.attempts) >= STRIPE_EVENT_MAX_ATTEMPTS) {
      await db.prepare('UPDATE stripe_events SET processed_at = ?, result = ? WHERE id = ?')
        .bind(nowMs, 'failed: ' + msg, eventId).run();
      await telegram(env, `⚠️ <b>Stripe event could not be processed</b> after ${STRIPE_EVENT_MAX_ATTEMPTS} tries — check Stripe: ` +
        `${escHtml((ev && ev.payment_intent_id) || 'no payment id')} (${escHtml(ev && ev.type)}, event ${escHtml(eventId)})\n${escHtml(msg)}`);
    } else {
      // Left unprocessed on purpose: the cron picks it up again after STUCK_EVENT_AFTER_MS.
      await db.prepare('UPDATE stripe_events SET claimed_at = NULL, result = ? WHERE id = ?').bind('error: ' + msg, eventId).run();
    }
    return 'error';
  }
  await db.prepare('UPDATE stripe_events SET processed_at = ?, result = ? WHERE id = ?').bind(nowMs, String(result), eventId).run();
  return result;
}

async function reportUnmatchedStripeEvent(env, event, piId, amount) {
  // Never silently dropped: money moved in Stripe with no booking behind it.
  console.error('stripe webhook: NO MATCHING BOOKING', JSON.stringify({
    event_id: event.id, type: event.type, payment_intent: piId || null, amount: amount == null ? null : amount,
  }));
  const amountLabel = Number.isFinite(Number(amount)) && amount !== null ? fmtMoneyCents(Number(amount)) : 'amount unknown';
  await telegram(env, `⚠️ <b>Stripe payment with no matching booking</b> — check Stripe: ${escHtml(piId || 'no payment id')}, ${amountLabel}\n` +
    `(${escHtml(event.type)}, event ${escHtml(event.id)})`);
  return 'unmatched';
}

// Only ids from the event are used to FIND rows; what a row becomes is decided by its own
// state in D1 (and, for a payment, by comparing the amount with the row's own deposit_cents).
async function applyStripeEvent(env, db, event, nowMs, defer) {
  const obj = (event.data && event.data.object) || {};
  const created = Number(event.created);
  const eventMs = Number.isFinite(created) && created > 0 ? created * 1000 : nowMs;
  switch (event.type) {
    case 'payment_intent.succeeded': {
      const row = await rowForPaymentIntent(db, obj.id);
      if (!row) return reportUnmatchedStripeEvent(env, event, obj.id, obj.amount);
      const out = await confirmPaidCheckout(env, db, row, obj, { nowMs, defer });
      if (out.state === 'unbookable') return out.refunded ? 'refunded_unbookable' : 'unbookable_refund_failed';
      if (out.state === 'amount_mismatch') {
        console.error('stripe webhook: amount mismatch', event.id, obj.id, obj.amount, row.deposit_cents);
        await telegram(env, `⚠️ <b>Stripe payment amount does not match the booking</b> — check Stripe: ${escHtml(obj.id)}, ` +
          `${fmtMoneyCents(Number(obj.amount) || 0)} paid, ${fmtMoneyCents(Number(row.deposit_cents) || 0)} expected. Not confirmed.`);
      }
      return out.state;
    }
    case 'payment_intent.payment_failed':
    case 'payment_intent.canceled': {
      const row = await rowForPaymentIntent(db, obj.id);
      if (!row) return reportUnmatchedStripeEvent(env, event, obj.id, obj.amount);
      return recordDropOff(db, row, event.type, obj, eventMs, nowMs);
    }
    case 'charge.refunded': {
      const piId = typeof obj.payment_intent === 'string' ? obj.payment_intent : '';
      const row = await rowForPaymentIntent(db, piId);
      if (!row) return reportUnmatchedStripeEvent(env, event, piId, obj.amount_refunded != null ? obj.amount_refunded : obj.amount);
      return recordRefund(env, db, row, obj, nowMs);
    }
    default:
      return 'ignored';
  }
}

// A drop-off: the card failed or the PaymentIntent was cancelled. The hold stays until it
// lapses; the follow-up email is due FOLLOWUP_DELAY_MS after the event.
async function recordDropOff(db, row, type, obj, eventMs, nowMs) {
  const failed = type === 'payment_intent.payment_failed';
  const message = String((obj.last_payment_error && obj.last_payment_error.message) ||
    (failed ? 'The payment failed' : 'The payment was cancelled' + (obj.cancellation_reason ? ` (${obj.cancellation_reason})` : ''))).slice(0, 300);
  if (row.status === 'pending' && HOLD_LIFECYCLES.includes(row.lifecycle)) {
    const res = await db.prepare(
      `UPDATE bookings SET lifecycle = 'deposit_failed', payment_failed_at = ?, last_payment_error = ?,
         followup_due_at = COALESCE(followup_due_at, ?), updated_at = ?
       WHERE id = ? AND status = 'pending' AND lifecycle IN ('started', 'deposit_pending', 'deposit_failed')`
    ).bind(eventMs, message, eventMs + FOLLOWUP_DELAY_MS, nowMs, row.id).run();
    return changesOf(res) ? 'deposit_failed' : 'ignored_state';
  }
  // A card that fails after the hold lapsed is still a real drop-off. A cancellation of an
  // already-abandoned checkout is not - that is our own abandonment, or it no longer matters.
  if (failed && row.status === 'abandoned' && row.abandoned_reason === 'hold_lapsed' && Number(row.deposit_paid) !== 1) {
    await db.prepare(
      `UPDATE bookings SET payment_failed_at = ?, last_payment_error = ?, followup_due_at = COALESCE(followup_due_at, ?), updated_at = ?
       WHERE id = ? AND status = 'abandoned'`
    ).bind(eventMs, message, eventMs + FOLLOWUP_DELAY_MS, nowMs, row.id).run();
    return 'failed_after_abandon';
  }
  return 'ignored_state';
}

async function recordRefund(env, db, row, charge, nowMs) {
  const cents = Math.max(0, Math.round(Number(charge.amount_refunded) || 0));
  if (!cents) return 'ignored_no_amount';
  const res = await db.prepare(
    `UPDATE bookings SET lifecycle = 'refunded', refunded_cents = ?, refunded_at = COALESCE(refunded_at, ?), updated_at = ?
     WHERE id = ? AND NOT (lifecycle = 'refunded' AND COALESCE(refunded_cents, 0) = ?)`
  ).bind(cents, nowMs, nowMs, row.id, cents).run();
  if (!changesOf(res)) return 'already_refunded';
  let what = String(row.treatment_id || 'treatment');
  try { what = (await describeBooking(db, row)).what; } catch (_) { /* the alert still goes */ }
  const deposit = Number(row.deposit_cents) || 0;
  await telegram(env, `↩️ <b>Deposit refunded</b>\n${escHtml(row.name)} · ${escHtml(row.phone)}\n` +
    `${escHtml(what)} — ${fmtDate(row.date)}, ${fmtTime(row.start_min)}\n` +
    `${fmtMoneyCents(cents)} refunded${deposit && cents < deposit ? ` of the ${fmtMoneyCents(deposit)} deposit` : ''}.\n` +
    `Stripe ref ${escHtml(row.stripe_payment_intent_id)}`);
  return 'refunded';
}

async function reprocessStuckStripeEvents(env, nowMs) {
  const db = env.DB;
  const { results } = await db.prepare(
    `SELECT id FROM stripe_events WHERE processed_at IS NULL AND received_at <= ? AND (claimed_at IS NULL OR claimed_at <= ?)
     ORDER BY received_at LIMIT 25`
  ).bind(nowMs - STUCK_EVENT_AFTER_MS, nowMs - STUCK_EVENT_AFTER_MS).all();
  for (const r of results) await processStripeEvent(env, r.id, nowMs);
  return results.length;
}

// ---------- abandonment ----------

async function abandonLapsedCheckouts(env, nowMs, defer) {
  const db = env.DB;
  const { results } = await db.prepare(
    `SELECT * FROM bookings WHERE status = 'pending' AND lifecycle IN ('started', 'deposit_pending', 'deposit_failed')
       AND (hold_until IS NULL OR hold_until <= ?) ORDER BY hold_until LIMIT 50`
  ).bind(nowMs).all();
  let n = 0;
  for (const row of results) {
    if (!holdHasLapsed(row, nowMs)) continue;
    try {
      if ((await abandonCheckout(env, db, row, nowMs, defer)) === 'abandoned') n++;
    } catch (e) {
      console.error('abandonment failed', row.id, String(e && e.message || e).slice(0, 200));
    }
  }
  return n;
}

async function abandonCheckout(env, db, row, nowMs, defer) {
  let learnedDecline = null;
  if (row.stripe_payment_intent_id && env.STRIPE_SECRET_KEY) {
    // Ask Stripe before giving the time away: a payment whose webhook is late is confirmed, not abandoned.
    const pi = await stripeGetPaymentIntent(env, row.stripe_payment_intent_id);
    if (pi && pi.status === 'succeeded') {
      const out = await confirmPaidCheckout(env, db, row, pi, { nowMs, defer });
      return 'paid:' + out.state;
    }
    if (pi && ['processing', 'requires_capture'].includes(pi.status)) return 'in_flight';
    const msg = pi && pi.last_payment_error && pi.last_payment_error.message;
    if (msg && row.payment_failed_at == null) learnedDecline = String(msg).slice(0, 300);
  }
  const res = await db.prepare(
    `UPDATE bookings SET status = 'abandoned', lifecycle = 'abandoned', abandoned_at = ?, abandoned_reason = COALESCE(abandoned_reason, 'hold_lapsed'),
       hold_until = NULL, last_payment_error = COALESCE(last_payment_error, ?), payment_failed_at = COALESCE(payment_failed_at, ?),
       followup_due_at = COALESCE(followup_due_at, ?), updated_at = ?
     WHERE id = ? AND status = 'pending' AND lifecycle IN ('started', 'deposit_pending', 'deposit_failed') AND (hold_until IS NULL OR hold_until <= ?)`
  ).bind(nowMs, learnedDecline, learnedDecline ? nowMs : null, learnedDecline ? nowMs : null, nowMs, row.id, nowMs).run();
  if (changesOf(res) !== 1) return 'not_abandoned';

  const fresh = (await db.prepare('SELECT * FROM bookings WHERE id = ?').bind(row.id).first()) || row;
  let what = String(fresh.treatment_id || 'treatment');
  try { what = (await describeBooking(db, fresh)).what; } catch (_) { /* the alert still goes */ }
  const when = isDateStr(fresh.date) && Number.isInteger(fresh.start_min) ? `${fmtDate(fresh.date)}, ${fmtTime(fresh.start_min)}` : 'time not recorded';
  const declined = fresh.last_payment_error || '';
  const stopped = !fresh.stripe_payment_intent_id
    ? 'the payment step never opened (Stripe did not start the payment)'
    : 'stopped at the deposit step' + (declined ? `, card declined / payment failed: ${escHtml(declined)}` : ', no card payment was attempted');
  const followup = fresh.followup_result === 'sent' ? 'Follow-up email already sent.'
    : fresh.payment_failed_at != null
      ? (fresh.email ? 'One follow-up email goes to them (8am–8pm only, once a week per address).' : 'No email address, so no follow-up email.')
      : 'No customer email is sent for this.';
  await telegram(env, `\u{1F6D2} <b>Didn't finish booking</b> — ${escHtml(fresh.name)} · ${escHtml(fresh.phone)} · ${escHtml(what)} · ${when}\n` +
    `${stopped}\nThe time is free again. ${followup}`);
  return 'abandoned';
}

// ---------- drop-off follow-up (one email per checkout, ever) ----------

async function finishFollowup(db, row, nowMs, result) {
  await db.prepare('UPDATE bookings SET followed_up_at = ?, followup_result = ?, updated_at = ? WHERE id = ? AND followed_up_at IS NULL')
    .bind(nowMs, result, nowMs, row.id).run();
  return result;
}

// ⚠️ THE ONE FUNCTION THAT SENDS THE CUSTOMER FOLLOW-UP. The due-dispatcher and the backstop
// sweep both call it; the claim UPDATE (followed_up_at still NULL) means at most one email per row.
async function sendDropOffFollowup(env, db, row, nowMs) {
  if (!row || row.followed_up_at != null) return 'already';
  if (!['pending', 'abandoned'].includes(row.status) || Number(row.deposit_paid) === 1) return 'skipped_paid';
  const email = lowerOf(row.email);
  if (!email) return finishFollowup(db, row, nowMs, 'skipped_no_email');
  const now = nowInAdelaide(nowMs);
  const phone = digitsOf(row.phone);

  // Did they book anyway (a later checkout, or Stefani entered it)? Then there is nothing to chase.
  const createdMs = parseStoredInstant(row.created_at);
  const { results: later } = await db.prepare(
    "SELECT phone, email FROM bookings WHERE status = 'confirmed' AND id != ? AND (created_at >= ? OR confirmed_at >= ?)"
  ).bind(row.id, String(row.created_at || ''), Number.isFinite(createdMs) ? createdMs : 0).all();
  if (later.some(b => (phone && digitsOf(b.phone) === phone) || lowerOf(b.email) === email)) {
    return finishFollowup(db, row, nowMs, 'skipped_booked_since');
  }
  if (await atBookingCap(db, row.phone, email, now)) return finishFollowup(db, row, nowMs, 'skipped_at_cap');
  const recent = await db.prepare(
    "SELECT COUNT(*) AS n FROM bookings WHERE LOWER(email) = ? AND followup_result = 'sent' AND followed_up_at > ? AND id != ?"
  ).bind(email, nowMs - FOLLOWUP_EMAIL_PER_ADDRESS_DAYS * 86400000, row.id).first();
  if (recent && recent.n > 0) return finishFollowup(db, row, nowMs, 'skipped_recent_email');

  const inEmailHours = isInFollowupEmailHours(nowInAdelaide(nowMs).min);
  if (!inEmailHours) return 'waiting_for_email_hours';

  const claimed = await db.prepare(
    `UPDATE bookings SET followed_up_at = ?, followup_result = 'sending', updated_at = ?
     WHERE id = ? AND followed_up_at IS NULL AND status IN ('pending', 'abandoned') AND COALESCE(deposit_paid, 0) = 0`
  ).bind(nowMs, nowMs, row.id).run();
  if (changesOf(claimed) !== 1) return 'claimed_elsewhere';

  const t = await db.prepare('SELECT id, name, duration_min FROM treatments WHERE id = ?').bind(String(row.treatment_id || '')).first();
  const addonIds = String(row.addon_ids || '').split(',').map(s => s.trim()).filter(Boolean);
  const addons = [];
  for (const aid of addonIds) {
    const a = await db.prepare('SELECT name, duration_min FROM addons WHERE id = ?').bind(aid).first();
    if (a) addons.push(a);
  }
  const treatmentName = t ? t.name : String(row.treatment_id || 'treatment');
  const what = treatmentName + (addons.length ? ' + ' + addons.map(a => a.name).join(' + ') : '');
  const hasSlot = isDateStr(row.date) && Number.isInteger(row.start_min);
  const duration = t ? t.duration_min + addons.reduce((s, a) => s + (a.duration_min || 0), 0) : 0;
  const slotOpen = !!t && hasSlot && (await slotsForDate(db, row.date, duration, now.abs,
    { excludeId: row.id, holderPhone: row.phone, holderEmail: email, nowMs })).includes(row.start_min);
  const link = slotOpen
    ? bookingLinkFor(row.treatment_id, addonIds.join(','), row.date, row.start_min)
    : bookingLinkFor(row.treatment_id, addonIds.join(','));
  let sent = false;
  try {
    sent = await sendEmail(env, email, `Your ${treatmentName} booking isn't confirmed yet`,
      checkoutFollowupEmail({
        name: row.name, what, slotOpen, link,
        dateLabel: hasSlot ? fmtDate(row.date) : '', timeLabel: hasSlot ? fmtTime(row.start_min) : '',
        depositLabel: fmtMoneyCents(row.deposit_cents || 0),
      }));
  } catch (e) {
    console.error('follow-up email failed', row.id, String(e && e.message || e).slice(0, 200));
  }
  if (sent) {
    await db.prepare("UPDATE bookings SET followup_result = 'sent', updated_at = ? WHERE id = ?").bind(nowMs, row.id).run();
    return 'sent';
  }
  // Release the claim so a later run can try again (still inside the 48h window).
  await db.prepare("UPDATE bookings SET followed_up_at = NULL, followup_result = 'send_failed', updated_at = ? WHERE id = ? AND followup_result = 'sending'")
    .bind(nowMs, row.id).run();
  return 'send_failed';
}

// Every minute: drop-offs whose follow-up is due (set by the failed/cancelled payment event).
async function dispatchDueFollowups(env, nowMs) {
  const db = env.DB;
  const { results } = await db.prepare(
    `SELECT * FROM bookings WHERE followup_due_at IS NOT NULL AND followup_due_at <= ? AND followup_due_at > ?
       AND followed_up_at IS NULL AND status IN ('pending', 'abandoned') ORDER BY followup_due_at LIMIT 50`
  ).bind(nowMs, nowMs - FOLLOWUP_MAX_AGE_MS).all();
  const out = [];
  for (const row of results) {
    try { out.push(await sendDropOffFollowup(env, db, row, nowMs)); }
    catch (e) { console.error('follow-up dispatch failed', row.id, String(e && e.message || e).slice(0, 200)); }
  }
  return out;
}

// Hourly backstop: a row that clearly had a failed payment but never got its follow-up due
// time (the event path missed it). Same guarded sender, so it can never double up. A row
// abandoned WITHOUT any failed payment is never selected here.
async function followupBackstopSweep(env, nowMs) {
  const db = env.DB;
  const { results } = await db.prepare(
    `SELECT * FROM bookings WHERE followed_up_at IS NULL AND status IN ('pending', 'abandoned') AND COALESCE(deposit_paid, 0) = 0
       AND (lifecycle = 'deposit_failed' OR payment_failed_at IS NOT NULL)
       AND COALESCE(followup_due_at, payment_failed_at + ?, pi_created_at + ?) <= ?
       AND COALESCE(followup_due_at, payment_failed_at + ?, pi_created_at + ?) > ?
     ORDER BY created_at LIMIT 50`
  ).bind(FOLLOWUP_DELAY_MS, FOLLOWUP_DELAY_MS, nowMs, FOLLOWUP_DELAY_MS, FOLLOWUP_DELAY_MS, nowMs - FOLLOWUP_MAX_AGE_MS).all();
  const out = [];
  for (const row of results) {
    try { out.push(await sendDropOffFollowup(env, db, row, nowMs)); }
    catch (e) { console.error('follow-up backstop failed', row.id, String(e && e.message || e).slice(0, 200)); }
  }
  return out;
}

// ---------- completed marking ----------

// A confirmed booking whose appointment END has passed on the Adelaide wall clock.
async function markCompletedBookings(env, nowMs) {
  const now = nowInAdelaide(nowMs);
  const res = await env.DB.prepare(
    `UPDATE bookings SET lifecycle = 'completed', completed_at = ?, updated_at = ?
     WHERE status = 'confirmed' AND lifecycle IN ('deposit_paid', 'booked_no_deposit')
       AND (date < ? OR (date = ? AND end_min <= ?))`
  ).bind(nowMs, nowMs, now.date, now.date, now.min).run();
  return changesOf(res);
}

// ---------- reporting ----------

const REPORT_NOTE =
  'Counts are for bookings STARTED on these Adelaide calendar days. collected_cents is deposits actually received ' +
  'through Stripe (paid deposits minus refunds). outstanding_cents is, for confirmed bookings in the range, the full ' +
  "price (or Stefani's price override) minus the net deposit: the balance due in person on the day. This system does " +
  'not record in-person payments, so outstanding_cents still includes balances already paid at the studio.';

// Pure. rows: bookings rows (created_at, status, lifecycle, deposit_paid, deposit_cents, refunded_cents,
// payment_failed_at, abandoned_reason, stripe_payment_intent_id, price_override). priceOf(row) -> dollars.
function aggregateDepositReport(rows, from, to, priceOf) {
  const out = {
    from, to, started: 0, deposits_paid: 0, deposits_failed: 0, abandoned: 0, refunded: 0,
    bookings_without_deposit: 0, collected_cents: 0, outstanding_cents: 0, note: REPORT_NOTE,
  };
  for (const r of rows || []) {
    const day = adelaideDateOfInstant(r.created_at);
    if (!day || day < from || day > to) continue;
    const superseded = r.abandoned_reason === 'superseded';
    const paid = Number(r.deposit_paid) === 1;
    const deposit = paid ? Math.max(0, Math.round(Number(r.deposit_cents) || 0)) : 0;
    const refunded = Math.max(0, Math.round(Number(r.refunded_cents) || 0));
    const wentToCheckout = !!r.stripe_payment_intent_id || r.status === 'pending' || r.status === 'abandoned';
    if (wentToCheckout && !superseded) out.started++;
    if (paid) out.deposits_paid++;
    if (r.payment_failed_at != null) out.deposits_failed++;
    if (r.lifecycle === 'abandoned' && !superseded) out.abandoned++;
    if (refunded > 0) out.refunded++;
    if (r.status === 'confirmed' && !paid) out.bookings_without_deposit++;
    out.collected_cents += deposit - refunded;
    if (r.status === 'confirmed') {
      const override = r.price_override;
      const priceAud = override !== null && override !== undefined && Number.isFinite(Number(override)) ? Number(override) : Number(priceOf(r)) || 0;
      out.outstanding_cents += Math.max(0, Math.round(priceAud * 100) - (deposit - refunded));
    }
  }
  return out;
}

// ---------- the cron ----------

async function runScheduledWork(env, nowMs) {
  nowMs = Number.isFinite(nowMs) ? nowMs : Date.now();
  try {
    await ensureBookingSchema(env.DB, nowMs);
  } catch (e) {
    console.error('cron: booking schema check failed', String(e && e.message || e).slice(0, 200));
  }
  const deferred = [];
  const defer = p => deferred.push(p);
  const steps = [
    ['stripe events', () => reprocessStuckStripeEvents(env, nowMs)],
    ['abandonment', () => abandonLapsedCheckouts(env, nowMs, defer)],
    ['follow-ups', () => dispatchDueFollowups(env, nowMs)],
    ['completed', () => markCompletedBookings(env, nowMs)],
  ];
  // Hourly work runs on the Adelaide hour. Reminders keep their own reminded flag, so a missed hour is harmless.
  if (nowInAdelaide(nowMs).min % 60 === 0) {
    steps.push(['reminders', () => sendReminders(env, nowMs)]);
    steps.push(['follow-up backstop', () => followupBackstopSweep(env, nowMs)]);
  }
  const done = {};
  for (const [name, fn] of steps) {
    // Independent: a failure in one never stops the others.
    try { done[name] = await fn(); } catch (e) {
      console.error('cron step failed:', name, String(e && e.message || e).slice(0, 200));
      done[name] = 'error';
    }
  }
  await Promise.allSettled(deferred);
  return done;
}

// Test hook only: workerd never defines REVIVE_WORKER_TEST_HOOKS, so production exposes nothing.
if (typeof globalThis !== 'undefined' && typeof globalThis.REVIVE_WORKER_TEST_HOOKS === 'function') {
  globalThis.REVIVE_WORKER_TEST_HOOKS({
    HOLD_MIN, HOLD_MS, FOLLOWUP_DELAY_MS, holdHasLapsed, isInFollowupEmailHours, backfillLifecycle,
    aggregateDepositReport, verifyStripeSignature, nowInAdelaide, adelaideDateOfInstant, parseStoredInstant,
    runScheduledWork, dispatchDueFollowups, followupBackstopSweep, abandonLapsedCheckouts, markCompletedBookings,
    processStripeEvent, ensureBookingSchema, sendDropOffFollowup,
  });
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
      // Lazy migration (lifecycle/hold columns, stripe_events, backfill): one PRAGMA per
      // isolate once done. The Stripe webhook runs it itself, AFTER its signature check.
      if (path.startsWith('/api/') && path !== '/api/webhooks/stripe' && env.DB) {
        await ensureBookingSchema(env.DB, Date.now())
          .catch(e => console.error('booking schema check failed', String(e && e.message || e).slice(0, 200)));
      }
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
  // Every minute ("* * * * *"): stuck Stripe events, lapsed holds, due follow-ups, completed
  // marking; on the Adelaide hour also reminders and the follow-up backstop sweep.
  async scheduled(event, env, ctx) {
    const nowMs = event && Number.isFinite(event.scheduledTime) ? event.scheduledTime : Date.now();
    ctx.waitUntil(runScheduledWork(env, nowMs));
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
      'SELECT id, name, duration_min, price_aud, treatment_ids FROM addons WHERE active = 1 ORDER BY price_aud DESC, name'
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

  if (path === '/api/webhooks/stripe' && req.method === 'POST') {
    return await handleStripeWebhook(req, env, ctx);
  }

  if (path === '/api/create-payment-intent' && req.method === 'POST') {
    if (!env.STRIPE_SECRET_KEY) return json({ error: 'payments_unavailable' }, 503, cors);
    const body = await req.json().catch(() => ({}));
    const name = String(body.name || '').trim().slice(0, 120);
    const phone = String(body.phone || '').trim();
    const email = String(body.email || '').trim().toLowerCase();
    const notes = String(body.notes || '').trim().slice(0, 800);

    // Price the booking from D1, never from the request. The client chooses WHICH
    // treatment and add-ons; the server alone decides what that costs.
    const dt = await db.prepare('SELECT * FROM treatments WHERE id = ? AND active = 1')
      .bind(body.treatment).first();
    if (!dt) return json({ error: 'unknown_treatment' }, 400, cors);
    const dAddons = await lookupAddons(db, body.addons ?? body.addon);
    if (dAddons === undefined) return json({ error: 'unknown_addon' }, 400, cors);
    const startMin = parseHHMM(body.time) ?? (Number.isInteger(body.start_min) ? body.start_min : null);
    if (!isDateStr(body.date) || startMin === null) return json({ error: 'bad_slot' }, 400, cors);
    if (name.length < 2) return json({ error: 'name_required' }, 400, cors);
    if (phone.replace(/\D/g, '').length < 8) return json({ error: 'phone_required' }, 400, cors);
    if (!email) return json({ error: 'email_required' }, 400, cors);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: 'bad_email' }, 400, cors);
    const depositCents = depositCentsFor(totalPriceAud(dt, dAddons));
    if (depositCents <= 0) return json({ error: 'no_deposit_required', deposit_cents: 0 }, 400, cors);

    const duration = dt.duration_min + dAddons.reduce((s, a) => s + a.duration_min, 0);
    const nowMs = Date.now();
    const now = nowInAdelaide(nowMs);
    const addonIds = dAddons.map(a => a.id).join(',');
    const addonNames = dAddons.map(a => a.name).join(' + ');
    const clientIp = String(req.headers.get('cf-connecting-ip') || '').slice(0, 64);
    const userAgent = String(req.headers.get('user-agent') || '').slice(0, 300);

    // The checkout being resumed (Back, then Continue again on the page), if it is still a live hold.
    const wantId = String(body.checkout_id || '').trim().slice(0, 64);
    const existing = wantId
      ? await db.prepare("SELECT * FROM bookings WHERE id = ? AND status = 'pending'").bind(wantId).first()
      : null;

    // ⚠️ SLOT + CAP ARE CHECKED HERE, BEFORE ANY PaymentIntent EXISTS. The browser
    // confirms the card before it calls /api/book, so a check that only runs there
    // fires after the customer has already been charged. Do not move this below
    // the Stripe call. Other people's live holds count as taken.
    const blocker = await bookingBlocker(db, body.date, startMin, duration, phone, email, now,
      { excludeId: existing ? existing.id : '', nowMs });
    if (blocker) return json({ error: blocker.error }, blocker.status, cors);

    if (existing && existing.stripe_payment_intent_id) {
      const livePi = await stripeGetPaymentIntent(env, existing.stripe_payment_intent_id);
      const sameOrder = existing.treatment_id === dt.id && (existing.addon_ids || '') === addonIds &&
        Number(existing.deposit_cents) === depositCents;
      if (sameOrder && livePi && livePi.client_secret && livePi.amount === depositCents &&
          (livePi.status === 'requires_payment_method' || livePi.status === 'requires_confirmation')) {
        // Same order, card not yet charged: hand back the SAME PaymentIntent so a
        // back-and-forth on the page never leaves a trail of orphaned intents. The hold
        // moves to the (possibly new) time and restarts its HOLD_MIN clock.
        const reused = await db.prepare(
          `UPDATE bookings SET name = ?, phone = ?, email = ?, notes = ?, date = ?, start_min = ?, end_min = ?,
             hold_until = ?, client_ip = ?, user_agent = ?, updated_at = ?
           WHERE id = ? AND status = 'pending'`
        ).bind(name, phone, email, notes, body.date, startMin, startMin + duration,
               nowMs + HOLD_MS, clientIp, userAgent, nowMs, existing.id).run();
        if (changesOf(reused) === 1) {
          await supersedeOwnHolds(env, db, { phone, email, date: body.date, startMin, endMin: startMin + duration, keepId: existing.id, nowMs });
          return json({ client_secret: livePi.client_secret, deposit_cents: depositCents, checkout_id: existing.id, policy: CANCELLATION_POLICY }, 200, cors);
        }
      }
      await supersedeHold(env, db, existing, livePi, nowMs);
    } else if (existing) {
      await supersedeHold(env, db, existing, null, nowMs);
    }
    await supersedeOwnHolds(env, db, { phone, email, date: body.date, startMin, endMin: startMin + duration, keepId: '', nowMs });

    // The row IS the hold, and it exists before the PaymentIntent does - so every PaymentIntent
    // this worker hands out has a booking row a webhook can find. If the row cannot be written,
    // no payment is started at all.
    const checkoutId = newBookingId();
    const attr = cleanAttribution(body.attribution);
    await db.prepare(
      `INSERT INTO bookings (id, treatment_id, addon_ids, addon_names, date, start_min, end_min, name, phone, email, notes,
         status, reminded, cancel_token, created_at, stripe_payment_intent_id, deposit_paid, deposit_cents,
         lifecycle, hold_until, client_ip, user_agent, updated_at, ${ATTRIBUTION_FIELDS.join(', ')})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, '', 0, ?, 'started', ?, ?, ?, ?, ${ATTRIBUTION_FIELDS.map(() => '?').join(', ')})`
    ).bind(checkoutId, dt.id, addonIds, addonNames, body.date, startMin, startMin + duration, name, phone, email, notes,
           crypto.randomUUID(), new Date(nowMs).toISOString(), depositCents, nowMs + HOLD_MS, clientIp, userAgent, nowMs,
           ...ATTRIBUTION_FIELDS.map(k => attr[k])).run();

    const params = new URLSearchParams();
    params.set('amount', String(depositCents));
    params.set('currency', 'aud');
    params.append('payment_method_types[]', 'card');
    if (name) params.set('description', `Revive Aesthetics booking deposit — ${name}`);
    params.set('metadata[checkout_id]', checkoutId);
    params.set('metadata[phone]', phone);
    if (attr.utm_source) params.set('metadata[utm_source]', attr.utm_source);
    if (attr.utm_campaign) params.set('metadata[utm_campaign]', attr.utm_campaign);
    const r = await fetch('https://api.stripe.com/v1/payment_intents', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });
    const pi = await r.json();
    if (!r.ok) {
      // Release the hold now; the cron abandons the row and tells Stefani the payment step never opened.
      await db.prepare("UPDATE bookings SET hold_until = ?, updated_at = ? WHERE id = ? AND status = 'pending'")
        .bind(nowMs, nowMs, checkoutId).run().catch(() => {});
      return json({ error: 'stripe_error', detail: pi.error?.message }, 502, cors);
    }
    // The hold's HOLD_MIN clock starts when the PaymentIntent exists.
    const piAt = Date.now();
    const armed = await db.prepare(
      `UPDATE bookings SET stripe_payment_intent_id = ?, lifecycle = 'deposit_pending', pi_created_at = ?, hold_until = ?, updated_at = ?
       WHERE id = ? AND status = 'pending'`
    ).bind(pi.id, piAt, piAt + HOLD_MS, piAt, checkoutId).run();
    if (changesOf(armed) !== 1) throw new Error('checkout row vanished before its payment could be attached');
    // deposit_cents is returned so the page can DISPLAY the figure. It is never
    // read back as an input - the confirmation compares Stripe's amount with the row.
    return json({ client_secret: pi.client_secret, deposit_cents: depositCents, checkout_id: checkoutId, policy: CANCELLATION_POLICY }, 200, cors);
  }

  if (path === '/api/book' && req.method === 'POST') {
    const b = await req.json().catch(() => ({}));
    if (b.website) return json({ ok: true }, 200, cors); // honeypot: pretend success
    const pid = String(b.payment_intent_id || '').trim();

    // A deposit taken through /api/create-payment-intent already has its booking row (the
    // hold). Confirm THAT row. The Stripe webhook may have confirmed it already, in which
    // case this returns the same booking and sends nothing a second time.
    if (pid) {
      const held = await rowForPaymentIntent(db, pid);
      if (held) return await bookHeldCheckout(env, ctx, db, req, held, pid, cors);
    }

    // Below: a booking with no deposit (free treatment), or a PaymentIntent with no checkout
    // row (created before holds existed).
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
    const nowMs = Date.now();
    const now = nowInAdelaide(nowMs);
    const what = t.name + (addonNames ? ' + ' + addonNames : '');

    // Stripe deposit. The expected amount is recomputed HERE from the treatment
    // and add-on rows already looked up above - the request body cannot influence
    // it. `price` is the server's own figure, so depositCents is too.
    const depositCents = depositCentsFor(price);
    let paymentIntentId = '';
    let depositPaidCents = 0;
    let verifiedPi = null;
    const unbookable = { pid, name, phone, email, what, date: b.date, startMin, cors };

    // Slot open + gentle abuse cap (max 2 upcoming bookings per phone/email).
    // ⚠️ If this refuses a request that carries a succeeded payment, the customer has
    // already paid: refund it and tell Stefani - never just return the error.
    const blocker = await bookingBlocker(db, b.date, startMin, duration, phone, email, now, { nowMs });
    if (blocker) {
      if (pid) {
        const refundedRes = await refundUnbookable(env, ctx, db, { ...unbookable, error: blocker.error, status: blocker.status });
        if (refundedRes) return refundedRes;
      }
      return json({ error: blocker.error }, blocker.status, cors);
    }

    // Check if this client's phone is flagged as requiring a deposit.
    // Normalise to digits only so "0489052103" and "+61489052103" both match.
    const phoneDigits = phone.replace(/\D/g, '');
    const clientFlag = await db.prepare(
      'SELECT require_deposit FROM client_flags WHERE phone = ?'
    ).bind(phoneDigits).first().catch(() => null);
    const requiresDeposit = clientFlag?.require_deposit === 1;

    if (depositCents > 0 && !pid && (env.STRIPE_SECRET_KEY || requiresDeposit)) {
      // A deposit is owed. If Stripe is live the client can pay online; if not
      // but the client is flagged, they must call Stefani to arrange payment.
      return json({
        error: 'deposit_required',
        deposit_cents: depositCents,
        ...(requiresDeposit && !env.STRIPE_SECRET_KEY
          ? { message: 'A deposit is required for your booking. Please call Stefani on 0404 967 051 to arrange.' }
          : {}),
      }, 402, cors);
    }

    if (pid && env.STRIPE_SECRET_KEY) {
      const sr = await fetch(`https://api.stripe.com/v1/payment_intents/${encodeURIComponent(pid)}`, {
        headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
      });
      const pi = await sr.json();
      if (!sr.ok || pi.status !== 'succeeded' || pi.amount !== depositCents || pi.currency !== 'aud') {
        return json({ error: 'deposit_unverified' }, 402, cors);
      }
      paymentIntentId = pid;
      depositPaidCents = pi.amount;
      verifiedPi = pi;
    }

    const id = crypto.randomUUID().slice(0, 8);
    const cancelToken = crypto.randomUUID();
    const attr = cleanAttribution(b.attribution);
    try {
      await db.prepare(
        `INSERT INTO bookings (id, treatment_id, addon_ids, addon_names, date, start_min, end_min, name, phone, email, notes, cancel_token, created_at, lifecycle, confirmed_at, updated_at, stripe_payment_intent_id, deposit_paid, deposit_cents, ${ATTRIBUTION_FIELDS.join(', ')})
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${ATTRIBUTION_FIELDS.map(() => '?').join(', ')})`
      ).bind(id, t.id, addons.map(a => a.id).join(','), addonNames, b.date, startMin, startMin + duration,
             name, phone, email, notes, cancelToken, new Date(nowMs).toISOString(),
             paymentIntentId ? 'deposit_paid' : 'booked_no_deposit', nowMs, nowMs,
             paymentIntentId, paymentIntentId ? 1 : 0, depositPaidCents,
             ...ATTRIBUTION_FIELDS.map(k => attr[k])).run();
    } catch (e) {
      if (String(e.message || e).includes('UNIQUE')) {
        // Someone took the slot in the instant between the check and the write.
        // The deposit has already been verified as paid, so refund it.
        if (paymentIntentId) {
          const refundedRes = await refundUnbookable(env, ctx, db, { ...unbookable, pi: verifiedPi, error: 'slot_unavailable', status: 409 });
          if (refundedRes) return refundedRes;
        }
        return json({ error: 'slot_unavailable' }, 409, cors);
      }
      throw e;
    }

    const created = await db.prepare('SELECT * FROM bookings WHERE id = ?').bind(id).first();
    ctx.waitUntil(notifyBookingConfirmed(env, db, created, {
      clientIp: req.headers.get('cf-connecting-ip') || '',
      userAgent: req.headers.get('user-agent') || '',
    }));

    return json({
      ok: true, id, cancel_token: cancelToken,
      treatment: t.name, addon: addonNames || null,
      date: b.date, date_label: fmtDate(b.date),
      time_label: fmtTime(startMin), duration_min: duration,
      price_aud: price,
    }, 200, cors);
  }

  // One-tap Apple Calendar subscribe: https link (tappable in Telegram/SMS) that
  // redirects to the webcal:// form of the feed, which iOS hands to Calendar.
  if (path === '/api/apple-calendar' && req.method === 'GET') {
    const key = url.searchParams.get('key') || '';
    if (!env.ADMIN_TOKEN || key !== env.ADMIN_TOKEN) return new Response('forbidden', { status: 403 });
    const webcal = `webcal://${url.host}/api/feed.ics?key=${key}`;
    return new Response(
      `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<meta http-equiv="refresh" content="0;url=${webcal}">` +
      `<title>Revive Bookings — Apple Calendar</title>` +
      `<body style="font-family:sans-serif;background:#2B0F1A;color:#F2E7CE;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:90vh;text-align:center;padding:24px">` +
      `<p>Opening Apple Calendar…</p>` +
      `<p><a href="${webcal}" style="display:inline-block;background:#c2a878;color:#2B0F1A;padding:14px 28px;border-radius:999px;text-decoration:none;font-weight:600">Subscribe to Revive Bookings</a></p>` +
      `<p style="opacity:.7;font-size:14px">Tap the button if nothing happens, then tap Subscribe.</p></body>`,
      { headers: { 'content-type': 'text/html; charset=utf-8' } }
    );
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
      const res = await db.prepare("UPDATE bookings SET status='cancelled', lifecycle='cancelled', cancelled_at=? WHERE id=? AND status='confirmed'")
        .bind(new Date().toISOString(), row.id).run();
      if (changesOf(res) === 1) ctx.waitUntil(Promise.allSettled([
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

  // Sculpt consent forms (lymphatic massage · cupping · sculpting tools · LED):
  // body-sculpt (stomach) and face-sculpt share the flow, differing in health questions.
  if (path === '/api/consent' && req.method === 'POST') {
    const body = await req.json().catch(() => ({}));
    if (body.website) return json({ ok: true }, 200, cors); // honeypot: pretend success
    const s = (v, n) => String(v || '').trim().slice(0, n);
    const name = s(body.name, 120);
    const phone = s(body.phone, 40);
    const email = s(body.email, 160).toLowerCase();
    if (name.length < 2) return json({ error: 'name_required' }, 400, cors);

    const yn = (v) => { const x = String(v || '').toLowerCase(); return x === 'yes' || x === 'no' ? x : ''; };
    const CONSENT_FORMS = {
      'body-sculpt': {
        label: 'Body sculpt',
        health: ['pregnant', 'breastfeeding', 'abdo_surgery', 'hernia', 'clotting',
                 'heart_kidney_lymph', 'skin_area', 'photosensitive'],
      },
      'face-sculpt': {
        label: 'Face sculpt',
        health: ['pregnant', 'breastfeeding', 'face_surgery', 'injectables', 'coldsores',
                 'clotting', 'skin_area', 'photosensitive'],
      },
      'pdrn-microneedling': {
        label: 'PDRN Microneedling',
        health: ['pregnant', 'breastfeeding', 'roaccutane', 'fish_allergy', 'clotting',
                 'active_skin', 'recent_treatment', 'injectables', 'keloid', 'autoimmune', 'chemo'],
      },
      'korean-lash-lift': {
        label: 'Korean Lash Lift',
        health: ['pregnant', 'eye_infection', 'eye_surgery', 'chemical_allergy',
                 'lash_condition', 'alopecia', 'chemo', 'contacts', 'recent_lift'],
      },
    };
    const formType = CONSENT_FORMS[body.form] ? body.form : 'body-sculpt';
    const HEALTH = CONSENT_FORMS[formType].health;
    const formLabel = CONSENT_FORMS[formType].label;
    const p = { form: formType + '-consent' };
    for (const k of HEALTH) p[k] = yn(body[k]);
    if (HEALTH.some(k => !p[k])) return json({ error: 'health_required' }, 400, cors);
    p.other_conditions = s(body.other_conditions, 600);
    p.photo_consent = ['social', 'private'].includes(body.photo_consent) ? body.photo_consent : '';
    if (!p.photo_consent) return json({ error: 'photo_choice_required' }, 400, cors);
    p.signature = s(body.signature, 120);
    if (!body.c_accurate || !body.c_treatment || !body.c_results || !body.c_aftercare || p.signature.length < 2) {
      return json({ error: 'consent_required' }, 400, cors);
    }
    Object.assign(p, { c_accurate: true, c_treatment: true, c_results: true, c_aftercare: true });

    const flags = HEALTH.filter(k => p[k] === 'yes');
    const summary = (formLabel + ' consent signed · photos: ' +
      (p.photo_consent === 'social' ? 'ok for socials' : 'file only') +
      (p.other_conditions ? ' · notes given' : '')).slice(0, 240);
    const id = crypto.randomUUID().slice(0, 10);
    await db.prepare(
      `INSERT INTO intake_forms (id, booking_id, name, phone, email, summary, flags, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(id, s(body.booking_id, 16) || null, name, phone, email,
           summary, flags.join(','), JSON.stringify(p), new Date().toISOString()).run();

    ctx.waitUntil(telegram(env,
      `\u{1F4DD} <b>${formLabel} consent signed</b>\n${name}${phone ? ' · ' + phone : ''}\n${summary}` +
      (flags.length ? `\n⚠️ <b>REVIEW: ${flags.join(', ').toUpperCase()}</b> — confirm suitability before treating` : '')));

    return json({ ok: true, id, flagged: flags.length > 0 }, 200, cors);
  }

  if (path === '/api/survey' && req.method === 'POST') {
    const body = await req.json().catch(() => ({}));
    if (body.website) return json({ ok: true }, 200, cors); // honeypot: pretend success

    const s = (v, n) => String(v || '').trim().slice(0, n);
    const p = {
      had_before: s(body.had_before, 60),
      interest: s(body.interest, 60),
      style: s(body.style, 60),
      price: s(body.price, 60),
      frequency: s(body.frequency, 60),
      matters: (Array.isArray(body.matters) ? body.matters : [])
        .map(x => String(x).trim().slice(0, 60)).filter(Boolean).slice(0, 8),
      comments: s(body.comments, 600),
      notify: body.notify ? 'yes' : 'no',
    };
    if (!p.interest) return json({ error: 'interest_required' }, 400, cors);

    const survey = s(body.survey, 40) || 'lash-lift';
    const name = s(body.name, 120);
    const contact = s(body.contact, 160);
    const id = crypto.randomUUID().slice(0, 10);
    await db.prepare(
      `INSERT INTO survey_responses (id, survey, name, contact, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(id, survey, name, contact, JSON.stringify(p), new Date().toISOString()).run();

    const lines = [
      `\u{1F4AC} <b>Lash lift survey response</b>`,
      `Would book: <b>${p.interest || '—'}</b> · Fair price: <b>${p.price || '—'}</b>`,
      `Had one before: ${p.had_before || '—'} · Style: ${p.style || '—'} · Upkeep: ${p.frequency || '—'}`,
    ];
    if (p.matters.length) lines.push(`Matters most: ${p.matters.join(', ')}`);
    if (p.comments) lines.push(`“${p.comments}”`);
    if (name || contact) lines.push(`${name || 'No name'}${contact ? ' · ' + contact : ''}${p.notify === 'yes' ? ' · wants launch news' : ''}`);
    ctx.waitUntil(telegram(env, lines.join('\n')));

    return json({ ok: true, id }, 200, cors);
  }

  // ---- Instagram / Messenger webhook ----

  // GET: Meta sends this to verify our endpoint when you first add the webhook
  if (path === '/api/webhooks/instagram' && req.method === 'GET') {
    const mode      = url.searchParams.get('hub.mode');
    const token     = url.searchParams.get('hub.verify_token');
    const challenge = url.searchParams.get('hub.challenge');
    if (mode === 'subscribe' && token === env.META_VERIFY_TOKEN) {
      return new Response(challenge, { status: 200 });
    }
    return new Response('Forbidden', { status: 403 });
  }

  // POST: real DM event arrives here
  if (path === '/api/webhooks/instagram' && req.method === 'POST') {
    const rawBody = await req.text();

    // Verify Meta signature so random internet people can't fake events
    if (env.META_APP_SECRET) {
      const sigHeader = req.headers.get('x-hub-signature-256') || '';
      const key = await crypto.subtle.importKey(
        'raw', new TextEncoder().encode(env.META_APP_SECRET),
        { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
      );
      const sig  = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody));
      const expected = 'sha256=' + Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
      if (sigHeader !== expected) return new Response('Forbidden', { status: 403 });
    }

    let body;
    try { body = JSON.parse(rawBody); } catch { return new Response('EVENT_RECEIVED', { status: 200 }); }

    const autoReply = env.IG_AUTO_REPLY ||
      "Hi! Thanks for messaging Revive Aesthetics 🌿 Stefani will get back to you soon. To book online: reviveaestheticsadl.com.au 💛";

    // Meta sends entry.messaging[] for both Instagram and Messenger via connected Facebook Page
    for (const entry of (body.entry || [])) {
      for (const messaging of (entry.messaging || [])) {
        const senderId   = messaging.sender?.id;
        const msgText    = messaging.message?.text;
        const isEcho     = messaging.message?.is_echo;
        if (isEcho || !senderId || !msgText) continue;

        // Telegram ping to Stefani
        ctx.waitUntil(telegram(env,
          `\u{1F4E9} <b>Instagram DM</b>\n\n"${msgText}"\n\n<i>Auto-reply sent. Reply on Instagram to continue the chat.</i>`
        ));

        // Auto-reply via Instagram Graph API
        if (env.META_PAGE_ACCESS_TOKEN) {
          ctx.waitUntil(
            fetch('https://graph.instagram.com/v21.0/me/messages', {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${env.META_PAGE_ACCESS_TOKEN}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                recipient: { id: senderId },
                message:   { text: autoReply },
              }),
            }).catch(() => {})
          );
        }
      }
    }

    return new Response('EVENT_RECEIVED', { status: 200 });
  }

  return json({ error: 'not_found' }, 404, cors);
}

async function lookupBooking(db, id, token) {
  if (!id || !token) return null;
  return db.prepare(
    `SELECT b.*, t.name AS tname, b.addon_names AS aname
     FROM bookings b JOIN treatments t ON t.id = b.treatment_id
     WHERE b.id = ? AND b.cancel_token = ? AND b.status IN ('confirmed', 'cancelled')`
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
    // A checkout in progress (pending) or one that never paid (abandoned) is NOT an
    // appointment and must never reach the diary or a client's history. ?include=all
    // shows them deliberately, for troubleshooting.
    const includeAll = url.searchParams.get('include') === 'all';
    const { results } = await db.prepare(
      `SELECT b.id, b.date, b.start_min, b.end_min, b.status, b.name, b.phone, b.email, b.notes,
              b.created_at, b.addon_ids, t.name AS treatment, t.price_aud, b.addon_names AS addon,
              b.price_override, b.deposit_paid, b.deposit_cents, b.stripe_payment_intent_id,
              b.lifecycle, b.refunded_cents, ${ATTRIBUTION_FIELDS.map(k => 'b.' + k).join(', ')}
       FROM bookings b JOIN treatments t ON t.id = b.treatment_id
       WHERE b.date BETWEEN ? AND ?${includeAll ? '' : " AND b.status IN ('confirmed', 'cancelled')"}
       ORDER BY b.date, b.start_min`
    ).bind(from, to).all();
    const priceOf = await makePriceOf(db);
    return json({
      bookings: results.map(r => ({
        ...r, addon_ids: undefined, price_override: undefined,
        price_aud: Number.isFinite(r.price_override) ? r.price_override : priceOf(r),
        deposit_paid: r.deposit_paid === 1,
        // Stefani needs the AMOUNT, not just a yes/no. When she cancels someone
        // inside the 48h window she has to refund exactly what was taken, and
        // "a deposit was paid" alone means refunding blind. The payment id is
        // included so she can find the charge in Stripe without searching by name.
        deposit_label: r.deposit_cents ? fmtMoneyCents(r.deposit_cents) : '',
        deposit_cents: r.deposit_cents || 0,
        refunded_cents: r.refunded_cents || 0,
        stripe_payment_intent_id: undefined,
        stripe_ref: r.stripe_payment_intent_id || '',
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

  if (path === '/api/admin/survey' && req.method === 'GET') {
    const survey = String(url.searchParams.get('survey') || 'lash-lift').slice(0, 40);
    const { results } = await db.prepare(
      'SELECT id, survey, name, contact, payload, created_at FROM survey_responses WHERE survey = ? ORDER BY created_at DESC LIMIT 500'
    ).bind(survey).all();
    return json({
      survey, count: results.length,
      responses: results.map(r => ({ ...r, payload: r.payload ? JSON.parse(r.payload) : {} })),
    }, 200, cors);
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

  // Silent admin booking — no email, no Telegram. Used to block specific slots.
  if (path === '/api/admin/book' && req.method === 'POST') {
    const b = await req.json().catch(() => ({}));
    if (!isDateStr(b.date)) return json({ error: 'bad_date' }, 400, cors);
    const start = typeof b.start_min === 'number' ? b.start_min : null;
    const end = typeof b.end_min === 'number' ? b.end_min : null;
    if (start === null || end === null || end <= start) return json({ error: 'bad_times' }, 400, cors);
    const id = crypto.randomUUID();
    await db.prepare(
      `INSERT OR IGNORE INTO bookings (id, treatment_id, addon_ids, addon_names, date, start_min, end_min, name, phone, email, notes, status, reminded, cancel_token, created_at, lifecycle)
       VALUES (?, 'consultation', '', '', ?, ?, ?, ?, '', '', ?, 'confirmed', 0, ?, ?, 'booked_no_deposit')`
    ).bind(id, b.date, start, end, String(b.name || 'BLOCKED').slice(0, 100),
      String(b.notes || 'Admin block').slice(0, 500), crypto.randomUUID(), new Date().toISOString()).run();
    return json({ ok: true, id }, 200, cors);
  }

  if (path === '/api/admin/cancel' && req.method === 'POST') {
    const b = await req.json().catch(() => ({}));
    // Only a real appointment can be cancelled; a pending checkout is not one.
    await db.prepare("UPDATE bookings SET status='cancelled', lifecycle='cancelled', cancelled_at=? WHERE id=? AND status='confirmed'")
      .bind(new Date().toISOString(), String(b.id || '')).run();
    return json({ ok: true }, 200, cors);
  }

  // Send (or resend) the branded confirmation email for an existing booking —
  // used for bookings Stefani adds manually, which skip the public /api/book flow.
  if (path === '/api/admin/send-confirmation' && req.method === 'POST') {
    const b = await req.json().catch(() => ({}));
    const row = await db.prepare(
      `SELECT b.*, t.name AS tname, t.price_aud FROM bookings b JOIN treatments t ON t.id = b.treatment_id
       WHERE b.id = ?`
    ).bind(String(b.id || '')).first();
    if (!row || row.status !== 'confirmed') return json({ error: 'not_found' }, 404, cors);
    if (!row.email) return json({ error: 'no_email' }, 400, cors);
    const what = row.tname + (row.addon_names ? ' + ' + row.addon_names : '');
    const priceOf = await makePriceOf(db);
    const price = Number.isFinite(b.price_override) ? b.price_override : priceOf(row);
    const cancelUrl = `${CANCEL_BASE}?cancel=${row.id}&token=${row.cancel_token}`;
    const sent = await sendEmail(env, row.email,
      `Booking confirmed: ${what}, ${fmtDate(row.date)} ${fmtTime(row.start_min)} — Revive Aesthetics`,
      confirmationEmail({
        name: row.name, what, dateLabel: fmtDate(row.date), timeLabel: fmtTime(row.start_min),
        duration: row.end_min - row.start_min, price,
        intro: typeof b.intro === 'string' ? b.intro.slice(0, 500) : '',
      }, cancelUrl,
      treatmentForms(row.treatment_id, row.id, row.name, row.phone, row.email)));
    return json({ ok: !!sent, sent_to: row.email }, 200, cors);
  }

  // Pin the exact public slots Stefani wants shown for a date (replaces any previous override).
  if (path === '/api/admin/set-allowed-slots' && req.method === 'POST') {
    const b = await req.json().catch(() => ({}));
    if (!isDateStr(b.date)) return json({ error: 'bad_date' }, 400, cors);
    const slots = Array.isArray(b.slots) ? b.slots.filter(s => Number.isInteger(s)) : [];
    await db.prepare('DELETE FROM slot_overrides WHERE date = ?').bind(b.date).run();
    for (const s of slots) {
      await db.prepare('INSERT OR IGNORE INTO slot_overrides (date, start_min) VALUES (?, ?)').bind(b.date, s).run();
    }
    return json({ ok: true, date: b.date, slots }, 200, cors);
  }

  // Restore normal availability for a date (remove any slot override).
  if (path === '/api/admin/clear-allowed-slots' && req.method === 'POST') {
    const b = await req.json().catch(() => ({}));
    if (!isDateStr(b.date)) return json({ error: 'bad_date' }, 400, cors);
    await db.prepare('DELETE FROM slot_overrides WHERE date = ?').bind(b.date).run();
    return json({ ok: true }, 200, cors);
  }

  // Idempotent schema migration — creates any tables added after the initial deploy.
  // Update a treatment's duration or price — POST /api/admin/update-treatment {id, duration_min?, price_aud?}
  if (path === '/api/admin/update-treatment' && req.method === 'POST') {
    const b = await req.json().catch(() => ({}));
    if (!b.id) return json({ error: 'missing id' }, 400, cors);
    if (b.duration_min != null) {
      await db.prepare('UPDATE treatments SET duration_min = ? WHERE id = ?').bind(b.duration_min, b.id).run();
    }
    if (b.price_aud != null) {
      await db.prepare('UPDATE treatments SET price_aud = ? WHERE id = ?').bind(b.price_aud, b.id).run();
    }
    const { results } = await db.prepare('SELECT * FROM treatments WHERE id = ?').bind(b.id).all();
    return json({ ok: true, treatment: results[0] || null }, 200, cors);
  }

  // Update a booking's add-on — POST /api/admin/update-booking-addon {id, addon_ids, addon_names, end_min?}
  if (path === '/api/admin/update-booking-addon' && req.method === 'POST') {
    const b = await req.json().catch(() => ({}));
    if (!b.id) return json({ error: 'missing id' }, 400, cors);
    const row = await db.prepare("SELECT * FROM bookings WHERE id = ? AND status = 'confirmed'").bind(b.id).first();
    if (!row) return json({ error: 'not_found' }, 404, cors);
    await db.prepare('UPDATE bookings SET addon_ids = ?, addon_names = ?, end_min = ? WHERE id = ?')
      .bind(String(b.addon_ids || ''), String(b.addon_names || ''), b.end_min ?? row.end_min, b.id).run();
    const updated = await db.prepare('SELECT * FROM bookings WHERE id = ?').bind(b.id).first();
    return json({ ok: true, booking: updated }, 200, cors);
  }

  if (path === '/api/admin/migrate' && req.method === 'POST') {
    await db.prepare(
      `CREATE TABLE IF NOT EXISTS slot_overrides (date TEXT NOT NULL, start_min INTEGER NOT NULL, PRIMARY KEY (date, start_min))`
    ).run();
    // Stripe deposit columns — added 2026-08-26; safe to run repeatedly
    await db.exec(`ALTER TABLE bookings ADD COLUMN stripe_payment_intent_id TEXT`).catch(() => {});
    await db.exec(`ALTER TABLE bookings ADD COLUMN deposit_paid INTEGER DEFAULT 0`).catch(() => {});
    // How much was actually taken, in cents — added 2026-09-06 with the 30% deposit.
    // deposit_paid stays a 0/1 flag; this is the amount, needed to refund correctly.
    // ⚠️ RUN MIGRATE BEFORE DEPLOYING the code that writes this column, or every
    // INSERT fails on "no such column" and bookings stop working entirely.
    await db.exec(`ALTER TABLE bookings ADD COLUMN deposit_cents INTEGER DEFAULT 0`).catch(() => {});
    // treatment_ids on addons — added 2026-09-01; empty string = applies to all treatments
    await db.exec(`ALTER TABLE addons ADD COLUMN treatment_ids TEXT NOT NULL DEFAULT ''`).catch(() => {});
    // client_flags — added 2026-09-08; flags clients who must pay a deposit before booking
    await db.prepare(
      `CREATE TABLE IF NOT EXISTS client_flags (
        phone           TEXT PRIMARY KEY,   -- digits only, e.g. "0489052103"
        require_deposit INTEGER DEFAULT 1,  -- 1 = always require deposit
        note            TEXT DEFAULT '',    -- internal reason (Stefani-only)
        created_at      TEXT DEFAULT (datetime('now'))
      )`
    ).run();
    // Booking lifecycle + checkout holds + stripe_events — added 2026-09-14. Adds any missing
    // columns, creates stripe_events and backfills lifecycle on every existing row. It also
    // runs lazily on the first request of each isolate; this is belt and braces.
    const backfilled = await ensureBookingSchema(db, Date.now(), true);
    return json({ ok: true, lifecycle_backfilled: backfilled }, 200, cors);
  }

  // Deposit funnel + money for bookings STARTED on Adelaide days from..to (inclusive).
  if (path === '/api/admin/report' && req.method === 'GET') {
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');
    if (!isDateStr(from) || !isDateStr(to) || from > to) return json({ error: 'bad_range' }, 400, cors);
    // Coarse prefilter on the stored text with two days of padding either side; the exact
    // Adelaide-day filter happens in aggregateDepositReport, which converts each instant.
    const { results } = await db.prepare(
      `SELECT b.*, t.price_aud AS treatment_price_aud FROM bookings b LEFT JOIN treatments t ON t.id = b.treatment_id
       WHERE b.created_at >= ? AND b.created_at < ?`
    ).bind(addDays(from, -2), addDays(to, 3)).all();
    const priceOf = await makePriceOf(db);
    return json(aggregateDepositReport(results, from, to,
      r => priceOf({ price_aud: r.treatment_price_aud || 0, addon_ids: r.addon_ids })), 200, cors);
  }

  if (path === '/api/admin/client-flags' && req.method === 'GET') {
    const { results } = await db.prepare('SELECT * FROM client_flags ORDER BY created_at DESC').all();
    return json({ flags: results }, 200, cors);
  }

  if (path === '/api/admin/flag-client' && req.method === 'POST') {
    const b = await req.json().catch(() => ({}));
    const phone = String(b.phone || '').replace(/\D/g, '');
    if (phone.length < 8) return json({ error: 'phone_required' }, 400, cors);
    const requireDeposit = b.require_deposit === false ? 0 : 1;
    const note = String(b.note || '').slice(0, 300);
    if (requireDeposit === 0) {
      await db.prepare('DELETE FROM client_flags WHERE phone = ?').bind(phone).run();
      return json({ ok: true, removed: true, phone }, 200, cors);
    }
    await db.prepare(
      `INSERT OR REPLACE INTO client_flags (phone, require_deposit, note, created_at)
       VALUES (?, 1, ?, datetime('now'))`
    ).bind(phone, note).run();
    return json({ ok: true, flagged: true, phone }, 200, cors);
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
