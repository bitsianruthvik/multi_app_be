/**
 * Excel round trips on owned fixtures. Local only; all changes roll back.
 * A catalog item's or definition's BOM is one row per line (bomSheetService). An ORDER LINE's sheet is the screen,
 * two rows per line (orderSheetService) — its own suite is order_sheet_test.mjs; here it is only held to the same
 * round trip, quantity and frozen-line promises as the record sheets beside it.
 */
import ExcelJS from 'exceljs';
import { pool } from '../../db.js';
import '../../apps/cf_erp/services/codegenProvider.js';
import { exportSheet, importSheet, FIXED_COLUMNS } from '../../apps/cf_erp/services/bomSheetService.js';
import { exportOrderSheet, importOrderSheet } from '../../apps/cf_erp/services/orderSheetService.js';
import { addOrderLine } from '../../apps/cf_erp/services/salesOrderService.js';
import { listMachines } from '../../apps/cf_erp/services/machineService.js';

if (!/^(localhost|127\.0\.0\.1|::1)$/.test(process.env.DB_HOST ?? 'localhost')) throw new Error('This suite is local only.');
const companyId = Number(process.env.CF_SHEET_COMPANY ?? 2);
const tables = ['cf_classification_nodes', 'cf_master_records', 'cf_item_details', 'cf_definition_details', 'cf_boms', 'cf_bom_lines', 'cf_sales_orders', 'cf_sales_order_lines', 'cf_spec_values', 'cf_spec_value_history', 'cf_machines'];
let passed = 0, failed = 0;
function ok(label, condition) { console.log(`${condition ? 'PASS' : 'FAIL'} ${label}`); condition ? passed++ : failed++; }
const db = await pool.getConnection();
const counts = async () => Object.fromEntries(await Promise.all(tables.map(async (t) => [t, Number((await db.query(`SELECT COUNT(*) n FROM ${t}`))[0][0].n)])));
const before = await counts();
const col = (key) => FIXED_COLUMNS.findIndex((c) => c.key === key) + 1;
const cell = (ws, row, key, value) => { ws.getRow(row).getCell(col(key)).value = value; };
const find = (ws, id) => {
  for (let row = 2; row <= ws.rowCount; row++) if (String(ws.getRow(row).getCell(col('rowId')).value) === String(id)) return row;
  throw new Error(`Missing fixture row ${id}`);
};
const qty = async (id) => Number((await db.query('SELECT quantity FROM cf_bom_lines WHERE id = ?', [id]))[0][0].quantity);
try {
  await db.beginTransaction();
  const [[user]] = await db.query('SELECT id FROM users WHERE company_id = ? AND deleted_at IS NULL LIMIT 1', [companyId]);
  const c = { companyId, userId: user.id };
  const tag = `BST${Date.now().toString(36).toUpperCase()}`;
  const ins = async (sql, params) => (await db.query(sql, params))[0].insertId;
  const node = (parent, depth, key, scope = 'both') => ins("INSERT INTO cf_classification_nodes(company_id,parent_id,depth,scope,code,name,status) VALUES(?,?,?,?,?,?,'active')", [companyId, parent, depth, scope, `${tag}-${key}`, `${tag} ${key}`]);
  const family = await node(null, 0, 'F');
  const sub = await node(family, 1, 'S');
  const variant = await node(sub, 2, 'V');
  const master = async (key, kind = 'catalog') => {
    const id = await ins("INSERT INTO cf_master_records(company_id,record_kind,code,name,classification_id,status,created_by) VALUES(?,?,?,?,?,'active',?)", [companyId, kind === 'catalog' ? 'item' : 'definition', `${tag}-${key}`, `${tag} ${key}`, variant, c.userId]);
    if (kind === 'catalog') await db.query("INSERT INTO cf_item_details(master_id,company_id,item_type,tracked_by,uom,sourcing) VALUES(?,?,'catalog','quantity','nos','stock')", [id, companyId]);
    else await db.query("INSERT INTO cf_definition_details(master_id,company_id,definition_type) VALUES(?,?,'template')", [id, companyId]);
    return id;
  };
  const bom = (parent, type) => ins("INSERT INTO cf_boms(company_id,parent_id,bom_type,status,created_by) VALUES(?,?,?,'active',?)", [companyId, parent, type, c.userId]);
  const line = (bomId, child, number, quantity) => ins('INSERT INTO cf_bom_lines(company_id,bom_id,line_no,child_id,design_id,position,quantity,created_by) VALUES(?,?,?,?,?,1,?,?)', [companyId, bomId, number, child, child, quantity, c.userId]);
  const part = await master('PART');
  const assembly = await master('ASSY');
  const nestedLine = await line(await bom(assembly, 'standard'), part, 10, 2);
  const item = await master('ITEM');
  const itemBom = await bom(item, 'standard');
  const itemLine = await line(itemBom, assembly, 10, 3);
  const secondLine = await line(itemBom, part, 20, 4);
  const empty = await master('EMPTY');
  const template = await master('TPL', 'template');
  const templateLine = await line(await bom(template, 'template'), assembly, 10, 2);
  const order = await ins("INSERT INTO cf_sales_orders(company_id,code,order_type,title,status,created_by) VALUES(?,?,'customer','Excel test','inquiry',?)", [companyId, `${tag}-SO`, c.userId]);
  await addOrderLine(db, c, order, { recordId: template, quantity: 2 });
  const [[orderLine]] = await db.query('SELECT id,item_id FROM cf_sales_order_lines WHERE order_id = ? AND deleted_at IS NULL', [order]);
  const [[customLine]] = await db.query('SELECT l.id FROM cf_bom_lines l JOIN cf_boms b ON b.id=l.bom_id WHERE b.parent_id=? AND l.deleted_at IS NULL', [orderLine.item_id]);
  const record = (id) => ({ kind: 'record', recordId: id });
  const fresh = async (scope) => {
    const out = await exportSheet(db, companyId, scope);
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(out.buffer);
    return { wb, ws: wb.getWorksheet('BOM'), out };
  };
  const run = async (scope, wb, dryRun = true) => importSheet(db, c, scope, { file: Buffer.from(await wb.xlsx.writeBuffer()), dryRun });
  // The order line's own sheet: pairs of rows found by the hidden id each carries (N|<line>:<record> / V|…).
  const freshLine = async () => {
    const out = await exportOrderSheet(db, companyId, orderLine.id);
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(out.buffer);
    return { wb, ws: wb.getWorksheet('BOM'), out };
  };
  const runLine = async (wb, dryRun = true) => importOrderSheet(db, c, orderLine.id, { file: Buffer.from(await wb.xlsx.writeBuffer()), dryRun });
  const pairOf = (ws, lineId) => {
    let names = null, values = null;
    ws.eachRow((row) => { for (let i = 1; i <= row.cellCount; i++) { const v = String(row.getCell(i).value ?? ''); if (v.startsWith(`N|${lineId}:`)) names = row; if (v.startsWith(`V|${lineId}:`)) values = row; } });
    if (!names || !values) throw new Error(`Missing order-line pair ${lineId}`);
    return { names, values, cellOf: (label) => { for (let i = 2; i <= names.cellCount; i++) if (names.getCell(i).value === label) return values.getCell(i); throw new Error(`No ${label} on pair ${lineId}`); } };
  };
  const attempt = async (label, fn) => {
    await db.query('SAVEPOINT sheet_case');
    try { await fn(); } catch (e) { failed++; console.error(`FAIL ${label}: ${e.message}`, e.problems ?? ''); }
    finally { await db.query('ROLLBACK TO SAVEPOINT sheet_case'); }
  };

  for (const scope of [record(item), record(template)]) await attempt('round trip', async () => {
    const { wb, ws } = await fresh(scope);
    const preview = await run(scope, wb);
    ok('unchanged workbook has no changes or problems', preview.ok && preview.changes.length === 0);
    ok('editable columns come first and name stays frozen', ws.getCell('B1').value === 'Quantity' && ws.views[0].xSplit === 1);
    ok('workbook has instructions', !!wb.getWorksheet('How to use this'));
  });
  await attempt('order line round trip', async () => {
    const { wb, ws, out } = await freshLine();
    const preview = await runLine(wb);
    ok('order line: unchanged workbook has no changes or problems', preview.ok && preview.changes.length === 0);
    ok('order line: two rows per BOM row under one banner, and no instructions sheet', ws.actualRowCount === 1 + 2 * out.rows && out.rows > 0 && wb.worksheets.length === 1 && !wb.getWorksheet('How to use this'));
  });
  await attempt('order line quantity', async () => {
    const { wb, ws } = await freshLine();
    pairOf(ws, customLine.id).cellOf('Qty').value = 7;
    const old = await qty(customLine.id), preview = await runLine(wb);
    ok('order line: preview reports the quantity', preview.ok && preview.summary.quantityChanged === 1 && preview.summary.roleChanged === 0 && preview.summary.notesChanged === 0);
    ok('order line: preview leaves database untouched', await qty(customLine.id) === old);
    const applied = await runLine(wb, false);
    ok('order line: apply saves the quantity', applied.applied === true && await qty(customLine.id) === 7);
  });
  for (const [scope, id] of [[record(item), itemLine], [record(template), templateLine]]) await attempt('quantity and text', async () => {
    const { wb, ws } = await fresh(scope);
    const row = find(ws, id); cell(ws, row, 'quantity', 7); cell(ws, row, 'role', 'Edited role'); cell(ws, row, 'notes', 'Edited notes');
    const old = await qty(id), preview = await run(scope, wb);
    ok('preview reports quantity, role and notes', preview.ok && preview.summary.quantityChanged === 1 && preview.summary.roleChanged === 1 && preview.summary.notesChanged === 1);
    ok('preview leaves database untouched', await qty(id) === old);
    const applied = await run(scope, wb, false);
    ok('apply saves the quantity', applied.applied && await qty(id) === 7);
  });
  await attempt('empty BOM', async () => {
    const { wb, ws } = await fresh(record(empty));
    const row = ws.rowCount + 1; cell(ws, row, 'parentRowId', 'ROOT'); cell(ws, row, 'code', `${tag}-PART`); cell(ws, row, 'quantity', 5);
    ok('empty item allows a new row', (await run(record(empty), wb)).summary.rowsAdded === 1);
    ok('empty item creates its BOM on apply', (await run(record(empty), wb, false)).applied);
    const [[found]] = await db.query('SELECT l.quantity FROM cf_bom_lines l JOIN cf_boms b ON b.id=l.bom_id WHERE b.parent_id=? AND l.deleted_at IS NULL', [empty]);
    ok('added quantity persisted', Number(found.quantity) === 5);
  });
  await attempt('omission and explicit removal', async () => {
    const { wb, ws } = await fresh(record(item));
    ws.spliceRows(find(ws, secondLine), 1);
    ok('omitting a row does not remove it', (await run(record(item), wb)).summary.rowsRemoved === 0);
    cell(ws, find(ws, itemLine), 'del', 'yes');
    const p = await run(record(item), wb);
    ok('removal preview includes descendants', p.ok && p.summary.rowsRemoved === 1 && p.summary.rowsRemovedBeneath === 1);
    await run(record(item), wb, false);
    const [[kept]] = await db.query('SELECT deleted_at FROM cf_bom_lines WHERE id=?', [nestedLine]);
    ok('catalog child BOM is preserved', kept.deleted_at === null && await qty(secondLine) === 4);
  });
  await attempt('read-only nested BOM and foreign identity', async () => {
    const { wb, ws } = await fresh(record(item));
    cell(ws, find(ws, nestedLine), 'quantity', 8);
    ok('nested catalog change refused', !(await run(record(item), wb)).ok);
    let refused = false; try { await run(record(item), wb, false); } catch { refused = true; }
    ok('invalid apply changes nothing', refused && await qty(nestedLine) === 2);
    ok('foreign workbook refused', !(await run(record(template), wb)).ok);
  });
  await attempt('cycle preview', async () => {
    const { wb, ws } = await fresh(record(item));
    const row = ws.rowCount + 1; cell(ws, row, 'parentRowId', 'ROOT'); cell(ws, row, 'code', `${tag}-ITEM`); cell(ws, row, 'quantity', 1);
    ok('self reference refused in preview', !(await run(record(item), wb)).ok);
  });
  await attempt('frozen workbook', async () => {
    const { wb } = await freshLine();
    await db.query('UPDATE cf_sales_order_lines SET locked_at=NOW() WHERE id=?', [orderLine.id]);
    let refused = false; try { await runLine(wb); } catch { refused = true; }
    ok('locked order refuses upload', refused);
    ok('locked order still downloads', (await freshLine()).out.rows > 0);
  });
  await attempt('machine paging', async () => {
    const mf = await node(null, 0, 'MF', 'machine');
    const ms = await node(mf, 1, 'MS', 'machine');
    const mv = await node(ms, 2, 'MV', 'machine');
    const machines = Array.from({ length: 503 }, (_, i) => [companyId, `${tag}-M${String(i).padStart(3, '0')}`, `${tag} asset ${i}`, mv, 'active']);
    await db.query('INSERT INTO cf_machines(company_id,code,name,classification_id,status) VALUES ?', [machines]);
    const first = await listMachines(db, companyId, { search: tag, classificationId: mv });
    const rest = await listMachines(db, companyId, { search: tag, classificationId: mv, offset: 500 });
    ok('machine pages contain all 503 assets exactly once', first.length === 500 && rest.length === 3 && new Set([...first, ...rest].map((m) => m.id)).size === 503);
  });
} catch (e) { failed++; console.error('FAIL suite:', e.message, e.problems ?? '', e.stack); }
finally {
  await db.rollback();
  const after = await counts();
  for (const table of tables) ok(`rollback preserved ${table}`, before[table] === after[table]);
  db.release(); await pool.end();
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
