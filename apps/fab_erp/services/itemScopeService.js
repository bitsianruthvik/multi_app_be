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
 * ONE BINDING PER PURPOSE (2026-09-02). This described a three-tier resolution
 * — order line type, then structure level, then a global default — which read
 * well and was never once exercised: the only caller has always asked for the
 * purpose alone. See `resolveScope`.
 *
 * IT CANNOT RESOLVE TO NOTHING. A missing binding falls through to the global
 * default, never to an empty list. An empty picker is indistinguishable from
 * "we have no stock" and gets reported as a data problem by whoever hits it.
 */

import { pool } from '../../../db.js';

/**
 * The scope that governs a purpose.
 *
 * The binding used to be keyed on a line type and a structure level as well,
 * with a specificity score picking the winner. Both keys are gone — not because
 * levels went away, but because `pickList` is the only caller `resolveScope`
 * has ever had and it never passed either one, so every lookup in production
 * has always resolved to the global binding. Two columns, a three-way score and
 * a doc-comment describing a hierarchy nothing ever exercised.
 *
 * If per-context scoping is wanted later, the honest key is the catalog item —
 * the same key the BOM and the flow default now use.
 */
export async function resolveScope(companyId, purpose, { conn = null } = {}) {
  const exec = conn ?? pool;
  const [rows] = await exec.query(
    `SELECT b.id, b.scope_id AS scopeId, s.scope_key AS scopeKey, s.label
       FROM fab_item_scope_bindings b
       JOIN fab_item_scopes s ON s.id = b.scope_id AND s.deleted_at IS NULL AND s.active = 1
      WHERE b.company_id = ? AND b.purpose = ? AND b.active = 1 AND b.deleted_at IS NULL
      ORDER BY b.id
      LIMIT 1`,
    [companyId, purpose],
  );
  return rows[0] ?? null;
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
