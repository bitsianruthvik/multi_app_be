/**
 * sheet.mjs — the nesting sheet, plate by plate, for a person to check.
 *
 * Usage: node scripts/kepl/sheet.mjs > kepl/NESTING_SHEET.md
 *
 * The database now holds this same assignment, but a table in the database is
 * not something anyone can disagree with. This prints what went on each plate
 * and what it left over, so the fit can be argued with by eye before any steel
 * is cut — which is the only check that matters.
 */

import { SPANS, spanPartRows, RAW_MATERIAL, DENSITY, BOQ_STATED } from './model.mjs';
import { nestAll, utilisation, verify } from './nest.mjs';

const rows = [];
for (let s = 1; s <= SPANS; s++) rows.push(...spanPartRows(s));
const { plates, unplaced } = nestAll(rows, RAW_MATERIAL);
const problems = verify(plates);

const out = [];
out.push('# KEPL ROB 59.3 m — nesting sheet');
out.push('');
out.push(`${plates.length} plates, ${rows.length} part rows, `
  + `${rows.reduce((a, r) => a + r.qty, 0)} pieces. `
  + `Mean utilisation ${((plates.reduce((a, p) => a + utilisation(p), 0) / plates.length) * 100).toFixed(1)}%.`);
out.push('');
out.push(problems.length
  ? `**${problems.length} FIT PROBLEMS** — see the end.`
  : '**Every part sits inside its plate in the orientation shown, and no plate is asked '
    + 'for more area than it has.** Fit is re-derived from the final assignment, not '
    + 'from the packer\'s own bookkeeping.');
out.push('');

// ── purchased vs used ──────────────────────────────────────────────────────
out.push('## Plates needed against plates listed');
out.push('');
out.push('| thk | plate | listed | needed | |');
out.push('|---|---|---|---|---|');
const usedBySize = new Map();
for (const p of plates) {
  const k = `${p.spec.t}|${p.spec.w}x${p.spec.l}`;
  usedBySize.set(k, (usedBySize.get(k) ?? 0) + 1);
}
let listed = 0; let needed = 0;
for (const rm of RAW_MATERIAL) {
  const k = `${rm.t}|${rm.w}x${rm.l}`;
  const u = usedBySize.get(k) ?? 0;
  listed += rm.qty; needed += u;
  const delta = u - rm.qty;
  out.push(`| ${rm.t} | ${rm.w} x ${rm.l} | ${rm.qty} | ${u} | `
    + `${delta === 0 ? 'matches' : delta > 0 ? `**${delta} more**` : `${-delta} spare`} |`);
}
out.push(`| | **total** | **${listed}** | **${needed}** | |`);
out.push('');

// ── weight cross-check ─────────────────────────────────────────────────────
const fabKg = rows.reduce((a, r) => a + r.t * r.l * r.w * DENSITY * r.qty, 0);
out.push('## Weight, against the BOQ');
out.push('');
out.push('| | this build | BOQ | |');
out.push('|---|---|---|---|');
out.push(`| fabricated steel | ${(fabKg / 1000).toFixed(2)} MT | | |`);
out.push(`| shear studs | 10.96 MT | | |`);
out.push(`| **total** | **${(fabKg / 1000 + 10.96).toFixed(2)} MT** | **${BOQ_STATED.totalMt} MT** | `
  + `${(((fabKg / 1000 + 10.96) - BOQ_STATED.totalMt) / BOQ_STATED.totalMt * 100).toFixed(2)}% |`);
out.push('');

// ── the plates ─────────────────────────────────────────────────────────────
out.push('## Every plate');
out.push('');
for (const p of plates) {
  const parts = new Map();
  for (const r of p.rows) {
    const k = `${r.code.split('-').pop()} ${r.l}x${r.w}`;
    parts.set(k, (parts.get(k) ?? 0) + r.qty);
  }
  out.push(`**${p.no}** — ${p.spec.t} mm, ${p.spec.w} x ${p.spec.l} mm — `
    + `${(utilisation(p) * 100).toFixed(0)}% used, ${p.rows.length} rows, `
    + `${p.rows.reduce((a, r) => a + r.qty, 0)} pieces`);
  out.push('');
  out.push([...parts.entries()].map(([k, v]) => `${v} x ${k}`).join(' · '));
  out.push('');
}

if (unplaced.length) {
  out.push('## Unplaced');
  out.push('');
  for (const u of unplaced) out.push(`- ${u.row.path}/${u.row.code} ${u.row.t}x${u.row.l}x${u.row.w} — ${u.why}`);
  out.push('');
}
if (problems.length) {
  out.push('## Fit problems');
  out.push('');
  for (const p of problems) out.push(`- ${p}`);
}

console.log(out.join('\n'));
