/**
 * flow_changes_test.mjs — the flow page's one save (applyFlowChanges, PUT /flows/:id/steps).
 * The page edits a copy of the steps and sends the whole list: new steps added, missing ones removed,
 * numbers rewritten 10, 20, 30 …, steps of one group share a number, an operation changed in place
 * carries its time overrides, waits matched, every problem named at once and nothing written on a
 * refusal, records re-synced once — and getFlow now carries each step's times.
 * Local only, one rolled-back transaction, every cf_ table re-counted.
 *
 *   cd multi_app_be && node scripts/cf_kepl/flow_changes_test.mjs
 */
import { pool } from '../../db.js';
import { createFlow, getFlow, applyFlowChanges, setFlowStatus, addStep, moveStep, removeStep } from '../../apps/cf_erp/services/flowService.js';
import { createTimingRule } from '../../apps/cf_erp/services/operationService.js';
import { updateRecord } from '../../apps/cf_erp/services/masterRecordService.js';

if (!/^(localhost|127\.0\.0\.1|::1)$/.test(process.env.DB_HOST ?? 'localhost')) throw new Error('This suite is local only.');
const COMPANY = Number(process.env.CF_FLOWCHANGES_COMPANY ?? 2);
const T = `FC${Date.now().toString(36).toUpperCase()}`;
let passed = 0, failed = 0;
function ok(label, condition, detail = '') {
  if (typeof label !== 'string' || typeof condition !== 'boolean') throw new Error('ok needs label, boolean');
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${!condition && detail ? ` — ${detail}` : ''}`);
  condition ? passed++ : failed++;
}
const [tables] = await pool.query("SELECT TABLE_NAME name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME LIKE 'cf\\_%' ORDER BY TABLE_NAME");
const counts = async () => (await pool.query(tables.map((t) => `SELECT '${t.name}' AS name,COUNT(*) AS n FROM \`${t.name}\``).join(' UNION ALL ')))[0];
const before = await counts();
const db = await pool.getConnection();
const refused = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };
try {
  await db.beginTransaction();
  await db.query('SET FOREIGN_KEY_CHECKS = 0');
  const c = { companyId: COMPANY, userId: null };
  const op = async (s, extra = {}) => (await db.query('INSERT INTO cf_operations SET ?', [{ company_id: COMPANY, code: `${T}-${s}`, name: `${T} ${s}`, ...extra }]))[0].insertId;
  const A = await op('A'), B = await op('B'), C = await op('C'), D = await op('D'), R = await op('R'), OFF = await op('OFF', { status: 'inactive' });
  const letter = new Map([[A, 'A'], [B, 'B'], [C, 'C'], [D, 'D'], [R, 'R'], [OFF, 'OFF']]);
  const show = (f) => f.steps.map((s) => `${letter.get(s.operation.id)}${s.sequence}`).join(' ');
  const stepOf = (f, opId) => f.steps.find((s) => s.operation.id === opId);
  const rawSteps = async (flowId) => JSON.stringify((await db.query(
    'SELECT id, sequence, operation_id, step_name, notes, deleted_at IS NULL AS live FROM cf_operation_flow_steps WHERE company_id = ? AND flow_id = ? ORDER BY id', [COMPANY, flowId]))[0]);
  const rawWaits = async (flowId) => JSON.stringify((await db.query(
    `SELECT w.id, w.flow_step_id, w.relation, w.deleted_at IS NULL AS live FROM cf_step_wait_rules w JOIN cf_operation_flow_steps s ON s.id = w.flow_step_id
      WHERE w.company_id = ? AND s.flow_id = ? ORDER BY w.id`, [COMPANY, flowId]))[0]);
  const keep = (s, extra = {}) => ({ id: s.id, operationId: s.operation.id, ...extra });

  const flow = await createFlow(db, c, { code: `${T}-F`, name: 'Flow changes' });
  const F = flow.id;

  // --- first save: two new steps -------------------------------------------------
  let r = await applyFlowChanges(db, c, F, { steps: [{ operationId: A }, { operationId: B, stepName: '  Second  ' }] });
  let f = r.flow;
  ok('an empty flow takes its first steps, numbered 10 and 20', show(f) === 'A10 B20', show(f));
  ok('the summary says it in words', r.summary === '2 steps added.', r.summary);
  ok('a step name is trimmed', stepOf(f, B).stepName === 'Second');
  const idA = stepOf(f, A).id, idB = stepOf(f, B).id;

  // --- dry run --------------------------------------------------------------------
  const snap = await rawSteps(F);
  r = await applyFlowChanges(db, c, F, { dryRun: true, steps: [keep(stepOf(f, A)), { operationId: C }, keep(stepOf(f, B))] });
  ok('dry run: says what would change', r.summary === '1 step added.' && r.dryRun === true && r.changes.added === 1, JSON.stringify(r.changes));
  ok('dry run: writes nothing', (await rawSteps(F)) === snap && show(r.flow) === 'A10 B20');

  // --- add in the middle ------------------------------------------------------------
  r = await applyFlowChanges(db, c, F, { steps: [keep(stepOf(f, A)), { operationId: C }, keep(stepOf(f, B))] });
  f = r.flow;
  ok('add in the middle renumbers 10 / 20 / 30', show(f) === 'A10 C20 B30', show(f));
  ok('the kept steps keep their ids', stepOf(f, A).id === idA && stepOf(f, B).id === idB);
  ok('a kept step with no name sent keeps its name', stepOf(f, B).stepName === 'Second');
  ok('adding a step syncs', r.synced === true);
  const idC = stepOf(f, C).id;

  // --- reorder ----------------------------------------------------------------------
  r = await applyFlowChanges(db, c, F, { steps: [keep(stepOf(f, B)), keep(stepOf(f, A)), keep(stepOf(f, C))] });
  f = r.flow;
  ok('reorder: B first', show(f) === 'B10 A20 C30', show(f));
  ok('reorder: said in words, ids kept', r.summary === 'Order changed.' && stepOf(f, C).id === idC && stepOf(f, B).id === idB, r.summary);
  ok('reorder alone does not sync (the flow reads the same values)', r.synced === false);
  r = await applyFlowChanges(db, c, F, { steps: f.steps.map((s) => keep(s)) });
  ok('the same list again changes nothing', r.summary === 'Nothing changed.' && r.synced === false, r.summary);

  // --- steps of one group share a number -----------------------------------------------
  let e = await refused(() => applyFlowChanges(db, c, F, { steps: [keep(stepOf(f, B)), keep(stepOf(f, A), { group: 'x' }), keep(stepOf(f, C), { group: 'x' })] }));
  ok('a plain list ending in two steps side by side is a lane left open — refused', new RegExp(`Lane 2 \\(ends at ${T}-C\\) is still open — merge it back before saving`).test(e?.problems?.[0] ?? ''), JSON.stringify(e?.problems));
  r = await applyFlowChanges(db, c, F, { steps: [keep(stepOf(f, B)), keep(stepOf(f, A), { group: 'x' }), keep(stepOf(f, C), { group: 'x' }), { operationId: D }] });
  f = r.flow;
  ok('same group: one number, and the step after them closes it', show(f) === 'B10 A20 C20 D30', show(f));
  ok('…and that counts as the order changing', r.changes.orderChanged === true);
  ok('…read back as lanes: A in lane 0, C in lane 1, both after B, D after both', stepOf(f, A).lane === 0 && stepOf(f, C).lane === 1
    && JSON.stringify(stepOf(f, A).after) === JSON.stringify([idB]) && JSON.stringify(stepOf(f, C).after) === JSON.stringify([idB])
    && JSON.stringify([...stepOf(f, D).after].sort((x, y) => x - y)) === JSON.stringify([idA, idC].sort((x, y) => x - y)), JSON.stringify(f.steps.map((s) => [s.lane, s.after])));
  ok('the flow is linked from its first save here', f.linked === true);
  e = await refused(() => applyFlowChanges(db, c, F, { steps: [keep(stepOf(f, B)), keep(stepOf(f, A), { group: 'x' }), { operationId: A, group: 'x' }, keep(stepOf(f, C)), keep(stepOf(f, D))] }));
  ok('one operation twice at one number is refused in words', e?.code === 'INVALID' && /already at step 20/.test(e.problems?.[0] ?? ''), JSON.stringify(e?.problems));
  r = await applyFlowChanges(db, c, F, { steps: [keep(stepOf(f, B)), keep(stepOf(f, A)), keep(stepOf(f, C)), { operationId: A }] });
  f = r.flow;
  ok('the same operation again at its own number is fine (a second pass)', show(f) === 'B10 A20 C30 A40', show(f));

  // --- waits: add, keep, remove in one save -----------------------------------------------
  const lastA = f.steps[3];
  r = await applyFlowChanges(db, c, F, { steps: f.steps.map((s) => (s.id === idB ? keep(s, { waits: [{ relation: 'parent' }, { relation: 'children', targetOperationId: A, requiredStatus: 'started', notes: 'why' }] }) : keep(s))) });
  f = r.flow;
  ok('two waits added in one save', stepOf(f, B).waits.length === 2 && r.summary === '2 waits added.', r.summary);
  ok('waits alone do not sync', r.synced === false);
  const wParent = stepOf(f, B).waits.find((w) => w.relation === 'parent'), wChildren = stepOf(f, B).waits.find((w) => w.relation === 'children');
  ok('a wait carries its operation, status and note', wChildren.targetOperation.id === A && wChildren.requiredStatus === 'started' && wChildren.notes === 'why');
  r = await applyFlowChanges(db, c, F, { steps: f.steps.map((s) => (s.id === idB ? keep(s, { waits: [{ id: wParent.id }, { relation: 'siblings' }] }) : keep(s))) });
  f = r.flow;
  const nowWaits = stepOf(f, B).waits;
  ok('add and remove a wait in the same save', nowWaits.length === 2 && nowWaits.some((w) => w.relation === 'siblings') && !nowWaits.some((w) => w.relation === 'children') && r.summary === '1 wait added, 1 wait removed.', r.summary);
  ok('a kept wait keeps its id', nowWaits.some((w) => w.id === wParent.id));
  r = await applyFlowChanges(db, c, F, { steps: f.steps.map((s) => keep(s)) });
  ok('waits left out on a kept step are untouched', stepOf(r.flow, B).waits.length === 2 && r.summary === 'Nothing changed.');
  r = await applyFlowChanges(db, c, F, { steps: [keep(stepOf(f, A)), keep(stepOf(f, B)), keep(stepOf(f, C)), keep(lastA)] });
  f = r.flow;
  ok('waits travel with their step when it moves', show(f) === 'A10 B20 C30 A40' && stepOf(f, B).waits.length === 2, show(f));

  // --- refusals: every problem named, nothing written ---------------------------------------
  const stepsSnap = await rawSteps(F), waitsSnap = await rawWaits(F);
  e = await refused(() => applyFlowChanges(db, c, F, { steps: [
    keep(stepOf(f, A)),
    { operationId: OFF },
    keep(stepOf(f, B), { waits: [{ id: wParent.id }, { relation: 'ancestor' }, { relation: 'sideways' }] }),
    { operationId: 999999999 },
    { stepName: 'no operation' },
    { id: 999999999, operationId: C },
  ] }));
  const said = (re) => (e?.problems ?? []).some((p) => re.test(p));
  ok('a bad save is refused 422 with a list of problems', e?.status === 422 && e?.code === 'INVALID' && Array.isArray(e.problems), `${e?.status} ${e?.code}`);
  ok('…the inactive operation is named', said(new RegExp(`Step 2 \\(${T}-OFF\\): Operation ${T}-OFF is inactive`)), JSON.stringify(e?.problems));
  ok('…the ancestor wait with no template is named', said(/Step 3 .*Wait rule — Say which ancestor/));
  ok('…the unknown relation is named', said(/Step 3 .*Wait rule — Wait for its parent/));
  ok('…the operation that does not exist is named', said(/Step 4: That operation does not exist/));
  ok('…the step with no operation is named', said(/Step 5: Choose an operation/));
  ok('…the step that is not of this flow is named', said(/Step 6 .*no longer a step of this flow/));
  ok('…and NOTHING was written', (await rawSteps(F)) === stepsSnap && (await rawWaits(F)) === waitsSnap);
  e = await refused(() => applyFlowChanges(db, c, F, { steps: f.steps.map((s) => (s.id === idB ? keep(s, { waits: [{ id: wParent.id }, { relation: 'parent' }] }) : keep(s))) }));
  ok('the same wait twice is refused', /same thing twice/.test(e?.problems?.[0] ?? ''), JSON.stringify(e?.problems));
  e = await refused(() => applyFlowChanges(db, c, F, { steps: [keep(stepOf(f, A)), keep(stepOf(f, A))] }));
  ok('one step twice in the list is refused', /in the list twice/.test(e?.problems?.join(' ') ?? ''));
  e = await refused(() => applyFlowChanges(db, c, F, {}));
  ok('no list at all is refused', e?.code === 'INVALID');

  // --- an operation changed in place ------------------------------------------------------------
  const [[piece]] = await db.query('SELECT id, bom_line_id, order_line_id FROM cf_order_pieces WHERE company_id = ? AND bom_line_id IS NOT NULL AND deleted_at IS NULL ORDER BY id LIMIT 1', [COMPANY]);
  ok('a locked piece to hang work on', !!piece);
  if (piece) {
    const [[released]] = await db.query('SELECT COUNT(*) AS n FROM cf_production_releases WHERE company_id = ? AND order_line_id = ? AND deleted_at IS NULL', [COMPANY, piece.order_line_id]);
    await db.query('UPDATE cf_production_releases SET deleted_at = NOW() WHERE company_id = ? AND order_line_id = ? AND deleted_at IS NULL', [COMPANY, piece.order_line_id]);
    await db.query('UPDATE cf_bom_lines SET operation_flow_id = ? WHERE id = ?', [F, piece.bom_line_id]);
    await db.query('INSERT INTO cf_time_overrides SET ?', [{ company_id: COMPANY, order_line_id: piece.order_line_id, bom_line_id: piece.bom_line_id, operation_id: C, work_minutes: 5 }]);
    r = await applyFlowChanges(db, c, F, { steps: f.steps.map((s) => (s.id === idC ? { id: s.id, operationId: D } : keep(s))) });
    f = r.flow;
    ok('replace in place: same step, new operation, same number', f.steps.find((s) => s.id === idC).operation.id === D && show(f) === 'A10 B20 D30 A40', show(f));
    ok('…said in words, with what moved', /^1 operation replaced\. Moved to the new operation: 1 time override\.$/.test(r.summary), r.summary);
    const [[ov]] = await db.query('SELECT operation_id FROM cf_time_overrides WHERE company_id = ? AND order_line_id = ? AND bom_line_id = ? AND work_minutes = 5 AND deleted_at IS NULL', [COMPANY, piece.order_line_id, piece.bom_line_id]);
    ok('…the time override moved to the new operation', Number(ov.operation_id) === D, `was released before: ${released.n}`);
    ok('replacing an operation syncs', r.synced === true);
  }
  await db.query('INSERT INTO cf_production_steps SET ?', [{ company_id: COMPANY, production_item_id: 999999, flow_step_id: idB, operation_id: B, sequence: 20, quantity: 1 }]);
  e = await refused(() => applyFlowChanges(db, c, F, { steps: f.steps.map((s) => (s.id === idB ? { id: s.id, operationId: C } : keep(s))) }));
  ok('a step already in production cannot change its operation', /already in production \(1 released step\)/.test(e?.problems?.[0] ?? ''), JSON.stringify(e?.problems));
  r = await applyFlowChanges(db, c, F, { steps: f.steps.map((s) => (s.id === idB ? keep(s, { stepName: 'Renamed', notes: 'A note' }) : keep(s))) });
  f = r.flow;
  ok('…but it can still be renamed and moved', stepOf(f, B).stepName === 'Renamed' && stepOf(f, B).notes === 'A note' && r.summary === '1 step edited.', r.summary);

  // --- remove ---------------------------------------------------------------------------------------
  r = await applyFlowChanges(db, c, F, { steps: f.steps.filter((s) => s.id !== idB).map((s) => keep(s)) });
  f = r.flow;
  ok('remove: the rest closes up 10 / 20 / 30', show(f) === 'A10 D20 A30' && r.summary === '1 step removed.', `${show(f)} ${r.summary}`);
  const [[gone]] = await db.query('SELECT deleted_at FROM cf_operation_flow_steps WHERE id = ?', [idB]);
  const [[goneWaits]] = await db.query('SELECT COUNT(*) AS n FROM cf_step_wait_rules WHERE company_id = ? AND flow_step_id = ? AND deleted_at IS NULL', [COMPANY, idB]);
  ok('…the step is soft-deleted and its waits go with it', gone.deleted_at != null && Number(goneWaits.n) === 0);

  // --- one sync: a definition on the flow gains and loses what the new step's time reads ---------------
  const [sp] = await db.query("INSERT INTO cf_specifications (company_id, code, name, data_type, status) VALUES (?, ?, ?, 'number', 'active')", [COMPANY, `${T}_X`, `Test ${T} X`]);
  const [[mc]] = await db.query('SELECT id FROM cf_machines WHERE company_id = ? AND deleted_at IS NULL ORDER BY id DESC LIMIT 1', [COMPANY]);
  const rule = await createTimingRule(db, c, R, { subjectType: 'machine', subjectId: mc.id, workExpression: `item.${T}_X * 2`, setupExpression: '5' });
  const [[def]] = await db.query(
    `SELECT m.id FROM cf_master_records m JOIN cf_definition_details d ON d.master_id = m.id
      WHERE m.company_id = ? AND m.record_kind = 'definition' AND d.definition_type = 'template' AND m.deleted_at IS NULL AND m.default_flow_id IS NULL
      ORDER BY m.id LIMIT 1`, [COMPANY]);
  await setFlowStatus(db, c, F, 'active');
  await updateRecord(db, c, def.id, { defaultFlowId: F });
  const flowRules = async () => (await db.query(
    `SELECT a.origin, a.is_required FROM cf_spec_assignments a
      WHERE a.company_id = ? AND a.subject_type = 'master' AND a.subject_id = ? AND a.specification_id = ? AND a.deleted_at IS NULL`, [COMPANY, def.id, sp.insertId]))[0];
  ok('before: the definition is not asked for X', (await flowRules()).length === 0);
  r = await applyFlowChanges(db, c, F, { steps: [keep(f.steps[0]), { operationId: R }, keep(f.steps[1]), keep(f.steps[2])] });
  f = r.flow;
  let fr = await flowRules();
  ok('adding a step whose time reads item.X makes X required on the definition (origin flow)', fr.length === 1 && fr[0].origin === 'flow' && fr[0].is_required === 1, JSON.stringify(fr));
  r = await applyFlowChanges(db, c, F, { steps: f.steps.filter((s) => s.operation.id !== R).map((s) => keep(s)) });
  ok('removing that step takes the rule away again', (await flowRules()).length === 0 && r.synced === true);

  // --- the step times on getFlow --------------------------------------------------------------------------
  r = await applyFlowChanges(db, c, F, { steps: [...r.flow.steps.map((s) => keep(s)), { operationId: R }] });
  f = await getFlow(db, COMPANY, F);
  const tR = stepOf(f, R).time, tA = stepOf(f, A).time;
  ok('getFlow: a step carries its operation\'s main rule', tR.ruleId === rule.id && tR.rules === 1 && tR.subject?.type === 'machine' && tR.subject.id === mc.id, JSON.stringify(tR));
  ok('getFlow: the setup is a fixed time', tR.setup.expression === '5' && Number(tR.setup.display) === 5, JSON.stringify(tR.setup));
  ok('getFlow: the work time is its expression', tR.work.minutes === null && new RegExp(`item\\.${T}_X \\* 2`, 'i').test(tR.work.expression) && typeof tR.work.display === 'string', JSON.stringify(tR.work));
  ok('getFlow: an operation with no rule says so', tA.ruleId === null && tA.rules === 0 && tA.subject === null && tA.work.minutes === null && tA.work.expression === null && tA.setup.display === null, JSON.stringify(tA));

  // =====================================================================================================
  // LANES (init.sql §54): each step says what it starts after and which lane it is drawn in.
  // =====================================================================================================
  const opOf = new Map();
  for (const code of ['S1', 'S2', 'S3', 'S4', 'S5', 'S5B', 'S6', 'S7', 'S8', 'S9', 'S10', 'L2A', 'L2B', 'L2C', 'L3A', 'N3A', 'N3B', 'B1', 'B2', 'C1']) opOf.set(code, await op(code));
  const codeOf = new Map([...opOf].map(([code, id]) => [id, code]));
  codeOf.set(A, 'A'); codeOf.set(D, 'D');
  opOf.set('A', A); opOf.set('D', D);
  /** One step of a lanes payload: its key IS its operation code; `ids` gives the saved step to keep. */
  const P = (ids) => (code, lane, after, extra = {}) => ({ ...(ids?.get(code) ? { id: ids.get(code) } : {}), key: code, operationId: opOf.get(code), lane, after, ...extra });
  const idsOf = (fl2) => new Map(fl2.steps.map((s) => [codeOf.get(s.operation.id), s.id]));
  /** What came back, by operation code: { CODE: { lane, row, after: [codes] } }. */
  const picture = (fl2) => {
    const byId2 = new Map(fl2.steps.map((s) => [s.id, codeOf.get(s.operation.id)]));
    return Object.fromEntries(fl2.steps.map((s) => [byId2.get(s.id), { lane: s.lane, seq: s.sequence, after: s.after.map((a) => byId2.get(a)).sort() }]));
  };
  const linksOf = async (flowId) => JSON.stringify((await db.query('SELECT step_id, after_step_id, deleted_at IS NULL AS live FROM cf_flow_step_links WHERE company_id = ? AND flow_id = ? ORDER BY id', [COMPANY, flowId]))[0]);
  const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  // --- A → (B1 → B2 ‖ C1) → D ---------------------------------------------------------------------------
  const small = await createFlow(db, c, { code: `${T}-LANES`, name: 'Lanes' });
  let p = P(null);
  r = await applyFlowChanges(db, c, small.id, { steps: [p('A', 0, []), p('B1', 0, ['A']), p('C1', 1, ['A']), p('B2', 0, ['B1']), p('D', 0, ['B2', 'C1'])] });
  let pic = picture(r.flow);
  ok('split and merge: lanes and what each step starts after come back as saved', sameJson(pic, {
    A: { lane: 0, seq: 10, after: [] }, B1: { lane: 0, seq: 20, after: ['A'] }, C1: { lane: 1, seq: 20, after: ['A'] },
    B2: { lane: 0, seq: 30, after: ['B1'] }, D: { lane: 0, seq: 40, after: ['B2', 'C1'] },
  }), JSON.stringify(pic));
  ok('sequences are the rows: B1 and C1 share 20', r.flow.steps.map((s) => s.sequence).join() === '10,20,20,30,40');
  ok('linked is set by the save', r.flow.linked === true && Number((await db.query('SELECT linked FROM cf_operation_flows WHERE id = ?', [small.id]))[0][0].linked) === 1);
  ok('five links are stored', JSON.parse(await linksOf(small.id)).filter((l) => l.live).length === 5);
  let ids = idsOf(r.flow);
  p = P(ids);
  const same5 = [p('A', 0, []), p('B1', 0, ['A']), p('C1', 1, ['A']), p('B2', 0, ['B1']), p('D', 0, ['B2', 'C1'])];
  let linkSnap = await linksOf(small.id);
  r = await applyFlowChanges(db, c, small.id, { steps: same5 });
  ok('the same picture again changes nothing — not a link rewritten', r.summary === 'Nothing changed.' && (await linksOf(small.id)) === linkSnap, r.summary);
  // B2 moves to the other lane: now after C1, and D after B1 and B2.
  r = await applyFlowChanges(db, c, small.id, { steps: [p('A', 0, []), p('B1', 0, ['A']), p('C1', 1, ['A']), p('B2', 1, ['C1']), p('D', 0, ['B1', 'B2'])] });
  pic = picture(r.flow);
  ok('a step moved to the other lane: links diffed (old ones soft-deleted, new ones added), ids kept', sameJson(pic.B2, { lane: 1, seq: 30, after: ['C1'] }) && sameJson(pic.D.after, ['B1', 'B2'])
    && idsOf(r.flow).get('B2') === ids.get('B2') && r.changes.orderChanged === true && r.synced === false, JSON.stringify(pic));
  const afterMove = JSON.parse(await linksOf(small.id));
  ok('…5 live links, 2 soft-deleted', afterMove.filter((l) => l.live).length === 5 && afterMove.filter((l) => !l.live).length === 2, JSON.stringify(afterMove));
  // Two steps of one operation in one row cannot share a number.
  r = await applyFlowChanges(db, c, small.id, { steps: [p('A', 0, []), p('B1', 0, ['A']), { key: 'B1x', operationId: opOf.get('B1'), lane: 1, after: ['A'] }, p('D', 0, ['B1', 'B1x'])] });
  ok('one operation in two lanes of one row: the second takes the next number', r.flow.steps.map((s) => s.sequence).join() === '10,20,21,30', r.flow.steps.map((s) => s.sequence).join());
  ids = idsOf(r.flow);
  p = P(ids);

  // --- refusals: a lane left open, a circle, a dangling `after` — nothing written ---------------------------
  const smallSteps = await rawSteps(small.id);
  linkSnap = await linksOf(small.id);
  e = await refused(() => applyFlowChanges(db, c, small.id, { steps: [p('A', 0, []), p('B1', 0, ['A']), p('C1', 1, ['A']), p('D', 0, ['B1'])] }));
  ok('a lane left open is refused, naming the lane and where it ends', e?.status === 422 && sameJson(e.problems, [`Lane 2 (ends at ${T}-C1) is still open — merge it back before saving.`]), JSON.stringify(e?.problems));
  e = await refused(() => applyFlowChanges(db, c, small.id, { steps: [p('A', 0, []), p('B1', 0, ['A']), p('C1', 1, ['A']), p('B2', 2, ['A'])] }));
  ok('two lanes left open: both named; the trunk\'s end is not', sameJson(e?.problems, [`Lane 2 (ends at ${T}-C1) is still open — merge it back before saving.`, `Lane 3 (ends at ${T}-B2) is still open — merge it back before saving.`]), JSON.stringify(e?.problems));
  e = await refused(() => applyFlowChanges(db, c, small.id, { steps: [p('A', 0, []), p('B1', 0, ['A', 'D']), p('B2', 0, ['B1']), p('D', 0, ['B2'])] }));
  ok('a circle is refused, naming the steps in it', /would wait for each other/.test(e?.problems?.[0] ?? '') && ['B1', 'B2', 'D'].every((x) => e.problems[0].includes(`${T}-${x}`)) && !e.problems[0].includes(`${T}-A `), JSON.stringify(e?.problems));
  e = await refused(() => applyFlowChanges(db, c, small.id, { steps: [p('A', 0, []), p('B1', 0, ['A', 'GHOST']), p('D', 0, ['B1', 'D'])] }));
  ok('an `after` that names no step of the list, and a step after itself, are both named', (e?.problems ?? []).some((x) => /Step 2 .*starts after a step that is not in the list \(GHOST\)/.test(x)) && (e?.problems ?? []).some((x) => /Step 3 .*cannot start after itself/.test(x)), JSON.stringify(e?.problems));
  ok('…and NOTHING was written by any of the four', (await rawSteps(small.id)) === smallSteps && (await linksOf(small.id)) === linkSnap);

  // --- the per-step routes on a linked flow ------------------------------------------------------------------
  e = await refused(() => addStep(db, c, small.id, { operationId: opOf.get('C1') }));
  ok('a linked flow is not changed by sequence number: addStep refused in words', e?.code === 'FLOW_HAS_LANES' && /laid out in lanes/.test(e.message), e?.message);
  e = await refused(() => moveStep(db, c, ids.get('B1'), { direction: 'down' }));
  ok('…moveStep too', e?.code === 'FLOW_HAS_LANES');
  // A (10) → B1 (20) ‖ B1x (21) → D (30); removing B1 through the old route bridges nothing new (D still after B1x).
  r = await applyFlowChanges(db, c, small.id, { steps: [p('A', 0, []), p('B1', 0, ['A']), p('D', 0, ['B1'])] });
  await removeStep(db, c, ids.get('B1'));
  pic = picture(await getFlow(db, COMPANY, small.id));
  ok('removeStep on a linked flow: what came after it now starts after what it started after', sameJson(pic.D.after, ['A']) && !pic.B1, JSON.stringify(pic));

  // --- a legacy flow: read as lanes, untouched until it is saved here ----------------------------------------------
  const legacy = await createFlow(db, c, { code: `${T}-LEGACY`, name: 'Legacy' });
  await addStep(db, c, legacy.id, { operationId: A });
  await addStep(db, c, legacy.id, { operationId: opOf.get('B1'), sequence: 20 });
  await addStep(db, c, legacy.id, { operationId: opOf.get('C1'), sequence: 20 });
  await addStep(db, c, legacy.id, { operationId: D, sequence: 35 });
  let lf = await getFlow(db, COMPANY, legacy.id);
  pic = picture(lf);
  ok('a legacy flow is not linked', lf.linked === false);
  ok('…and reads as lanes: a shared number is a split, the next number the step they meet at', sameJson(pic, {
    A: { lane: 0, seq: 10, after: [] }, B1: { lane: 0, seq: 20, after: ['A'] }, C1: { lane: 1, seq: 20, after: ['A'] }, D: { lane: 0, seq: 35, after: ['B1', 'C1'] },
  }), JSON.stringify(pic));
  const legacySteps = await rawSteps(legacy.id);
  ok('…reading it wrote nothing: no link, the numbers as they were, still not linked', (await linksOf(legacy.id)) === '[]' && Number((await db.query('SELECT linked FROM cf_operation_flows WHERE id = ?', [legacy.id]))[0][0].linked) === 0);
  ids = idsOf(lf);
  p = P(ids);
  const asRead = [p('A', 0, []), p('B1', 0, ['A']), p('C1', 1, ['A']), p('D', 0, ['B1', 'C1'])];
  r = await applyFlowChanges(db, c, legacy.id, { dryRun: true, steps: asRead });
  ok('a dry run of it writes nothing either', (await rawSteps(legacy.id)) === legacySteps && (await linksOf(legacy.id)) === '[]' && r.flow.linked === false);
  r = await applyFlowChanges(db, c, legacy.id, { steps: asRead });
  pic = picture(r.flow);
  ok('saved as it was read: now linked, 4 links written, rows renumbered 10/20/20/30, same order', r.flow.linked === true && JSON.parse(await linksOf(legacy.id)).length === 4
    && r.changes.orderChanged === false && pic.D.seq === 30 && sameJson(pic.D.after, ['B1', 'C1']) && r.synced === false, `${r.summary} ${JSON.stringify(pic)}`);

  // --- the user's scenario, 2026-10-10 ----------------------------------------------------------------------------------
  //   1. ten steps in one lane   2. a second lane from S3 (L2A)   3. a third from S4 (L3A)   4. lane 2 closes onto S7
  //   5. S5B after S5            6. L2B in lane 2                 7. a parallel of lane 2 (N3A) — it is lane 3, the old lane 3 is lane 4
  //   8. the old lane 3 closes into the new one at N3B            10. the new lane is still open: REFUSED; then it closes into lane 2 at L2C.
  const scen = await createFlow(db, c, { code: `${T}-SCEN`, name: 'Scenario' });
  const trunk10 = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9', 'S10'];
  p = P(null);
  r = await applyFlowChanges(db, c, scen.id, { steps: trunk10.map((code, i) => p(code, 0, i ? [trunk10[i - 1]] : [])) });
  ok('scenario 1: ten steps in one lane, rows 10 … 100', r.flow.steps.map((s) => s.sequence).join() === '10,20,30,40,50,60,70,80,90,100' && r.flow.steps.every((s) => s.lane === 0));
  ids = idsOf(r.flow);
  p = P(ids);
  const upTo8 = [
    p('S1', 0, []), p('S2', 0, ['S1']), p('S3', 0, ['S2']), p('S4', 0, ['S3']), p('S5', 0, ['S4']), p('S5B', 0, ['S5']), p('S6', 0, ['S5B']),
    p('S7', 0, ['S6', 'L2B']), p('S8', 0, ['S7']), p('S9', 0, ['S8']), p('S10', 0, ['S9']),
    p('L2A', 1, ['S3']), p('L2B', 1, ['L2A']),
    p('N3A', 2, ['L2A']), p('N3B', 2, ['N3A', 'L3A']),
    p('L3A', 3, ['S4']),
  ];
  const scenSteps = await rawSteps(scen.id), scenLinks = await linksOf(scen.id);
  e = await refused(() => applyFlowChanges(db, c, scen.id, { steps: upTo8 }));
  ok('scenario 10: lane 3 (the parallel of lane 2) was never closed — the save is refused, naming it', e?.status === 422 && sameJson(e.problems, [`Lane 3 (ends at ${T}-N3B) is still open — merge it back before saving.`]), JSON.stringify(e?.problems));
  ok('…and nothing was written', (await rawSteps(scen.id)) === scenSteps && (await linksOf(scen.id)) === scenLinks);
  // Closed the natural way: into lane 2, the lane it split from, at a new step L2C before lane 2 meets the trunk at S7.
  const closed = upTo8.map((s) => (s.key === 'S7' ? p('S7', 0, ['S6', 'L2C']) : s)).concat([p('L2C', 1, ['L2B', 'N3B'])]);
  r = await applyFlowChanges(db, c, scen.id, { steps: closed });
  const WANT = {
    S1: { lane: 0, seq: 10, after: [] }, S2: { lane: 0, seq: 20, after: ['S1'] }, S3: { lane: 0, seq: 30, after: ['S2'] }, S4: { lane: 0, seq: 40, after: ['S3'] },
    L2A: { lane: 1, seq: 40, after: ['S3'] },
    S5: { lane: 0, seq: 50, after: ['S4'] }, L2B: { lane: 1, seq: 50, after: ['L2A'] }, N3A: { lane: 2, seq: 50, after: ['L2A'] }, L3A: { lane: 3, seq: 50, after: ['S4'] },
    S5B: { lane: 0, seq: 60, after: ['S5'] }, N3B: { lane: 2, seq: 60, after: ['L3A', 'N3A'] },
    S6: { lane: 0, seq: 70, after: ['S5B'] }, L2C: { lane: 1, seq: 70, after: ['L2B', 'N3B'] },
    S7: { lane: 0, seq: 80, after: ['L2C', 'S6'] }, S8: { lane: 0, seq: 90, after: ['S7'] }, S9: { lane: 0, seq: 100, after: ['S8'] }, S10: { lane: 0, seq: 110, after: ['S9'] },
  };
  pic = picture(await getFlow(db, COMPANY, scen.id));
  const wrong = Object.keys(WANT).filter((k) => !sameJson(pic[k], WANT[k]));
  ok('scenario: saved and read back — every step\'s lane, row number and `after` are exactly as wanted', wrong.length === 0 && Object.keys(pic).length === 17, wrong.map((k) => `${k} ${JSON.stringify(pic[k])}`).join(' | '));
  ok('…the ten first steps kept their ids, seven were added', trunk10.every((code) => idsOf(r.flow).get(code) === ids.get(code)) && r.changes.added === 7 && r.changes.orderChanged === false, JSON.stringify(r.changes));
  ok('…19 links stored (17 steps: 16 with one or two predecessors)', JSON.parse(await linksOf(scen.id)).filter((l) => l.live).length === Object.values(WANT).reduce((n, s) => n + s.after.length, 0));
  ok('…it reads in flow order top to bottom, row by row', r.flow.steps.map((s) => codeOf.get(s.operation.id)).slice(0, 5).join() === 'S1,S2,S3,S4,L2A' || r.flow.steps.map((s) => codeOf.get(s.operation.id)).slice(0, 5).join() === 'S1,S2,S3,L2A,S4');

  // --- an obsolete flow ----------------------------------------------------------------------------------------
  await setFlowStatus(db, c, F, 'obsolete');
  const obsSnap = await rawSteps(F);
  e = await refused(() => applyFlowChanges(db, c, F, { steps: [] }));
  ok('an obsolete flow is refused', e?.code === 'OBSOLETE' && /obsolete/.test(e.message), e?.message);
  ok('…and nothing was written', (await rawSteps(F)) === obsSnap);
} catch (e) {
  failed++;
  console.error('  ERROR', e.message, e.problems ? JSON.stringify(e.problems) : '', e.stack?.split('\n').slice(1, 4).join(' '));
} finally {
  await db.query('SET FOREIGN_KEY_CHECKS = 1').catch(() => {});
  await db.rollback();
  db.release();
  const after = await counts();
  const changed = after.filter((a) => before.find((b) => b.name === a.name)?.n !== a.n);
  ok('every cf_ table count is back', changed.length === 0, changed.map((x) => x.name).join(', '));
  await pool.end();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
}
