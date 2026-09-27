/**
 * revision_test.mjs — REVISIONS (services/revisionService.js, models/init.sql
 * §27): a change after LOCK is a new revision of the same order. Against the
 * local database.
 *
 *   cd multi_app_be && node scripts/cf_kepl/revision_test.mjs
 *   CF_REV_COMPANY=3 node scripts/cf_kepl/revision_test.mjs          (3 is the default)
 *
 * The user, 2026-09-27: "If it changes, the whole sales order basically changes
 * so it should be a new one anyways" — a new revision of the same order
 * ("SO-…-0001 rev 2"). The locked revision stays exactly as it was; the new one
 * starts as a copy of its lines, structure and values, unlocked; locking it
 * gives every unchanged piece exactly the code it had.
 *
 * Run it in a company where the classification codes FAB_PARTS, CUT_PLATE and
 * PLATE and the specification codes THICKNESS, LENGTH, WIDTH and GRADE are all
 * free (company 3 locally). cutPlateService finds things by exactly those
 * codes, so the suite makes its own nodes and specifications with them rather
 * than borrow a tenant's — and refuses to run where they already exist.
 *
 * EVERYTHING HAPPENS INSIDE ONE TRANSACTION THAT IS ROLLED BACK, and the last
 * thing it does is re-count every cf_ table and prove each is back where it
 * started.
 *
 * IT OWNS ITS FIXTURE — classification, specifications and rules, raw plates
 * and the plate selection, templates, flow, customer, dispatch area, orders,
 * and the coding rules for pieces and cut plates — every name and code
 * carrying this run's tag (uq_ccn_sibling is unique on NAME per parent). Every
 * other item and production-piece coding rule of the company is switched off
 * for the transaction.
 *
 *   GIRDER  GR  (a line sells 1)
 *     SEGMENT SG x2 (one row)
 *       WEB   WB x1                 a plate part: 12 x 500 x 2000 E350
 *       STIFF IS x3  (plain)        a plate part: 10 x 100 x 300 E250
 *       STIFF IS x1  (drilled)      a plate part: 10 x 120 x 300 E250 — its own rectangle
 *       CLEAT CL x6                 not a plate part: MAT x 0.5 each
 *     each plate part is cut from a CUT PLATE the line derives per rectangle,
 *     cut from a raw plate the plate selection chooses (PL1 by default)
 *
 *   piece rules   the top  {order.code}-{item.shortName}-{line.position:00}-{piece.seq}
 *                 inside   {parent.code}-{item.shortName}{piece.seq}
 *   blank rule    {order.code}-{line.no}-{record.shortName}-{T}X{W}X{L}-{GRADE} — the
 *                 KEPL tenant's own shape, which a revision's cut plates repeat
 */
import path from 'path';
import { pathToFileURL } from 'url';

const BE = process.cwd();
const imp = (p) => import(pathToFileURL(path.join(BE, p)).href);
const { pool } = await imp('db.js');
await imp('apps/cf_erp/services/codegenProvider.js');           // registers the code-generator entities
const { attachNodeCache, detachNodeCache } = await imp('apps/cf_erp/lib/db.js');
const codegen = await imp('apps/cf_erp/modules/codegen/service.js');
const B = await imp('apps/cf_erp/services/bomService.js');
const BC = await imp('apps/cf_erp/services/bomChangeService.js');
const CUT = await imp('apps/cf_erp/services/cutPlateService.js');
const LOCK = await imp('apps/cf_erp/services/lockService.js');
const REV = await imp('apps/cf_erp/services/revisionService.js');
const SO = await imp('apps/cf_erp/services/salesOrderService.js');
const MR = await imp('apps/cf_erp/services/masterRecordService.js');
const OV = await imp('apps/cf_erp/services/orderValuesService.js');
const V = await imp('apps/cf_erp/services/valueService.js');
const SPEC = await imp('apps/cf_erp/services/specificationService.js');
const REL = await imp('apps/cf_erp/services/releaseService.js');
const NEST = await imp('apps/cf_erp/services/nestingService.js');
const STOCK = await imp('apps/cf_erp/services/stockService.js');
const SHIP = await imp('apps/cf_erp/services/dispatchService.js');
const OVS = await imp('apps/cf_erp/services/overviewService.js');
const PH = await imp('apps/cf_erp/services/placeholderService.js');
const SEL = await imp('apps/cf_erp/services/selectionService.js');
const DWG = await imp('apps/cf_erp/services/drawingService.js');
const { createRule } = await imp('apps/cf_erp/services/assignmentService.js');
const { createNode } = await imp('apps/cf_erp/services/classificationService.js');
const OPS = await imp('apps/cf_erp/services/operationService.js');
const FLOWS = await imp('apps/cf_erp/services/flowService.js');
const AREAS = await imp('apps/cf_erp/services/stockingAreaService.js');
const PARTIES = await imp('apps/cf_erp/modules/parties/service.js');
const orderRouter = (await imp('apps/cf_erp/routes/orders.js')).default;
const indexRouter = (await imp('apps/cf_erp/routes/index.js')).default;

const COMPANY = Number(process.env.CF_REV_COMPANY ?? 3);

/* --------------------------------------------------------------------------
 * A tiny harness
 * ----------------------------------------------------------------------- */
let passed = 0;
let failed = 0;
const fails = [];
/**
 * ok(label, cond, detail?) — the LABEL comes first. It demands a string and then
 * a boolean, so a swapped ok(cond, 'label'), or a truthy object passed as the
 * condition, throws instead of passing unconditionally.
 */
function ok(label, cond, detail = '') {
  if (typeof label !== 'string' || typeof cond !== 'boolean') {
    throw new Error(`ok(label, cond) takes a string and then a boolean — got ok(${typeof label}, ${typeof cond})`);
  }
  if (cond) { passed += 1; console.log(`  PASS  ${label}`); }
  else { failed += 1; fails.push(label); console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (label, got, want) => ok(label, Object.is(got, want), `got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);
const same = (label, got, want) => ok(label, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)?.slice(0, 500)}, wanted ${JSON.stringify(want)?.slice(0, 500)}`);
const section = (s) => console.log(`\n${s}`);
const says = (text) => console.log(`        says: ${text}`);
async function refusal(fn) {
  try { await fn(); return null; } catch (e) { return e; }
}
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/* --------------------------------------------------------------------------
 * Counting, so "writes nothing" is a fact and not a hope
 * ----------------------------------------------------------------------- */
async function cfTables(db) {
  const [rows] = await db.query("SHOW TABLES LIKE 'cf\\_%'");
  return rows.map((r) => Object.values(r)[0]).sort();
}
async function census(db, tables) {
  const out = {};
  for (const t of tables) {
    const [[r]] = await db.query(`SELECT COUNT(*) AS n FROM \`${t}\``);
    out[t] = Number(r.n);
  }
  return out;
}
/** Counts the round trips made through it. A Proxy, so the transaction's node cache still rides on the connection. */
function counting(db) {
  const tally = { n: 0 };
  const proxy = new Proxy(db, {
    get: (target, prop) => (prop === 'query' ? (...args) => { tally.n += 1; return target.query(...args); } : Reflect.get(target, prop)),
  });
  return { db: proxy, tally };
}

/* --------------------------------------------------------------------------
 * The fixture — all of it this run's own
 * ----------------------------------------------------------------------- */
const tag = `RVT${Date.now().toString(36).toUpperCase()}`;
const tok = (key, extra = {}) => ({ segmentType: 'token', tokenKey: key, transform: 'none', isRequired: true, ...extra });
const lit = (text) => ({ segmentType: 'literal', literalText: text });
const SIZES = {
  web: { THICKNESS: 12, LENGTH: 2000, WIDTH: 500, GRADE: 'E350' },
  plain: { THICKNESS: 10, LENGTH: 300, WIDTH: 100, GRADE: 'E250' },
  drilled: { THICKNESS: 10, LENGTH: 300, WIDTH: 120, GRADE: 'E250' },
};
const ROLE_SIZE = { Web: 'web', 'Stiffener — plain': 'plain', 'Stiffener — drilled': 'drilled' };

async function refuseTakenCodes(db) {
  const [nodes] = await db.query("SELECT code FROM cf_classification_nodes WHERE company_id = ? AND code IN ('FAB_PARTS','CUT_PLATE','PLATE') AND deleted_at IS NULL", [COMPANY]);
  const [specs] = await db.query("SELECT code FROM cf_specifications WHERE company_id = ? AND code IN ('THICKNESS','LENGTH','WIDTH','GRADE') AND deleted_at IS NULL", [COMPANY]);
  const taken = [...nodes.map((r) => r.code), ...specs.map((r) => r.code)];
  if (taken.length) {
    throw new Error(`Company ${COMPANY} already has ${taken.join(', ')} — run this in a company where FAB_PARTS, CUT_PLATE, PLATE, THICKNESS, LENGTH, WIDTH and GRADE are all free (such as 3), so the suite never borrows a tenant's setup.`);
  }
}

async function buildFixture(db, c) {
  await refuseTakenCodes(db);
  const fam = await createNode(db, c, { code: `${tag}-F`, name: `Revision fixture ${tag}` });
  const sub = await createNode(db, c, { parentId: fam.id, code: `${tag}-S`, name: `Revision kinds ${tag}` });
  const parts = await createNode(db, c, { parentId: fam.id, code: 'FAB_PARTS', name: `Parts ${tag}` });
  const steel = await createNode(db, c, { parentId: fam.id, code: `${tag}-ST`, name: `Steel ${tag}` });
  const v = {
    assy: await createNode(db, c, { parentId: sub.id, code: `${tag}-VA`, name: `Assemblies ${tag}` }),
    seg: await createNode(db, c, { parentId: sub.id, code: `${tag}-VS`, name: `Segments ${tag}` }),
    cleat: await createNode(db, c, { parentId: sub.id, code: `${tag}-VC`, name: `Cleats ${tag}` }),
    mat: await createNode(db, c, { parentId: sub.id, code: `${tag}-VM`, name: `Material ${tag}` }),
    part: await createNode(db, c, { parentId: parts.id, code: `${tag}-VP`, name: `Plate parts ${tag}` }),
    plate: await createNode(db, c, { parentId: steel.id, code: 'PLATE', name: `Plate ${tag}` }),
    cut: await createNode(db, c, { parentId: steel.id, code: 'CUT_PLATE', name: `Cut plate ${tag}` }),
  };

  // The four sizes cutPlateService pools parts by — this run's own specifications.
  const spec = async (code, dataType, uom) => {
    const [r] = await db.query(
      "INSERT INTO cf_specifications (company_id, code, name, data_type, default_uom, status) VALUES (?, ?, ?, ?, ?, 'active')",
      [COMPANY, code, `${code.toLowerCase()} (revision test ${tag})`, dataType, uom],
    );
    return { id: r.insertId, code };
  };
  const S = { THICKNESS: await spec('THICKNESS', 'number', 'mm'), LENGTH: await spec('LENGTH', 'number', 'mm'), WIDTH: await spec('WIDTH', 'number', 'mm'), GRADE: await spec('GRADE', 'option', null) };
  for (const g of ['E250', 'E350']) {
    await db.query("INSERT INTO cf_spec_options (company_id, specification_id, value, label, status, sort_order) VALUES (?, ?, ?, ?, 'active', 0)", [COMPANY, S.GRADE.id, g, g]);
  }
  // Plates and cut plates hold the sizes; a plate part must be given them.
  for (const s of Object.values(S)) {
    await createRule(db, c, { subjectType: 'classification', subjectId: steel.id, specificationId: s.id, captureAt: 'item', valueRule: 'entered', isApplicable: true, isRequired: false });
    await createRule(db, c, { subjectType: 'classification', subjectId: v.part.id, specificationId: s.id, captureAt: 'item', valueRule: 'entered', isApplicable: true, isRequired: true });
  }

  const op = await OPS.createOperation(db, c, { code: `${tag}-OP`, name: `Make ${tag}` });
  const flow = await FLOWS.createFlow(db, c, { code: `${tag}-FL`, name: `Make ${tag}` });
  await FLOWS.addStep(db, c, flow.id, { operationId: op.id });
  await FLOWS.setFlowStatus(db, c, flow.id, 'active');

  const MAT = await MR.createItem(db, c, { itemType: 'catalog', classificationId: v.mat.id, code: `${tag}-MAT`, name: `Cleat stock ${tag}`, shortName: 'MAT', uom: 'kg', status: 'active' });
  const plate = async (code, t, l, w) => {
    const it = await MR.createItem(db, c, { itemType: 'catalog', classificationId: v.plate.id, code: `${tag}-${code}`, name: `Plate ${code} ${tag}`, uom: 'nos' });
    await V.setValues(db, c, 'master', it.id, [
      { specCode: 'THICKNESS', value: t }, { specCode: 'LENGTH', value: l }, { specCode: 'WIDTH', value: w }, { specCode: 'GRADE', value: 'E350' },
    ]);
    return MR.setStatus(db, c, it.id, 'active');
  };
  const PL1 = await plate('PL1', 12, 6000, 2000);
  const PL2 = await plate('PL2', 12, 8000, 2500);
  // The one active selection searching PLATE — PL1 its default, PL2 allowed.
  let sel = await MR.createDefinition(db, c, {
    definitionType: 'selection', classificationId: v.plate.id, code: `${tag}-SEL`, name: `Plate selection ${tag}`,
    selectionMode: 'allowed_list', candidateClassificationId: v.plate.id,
  });
  await SEL.addAllowedItem(db, c, sel.id, { itemId: PL1.id });
  await SEL.addAllowedItem(db, c, sel.id, { itemId: PL2.id });
  sel = await MR.setStatus(db, c, sel.id, 'active');
  const [[allowed]] = await db.query('SELECT id FROM cf_definition_allowed_items WHERE company_id = ? AND definition_id = ? AND item_id = ? AND deleted_at IS NULL', [COMPANY, sel.id, PL1.id]);
  await SEL.setDefaultAllowed(db, c, allowed.id);

  const tpl = async (code, name, shortName, classificationId) => {
    const d = await MR.createDefinition(db, c, { definitionType: 'template', classificationId, code: `${tag}-${code}`, name: `${name} ${tag}`, shortName, status: 'active' });
    await MR.updateRecord(db, c, d.id, { defaultFlowId: flow.id });
    return d;
  };
  const WB = await tpl('WB', 'Web', 'WB', v.part.id);
  const IS = await tpl('IS', 'Stiffener', 'IS', v.part.id);
  const CL = await tpl('CL', 'Cleat', 'CL', v.cleat.id);
  const SG = await tpl('SG', 'Segment', 'SG', v.seg.id);
  const GR = await tpl('GR', 'Girder', 'GR', v.assy.id);
  const GRX = await tpl('GRX', 'Long girder', 'GRX', v.assy.id);
  await B.addLine(db, c, CL.id, { childId: MAT.id, quantity: 0.5 });
  await B.setBomStatus(db, c, CL.id, 'active');
  await B.addLine(db, c, SG.id, { childId: WB.id, quantity: 1, role: 'Web' });
  await B.addLine(db, c, SG.id, { childId: IS.id, quantity: 3, role: 'Stiffener — plain' });
  await B.addLine(db, c, SG.id, { childId: IS.id, quantity: 1, role: 'Stiffener — drilled' });
  await B.addLine(db, c, SG.id, { childId: CL.id, quantity: 6, role: 'Cleats' });
  await B.setBomStatus(db, c, SG.id, 'active');
  await B.addLine(db, c, GR.id, { childId: SG.id, quantity: 2, role: 'Segments' });
  await B.setBomStatus(db, c, GR.id, 'active');
  // Three segment ROWS rather than one row of three: more rows, the same depth.
  for (let i = 0; i < 3; i++) await B.addLine(db, c, GRX.id, { childId: SG.id, quantity: 1, role: `Segment ${i + 1}` });
  await B.setBomStatus(db, c, GRX.id, 'active');

  const temporary = { tokenKey: 'kind', operator: 'eq', value: 'temporary' };
  const underFam = { tokenKey: 'classification', operator: 'under', value: String(fam.id) };
  const pieceRule = (code, body) => codegen.createScheme(db, COMPANY, c.userId, {
    code: `${tag}-${code}`, name: `Revision test ${code} ${tag}`, entityType: 'production_piece', targetField: 'code', seqScope: 'prefix', priority: 0, status: 'active', ...body,
  });
  const rules = {
    top: await pieceRule('PTOP', { conditions: [temporary, { tokenKey: 'placement', operator: 'eq', value: 'line' }, underFam], segments: [tok('order.code'), lit('-'), tok('item.shortName'), lit('-'), tok('line.position', { format: '00' }), lit('-'), tok('piece.seq')] }),
    part: await pieceRule('PPART', { conditions: [{ tokenKey: 'placement', operator: 'eq', value: 'component' }, underFam], segments: [tok('parent.code'), lit('-'), tok('item.shortName'), tok('piece.seq')] }),
    // The KEPL tenant's blank rule: order, line, short name, the rectangle.
    blank: await codegen.createScheme(db, COMPANY, c.userId, {
      code: `${tag}-BLANK`, name: `Revision test blank ${tag}`, entityType: 'item', targetField: 'code', seqScope: 'prefix', priority: 0, status: 'active',
      conditions: [temporary, { tokenKey: 'classification', operator: 'eq', value: String(v.cut.id) }],
      segments: [tok('order.code'), lit('-'), tok('line.no'), lit('-'), tok('record.shortName'), lit('-'), tok('spec:THICKNESS'), lit('X'), tok('spec:WIDTH'), lit('X'), tok('spec:LENGTH'), lit('-'), tok('spec:GRADE')],
    }),
  };
  const cust = await PARTIES.createParty(db, c, { code: `${tag}-CUST`, name: `Revision test customer ${tag}`, roles: ['customer'] });
  const area = await AREAS.createArea(db, c, { code: `${tag}-DSP`, name: `Dispatch ${tag}`, purpose: 'dispatch' });
  return { fam, v, S, op, flow, MAT, PL1, PL2, sel, WB, IS, CL, SG, GR, GRX, rules, cust, area };
}

/* --------------------------------------------------------------------------
 * Helpers over the fixture
 * ----------------------------------------------------------------------- */
async function newOrder(db, c, f, letter, records) {
  const code = `${tag}-${letter}`;
  const order = await SO.createOrder(db, c, { orderType: 'customer', customerId: f.cust.id, code, title: `Revision fixture ${letter} ${tag}`, committedDate: '2026-12-31' });
  let o = order;
  for (const r of records) o = await SO.addOrderLine(db, c, order.id, typeof r === 'object' ? r : { recordId: r, quantity: 1 });
  return { order: o, lines: o.lines, code };
}

/** A line's plate parts with the role their row plays. */
async function partsOf(db, f, lineId) {
  const [rows] = await db.query(
    `SELECT m.id, m.name, l.role FROM cf_master_records m
       JOIN cf_item_details i ON i.master_id = m.id AND i.deleted_at IS NULL
       JOIN cf_bom_lines l ON l.child_id = m.id AND l.deleted_at IS NULL
      WHERE i.company_id = ? AND i.owner_order_line_id = ? AND m.classification_id = ? AND m.deleted_at IS NULL
      ORDER BY m.id`,
    [COMPANY, lineId, f.v.part.id],
  );
  return rows;
}

/** Every plate part given its size through the Values stage's own write, then its cut pieces made — as the route does. */
async function fillAndCut(db, c, f, lineId) {
  const writes = [];
  for (const p of await partsOf(db, f, lineId)) {
    for (const [specCode, value] of Object.entries(SIZES[ROLE_SIZE[p.role]])) writes.push({ recordId: p.id, specCode, value });
  }
  await OV.writeLineValues(db, c, lineId, { writes });
  return CUT.refreshCutPieces(db, c, lineId);
}

/** A line's cut plates: code, name, flow, and the plate line (plate and quantity). */
async function cutPlatesOf(db, f, lineId) {
  const [rows] = await db.query(
    `SELECT m.id, m.code, m.name, m.status, m.default_flow_id AS flow,
            (SELECT pl.id FROM cf_boms b JOIN cf_bom_lines pl ON pl.bom_id = b.id AND pl.deleted_at IS NULL
              WHERE b.parent_id = m.id AND b.deleted_at IS NULL ORDER BY pl.id LIMIT 1) AS plate_line,
            (SELECT pl.child_id FROM cf_boms b JOIN cf_bom_lines pl ON pl.bom_id = b.id AND pl.deleted_at IS NULL
              WHERE b.parent_id = m.id AND b.deleted_at IS NULL ORDER BY pl.id LIMIT 1) AS plate,
            (SELECT pl.quantity FROM cf_boms b JOIN cf_bom_lines pl ON pl.bom_id = b.id AND pl.deleted_at IS NULL
              WHERE b.parent_id = m.id AND b.deleted_at IS NULL ORDER BY pl.id LIMIT 1) AS plate_qty
       FROM cf_master_records m JOIN cf_item_details i ON i.master_id = m.id AND i.deleted_at IS NULL
      WHERE i.company_id = ? AND i.owner_order_line_id = ? AND m.classification_id = ? AND m.deleted_at IS NULL
      ORDER BY m.name`,
    [COMPANY, lineId, f.v.cut.id],
  );
  return rows.map((r) => ({ ...r, plate_qty: r.plate_qty == null ? null : Number(r.plate_qty) }));
}

const livePieces = async (db, lineId) => (await db.query(
  `SELECT id, parent_id, item_id, piece_no, piece_seq, quantity, code, depth, sort_order
     FROM cf_order_pieces WHERE company_id = ? AND order_line_id = ? AND deleted_at IS NULL ORDER BY sort_order`,
  [COMPANY, lineId],
))[0];
/** A line's pieces in a shape that does not depend on ids: code, place, numbers. */
const pieceShape = (pieces) => {
  const k = new Map(pieces.map((p, i) => [p.id, i]));
  return pieces.map((p) => [p.code, p.parent_id == null ? null : k.get(p.parent_id), p.depth, p.piece_no, p.piece_seq, Number(p.quantity)]);
};
const orderRow = async (db, id) => (await db.query('SELECT id, code, status, revision, revision_of_id, revised_at, status_before_revised, deleted_at FROM cf_sales_orders WHERE id = ?', [id]))[0][0];

/**
 * A line's whole structure, cut plates included, in a shape that does not depend
 * on ids or codes: where each node sits (line numbers and positions down from
 * the top), what it is (a catalog item by id, a row by name), its quantity,
 * role, selection and flow. Two revisions of an unchanged line give the same.
 */
async function shapeOf(db, lineId) {
  const [[l]] = await db.query('SELECT item_id, quantity FROM cf_sales_order_lines WHERE id = ?', [lineId]);
  const tree = await B.explode(db, COMPANY, l.item_id, { rootQuantity: Number(l.quantity) });
  const rows = [];
  const walk = (n, at) => {
    const here = n.depth === 0 ? 'L' : `${at}/${n.lineNo}.${n.position}`;
    rows.push({
      path: here, id: n.id, kind: n.kind, status: n.status, code: n.code,
      sig: [here, n.kind, n.kind === 'temporary' ? n.name : n.id, n.quantity, n.role ?? '', n.selection?.id ?? '', n.resolved, n.flow?.id ?? ''].join('|'),
    });
    for (const k of n.children) walk(k, here);
  };
  walk(tree.root, '');
  return rows;
}
/** The values each row of a structure holds, by where it sits. */
async function valuesOf(db, rows) {
  const temp = rows.filter((r) => r.kind === 'temporary');
  const [vals] = await db.query(
    `SELECT v.subject_id, s.code, v.value_number, v.value_text, v.value_bool, v.option_id, v.uom, v.source
       FROM cf_spec_values v JOIN cf_specifications s ON s.id = v.specification_id
      WHERE v.company_id = ? AND v.subject_type = 'master' AND v.subject_id IN (?) AND v.deleted_at IS NULL`,
    [COMPANY, [...new Set(temp.map((r) => r.id))]],
  );
  const by = new Map();
  for (const v of vals) {
    if (!by.has(v.subject_id)) by.set(v.subject_id, {});
    by.get(v.subject_id)[v.code] = [v.value_number == null ? null : Number(v.value_number), v.value_text, v.value_bool, v.option_id, v.uom, v.source].join('|');
  }
  return temp.map((r) => [r.path, Object.entries(by.get(r.id) ?? {}).sort()]);
}

/* --------------------------------------------------------------------------
 * The run
 * ----------------------------------------------------------------------- */
console.log(`revision_test — company ${COMPANY}, fixture tag ${tag}`);

section('0. The harness refuses a swapped ok(), and the routes are mounted');
ok('ok(cond, label) throws instead of passing', (await refusal(() => ok(true, 'swapped'))) instanceof Error);
ok('ok(label, truthy object) throws too', (await refusal(() => ok('object', {}))) instanceof Error);
const routeOf = (method, p) => orderRouter.stack.find((l) => l.route?.path === p && l.route.methods[method])?.route ?? null;
const reviseRoute = routeOf('post', '/orders/:id/revise');
const discardRoute = routeOf('delete', '/orders/:id/revision');
ok('POST /orders/:id/revise is a route', !!reviseRoute);
ok('DELETE /orders/:id/revision is a route', !!discardRoute);
same('each behind protect, a permission check and the handler', [reviseRoute?.stack?.length, reviseRoute?.stack?.[0]?.name, discardRoute?.stack?.length, discardRoute?.stack?.[0]?.name], [3, 'protect', 3, 'protect']);
ok('and the order routes are mounted in the app\'s router', indexRouter.stack.some((l) => l.handle === orderRouter));

const TABLES = await cfTables(pool);
const before = await census(pool, TABLES);
const conn = await pool.getConnection();
try {
  await conn.beginTransaction();
  attachNodeCache(conn);
  const c = { companyId: COMPANY, userId: null };

  const [rivals] = await conn.query(
    `SELECT id FROM cf_code_schemes WHERE company_id = ? AND entity_type IN ('item', 'production_piece') AND status = 'active' AND deleted_at IS NULL`,
    [COMPANY],
  );
  if (rivals.length) await conn.query("UPDATE cf_code_schemes SET status = 'inactive' WHERE company_id = ? AND id IN (?)", [COMPANY, rivals.map((r) => r.id)]);
  const f = await buildFixture(conn, c);

  /* ---- 1. rev 1: built, valued, cut, one plate chosen by hand, locked ---- */
  section('1. Rev 1: two girder lines locked, a segment line left open, a catalog line');
  const navBefore = (await OVS.navCounts(conn, COMPANY)).counts.openOrders;
  const cockpitInquiries = async () => (await OVS.cockpit(conn, COMPANY)).queues.find((q) => q.key === 'inquiries')?.count ?? 0;
  const inquiriesBefore = await cockpitInquiries();
  const A = await newOrder(conn, c, f, 'A', [f.GR.id, f.GR.id, { recordId: f.MAT.id, quantity: 5 }, f.SG.id]);
  const [a10, a20, a30, a40] = A.lines;
  same('four lines: two girders, the catalog material, a segment', A.lines.map((l) => [l.lineNo, l.lineType]), [[10, 'custom'], [20, 'custom'], [30, 'standard'], [40, 'custom']]);
  for (const l of [a10, a20, a40]) {
    const r = await fillAndCut(conn, c, f, l.id);
    ok(`line ${l.lineNo}: its values filled, its cut pieces made automatically`, r.made === true && r.summary.cutPieces === 3, r.message);
  }
  // A person chooses the bigger plate for line 10's web rectangle.
  const a10Plates = await cutPlatesOf(conn, f, a10.id);
  const webPlate = a10Plates.find((p) => p.name.includes('500'));
  await B.resolveLine(conn, c, webPlate.plate_line, { itemId: f.PL2.id });
  await CUT.refreshCutPieces(conn, c, a10.id);
  const a10After = await cutPlatesOf(conn, f, a10.id);
  same('line 10\'s web is cut from PL2 now, the rest from the default PL1', a10After.map((p) => [p.name.includes('500') ? 'web' : 'other', p.plate]),
    a10After.map((p) => [p.name.includes('500') ? 'web' : 'other', p.name.includes('500') ? f.PL2.id : f.PL1.id]));
  ok('a cut plate code is the tenant\'s own shape: order, line, the rectangle', a10After.some((p) => p.code === `${A.code}-10-CUTPL-12X500X2000-E350`), a10After.map((p) => p.code).join(', '));
  // A chart is a specification value too: revisions must preserve it and its audit history.
  const chartSpec = await SPEC.createSpec(conn, c, { code: `${tag}_CHART`, name: `${tag} chart`, dataType: 'table',
    tableConfig: { axes: [{ label: 'Thickness', unit: 'mm' }, { label: 'Diameter', unit: 'mm' }], mode: 'step_up' } });
  await createRule(conn, c, { specificationId: chartSpec.id, subjectType: 'master', subjectId: a10.item.id,
    captureAt: 'item', valueRule: 'entered' });
  const chartValue = { x: [10, 20], y: [21, 25], v: [[50, 80], [null, null]] };
  await V.setValues(conn, c, 'master', a10.item.id, [{ specificationId: chartSpec.id, value: chartValue }]);
  await LOCK.lockLine(conn, c, a10.id);
  await LOCK.lockLine(conn, c, a20.id);
  const a1Pieces = { 10: await livePieces(conn, a10.id), 20: await livePieces(conn, a20.id) };
  same('both girder lines locked: 25 pieces each, positions 01 and 02', [a1Pieces[10].length, a1Pieces[20].length, a1Pieces[10][0].code, a1Pieces[20][0].code],
    [25, 25, `${A.code}-GR-01-1`, `${A.code}-GR-02-1`]);
  const shapes1 = { 10: await shapeOf(conn, a10.id), 20: await shapeOf(conn, a20.id), 40: await shapeOf(conn, a40.id) };
  const values1 = { 10: await valuesOf(conn, shapes1[10]), 20: await valuesOf(conn, shapes1[20]), 40: await valuesOf(conn, shapes1[40]) };

  // The drawing line 10 is built to: rev A covers its segment row and its web
  // row, then rev B supersedes it and carries the links forward (drawingService
  // copies links, never moves them) — so each row holds a link to both revisions.
  const rowAt = (shapes, p) => shapes.find((r) => r.path === p);
  const segA = rowAt(shapes1[10], 'L/10.1');
  const webA = rowAt(shapes1[10], 'L/10.1/10.1');
  const dwgA = await DWG.createDrawing(conn, c, { number: `${tag}-GA-01`, code: `${tag}-DWG`, title: `Girder general arrangement ${tag}`, source: 'customer' });
  await DWG.linkDrawing(conn, c, dwgA.id, { subjectId: segA.id, note: 'sheet 1 of 2' });
  await DWG.linkDrawing(conn, c, dwgA.id, { subjectId: webA.id, note: 'sheet 2 of 2' });
  const dwgB = await DWG.reviseDrawing(conn, c, dwgA.id, {});
  const linksOn = async (ids) => (await conn.query(
    'SELECT id, drawing_id, subject_id, note, deleted_at FROM cf_drawing_links WHERE company_id = ? AND subject_type = \'master_record\' AND subject_id IN (?) ORDER BY subject_id, drawing_id, id',
    [COMPANY, ids],
  ))[0];
  const drawingsNow = async () => (await conn.query('SELECT id, revision, status, supersedes_id FROM cf_drawings WHERE company_id = ? AND deleted_at IS NULL ORDER BY id', [COMPANY]))[0];
  const rev1Links = await linksOn([segA.id, webA.id]);
  same('line 10\'s segment and web rows each carry a live link to both revisions of the drawing',
    rev1Links.map((l) => [l.subject_id === segA.id ? 'segment' : 'web', l.drawing_id === dwgA.id ? 'A' : l.drawing_id === dwgB.id ? 'B' : '?', l.note, l.deleted_at]),
    [['segment', 'A', 'sheet 1 of 2', null], ['segment', 'B', 'sheet 1 of 2', null], ['web', 'A', 'sheet 2 of 2', null], ['web', 'B', 'sheet 2 of 2', null]]);
  const drawings1 = await drawingsNow();

  /* ---- 2. revise --------------------------------------------------------------- */
  section('2. Revise: rev 2 is a copy of rev 1, every line unlocked');
  const trips = counting(conn);
  const A2 = await REV.reviseOrder(trips.db, c, A.order.id);
  console.log(`        round trips: reviseOrder ${trips.tally.n} (4 lines: 3 built from templates, 1 catalog)`);
  same('the same number, rev 2, pointing at rev 1', [A2.code, A2.revision, A2.revisionOfId, A2.status], [A.code, 2, A.order.id, 'inquiry']);
  same('every revision of the order, oldest first', A2.revisions.map((r) => [r.id, r.revision, r.status, !!r.revisedAt]), [[A.order.id, 1, 'revised', true], [A2.id, 2, 'inquiry', false]]);
  const [b10, b20, b30, b40] = A2.lines;
  same('every live line copied: its number, kind, what it sells, quantity, each pointing at its old line',
    A2.lines.map((l) => [l.lineNo, l.lineType, l.design.id, l.quantity, l.revisesLineId]),
    A.lines.map((l) => [l.lineNo, l.lineType, l.design.id, l.quantity, l.id]));
  ok('and none of them locked', A2.lines.every((l) => l.lock == null));
  eq('the catalog line sells the same catalog item', b30.item.id, a30.item.id);
  ok('each custom line sells a new row of its own', [b10, b20, b40].every((l, i) => l.item.id !== [a10, a20, a40][i].item.id));
  same('cut pieces made again for each custom line — 3 rectangles each', A2.cutPieces.map((x) => [x.lineNo, x.made, x.reason]), [[10, true, 'made'], [20, true, 'made'], [40, true, 'made']]);
  says(A2.cutPieces[0].message);

  const shapes2 = { 10: await shapeOf(conn, b10.id), 20: await shapeOf(conn, b20.id), 40: await shapeOf(conn, b40.id) };
  const jsonValue = (v) => typeof v === 'string' ? JSON.parse(v) : v;
  const chartShape = (v) => { const t = jsonValue(v); return t == null ? null : [t.x, t.y, t.v]; };
  const [[copiedChart]] = await conn.query(
    "SELECT value_json FROM cf_spec_values WHERE company_id = ? AND subject_type = 'master' AND subject_id = ? AND specification_id = ? AND deleted_at IS NULL",
    [COMPANY, b10.item.id, chartSpec.id]);
  same('revision preserves both axes and blank cells of a table value', chartShape(copiedChart?.value_json), chartShape(chartValue));
  const [[chartHistory]] = await conn.query(
    "SELECT new_value FROM cf_spec_value_history WHERE company_id = ? AND subject_type = 'master' AND subject_id = ? AND specification_id = ? AND change_type = 'create'",
    [COMPANY, b10.item.id, chartSpec.id]);
  same('the copied chart has its complete value in history', chartShape(jsonValue(chartHistory?.new_value)?.json), chartShape(chartValue));
  for (const n of [10, 20, 40]) {
    same(`line ${n}: the structure is identical, cut pieces included (${shapes2[n].length} nodes)`, shapes2[n].map((r) => r.sig), shapes1[n].map((r) => r.sig));
    same(`line ${n}: every row holds exactly the values it held`, await valuesOf(conn, shapes2[n]), values1[n]);
  }
  const rev2Rows = shapes2[10].filter((r) => r.kind === 'temporary' && !r.sig.includes('Cut plate'));
  ok('its rows are drafts again, with no code — lock activates them', rev2Rows.every((r) => r.status === 'draft' && r.code == null), JSON.stringify(rev2Rows.slice(0, 2)));
  const [[hist]] = await conn.query(
    `SELECT COUNT(*) AS vals, (SELECT COUNT(*) FROM cf_spec_value_history h WHERE h.company_id = ? AND h.subject_type = 'master' AND h.change_type = 'create' AND h.subject_id IN (?)) AS hist
       FROM cf_spec_values v WHERE v.company_id = ? AND v.subject_type = 'master' AND v.subject_id IN (?) AND v.deleted_at IS NULL`,
    [COMPANY, rev2Rows.map((r) => r.id), COMPANY, rev2Rows.map((r) => r.id)],
  );
  ok('every copied value has its history row', Number(hist.vals) > 0 && Number(hist.vals) === Number(hist.hist), JSON.stringify(hist));

  const b10Plates = await cutPlatesOf(conn, f, b10.id);
  ok('the cut plates are the line\'s own, new ones', b10Plates.every((p) => !a10After.some((o) => o.id === p.id)) && b10Plates.length === 3);
  same('each carries rev 2 in its code — rev 1 keeps the plain one, and a code is unique among live records',
    b10Plates.map((p) => p.code), a10After.map((p) => `${p.code}-R2`));
  same('each rectangle is cut from the plate rev 1 cut it from — the hand-picked PL2 included', b10Plates.map((p) => p.plate), a10After.map((p) => p.plate));
  same('at the area fraction of that plate', b10Plates.map((p) => p.plate_qty), a10After.map((p) => p.plate_qty));

  const segB = rowAt(shapes2[10], 'L/10.1');
  const webB = rowAt(shapes2[10], 'L/10.1/10.1');
  const rev2Links = await linksOn([segB.id, webB.id]);
  same('rev 2\'s copies of those rows carry the same links: the same drawing revisions, the same notes',
    rev2Links.map((l) => [l.subject_id === segB.id ? 'segment' : 'web', l.drawing_id === dwgA.id ? 'A' : l.drawing_id === dwgB.id ? 'B' : '?', l.note, l.deleted_at]),
    rev1Links.map((l) => [l.subject_id === segA.id ? 'segment' : 'web', l.drawing_id === dwgA.id ? 'A' : 'B', l.note, null]));
  ok('as new links of their own', rev2Links.every((l) => !rev1Links.some((o) => o.id === l.id)));
  same('rev 1\'s links are untouched — the same rows, drawings, notes, all live', await linksOn([segA.id, webA.id]), rev1Links);
  same('and the drawings themselves are untouched — no new drawing, no revision moved', await drawingsNow(), drawings1);
  const forRow = await DWG.drawingsForRecord(conn, COMPANY, segB.id);
  same('the copied segment is covered by the drawing\'s issued revision, as the original is', forRow.rows.map((r) => [r.drawing.id, r.note]), [[dwgB.id, 'sheet 1 of 2']]);
  const coverage = await DWG.drawingCoverage(conn, COMPANY, dwgB.id);
  same('and the drawing lists both revisions of the order as what it covers', coverage.map((r) => [r.subject.id, r.note]).sort(),
    [[segA.id, 'sheet 1 of 2'], [webA.id, 'sheet 2 of 2'], [segB.id, 'sheet 1 of 2'], [webB.id, 'sheet 2 of 2']].sort());

  const a1 = await orderRow(conn, A.order.id);
  same('rev 1 is revised: when, and the status it had', [a1.status, !!a1.revised_at, a1.status_before_revised], ['revised', true, 'inquiry']);
  same('its lines stay locked, and its pieces live — until rev 2 locks', [(await livePieces(conn, a10.id)).length, (await livePieces(conn, a20.id)).length], [25, 25]);

  /* ---- 3. rev 1 is kept as it was ------------------------------------------------ */
  section('3. Rev 1 is read-only: every kind of write refused, naming the revision');
  const REV1 = new RegExp(`^${esc(A.code)} rev 1 was revised — it is kept as it was; change rev 2 instead\\.$`);
  const refusedRev1 = (label, err, status = null) => ok(label, !!err && REV1.test(err.message ?? '') && (status == null || err.status === status), err ? `${err.status} ${err.code}: ${err.message}` : 'it was accepted');
  const hasRev1 = (label, err) => ok(label, !!err && (err.problems ?? []).some((p) => REV1.test(p)), err ? `${err.code}: ${(err.problems ?? [err.message]).join(' | ')}` : 'it was accepted');
  const a40Seg = (await conn.query('SELECT m.id FROM cf_master_records m JOIN cf_item_details i ON i.master_id = m.id WHERE i.owner_order_line_id = ? AND m.classification_id = ? AND m.deleted_at IS NULL LIMIT 1', [a40.id, f.v.seg.id]))[0][0].id;
  const [[a40SegLine]] = await conn.query('SELECT l.id FROM cf_bom_lines l JOIN cf_boms b ON b.id = l.bom_id WHERE b.parent_id = ? AND l.deleted_at IS NULL ORDER BY l.line_no LIMIT 1', [a40Seg]);
  const a40Part = (await partsOf(conn, f, a40.id))[0].id;
  refusedRev1('the header', await refusal(() => SO.updateOrder(conn, c, A.order.id, { title: 'Renamed' })), 422);
  says((await refusal(() => SO.updateOrder(conn, c, A.order.id, { title: 'Renamed' }))).message);
  refusedRev1('its status', await refusal(() => SO.setOrderStatus(conn, c, A.order.id, 'quoted')), 422);
  refusedRev1('a new line', await refusal(() => SO.addOrderLine(conn, c, A.order.id, { recordId: f.GR.id, quantity: 1 })), 422);
  refusedRev1('a line\'s wording', await refusal(() => SO.updateOrderLine(conn, c, a10.id, { description: 'Span 1' })), 422);
  refusedRev1('removing its open line', await refusal(() => SO.removeOrderLine(conn, c, a40.id)), 422);
  refusedRev1('deleting it', await refusal(() => SO.deleteOrder(conn, c, A.order.id)), 409);
  refusedRev1('a row added to its open line\'s structure', await refusal(() => B.addLine(conn, c, a40Seg, { childId: f.MAT.id, quantity: 1 })), 422);
  refusedRev1('a row\'s quantity', await refusal(() => B.updateLine(conn, c, a40SegLine.id, { quantity: 2 })), 422);
  refusedRev1('a batch of structure edits (edit mode), as its 409', await refusal(() => BC.applyBomChanges(conn, c, { scope: { orderLineId: a40.id }, changes: [{ op: 'quantity', lineId: a40SegLine.id, quantity: 2 }] })), 409);
  refusedRev1('a value on the Values stage, as its 409', await refusal(() => OV.writeLineValues(conn, c, a40.id, { writes: [{ recordId: a40Part, specCode: 'THICKNESS', value: 14 }] })), 409);
  refusedRev1('a value set on the record itself', await refusal(() => V.setValues(conn, c, 'master', a40Part, [{ specCode: 'THICKNESS', value: 14 }])), 422);
  refusedRev1('a row\'s own details', await refusal(() => MR.updateRecord(conn, c, a40Part, { name: 'Renamed' })), 422);
  refusedRev1('working its cut pieces out again', await refusal(() => CUT.deriveCutPlates(conn, c, a40.id, {})), 422);
  const auto = await CUT.refreshCutPieces(conn, c, a40.id);
  ok('and the automatic cut pieces say so, without failing', auto.made === false && auto.reason === 'closed' && REV1.test(auto.message), JSON.stringify(auto));
  hasRev1('locking its open line', await refusal(() => LOCK.lockLine(conn, c, a40.id)));
  ok('the Lock stage says it in the same words', REV1.test((await LOCK.lockPlan(conn, COMPANY, a40.id)).checks[0]?.detail ?? ''));
  refusedRev1('nesting a line', await refusal(() => NEST.acceptNesting(conn, c, a10.id, {})), 422);
  hasRev1('releasing a line', await refusal(() => REL.releaseLine(conn, c, a10.id, { finishedAreaId: f.area.id })));
  hasRev1('issuing stock to it', await refusal(() => STOCK.postMovement(conn, c, { movementType: 'issue', orderId: A.order.id, lines: [] })));
  refusedRev1('shipping against it', await refusal(() => SHIP.shipLine(conn, c, a30.id, {})), 422);
  const valuesView = await OV.readLineValues(conn, COMPANY, a40.id);
  same('the Values stage reads it as frozen, in the same words', [valuesView.lock?.reason, REV1.test(valuesView.lock?.message ?? ''), valuesView.editable], ['closed', true, false]);
  eq('its Structure tab is read-only', (await SO.lineStructure(conn, COMPANY, a40.id)).order.editable, false);
  const a1View = await SO.getOrder(conn, COMPANY, A.order.id);
  same('getOrder says revised, when, what it was, and offers no move', [a1View.status, !!a1View.revisedAt, a1View.statusBeforeRevised, a1View.allowedTransitions], ['revised', true, 'inquiry', []]);
  same('and lists the same revisions', a1View.revisions.map((r) => r.id), [A.order.id, A2.id]);
  refusedRev1('revising it again — only the latest is revised', await refusal(() => REV.reviseOrder(conn, c, A.order.id)), 422);
  const notLatest = await refusal(() => REV.discardRevision(conn, c, A.order.id));
  ok('and discarding it is refused: only the latest revision is discarded', notLatest?.code === 'NOT_LATEST' && /Only the latest revision, rev 2, can be discarded\.$/.test(notLatest?.message ?? ''), notLatest?.message);

  /* ---- 4. lists ------------------------------------------------------------------ */
  section('4. Lists show the latest revision only');
  const listed = await SO.listOrders(conn, COMPANY, {});
  same('the orders list: rev 2, not rev 1', [listed.some((o) => o.id === A2.id), listed.some((o) => o.id === A.order.id)], [true, false]);
  same('with its revision on the row', [listed.find((o) => o.id === A2.id)?.revision, listed.find((o) => o.id === A2.id)?.revisionOfId], [2, A.order.id]);
  const all = await SO.listOrders(conn, COMPANY, { revisions: 'all' });
  same('revisions=all lists both', [all.some((o) => o.id === A2.id), all.some((o) => o.id === A.order.id)], [true, true]);
  ok('status=revised finds the earlier one', (await SO.listOrders(conn, COMPANY, { status: 'revised' })).some((o) => o.id === A.order.id));
  const found = (await OVS.search(conn, COMPANY, A.code)).results.filter((r) => r.type === 'order');
  same('the ⌘K search finds rev 2 only, and says which revision', found.map((r) => [r.id, r.revision]), [[A2.id, 2]]);
  eq('the nav count of open orders counts the order once', (await OVS.navCounts(conn, COMPANY)).counts.openOrders, navBefore + 1);
  eq('so does Home\'s inquiries queue', await cockpitInquiries(), inquiriesBefore + 1);
  const ph10 = await PH.linePlaceholders(conn, COMPANY, b10.id);
  const ph20 = await PH.linePlaceholders(conn, COMPANY, b20.id);
  same('rev 2\'s lines take the positions rev 1 locked them at', [ph10.position, ph20.position, ph10.rows[0]?.code, ph20.rows[0]?.code], [1, 2, `${A.code}-GR-01-1`, `${A.code}-GR-02-1`]);

  /* ---- 5. lock in rev 2 ---------------------------------------------------------- */
  section('5. Locking rev 2 retires rev 1\'s pieces, and the codes come back identical');
  const plan10 = await LOCK.lockPlan(conn, COMPANY, b10.id, { nodes: true });
  ok('rev 2\'s line can be locked — rev 1\'s live pieces are not "taken"', plan10.canLock === true && plan10.taken.length === 0, plan10.problems.join(' | '));
  same('and would get exactly rev 1\'s codes', plan10.nodes.map((n) => n.code), a1Pieces[10].map((p) => p.code));
  await LOCK.lockLine(conn, c, b10.id);
  same('every live piece of rev 1 is retired — both of its locked lines', [(await livePieces(conn, a10.id)).length, (await livePieces(conn, a20.id)).length], [0, 0]);
  same('line 10 locked to identical codes, piece for piece — place, numbers, quantities', pieceShape(await livePieces(conn, b10.id)), pieceShape(a1Pieces[10]));
  await LOCK.lockLine(conn, c, b20.id);
  same('line 20 too', pieceShape(await livePieces(conn, b20.id)), pieceShape(a1Pieces[20]));
  await LOCK.lockLine(conn, c, b40.id);
  eq('the line rev 1 never locked locks now, at its own position', (await livePieces(conn, b40.id))[0].code, `${A.code}-SG-01-1`);
  const [[retired]] = await conn.query('SELECT COUNT(*) AS n FROM cf_order_pieces WHERE company_id = ? AND order_line_id IN (?) AND deleted_at IS NOT NULL', [COMPANY, [a10.id, a20.id]]);
  eq('rev 1\'s 50 pieces are still there, retired — its history', Number(retired.n), 50);
  const lockedDiscard = await refusal(() => REV.discardRevision(conn, c, A2.id));
  ok('a revision with a locked line is not discarded', lockedDiscard?.code === 'LOCKED' && /locked — their pieces carry their codes, so the revision stays/.test(lockedDiscard?.message ?? ''), lockedDiscard?.message);
  says(lockedDiscard?.message);

  /* ---- 6. rev 3 ------------------------------------------------------------------- */
  section('6. A third revision: the words name the latest, and the codes come back again');
  const A3 = await REV.reviseOrder(conn, c, A2.id);
  same('rev 3 of the same number, pointing at rev 2', [A3.code, A3.revision, A3.revisionOfId], [A.code, 3, A2.id]);
  const REV1to3 = new RegExp(`^${esc(A.code)} rev 1 was revised — it is kept as it was; change rev 3 instead\\.$`);
  ok('rev 1 now points at rev 3', REV1to3.test((await refusal(() => SO.updateOrder(conn, c, A.order.id, { title: 'x' })))?.message ?? ''));
  ok('and so does rev 2', new RegExp(`^${esc(A.code)} rev 2 was revised — it is kept as it was; change rev 3 instead\\.$`).test((await refusal(() => SO.updateOrder(conn, c, A2.id, { title: 'x' })))?.message ?? ''));
  const c3Plates = await cutPlatesOf(conn, f, A3.lines[0].id);
  ok('rev 3\'s cut plates carry rev 3', c3Plates.length === 3 && c3Plates.every((p) => p.code.endsWith('-R3')), c3Plates.map((p) => p.code).join(', '));
  await LOCK.lockLine(conn, c, A3.lines[0].id);
  same('locking rev 3 retires rev 2\'s pieces, and line 10 has rev 1\'s codes once more', [(await livePieces(conn, b10.id)).length, (await livePieces(conn, b20.id)).length, JSON.stringify(pieceShape(await livePieces(conn, A3.lines[0].id))) === JSON.stringify(pieceShape(a1Pieces[10]))], [0, 0, true]);
  same('the lists show rev 3 alone', (await SO.listOrders(conn, COMPANY, {})).filter((o) => o.code === A.code).map((o) => o.revision), [3]);

  /* ---- 7. drop a line -------------------------------------------------------------- */
  section('7. A revision that drops a line: the others keep their codes, the dropped codes are free again');
  const Bq = await newOrder(conn, c, f, 'B', [f.GR.id, f.GR.id]);
  for (const l of Bq.lines) { await fillAndCut(conn, c, f, l.id); await LOCK.lockLine(conn, c, l.id); }
  const b1Pieces = { 10: await livePieces(conn, Bq.lines[0].id), 20: await livePieces(conn, Bq.lines[1].id) };
  const B2 = await REV.reviseOrder(conn, c, Bq.order.id);
  await SO.removeOrderLine(conn, c, B2.lines[0].id);
  const kept = await LOCK.lockPlan(conn, COMPANY, B2.lines[1].id);
  same('span 1 dropped: span 2 keeps position 02 — it did not change', [kept.position?.value, kept.canLock], [2, true]);
  await LOCK.lockLine(conn, c, B2.lines[1].id);
  same('and locks to exactly its rev 1 codes', pieceShape(await livePieces(conn, B2.lines[1].id)), pieceShape(b1Pieces[20]));
  eq('the dropped line\'s rev 1 pieces are retired with the rest', (await livePieces(conn, Bq.lines[0].id)).length, 0);
  const again = (await SO.addOrderLine(conn, c, B2.id, { recordId: f.GR.id, quantity: 1, lineNo: 10 })).lines.find((l) => l.lineNo === 10);
  await fillAndCut(conn, c, f, again.id);
  const reuse = await LOCK.lockPlan(conn, COMPANY, again.id, { nodes: true });
  same('a span added back as line 10 takes position 01, and nothing calls its codes taken', [reuse.position?.value, reuse.canLock, reuse.taken.length], [1, true, 0]);
  await LOCK.lockLine(conn, c, again.id);
  same('it locks to the codes the dropped line had — they were freed for reuse', pieceShape(await livePieces(conn, again.id)).map((p) => p[0]), pieceShape(b1Pieces[10]).map((p) => p[0]));

  /* ---- 8. released --------------------------------------------------------------- */
  section('8. A released line: revising is refused until the release is taken back');
  const Cq = await newOrder(conn, c, f, 'C', [f.GR.id]);
  const cLine = Cq.lines[0];
  for (const p of await partsOf(conn, f, cLine.id)) {
    await OV.writeLineValues(conn, c, cLine.id, { writes: Object.entries(SIZES[ROLE_SIZE[p.role]]).map(([specCode, value]) => ({ recordId: p.id, specCode, value })) });
  }
  // "Make them now", with the flow they are cut by — release needs every made thing to have one.
  await CUT.deriveCutPlates(conn, c, cLine.id, { flowId: f.flow.id });
  await LOCK.lockLine(conn, c, cLine.id);
  await SO.setOrderStatus(conn, c, Cq.order.id, 'confirmed');
  const rel = await REL.releaseLine(conn, c, cLine.id, { finishedAreaId: f.area.id });
  const relErr = await refusal(() => REV.reviseOrder(conn, c, Cq.order.id));
  ok('revising is refused, in words: take the release back first', relErr?.code === 'RELEASED' && relErr.status === 422 && /Line 10 of \S+ is released to production — take the release back first/.test(relErr.message), relErr?.message);
  says(relErr?.message);
  eq('and nothing was written', (await SO.listOrders(conn, COMPANY, { revisions: 'all' })).filter((o) => o.code === Cq.code).length, 1);
  await REL.unrelease(conn, c, rel.id);
  const C2 = await REV.reviseOrder(conn, c, Cq.order.id);
  eq('taken back, it revises — and a confirmed order\'s revision is confirmed', C2.status, 'confirmed');
  const c2Plates = await cutPlatesOf(conn, f, C2.lines[0].id);
  ok('its cut plates are made by the flow rev 1\'s were — carried, not lost', c2Plates.length === 3 && c2Plates.every((p) => p.flow === f.flow.id), JSON.stringify(c2Plates.map((p) => p.flow)));
  await LOCK.lockLine(conn, c, C2.lines[0].id);
  const rel2 = await REL.releaseLine(conn, c, C2.lines[0].id, { finishedAreaId: f.area.id });
  same('so rev 2 locks and releases with the same codes', rel2.items.map((i) => i.code).slice(0, 3), [`${Cq.code}-GR-01-1`, `${Cq.code}-GR-01-1-SG1`, `${Cq.code}-GR-01-1-SG1-WB1`]);

  /* ---- 9. discard ------------------------------------------------------------------ */
  section('9. Discarding a revision gives the previous one back, as it was');
  const Dq = await newOrder(conn, c, f, 'D', [f.GR.id]);
  await fillAndCut(conn, c, f, Dq.lines[0].id);
  await LOCK.lockLine(conn, c, Dq.lines[0].id);
  const dPieces = await livePieces(conn, Dq.lines[0].id);
  // D's segment row is built to the drawing too, so its copy in rev 2 is linked.
  const dSeg1 = rowAt(await shapeOf(conn, Dq.lines[0].id), 'L/10.1');
  await DWG.linkDrawing(conn, c, dwgB.id, { subjectId: dSeg1.id, note: 'order D' });
  const d1Links = await linksOn([dSeg1.id]);
  const D2 = await REV.reviseOrder(conn, c, Dq.order.id);
  const dSeg2 = rowAt(await shapeOf(conn, D2.lines[0].id), 'L/10.1');
  same('rev 2 of order D carries the link on its copied segment', (await linksOn([dSeg2.id])).map((l) => [l.drawing_id, l.note, l.deleted_at]), [[dwgB.id, 'order D', null]]);
  await SO.updateOrder(conn, c, D2.id, { title: 'Changed in rev 2' });
  const d2Seg = (await conn.query('SELECT m.id FROM cf_master_records m JOIN cf_item_details i ON i.master_id = m.id WHERE i.owner_order_line_id = ? AND m.classification_id = ? AND m.deleted_at IS NULL LIMIT 1', [D2.lines[0].id, f.v.seg.id]))[0][0].id;
  const [[d2Line]] = await conn.query("SELECT l.id FROM cf_bom_lines l JOIN cf_boms b ON b.id = l.bom_id WHERE b.parent_id = ? AND l.role = 'Stiffener — plain' AND l.deleted_at IS NULL", [d2Seg]);
  await B.updateLine(conn, c, d2Line.id, { quantity: 4 });
  const delRev = await refusal(() => SO.deleteOrder(conn, c, D2.id));
  ok('deleting a revision is refused — discard it instead', delRev?.status === 409 && /is a revision — discard the revision instead, which gives rev 1 back as it was\.$/.test(delRev.message), delRev?.message);
  const d2Items = (await conn.query('SELECT master_id FROM cf_item_details WHERE owner_order_line_id = ? AND deleted_at IS NULL', [D2.lines[0].id]))[0].map((r) => r.master_id);
  const dTrips = counting(conn);
  const back = await REV.discardRevision(dTrips.db, c, D2.id);
  console.log(`        round trips: discardRevision ${dTrips.tally.n} (${d2Items.length} rows)`);
  same('rev 1 is the current revision again, with the status it had', [back.id, back.status, back.revisedAt, back.statusBeforeRevised, back.allowedTransitions.length > 0], [Dq.order.id, 'inquiry', null, null, true]);
  same('only rev 1 is left', back.revisions.map((r) => [r.id, r.revision]), [[Dq.order.id, 1]]);
  eq('rev 2 is gone', (await refusal(() => SO.getOrder(conn, COMPANY, D2.id)))?.status, 404);
  const [[gone]] = await conn.query('SELECT COUNT(*) AS n FROM cf_master_records WHERE id IN (?) AND deleted_at IS NULL', [d2Items]);
  eq('with every row, cut piece and value it held', Number(gone.n), 0);
  const [[vGone]] = await conn.query("SELECT COUNT(*) AS n FROM cf_spec_values WHERE company_id = ? AND subject_type = 'master' AND subject_id IN (?) AND deleted_at IS NULL", [COMPANY, d2Items]);
  const [[hDel]] = await conn.query("SELECT COUNT(*) AS n FROM cf_spec_value_history WHERE company_id = ? AND subject_type = 'master' AND subject_id IN (?) AND change_type = 'delete'", [COMPANY, d2Items]);
  ok('each value deleted with its history row', Number(vGone.n) === 0 && Number(hDel.n) > 0, `${vGone.n} live, ${hDel.n} history`);
  same('the discarded rows\' drawing links go with them — the drawing\'s coverage lists no deleted row', (await linksOn([dSeg2.id])).map((l) => !!l.deleted_at), [true]);
  same('rev 1\'s own link is untouched', await linksOn([dSeg1.id]), d1Links);
  same('and the drawings are exactly as they were', (await drawingsNow()).map((d) => [d.id, d.revision, d.status]), drawings1.map((d) => [d.id, d.revision, d.status]));
  same('rev 1 is exactly as it was: its title, its locked pieces', [back.title, (await livePieces(conn, Dq.lines[0].id)).map((p) => p.code)], [`Revision fixture D ${tag}`, dPieces.map((p) => p.code)]);
  same('the list shows rev 1 again', (await SO.listOrders(conn, COMPANY, {})).filter((o) => o.code === Dq.code).map((o) => [o.id, o.revision, o.status]), [[Dq.order.id, 1, 'inquiry']]);
  eq('and it can change again', (await SO.updateOrder(conn, c, Dq.order.id, { notes: 'open again' })).notes, 'open again');
  const D2b = await REV.reviseOrder(conn, c, Dq.order.id);
  same('revised again: rev 2 once more — the discarded one gave its place back', [D2b.revision, D2b.revisionOfId], [2, Dq.order.id]);
  const Eq = await newOrder(conn, c, f, 'E', [f.GR.id]);
  const firstOnly = await refusal(() => REV.discardRevision(conn, c, Eq.order.id));
  ok('a first revision has nothing to go back to', firstOnly?.code === 'NOT_A_REVISION', firstOnly?.message);

  /* ---- 10. more refusals ------------------------------------------------------------ */
  section('10. What cannot be revised, in words');
  const Fq = await newOrder(conn, c, f, 'F', [f.GR.id]);
  const nothing = await refusal(() => REV.reviseOrder(conn, c, Fq.order.id));
  ok('an order with nothing locked changes as it is', nothing?.code === 'NOTHING_LOCKED' && /is locked yet, so it can still be changed as it is/.test(nothing.message), nothing?.message);
  says(nothing?.message);
  await SO.setOrderStatus(conn, c, Fq.order.id, 'lost');
  const lost = await refusal(() => REV.reviseOrder(conn, c, Fq.order.id));
  ok('a lost order is not revised', lost?.code === 'NOT_REVISABLE' && /is lost — only an open order/.test(lost.message), lost?.message);
  const stock = await SO.createOrder(conn, c, { orderType: 'stock', code: `${tag}-STK` });
  const stockErr = await refusal(() => REV.reviseOrder(conn, c, stock.id));
  ok('nor is a stock order', stockErr?.code === 'NOT_REVISABLE' && /is a stock order/.test(stockErr.message), stockErr?.message);
  eq('a revision cannot be renumbered', (await refusal(() => SO.updateOrder(conn, c, D2b.id, { code: `${tag}-OTHER` })))?.problems?.[0], `A revision keeps its order's number — this is rev 2 of ${Dq.code}.`);
  eq('an order that does not exist is a 404', (await refusal(() => REV.reviseOrder(conn, c, 999999999)))?.status, 404);
  eq('nor can another company revise it', (await refusal(() => REV.reviseOrder(conn, { companyId: COMPANY + 1000000, userId: null }, D2b.id)))?.status, 404);

  /* ---- 11. round trips ---------------------------------------------------------------- */
  section('11. Round trips do not grow with the rows');
  const G1 = await newOrder(conn, c, f, 'G1', [f.GR.id]);
  const G3 = await newOrder(conn, c, f, 'G3', [f.GRX.id]);
  for (const g of [G1, G3]) { await fillAndCut(conn, c, f, g.lines[0].id); await LOCK.lockLine(conn, c, g.lines[0].id); }
  const rowsOf = async (lineId) => Number((await conn.query('SELECT COUNT(*) AS n FROM cf_item_details WHERE owner_order_line_id = ? AND deleted_at IS NULL', [lineId]))[0][0].n);
  const small = counting(conn);
  await REV.reviseOrder(small.db, c, G1.order.id);
  const big = counting(conn);
  await REV.reviseOrder(big.db, c, G3.order.id);
  console.log(`        reviseOrder: ${small.tally.n} round trips for a line of ${await rowsOf(G1.lines[0].id)} rows, ${big.tally.n} for ${await rowsOf(G3.lines[0].id)}`);
  ok('more than twice the rows, the same round trips', small.tally.n === big.tally.n && (await rowsOf(G3.lines[0].id)) > 2 * (await rowsOf(G1.lines[0].id)), `${small.tally.n} vs ${big.tally.n}`);
  // Most of it is making the line's cut pieces from scratch (cutPlateService's
  // own bulk derive, ~44 on the KEPL line); the copy itself is ~30 statements.
  ok('and under a hundred for a line, not one a row', small.tally.n <= 100, String(small.tally.n));

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

section('12. Nothing survived the rollback');
const afterCensus = await census(pool, TABLES);
const left = TABLES.filter((t) => before[t] !== afterCensus[t]).map((t) => `${t} ${before[t]}->${afterCensus[t]}`);
const touched = ['cf_classification_nodes', 'cf_specifications', 'cf_spec_options', 'cf_spec_assignments', 'cf_spec_values', 'cf_spec_value_history',
  'cf_master_records', 'cf_item_details', 'cf_definition_details', 'cf_definition_allowed_items', 'cf_boms', 'cf_bom_lines', 'cf_operations',
  'cf_operation_flows', 'cf_operation_flow_steps', 'cf_code_schemes', 'cf_code_scheme_conditions', 'cf_code_scheme_segments', 'cf_code_sequences',
  'cf_parties', 'cf_stocking_areas', 'cf_sales_orders', 'cf_sales_order_lines', 'cf_order_pieces', 'cf_production_releases', 'cf_production_items',
  'cf_production_steps', 'cf_step_dependencies', 'cf_material_requirements'].filter((t) => t in before);
console.log('        census of the tables the fixture writes (before -> after):');
for (const t of touched) console.log(`          ${t.padEnd(28)} ${String(before[t]).padStart(7)} -> ${String(afterCensus[t]).padStart(7)}`);
ok(`every cf_ table (${TABLES.length}) is back to the count it started at`, left.length === 0, left.join(', '));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) console.log(`failed: ${fails.join(' · ')}`);
await pool.end();
process.exitCode = failed ? 1 : 0;
