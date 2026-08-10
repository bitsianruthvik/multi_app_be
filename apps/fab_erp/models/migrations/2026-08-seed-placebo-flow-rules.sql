-- 2026-08-seed-placebo-flow-rules.sql
-- ---------------------------------------------------------------------------
-- Placebo's three flow rules — the whole of flow allocation for a girder job.
--
--   part    | (default) | Part Fabrication — Plain (no holes)
--   part    | /D        | Part Fabrication — Drilled
--   segment | (default) | Girder Segment — Assembly, Welding & Finishing
--
-- Spans and girders get no rule on purpose: they are groupings, and no flow
-- means nothing to do.
--
-- line_type is NULL — "any structure type" — for two reasons. No order line
-- carries a structure type yet, so a rule scoped to 'Composite Girder' would
-- match nothing and the feature would look broken on day one. And a PEB uses
-- the same tree and the same flows for now, so a global rule is honest rather
-- than merely convenient. A type-scoped rule added later automatically wins,
-- because a more specific rule beats a general one.
--
-- Matched on flow CODE, not name: the names carry em-dashes and would be at the
-- mercy of collation. Idempotent — re-running inserts nothing.
-- ---------------------------------------------------------------------------

INSERT INTO fab_flow_rules (company_id, line_type, level_kind, code_suffix, flow_id, notes)
SELECT 30005, NULL, 'part', NULL, f.id, 'default for parts'
  FROM fab_operation_flows f
 WHERE f.company_id = 30005 AND f.code = 'PARTPL' AND f.deleted_at IS NULL
   AND NOT EXISTS (
     SELECT 1 FROM fab_flow_rules r
      WHERE r.company_id = 30005 AND r.level_kind = 'part'
        AND r.code_suffix IS NULL AND r.line_type IS NULL AND r.deleted_at IS NULL);

INSERT INTO fab_flow_rules (company_id, line_type, level_kind, code_suffix, flow_id, notes)
SELECT 30005, NULL, 'part', '/D', f.id, 'parts whose code ends /D are drilled'
  FROM fab_operation_flows f
 WHERE f.company_id = 30005 AND f.code = 'PARTDR' AND f.deleted_at IS NULL
   AND NOT EXISTS (
     SELECT 1 FROM fab_flow_rules r
      WHERE r.company_id = 30005 AND r.level_kind = 'part'
        AND r.code_suffix = '/D' AND r.line_type IS NULL AND r.deleted_at IS NULL);

INSERT INTO fab_flow_rules (company_id, line_type, level_kind, code_suffix, flow_id, notes)
SELECT 30005, NULL, 'segment', NULL, f.id, 'default for girder segments'
  FROM fab_operation_flows f
 WHERE f.company_id = 30005 AND f.code = 'SEG' AND f.deleted_at IS NULL
   AND NOT EXISTS (
     SELECT 1 FROM fab_flow_rules r
      WHERE r.company_id = 30005 AND r.level_kind = 'segment'
        AND r.code_suffix IS NULL AND r.line_type IS NULL AND r.deleted_at IS NULL);
