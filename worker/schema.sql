-- Revive Aesthetics booking — D1 schema + seed data
-- Safe to re-run: tables use IF NOT EXISTS, seeds use INSERT OR IGNORE
-- (so price edits made later via UPDATE are never clobbered by a redeploy).

CREATE TABLE IF NOT EXISTS treatments (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  duration_min INTEGER NOT NULL,
  price_aud    INTEGER NOT NULL,          -- whole dollars; 0 = free
  description  TEXT NOT NULL DEFAULT '',
  active       INTEGER NOT NULL DEFAULT 1,
  sort         INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS bookings (
  id           TEXT PRIMARY KEY,
  treatment_id TEXT NOT NULL REFERENCES treatments(id),
  date         TEXT NOT NULL,             -- YYYY-MM-DD (Adelaide local)
  start_min    INTEGER NOT NULL,          -- minutes from midnight, Adelaide local
  end_min      INTEGER NOT NULL,
  name         TEXT NOT NULL,
  phone        TEXT NOT NULL,
  email        TEXT NOT NULL DEFAULT '',
  notes        TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'confirmed',  -- confirmed | cancelled
  cancel_token TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  cancelled_at TEXT
);

-- one confirmed booking per slot, ever
CREATE UNIQUE INDEX IF NOT EXISTS ux_bookings_active_slot
  ON bookings(date, start_min) WHERE status = 'confirmed';
CREATE INDEX IF NOT EXISTS ix_bookings_date ON bookings(date);

CREATE TABLE IF NOT EXISTS blocked_dates (
  date   TEXT PRIMARY KEY,                -- YYYY-MM-DD
  reason TEXT NOT NULL DEFAULT ''
);

-- ============================================================
-- Seed treatments.
-- !! PRICES ARE PLACEHOLDERS — confirm with Stefani, then:
--    npx wrangler d1 execute revive-booking --remote \
--      --command "UPDATE treatments SET price_aud=149 WHERE id='peel'"
-- ============================================================
INSERT OR IGNORE INTO treatments (id, name, duration_min, price_aud, description, active, sort) VALUES
  ('consult', 'Skin Consultation', 30, 0,
   'A one-on-one skin assessment. We talk through your concerns and map out a treatment plan built around you.', 1, 1),
  ('peel', 'Chemical Peel', 45, 129,
   'Professional-grade peel to resurface, brighten and refine — tailored strength for your skin type and goals.', 1, 2),
  ('microneedling', 'Microneedling', 75, 249,
   'Collagen-induction therapy to soften scarring, smooth texture and improve firmness over time.', 1, 3);
