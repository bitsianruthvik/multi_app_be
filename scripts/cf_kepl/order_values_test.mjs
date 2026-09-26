/**
 * order_values_test.mjs — the Values stage's bulk read and bulk write
 * (GET / PUT /order-lines/:id/values, services/orderValuesService.js),
 * against the local DB.
 *
 *   cd multi_app_be && node scripts/cf_kepl/order_values_test.mjs
 *
 * EVERYTHING HAPPENS INSIDE ONE TRANSACTION THAT IS ROLLED BACK. Nothing here is
 * committed, and the last thing it does is re-count every table it wrote and
 * prove each is back at the count it started with.
 *
 * IT BUILDS ITS OWN FIXTURE — a Family > Subfamily > three Variants, eleven
 * specifications, two formulas, rules of every kind (entered, defaulted, fixed,
 * calculated, roll-up, inherited, one captured per batch), a catalog bolt, three
 * templates, two coding rules and a sales order — and reads none of the
 * company's own nodes, records or rules. Four suites broke in one week by
 * borrowing tenant data (uq_ccn_sibling is unique on the NAME, not the code), so
 * every code and name here carries this run's tag. Its coding rules are more
 * specific than any the company has (kind + exact Variant), so the codes it
 * reads are its own.
 *
 * ok(label, cond) — the label FIRST. A swapped call has passed unconditionally
 * twice in this codebase, so ok() refuses anything but (string, boolean), and
 * section 0 proves it does.
 */
import path from 'path';
import { pathToFileURL } from 'url';

const BE = process.cwd();
const imp = (p) => import(pathToFileURL(path.join(BE, p)).href);
const { pool } = await imp('db.js');
const { attachNodeCache, detachNodeCache } = await imp('apps/cf_erp/lib/db.js');
await imp('apps/cf_erp/services/codegenProvider.js'); // registers 'item' with the code generator, as app.js does
const OV = await imp('apps/cf_erp/services/orderValuesService.js');
const S = await imp('apps/cf_erp/services/salesOrderService.js');
const V = await imp('apps/cf_erp/services/valueService.js');
const R = await imp('apps/cf_erp/services/resolutionService.js');
const { loadMaster } = await imp('apps/cf_erp/services/records.js');
const { protect } = await imp('core/middleware/authmiddleware.js');
const valuesRoutes = (await imp('apps/cf_erp/routes/orderValues.js')).default;
const indexRoutes = (await imp('apps/cf_erp/routes/index.js')).default;

const COMPANY = Number(process.env.CF_VALUES_COMPANY ?? 2);

/* --------------------------------------------------------------------------
 * A tiny harness
 * ----------------------------------------------------------------------- */
let passed = 0;
let failed = 0;
const fails = [];
/** ok(label, cond, detail?) — a string, then a boolean. Anything else throws rather than passing. */
function ok(label, cond, detail = '') {
  if (typeof label !== 'string' || typeof cond !== 'boolean') {
    throw new Error(`ok(label, cond) was called as ok(${typeof label}, ${typeof cond}) — the label comes first and the condition must be a boolean.`);
  }
  if (cond) { passed += 1; console.log(`  PASS  ${label}`); }
  else { failed += 1; fails.push(label); console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
}
/** A comparison, not an assertion — it returns a boolean and registers nothing. Never call it as a test. */
const alike = (got, want) => Object.is(got, want) || JSON.stringify(got) === JSON.stringify(want);
/** eq(label, got, want) — an assertion; like ok(), it refuses a label that is not a string. */
const eq = (label, got, want) => ok(label, alike(got, want), `got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);
const near = (label, got, want) => ok(label, got != null && Math.abs(Number(got) - want) < 1e-6, `got ${got}, wanted ${want}`);
const section = (s) => console.log(`\n${s}`);
const says = (text) => console.log(`        says: ${text}`);
const refusal = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

/* --------------------------------------------------------------------------
 * Counting, so "writes nothing" is a fact and not a hope
 * ----------------------------------------------------------------------- */
const COUNTED = [
  'cf_classification_nodes', 'cf_specifications', 'cf_spec_options', 'cf_formulas',
  'cf_spec_assignments', 'cf_spec_assignment_options', 'cf_spec_values', 'cf_spec_value_history',
  'cf_master_records', 'cf_item_details', 'cf_definition_details', 'cf_boms', 'cf_bom_lines',
  'cf_sales_orders', 'cf_sales_order_lines', 'cf_production_releases',
  'cf_code_schemes', 'cf_code_scheme_segments', 'cf_code_scheme_conditions', 'cf_code_sequences',
];
async function counts(db) {
  const out = {};
  for (const t of COUNTED) {
    const [[r]] = await db.query(`SELECT COUNT(*) AS n FROM \`${t}\``);
    out[t] = Number(r.n);
  }
  return out;
}
const diff = (a, b) => COUNTED.filter((t) => a[t] !== b[t]).map((t) => `${t} ${a[t]}->${b[t]}`);

/** Every query the connection sends while `fn` runs. */
async function roundTrips(conn, fn) {
  const real = conn.query.bind(conn);
  let n = 0;
  conn.query = (...a) => { n += 1; return real(...a); };
  try { return { out: await fn(), n }; } finally { conn.query = real; }
}

/* --------------------------------------------------------------------------
 * Guards: what a request gets through before the handler
 * ----------------------------------------------------------------------- */
function routeOf(router, method, routePath) {
  return router.stack.find((l) => l.route?.path === routePath && l.route.methods[method])?.route ?? null;
}
const guardsOf = (route) => route.stack.slice(0, -1).map((l) => l.handle).filter((fn) => fn !== protect);
async function throughGuards(route, user) {
  const req = { user, params: { id: '1' }, body: {}, headers: {}, cookies: {} };
  for (const fn of guardsOf(route)) {
    let passedOn = false;
    let status = null;
    const res = { status(code) { status = code; return this; }, json() { return this; } };
    await fn(req, res, () => { passedOn = true; });
    if (!passedOn) return { reached: false, status };
  }
  return { reached: true, status: null };
}
const user = (tags) => ({ id: null, role: 'user', companyId: COMPANY, uiPermissions: tags });

/* --------------------------------------------------------------------------
 * The fixture — all of it this run's own
 * ----------------------------------------------------------------------- */
async function buildFixture(db, c) {
  const tag = `OVT${Date.now().toString(36).toUpperCase()}`;
  const ins = async (sql, params) => (await db.query(sql, params))[0].insertId;

  const node = (parentId, depth, key) => ins(
    "INSERT INTO cf_classification_nodes (company_id, parent_id, depth, scope, code, name, status) VALUES (?, ?, ?, 'both', ?, ?, 'active')",
    [COMPANY, parentId, depth, `${tag}-${key}`, `${tag} ${key} — order values test`],
  );
  const fam = await node(null, 0, 'F');
  const sub = await node(fam, 1, 'S');
  const vPart = await node(sub, 2, 'PART');
  const vAsm = await node(sub, 2, 'ASM');
  const vBolt = await node(sub, 2, 'BOLT');

  const spec = async (key, dataType, { uom = null, decimals = null } = {}) => {
    const code = `${tag}_${key}`;
    const id = await ins(
      "INSERT INTO cf_specifications (company_id, code, name, data_type, default_uom, decimals, status) VALUES (?, ?, ?, ?, ?, ?, 'active')",
      [COMPANY, code, `${key} (values test)`, dataType, uom, decimals],
    );
    return { id, code };
  };
  const LEN = await spec('LEN', 'number', { uom: 'mm' });
  const WID = await spec('WID', 'number', { uom: 'mm' });
  const THK = await spec('THK', 'number', { uom: 'mm' });
  const WT = await spec('WT', 'number', { uom: 'kg', decimals: 3 });
  const DENS = await spec('DENS', 'number', { uom: 'kg/m3' });
  const GRD = await spec('GRD', 'option');
  const CLS = await spec('CLS', 'option');
  const HOLED = await spec('HOLED', 'boolean');
  const MARK = await spec('MARK', 'text');
  const PAINT = await spec('PAINT', 'text');
  const DUE = await spec('DUE', 'date');
  const HEAT = await spec('HEAT', 'text');
  const option = (specId, value, sort) => ins(
    "INSERT INTO cf_spec_options (company_id, specification_id, value, sort_order, status) VALUES (?, ?, ?, ?, 'active')",
    [COMPANY, specId, value, sort],
  );
  const E250 = await option(GRD.id, 'E250', 1);
  const E350 = await option(GRD.id, 'E350', 2);
  const E450 = await option(GRD.id, 'E450', 3);
  const clsA = await option(CLS.id, 'A', 1);
  const clsB = await option(CLS.id, 'B', 2);

  const formula = (key, expression) => ins(
    "INSERT INTO cf_formulas (company_id, code, name, expression, status) VALUES (?, ?, ?, ?, 'active')",
    [COMPANY, `${tag}_${key}`, key, expression],
  );
  const PWT = await formula('PWT', `${LEN.code} * ${WID.code} * ${THK.code} * ${DENS.code} / 1000000000`);
  const AWT = await formula('AWT', `SUM(children.${WT.code})`);

  const rule = (subjectType, subjectId, s, valueRule, { required = false, formulaId = null, sort = 0, captureAt = 'item', applicable = true } = {}) => ins(
    `INSERT INTO cf_spec_assignments
       (company_id, specification_id, subject_type, subject_id, capture_at, is_required, is_applicable, value_rule, formula_id, sort_order, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [COMPANY, s.id, subjectType, subjectId, captureAt, required ? 1 : 0, applicable ? 1 : 0, valueRule, formulaId, sort, c.userId],
  );
  const classValue = (nodeId, s, column, value) => db.query(
    `INSERT INTO cf_spec_values (company_id, specification_id, subject_type, subject_id, ${column}, source) VALUES (?, ?, 'classification', ?, ?, 'entered')`,
    [COMPANY, s.id, nodeId, value],
  );

  // Density is fixed at the Family — every part reads 7850 from there — and
  // switched off for assemblies, which are weighed by adding up, not by size.
  await rule('classification', fam, DENS, 'fixed', { sort: 90 });
  await classValue(fam, DENS, 'value_number', 7850);
  await rule('classification', vAsm, DENS, 'fixed', { applicable: false });
  // A part: its size, grade and class typed; its weight worked out; its paint from its parent.
  await rule('classification', vPart, LEN, 'entered', { required: true, sort: 1 });
  await rule('classification', vPart, WID, 'entered', { required: true, sort: 2 });
  await rule('classification', vPart, THK, 'entered', { required: true, sort: 3 });
  const grdRule = await rule('classification', vPart, GRD, 'entered', { required: true, sort: 4 });
  for (const o of [E250, E350]) await db.query('INSERT INTO cf_spec_assignment_options (company_id, assignment_id, option_id) VALUES (?, ?, ?)', [COMPANY, grdRule, o]);
  await rule('classification', vPart, HOLED, 'entered', { sort: 5 });
  await rule('classification', vPart, MARK, 'entered', { sort: 6 });
  await rule('classification', vPart, CLS, 'defaulted', { required: true, sort: 7 });
  await classValue(vPart, CLS, 'option_id', clsA);
  await rule('classification', vPart, WT, 'calculated', { formulaId: PWT, sort: 8 });
  await rule('classification', vPart, PAINT, 'inherited', { sort: 9 });
  await rule('classification', vPart, HEAT, 'entered', { captureAt: 'batch', sort: 10 });
  // An assembly: a mark, a paint and a due date typed; its weight rolled up.
  await rule('classification', vAsm, MARK, 'entered', { sort: 1 });
  await rule('classification', vAsm, PAINT, 'entered', { sort: 2 });
  await rule('classification', vAsm, DUE, 'entered', { sort: 3 });
  await rule('classification', vAsm, WT, 'rollup', { formulaId: AWT, sort: 4 });
  // A bought bolt: its own weight and length, typed on the catalog item.
  await rule('classification', vBolt, WT, 'entered', { sort: 1 });
  await rule('classification', vBolt, LEN, 'entered', { sort: 2 });

  const master = async (kind, key, name, short, classificationId) => {
    const id = await ins(
      "INSERT INTO cf_master_records (company_id, record_kind, code, name, short_name, classification_id, status, created_by) VALUES (?, ?, ?, ?, ?, ?, 'active', ?)",
      [COMPANY, kind === 'catalog' ? 'item' : 'definition', `${tag}-${key}`, name, short, classificationId, c.userId],
    );
    if (kind === 'catalog') {
      await db.query("INSERT INTO cf_item_details (master_id, company_id, item_type, tracked_by, uom, sourcing) VALUES (?, ?, 'catalog', 'quantity', 'nos', 'stock')", [id, COMPANY]);
    } else {
      await db.query("INSERT INTO cf_definition_details (master_id, company_id, definition_type) VALUES (?, ?, 'template')", [id, COMPANY]);
    }
    return id;
  };
  const bomOf = (parentId, bomType) => ins("INSERT INTO cf_boms (company_id, parent_id, bom_type, status, created_by) VALUES (?, ?, ?, 'active', ?)", [COMPANY, parentId, bomType, c.userId]);
  const line = (bomId, lineNo, childId, qty, position = 1) => ins(
    'INSERT INTO cf_bom_lines (company_id, bom_id, line_no, child_id, design_id, position, quantity, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [COMPANY, bomId, lineNo, childId, childId, position, qty, c.userId],
  );

  const BOLT = await master('catalog', 'BOLT', 'Test bolt M20', 'BLT', vBolt);
  const TPA = await master('template', 'TPA', 'Web plate', 'PA', vPart);
  const TPB = await master('template', 'TPB', 'Stiffener', 'PB', vPart);
  const TASM = await master('template', 'TASM', 'Segment', 'AS', vAsm);
  const TTOP = await master('template', 'TTOP', 'Girder', 'TOP', vAsm);
  const asmBom = await bomOf(TASM, 'template');
  await line(asmBom, 10, TPA, 1, 1);
  await line(asmBom, 20, TPA, 1, 2); // the same part twice, at two positions
  await line(asmBom, 30, TPB, 2, 1); // two identical stiffeners on one line
  await line(asmBom, 40, BOLT, 4, 1);
  const topBom = await bomOf(TTOP, 'template');
  await line(topBom, 10, TASM, 1, 1);
  await line(topBom, 20, TASM, 1, 2);

  // The fixture's own coding rules: {parent.code}-{shortName}{position:00}, one
  // per Variant; kind (1) + exact Variant (4) outweighs every rule the company has.
  for (const variant of [vPart, vAsm]) {
    const scheme = await ins(
      "INSERT INTO cf_code_schemes (company_id, code, name, entity_type, target_field, seq_scope, priority, status) VALUES (?, ?, 'Order values test', 'item', 'code', 'prefix', 0, 'active')",
      [COMPANY, `${tag}-C${variant}`],
    );
    for (const [k, op, v] of [['kind', 'eq', 'temporary'], ['classification', 'eq', String(variant)]]) {
      await db.query('INSERT INTO cf_code_scheme_conditions (company_id, scheme_id, token_key, operator, value) VALUES (?, ?, ?, ?, ?)', [COMPANY, scheme, k, op, v]);
    }
    for (const [i, [type, token, literal, format]] of [['token', 'parent.code'], ['literal', null, '-'], ['token', 'record.shortName'], ['token', 'position', null, '00']].entries()) {
      await db.query(
        'INSERT INTO cf_code_scheme_segments (company_id, scheme_id, sort_order, segment_type, literal_text, token_key, format) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [COMPANY, scheme, i + 1, type, literal ?? null, token ?? null, format ?? null],
      );
    }
  }

  // Catalog values, set directly on the shared bolt: 0.25 kg, 70 mm.
  for (const [s, n] of [[WT, 0.25], [LEN, 70]]) {
    await db.query("INSERT INTO cf_spec_values (company_id, specification_id, subject_type, subject_id, value_number, source) VALUES (?, ?, 'master', ?, ?, 'entered')", [COMPANY, s.id, BOLT, n]);
  }

  // An order of its own, and a custom line made the real way: the girder
  // template becomes the order's temporary items, coded by the rules above.
  const orderCode = `${tag}-SO`;
  const orderId = await ins("INSERT INTO cf_sales_orders (company_id, code, order_type, title, status, created_by) VALUES (?, ?, 'customer', 'Order values fixture', 'inquiry', ?)", [COMPANY, orderCode, c.userId]);
  await S.addOrderLine(db, c, orderId, { recordId: TTOP, quantity: 2 });
  const [[ol]] = await db.query('SELECT id, item_id FROM cf_sales_order_lines WHERE company_id = ? AND order_id = ? AND deleted_at IS NULL', [COMPANY, orderId]);

  const [recs] = await db.query('SELECT m.id, m.code FROM cf_master_records m JOIN cf_item_details i ON i.master_id = m.id WHERE i.owner_order_line_id = ?', [ol.id]);
  const byCode = new Map(recs.map((r) => [r.code, r.id]));
  const root = `${orderCode}-TOP01`;
  const at = (suffix) => {
    const id = byCode.get(`${root}${suffix}`);
    if (!id) throw new Error(`The fixture's structure did not come out coded as expected — no ${root}${suffix} among ${[...byCode.keys()].join(', ')}`);
    return id;
  };
  const f = {
    tag, fam, vPart, vAsm, vBolt, orderId, orderCode, lineId: ol.id,
    spec: { LEN, WID, THK, WT, DENS, GRD, CLS, HOLED, MARK, PAINT, DUE, HEAT },
    opt: { E250, E350, E450, clsA, clsB },
    BOLT, TPA, TPB, TASM, TTOP,
    root: at(''),
    asm1: at('-AS01'), asm2: at('-AS02'),
    a1pa1: at('-AS01-PA01'), a1pa2: at('-AS01-PA02'), a1pb: at('-AS01-PB01'),
    a2pa1: at('-AS02-PA01'), a2pa2: at('-AS02-PA02'), a2pb: at('-AS02-PB01'),
  };
  if (ol.item_id !== f.root) throw new Error('The line does not sell the fixture\'s root.');

  // A starting point the real way: some filled, some not.
  const set = (id, entries) => V.setValues(db, c, 'master', id, entries.map(([s, value]) => ({ specCode: s.code, value })));
  await set(f.asm1, [[PAINT, 'RAL5010'], [MARK, 'A1']]);
  await set(f.asm2, [[MARK, 'A2']]);
  await set(f.a1pa1, [[LEN, 1000], [WID, 500], [THK, 10], [GRD, 'E350']]);
  await set(f.a1pa2, [[LEN, 1000], [WID, 400], [THK, 10]]);
  return f;
}

/** A stored value, as a plain number / text / option id / boolean, with its source. */
async function stored(db, subjectId, s) {
  const [[v]] = await db.query(
    "SELECT value_number, value_text, value_bool, value_date, option_id, source FROM cf_spec_values WHERE company_id = ? AND subject_type = 'master' AND subject_id = ? AND specification_id = ? AND deleted_at IS NULL",
    [COMPANY, subjectId, s.id],
  );
  if (!v) return null;
  const value = v.value_number != null ? Number(v.value_number) : v.value_text ?? v.option_id ?? (v.value_bool != null ? !!v.value_bool : null) ?? R.dateText(v.value_date);
  return { value, source: v.source };
}
/** Every live value row on the structure's own records, as text — to compare two ways of writing. */
async function stateOf(db, ids) {
  const [rows] = await db.query(
    `SELECT subject_id, specification_id, value_number, value_text, value_bool, value_date, option_id, source FROM cf_spec_values
      WHERE company_id = ? AND subject_type = 'master' AND subject_id IN (?) AND deleted_at IS NULL ORDER BY subject_id, specification_id`,
    [COMPANY, ids],
  );
  return rows.map((r) => `${r.subject_id}:${r.specification_id}=${r.value_number == null ? '' : Number(r.value_number)}|${r.value_text ?? ''}|${r.value_bool ?? ''}|${R.dateText(r.value_date) ?? ''}|${r.option_id ?? ''}|${r.source}`);
}
const rowOf = (view, id) => view.groups.flatMap((g) => g.rows.map((r) => ({ g, r }))).find((x) => x.r.id === id) ?? null;
const cellOf = (view, id, s) => rowOf(view, id)?.r.cells[s.code] ?? null;
const colOf = (view, id, s) => rowOf(view, id)?.g.columns.find((col) => col.code === s.code) ?? null;
/** A cell's own field, or its column's when the cell does not say — the view's compaction, undone. */
const fieldOf = (view, id, s, key) => {
  const cell = cellOf(view, id, s) ?? {};
  return key in cell ? cell[key] : colOf(view, id, s)?.[key];
};
/** The mirror against resolve(), record by record: the number of records whose answers differ. */
async function mirrorDiffers(db, lineId) {
  const mirror = await OV.resolveLineRecords(db, COMPANY, lineId);
  const bad = [];
  for (const [id, pub] of mirror) {
    const real = R.publicResolution(await R.resolve(db, COMPANY, { master: await loadMaster(db, COMPANY, id) }));
    if (JSON.stringify(real) !== JSON.stringify(pub)) bad.push(id);
  }
  return { size: mirror.size, bad };
}

/* --------------------------------------------------------------------------
 * The run
 * ----------------------------------------------------------------------- */
console.log(`order_values_test — company ${COMPANY}`);

section('0. The harness refuses a swapped ok()');
const swapped = await refusal(() => ok(true, 'swapped'));
ok('ok(cond, label) throws instead of passing', swapped instanceof Error);
const truthy = await refusal(() => ok('a truthy object is not a condition', {}));
ok('ok(label, object) throws too', truthy instanceof Error);
const swappedEq = await refusal(() => eq(1, 1, 'label last'));
ok('eq(got, want, label) throws too', swappedEq instanceof Error);
const passedBefore = passed;
alike(1, 2);
ok('alike() is a comparison and registers nothing (so it can never pass a test by being called as one)', passed === passedBefore && failed === 0);

section('1. The routes and their guards');
const getRoute = routeOf(valuesRoutes, 'get', '/order-lines/:id/values');
const putRoute = routeOf(valuesRoutes, 'put', '/order-lines/:id/values');
ok('GET /order-lines/:id/values is registered', !!getRoute);
ok('PUT /order-lines/:id/values is registered', !!putRoute);
ok('and the router is mounted under the cf_erp root', indexRoutes.stack.some((l) => l.handle === valuesRoutes));
if (getRoute && putRoute) {
  ok('both check the token first', getRoute.stack[0]?.handle === protect && putRoute.stack[0]?.handle === protect);
  ok('both have a permission guard after it (so passing it is not vacuous)', guardsOf(getRoute).length >= 1 && guardsOf(putRoute).length >= 1);
  const VIEW_ONLY = user(['cf_erp_orders_view']);
  const ORDERS = user(['cf_erp_orders_view', 'cf_erp_orders_manage']);
  const CATALOG = user(['cf_erp_orders_view', 'cf_erp_catalog_manage']);
  const NEITHER = user(['cf_erp_catalog_view']);
  ok('the orders view grant reads', (await throughGuards(getRoute, VIEW_ONLY)).reached);
  ok('without it the read is refused', !(await throughGuards(getRoute, NEITHER)).reached);
  const viewPut = await throughGuards(putRoute, VIEW_ONLY);
  ok('the view grant alone cannot write', !viewPut.reached);
  eq('with a 403', viewPut.status, 403);
  ok('the orders grant writes (the people who work the order\'s stages)', (await throughGuards(putRoute, ORDERS)).reached);
  ok('the catalog grant writes (what PUT /records/:id/values asks today)', (await throughGuards(putRoute, CATALOG)).reached);
  ok('an admin writes', (await throughGuards(putRoute, { ...NEITHER, role: 'admin' })).reached);
}

const [[someUser]] = await pool.query('SELECT id FROM users WHERE company_id = ? ORDER BY id LIMIT 1', [COMPANY]);
const c = { companyId: COMPANY, userId: someUser?.id ?? null };
const before = await counts(pool);
const conn = await pool.getConnection();
await conn.beginTransaction();
attachNodeCache(conn);

try {
  section('2. The fixture — its own classification, specifications, templates, coding rules and order');
  const f = await buildFixture(conn, c);
  const { LEN, WID, THK, WT, DENS, GRD, CLS, HOLED, MARK, PAINT, DUE, HEAT } = f.spec;
  const own = [f.root, f.asm1, f.asm2, f.a1pa1, f.a1pa2, f.a1pb, f.a2pa1, f.a2pa2, f.a2pb];
  const everyone = [...own, f.BOLT];
  ok('the girder template became the order\'s nine temporary items', own.every((id) => Number.isInteger(id)));
  const start = await stateOf(conn, everyone);

  section('3. The read: one row per record, grouped by kind of thing, every applicable spec');
  const { out: view, n: readTrips } = await roundTrips(conn, () => OV.readLineValues(conn, COMPANY, f.lineId));
  eq('the read costs 8 round trips', readTrips, 8);
  eq('ten rows: nine own items and the shared bolt (in one place per record, not per BOM line)', view.counts.rows, 10);
  eq('nine of them are this order\'s own', view.counts.own, 9);
  eq('one is shared', view.counts.shared, 1);
  const keys = view.groups.map((g) => g.key);
  eq('grouped by whose and by classification — own assemblies, own parts, then the shared bolts', keys, [`own:${f.vAsm}`, `own:${f.vPart}`, `shared:${f.vBolt}`]);
  const partGroup = view.groups.find((g) => g.key === `own:${f.vPart}`);
  const asmGroup = view.groups.find((g) => g.key === `own:${f.vAsm}`);
  eq('parts carry the parts\' columns, in the rules\' order', partGroup.columns.map((col) => col.code),
    [LEN.code, WID.code, THK.code, GRD.code, HOLED.code, MARK.code, CLS.code, WT.code, PAINT.code, DENS.code]);
  eq('assemblies carry only theirs — no column of blanks that do not apply, and not the density switched off for them', asmGroup.columns.map((col) => col.code), [MARK.code, PAINT.code, DUE.code, WT.code]);
  ok('a batch-captured spec is not a column (it is recorded on each batch)', !partGroup.columns.some((col) => col.code === HEAT.code));
  const reqCols = partGroup.columns.filter((col) => col.required).length;
  ok('not just the required ones: optional and worked-out specs are columns too', reqCols === 5 && partGroup.columns.length === 10);
  // Every row's cells are exactly the applicable item-level specs resolve() gives it.
  let cellsMatch = true;
  for (const id of everyone) {
    const real = await R.resolve(conn, COMPANY, { master: await loadMaster(conn, COMPANY, id) });
    const want = real.specs.filter((s) => s.applicable && s.captureAt === 'item').map((s) => s.spec.code).sort();
    const got = Object.keys(rowOf(view, id)?.r.cells ?? {}).sort();
    if (JSON.stringify(want) !== JSON.stringify(got)) { cellsMatch = false; console.log('        cells differ for', id, got, want); }
  }
  ok('every row has a cell for every applicable item-level spec resolve() gives it, and no other', cellsMatch);
  const md = await mirrorDiffers(conn, f.lineId);
  ok(`the in-memory resolution equals resolve() for every record, field by field (${md.size} records)`, md.size === 10 && md.bad.length === 0, `differs for ${md.bad.join(', ')}`);

  eq('a typed spec is editable on the column', colOf(view, f.a1pa1, LEN)?.editable, true);
  eq('its rule is said on the column', colOf(view, f.a1pa1, LEN)?.rule, 'entered');
  eq('the part\'s own typed length comes back as the input', cellOf(view, f.a1pa1, LEN)?.input, '1000');
  eq('an option comes back as its id', cellOf(view, f.a1pa1, GRD)?.input, String(f.opt.E350));
  const grdList = view.optionLists[colOf(view, f.a1pa1, GRD)?.options];
  eq('with the narrowed option list (E250, E350 — not E450)', (grdList ?? []).map((o) => o.value), ['E250', 'E350']);
  eq('a calculated weight is not editable', colOf(view, f.a1pa1, WT)?.editable, false);
  eq('its rule is calculated', fieldOf(view, f.a1pa1, WT, 'rule'), 'calculated');
  eq('it shows its worked-out value', cellOf(view, f.a1pa1, WT)?.display, '39.250 kg');
  ok('and says why, naming the formula', /formula .*_PWT/.test(fieldOf(view, f.a1pa1, WT, 'why') ?? ''), fieldOf(view, f.a1pa1, WT, 'why'));
  eq('a fixed density shows the Family\'s value', cellOf(view, f.a1pa1, DENS)?.display, '7850 kg/m3');
  ok('and says where to change it', /Fixed at family level .*— change it there/.test(fieldOf(view, f.a1pa1, DENS, 'why') ?? ''), fieldOf(view, f.a1pa1, DENS, 'why'));
  eq('an inherited paint shows the parent\'s value', cellOf(view, f.a1pa1, PAINT)?.display, 'RAL5010');
  ok('and names the parent it came from', (fieldOf(view, f.a1pa1, PAINT, 'why') ?? '').includes(`${f.orderCode}-TOP01-AS01`), fieldOf(view, f.a1pa1, PAINT, 'why'));
  eq('a defaulted class starts empty but shows its default', [cellOf(view, f.a1pa1, CLS)?.input ?? '', cellOf(view, f.a1pa1, CLS)?.defaultDisplay], ['', 'A']);
  eq('and is editable, to override it', [fieldOf(view, f.a1pa1, CLS, 'rule'), colOf(view, f.a1pa1, CLS)?.editable], ['defaulted', true]);
  eq('a roll-up waits while a part has no size', cellOf(view, f.asm1, WT)?.display ?? null, null);
  ok('and says what it waits for', /waiting for/.test(fieldOf(view, f.asm1, WT, 'why') ?? ''), fieldOf(view, f.asm1, WT, 'why'));
  eq('an empty required value is marked missing', cellOf(view, f.a1pb, LEN)?.missing, true);
  eq('an empty optional one is not', cellOf(view, f.a1pb, HOLED)?.missing ?? false, false);
  const realMissing = (await Promise.all(own.map(async (id) => (await R.resolve(conn, COMPANY, { master: await loadMaster(conn, COMPANY, id) })).missingRequired.length))).reduce((a, b) => a + b, 0);
  eq('the missing count agrees with resolve() (17: a grade, and four parts with nothing)', [view.counts.missingOwn, realMissing], [17, 17]);
  eq('a part missing only its grade says so on its row', rowOf(view, f.a1pa2)?.r.missing, 1);
  const bolt = rowOf(view, f.BOLT)?.r;
  ok('the shared bolt is read-only, in the structure tree\'s own words', /is not this order’s own work, so its values belong to the record itself/.test(bolt?.readOnly ?? ''), bolt?.readOnly);
  eq('and its column is not editable here', colOf(view, f.BOLT, WT)?.editable, false);
  eq('a row names its parent, so two parts of one name can be told apart', rowOf(view, f.a2pa1)?.r.parent?.code, `${f.orderCode}-TOP01-AS02`);
  eq('the view is editable while the order is open', view.editable, true);

  section('4. Read-only rules are refused on write — and nothing is written');
  const countsBeforeRO = await counts(conn);
  const ro = await refusal(() => OV.writeLineValues(conn, c, f.lineId, {
    writes: [
      { recordId: f.a1pa1, specCode: WT.code, value: 5 },
      { recordId: f.a1pa1, specCode: DENS.code, value: 8000 },
      { recordId: f.asm1, specCode: WT.code, value: 100 },
      { recordId: f.a1pa1, specCode: PAINT.code, value: 'RED' },
      { recordId: f.a1pa1, specCode: HEAT.code, value: 'H1' },
      { recordId: f.a1pa1, specCode: LEN.code, value: 1111 }, // fine on its own — goes down with the rest
    ],
  }));
  eq('it is a 422', ro?.status, 422);
  eq('listing five problems at once', ro?.problems?.length, 5);
  ok('a calculated value cannot be typed in', (ro?.problems ?? []).some((p) => p.includes(`${WT.code}: is calculated`)), ro?.problems?.join(' | '));
  ok('a fixed one says where to change it', (ro?.problems ?? []).some((p) => p.includes(`${DENS.code}: is fixed at family level`)));
  ok('a roll-up cannot be typed in', (ro?.problems ?? []).some((p) => p.startsWith(`${f.orderCode}-TOP01-AS01 · ${WT.code}: is a roll-up`)));
  ok('an inherited one cannot be typed in', (ro?.problems ?? []).some((p) => p.includes(`${PAINT.code}: is inherited`)));
  ok('a batch-captured one is recorded on each batch', (ro?.problems ?? []).some((p) => p.includes(`${HEAT.code}: is recorded on each batch`)));
  ok('every problem names its row', (ro?.problems ?? []).every((p) => p.startsWith(`${f.orderCode}-TOP01-AS01`)));
  eq('detail.cells carries the same, by record and spec', ro?.detail?.cells?.length, 5);
  says(ro?.problems?.[0]);
  eq('nothing was written — not even the good length', diff(countsBeforeRO, await counts(conn)), []);
  eq('the length is still 1000', (await stored(conn, f.a1pa1, LEN))?.value, 1000);

  section('5. One bad value refuses the whole batch, with every problem listed');
  const countsBeforeBad = await counts(conn);
  const bad = await refusal(() => OV.writeLineValues(conn, c, f.lineId, {
    writes: [
      { recordId: f.a1pb, specCode: LEN.code, value: 800 },     // good
      { recordId: f.a1pb, specCode: WID.code, value: 'wide' },  // not a number
      { recordId: f.a1pb, specCode: GRD.code, value: 'E999' },  // not an option
      { recordId: f.a2pa1, specCode: GRD.code, value: 'E450' }, // an option, narrowed out here
      { recordId: f.a2pa1, specCode: 'NO_SUCH_SPEC', value: 1 },
      { recordId: f.a2pa1, specCode: HOLED.code, value: 'maybe' },
      { recordId: f.asm1, specCode: DUE.code, value: '2026-02-30' },
      { recordId: f.a2pa2, specCode: LEN.code, value: 10 },     // good
      { recordId: f.a2pa2, specCode: LEN.code, value: 20 },     // the same cell twice
      { recordId: f.TPA, specCode: LEN.code, value: 1 },        // a template, not in the structure
    ],
  }));
  eq('it is a 422', bad?.status, 422);
  eq('with eight problems — every bad value, none of the good ones', bad?.problems?.length, 8);
  says(bad?.message);
  for (const p of bad?.problems ?? []) says(p);
  const has = (re) => (bad?.problems ?? []).some((p) => re.test(p));
  ok('a word where a number goes', has(new RegExp(`-AS01-PB01 · ${WID.code}: needs a number`)));
  ok('an option that does not exist', has(new RegExp(`-AS01-PB01 · ${GRD.code}: "E999" is not an option`)));
  ok('an option this part may not take', has(new RegExp(`-AS02-PA01 · ${GRD.code}: E450 is not allowed`)));
  ok('a specification that does not apply', has(/-AS02-PA01 · NO_SUCH_SPEC: is not part of this item’s setup/));
  ok('a yes/no that is neither', has(new RegExp(`-AS02-PA01 · ${HOLED.code}: is yes or no`)));
  ok('a date that is not a date', has(new RegExp(`-AS01 · ${DUE.code}: needs a date`)));
  ok('the same cell given twice', has(new RegExp(`-AS02-PA02 · ${LEN.code}: is given twice`)));
  ok('a record that is not part of this structure', has(new RegExp(`Record #${f.TPA} is not part of line`)));
  eq('and nothing was written, not even the good values', diff(countsBeforeBad, await counts(conn)), []);
  eq('the stiffener still has no length', await stored(conn, f.a1pb, LEN), null);

  section('6. A shared catalog record under the line cannot be written through it');
  const shared = await refusal(() => OV.writeLineValues(conn, c, f.lineId, { writes: [{ recordId: f.BOLT, specCode: WT.code, value: 9 }] }));
  eq('it is a 422', shared?.status, 422);
  ok('saying its values belong to the record itself', /BOLT: is not this order’s own work, so its values belong to the record itself — change them on/.test(shared?.problems?.[0] ?? ''), shared?.problems?.[0]);
  eq('the bolt still weighs 0.25', (await stored(conn, f.BOLT, WT))?.value, 0.25);

  // The batch the next sections save: every part sized, two grades, a class
  // override, a mark, a paint that flows down, a due date.
  const batch = [
    ...[[f.a1pb, 800, 300, 8], [f.a2pa1, 1200, 500, 12], [f.a2pa2, 1200, 500, 12], [f.a2pb, 600, 300, 8]]
      .flatMap(([id, l, w, t]) => [
        { recordId: id, specCode: LEN.code, value: l }, { recordId: id, specCode: WID.code, value: String(w) }, { recordId: id, specCode: THK.code, value: t },
      ]),
    { recordId: f.a1pa2, specCode: GRD.code, value: 'e250' },               // by value, any case
    { recordId: f.a1pb, specCode: GRD.code, value: String(f.opt.E350) },    // by id, as the grid sends it
    { recordId: f.a2pa1, specCode: GRD.code, value: 'E250' },
    { recordId: f.a2pa2, specCode: GRD.code, value: 'E350' },
    { recordId: f.a2pb, specCode: GRD.code, value: 'E250' },
    { recordId: f.a2pa1, specCode: CLS.code, value: String(f.opt.clsB) },   // override the default
    { recordId: f.a2pa1, specCode: HOLED.code, value: 'true' },
    { recordId: f.a2pa1, specCode: MARK.code, value: 'W-7' },
    { recordId: f.asm2, specCode: PAINT.code, value: 'RAL7035' },           // its parts inherit it
    { recordId: f.asm2, specCode: DUE.code, value: '2026-10-15' },
  ];

  section('7. A dry run is the real write, rolled back — it writes nothing');
  const countsBeforeDry = await counts(conn);
  const { out: dry, n: dryTrips } = await roundTrips(conn, () => OV.writeLineValues(conn, c, f.lineId, { dryRun: true, writes: batch }));
  eq('it says it did not apply', [dry.applied, dry.dryRun], [false, true]);
  eq('it reports every value it would save', dry.summary.changed, batch.length);
  eq('and the ten worked-out values that would follow — four weights, three roll-ups, three inherited paints', dry.summary.derived, 10);
  says(dry.summary.sentence);
  eq('no table changed', diff(countsBeforeDry, await counts(conn)), []);
  eq('no value changed since the fixture was built', await stateOf(conn, everyone), start);
  eq('the stiffener still has no length', await stored(conn, f.a1pb, LEN), null);
  eq('but its view shows what the save would give', cellOf(dry.view, f.a1pb, LEN)?.input, '800');
  ok(`the dry run costs a fixed number of round trips (${dryTrips})`, dryTrips <= 16, `${dryTrips}`);

  section('8. Several writes across several records apply together — and match setValues exactly');
  // The same batch the old way, one setValues per record, inside a savepoint
  // that is rolled back: the state it leaves is what the bulk write must leave.
  await conn.query('SAVEPOINT old_way');
  const byRecord = new Map();
  for (const w of batch) { if (!byRecord.has(w.recordId)) byRecord.set(w.recordId, []); byRecord.get(w.recordId).push({ specCode: w.specCode, value: w.value }); }
  const { n: oldTrips } = await roundTrips(conn, async () => { for (const [id, entries] of byRecord) await V.setValues(conn, c, 'master', id, entries); });
  const oldState = await stateOf(conn, everyone);
  await conn.query('ROLLBACK TO SAVEPOINT old_way');

  const historyBefore = (await counts(conn)).cf_spec_value_history;
  const { out: saved, n: writeTrips } = await roundTrips(conn, () => OV.writeLineValues(conn, c, f.lineId, { writes: batch }));
  eq('it applied', saved.applied, true);
  eq(`all ${batch.length} values were saved`, saved.summary.changed, batch.length);
  says(saved.summary.sentence);
  eq('the stored state is exactly what one setValues per record leaves', await stateOf(conn, everyone), oldState);
  ok(`in ${writeTrips} round trips where setValues took ${oldTrips}`, writeTrips <= 16 && writeTrips < oldTrips, `${writeTrips} vs ${oldTrips}`);
  eq('four records got their size', (await Promise.all([f.a1pb, f.a2pa1, f.a2pa2, f.a2pb].map((id) => stored(conn, id, THK)))).every((v) => v?.source === 'entered'), true);
  eq('a grade typed by value is stored as the option', (await stored(conn, f.a1pa2, GRD))?.value, f.opt.E250);
  eq('a grade typed by id is stored as the option', (await stored(conn, f.a1pb, GRD))?.value, f.opt.E350);
  eq('the class override is the part\'s own, entered', await stored(conn, f.a2pa1, CLS), { value: f.opt.clsB, source: 'entered' });
  eq('a yes/no is stored', (await stored(conn, f.a2pa1, HOLED))?.value, true);
  eq('a date is stored', (await stored(conn, f.asm2, DUE))?.value, '2026-10-15');
  const historyAfter = (await counts(conn)).cf_spec_value_history;
  ok('every typed value has its history row, and so does every value that followed', historyAfter - historyBefore === saved.summary.historyRows && saved.summary.historyRows >= batch.length, `${historyAfter - historyBefore} rows, summary says ${saved.summary.historyRows}`);
  const [[h]] = await conn.query(
    "SELECT change_type, new_value FROM cf_spec_value_history WHERE company_id = ? AND subject_type = 'master' AND subject_id = ? AND specification_id = ? ORDER BY id DESC LIMIT 1",
    [COMPANY, f.a1pb, LEN.id],
  );
  const hv = typeof h?.new_value === 'string' ? JSON.parse(h.new_value) : h?.new_value;
  eq('a history row records what was typed, as valueService writes it', [h?.change_type, hv?.number, hv?.source, hv?.uom], ['create', 800, 'entered', 'mm']);
  const fresh = await OV.readLineValues(conn, COMPANY, f.lineId);
  ok('the view the save hands back is exactly a fresh read', JSON.stringify(fresh) === JSON.stringify(saved.view));
  ok('and the dry run\'s view was exactly what the save gave', JSON.stringify(dry.view) === JSON.stringify(saved.view));

  section('9. Roll-ups, calculated and inherited values are right after the write');
  const partWt = (l, w, t) => (l * w * t * 7850) / 1e9;
  near('a part\'s weight is worked out from its new size', (await stored(conn, f.a1pb, WT))?.value, partWt(800, 300, 8));
  const asm1 = partWt(1000, 500, 10) + partWt(1000, 400, 10) + 2 * partWt(800, 300, 8) + 4 * 0.25;
  const asm2 = 2 * partWt(1200, 500, 12) + 2 * partWt(600, 300, 8) + 4 * 0.25;
  near('the first segment adds up its parts, the stiffeners twice and four bolts', (await stored(conn, f.asm1, WT))?.value, asm1);
  near('so does the second', (await stored(conn, f.asm2, WT))?.value, asm2);
  near('and the girder adds up both segments', (await stored(conn, f.root, WT))?.value, asm1 + asm2);
  eq('the roll-up is stored as a roll-up', (await stored(conn, f.root, WT))?.source, 'rollup');
  eq('the view shows the girder\'s weight', cellOf(saved.view, f.root, WT)?.display, `${(asm1 + asm2).toFixed(3)} kg`);
  eq('the second segment\'s parts now inherit its paint', (await stored(conn, f.a2pb, PAINT))?.value, 'RAL7035');
  eq('stored as inherited', (await stored(conn, f.a2pb, PAINT))?.source, 'inherited');
  eq('nothing is missing any more', saved.view.counts.missingOwn, 0);
  const md2 = await mirrorDiffers(conn, f.lineId);
  ok('the in-memory resolution still equals resolve() for every record', md2.bad.length === 0, `differs for ${md2.bad.join(', ')}`);

  section('10. A default comes back when the override is cleared; a no-op writes nothing');
  const cleared = await OV.writeLineValues(conn, c, f.lineId, { writes: [{ recordId: f.a2pa1, specCode: CLS.code, value: null }] });
  eq('clearing the override is one change', cleared.summary.changed, 1);
  eq('the part follows the default again', await stored(conn, f.a2pa1, CLS), { value: f.opt.clsA, source: 'defaulted' });
  eq('its cell is empty with the default shown', [cellOf(cleared.view, f.a2pa1, CLS)?.input ?? '', cellOf(cleared.view, f.a2pa1, CLS)?.defaultDisplay], ['', 'A']);
  const countsBeforeNoop = await counts(conn);
  const noop = await OV.writeLineValues(conn, c, f.lineId, { writes: [{ recordId: f.a1pa1, specCode: LEN.code, value: '1000' }] });
  eq('the same value again changes nothing', [noop.summary.changed, noop.summary.historyRows], [0, 0]);
  eq('and writes nothing', diff(countsBeforeNoop, await counts(conn)), []);

  section('11. The write costs the same few round trips whatever its size');
  const small = await roundTrips(conn, () => OV.writeLineValues(conn, c, f.lineId, { writes: [{ recordId: f.a1pa1, specCode: MARK.code, value: 'S1' }] }));
  const big = await roundTrips(conn, () => OV.writeLineValues(conn, c, f.lineId, {
    writes: [f.a1pa1, f.a1pa2, f.a1pb, f.a2pa1, f.a2pa2, f.a2pb].flatMap((id, i) => [
      { recordId: id, specCode: MARK.code, value: `B${i}` }, { recordId: id, specCode: LEN.code, value: 2000 + i }, { recordId: id, specCode: HOLED.code, value: i % 2 ? 'yes' : 'no' },
    ]),
  }));
  console.log(`        1 value: ${small.n} round trips · 18 values on 6 records, re-working 9 roll-up chains: ${big.n}`);
  ok('one value costs no more than 16 round trips', small.n <= 16, `${small.n}`);
  ok('eighteen values across six records cost no more than 16 either', big.n <= 16, `${big.n}`);
  near('and the roll-up followed the new lengths', (await stored(conn, f.root, WT))?.value,
    [[2000, 500, 10], [2001, 400, 10], [2002, 300, 8, 2], [2003, 500, 12], [2004, 500, 12], [2005, 300, 8, 2]]
      .reduce((sum, [l, w, t, q = 1]) => sum + q * partWt(l, w, t), 8 * 0.25));

  section('12. A frozen line refuses — a closed order, and a released line');
  await conn.query("UPDATE cf_sales_orders SET status = 'closed' WHERE company_id = ? AND id = ?", [COMPANY, f.orderId]);
  const closedView = await OV.readLineValues(conn, COMPANY, f.lineId);
  eq('the view says it is not editable', [closedView.editable, closedView.lock?.reason], [false, 'closed']);
  ok('and no column is editable', closedView.groups.every((g) => g.columns.every((col) => !col.editable)));
  ok('the lock is said once, on the view — no own row repeats it', closedView.groups.every((g) => !g.own || g.rows.every((r) => !r.readOnly)));
  says(closedView.lock?.message);
  const countsBeforeFrozen = await counts(conn);
  const closedPut = await refusal(() => OV.writeLineValues(conn, c, f.lineId, { writes: [{ recordId: f.a1pa1, specCode: MARK.code, value: 'late' }] }));
  eq('a write to a closed order is a 409', [closedPut?.status, closedPut?.code], [409, 'ORDER_CLOSED']);
  says(closedPut?.message);
  const closedDry = await refusal(() => OV.writeLineValues(conn, c, f.lineId, { dryRun: true, writes: [{ recordId: f.a1pa1, specCode: MARK.code, value: 'late' }] }));
  eq('so is a dry run', closedDry?.status, 409);
  eq('neither wrote anything', diff(countsBeforeFrozen, await counts(conn)), []);
  await conn.query("UPDATE cf_sales_orders SET status = 'confirmed' WHERE company_id = ? AND id = ?", [COMPANY, f.orderId]);
  const relId = (await conn.query(
    'INSERT INTO cf_production_releases (company_id, order_id, order_line_id, item_id, quantity, created_by) VALUES (?, ?, ?, ?, 2, ?)',
    [COMPANY, f.orderId, f.lineId, f.root, c.userId],
  ))[0].insertId;
  const releasedView = await OV.readLineValues(conn, COMPANY, f.lineId);
  eq('a released line\'s view is not editable either', [releasedView.editable, releasedView.lock?.reason], [false, 'released']);
  const countsBeforeReleased = await counts(conn);
  const relPut = await refusal(() => OV.writeLineValues(conn, c, f.lineId, { writes: [{ recordId: f.a1pa1, specCode: MARK.code, value: 'late' }] }));
  eq('a write to a released line is a 409', [relPut?.status, relPut?.code], [409, 'RELEASED']);
  says(relPut?.message);
  eq('and wrote nothing', diff(countsBeforeReleased, await counts(conn)), []);
  eq('the mark is still what it was', (await stored(conn, f.a1pa1, MARK))?.value, 'B0');
  await conn.query('UPDATE cf_production_releases SET deleted_at = NOW() WHERE company_id = ? AND id = ?', [COMPANY, relId]);
  const openAgain = await OV.writeLineValues(conn, c, f.lineId, { writes: [{ recordId: f.a1pa1, specCode: MARK.code, value: 'after' }] });
  eq('with the release taken back, the same write goes through', openAgain.applied && (await stored(conn, f.a1pa1, MARK))?.value === 'after', true);

  section('13. Bad requests are refused before anything is read');
  const shape = await refusal(() => OV.writeLineValues(conn, c, f.lineId, { writes: 'all of them' }));
  eq('writes that are not a list are a 422', shape?.status, 422);
  const noLine = await refusal(() => OV.readLineValues(conn, COMPANY, 2147483000));
  eq('a line that does not exist is a 404', noLine?.status, 404);

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

section('14. Nothing survived the rollback');
const after = await counts(pool);
const left = diff(before, after);
ok('every table it wrote is back to the count it started at', left.length === 0, left.join(', '));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) console.log(`failed: ${fails.join(' · ')}`);
await pool.end();
process.exitCode = failed ? 1 : 0;
