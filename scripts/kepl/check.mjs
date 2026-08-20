import { SPANS, spanPartRows, rowWeight, RAW_MATERIAL, BOQ_STATED, STUDS, DENSITY } from './model.mjs';
import { nestAll, utilisation, verify } from './nest.mjs';

const rows = [];
for (let s = 1; s <= SPANS; s++) rows.push(...spanPartRows(s));

const fabKg = rows.reduce((a, r) => a + rowWeight(r), 0);
const studKg = STUDS.perSpan * SPANS * STUDS.gramsEach / 1000;
console.log(`part rows        ${rows.length}   (pieces ${rows.reduce((a, r) => a + r.qty, 0)})`);
console.log(`fabricated steel ${(fabKg / 1000).toFixed(2)} MT`);
console.log(`shear studs      ${(studKg / 1000).toFixed(2)} MT`);
console.log(`TOTAL            ${((fabKg + studKg) / 1000).toFixed(2)} MT   vs BOQ ${BOQ_STATED.totalMt} MT`
  + `   (${(((fabKg + studKg) / 1000 - BOQ_STATED.totalMt) / BOQ_STATED.totalMt * 100).toFixed(2)}%)`);

const rmKg = RAW_MATERIAL.reduce((a, p) => a + p.t * p.l * p.w * DENSITY * p.qty, 0);
console.log(`RM purchased     ${(rmKg / 1000).toFixed(2)} MT  vs list ${BOQ_STATED.rmMt} MT`);

const { plates, unplaced, byThickness } = nestAll(rows, RAW_MATERIAL);
console.log(`\nNESTING  ${plates.length} plates`);
console.log('thk   used  bought   sizes');
for (const t of Object.keys(byThickness).sort((a, b) => a - b)) {
  const b = byThickness[t];
  const flag = b.used > b.bought ? `  SHORT by ${b.used - b.bought}` : '';
  console.log(`${String(t).padStart(3)}   ${String(b.used).padStart(4)}  ${String(b.bought).padStart(6)}   `
    + Object.entries(b.sizes).map(([k, v]) => `${k} x${v}`).join(', ') + flag);
}
const avg = plates.reduce((a, p) => a + utilisation(p), 0) / plates.length;
console.log(`\nmean utilisation ${(avg * 100).toFixed(1)}%`);
if (unplaced.length) { console.log(`\nUNPLACED ${unplaced.length}:`); for (const u of unplaced.slice(0, 10)) console.log(`  ${u.row.path}/${u.row.code} ${u.row.t}x${u.row.l}x${u.row.w} — ${u.why}`); }
const problems = verify(plates);
console.log(problems.length ? `\nFIT CHECK FAILED (${problems.length}):\n  ` + problems.slice(0, 10).join('\n  ') : '\nFIT CHECK PASSED — every part sits inside its plate, no plate overfilled.');
