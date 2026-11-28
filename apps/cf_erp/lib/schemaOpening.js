/**
 * schemaOpening.js — a backend ahead of init.sql §121 (TM/s121.sql) keeps working.
 *
 * §121 adds cf_production_steps.opening (a step done by an opening position). Apply it BEFORE the backend push; if it
 * is not there yet, the first read that names the column fails with 1054, this remembers that for the life of the
 * process, and the readers run their query again as if no step were an opening one (which, without the column, none is).
 */
let missing = false;

/** True while §121 is believed present. */
export const hasOpening = () => !missing;

/** Call from a catch: true (and remembered) when the error is the missing opening column. */
export function missingOpening(e) {
  if (e && e.errno === 1054 && /opening/.test(String(e.message ?? e.sqlMessage ?? ''))) {
    missing = true;
    return true;
  }
  return false;
}

/** db.query(make(true), params) — or make(false) when the database has no §121. */
export async function queryOpening(db, make, params) {
  if (!missing) {
    try { return await db.query(make(true), params); } catch (e) { if (!missingOpening(e)) throw e; }
  }
  return db.query(make(false), params);
}
