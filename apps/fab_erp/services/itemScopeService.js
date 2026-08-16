/**
 * itemScopeService.js — which catalog items may be picked, and where.
 *
 * A scope is a named pick list defined by rules over the taxonomy. An item
 * qualifies if it matches ANY include rule and NO exclude rule; within a single
 * rule, the non-null fields are ANDed.
 *
 * WHY INCLUSION AND NOT SUBTRACTION. The material picker's rule was "everything
 * bought, minus consumables and fasteners". Subtraction means every category
 * added later is in by default until somebody remembers to take it out, which
 * is how paint and welding flux came to be offered as things to cut a flange
 * from. An inclusion is wrong in the safe direction: a new category is absent
 * until somebody says it belongs, and an absence is visible in a way a wrong
 * presence is not.
 *
 * THE TWO-TIER RESOLUTION, decided 2026-08-16:
 *
 *   1. the order LINE's type      most specific — a bridge line and a PEB line
 *                                  on one system can draw from different lists
 *   2. the STRUCTURE LEVEL         a part and a segment may differ
 *   3. the global default          purpose with no line type and no level
 *
 * IT CANNOT RESOLVE TO NOTHING. A missing binding falls through to the global
 * default, never to an empty list. An empty picker is indistinguishable from
 * "we have no stock" and gets reported as a data problem by whoever hits it.
 */

import { pool } from '../../../db.js';

/** The scope that governs a purpose, for this line type and structure level. */
export async function resolveScope(companyId, purpose, { lineType = null, levelKind = null, conn = null } = {}) {
  const exec = conn ?? pool;
  const [rows] = await exec.query(
    `SELECT b.id, b.scope_id AS scopeId, b.line_type AS lineType, b.level_kind AS levelKind,
            s.scope_key AS scopeKey, s.label
       FROM fab_item_scope_bindings b
       JOIN fab_item_scopes s ON s.id = b.scope_id AND s.deleted_at IS NULL AND s.active = 1
      WHERE b.company_id = ? AND b.purpose = ? AND b.active = 1 AND b.deleted_at IS NULL
        AND (b.line_type IS NULL OR b.line_type = ?)
        AND (b.level_kind IS NULL OR b.level_kind = ?)`,
    [companyId, purpose, lineType, levelKind],
  );
  if (!rows.length) return null;

  // Most specific wins: a line-type match beats a level match beats the global.
  const score = (b) => (b.lineType ? 2 : 0) + (b.levelKind ? 1 : 0);
  rows.sort((a, b) => score(b) - score(a));
  return rows[0];
}

/** A scope's rules, split into the two lists the matcher wants. */
export async function scopeRules(companyId, scopeId, conn = null) {
  const exec = conn ?? pool;
  const [rows] = await exec.query(
    `SELECT rule_type AS ruleType, category_id AS categoryId, group_id AS groupId,
            subgroup_id AS subgroupId, procurement_type AS procurementType,
            material_form AS materialForm
       FROM fab_item_scope_rules
      WHERE company_id = ? AND scope_id = ? AND deleted_at IS NULL`,
    [companyId, scopeId],
  );
  return {
    include: rows.filter((r) => r.ruleType !== 'exclude'),
    exclude: rows.filter((r) => r.ruleType === 'exclude'),
  };
}

/** Does one catalog item satisfy one rule? Non-null fields are ANDed. */
const matchesRule = (item, r) =>
  (r.categoryId == null || Number(item.categoryId) === Number(r.categoryId))
  && (r.groupId == null || Number(item.groupId) === Number(r.groupId))
  && (r.subgroupId == null || Number(item.subgroupId) === Number(r.subgroupId))
  && (r.procurementType == null || item.procurementType === r.procurementType)
  && (r.materialForm == null || item.materialForm === r.materialForm);

/**
 * Every catalog item in a scope.
 *
 * A scope with NO include rules matches nothing, which is deliberate: an empty
 * rule set is an unfinished scope, and quietly treating it as "everything"
 * would turn a half-built configuration into the widest possible list — the
 * exact failure this replaces.
 */
export async function itemsInScope(companyId, scopeId, { search = null, conn = null } = {}) {
  const exec = conn ?? pool;
  const rules = await scopeRules(companyId, scopeId, exec);
  if (!rules.include.length) return [];

  const [items] = await exec.query(
    // `density_kg_m3` and `section_area_mm2` are NOT decoration here. A part's
    // weight is volume x density, computed by itemWeightService from whatever
    // rawMaterialsFor returns — omit them and every weight in the system
    // silently becomes null, which is the kind of breakage that shows up as a
    // blank column three screens away.
    `SELECT i.id, i.code, i.name, i.unit, i.thickness_mm AS thicknessMm,
            i.density_kg_m3 AS densityKgM3, i.section_area_mm2 AS sectionAreaMm2,
            i.material_form AS materialForm, i.procurement_type AS procurementType,
            i.category_id AS categoryId, i.group_id AS groupId, i.subgroup_id AS subgroupId,
            cat.code AS categoryCode, grp.name AS groupName
       FROM fab_item_catalog i
       LEFT JOIN fab_item_categories cat ON cat.id = i.category_id
       LEFT JOIN fab_item_groups grp ON grp.id = i.group_id
      WHERE i.company_id = ? AND i.deleted_at IS NULL
        ${search ? 'AND (i.code LIKE ? OR i.name LIKE ?)' : ''}
      ORDER BY i.code`,
    search ? [companyId, `%${search}%`, `%${search}%`] : [companyId],
  );

  return items.filter((it) =>
    rules.include.some((r) => matchesRule(it, r))
    && !rules.exclude.some((r) => matchesRule(it, r)));
}

/**
 * The pick list for a purpose, resolved and evaluated in one call.
 *
 * Returns `{ scope, items }`. A null scope means no binding exists at all — a
 * configuration gap rather than an empty list, and the caller should say so
 * rather than render nothing.
 */
export async function pickList(companyId, purpose, opts = {}) {
  const scope = await resolveScope(companyId, purpose, opts);
  if (!scope) return { scope: null, items: [] };
  return { scope, items: await itemsInScope(companyId, scope.scopeId, opts) };
}
