/**
 * formula.js — the variable catalogue and validator behind the time-formula editor.
 *
 * GET  /formula/variables  — every machine.* and item.* variable a formula may use
 * POST /formula/validate   — parse a formula and resolve every variable it names
 *
 * Both endpoints were called by the frontend long before they existed.
 * `hooks/useFormulaVariables.ts` has always fetched /formula/variables, caught the
 * 404 and fallen back to an empty list — so FormulaCodeEditor's autocomplete
 * offered nothing and its linter red-underlined every machine.* and item.*
 * variable as unknown. `components/FormulaEditor.tsx` documents /formula/validate
 * in its header. Neither route was ever written.
 *
 * Why validation matters more than autocomplete: an unresolved variable does not
 * fail loudly. formulaEngine defaults any unknown namespaced symbol to 0, so
 * `item.length_mm / machine.speed` with no speed defined evaluates to Infinity,
 * fails the isFinite check, and returns null. computed_hours lands NULL, the
 * critical chain reads that task as 0 minutes, the project buffer shrinks, and a
 * customer is promised a date the shop cannot meet — with no error anywhere.
 * Rejecting the formula at save time is the only place that chain can be broken.
 */

import { Router } from 'express';
import { pool } from '../../../db.js';
import { protect } from '../../../core/middleware/authmiddleware.js';
import { parseFormula, evaluateFormula, formulaResultToHours } from '../services/formulaEngine.js';
import { resolveItemFields, inputContextForItem } from '../services/itemFieldService.js';

const router = Router();

const requirePerm = (tag) => (req, res, next) => {
  const isAdmin = String(req.user?.role ?? '').toLowerCase() === 'admin';
  if (isAdmin) return next();
  if (!Array.isArray(req.user?.uiPermissions) || !req.user.uiPermissions.includes(tag)) {
    return res.status(403).json({ message: `Permission required: ${tag}` });
  }
  next();
};

const companyOf = (req) => req.user.companyId ?? req.user.company_id;

/**
 * Every variable a formula may reference, grouped by namespace.
 *
 * Shape matches the frontend's FormulaVariables contract exactly:
 *   { machine: [{ key, label, unit }], item: [{ key, label, unit }] }
 * with `key` in dot notation. `step.*` and `op.*` are deliberately absent — the
 * editor takes those as separate props, because they are scoped to the flow step
 * or operation being edited rather than to the company.
 *
 * machine.* is DISTINCT across resource types: two types may both declare
 * `speed`, and the editor only needs to know the name is legal.
 */
router.get('/formula/variables', protect, requirePerm('fab_erp_operations_view'), async (req, res) => {
  try {
    const companyId = companyOf(req);

    // fab_resource_type_properties has no company_id column; scope through the
    // resource type instead, or one company's editor would list another's.
    //
    // The unit is only reported when every resource type declaring this property
    // agrees on it. `speed` legitimately means mm2/min on a plasma table and
    // kg/min on a crane, and picking one arbitrarily (MIN(unit) says "checks/min"
    // because QC sorts first) would put a wrong unit next to the name in
    // autocomplete. Ambiguous unit -> no unit.
    const [machineRows] = await pool.query(
      `SELECT p.property_key,
              MIN(p.property_label) AS property_label,
              CASE WHEN COUNT(DISTINCT p.unit) = 1 THEN MIN(p.unit) ELSE NULL END AS unit,
              COUNT(DISTINCT p.unit) AS unit_variants
         FROM fab_resource_type_properties p
         JOIN fab_resource_types rt ON rt.id = p.resource_type_id AND rt.deleted_at IS NULL
        WHERE rt.company_id = ? AND p.deleted_at IS NULL
        GROUP BY p.property_key
        ORDER BY p.property_key`,
      [companyId],
    );

    // The field registry, not the old metric defs — and only the fields that can
    // legitimately appear in a formula. A text field offered here would be
    // accepted by the editor and then coerce to NaN at evaluation, nulling the
    // whole duration and planning the task as instant.
    //
    // Definitions now come from fab_fields; fab_field_defs is the retired one.
    // Only the definition moved — values still resolve through their own path —
    // which is why this endpoint could cross over on its own. `unit` is
    // `default_unit` there, aliased back so the JSON the editor already parses
    // does not change shape underneath it.
    const [itemRows] = await pool.query(
      `SELECT field_key AS metric_key, label AS metric_label, default_unit AS unit
         FROM fab_fields
        WHERE company_id = ? AND deleted_at IS NULL AND active = 1
          AND formula_usable = 1
        ORDER BY sort_order, field_key`,
      [companyId],
    );

    res.json({
      machine: machineRows.map((r) => ({
        key: `machine.${r.property_key}`,
        label: Number(r.unit_variants) > 1
          ? `${r.property_label || r.property_key} (varies by machine type)`
          : (r.property_label || r.property_key),
        unit: r.unit ?? null,
      })),
      item: itemRows.map((r) => ({
        key: `item.${r.metric_key}`,
        label: r.metric_label || r.metric_key,
        unit: r.unit ?? null,
      })),
    });
  } catch (err) {
    res.status(500).json({ message: err.message ?? 'Failed to load formula variables' });
  }
});

/**
 * Validate a formula: does it parse, and does every variable it names resolve?
 *
 * Body: { formula, operationId?, resourceTypeId?, sampleItemId? }
 *
 * `operationId` scopes op.* to that operation's own variables; without it, any
 * op.* is reported unresolved. `sampleItemId` additionally evaluates the formula
 * against a real item so the caller can show what it would produce — the check
 * that would have caught a cut taking 8.33 h for every plate regardless of size.
 *
 * Returns 200 with { valid: false, ... } for a bad formula rather than 4xx: this
 * is a checker, and the caller renders the reasons.
 */
router.post('/formula/validate', protect, requirePerm('fab_erp_operations_view'), async (req, res) => {
  try {
    const companyId = companyOf(req);
    const { formula, operationId, resourceTypeId, sampleItemId } = req.body ?? {};

    if (typeof formula !== 'string' || !formula.trim()) {
      return res.status(400).json({ message: '"formula" (string) is required.' });
    }

    const parsed = parseFormula(formula);
    if (!parsed.valid) {
      return res.json({ valid: false, error: parsed.error, variables: [], unresolved: [] });
    }

    // Which names are legal, per namespace.
    const [machineRows] = await pool.query(
      `SELECT DISTINCT p.property_key
         FROM fab_resource_type_properties p
         JOIN fab_resource_types rt ON rt.id = p.resource_type_id AND rt.deleted_at IS NULL
        WHERE rt.company_id = ? AND p.deleted_at IS NULL
          ${resourceTypeId ? 'AND p.resource_type_id = ?' : ''}`,
      resourceTypeId ? [companyId, resourceTypeId] : [companyId],
    );
    // Same registry as /formula/variables, and it has to stay the same one: a
    // key offered by autocomplete that the validator then called unknown would
    // make the editor argue with itself. `formula_usable = 1` is the whole
    // point of the filter here — a registered but non-usable key must come back
    // as unresolved rather than silently evaluating to 0.
    //
    // Definitions moved to fab_fields (fab_field_defs is retired); no unit is
    // read on this path, so only the table name changes.
    const [itemRows] = await pool.query(
      `SELECT field_key AS metric_key FROM fab_fields
        WHERE company_id = ? AND deleted_at IS NULL AND active = 1 AND formula_usable = 1`,
      [companyId],
    );
    const [opRows] = operationId
      ? await pool.query(
          `SELECT var_key FROM fab_operation_variables
            WHERE company_id = ? AND operation_id = ? AND deleted_at IS NULL`,
          [companyId, operationId],
        )
      : [[]];

    const known = {
      machine: new Set(machineRows.map((r) => r.property_key)),
      item: new Set(itemRows.map((r) => r.metric_key)),
      op: new Set(opRows.map((r) => r.var_key)),
      step: null,   // step params are per flow step; not checkable from here
    };

    const unresolved = [];
    for (const v of parsed.variables) {
      const [ns, key] = v.split('.');
      if (!ns || !key) continue;                 // bare identifier, not namespaced
      if (ns === 'step') continue;               // out of scope, see above
      /**
       * `input.<role>.<field>` and the `inputs.*` aggregates are out of scope for
       * the same reason as `step.*`, and a stricter one: which roles a task has
       * depends on the BOM under the item it runs on, which this endpoint is not
       * given. Validating them here would red-underline a correct formula on
       * every item that happens not to carry that role — a first step consumes
       * material, a later one consumes a part, and both are right.
       *
       * `parseFormula` returns these already rewritten to underscore form (the
       * dot-notation round-trip only covers the four two-part namespaces), so
       * they arrive as bare identifiers and are skipped by the `!key` guard
       * above. Named explicitly so the next person does not "fix" that.
       */
      if (ns === 'input' || ns === 'inputs') continue;
      if (!known[ns] || !known[ns].has(key)) unresolved.push(v);
    }

    // Optional: what would this actually produce for a real item?
    let sample = null;
    if (sampleItemId) {
      // The field registry resolver, not the retired fab_item_metric_values table.
      // Phase 1 migrated those rows out; reading the old table here made the
      // preview evaluate every item.* as 0 — so a formula that will size the job
      // correctly in production previewed as a flat constant, which is exactly
      // the failure this preview exists to catch.
      const itemValues = (await resolveItemFields(companyId, [Number(sampleItemId)])).get(Number(sampleItemId)) ?? {};
      const opValues = Object.fromEntries(
        (operationId
          ? (await pool.query(
              `SELECT var_key, default_value FROM fab_operation_variables
                WHERE company_id = ? AND operation_id = ? AND deleted_at IS NULL`,
              [companyId, operationId],
            ))[0]
          : []
        ).map((v) => [v.var_key, v.default_value]),
      );
      // Inputs come from the item's own BOM children, same as materialization.
      const inputCtx = await inputContextForItem(companyId, Number(sampleItemId));
      const raw = await evaluateFormula(formula, itemValues, {}, resourceTypeId ?? null, opValues, inputCtx);
      let timeUnit = 'min';
      if (operationId) {
        const [[op]] = await pool.query(
          `SELECT time_unit FROM fab_operations WHERE id = ? AND company_id = ?`,
          [operationId, companyId],
        );
        if (op?.time_unit) timeUnit = op.time_unit;
      }
      sample = { itemId: Number(sampleItemId), raw, timeUnit, hours: formulaResultToHours(raw, timeUnit) };
    }

    res.json({
      valid: unresolved.length === 0,
      variables: parsed.variables,
      unresolved,
      ...(unresolved.length > 0 && {
        error: `Unresolved variable${unresolved.length > 1 ? 's' : ''}: ${unresolved.join(', ')}. `
             + 'An unresolved variable reads as 0, which silently produces a null duration.',
      }),
      sample,
    });
  } catch (err) {
    res.status(500).json({ message: err.message ?? 'Failed to validate formula' });
  }
});

export default router;
