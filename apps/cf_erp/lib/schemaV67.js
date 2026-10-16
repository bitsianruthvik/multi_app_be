/**
 * schemaV67.js — a backend ahead of its schema keeps writing stock.
 *
 * init.sql §67 (TM/s67.sql) adds cf_stock_ledger.owner_party_id, the loss and
 * unit tables and the step scrap columns. Apply it BEFORE the backend push; if
 * it is not there yet, the first statement that needs it fails with 1054 / 1146,
 * this remembers that for the life of the process, and the writers fall back to
 * what they wrote before §67 (no owner column, no units, no loss rows).
 */
let missing = false;

/** True while §67 is believed present. */
export const hasV67 = () => !missing;

/** Call from a catch: true (and remembered) when the error is a missing §67 column or table. */
export function missingV67(e) {
  if (e && (e.errno === 1054 || e.errno === 1146) && /owner_party_id|cf_stock_units|cf_stock_unit_events|cf_stock_losses|ledger_scrap|ledger_remade|cut_movement_id|scrap_rate_per_kg/.test(String(e.message ?? e.sqlMessage ?? ''))) {
    missing = true;
    return true;
  }
  return false;
}
