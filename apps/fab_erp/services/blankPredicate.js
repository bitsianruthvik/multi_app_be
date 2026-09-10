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
