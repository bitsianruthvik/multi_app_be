/**
 * formulaEngine.js — evaluates parametric step formulas.
 *
 * Formula variable namespaces:
 *   machine.<key>  → resolved from fab_resource_type_properties for the given resource type
 *   item.<key>     → passed in as itemValues map
 *   step.<key>     → passed in as stepValues map (standard_values overrides from planned op)
 *   op.<key>       → passed in as opValues map (an operation's own named variables)
 *
 * expr-eval does not support dots in identifiers, so dots are rewritten to underscores:
 *   machine.speed → machine_speed
 *   item.length   → item_length
 *   step.holes    → step_holes
 *   op.cycle_time → op_cycle_time
 *
 * IF(cond, a, b) is pre-processed to (cond ? a : b) before parsing.
 */

import { Parser } from 'expr-eval';
import { pool } from '../../../db.js';

const parser = new Parser({
  operators: {
    conditional: true,  // enables ternary ? : operator
  },
});

/**
 * Pre-process a formula string:
 *  1. Rewrite IF(cond, a, b) → (cond ? a : b)  (handles nested commas naively)
 *  2. Rewrite dot-notation vars → underscore form for expr-eval
 *
 * @param {string} formula
 * @returns {string} normalised expression
 */
function normalise(formula) {
  // Step 1: rewrite IF(...) — simple non-nested version
  let result = formula.replace(
    /\bIF\s*\(\s*([^,]+?)\s*,\s*([^,]+?)\s*,\s*([^)]+?)\s*\)/gi,
    (_, cond, tVal, fVal) => `(${cond.trim()} ? ${tVal.trim()} : ${fVal.trim()})`,
  );
  // Step 2: rewrite namespace.key → namespace_key
  result = result.replace(/\b(machine|item|step|op)\.(\w+)\b/g, '$1_$2');
  return result;
}

/**
 * Evaluate a step formula and return the computed numeric result (typically hours).
 *
 * @param {string|null} formula         - raw dot-notation formula string
 * @param {Record<string,number>} itemValues   - item metric values keyed by metric_key
 * @param {Record<string,number>} stepValues   - step parameter values (standard_values overrides)
 * @param {number|null} resourceTypeId  - resource type whose properties supply machine.* vars
 * @param {Record<string,number>} opValues     - operation's own variable values keyed by var_key
 * @returns {Promise<number|null>}      - evaluated result or null on error/missing formula
 */
export async function evaluateFormula(
  formula,
  itemValues  = {},
  stepValues  = {},
  resourceTypeId = null,
  opValues = {},
) {
  if (!formula || typeof formula !== 'string') return null;

  try {
    // Load machine.* properties for the given resource type
    let machineProps = [];
    if (resourceTypeId) {
      const [rows] = await pool.query(
        `SELECT property_key, default_value
           FROM fab_resource_type_properties
          WHERE resource_type_id = ? AND deleted_at IS NULL`,
        [resourceTypeId],
      );
      machineProps = rows;
    }

    // Build evaluation scope with underscore-prefixed keys
    const scope = {};
    for (const [k, v] of Object.entries(itemValues)) {
      scope[`item_${k}`] = Number(v ?? 0);
    }
    for (const [k, v] of Object.entries(stepValues)) {
      scope[`step_${k}`] = Number(v ?? 0);
    }
    for (const prop of machineProps) {
      scope[`machine_${prop.property_key}`] = Number(prop.default_value ?? 0);
    }
    for (const [k, v] of Object.entries(opValues)) {
      scope[`op_${k}`] = Number(v ?? 0);
    }

    const normalised = normalise(formula);
    const result = parser.evaluate(normalised, scope);
    return typeof result === 'number' && isFinite(result) ? result : null;
  } catch {
    return null;
  }
}

/**
 * Given an array of allowed resource type IDs, return the first one that
 * exists and is not soft-deleted. Used when no specific resource is assigned.
 *
 * @param {number[]} allowedIds
 * @returns {Promise<number|null>}
 */
export async function resolveFirstResourceType(allowedIds = []) {
  if (!Array.isArray(allowedIds) || allowedIds.length === 0) return null;
  const [rows] = await pool.query(
    `SELECT id FROM fab_resource_types
      WHERE id IN (?) AND deleted_at IS NULL
      ORDER BY FIELD(id, ?) LIMIT 1`,
    [allowedIds, allowedIds],
  );
  return rows[0]?.id ?? null;
}

/**
 * Parse a formula and return the list of variable names it uses.
 * Returns the dot-notation form (e.g. "machine.speed", "item.length").
 *
 * @param {string} formula
 * @returns {{ valid: boolean, variables?: string[], error?: string }}
 */
export function parseFormula(formula) {
  if (!formula || typeof formula !== 'string') {
    return { valid: false, error: 'Formula is empty' };
  }
  try {
    const normalised = normalise(formula);
    const expr = parser.parse(normalised);
    const rawVars = expr.variables();
    // Convert back to dot-notation for display
    const variables = rawVars.map((v) =>
      v.replace(/^(machine|item|step|op)_(\w+)$/, '$1.$2'),
    );
    return { valid: true, variables };
  } catch (e) {
    return { valid: false, error: e.message };
  }
}

/**
 * Convert a time-formula result into HOURS using the operation's `time_unit`.
 *
 * `fab_operations.time_formula` returns a number in whatever unit the operation
 * declares — `min` for almost every real operation, since that is how a
 * fabricator writes a standard time ("cut_length / 2" minutes). But
 * `fab_project_tasks.computed_hours` is, by its name and by every consumer,
 * HOURS.
 *
 * Nothing converted between the two until 2026-08-04, so a 500-minute plate cut
 * was stored as 500 HOURS — a 60x overstatement on every task in the system.
 * The learned-duration branch beside it always divided p80_minutes by 60, so
 * the intent was never in doubt; the formula branch simply never did the same.
 * Everything downstream inherited it: capacity, the critical-chain baseline,
 * ETAs, the variance readout, and the "running Nx typical" nudge.
 */
export function formulaResultToHours(value, timeUnit) {
  if (value == null || !Number.isFinite(Number(value))) return null;
  const v = Number(value);
  switch (String(timeUnit || 'min').toLowerCase()) {
    case 'hr':
    case 'hour':
    case 'hours': return v;
    case 'sec':
    case 'second':
    case 'seconds': return v / 3600;
    case 'min':
    case 'minute':
    case 'minutes':
    default: return v / 60;
  }
}
