/**
 * add_line_choices_test.mjs — ADD LINE (three choices) + NEW-ORDER DEFAULTS (init.sql §77,
 * services/drawingLineService.js, lib/drawingBom/*, routes/addLine.js), against the local DB.
 *
 *   cd multi_app_be && node scripts/cf_kepl/add_line_choices_test.mjs
 *   CF_ADDLINE_COMPANY=2 node scripts/cf_kepl/add_line_choices_test.mjs     (2 is the default: the local bridge catalog)
 *
 * User, 2026-10-18: the New order dialog carries the order values (one request); "Add line" › "From a new drawing"
 * reads a DWG/DXF with the rules engine and ADDS the line at once, rows it is unsure of flagged "Check (by AI)";
 * "Remove line" when it is way off; "Save as a standard drawing" at the end of step 1.
 * The drawing: TM/NECL_48M_DXF/NECL-48M-SPAN.dxf (a real GA of the NECL 48 m span, no title block, no quantities —
 * so every row is flagged), and TM/ORDER_DRAWINGS/NECL_48M.dwg when this machine can read DWG.
 *
 * Uses the company's real catalog on purpose (mapping onto the existing definitions is what is proved).
 * EVERYTHING HAPPENS INSIDE ONE TRANSACTION THAT IS ROLLED BACK; the last thing it does is re-count every table it wrote.
 */
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

const BE = process.cwd();
const imp = (p) => import(pathToFileURL(path.join(BE, p)).href);
const { pool } = await imp('db.js');
const { attachNodeCache } = await imp('apps/cf_erp/lib/db.js');
await imp('apps/cf_erp/services/codegenProvider.js');
const DL = await imp('apps/cf_erp/services/drawingLineService.js');
const SO = await imp('apps/cf_erp/services/salesOrderService.js');
const STD = await imp('apps/cf_erp/services/standardDrawingService.js');
const { readDxfDb } = await imp('apps/cf_erp/lib/drawingBom/dxfDb.js');
const { extractFromDb } = await imp('apps/cf_erp/lib/drawingBom/extract.js');
const { toBom, roleOf } = await imp('apps/cf_erp/lib/drawingBom/toBom.js');
const { readPartDrawing } = await imp('apps/cf_erp/services/partGeometry.js');
const { protect } = await imp('core/middleware/authmiddleware.js');
const addLineRoutes = (await imp('apps/cf_erp/routes/addLine.js')).default;

const COMPANY = Number(process.env.CF_ADDLINE_COMPANY ?? 2);
const TM = path.resolve(BE, '..');
const DXF = path.join(TM, 'NECL_48M_DXF', 'NECL-48M-SPAN.dxf');
const DWG = path.join(TM, 'ORDER_DRAWINGS', 'NECL_48M.dwg');

let passed = 0;
let failed = 0;
const fails = [];
function ok(label, cond, detail = '') {
  if (typeof label !== 'string' || typeof cond !== 'boolean') throw new Error(`ok(label, cond) was called as ok(${typeof label}, ${typeof cond}).`);
  if (cond) { passed += 1; console.log(`  PASS  ${label}`); } else { failed += 1; fails.push(label); console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (label, got, want) => ok(label, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);
const section = (s) => console.log(`\n${s}`);
const says = (t) => console.log(`        says: ${t}`);
const refusal = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };
async function roundTrips(conn, fn) {
  const real = conn.query.bind(conn);
  let n = 0;
  conn.query = (...a) => { n += 1; return real(...a); };
  try { return { out: await fn(), n }; } finally { conn.query = real; }
}
const COUNTED = [
  'cf_master_records', 'cf_item_details', 'cf_boms', 'cf_bom_lines', 'cf_spec_values', 'cf_spec_value_history', 'cf_sales_orders', 'cf_sales_order_lines',
  'cf_order_spec_defaults', 'cf_order_spec_default_history', 'cf_part_drawings', 'cf_drawings', 'cf_drawing_links',
  'cf_standard_drawings', 'cf_standard_drawing_versions', 'cf_standard_drawing_files', 'cf_line_drawing_imports', 'cf_specifications',
];
async function counts(db) {
  const out = {};
  for (const t of COUNTED) out[t] = Number((await db.query(`SELECT COUNT(*) AS n FROM \`${t}\``))[0][0].n);
  return out;
}
const routeOf = (router, method, p) => router.stack.find((l) => l.route?.path === p && l.route.methods[method])?.route ?? null;
async function reached(route, tags) {
  const req = { user: { id: null, role: 'user', companyId: COMPANY, uiPermissions: tags }, params: { id: '1' }, body: {}, headers: {}, cookies: {} };
  for (const fn of route.stack.slice(0, -1).map((l) => l.handle).filter((f) => f !== protect)) {
    let on = false;
    const res = { status() { return this; }, json() { return this; } };
    await fn(req, res, () => { on = true; });
    if (!on) return false;
  }
  return true;
}
const b64 = (file) => fs.readFileSync(file).toString('base64');

const conn = await pool.getConnection();
attachNodeCache(conn);
const before = await counts(conn);
await conn.beginTransaction();
try {
  const [[u]] = await conn.query('SELECT id FROM users WHERE company_id = ? ORDER BY id LIMIT 1', [COMPANY]);
  const c = { companyId: COMPANY, userId: u?.id ?? null };
  const TAG = Date.now().toString(36).toUpperCase();

  /* ------------------------------------------------------------------------ */
  section('0. The engine in the backend (pure): the NECL 48 m GA as DXF');
  const text = fs.readFileSync(DXF).toString('latin1');
  const db0 = readDxfDb(text);
  ok('the DXF reads (entities, layers)', db0.entities.length > 10000 && db0.tables.LAYER.entries.length > 0, `${db0.entities.length}`);
  const res = extractFromDb(db0, { readPartDrawing, name: 'NECL-48M-SPAN.dxf' });
  ok('no title block: read as one sheet over the whole drawing', res.framed === false && res.sheets.length === 1);
  eq('22 parts read from the call-outs', res.parts.length, 22);
  ok('4 girders found from the G1..G4 labels', res.girders === 4);
  const tb = toBom(res, { sourceName: 'NECL-48M-SPAN.dxf' });
  eq('every part flagged (no quantities on this GA)', tb.stats.flagged, 22);
  ok('girder plates go under the main girder', tb.bom.assembly.children.some((n) => n.kind === 'girder' && n.children.length >= 8));
  eq('roles: bearing stiffener / web / top flange / angle', [
    roleOf({ kind: 'plate', description: 'BEARING STIFFENER PL', assembly: 'Main girder (stiffener)' }),
    roleOf({ kind: 'plate', description: 'WEB PL', assembly: 'Main girder, segment S1' }),
    roleOf({ kind: 'plate', description: 'TOP FLANGE', assembly: 'End diaphragm' }),
    roleOf({ kind: 'section', description: 'ANG1' }),
  ], ['bearing_stiffener', 'web', 'diaphragm_top_flange', 'angle']);
  ok('a scanned PDF is refused politely', /cannot be read by AI yet/.test((await refusal(() => DL.readUpload({ name: 'scan.pdf', content: Buffer.from('%PDF-1.4 x').toString('base64') })))?.message ?? ''));
  ok('another file type is refused', (await refusal(() => DL.readUpload({ name: 'x.txt', content: 'aGk=' })))?.code === 'WRONG_FILE');
  eq('the AI part of a note comes off, the rest stays', DL.withoutAiFlag('DRILL ON ASSEMBLY · Check (by AI): quantity not on the drawing — set to 1'), 'DRILL ON ASSEMBLY');

  /* ------------------------------------------------------------------------ */
  section('1. New order WITH its order values, one request');
  // The two specs this catalog sets for a whole order (the user's list: grade, impact class …), flagged here in the transaction.
  await conn.query("UPDATE cf_specifications SET order_level = 1 WHERE company_id = ? AND code IN ('GRADE', 'IMPACT_CLASS') AND deleted_at IS NULL", [COMPANY]);
  const nd = await DL.newOrderDefaults(conn, COMPANY);
  ok('the dialog reads the same specs as the Structure panel', nd.available && nd.specs.map((s) => s.code).sort().join() === 'GRADE,IMPACT_CLASS', JSON.stringify(nd.specs.map((s) => s.code)));
  const grade = nd.specs.find((s) => s.code === 'GRADE');
  const e350 = grade.options.find((o) => o.value === 'E350');
  ok('GRADE offers E350', !!e350);
  const [[cust]] = await conn.query("SELECT id FROM cf_parties WHERE company_id = ? AND is_customer = 1 AND status = 'active' AND deleted_at IS NULL ORDER BY id LIMIT 1", [COMPANY]);
  const create = await roundTrips(conn, () => SO.createOrder(conn, c, { orderType: 'customer', customerId: cust.id, title: `Add line test ${TAG}`, code: `ALT-${TAG}`, specDefaults: [{ specCode: 'GRADE', value: e350.id }] }));
  const order = create.out;
  says(`createOrder with values: ${create.n} round trips`);
  ok('the order is made', order.code === `ALT-${TAG}`);
  const [od] = await conn.query('SELECT specification_id, option_id FROM cf_order_spec_defaults WHERE company_id = ? AND order_id = ? AND order_line_id IS NULL AND deleted_at IS NULL', [COMPANY, order.id]);
  ok('its GRADE order value is saved with it', od.length === 1 && Number(od[0].option_id) === Number(e350.id));
  ok('one request, a fixed count of round trips (≤ 40)', create.n <= 40, `${create.n}`);
  const nd2 = await DL.newOrderDefaults(conn, COMPANY);
  ok('the next New order is prefilled from this last order', nd2.values.GRADE?.input === String(e350.id) && nd2.values.GRADE.from === 'last_order' && nd2.lastOrder?.code === order.code);
  const bad = await refusal(() => SO.createOrder(conn, c, { orderType: 'customer', customerId: cust.id, code: `ALT-${TAG}-B`, specDefaults: [{ specCode: 'GRADE', value: 'NOPE' }] }));
  ok('a wrong value refuses the whole order', bad?.status === 422, bad?.message);

  /* ------------------------------------------------------------------------ */
  section('2. Add line › From a new drawing: built and added at once, unsure rows flagged');
  const add = await roundTrips(conn, () => DL.addLineFromDrawing(conn, c, order.id, { file: { name: 'NECL-48M-SPAN.dxf', content: b64(DXF) }, quantity: 2 }));
  const fd = add.out.fromDrawing;
  says(fd.sentence);
  says(`${add.n} round trips`);
  ok('the line is on the order', add.out.lines.length === 1 && add.out.lines[0].id === fd.lineId);
  ok('its quantity is the one asked', Number(add.out.lines[0].quantity) === 2);
  ok('it sells the span definition (SPAN-001)', add.out.lines[0].design?.code === 'SPAN-001' || add.out.lines[0].design?.name === 'Bridge span', JSON.stringify(add.out.lines[0].design));
  ok('22 parts read, rows written', fd.parts === 22 && fd.rows > 22, `${fd.parts}/${fd.rows}`);
  ok('every one of the 22 part rows is flagged (+ any assembly placed on a generic name)', fd.flags.filter((f) => f.mark != null).length === 22 && fd.flagged >= 22, `${fd.flagged}`);
  ok('a flag carries its reasons', fd.flags.every((f) => f.rowId && f.reasons.length > 0));
  ok('the sentence says "by AI"', /by AI/.test(fd.sentence));
  ok('round trips are fixed (≤ 260, whatever the parts)', add.n <= 260, `${add.n}`);
  const [notes] = await conn.query(
    `SELECT bl.child_id, bl.notes, bl.quantity FROM cf_bom_lines bl JOIN cf_boms b ON b.id = bl.bom_id AND b.deleted_at IS NULL
       JOIN cf_item_details i ON i.master_id = b.parent_id AND i.owner_order_line_id = ? WHERE bl.company_id = ? AND bl.deleted_at IS NULL`, [fd.lineId, COMPANY]);
  const flagged = notes.filter((n) => String(n.notes ?? '').includes(DL.AI_FLAG));
  eq('the grid rows carry "Check (by AI): …" on every flagged BOM line', flagged.length, fd.flagged);
  ok('the reason is in words', flagged.some((n) => /quantity not on the drawing/.test(n.notes)));
  const [[files]] = await conn.query('SELECT COUNT(*) AS n FROM cf_part_drawings WHERE company_id = ? AND order_line_id = ? AND deleted_at IS NULL', [COMPANY, fd.lineId]);
  ok('the part DXFs the engine drew are on the line', Number(files.n) === fd.files && fd.files >= 1, `${files.n}`);
  const [vals] = await conn.query(
    `SELECT UPPER(s.code) AS code, COUNT(*) AS n FROM cf_spec_values v JOIN cf_specifications s ON s.id = v.specification_id
       JOIN cf_item_details i ON i.master_id = v.subject_id AND i.owner_order_line_id = ?
      WHERE v.company_id = ? AND v.subject_type = 'master' AND v.deleted_at IS NULL GROUP BY s.code`, [fd.lineId, COMPANY]);
  const vc = Object.fromEntries(vals.map((v) => [v.code, Number(v.n)]));
  ok('values written: thickness, width, length on every plate', (vc.THICKNESS ?? 0) >= 19 && (vc.LENGTH ?? 0) >= 19, JSON.stringify(vc));
  ok('the order value reaches the rows (GRADE)', (vc.GRADE ?? 0) >= 19, JSON.stringify(vc));
  const imp1 = await DL.lineDrawingImport(conn, COMPANY, fd.lineId);
  ok('the import record says the file and the counts', imp1.import?.file === 'NECL-48M-SPAN.dxf' && imp1.import.flagged === fd.flagged && imp1.open.length === fd.flagged);

  /* ------------------------------------------------------------------------ */
  section('3. Mark flags checked');
  const one = await DL.clearAiFlags(conn, c, fd.lineId, { rowIds: [fd.flags[0].rowId] });
  ok('one row marked checked', one.cleared === 1 && one.open.length === fd.flagged - 1, `${one.cleared}/${one.open.length}`);
  const all = await roundTrips(conn, () => DL.clearAiFlags(conn, c, fd.lineId, {}));
  ok('"Mark all checked" clears the rest', all.out.open.length === 0, `${all.out.open.length}`);
  ok('…in a fixed handful of statements (≤ 8)', all.n <= 8, `${all.n}`);

  /* ------------------------------------------------------------------------ */
  section('4. Save as a standard drawing (one request)');
  const NUM = `ALT-STD-${TAG}`;
  const saved = await DL.saveLineAsStandard(conn, c, fd.lineId, { number: NUM, name: 'NECL 48 m span (test)' });
  ok('a standard with version 1 from the line', saved.standard?.number === NUM && saved.saved?.versionNo === 1, JSON.stringify(saved.saved));
  ok('the line is tied to it', saved.line?.id === fd.lineId && saved.version?.versionNo === 1);
  const [[sv]] = await conn.query('SELECT rows_count, made_from FROM cf_standard_drawing_versions WHERE company_id = ? AND id = ?', [COMPANY, saved.saved.versionId]);
  ok('the version holds the line\'s rows (made from the line)', Number(sv.rows_count) >= 22 && sv.made_from === 'line', JSON.stringify(sv));
  const again = await refusal(() => DL.saveLineAsStandard(conn, c, fd.lineId, { number: `${NUM}-2` }));
  ok('a line already tied to a standard is refused in words', again?.code === 'HAS_STANDARD');
  // the round trip: a new line from that standard (choice 2) gets the same rows
  const fromStd = await STD.addLineFromStandard(conn, c, order.id, { standardId: saved.standard.id, quantity: 1 });
  ok('choice 2 (from a standard drawing) copies it back', fromStd.fromStandard?.rows === Number(sv.rows_count), `${fromStd.fromStandard?.rows}`);

  /* ------------------------------------------------------------------------ */
  section('5. Remove line');
  const removed = await SO.removeOrderLine(conn, c, fd.lineId);
  ok('the AI line goes', !removed.lines.some((l) => l.id === fd.lineId));
  const [[left]] = await conn.query('SELECT COUNT(*) AS n FROM cf_item_details WHERE company_id = ? AND owner_order_line_id = ? AND deleted_at IS NULL', [COMPANY, fd.lineId]);
  eq('…with its rows', Number(left.n), 0);

  /* ------------------------------------------------------------------------ */
  section('6. DWG (when this machine can read DWG)');
  if (fs.existsSync(DWG)) {
    const r = await refusal(async () => {
      const out = await DL.addLineFromDrawing(conn, c, order.id, { file: { name: 'NECL_48M.dwg', content: b64(DWG) }, quantity: 1 });
      says(out.fromDrawing.sentence);
      ok('the DWG line: every captioned part (≥ 40), most of them sure (fewer than half flagged)', out.fromDrawing.parts >= 40 && out.fromDrawing.flagged < out.fromDrawing.parts / 2, `${out.fromDrawing.parts}/${out.fromDrawing.flagged}`);
    });
    if (r?.code === 'DWG_READER') says(`skipped: ${r.message}`); else if (r) ok('DWG line', false, r.message);
  } else says('skipped: no DWG on disk');

  /* ------------------------------------------------------------------------ */
  section('7. Routes and grants');
  for (const [m, p, tag] of [['get', '/order-defaults/new', 'cf_erp_orders_view'], ['post', '/orders/:id/lines/from-drawing', 'cf_erp_orders_manage'],
    ['get', '/order-lines/:id/drawing-import', 'cf_erp_orders_view'], ['post', '/order-lines/:id/ai-flags/clear', 'cf_erp_orders_manage'],
    ['post', '/order-lines/:id/standard/from-line', 'cf_erp_orders_manage']]) {
    const r = routeOf(addLineRoutes, m, p);
    ok(`${m.toUpperCase()} ${p} exists`, !!r);
    if (r) {
      ok(`  ${tag} reaches it`, await reached(r, [tag]));
      ok('  no grant does not', !(await reached(r, [])));
    }
  }
} catch (err) {
  failed += 1; fails.push(`threw: ${err.message}`);
  console.log(`  FAIL  threw: ${err.stack ?? err.message}${err.problems ? `\n${err.problems.join('\n')}` : ''}`);
} finally {
  await conn.rollback();
  const after = await counts(conn);
  const moved = COUNTED.filter((t) => before[t] !== after[t]);
  ok('rolled back: every table it wrote is back where it was', moved.length === 0, moved.map((t) => `${t} ${before[t]}->${after[t]}`).join(', '));
  conn.release();
  await pool.end();
}
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log(fails.map((f) => `  - ${f}`).join('\n')); process.exit(1); }
