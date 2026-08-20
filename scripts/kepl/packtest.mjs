import { nest, verify, utilisation } from '../../apps/fab_erp/services/nestingPacker.js';
import { SPANS, spanPartRows, RAW_MATERIAL } from './model.mjs';

// ── 1. a case small enough to check by hand ────────────────────────────────
const spec = [{ id: 1, code: 'P', length: 12000, width: 2000 }];
const four = [1, 2, 3, 4].map((i) => ({ key: `f${i}`, length: 12000, width: 500, qty: 1 }));
let r = nest(four, spec);
console.log(`4 x 12000x500 on one 12000x2000 -> ${r.plates.length} plate(s), `
  + `${(utilisation(r.plates[0]) * 100).toFixed(0)}% used, unplaced ${r.unplaced.length}   `
  + `${r.plates.length === 1 ? 'PASS' : 'FAIL'}`);

const five = [...four, { key: 'f5', length: 12000, width: 500, qty: 1 }];
r = nest(five, spec);
console.log(`5 of them -> ${r.plates.length} plate(s)   ${r.plates.length === 2 ? 'PASS' : 'FAIL'}`);

// a part nobody sells a plate for
r = nest([{ key: 'huge', length: 12000, width: 2995, qty: 1 }], spec);
console.log(`a 2995-wide part on a 2000-wide plate -> unplaced ${r.unplaced.length}   `
  + `${r.unplaced.length === 1 ? 'PASS' : 'FAIL'}`);
console.log(`   reason: ${r.unplaced[0]?.reason}`);

// ── 2. the KEPL order, against its own project-specific plate list ─────────
const rows = [];
for (let s = 1; s <= SPANS; s++) {
  for (const p of spanPartRows(s)) {
    rows.push({ key: `${s}/${p.path}/${p.code}`, length: p.l, width: p.w, qty: p.qty, t: p.t });
  }
}
let total = 0; let totalUtil = 0; let unplacedAll = 0; const problems = [];
for (const t of [...new Set(rows.map((x) => x.t))].sort((a, b) => a - b)) {
  const mine = rows.filter((x) => x.t === t);
  const specs = RAW_MATERIAL.filter((m) => m.t === t)
    .map((m, i) => ({ id: i, code: `${m.t}mm`, length: m.l, width: m.w }));
  const res = nest(mine, specs);
  problems.push(...verify(res.plates));
  total += res.plates.length;
  totalUtil += res.plates.reduce((a, p) => a + utilisation(p), 0);
  unplacedAll += res.unplaced.length;
}
console.log(`\nKEPL parts on KEPL's own plate list: ${total} plates, `
  + `${(totalUtil / total * 100).toFixed(1)}% mean utilisation, ${unplacedAll} unplaced`);
console.log(`  fit re-check: ${problems.length ? `${problems.length} PROBLEMS` : 'clean'}`);
console.log(`  (the offline script got 119 plates at 92.3% — same order of magnitude means the port is sane)`);
