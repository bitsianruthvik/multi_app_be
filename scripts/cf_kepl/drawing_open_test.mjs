/**
 * drawing_open_test.mjs — "some of the drawings are not opening" and "some of the RDSO drawings are not at structure
 * levels" (user, 2026-10-27; SO260002 and SO260014 on production), against the local DB.
 *
 *   cd multi_app_be && node scripts/cf_kepl/drawing_open_test.mjs          (CF_STD_COMPANY=2 by default: the bridge catalog)
 *
 * 1. Content-Disposition: a file named "BLB(1–60).dxf" (an en dash) made Node refuse the header — a 500 for 13 of
 *    SO260002's 67 drawings. lib/http.js contentDisposition (RFC 5987 filename*) passes Node's own header check and
 *    keeps the real name; no cf_erp route builds the header by hand any more.
 * 2. GET /drawings/:id/file (registerFile): a revision whose file a standard keeps opens; one with no file anywhere
 *    says so plainly (404 NO_FILE, with its link when it has one).
 * 3. Importing an RDSO set puts its sheets on the assembly rows they draw; a line made from it carries them; the line's
 *    drawing tree gives every assembly row a sheet (file or link).
 * 4. The repair (standardSheetService.repairStandardSheets, scripts/cf_kepl/rdso-sheets-attach.mjs): with the sheet
 *    links gone (as on production), a dry run writes nothing and counts them; --commit puts them back on the version
 *    and, by BOM path, on the line; a second run adds nothing.
 *
 * EVERYTHING HAPPENS INSIDE ONE TRANSACTION THAT IS ROLLED BACK; the last check proves every table is back.
 */
import fs from 'fs';
import http from 'http';
import path from 'path';
import { pathToFileURL } from 'url';

const BE = process.cwd();
const imp = (p) => import(pathToFileURL(path.join(BE, p)).href);
const { pool } = await imp('db.js');
const { attachNodeCache, detachNodeCache } = await imp('apps/cf_erp/lib/db.js');
await imp('apps/cf_erp/services/codegenProvider.js');
const { contentDisposition } = await imp('apps/cf_erp/lib/http.js');
const STD = await imp('apps/cf_erp/services/standardDrawingService.js');
const SHEETS = await imp('apps/cf_erp/services/standardSheetService.js');
const PD = await imp('apps/cf_erp/services/partDrawingService.js');
const SO = await imp('apps/cf_erp/services/salesOrderService.js');

const COMPANY = Number(process.env.CF_STD_COMPANY ?? 2);
const OUT = path.resolve(BE, '..', 'drawing_bom', 'out');
let passed = 0; let failed = 0; const fails = [];
function ok(label, cond, detail = '') {
  if (cond) { passed += 1; console.log(`  PASS  ${label}`); } else { failed += 1; fails.push(label); console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (label, got, want) => ok(label, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);
const section = (s) => console.log(`\n${s}`);
const refusal = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };
const headerOk = (v) => { try { http.validateHeaderValue('Content-Disposition', v); return true; } catch { return false; } };

const COUNTED = ['cf_drawings', 'cf_drawing_links', 'cf_part_drawings', 'cf_standard_drawings', 'cf_standard_drawing_versions', 'cf_standard_drawing_files', 'cf_sales_orders', 'cf_sales_order_lines', 'cf_master_records'];
const counts = async (db) => Object.fromEntries(await Promise.all(COUNTED.map(async (t) => [t, Number((await db.query(`SELECT COUNT(*) AS n FROM \`${t}\``))[0][0].n)])));
const diff = (a, b) => COUNTED.filter((t) => a[t] !== b[t]).map((t) => `${t} ${a[t]}->${b[t]}`);

/* ---------------------------------------------------------------------------- */
section('1. Content-Disposition (pure, and every cf_erp route)');
for (const name of ['BLB(1–60).dxf', 'IS1-(8–10,12)_12mm_E350.dxf', 'café "x".pdf', 'plain.dxf']) {
  const v = contentDisposition(name);
  ok(`"${name}": Node accepts the header`, headerOk(v), v);
  const star = /filename\*=UTF-8''(.+)$/.exec(v)?.[1];
  eq(`"${name}": filename* gives the real name back`, star ? decodeURIComponent(star) : null, name);
}
ok('the old way is what failed: an en dash in a quoted filename is refused by Node', !headerOk('attachment; filename="BLB(1–60).dxf"'));
ok('inline keeps its type', contentDisposition('a.pdf', 'inline').startsWith('inline; '));
const routesDir = path.join(BE, 'apps', 'cf_erp', 'routes');
const handBuilt = fs.readdirSync(routesDir).filter((f) => f.endsWith('.js')).filter((f) => /Content-Disposition',\s*`/.test(fs.readFileSync(path.join(routesDir, f), 'utf8')));
eq('no cf_erp route builds Content-Disposition by hand', handBuilt, []);

const conn = await pool.getConnection();
attachNodeCache(conn);
const before = await counts(conn);
const [othersBefore] = await conn.query('SELECT COUNT(*) AS n FROM cf_drawing_links WHERE company_id <> ?', [COMPANY]);
await conn.beginTransaction();
try {
  const [[u]] = await conn.query('SELECT id FROM users WHERE company_id = ? ORDER BY id LIMIT 1', [COMPANY]);
  const c = { companyId: COMPANY, userId: u?.id ?? null };
  const TAG = Date.now().toString(36).toUpperCase();
  const dir = path.join(OUT, 'RDSO_11753R3');
  const bom = JSON.parse(fs.readFileSync(path.join(dir, 'bom.json'), 'utf8'));
  bom.drawing.number = `${bom.drawing.number}-T${TAG}`;
  // The sheets carry the run's tag too, so nothing here meets a real import's register drawings.
  bom.drawing.sheets = bom.drawing.sheets.map((s) => ({ ...s, number: s.number.replace('RDSO/B-11753', `RDSO/B-11753-T${TAG}`) }));
  const files = fs.readdirSync(path.join(dir, 'dxf')).filter((f) => /\.dxf$/i.test(f)).map((n) => ({ name: n, text: fs.readFileSync(path.join(dir, 'dxf', n)).toString('latin1') }));

  /* -------------------------------------------------------------------------- */
  section('2. Pure: which sheet draws which assembly row');
  const plan = SHEETS.sheetLinksPlan({
    sheets: [{ sheet: 1, number: 'RDSO/B-11753R3', title: 'GENERAL ARRANGEMENT' }, { sheet: 2, number: 'RDSO/B-11753/1R3', title: 'DETAILS OF SPLICE JOINT' },
      { sheet: 3, number: 'RDSO/B-11753/2R4', title: 'DETAILS OF X-FRAME AND END DIAPHRAGM' }, { sheet: 5, number: 'RDSO/B-11753/4R3', title: 'ASSEMBLY DRAWING AND PART & SHIPPING LIST' },
      { sheet: 7, number: 'RDSO/B-11753/6R2', title: 'DETAILS OF DECK SLAB' }],
    main: { number: 'RDSO/B-11753', revision: 'R3' },
    rows: [{ id: 1, isRoot: true, text: 'Composite Girder span' }, { id: 2, text: 'Diaphragm End diaphragm DP' }, { id: 3, text: 'Splice set Splice set' },
      { id: 4, text: 'Girder segment Girder segment GA' }, { id: 5, text: 'Lifting beam' }],
  });
  eq('the general arrangement is the series itself, not a new sheet', plan.sheets.map((s) => s.number), ['RDSO/B-11753/1', 'RDSO/B-11753/2', 'RDSO/B-11753/4', 'RDSO/B-11753/6']);
  eq('number and revision as printed', SHEETS.parseSheetNumber('RDSO/B-11753/2R4'), { number: 'RDSO/B-11753/2', revision: 'R4' });
  eq('a sheet never altered is revision 0', SHEETS.parseSheetNumber('RDSO/B-11765/1'), { number: 'RDSO/B-11765/1', revision: '0' });
  const at = (id) => plan.links.filter((l) => l.rowId === id).map((l) => l.key);
  eq('end diaphragm → the X-frame & end diaphragm sheet', at(2), ['rdso/b-11753/2|r4']);
  eq('splice set → the splice joint sheet', at(3), ['rdso/b-11753/1|r3']);
  eq('girder segment → the assembly drawing', at(4), ['rdso/b-11753/4|r3']);
  eq('a row no sheet names → the series', at(5), ['main']);
  eq('the span keeps the series it already has (no new link)', at(1), []);

  /* -------------------------------------------------------------------------- */
  section('3. Import: the sheets on the standard\'s assembly rows, and on a line made from it');
  const applied = await STD.importStandard(conn, c, { bom, files, apply: true });
  const w = applied.report.written;
  ok('the import says how many sheets it linked', w.sheets?.links > 0 && w.sheets?.sheets > 0, JSON.stringify(w.sheets));
  const [[ver]] = await conn.query('SELECT * FROM cf_standard_drawing_versions WHERE id = ?', [w.versionId]);
  const vRows = await SHEETS.treeRows(conn, COMPANY, ver.root_item_id);
  const vAsm = vRows.filter((r) => r.isAssembly && !r.isRoot);
  const [vl] = await conn.query('SELECT subject_id, drawing_id FROM cf_drawing_links WHERE subject_id IN (?) AND deleted_at IS NULL', [vAsm.map((r) => r.id)]);
  ok(`every assembly row of the standard (${vAsm.length}) has a drawing`, vAsm.length >= 7 && vAsm.every((r) => vl.some((l) => Number(l.subject_id) === r.id)), vAsm.filter((r) => !vl.some((l) => Number(l.subject_id) === r.id)).map((r) => r.text).join('; '));
  const [sheetRegs] = await conn.query('SELECT id, number, revision, url, source, status FROM cf_drawings WHERE company_id = ? AND number LIKE ? AND deleted_at IS NULL', [COMPANY, `RDSO/B-11753-T${TAG}/%`]);
  ok('each sheet is the customer\'s, issued, with the series link at its page', sheetRegs.length >= 4 && sheetRegs.every((d) => d.source === 'customer' && d.status === 'issued' && /#page=\d+$/.test(d.url ?? '')), JSON.stringify(sheetRegs.map((d) => [d.number, d.url])));
  ok('the deck slab (no steel row) is not registered', !sheetRegs.some((d) => d.number.endsWith('/6')));

  const [[cust]] = await conn.query('SELECT id FROM cf_parties WHERE company_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 1', [COMPANY]);
  const order = await SO.createOrder(conn, c, { orderType: 'customer', customerId: cust.id, title: 'drawing open test' });
  const made = await STD.addLineFromStandard(conn, c, order.id, { standardId: w.standardId, quantity: 1 });
  const lineId = made.fromStandard.lineId;
  const tree = await PD.drawingTree(conn, COMPANY, order.id, lineId);
  const byMark = (m) => tree.rows.filter((r) => r.mark === m);
  const asm = tree.rows.filter((r) => tree.rows.some((k) => k.parentId === r.rowId) && r.parentId != null && !r.hasDrawing);
  ok(`the line: every assembly row (${asm.length}) shows a sheet`, asm.length >= 7 && asm.every((r) => r.sheet), asm.filter((r) => !r.sheet).map((r) => `${r.level}:${r.name}`).join('; '));
  ok('the end diaphragm DP and the X-frame IXF show the X-frame & end diaphragm sheet', [...byMark('DP'), ...byMark('IXF')].length === 2 && [...byMark('DP'), ...byMark('IXF')].every((r) => r.sheet?.number === `RDSO/B-11753-T${TAG}/2` && r.sheet.revision === 'R4'));
  ok('segments GA and GB show the assembly drawing', [...byMark('GA'), ...byMark('GB')].every((r) => r.sheet?.number === `RDSO/B-11753-T${TAG}/4`));
  ok('a sheet kept only at RDSO says so: no file, its link', byMark('DP')[0]?.sheet?.hasFile === false && /#page=3$/.test(byMark('DP')[0]?.sheet?.url ?? ''));
  ok('the parts still open their own DXF (a file on the line, no sheet)', byMark('TF1').length > 0 && byMark('TF1').every((r) => r.hasDrawing && r.sheet === null));
  const root = tree.rows.find((r) => r.parentId == null);
  ok('the span shows the series (no file here: its link)', root?.sheet?.url?.includes('rdso') && root.sheet.hasFile === false, JSON.stringify(root?.sheet));
  const view = await PD.getDrawings(conn, COMPANY, order.id, lineId);
  ok('the Drawings dialog lists the sheets as waiting, each with its link', view.waiting.length >= 5 && view.waiting.every((x) => x.drawing.url), `${view.waiting.length}`);

  /* -------------------------------------------------------------------------- */
  section('4. GET /drawings/:id/file — every drawing with a file opens; one without says so');
  const partFile = view.drawings[0];
  const fromLine = await PD.registerFile(conn, COMPANY, partFile.drawing.id);
  ok('a part\'s register revision opens (its file on the line)', fromLine.buffer.length > 100 && /SECTION/.test(fromLine.buffer.toString('latin1')));
  await conn.query('UPDATE cf_part_drawings SET deleted_at = NOW() WHERE company_id = ? AND drawing_id = ?', [COMPANY, partFile.drawing.id]);
  const fromStd = await PD.registerFile(conn, COMPANY, partFile.drawing.id);
  ok('…and with no line holding it, from the standard that keeps it', fromStd.buffer.length > 100 && fromStd.filename === partFile.fileName);
  const noFile = await refusal(() => PD.registerFile(conn, COMPANY, byMark('DP')[0].sheet.id));
  ok('a sheet with no file anywhere: 404 NO_FILE, said plainly, with its link', noFile?.status === 404 && noFile.code === 'NO_FILE' && /has no file in the system/.test(noFile.message) && /#page=3/.test(noFile.detail?.url ?? ''), noFile?.message);
  await conn.query('UPDATE cf_part_drawings SET file_name = ? WHERE company_id = ? AND order_line_id = ? AND id = ?', ['BLB(1–60).dxf', COMPANY, lineId, view.drawings[1].id]);
  const dash = await PD.drawingFile(conn, COMPANY, order.id, lineId, view.drawings[1].id);
  ok('a line drawing named with an en dash: its header is one Node sends', headerOk(contentDisposition(dash.filename)) && dash.filename === 'BLB(1–60).dxf');

  /* -------------------------------------------------------------------------- */
  section('5. The repair: the sheets gone (as on production) → a dry run counts, --commit puts them back, again adds nothing');
  const [std] = await conn.query('SELECT * FROM cf_standard_drawings WHERE id = ?', [w.standardId]);
  const lineRoot = Number(made.lines.find((l) => l.id === lineId).item.id);
  const lRows = await SHEETS.treeRows(conn, COMPANY, lineRoot);
  const allIds = [...vRows.map((r) => r.id), ...lRows.map((r) => r.id)];
  const [had] = await conn.query("SELECT COUNT(*) AS n FROM cf_drawing_links WHERE subject_id IN (?) AND note = 'Sheet of the standard' AND deleted_at IS NULL", [allIds]);
  await conn.query("UPDATE cf_drawing_links SET deleted_at = NOW() WHERE subject_id IN (?) AND note = 'Sheet of the standard' AND deleted_at IS NULL", [allIds]);
  const c0 = await counts(conn);
  const dry = await SHEETS.repairStandardSheets(conn, c, { standard: std[0], bom, commit: false });
  ok('a dry run writes nothing', diff(c0, await counts(conn)).length === 0);
  const dryAdds = dry.versions.reduce((a, v) => a + v.add, 0) + dry.lines.reduce((a, l) => a + l.add, 0);
  eq('it counts every sheet link that went (version + line)', dryAdds, Number(had[0].n));
  ok('the sheets are found again, not made twice', dry.sheets.every((s) => s.registered));
  const fixed = await SHEETS.repairStandardSheets(conn, c, { standard: std[0], bom, commit: true });
  const line = fixed.lines.find((l) => l.id === lineId);
  ok('the line gets its links by BOM path from its version, none unmatched', line && line.add > 0 && line.unmatched === 0, JSON.stringify(line));
  const tree2 = await PD.drawingTree(conn, COMPANY, order.id, lineId);
  const asm2 = tree2.rows.filter((r) => tree2.rows.some((k) => k.parentId === r.rowId) && r.parentId != null && !r.hasDrawing);
  ok('after the repair every assembly row of the line shows its sheet again', asm2.length === asm.length && asm2.every((r) => r.sheet), asm2.filter((r) => !r.sheet).map((r) => r.name).join('; '));
  const again = await SHEETS.repairStandardSheets(conn, c, { standard: std[0], bom, commit: true });
  eq('a second run adds nothing (idempotent)', again.versions.reduce((a, v) => a + v.add, 0) + again.lines.reduce((a, l) => a + l.add, 0), 0);
  const [othersNow] = await conn.query('SELECT COUNT(*) AS n FROM cf_drawing_links WHERE company_id <> ?', [COMPANY]);
  eq('no other company\'s links were touched', Number(othersNow[0].n), Number(othersBefore[0].n));
} catch (err) {
  failed += 1;
  fails.push(`crashed: ${err.message}`);
  console.log(`\n  CRASH ${err.stack ?? err.message}${err.problems ? `\n  ${err.problems.join('\n  ')}` : ''}`);
} finally {
  await conn.rollback();
  const d = diff(before, await counts(conn));
  ok('rolled back: every table is where it started', d.length === 0, d.join(', '));
  detachNodeCache(conn);
  conn.release();
  await pool.end();
}
console.log(`\n${passed} passed, ${failed} failed`);
if (fails.length) console.log(`Failed:\n  ${fails.join('\n  ')}`);
process.exit(failed ? 1 : 0);
