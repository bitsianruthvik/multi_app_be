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

  /**
   * Step 2a: the INPUT namespaces, before the generic rule below.
   *
   *   inputs.sum(weight_kg)  → inputs_sum_weight_kg
   *   inputs.count           → inputs_count
   *   input.raw_material.thickness_mm → input_raw_material_thickness_mm
   *
   * BY ROLE, NEVER BY POSITION. `input[0]` would mean a formula's meaning
   * changes when somebody reorders a BOM — silently, and nobody would ever
   * connect the two. A role is a statement about what the input IS.
   *
   * Aggregates are rewritten to plain identifiers rather than left as function
   * calls: the value is computed once when the scope is built, so the parser
   * never has to know these functions exist and an aggregate over a field
   * nothing carries degrades to 0 like every other unknown symbol.
   */
  result = result.replace(/\binputs\.(sum|max|min|avg)\s*\(\s*([A-Za-z_]\w*)\s*\)/gi,
    (_m, fn, field) => `inputs_${String(fn).toLowerCase()}_${field}`);
  result = result.replace(/\binputs\.count\b/gi, 'inputs_count');
  result = result.replace(/\binput\.(\w+)\.(\w+)\b/g, 'input_$1_$2');

  // Step 2b: rewrite namespace.key → namespace_key
  result = result.replace(/\b(machine|item|step|op)\.(\w+)\b/g, '$1_$2');
  return result;
}

/**
 * Aggregate helpers over the inputs' resolved field values.
 *
 * Absent values are SKIPPED, not counted as zero: an average over three parts
 * where one has no weight is the average of the two that do, and treating the
 * third as 0 kg would quietly halve it. `count` is the number of inputs, not
 * the number that happen to carry the field.
 */
function aggregate(fn, field, inputs) {
  const vals = (inputs || [])
    .map((i) => Number(i?.[field]))
    .filter((n) => Number.isFinite(n));
  if (fn === 'count') return (inputs || []).length;
  if (!vals.length) return 0;
  switch (fn) {
    case 'sum': return vals.reduce((a, b) => a + b, 0);
    case 'max': return Math.max(...vals);
    case 'min': return Math.min(...vals);
    case 'avg': return vals.reduce((a, b) => a + b, 0) / vals.length;
    default: return 0;
  }
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
 * @param {{byRole?:Record<string,Record<string,number>>, all?:Array<Record<string,number>>}} [inputCtx]
 *        what this task CONSUMES — see resolveTaskInputs. `byRole` supplies
 *        `input.<role>.<field>`, `all` backs the `inputs.*` aggregates. A sixth
 *        positional argument rather than an options object because four call
 *        sites already pass five, and churning them all to add one was the
 *        larger change.
 * @returns {Promise<number|null>}      - evaluated result or null on error/missing formula
 */
export async function evaluateFormula(
  formula,
  itemValues  = {},
  stepValues  = {},
  resourceTypeId = null,
  opValues = {},
  inputCtx = null,
  /**
   * Optional Map<resourceTypeId, rows> the CALLER owns, for when this is being
   * evaluated in a loop.
   *
   * One evaluation costs one query for the machine properties, which is
   * nothing on its own and is why it was written this way. Materializing an
   * order calls this once per task, and on a real bridge order that is twelve
   * thousand queries for the fourteen distinct answers the shop has — enough
   * that raising a production order outlived its own database connection.
   *
   * Deliberately caller-owned and NOT a module-level cache: a cache that
   * outlives the call would keep serving a machine property somebody has since
   * edited, forever, in a long-running server. This one lives exactly as long
   * as the loop that made it. Omit it and the behaviour is unchanged.
   */
  machinePropsCache = null,
) {
  if (!formula || typeof formula !== 'string') return null;

  try {
    // Load machine.* properties for the given resource type
    let machineProps = [];
    if (resourceTypeId) {
      if (machinePropsCache?.has(resourceTypeId)) {
        machineProps = machinePropsCache.get(resourceTypeId);
      } else {
        const [rows] = await pool.query(
          `SELECT property_key, default_value
             FROM fab_resource_type_properties
            WHERE resource_type_id = ? AND deleted_at IS NULL`,
          [resourceTypeId],
        );
        machineProps = rows;
        machinePropsCache?.set(resourceTypeId, rows);
      }
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
    // input.<role>.<field> — what this task consumes, addressed by role.
    for (const [role, fields] of Object.entries(inputCtx?.byRole ?? {})) {
      for (const [k, v] of Object.entries(fields ?? {})) {
        const n = Number(v);
        if (Number.isFinite(n)) scope[`input_${role}_${k}`] = n;
      }
    }

    const normalised = normalise(formula);

    /**
     * The aggregates the formula actually asks for, computed once each.
     *
     * Driven off the normalised text rather than pre-computing every possible
     * (function × field) pair, which is unbounded — a formula can name any
     * field, and most name none.
     */
    const allInputs = inputCtx?.all ?? [];
    for (const [, fn, field] of normalised.matchAll(/\binputs_(sum|max|min|avg)_(\w+)\b/g)) {
      scope[`inputs_${fn}_${field}`] = aggregate(fn, field, allInputs);
    }
    if (/\binputs_count\b/.test(normalised)) scope.inputs_count = allInputs.length;

    // Any namespaced variable the formula mentions but the item/step/machine/op
    // has no value for reads as 0. Without this mathjs throws on the undefined
    // symbol and the whole formula returns null — so a single unmeasured metric
    // wiped the estimate instead of letting an IF(...) fall back to its default.
    // `input_` is included so a role that is absent on this task (a first step
    // consumes material, a later one consumes a part) degrades the same way.
    for (const [, sym] of normalised.matchAll(/\b((?:machine|item|step|op|input|inputs)_\w+)\b/g)) {
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
/**
 * A flow step's own parameters, as the `step.*` scope.
 *
 * Lives here because this module owns what the namespaces mean, and because two
 * callers need it — materialization and the re-materialize diff. If those two
 * ever disagreed about how a step's params are read, every re-materialize would
 * report a spurious duration change on every step that had any.
 *
 * Tolerates both shapes the driver can hand back for a JSON column: a parsed
 * object, or the raw string. Non-numeric values are dropped rather than passed
 * through — the engine coerces with Number(), so a stray string would become
 * NaN and null the whole formula, planning the task as instant.
 */
export function parseStepParams(step) {
  const raw = step?.params_json ?? step?.paramsJson ?? null;
  if (!raw) return {};
  let obj = raw;
  if (typeof raw === 'string') {
    try { obj = JSON.parse(raw); } catch { return {}; }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    const n = Number(v);
    if (Number.isFinite(n)) out[k] = n;
  }
  return out;
}

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
