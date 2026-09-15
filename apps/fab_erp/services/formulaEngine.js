/**
 * formulaEngine.js — evaluates parametric step formulas.
 *
 * Formula variable namespaces:
 *   machine.<key>  → resolved from fab_resource_type_properties for the given resource type
 *   item.<key>     → passed in as itemValues map
 *   step.<key>     → passed in as stepValues map (standard_values overrides from planned op)
 *   op.<key>       → passed in as opValues map (an operation's own named variables)
 *   input.<role>.<field>          → what this task CONSUMES, by role (see buildInputContext)
 *   inputs.count | sum|avg|max|min(field) → aggregates over the same inputs
 *
 * expr-eval does not support dots in identifiers, so dots are rewritten to underscores:
 *   machine.speed → machine_speed
 *   item.length   → item_length
 *   step.holes    → step_holes
 *   op.cycle_time → op_cycle_time
 *
 * IF(cond, a, b) is pre-processed to (cond ? a : b) before parsing.
 *
 * ─── R2: split into a pure evaluator + a caller-owned DB loader (2026-09-13) ───
 * This module used to run three queries per resource type INSIDE evaluateFormula
 * and swallow every failure to `null`. Split for two independent reasons:
 *
 *   1. `evaluate(formula, scope)` is now pure — no `pool`, no await — so it can
 *      be unit-tested and reused (the parity script imports it directly) without
 *      a database. `machineScopeFor(conn, resourceTypeId, cache)` is the loader;
 *      `evaluateFormula` (below) is a thin wrapper gluing the two together and
 *      keeping its old positional signature so no caller's call-site changes.
 *   2. A bare `catch { return null }` is why an unresolved variable — almost
 *      always a typo — evaluated as 0 with no error anywhere: computed_hours
 *      landed NULL or a plausible-looking wrong number, the critical chain sized
 *      itself off it, and nobody could tell the difference from a genuinely
 *      instant task. `evaluate()`/`evaluateFormula()` now return
 *      `{ value, error, warnings }` and name what went wrong.
 */

import { Parser } from 'expr-eval';
import { pool } from '../../../db.js';

/**
 * Every operator/function expr-eval ships is enabled unless named here as
 * `false` — `assignment` ('='), `fndef` ('name(x)=...'), `in`, and
 * `concatenate` ('||') have no legitimate use in a time formula and are pure
 * attack surface (assignment can mutate the scope object mid-evaluation;
 * fndef defines new callables) for a value that ultimately comes from a
 * user-editable operation record. The trig/log/exponential unary family is
 * disabled too, in favour of the explicit allow-list below — no formula
 * stored locally or in the prod-shaped fixture uses any of them (verified by
 * grepping `fab_operations.time_formula` for every `word(` pattern; see the
 * EU-8 report), so this is a pure narrowing today, not a break.
 */
const DISABLED_OPERATORS = {
  assignment: false,
  fndef: false,
  in: false,
  concatenate: false,
  sin: false, cos: false, tan: false, asin: false, acos: false, atan: false,
  sinh: false, cosh: false, tanh: false, asinh: false, acosh: false, atanh: false,
  cbrt: false, log: false, ln: false, lg: false, log10: false, log2: false,
  expm1: false, log1p: false, trunc: false, exp: false, length: false,
  sign: false, factorial: false,
  conditional: true, // enables the `cond ? a : b` ternary that IF(...) rewrites into
};

const parser = new Parser({ operators: DISABLED_OPERATORS });

/**
 * `min`, `max` and `pow` live in expr-eval's `functions` table, not its
 * `operators` table, so the flags above cannot reach them — expr-eval's own
 * README documents deleting keys off `parser.functions` as the way to
 * customise that set. Everything else that table ships (`random`, `fac`,
 * `hypot`, `pyt`, `atan2`, `if`, `gamma`, `roundTo`, `map`, `fold`, `filter`,
 * `indexOf`, `join`) is removed. `abs`/`ceil`/`floor`/`round`/`sqrt` are
 * unary operators, not functions, and stay enabled via the (unlisted, so
 * default-true) `operators` flags above.
 */
export const ALLOWED_FUNCTIONS = new Set(['min', 'max', 'abs', 'ceil', 'floor', 'round', 'sqrt', 'pow']);
for (const name of Object.keys(parser.functions)) {
  if (!ALLOWED_FUNCTIONS.has(name)) delete parser.functions[name];
}

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
 * Every `input.<role>.<field>` / `inputs.<fn>(<field>)` / `inputs.count`
 * reference in the RAW (pre-normalise) formula text, structured rather than
 * flattened to an underscore identifier.
 *
 * Scanning the dot-notation text directly — rather than trying to recover
 * role vs. field from the mangled `input_raw_material_thickness_mm` form —
 * is what makes this unambiguous: role and field share the same underscore
 * alphabet, so splitting the flattened identifier back apart would need to
 * already know the two roles in use today (`raw_material`, `child_parts`)
 * and would silently mis-split anything else, which is exactly what this
 * exists to validate rather than assume.
 */
function scanInputRefs(formula) {
  const refs = [];
  for (const m of formula.matchAll(/\binput\.(\w+)\.(\w+)\b/g)) {
    refs.push({ ns: 'input', role: m[1], key: m[2] });
  }
  for (const m of formula.matchAll(/\binputs\.(sum|max|min|avg)\s*\(\s*([A-Za-z_]\w*)\s*\)/gi)) {
    refs.push({ ns: 'inputs', fn: m[1].toLowerCase(), key: m[2] });
  }
  if (/\binputs\.count\b/i.test(formula)) refs.push({ ns: 'inputs', fn: 'count', key: null });
  return refs;
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
 * Parsed ASTs, keyed by the RAW formula string.
 *
 * Unlike the machine-property cache below (which must stay caller-owned,
 * because a machine's properties are mutable data a long-running server
 * could go stale on), a parsed expression is immutable once built and the
 * formula TEXT is its own cache key — the only way the answer for a given
 * key could change is if the text changes, which is a different key. Safe
 * to hold at module scope for the life of the process. Capped and FIFO-
 * evicted (Map preserves insertion order, so the first key is the oldest) so
 * a company that generates one formula per part cannot grow this forever.
 */
const PARSED_CACHE_LIMIT = 500;
const parsedCache = new Map();

function parsedExpressionFor(formula) {
  const cached = parsedCache.get(formula);
  if (cached) return cached;
  const normalised = normalise(formula);
  const expr = parser.parse(normalised); // throws on bad syntax; caller catches
  const entry = { expr, normalised };
  if (parsedCache.size >= PARSED_CACHE_LIMIT) {
    parsedCache.delete(parsedCache.keys().next().value);
  }
  parsedCache.set(formula, entry);
  return entry;
}

/** `machine_speed` → `machine.speed`; `input_raw_material_x` → `input.raw_material.x`; etc. */
const KNOWN_INPUT_ROLES = ['raw_material', 'child_parts'];
function toDotted(sym) {
  const m1 = /^(machine|item|step|op)_(.+)$/.exec(sym);
  if (m1) return `${m1[1]}.${m1[2]}`;
  for (const role of KNOWN_INPUT_ROLES) {
    if (sym.startsWith(`input_${role}_`)) return `input.${role}.${sym.slice(`input_${role}_`.length)}`;
  }
  const m2 = /^inputs_(sum|max|min|avg)_(.+)$/.exec(sym);
  if (m2) return `inputs.${m2[1]}(${m2[2]})`;
  if (sym === 'inputs_count') return 'inputs.count';
  return sym;
}

/**
 * Evaluate a normalised-scope formula. PURE — no DB, no await, no `pool`.
 *
 * @param {string|null} formula
 * @param {Record<string, number>} scope  every namespaced value the caller
 *        already resolved (see evaluateFormula for how the DB-backed wrapper
 *        builds this), keyed in expr-eval's underscore form (`item_length`,
 *        `input_raw_material_thickness_mm`, …).
 * @returns {{ value: number|null, error: {code:string,message:string,symbol?:string}|null, warnings: Array<{code:string,symbols:string[]}> }}
 */
export function evaluate(formula, scope = {}) {
  if (!formula || typeof formula !== 'string') {
    return { value: null, error: null, warnings: [] };
  }

  let expr;
  try {
    ({ expr } = parsedExpressionFor(formula));
  } catch (e) {
    return { value: null, error: { code: 'PARSE_ERROR', message: e.message }, warnings: [] };
  }

  const vars = expr.variables();
  const working = { ...scope };
  const warnings = [];

  // step.* keeps resolving to 0, EXPLICITLY (User Clarifications 7). Every
  // caller has passed `{}` for step values since this module was written, so
  // `step.anything` has always been 0 — that stays true, but now says so.
  const stepVars = vars.filter((v) => v.startsWith('step_'));
  if (stepVars.length) {
    for (const v of stepVars) working[v] = 0;
    warnings.push({ code: 'STEP_VARS_ZERO', symbols: stepVars.map(toDotted) });
  }

  // input.*/inputs.* absence is a SHAPE fact, not a typo: an operation's
  // formula may name a role (`input.raw_material.*`) that this particular
  // item's step simply does not consume — a deburr pass on a made assembly
  // has no raw-material child, the same way many items have no child_parts.
  // Whether the ROLE and KEY are even legal names is a parse-time question
  // (routes/formula.js `/formula/validate`, which has the registries this
  // pure function does not); here, a missing one degrades to 0 like step.*,
  // flagged so the gap is visible without breaking a formula's own
  // `IF(input.raw_material.x > N, ..., default)` guard — the exact pattern
  // every stored formula that references input.* uses today.
  const inputVars = vars.filter((v) => (v.startsWith('input_') || v.startsWith('inputs_')) && !(v in working));
  if (inputVars.length) {
    for (const v of inputVars) working[v] = 0;
    warnings.push({ code: 'INPUT_UNAVAILABLE', symbols: inputVars.map(toDotted) });
  }

  /**
   * machine.*, item.*, op.* absence: DEGRADE to 0 with a warning, not
   * UNKNOWN_SYMBOL — proven necessary against the real fixture, not a
   * cautious default. `evaluate()` cannot tell "nobody registered this
   * field" (a typo) apart from "registered, but nothing has measured it on
   * THIS item" (routine and expected) without the field/property/variable
   * registries, which are a database lookup this pure function does not
   * have — exactly why routes/formula.js `/formula/validate` (item 4) does
   * that check at SAVE time instead, against every registry, once, instead
   * of per-item at every plan.
   *
   * Verified empirically (`scripts/verify-formula-parity.mjs`) against order
   * 247: 50 of its 117 tasks reference `item.unit_weight_kg`,
   * `item.surface_area_m2`, or `item.edge_length_m` inside an
   * `IF(item.x > 0, item.x, fallback)` guard on items where that metric is
   * genuinely unmeasured — the same defensive idiom `input.*` relies on, at
   * far larger scale. Treating that as UNKNOWN_SYMBOL would have nulled
   * computed_hours on 43% of the fixture, which is exactly the regression
   * "What must NOT change" forbids. See the EU-8 report for the full list.
   */
  const degradedVars = vars.filter((v) =>
    (v.startsWith('machine_') || v.startsWith('item_') || v.startsWith('op_')) && !(v in working));
  if (degradedVars.length) {
    for (const v of degradedVars) working[v] = 0;
    warnings.push({ code: 'VALUE_UNAVAILABLE', symbols: degradedVars.map(toDotted) });
  }

  // What's left is a symbol matching none of the five known namespaces at
  // all — a disabled function (parser.functions no longer has it; see the
  // allow-list at the top of this file) or a bare, non-namespaced identifier.
  // THIS is what UNKNOWN_SYMBOL is for: something no amount of per-item data
  // could ever resolve, as opposed to a real field this item hasn't got.
  for (const v of vars) {
    if (!(v in working)) {
      const symbol = toDotted(v);
      return { value: null, error: { code: 'UNKNOWN_SYMBOL', message: `Unknown variable: ${symbol}`, symbol }, warnings };
    }
  }

  let result;
  try {
    result = expr.evaluate(working);
  } catch (e) {
    return { value: null, error: { code: 'EVAL_ERROR', message: e.message }, warnings };
  }

  if (typeof result !== 'number' || Number.isNaN(result)) {
    // NaN covers both 0/0 and a genuinely invalid operation; expr-eval gives
    // no way to tell them apart after the fact, so this is deliberately the
    // more generic of the two numeric codes.
    return { value: null, error: { code: 'NON_FINITE', message: 'Formula did not evaluate to a usable number' }, warnings };
  }
  if (result === Infinity || result === -Infinity) {
    return { value: null, error: { code: 'DIVIDE_BY_ZERO', message: 'Formula divided a nonzero value by zero' }, warnings };
  }
  return { value: result, error: null, warnings };
}

/**
 * `machine.*` loader — the caller-owned half of what used to be inline in
 * evaluateFormula. Deliberately NOT a module-level cache: a cache that
 * outlived the call would keep serving a machine property somebody has since
 * edited, forever, in a long-running server (§13 "Resolution and
 * materialization are batched"). `cache` lives exactly as long as whatever
 * loop the caller is running (e.g. one materialization pass).
 *
 * @param {*} conn          pool or transaction connection
 * @param {number|null} resourceTypeId
 * @param {Map<number, Record<string,number>>|null} cache  optional, caller-owned
 * @returns {Promise<Record<string, number>>} scope fragment, already prefixed `machine_*`
 */
export async function machineScopeFor(conn, resourceTypeId, cache = null) {
  if (!resourceTypeId) return {};
  if (cache?.has(resourceTypeId)) return cache.get(resourceTypeId);

  const exec = conn ?? pool;

  /**
   * FIELDS FIRST, the old table as fallback.
   *
   * A resource type and its MACH-* catalogue item are the same concept held
   * twice, and `fab_resource_type_properties` was a parallel attribute
   * mechanism hanging off the type. Under the standing rule the catalogue
   * item is the type and its attributes are field values, so `machine.*`
   * resolves from the field registry via the type's `catalog_item_id`.
   *
   * The old table is still read and still wins nothing: a key present in
   * both takes the FIELD. Keeping the fallback is what makes this change
   * safe to deploy before every tenant has been linked.
   */
  const [rows] = await exec.query(
    `SELECT property_key, default_value
       FROM fab_resource_type_properties
      WHERE resource_type_id = ? AND deleted_at IS NULL`,
    [resourceTypeId],
  );
  const merged = new Map(rows.map((r) => [r.property_key, r.default_value]));

  const [[link]] = await exec.query(
    `SELECT company_id, catalog_item_id FROM fab_resource_types
      WHERE id = ? AND deleted_at IS NULL LIMIT 1`,
    [resourceTypeId],
  );
  if (link?.catalog_item_id) {
    const [vals] = await exec.query(
      `SELECT f.field_key, v.value_num
         FROM fab_field_values v
         JOIN fab_fields f ON f.id = v.field_id AND f.deleted_at IS NULL
        WHERE v.company_id = ? AND v.scope = 'catalog_item' AND v.scope_id = ?
          AND v.deleted_at IS NULL AND v.value_num IS NOT NULL`,
      [link.company_id, link.catalog_item_id],
    );
    for (const v of vals) merged.set(v.field_key, v.value_num);
  }

  const scope = {};
  for (const [k, v] of merged) scope[`machine_${k}`] = Number(v ?? 0);
  cache?.set(resourceTypeId, scope);
  return scope;
}

/**
 * Evaluate a step formula and return `{ value, error, warnings }`.
 *
 * Thin wrapper: builds the scope (DB-backed for `machine.*` via
 * `machineScopeFor`, everything else from what the caller already resolved)
 * and delegates to the pure `evaluate()`. Kept under the same exported name
 * and the same positional parameters formulaEngine has always taken, so nothing
 * outside this module's own callers (routes/formula.js, taskGatingService.js —
 * both updated in this change) needs to change how it CALLS this function.
 *
 * What DID change (R2): the return value. It used to be `Promise<number|null>`,
 * silently. It is now `{ value, error, warnings }` — see `evaluate()` above for
 * the error codes.
 *
 * @param {string|null} formula
 * @param {Record<string,number>} itemValues
 * @param {Record<string,number>} stepValues   kept for signature compatibility;
 *        `evaluate()` always zeroes any step_* symbol regardless (decision 7).
 * @param {number|null} resourceTypeId
 * @param {Record<string,number>} opValues
 * @param {{byRole?:Record<string,Record<string,number>>, all?:Array<Record<string,number>>}} [inputCtx]
 * @param {Map<number, Record<string,number>>|null} [machinePropsCache]
 *        Optional caller-owned cache — see machineScopeFor.
 */
export async function evaluateFormula(
  formula,
  itemValues  = {},
  stepValues  = {},
  resourceTypeId = null,
  opValues = {},
  inputCtx = null,
  machinePropsCache = null,
) {
  if (!formula || typeof formula !== 'string') return { value: null, error: null, warnings: [] };

  const scope = {};
  for (const [k, v] of Object.entries(itemValues)) scope[`item_${k}`] = Number(v ?? 0);
  // Real values are still placed in scope (a caller that fixed a step's
  // params should not have that silently thrown away); `evaluate()` is what
  // enforces that step.* resolves to 0 regardless.
  for (const [k, v] of Object.entries(stepValues)) scope[`step_${k}`] = Number(v ?? 0);
  Object.assign(scope, await machineScopeFor(pool, resourceTypeId, machinePropsCache));
  for (const [k, v] of Object.entries(opValues)) scope[`op_${k}`] = Number(v ?? 0);

  // input.<role>.<field> — what this task consumes, addressed by role.
  for (const [role, fields] of Object.entries(inputCtx?.byRole ?? {})) {
    for (const [k, v] of Object.entries(fields ?? {})) {
      const n = Number(v);
      if (Number.isFinite(n)) scope[`input_${role}_${k}`] = n;
    }
  }

  // The aggregates the formula actually asks for, computed once each — driven
  // off the normalised text rather than every possible (function × field)
  // pair, which is unbounded.
  const { normalised } = (() => {
    try { return parsedExpressionFor(formula); } catch { return { normalised: normalise(formula) }; }
  })();
  const allInputs = inputCtx?.all ?? [];
  for (const [, fn, field] of normalised.matchAll(/\binputs_(sum|max|min|avg)_(\w+)\b/g)) {
    scope[`inputs_${fn}_${field}`] = aggregate(fn, field, allInputs);
  }
  if (/\binputs_count\b/.test(normalised)) scope.inputs_count = allInputs.length;

  return evaluate(formula, scope);
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

/**
 * Parse a formula and return the list of variable names it uses.
 * Returns the dot-notation form (e.g. "machine.speed", "item.length") for the
 * four two-part namespaces; `input.*`/`inputs.*` stay in underscore form in
 * `variables` (unchanged — existing callers key off this shape) but are ALSO
 * returned structured in `inputRefs`, since "input" vs "raw_material" vs
 * "thickness_mm" cannot be told apart again once flattened to
 * `input_raw_material_thickness_mm`.
 *
 * @param {string} formula
 * @returns {{ valid: boolean, variables?: string[], inputRefs?: Array<{ns:string,role?:string,fn?:string,key:string|null}>, error?: string }}
 */
export function parseFormula(formula) {
  if (!formula || typeof formula !== 'string') {
    return { valid: false, error: 'Formula is empty' };
  }
  try {
    const { expr } = parsedExpressionFor(formula);
    const rawVars = expr.variables();
    // Convert back to dot-notation for display
    const variables = rawVars.map((v) =>
      v.replace(/^(machine|item|step|op)_(\w+)$/, '$1.$2'),
    );
    return { valid: true, variables, inputRefs: scanInputRefs(formula) };
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
