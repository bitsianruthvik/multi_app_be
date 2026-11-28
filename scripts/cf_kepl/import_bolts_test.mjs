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
 *   6–9. exact sizes only (user, 2026-11-28): a size or class the catalog lacks is a NEW item planned (newItems), never
 *      the nearest size or the selection's default; weights and grip lengths (lib/fastenerItems.js)
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
  // The set now sizes its bolts (M22 x 90, x 125 … class 8.8, from the grip): each takes the catalog set of EXACTLY that size,
  // else a new one is planned (2026-11-28) — never left open, never the nearest size (M22 x 95 is in this catalog).
  ok('…each sized bolt is the exact catalog set or a NEW one planned, never the nearest', rows.every((r) => (r.chosen && r.chosen.name.includes(`M22 x ${SI.boltWanted(r.item).length},`)) || (r.chosen === null && r.make?.name === `HSFG bolt set M22 x ${SI.boltWanted(r.item).length}, class 8.8 (bolt + nut + 2 washers)`)), J(rows.map((r) => [r.mark, r.chosen?.name, r.make?.name])));
  ok('…the quantities are the BOM\'s', total > 0, String(total));

  // 4. A sized bolt is chosen.
  const sized = { ...bom, items: bom.items.map((i) => (i.role === 'bolt' ? { ...i, profile: 'M22 x 95', description: 'HSFG bolt, property class 8.8' } : i)) };
  const p2 = SI.planImport(sized, withBolts);
  ok('4. a bolt the BOM sizes (M22 x 95, class 8.8) gets the catalog bolt set of that size', selRows(p2).length > 0 && selRows(p2).every((r) => r.chosen?.id === 990012), J(selRows(p2).map((r) => r.chosen)));

  // 5. Anchor bolts stay bought.
  ok('5. anchor (holding-down) bolts stay bought', p1.bought.some((b) => /AB$/.test(b.mark)), J(p1.bought.map((b) => b.mark)));

  // 6–9. EXACT SIZES ONLY (user, 2026-11-28): no nearest size, no default — the item of the drawing's size is planned.
  const FI = await imp('apps/cf_erp/lib/fastenerItems.js');
  const longer = { ...bom, items: bom.items.map((i) => (i.role === 'bolt' ? { ...i, profile: 'M22 x 100', description: 'HSFG bolt, property class 8.8' } : i)) };
  const p3 = SI.planImport(longer, withBolts);
  ok('6. M22 x 100 class 8.8 with only M22 x 95 in the catalog: not chosen, a NEW item planned in the Bolt set selection',
    selRows(p3).length > 0 && selRows(p3).every((r) => r.chosen === null && r.make?.name === 'HSFG bolt set M22 x 100, class 8.8 (bolt + nut + 2 washers)')
      && p3.newItems.filter((n) => n.kind === 'bolt').length === 1 && p3.newItems.find((n) => n.kind === 'bolt').selection.id === boltDef.id && p3.newItems.find((n) => n.kind === 'bolt').weightKg === FI.boltSetKg(22, 100), J(p3.newItems));
  const otherClass = { ...bom, items: bom.items.map((i) => (i.role === 'bolt' ? { ...i, profile: 'M24 x 95', description: 'HSFG bolt, property class 8.8' } : i)) };
  ok('7. the right size in another class (M24 x 95 10.9 for 8.8) is not taken: a new 8.8 set is planned',
    SI.planImport(otherClass, withBolts).newItems.filter((n) => n.kind === 'bolt').map((n) => n.name).join() === 'HSFG bolt set M24 x 95, class 8.8 (bolt + nut + 2 washers)');
  ok('8. weights and lengths: M22 x 95 set 0.543 kg (as the catalog), stud 25 x 100 ≈ 0.457 kg, M22 grip 86 → 125, grip 32 → 70',
    FI.boltSetKg(22, 95) === 0.543 && Math.abs(FI.studKg(25, 100) - 0.457) < 0.002 && FI.boltLengthFromGrip(22, 86, [60, 65, 130]) === 125 && FI.boltLengthFromGrip(22, 32) === 70,
    J([FI.boltSetKg(22, 95), FI.studKg(25, 100), FI.boltLengthFromGrip(22, 86), FI.boltLengthFromGrip(22, 32)]));
  const studDef = { id: 990002, code: 'SELST-001', name: 'Shear stud', short_name: null, status: 'active', classification_id: 1, default_flow_id: null, definition_type: 'selection', bom_id: null, bom_status: null };
  const studCat = { ...withBolts, defs: [...withBolts.defs.filter((d) => d.name !== 'Shear stud'), studDef], studs: [{ id: 990021, code: 'STUD-001', name: 'Shear stud 25 dia x 175' }, { id: 990022, code: 'FS-1', name: 'STUDS M25 X 100 MM' }] };
  const studBom = (h) => ({ ...bom, items: [...bom.items, { id: 'STUD', mark: 'STUD', role: 'shear_stud', category: 'bought', description: `Shear stud Ø25 × ${h}`, profile: `stud 25 dia x ${h}`, material: `shear stud 25 dia x ${h}` }],
    assembly: { ...bom.assembly, children: [...(bom.assembly.children ?? []), { item: 'STUD', qtyPerParent: 10 }] } });
  const p4 = SI.planImport(studBom(100), studCat);
  const studRows = p4.rows.filter((r) => r.kind === 'selection' && r.mark === 'STUD');
  ok('9. studs 25 x 100 with only 25 x 175 in the selection: NOT the default, a new "Shear stud 25 dia x 100" planned (a stores "STUDS M25 X 100" is not a shear stud)',
    studRows.length === 1 && studRows[0].chosen === null && studRows[0].make?.name === 'Shear stud 25 dia x 100' && p4.newItems.some((n) => n.name === 'Shear stud 25 dia x 100' && n.kind === 'stud'), J([studRows.map((r) => [r.chosen, r.make]), p4.newItems]));
  const p5 = SI.planImport(studBom(175), studCat);
  ok('…and 25 x 175 studs take STUD-001, nothing new', p5.rows.filter((r) => r.mark === 'STUD').length === 1 && p5.rows.filter((r) => r.mark === 'STUD').every((r) => r.chosen?.id === 990021 && !r.make) && !p5.newItems.some((n) => n.name === 'Shear stud 25 dia x 175'));
} catch (e) { failed += 1; fails.push(`crashed: ${e.message}`); console.log(e); } finally { await pool.end(); }
console.log(`\n${passed} passed, ${failed} failed${fails.length ? `\n  ${fails.join('\n  ')}` : ''}`);
process.exit(failed ? 1 : 0);
