-- 2026-08-rm-weight-factors.sql
-- ---------------------------------------------------------------------------
-- Weight factors for the raw materials, so a part's weight can be worked out
-- from its dimensions instead of typed.
--
--   density   : thickness(mm) x length(mm) x width(mm) x factor / 1e6  -> kg
--               factor is g/cc — 7.85 for structural steel
--   per_metre : factor x length(mm) / 1000                            -> kg
--               factor is the section's mass per metre
--
-- Matched on `code` per company, one statement each, rather than a LIKE sweep:
-- a factor applied to the wrong material produces weights that look plausible
-- and are wrong, which is far worse than a blank.
--
-- ONLY materials whose weight genuinely comes from dimensions get a factor.
-- Welding wire, flux, grit, paint, bolts and gas are bought and issued by
-- weight, volume or the piece — there is no length x width x thickness to
-- multiply, and inventing a density for them would let the system compute a
-- confident, meaningless number. Those are deliberately left NULL, which the
-- weight service reads as "unknown" rather than zero.
--
-- Section masses are the IS 808 standard values. ISA 100x100x10 = 14.9 kg/m is
-- confirmed against the client's own Vishwa Samudra BOQ, which uses exactly
-- that figure for BLB 1 (14.9 x 1.850 m = 27.565 kg).
-- ---------------------------------------------------------------------------

-- ── Structural steel plate — density 7.85 g/cc ──────────────────────────────

UPDATE fab_item_catalog SET unit_weight = 7.85, weight_basis = 'density'
 WHERE deleted_at IS NULL AND unit_weight IS NULL AND code IN (
   -- Placebo (30005), the live plate stock
   'RM26RM01418',  -- MS Plate 16mm E350 B0
   'RM26RM01419',  -- MS Plate 20mm E350 B0
   'RM26RM01420',  -- MS Plate 28mm E350 B0
   'RM26RM01421',  -- MS Plate 32mm E350 B0
   'RM26RM01422',  -- MS Plate 40mm E350 B0
   'RM26RM01423',  -- MS Plate 45mm E350 B0
   -- StartHub (1)
   'PL-12-E350', 'PL-20-E350', 'PL-25-E350', '123',
   -- Vertex (4) — structural bar, cut to size
   'STRUCT-STEEL'
 );

-- ── Steel sections — mass per metre (IS 808) ────────────────────────────────

UPDATE fab_item_catalog SET unit_weight = 14.9,  weight_basis = 'per_metre'
 WHERE deleted_at IS NULL AND unit_weight IS NULL AND code = 'RM26RM01424'; -- ISA 100x100x10

UPDATE fab_item_catalog SET unit_weight = 8.9,   weight_basis = 'per_metre'
 WHERE deleted_at IS NULL AND unit_weight IS NULL AND code = 'ISA75';       -- ISA 75x75x8

UPDATE fab_item_catalog SET unit_weight = 44.2,  weight_basis = 'per_metre'
 WHERE deleted_at IS NULL AND unit_weight IS NULL AND code = 'ISMB300';     -- ISMB 300

UPDATE fab_item_catalog SET unit_weight = 22.1,  weight_basis = 'per_metre'
 WHERE deleted_at IS NULL AND unit_weight IS NULL AND code = 'ISMC200';     -- ISMC 200

-- MS Pipe 100NB SCH40: OD 114.3 mm, wall 6.02 mm
--   pi x (114.3 - 6.02) x 6.02 x 7.85 / 1000 = 16.08 kg/m
UPDATE fab_item_catalog SET unit_weight = 16.08, weight_basis = 'per_metre'
 WHERE deleted_at IS NULL AND unit_weight IS NULL AND code = 'PIPE100NB';

-- SS 316L Pipe 2in Sch40: OD 60.3 mm, wall 3.91 mm, density 8.0
--   pi x (60.3 - 3.91) x 3.91 x 8.0 / 1000 = 5.54 kg/m
UPDATE fab_item_catalog SET unit_weight = 5.54,  weight_basis = 'per_metre'
 WHERE deleted_at IS NULL AND unit_weight IS NULL AND code = 'SS-PIPE-2IN';

-- ── Non-ferrous bar — density ───────────────────────────────────────────────

UPDATE fab_item_catalog SET unit_weight = 2.70, weight_basis = 'density'
 WHERE deleted_at IS NULL AND unit_weight IS NULL AND code = 'ALM-6061';    -- Aluminium 6061-T6

UPDATE fab_item_catalog SET unit_weight = 8.00, weight_basis = 'density'
 WHERE deleted_at IS NULL AND unit_weight IS NULL AND code = 'SS-316';      -- SS 316L round bar
