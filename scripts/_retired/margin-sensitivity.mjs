/**
 * margin-sensitivity.mjs — what the cutting margin costs, and what it makes
 * impossible.
 *
 * The margin is charged to the PART, so it hurts small parts hardest: a
 * 2995 x 178 stiffener at 50 mm clearance reserves 3045 x 228, which is 28%
 * more steel for the same piece. That means the right number matters a great
 * deal, and "50 mm" can mean two different things:
 *
 *   part-to-part gap   what the torch needs between two cuts
 *   edge margin        the unusable band at the plate's rim
 *
 * They are often different in practice — 10 mm between parts and 50 mm at the
 * edge is a common shop rule. This runs the same order across a range so the
 * cost of each assumption is visible, and lists the parts that stop fitting at
 * all.
 *
 *   node scripts/margin-sensitivity.mjs <orderId> [margins]
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const orderId = Number(process.argv[2]);
const MARGINS = (process.argv[3] ?? '0,10,25,50').split(',').map(Number);

const __dir = path.dirname(fileURLToPath(import.meta.url));
const env = {};
fs.readFileSync(path.join(__dir, '..', '..', '.env.tidb'), 'utf8').split('\n').forEach((l) => {
  l = l.trim(); if (!l || l.startsWith('#')) return;
  const [k, ...r] = l.split('='); env[k.trim()] = r.join('=').trim();
});
Object.assign(process.env, {
  DB_HOST: env.DB_HOST, DB_PORT: env.DB_PORT ?? '4000', DB_USER: env.DB_USER,
  DB_PASSWORD: env.DB_PASSWORD, DB_NAME: env.DB_NAME, DB_SSL: 'true',
});

const { pool } = await import('../db.js');
const { nest, areaOf, usedArea, rowFitsSpec } = await import('../apps/fab_erp/services/nestingPacker.js');
const { nestableParts, plateCatalog, offcutSpecs } = await import('../apps/fab_erp/services/nestingSuggestService.js');
const { plateFits } = await import('../apps/fab_erp/services/materialMatchService.js');

const COMPANY = 30005;
const DENSITY = 7.85 / 1000;

const { rows: allRows } = await nestableParts(COMPANY, orderId, { includeNested: true });
const plates = await plateCatalog(COMPANY);
const offcuts = await offcutSpecs(COMPANY, [...new Set(allRows.map((r) => r.currentMaterialId).filter(Boolean))]);

const groups = new Map();
for (const r of allRows) {
  if (r.grade == null || r.material == null) continue;
  const key = `${r.thickness}|${r.grade}|${r.material}`;
  if (!groups.has(key)) groups.set(key, { thickness: r.thickness, grade: r.grade, material: r.material, rows: [] });
  groups.get(key).rows.push(r);
}
const prepared = [...groups.values()].map((g) => ({
  ...g,
  candidates: [
    ...offcuts.filter((o) => g.rows.some((r) => r.currentMaterialId === o.catalogItemId)),
    ...plates.filter((p) => plateFits(g, p)),
  ],
})).filter((g) => g.candidates.length);

const out = [];
for (const margin of MARGINS) {
  let area = 0; let part = 0; let tonnes = 0; let plateCount = 0;
  const stranded = [];
  for (const g of prepared) {
    const res = nest(g.rows, g.candidates, { restarts: 8, margin });
    area += res.plates.reduce((a, p) => a + areaOf(p), 0);
    part += res.plates.reduce((a, p) => a + usedArea(p), 0);
    tonnes += res.plates.reduce((a, p) => a + (areaOf(p) / 1e6) * g.thickness * DENSITY, 0);
    plateCount += res.plates.length;
    for (const u of res.unplaced) {
      stranded.push({ thickness: g.thickness, name: u.row.partName, l: u.row.length, w: u.row.width, qty: u.row.qty });
    }
  }
  out.push({
    marginMm: margin,
    plates: plateCount,
    plateAreaM2: Math.round(area / 1e6 * 10) / 10,
    wastePct: Math.round((1 - part / area) * 1000) / 10,
    steelTonnes: Math.round(tonnes * 100) / 100,
    strandedRows: stranded.length,
  });
  console.log(`margin ${String(margin).padStart(3)} mm  ${String(plateCount).padStart(4)} plates  `
    + `waste ${String(out[out.length - 1].wastePct).padStart(5)}%  ${String(out[out.length - 1].steelTonnes).padStart(7)} t  `
    + `stranded ${stranded.length}`);
  if (stranded.length) {
    const byName = new Map();
    for (const s of stranded) {
      const k = `${s.thickness}mm ${s.name} ${s.l}x${s.w} q${s.qty}`;
      byName.set(k, (byName.get(k) ?? 0) + 1);
    }
    for (const [k, n] of [...byName].slice(0, 8)) console.log(`      x${n}  ${k}`);
  }
}
console.log('\n=== margin sensitivity ===');
console.table(out);
await pool.end();
