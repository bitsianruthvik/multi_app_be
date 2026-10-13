/**
 * _shared.js — the few things every entity definition needs.
 * (See ../engine.js for what a definition is.)
 */
import { PERM } from '../../../lib/http.js';

export { PERM };

/** A list of plain words: the text is its own key. */
export const words = (label, values) => ({ label, entries: values.map((v) => ({ text: v, key: v })) });
/** A list of records with codes: "CODE — Name", matched by the code. A record with no code is matched by "#id". */
export const coded = (label, rows, { code = 'code', name = 'name' } = {}) => ({
  label,
  entries: rows.map((r) => {
    const k = r[code] != null && String(r[code]).trim() !== '' ? String(r[code]).trim() : `#${r.id}`;
    return { text: `${k} — ${r[name] ?? ''}`.trim(), key: k, id: r.id, row: r };
  }),
});
/** The entry of a list for an id, as its text — what a cell shows. */
export const textOf = (list, id) => (id == null ? null : (list.entries.find((e) => e.id === id)?.text ?? null));

export const STATUS = ['ACTIVE', 'INACTIVE'];
export const yes = (v) => v === 'Yes' || v === true;
export const flag = (v) => (v ? 'Yes' : 'No');
export const day = (v) => {
  if (v == null || v === '') return null;
  if (v instanceof Date) return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
  return String(v).slice(0, 10);
};
export const todayText = () => day(new Date());
export const changed = (row, key) => row.isNew || row.changes.some((c) => c.key === key);
/** The keys of a row that differ from the record (every filled key, for a new row). */
export const changedKeys = (row) => new Set(row.changes.map((c) => c.key));

/** Is a department inside the login's scope? Everything is, for a whole-company login. */
export const inScope = (env, departmentId) => env.scope.all || (departmentId != null && env.scope.departmentIds.has(Number(departmentId)));

/** Rows that would close a loop when each row's `parentOf(row)` replaces what `parentNow` says. */
export function loops(rows, parentNow, parentOf) {
  const parent = new Map(parentNow);
  for (const r of rows) if (!r.isNew && r.id != null && !r.problems.length) parent.set(r.id, parentOf(r));
  const bad = [];
  for (const r of rows) {
    if (r.isNew || r.id == null || r.problems.length) continue;
    // Only a row whose parent this file changes: a row left as it was did not make the loop.
    if ((parentNow.get(r.id) ?? null) === (parentOf(r) ?? null)) continue;
    const seen = new Set([r.id]);
    for (let p = parent.get(r.id) ?? null, i = 0; p != null && i < 10000; p = parent.get(p) ?? null, i += 1) {
      if (seen.has(p)) { if (p === r.id) bad.push(r); break; }
      seen.add(p);
    }
  }
  return bad;
}
