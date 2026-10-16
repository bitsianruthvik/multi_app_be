/**
 * order_defaults_test.mjs — ORDER and LINE values for specifications (init.sql §65,
 * lib/orderDefaults.js, services/orderDefaultService.js, GET/PUT /orders/:id/spec-defaults),
 * against the local DB.
 *
 *   cd multi_app_be && node scripts/cf_kepl/order_defaults_test.mjs
 *
 * User, 2026-10-16: "The various coats, MS BO or BR, all of these are also set at an order or a line
 * level typically and can be overridden in the values screen if required."
 *
 * Most specific wins: row entry > line value > order value > the spec's own rule. The suite proves the
 * inheritance order, an override and its clearing, the required check, a formula reading an inherited
 * value (and an order value standing over a Defaulted formula), a narrowed option list, the two
 * resolvers agreeing, a LOCKED line untouched by a later order change, a revision carrying the values,
 * the one-off proposal, and that the reads and writes cost the same whatever the size of the line.
 *
 * EVERYTHING HAPPENS INSIDE ONE TRANSACTION THAT IS ROLLED BACK, and the last thing it does is re-count
 * every table it wrote. IT BUILDS ITS OWN FIXTURE (every code and name carries this run's tag) and reads
 * none of the company's nodes, records or rules. The "locked" line is locked by setting locked_at — a real
 * lock needs codes and cut pieces this fixture has no rules for; frozenBy reads exactly that column.
 */
import path from 'path';
import { pathToFileURL } from 'url';

const BE = process.cwd();
const imp = (p) => import(pathToFileURL(path.join(BE, p)).href);
const { pool } = await imp('db.js');
const { attachNodeCache, detachNodeCache } = await imp('apps/cf_erp/lib/db.js');
await imp('apps/cf_erp/services/codegenProvider.js');
const OV = await imp('apps/cf_erp/services/orderValuesService.js');
const OD = await imp('apps/cf_erp/services/orderDefaultService.js');
const S = await imp('apps/cf_erp/services/salesOrderService.js');
const V = await imp('apps/cf_erp/services/valueService.js');
const R = await imp('apps/cf_erp/services/resolutionService.js');
const SPEC = await imp('apps/cf_erp/services/specificationService.js');
const REV = await imp('apps/cf_erp/services/revisionService.js');
const { loadMaster } = await imp('apps/cf_erp/services/records.js');
const { protect } = await imp('core/middleware/authmiddleware.js');
const valuesRoutes = (await imp('apps/cf_erp/routes/orderValues.js')).default;

const COMPANY = Number(process.env.CF_VALUES_COMPANY ?? 2);

let passed = 0;
let failed = 0;
const fails = [];
function ok(label, cond, detail = '') {
  if (typeof label !== 'string' || typeof cond !== 'boolean') throw new Error(`ok(label, cond) was called as ok(${typeof label}, ${typeof cond}).`);
  if (cond) { passed += 1; console.log(`  PASS  ${label}`); } else { failed += 1; fails.push(label); console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
}
const alike = (got, want) => Object.is(got, want) || JSON.stringify(got) === JSON.stringify(want);
const eq = (label, got, want) => ok(label, alike(got, want), `got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);
const near = (label, got, want) => ok(label, got != null && Math.abs(Number(got) - want) < 1e-6, `got ${got}, wanted ${want}`);
const section = (s) => console.log(`\n${s}`);
const says = (text) => console.log(`        says: ${text}`);
const refusal = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

const COUNTED = [
  'cf_classification_nodes', 'cf_specifications', 'cf_spec_options', 'cf_formulas', 'cf_spec_assignments', 'cf_spec_assignment_options',
  'cf_spec_values', 'cf_spec_value_history', 'cf_master_records', 'cf_item_details', 'cf_definition_details', 'cf_boms', 'cf_bom_lines',
  'cf_sales_orders', 'cf_sales_order_lines', 'cf_order_spec_defaults', 'cf_order_spec_default_history',
];
async function counts(db) {
  const out = {};
  for (const t of COUNTED) out[t] = Number((await db.query(`SELECT COUNT(*) AS n FROM \`${t}\``))[0][0].n);
  return out;
}
const diff = (a, b) => COUNTED.filter((t) => a[t] !== b[t]).map((t) => `${t} ${a[t]}->${b[t]}`);
async function roundTrips(conn, fn) {
  const real = conn.query.bind(conn);
  let n = 0;
  conn.query = (...a) => { n += 1; return real(...a); };
  try { return { out: await fn(), n }; } finally { conn.query = real; }
}
const routeOf = (router, method, routePath) => router.stack.find((l) => l.route?.path === routePath && l.route.methods[method])?.route ?? null;
const guardsOf = (route) => route.stack.slice(0, -1).map((l) => l.handle).filter((fn) => fn !== protect);
async function throughGuards(route, user) {
  const req = { user, params: { id: '1' }, body: {}, headers: {}, cookies: {} };
  for (const fn of guardsOf(route)) {
    let on = false; let status = null;
    const res = { status(code) { status = code; return this; }, json() { return this; } };
    await fn(req, res, () => { on = true; });
    if (!on) return { reached: false, status };
  }
  return { reached: true, status: null };
}
const user = (tags) => ({ id: null, role: 'user', companyId: COMPANY, uiPermissions: tags });

/* --------------------------------------------------------------------------
 * The fixture
 * ----------------------------------------------------------------------- */
async function buildFixture(db, c) {
  const tag = `ODT${Date.now().toString(36).toUpperCase()}`;
  const ins = async (sql, params) => (await db.query(sql, params))[0].insertId;
  const node = (parentId, depth, key) => ins(
    "INSERT INTO cf_classification_nodes (company_id, parent_id, depth, scope, code, name, status) VALUES (?, ?, ?, 'both', ?, ?, 'active')",
    [COMPANY, parentId, depth, `${tag}-${key}`, `${tag} ${key} — order defaults test`],
  );
  const fam = await node(null, 0, 'F');
  const sub = await node(fam, 1, 'S');
  const vPart = await node(sub, 2, 'PART');
  const vAsm = await node(sub, 2, 'ASM');
  const spec = async (key, dataType, { uom = null, decimals = null } = {}) => {
    const code = `${tag}_${key}`;
    const id = await ins("INSERT INTO cf_specifications (company_id, code, name, data_type, default_uom, decimals, status) VALUES (?, ?, ?, ?, ?, ?, 'active')",
      [COMPANY, code, `${key} (order defaults test)`, dataType, uom, decimals]);
    return { id, code };
  };
  const LEN = await spec('LEN', 'number', { uom: 'mm' });
  const WID = await spec('WID', 'number', { uom: 'mm' });
  const THK = await spec('THK', 'number', { uom: 'mm' });
  const DENS = await spec('DENS', 'number', { uom: 'kg/m3' });
  const WT = await spec('WT', 'number', { uom: 'kg', decimals: 3 });
  const GRD = await spec('GRD', 'option');
  const CLS = await spec('CLS', 'option');
  const COATS = await spec('COATS', 'number');
  const MCOAT = await spec('MCOAT', 'number');
  const MARK = await spec('MARK', 'text');
  const option = (specId, value, sort) => ins("INSERT INTO cf_spec_options (company_id, specification_id, value, sort_order, status) VALUES (?, ?, ?, ?, 'active')", [COMPANY, specId, value, sort]);
  const E250 = await option(GRD.id, 'E250', 1);
  const E350 = await option(GRD.id, 'E350', 2);
  const E450 = await option(GRD.id, 'E450', 3);
  const clsA = await option(CLS.id, 'BO', 1);
  const clsB = await option(CLS.id, 'BR', 2);
  const formula = (key, expression) => ins("INSERT INTO cf_formulas (company_id, code, name, expression, status) VALUES (?, ?, ?, ?, 'active')", [COMPANY, `${tag}_${key}`, key, expression]);
  const PWT = await formula('PWT', `${LEN.code} * ${WID.code} * ${THK.code} * ${DENS.code} / 1000000000`);
  const PMC = await formula('PMC', `${COATS.code} + 1`);
  const AWT = await formula('AWT', `SUM(children.${WT.code})`);
  const rule = (subjectId, s, valueRule, { required = false, formulaId = null, sort = 0 } = {}) => ins(
    `INSERT INTO cf_spec_assignments (company_id, specification_id, subject_type, subject_id, capture_at, is_required, is_applicable, value_rule, formula_id, sort_order, created_by)
     VALUES (?, ?, 'classification', ?, 'item', ?, 1, ?, ?, ?, ?)`,
    [COMPANY, s.id, subjectId, required ? 1 : 0, valueRule, formulaId, sort, c.userId],
  );
  const classValue = (nodeId, s, column, value) => db.query(
    `INSERT INTO cf_spec_values (company_id, specification_id, subject_type, subject_id, ${column}, source) VALUES (?, ?, 'classification', ?, ?, 'entered')`, [COMPANY, s.id, nodeId, value]);
  await rule(fam, DENS, 'defaulted', { sort: 90 });
  await classValue(fam, DENS, 'value_number', 7850);
  await rule(vPart, LEN, 'entered', { required: true, sort: 1 });
  await rule(vPart, WID, 'entered', { required: true, sort: 2 });
  await rule(vPart, THK, 'entered', { required: true, sort: 3 });
  const grdRule = await rule(vPart, GRD, 'entered', { required: true, sort: 4 });
  for (const o of [E250, E350]) await db.query('INSERT INTO cf_spec_assignment_options (company_id, assignment_id, option_id) VALUES (?, ?, ?)', [COMPANY, grdRule, o]);
  await rule(vPart, CLS, 'defaulted', { required: true, sort: 5 });
  await classValue(vPart, CLS, 'option_id', clsA);
  await rule(vPart, COATS, 'entered', { sort: 6 });
  await rule(vPart, MCOAT, 'defaulted', { formulaId: PMC, sort: 7 });
  await rule(vPart, WT, 'calculated', { formulaId: PWT, sort: 8 });
  await rule(vPart, MARK, 'entered', { sort: 9 });
  await rule(vAsm, MARK, 'entered', { sort: 1 });
  await rule(vAsm, COATS, 'entered', { sort: 2 });
  await rule(vAsm, WT, 'rollup', { formulaId: AWT, sort: 3 });
  await db.query("UPDATE cf_spec_assignments SET is_applicable = 1 WHERE company_id = ? AND subject_id = ? AND specification_id = ?", [COMPANY, vAsm, DENS.id]);
  const master = async (key, name, short, classificationId) => {
    const id = await ins("INSERT INTO cf_master_records (company_id, record_kind, code, name, short_name, classification_id, status, created_by) VALUES (?, 'definition', ?, ?, ?, ?, 'active', ?)",
      [COMPANY, `${tag}-${key}`, name, short, classificationId, c.userId]);
    await db.query("INSERT INTO cf_definition_details (master_id, company_id, definition_type) VALUES (?, ?, 'template')", [id, COMPANY]);
    return id;
  };
  const bomOf = (parentId) => ins("INSERT INTO cf_boms (company_id, parent_id, bom_type, status, created_by) VALUES (?, ?, 'template', 'active', ?)", [COMPANY, parentId, c.userId]);
  const line = (bomId, lineNo, childId, qty, position = 1) => ins(
    'INSERT INTO cf_bom_lines (company_id, bom_id, line_no, child_id, design_id, position, quantity, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [COMPANY, bomId, lineNo, childId, childId, position, qty, c.userId]);
  const TPA = await master('TPA', 'Web plate', 'PA', vPart);
  const TPB = await master('TPB', 'Stiffener', 'PB', vPart);
  const TASM = await master('TASM', 'Segment', 'AS', vAsm);
  const TTOP = await master('TTOP', 'Girder', 'TOP', vAsm);
  const TBIG = await master('TBIG', 'Long girder', 'BIG', vAsm);
  const asmBom = await bomOf(TASM);
  await line(asmBom, 10, TPA, 1, 1);
  await line(asmBom, 20, TPA, 1, 2);
  await line(asmBom, 30, TPB, 2, 1);
  const topBom = await bomOf(TTOP);
  await line(topBom, 10, TASM, 1, 1);
  await line(topBom, 20, TASM, 1, 2);
  const bigBom = await bomOf(TBIG);
  for (let i = 1; i <= 8; i++) await line(bigBom, i * 10, TASM, 1, i);

  const orderId = await ins("INSERT INTO cf_sales_orders (company_id, code, order_type, title, status, created_by) VALUES (?, ?, 'customer', 'Order defaults fixture', 'inquiry', ?)", [COMPANY, `${tag}-SO`, c.userId]);
  await S.addOrderLine(db, c, orderId, { recordId: TTOP, quantity: 1 });
  await S.addOrderLine(db, c, orderId, { recordId: TTOP, quantity: 1 });
  await S.addOrderLine(db, c, orderId, { recordId: TBIG, quantity: 1 });
  const [ols] = await db.query('SELECT id, item_id, line_no FROM cf_sales_order_lines WHERE company_id = ? AND order_id = ? AND deleted_at IS NULL ORDER BY line_no, id', [COMPANY, orderId]);
  const at = async (parentId, lineNo) => {
    const [[k]] = await db.query(
      `SELECT l.child_id FROM cf_bom_lines l JOIN cf_boms b ON b.id = l.bom_id AND b.deleted_at IS NULL
        WHERE l.company_id = ? AND b.parent_id = ? AND l.line_no = ? AND l.deleted_at IS NULL`, [COMPANY, parentId, lineNo]);
    if (!k) throw new Error(`Nothing at line ${lineNo} under ${parentId}.`);
    return k.child_id;
  };
  const shape = async (ol) => {
    const asm1 = await at(ol.item_id, 10); const asm2 = await at(ol.item_id, 20);
    return { lineId: ol.id, lineNo: ol.line_no, root: ol.item_id, asm1, asm2,
      a1pa1: await at(asm1, 10), a1pa2: await at(asm1, 20), a1pb: await at(asm1, 30),
      a2pa1: await at(asm2, 10), a2pa2: await at(asm2, 20), a2pb: await at(asm2, 30) };
  };
  return {
    tag, orderId, orderCode: `${tag}-SO`, vPart,
    spec: { LEN, WID, THK, DENS, WT, GRD, CLS, COATS, MCOAT, MARK },
    opt: { E250, E350, E450, clsA, clsB },
    L1: await shape(ols[0]), L2: await shape(ols[1]), L3: { lineId: ols[2].id, lineNo: ols[2].line_no, root: ols[2].item_id },
  };
}

async function stored(db, subjectId, s) {
  const [[v]] = await db.query(
    "SELECT value_number, value_text, option_id, source FROM cf_spec_values WHERE company_id = ? AND subject_type = 'master' AND subject_id = ? AND specification_id = ? AND deleted_at IS NULL",
    [COMPANY, subjectId, s.id]);
  if (!v) return null;
  return { value: v.value_number != null ? Number(v.value_number) : v.value_text ?? v.option_id, source: v.source };
}
async function stateOf(db, ids) {
  const [rows] = await db.query(
    `SELECT subject_id, specification_id, value_number, value_text, option_id, source FROM cf_spec_values
      WHERE company_id = ? AND subject_type = 'master' AND subject_id IN (?) AND deleted_at IS NULL ORDER BY subject_id, specification_id`, [COMPANY, ids]);
  return rows.map((r) => `${r.subject_id}:${r.specification_id}=${r.value_number == null ? '' : Number(r.value_number)}|${r.value_text ?? ''}|${r.option_id ?? ''}|${r.source}`);
}
const rowOf = (view, id) => view.groups.flatMap((g) => g.rows.map((r) => ({ g, r }))).find((x) => x.r.id === id) ?? null;
const cellOf = (view, id, s) => rowOf(view, id)?.r.cells[s.code] ?? null;
async function mirrorDiffers(db, lineId) {
  const mirror = await OV.resolveLineRecords(db, COMPANY, lineId);
  const bad = [];
  for (const [id, pub] of mirror) {
    const real = R.publicResolution(await R.resolve(db, COMPANY, { master: await loadMaster(db, COMPANY, id) }));
    if (JSON.stringify(real) !== JSON.stringify(pub)) bad.push(id);
  }
  return { size: mirror.size, bad };
}
const ownIdsOf = (L) => [L.root, L.asm1, L.asm2, L.a1pa1, L.a1pa2, L.a1pb, L.a2pa1, L.a2pa2, L.a2pb];

/* --------------------------------------------------------------------------
 * The run
 * ----------------------------------------------------------------------- */
console.log(`order_defaults_test — company ${COMPANY}`);

section('1. The routes and their guards');
const getRoute = routeOf(valuesRoutes, 'get', '/orders/:id/spec-defaults');
const putRoute = routeOf(valuesRoutes, 'put', '/orders/:id/spec-defaults');
ok('GET /orders/:id/spec-defaults is registered', !!getRoute);
ok('PUT /orders/:id/spec-defaults is registered', !!putRoute);
if (getRoute && putRoute) {
  ok('both check the token first', getRoute.stack[0]?.handle === protect && putRoute.stack[0]?.handle === protect);
  ok('the orders view grant reads', (await throughGuards(getRoute, user(['cf_erp_orders_view']))).reached);
  ok('the view grant alone cannot write', !(await throughGuards(putRoute, user(['cf_erp_orders_view']))).reached);
  ok('the orders grant writes (as the Values stage)', (await throughGuards(putRoute, user(['cf_erp_orders_view', 'cf_erp_orders_manage']))).reached);
}

const [[someUser]] = await pool.query('SELECT id FROM users WHERE company_id = ? ORDER BY id LIMIT 1', [COMPANY]);
const c = { companyId: COMPANY, userId: someUser?.id ?? null };
const before = await counts(pool);
const conn = await pool.getConnection();
await conn.beginTransaction();
attachNodeCache(conn);

try {
  section('2. The fixture, and the Setup flag "Can be set for a whole order"');
  const f = await buildFixture(conn, c);
  const { LEN, WID, THK, DENS, WT, GRD, CLS, COATS, MCOAT, MARK } = f.spec;
  const { L1, L2, L3 } = f;
  const set = (id, entries) => V.setValues(conn, c, 'master', id, entries.map(([s, value]) => ({ specCode: s.code, value })));
  for (const L of [L1, L2]) {
    for (const p of [L.a1pa1, L.a1pa2, L.a1pb, L.a2pa1, L.a2pa2, L.a2pb]) await set(p, [[LEN, 1000], [WID, 500], [THK, 10]]);
  }
  await set(L1.a1pa1, [[GRD, 'E350']]); await set(L1.a1pa2, [[GRD, 'E350']]); await set(L1.a2pa1, [[GRD, 'E350']]); await set(L1.a1pb, [[GRD, 'E250']]);
  await set(L2.a1pa1, [[GRD, 'E350']]);
  for (const s of [GRD, CLS, COATS, MCOAT, DENS]) await SPEC.updateSpec(conn, c, s.id, { orderLevel: true });
  ok('the flag reads back on the specification', (await SPEC.getSpec(conn, COMPANY, GRD.id)).orderLevel === true);
  ok('and is off on one not flagged', (await SPEC.getSpec(conn, COMPANY, MARK.id)).orderLevel === false);
  const tableRefused = await refusal(() => SPEC.createSpec(conn, c, { code: `${f.tag}_TBL`, name: 'chart', dataType: 'table', tableConfig: { axes: [{ label: 'T' }] }, orderLevel: true }));
  ok('a table cannot be set for a whole order', !!tableRefused);
  if (tableRefused) says(tableRefused.problems?.[0] ?? tableRefused.message);

  section('3. The panel read: flagged specs, values, how each line\'s rows take them');
  const before3 = await OV.readLineValues(conn, COMPANY, L1.lineId);
  ok('before any order value, an empty required GRD is missing', cellOf(before3, L1.a2pa2, GRD)?.missing === true);
  let panel = await OD.readOrderDefaults(conn, COMPANY, f.orderId);
  ok('the panel lists the flagged specifications', [GRD, CLS, COATS, MCOAT, DENS].every((s) => panel.specs.some((x) => x.code === s.code)));
  ok('and not the others', !panel.specs.some((x) => x.code === MARK.code));
  eq('an option spec carries its active options', panel.specs.find((x) => x.code === GRD.code)?.options?.map((o) => o.value), ['E250', 'E350', 'E450']);
  eq('line 1: six part rows take GRD, four typed, two empty', panel.lines[0].usage?.[GRD.code], { rows: 6, follow: 0, own: 4, notAllowed: 0, empty: 2 });
  eq('COATS reaches parts AND assemblies (8 rows + the girder = 9 incl. root)', panel.lines[0].usage?.[COATS.code]?.rows, 9);

  section('4. An ORDER value: empty rows take it, typed rows keep theirs (marked)');
  const w1 = await OD.writeOrderDefaults(conn, c, f.orderId, { writes: [{ specCode: GRD.code, value: 'E350' }] });
  says(w1.summary.sentence);
  ok('the save says lines followed', w1.summary.lines.filter((l) => !l.skipped).length === 3);
  let v1 = await OV.readLineValues(conn, COMPANY, L1.lineId);
  eq('an empty row now shows the order\'s value', cellOf(v1, L1.a2pa2, GRD)?.defaultDisplay, 'E350');
  eq('marked "from order"', cellOf(v1, L1.a2pa2, GRD)?.inherit, 'order');
  ok('with no input of its own', !cellOf(v1, L1.a2pa2, GRD)?.input);
  ok('and is no longer missing (an inherited value counts as filled)', !cellOf(v1, L1.a2pa2, GRD)?.missing);
  eq('stored on the row as a default', await stored(conn, L1.a2pa2, GRD), { value: f.opt.E350, source: 'defaulted' });
  eq('a row typed E250 keeps it — an override', cellOf(v1, L1.a1pb, GRD)?.input, String(f.opt.E250));
  eq('marked as standing over the order\'s value', [cellOf(v1, L1.a1pb, GRD)?.override, cellOf(v1, L1.a1pb, GRD)?.orderDisplay], ['order', 'E350']);
  eq('its stored entry is untouched', await stored(conn, L1.a1pb, GRD), { value: f.opt.E250, source: 'entered' });
  ok('the view counts rows from the order and overrides', v1.counts.fromOrder >= 2 && v1.counts.overrides >= 3);
  panel = await OD.readOrderDefaults(conn, COMPANY, f.orderId);
  eq('the panel shows the order value', panel.values[GRD.code], { input: String(f.opt.E350), display: 'E350' });
  eq('and line 1 usage: 2 follow, 4 own', [panel.lines[0].usage[GRD.code].follow, panel.lines[0].usage[GRD.code].own], [2, 4]);
  const again = await OD.writeOrderDefaults(conn, c, f.orderId, { writes: [{ specCode: GRD.code, value: 'e350' }] });
  ok('saying it again changes nothing', again.summary.changed === 0);

  section('5. A LINE value stands over the order\'s, on its line only');
  await OD.writeOrderDefaults(conn, c, f.orderId, { lineId: L1.lineId, writes: [{ specCode: GRD.code, value: f.opt.E250 }] });
  v1 = await OV.readLineValues(conn, COMPANY, L1.lineId);
  let v2 = await OV.readLineValues(conn, COMPANY, L2.lineId);
  eq('line 1 rows read the line\'s value', [cellOf(v1, L1.a2pa2, GRD)?.defaultDisplay, cellOf(v1, L1.a2pa2, GRD)?.inherit], ['E250', 'line']);
  eq('stored E250', (await stored(conn, L1.a2pa2, GRD))?.value, f.opt.E250);
  eq('line 2 rows still read the order\'s', [cellOf(v2, L2.a2pa2, GRD)?.defaultDisplay, cellOf(v2, L2.a2pa2, GRD)?.inherit], ['E350', 'order']);
  eq('a row typed E350 on line 1 now stands over the LINE value', [cellOf(v1, L1.a1pa1, GRD)?.override, cellOf(v1, L1.a1pa1, GRD)?.orderDisplay], ['line', 'E250']);
  await OD.writeOrderDefaults(conn, c, f.orderId, { lineId: L1.lineId, writes: [{ specCode: GRD.code, value: null }] });
  v1 = await OV.readLineValues(conn, COMPANY, L1.lineId);
  eq('taking the line value away: the order\'s comes back', [cellOf(v1, L1.a2pa2, GRD)?.defaultDisplay, cellOf(v1, L1.a2pa2, GRD)?.inherit], ['E350', 'order']);
  eq('stored E350 again', (await stored(conn, L1.a2pa2, GRD))?.value, f.opt.E350);

  section('6. Override on the Values screen, and "use the order\'s value"');
  await OV.writeLineValues(conn, c, L1.lineId, { writes: [{ recordId: L1.a2pa2, specCode: GRD.code, value: 'E250' }] });
  v1 = await OV.readLineValues(conn, COMPANY, L1.lineId);
  eq('typing makes a row override', [cellOf(v1, L1.a2pa2, GRD)?.input, cellOf(v1, L1.a2pa2, GRD)?.override], [String(f.opt.E250), 'order']);
  eq('stored as entered', await stored(conn, L1.a2pa2, GRD), { value: f.opt.E250, source: 'entered' });
  await OV.writeLineValues(conn, c, L1.lineId, { writes: [{ recordId: L1.a2pa2, specCode: GRD.code, value: null }] });
  v1 = await OV.readLineValues(conn, COMPANY, L1.lineId);
  eq('emptying it takes the order\'s value again', [cellOf(v1, L1.a2pa2, GRD)?.inherit, cellOf(v1, L1.a2pa2, GRD)?.defaultDisplay], ['order', 'E350']);
  eq('stored as a default again', await stored(conn, L1.a2pa2, GRD), { value: f.opt.E350, source: 'defaulted' });

  section('7. A narrowed option list: a value the row does not allow does not reach it');
  await OD.writeOrderDefaults(conn, c, f.orderId, { writes: [{ specCode: GRD.code, value: 'E450' }] });
  v1 = await OV.readLineValues(conn, COMPANY, L1.lineId);
  ok('the part row (E250/E350 only) does not take E450', !cellOf(v1, L1.a2pa2, GRD)?.inherit);
  ok('it says why', /not allowed/.test(cellOf(v1, L1.a2pa2, GRD)?.note ?? ''));
  says(cellOf(v1, L1.a2pa2, GRD)?.note ?? '');
  ok('and, with nothing of its own, is missing again', cellOf(v1, L1.a2pa2, GRD)?.missing === true);
  eq('the earlier default stored on it is gone', await stored(conn, L1.a2pa2, GRD), null);
  panel = await OD.readOrderDefaults(conn, COMPANY, f.orderId);
  eq('the panel counts it as not allowed', panel.lines[0].usage[GRD.code].notAllowed, 2);
  await OD.writeOrderDefaults(conn, c, f.orderId, { writes: [{ specCode: GRD.code, value: 'E350' }] });

  section('8. Formulas read the inherited value; an order value stands over a Defaulted formula');
  near('weight before: density 7850 from the Family', (await stored(conn, L1.a1pa1, WT))?.value, 1000 * 500 * 10 * 7850 / 1e9);
  await OD.writeOrderDefaults(conn, c, f.orderId, { writes: [{ specCode: DENS.code, value: 8000 }, { specCode: COATS.code, value: 2 }] });
  near('the order\'s density 8000 reaches the weight formula', (await stored(conn, L1.a1pa1, WT))?.value, 40);
  near('and the roll-up above it', (await stored(conn, L1.asm1, WT))?.value, 40 * 4);
  near('MCOAT = COATS + 1 reads the inherited COATS', (await stored(conn, L1.a1pa1, MCOAT))?.value, 3);
  await OD.writeOrderDefaults(conn, c, f.orderId, { writes: [{ specCode: MCOAT.code, value: 5 }] });
  v1 = await OV.readLineValues(conn, COMPANY, L1.lineId);
  near('an order MCOAT stands over its formula', (await stored(conn, L1.a1pa1, MCOAT))?.value, 5);
  eq('shown as from the order, not as calculated', [cellOf(v1, L1.a1pa1, MCOAT)?.inherit, cellOf(v1, L1.a1pa1, MCOAT)?.from ?? null], ['order', null]);
  await OV.writeLineValues(conn, c, L1.lineId, { writes: [{ recordId: L1.a1pa1, specCode: MCOAT.code, value: 7 }] });
  near('a row entry stands over both', (await stored(conn, L1.a1pa1, MCOAT))?.value, 7);
  await OD.writeOrderDefaults(conn, c, f.orderId, { writes: [{ specCode: MCOAT.code, value: null }] });
  near('without the order value the formula answers again on the other rows', (await stored(conn, L1.a1pa2, MCOAT))?.value, 3);
  await OD.writeOrderDefaults(conn, c, f.orderId, { writes: [{ specCode: CLS.code, value: 'BR' }] });
  eq('a Defaulted option (class from the Variant) takes the order\'s value', (await stored(conn, L1.a1pa1, CLS))?.value, f.opt.clsB);

  section('9. The two resolvers agree, record by record');
  for (const L of [L1, L2]) {
    const m = await mirrorDiffers(conn, L.lineId);
    ok(`line ${L.lineNo}: the mirror and resolve() agree on all ${m.size} records`, m.bad.length === 0, `differ: ${m.bad.join(', ')}`);
  }

  section('10. Round trips do not grow with the line');
  const small = await roundTrips(conn, () => OV.readLineValues(conn, COMPANY, L1.lineId));
  const big = await roundTrips(conn, () => OV.readLineValues(conn, COMPANY, L3.lineId));
  const [[{ n: bigRows }]] = await conn.query("SELECT COUNT(*) AS n FROM cf_item_details WHERE company_id = ? AND owner_order_line_id = ? AND item_type = 'temporary' AND deleted_at IS NULL", [COMPANY, L3.lineId]);
  eq(`the Values read: line 1 (9 rows) and line 3 (${bigRows} rows) cost the same (${small.n})`, big.n, small.n);
  const ws = await roundTrips(conn, () => OD.writeOrderDefaults(conn, c, f.orderId, { lineId: L1.lineId, writes: [{ specCode: COATS.code, value: 3 }] }));
  const wb = await roundTrips(conn, () => OD.writeOrderDefaults(conn, c, f.orderId, { lineId: L3.lineId, writes: [{ specCode: COATS.code, value: 3 }] }));
  eq(`a line value on line 1 and on line 3 costs the same (${ws.n})`, wb.n, ws.n);
  ok(`and it is a small fixed number (≤ 60 with the panel re-read; got ${wb.n})`, wb.n <= 60);
  const rt = await roundTrips(conn, async () => R.resolve(conn, COMPANY, { master: await loadMaster(conn, COMPANY, L1.a1pa1) }));
  says(`resolve() of one order row: ${rt.n} queries (one of them the order values)`);

  section('11. LOCK: a later order change never reaches a locked line');
  await OD.writeOrderDefaults(conn, c, f.orderId, { writes: [{ specCode: GRD.code, value: 'E350' }] });
  await conn.query('UPDATE cf_sales_order_lines SET locked_at = NOW() WHERE company_id = ? AND id = ?', [COMPANY, L2.lineId]);
  const lockedBefore = await stateOf(conn, ownIdsOf(L2));
  const w11 = await OD.writeOrderDefaults(conn, c, f.orderId, { writes: [{ specCode: GRD.code, value: 'E250' }, { specCode: COATS.code, value: 4 }] });
  says(w11.summary.sentence);
  ok('the save says line 2 is locked and skipped', w11.summary.lines.some((l) => l.lineId === L2.lineId && l.skipped === 'locked'));
  eq('every stored value of the locked line is exactly as it was', await stateOf(conn, ownIdsOf(L2)), lockedBefore);
  eq('the open line moved', (await stored(conn, L1.a2pa2, GRD))?.value, f.opt.E250);
  const lineLocked = await refusal(() => OD.writeOrderDefaults(conn, c, f.orderId, { lineId: L2.lineId, writes: [{ specCode: GRD.code, value: 'E350' }] }));
  eq('a line value on the locked line is refused', lineLocked?.code ?? lineLocked?.error, 'LOCKED');
  v2 = await OV.readLineValues(conn, COMPANY, L2.lineId);
  ok('the locked line\'s view says nothing is inherited — it shows what it holds', !cellOf(v2, L2.a2pa2, GRD)?.inherit && cellOf(v2, L2.a2pa2, GRD)?.input === String(f.opt.E350), JSON.stringify(cellOf(v2, L2.a2pa2, GRD)));

  section('12. A REVISION carries the order and line values');
  await OD.writeOrderDefaults(conn, c, f.orderId, { lineId: L1.lineId, writes: [{ specCode: CLS.code, value: 'BO' }] });
  const rev = await REV.reviseOrder(conn, c, f.orderId);
  const [newDefaults] = await conn.query('SELECT d.order_line_id, s.code, d.option_id, d.value_number, l.revises_line_id FROM cf_order_spec_defaults d JOIN cf_specifications s ON s.id = d.specification_id LEFT JOIN cf_sales_order_lines l ON l.id = d.order_line_id WHERE d.company_id = ? AND d.order_id = ? AND d.deleted_at IS NULL', [COMPANY, rev.id]);
  const [oldDefaults] = await conn.query('SELECT order_line_id FROM cf_order_spec_defaults WHERE company_id = ? AND order_id = ? AND deleted_at IS NULL', [COMPANY, f.orderId]);
  eq('every value came across', newDefaults.length, oldDefaults.length);
  ok('the order values on the new revision', newDefaults.some((d) => d.order_line_id == null && d.code === GRD.code && d.option_id === f.opt.E250));
  ok('each line value on the line that revises its line', newDefaults.filter((d) => d.order_line_id != null).every((d) => [L1.lineId, L3.lineId].includes(Number(d.revises_line_id))) && newDefaults.some((d) => d.code === CLS.code && Number(d.revises_line_id) === L1.lineId));
  const [[newL1]] = await conn.query('SELECT id FROM cf_sales_order_lines WHERE company_id = ? AND order_id = ? AND revises_line_id = ?', [COMPANY, rev.id, L1.lineId]);
  const nv = await OV.readLineValues(conn, COMPANY, newL1.id);
  const inheritCells = nv.groups.flatMap((g) => g.rows.flatMap((r) => Object.values(r.cells))).filter((x) => x.inherit).length;
  ok(`the new revision's rows read them (${inheritCells} cells from the order or line)`, inheritCells > 0);
  const [[hist]] = await conn.query('SELECT COUNT(*) AS n FROM cf_order_spec_default_history WHERE company_id = ? AND order_id = ?', [COMPANY, rev.id]);
  eq('each copied value has its history row', Number(hist.n), newDefaults.length);
  const closed = await refusal(() => OD.writeOrderDefaults(conn, c, f.orderId, { writes: [{ specCode: GRD.code, value: 'E350' }] }));
  eq('the revised order takes no more changes', closed?.code ?? closed?.error, 'ORDER_CLOSED');

  section('13. History, and the Setup flag cannot be turned off while an open order holds a value');
  const [[h]] = await conn.query('SELECT COUNT(*) AS n FROM cf_order_spec_default_history WHERE company_id = ? AND order_id = ?', [COMPANY, f.orderId]);
  ok(`every change of the first revision's values was written down (${h.n} rows)`, Number(h.n) >= 15);
  const off = await refusal(() => SPEC.updateSpec(conn, c, GRD.id, { orderLevel: false }));
  ok('turning GRD off is refused', !!off);
  if (off) says(off.problems?.[0] ?? off.message);

  section('14. The one-off: propose order values from what rows say, then apply');
  const o2 = (await conn.query("INSERT INTO cf_sales_orders (company_id, code, order_type, title, status, created_by) VALUES (?, ?, 'customer', 'Proposal fixture', 'inquiry', ?)", [COMPANY, `${f.tag}-SO2`, c.userId]))[0].insertId;
  const [[tTop]] = await conn.query('SELECT id FROM cf_master_records WHERE company_id = ? AND code = ?', [COMPANY, `${f.tag}-TTOP`]);
  await S.addOrderLine(conn, c, o2, { recordId: tTop.id, quantity: 1 });
  const [[pl]] = await conn.query('SELECT id, item_id, line_no FROM cf_sales_order_lines WHERE company_id = ? AND order_id = ? AND deleted_at IS NULL', [COMPANY, o2]);
  const [parts] = await conn.query(
    `SELECT m.id FROM cf_master_records m JOIN cf_item_details i ON i.master_id = m.id
      WHERE i.company_id = ? AND i.owner_order_line_id = ? AND m.classification_id = ? AND m.deleted_at IS NULL ORDER BY m.id`, [COMPANY, pl.id, f.vPart]);
  const typed = ['E350', 'E350', 'E350', 'E250'];
  for (const [i, p] of parts.slice(0, 4).entries()) await set(p.id, [[GRD, typed[i]]]);
  const effBefore = (await OV.readLineValues(conn, COMPANY, pl.id)).groups.flatMap((g) => g.rows.map((r) => `${r.id}:${r.cells[GRD.code]?.input ?? r.cells[GRD.code]?.defaultDisplay ?? ''}`));
  const p = await OD.proposeOrderDefaults(conn, COMPANY, o2);
  const pg = p.proposals.find((x) => x.code === GRD.code);
  eq('it proposes the most common typed value', pg?.value?.display, 'E350');
  eq('3 rows typed the same, 1 differently, 2 empty', [pg?.typedSame, pg?.typedOther, pg?.empty], [3, 1, 2]);
  eq('the 3 same rows are the entries it would take away', pg?.clear?.[pl.id]?.length, 3);
  const nothingYet = await OD.readOrderDefaults(conn, COMPANY, o2, { usage: false });
  ok('a proposal writes nothing', !Object.keys(nothingYet.values).length);
  const ap = await OD.applyOrderDefaultsProposal(conn, c, o2, p);
  says(ap.order?.sentence ?? '');
  const after14 = await OV.readLineValues(conn, COMPANY, pl.id);
  const lookup = (id) => { const x = rowOf(after14, id)?.r.cells[GRD.code]; return x?.inherit ? 'inherit' : x?.override ? 'override' : 'own'; };
  eq('the three same rows now read it from the order', parts.slice(0, 3).map((x) => lookup(x.id)), ['inherit', 'inherit', 'inherit']);
  eq('the different one is an override', lookup(parts[3].id), 'override');
  eq('the two empty ones take it too', parts.slice(4).map((x) => lookup(x.id)), ['inherit', 'inherit']);
  const effAfter = after14.groups.flatMap((g) => g.rows.map((r) => `${r.id}:${r.cells[GRD.code]?.input ?? r.cells[GRD.code]?.defaultDisplay ?? ''}`));
  const optLabel = (s) => s.replace(`:${f.opt.E350}`, ':E350').replace(`:${f.opt.E250}`, ':E250');
  eq('typed rows read exactly what they read before (empty ones now read E350)', effAfter.map(optLabel).filter((x) => !x.endsWith(':') && parts.slice(0, 4).some((q) => x.startsWith(`${q.id}:`))),
    effBefore.map(optLabel).filter((x) => !x.endsWith(':') && parts.slice(0, 4).some((q) => x.startsWith(`${q.id}:`))));
} catch (err) {
  failed += 1;
  fails.push(`threw: ${err.message}`);
  console.error(err);
} finally {
  detachNodeCache(conn);
  try { await conn.rollback(); } catch { /* ignore */ }
  conn.release();
}

section('15. Nothing survived the rollback');
const after = await counts(pool);
eq('every counted table is back where it started', diff(before, after), []);

console.log(`\n${passed} passed, ${failed} failed`);
if (fails.length) console.log(fails.map((x) => `  - ${x}`).join('\n'));
await pool.end();
process.exitCode = failed ? 1 : 0;
