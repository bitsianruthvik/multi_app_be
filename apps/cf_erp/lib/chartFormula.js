/**
 * chartFormula.js — the short way to read a chart in a time formula (user, 2026-10-08: "make this
 * lookup very simple").
 *
 * A chart (a table specification on a machine type or machine) whose every column says which of
 * the piece's values it is read by — Thickness → item.THICKNESS — can be written by its name:
 *
 *   item.CUT_LENGTH / machine.GAS_CUT_SPEED   is   item.CUT_LENGTH / LOOKUP(machine.GAS_CUT_SPEED, item.THICKNESS)
 *
 * machine.NAME is the way it is written and shown (2026-10-09: like item.X — "machine." lists every
 * number and chart the machine has); a bare NAME typed out of habit is read the same.
 *
 * The long form is what is STORED and worked out (formulaEngine, flowSpecService read it as
 * before); the short form is what a person writes and sees. expandCharts turns short into long
 * when a rule is saved, contractCharts turns long into short when it is shown. A LOOKUP written
 * out by hand with other arguments stays as written.
 *
 * bindings: Map CODE -> [FIELD_CODE, …] — only charts whose every column has a field.
 * PURE: no database.
 */
const IDENT = /(item\.|machine\.)?([A-Za-z_][A-Za-z0-9_]*)/g;

/** Short → long. */
export function expandCharts(expr, bindings) {
  if (expr == null || !bindings?.size) return expr;
  const s = String(expr);
  let out = '';
  let last = 0;
  for (const m of s.matchAll(IDENT)) {
    const [whole, prefix, name] = m;
    const at = m.index;
    const before = s.slice(0, at);
    // Part of a number (1e3), or the tail of something dotted we did not match.
    if (/[0-9.]$/.test(before) && !prefix) continue;
    if (prefix === 'item.') continue;
    const code = name.toUpperCase();
    const fields = bindings.get(code);
    if (!fields) continue;
    const after = s.slice(at + whole.length);
    if (/^\s*\(/.test(after)) continue;                                  // a function of that name
    if (/LOOKUP\s*\(\s*$/i.test(before)) continue;                        // already a LOOKUP's chart
    out += s.slice(last, at) + `LOOKUP(machine.${code}, ${fields.map((f) => `item.${f}`).join(', ')})`;
    last = at + whole.length;
  }
  return out + s.slice(last);
}

/** Long → short, where a LOOKUP reads a chart by exactly its own columns. */
export function contractCharts(expr, bindings) {
  if (expr == null || !bindings?.size) return expr;
  return String(expr).replace(/LOOKUP\s*\(\s*machine\.([A-Za-z_][A-Za-z0-9_]*)\s*,([^()]*)\)/gi, (whole, name, rest) => {
    const fields = bindings.get(name.toUpperCase());
    if (!fields) return whole;
    const args = rest.split(',').map((a) => a.trim());
    // Only its own columns IN ITS ORDER become the name; anything else is shown exactly as it was written
    // (2026-10-09: a LOOKUP typed in another order came back as the bare name and read as a reset).
    // The engine reads each column by its own value either way (formulaEngine.alignedArgs).
    const same = args.length === fields.length && args.every((a, i) => a.toLowerCase() === `item.${fields[i]}`.toLowerCase());
    return same ? `machine.${name.toUpperCase()}` : whole;
  });
}
