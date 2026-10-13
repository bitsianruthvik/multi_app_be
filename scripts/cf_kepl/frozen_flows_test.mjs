/**
 * frozen_flows_test.mjs — a frozen order line keeps its own copy of every flow it uses
 * (init.sql §60, services/frozenFlowService.js). Against the local database.
 *
 *   cd multi_app_be && node scripts/cf_kepl/frozen_flows_test.mjs
 *   CF_TEST_COMPANY=1 node scripts/cf_kepl/frozen_flows_test.mjs     (default company 2)
 *
 * User, 2026-10-12: "Once the order passes through freeze design nothing should change. Before
 * that it can change." So: before lock a change to a catalog flow reaches the line; after lock it
 * does not — a step added, a step removed, an operation swapped, a wait changed, the flow made
 * obsolete — and release makes its production steps from the line's copies.
 *
 * EVERYTHING HAPPENS INSIDE ONE TRANSACTION THAT IS ROLLED BACK, and every cf_ table is re-counted.
 * IT OWNS ITS FIXTURE — classification, operations, flows, templates, a catalog item, customer,
 * orders — every name and code carrying this run's tag (uq_ccn_sibling is unique on NAME). The
 * company's own coding rules are switched off for the transaction, so pieces take the built-in code.
 *
 *   GIRDER (flow F1: A → B, B waits for every piece below it to finish C)
 *     SEGMENT x1          (F1 too — two rows, ONE copy)
 *       WEB x2            (F2: C; E is added before the lock)        → plate stock
 *       PART ONE x1       (no flow — given one AFTER the freeze)     → plate stock
 *       PART TWO x1       (no flow — given one AFTER the freeze)     → plate stock
 *       BRACKET x1        a CATALOG item made on the order (F3: D)   → plate stock
 */
import path from 'path';
import { pathToFileURL } from 'url';

const BE = process.cwd();
const imp = (p) => import(pathToFileURL(path.join(BE, p)).href);
const { pool } = await imp('db.js');
if (!/^(localhost|127\.0\.0\.1|::1)$/.test(process.env.DB_HOST ?? 'localhost')) throw new Error('This suite is local only.');
await imp('apps/cf_erp/services/codegenProvider.js');
const { attachNodeCache, detachNodeCache } = await imp('apps/cf_erp/lib/db.js');
const B = await imp('apps/cf_erp/services/bomService.js');
const BC = await imp('apps/cf_erp/services/bomChangeService.js');
const REL = await imp('apps/cf_erp/services/releaseService.js');
const LOCK = await imp('apps/cf_erp/services/lockService.js');
const SO = await imp('apps/cf_erp/services/salesOrderService.js');
const MR = await imp('apps/cf_erp/services/masterRecordService.js');
const OV = await imp('apps/cf_erp/services/orderValuesService.js');
const TE = await imp('apps/cf_erp/services/timeEstimateService.js');
const WO = await imp('apps/cf_erp/services/workOrderService.js');
const REV = await imp('apps/cf_erp/services/revisionService.js');
const ROLL = await imp('apps/cf_erp/services/rollOutService.js');
const FF = await imp('apps/cf_erp/services/frozenFlowService.js');
const { createNode } = await imp('apps/cf_erp/services/classificationService.js');
const OPS = await imp('apps/cf_erp/services/operationService.js');
const FLOWS = await imp('apps/cf_erp/services/flowService.js');
const AREAS = await imp('apps/cf_erp/services/stockingAreaService.js');
const PARTIES = await imp('apps/cf_erp/modules/parties/service.js');
const { backfillFrozenFlows } = await imp('scripts/cf_kepl/freeze-flows-backfill.mjs');

const COMPANY = Number(process.env.CF_TEST_COMPANY ?? 2);

/* --------------------------------------------------------------------------
 * A tiny harness
 * ----------------------------------------------------------------------- */
let passed = 0;
let failed = 0;
const fails = [];
/** ok(label, cond, detail?) — a string and then a boolean, so a swapped call throws instead of passing. */
function ok(label, cond, detail = '') {
  if (typeof label !== 'string' || typeof cond !== 'boolean') throw new Error(`ok(label, cond) takes a string and then a boolean — got ok(${typeof label}, ${typeof cond})`);
  if (cond) { passed += 1; console.log(`  PASS  ${label}`); } else { failed += 1; fails.push(label); console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (label, got, want) => ok(label, Object.is(got, want), `got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);
const same = (label, got, want) => ok(label, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)?.slice(0, 500)}, wanted ${JSON.stringify(want)?.slice(0, 500)}`);
const section = (s) => console.log(`\n${s}`);
const refusal = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };
const FROZEN_WORDS = /design is frozen, so the flow of .* cannot change\. Make a new revision of the order to change it\.$/;

async function cfTables(db) {
  const [rows] = await db.query("SHOW TABLES LIKE 'cf\\_%'");
  return rows.map((r) => Object.values(r)[0]).sort();
}
async function census(db, tables) {
  const out = {};
  for (const t of tables) out[t] = Number((await db.query(`SELECT COUNT(*) AS n FROM \`${t}\``))[0][0].n);
  return out;
}
/** Counts the round trips made through it (a Proxy, so the transaction's node cache still rides on the connection). */
function counting(db) {
  const tally = { n: 0 };
  return { tally, db: new Proxy(db, { get: (target, prop) => (prop === 'query' ? (...args) => { tally.n += 1; return target.query(...args); } : Reflect.get(target, prop)) }) };
}

const tag = `FZ${Date.now().toString(36).toUpperCase()}`;
console.log(`frozen_flows_test — company ${COMPANY}, fixture tag ${tag}`);
ok('ok(cond, label) throws instead of passing', (await refusal(() => ok(true, 'swapped'))) instanceof Error);

const TABLES = await cfTables(pool);
const before = await census(pool, TABLES);
const conn = await pool.getConnection();
try {
  await conn.beginTransaction();
  attachNodeCache(conn);
  const c = { companyId: COMPANY, userId: null };
  const [rivals] = await conn.query("SELECT id FROM cf_code_schemes WHERE company_id = ? AND entity_type IN ('item', 'production_piece') AND status = 'active' AND deleted_at IS NULL", [COMPANY]);
  if (rivals.length) await conn.query("UPDATE cf_code_schemes SET status = 'inactive' WHERE company_id = ? AND id IN (?)", [COMPANY, rivals.map((r) => r.id)]);

  /* ---- the fixture ---------------------------------------------------------------- */
  const fam = await createNode(conn, c, { code: `${tag}-F`, name: `Frozen flows ${tag}` });
  const sub = await createNode(conn, c, { parentId: fam.id, code: `${tag}-S`, name: `Frozen flows kinds ${tag}` });
  const v = {};
  for (const [key, code, name] of [['assy', 'VA', 'Assemblies'], ['seg', 'VS', 'Segments'], ['part', 'VP', 'Parts'], ['bought', 'VB', 'Brackets'], ['mat', 'VM', 'Material']]) {
    v[key] = await createNode(conn, c, { parentId: sub.id, code: `${tag}-${code}`, name: `${name} ${tag}` });
  }
  const op = {};
  for (const k of ['A', 'B', 'C', 'D', 'E', 'G', 'N', 'X']) op[k] = (await OPS.createOperation(conn, c, { code: `${tag}-${k}`, name: `${tag} op ${k}` })).id;
  const letter = new Map(Object.entries(op).map(([k, id]) => [Number(id), k]));
  const letters = (ids) => ids.map((id) => letter.get(Number(id)) ?? `?${id}`).join('');

  /** A catalog flow, saved by the flow page's one save: the steps a chain in list order, so it is LINKED. */
  const makeFlow = async (code, steps) => {
    const f = await FLOWS.createFlow(conn, c, { code: `${tag}-${code}`, name: `Flow ${code} ${tag}` });
    await FLOWS.applyFlowChanges(conn, c, f.id, { steps });
    await FLOWS.setFlowStatus(conn, c, f.id, 'active');
    return f.id;
  };
  const F1 = await makeFlow('F1', [{ operationId: op.A }, { operationId: op.B, stepName: 'Second', waits: [{ relation: 'descendants', targetOperationId: op.C, requiredStatus: 'done' }] }]);
  const F2 = await makeFlow('F2', [{ operationId: op.C }]);
  const F3 = await makeFlow('F3', [{ operationId: op.D }]);
  const F4 = await makeFlow('F4', [{ operationId: op.G }]);

  const mat = await MR.createItem(conn, c, { itemType: 'catalog', classificationId: v.mat.id, code: `${tag}-MAT`, name: `Plate stock ${tag}`, shortName: 'MAT', uom: 'kg', status: 'active' });
  const bracket = await MR.createItem(conn, c, { itemType: 'catalog', classificationId: v.bought.id, code: `${tag}-BRK`, name: `Bracket ${tag}`, shortName: `BK${tag}`, uom: 'nos', sourcing: 'make', status: 'active' });
  await MR.updateRecord(conn, c, bracket.id, { defaultFlowId: F3 });
  await B.addLine(conn, c, bracket.id, { childId: mat.id, quantity: 2 });
  await B.setBomStatus(conn, c, bracket.id, 'active');
  const tpl = async (code, name, shortName, classificationId, flowId) => {
    const d = await MR.createDefinition(conn, c, { definitionType: 'template', classificationId, code: `${tag}-${code}`, name: `${name} ${tag}`, shortName, status: 'active' });
    if (flowId) await MR.updateRecord(conn, c, d.id, { defaultFlowId: flowId });
    return d;
  };
  const WB = await tpl('WB', 'Web', 'WB', v.part.id, F2);
  const P1 = await tpl('P1', 'Part one', 'PA', v.part.id, null);
  const P2 = await tpl('P2', 'Part two', 'PB', v.part.id, null);
  const SG = await tpl('SG', 'Segment', 'SG', v.seg.id, F1);
  const GR = await tpl('GR', 'Girder', `G${tag}`, v.assy.id, F1);
  for (const t of [WB, P1, P2]) { await B.addLine(conn, c, t.id, { childId: mat.id, quantity: 1.5 }); await B.setBomStatus(conn, c, t.id, 'active'); }
  await B.addLine(conn, c, SG.id, { childId: WB.id, quantity: 2, role: 'Webs' });
  await B.addLine(conn, c, SG.id, { childId: P1.id, quantity: 1, role: 'Part one' });
  await B.addLine(conn, c, SG.id, { childId: P2.id, quantity: 1, role: 'Part two' });
  await B.addLine(conn, c, SG.id, { childId: bracket.id, quantity: 1, role: 'Bracket' });
  await B.setBomStatus(conn, c, SG.id, 'active');
  await B.addLine(conn, c, GR.id, { childId: SG.id, quantity: 1, role: 'Segment' });
  await B.setBomStatus(conn, c, GR.id, 'active');
  const party = await PARTIES.createParty(conn, c, { code: `${tag}-CUST`, name: `Frozen flows customer ${tag}`, roles: ['customer'] });
  const area = await AREAS.createArea(conn, c, { code: `${tag}-DSP`, name: `Dispatch ${tag}`, purpose: 'dispatch' });

  /** An order of one girder per quantity given; each line with its rows by template. */
  const makeOrder = async (suffix, lines = 1) => {
    const order = await SO.createOrder(conn, c, { orderType: 'customer', customerId: party.id, code: `${tag}-SO${suffix}`, title: `Frozen flows ${suffix} ${tag}`, committedDate: '2026-12-31' });
    let o = order;
    for (let i = 0; i < lines; i++) o = await SO.addOrderLine(conn, c, order.id, { recordId: GR.id, quantity: 1 });
    await SO.setOrderStatus(conn, c, order.id, 'confirmed');
    return { id: order.id, lines: await Promise.all(o.lines.map((l) => rowsOfLine(l.id))) };
  };
  /** The line's rows: its item, each row by the template it came from, and each row's BOM line. */
  const rowsOfLine = async (lineId) => {
    const [[line]] = await conn.query('SELECT id, order_id, item_id FROM cf_sales_order_lines WHERE id = ?', [lineId]);
    const [rows] = await conn.query(
      `SELECT m.id, i.source_definition_id AS def, (SELECT bl.id FROM cf_bom_lines bl WHERE bl.company_id = m.company_id AND bl.child_id = m.id AND bl.deleted_at IS NULL LIMIT 1) AS bom_line
         FROM cf_master_records m JOIN cf_item_details i ON i.master_id = m.id AND i.deleted_at IS NULL
        WHERE i.company_id = ? AND i.owner_order_line_id = ? AND m.deleted_at IS NULL`, [COMPANY, lineId]);
    const of = (d) => rows.find((r) => Number(r.def) === Number(d.id));
    return { id: lineId, orderId: line.order_id, GR: of(GR), SG: of(SG), WB: of(WB), P1: of(P1), P2: of(P2) };
  };
  const fillValues = async (lineId) => {
    const view = await OV.readLineValues(conn, COMPANY, lineId);
    const missing = [];
    for (const g of view.groups) for (const r of g.rows) for (const [code, cell] of Object.entries(r.cells)) if (cell.missing) missing.push({ recordId: r.id, specCode: code, value: 1 });
    if (missing.length) await OV.writeLineValues(conn, c, lineId, { writes: missing });
  };
  const lock = async (line) => { await fillValues(line.id); return LOCK.lockLine(conn, c, line.id); };
  /** What the Times grid shows: each row's operations, by the item the row is — "GR:AB SG:AB WB:C …". */
  const grid = async (line) => {
    const t = await TE.getLineTimes(conn, COMPANY, line.orderId, line.id);
    const name = new Map([[line.GR.id, 'GR'], [line.SG.id, 'SG'], [line.WB.id, 'WB'], [line.P1.id, 'P1'], [line.P2.id, 'P2'], [bracket.id, 'BK']]);
    return t.rows.filter((r) => name.has(r.itemId)).map((r) => `${name.get(r.itemId)}:${letters(Object.keys(r.cells).map(Number).sort((a, b) => a - b))}`).join(' ');
  };
  const copiesOf = async (lineId) => (await conn.query(
    'SELECT id, code, name, revision, status, linked, source_flow_id, source_revision FROM cf_operation_flows WHERE company_id = ? AND owner_order_line_id = ? AND deleted_at IS NULL ORDER BY source_flow_id', [COMPANY, lineId]))[0];
  /** A flow as it reads: its steps in order with the steps each starts after and its waits — no ids, so a copy can be compared with its source. */
  const picture = async (flowId) => {
    const f = await FLOWS.getFlow(conn, COMPANY, flowId);
    const at = new Map(f.steps.map((s) => [s.id, `${letter.get(s.operation.id)}${s.sequence}`]));
    return JSON.stringify(f.steps.map((s) => ({ op: at.get(s.id), lane: s.lane, name: s.stepName, after: s.after.map((a) => at.get(a)).sort(),
      waits: s.waits.map((w) => `${w.relation}:${w.targetOperation ? letter.get(w.targetOperation.id) : '-'}:${w.requiredStatus}`).sort() })));
  };
  const keep = (s, extra = {}) => ({ id: s.id, operationId: s.operation.id, ...extra });

  const O1 = await makeOrder('A');
  const L1 = O1.lines[0];
  const O2 = await makeOrder('B');
  const L2 = O2.lines[0];

  /* ---- 1. before the freeze ------------------------------------------------------- */
  section('1. Before the freeze, a change to a catalog flow reaches the line');
  eq('the Times grid shows each row\'s flow as the catalog has it', await grid(L1), 'GR:AB SG:AB WB:C P1: P2: BK:D');
  let f2 = await FLOWS.getFlow(conn, COMPANY, F2);
  await FLOWS.applyFlowChanges(conn, c, F2, { steps: [keep(f2.steps[0]), { operationId: op.E }] });
  eq('a step added to the web\'s flow shows on the unfrozen line', await grid(L1), 'GR:AB SG:AB WB:CE P1: P2: BK:D');
  same('no flow is copied for a line that is not frozen', (await copiesOf(L1.id)).length, 0);
  same('the Structure tab: flows open, any of them', [(await SO.lineStructure(conn, COMPANY, L1.id)).order.flowsEditable, (await SO.lineStructure(conn, COMPANY, L1.id)).order.flowsFillOnly], [true, false]);

  /* ---- 2. the freeze copies ------------------------------------------------------- */
  section('2. Freezing the line copies every flow it uses — once');
  await lock(L1);
  let copies = await copiesOf(L1.id);
  const copyOf = () => new Map(copies.map((r) => [Number(r.source_flow_id), Number(r.id)]));
  same('three flows, three copies: the girder and its segment share ONE; the catalog bracket\'s is copied too', copies.map((r) => Number(r.source_flow_id)), [F1, F2, F3].sort((a, b) => a - b));
  const [[srcF1]] = await conn.query('SELECT code, name, revision, status, linked FROM cf_operation_flows WHERE id = ?', [F1]);
  const c1 = copies.find((r) => Number(r.source_flow_id) === F1);
  same('a copy keeps its flow\'s code, name, revision label, status and lanes', [c1.code, c1.name, c1.revision, c1.status, c1.linked], [srcF1.code, srcF1.name, srcF1.revision, srcF1.status, srcF1.linked]);
  eq('…and says which revision it was copied at', c1.source_revision, srcF1.revision);
  for (const [name, src] of [['F1', F1], ['F2', F2], ['F3', F3]]) {
    eq(`${name}: the copy reads exactly as the flow does — steps, what each starts after, waits`, await picture(copyOf().get(src)), await picture(src));
  }
  const [stepIds] = await conn.query('SELECT s.id, s.flow_id FROM cf_operation_flow_steps s WHERE s.company_id = ? AND s.flow_id IN (?) AND s.deleted_at IS NULL', [COMPANY, [F1, ...copies.map((r) => r.id)]]);
  ok('the copy has steps of its own (no step is shared with the catalog flow)', new Set(stepIds.map((s) => s.id)).size === stepIds.length && stepIds.filter((s) => Number(s.flow_id) === copyOf().get(F1)).length === 2);
  eq('no row of the line was repointed: they still name the catalog flows',
    JSON.stringify((await conn.query('SELECT id, default_flow_id FROM cf_master_records WHERE id IN (?) ORDER BY id', [[L1.GR.id, L1.SG.id, L1.WB.id, bracket.id]]))[0].map((r) => Number(r.default_flow_id))),
    JSON.stringify([[L1.GR.id, F1], [L1.SG.id, F1], [L1.WB.id, F2], [bracket.id, F3]].sort((a, b) => a[0] - b[0]).map((x) => x[1])));
  const again = counting(conn);
  const second = await FF.ensureLineFlowCopies(again.db, c, L1.id, { flowIds: [F1, F2, F3] });
  same('asked again, nothing is copied — in ONE round trip', [second.copied, again.tally.n, (await copiesOf(L1.id)).length], [0, 1, 3]);
  const third = await FF.ensureLineFlowCopies(conn, c, L1.id);
  same('…nor when it reads the structure itself', [third.copied, (await copiesOf(L1.id)).length], [0, 3]);
  const map = await FF.frozenFlowMap(conn, COMPANY, [L1.id, L2.id]);
  same('frozenFlowMap: the frozen line\'s copies by source; the unfrozen line is not in it', [[...map.keys()], [...map.get(L1.id).keys()].sort((a, b) => a - b)], [[L1.id], [F1, F2, F3].sort((a, b) => a - b)]);
  eq('the grid of the frozen line reads the same as before the freeze', await grid(L1), 'GR:AB SG:AB WB:CE P1: P2: BK:D');

  /* ---- 3. a copy is not a catalog flow -------------------------------------------- */
  section('3. A copy is in no list, cannot be picked and cannot be edited');
  const copyIds = new Set(copies.map((r) => Number(r.id)));
  const listed = await FLOWS.listFlows(conn, COMPANY, {});
  ok('listFlows shows none of the copies', !listed.some((f) => copyIds.has(Number(f.id))));
  eq('…and each of the fixture\'s flows once', listed.filter((f) => f.code.startsWith(`${tag}-`)).length, 4);
  eq('searching by the code finds the catalog flow only', (await FLOWS.listFlows(conn, COMPANY, { search: `${tag}-F1` })).length, 1);
  const opA = await OPS.getOperation(conn, COMPANY, op.A);
  same('an operation\'s "used in flows" names the catalog flow once', opA.flows.map((f) => Number(f.id)), [F1]);
  eq('…and counts it once', (await OPS.listOperations(conn, COMPANY, { search: `${tag}-A` }))[0].flowCount, 1);
  const pick = [];
  eq('a copy cannot be picked for a record or a BOM line', await FLOWS.requireUsableFlow(conn, COMPANY, copyOf().get(F1), pick), null);
  ok('…"That flow does not exist."', pick[0] === 'That flow does not exist.', pick.join(' | '));
  const dup = await refusal(() => FLOWS.createFlow(conn, c, { code: `${tag}-F1`, name: 'Second F1' }));
  ok('the catalog still refuses a second flow of that code (uq_cof_catalog_code)', dup?.code === 'ER_DUP_ENTRY' && /uq_cof_catalog_code/.test(dup?.message ?? ''), dup ? `${dup.code}: ${dup.message}` : 'it was accepted');
  const cF1 = await FLOWS.getFlow(conn, COMPANY, copyOf().get(F1));
  const refusedCopy = (label, err) => ok(`refused on a copy: ${label}`, err?.code === 'FROZEN_FLOW_COPY' && err?.status === 409, err ? `${err.code}: ${err.message}` : 'it was accepted');
  refusedCopy('saving its steps', await refusal(() => FLOWS.applyFlowChanges(conn, c, cF1.id, { steps: [keep(cF1.steps[0])] })));
  refusedCopy('adding a step', await refusal(() => FLOWS.addStep(conn, c, copyOf().get(F3), { operationId: op.N })));   // refused as a copy before it is refused for its lanes
  refusedCopy('changing a step', await refusal(() => FLOWS.updateStep(conn, c, cF1.steps[0].id, { stepName: 'Renamed' })));
  refusedCopy('replacing a step\'s operation', await refusal(() => FLOWS.replaceStepOperation(conn, c, cF1.steps[0].id, { operationId: op.X })));
  refusedCopy('moving a step', await refusal(() => FLOWS.moveStep(conn, c, cF1.steps[0].id, { direction: 'down' })));
  refusedCopy('removing a step', await refusal(() => FLOWS.removeStep(conn, c, cF1.steps[0].id)));
  refusedCopy('adding a wait', await refusal(() => FLOWS.addWaitRule(conn, c, cF1.steps[0].id, { relation: 'parent' })));
  refusedCopy('removing a wait', await refusal(() => FLOWS.removeWaitRule(conn, c, cF1.steps[1].waits[0].id)));
  refusedCopy('renaming it', await refusal(() => FLOWS.updateFlow(conn, c, cF1.id, { name: 'Other' })));
  refusedCopy('making it obsolete', await refusal(() => FLOWS.setFlowStatus(conn, c, cF1.id, 'obsolete')));
  refusedCopy('revising it', await refusal(() => FLOWS.reviseFlow(conn, c, cF1.id, {})));
  refusedCopy('deleting it', await refusal(() => FLOWS.deleteFlow(conn, c, cF1.id)));
  eq('…after all of that it still reads exactly as the flow it was copied from', await picture(cF1.id), await picture(F1));

  /* ---- 4. a line frozen before copies existed: release makes them ------------------- */
  section('4. A line frozen before §60 has no copies — release makes them, and so does the backfill');
  const O3 = await makeOrder('C');
  const L3 = O3.lines[0];
  await lock(L3);
  await conn.query('UPDATE cf_operation_flows SET deleted_at = NOW() WHERE company_id = ? AND owner_order_line_id = ?', [COMPANY, L3.id]);   // as if locked before §60
  eq('with no copies the line reads the catalog (the old behaviour)', (await copiesOf(L3.id)).length, 0);
  await MR.updateRecord(conn, c, L3.P1.id, { defaultFlowId: F4 });
  await MR.updateRecord(conn, c, L3.P2.id, { defaultFlowId: F4 });
  same('a flow given to a row with none is copied at once — that flow only', (await copiesOf(L3.id)).map((r) => Number(r.source_flow_id)), [F4]);
  const rel3 = await REL.releaseLine(conn, c, L3.id, { finishedAreaId: area.id });
  const copies3 = await copiesOf(L3.id);
  same('release copied the three it lacked', copies3.map((r) => Number(r.source_flow_id)), [F1, F2, F3, F4].sort((a, b) => a - b));
  const [items3] = await conn.query('SELECT flow_id FROM cf_production_items WHERE company_id = ? AND release_id = ? AND deleted_at IS NULL', [COMPANY, rel3.id]);
  ok('…and every production piece was released from one of the line\'s own copies', items3.length === 6 && items3.every((r) => copies3.some((x) => Number(x.id) === Number(r.flow_id))), JSON.stringify(items3));

  const O4 = await makeOrder('D');
  const L4 = O4.lines[0];
  await lock(L4);
  await conn.query('UPDATE cf_operation_flows SET deleted_at = NOW() WHERE company_id = ? AND owner_order_line_id = ?', [COMPANY, L4.id]);
  const quiet = () => {};
  const run1 = await backfillFrozenFlows(conn, { companyId: COMPANY, log: quiet });
  const mine = (run) => run.lines.find((l) => Number(l.lineId) === Number(L4.id));
  same('the backfill copies the three flows of the line that had none', [mine(run1)?.copied, mine(run1)?.had, (await copiesOf(L4.id)).length], [3, 0, 3]);
  same('…and leaves the lines that have theirs alone', [run1.lines.find((l) => Number(l.lineId) === Number(L1.id))?.copied, run1.lines.find((l) => Number(l.lineId) === Number(L3.id))?.copied], [0, 0]);
  const flowsBefore = Number((await conn.query('SELECT COUNT(*) AS n FROM cf_operation_flows WHERE company_id = ?', [COMPANY]))[0][0].n);
  const run2 = await backfillFrozenFlows(conn, { companyId: COMPANY, log: quiet });
  same('run again it copies nothing, for any line of the company', [run2.totals.copied, mine(run2)?.had, Number((await conn.query('SELECT COUNT(*) AS n FROM cf_operation_flows WHERE company_id = ?', [COMPANY]))[0][0].n)], [0, 3, flowsBefore]);

  /* ---- 5. the catalog changes after the freeze ------------------------------------ */
  section('5. After the freeze the catalog changes — a step added, one removed, an operation swapped, a wait changed, a flow obsolete');
  const lockedGrid = await grid(L1);
  const assignBefore = JSON.stringify((await WO.getAssignment(conn, COMPANY, O1.id, L1.id)).operations);
  const preview0 = await REL.releasePreview(conn, COMPANY, L1.id);
  // A time typed for the segment's B on the frozen line and on the unfrozen one.
  for (const l of [L1, L2]) await conn.query('INSERT INTO cf_time_overrides SET ?', [{ company_id: COMPANY, order_line_id: l.id, bom_line_id: l.SG.bom_line, operation_id: op.B, work_minutes: 5 }]);
  const overrideOp = async (l) => Number((await conn.query('SELECT operation_id FROM cf_time_overrides WHERE company_id = ? AND order_line_id = ? AND bom_line_id = ? AND deleted_at IS NULL', [COMPANY, l.id, l.SG.bom_line]))[0][0].operation_id);

  let f1 = await FLOWS.getFlow(conn, COMPANY, F1);
  const sA = f1.steps.find((s) => s.operation.id === op.A), sB = f1.steps.find((s) => s.operation.id === op.B);
  const r1 = await FLOWS.applyFlowChanges(conn, c, F1, { steps: [keep(sA), { id: sB.id, operationId: op.X, waits: [{ relation: 'descendants', targetOperationId: op.E, requiredStatus: 'started' }] }, { operationId: op.N }] });
  same('F1 in the catalog: B swapped for X, N added, the wait replaced', [r1.changes.replaced, r1.changes.added, r1.changes.waitsAdded, r1.changes.waitsRemoved], [1, 1, 1, 1]);
  f2 = await FLOWS.getFlow(conn, COMPANY, F2);
  await FLOWS.applyFlowChanges(conn, c, F2, { steps: [keep(f2.steps.find((s) => s.operation.id === op.C))] });
  const f3 = await FLOWS.getFlow(conn, COMPANY, F3);
  await FLOWS.applyFlowChanges(conn, c, F3, { steps: [keep(f3.steps[0]), { operationId: op.N }] });
  await FLOWS.setFlowStatus(conn, c, F3, 'obsolete');
  eq('the UNFROZEN line follows every change', await grid(L2), 'GR:ANX SG:ANX WB:C P1: P2: BK:DN');
  eq('the FROZEN line shows exactly what it showed at the freeze', await grid(L1), lockedGrid);
  eq('…its contractor grid has the same operations', JSON.stringify((await WO.getAssignment(conn, COMPANY, O1.id, L1.id)).operations), assignBefore);
  eq('the copy of F1 still reads A → B with its wait', await picture(copyOf().get(F1)), JSON.stringify([{ op: 'A10', lane: 0, name: null, after: [], waits: [] }, { op: 'B20', lane: 0, name: 'Second', after: ['A10'], waits: ['descendants:C:done'] }]));
  eq('the copy of the obsolete F3 is still active', (await copiesOf(L1.id)).find((r) => Number(r.source_flow_id) === F3).status, 'active');
  same('the swap moved the unfrozen line\'s typed time to X; the frozen line\'s stays on B', [letter.get(await overrideOp(L2)), letter.get(await overrideOp(L1))], ['X', 'B']);
  ok('…and the save said one moved, not two', /Moved to the new operation: 1 time override\./.test(r1.summary), r1.summary);
  const [[lineRow]] = await conn.query('SELECT l.*, o.code AS order_code, o.order_type FROM cf_sales_order_lines l JOIN cf_sales_orders o ON o.id = l.order_id WHERE l.id = ?', [L1.id]);
  const rolled = await ROLL.rollOutPlan(conn, COMPANY, lineRow);
  ok('the roll-out hands every node the COPY\'s flow id (release, its preview and the planner read from it)',
    rolled.nodes.filter((n) => n.flowId != null).length === 4 && rolled.nodes.every((n) => n.flowId == null || copyIds.has(Number(n.flowId))), JSON.stringify(rolled.nodes.map((n) => n.flowId)));
  const preview1 = await REL.releasePreview(conn, COMPANY, L1.id);
  same('the release preview says what it said before the catalog changed', preview1.problems, preview0.problems);
  ok('…no word about an obsolete flow — only the two parts that have no flow yet', preview1.problems.length === 2 && preview1.problems.every((p) => /has no flow/.test(p)), preview1.problems.join(' | '));

  /* ---- 6. the frozen line's own flows: filled in, never changed --------------------- */
  section('6. On the frozen line a row that has a flow keeps it; a row with none may be given one');
  const st = (await SO.lineStructure(conn, COMPANY, L1.id)).order;
  same('the Structure tab: flows open only to fill in a missing one', [st.flowsEditable, st.flowsFillOnly, st.locked], [true, true, true]);
  const frozen = (label, err) => ok(`refused: ${label}`, err?.code === 'FLOW_FROZEN' && FROZEN_WORDS.test(err?.message ?? ''), err ? `${err.code}: ${err.message}` : 'it was accepted');
  frozen('another flow for the web', await refusal(() => MR.updateRecord(conn, c, L1.WB.id, { defaultFlowId: F4 })));
  frozen('no flow for the web', await refusal(() => MR.updateRecord(conn, c, L1.WB.id, { defaultFlowId: null })));
  frozen('the web\'s BOM line naming another flow', await refusal(() => B.updateLine(conn, c, L1.WB.bom_line, { operationFlowId: F4 })));
  const batch = (changes, more = {}) => BC.applyBomChanges(conn, c, { scope: { orderLineId: L1.id }, changes, ...more });
  const b1 = await refusal(() => batch([{ op: 'ownFlow', recordId: L1.WB.id, flowId: F4 }], { dryRun: true }));
  ok('edit mode says it as a problem, in the same sentence — own flow', (b1?.problems ?? []).length === 1 && FROZEN_WORDS.test(b1.problems[0]), JSON.stringify(b1?.problems ?? b1?.message));
  const b2 = await refusal(() => batch([{ op: 'flow', lineId: L1.WB.bom_line, flowId: F4 }]));
  ok('…and a line\'s flow', (b2?.problems ?? []).length === 1 && FROZEN_WORDS.test(b2.problems[0]), JSON.stringify(b2?.problems ?? b2?.message));
  eq('the web keeps its flow', Number((await conn.query('SELECT default_flow_id FROM cf_master_records WHERE id = ?', [L1.WB.id]))[0][0].default_flow_id), F2);
  const pointAtCopy = await refusal(() => MR.updateRecord(conn, c, L1.P1.id, { defaultFlowId: copyOf().get(F2) }));
  ok('a row cannot be pointed at a copy', (pointAtCopy?.problems ?? []).includes('That flow does not exist.'), JSON.stringify(pointAtCopy?.problems ?? pointAtCopy?.message));
  const fill1 = await batch([{ op: 'ownFlow', recordId: L1.P1.id, flowId: F4 }]);
  same('part one, which had no flow, is given one (edit mode)', [fill1.applied, fill1.results[0].changed, Number((await conn.query('SELECT default_flow_id FROM cf_master_records WHERE id = ?', [L1.P1.id]))[0][0].default_flow_id)], [true, true, F4]);
  copies = await copiesOf(L1.id);
  same('…and the line takes its own copy of that flow', copies.map((r) => Number(r.source_flow_id)), [F1, F2, F3, F4].sort((a, b) => a - b));
  await B.updateLine(conn, c, L1.P2.bom_line, { operationFlowId: F4 });
  same('part two is given the same flow on its BOM line — no second copy', [Number((await conn.query('SELECT operation_flow_id FROM cf_bom_lines WHERE id = ?', [L1.P2.bom_line]))[0][0].operation_flow_id), (await copiesOf(L1.id)).length], [F4, 4]);
  frozen('changing the flow just given', await refusal(() => MR.updateRecord(conn, c, L1.P1.id, { defaultFlowId: F2 })));
  frozen('clearing the flow just given to the BOM line', await refusal(() => B.updateLine(conn, c, L1.P2.bom_line, { operationFlowId: null })));
  const f4 = await FLOWS.getFlow(conn, COMPANY, F4);
  await FLOWS.applyFlowChanges(conn, c, F4, { steps: [keep(f4.steps[0]), { operationId: op.N }] });
  eq('the flow given after the freeze is frozen too: a step added to it since does not show', await grid(L1), 'GR:AB SG:AB WB:CE P1:G P2:G BK:D');

  /* ---- 7. release ----------------------------------------------------------------- */
  section('7. Release makes the production steps from the copies');
  const rel = await REL.releaseLine(conn, c, L1.id, { finishedAreaId: area.id });
  ok('the line is released — though F3 is obsolete in the catalog and F1, F2 and F4 have changed', !!rel?.id);
  const [items] = await conn.query('SELECT id, item_id, flow_id FROM cf_production_items WHERE company_id = ? AND release_id = ? AND deleted_at IS NULL', [COMPANY, rel.id]);
  const [steps] = await conn.query(
    `SELECT s.production_item_id, s.operation_id, s.flow_step_id, fs.flow_id AS step_flow
       FROM cf_production_steps s JOIN cf_production_items pi ON pi.id = s.production_item_id
       LEFT JOIN cf_operation_flow_steps fs ON fs.id = s.flow_step_id
      WHERE s.company_id = ? AND pi.release_id = ? AND s.deleted_at IS NULL ORDER BY s.production_item_id, s.sequence, s.id`, [COMPANY, rel.id]);
  copies = await copiesOf(L1.id);
  const allCopyIds = new Set(copies.map((r) => Number(r.id)));
  ok('every production piece names one of the line\'s own copies', items.length === 6 && items.every((r) => allCopyIds.has(Number(r.flow_id))), JSON.stringify(items.map((r) => r.flow_id)));
  ok('every production step was copied from a step of that copy', steps.length > 0 && steps.every((s) => s.flow_step_id != null && allCopyIds.has(Number(s.step_flow))));
  const nameOfItem = new Map([[L1.GR.id, 'GR'], [L1.SG.id, 'SG'], [L1.WB.id, 'WB'], [L1.P1.id, 'P1'], [L1.P2.id, 'P2'], [bracket.id, 'BK']]);
  const opsOfItem = items.map((it) => `${nameOfItem.get(it.item_id)}:${letters(steps.filter((s) => s.production_item_id === it.id).map((s) => s.operation_id))}`).sort().join(' ');
  eq('the steps are the frozen ones — B not X, no N, the web still has E, the bracket only D', opsOfItem, 'BK:D GR:AB P1:G P2:G SG:AB WB:CE');
  const [deps] = await conn.query(
    `SELECT d.wait_rule_id, fs.flow_id FROM cf_step_dependencies d
       JOIN cf_production_steps s ON s.id = d.step_id JOIN cf_production_items pi ON pi.id = s.production_item_id
       JOIN cf_step_wait_rules w ON w.id = d.wait_rule_id JOIN cf_operation_flow_steps fs ON fs.id = w.flow_step_id
      WHERE d.company_id = ? AND pi.release_id = ? AND d.wait_rule_id IS NOT NULL AND d.deleted_at IS NULL`, [COMPANY, rel.id]);
  ok('the waits are the frozen ones too: the segment\'s B waits for the web\'s C, by the copy\'s own rule', deps.length >= 1 && deps.every((d) => allCopyIds.has(Number(d.flow_id))), JSON.stringify(deps));
  await REL.unrelease(conn, c, rel.id);
  same('a release taken back returns the line to frozen — with its copies', [(await copiesOf(L1.id)).length, await grid(L1)], [4, 'GR:AB SG:AB WB:CE P1:G P2:G BK:D']);
  const delF2 = await refusal(() => FLOWS.deleteFlow(conn, c, F2));
  ok('the catalog flow rows still name cannot be deleted (their pointers count, the copies do not)', delF2?.code === 'IN_USE' && !/copy/i.test(delF2?.message ?? ''), delF2 ? `${delF2.code}: ${delF2.message}` : 'it was deleted');

  /* ---- 8. a new revision reads the catalog again ------------------------------------ */
  section('8. A new revision of the order is not frozen: it reads the catalog flows as they are now');
  const rev = await REV.reviseOrder(conn, c, O1.id);
  const R1 = await rowsOfLine(rev.lines[0].id);
  const [ptrs] = await conn.query(
    `SELECT m.default_flow_id AS f FROM cf_master_records m JOIN cf_item_details i ON i.master_id = m.id AND i.deleted_at IS NULL WHERE i.company_id = ? AND i.owner_order_line_id = ? AND m.deleted_at IS NULL
     UNION ALL
     SELECT bl.operation_flow_id FROM cf_bom_lines bl JOIN cf_boms b ON b.id = bl.bom_id JOIN cf_item_details i ON i.master_id = b.parent_id AND i.deleted_at IS NULL
      WHERE i.company_id = ? AND i.owner_order_line_id = ? AND bl.deleted_at IS NULL`, [COMPANY, R1.id, COMPANY, R1.id]);
  const named = ptrs.map((p) => p.f).filter((x) => x != null).map(Number);
  ok('its rows name catalog flows — the pointers were copied as they were, none names a copy', named.length >= 5 && named.every((id) => [F1, F2, F4].includes(id)), JSON.stringify(named));
  eq('it owns no copy', (await copiesOf(R1.id)).length, 0);
  eq('…and its grid shows the flows as the catalog has them today', await grid(R1), 'GR:ANX SG:ANX WB:C P1:GN P2:GN BK:DN');
  const [[anyPtr]] = await conn.query(
    `SELECT (SELECT COUNT(*) FROM cf_master_records m JOIN cf_operation_flows f ON f.id = m.default_flow_id WHERE m.company_id = ? AND f.owner_order_line_id IS NOT NULL)
          + (SELECT COUNT(*) FROM cf_bom_lines bl JOIN cf_operation_flows f ON f.id = bl.operation_flow_id WHERE bl.company_id = ? AND f.owner_order_line_id IS NOT NULL) AS n`, [COMPANY, COMPANY]);
  eq('nowhere in the company does a record or a BOM line name a copy', Number(anyPtr.n), 0);

  /* ---- 9. round trips ---------------------------------------------------------------- */
  section('9. Copying costs the same number of round trips for one flow and for three');
  const O5 = await makeOrder('E', 2);
  const twoStep = (code) => makeFlow(code, [{ operationId: op.A }, { operationId: op.G, waits: [{ relation: 'parent' }] }]);
  const R = [await twoStep('R1'), await twoStep('R2'), await twoStep('R3')];
  const one = counting(conn);
  const got1 = await FF.ensureLineFlowCopies(one.db, c, O5.lines[0].id, { flowIds: [R[0]] });
  const three = counting(conn);
  const got3 = await FF.ensureLineFlowCopies(three.db, c, O5.lines[1].id, { flowIds: R });
  console.log(`        ensureLineFlowCopies: ${one.tally.n} round trips for 1 flow (2 steps, 1 link, 1 wait), ${three.tally.n} for 3 flows (6 steps, 3 links, 3 waits)`);
  same('one flow copied, then three', [got1.copied, got3.copied], [1, 3]);
  ok('the same round trips', one.tally.n === three.tally.n, `${one.tally.n} vs ${three.tally.n}`);
  ok('…eleven at most', three.tally.n <= 11, `${three.tally.n}`);
  for (const r of R) eq('each of the three reads as its flow does', await picture(got3.flows.get(r)), await picture(r));

  /* ---- 10. a flow that is not active yet ----------------------------------------------- */
  // A copy can never be changed or activated, so a DRAFT flow frozen as a draft could never be
  // released. Only an active flow is frozen; a draft one stays live and is copied once it is active.
  section('10. A draft flow is not frozen until it is active');
  const draft = await FLOWS.createFlow(conn, c, { code: `${tag}-DRAFT`, name: `Flow DRAFT ${tag}` });
  await FLOWS.applyFlowChanges(conn, c, draft.id, { steps: [{ operationId: op.A }] });
  const d1 = await FF.ensureLineFlowCopies(conn, c, O5.lines[0].id, { flowIds: [draft.id] });
  ok('a draft flow is not copied — the line still reads it live', d1.copied === 0 && !d1.flows.has(draft.id), JSON.stringify([d1.copied, [...d1.flows.keys()]]));
  await FLOWS.applyFlowChanges(conn, c, draft.id, { steps: [{ operationId: op.A }, { operationId: op.G }] });
  await FLOWS.setFlowStatus(conn, c, draft.id, 'active');
  const d2 = await FF.ensureLineFlowCopies(conn, c, O5.lines[0].id, { flowIds: [draft.id] });
  ok('once it is active it is copied, as it stands then', d2.copied === 1 && d2.flows.has(draft.id));
  eq('…with the step added while it was a draft', await picture(d2.flows.get(draft.id)), await picture(draft.id));

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

section('10. Nothing survived the rollback');
const after = await census(pool, TABLES);
const left = TABLES.filter((t) => before[t] !== after[t]).map((t) => `${t} ${before[t]}->${after[t]}`);
ok(`every cf_ table (${TABLES.length}) is back to the count it started at`, left.length === 0, left.join(', '));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) console.log(`failed: ${fails.join(' · ')}`);
await pool.end();
process.exitCode = failed ? 1 : 0;
