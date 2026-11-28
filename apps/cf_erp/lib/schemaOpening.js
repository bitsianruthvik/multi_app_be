/**
 * schemaOpening.js — a backend ahead of init.sql §121 (TM/s121.sql) keeps working.
 *
 * §121 adds cf_production_steps.opening (a step done by an opening position). Apply it BEFORE the backend push; if it
 * is not there yet, a read that names the column fails with 1054 and the reader runs its query again as if no step
 * were an opening one (which, without the column, none is). "Missing" is remembered for RECHECK_MS only, so a database
 * migrated while the process runs is picked up within minutes, without a restart.
 */
const RECHECK_MS = 5 * 60 * 1000;
let missingAt = 0;

/** True unless the column was found missing within the last few minutes. */
export const hasOpening = () => !missingAt || Date.now() - missingAt > RECHECK_MS;

/** Call from a catch: true (and remembered for a while) when the error is the missing opening column. */
export function missingOpening(e) {
  if (e && e.errno === 1054 && /opening/.test(String(e.message ?? e.sqlMessage ?? ''))) {
    missingAt = Date.now();
    return true;
  }
  return false;
}

/** db.query(make(true), params) — or make(false) when the database has no §121. */
export async function queryOpening(db, make, params) {
  if (hasOpening()) {
    try { return await db.query(make(true), params); } catch (e) { if (!missingOpening(e)) throw e; }
  }
  return db.query(make(false), params);
}
