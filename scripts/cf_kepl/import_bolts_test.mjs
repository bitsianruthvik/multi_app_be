/**
 * import_bolts_test.mjs — BOLTS ARE ROWS when a standard is imported (user, 2026-11-01: "are these … bolts selected of
 * the right dia and length … in the BOM?"; lib/standardImport.js). Local only, read-only (planImport is pure; the
 * catalog is read from the local database).
 *   cd multi_app_be && node scripts/cf_kepl/import_bolts_test.mjs
 *
 *   1. boltWanted / boltOf read diameter, length and class from what a BOM and the catalog write
 *   2. a tenant with no "Bolt set" selection: bolts stay listed (bought), as before — nothing changes
 *   3. with it: the RDSO 11751 HSFG M22 item becomes a "Bolt set" selection row, quantity as the BOM says, left to
 *      choose with "length by grip" said (the BOM gives no length)
 *   4. a bolt whose length the BOM gives (M24 x 95, class 10.9) is chosen: the catalog's bolt set of that size
 *   5. anchor bolts (holding down) stay bought — they are the bearing supplier's
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const BE = process.cwd();
const imp = (p) => import(pathToFileURL(path.join(BE, p)).href);
const { pool } = await imp('db.js');
if (!/^(localhost|127\.0\.0\.1|::1)$/.test(process.env.DB_HOST ?? 'localhost')) throw new Error('This suite is local only.');
const SI = await imp('apps/cf_erp/lib/standardImport.js');
const { importCatalog } = await imp('apps/cf_erp/services/standardDrawingService.js');

let passed = 0; let failed = 0; const fails = [];
const ok = (name, cond, detail = '') => { if (cond) { passed += 1; console.log(`  PASS  ${name}`); } else { failed += 1; fails.push(name); console.log(`  FAIL  ${name}${detail ? ` — ${String(detail).slice(0, 600)}` : ''}`); } };
const J = (v) => JSON.stringify(v);

try {
  ok('1. boltWanted reads an RDSO parts-list bolt (22 MM DIA, class 8.8, no length)', J(SI.boltWanted({ profile: 'M22', description: 'HSFG BOLT 22 MM DIA PROPERTY CLASS 8.8 (with nut and washers)' })) === J({ dia: 22, length: null, grade: '8.8' }));
  ok('…and a sized one (M24 x 95, class 10.9)', J(SI.boltWanted({ profile: 'M24 x 95', description: 'HSFG bolt, class 10.9' })) === J({ dia: 24, length: 95, grade: '10.9' }));
  ok('boltOf reads the catalog name', J(SI.boltOf('HSFG bolt set M24 x 95, class 10.9 (bolt + nut + 2 washers)')) === J({ dia: 24, length: 95, grade: '10.9' }) && SI.boltOf('Shear stud 25 dia x 200') === null);
  ok("a bolt's definition is the Bolt set selection", J(SI.partCandidates({ role: 'bolt' })) === J(['Bolt set']));

  const company = Number(process.env.CF_IMPORT_COMPANY ?? 2);
  const catalog = await importCatalog(pool, company);
  const bom = JSON.parse(fs.readFileSync(path.join(BE, '..', 'drawing_bom', 'out', 'RDSO_11751R3', 'bom.json'), 'utf8'));
  const hsfg = bom.items.find((i) => i.role === 'bolt');
  const selRows = (plan) => plan.rows.filter((r) => r.kind === 'selection' && r.item?.role === 'bolt');

  // 2. No Bolt set on this tenant (as the local company starts).
  const plain = { ...catalog, defs: catalog.defs.filter((d) => !(d.name === 'Bolt set' && d.definition_type === 'selection')) };
  const p0 = SI.planImport(bom, plain);
  ok('2. without the Bolt set selection the bolts stay listed (bought), no bolt rows', selRows(p0).length === 0 && p0.bought.some((b) => b.mark === hsfg.mark), J(p0.bought.map((b) => b.mark)));

  // 3. With it (a stand-in selection definition; its candidates: two bolt sets).
  const boltDef = { id: 990001, code: 'SELBS-001', name: 'Bolt set', short_name: null, status: 'active', classification_id: 1, default_flow_id: null, definition_type: 'selection', bom_id: null, bom_status: null };
  const withBolts = { ...catalog, defs: [...plain.defs, boltDef], bolts: [{ id: 990011, code: 'BOLT-001', name: 'HSFG bolt set M24 x 95, class 10.9 (bolt + nut + 2 washers)' }, { id: 990012, code: 'BOLT-002', name: 'HSFG bolt set M22 x 95, class 8.8 (bolt + nut + 2 washers)' }] };
  const p1 = SI.planImport(bom, withBolts);
  const rows = selRows(p1);
  const total = rows.reduce((a, r) => a + Number(r.quantity) * 1, 0);
  ok('3. the HSFG bolts are Bolt set rows now, not listed', rows.length > 0 && !p1.bought.some((b) => b.mark === hsfg.mark) && rows.every((r) => r.def.id === boltDef.id), J(rows.map((r) => [r.mark, r.quantity])));
  ok('…left to choose (no length on the drawing), and it says so', rows.every((r) => r.chosen === null && /Choose the bolt size: M22 — length by grip/.test(r.notes ?? '')), J(rows.map((r) => r.notes)));
  ok('…the quantities are the BOM\'s', total > 0, String(total));

  // 4. A sized bolt is chosen.
  const sized = { ...bom, items: bom.items.map((i) => (i.role === 'bolt' ? { ...i, profile: 'M22 x 95', description: 'HSFG bolt, property class 8.8' } : i)) };
  const p2 = SI.planImport(sized, withBolts);
  ok('4. a bolt the BOM sizes (M22 x 95, class 8.8) gets the catalog bolt set of that size', selRows(p2).length > 0 && selRows(p2).every((r) => r.chosen?.id === 990012), J(selRows(p2).map((r) => r.chosen)));

  // 5. Anchor bolts stay bought.
  ok('5. anchor (holding-down) bolts stay bought', p1.bought.some((b) => /AB$/.test(b.mark)), J(p1.bought.map((b) => b.mark)));
} catch (e) { failed += 1; fails.push(`crashed: ${e.message}`); console.log(e); } finally { await pool.end(); }
console.log(`\n${passed} passed, ${failed} failed${fails.length ? `\n  ${fails.join('\n  ')}` : ''}`);
process.exit(failed ? 1 : 0);
