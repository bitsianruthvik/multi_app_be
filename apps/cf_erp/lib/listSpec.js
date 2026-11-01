/**
 * listSpec.js — a LIST specification: rows of named columns held on one piece (2026-11-01, user: "a linked
 * array store … have the two specifications linked"). Pure, no database.
 *
 * HOLE_SET is the first one: one row per kind of hole on a part, so a diameter and its count can never come
 * apart the way HOLES and HOLE_DIA did on a part with two sizes of hole —
 *   [{ DIA: 22, COUNT: 12, KIND: 'drilled' }, { DIA: 26, COUNT: 4, KIND: 'countersunk', DEPTH: 40 }]
 *
 * Its shape is the specification's table_config:
 *   { columns: [{ code, name, kind: 'number' | 'word', unit?, options?, required?, integer?, blank? }] }
 *   options   the words a 'word' column takes (KIND: drilled, punched, …)
 *   blank     what an empty cell means, in words ("the plate's thickness") — shown, not stored
 * A value is the array of rows, column codes upper case; it is stored in cf_spec_values.value_json. Formulas read
 * it through EACH(list, …) (formulaEngine), a row's cell as row.X.
 */

const isBlank = (v) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
const r6 = (n) => Number(Number(n).toFixed(6));

/** The columns a list spec's table_config declares, or null when it is not a list config. */
export function listColumns(config) {
  const cols = config?.columns;
  if (!Array.isArray(cols) || !cols.length) return null;
  return cols.map((c) => ({ ...c, code: String(c.code ?? '').toUpperCase(), kind: c.kind === 'word' ? 'word' : 'number' }));
}

/** Checks a list spec's table_config when the spec is saved. → { config } | { problem } */
export function checkListConfig(config) {
  const cols = listColumns(config);
  if (!cols) return { problem: 'A list needs its columns: { columns: [{ code, name, kind }] }.' };
  const seen = new Set();
  for (const c of cols) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(c.code)) return { problem: `"${c.code}" is not a column code (letters, digits and _).` };
    if (seen.has(c.code)) return { problem: `Column ${c.code} is there twice.` };
    seen.add(c.code);
    if (c.options != null && (!Array.isArray(c.options) || c.options.some((o) => typeof o !== 'string' || !o.trim()))) return { problem: `Column ${c.code}: options are words.` };
  }
  return { config: { columns: cols.map((c) => ({ code: c.code, name: String(c.name ?? c.code), kind: c.kind, ...(c.unit ? { unit: String(c.unit) } : {}),
    ...(c.options ? { options: c.options.map((o) => o.trim()) } : {}), ...(c.required ? { required: true } : {}), ...(c.integer ? { integer: true } : {}),
    ...(c.blank ? { blank: String(c.blank) } : {}) })) } };
}

/**
 * A typed list value against its columns. → { rows } | { problem }. Rows that are wholly empty are dropped;
 * an empty list is a value (no holes), distinct from no value at all.
 */
export function checkListValue(code, config, input) {
  const cols = listColumns(config);
  if (!cols) return { problem: `${code} has no columns set up.` };
  let raw = input;
  if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch { return { problem: `${code} needs a list of rows.` }; } }
  if (!Array.isArray(raw)) return { problem: `${code} needs a list of rows, not a plain value.` };
  if (raw.length > 200) return { problem: `${code} has more than 200 rows.` };
  const rows = [];
  for (const [i, given] of raw.entries()) {
    if (given == null || typeof given !== 'object' || Array.isArray(given)) return { problem: `${code} row ${i + 1} is not a row.` };
    const keyed = {};
    for (const [k, v] of Object.entries(given)) keyed[String(k).toUpperCase()] = v;
    const unknown = Object.keys(keyed).find((k) => !cols.some((c) => c.code === k));
    if (unknown) return { problem: `${code} has no column ${unknown}.` };
    if (cols.every((c) => isBlank(keyed[c.code]))) continue;
    const row = {};
    for (const c of cols) {
      const v = keyed[c.code];
      if (isBlank(v)) {
        if (c.required) return { problem: `${code} row ${i + 1}: ${c.name} is needed.` };
        continue;
      }
      if (c.kind === 'number') {
        const n = typeof v === 'number' ? v : Number(String(v).trim());
        if (!Number.isFinite(n)) return { problem: `${code} row ${i + 1}: ${c.name} needs a number.` };
        if (n < 0) return { problem: `${code} row ${i + 1}: ${c.name} cannot be below 0.` };
        if (c.integer && !Number.isInteger(n)) return { problem: `${code} row ${i + 1}: ${c.name} is a whole number.` };
        row[c.code] = r6(n);
      } else {
        const w = String(v).trim();
        const hit = c.options ? c.options.find((o) => o.toLowerCase() === w.toLowerCase()) : w;
        if (!hit) return { problem: `${code} row ${i + 1}: "${w}" is not one of ${c.options.join(', ')}.` };
        if (hit.length > 60) return { problem: `${code} row ${i + 1}: ${c.name} is too long.` };
        row[c.code] = hit;
      }
    }
    rows.push(row);
  }
  return { rows };
}

/** A list in a few words: "12 × Ø22 drilled · 4 × Ø26 countersunk (40)" for a hole set; "3 rows" otherwise. */
export function listSummary(config, rows) {
  if (!Array.isArray(rows)) return null;
  if (!rows.length) return 'none';
  const cols = listColumns(config) ?? [];
  const has = (c) => cols.some((x) => x.code === c);
  if (has('DIA') && has('COUNT')) {
    return rows.map((r) => `${r.COUNT ?? '?'} × Ø${r.DIA ?? '?'}${r.KIND && r.KIND !== 'drilled' ? ` ${r.KIND}` : ''}${r.DEPTH != null ? ` (${r.DEPTH} deep)` : ''}`).join(' · ');
  }
  return `${rows.length} row${rows.length === 1 ? '' : 's'}`;
}

/** Whether two list values say the same (rows in order, cells by value). */
export function sameList(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  return a.every((r, i) => {
    const s = b[i] ?? {};
    const keys = new Set([...Object.keys(r ?? {}), ...Object.keys(s)]);
    return [...keys].every((k) => (r?.[k] ?? null) === (s[k] ?? null) || (typeof r?.[k] === 'number' && Math.abs(r[k] - s[k]) < 1e-6));
  });
}

/** The holes a drawing shows, as a hole set: one row per diameter, largest count first. Null when it shows none. */
export function holeSetOf(holeDiameters) {
  const count = new Map();
  for (const d of holeDiameters ?? []) {
    const n = Math.round(Number(d) * 10) / 10;
    if (Number.isFinite(n) && n > 0) count.set(n, (count.get(n) ?? 0) + 1);
  }
  if (!count.size) return null;
  return [...count].sort((a, b) => b[1] - a[1] || b[0] - a[0]).map(([d, n]) => ({ DIA: d, COUNT: n, KIND: 'drilled' }));
}

/** HOLE_SET's columns — the setup script and the tests use the same shape. */
export const HOLE_SET_CONFIG = {
  columns: [
    { code: 'DIA', name: 'Diameter', kind: 'number', unit: 'mm', required: true },
    { code: 'COUNT', name: 'Holes', kind: 'number', integer: true, required: true },
    { code: 'KIND', name: 'Kind', kind: 'word', options: ['drilled', 'punched', 'countersunk', 'tapped', 'reamed'] },
    { code: 'DEPTH', name: 'Through', kind: 'number', unit: 'mm', blank: "the part's thickness" },
  ],
};
