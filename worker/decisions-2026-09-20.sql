-- Revive Aesthetics — menu decisions taken by Stefani on 20 Sept 2026.
-- Safe to re-run: every statement is an UPDATE or an INSERT OR IGNORE.
--
-- Apply with:  bash worker/apply-decisions-2026-09-20.sh
-- Or by hand:  npx wrangler d1 execute revive-booking --remote --file decisions-2026-09-20.sql

-- ------------------------------------------------------------------
-- 1. The lash add-on is a keratin infusion, not a toxin. The word
--    "Botox" must never appear on the menu. The row id stays as-is so
--    existing bookings that reference it keep working.
-- ------------------------------------------------------------------
UPDATE addons SET name = 'Keratin Lash Infusion' WHERE id = 'botox-lash';

-- ------------------------------------------------------------------
-- 2. Plainer, truer copy for the lash lift.
-- ------------------------------------------------------------------
UPDATE treatments
   SET description = 'A Korean-technique lift and curl of your own natural lashes from the root, finished with a tint. Lasts 6–8 weeks. No extensions, no mascara needed.'
 WHERE id = 'lash-lift';

-- ------------------------------------------------------------------
-- 3. Three new brow treatments.
-- ------------------------------------------------------------------
INSERT OR IGNORE INTO treatments (id, name, duration_min, price_aud, description, active, sort) VALUES
  ('brow-shape-tint', 'Brow Shape & Tint', 30, 50,
   'Your brows shaped and tinted to suit your face, in a quick half-hour visit.', 1, 4),
  ('brow-lamination', 'Brow Lamination, Tint & Shape', 60, 100,
   'Your brow hairs brushed up and set into a fuller shape, then tinted and shaped to finish.', 1, 3),
  ('lash-brow-combo', 'Korean Lash Lift + Brow Lamination', 135, 180,
   'The Korean lash lift and tint together with brow lamination, tint and shape, in one appointment.', 1, 2);

-- ------------------------------------------------------------------
-- 4. Public menu order. The live `sort` values for lash-lift,
--    consultation and lymphatic are not in schema.sql (they were added
--    after the initial seed), so every id is set explicitly rather than
--    guessed. Reads as: lash lift, combo, brow lamination, brow shape
--    & tint, consultation, microneedling, lymphatic.
-- ------------------------------------------------------------------
UPDATE treatments SET sort = 1 WHERE id = 'lash-lift';
UPDATE treatments SET sort = 2 WHERE id = 'lash-brow-combo';
UPDATE treatments SET sort = 3 WHERE id = 'brow-lamination';
UPDATE treatments SET sort = 4 WHERE id = 'brow-shape-tint';
UPDATE treatments SET sort = 5 WHERE id = 'consultation';
UPDATE treatments SET sort = 6 WHERE id = 'microneedling';
UPDATE treatments SET sort = 7 WHERE id = 'lymphatic';
