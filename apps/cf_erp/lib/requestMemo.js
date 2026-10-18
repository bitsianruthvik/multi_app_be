/**
 * requestMemo.js — one read of the line's fixed facts per plate save (PERFORMANCE 17, 2026-10-18).
 *
 * "Use this nesting" took ~40 s on production TiDB (~49 ms a round trip): the screen asks for the before / after
 * sheet (`impact: true`), so the line was read three times — measured before, the accept's own reads, measured
 * after — and each time the same structure (the BOM walk, one statement per level), the same cut plates, catalog
 * plates, cut settings and drawings. 150 round trips for a line of 3 plates; more for a deeper tree.
 *
 * What an accept / a swap writes is the plates (lots, placements, offcuts), the plate line of each cut plate (child
 * and quantity — BELOW the cut plates, so no cut plate's count changes) and the cut length / piercings values. None
 * of the facts memoised here reads those. So inside ONE scope — plateChangeGate wraps the before / action / after of
 * a nesting save in it — each is read once.
 *
 * THE SCOPE IS EXPLICIT, NOT THE TRANSACTION. withMemo sets a Map on the connection for the length of `fn` and
 * deletes it in its finally. Outside a scope nothing is memoised (memoized simply calls `load`): a test, a script or
 * another route that writes a drawing and reads it back in one transaction sees what it wrote, exactly as before.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

const MEMO = Symbol('cf_erp.requestMemo');
/** The same scope for code that has no db handle (the plate measurer): the scope's Map, through every await. */
const SCOPE = new AsyncLocalStorage();

/** The memo of the scope this code runs in (no db handle needed), or null. */
export const scopeMemo = () => SCOPE.getStore() ?? null;

/** The live memo of this db handle, or null outside a scope. */
export const memoOf = (db) => db?.[MEMO] ?? null;

/** Runs `fn` with a memo on `db` (a nested call shares the outer one). */
export async function withMemo(db, fn) {
  if (!db || db[MEMO]) return fn();
  const m = new Map();
  db[MEMO] = m;
  try { return await SCOPE.run(m, fn); } finally { delete db[MEMO]; }
}

/**
 * The value under `key`, loaded once per scope. The PROMISE is kept, so two callers in flight share one read; a
 * load that fails is forgotten (the next caller tries again). Outside a scope: `load()`.
 */
export function memoized(db, key, load) {
  const m = memoOf(db);
  if (!m) return load();
  if (m.has(key)) return m.get(key);
  const p = Promise.resolve().then(load);
  m.set(key, p);
  p.catch(() => { if (m.get(key) === p) m.delete(key); });
  return p;
}

/** A write inside the scope that changes a memoised fact: every key starting with `prefix` is read again. */
export function forget(db, prefix) {
  const m = memoOf(db);
  if (!m) return;
  for (const k of [...m.keys()]) if (String(k).startsWith(prefix)) m.delete(k);
}

/** A value read anyway (a locking read) put in the scope, so later plain reads of it cost nothing. */
export function remember(db, key, value) {
  const m = memoOf(db);
  if (m) m.set(key, Promise.resolve(value));
}
