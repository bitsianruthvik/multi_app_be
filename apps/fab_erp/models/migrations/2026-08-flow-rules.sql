-- 2026-08-flow-rules.sql
-- ---------------------------------------------------------------------------
-- Stage 3 of a sales order: which operation flow each item gets.
--
-- Assigning a flow is not a 400-item decision. On a real order it is two:
-- every girder segment gets the same assembly flow, and every part gets the
-- same fabrication flow bar the drilled ones. What varies is the LEVEL, not the
-- item. So a rule is:
--
--   (structure type, level, code suffix) -> flow
--
-- and a DEFAULT is simply a rule with no suffix:
--
--   Composite Girder | part    | (none) | Part Fabrication — Plain
--   Composite Girder | part    | /D     | Part Fabrication — Drilled
--   Composite Girder | segment | (none) | Girder Segment — Assembly, Welding…
--
-- One table rather than a defaults table plus an exceptions table, because they
-- are the same thing at different specificities, and splitting them would mean
-- two places to look when a flow comes out wrong.
--
-- `/D` is the shop's own marker for a drilled variant (`IS2` vs `IS2/D`), which
-- is why itemCodeService.normaliseAbbr keeps the slash.
--
-- NO RULE MEANS NO FLOW MEANS NOTHING TO DO. Spans and girders carry no flow on
-- a real order — they are groupings. That is a valid end state, not a gap, so
-- nothing here nags about it.
--
-- line_type NULL = applies to any structure type, which is what a shop with one
-- kind of job wants and what a PEB uses until it earns its own rules.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS fab_flow_rules (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  company_id  INT           NOT NULL,
  line_type   VARCHAR(40)   NULL,           -- NULL = any structure type
  level_kind  VARCHAR(20)   NOT NULL,       -- span | girder | segment | part
  code_suffix VARCHAR(20)   NULL,           -- NULL = the default for that level
  flow_id     INT           NOT NULL,
  active      TINYINT(1)    NOT NULL DEFAULT 1,
  notes       VARCHAR(255)  NULL,
  deleted_at  DATETIME      DEFAULT NULL,
  created_at  TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (company_id) REFERENCES companies(id),
  KEY idx_ffr_lookup (company_id, level_kind, line_type)
);

-- A record of what an apply actually did, so "why does this part have that
-- flow" has an answer that is not a guess.
SET @col = (SELECT COUNT(*) FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fab_items' AND COLUMN_NAME='flow_source');
SET @sql = IF(@col=0,'ALTER TABLE fab_items ADD COLUMN flow_source VARCHAR(20) NULL','SELECT 1');
PREPARE s FROM @sql; EXECUTE s; DEALLOCATE PREPARE s;
