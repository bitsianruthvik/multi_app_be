/**
 * lib/orderDefaults.js — ORDER and LINE values (init.sql §65), the pure part both resolvers share
 * (resolutionService.resolve and orderValuesService.resolveRecord — they must not drift; the
 * order_values_test compares them record by record).
 *
 * User, 2026-10-16: "The various coats, MS BO or BR, all of these are also set at an order or a line
 * level typically and can be overridden in the values screen if required."
 *
 * A specification flagged `order_level` in Setup ("Can be set for a whole order") may carry a value on
 * the ORDER and on each LINE (cf_order_spec_defaults; order_line_id NULL = the whole order). Every row
 * of the order that has that specification takes it — most specific wins:
 *
 *   the row's own entry  >  the line's value  >  the order's value  >  the spec's own rule
 *                                                                     (a Defaulted formula, a default from above)
 *
 * Only where a person could type the value on the row: an item-level rule that applies, `entered` or
 * `defaulted` (with or without a formula), never a table. `fixed`, `calculated`, `rollup` and
 * `inherited` keep their own rule. An option value the row's rule does not allow (a narrowed list) does
 * not reach that row — it keeps its own rule, and the cell says why.
 *
 * What stands over an order value on the row: an `entered` row (typed by a person), or a section part's
 * steel taken from its stock bar (lib/cutFrom STEEL_FROM_STOCK, stored `inherited` under an entered rule).
 * A row value with source `defaulted` under an entered rule is what an earlier order value left there —
 * it never stands over the current one.
 *
 * The value reached is STORED on the row like any default (source `defaulted`), so every reader of
 * cf_spec_values — nesting, cut pieces, codes, buying — sees it; a locked line is never re-worked, so a
 * later change of the order's value cannot reach it.
 */
import { STEEL_FROM_STOCK_SET } from './cutFrom.js';

/** The value rules a person types on a row — the only ones an order or line value reaches. */
export const ORDER_DEFAULT_RULES = new Set(['entered', 'defaulted']);

/** What a record outside any order line reads: nothing. */
export const NO_ORDER_DEFAULTS = Object.freeze({ line: new Map(), order: new Map() });

/** The words for where a value came from. */
export const LEVEL_WORD = { order: 'order', line: 'line' };

/**
 * Rows of cf_order_spec_defaults for ONE line's view: { line: Map(specId -> row), order: Map(specId -> row) }.
 * `rows` may hold other lines' rows (an order read once for several lines) — they are left out.
 */
export function defaultsForLine(rows, lineId) {
  const out = { line: new Map(), order: new Map() };
  for (const r of rows ?? []) {
    if (r.order_line_id == null) out.order.set(Number(r.specification_id), r);
    else if (Number(r.order_line_id) === Number(lineId)) out.line.set(Number(r.specification_id), r);
  }
  return out;
}

/** A row value that stands over an order or line value. */
export function ownStands(own, specCode) {
  if (!own) return false;
  if (own.source === 'entered') return true;
  return own.source === 'inherited' && STEEL_FROM_STOCK_SET.has(String(specCode ?? '').toUpperCase());
}

/**
 * The order or line value that reaches one specification of one row, by its winning rule:
 *   { row, level: 'line' | 'order', allowed } — `allowed` false when an option is not in the row's list
 *   null — no value at either level, or the rule is not one a person types
 * `defaults` holds flagged specifications only (loadOrderDefaultRows filters on the flag), so the rule
 * itself need not carry it — and a database without §65 yet resolves exactly as before.
 */
export function orderDefaultOf(defaults, rule, allowed) {
  if (!defaults || !rule) return null;
  if (!rule.is_applicable || rule.capture_at !== 'item' || !ORDER_DEFAULT_RULES.has(rule.value_rule) || rule.data_type === 'table') return null;
  const specId = Number(rule.specification_id);
  const lineRow = defaults.line.get(specId) ?? null;
  const row = lineRow ?? defaults.order.get(specId) ?? null;
  if (!row) return null;
  const ok = rule.data_type !== 'option' || !allowed || row.option_id == null || allowed.some((o) => Number(o.id) === Number(row.option_id));
  return { row, level: lineRow ? 'line' : 'order', allowed: ok };
}

/** A database without init.sql §65 yet reads as "no order values" — never a failed resolve. */
export const missingSchema = (err) => err && (err.code === 'ER_NO_SUCH_TABLE' || err.code === 'ER_BAD_FIELD_ERROR' || err.errno === 1146 || err.errno === 1054);

/**
 * The live order and line values of one order (and, with `lineIds`, only the whole-order ones plus
 * those lines'), flagged specs only. ONE query. Rows carry spec_code / data_type for the callers.
 */
export async function loadOrderDefaultRows(db, companyId, orderId, lineIds = null) {
  if (orderId == null) return [];
  const lines = lineIds == null ? null : [...new Set(lineIds.map(Number))];
  try {
    const [rows] = await db.query(
      `SELECT d.*, s.code AS spec_code, s.name AS spec_name, s.data_type, s.decimals, s.default_uom
         FROM cf_order_spec_defaults d
         JOIN cf_specifications s ON s.company_id = d.company_id AND s.id = d.specification_id AND s.deleted_at IS NULL AND s.order_level = 1
        WHERE d.company_id = ? AND d.order_id = ? AND d.deleted_at IS NULL${lines ? (lines.length ? ' AND (d.order_line_id IS NULL OR d.order_line_id IN (?))' : ' AND d.order_line_id IS NULL') : ''}`,
      lines && lines.length ? [companyId, orderId, lines] : [companyId, orderId],
    );
    return rows;
  } catch (err) {
    if (missingSchema(err)) return [];
    throw err;
  }
}

/** The sentence on a row an option value does not reach. */
export const notAllowedNote = (level, display) =>
  `The ${LEVEL_WORD[level]}’s value${display ? ` ${display}` : ''} is not allowed on this row — it keeps its own rule.`;
