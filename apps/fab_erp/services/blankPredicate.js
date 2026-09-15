/**
 * blankPredicate.js — "this row is not a blank", written once.
 *
 * ── WHY IT IS ITS OWN FILE ───────────────────────────────────────────────────
 *
 * It lived in `blankService` until `productionOrderService` needed it too — and
 * `blankService` already imports `productionOrderService` to raise the order.
 * That is a cycle. ES modules survive one as long as nothing is read at
 * module-evaluation time, which was true here, so it would have worked and gone
 * on working right up until somebody moved a call to the top level.
 *
 * This file imports nothing, so it can be imported by anything.
 *
 * ── WHAT IT IS FOR ───────────────────────────────────────────────────────────
 *
 * A blank sits on the order as a structure row with the plate beneath it. That
 * makes it look exactly like a made leaf, so without this exclusion:
 *
 *   · `orderBlanks` treats it as something to cut out of something else, and
 *     the order grows blanks of blanks on every re-nest
 *   · the structure editor shows it as a sibling of the Span
 *   · the spreadsheet exports it
 *   · the fabrication order claims its cutting tasks
 *   · and worst, `applyTree` — which soft-deletes anything not in the tree it
 *     was sent — deletes every blank the next time somebody saves a quantity
 *
 * The test is the CATALOG's `material_form`, not the row's shape. Shape-based
 * guesses ("it has exactly one material child") hold until the day a real part
 * has one too.
 */

/**
 * SQL fragment excluding blank rows, for any query aliasing `fab_items`.
 *
 * @param {string} alias the table alias to test — the fab_items one
 * @returns {string} a bare condition, to be joined with AND
 */
export const NOT_A_BLANK = (alias = 'i') => `
  NOT EXISTS (SELECT 1 FROM fab_item_catalog bc
               WHERE bc.id = ${alias}.catalog_item_id
                 AND bc.material_form = 'blank')`;

/** The mirror of the above: only blank rows. */
export const IS_A_BLANK = (alias = 'i') => `
  EXISTS (SELECT 1 FROM fab_item_catalog bc
           WHERE bc.id = ${alias}.catalog_item_id
             AND bc.material_form = 'blank')`;

/**
 * SQL fragment: TRUE when a row is a MADE, CHILDLESS leaf — a part nesting and
 * the blank calculation are allowed to act on.
 *
 * "Childless" ignores material links (`node_kind = 'material'`): a part that
 * has already been nested has one, and counting it as a child would drop
 * every nested part off the list the moment it is cut.
 *
 * MERGED FROM THREE COPIES (PLAN.md EU-3): `blankService.orderBlanks`,
 * `nestingBoardService`'s "orphans" query, and `blankPlanService` (which does
 * not query this directly — it reads blanks through `blankService`, so its
 * citation in the plan is the same rule at one remove). The one real
 * difference: `nestingBoardService`'s copy tested `is_leaf = 1` with no
 * `NOT_A_BLANK` exclusion at all, which would treat a blank row itself as a
 * made leaf. That file is deleted whole in EU-20, so the surviving rule is
 * `blankService`'s (procurement + explicit childless-of-non-material + not a
 * blank), unchanged in behaviour from what `blankService` already ran.
 *
 * @param {string} alias the fab_items alias
 */
export const isMadeChildlessLeaf = (alias = 'p') => `
  COALESCE(${alias}.procurement_type, 'make') = 'make'
  AND NOT EXISTS (
    SELECT 1 FROM fab_items __icl
     WHERE __icl.parent_item_id = ${alias}.id AND __icl.deleted_at IS NULL
       AND NOT __icl.node_kind = 'material')
  AND ${NOT_A_BLANK(alias)}`;

/**
 * How many of a row the ORDER needs, walking up the tree and multiplying every
 * ancestor's `qty` — a row is a design, not a count of pieces.
 *
 * MERGED FROM TWO IDENTICAL COPIES (`blankService.orderBlanks`,
 * `nestingSuggestService`) — no behavioural difference found; the callers
 * differed only in which rows they fed into `nodeById`, not in the walk
 * itself. `nestingSuggestService`'s own copy is left in place (deleted whole
 * in EU-20).
 *
 * OPTIONAL `lineQtyMap` (EU-5, User Clarifications 3): the tree walk only ever
 * knew about STRUCTURAL qty (an ancestor's own `qty` column). The order LINE's
 * qty is a separate multiplier, applied ONCE at the target row itself — not
 * per ancestor, since every row in the chain hangs under the same line. Passing
 * nothing multiplies by 1, i.e. every caller that predates line qty keeps its
 * exact prior behaviour.
 *
 * @param {Map<number, {qty:number, parentItemId:number|null, orderLineId?:number|null}>} nodeById
 *   every candidate row for this order, keyed by id (build once per order, not
 *   once per part — that is the point of passing the map in rather than a query).
 * @param {number} partId
 * @param {Map<number, number>} [lineQtyMap] from `orderLineQty.lineQtyMap`
 */
export function rolledQty(nodeById, partId, lineQtyMap) {
  const target = nodeById.get(Number(partId));
  let multiplier = 1;
  let at = target;
  for (let hops = 0; at && hops < 64; hops += 1) {   // cycle guard, not optimism
    multiplier *= Number(at.qty) || 0;
    if (at.parentItemId == null) break;
    at = nodeById.get(Number(at.parentItemId));
  }
  if (lineQtyMap) {
    multiplier *= lineQtyMap.get(target?.orderLineId == null ? null : Number(target.orderLineId)) ?? 1;
  }
  return Math.round(multiplier);
}
