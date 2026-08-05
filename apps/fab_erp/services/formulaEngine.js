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
  // Step 1: rewrite IF(...) → ternary, innermost first.
  //
  // This used to be one regex with `[^,]+?` arguments, which could not span a
  // nested IF — its own comment admitted it handled "nested commas naively".
  // A formula like  IF(a > 0, x / IF(b > 0, b, 1), y)  came out mangled and
  // evaluated to garbage or null with no error, which is the worst way for a
  // duration to be wrong. Nested IF is not exotic: guarding a divisor against
  // zero (`/ IF(machine.speed > 0, machine.speed, 500)`) needs it, and that is
  // exactly what a formula referencing machine speed should do.
  //
  // Scanned rather than regexed: find each IF, match its parentheses by depth,
  // split on TOP-LEVEL commas only, and recurse into each argument.
  let result = rewriteIf(formula);
  // Step 2: rewrite namespace.key → namespace_key
  result = result.replace(/\b(machine|item|step|op)\.(\w+)\b/g, '$1_$2');
  return result;
}

/** Rewrite every IF(cond, then, else) in `src` to (cond ? then : else). */
function rewriteIf(src) {
  const m = /\bIF\s*\(/i.exec(src);
  if (!m) return src;

  const open = m.index + m[0].length - 1; // index of the '('
  let depth = 0;
  let close = -1;
  const commas = [];
  for (let i = open; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) { close = i; break; }
    } else if (ch === ',' && depth === 1) commas.push(i);
  }

  // Unbalanced parens or not exactly three arguments: leave it alone and let
  // expr-eval produce a real parse error rather than silently inventing one.
  if (close === -1 || commas.length !== 2) return src;

  const cond = src.slice(open + 1, commas[0]);
  const tVal = src.slice(commas[0] + 1, commas[1]);
  const fVal = src.slice(commas[1] + 1, close);

  const rewritten =
    `(${rewriteIf(cond).trim()} ? ${rewriteIf(tVal).trim()} : ${rewriteIf(fVal).trim()})`;

  // Recurse across the remainder so several IFs in one formula all convert.
  return src.slice(0, m.index) + rewritten + rewriteIf(src.slice(close + 1));
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
    // Any namespaced variable the formula mentions but the item/step/machine/op
    // has no value for reads as 0. Without this mathjs throws on the undefined
    // symbol and the whole formula returns null — so a single unmeasured metric
    // wiped the estimate instead of letting an IF(...) fall back to its default.
    for (const [, sym] of normalised.matchAll(/\b((?:machine|item|step|op)_\w+)\b/g)) {
      if (!(sym in scope)) scope[sym] = 0;
    }
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
