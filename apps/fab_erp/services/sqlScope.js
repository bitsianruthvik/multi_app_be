/**
 * sqlScope.js — small SQL fragments that were being hand-built at each call
 * site, differently enough that one of them was a runtime string edit.
 */

/**
 * The order-line scope condition, with the alias already applied.
 *
 * `bomService.js` needed this twice with two different column prefixes — the
 * top-level query aliases nothing, the JOIN'd sub-query needs `i.` — and did it
 * by taking the no-alias SQL and calling
 * `.replace('order_line_id', 'i.order_line_id')` on the STRING. That works only
 * because no other token in the fragment contains `order_line_id`; the moment
 * one did, the replace would corrupt it silently. Building the aliased form
 * directly has no such trap.
 *
 * `orderLineId == null` means "the line-less rows" (`IS NULL`), not "every
 * row" — that is the contract `instantiate`/`buildFromTree` already relied on.
 *
 * @param {string} alias table alias, or '' for none
 * @param {number|null} orderLineId
 * @returns {{sql:string, params:number[]}}
 */
export function lineScopeSql(alias, orderLineId) {
  const prefix = alias ? `${alias}.` : '';
  return orderLineId == null
    ? { sql: `AND ${prefix}order_line_id IS NULL`, params: [] }
    : { sql: `AND ${prefix}order_line_id = ?`, params: [orderLineId] };
}

/** `?` repeated `n` times, comma-joined, for a hand-built `IN (...)` list. */
export function placeholders(n) {
  return Array.from({ length: n }, () => '?').join(',');
}
