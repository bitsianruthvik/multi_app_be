/**
 * 06-scopes.mjs — which items each picker is allowed to offer.
 *
 * MISSING FROM THE REBUILD PLAN, and the omission is not cosmetic.
 *
 * `rawMaterialService` asks the scope table what a part may be cut from. When no
 * `bom_material` scope is configured it falls back to "every catalog item whose
 * category is not in NOT_CUT_FROM", and that list is `['cons', 'fast']` — it
 * excludes Consumables and Fasteners but NOT `mro` or `tool`. So on a tenant
 * with no scopes, the spares this rebuild introduces would be offered as things
 * to cut a girder flange out of.
 *
 * Old Placebo had exactly three scopes, each an include rule on one category,
 * each bound to the purpose it serves. This restores that shape rather than
 * inventing a new one.
 *
 * Idempotent: keyed on `scope_key` within the company, and the rule and binding
 * are matched on what they point at rather than on an id.
 */

export const NAME = 'Item scopes';

/** scope_key -> [label, category code, purpose]. */
const SCOPES = [
  ['bom_material', 'What a part is cut from', 'rm', 'bom_material'],
  ['machines', 'Machines', 'mach', 'machines'],
  ['spares', 'Spare parts', 'mro', 'spares'],
];

export async function seed(ctx) {
  const { companyId, apply, conn } = ctx;
  const counts = { scopes: 0, rules: 0, bindings: 0, unchanged: 0 };

  for (const [scopeKey, label, categoryCode, purpose] of SCOPES) {
    const [[cat]] = await conn.query(
      `SELECT id, name FROM fab_item_categories
        WHERE company_id = ? AND code = ? AND deleted_at IS NULL LIMIT 1`,
      [companyId, categoryCode],
    );
    if (!cat) {
      ctx.log(`! no category '${categoryCode}' — ${scopeKey} skipped (module 02 creates it)`);
      continue;
    }

    const [[existing]] = await conn.query(
      `SELECT id FROM fab_item_scopes
        WHERE company_id = ? AND scope_key = ? AND deleted_at IS NULL LIMIT 1`,
      [companyId, scopeKey],
    );

    let scopeId = existing?.id;
    if (!scopeId) {
      counts.scopes++;
      if (apply) {
        const [r] = await conn.query(
          `INSERT INTO fab_item_scopes (company_id, scope_key, label, notes, active)
           VALUES (?,?,?,?,1)`,
          [companyId, scopeKey, label, `Include everything in ${cat.name}.`],
        );
        scopeId = r.insertId;
      }
      ctx.log(`+ scope ${scopeKey} -> ${cat.name}`);
    } else {
      counts.unchanged++;
    }
    if (!scopeId) continue; // dry run, nothing downstream to key on

    // ── the include rule ────────────────────────────────────────────────────
    const [[rule]] = await conn.query(
      `SELECT id FROM fab_item_scope_rules
        WHERE company_id = ? AND scope_id = ? AND rule_type = 'include'
          AND category_id = ? AND deleted_at IS NULL LIMIT 1`,
      [companyId, scopeId, cat.id],
    );
    if (!rule) {
      counts.rules++;
      if (apply) {
        await conn.query(
          `INSERT INTO fab_item_scope_rules
             (company_id, scope_id, rule_type, category_id, notes)
           VALUES (?,?,'include',?,?)`,
          [companyId, scopeId, cat.id, cat.name],
        );
      }
    }

    // ── the binding that puts the scope to work ─────────────────────────────
    const [[binding]] = await conn.query(
      `SELECT id FROM fab_item_scope_bindings
        WHERE company_id = ? AND scope_id = ? AND purpose = ?
          AND line_type IS NULL AND level_kind IS NULL AND deleted_at IS NULL LIMIT 1`,
      [companyId, scopeId, purpose],
    );
    if (!binding) {
      counts.bindings++;
      if (apply) {
        await conn.query(
          `INSERT INTO fab_item_scope_bindings
             (company_id, scope_id, purpose, line_type, level_kind, active)
           VALUES (?,?,?,NULL,NULL,1)`,
          [companyId, scopeId, purpose],
        );
      }
    }
  }

  return counts;
}
