/**
 * flow_lanes_test.mjs — lanes on a RELEASED piece (init.sql §54): what release writes to
 * cf_step_dependencies is exactly what each step of the flow starts after.
 *
 *   cd multi_app_be && node scripts/cf_kepl/flow_lanes_test.mjs
 *   CF_TEST_COMPANY=1 node scripts/cf_kepl/flow_lanes_test.mjs      (default company 2)
 *
 * One assembly with three parts, each made by its own flow, locked and released:
 *
 *   SCEN    the user's scenario of 2026-10-10 — a trunk of 11 steps, lane 2 from S3 closing onto S7,
 *           a parallel of lane 2 (lane 3) closing back into lane 2, and the original third lane
 *           (now lane 4) closing into lane 3. 17 steps, 19 waits.
 *   LINKED  A → (B1 → B2 ‖ C1) → D saved through the lane editor's save: B2 waits for B1 ONLY.
 *   LEGACY  the same shape the old way — shared sequence numbers, never saved by the editor:
 *           B2 still waits for B1 AND C1, and D for B2 only. The old rule is untouched.
 *
 * The fixture is this run's own (every name carries its tag) and everything happens inside ONE
 * transaction that is rolled back; every cf_ table is re-counted at the end.
 */
import path from 'path';
import { pathToFileURL } from 'url';

const BE = process.cwd();
const imp = (p) => import(pathToFileURL(path.join(BE, p)).href);
const { pool } = await imp('db.js');
await imp('apps/cf_erp/services/codegenProvider.js');
const { attachNodeCache, detachNodeCache } = await imp('apps/cf_erp/lib/db.js');
const codegen = await imp('apps/cf_erp/modules/codegen/service.js');
const B = await imp('apps/cf_erp/services/bomService.js');
const REL = await imp('apps/cf_erp/services/releaseService.js');
const LOCK = await imp('apps/cf_erp/services/lockService.js');
const SO = await imp('apps/cf_erp/services/salesOrderService.js');
const MR = await imp('apps/cf_erp/services/masterRecordService.js');
const { createNode } = await imp('apps/cf_erp/services/classificationService.js');
const OPS = await imp('apps/cf_erp/services/operationService.js');
const FLOWS = await imp('apps/cf_erp/services/flowService.js');
const AREAS = await imp('apps/cf_erp/services/stockingAreaService.js');
const PARTIES = await imp('apps/cf_erp/modules/parties/service.js');

if (!/^(localhost|127\.0\.0\.1|::1)$/.test(process.env.DB_HOST ?? 'localhost')) throw new Error('This suite is local only.');
const COMPANY = Number(process.env.CF_TEST_COMPANY ?? 2);
const tag = `FL${Date.now().toString(36).toUpperCase()}`;
let passed = 0, failed = 0;
function ok(label, cond, detail = '') {
  if (typeof label !== 'string' || typeof cond !== 'boolean') throw new Error('ok(label, cond) takes a string and then a boolean');
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${!cond && detail ? ` — ${detail}` : ''}`);
  cond ? passed++ : failed++;
}
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const [tables] = await pool.query("SELECT TABLE_NAME name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME LIKE 'cf\\_%' ORDER BY TABLE_NAME");
const counts = async () => (await pool.query(tables.map((t) => `SELECT '${t.name}' AS name,COUNT(*) AS n FROM \`${t.name}\``).join(' UNION ALL ')))[0];
const before = await counts();

/** The scenario as it is saved: CODE -> [lane, [what it starts after]]. */
const SCEN = {
  S1: [0, []], S2: [0, ['S1']], S3: [0, ['S2']], S4: [0, ['S3']], S5: [0, ['S4']], S5B: [0, ['S5']], S6: [0, ['S5B']],
  S7: [0, ['S6', 'L2C']], S8: [0, ['S7']], S9: [0, ['S8']], S10: [0, ['S9']],
  L2A: [1, ['S3']], L2B: [1, ['L2A']], L2C: [1, ['L2B', 'N3B']],
  N3A: [2, ['L2A']], N3B: [2, ['N3A', 'L3A']],
  L3A: [3, ['S4']],
};
const SMALL = { A: [0, []], B1: [0, ['A']], C1: [1, ['A']], B2: [0, ['B1']], D: [0, ['B2', 'C1']] };

const conn = await pool.getConnection();
try {
  await conn.beginTransaction();
  attachNodeCache(conn);
  const c = { companyId: COMPANY, userId: null };
  // Only this run's coding rules may code its items and pieces.
  const [rivals] = await conn.query("SELECT id FROM cf_code_schemes WHERE company_id = ? AND entity_type IN ('item', 'production_piece') AND status = 'active' AND deleted_at IS NULL", [COMPANY]);
  if (rivals.length) await conn.query("UPDATE cf_code_schemes SET status = 'inactive' WHERE company_id = ? AND id IN (?)", [COMPANY, rivals.map((r) => r.id)]);

  const fam = await createNode(conn, c, { code: `${tag}-F`, name: `Lanes fixture ${tag}` });
  const sub = await createNode(conn, c, { parentId: fam.id, code: `${tag}-S`, name: `Lanes fixture kinds ${tag}` });
  const v = {};
  for (const [key, code, name] of [['assy', 'VA', 'Assemblies'], ['part', 'VP', 'Parts'], ['mat', 'VM', 'Material']]) {
    v[key] = await createNode(conn, c, { parentId: sub.id, code: `${tag}-${code}`, name: `${name} ${tag}` });
  }
  const opId = new Map();
  for (const code of [...Object.keys(SCEN), ...Object.keys(SMALL), 'ASM']) opId.set(code, (await OPS.createOperation(conn, c, { code: `${tag}-${code}`, name: `${code} ${tag}` })).id);
  const codeOfOp = new Map([...opId].map(([code, id]) => [id, code]));

  const save = async (flowCode, shape) => {
    const flow = await FLOWS.createFlow(conn, c, { code: `${tag}-${flowCode}`, name: `${flowCode} ${tag}` });
    await FLOWS.applyFlowChanges(conn, c, flow.id, { steps: Object.entries(shape).map(([code, [lane, after]]) => ({ key: code, operationId: opId.get(code), lane, after })) });
    return FLOWS.setFlowStatus(conn, c, flow.id, 'active');
  };
  const scen = await save('SCEN', SCEN);
  const linked = await save('LINKED', SMALL);
  // The same shape the old way: A 10 | B1 20, C1 20 | B2 30 | D 40 — numbers only, never saved by the editor.
  const legacyFlow = await FLOWS.createFlow(conn, c, { code: `${tag}-LEGACY`, name: `Legacy ${tag}` });
  for (const [code, sequence] of [['A', 10], ['B1', 20], ['C1', 20], ['B2', 30], ['D', 40]]) await FLOWS.addStep(conn, c, legacyFlow.id, { operationId: opId.get(code), sequence });
  const legacy = await FLOWS.setFlowStatus(conn, c, legacyFlow.id, 'active');
  const asmFlow = await save('ASM', { ASM: [0, []] });
  ok('the fixture: two flows saved with lanes are linked, the legacy one is not', scen.linked === true && linked.linked === true && legacy.linked === false);
  ok('the scenario flow reads back with 17 steps in 4 lanes', scen.steps.length === 17 && new Set(scen.steps.map((s) => s.lane)).size === 4);

  const mat = await MR.createItem(conn, c, { itemType: 'catalog', classificationId: v.mat.id, code: `${tag}-MAT`, name: `Plate stock ${tag}`, shortName: 'MAT', uom: 'kg', status: 'active' });
  const tpl = async (code, name, shortName, classificationId, flowId) => {
    const d = await MR.createDefinition(conn, c, { definitionType: 'template', classificationId, code: `${tag}-${code}`, name: `${name} ${tag}`, shortName, status: 'active' });
    await MR.updateRecord(conn, c, d.id, { defaultFlowId: flowId });
    return d;
  };
  const PS = await tpl('PS', 'Scenario part', 'PS', v.part.id, scen.id);
  const PL = await tpl('PL', 'Linked part', 'PL', v.part.id, linked.id);
  const PG = await tpl('PG', 'Legacy part', 'PG', v.part.id, legacy.id);
  const AS = await tpl('AS', 'Assembly', `AS${tag}`, v.assy.id, asmFlow.id);
  for (const t of [PS, PL, PG]) {
    await B.addLine(conn, c, t.id, { childId: mat.id, quantity: 1.5 });
    await B.setBomStatus(conn, c, t.id, 'active');
    await B.addLine(conn, c, AS.id, { childId: t.id, quantity: 1 });
  }
  await B.setBomStatus(conn, c, AS.id, 'active');

  const tok = (key, extra = {}) => ({ segmentType: 'token', tokenKey: key, transform: 'none', isRequired: true, ...extra });
  const lit = (text) => ({ segmentType: 'literal', literalText: text });
  const temporary = { tokenKey: 'kind', operator: 'eq', value: 'temporary' };
  const underFam = { tokenKey: 'classification', operator: 'under', value: String(fam.id) };
  const inside = { tokenKey: 'placement', operator: 'eq', value: 'component' };
  const onLine = { tokenKey: 'placement', operator: 'eq', value: 'line' };
  const rule = (code, body) => codegen.createScheme(conn, COMPANY, c.userId, { code: `${tag}-${code}`, name: `Lanes test ${code} ${tag}`, entityType: 'item', targetField: 'code', seqScope: 'prefix', priority: 0, status: 'active', ...body });
  await rule('LINE', { conditions: [temporary, onLine, underFam], segments: [tok('order.code'), lit('-'), tok('record.shortName'), tok('position', { format: '00' })] });
  await rule('PART', { conditions: [temporary, inside, underFam], segments: [tok('parent.code'), lit('-'), tok('record.shortName'), tok('range')] });
  await rule('PTOP', { entityType: 'production_piece', conditions: [temporary, onLine, underFam], segments: [tok('item.shortName'), lit('-'), tok('piece.seq')] });
  await rule('PPART', { entityType: 'production_piece', conditions: [inside, underFam], segments: [tok('parent.code'), lit('-'), tok('item.shortName'), tok('piece.seq')] });

  const party = await PARTIES.createParty(conn, c, { code: `${tag}-CUST`, name: `Lanes test customer ${tag}`, roles: ['customer'] });
  const order = await SO.createOrder(conn, c, { orderType: 'customer', customerId: party.id, code: `${tag}-SO`, title: `Lanes fixture ${tag}`, committedDate: '2026-12-31' });
  const line = (await SO.addOrderLine(conn, c, order.id, { recordId: AS.id, quantity: 1 })).lines[0];
  await SO.setOrderStatus(conn, c, order.id, 'confirmed');
  const area = await AREAS.createArea(conn, c, { code: `${tag}-DSP`, name: `Dispatch ${tag}`, purpose: 'dispatch' });
  const plan = await LOCK.lockPlan(conn, COMPANY, line.id);
  ok('the line can be locked', plan.canLock === true, (plan.problems ?? []).join(' | '));
  await LOCK.lockLine(conn, c, line.id);
  const check = await REL.releaseCheck(conn, COMPANY, line.id);
  ok('and released: no problem, no circle of waits', (check.problems ?? []).length === 0, (check.problems ?? []).join(' | '));
  await REL.releaseLine(conn, c, line.id, { finishedAreaId: area.id });
  const releaseId = (await REL.liveReleaseOfLine(conn, COMPANY, line.id))?.id;
  ok('the line is released', Number.isInteger(releaseId));

  // What release wrote: every step with the flow step it was copied from, and every wait.
  const [steps] = await conn.query(
    `SELECT s.id, s.production_item_id AS item, s.flow_step_id, s.operation_id, s.sequence, fs.flow_id
       FROM cf_production_steps s JOIN cf_production_items pi ON pi.id = s.production_item_id
       JOIN cf_operation_flow_steps fs ON fs.id = s.flow_step_id
      WHERE s.company_id = ? AND pi.release_id = ? AND s.deleted_at IS NULL ORDER BY s.id`, [COMPANY, releaseId]);
  const [deps] = await conn.query(
    `SELECT d.step_id, d.target_step_id, d.target_item_id, d.required, d.origin
       FROM cf_step_dependencies d JOIN cf_production_steps s ON s.id = d.step_id JOIN cf_production_items pi ON pi.id = s.production_item_id
      WHERE d.company_id = ? AND pi.release_id = ? AND d.deleted_at IS NULL`, [COMPANY, releaseId]);
  const stepById = new Map(steps.map((s) => [s.id, s]));
  const code = (s) => codeOfOp.get(s.operation_id);
  /** The waits written for the piece made by one flow: { CODE: [codes it waits for] }, and everything that is not a plain flow wait. */
  const waitsOf = (flowId) => {
    const mine = steps.filter((s) => s.flow_id === flowId);
    const out = Object.fromEntries(mine.map((s) => [code(s), []]));
    const odd = [];
    for (const d of deps) {
      const s = stepById.get(d.step_id);
      if (s.flow_id !== flowId) continue;
      const t = d.target_step_id != null ? stepById.get(d.target_step_id) : null;
      if (d.origin !== 'flow' || d.required !== 'done' || !t || t.item !== s.item) { odd.push(d); continue; }
      out[code(s)].push(code(t));
    }
    for (const k of Object.keys(out)) out[k].sort();
    return { waits: out, odd, steps: mine };
  };
  const wantOf = (shape) => Object.fromEntries(Object.entries(shape).map(([k, [, after]]) => [k, [...after].sort()]));
  const ordered = (o) => Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));

  const s1 = waitsOf(scen.id);
  const diff = Object.keys(SCEN).filter((k) => !sameJson(s1.waits[k], wantOf(SCEN)[k]));
  ok('SCENARIO: the released piece has 17 steps', s1.steps.length === 17);
  ok('SCENARIO: every step waits for exactly the steps it starts after — none missing, none extra', diff.length === 0 && sameJson(ordered(s1.waits), ordered(wantOf(SCEN))), diff.map((k) => `${k}: ${JSON.stringify(s1.waits[k])} wanted ${JSON.stringify(wantOf(SCEN)[k])}`).join(' | '));
  ok('SCENARIO: 19 waits in all, and nothing but flow waits on the piece\'s steps', Object.values(s1.waits).reduce((n, a) => n + a.length, 0) === 19 && s1.odd.length === 0, JSON.stringify(s1.odd));
  ok('SCENARIO: S7 waits for S6 and for lane 2\'s last step, not for lane 3 or 4', sameJson(s1.waits.S7, ['L2C', 'S6']));
  ok('SCENARIO: lane 3\'s meeting step waits for its own lane and for lane 4\'s last step', sameJson(s1.waits.N3B, ['L3A', 'N3A']));
  ok('SCENARIO: inside a lane a step waits only for the one above it (S5 for S4 — not for L2A beside it)', sameJson(s1.waits.S5, ['S4']) && sameJson(s1.waits.L2B, ['L2A']));
  ok('SCENARIO: the released steps carry the row numbers', sameJson(ordered(Object.fromEntries(s1.steps.map((s) => [code(s), s.sequence]))), ordered({
    S1: 10, S2: 20, S3: 30, S4: 40, S5: 50, S5B: 60, S6: 70, S7: 80, S8: 90, S9: 100, S10: 110, L2A: 40, L2B: 50, L2C: 70, N3A: 50, N3B: 60, L3A: 50, })
  ), JSON.stringify(s1.steps.map((s) => [code(s), s.sequence])));

  const s2 = waitsOf(linked.id);
  ok('LINKED A → (B1 → B2 ‖ C1) → D: B1 after A, C1 after A, B2 after B1 ONLY, D after B2 and C1', sameJson(ordered(s2.waits), ordered({ A: [], B1: ['A'], C1: ['A'], B2: ['B1'], D: ['B2', 'C1'] })) && s2.odd.length === 0, JSON.stringify(s2.waits));
  const s3 = waitsOf(legacy.id);
  ok('LEGACY, the same shape by sequence number: B2 still waits for B1 AND C1, D for B2 — the old rule is untouched', sameJson(ordered(s3.waits), ordered({ A: [], B1: ['A'], C1: ['A'], B2: ['B1', 'C1'], D: ['B2'] })) && s3.odd.length === 0, JSON.stringify(s3.waits));

  // The assembly: its one step waits for each part to be COMPLETE — every step of every lane.
  const asm = steps.filter((s) => s.flow_id === asmFlow.id);
  const asmDeps = deps.filter((d) => d.step_id === asm[0]?.id);
  const partItems = [scen.id, linked.id, legacy.id].map((fid) => steps.find((s) => s.flow_id === fid).item).sort();
  ok('the assembly\'s first step waits for each of the three parts as a whole (complete)', asm.length === 1 && asmDeps.length === 3
    && asmDeps.every((d) => d.origin === 'default' && d.required === 'complete' && d.target_step_id == null)
    && sameJson(asmDeps.map((d) => d.target_item_id).sort(), partItems), JSON.stringify(asmDeps));

  // The tracker's view of it: only what starts after nothing is ready.
  const tracked = await REL.getRelease(conn, COMPANY, releaseId);
  ok('the tracker reads the release without a problem', !!tracked);
} catch (e) {
  failed++;
  console.error('  ERROR', e.code ?? '', e.message, e.problems ? JSON.stringify(e.problems) : '', e.stack?.split('\n').slice(1, 5).join(' '));
} finally {
  await conn.rollback();
  detachNodeCache(conn);
  conn.release();
  const after = await counts();
  const changed = after.filter((a) => before.find((b) => b.name === a.name)?.n !== a.n);
  ok('every cf_ table count is back', changed.length === 0, changed.map((x) => x.name).join(', '));
  await pool.end();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
}
