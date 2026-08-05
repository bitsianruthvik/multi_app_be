-- 2026-08-drop-bom-templates.sql  (plan Phase 2c)
--
-- Remove the reusable/versioned BOM template model. All three tables held zero
-- rows for the life of the feature.
--
-- This one is contradicted by the spec rather than merely unused: BOMs are built
-- per project in an hour or two and cross-project reuse is explicitly not
-- wanted. The template/slot/version machinery is the opposite of that.
--
-- KEPT, and not to be confused with the above: fab_material_boms (29 rows) and
-- fab_material_bom_items (367 rows) are the per-project BOM that BomDesigner
-- writes and that /bom/copy-template and /bom/template-count read. "template" in
-- those two endpoint names refers to the material BOM, not to fab_bom_templates
-- -- an easy and expensive misreading, since the plan originally called for all
-- three /bom endpoints to be deleted when only /bom/instantiate-template
-- actually touched the template tables.
--
-- Drop order: children before parent. No FK constraints exist on any of them
-- (indexes only), but the order costs nothing and states the intent.
--
-- Idempotent: DROP TABLE IF EXISTS, safe to re-run.

DROP TABLE IF EXISTS fab_bom_template_slots;
DROP TABLE IF EXISTS fab_bom_template_nodes;
DROP TABLE IF EXISTS fab_bom_templates;
