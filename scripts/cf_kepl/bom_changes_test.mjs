/**
 * bom_changes_test.mjs — edit mode's batch of BOM changes, against the local DB.
 *
 *   cd multi_app_be && node scripts/cf_kepl/bom_changes_test.mjs
 *
 * EVERYTHING HAPPENS INSIDE ONE TRANSACTION THAT IS ROLLED BACK. Nothing here is
 * committed, and the last thing it does is re-count every table it wrote and
 * prove each is back at the count it started with.
 *
 * IT BUILDS ITS OWN FIXTURE — classification, specifications, formulas, flows,
 * catalog items, templates, a selection, a coding rule and an order — and reads
 * none of the company's own nodes, records or rules. Four suites broke in one
 * week by borrowing tenant data, one of them because uq_ccn_sibling is unique on
 * the NAME, not the code; every name and code here carries a run tag. Its coding
 * rule is more specific than any the company has (kind + exact Variant), so the
 * codes it asserts are the fixture's own, produced by the real generator.
 *
 * ok(label, cond) — the label FIRST. A swapped call has passed unconditionally
 * twice in this codebase, so ok() here refuses anything but (string, boolean).
 */
import path from 'path';
import { pathToFileURL } from 'url';

const BE = process.cwd();
const imp = (p) => import(pathToFileURL(path.join(BE, p)).href);
const { pool } = await imp('db.js');
const { attachNodeCache, detachNodeCache } = await imp('apps/cf_erp/lib/db.js');
await imp('apps/cf_erp/services/codegenProvider.js'); // registers 'item' with the code generator, as app.js does
const BC = await imp('apps/cf_erp/services/bomChangeService.js');
const B = await imp('apps/cf_erp/services/bomService.js');
const S = await imp('apps/cf_erp/services/salesOrderService.js');
const V = await imp('apps/cf_erp/services/valueService.js');
const M = await imp('apps/cf_erp/services/masterRecordService.js');

const COMPANY = Number(process.env.CF_BOMCHG_COMPANY ?? 2);

/* --------------------------------------------------------------------------
 * A tiny harness
 * ----------------------------------------------------------------------- */
let passed = 0;
let failed = 0;
const fails = [];
function ok(name, cond, detail = '') {
  if (typeof name !== 'string' || typeof cond !== 'boolean') {
    throw new Error(`ok(label, cond) was called as ok(${typeof name}, ${typeof cond}) — the label comes first and the condition must be a boolean.`);
  }
  if (cond) { passed += 1; console.log(`  PASS  ${name}`); }
  else { failed += 1; fails.push(name); console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}
const same = (got, want) => Object.is(got, want) || JSON.stringify(got) === JSON.stringify(want);
const eq = (name, got, want) => ok(name, same(got, want), `got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);
const near = (name, got, want) => ok(name, got != null && Math.abs(Number(got) - want) < 1e-6, `got ${got}, wanted ${want}`);
const section = (s) => console.log(`\n${s}`);
const some = (xs, re) => (xs ?? []).some((p) => re.test(String(p)));
const refusal = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

/* --------------------------------------------------------------------------
 * Counting, so "writes nothing" is a fact and not a hope
 * ----------------------------------------------------------------------- */
const COUNTED = [
  'cf_classification_nodes', 'cf_specifications', 'cf_spec_options', 'cf_formulas',
  'cf_spec_assignments', 'cf_spec_assignment_options', 'cf_spec_values', 'cf_spec_value_history',
  'cf_master_records', 'cf_item_details', 'cf_definition_details', 'cf_definition_allowed_items',
  'cf_boms', 'cf_bom_lines', 'cf_operation_flows', 'cf_sales_orders', 'cf_sales_order_lines',
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

/** Round trips: every query the connection sends while a paste runs, and how many were INSERTs. */
function meter(conn) {
  const real = conn.query.bind(conn);
  const m = { total: 0, inserts: 0 };
  conn.query = (sql, ...rest) => {
    m.total += 1;
    if (/^\s*INSERT/i.test(typeof sql === 'string' ? sql : sql?.sql ?? '')) m.inserts += 1;
    return real(sql, ...rest);
  };
  return { m, stop: () => { conn.query = real; } };
}

/* --------------------------------------------------------------------------
 * The fixture
 * ----------------------------------------------------------------------- */
async function buildFixture(db, c) {
  const tag = `BCT${Date.now().toString(36).toUpperCase()}`;
  const ins = async (sql, params) => (await db.query(sql, params))[0].insertId;

  // Classification — its own Family > Subfamily > Variant, names tagged.
  const node = (parentId, depth, key) => ins(
    "INSERT INTO cf_classification_nodes (company_id, parent_id, depth, scope, code, name, status) VALUES (?, ?, ?, 'both', ?, ?, 'active')",
    [COMPANY, parentId, depth, `${tag}-${key}`, `${tag} ${key} — bom changes test`],
  );
  const fam = await node(null, 0, 'F');
  const sub = await node(fam, 1, 'S');
  const variant = await node(sub, 2, 'V');

  const spec = async (key, dataType, uom = null) => {
    const code = `${tag}_${key}`;
    return { id: await ins("INSERT INTO cf_specifications (company_id, code, name, data_type, default_uom, status) VALUES (?, ?, ?, ?, ?, 'active')", [COMPANY, code, `${key} (test)`, dataType, uom]), code };
  };
  const LEN = await spec('LEN', 'number', 'mm');
  const WID = await spec('WID', 'number', 'mm');
  const WT = await spec('WT', 'number', 'kg');
  const GRD = await spec('GRD', 'text');
  const FIN = await spec('FIN', 'option');
  const galv = await ins("INSERT INTO cf_spec_options (company_id, specification_id, value, status) VALUES (?, ?, 'GALV', 'active')", [COMPANY, FIN.id]);
  await ins("INSERT INTO cf_spec_options (company_id, specification_id, value, status) VALUES (?, ?, 'PAINT', 'active')", [COMPANY, FIN.id]);
  const formula = (key, expression) => ins("INSERT INTO cf_formulas (company_id, code, name, expression, status) VALUES (?, ?, ?, ?, 'active')", [COMPANY, `${tag}_${key}`, key, expression]);
  const wtCalc = await formula('WTCALC', `${LEN.code} * ${WID.code} / 1000`);
  const wtSum = await formula('WTSUM', `SUM(children.${WT.code})`);

  const flow = (key, status) => ins('INSERT INTO cf_operation_flows (company_id, code, name, status) VALUES (?, ?, ?, ?)', [COMPANY, `${tag}-${key}`, `Flow ${key}`, status]);
  const FLW1 = await flow('F1', 'active');
  const FLW2 = await flow('F2', 'active');
  const FLWX = await flow('FX', 'obsolete');

  const master = async (kind, key, name, short, classificationId = variant) => {
    const id = await ins(
      "INSERT INTO cf_master_records (company_id, record_kind, code, name, short_name, classification_id, status, created_by) VALUES (?, ?, ?, ?, ?, ?, 'active', ?)",
      [COMPANY, kind === 'catalog' ? 'item' : 'definition', `${tag}-${key}`, name, short, classificationId, c.userId],
    );
    if (kind === 'catalog') {
      await db.query("INSERT INTO cf_item_details (master_id, company_id, item_type, tracked_by, uom, sourcing) VALUES (?, ?, 'catalog', 'quantity', 'nos', 'stock')", [id, COMPANY]);
    } else {
      await db.query('INSERT INTO cf_definition_details (master_id, company_id, definition_type, selection_mode) VALUES (?, ?, ?, ?)', [id, COMPANY, kind, kind === 'selection' ? 'allowed_list' : null]);
    }
    return id;
  };
  const rule = (subjectType, subjectId, specId, valueRule, formulaId = null) => ins(
    "INSERT INTO cf_spec_assignments (company_id, specification_id, subject_type, subject_id, capture_at, is_required, is_applicable, value_rule, formula_id, sort_order, created_by) VALUES (?, ?, ?, ?, 'item', 0, 1, ?, ?, 0, ?)",
    [COMPANY, specId, subjectType, subjectId, valueRule, formulaId, c.userId],
  );
  const bomOf = (parentId, bomType) => ins("INSERT INTO cf_boms (company_id, parent_id, bom_type, status, created_by) VALUES (?, ?, ?, 'active', ?)", [COMPANY, parentId, bomType, c.userId]);
  const line = (bomId, lineNo, childId, qty, { position = 1, flowId = null, designId = childId } = {}) => ins(
    'INSERT INTO cf_bom_lines (company_id, bom_id, line_no, child_id, design_id, position, quantity, operation_flow_id, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [COMPANY, bomId, lineNo, childId, designId, position, qty, flowId, c.userId],
  );
  const catalogValue = (itemId, specId, n) => db.query(
    "INSERT INTO cf_spec_values (company_id, specification_id, subject_type, subject_id, value_number, source) VALUES (?, ?, 'master', ?, ?, 'entered')",
    [COMPANY, specId, itemId, n],
  );

  // Catalog items, each carrying its own weight so a roll-up over them can finish.
  const BOLT = await master('catalog', 'BOLT', 'Test bolt', 'BLT');
  const BOLT2 = await master('catalog', 'BOLT2', 'Test bolt, long', 'BLT');
  const ASSY = await master('catalog', 'ASSY', 'Test bracket kit', 'KIT');
  for (const [id, w] of [[BOLT, 0.1], [BOLT2, 0.2], [ASSY, 2]]) { await rule('master', id, WT.id, 'entered'); await catalogValue(id, WT.id, w); }
  const assyBom = await bomOf(ASSY, 'standard');
  const assyBoltLine = await line(assyBom, 10, BOLT, 4);

  // Definitions: two parts, a selection, a segment made of them, a girder of two segments.
  const WEB = await master('template', 'WEB', 'Web plate', 'WEB');
  const FLANGE = await master('template', 'FLG', 'Flange plate', 'FLG');
  const SEL = await master('selection', 'SEL', 'Bolt choice', 'SEL');
  await db.query('INSERT INTO cf_definition_allowed_items (company_id, definition_id, item_id, is_default) VALUES (?, ?, ?, 1)', [COMPANY, SEL, BOLT2]);
  const SEGMENT = await master('template', 'SEG', 'Girder segment', 'SEG');
  const GIRDER = await master('template', 'GDR', 'Girder', 'GDR');
  const segBom = await bomOf(SEGMENT, 'template');
  const tplWebLine = await line(segBom, 10, WEB, 1);
  await line(segBom, 20, FLANGE, 2, { flowId: FLW2 });
  await line(segBom, 30, BOLT, 8);
  await line(segBom, 40, SEL, 4);
  await line(segBom, 50, ASSY, 1);
  const gdrBom = await bomOf(GIRDER, 'template');
  await line(gdrBom, 10, SEGMENT, 1, { position: 1 });
  await line(gdrBom, 20, SEGMENT, 1, { position: 2 });

  // Rules: sizes typed on every item; a part's weight worked out from its size,
  // an assembly's rolled up; the grade typed on a segment, inherited by its parts.
  await rule('classification', variant, LEN.id, 'entered');
  await rule('classification', variant, WID.id, 'entered');
  for (const part of [WEB, FLANGE]) { await rule('master', part, WT.id, 'calculated', wtCalc); await rule('master', part, GRD.id, 'inherited'); }
  for (const asm of [SEGMENT, GIRDER]) { await rule('master', asm, WT.id, 'rollup', wtSum); await rule('master', asm, GRD.id, 'entered'); }

  // The fixture's own coding rule: {parent.code}-{shortName}{position:00}.
  // kind (1) + exact Variant (4) outweighs every rule the company already has.
  const scheme = await ins(
    "INSERT INTO cf_code_schemes (company_id, code, name, entity_type, target_field, seq_scope, priority, status) VALUES (?, ?, 'Bom changes test', 'item', 'code', 'prefix', 0, 'active')",
    [COMPANY, `${tag}-TMP`],
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

  // A stiffener, coded the way the company now codes parts — {parent.code}-
  // {shortName}{range} (codeRangeService) — by a rule that also names the
  // definition, so it outweighs the rule above (1 + 4 + 4 against 1 + 4).
  const STIFF = await master('template', 'STIFF', 'Intermediate stiffener', 'IS');
  const rangeScheme = await ins(
    "INSERT INTO cf_code_schemes (company_id, code, name, entity_type, target_field, seq_scope, priority, status) VALUES (?, ?, 'Bom changes test — ranges', 'item', 'code', 'prefix', 0, 'active')",
    [COMPANY, `${tag}-RNG`],
  );
  for (const [k, op, v] of [['kind', 'eq', 'temporary'], ['classification', 'eq', String(variant)], ['definition', 'eq', String(STIFF)]]) {
    await db.query('INSERT INTO cf_code_scheme_conditions (company_id, scheme_id, token_key, operator, value) VALUES (?, ?, ?, ?, ?)', [COMPANY, rangeScheme, k, op, v]);
  }
  for (const [i, [type, token, literal, format]] of [['token', 'parent.code'], ['literal', null, '-'], ['token', 'record.shortName'], ['token', 'range', null, '0']].entries()) {
    await db.query(
      'INSERT INTO cf_code_scheme_segments (company_id, scheme_id, sort_order, segment_type, literal_text, token_key, format) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [COMPANY, rangeScheme, i + 1, type, literal ?? null, token ?? null, format ?? null],
    );
  }

  // An order of its own, and a custom line made the real way: the girder
  // template becomes the order's temporary items, coded by the rule above.
  const orderCode = `${tag}-SO`;
  const orderId = await ins("INSERT INTO cf_sales_orders (company_id, code, order_type, title, status, created_by) VALUES (?, ?, 'customer', 'Bom changes fixture', 'inquiry', ?)", [COMPANY, orderCode, c.userId]);
  await S.addOrderLine(db, c, orderId, { recordId: GIRDER, quantity: 2 });
  const [[ol]] = await db.query('SELECT id, item_id FROM cf_sales_order_lines WHERE company_id = ? AND order_id = ? AND deleted_at IS NULL', [COMPANY, orderId]);

  const f = {
    tag, variant, orderId, orderCode, lineId: ol.id, root: ol.item_id,
    spec: { LEN, WID, WT, GRD, FIN }, galv, flows: { FLW1, FLW2, FLWX },
    BOLT, BOLT2, ASSY, assyBoltLine, WEB, FLANGE, SEL, SEGMENT, GIRDER, STIFF, tplWebLine,
  };
  let t = await look(db, f);
  f.rootCode = `${orderCode}-GDR01`;
  f.seg1 = t.byCode.get(`${f.rootCode}-SEG01`);
  f.seg2 = t.byCode.get(`${f.rootCode}-SEG02`);
  if (!f.seg1 || !f.seg2) throw new Error(`The fixture's structure did not come out coded as expected: ${[...t.byCode.keys()].join(', ')}`);

  // A cut plate both webs are cut from — ONE temporary item under two parts,
  // the way cutPlateService leaves one — filed under the fixture's own
  // cut-plate variant, which the service is told about (opts.cutPlateCode).
  const cutVariant = await node(sub, 2, 'CUTP');
  f.cutPlateCode = `${tag}-CUTP`;
  f.cutVariant = cutVariant;
  const BLK = await master('template', 'BLK', 'Cut plate', 'BLK', cutVariant);
  f.blank = await ins(
    "INSERT INTO cf_master_records (company_id, record_kind, code, name, classification_id, status, created_by) VALUES (?, 'item', ?, 'Cut plate 10 x 500 x 1000', ?, 'draft', ?)",
    [COMPANY, `${tag}-BLANK1`, cutVariant, c.userId],
  );
  await db.query(
    "INSERT INTO cf_item_details (master_id, company_id, item_type, tracked_by, uom, sourcing, source_definition_id, owner_order_line_id) VALUES (?, ?, 'temporary', 'individual', 'nos', 'make', ?, ?)",
    [f.blank, COMPANY, BLK, ol.id],
  );
  for (const seg of [f.seg1, f.seg2]) {
    const webBom = await ins("INSERT INTO cf_boms (company_id, parent_id, bom_type, status, created_by) VALUES (?, ?, 'custom', 'draft', ?)", [COMPANY, kid(seg, WEB).id, c.userId]);
    await line(webBom, 10, f.blank, 1, { designId: BLK });
  }
  t = await look(db, f);
  f.seg1 = t.byCode.get(`${f.rootCode}-SEG01`);
  f.seg2 = t.byCode.get(`${f.rootCode}-SEG02`);

  // Values the real way: every write through valueService, roll-ups following.
  const set = (id, entries) => V.setValues(db, c, 'master', id, entries.map(([s, value]) => ({ specCode: s.code, value })));
  await set(f.root, [[GRD, 'E350']]);
  await set(f.seg1.id, [[GRD, 'E350']]);
  await set(f.seg2.id, [[GRD, 'E250']]);
  for (const seg of [f.seg1, f.seg2]) {
    await set(kid(seg, WEB).id, [[LEN, 1000], [WID, 500]]);
    await set(kid(seg, FLANGE).id, [[LEN, 1000], [WID, 300]]);
  }
  // A rule the WEB of segment 1 carries itself, narrowed to one option, and a
  // default flow of its own — both must travel with a copy.
  const web1 = kid(f.seg1, WEB).id;
  const itemRule = await rule('master', web1, FIN.id, 'entered');
  await db.query('INSERT INTO cf_spec_assignment_options (company_id, assignment_id, option_id) VALUES (?, ?, ?)', [COMPANY, itemRule, galv]);
  await set(web1, [[FIN, 'GALV']]);
  await M.updateRecord(db, c, web1, { defaultFlowId: FLW1 });
  return f;
}

/** The order line's structure, a lookup by code, and each line's design (explode does not carry it). */
const designOf = new Map();
async function look(db, f) {
  const tree = await B.explode(db, COMPANY, f.root, {});
  const byCode = new Map();
  const lineIds = [];
  const walk = (n) => { if (n.code) byCode.set(n.code, n); if (n.lineId) lineIds.push(n.lineId); n.children.forEach(walk); };
  walk(tree.root);
  if (lineIds.length) {
    const [rows] = await db.query('SELECT id, design_id FROM cf_bom_lines WHERE company_id = ? AND id IN (?)', [COMPANY, lineIds]);
    for (const r of rows) designOf.set(r.id, r.design_id);
  }
  return { tree, byCode };
}
/** A node's child made from one design (the first, unless `nth` says otherwise). */
const kid = (node, designId, nth = 0) => node.children.filter((k) => k.id === designId || designOf.get(k.lineId) === designId)[nth];
async function value(db, subjectId, s) {
  const [[v]] = await db.query(
    "SELECT value_number, value_text, option_id, source FROM cf_spec_values WHERE company_id = ? AND subject_type = 'master' AND subject_id = ? AND specification_id = ? AND deleted_at IS NULL",
    [COMPANY, subjectId, s.id],
  );
  if (!v) return null;
  return v.value_number != null ? Number(v.value_number) : v.value_text ?? v.option_id;
}
async function lineRow(db, lineId) {
  const [[l]] = await db.query('SELECT * FROM cf_bom_lines WHERE company_id = ? AND id = ?', [COMPANY, lineId]);
  return l;
}

/* --------------------------------------------------------------------------
 * The run
 * ----------------------------------------------------------------------- */
const [[user]] = await pool.query('SELECT id FROM users WHERE company_id = ? ORDER BY id LIMIT 1', [COMPANY]);
const c = { companyId: COMPANY, userId: user?.id ?? null };
const before = await counts(pool);
const conn = await pool.getConnection();
await conn.beginTransaction();
attachNodeCache(conn);

try {
  section('0. Fixture — its own classification, specs, templates, coding rule and order');
  const f = await buildFixture(conn, c);
  let t = await look(conn, f);
  const seg1 = () => t.byCode.get(`${f.rootCode}-SEG01`);
  const seg2 = () => t.byCode.get(`${f.rootCode}-SEG02`);
  const web1 = () => kid(seg1(), f.WEB);
  const flg1 = () => kid(seg1(), f.FLANGE);
  const bolt = (seg) => seg.children.find((k) => k.id === f.BOLT);
  const selLine = (seg) => seg.children.find((k) => k.selection?.id === f.SEL);
  const assyNode = (seg) => seg.children.find((k) => k.id === f.ASSY);
  ok('the girder template became the order\'s temporary items', t.tree.root.code === f.rootCode && !!seg1() && !!seg2());
  ok('the selection line started with its only candidate', selLine(seg1())?.id === f.BOLT2);
  near('a part\'s weight is worked out from its size', await value(conn, web1().id, f.spec.WT), 500);
  // 1×500 + 2×300 + 8×0.1 + 4×0.2 + 1×2
  near('a segment rolls its parts up', await value(conn, seg1().id, f.spec.WT), 1103.6);
  near('and the girder rolls its segments up', await value(conn, f.root, f.spec.WT), 2207.2);
  eq('a part inherits its segment\'s grade', await value(conn, kid(seg2(), f.WEB).id, f.spec.GRD), 'E250');
  ok('both webs are cut from one shared cut plate', kid(seg1(), f.WEB).children[0]?.id === f.blank && kid(seg2(), f.WEB).children[0]?.id === f.blank);
  const scope = { orderLineId: f.lineId };
  const opts = { cutPlateCode: f.cutPlateCode };
  const apply = (input, o = {}) => BC.applyBomChanges(conn, c, input, { ...opts, ...o });
  const run = (changes, extra = {}) => apply({ scope, changes, ...extra });
  const parentsOfBlank = async () => Number((await conn.query('SELECT COUNT(*) AS n FROM cf_bom_lines WHERE company_id = ? AND child_id = ? AND deleted_at IS NULL', [COMPANY, f.blank]))[0][0].n);

  /* ---- 1. several changes, one save ------------------------------------- */
  section('1. Several changes applied together');
  const s2bolt = bolt(seg2());
  const one = await run([
    { op: 'quantity', lineId: flg1().lineId, quantity: 3 },
    { op: 'flow', lineId: web1().lineId, flowId: f.flows.FLW1 },
    { op: 'remove', lineId: s2bolt.lineId },
  ]);
  eq('it says what it did', one.summary.sentence, '1 quantity changed, 1 flow changed, 1 line removed');
  eq('and it was applied', one.applied, true);
  eq('the flange line holds 3 now', Number((await lineRow(conn, flg1().lineId)).quantity), 3);
  eq('the web line is made by the flow chosen', (await lineRow(conn, web1().lineId)).operation_flow_id, f.flows.FLW1);
  ok('the bolt line of segment 2 is gone', (await lineRow(conn, s2bolt.lineId)).deleted_at != null);
  near('segment 1 rolled up again (a third flange)', await value(conn, seg1().id, f.spec.WT), 1403.6);
  near('segment 2 rolled up again (no bolts)', await value(conn, seg2().id, f.spec.WT), 1102.8);
  near('and the girder above both', await value(conn, f.root, f.spec.WT), 2506.4);
  eq('one result per change, in order', one.results.map((r) => r.op), ['quantity', 'flow', 'remove']);
  t = await look(conn, f);

  /* ---- 2. one bad change refuses the lot, every problem named ----------- */
  section('2. One bad change refuses the whole batch, with every problem listed');
  const beforeBad = await counts(conn);
  const bad = await refusal(() => run([
    { op: 'quantity', lineId: web1().lineId, quantity: 5 },               // fine on its own
    { op: 'quantity', lineId: flg1().lineId, quantity: -1 },
    { op: 'flow', lineId: kid(seg2(), f.WEB).lineId, flowId: 2147483000 },
    { op: 'flow', lineId: kid(seg2(), f.FLANGE).lineId, flowId: f.flows.FLWX },
    { op: 'flow', lineId: selLine(seg2()).lineId, flowId: f.flows.FLW1 },
    { op: 'remove', lineId: assyNode(seg2()).lineId },
    { op: 'quantity', lineId: assyNode(seg2()).lineId, quantity: 2 },
  ]));
  eq('it is refused as a whole', bad?.status, 422);
  eq('with the house code', bad?.code, 'INVALID');
  ok('a quantity below zero is named', some(bad?.problems, /FLG01: Quantity must be more than zero/), JSON.stringify(bad?.problems));
  ok('a flow that does not exist is named', some(bad?.problems, /WEB01: That flow does not exist/));
  ok('an obsolete flow is named', some(bad?.problems, /FLG01: Flow .*-FX is obsolete/));
  ok('a flow on a selection line is named', some(bad?.problems, /selection line takes the flow/));
  ok('a change to a line the same save removes is named', some(bad?.problems, /changed and removed in the same save/));
  eq('all five, together', bad?.problems?.length, 5);
  eq('the good change did not happen either', Number((await lineRow(conn, web1().lineId)).quantity), 1);
  ok('and nothing was written', diff(beforeBad, await counts(conn)).length === 0, diff(beforeBad, await counts(conn)).join(', '));

  // Each case below really removes, inside a savepoint, and is rolled back so
  // the sections after it find both webs where they were.
  section('2b. Removing a part leaves the cut plate another part is still cut from');
  const live = async (id) => (await conn.query('SELECT deleted_at FROM cf_master_records WHERE id = ?', [id]))[0][0]?.deleted_at == null;
  await conn.query('SAVEPOINT t2b');
  const webGone = await run([{ op: 'remove', lineId: web1().lineId }]);
  eq('removing one web goes through', webGone.summary.counts.removed, 1);
  ok('the web is gone', !(await live(web1().id)));
  ok('the cut plate is not — segment 2\'s web is still cut from it', await live(f.blank));
  eq('and that web is the one part left on it', await parentsOfBlank(), 1);
  await conn.query('ROLLBACK TO SAVEPOINT t2b');
  await B.removeLine(conn, c, web1().lineId);
  ok('the one-line Remove leaves it too — the delete both use is where it was wrong', (await live(f.blank)) && (await parentsOfBlank()) === 1);
  await conn.query('ROLLBACK TO SAVEPOINT t2b');
  await run([{ op: 'remove', lineId: web1().lineId }, { op: 'remove', lineId: kid(seg2(), f.WEB).lineId }]);
  ok('removing the LAST part cut to it takes the cut plate with it', !(await live(f.blank)));
  await conn.query('ROLLBACK TO SAVEPOINT t2b');
  eq('(rolled back: both webs on it again)', await parentsOfBlank(), 2);

  /* ---- 3. a dry run writes nothing -------------------------------------- */
  section('3. A dry run writes nothing, and says what Save would do');
  const beforeDry = await counts(conn);
  const dry = await run([
    { op: 'quantity', lineId: web1().lineId, quantity: 2 },
    { op: 'paste', sourceLineId: seg1().lineId, parentId: f.root },
    { op: 'remove', lineId: kid(seg2(), f.FLANGE).lineId },
  ], { dryRun: true });
  eq('it says it is a dry run', [dry.dryRun, dry.applied], [true, false]);
  eq('it counts what would change', dry.summary.sentence, '1 quantity changed, 1 line pasted (3 new temporary items), 1 line removed');
  const dryCodes = dry.results[1].items.map((i) => i.code);
  eq('and names the codes the copies would get', dryCodes, [`${f.rootCode}-SEG03`, `${f.rootCode}-SEG03-WEB01`, `${f.rootCode}-SEG03-FLG01`]);
  ok('it gives no ids for rows that were never kept', dry.results[1].lineId === null && dry.results[1].items.every((i) => i.id === null));
  ok('nothing was written', diff(beforeDry, await counts(conn)).length === 0, diff(beforeDry, await counts(conn)).join(', '));
  eq('the quantity is as it was', Number((await lineRow(conn, web1().lineId)).quantity), 1);

  /* ---- 4. a stray line is refused, never guessed at ---------------------- */
  section('4. A line that is not part of this structure is refused');
  const stray = await refusal(() => run([
    { op: 'quantity', lineId: f.tplWebLine, quantity: 2 },         // the SEGMENT template's own line — real, but not here
    { op: 'remove', lineId: 2147483000 },                          // no such line
    { op: 'quantity', lineId: kid(assyNode(seg1()), f.BOLT)?.lineId ?? assyNode(seg1()).children[0].lineId, quantity: 9 }, // in the tree, not this screen's
  ]));
  eq('refused', stray?.status, 422);
  eq('both stray ids named', stray?.problems?.filter((p) => /is not part of this structure/.test(p)).length, 2);
  ok('a line in a catalog item\'s own BOM is not this screen\'s to change', some(stray?.problems, /ASSY’s Standard BOM is shared by everything that uses/), JSON.stringify(stray?.problems));
  eq('and the template line was left alone', Number((await lineRow(conn, f.tplWebLine)).quantity), 1);

  /* ---- 5. deep paste into a Custom BOM ---------------------------------- */
  section('5. Paste into a Custom BOM is a deep copy — values, lines, flows, rules, codes');
  const beforePaste = await counts(conn);
  const m1 = meter(conn);
  const pasted = await run([{ op: 'paste', sourceLineId: seg1().lineId, parentId: f.root }]);
  m1.stop();
  const rtSeg = m1.m;
  eq('it pasted one line with three new temporary items', pasted.summary.sentence, '1 line pasted (3 new temporary items)');
  eq('the copies took the codes the dry run promised', pasted.results[0].items.map((i) => i.code), dryCodes);
  const afterPaste = await counts(conn);
  eq('three items with their detail rows, two BOMs (segment, web), seven lines',
    ['cf_master_records', 'cf_item_details', 'cf_boms', 'cf_bom_lines'].map((k) => afterPaste[k] - beforePaste[k]), [3, 3, 2, 7]);
  t = await look(conn, f);
  const seg3 = t.byCode.get(`${f.rootCode}-SEG03`);
  const web3 = seg3 && kid(seg3, f.WEB);
  const flg3 = seg3 && kid(seg3, f.FLANGE);
  ok('the copy hangs under the girder, after the other two', !!seg3 && seg3.lineNo === 30 && seg3.position === 3);
  const topLine = await lineRow(conn, pasted.results[0].lineId);
  eq('its line is the segment design, from the same template line', [topLine.design_id, topLine.source_line_id], [f.SEGMENT, (await lineRow(conn, seg1().lineId)).source_line_id]);
  const [copies] = await conn.query(
    `SELECT m.id, m.name, m.short_name, m.status, m.classification_id, m.default_flow_id, i.source_definition_id, i.owner_order_line_id, i.tracked_by
       FROM cf_master_records m JOIN cf_item_details i ON i.master_id = m.id WHERE m.id IN (?)`,
    [[seg3.id, web3.id, flg3.id]],
  );
  ok('every copy is a new draft temporary item of the same order line', copies.length === 3 && copies.every((x) => x.status === 'draft' && x.owner_order_line_id === f.lineId));
  ok('made from the same definitions, filed in the same place', copies.every((x) => [f.SEGMENT, f.WEB, f.FLANGE].includes(x.source_definition_id) && x.classification_id === f.variant));
  eq('the web copy keeps its own default flow', copies.find((x) => x.id === web3.id)?.default_flow_id, f.flows.FLW1);
  ok('the copies are new records, not the originals', ![seg1().id, web1().id, flg1().id].some((id) => [seg3.id, web3.id, flg3.id].includes(id)));
  eq('the copy has every line the original has', seg3.children.length, seg1().children.length);
  eq('catalog items are referenced, not copied', bolt(seg3)?.id, f.BOLT);
  ok('the selection line is referenced with its choice', selLine(seg3)?.id === f.BOLT2 && selLine(seg3)?.selection?.id === f.SEL);
  eq('the catalog kit is referenced, its own BOM untouched', [assyNode(seg3)?.id, assyNode(seg3)?.children.length], [f.ASSY, 1]);
  eq('the web copy is cut from the SAME cut plate — shared, not copied', web3.children.map((k) => k.id), [f.blank]);
  eq('which now serves three parts', await parentsOfBlank(), 3);
  const [[inCut]] = await conn.query(
    'SELECT COUNT(*) AS n FROM cf_master_records m JOIN cf_item_details i ON i.master_id = m.id AND i.deleted_at IS NULL WHERE m.company_id = ? AND m.classification_id = ? AND m.deleted_at IS NULL',
    [COMPANY, f.cutVariant],
  );
  eq('no second cut plate was made', Number(inCut.n), 1);
  ok('and the result says so', some(pasted.results[0].notes, /Shares 1 cut plate with the original .*BLANK1/), JSON.stringify(pasted.results[0].notes));
  eq('the flange line keeps its quantity as saved', flg3.quantity, 3);
  eq('and its flow from the template line', flg3.flow?.id, f.flows.FLW2);
  eq('the web line keeps the flow chosen in section 1', (await lineRow(conn, web3.lineId)).operation_flow_id, f.flows.FLW1);
  eq('the web copy has its sizes — the dimensions', [await value(conn, web3.id, f.spec.LEN), await value(conn, web3.id, f.spec.WID)], [1000, 500]);
  eq('its own option value', await value(conn, web3.id, f.spec.FIN), f.galv);
  const [[ruleCopy]] = await conn.query(
    "SELECT a.id, (SELECT GROUP_CONCAT(o.option_id) FROM cf_spec_assignment_options o WHERE o.assignment_id = a.id AND o.deleted_at IS NULL) AS opts FROM cf_spec_assignments a WHERE a.company_id = ? AND a.subject_type = 'master' AND a.subject_id = ? AND a.specification_id = ? AND a.deleted_at IS NULL",
    [COMPANY, web3.id, f.spec.FIN.id],
  );
  eq('and the rule it carries itself, narrowed the same way', ruleCopy?.opts, String(f.galv));
  const [[hist]] = await conn.query("SELECT COUNT(*) AS n FROM cf_spec_value_history WHERE company_id = ? AND subject_type = 'master' AND subject_id = ?", [COMPANY, web3.id]);
  const [[valsN]] = await conn.query("SELECT COUNT(*) AS n FROM cf_spec_values WHERE company_id = ? AND subject_type = 'master' AND subject_id = ? AND deleted_at IS NULL", [COMPANY, web3.id]);
  ok('every copied value left a history row', Number(hist.n) > 0 && Number(hist.n) === Number(valsN.n), `${hist.n} history, ${valsN.n} values`);
  near('the copy weighs what the original weighs', await value(conn, seg3.id, f.spec.WT), 1403.6);
  near('and the girder now rolls up three segments', await value(conn, f.root, f.spec.WT), 1403.6 * 2 + 1102.8);

  section('5b. The copy is independent of the original');
  await V.setValues(conn, c, 'master', web3.id, [{ specCode: f.spec.LEN.code, value: 2000 }]);
  near('a new size on the copy moves the copy', await value(conn, web3.id, f.spec.WT), 1000);
  eq('and not the original', [await value(conn, web1().id, f.spec.LEN), await value(conn, web1().id, f.spec.WT)], [1000, 500]);
  await run([{ op: 'quantity', lineId: flg3.lineId, quantity: 5 }]);
  eq('a quantity on the copy leaves the original\'s line alone', Number((await lineRow(conn, flg1().lineId)).quantity), 3);
  await conn.query('SAVEPOINT t5b');
  await run([{ op: 'remove', lineId: web3.lineId }]);
  ok('removing the copy\'s web leaves the cut plate for the two webs still on it', (await live(f.blank)) && (await parentsOfBlank()) === 2);
  await conn.query('ROLLBACK TO SAVEPOINT t5b');
  await run([{ op: 'remove', lineId: flg3.lineId }]);
  const [[gone]] = await conn.query('SELECT deleted_at FROM cf_master_records WHERE id = ?', [flg3.id]);
  const [[kept]] = await conn.query('SELECT deleted_at FROM cf_master_records WHERE id = ?', [flg1().id]);
  ok('removing the copy\'s flange deletes the copy only', gone.deleted_at != null && kept.deleted_at == null);
  t = await look(conn, f);

  section('5c. A pasted part follows its new parent where it inherits');
  const m2 = meter(conn);
  const moved = await run([{ op: 'paste', sourceLineId: web1().lineId, parentId: seg2().id }]);
  m2.stop();
  const rtWeb = m2.m;
  eq('the part copy is coded under its new parent', moved.results[0].items.map((i) => i.code), [`${f.rootCode}-SEG02-WEB02`]);
  t = await look(conn, f);
  const webInSeg2 = kid(seg2(), f.WEB, 1);
  eq('its grade is its new segment\'s', await value(conn, webInSeg2.id, f.spec.GRD), 'E250');
  eq('the original keeps its own', await value(conn, web1().id, f.spec.GRD), 'E350');

  /* ---- 6. template and standard BOMs reference the same child ----------- */
  section('6. Paste into a Template or Standard BOM adds a line to the same child');
  const beforeTpl = await counts(conn);
  const tpl = await apply({ scope: { recordId: f.SEGMENT }, changes: [{ op: 'paste', sourceLineId: f.tplWebLine, parentId: f.SEGMENT, quantity: 2 }] });
  const tplLine = await lineRow(conn, tpl.results[0].lineId);
  eq('a template line to the same definition', [tplLine.child_id, tplLine.design_id, Number(tplLine.quantity)], [f.WEB, f.WEB, 2]);
  eq('numbered after the one it copies', tplLine.position, 2);
  eq('no record was created', (await counts(conn)).cf_master_records, beforeTpl.cf_master_records);
  eq('it reports the mode', tpl.results[0].mode, 'reference');
  const std = await apply({ scope: { recordId: f.ASSY }, changes: [{ op: 'paste', sourceLineId: f.assyBoltLine, parentId: f.ASSY }] });
  const stdLine = await lineRow(conn, std.results[0].lineId);
  eq('a standard line to the same catalog item', [stdLine.child_id, Number(stdLine.quantity)], [f.BOLT, 4]);
  const tplScopeRefusal = await refusal(() => apply({ scope: { recordId: f.GIRDER }, changes: [{ op: 'paste', sourceLineId: f.tplWebLine, parentId: f.SEGMENT }] }));
  ok('a sub-template\'s BOM is changed on that template, not from the girder', some(tplScopeRefusal?.problems, /SEG’s Template BOM is changed on the template itself/), JSON.stringify(tplScopeRefusal?.problems));
  const tempInTpl = await refusal(() => apply({ scope: { recordId: f.SEGMENT }, changes: [{ op: 'paste', sourceLineId: seg1().lineId, parentId: f.SEGMENT }] }));
  ok('and an order\'s line is not part of a template\'s structure', some(tempInTpl?.problems, /is not part of this structure/));

  /* ---- 7. loops ---------------------------------------------------------- */
  section('7. A paste that would put a thing under itself is refused');
  const loop = await refusal(() => run([
    { op: 'paste', sourceLineId: seg1().lineId, parentId: seg1().id },
    { op: 'paste', sourceLineId: seg2().lineId, parentId: kid(seg2(), f.WEB).id },
  ]));
  eq('refused', loop?.status, 422);
  ok('into itself', some(loop?.problems, /SEG01 cannot be pasted into itself/), JSON.stringify(loop?.problems));
  ok('into its own part', some(loop?.problems, /SEG02 cannot be pasted into .*WEB01, which is inside .*SEG02/));

  /* ---- 8. frozen -------------------------------------------------------- */
  section('8. A frozen order refuses, with a 409');
  const beforeFrozen = await counts(conn);
  await conn.query("UPDATE cf_sales_orders SET status = 'closed' WHERE id = ?", [f.orderId]);
  const frozen = await refusal(() => run([{ op: 'quantity', lineId: web1().lineId, quantity: 7 }]));
  eq('a closed order is a conflict', [frozen?.status, frozen?.code], [409, 'ORDER_CLOSED']);
  const frozenRecord = await refusal(() => apply({ scope: { recordId: seg1().id }, changes: [{ op: 'quantity', lineId: web1().lineId, quantity: 7 }] }));
  eq('from the item\'s own page as well', [frozenRecord?.status, frozenRecord?.code], [409, 'ORDER_CLOSED']);
  await conn.query("UPDATE cf_sales_orders SET status = 'inquiry' WHERE id = ?", [f.orderId]);
  eq('and nothing moved', Number((await lineRow(conn, web1().lineId)).quantity), 1);
  ok('not a row', diff(beforeFrozen, await counts(conn)).length === 0, diff(beforeFrozen, await counts(conn)).join(', '));

  /* ---- 9. contract edges ------------------------------------------------ */
  section('9. The rest of the contract');
  const asked = [];
  await apply({ scope, changes: [{ op: 'quantity', lineId: web1().lineId, quantity: 1 }] }, { allow: (bt) => asked.push(bt) });
  eq('the route is asked for the grant of the parent\'s BOM type', asked, ['custom']);
  const denied = await refusal(() => apply({ scope, changes: [{ op: 'quantity', lineId: web1().lineId, quantity: 4 }] }, {
    allow: () => { const e = new Error('Permission required'); e.status = 403; throw e; },
  }));
  eq('and its refusal stands', denied?.status, 403);
  const both = await refusal(() => apply({ scope: { recordId: 1, orderLineId: 1 }, changes: [] }));
  eq('a scope must name one structure', both?.status, 422);
  const nothing = await run([]);
  eq('an empty save changes nothing', nothing.summary.sentence, 'nothing to change');
  const twice = await refusal(() => run([{ op: 'quantity', lineId: web1().lineId, quantity: 2 }, { op: 'quantity', lineId: web1().lineId, quantity: 3 }]));
  ok('a line given two quantities is refused, not guessed at', some(twice?.problems, /more than one quantity/));
  const moveIt = await run([
    { op: 'paste', sourceLineId: selLine(seg1()).lineId, parentId: seg2().id },
    { op: 'remove', lineId: selLine(seg1()).lineId },
  ]);
  eq('paste there and remove here is a move', moveIt.summary.sentence, '1 line pasted, 1 line removed');
  t = await look(conn, f);
  eq('the selection now sits in segment 2 twice and segment 1 not at all', [seg2().children.filter((k) => k.selection?.id === f.SEL).length, seg1().children.filter((k) => k.selection?.id === f.SEL).length], [2, 0]);
  const webs = [seg1(), seg2(), t.byCode.get(`${f.rootCode}-SEG03`)].flatMap((s) => s.children.filter((k) => k.children.some((g) => g.id === f.blank)));
  const allGo = await run(webs.map((w) => ({ op: 'remove', lineId: w.lineId })), { dryRun: true });
  eq('removing every part a cut plate serves, together, is allowed', [webs.length, allGo.summary.counts.removed], [4, 4]);

  /* ---- 9b. range codes --------------------------------------------------- */
  section('9b. Range codes — a same-size copy pasted BEFORE a row of the same short name');
  const s1code = seg1().code;
  await B.addLine(conn, c, seg1().id, { childId: f.STIFF, quantity: 23 });   // a row added the ordinary way
  t = await look(conn, f);
  const stiffsOf = () => seg1().children.filter((k) => designOf.get(k.lineId) === f.STIFF);
  const isOriginal = stiffsOf()[0];
  eq('the stiffener row covers pieces 1-23 of its segment', isOriginal?.code, `${s1code}-IS1-23`);
  const before23 = { op: 'paste', sourceLineId: isOriginal.lineId, parentId: seg1().id, afterLineId: assyNode(seg1()).lineId };
  const isDry = await run([before23], { dryRun: true });
  eq('a dry run names the copy by the pieces it will take', isDry.results[0].items.map((i) => i.code), [`${s1code}-IS1-23`]);
  const isPasted = await refusal(() => run([before23]));
  ok('the copy is saved — no CODE_CLASH with the code the original carried', isPasted === null, JSON.stringify(isPasted?.problems ?? isPasted?.message));
  t = await look(conn, f);
  const stiffs = stiffsOf();
  eq('the copy comes first and takes 1-23, the original moves on to 24-46', stiffs.map((k) => k.code), [`${s1code}-IS1-23`, `${s1code}-IS24-46`]);
  ok('in the order they are shown, the original keeping its own record', stiffs.length === 2 && stiffs[0].lineNo < stiffs[1].lineNo && stiffs[1].id === isOriginal.id);
  await run([{ op: 'quantity', lineId: stiffs[0].lineId, quantity: 20 }]);
  t = await look(conn, f);
  eq('a quantity on the first row moves the numbers of the one after it', stiffsOf().map((k) => k.code), [`${s1code}-IS1-20`, `${s1code}-IS21-43`]);

  /* ---- 10. round trips --------------------------------------------------- */
  section('10. Round trips for a deep copy (what TiDB, ~49 ms away, will feel)');
  console.log(`  3-item segment copy: ${rtSeg.total} round trips, ${rtSeg.inserts} of them INSERTs`);
  console.log(`  1-item part copy:    ${rtWeb.total} round trips, ${rtWeb.inserts} of them INSERTs`);
  // The segment copy writes a BOM and five lines the part copy does not, and
  // three times the values — in the same handful of statements.
  ok('the writes do not grow with the number of items copied', rtSeg.inserts <= rtWeb.inserts + 2, `${rtSeg.inserts} vs ${rtWeb.inserts}`);

  // A flow moves no values; a quantity does. So (one quantity − one flow) is
  // what one refresh costs, and a second quantity under the SAME parent must
  // cost less than that — it is written, and waits for the one refresh.
  section('10b. Quantities under one parent share one refresh');
  const rt = async (changes) => { const m = meter(conn); await run(changes); m.stop(); return m.m.total; };
  const oneFlow = await rt([{ op: 'flow', lineId: flg1().lineId, flowId: f.flows.FLW1 }]);
  const oneQty = await rt([{ op: 'quantity', lineId: flg1().lineId, quantity: 4 }]);
  const twoQty = await rt([{ op: 'quantity', lineId: flg1().lineId, quantity: 6 }, { op: 'quantity', lineId: web1().lineId, quantity: 2 }]);
  console.log(`  one flow: ${oneFlow} round trips · one quantity: ${oneQty} · two quantities under one segment: ${twoQty}`);
  ok('the second quantity costs less than a refresh of its own', twoQty - oneQty < oneQty - oneFlow, `${twoQty} − ${oneQty} vs ${oneQty} − ${oneFlow}`);

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
const after = await counts(pool);
const left = diff(before, after);
ok('every table it wrote is back to the count it started at', left.length === 0, left.join(', '));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) console.log(`failed: ${fails.join(' · ')}`);
await pool.end();
process.exitCode = failed ? 1 : 0;
