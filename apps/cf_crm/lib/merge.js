/**
 * Three-way merge of one record, field by field.
 *
 * base   — the version the person started editing from (cf_crm_record_versions)
 * theirs — what is saved now (someone else changed it since)
 * mine   — what this save sends
 *
 * A field this save did not change keeps the saved value (theirs). A field it
 * changed takes this save's value. If both changed the same field to
 * different values, this save's value is kept and the field is reported in
 * `clash`, so the person is told; the other value stays in the version
 * history. Values are compared as data (key order does not matter); a list
 * such as mobiles is one value.
 */
const IGNORE = new Set(['updatedAt', 'updatedBy', '_rev']);

export function stable(v) {
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
  return v === undefined ? 'undefined' : JSON.stringify(v);
}
const same = (a, b) => stable(a) === stable(b);

export function merge3(base, theirs, mine) {
  base = base || {}; theirs = theirs || {}; mine = mine || {};
  const out = { ...theirs };
  const clash = [];
  const keys = new Set([...Object.keys(base), ...Object.keys(theirs), ...Object.keys(mine)]);
  for (const k of keys) {
    if (IGNORE.has(k)) continue;
    if (same(mine[k], base[k])) continue; // not changed by this save
    if (!same(theirs[k], base[k]) && !same(mine[k], theirs[k])) clash.push(k);
    if (mine[k] === undefined) delete out[k];
    else out[k] = mine[k];
  }
  if (mine.updatedAt !== undefined) out.updatedAt = mine.updatedAt;
  if (mine.updatedBy !== undefined) out.updatedBy = mine.updatedBy;
  return { data: out, clash };
}
