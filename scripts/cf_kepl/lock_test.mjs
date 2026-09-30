/**
 * lock_test.mjs — LOCK (services/lockService.js): a line's structure rolled out
 * into pieces with their real codes (cf_order_pieces), and the line frozen.
 * Against the local database.
 *
 *   cd multi_app_be && node scripts/cf_kepl/lock_test.mjs
 *   CF_TEST_COMPANY=1 node scripts/cf_kepl/lock_test.mjs          (1 is the default)
 *
 * Run it in a company whose FAB_PARTS and CUT_PLATE classification codes are
 * free (company 1 locally): the fixture files its parts and cut pieces under
 * nodes of those codes of its own, because the cut-piece check finds them by
 * code, and a borrowed CUT_PLATE brings the tenant's required values with it.
 *
 * EVERYTHING HAPPENS INSIDE ONE TRANSACTION THAT IS ROLLED BACK, and the last
 * thing it does is re-count every cf_ table and prove each is back where it
 * started.
 *
 * IT OWNS ITS FIXTURE — classification, specification and rule, templates,
 * flow, customer, orders, process and production-piece coding rules — every
 * name and code carrying this run's tag (uq_ccn_sibling is unique on NAME per
 * parent). Every other item and production-piece coding rule of the company is
 * switched off for the transaction.
 *
 *   GIRDER  GR  (order A sells 2)
 *     SEGMENT SG x2 (one row)                          pieces SG1, SG2
 *       WEB   WB x1                                    a piece, cut from its own
 *         CUT PIECE CP x1   (filed under CUT_PLATE)    a group of 1: CP1
 *       STIFF IS x3  + IS x1 (a copied row)            pieces IS1-3, then IS4
 *         CUT PIECE CP x1
 *       CLEAT CL x6         (not a plate part)         one group of 6: CL1-6
 *     every cut piece and cleat is made of MAT (catalog material)
 *
 *   piece rules: the top  {order.code}-{item.shortName}-{line.position:00}-{piece.seq}
 *                inside   {parent.code}-{item.shortName}{piece.seq}
 */
import fs from 'fs';
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
const SHEET = await imp('apps/cf_erp/services/bomSheetService.js');
const REL = await imp('apps/cf_erp/services/releaseService.js');
const LOCK = await imp('apps/cf_erp/services/lockService.js');
const ROLL = await imp('apps/cf_erp/services/rollOutService.js');
const SO = await imp('apps/cf_erp/services/salesOrderService.js');
const MR = await imp('apps/cf_erp/services/masterRecordService.js');
const OV = await imp('apps/cf_erp/services/orderValuesService.js');
const V = await imp('apps/cf_erp/services/valueService.js');
const PROC = await imp('apps/cf_erp/services/processService.js');
const { createNode } = await imp('apps/cf_erp/services/classificationService.js');
const OPS = await imp('apps/cf_erp/services/operationService.js');
const FLOWS = await imp('apps/cf_erp/services/flowService.js');
const AREAS = await imp('apps/cf_erp/services/stockingAreaService.js');
const PARTIES = await imp('apps/cf_erp/modules/parties/service.js');
const lockRouter = (await imp('apps/cf_erp/routes/lock.js')).default;
const indexRouter = (await imp('apps/cf_erp/routes/index.js')).default;

const COMPANY = Number(process.env.CF_TEST_COMPANY ?? 1);
const LOCKED_WORDS = /^Line \d+ of \S+ is locked — its structure, values and cut pieces no longer change\. A change means a new revision of the order\.$/;

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
const same = (label, got, want) => ok(label, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)?.slice(0, 400)}, wanted ${JSON.stringify(want)?.slice(0, 400)}`);
const section = (s) => console.log(`\n${s}`);
const says = (text) => console.log(`        says: ${text}`);
async function refusal(fn) {
  try { await fn(); return null; } catch (e) { return e; }
}
/** A refusal in the one sentence a locked line gets, with the code it is filed under. */
function refusedLocked(label, err, code = 'LOCKED') {
  ok(label, err?.code === code && LOCKED_WORDS.test(err?.message ?? ''), err ? `${err.code}: ${err.message}` : 'it was accepted');
}

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
const tag = `LKT${Date.now().toString(36).toUpperCase()}`;
const tok = (key, extra = {}) => ({ segmentType: 'token', tokenKey: key, transform: 'none', isRequired: true, ...extra });
const lit = (text) => ({ segmentType: 'literal', literalText: text });

async function nodeByCode(db, code) {
  const [[n]] = await db.query('SELECT id FROM cf_classification_nodes WHERE company_id = ? AND code = ? AND deleted_at IS NULL', [COMPANY, code]);
  return n ?? null;
}

async function buildFixture(db, c) {
  const fam = await createNode(db, c, { code: `${tag}-F`, name: `Lock fixture ${tag}` });
  const sub = await createNode(db, c, { parentId: fam.id, code: `${tag}-S`, name: `Lock fixture kinds ${tag}` });
  // The two codes the cut-piece check finds things by. The company must not
  // have them already (see the header); the NAMES carry the tag.
  if (await nodeByCode(db, 'FAB_PARTS') || await nodeByCode(db, 'CUT_PLATE')) {
    throw new Error(`Company ${COMPANY} already files parts or cut plates (FAB_PARTS / CUT_PLATE) — run this in a company where both codes are free, such as 1.`);
  }
  const parts = await createNode(db, c, { parentId: fam.id, code: 'FAB_PARTS', name: `Parts ${tag}` });
  const v = {
    assy: await createNode(db, c, { parentId: sub.id, code: `${tag}-VA`, name: `Assemblies ${tag}` }),
    seg: await createNode(db, c, { parentId: sub.id, code: `${tag}-VS`, name: `Segments ${tag}` }),
    part: await createNode(db, c, { parentId: parts.id, code: `${tag}-VP`, name: `Plate parts ${tag}` }),
    cut: await createNode(db, c, { parentId: sub.id, code: 'CUT_PLATE', name: `Cut pieces ${tag}` }),
    cleat: await createNode(db, c, { parentId: sub.id, code: `${tag}-VC`, name: `Cleats ${tag}` }),
    mat: await createNode(db, c, { parentId: sub.id, code: `${tag}-VM`, name: `Material ${tag}` }),
  };

  // A plate part's thickness is required and typed — what the Values stage asks for.
  const [s] = await db.query(
    "INSERT INTO cf_specifications (company_id, code, name, data_type, default_uom, status) VALUES (?, ?, ?, 'number', 'mm', 'active')",
    [COMPANY, `${tag}_THK`, `Thickness (lock test ${tag})`],
  );
  const THK = { id: s.insertId, code: `${tag}_THK` };
  await db.query(
    `INSERT INTO cf_spec_assignments (company_id, specification_id, subject_type, subject_id, capture_at, is_required, is_applicable, value_rule, sort_order)
     VALUES (?, ?, 'classification', ?, 'item', 1, 1, 'entered', 1)`,
    [COMPANY, THK.id, v.part.id],
  );

  const op = await OPS.createOperation(db, c, { code: `${tag}-OP`, name: `Make ${tag}` });
  const flow = await FLOWS.createFlow(db, c, { code: `${tag}-FL`, name: `Make ${tag}` });
  await FLOWS.addStep(db, c, flow.id, { operationId: op.id });
  await FLOWS.setFlowStatus(db, c, flow.id, 'active');

  const MAT = await MR.createItem(db, c, {
    itemType: 'catalog', classificationId: v.mat.id, code: `${tag}-MAT`, name: `Plate stock ${tag}`, shortName: 'MAT', uom: 'kg', status: 'active',
  });
  const tpl = async (code, name, shortName, classificationId) => {
    const d = await MR.createDefinition(db, c, {
      definitionType: 'template', classificationId, code: `${tag}-${code}`, name: `${name} ${tag}`, shortName, status: 'active',
    });
    await MR.updateRecord(db, c, d.id, { defaultFlowId: flow.id });
    return d;
  };
  const CP = await tpl('CP', 'Cut piece', 'CP', v.cut.id);
  const WB = await tpl('WB', 'Web', 'WB', v.part.id);
  const IS = await tpl('IS', 'Stiffener', 'IS', v.part.id);
  const CL = await tpl('CL', 'Cleat', 'CL', v.cleat.id);
  const SG = await tpl('SG', 'Segment', 'SG', v.seg.id);
  const GR = await tpl('GR', 'Girder', 'GR', v.assy.id);

  await B.addLine(db, c, CP.id, { childId: MAT.id, quantity: 0.25 });
  await B.setBomStatus(db, c, CP.id, 'active');
  for (const part of [WB, IS]) {
    await B.addLine(db, c, part.id, { childId: CP.id, quantity: 1, role: 'Cut from' });
    await B.setBomStatus(db, c, part.id, 'active');
  }
  await B.addLine(db, c, CL.id, { childId: MAT.id, quantity: 0.5 });
  await B.setBomStatus(db, c, CL.id, 'active');
  await B.addLine(db, c, SG.id, { childId: WB.id, quantity: 1, role: 'Web' });
  await B.addLine(db, c, SG.id, { childId: IS.id, quantity: 3, role: 'Stiffener — plain' });
  await B.addLine(db, c, SG.id, { childId: IS.id, quantity: 1, role: 'Stiffener — drilled' });
  await B.addLine(db, c, SG.id, { childId: CL.id, quantity: 6, role: 'Cleats' });
  await B.setBomStatus(db, c, SG.id, 'active');
  await B.addLine(db, c, GR.id, { childId: SG.id, quantity: 2, role: 'Segments' });
  await B.setBomStatus(db, c, GR.id, 'active');

  const temporary = { tokenKey: 'kind', operator: 'eq', value: 'temporary' };
  const underFam = { tokenKey: 'classification', operator: 'under', value: String(fam.id) };
  const inside = { tokenKey: 'placement', operator: 'eq', value: 'component' };
  const onLine = { tokenKey: 'placement', operator: 'eq', value: 'line' };
  const exactly = (node) => ({ tokenKey: 'classification', operator: 'eq', value: String(node.id) });
  const pieceRule = (code, body) => codegen.createScheme(db, COMPANY, c.userId, {
    code: `${tag}-${code}`, name: `Lock test ${code} ${tag}`, entityType: 'production_piece', targetField: 'code', seqScope: 'prefix', priority: 0, status: 'active', ...body,
  });
  const rules = {
    // CFPC-TOP's shape: the order, the design's short name, the line position, the piece.
    top: await pieceRule('PTOP', { conditions: [temporary, onLine, underFam], segments: [tok('order.code'), lit('-'), tok('item.shortName'), lit('-'), tok('line.position', { format: '00' }), lit('-'), tok('piece.seq')] }),
    // CFPC-PART's shape: the parent's code, the short name, the piece under its parent.
    part: await pieceRule('PPART', { conditions: [inside, underFam], segments: [tok('parent.code'), lit('-'), tok('item.shortName'), tok('piece.seq')] }),
  };
  const cust = await PARTIES.createParty(db, c, { code: `${tag}-CUST`, name: `Lock test customer ${tag}`, roles: ['customer'] });
  const area = await AREAS.createArea(db, c, { code: `${tag}-DSP`, name: `Dispatch ${tag}`, purpose: 'dispatch' });
  return { fam, sub, parts, v, THK, op, flow, MAT, CP, WB, IS, CL, SG, GR, rules, pieceRule, inside, onLine, temporary, underFam, exactly, cust, area };
}

/** An order of its own with one line per quantity given, each selling the girder. Its rows' thickness filled. */
async function girderOrder(db, c, f, letter, quantities) {
  const order = await SO.createOrder(db, c, { orderType: 'customer', customerId: f.cust.id, code: `${tag}-SO${letter}`, title: `Lock fixture ${letter} ${tag}`, committedDate: '2026-12-31' });
  let o = order;
  for (const q of quantities) o = await SO.addOrderLine(db, c, order.id, { recordId: f.GR.id, quantity: q });
  for (const l of o.lines) await fillThickness(db, c, f, l.id);
  return { order: o, lines: o.lines, code: `${tag}-SO${letter}` };
}

/** Every plate part of a line gets its thickness, through the Values stage's own write. */
async function fillThickness(db, c, f, lineId, value = 10) {
  const [parts] = await db.query(
    `SELECT m.id FROM cf_master_records m JOIN cf_item_details i ON i.master_id = m.id AND i.deleted_at IS NULL
      WHERE i.company_id = ? AND i.owner_order_line_id = ? AND m.classification_id = ? AND m.deleted_at IS NULL`,
    [COMPANY, lineId, f.v.part.id],
  );
  if (parts.length) await OV.writeLineValues(db, c, lineId, { writes: parts.map((p) => ({ recordId: p.id, specCode: f.THK.code, value })) });
  return parts.map((p) => p.id);
}

const livePieces = async (db, lineId) => (await db.query(
  `SELECT id, parent_id, item_id, bom_line_id, piece_no, piece_seq, quantity, code, rule_code, path_key, depth, sort_order
     FROM cf_order_pieces WHERE company_id = ? AND order_line_id = ? AND deleted_at IS NULL ORDER BY sort_order`,
  [COMPANY, lineId],
))[0];
const lineRow = async (db, lineId) => (await db.query('SELECT locked_at, locked_by, lock_position, deleted_at FROM cf_sales_order_lines WHERE id = ?', [lineId]))[0][0];

/* --------------------------------------------------------------------------
 * The run
 * ----------------------------------------------------------------------- */
console.log(`lock_test — company ${COMPANY}, fixture tag ${tag}`);

section('0. The harness refuses a swapped ok(), and the routes are mounted');
ok('ok(cond, label) throws instead of passing', (await refusal(() => ok(true, 'swapped'))) instanceof Error);
ok('ok(label, truthy object) throws too', (await refusal(() => ok('object', {}))) instanceof Error);
const routeOf = (method, p) => lockRouter.stack.find((l) => l.route?.path === p && l.route.methods[method])?.route ?? null;
const getRoute = routeOf('get', '/order-lines/:id/lock');
const postRoute = routeOf('post', '/order-lines/:id/lock');
ok('GET /order-lines/:id/lock is a route', !!getRoute);
ok('POST /order-lines/:id/lock is a route', !!postRoute);
same('each behind protect, a permission check and the handler', [getRoute?.stack?.length, getRoute?.stack?.[0]?.name, postRoute?.stack?.length, postRoute?.stack?.[0]?.name], [3, 'protect', 3, 'protect']);
ok('and the lock routes are mounted in the app\'s router', indexRouter.stack.some((l) => l.handle === lockRouter));
const ordersSource = fs.readFileSync(path.join(BE, 'apps/cf_erp/routes/orders.js'), 'utf8');
ok('working a line\'s cut plates out again asks whether it is locked first', /assertLineUnlocked\(db, c\.companyId, id\(req\)\);\s*return deriveCutPlates/.test(ordersSource));

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
  // A process of its own with the lock stage, stamped on the order below.
  const prc = await PROC.createProcess(conn, c, { code: `${tag}-PRC`, name: `Lock test ${tag}` });
  await PROC.replaceStages(conn, c, prc.id, { stages: ['lines', 'structure', 'values', 'cut_pieces', 'lock', 'nesting', 'buying', 'production', 'confirm'].map((stageKey) => ({ stageKey })) });
  await PROC.setProcessStatus(conn, c, prc.id, 'active');

  const A = await girderOrder(conn, c, f, 'A', [2]);
  const lineA = A.lines[0];
  await conn.query('UPDATE cf_sales_orders SET process_id = ? WHERE id = ?', [prc.id, A.order.id]);

  /* ---- 1. what lock would write ----------------------------------------- */
  section('1. lockPlan: the checks in words, and every piece with the code lock would give it');
  const tripPlan = counting(conn);
  const plan = await LOCK.lockPlan(tripPlan.db, COMPANY, lineA.id, { nodes: true });
  ok('the line can be locked — every check passes', plan.canLock === true, plan.problems.join(' | '));
  same('five checks, each passed', plan.checks.map((ch) => [ch.key, ch.ok]),
    [['line', true], ['values', true], ['structure', true], ['cut_pieces', true], ['codes', true]]);
  ok('each check has a title and a sentence', plan.checks.every((ch) => typeof ch.title === 'string' && ch.title.length > 0 && typeof ch.detail === 'string' && ch.detail.length > 0));
  says(plan.checks.find((ch) => ch.key === 'structure').detail);
  same('it is not locked yet', plan.locked, null);
  same('the line would be position 01 — the only line of its design', plan.position, { value: 1, text: '01', lines: 1 });
  eq('50 pieces: per girder 1 + 2 segments x (1 + web + cut piece + 4 stiffeners x 2 + cleats)', plan.summary.nodes, 50);
  same('26 numbered one by one (girders, segments, parts), 24 groups (cut pieces, cleats)', [plan.summary.pieces, plan.summary.groups], [26, 24]);
  same('every code from a rule, none built in, no duplicate, none taken, no hole',
    [plan.summary.byRule, plan.summary.builtIn, plan.summary.duplicates, plan.summary.taken, plan.summary.missing], [50, 0, 0, 0, 0]);
  const byK = new Map(plan.nodes.map((n) => [n.k, n]));
  const kids = (k) => plan.nodes.filter((n) => n.parentK === k);
  const tops = plan.nodes.filter((n) => n.parentK == null);
  same('the two girders: {order}-{short name}-{position}-{piece}', tops.map((n) => n.code), [`${A.code}-GR-01-1`, `${A.code}-GR-01-2`]);
  const segs = kids(tops[1].k);
  same('under the second girder its segments start again at 1', segs.map((n) => n.code), [`${A.code}-GR-01-2-SG1`, `${A.code}-GR-01-2-SG2`]);
  const under = kids(segs[0].k);
  same('under a segment: the web, the stiffeners 1-3 and the copied row\'s 4, then the cleats as one group of 6',
    under.map((n) => n.code), ['WB1', 'IS1', 'IS2', 'IS3', 'IS4', 'CL1-6'].map((x) => `${segs[0].code}-${x}`));
  const cleats = under[under.length - 1];
  same('the cleats are a group: no piece number, 6 of them, their range as the piece seq', [cleats.pieceNo, cleats.quantity, cleats.pieceSeq], [null, 6, '1-6']);
  same('each part has its cut piece under it: a group of 1', kids(under[1].k).map((n) => [n.code, n.quantity]), [[`${under[1].code}-CP1`, 1]]);
  ok('nodes come in roll-out order: every parent before its children', plan.nodes.every((n, i) => n.k === i && (n.parentK == null || n.parentK < n.k)));
  ok('a group carries a label naming its item and how many', typeof cleats.label === 'string' && cleats.label.endsWith(' ×6'), cleats.label);
  const preview = await REL.previewReleaseCodes(conn, COMPANY, lineA.id);
  same('previewReleaseCodes gives the same codes, at the same line position', preview.nodes.map((n) => n.code), plan.nodes.map((n) => n.code));
  eq('and it says the position it used', preview.linePosition, 1);
  console.log(`        round trips: lockPlan ${tripPlan.tally.n} (50 pieces)`);

  /* ---- 2. what stops a lock ------------------------------------------------ */
  section('2. Every problem at once: missing values and a plate part with no cut piece');
  await conn.query('SAVEPOINT gaps');
  const [[aPart]] = await conn.query(
    `SELECT m.id, m.name FROM cf_master_records m JOIN cf_item_details i ON i.master_id = m.id
      WHERE i.company_id = ? AND i.owner_order_line_id = ? AND m.classification_id = ? AND m.deleted_at IS NULL ORDER BY m.id LIMIT 1`,
    [COMPANY, lineA.id, f.v.part.id],
  );
  await OV.writeLineValues(conn, c, lineA.id, { writes: [{ recordId: aPart.id, specCode: f.THK.code, value: null }] });
  const [[cutLine]] = await conn.query(
    `SELECT l.id FROM cf_bom_lines l JOIN cf_boms b ON b.id = l.bom_id AND b.deleted_at IS NULL
      WHERE l.company_id = ? AND b.parent_id = (SELECT m.id FROM cf_master_records m JOIN cf_item_details i ON i.master_id = m.id
             WHERE i.company_id = ? AND i.owner_order_line_id = ? AND m.classification_id = ? AND m.deleted_at IS NULL ORDER BY m.id DESC LIMIT 1)
        AND l.deleted_at IS NULL`,
    [COMPANY, COMPANY, lineA.id, f.v.part.id],
  );
  await B.removeLine(conn, c, cutLine.id);
  const gap = await LOCK.lockPlan(conn, COMPANY, lineA.id);
  ok('it cannot be locked', gap.canLock === false);
  const check = (key) => gap.checks.find((ch) => ch.key === key);
  ok('the values check says how many are empty, and names the row and the specification',
    check('values').ok === false && check('values').detail.startsWith('1 required value is still empty') && check('values').detail.includes(f.THK.code), check('values').detail);
  ok('and says what to do', typeof check('values').todo === 'string' && check('values').todo.includes('Values stage'), check('values').todo);
  ok('the cut-piece check names the plate part that has none', check('cut_pieces').ok === false && check('cut_pieces').detail.includes('1 plate part has no cut piece yet'), check('cut_pieces').detail);
  ok('and says they are made automatically once the values are complete', (check('cut_pieces').todo ?? '').includes('made automatically as soon as the values are complete'), check('cut_pieces').todo);
  ok('the part is not named a second time as "made out of nothing" — the cut-piece check says why', check('structure').ok === true, check('structure').problems.join(' | '));
  const gapErr = await refusal(() => LOCK.lockLine(conn, c, lineA.id));
  eq('lockLine refuses: NOT_READY, a 422', `${gapErr?.code} ${gapErr?.status}`, 'NOT_READY 422');
  ok('with both problems at once', (gapErr?.problems ?? []).some((p) => p.includes('still empty')) && (gapErr?.problems ?? []).some((p) => p.includes('no cut piece')), (gapErr?.problems ?? []).join(' | '));
  eq('and nothing was written', (await livePieces(conn, lineA.id)).length, 0);
  eq('the line is not locked', (await lineRow(conn, lineA.id)).locked_at, null);
  await conn.query('ROLLBACK TO SAVEPOINT gaps');

  // The process's own stage says the same before the lock.
  const procBefore = await PROC.orderProcess(conn, COMPANY, A.order.id);
  const lockStage0 = procBefore.lines[0].stages.find((st) => st.stageKey === 'lock');
  same('on the order\'s process, Lock is ready: nothing in its way, not done yet', [lockStage0?.applies, lockStage0?.state, lockStage0?.blockers?.length], [true, 'partial', 0]);
  says(lockStage0?.detail);

  /* ---- 3. lock ------------------------------------------------------------------ */
  section('3. lockLine writes exactly what lockPlan showed, piece for piece');
  const [draftsBefore] = await conn.query(
    "SELECT COUNT(*) AS n FROM cf_master_records m JOIN cf_item_details i ON i.master_id = m.id WHERE i.company_id = ? AND i.owner_order_line_id = ? AND m.status = 'draft' AND m.deleted_at IS NULL",
    [COMPANY, lineA.id],
  );
  ok('before the lock its rows are drafts — a row has no draft life of its own', Number(draftsBefore[0].n) > 0, String(draftsBefore[0].n));
  const tripLock = counting(conn);
  const lockedView = await LOCK.lockLine(tripLock.db, c, lineA.id);
  console.log(`        round trips: lockLine ${tripLock.tally.n} (50 pieces)`);
  ok('it answers with the locked line', !!lockedView.locked && lockedView.locked.pieces === 50 && lockedView.locked.position === 1, JSON.stringify(lockedView.locked));
  const written = await livePieces(conn, lineA.id);
  eq('50 pieces written', written.length, 50);
  same('the same codes, in the same order', written.map((p) => p.code), plan.nodes.map((n) => n.code));
  const kOfId = new Map(written.map((p) => [p.id, p.sort_order - 1]));
  same('each under the same parent', written.map((p) => (p.parent_id == null ? null : kOfId.get(p.parent_id))), plan.nodes.map((n) => n.parentK));
  same('the same item, piece number, piece seq, quantity and depth', written.map((p) => [p.item_id, p.piece_no, p.piece_seq, Number(p.quantity), p.depth]),
    plan.nodes.map((n) => [n.itemId, n.pieceNo, n.pieceSeq == null ? null : String(n.pieceSeq), n.quantity, n.depth]));
  ok('every piece names the rule that coded it', written.every((p) => p.rule_code === f.rules.top.code || p.rule_code === f.rules.part.code));
  ok('and a path key saying where it sits, unique on the line', new Set(written.map((p) => p.path_key)).size === 50 && written[0].path_key === 'L.1'
    && written.every((p) => p.parent_id == null || p.path_key.startsWith(`${written[kOfId.get(p.parent_id)].path_key}/`)), written.slice(0, 3).map((p) => p.path_key).join(', '));
  const stamp = await lineRow(conn, lineA.id);
  same('the line is stamped: locked, at position 1', [!!stamp.locked_at, stamp.lock_position], [true, 1]);
  const [draftsAfter] = await conn.query(
    "SELECT m.status, COUNT(*) AS n FROM cf_master_records m JOIN cf_item_details i ON i.master_id = m.id WHERE i.company_id = ? AND i.owner_order_line_id = ? AND m.deleted_at IS NULL GROUP BY m.status",
    [COMPANY, lineA.id],
  );
  same('and every row and cut piece of it is active now — locking activated them', draftsAfter.map((r) => r.status), ['active']);
  const [codedRows] = await conn.query("SELECT COUNT(*) AS n FROM cf_master_records m JOIN cf_item_details i ON i.master_id = m.id WHERE i.owner_order_line_id = ? AND m.code IS NOT NULL", [lineA.id]);
  eq('without minting a code for any row', Number(codedRows[0].n), 0);
  const after = await LOCK.lockPlan(conn, COMPANY, lineA.id, { nodes: true });
  same('lockPlan now reads the locked pieces, piece for piece', after.nodes.map((n) => [n.k, n.parentK, n.code]), plan.nodes.map((n) => [n.k, n.parentK, n.code]));
  same('and says it is locked, when and at what position', [!!after.locked?.at, after.locked?.pieces, after.locked?.position, after.canLock], [true, 50, 1, false]);
  const second = await refusal(() => LOCK.lockLine(conn, c, lineA.id));
  ok('a second lock is refused', second?.code === 'ALREADY_LOCKED' && /already locked/.test(second?.message ?? ''), second?.message);
  const procAfter = await PROC.orderProcess(conn, COMPANY, A.order.id);
  const lockStage1 = procAfter.lines[0].stages.find((st) => st.stageKey === 'lock');
  same('the process says it too: Lock is done, "Locked — 50 pieces"', [lockStage1?.state, lockStage1?.detail], ['done', 'Locked — 50 pieces']);

  /* ---- 4. frozen ------------------------------------------------------------------- */
  section('4. A locked line no longer changes — each refusal in the same words');
  const segRow = (await conn.query(
    'SELECT m.id FROM cf_master_records m JOIN cf_item_details i ON i.master_id = m.id WHERE i.owner_order_line_id = ? AND m.classification_id = ? AND m.deleted_at IS NULL ORDER BY m.id LIMIT 1',
    [lineA.id, f.v.seg.id],
  ))[0][0].id;
  refusedLocked('adding a row to its structure', await refusal(() => B.addLine(conn, c, segRow, { childId: f.MAT.id, quantity: 1 })));
  const [[segLine]] = await conn.query('SELECT l.id FROM cf_bom_lines l JOIN cf_boms b ON b.id = l.bom_id WHERE b.parent_id = ? AND l.deleted_at IS NULL ORDER BY l.line_no LIMIT 1', [segRow]);
  refusedLocked('changing a row\'s quantity', await refusal(() => B.updateLine(conn, c, segLine.id, { quantity: 2 })));
  refusedLocked('removing a row', await refusal(() => B.removeLine(conn, c, segLine.id)));
  const bc = await refusal(() => BC.applyBomChanges(conn, c, { scope: { orderLineId: lineA.id }, changes: [{ op: 'quantity', lineId: segLine.id, quantity: 2 }] }));
  refusedLocked('a batch of structure edits (edit mode)', bc);
  eq('... as the 409 edit mode promises for a frozen structure', bc?.status, 409);
  const sheet = await SHEET.exportSheet(conn, COMPANY, lineA.id);
  ok('the BOM sheet still comes out — a locked line\'s sheet is a record worth having', sheet.buffer.length > 0);
  refusedLocked('but a BOM sheet does not go back in', await refusal(() => SHEET.importSheet(conn, c, lineA.id, { fileBase64: sheet.buffer.toString('base64') })));
  const [[partRow]] = await conn.query(
    'SELECT m.id FROM cf_master_records m JOIN cf_item_details i ON i.master_id = m.id WHERE i.owner_order_line_id = ? AND m.classification_id = ? AND m.deleted_at IS NULL ORDER BY m.id LIMIT 1',
    [lineA.id, f.v.part.id],
  );
  const vw = await refusal(() => OV.writeLineValues(conn, c, lineA.id, { writes: [{ recordId: partRow.id, specCode: f.THK.code, value: 12 }] }));
  refusedLocked('a value typed on the Values stage', vw);
  eq('... a 409, as a released line\'s values are', vw?.status, 409);
  refusedLocked('a value set on the record itself', await refusal(() => V.setValues(conn, c, 'master', partRow.id, [{ specCode: f.THK.code, value: 12 }])));
  const readBack = await OV.readLineValues(conn, COMPANY, lineA.id);
  same('the Values stage reads as locked, in the same words, and not editable', [readBack.lock?.reason, LOCKED_WORDS.test(readBack.lock?.message ?? ''), readBack.editable], ['locked', true, false]);
  refusedLocked('working its cut pieces out again (the route asks this before deriving)', await refusal(() => LOCK.assertLineUnlocked(conn, COMPANY, lineA.id)));
  refusedLocked('a row\'s own details', await refusal(() => MR.updateRecord(conn, c, partRow.id, { name: 'Renamed' })));
  refusedLocked('the line\'s quantity', await refusal(() => SO.updateOrderLine(conn, c, lineA.id, { quantity: 3 })));
  refusedLocked('removing the line', await refusal(() => SO.removeOrderLine(conn, c, lineA.id)));
  eq('... while its wording may still change', (await SO.updateOrderLine(conn, c, lineA.id, { description: 'Span 1 girders' })).lines[0].description, 'Span 1 girders');
  const struct = await SO.lineStructure(conn, COMPANY, lineA.id);
  eq('the Structure tab is read-only', struct.order.editable, false);
  const orderView = await SO.getOrder(conn, COMPANY, A.order.id);
  same('and the order says the line is locked, at which position', [!!orderView.lines[0].lock?.lockedAt, orderView.lines[0].lock?.position], [true, 1]);

  /* ---- 4b. flows stay open until release ----------------------------------------- */
  // User, 2026-09-30: how a thing is made may still change on a locked line,
  // until it is released — and nothing else may (records.flowStillOpen).
  section('4b. How a row is made still changes on a locked line — and only that');
  const flow2 = await FLOWS.createFlow(conn, c, { code: `${tag}-FL2`, name: `Make ${tag} another way` });
  await FLOWS.addStep(conn, c, flow2.id, { operationId: f.op.id });
  await FLOWS.setFlowStatus(conn, c, flow2.id, 'active');
  eq('the Structure tab says flows can still change', struct.order.flowsEditable, true);
  same('... and that the line is locked, not released', [struct.order.locked, struct.order.released], [true, false]);
  const flowOf = async (recordId) => (await conn.query('SELECT default_flow_id FROM cf_master_records WHERE id = ?', [recordId]))[0][0].default_flow_id;
  const partFlowWas = await flowOf(partRow.id);
  const newFlow = await MR.updateRecord(conn, c, partRow.id, { defaultFlowId: flow2.id });
  eq('a row\'s "usually made by" changes on its own', newFlow.defaultFlowId, flow2.id);
  eq('... and is saved', await flowOf(partRow.id), flow2.id);
  refusedLocked('but a flow with any other field is refused whole', await refusal(() => MR.updateRecord(conn, c, partRow.id, { defaultFlowId: f.flow.id, name: 'Renamed' })));
  eq('... and the flow did not change with it', await flowOf(partRow.id), flow2.id);
  await MR.updateRecord(conn, c, partRow.id, { defaultFlowId: partFlowWas });
  eq('cleared again, it goes back to its template\'s flow', await flowOf(partRow.id), partFlowWas);
  const lineFlow = async (lineId) => (await conn.query('SELECT operation_flow_id FROM cf_bom_lines WHERE id = ?', [lineId]))[0][0].operation_flow_id;
  await B.updateLine(conn, c, segLine.id, { operationFlowId: flow2.id });
  eq('a BOM line\'s flow changes through the line dialog', await lineFlow(segLine.id), flow2.id);
  refusedLocked('but not with its quantity in the same save', await refusal(() => B.updateLine(conn, c, segLine.id, { operationFlowId: null, quantity: 2 })));
  const dry = await BC.applyBomChanges(conn, c, { scope: { orderLineId: lineA.id }, dryRun: true, changes: [{ op: 'flow', lineId: segLine.id, flowId: null }] });
  ok('edit mode checks a flow-only batch without refusing it', dry.dryRun === true && dry.summary.counts.flow === 1, JSON.stringify(dry.summary));
  const bcFlow = await BC.applyBomChanges(conn, c, { scope: { orderLineId: lineA.id }, changes: [{ op: 'flow', lineId: segLine.id, flowId: null }] });
  ok('and saves it', bcFlow.applied === true && bcFlow.summary.counts.flow === 1, JSON.stringify(bcFlow.summary));
  eq('... the line is back on the usual flow', await lineFlow(segLine.id), null);
  const mixed = await refusal(() => BC.applyBomChanges(conn, c, { scope: { orderLineId: lineA.id }, changes: [{ op: 'flow', lineId: segLine.id, flowId: flow2.id }, { op: 'quantity', lineId: segLine.id, quantity: 2 }] }));
  refusedLocked('a batch with a flow AND anything else is refused whole', mixed);
  eq('... as a 409', mixed?.status, 409);
  eq('... and nothing of it was saved', await lineFlow(segLine.id), null);
  same('the pieces and their codes did not move', (await livePieces(conn, lineA.id)).map((p) => p.code), plan.nodes.map((n) => n.code));

  /* ---- 5. positions --------------------------------------------------------------- */
  section('5. Line positions: counted over the lines that exist at lock — no gaps, no 2s');
  const Bq = await girderOrder(conn, c, f, 'B', [1, 1]);
  const [b10, b20] = Bq.lines;
  eq('two lines of one design: the second would be 02', (await LOCK.lockPlan(conn, COMPANY, b20.id)).position.value, 2);
  eq('linePositionOf says the same', await ROLL.linePositionOf(conn, COMPANY, b20.id), 2);
  await SO.removeOrderLine(conn, c, b10.id);
  const bPlan = await LOCK.lockPlan(conn, COMPANY, b20.id, { nodes: true });
  eq('the first deleted before any lock: the other would now be 01', bPlan.position.value, 1);
  await LOCK.lockLine(conn, c, b20.id);
  same('it locks as 01, and its codes say 01', [(await lineRow(conn, b20.id)).lock_position, (await livePieces(conn, b20.id))[0].code], [1, `${Bq.code}-GR-01-1`]);
  const Cq = await girderOrder(conn, c, f, 'C', [1, 1, 1]);
  const [c10, c20, c30] = Cq.lines;
  await LOCK.lockLine(conn, c, c30.id);
  eq('three lines, the third locked first: it takes its rank, 03', (await lineRow(conn, c30.id)).lock_position, 3);
  await LOCK.lockLine(conn, c, c10.id);
  eq('the first then locks as 01', (await lineRow(conn, c10.id)).lock_position, 1);
  await SO.removeOrderLine(conn, c, c20.id);
  const c40 = (await SO.addOrderLine(conn, c, Cq.order.id, { recordId: f.GR.id, quantity: 1 })).lines.find((l) => ![c10.id, c30.id].includes(l.id));
  await fillThickness(conn, c, f, c40.id);
  eq('a line added after: its rank is 3, but 03 is held by a locked line — so the next free, 04', (await LOCK.lockPlan(conn, COMPANY, c40.id)).position.value, 4);
  await LOCK.lockLine(conn, c, c40.id);
  same('and it locks as 04', [(await lineRow(conn, c40.id)).lock_position, (await livePieces(conn, c40.id))[0].code], [4, `${Cq.code}-GR-04-1`]);

  /* ---- 6. duplicates, taken codes, holes ---------------------------------------- */
  section('6. Lock refuses two pieces with one code, a code another line holds, and a rule with a hole');
  const D = await girderOrder(conn, c, f, 'D', [1]);
  const lineD = D.lines[0];
  await conn.query('SAVEPOINT dup');
  // Same conditions as the part rule and a higher priority: the stiffeners lose their number.
  await f.pieceRule('PDUP', { priority: 5, conditions: [f.inside, f.exactly(f.v.part)], segments: [tok('parent.code'), lit('-'), tok('item.shortName')] });
  const dupPlan = await LOCK.lockPlan(conn, COMPANY, lineD.id);
  ok('the codes check names codes given to more than one piece', dupPlan.checks.find((ch) => ch.key === 'codes').ok === false && dupPlan.summary.duplicates > 0, JSON.stringify(dupPlan.summary));
  const dupErr = await refusal(() => LOCK.lockLine(conn, c, lineD.id));
  ok('lockLine refuses, naming one of them', dupErr?.code === 'NOT_READY' && dupPlan.duplicates.some((d) => (dupErr.problems ?? []).join(' ').includes(d)), (dupErr?.problems ?? []).join(' | '));
  says((dupErr?.problems ?? []).find((p) => p.includes('more than one piece')));
  await conn.query('ROLLBACK TO SAVEPOINT dup');

  await conn.query('SAVEPOINT taken');
  // The top rule without the order code: two orders' first girders are one code.
  await f.pieceRule('PTOP2', { priority: 5, conditions: [f.temporary, f.onLine, f.underFam], segments: [tok('item.shortName'), lit(`-${tag}-`), tok('line.position', { format: '00' }), lit('-'), tok('piece.seq')] });
  const E = await girderOrder(conn, c, f, 'E', [1]);
  await LOCK.lockLine(conn, c, E.lines[0].id);
  const takenPlan = await LOCK.lockPlan(conn, COMPANY, lineD.id);
  ok('the next order\'s girder code is taken by the locked one', takenPlan.taken.includes(`GR-${tag}-01-1`) && takenPlan.canLock === false, takenPlan.taken.slice(0, 4).join(', '));
  const takenErr = await refusal(() => LOCK.lockLine(conn, c, lineD.id));
  ok('lockLine refuses, naming it', takenErr?.code === 'NOT_READY' && (takenErr.problems ?? []).some((p) => p.includes(`GR-${tag}-01-1`) && p.includes('another line')), (takenErr?.problems ?? []).join(' | '));
  says((takenErr?.problems ?? []).find((p) => p.includes('another line')));
  await conn.query('ROLLBACK TO SAVEPOINT taken');

  await conn.query('SAVEPOINT hole');
  // piece.no is blank on a group, so the cleats' code has a hole.
  await f.pieceRule('PHOLE', { priority: 5, conditions: [f.inside, f.exactly(f.v.cleat)], segments: [tok('parent.code'), lit('-'), tok('piece.no')] });
  const holeErr = await refusal(() => LOCK.lockLine(conn, c, lineD.id));
  ok('a rule with a hole is refused, saying which rule and what it needs', holeErr?.code === 'NOT_READY' && (holeErr.problems ?? []).some((p) => p.includes(`${tag}-PHOLE`) && p.includes('piece.no')), (holeErr?.problems ?? []).join(' | '));
  says((holeErr?.problems ?? []).find((p) => p.includes('PHOLE')));
  eq('nothing was written for it', (await livePieces(conn, lineD.id)).length, 0);
  await conn.query('ROLLBACK TO SAVEPOINT hole');

  /* ---- 7. release ---------------------------------------------------------------- */
  section('7. Release: only a locked line, and only with the codes lock wrote');
  await SO.setOrderStatus(conn, c, D.order.id, 'confirmed');
  const unlockedCheck = await REL.releaseCheck(conn, COMPANY, lineD.id);
  same('a line not locked: the release check says one thing, lock first', unlockedCheck.problems, [REL.lockFirst({ line_no: lineD.lineNo, order_code: D.code })]);
  const unlockedErr = await refusal(() => REL.releaseLine(conn, c, lineD.id, { finishedAreaId: f.area.id }));
  ok('and release refuses it', unlockedErr?.code === 'NOT_READY' && (unlockedErr.problems ?? []).some((p) => p.includes('Lock the line first — it comes after the values and cut pieces')), (unlockedErr?.problems ?? []).join(' | '));

  await SO.setOrderStatus(conn, c, A.order.id, 'confirmed');
  // A coding rule changed AFTER the lock: it would give every part a new code.
  await f.pieceRule('PNEW', { priority: 9, conditions: [f.inside, f.underFam], segments: [tok('parent.code'), lit('-NEW-'), tok('item.shortName'), tok('piece.seq')] });
  const lockedPreview = await REL.previewReleaseCodes(conn, COMPANY, lineA.id);
  same('the release preview of the locked line still shows the locked codes', lockedPreview.nodes.map((n) => n.code), plan.nodes.map((n) => n.code));
  eq('with nothing stopping it', lockedPreview.problems.length, 0);
  ok('while a line not locked already codes by the new rule', (await LOCK.lockPlan(conn, COMPANY, lineD.id, { nodes: true })).nodes.some((n) => n.code.includes('-NEW-')));
  const relCheck = await REL.releaseCheck(conn, COMPANY, lineA.id);
  ok('the locked line can be released', relCheck.ok === true, relCheck.problems.join(' | '));
  const released = await REL.releaseLine(conn, c, lineA.id, { finishedAreaId: f.area.id });
  same('release wrote the locked codes, node for node — not the new rule\'s', released.items.map((i) => i.code), plan.nodes.map((n) => n.code));
  eq('50 tracker pieces', released.items.length, 50);
  // Released: flows freeze with everything else.
  const relFlow = await refusal(() => MR.updateRecord(conn, c, partRow.id, { defaultFlowId: flow2.id }));
  ok('released, a row\'s flow is refused — in a plain sentence', relFlow?.code === 'RELEASED' && /its flow can no longer change/.test(relFlow?.message ?? ''), relFlow ? `${relFlow.code}: ${relFlow.message}` : 'it was accepted');
  const relLine = await refusal(() => B.updateLine(conn, c, segLine.id, { operationFlowId: flow2.id }));
  eq('... so is a BOM line\'s', relLine?.code, 'RELEASED');
  const relBatch = await refusal(() => BC.applyBomChanges(conn, c, { scope: { orderLineId: lineA.id }, changes: [{ op: 'flow', lineId: segLine.id, flowId: flow2.id }] }));
  same('... and edit mode\'s, as a 409', [relBatch?.code, relBatch?.status], ['RELEASED', 409]);
  const relStruct = await SO.lineStructure(conn, COMPANY, lineA.id);
  same('the Structure tab says flows no longer change', [relStruct.order.flowsEditable, relStruct.order.released], [false, true]);
  ok('and a group\'s label names its item, though its row has no code', released.items.some((i) => !i.pieceNo && / ×6 for /.test(i.label)), released.items.find((i) => !i.pieceNo)?.label);

  /* ---- 8. taking it back ---------------------------------------------------------- */
  section('8. Taking a release back leaves the line locked');
  await REL.unrelease(conn, c, released.id);
  ok('the release is gone', !(await REL.liveReleaseOfLine(conn, COMPANY, lineA.id)));
  ok('the line is still locked', !!(await lineRow(conn, lineA.id)).locked_at);
  same('its locked pieces are all still there, codes unchanged', (await livePieces(conn, lineA.id)).map((p) => p.code), plan.nodes.map((n) => n.code));
  refusedLocked('and its structure is still frozen', await refusal(() => B.addLine(conn, c, segRow, { childId: f.MAT.id, quantity: 1 })));
  const again = await REL.releaseLine(conn, c, lineA.id, { finishedAreaId: f.area.id });
  same('released again, it carries the same codes', again.items.map((i) => i.code), plan.nodes.map((n) => n.code));

  /* ---- 9. a deleted order gives its codes back -------------------------------------- */
  section('9. Deleting an order retires its locked pieces, so their codes are free again');
  const G = await girderOrder(conn, c, f, 'G', [1]);
  await LOCK.lockLine(conn, c, G.lines[0].id);
  eq('its line is locked with 25 pieces', (await livePieces(conn, G.lines[0].id)).length, 25);
  await SO.deleteOrder(conn, c, G.order.id);
  eq('deleted, none of them is live any more', (await livePieces(conn, G.lines[0].id)).length, 0);

  /* ---- 10. round trips ---------------------------------------------------------------- */
  section('10. Round trips do not grow with the pieces');
  const H = await girderOrder(conn, c, f, 'H', [1, 3]);
  const small = counting(conn);
  const hs = await LOCK.lockPlan(small.db, COMPANY, H.lines[0].id);
  const big = counting(conn);
  const hb = await LOCK.lockPlan(big.db, COMPANY, H.lines[1].id);
  console.log(`        lockPlan: ${small.tally.n} round trips for ${hs.summary.nodes} pieces, ${big.tally.n} for ${hb.summary.nodes}`);
  ok('lockPlan: three times the pieces, the same round trips', small.tally.n === big.tally.n && hb.summary.nodes === 3 * hs.summary.nodes, `${small.tally.n} vs ${big.tally.n}`);
  const ls = counting(conn);
  await LOCK.lockLine(ls.db, c, H.lines[0].id);
  const lb = counting(conn);
  await LOCK.lockLine(lb.db, c, H.lines[1].id);
  console.log(`        lockLine: ${ls.tally.n} round trips for ${hs.summary.nodes} pieces, ${lb.tally.n} for ${hb.summary.nodes}`);
  ok('lockLine: the same round trips too', ls.tally.n === lb.tally.n, `${ls.tally.n} vs ${lb.tally.n}`);
  ok('and a few dozen, not one a piece', lb.tally.n <= 60, `${lb.tally.n}`);

  /* ---- 11. not found -------------------------------------------------------------------- */
  section('11. Not found, a line of another company, and a catalog line');
  eq('a line that does not exist is a 404', (await refusal(() => LOCK.lockPlan(conn, COMPANY, 999999999)))?.status, 404);
  eq('nor can another company read it', (await refusal(() => LOCK.lockPlan(conn, COMPANY + 1000000, lineA.id)))?.status, 404);
  const std = await SO.addOrderLine(conn, c, D.order.id, { recordId: f.MAT.id, quantity: 5 });
  const stdLine = std.lines.find((l) => l.lineType === 'standard');
  const stdPlan = await LOCK.lockPlan(conn, COMPANY, stdLine.id);
  ok('a line selling a catalog item as it is has nothing to lock, and says so', stdPlan.canLock === false && stdPlan.checks[0].detail.includes('only a line built from a template'), stdPlan.checks[0].detail);

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
const touched = ['cf_classification_nodes', 'cf_specifications', 'cf_spec_assignments', 'cf_spec_values', 'cf_spec_value_history', 'cf_master_records',
  'cf_item_details', 'cf_definition_details', 'cf_boms', 'cf_bom_lines', 'cf_operations', 'cf_operation_flows', 'cf_operation_flow_steps',
  'cf_code_schemes', 'cf_code_scheme_conditions', 'cf_code_scheme_segments', 'cf_parties', 'cf_processes', 'cf_process_stages',
  'cf_sales_orders', 'cf_sales_order_lines', 'cf_order_pieces', 'cf_stocking_areas', 'cf_production_releases', 'cf_production_items',
  'cf_production_steps', 'cf_step_dependencies', 'cf_material_requirements'].filter((t) => t in before);
console.log('        census of the tables the fixture writes (before -> after):');
for (const t of touched) console.log(`          ${t.padEnd(28)} ${String(before[t]).padStart(7)} -> ${String(afterCensus[t]).padStart(7)}`);
ok(`every cf_ table (${TABLES.length}) is back to the count it started at`, left.length === 0, left.join(', '));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) console.log(`failed: ${fails.join(' · ')}`);
await pool.end();
process.exitCode = failed ? 1 : 0;
