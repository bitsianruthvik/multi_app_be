-- 2026-08-bom-templates.sql
-- ---------------------------------------------------------------------------
-- What a structure type is made of, as data rather than as a constant.
--
-- This lived in `DEFAULT_PARTS` in multi_app_fe/src/apps/fab_erp/types.ts — a
-- hardcoded TypeScript array. Three things were wrong with that, and they only
-- get worse as more companies come on:
--
--   * changing the parts of a composite girder needed a code change and a deploy
--   * every company on the platform got the same seven parts
--   * only 'Composite Girder' had an entry at all, so picking BowString, Tub
--     Girder, Openweb or PEB in the wizard filled in nothing
--
-- It is the SAME SHAPE as fab_flow_rules — "for this kind of line item, do X by
-- default" — and that one was already a company-scoped table editable in Setup.
-- Two implementations of one idea is one too many, so this follows it exactly.
--
-- A template row is a PART: its code, what to call it, and optionally the
-- thickness and material it usually is. The wizard copies them in and everything
-- stays editable before anything is generated — these are a starting point, not
-- a schema, which is why nothing here is enforced downstream.
--
-- Idempotent; re-running is a no-op.
--
-- NOTE: this is folded into models/init.sql, which is what push-to-prod
-- actually runs. Keep the two in step — init.sql is the authority.
-- ---------------------------------------------------------------------------

-- `fab_bom_templates` was ALSO the name of the reusable/versioned BOM model
-- dropped in 2026-08-drop-bom-templates.sql — a different schema with no
-- line_type. On a database still carrying that one, CREATE TABLE IF NOT EXISTS
-- would quietly leave it in place and the seed below would fail on an unknown
-- column. Those legacy tables held zero rows, so dropping is safe.
SET @legacy_exists = (
  SELECT COUNT(*) FROM information_schema.tables
   WHERE table_schema = DATABASE() AND table_name = 'fab_bom_templates');
SET @has_line_type = (
  SELECT COUNT(*) FROM information_schema.columns
   WHERE table_schema = DATABASE() AND table_name = 'fab_bom_templates'
     AND column_name = 'line_type');
SET @sql = IF(@legacy_exists = 1 AND @has_line_type = 0,
  'DROP TABLE fab_bom_templates', 'SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;

DROP TABLE IF EXISTS fab_bom_template_slots;
DROP TABLE IF EXISTS fab_bom_template_nodes;

CREATE TABLE IF NOT EXISTS fab_bom_templates (
  id                  INT AUTO_INCREMENT PRIMARY KEY,
  company_id          INT NOT NULL,
  -- Which structure type this part belongs to, matching fab_order_lines.line_type.
  -- Free text rather than an enum for the same reason line_type is: the list of
  -- structure types is itself hardcoded in two places today, and an enum here
  -- would make that a third.
  line_type           VARCHAR(40) NOT NULL,
  code                VARCHAR(60) NOT NULL,
  name                VARCHAR(255) NULL,
  qty                 DECIMAL(14,4) NOT NULL DEFAULT 1,
  -- The usual thickness and material. Both optional: a template that only says
  -- "every composite girder has a top flange" is already worth having, and
  -- guessing a material would be worse than leaving it to the wizard.
  thickness_mm        DECIMAL(10,3) NULL,
  rm_catalog_item_id  INT NULL,
  sort_order          INT NOT NULL DEFAULT 0,
  active              TINYINT(1) NOT NULL DEFAULT 1,
  notes               TEXT NULL,
  created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at          DATETIME NULL,
  KEY idx_fbt_company_type (company_id, line_type, active),
  KEY idx_fbt_material (rm_catalog_item_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ── seed the parts that were hardcoded ────────────────────────────────────
-- Seeded for every company that HAS THE fab_erp APP. Keying this off the item
-- catalog instead would miss any tenant onboarded later, whose catalog is empty
-- on day one — and a seed only reaches whoever qualifies on the day it runs.
-- Guarded per (company, line_type, code) so a re-run adds nothing and, more
-- importantly, never resurrects a part somebody deliberately deleted.
--
-- The /D codes are load-bearing: flow rules match on a code suffix, and that is
-- what makes drilling get assigned without a per-item decision. Renaming them
-- to something tidier would silently route holed stiffeners down the flow that
-- never drills them.

INSERT INTO fab_bom_templates (company_id, line_type, code, name, sort_order)
SELECT c.company_id, 'Composite Girder', s.code, s.name, s.sort_order
  FROM (SELECT DISTINCT company_id FROM apps
         WHERE slug = 'fab_erp' AND deleted_at IS NULL) c
  JOIN (
        SELECT 'TF'   AS code, 'Top Flange'                    AS name, 1 AS sort_order
  UNION SELECT 'WP',        'Web Plate',                     2
  UNION SELECT 'BF',        'Bottom Flange',                 3
  UNION SELECT 'BS',        'Bearing Stiffener Plain',       4
  UNION SELECT 'BS/D',      'Bearing Stiffener Hole',        5
  UNION SELECT 'IS',        'Intermediate Stiffener Plain',  6
  UNION SELECT 'IS/D',      'Intermediate Stiffener Hole',   7
  ) s
 WHERE NOT EXISTS (
   SELECT 1 FROM fab_bom_templates t
    WHERE t.company_id = c.company_id
      AND t.line_type = 'Composite Girder'
      AND t.code = s.code);
