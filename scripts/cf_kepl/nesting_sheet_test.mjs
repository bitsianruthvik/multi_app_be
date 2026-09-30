/**
 * nesting_sheet_test.mjs — the nesting Excel sheet at QUANTITY level (decided
 * 2026-09-29): Nest | Plate | Cut plate | Qty | Grade, then read-only Verdict
 * and Notes; a Needed tab; a How to use this tab. Against the local database.
 *
 *   cd multi_app_be && node scripts/cf_kepl/nesting_sheet_test.mjs
 *
 * ONE TRANSACTION, ROLLED BACK, tables re-counted at the end. IT OWNS ITS
 * FIXTURE (thickness 6.123 mm, every name tagged with a run id). It posts REAL
 * .xlsx buffers — the export's own bytes, and workbooks built the way another
 * nesting program's export looks (other header names, a title above the
 * header, blank rows). The verdicts, force and nest-the-rest are
 * nesting_import_test's; this suite is about the file.
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
const T = 6.123;

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
  const tag = `NS${Date.now().toString(36).toUpperCase()}`;
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
async function readBook(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const sheet = (name) => {
    const ws = wb.getWorksheet(name);
    if (!ws) return null;
    const rows = [];
    ws.eachRow({ includeEmpty: false }, (r) => { rows.push(r.values.slice(1).map((v) => (v && typeof v === 'object' && 'result' in v ? v.result : v))); });
    return rows;
  };
  return { wb, names: wb.worksheets.map((w) => w.name), sheet };
}

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

  /* ---- 1. an empty line's workbook ---------------------------------------- */
  section('1. Download on a line with nothing nested: three tabs, the Needed tab filled');
  const beforeGet = await counts(conn);
  const empty = await SS.exportSheet(conn, COMPANY, fx.lineId);
  ok('a look is a look — downloading wrote nothing', diff(beforeGet, await counts(conn)).length === 0);
  ok('it is a workbook', empty.buffer[0] === 0x50 && empty.buffer[1] === 0x4b);
  eq('no nest rows yet', empty.rows, 0);
  eq('and it says nothing is saved', empty.saved, false);
  ok('the file name names the order and line', /^NESTS_.*_L1\.xlsx$/.test(empty.filename), empty.filename);
  const b0 = await readBook(empty.buffer);
  eq('tabs: Nests, Needed, How to use this', b0.names.join(' | '), 'Nests | Needed | How to use this');
  const nests0 = b0.sheet('Nests');
  ok('row 1 is the banner: saving replaces every nest', /SAVING AN UPLOAD REPLACES EVERY NEST/.test(String(nests0[0][0])), String(nests0[0][0]));
  eq('row 2 is the header', nests0[1].slice(0, 5).join(' | '), 'Nest | Plate | Cut plate | Qty | Grade');
  ok('Verdict and Notes say they are not read back', /not read back/.test(String(nests0[1][5])) && /not read back/.test(String(nests0[1][6])));
  const needed0 = b0.sheet('Needed');
  eq('Needed header', needed0[0].join(' | '), 'Cut plate | Thickness (mm) | Length (mm) | Width (mm) | Grade | Needed | Nested | Left');
  const needRow = (rows, id) => rows.find((r) => r[0] === code(id));
  eq('C2: 400 x 300, needed 6, nested 0, left 6', JSON.stringify(needRow(needed0, fx.C2)?.slice(1)), JSON.stringify([T, 400, 300, fx.GA, 6, 0, 6]));
  ok('the hand-held cut plate is listed too (it may go on an imported nest)', !!needRow(needed0, fx.CM));
  ok('How to use this explains plate and cut plate by size', b0.sheet('How to use this').some((r) => /thickness x length x width/.test(String(r[1] ?? ''))));

  /* ---- 2. the other program's file ----------------------------------------- */
  section('2. Another program\'s export: other header names, a title, blank rows');
  const other = await workbook([
    ['Sheet 1', `${fx.tag}-P2`, code(fx.C2), 6],
    [null, null, null, null],                                   // a blank row between nests
    ['Sheet 2', `${fx.tag}-P1`, `${T} x 600 x 600`, 1],
  ], { header: ['Nest No.', 'Stock Plate', 'Part Name', 'Quantity'] });
  const o1 = await SS.importSheet(conn, c, fx.lineId, { file: `data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,${other}`, filename: 'other.xlsx', dryRun: true });
  eq('the headers were understood', o1.problems.length, 0, JSON.stringify(o1.problems));
  eq('two nests', o1.nests.length, 2);
  eq('a data: URL prefix is taken off the base64', o1.nests[0]?.nestNo, 'Sheet 1');
  ok('the response has the contract\'s keys', ['applied', 'canSave', 'needsForce', 'problems', 'nests', 'coverage'].every((k) => k in o1));
  ok('each nest has the contract\'s keys', o1.nests.every((n) => ['nestNo', 'plateCode', 'plateLabel', 'items', 'verdict', 'reasons', 'waste', 'hasLayout'].every((k) => k in n)));
  ok('coverage rows have the contract\'s keys', o1.coverage.every((x) => ['cutPlateCode', 'needed', 'nested', 'diff'].every((k) => k in x)));

  /* ---- 3. what is wrong in the cells --------------------------------------- */
  section('3. Cell problems, all at once');
  const bad = await SS.importSheet(conn, c, fx.lineId, {
    file: await workbook([
      [null, `${fx.tag}-P2`, code(fx.C2), 1, ''],                   // no nest and none above
      ['X1', `${fx.tag}-P2`, code(fx.C2), 1, ''],
      ['X1', `${fx.tag}-P1`, code(fx.C1), 1, ''],                   // a second plate on the same nest
      ['X2', null, code(fx.C2), 1, ''],                             // a nest that never says its plate
      ['X3', `${fx.tag}-P2`, code(fx.C2), '', ''],                  // no quantity
      ['X4', `${fx.tag}-P2`, code(fx.C2), 'lots', ''],              // not a number
      ['X5', `${fx.tag}-P2`, code(fx.C2), 1, fx.GB],                // the code's grade contradicts the Grade column
      ['X6', `${fx.tag}-P2`, `${T} x 999 x 999`, 1, ''],            // a size that matches nothing
    ]),
    dryRun: true,
  });
  eq('cannot be saved', bad.canSave, false);
  ok('a row with no nest and nothing above', some(bad.problems, /no Nest, and there is no nest above/), JSON.stringify(bad.problems));
  ok('two plates on one nest', some(bad.problems, /nest X1 is given two plates/));
  ok('a nest with no plate', some(bad.problems, /nest X2 does not say which plate/));
  ok('no quantity', some(bad.problems, /has no quantity/));
  ok('not a number', some(bad.problems, /"lots" is not a number/));
  ok('the grade contradicts the code', some(bad.problems, /is .*GA, not .*GB/));
  ok('a size that matches nothing', some(bad.problems, /no cut plate of this line is 6\.123 x 999 x 999/));

  const nothing = await SS.importSheet(conn, c, fx.lineId, { file: await workbook([]), dryRun: true });
  ok('an empty Nests tab is a problem, not a silent "nothing"', some(nothing.problems, /has no nests on it/), JSON.stringify(nothing.problems));
  let wrong = null;
  try { await SS.importSheet(conn, c, fx.lineId, { file: await workbook([['a', 'b']], { header: ['Foo', 'Bar'] }) }); } catch (e) { wrong = e; }
  eq('a workbook with no Nest / Cut plate / Qty columns is refused', wrong?.code, 'WRONG_SHEET');
  let csv = null;
  try { await SS.importSheet(conn, c, fx.lineId, { file: Buffer.from('Nest,Plate\n1,2\n').toString('base64') }); } catch (e) { csv = e; }
  eq('a file that is not .xlsx is refused', csv?.code, 'BAD_FILE');
  let none = null;
  try { await SS.importSheet(conn, c, fx.lineId, {}); } catch (e) { none = e; }
  eq('no file at all', none?.code, 'NO_FILE');

  /* ---- 4. save, download, upload the same bytes ----------------------------- */
  section('4. Save, download, and the downloaded bytes come back as the same nests');
  const f = await workbook([
    ['A', `${fx.tag}-P2`, code(fx.C2), 6, ''],
    ['', '', code(fx.C1), 1, ''],
    ['B', `${fx.tag}-PB`, code(fx.C3), 2, ''],
  ]);
  const saved = await SS.importSheet(conn, c, fx.lineId, { file: f, filename: 'mine.xlsx' });
  eq('saved', saved.applied, true);
  const out = await SS.exportSheet(conn, COMPANY, fx.lineId);
  eq('three rows: one per cut plate per nest', out.rows, 3);
  eq('two nests', out.lots, 2);
  eq('it is the saved plan', out.saved, true);
  const b1 = await readBook(out.buffer);
  const rows1 = b1.sheet('Nests').slice(2);
  eq('A\'s first row carries plate, cut plate, qty and the verdict', JSON.stringify(rows1[0].slice(0, 4).concat(rows1[0][5])), JSON.stringify(['A', `${fx.tag}-P2`, code(fx.C2), 6, 'Fits']));
  const need1 = b1.sheet('Needed').slice(1);
  eq('Needed now says C2 nested 6, left 0', JSON.stringify(needRow(need1, fx.C2)?.slice(5)), JSON.stringify([6, 6, 0]));
  eq('…and C1 nested 1, left 2', JSON.stringify(needRow(need1, fx.C1)?.slice(5)), JSON.stringify([3, 1, 2]));
  const back = await SS.importSheet(conn, c, fx.lineId, { file: out.buffer.toString('base64'), filename: out.filename, dryRun: true });
  eq('the downloaded file reads back cleanly', back.problems.length, 0, JSON.stringify(back.problems));
  const shape = (ns) => ns.map((n) => `${n.nestNo}@${n.plateCode}:${n.items.map((i) => `${i.cutPlateCode}x${i.qty}`).join(',')}`).join(' ');
  eq('as the same nests', shape(back.nests), shape(saved.nests));
  ok('the read-only Verdict and Notes columns were ignored', back.nests.every((n) => n.verdict === 'fits'));

  /* ---- 5. the route's own shape --------------------------------------------- */
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
