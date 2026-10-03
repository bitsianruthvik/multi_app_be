/**
 * nesting_import_test.mjs — imported nests, the rule check that warns, nest
 * the rest, waste by cause and offcuts (CF_ERP_NESTING_PLAN, "Decided
 * 2026-09-29"), against the local database.
 *
 *   cd multi_app_be && node scripts/cf_kepl/nesting_import_test.mjs
 *
 * ONE TRANSACTION, ROLLED BACK, and the tables it touches are re-counted at
 * the end. IT OWNS ITS FIXTURE: its own plates, cut plates, grades and order,
 * at a thickness (6.321 mm) nothing else in the company has, every name tagged
 * with a run id. It uses the REAL packer, because the verdicts (fits / tight /
 * wont_fit) are the packer's answer on one sheet.
 *
 * Company: CF_NEST_COMPANY (default 2).
 */
import path from 'path';
import { pathToFileURL } from 'url';
import ExcelJS from 'exceljs';

const BE = process.cwd();
const imp = (p) => import(pathToFileURL(path.join(BE, p)).href);
const { pool } = await imp('db.js');
const { attachNodeCache, detachNodeCache } = await imp('apps/cf_erp/lib/db.js');
const N = await imp('apps/cf_erp/services/nestingService.js');
const SS = await imp('apps/cf_erp/services/nestingSheetService.js');

const COMPANY = Number(process.env.CF_NEST_COMPANY ?? 2);
const T = 6.321;

let passed = 0;
let failed = 0;
const fails = [];
function ok(name, cond, detail = '') {
  if (cond) { passed += 1; console.log(`  PASS  ${name}`); }
  else { failed += 1; fails.push(name); console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (name, got, want) => ok(name, Object.is(got, want) || got === want, `got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);
const near = (name, got, want, tol = 1e-6) => ok(name, Math.abs(Number(got) - Number(want)) <= tol, `got ${got}, wanted ${want}`);
const section = (s) => console.log(`\n${s}`);
const some = (xs, re) => (xs ?? []).some((p) => re.test(String(p)));

const COUNTED = [
  'cf_plate_lots', 'cf_nest_placements', 'cf_offcuts', 'cf_master_records', 'cf_item_details',
  'cf_boms', 'cf_bom_lines', 'cf_spec_values', 'cf_spec_options', 'cf_specifications',
  'cf_sales_orders', 'cf_sales_order_lines', 'cf_cut_settings',
];
async function counts(db) {
  const out = {};
  for (const t of COUNTED) { const [[r]] = await db.query(`SELECT COUNT(*) AS n FROM \`${t}\``); out[t] = Number(r.n); }
  return out;
}
const diff = (a, b) => COUNTED.filter((t) => a[t] !== b[t]).map((t) => `${t} ${a[t]}->${b[t]}`);

/* ---- fixture ------------------------------------------------------------- */
async function nodeByCode(db, code) {
  const [[n]] = await db.query('SELECT id FROM cf_classification_nodes WHERE company_id = ? AND code = ? AND deleted_at IS NULL', [COMPANY, code]);
  if (!n) throw new Error(`No ${code} classification node in company ${COMPANY}.`);
  return n.id;
}
async function specByCode(db, code, dataType) {
  const [[s]] = await db.query('SELECT id FROM cf_specifications WHERE company_id = ? AND code = ? AND deleted_at IS NULL', [COMPANY, code]);
  if (s) return s.id;
  const [r] = await db.query('INSERT INTO cf_specifications (company_id, code, name, data_type, status) VALUES (?, ?, ?, ?, \'active\')', [COMPANY, code, code, dataType]);
  return r.insertId;
}
async function option(db, specId, value) {
  const [r] = await db.query('INSERT INTO cf_spec_options (company_id, specification_id, value, status) VALUES (?, ?, ?, \'active\')', [COMPANY, specId, value]);
  return r.insertId;
}
async function makeMaster(db, { code, name, classificationId, itemType, ownerLineId = null }) {
  const [m] = await db.query('INSERT INTO cf_master_records (company_id, record_kind, code, name, classification_id, status) VALUES (?, \'item\', ?, ?, ?, \'active\')', [COMPANY, code, name, classificationId]);
  await db.query('INSERT INTO cf_item_details (master_id, company_id, item_type, tracked_by, uom, sourcing, owner_order_line_id) VALUES (?, ?, ?, \'quantity\', \'nos\', ?, ?)',
    [m.insertId, COMPANY, itemType, itemType === 'temporary' ? 'make' : 'stock', ownerLineId]);
  return m.insertId;
}
async function setVals(db, subjectId, vals) {
  for (const [specId, v] of vals) {
    if (v == null) continue;
    await db.query('INSERT INTO cf_spec_values (company_id, specification_id, subject_type, subject_id, value_number, option_id, value_bool, source) VALUES (?, ?, \'master\', ?, ?, ?, ?, \'entered\')',
      [COMPANY, specId, subjectId, v.kind === 'number' ? v.value : null, v.kind === 'option' ? v.value : null, v.kind === 'bool' ? v.value : null]);
  }
}
async function makeBomLine(db, parentId, childId, quantity, lineNo) {
  let [[bom]] = await db.query('SELECT id FROM cf_boms WHERE company_id = ? AND parent_id = ? AND deleted_at IS NULL', [COMPANY, parentId]);
  if (!bom) { const [b] = await db.query('INSERT INTO cf_boms (company_id, parent_id, bom_type, status) VALUES (?, ?, \'custom\', \'active\')', [COMPANY, parentId]); bom = { id: b.insertId }; }
  const [l] = await db.query('INSERT INTO cf_bom_lines (company_id, bom_id, line_no, child_id, design_id, position, quantity) VALUES (?, ?, ?, ?, ?, ?, ?)', [COMPANY, bom.id, lineNo, childId, childId, lineNo, quantity]);
  return l.insertId;
}

async function buildFixture(db) {
  const tag = `NI${Date.now().toString(36).toUpperCase()}`;
  const plateNode = await nodeByCode(db, 'PLATE');
  const cutNode = await nodeByCode(db, 'CUT_PLATE');
  const spec = {
    THICKNESS: await specByCode(db, 'THICKNESS', 'number'), LENGTH: await specByCode(db, 'LENGTH', 'number'),
    WIDTH: await specByCode(db, 'WIDTH', 'number'), GRADE: await specByCode(db, 'GRADE', 'option'),
    MATERIAL: await specByCode(db, 'MATERIAL', 'option'), DENSITY: await specByCode(db, 'DENSITY', 'number'),
    NEST_MANUAL: await specByCode(db, N.NEST_MANUAL_SPEC_CODE, 'boolean'),
  };
  const GA = `${tag}-GA`;
  const GB = `${tag}-GB`;
  const gA = await option(db, spec.GRADE, GA);
  const gB = await option(db, spec.GRADE, GB);
  const mat = await option(db, spec.MATERIAL, `${tag}-STEEL`);
  const num = (v) => ({ kind: 'number', value: v });
  const size = (t, l, w, g) => [[spec.THICKNESS, num(t)], [spec.LENGTH, num(l)], [spec.WIDTH, num(w)],
    [spec.GRADE, { kind: 'option', value: g }], [spec.MATERIAL, { kind: 'option', value: mat }], [spec.DENSITY, num(7850)]];

  const plate = async (sfx, t, l, w, g) => {
    const id = await makeMaster(db, { code: `${tag}-${sfx}`, name: `Import fixture plate ${sfx}`, classificationId: plateNode, itemType: 'catalog' });
    await setVals(db, id, size(t, l, w, g));
    return id;
  };
  const P1 = await plate('P1', T, 1000, 1000, gA);
  const P2 = await plate('P2', T, 2500, 1250, gA);
  const PB = await plate('PB', T, 2500, 1250, gB);          // same size as P2, other grade
  const PW = await plate('PW', T + 1, 1000, 1000, gA);      // wrong thickness

  const [o] = await db.query('INSERT INTO cf_sales_orders (company_id, code, order_type, title, status) VALUES (?, ?, \'customer\', \'Import fixture\', \'confirmed\')', [COMPANY, `${tag}-SO`]);
  const root = await makeMaster(db, { code: `${tag}-ROOT`, name: 'Import fixture assembly', classificationId: cutNode, itemType: 'temporary' });
  // Frozen (locked_at): nesting lays out a frozen design only (CF_ERP_ORDER_FLOW_PLAN, 2026-09-30).
  const [l] = await db.query('INSERT INTO cf_sales_order_lines (company_id, order_id, line_no, line_type, item_id, design_id, position, quantity, locked_at, lock_position) VALUES (?, ?, 1, \'custom\', ?, ?, 1, 1, NOW(), 1)',
    [COMPANY, o.insertId, root, root]);
  const lineId = l.insertId;
  await db.query('UPDATE cf_item_details SET owner_order_line_id = ? WHERE company_id = ? AND master_id = ?', [lineId, COMPANY, root]);

  const areaLine = {};
  let n = 0;
  const cut = async (sfx, len, wid, g, qty, manual = false) => {
    n += 1;
    const id = await makeMaster(db, { code: `${tag}-${sfx}`, name: `Import fixture ${sfx}`, classificationId: cutNode, itemType: 'temporary', ownerLineId: lineId });
    await setVals(db, id, size(T, len, wid, g));
    if (manual) await setVals(db, id, [[spec.NEST_MANUAL, { kind: 'bool', value: 1 }]]);
    await makeBomLine(db, root, id, qty, n);
    areaLine[id] = await makeBomLine(db, id, g === gB ? PB : P2, (len * wid) / (2500 * 1250), 1);
    return id;
  };
  const C1 = await cut('C1', 600, 600, gA, 3);
  const C2 = await cut('C2', 400, 300, gA, 6);
  const C3 = await cut('C3', 400, 300, gB, 2);
  const CM = await cut('CM', 250, 200, gA, 2, true);
  return { tag, GA, GB, lineId, orderId: o.insertId, P1, P2, PB, PW, C1, C2, C3, CM, areaLine };
}

/** A Nests workbook: header then rows, as base64. */
async function workbook(rows, { header = ['Nest', 'Plate', 'Cut plate', 'Qty', 'Grade'], title = true } = {}) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Nests');
  if (title) ws.addRow(['Nests from the other program']);
  ws.addRow(header);
  for (const r of rows) ws.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer()).toString('base64');
}

async function lotRows(db, lineId) {
  const [rows] = await db.query(
    `SELECT l.*, (SELECT COUNT(*) FROM cf_nest_placements p WHERE p.plate_lot_id = l.id AND p.deleted_at IS NULL) AS pieces,
            (SELECT COUNT(*) FROM cf_nest_placements p WHERE p.plate_lot_id = l.id AND p.deleted_at IS NULL AND p.x_mm IS NULL) AS unlaid,
            (SELECT COUNT(*) FROM cf_offcuts f WHERE f.plate_lot_id = l.id AND f.deleted_at IS NULL) AS offcuts
       FROM cf_plate_lots l WHERE l.company_id = ? AND l.order_line_id = ? AND l.deleted_at IS NULL ORDER BY l.lot_no`,
    [COMPANY, lineId],
  );
  return rows;
}

/* ---- run ----------------------------------------------------------------- */
const before = await counts(pool);
const conn = await pool.getConnection();
try {
  await conn.beginTransaction();
  attachNodeCache(conn);
  const c = { companyId: COMPANY, userId: null };

  section('Fixture');
  const fx = await buildFixture(conn);
  const code = (id) => `${fx.tag}-${{ [fx.C1]: 'C1', [fx.C2]: 'C2', [fx.C3]: 'C3', [fx.CM]: 'CM' }[id]}`;
  console.log(`  ${fx.tag}: line ${fx.lineId}`);

  /* ---- 1. the pure pieces -------------------------------------------------- */
  section('1. Sizes and numbers are read forgivingly');
  eq('"12 x 2500 x 1250"', JSON.stringify(SS.parseSize('12 x 2500 x 1250')), '[12,2500,1250]');
  eq('"12×2,500×1,250 mm"', JSON.stringify(SS.parseSize('12×2,500×1,250 mm')), '[12,2500,1250]');
  eq('"12*2500*1250"', JSON.stringify(SS.parseSize('12*2500*1250')), '[12,2500,1250]');
  eq('"12.5X600X300"', JSON.stringify(SS.parseSize('12.5X600X300')), '[12.5,600,300]');
  eq('a decimal comma "12,5"', SS.parseNumber('12,5'), 12.5);
  eq('two numbers is not a size', SS.parseSize('600 x 300'), null);
  eq('a code is not a size', SS.parseSize('CP-001'), null);
  eq('offcuts are lettered A…Z, AA', [0, 25, 26].map(N.offcutLetters).join(' '), 'A Z AA');

  /* ---- 2. fits / tight / wont_fit, and force ------------------------------- */
  section('2. An import is checked: fits, tight, won\'t fit — and needs force to save');
  const f1 = await workbook([
    ['N1', `${fx.tag}-P2`, code(fx.C2), 6, ''],
    ['', '', code(fx.CM), 2, ''],                                     // continuation; NEST_MANUAL on an imported nest
    ['N2', `${fx.tag}-P1`, code(fx.C1), 2, ''],                       // two 600x600 on 1000x1000: area yes, layout no
    ['N3', `${fx.tag}-P1`, code(fx.C1), 3, ''],                       // three: not even the area
    ['N4', `${fx.tag}-PW`, code(fx.C2), 1, ''],                       // wrong thickness
  ]);
  const beforeDry = await counts(conn);
  const dry = await SS.importSheet(conn, c, fx.lineId, { file: f1, filename: 'other.xlsx', dryRun: true });
  ok('a dry run writes nothing', diff(beforeDry, await counts(conn)).length === 0, diff(beforeDry, await counts(conn)).join(', '));
  eq('no cell problems', dry.problems.length, 0);
  ok('four nests', dry.nests.length === 4, JSON.stringify(dry.nests.map((x) => x.nestNo)));
  const v = Object.fromEntries(dry.nests.map((x) => [x.nestNo, x]));
  eq('N1 fits', v.N1?.verdict, 'fits');
  eq('…and has our layout', v.N1?.hasLayout, true);
  eq('N2 is tight', v.N2?.verdict, 'tight');
  ok('…and says their program may manage it', some(v.N2?.reasons, /room in principle/), JSON.stringify(v.N2?.reasons));
  eq('N3 won\'t fit', v.N3?.verdict, 'wont_fit');
  ok('…because the area is not there', some(v.N3?.reasons, /cannot all fit/), JSON.stringify(v.N3?.reasons));
  eq('N4 won\'t fit', v.N4?.verdict, 'wont_fit');
  ok('…and names the thickness', some(v.N4?.reasons, /mm and .* mm, so it cannot be cut/), JSON.stringify(v.N4?.reasons));
  ok('N1\'s items are the two cut plates, the continuation row joined it', JSON.stringify(v.N1?.items) === JSON.stringify([{ cutPlateCode: code(fx.C2), qty: 6 }, { cutPlateCode: code(fx.CM), qty: 2 }]), JSON.stringify(v.N1?.items));
  const cov = Object.fromEntries(dry.coverage.map((x) => [x.cutPlateCode, x]));
  eq('C1 is over: 5 nested of 3', cov[code(fx.C1)]?.diff, 2);
  eq('C2 is over by the one on N4', cov[code(fx.C2)]?.diff, 1);
  eq('C3 is short', cov[code(fx.C3)]?.diff, -2);
  eq('can be saved (no cell problems)', dry.canSave, true);
  eq('but needs force', dry.needsForce, true);
  eq('and a dry run applies nothing', dry.applied, false);
  ok('waste on the preview is the split by cause', dry.nests.every((x) => ['kerf', 'sequenceGaps', 'rim', 'offcut', 'wastage'].every((k) => typeof x.waste?.[k] === 'number')), JSON.stringify(v.N1?.waste));

  const noForce = await SS.importSheet(conn, c, fx.lineId, { file: f1, filename: 'other.xlsx' });
  eq('saving without force is not applied', noForce.applied, false);
  ok('…and says why', /save anyway/i.test(noForce.message), noForce.message);
  eq('…and wrote nothing', (await lotRows(conn, fx.lineId)).length, 0);

  const forced = await SS.importSheet(conn, c, fx.lineId, { file: f1, filename: 'other.xlsx', force: true });
  eq('with force it is applied', forced.applied, true);
  eq('four lots', forced.saved?.lots, 4);
  eq('pieces = 8 + 2 + 3 + 1', forced.saved?.pieces, 14);
  const lots1 = Object.fromEntries((await lotRows(conn, fx.lineId)).map((r) => [r.lot_no, r]));
  eq('lots keep the sheet\'s nest labels', Object.keys(lots1).sort().join(' '), 'N1 N2 N3 N4');
  ok('every lot is imported', Object.values(lots1).every((r) => r.origin === 'imported'));
  eq('N1 fits and was not forced', `${lots1.N1.check_verdict}/${lots1.N1.forced}`, 'fits/0');
  eq('N2 tight, forced', `${lots1.N2.check_verdict}/${lots1.N2.forced}`, 'tight/1');
  eq('N3 won\'t fit, forced', `${lots1.N3.check_verdict}/${lots1.N3.forced}`, 'wont_fit/1');
  eq('N1\'s placements carry our x/y', Number(lots1.N1.unlaid), 0);
  eq('N2\'s placements have NULL x/y — on the plate, no layout', Number(lots1.N2.unlaid), Number(lots1.N2.pieces));
  ok('every lot has waste_json', Object.values(lots1).every((r) => r.waste_json != null));
  ok('N1 has offcuts (a big plate, little on it)', Number(lots1.N1.offcuts) > 0, String(lots1.N1.offcuts));
  eq('a lot without a layout claims no offcuts', Number(lots1.N2.offcuts), 0);
  const [offs] = await conn.query('SELECT offcut_no, area_mm2, weight_kg, rect_length_mm, rect_width_mm, rect_x_mm, bbox_x_mm, outline_json FROM cf_offcuts WHERE company_id = ? AND plate_lot_id = ? AND deleted_at IS NULL ORDER BY offcut_no', [COMPANY, lots1.N1.id]);
  eq('offcuts are numbered <lot>-A upwards', offs[0]?.offcut_no, 'N1-A');
  ok('each is at least 300 x 300 of area and 100 across', offs.every((o) => Number(o.area_mm2) >= 90000 - 1e-6 && Math.min(Number(o.rect_length_mm), Number(o.rect_width_mm)) >= 100 - 1e-6));
  near('weight from density: area x thickness x 7850', Number(offs[0]?.weight_kg), Number(offs[0]?.area_mm2) / 1e6 * (T / 1000) * 7850, 0.002);
  ok('rect and bbox corners are stored', offs[0]?.rect_x_mm != null && offs[0]?.bbox_x_mm != null);
  ok('the outline is stored', Array.isArray(typeof offs[0]?.outline_json === 'string' ? JSON.parse(offs[0].outline_json) : offs[0]?.outline_json));

  section('2b. The saved plan reads back with the contract\'s per-lot fields');
  const g1 = await N.getNesting(conn, COMPANY, fx.lineId);
  const nests1 = Object.fromEntries(g1.groups.flatMap((g) => g.nests).map((x) => [x.lotNo, x]));
  eq('origin', nests1.N2?.origin, 'imported');
  eq('verdict', nests1.N2?.verdict, 'tight');
  eq('forced', nests1.N2?.forced, true);
  ok('reasons', some(nests1.N2?.reasons, /room in principle/));
  eq('hasLayout false without a layout', nests1.N2?.hasLayout, false);
  eq('hasLayout true with one', nests1.N1?.hasLayout, true);
  ok('pieces without a layout read back as null x/y', nests1.N2?.pieces.every((p) => p.x === null && p.y === null));
  ok('offcuts read back with rect, bbox and outline', nests1.N1?.offcuts?.length > 0 && nests1.N1.offcuts.every((o) => o.offcutNo && o.rect?.x != null && o.bbox?.length > 0 && Array.isArray(o.outline)));
  // THE IDENTITY: parts + every cause of waste = the plate, to the mm².
  const identity = (x) => x.usedArea + Object.values(x.waste).reduce((a, b) => a + b, 0) - x.sheetArea;
  ok('parts + kerf + gaps + rim + offcut + wastage = the plate, on a laid-out lot', Math.abs(identity(nests1.N1)) <= 1, String(identity(nests1.N1)));
  ok('…and on a lot without a layout that is not over-full', Math.abs(identity(nests1.N2)) <= 1, String(identity(nests1.N2)));
  ok('wasteKg is the same split in kilograms', ['kerf', 'rim', 'offcut', 'wastage'].every((k) => typeof nests1.N1.wasteKg[k] === 'number'));
  const sumOver = (k) => g1.groups.flatMap((g) => g.nests).reduce((a, x) => a + x.waste[k], 0);
  near('line totals sum the lots\' waste', g1.totals.waste.wastage, sumOver('wastage'), 0.01);
  near('…offcut too', g1.totals.waste.offcut, sumOver('offcut'), 0.01);
  eq('the line knows what is imported', g1.imported.lots, 4);

  /* ---- 3. cell problems block ---------------------------------------------- */
  section('3. Cells that cannot be read block the save, all listed at once');
  const bad = await SS.importSheet(conn, c, fx.lineId, {
    file: await workbook([
      ['B1', `${fx.tag}-P2`, `${T} x 400 x 300`, 1, ''],            // matches C2 AND C3 — which?
      ['B2', `${fx.tag}-NOPE`, code(fx.C2), 1, ''],                   // no such plate
      ['B3', `${fx.tag}-P2`, 'NOT-A-CODE', 1, ''],                    // no such cut plate
      ['B4', `${fx.tag}-P2`, code(fx.C2), '2.5', ''],                 // not a whole number
      ['B5', `${T} x 2500 x 1250`, code(fx.C2), 1, ''],               // plate by size, grade from the cut plate
    ]),
    force: true,
  });
  eq('not applied, even with force', bad.applied, false);
  eq('cannot be saved', bad.canSave, false);
  ok('the ambiguous size says to add the grade', some(bad.problems, /matches 2 cut plates.*Grade/), JSON.stringify(bad.problems));
  ok('the unknown plate is named', some(bad.problems, /NOPE" is not a catalog plate code/));
  ok('the unknown cut plate is named', some(bad.problems, /NOT-A-CODE/));
  ok('the fractional quantity is named', some(bad.problems, /2\.5 — a quantity is a whole number/));
  ok('problems name the sheet row', some(bad.problems, /^Nests row \d+/));
  ok('the nests that did read are still checked (plate by size, P2 over PB by the cut plate\'s grade)', bad.nests.some((x) => x.nestNo === 'B5' && x.plateCode === `${fx.tag}-P2`), JSON.stringify(bad.nests.map((x) => [x.nestNo, x.plateCode])));
  eq('and the earlier import is untouched', (await lotRows(conn, fx.lineId)).length, 4);

  /* ---- 4. code and size matching; short coverage; nest the rest ------------ */
  section('4. Matched by code or size, short is fine, then nest the rest');
  const f2 = await workbook([
    ['Nest A', `${T} × 2,500 × 1,250 mm`, `  ${code(fx.C2).toLowerCase()} `, '4', ''],   // plate by size; code with spaces and case
    [null, null, `${T}*600*600`, 1, fx.GA.toLowerCase()],                                 // cut plate by size + grade; continuation
  ], { title: false });
  const imp2 = await SS.importSheet(conn, c, fx.lineId, { file: f2, filename: 'part.xlsx' });
  eq('no problems', imp2.problems.length, 0, JSON.stringify(imp2.problems));
  eq('one nest, it fits, so no force is needed', `${imp2.nests.length}/${imp2.nests[0]?.verdict}/${imp2.needsForce}`, '1/fits/false');
  eq('the size picked the grade-A plate, not the same-size grade-B one', imp2.nests[0]?.plateCode, `${fx.tag}-P2`);
  ok('the cut plates matched by code and by size', JSON.stringify(imp2.nests[0]?.items) === JSON.stringify([{ cutPlateCode: code(fx.C2), qty: 4 }, { cutPlateCode: code(fx.C1), qty: 1 }]), JSON.stringify(imp2.nests[0]?.items));
  eq('saved without force', imp2.applied, true);
  eq('SAVING REPLACES EVERY LOT: the four earlier ones are gone', imp2.saved?.replacedLots, 4);
  const cov2 = Object.fromEntries(imp2.coverage.map((x) => [x.cutPlateCode, x.diff]));
  eq('C1 short by 2, C2 by 2, C3 by 2', [cov2[code(fx.C1)], cov2[code(fx.C2)], cov2[code(fx.C3)]].join(' '), '-2 -2 -2');
  const [[c3q]] = await conn.query('SELECT quantity FROM cf_bom_lines WHERE id = ?', [fx.areaLine[fx.C3]]);
  near('a cut plate on no nest goes back to its area fraction', Number(c3q.quantity), (400 * 300) / (2500 * 1250), 1e-6);

  // §44: a line's nesting must be told which plates it may use before it runs.
  await conn.query("UPDATE cf_sales_order_lines SET nest_plates = 'any' WHERE company_id = ? AND id IN (?)", [COMPANY, [fx.lineId]]);
  const rest = await N.planNesting(conn, COMPANY, fx.lineId, { effort: 'quick', seed: 3 });
  const restPieces = (id) => rest.groups.flatMap((g) => g.nests).reduce((a, x) => a + x.pieces.filter((p) => p.cutPlateId === id).length, 0);
  eq('the plan knows about the imported nest', rest.imported.lots, 1);
  eq('it asks only for the rest of C1 (3 - 1)', restPieces(fx.C1), 2);
  eq('…of C2 (6 - 4)', restPieces(fx.C2), 2);
  eq('…all of C3', restPieces(fx.C3), 2);
  eq('NEST_MANUAL stays out of automatic nesting', restPieces(fx.CM), 0);
  ok('its lots do not take the imported lot\'s number', rest.groups.flatMap((g) => g.nests).every((x) => x.lotNo !== 'Nest A' && /^N-\d{3}$/.test(x.lotNo)));
  ok('proposed nests carry origin, waste, wasteKg and offcuts', rest.groups.flatMap((g) => g.nests).every((x) => x.origin === 'auto' && x.hasLayout === true && typeof x.waste.wastage === 'number' && Array.isArray(x.offcuts)));
  const acc = await N.acceptNesting(conn, c, fx.lineId, rest);
  eq('accepting kept the imported lot', acc.keptImportedLots, 1);
  eq('and replaced no automatic lot (there were none)', acc.replacedLots, 0);
  const lots2 = await lotRows(conn, fx.lineId);
  eq('one imported + the automatic ones', lots2.filter((r) => r.origin === 'imported').length, 1);
  ok('automatic lots got waste_json', lots2.filter((r) => r.origin === 'auto').every((r) => r.waste_json != null));
  ok('and offcut rows where there is free steel', lots2.filter((r) => r.origin === 'auto').some((r) => Number(r.offcuts) > 0), JSON.stringify(lots2.map((r) => [r.lot_no, r.offcuts])));
  const g2 = await N.getNesting(conn, COMPANY, fx.lineId);
  ok('now every non-manual cut plate is covered exactly', g2.coverage.filter((x) => !x.manual).every((x) => x.diff === 0), JSON.stringify(g2.coverage));
  eq('and nothing has drifted', g2.drift.length, 0, JSON.stringify(g2.drift));
  // The steel balances: what the BOM asks for is exactly the plates opened,
  // imported and automatic together.
  const plateArea = new Map(g2.groups.flatMap((g) => g.nests).map((x) => [x.plateItemId, x.length * x.width]));
  const asked = acc.quantities.reduce((a, q) => a + q.quantity * q.blanks * plateArea.get(q.plateItemId), 0);
  const bought = g2.groups.flatMap((g) => g.nests)
    .filter((x) => x.pieces.some((p) => p.cutPlateId !== fx.CM))
    .reduce((a, x) => a + x.length * x.width, 0);
  near('the steel balances across imported and automatic lots', asked, bought, bought * 1e-5);

  section('4b. Accepting again keeps the imported nest');
  const again = await N.acceptNesting(conn, c, fx.lineId, rest);
  eq('the automatic lots are replaced', again.replacedLots, acc.lots);
  eq('the imported one is kept', again.keptImportedLots, 1);
  eq('same number of live lots', (await lotRows(conn, fx.lineId)).length, lots2.length);
  const [[deadOff]] = await conn.query('SELECT COUNT(*) AS n FROM cf_offcuts f JOIN cf_plate_lots l ON l.id = f.plate_lot_id WHERE f.company_id = ? AND l.order_line_id = ? AND l.deleted_at IS NOT NULL AND f.deleted_at IS NULL', [COMPANY, fx.lineId]);
  eq('offcuts of replaced lots are soft-deleted with them', Number(deadOff.n), 0);

  section('4c. A full automatic plan over an import is refused — unless it replaces it');
  let refused = null;
  const full = await N.planNesting(conn, COMPANY, fx.lineId, { effort: 'quick', seed: 3, replaceImported: true });
  try { await N.acceptNesting(conn, c, fx.lineId, full); } catch (e) { refused = e; }
  ok('refused: the imported nest already holds some of it', (refused?.problems ?? []).length > 0, refused?.message);
  const replacedAll = await N.acceptNesting(conn, c, fx.lineId, { ...full, replaceImported: true });
  eq('with replaceImported, no imported lot is kept', replacedAll.keptImportedLots, 0);
  eq('and every lot is automatic', (await lotRows(conn, fx.lineId)).filter((r) => r.origin === 'imported').length, 0);

  /* ---- 5. guards ------------------------------------------------------------ */
  section('5. The guards: a closed order cannot take an import');
  await conn.query('SAVEPOINT g');
  await conn.query('UPDATE cf_sales_orders SET status = \'closed\' WHERE id = ?', [fx.orderId]);
  const closed = await SS.importSheet(conn, c, fx.lineId, { file: f2, filename: 'part.xlsx' });
  eq('not applied', closed.applied, false);
  ok('and it says the order is closed', some(closed.problems, /closed/), JSON.stringify(closed.problems));
  await conn.query('ROLLBACK TO SAVEPOINT g');

  await conn.rollback();
  console.log('\nrolled back.');
} catch (err) {
  try { await conn.rollback(); } catch { /* the original error matters */ }
  failed += 1;
  fails.push('the run itself');
  console.error('\nTHREW:', err.code ?? '', err.message);
  if (err.problems) console.error('problems:', err.problems);
  console.error(err.stack?.split('\n').slice(1, 6).join('\n'));
} finally {
  detachNodeCache(conn);
  conn.release();
}

section('6. Nothing survived the rollback');
const left = diff(before, await counts(pool));
ok('every table is back to the count it started at', left.length === 0, left.join(', '));
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) console.log(`failed: ${fails.join(' · ')}`);
await pool.end();
process.exitCode = failed ? 1 : 0;
