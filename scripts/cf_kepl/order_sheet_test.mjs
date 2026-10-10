/**
 * order_sheet_test.mjs — the ORDER-LINE Excel: the BOM as the screen shows it,
 * two rows per line (services/orderSheetService.js, lib/orderSheetLayout.js),
 * against the local DB.
 *
 *   cd multi_app_be && node scripts/cf_kepl/order_sheet_test.mjs
 *
 * EVERYTHING HAPPENS INSIDE ONE TRANSACTION THAT IS ROLLED BACK, and the last
 * thing it does is re-count every cf_ table and prove each is back where it
 * started. It builds its own fixture (every code and name carries this run's
 * tag); the only tenant rows it reads are the THICKNESS / LENGTH specifications,
 * by code, so a real dimension leads a real row — and it makes its own if the
 * company has none.
 *
 * What "exactly what the screen shows" means is proved in two halves:
 *   - the layout rule against the frontend's own functions:
 *       multi_app_fe/scripts/cf_erp_order_sheet_layout_test.mjs
 *   - HERE: the workbook is that layout, cell for cell, read from the live
 *     structure and the live values view on every download.
 *
 * ok(label, cond) — the label FIRST; ok() refuses anything but (string, boolean).
 */
import path from 'path';
import { pathToFileURL } from 'url';
import ExcelJS from 'exceljs';

const BE = process.cwd();
const imp = (p) => import(pathToFileURL(path.join(BE, p)).href);
const { pool } = await imp('db.js');
const { attachNodeCache, detachNodeCache } = await imp('apps/cf_erp/lib/db.js');
await imp('apps/cf_erp/services/codegenProvider.js');
const OS = await imp('apps/cf_erp/services/orderSheetService.js');
const L = await imp('apps/cf_erp/lib/orderSheetLayout.js');
const OV = await imp('apps/cf_erp/services/orderValuesService.js');
const S = await imp('apps/cf_erp/services/salesOrderService.js');
const V = await imp('apps/cf_erp/services/valueService.js');
const B = await imp('apps/cf_erp/services/bomService.js');
const sheetRoutes = (await imp('apps/cf_erp/routes/bomSheet.js')).default;

if (!/^(localhost|127\.0\.0\.1|::1)$/.test(process.env.DB_HOST ?? 'localhost')) throw new Error('This suite is local only.');
const COMPANY = Number(process.env.CF_SHEET_COMPANY ?? 2);
/** The local order line with a real structure that is LOCKED (order 887). Skipped, and said so, if it is not there. */
const FROZEN_LINE = Number(process.env.CF_SHEET_FROZEN_LINE ?? 923);

let passed = 0;
let failed = 0;
const fails = [];
function ok(label, cond, detail = '') {
  if (typeof label !== 'string' || typeof cond !== 'boolean') throw new Error(`ok(label, cond) was called as ok(${typeof label}, ${typeof cond}).`);
  if (cond) { passed += 1; console.log(`  PASS  ${label}`); } else { failed += 1; fails.push(label); console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
}
const alike = (a, b) => Object.is(a, b) || JSON.stringify(a) === JSON.stringify(b);
const eq = (label, got, want) => ok(label, alike(got, want), `got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);
const section = (s) => console.log(`\n${s}`);
const says = (text) => console.log(`        says: ${text}`);
const refusal = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

async function cfTables(db) {
  const [rows] = await db.query("SHOW TABLES LIKE 'cf\\_%'");
  return rows.map((r) => Object.values(r)[0]).sort();
}
async function census(db, tables) {
  const out = {};
  for (const t of tables) out[t] = Number((await db.query(`SELECT COUNT(*) AS n FROM \`${t}\``))[0][0].n);
  return out;
}
const diff = (a, b) => Object.keys(a).filter((t) => a[t] !== b[t]).map((t) => `${t} ${a[t]}->${b[t]}`);
async function roundTrips(conn, fn) {
  const real = conn.query.bind(conn);
  let n = 0;
  conn.query = (...a) => { n += 1; return real(...a); };
  try { return { out: await fn(), n }; } finally { conn.query = real; }
}

/* --------------------------------------------------------------------------
 * The fixture — a girder of two segments; each segment two web plates, two
 * stiffeners on one line and four catalog bolts. All of it this run's own.
 * ----------------------------------------------------------------------- */
async function buildFixture(db, c) {
  const tag = `OST${Date.now().toString(36).toUpperCase()}`;
  const ins = async (sql, params) => (await db.query(sql, params))[0].insertId;
  const node = (parentId, depth, key) => ins(
    "INSERT INTO cf_classification_nodes (company_id, parent_id, depth, scope, code, name, status) VALUES (?, ?, ?, 'both', ?, ?, 'active')",
    [COMPANY, parentId, depth, `${tag}-${key}`, `${tag} ${key} — order sheet test`],
  );
  const fam = await node(null, 0, 'F');
  const sub = await node(fam, 1, 'S');
  const vPart = await node(sub, 2, 'PART');
  const vAsm = await node(sub, 2, 'ASM');
  const vBolt = await node(sub, 2, 'BOLT');

  const spec = async (key, dataType, { uom = null, decimals = null } = {}) => {
    const code = `${tag}_${key}`;
    const name = `${key} sheet test`;
    const id = await ins(
      "INSERT INTO cf_specifications (company_id, code, name, data_type, default_uom, decimals, status) VALUES (?, ?, ?, ?, ?, ?, 'active')",
      [COMPANY, code, `${name} ${tag}`, dataType, uom, decimals],
    );
    return { id, code };
  };
  // The grid leads a row with its dimensions, matched by CODE: the company's own, read only (or made here).
  const dimension = async (code) => {
    const [[s]] = await db.query("SELECT id, code FROM cf_specifications WHERE company_id = ? AND code = ? AND data_type = 'number' AND deleted_at IS NULL", [COMPANY, code]);
    if (s) return { id: s.id, code: s.code };
    const id = await ins("INSERT INTO cf_specifications (company_id, code, name, data_type, default_uom, status) VALUES (?, ?, ?, 'number', 'mm', 'active')", [COMPANY, code, `${code} ${tag}`]);
    return { id, code };
  };
  const THK = await dimension('THICKNESS');
  const LEN = await dimension('LENGTH');
  const WT = await spec('WT', 'number', { uom: 'kg', decimals: 3 });
  const DENS = await spec('DENS', 'number', { uom: 'kg/m3' });
  const GRD = await spec('GRD', 'option');
  const CLS = await spec('CLS', 'option');
  const HOLED = await spec('HOLED', 'boolean');
  const MARK = await spec('MARK', 'text');
  const PAINT = await spec('PAINT', 'text');
  const option = (specId, value, sort, label = null) => ins(
    "INSERT INTO cf_spec_options (company_id, specification_id, value, label, sort_order, status) VALUES (?, ?, ?, ?, ?, 'active')",
    [COMPANY, specId, value, label, sort],
  );
  const E250 = await option(GRD.id, 'E250', 1);
  const E350 = await option(GRD.id, 'E350', 2, 'E350 — high strength');
  await option(GRD.id, 'E450', 3);
  const clsA = await option(CLS.id, 'A', 1);
  const clsB = await option(CLS.id, 'B', 2);

  const formula = (key, expression) => ins("INSERT INTO cf_formulas (company_id, code, name, expression, status) VALUES (?, ?, ?, ?, 'active')", [COMPANY, `${tag}_${key}`, key, expression]);
  const PWT = await formula('PWT', `${LEN.code} * ${THK.code} * ${DENS.code} / 1000000`);
  const AWT = await formula('AWT', `SUM(children.${WT.code})`);
  const rule = (subjectType, subjectId, s, valueRule, { required = false, formulaId = null, sort = 0, applicable = true } = {}) => ins(
    `INSERT INTO cf_spec_assignments
       (company_id, specification_id, subject_type, subject_id, capture_at, is_required, is_applicable, value_rule, formula_id, sort_order, created_by)
     VALUES (?, ?, ?, ?, 'item', ?, ?, ?, ?, ?, ?)`,
    [COMPANY, s.id, subjectType, subjectId, required ? 1 : 0, applicable ? 1 : 0, valueRule, formulaId, sort, c.userId],
  );
  const classValue = (nodeId, s, column, value) => db.query(
    `INSERT INTO cf_spec_values (company_id, specification_id, subject_type, subject_id, ${column}, source) VALUES (?, ?, 'classification', ?, ?, 'entered')`,
    [COMPANY, s.id, nodeId, value],
  );
  await rule('classification', fam, DENS, 'fixed', { sort: 90 });
  await classValue(fam, DENS, 'value_number', 7850);
  await rule('classification', vAsm, DENS, 'fixed', { applicable: false });
  await rule('classification', vBolt, DENS, 'fixed', { applicable: false });
  // A part: a worked-out weight FIRST in rule order (the grid still puts what is typed before it), then what is typed.
  await rule('classification', vPart, WT, 'calculated', { formulaId: PWT, sort: 1 });
  await rule('classification', vPart, LEN, 'entered', { required: true, sort: 2 });
  await rule('classification', vPart, THK, 'entered', { required: true, sort: 3 });
  const grdRule = await rule('classification', vPart, GRD, 'entered', { required: true, sort: 4 });
  for (const o of [E250, E350]) await db.query('INSERT INTO cf_spec_assignment_options (company_id, assignment_id, option_id) VALUES (?, ?, ?)', [COMPANY, grdRule, o]);
  await rule('classification', vPart, HOLED, 'entered', { sort: 5 });
  const markRule = await rule('classification', vPart, MARK, 'entered', { sort: 6 });
  await rule('classification', vPart, CLS, 'defaulted', { required: true, sort: 7 });
  await classValue(vPart, CLS, 'option_id', clsA);
  // An assembly: a mark and a paint typed, its weight rolled up.
  await rule('classification', vAsm, MARK, 'entered', { sort: 1 });
  await rule('classification', vAsm, PAINT, 'entered', { sort: 2 });
  await rule('classification', vAsm, WT, 'rollup', { formulaId: AWT, sort: 3 });
  await rule('classification', vBolt, WT, 'entered', { sort: 1 });

  const master = async (kind, key, name, short, classificationId) => {
    const id = await ins(
      "INSERT INTO cf_master_records (company_id, record_kind, code, name, short_name, classification_id, status, created_by) VALUES (?, ?, ?, ?, ?, ?, 'active', ?)",
      [COMPANY, kind === 'catalog' ? 'item' : 'definition', `${tag}-${key}`, name, short, classificationId, c.userId],
    );
    if (kind === 'catalog') await db.query("INSERT INTO cf_item_details (master_id, company_id, item_type, tracked_by, uom, sourcing) VALUES (?, ?, 'catalog', 'quantity', 'nos', 'stock')", [id, COMPANY]);
    else await db.query("INSERT INTO cf_definition_details (master_id, company_id, definition_type) VALUES (?, ?, 'template')", [id, COMPANY]);
    return id;
  };
  const bomOf = (parentId, bomType) => ins("INSERT INTO cf_boms (company_id, parent_id, bom_type, status, created_by) VALUES (?, ?, ?, 'active', ?)", [COMPANY, parentId, bomType, c.userId]);
  const line = (bomId, lineNo, childId, qty, position = 1, role = null) => ins(
    'INSERT INTO cf_bom_lines (company_id, bom_id, line_no, child_id, design_id, position, quantity, role, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [COMPANY, bomId, lineNo, childId, childId, position, qty, role, c.userId],
  );
  const BOLT = await master('catalog', 'BOLT', `${tag} bolt M20`, 'BLT', vBolt);
  const TPA = await master('template', 'TPA', `${tag} web plate`, 'PA', vPart);
  const TPB = await master('template', 'TPB', `${tag} stiffener`, 'PB', vPart);
  const TASM = await master('template', 'TASM', `${tag} segment`, 'AS', vAsm);
  const TTOP = await master('template', 'TTOP', `${tag} girder`, 'TOP', vAsm);
  const asmBom = await bomOf(TASM, 'template');
  await line(asmBom, 10, TPA, 1, 1);
  await line(asmBom, 20, TPA, 1, 2);
  await line(asmBom, 30, TPB, 2, 1);
  await line(asmBom, 40, BOLT, 4, 1);
  const topBom = await bomOf(TTOP, 'template');
  await line(topBom, 10, TASM, 1, 1);
  await line(topBom, 20, TASM, 1, 2);
  await db.query("INSERT INTO cf_spec_values (company_id, specification_id, subject_type, subject_id, value_number, source) VALUES (?, ?, 'master', ?, 0.25, 'entered')", [COMPANY, WT.id, BOLT]);

  const orderCode = `${tag}-SO`;
  const orderId = await ins("INSERT INTO cf_sales_orders (company_id, code, order_type, title, status, created_by) VALUES (?, ?, 'customer', 'Order sheet fixture', 'inquiry', ?)", [COMPANY, orderCode, c.userId]);
  await S.addOrderLine(db, c, orderId, { recordId: TTOP, quantity: 2 });
  const [[ol]] = await db.query('SELECT id, item_id, line_no FROM cf_sales_order_lines WHERE company_id = ? AND order_id = ? AND deleted_at IS NULL', [COMPANY, orderId]);
  const at = async (parentId, lineNo) => {
    const [[k]] = await db.query(
      `SELECT l.id AS line_id, l.child_id FROM cf_bom_lines l JOIN cf_boms b ON b.id = l.bom_id AND b.deleted_at IS NULL
        WHERE l.company_id = ? AND b.parent_id = ? AND l.line_no = ? AND l.deleted_at IS NULL`,
      [COMPANY, parentId, lineNo],
    );
    if (!k) throw new Error(`The fixture's structure did not come out as expected — nothing at line ${lineNo} under record ${parentId}.`);
    return k;
  };
  const root = ol.item_id;
  const asm1 = await at(root, 10);
  const asm2 = await at(root, 20);
  const f = {
    tag, vPart, vAsm, vBolt, markRule, orderId, orderCode, lineId: ol.id, lineNo: ol.line_no, root, BOLT,
    spec: { THK, LEN, WT, DENS, GRD, CLS, HOLED, MARK, PAINT }, opt: { E250, E350, clsA, clsB },
    asm1, asm2,
    pa1: await at(asm1.child_id, 10), pa2: await at(asm1.child_id, 20), pb: await at(asm1.child_id, 30), bolt1: await at(asm1.child_id, 40),
    bolt2: await at(asm2.child_id, 40),
    rule, spec0: spec,
  };
  const set = (id, entries) => V.setValues(db, c, 'master', id, entries.map(([s, value]) => ({ specCode: s.code, value })));
  await set(asm1.child_id, [[PAINT, 'RAL5010'], [MARK, 'A1']]);
  await set(f.pa1.child_id, [[LEN, 1000], [THK, 10], [GRD, 'E350'], [HOLED, 'true']]);
  await set(f.pa2.child_id, [[LEN, 1000], [THK, 12.5]]);

  // A cut piece the way the system files one: a row under a part whose role says so. The screen never draws it.
  const cutBom = await bomOf(f.pa1.child_id, 'custom');
  f.cutLine = await line(cutBom, 10, BOLT, 1, 1, 'Cut from');
  return f;
}

/* --------------------------------------------------------------------------
 * Reading a workbook the way a person's Excel hands it back
 * ----------------------------------------------------------------------- */
const TAG_RE = /^([NV])\|(.+)$/;
const text = (v) => (v == null ? '' : typeof v === 'object' && 'richText' in v ? v.richText.map((r) => r.text).join('') : String(v));
/** The sheet as pairs: id -> { names: Row, values: Row, fields: [{ col, label, value, cell }], namesAt, valuesAt }. */
function pairsOf(ws) {
  const out = new Map();
  const order = [];
  ws.eachRow({ includeEmpty: false }, (row, n) => {
    let hit = null;
    for (let i = 1; i <= row.cellCount; i++) { const m = TAG_RE.exec(text(row.getCell(i).value)); if (m) hit = { kind: m[1], id: m[2], col: i }; }
    if (!hit) return;
    if (!out.has(hit.id)) { out.set(hit.id, { id: hit.id, idCol: hit.col }); order.push(hit.id); }
    const p = out.get(hit.id);
    if (hit.kind === 'N') { p.names = row; p.namesAt = n; } else { p.values = row; p.valuesAt = n; }
  });
  for (const p of out.values()) {
    p.fields = [];
    if (!p.names || !p.values) continue;
    for (let i = 2; i < p.idCol; i++) {
      const label = text(p.names.getCell(i).value);
      if (label) p.fields.push({ col: i, label, value: p.values.getCell(i).value, cell: p.values.getCell(i), nameCell: p.names.getCell(i) });
    }
    p.field = (label) => p.fields.find((x) => x.label === label) ?? null;
  }
  return { byId: out, order };
}
const fillOf = (cell) => cell.fill?.fgColor?.argb ?? null;
const GREY = 'FFEFEFEF';
const AMBER = 'FFFFE0A3';

/* --------------------------------------------------------------------------
 * The run
 * ----------------------------------------------------------------------- */
console.log(`order_sheet_test — company ${COMPANY}`);
const tables = await cfTables(pool);
const before = await census(pool, tables);
const conn = await pool.getConnection();
attachNodeCache(conn);
try {
  await conn.beginTransaction();
  const [[user]] = await conn.query('SELECT id FROM users WHERE company_id = ? AND deleted_at IS NULL LIMIT 1', [COMPANY]);
  const c = { companyId: COMPANY, userId: user.id };
  const f = await buildFixture(conn, c);
  const { THK, LEN, WT, DENS, GRD, CLS, HOLED, MARK, PAINT } = f.spec;

  const download = async (lineId = f.lineId) => {
    const out = await OS.exportOrderSheet(conn, COMPANY, lineId);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(out.buffer);
    const ws = wb.getWorksheet('BOM');
    return { out, wb, ws, ...pairsOf(ws) };
  };
  const upload = async (wb, dryRun = true, lineId = f.lineId) => OS.importOrderSheet(conn, c, lineId, { file: Buffer.from(await wb.xlsx.writeBuffer()), dryRun });
  /** One case on a fresh download, undone afterwards whatever it did. */
  let caseNo = 0;
  const attempt = async (fn) => {
    const sp = `order_sheet_case_${caseNo += 1}`;
    await conn.query(`SAVEPOINT ${sp}`);
    try { await fn(await download()); } finally { await conn.query(`ROLLBACK TO SAVEPOINT ${sp}`); }
  };
  const live = async () => {
    const view = await OV.readLineValues(conn, COMPANY, f.lineId);
    const tree = await B.explode(conn, COMPANY, view.root.id, { rootQuantity: view.line.quantity });
    return { view, tree };
  };
  const stored = async (recordId, s) => {
    const [[v]] = await conn.query(
      "SELECT value_number, value_text, value_bool, option_id, source FROM cf_spec_values WHERE company_id = ? AND subject_type = 'master' AND subject_id = ? AND specification_id = ? AND deleted_at IS NULL",
      [COMPANY, recordId, s.id],
    );
    if (!v) return null;
    return v.value_number != null ? Number(v.value_number) : v.value_text ?? v.option_id ?? (v.value_bool != null ? !!v.value_bool : null);
  };
  const stateOf = async () => {
    const [vals] = await conn.query("SELECT subject_id, specification_id, value_number, value_text, value_bool, option_id, source FROM cf_spec_values WHERE company_id = ? AND deleted_at IS NULL ORDER BY id", [COMPANY]);
    const [lines] = await conn.query('SELECT l.id, l.quantity FROM cf_bom_lines l WHERE l.company_id = ? AND l.deleted_at IS NULL ORDER BY l.id', [COMPANY]);
    return JSON.stringify([vals, lines]);
  };
  const id = (k) => `${k.line_id}:${k.child_id}`;
  const rootId = `ROOT:${f.root}`;

  /* ---- 1. the workbook's shape ---------------------------------------------------- */
  section('1. The workbook: one sheet, one banner, two rows per BOM row the screen draws');
  const first = await download();
  const { view, tree } = await live();
  const visible = [];
  (function walk(n) { if (n.role !== 'Cut from' && n.role !== 'Raw plate') visible.push(n); for (const k of n.children) walk(k); }(tree.root));
  const all = [];
  (function walk(n) { all.push(n); for (const k of n.children) walk(k); }(tree.root));
  eq('the fixture has the rows it was built with — a girder, 2 segments, 3 part rows and a bolt each — and one cut piece', [visible.length, all.length], [11, 12]);
  eq('the only sheet is BOM', first.wb.worksheets.map((w) => w.name), ['BOM']);
  eq('row 1 is one sentence saying how to read it', text(first.ws.getRow(1).getCell(1).value), OS.BANNER);
  ok('and nothing else is on row 1', first.ws.getRow(1).actualCellCount === 1);
  eq('the banner and the first column stay put when scrolling', [first.ws.views[0].state, first.ws.views[0].ySplit, first.ws.views[0].xSplit], ['frozen', 1, 1]);
  eq('exactly 2 rows per visible BOM row, plus the banner', first.ws.actualRowCount, 1 + 2 * visible.length);
  eq('and the route is told how many BOM rows it wrote', first.out.rows, visible.length);
  ok('it is an .xlsx named for the order and line', first.out.filename === `BOM_${f.orderCode}_L${f.lineNo}.xlsx` && /spreadsheetml/.test(first.out.contentType), first.out.filename);
  eq('the pairs are the structure depth first, in the screen’s order', first.order, visible.map((n) => L.pairId(n)));
  ok('every names row sits directly above its values row', [...first.byId.values()].every((p) => p.valuesAt === p.namesAt + 1));
  ok('the cut piece is not in the sheet', !first.order.some((x) => x.startsWith(`${f.cutLine}:`)) && all.some((n) => n.lineId === f.cutLine));
  const idCols = new Set([...first.byId.values()].map((p) => p.idCol));
  ok('the ids sit in ONE column, and it is hidden', idCols.size === 1 && first.ws.getColumn([...idCols][0]).hidden === true);
  ok('no other column is hidden, and nothing technical is in a visible cell', (() => {
    for (let i = 1; i < [...idCols][0]; i++) if (first.ws.getColumn(i).hidden) return false;
    let clean = true;
    first.ws.eachRow((row) => { for (let i = 1; i < [...idCols][0]; i++) if (/^[NV]\|/.test(text(row.getCell(i).value))) clean = false; });
    return clean;
  })());

  /* ---- 2. each pair is the screen's row -------------------------------------------- */
  section('2. Each pair: the fields readLineValues gives that row, in the layout’s order, with the view’s values');
  const layout = L.orderSheetLayout({ root: tree.root, view, codes: new Map() });
  const viewRows = new Map(view.groups.flatMap((g) => g.rows.map((r) => [r.id, { g, r }])));
  const labelsOf = (p) => p.fields.map((x) => x.label);
  let namesRight = 0;
  let valuesRight = 0;
  let fieldsRight = 0;
  const wrong = [];
  for (const row of layout) {
    const p = first.byId.get(row.id);
    const fields = row.fields.filter((x) => x.kind !== 'na');
    if (alike(labelsOf(p), fields.map((x) => x.label))) namesRight += 1; else wrong.push(`${row.label}: ${labelsOf(p).join(' | ')}`);
    if (alike(p.fields.map((x) => text(x.value)), fields.map((x) => x.value))) valuesRight += 1; else wrong.push(`${row.label}: ${p.fields.map((x) => text(x.value)).join(' | ')} vs ${fields.map((x) => x.value).join(' | ')}`);
    // Independently of the layout: the value fields are exactly the cells the values view gives this record.
    const given = Object.keys(viewRows.get(row.nodeId)?.r.cells ?? {}).sort();
    const written = fields.filter((x) => x.kind === 'value').map((x) => x.code).sort();
    if (alike(given, written)) fieldsRight += 1; else wrong.push(`${row.label}: view ${given.join(',')} vs sheet ${written.join(',')}`);
  }
  eq('every names row lists the layout’s fields, in its order', namesRight, layout.length);
  eq('every values row holds the layout’s text, cell for cell', valuesRight, layout.length);
  eq('and those fields are exactly the ones readLineValues gives each row', fieldsRight, layout.length);
  if (wrong.length) says(wrong.slice(0, 5).join(' ;; '));

  const pa1 = first.byId.get(id(f.pa1));
  const pa2 = first.byId.get(id(f.pa2));
  const pb = first.byId.get(id(f.pb));
  const a1 = first.byId.get(id(f.asm1));
  const top = first.byId.get(rootId);
  const label = (s, row = layout.find((r) => r.id === id(f.pa1))) => row.fields.find((x) => x.code === s.code)?.label;
  const rowOfLayout = (k) => layout.find((r) => r.id === k);
  // MARK leads GRD because the grid's columns run in the order the groups arrive (the assemblies' MARK first), typed before worked out.
  eq('a part reads: Qty, Total, Flow, then Thk and L first, what is typed, then what is worked out', labelsOf(pa1),
    ['Qty', 'Total', 'Flow', 'Thk (mm)', 'L (mm)', label(MARK), label(GRD), label(HOLED), label(CLS), label(WT), label(DENS)]);
  eq('a label is the grid’s short word where it has one, else the whole name — and the unit', [label(THK), label(WT), label(MARK)], ['Thk (mm)', `WT sheet test ${f.tag} (kg)`, `MARK sheet test ${f.tag}`]);
  eq('the top row has no Total (it equals its Qty) — Qty, Flow, then its own values', labelsOf(top).slice(0, 2), ['Qty', 'Flow']);
  eq('a row whose Total differs shows it', [pa1.field('Qty').value, pa1.field('Total').value, pb.field('Qty').value, pb.field('Total').value], [1, 2, 2, 4]);
  eq('column A: the name on the values row, indented by depth; the code on the names row', [text(pa1.values.getCell(1).value), pa1.values.getCell(1).alignment?.indent, text(a1.values.getCell(1).value), a1.values.getCell(1).alignment?.indent],
    [`${f.tag} web plate`, 2, `${f.tag} segment`, 1]);
  ok('the names row is grey, small and bold', fillOf(pa1.names.getCell(2)) === 'FFD9D9D9' && pa1.names.getCell(2).font?.bold === true && pa1.names.getCell(2).font?.size === 8);
  eq('a typed number is a number, a pick-list its words, yes/no in words', [pa1.field('Thk (mm)').value, pa1.field('L (mm)').value, pa1.field(label(GRD)).value, pa1.field(label(HOLED)).value], [10, 1000, 'E350 — high strength', 'Yes']);
  eq('a default is shown as the screen shows it', [pa1.field(label(CLS)).value, pa1.field(label(CLS)).cell.font?.italic], ['A', true]);
  eq('a worked-out value is its display', [pa1.field(label(WT)).value, pa1.field(label(DENS)).value], [view.groups.flatMap((g) => g.rows).find((r) => r.id === f.pa1.child_id).cells[WT.code].display, '7850 kg/m3']);
  eq('typeable cells are white; worked-out cells and Total and Flow are grey', ['Qty', 'Thk (mm)', label(MARK), label(CLS), 'Total', 'Flow', label(WT), label(DENS)].map((l) => fillOf(pa1.field(l).cell)),
    [null, null, null, null, GREY, GREY, GREY, GREY]);
  eq('a required empty cell is amber — and only that one', [fillOf(pa2.field(label(GRD)).cell), fillOf(pb.field('Thk (mm)').cell), fillOf(pa1.field(label(GRD)).cell), fillOf(pa2.field(label(MARK)).cell)], [AMBER, AMBER, null, null]);
  eq('the top row’s quantity is the order line’s — grey', fillOf(top.field('Qty').cell), GREY);
  eq('a pick-list offers that row’s own choices', pa1.field(label(GRD)).cell.dataValidation?.formulae, ['"E250,E350 — high strength"']);
  eq('yes/no offers Yes and No', pa1.field(label(HOLED)).cell.dataValidation?.formulae, ['"Yes,No"']);
  eq('a number takes a decimal; a quantity a number above zero', [pa1.field('Thk (mm)').cell.dataValidation?.type, pa1.field('Qty').cell.dataValidation?.operator], ['decimal', 'greaterThan']);
  ok('a grey cell offers nothing', !pa1.field(label(WT)).cell.dataValidation?.type && !pa1.field('Flow').cell.dataValidation?.type);
  const b1 = first.byId.get(id(f.bolt1));
  const b2 = first.byId.get(id(f.bolt2));
  ok('a record in two places is two pairs with the same values, all grey', !!b1 && !!b2 && b1 !== b2 && alike(b1.fields.slice(-1).map((x) => x.value), b2.fields.slice(-1).map((x) => x.value))
    && b1.fields.filter((x) => !['Qty', 'Total', 'Flow'].includes(x.label)).every((x) => fillOf(x.cell) === GREY));
  eq('a catalog row shows its code on the names row', text(b1.names.getCell(1).value), `${f.tag}-BOLT`);

  /* ---- 3. a round trip ------------------------------------------------------------- */
  section('3. Nothing edited is nothing changed');
  const censusBefore = await census(conn, tables);
  const stateBefore = await stateOf();
  const same = await upload(first.wb);
  eq('an untouched sheet reads back with no problems and no changes', [same.ok, same.problems, same.changes], [true, [], []]);
  eq('every pair matched and unchanged', [same.summary.rowsInSheet, same.summary.rowsMatched, same.summary.unchanged, same.summary.sentence], [visible.length, visible.length, visible.length, 'nothing to change']);
  eq('the dialog’s other counts are there and zero', [same.summary.roleChanged, same.summary.notesChanged, same.summary.rowsAdded, same.summary.rowsRemoved, same.summary.rowsRemovedBeneath, same.summary.quantityChanged, same.summary.valuesChanged], [0, 0, 0, 0, 0, 0, 0]);
  eq('it says what it read', [same.format, same.dryRun, same.orderLine.id, same.order.code, same.root.id], ['xlsx', true, f.lineId, f.orderCode, f.root]);
  const appliedSame = await upload(first.wb, false);
  eq('applying it applies nothing', [appliedSame.applied, appliedSame.changes.length], [true, 0]);
  const [[clsRow]] = await conn.query("SELECT source FROM cf_spec_values WHERE company_id = ? AND subject_type = 'master' AND subject_id = ? AND specification_id = ? AND deleted_at IS NULL", [COMPANY, f.pa1.child_id, CLS.id]);
  eq('and writes nothing — a shown default is not turned into a typed value', [diff(censusBefore, await census(conn, tables)), await stateOf() === stateBefore, clsRow?.source ?? 'defaulted'], [[], true, 'defaulted']);

  /* ---- 4. typing values ------------------------------------------------------------ */
  section('4. Typing a value: one change, a dry run writes nothing, applying saves it');
  await attempt(async (d) => {
    const p = d.byId.get(id(f.pa2));
    p.field(label(MARK)).cell.value = 'M-77';
    const censusAt = await census(conn, tables);
    const stateAt = await stateOf();
    const dry = await upload(d.wb);
    eq('the preview is one value change', [dry.ok, dry.problems, dry.changes.map((ch) => [ch.action, ch.field, ch.rowId, ch.from, ch.to])], [true, [], [['value', label(MARK), id(f.pa2), null, 'M-77']]]);
    eq('and says so', [dry.summary.valuesChanged, dry.summary.quantityChanged, dry.summary.unchanged, dry.summary.sentence], [1, 0, visible.length - 1, '1 value changed']);
    ok('the change names its row', dry.changes[0].path === `${f.tag} web plate`, dry.changes[0].path);
    eq('the dry run wrote nothing', [diff(censusAt, await census(conn, tables)), await stateOf() === stateAt], [[], true]);
    const applied = await upload(d.wb, false);
    eq('applying it saves the value', [applied.applied, applied.ok, await stored(f.pa2.child_id, MARK)], [true, true, 'M-77']);
    const again = await download();
    eq('a fresh download shows it', again.byId.get(id(f.pa2)).field(label(MARK)).value, 'M-77');
    eq('and that download reads back as no change', (await upload(again.wb)).changes, []);
  });
  await attempt(async (d) => {
    const p = d.byId.get(id(f.pa2));
    p.field(label(GRD)).cell.value = 'E350 — high strength'; // a pick-list, by the words the dropdown offers
    p.field(label(HOLED)).cell.value = 'Yes';
    p.field('Thk (mm)').cell.value = 16;
    p.field(label(CLS)).cell.value = 'B';                    // typing over a shown default
    d.byId.get(id(f.pa1)).field('L (mm)').cell.value = null; // clearing a value
    d.byId.get(id(f.asm1)).field(rowOfLayout(id(f.asm1)).fields.find((x) => x.code === PAINT.code).label).cell.value = 'RAL7035';
    const dry = await upload(d.wb);
    eq('six cells typed are six value changes', [dry.ok, dry.problems, dry.summary.valuesChanged, dry.summary.unchanged], [true, [], 6, visible.length - 3]);
    const applied = await upload(d.wb, false);
    eq('each is saved as its own kind: option, yes/no, number, an overridden default, a cleared value, text',
      [applied.applied, await stored(f.pa2.child_id, GRD), await stored(f.pa2.child_id, HOLED), await stored(f.pa2.child_id, THK), await stored(f.pa2.child_id, CLS), await stored(f.pa1.child_id, LEN), await stored(f.asm1.child_id, PAINT)],
      [true, f.opt.E350, true, 16, f.opt.clsB, null, 'RAL7035']);
    const again = await download();
    const q = again.byId.get(id(f.pa2));
    eq('a fresh download shows them all, and the cleared length is amber again',
      [q.field(label(GRD)).value, q.field(label(HOLED)).value, q.field('Thk (mm)').value, q.field(label(CLS)).value, q.field(label(CLS)).cell.font?.italic ?? false, fillOf(again.byId.get(id(f.pa1)).field('L (mm)').cell)],
      ['E350 — high strength', 'Yes', 16, 'B', false, AMBER]);
  });
  await attempt(async (d) => {
    d.byId.get(id(f.pa1)).field('Thk (mm)').cell.value = '10.0';
    d.byId.get(id(f.pa1)).field(label(CLS)).cell.value = null; // the shown default wiped: the row has no own value to clear
    const dry = await upload(d.wb);
    eq('the same number written another way, and a wiped default, are not changes', [dry.ok, dry.changes, dry.summary.unchanged], [true, [], visible.length]);
  });

  /* ---- 5. a quantity --------------------------------------------------------------- */
  section('5. A quantity goes through the line update edit mode uses');
  await attempt(async (d) => {
    d.byId.get(id(f.pb)).field('Qty').cell.value = 5;
    d.byId.get(id(f.pa2)).field(label(MARK)).cell.value = 'Q-1';
    const stateAt = await stateOf();
    const dry = await upload(d.wb);
    eq('the preview is one quantity and one value, the quantity first', [dry.ok, dry.changes.map((ch) => [ch.action, ch.field, ch.from, ch.to]), dry.summary.sentence],
      [true, [['update', 'quantity', 2, 5], ['value', label(MARK), null, 'Q-1']], '1 quantity changed, 1 value changed']);
    ok('and it wrote nothing', await stateOf() === stateAt);
    const applied = await upload(d.wb, false);
    const [[lineNow]] = await conn.query('SELECT quantity FROM cf_bom_lines WHERE id = ?', [f.pb.line_id]);
    eq('applying saves both', [applied.applied, Number(lineNow.quantity), await stored(f.pa2.child_id, MARK)], [true, 5, 'Q-1']);
    const again = await download();
    eq('a fresh download shows the new quantity and its total', [again.byId.get(id(f.pb)).field('Qty').value, again.byId.get(id(f.pb)).field('Total').value], [5, 10]);
  });

  /* ---- 6. what may not be typed ---------------------------------------------------- */
  section('6. What may not be typed is a problem in words, and nothing is applied');
  const refused = async (what, edit, pattern) => attempt(async (d) => {
    await edit(d);
    const stateAt = await stateOf();
    const censusAt = await census(conn, tables);
    const dry = await upload(d.wb);
    ok(`${what}: the preview says so`, dry.ok === false && dry.problems.length >= 1 && dry.problems.some((p) => pattern.test(p)), JSON.stringify(dry.problems));
    says(dry.problems[0]);
    eq(`${what}: it promises no changes`, [dry.changes, dry.summary.valuesChanged, dry.summary.quantityChanged], [[], 0, 0]);
    const err = await refusal(() => upload(d.wb, false));
    ok(`${what}: applying is refused with the same problems`, err?.status === 422 && Array.isArray(err.problems) && err.problems.some((p) => pattern.test(p)), err ? `${err.code}: ${err.message}` : 'it was accepted');
    eq(`${what}: nothing was written`, [diff(censusAt, await census(conn, tables)), await stateOf() === stateAt], [[], true]);
  });
  await refused('a worked-out cell', (d) => { d.byId.get(id(f.pa1)).field(label(WT)).cell.value = 99; d.byId.get(id(f.pa2)).field(label(MARK)).cell.value = 'never'; }, /worked out, not typed/);
  await refused('a fixed value', (d) => { d.byId.get(id(f.pa1)).field(label(DENS)).cell.value = 8000; }, /worked out, not typed.*Fixed at/);
  await refused('the flow cell', (d) => { d.byId.get(id(f.pa1)).field('Flow').cell.value = 'SOME-FLOW'; }, /Flow .*was changed to "SOME-FLOW".*chosen on the screen/);
  await refused('the Total cell', (d) => { d.byId.get(id(f.pa1)).field('Total').cell.value = 7; }, /Total \(2\) was changed to "7".*Change Qty/);
  await refused('the top row’s quantity', (d) => { d.byId.get(rootId).field('Qty').cell.value = 9; }, /order line’s own quantity/);
  await refused('a quantity that is not one', (d) => { d.byId.get(id(f.pb)).field('Qty').cell.value = -3; }, /not a quantity/);
  await refused('an unknown id', (d) => { const p = d.byId.get(id(f.pa2)); p.names.getCell(p.idCol).value = 'N|999999999:1'; p.values.getCell(p.idCol).value = 'V|999999999:1'; p.field(label(MARK)).cell.value = 'x'; }, /not part of the structure any more/);
  await refused('an edited field name', (d) => { const p = d.byId.get(id(f.pa2)); p.field(label(MARK)).nameCell.value = 'My own name'; p.field('My own name'); }, /"My own name" is not one of this line’s fields/);
  await refused('a pair without its values row', (d) => { d.ws.spliceRows(d.byId.get(id(f.pa2)).valuesAt, 1); }, /row of values under its names is missing/);
  await refused('a value on a shared catalog record', (d) => { const p = d.byId.get(id(f.bolt1)); p.fields[p.fields.length - 1].cell.value = 0.5; }, /sits in 2 places.*is given as "0.5".*and as "0.25"|not typed/);
  await refused('a choice the pick-list does not have', (d) => { d.byId.get(id(f.pa2)).field(label(GRD)).cell.value = 'E450'; }, /"E450" is not one of the choices/);
  await refused('text in a number', (d) => { d.byId.get(id(f.pa2)).field('Thk (mm)').cell.value = 'thick'; }, /needs a number/);
  await refused('a value typed under no name', (d) => { const p = d.byId.get(id(f.pa2)); p.values.getCell(p.idCol - 1 > p.fields[p.fields.length - 1].col ? p.fields[p.fields.length - 1].col + 1 : p.idCol + 1).value = 'stray'; }, /sits under no field name/);
  await attempt(async (d) => {
    const p1 = d.byId.get(id(f.bolt1));
    p1.fields[p1.fields.length - 1].cell.value = 0.5;
    const dry = await upload(d.wb);
    ok('two places of one record given two values: the problem names both', dry.problems.some((p) => /sits in 2 places/.test(p) && /"0\.5"/.test(p) && /"0\.25"/.test(p) && p.includes(id(f.bolt1)) && p.includes(id(f.bolt2))), JSON.stringify(dry.problems));
  });
  await attempt(async (d) => {
    const foreign = Buffer.from('Name,Quantity\r\nX,1\r\n', 'utf8');
    const csv = await refusal(() => OS.importOrderSheet(conn, c, f.lineId, { file: foreign, dryRun: true }));
    ok('a CSV is refused — the order-line sheet is .xlsx only', csv?.status === 422 && /not an Excel workbook/.test(csv.message), csv?.message);
    const wb = new ExcelJS.Workbook(); wb.addWorksheet('BOM').addRow(['Name', 'Quantity']); wb.getWorksheet('BOM').addRow(['X', 1]);
    const other = await upload(wb);
    ok('a workbook that is not this sheet is a problem in words', other.ok === false && /not a sheet downloaded from this order line/.test(other.problems[0] ?? ''), JSON.stringify(other.problems));
    ok('no file at all is refused', (await refusal(() => OS.importOrderSheet(conn, c, f.lineId, {})))?.code === 'NO_FILE');
    void d;
  });

  /* ---- 7. a sheet a person has been at ---------------------------------------------- */
  section('7. A sorted or cut-down sheet still reads back by its ids');
  await attempt(async (d) => {
    const keep = [id(f.pa2), id(f.asm1)];
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('BOM');
    ws.addRow([OS.BANNER]);
    // The pairs in another order, with a blank row between them; everything else left out.
    for (const k of keep) {
      const p = d.byId.get(k);
      if (k === id(f.pa2)) p.field(label(MARK)).cell.value = 'SORTED';
      for (const src of [p.names, p.values]) { const vals = []; for (let i = 1; i <= p.idCol; i++) vals[i] = src.getCell(i).value; ws.addRow(vals.slice(1)); }
      ws.addRow([]);
    }
    const dry = await upload(wb);
    eq('two pairs out of eleven, moved about: one change, no problems', [dry.ok, dry.problems, dry.summary.rowsInSheet, dry.summary.rowsMatched, dry.changes.map((ch) => [ch.rowId, ch.to])], [true, [], 2, 2, [[id(f.pa2), 'SORTED']]]);
    const applied = await upload(wb, false);
    eq('and rows left out of the sheet are left alone', [applied.applied, await stored(f.pa2.child_id, MARK), await stored(f.asm1.child_id, MARK), await stored(f.pa1.child_id, THK)], [true, 'SORTED', 'A1', 10]);
  });

  /* ---- 8. always the latest list of fields ------------------------------------------ */
  section('8. Every download has the fields as they are NOW');
  await attempt(async (old) => {
    await conn.query('UPDATE cf_spec_assignments SET deleted_at = NOW() WHERE company_id = ? AND id = ?', [COMPANY, f.markRule]);
    const after = await download();
    ok('a field that stopped applying to parts is gone from their pairs', !labelsOf(after.byId.get(id(f.pa1))).includes(label(MARK)) && !labelsOf(after.byId.get(id(f.pb))).includes(label(MARK)), labelsOf(after.byId.get(id(f.pa1))).join(' | '));
    ok('and stays on the rows it still applies to', labelsOf(after.byId.get(id(f.asm1))).includes(rowOfLayout(id(f.asm1)).fields.find((x) => x.code === MARK.code).label));
    eq('still two rows per BOM row', after.ws.actualRowCount, 1 + 2 * visible.length);
    old.byId.get(id(f.pa2)).field(label(MARK)).cell.value = 'too late';
    const stale = await upload(old.wb);
    ok('a sheet downloaded before the change says its field no longer applies', stale.ok === false && stale.problems.some((p) => p.includes(`"${label(MARK)}" is not one of this line’s fields`)), JSON.stringify(stale.problems.slice(0, 2)));

    const NEWF = await f.spec0('NEWF', 'text');
    await f.rule('classification', f.vPart, NEWF, 'entered', { required: true, sort: 20 });
    const added = await download();
    const newLabel = L.fieldLabel(NEWF.code, `NEWF sheet test ${f.tag}`, null);
    const q = added.byId.get(id(f.pa1));
    ok('a field added to parts is in their very next download, amber because it is required and empty', labelsOf(q).includes(newLabel) && fillOf(q.field(newLabel).cell) === AMBER, labelsOf(q).join(' | '));
    ok('and not on the rows it does not apply to', !labelsOf(added.byId.get(id(f.asm1))).includes(newLabel));
    q.field(newLabel).cell.value = 'filled';
    const applied = await upload(added.wb, false);
    eq('and it can be filled in from that sheet', [applied.applied, applied.summary.valuesChanged, await stored(f.pa1.child_id, NEWF)], [true, 1, 'filled']);
    eq('the names match the values view of the same moment', labelsOf((await download()).byId.get(id(f.pa1))).slice(3).length,
      Object.keys((await OV.readLineValues(conn, COMPANY, f.lineId)).groups.flatMap((g) => g.rows).find((r) => r.id === f.pa1.child_id).cells).length);
  });

  /* ---- 9. a locked line -------------------------------------------------------------- */
  section('9. A locked line still downloads, all grey, and refuses to come back in');
  await attempt(async (open) => {
    await conn.query('UPDATE cf_sales_order_lines SET locked_at = NOW() WHERE id = ?', [f.lineId]);
    const locked = await download();
    eq('the same rows come out', [locked.out.rows, locked.ws.actualRowCount], [visible.length, 1 + 2 * visible.length]);
    ok('the banner is the line’s own locked message', /is locked — its structure, values and cut pieces no longer change/.test(text(locked.ws.getRow(1).getCell(1).value)), text(locked.ws.getRow(1).getCell(1).value));
    ok('every value cell is grey and offers nothing', [...locked.byId.values()].every((p) => p.fields.every((x) => fillOf(x.cell) === GREY && !x.cell.dataValidation?.type)));
    // By name, not by position: with nothing typeable any more the grid no longer moves the typed columns ahead of the
    // worked-out ones (orderValuesService: no column of a locked line is editable), and the sheet follows the grid.
    const byName = (d) => [...d.byId.values()].map((p) => p.fields.map((x) => `${x.label}=${text(x.value)}`).sort());
    eq('with the same fields and the same text as before the lock', byName(locked), byName(open));
    eq('in the order the locked screen draws them — the worked-out weight no longer behind the typed values', labelsOf(locked.byId.get(id(f.pa1))),
      ['Qty', 'Total', 'Flow', 'Thk (mm)', 'L (mm)', label(MARK), label(WT), label(GRD), label(HOLED), label(CLS), label(DENS)]);
    for (const [what, wb, dry] of [['the open sheet', open.wb, true], ['its own sheet', locked.wb, true], ['applying', open.wb, false]]) {
      const err = await refusal(() => upload(wb, dry));
      ok(`upload is refused in the line’s locked words — ${what}`, err?.code === 'LOCKED' && /is locked — its structure, values and cut pieces no longer change/.test(err?.message ?? ''), err ? `${err.code}: ${err.message}` : 'it was accepted');
    }
  });
  const [[realLine]] = await conn.query('SELECT ol.id, ol.locked_at FROM cf_sales_order_lines ol WHERE ol.company_id = ? AND ol.id = ? AND ol.deleted_at IS NULL AND ol.item_id IS NOT NULL', [COMPANY, FROZEN_LINE]);
  if (!realLine?.locked_at) {
    console.log(`  SKIP  line ${FROZEN_LINE} is not a locked line of company ${COMPANY} here — the real-structure checks are left out.`);
  } else {
    const censusAt = await census(conn, tables);
    const big = await roundTrips(conn, () => download(FROZEN_LINE));
    const bigView = await OV.readLineValues(conn, COMPANY, FROZEN_LINE);
    const bigTree = await B.explode(conn, COMPANY, bigView.root.id, { rootQuantity: bigView.line.quantity });
    let shown = 0;
    let levels = 0;
    (function walk(n) { if (n.role !== 'Cut from' && n.role !== 'Raw plate') shown += 1; levels = Math.max(levels, n.depth); for (const k of n.children) walk(k); }(bigTree.root));
    eq(`the real locked line ${FROZEN_LINE}: two rows per row on screen`, [big.out.out.rows, big.out.ws.actualRowCount], [shown, 1 + 2 * shown]);
    ok('every pair is whole', [...big.out.byId.values()].every((p) => p.names && p.values && p.valuesAt === p.namesAt + 1 && p.fields.length >= 2));
    ok('everything in it is grey', [...big.out.byId.values()].every((p) => p.fields.every((x) => fillOf(x.cell) === GREY)));
    ok(`its ${shown} rows took a bounded number of round trips (${big.n}), not one per row`, big.n < 60 + 3 * levels && big.n < shown, `${big.n} for ${shown} rows, ${levels} levels`);
    const err = await refusal(() => upload(big.out.wb, true, FROZEN_LINE));
    ok('and it refuses to come back in', !!err && [409, 422].includes(err.status) && /locked|released|no longer change|frozen/.test(err.message), err ? `${err.code}: ${err.message}` : 'it was accepted');
    eq('reading it wrote nothing', diff(censusAt, await census(conn, tables)), []);
  }

  /* ---- 10. the routes ---------------------------------------------------------------- */
  section('10. The order-line routes use this sheet; the record routes keep theirs');
  const src = (await import('fs')).readFileSync(path.join(BE, 'apps/cf_erp/routes/bomSheet.js'), 'utf8');
  const routeOf = (method, p) => sheetRoutes.stack.find((l) => l.route?.path === p && l.route.methods[method])?.route ?? null;
  ok('GET and POST /order-lines/:id/sheet exist', !!routeOf('get', '/order-lines/:id/sheet') && !!routeOf('post', '/order-lines/:id/sheet'));
  ok('GET and POST /records/:id/bom/sheet exist', !!routeOf('get', '/records/:id/bom/sheet') && !!routeOf('post', '/records/:id/bom/sheet'));
  ok('the order-line pair calls exportOrderSheet / importOrderSheet', /order-lines\/:id\/sheet'[^]*?exportOrderSheet\(/.test(src) && /importOrderSheet\(db, c, id\(req\)/.test(src));
  ok('the record pair still calls exportRecordSheet / importRecordSheet', /exportRecordSheet\(pool/.test(src) && /importRecordSheet\(db, c, id\(req\)/.test(src));
  ok('the order-line download takes no ?format — it is always .xlsx', !/exportOrderSheet\([^)]*format/.test(src));

  await conn.rollback();
  console.log('\nrolled back.');
} catch (err) {
  try { await conn.rollback(); } catch { /* the original error is the one that matters */ }
  failed += 1;
  fails.push('the run itself');
  console.error('\nTHREW:', err.code ?? '', err.message);
  if (err.problems) console.error('problems:', err.problems);
  console.error(err.stack?.split('\n').slice(1, 8).join('\n'));
} finally {
  detachNodeCache(conn);
  conn.release();
}

section('11. Nothing survived the rollback');
const after = await census(pool, tables);
const left = diff(before, after);
ok(`every cf_ table (${tables.length}) is back to the count it started at`, left.length === 0, left.join(', '));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) console.log(`failed: ${fails.join(' · ')}`);
await pool.end();
process.exitCode = failed ? 1 : 0;
