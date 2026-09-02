/**
 * kepl-extras-build.mjs — add the BOQ's non-girder sections to the order.
 *
 * End Diaphragm x6, Intermediate Diaphragm x45, Splice Details x16 and the
 * shear studs, per span. Together 71.26 t of the sheet's 334.64 t; without them
 * the order weighs 263.4 t a span and reconciles only against the girder
 * subtotal.
 *
 * DECLARED ON THE BOM FIRST, then built. The BOM lines are added to the Span
 * template (with the counts as parameters, so the next bridge can answer 6/45/16
 * with its own numbers), and the order's items are then created by reading those
 * lines back — including `default_flow_id`. One source of truth for what a span
 * contains and how each piece is made, rather than a script that knows better
 * than the catalogue.
 *
 * THESE HANG OFF THE SPAN, beside the girders. So a diaphragm's parts sit at
 * depth 2 while a girder's parts sit at depth 3, in one order. That is a tree
 * the old fixed span/girder/segment/part ladder could not express at all; with
 * depth it needs no special case.
 *
 *   node scripts/kepl-extras-build.mjs <extras.json>            # report
 *   node scripts/kepl-extras-build.mjs <extras.json> --apply
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const APPLY = process.argv.includes('--apply');
const SRC = process.argv[2];
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
const { setFields } = await import('../apps/fab_erp/services/fieldService.js');
const { recomputeOrderWeights } = await import('../apps/fab_erp/services/itemWeightService.js');

const COMPANY = 30005;
const extras = JSON.parse(fs.readFileSync(SRC, 'utf8'));

/** BOQ part code -> the catalogue item that already exists for it. */
const CODE_TO_CATALOG = {
  EDTF: 'End Diaphragm Top Flange', EDW: 'End Diaphragm Web', EDBF: 'End Diaphragm Bottom Flange',
  JS: 'End Diaphragm Joint Stiffener', PP: 'End Diaphragm Packing Plate',
  IDTF: 'Interm Diaphragm Top Flange', IDW: 'Interm Diaphragm Web', IDDW: 'Interm Diaphragm Diagonal Web',
  IDBF: 'Interm Diaphragm Bottom Flange', ISP: 'Interm Diaphragm Side Plate',
  IFP: 'Interm Diaphragm Fill Plate', ICP: 'Interm Diaphragm Corner Plate',
  WCP: 'Web Cover Plate', TFICP: 'Top Flange Inner Cover Plate', TFOCP: 'Top Flange Outer Cover Plate',
  BFOCP: 'Bottom Flange Outer Cover Plate', BFICP: 'Bottom Flange Inner Cover Plate',
};
/** section -> the assembly catalogue item and the parameter that counts it. */
const ASSEMBLIES = {
  end_diaphragm: { name: 'End Diaphragm', param: 'endDiaphragms', seg: 'ED' },
  interm_diaphragm: { name: 'Intermediate Diaphragm', param: 'intermDiaphragms', seg: 'ID' },
  splice: { name: 'Splice', param: 'splices', seg: 'SPL' },
};

const [catalog] = await pool.query(
  'SELECT id, name, unit FROM fab_item_catalog WHERE company_id = ? AND deleted_at IS NULL', [COMPANY]);
const byName = new Map(catalog.map((c) => [c.name, c]));
const [flows] = await pool.query(
  'SELECT id, name FROM fab_operation_flows WHERE company_id = ? AND deleted_at IS NULL', [COMPANY]);
const flowByName = new Map(flows.map((f) => [f.name, f]));
const PLAIN = flowByName.get('Part Fabrication — Plain (no holes)');
const ASSY = flowByName.get('Girder Segment — Assembly, Welding & Finishing');

const missing = [];
for (const [code, name] of Object.entries(CODE_TO_CATALOG)) if (!byName.has(name)) missing.push(`${code} -> ${name}`);
for (const a of Object.values(ASSEMBLIES)) if (!byName.has(a.name)) missing.push(`assembly -> ${a.name}`);

console.log(`catalogue lookups missing: ${missing.length ? missing.join(', ') : 'none'}`);
console.log(`flows: plain=${PLAIN?.id ?? 'MISSING'} assembly=${ASSY?.id ?? 'MISSING'}`);

const bySection = {};
for (const p of extras.parts) (bySection[p.section] ??= []).push(p);
let newItems = 0;
for (const [sec, parts] of Object.entries(bySection)) {
  const a = ASSEMBLIES[sec];
  newItems += a && parts.length ? (1 + parts.length) * parts[0].perSpan : 0;
}
console.log(`\nwould create ${newItems} items per span (${newItems * 2} across both), plus 1 stud line per span`);
for (const [sec, parts] of Object.entries(bySection)) {
  const a = ASSEMBLIES[sec];
  console.log(`  ${String(a.name).padEnd(24)} x${parts[0].perSpan}  with ${parts.length} parts each`);
}

if (!APPLY) { console.log('\nDRY RUN — pass --apply to write.'); await pool.end(); process.exit(0); }

// ── 1. declare it on the BOM, so the next order gets it too ────────────────
const spanItem = byName.get('Span');
for (const [sec, parts] of Object.entries(bySection)) {
  const a = ASSEMBLIES[sec];
  const assy = byName.get(a.name);
  if (!assy) continue;

  const [[existing]] = await pool.query(
    `SELECT id FROM fab_item_bom WHERE company_id=? AND parent_item_id=? AND child_item_id=? AND deleted_at IS NULL`,
    [COMPANY, spanItem.id, assy.id]);
  if (!existing) {
    await pool.query(
      `INSERT INTO fab_item_bom (company_id, parent_item_id, child_item_id, qty_param, default_qty,
                                 code_segment, default_flow_id, sort_order, active, created_at)
       VALUES (?,?,?,?,?,?,?,?,1,NOW())`,
      [COMPANY, spanItem.id, assy.id, a.param, parts[0].perSpan, a.seg, ASSY?.id ?? null, 10]);
    console.log(`  BOM: Span -> ${a.name} (param ${a.param}, default ${parts[0].perSpan})`);
  }
  for (const p of parts) {
    const child = byName.get(CODE_TO_CATALOG[p.code]);
    if (!child) continue;
    const [[has]] = await pool.query(
      `SELECT id FROM fab_item_bom WHERE company_id=? AND parent_item_id=? AND child_item_id=? AND deleted_at IS NULL`,
      [COMPANY, assy.id, child.id]);
    if (has) continue;
    await pool.query(
      `INSERT INTO fab_item_bom (company_id, parent_item_id, child_item_id, qty_num,
                                 code_segment, default_flow_id, sort_order, active, created_at)
       VALUES (?,?,?,?,?,?,?,1,NOW())`,
      [COMPANY, assy.id, child.id, p.qty, p.code, PLAIN?.id ?? null, 0]);
  }
}
console.log('  BOM lines declared.');

// ── 2. build them onto this order's spans ──────────────────────────────────
const [[order]] = await pool.query(
  `SELECT id, order_number FROM fab_orders WHERE company_id=? AND deleted_at IS NULL
     AND order_type='sales' ORDER BY id DESC LIMIT 1`, [COMPANY]);
const [spans] = await pool.query(
  `SELECT id, code, order_line_id AS lineId FROM fab_items
    WHERE company_id=? AND order_id=? AND deleted_at IS NULL AND depth=0 ORDER BY code`, [COMPANY, order.id]);

const dimJobs = [];
for (const span of spans) {
  for (const [sec, parts] of Object.entries(bySection)) {
    const a = ASSEMBLIES[sec];
    const assy = byName.get(a.name);
    if (!assy) continue;
    for (let n = 1; n <= parts[0].perSpan; n += 1) {
      const assyCode = `${span.code}-${a.seg}${n}`;
      const [r] = await pool.query(
        `INSERT INTO fab_items (company_id, order_id, order_line_id, parent_item_id, catalog_item_id,
                                name, unit, qty, code, node_kind, depth, is_leaf, procurement_type, flow_id, created_at)
         VALUES (?,?,?,?,?,?, 'nos', 1, ?, 'structure', 1, 0, 'make', ?, NOW())`,
        [COMPANY, order.id, span.lineId, span.id, assy.id, a.name, assyCode, ASSY?.id ?? null]);
      const assyId = r.insertId;

      for (const p of parts) {
        const child = byName.get(CODE_TO_CATALOG[p.code]);
        if (!child) continue;
        const [pr] = await pool.query(
          `INSERT INTO fab_items (company_id, order_id, order_line_id, parent_item_id, catalog_item_id,
                                  name, unit, qty, code, node_kind, depth, is_leaf, procurement_type, flow_id, created_at)
           VALUES (?,?,?,?,?,?, 'nos', ?, ?, 'structure', 2, 1, 'make', ?, NOW())`,
          [COMPANY, order.id, span.lineId, assyId, child.id, child.name, p.qty,
           `${assyCode}-${p.code}`, PLAIN?.id ?? null]);
        dimJobs.push({ id: pr.insertId, t: p.thickness, a: p.dimA, b: p.dimB });
      }
    }
  }

  // Studs: bought whole, never fabricated, so no flow and procurement_type buy.
  const stud = byName.get('Shear Stud 25 dia x 175 (headed)');
  if (stud) {
    await pool.query(
      `INSERT INTO fab_items (company_id, order_id, order_line_id, parent_item_id, catalog_item_id,
                              name, unit, qty, code, node_kind, depth, is_leaf, procurement_type, flow_id, created_at)
       VALUES (?,?,?,?,?,?, 'nos', 7212, ?, 'structure', 1, 1, 'buy', NULL, NOW())`,
      [COMPANY, order.id, span.lineId, span.id, stud.id, stud.name, `${span.code}-STUDS`]);
  }
  console.log(`  built extras under ${span.code}`);
}

// ── 3. geometry ────────────────────────────────────────────────────────────
console.log(`  writing geometry to ${dimJobs.length} parts…`);
let n = 0;
for (const j of dimJobs) {
  await setFields(COMPANY, 'order_item', j.id, { thickness_mm: j.t, length_mm: j.a, width_mm: j.b });
  if ((++n % 100) === 0) console.log(`    ${n}/${dimJobs.length}`);
}

const w = await recomputeOrderWeights(COMPANY, order.id);
console.log(`\nweights: ${JSON.stringify(w)}`);
const [rows] = await pool.query(
  `SELECT depth, COUNT(*) n, ROUND(SUM(total_weight)/1000,2) t FROM fab_items
    WHERE company_id=? AND order_id=? AND deleted_at IS NULL AND node_kind='structure'
    GROUP BY depth ORDER BY depth`, [COMPANY, order.id]);
for (const r of rows) console.log(`  d${r.depth}: ${r.n} rows, ${r.t} t`);
await pool.end();
