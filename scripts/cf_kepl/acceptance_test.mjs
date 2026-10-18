/**
 * acceptance_test.mjs — STEP 3A of the CF_ERP redesign (init.sql §73, TM/s73.sql; contract TM/CF_ERP_ORDER_FLOW_PLAN.md
 * "2026-10-18 — Step 3A"): CUSTOMER ACCEPTANCE (the order's confirm step), the MANAGEMENT approvals inbox, the SALES
 * ORDERS BOARD and its post-production checklist.
 *
 *   cd multi_app_be && node scripts/cf_kepl/acceptance_test.mjs
 *   CF_ACC_COMPANY (2)
 *
 * ONE TRANSACTION, ROLLED BACK; every cf_ table is re-counted at the end. Everything is this run's own (TEST-ACC-<run>).
 * Line 923 is never touched.
 *
 *   1  templates: charges / milestones / stages, one default per kind, checked
 *   2  a new acceptance starts from the default templates; the estimate (weight × rate, a FORMULA on the part rows, the
 *      material row on the lines we buy, lump sums, milestones, margin over material)
 *   3  every trigger type checked (good and bad), pro-rata only where allowed, credit days, 100 %, formula bases
 *   4  the MR raised before acceptance is SHARED and HELD: nothing earmarked, no PR, no customer PO; PDF + Excel of it
 *   5  confirm only through the acceptance: the status route refuses, allowed moves leave it out
 *   6  save → pending approval (re-save replaces it); the stage and the board say so; supply editable until accepted
 *   7  the inbox per permission; requester ≠ approver; a rejection needs a reason and sends it back
 *   8  approve → confirmed, MR released (PR can be made; the customer's ₹0 PO dated as promised), terms LOCKED,
 *      post-production checklist made, event recorded
 *   9  rate change after acceptance = a new approval; the approved terms stay in force until it is approved
 *  10  a PO's approval through the inbox (context: lines, rates, the other quotes); a rejection sends it back
 *  11  close short needs approval; approved → closed short
 *  12  the board's lanes from facts (material → in production → dispatched → post-production → closed) and the
 *      checklist (done / undo / done, recorded; the last stage closes the order)
 *  13  a stock order still confirms with its button; a revision carries the acceptance
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const BE = process.cwd();
const imp = (p) => import(pathToFileURL(path.join(BE, p)).href);
const { pool } = await imp('db.js');
if (!/^(localhost|127\.0\.0\.1|::1)$/.test(process.env.DB_HOST ?? 'localhost')) throw new Error('This suite is local only.');
await imp('apps/cf_erp/services/codegenProvider.js');
const { attachNodeCache, detachNodeCache } = await imp('apps/cf_erp/lib/db.js');
const ACC = await imp('apps/cf_erp/services/acceptanceService.js');
const AP = await imp('apps/cf_erp/services/approvalService.js');
const BOARD = await imp('apps/cf_erp/services/orderBoardService.js');
const DOC = await imp('apps/cf_erp/services/mrDocumentService.js');
const RQ = await imp('apps/cf_erp/services/requisitionService.js');
const PRS = await imp('apps/cf_erp/services/purchaseRequestService.js');
const PS = await imp('apps/cf_erp/services/purchaseService.js');
const SO = await imp('apps/cf_erp/services/salesOrderService.js');
const PROC = await imp('apps/cf_erp/services/processService.js');
const OPS = await imp('apps/cf_erp/services/operationService.js');
const REV = await imp('apps/cf_erp/services/revisionService.js');
const B = await imp('apps/cf_erp/services/bomService.js');
const { harness, girder, simple, quietCodes } = await imp('scripts/cf_kepl/lib/buyingFixture.mjs');

const COMPANY = Number(process.env.CF_ACC_COMPANY ?? 2);
const RUN = Date.now().toString(36).toUpperCase().slice(-5);
const tag = `TEST-ACC-${RUN}`;
const H = harness(pool);
const { ok, section, refusal, j } = H;
const eq = (label, got, want) => ok(label, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)?.slice(0, 500)}, wanted ${JSON.stringify(want)?.slice(0, 300)}`);
const said = (e, re) => !!e && (re.test(e.message ?? '') || (e.problems ?? []).some((p) => re.test(p)));
const near = (a, b, tol = 0.01) => a != null && Math.abs(Number(a) - Number(b)) <= tol;
const before = await H.counts();
const db = await pool.getConnection();
const all = () => true;

try {
  await db.beginTransaction();
  attachNodeCache(db);
  const [users] = await db.query('SELECT id, name FROM users WHERE company_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 2', [COMPANY]);
  if (users.length < 2) throw new Error('The suite needs two users in the company (requester and approver).');
  const c = { companyId: COMPANY, userId: users[0].id };          // the salesman / buyer who asks
  const md = { companyId: COMPANY, userId: users[1].id };         // Management, who decides
  const asMd = { can: all, isAdmin: false };
  await quietCodes(db, COMPANY);
  const [[l923]] = await db.query('SELECT id, locked_at, (SELECT COUNT(*) FROM cf_production_releases r WHERE r.order_line_id = 923 AND r.deleted_at IS NULL) AS rel FROM cf_sales_order_lines WHERE id = 923');

  // ── fixture: a girder template (GR → SG ×2 → CL ×4 + BK ×1), operations, specs, a process WITH the acceptance stage ──
  const G = await girder(db, c, tag);
  const S = await simple(db, c, `${tag}S`);
  const fab = await OPS.createOperation(db, c, { code: `${tag}-FAB`, name: `Fabrication ${tag}` });
  const paint = await OPS.createOperation(db, c, { code: `${tag}-PNT`, name: `Painting ${tag}` });
  const ins = async (sql, params) => (await db.query(sql, params))[0].insertId;
  const spec = (code, name, uom) => ins("INSERT INTO cf_specifications (company_id, code, name, data_type, default_uom, status) VALUES (?, ?, ?, 'number', ?, 'active')", [COMPANY, code, name, uom]);
  const SA = `TSA${RUN}`; const COATS = `TCO${RUN}`;
  const saId = await spec(SA, `Surface area ${tag}`, 'm2');
  const coatsId = await spec(COATS, `Coats ${tag}`, null);
  const [[weightSpec]] = await db.query("SELECT id FROM cf_specifications WHERE company_id = ? AND code = 'WEIGHT' AND deleted_at IS NULL", [COMPANY]);
  const prc = await PROC.createProcess(db, c, { code: `${tag}-PRC`, name: `Acceptance test ${tag}` });
  await PROC.replaceStages(db, c, prc.id, { stages: ['structure', 'lock', 'nesting', 'buying', 'acceptance', 'production'].map((stageKey) => ({ stageKey })) });
  await PROC.setProcessStatus(db, c, prc.id, 'active');
  const VA = await ins("INSERT INTO cf_parties (company_id, code, name, is_supplier, status) VALUES (?, ?, ?, 1, 'active')", [COMPANY, `${tag}-VA`, `${tag} Vendor A`]);
  const VB = await ins("INSERT INTO cf_parties (company_id, code, name, is_supplier, status) VALUES (?, ?, ?, 1, 'active')", [COMPANY, `${tag}-VB`, `${tag} Vendor B`]);

  /** An inquiry for `qty` girders, frozen, on the acceptance process; WEIGHT 2000 kg a girder; part areas; 3 coats. */
  const makeOrder = async (key, qty) => {
    const o = await G.girderOrder(key, qty, { status: 'inquiry', lock: true });
    await db.query('UPDATE cf_sales_orders SET process_id = ? WHERE id = ?', [prc.id, o.id]);
    const [[line]] = await db.query('SELECT item_id FROM cf_sales_order_lines WHERE id = ?', [o.lineId]);
    await db.query(`INSERT INTO cf_spec_values (company_id, specification_id, subject_type, subject_id, value_number, uom, source) VALUES (?, ?, 'master', ?, 2000, 'kg', 'entered')
                    ON DUPLICATE KEY UPDATE value_number = 2000, uom = 'kg'`, [COMPANY, weightSpec.id, line.item_id]);
    const tree = await B.explode(db, COMPANY, line.item_id, { rootQuantity: qty });
    const parts = [];
    const walk = (n) => { const kids = n.children.filter((x) => x.kind === 'temporary'); if (n.kind === 'temporary' && !kids.length) parts.push(n); kids.forEach(walk); };
    walk(tree.root);
    for (const p of parts) {
      const area = /Cleat/.test(p.name) ? 0.5 : 2;
      await db.query("INSERT INTO cf_spec_values (company_id, specification_id, subject_type, subject_id, value_number, source) VALUES (?, ?, 'master', ?, ?, 'entered')", [COMPANY, saId, p.id, area]);
    }
    await db.query('INSERT INTO cf_order_spec_defaults (company_id, order_id, order_line_id, specification_id, value_number) VALUES (?, ?, NULL, ?, 3)', [COMPANY, o.id, coatsId]);
    return { ...o, parts };
  };

  /* ════════════════════ 1. templates ════════════════════ */
  section('1. Templates — charges, milestones, post-production stages');
  const chargesRows = {
    charges: [
      { key: 'fab', label: 'Fabrication', operationId: fab.id, basis: { type: 'weight', weight: 'drawing' }, rate: 45000, billing: 'pro_rata' },
      { key: 'pnt', label: 'Painting', operationId: paint.id, basis: { type: 'formula', expression: `${SA} * ${COATS}`, unit: 'm2' }, rate: 120, billing: 'on_completion' },
    ],
    material: { rate: 70000, weight: 'drawing' },
    lumpSums: [{ key: 'tr', label: 'Transport', amount: 50000 }],
  };
  const msRows = {
    milestones: [
      { key: 'm1', label: 'Advance', kind: 'percent', value: 10, trigger: { type: 'order_accepted' }, creditDays: 0 },
      { key: 'm2', label: 'Material in place', kind: 'percent', value: 20, trigger: { type: 'material_in_place' }, proRata: true, creditDays: 15 },
      { key: 'm3', label: 'On dispatch', kind: 'percent', value: 50, trigger: { type: 'dispatched', mode: 'each' }, creditDays: 30 },
      { key: 'm4', label: 'After inspection', kind: 'percent', value: 10, trigger: { type: 'post_stage', stageKey: 's1' }, creditDays: 30 },
      { key: 'm5', label: 'Retention', kind: 'percent', value: 10, trigger: { type: 'retention', months: 12, milestoneKey: 'm3' }, creditDays: 0 },
    ],
  };
  const stRows = { stages: [{ key: 's1', name: 'Inspection by RITES' }, { key: 's2', name: 'Erection at site' }] };
  const badKind = await refusal(() => ACC.createTemplate(db, c, { kind: 'prices', name: 'x', rows: {} }));
  ok('a template of an unknown kind is refused', badKind?.status === 422);
  const badCharge = await refusal(() => ACC.createTemplate(db, c, { kind: 'charges', name: 'Bad', rows: { charges: [{ label: 'X', basis: { type: 'formula', expression: 'SUM(children.WEIGHT)', unit: 't' }, billing: 'pro_rata' }] } }));
  ok('a template with a roll-up formula is refused', said(badCharge, /leave out SUM/), j(badCharge?.problems));
  const tCh0 = await ACC.createTemplate(db, c, { kind: 'charges', name: `${tag} old`, isDefault: true, rows: { charges: [{ label: 'Only fab', basis: { type: 'weight', weight: 'actual' }, billing: 'on_completion' }] } });
  ok('a charges template may leave operation and rate for the order', tCh0.isDefault && tCh0.rows.charges[0].operationId === null && tCh0.rows.charges[0].rate === null, j(tCh0.rows));
  const tCh = await ACC.createTemplate(db, c, { kind: 'charges', name: `${tag} Bridge girders`, isDefault: true, rows: chargesRows });
  const tMs = await ACC.createTemplate(db, c, { kind: 'milestones', name: `${tag} 10-20-50-10-10`, isDefault: true, rows: msRows });
  const tSt = await ACC.createTemplate(db, c, { kind: 'stages', name: `${tag} RITES + erection`, isDefault: true, rows: stRows });
  const list = await ACC.listTemplates(db, COMPANY, { kind: 'charges' });
  ok('one default per kind: the newer default took over', list.rows.filter((t) => t.isDefault).length === 1 && list.rows.find((t) => t.isDefault).id === tCh.id);
  ok('the milestone template keeps its post-stage link', tMs.rows.milestones[3].trigger.type === 'post_stage' && tMs.rows.milestones[3].trigger.stageKey === 's1', j(tMs.rows.milestones[3]));
  const renamed = await ACC.updateTemplate(db, c, tSt.id, { name: `${tag} Inspection and erection` });
  ok('a template is renamed', renamed.name.endsWith('Inspection and erection'));

  /* ════════════════════ 2. prefill + estimate ════════════════════ */
  section('2. A new acceptance starts from the default templates — and its estimate');
  const O1 = await makeOrder('A', 2);
  let A1 = await ACC.getAcceptance(db, COMPANY, O1.id);
  ok('state none, prefilled from the templates', A1.state === 'none' && A1.fromTemplates && A1.terms.charges.length === 2 && A1.terms.milestones.length === 5 && A1.terms.stages.length === 2, j([A1.state, A1.terms.charges.length]));
  ok('weight: 2 girders × 2000 kg = 4 t', near(A1.estimate.tonnes, 4), String(A1.estimate.tonnes));
  const fabEst = A1.estimate.charges.find((x) => x.key === 'fab');
  const pntEst = A1.estimate.charges.find((x) => x.key === 'pnt');
  ok('fabrication = 4 t × ₹45,000 = ₹1,80,000', near(fabEst.amount, 180000), j(fabEst));
  const cl = O1.parts.filter((p) => /Cleat/.test(p.name)).reduce((t, p) => t + p.total, 0);
  const bk = O1.parts.filter((p) => !/Cleat/.test(p.name)).reduce((t, p) => t + p.total, 0);
  const area = (cl * 0.5 + bk * 2) * 3;
  ok(`painting = Σ parts (area × coats from the ORDER's value) = ${area} m2 × ₹120`, near(pntEst.quantity, area) && near(pntEst.amount, area * 120), j([pntEst, cl, bk]));
  ok('material on the lines we buy: 4 t × ₹70,000', near(A1.estimate.material.amount, 280000), j(A1.estimate.material));
  const value = 180000 + area * 120 + 280000 + 50000;
  ok('the order value adds charges, material and lump sums', near(A1.estimate.value, value), String(A1.estimate.value));
  ok('milestones: 10 % = ₹' + Math.round(value * 0.1), near(A1.estimate.milestones[0].amount, value * 0.1) && near(A1.estimate.milestonesTotal, value));
  ok('no MR yet: the material cost is not known (no margin)', A1.estimate.materialCost === null && /No MR yet/.test(A1.estimate.materialCostNote));
  ok('the step lists operations, formula fields and every trigger', A1.lists.operations.some((o) => o.id === fab.id) && A1.lists.formulaFields.some((f) => f.code === SA) && A1.lists.triggers.length === 12);

  /* ════════════════════ 3. every trigger type, checked ════════════════════ */
  section('3. Milestone triggers — every type, good and bad');
  const base = () => JSON.parse(JSON.stringify(A1.terms));
  const tryTerms = (patch) => { const t = base(); patch(t); return ACC.saveAcceptance(db, c, O1.id, { ...t, dryRun: true }); };
  // The MR is not raised yet (step 4): every dry run says so first; the triggers are judged on the rest.
  const problemsOf = async (patch) => (await tryTerms(patch)).problems.filter((p) => p !== ACC.MR_FIRST);
  ok('before the MR is raised and shared, the check says so first', (await tryTerms(() => {})).problems[0] === ACC.MR_FIRST);
  const noMr = await refusal(() => ACC.saveAcceptance(db, c, O1.id, base()));
  ok('…and sending for approval is refused, naming the MR step', said(noMr, /Raise the MR in the Material request step and share it with the customer first/), j(noMr?.problems));
  const one = (trigger, extra = {}) => (t) => { t.milestones = [{ key: 'x1', label: 'All', kind: 'percent', value: 100, trigger, creditDays: 0, ...extra }]; };
  eq('the prefilled terms are clean', await problemsOf(() => {}), []);
  for (const tt of ['order_accepted', 'design_frozen', 'material_in_place', 'production_started', 'fully_dispatched']) {
    eq(`${tt}: accepted as it is`, await problemsOf(one({ type: tt })), []);
  }
  ok('operation_completed needs its operation', (await problemsOf(one({ type: 'operation_completed' }))).some((p) => /choose the operation/.test(p)));
  eq('operation_completed with an operation, pro-rata: accepted', await problemsOf(one({ type: 'operation_completed', operationId: fab.id }, { proRata: true })), []);
  ok('dispatched needs "each" or "all"', (await problemsOf(one({ type: 'dispatched' }))).some((p) => /each dispatch/.test(p)));
  const each = (await tryTerms(one({ type: 'dispatched', mode: 'each' }))).terms.milestones[0];
  const allD = (await tryTerms(one({ type: 'dispatched', mode: 'all' }, { proRata: true }))).terms.milestones[0];
  ok('each dispatch is pro-rata; "when everything is dispatched" is not', each.proRata === true && allD.proRata === false);
  ok('post_stage needs a stage of this order', (await problemsOf(one({ type: 'post_stage', stageKey: 'nope' }))).some((p) => /post-production stage/.test(p)));
  eq('post_stage on s2: accepted', await problemsOf(one({ type: 'post_stage', stageKey: 's2' })), []);
  ok('days_after: whole days from 1, and after what', (await problemsOf(one({ type: 'days_after', days: 0 }))).length >= 2);
  ok('days_after cannot follow another days_after', (await problemsOf(one({ type: 'days_after', days: 5, after: { type: 'days_after', days: 2, after: { type: 'order_accepted' } } }))).some((p) => /when it is due/.test(p)));
  eq('30 days after design frozen: accepted', await problemsOf(one({ type: 'days_after', days: 30, after: { type: 'design_frozen' } })), []);
  ok('fixed_date needs a date', (await problemsOf(one({ type: 'fixed_date', date: '31-12-2026' }))).some((p) => /give the date/.test(p)));
  eq('fixed date 2026-12-31: accepted', await problemsOf(one({ type: 'fixed_date', date: '2026-12-31' })), []);
  ok('retention must follow another milestone', (await problemsOf(one({ type: 'retention', months: 6, milestoneKey: 'x1' }))).some((p) => /retention follows/.test(p)));
  ok('retention needs months from 1', (await problemsOf((t) => { t.milestones[4].trigger.months = 0; })).some((p) => /months/.test(p)));
  ok('customer material received: refused when we buy every line', (await problemsOf(one({ type: 'customer_material_received' }))).some((p) => /comes from the customer/.test(p)));
  ok('an unknown trigger is refused', (await problemsOf(one({ type: 'invoice_paid' }))).some((p) => /when it is due/.test(p)));
  ok('pro-rata on "order accepted" is refused', (await problemsOf(one({ type: 'order_accepted' }, { proRata: true }))).some((p) => /pro-rata is for/.test(p)));
  ok('credit days are 0–365', (await problemsOf((t) => { t.milestones[0].creditDays = -1; })).some((p) => /credit days/.test(p)));
  ok('the milestones must make 100 %', (await problemsOf((t) => { t.milestones[0].value = 5; })).some((p) => /add up to 95/.test(p)));
  ok('a fixed amount may stand beside percentages', (await problemsOf((t) => { t.milestones[0] = { ...t.milestones[0], kind: 'amount', value: 50000 }; })).length === 0);
  ok('a formula with an unknown value is refused', (await problemsOf((t) => { t.charges[1].basis.expression = 'NOPE_X * 2'; })).some((p) => /not a number specification/.test(p)));
  ok('a formula needs its unit', (await problemsOf((t) => { t.charges[1].basis.unit = ''; })).some((p) => /unit of the formula/.test(p)));
  ok('a charge needs its operation and rate', (await problemsOf((t) => { t.charges[0].operationId = null; t.charges[0].rate = ''; })).length >= 2);
  ok('nothing to charge is refused', (await problemsOf((t) => { t.charges = []; t.material = null; t.lumpSums = []; })).some((p) => /at least one charge/.test(p)));

  /* ════════════════════ 4. the MR before acceptance: shared, held ════════════════════ */
  section('4. Raise the MR before acceptance — shared with the customer, nothing downstream');
  const raised = await RQ.raiseRequisitions(db, c, O1.id, { earmark: true });
  const mr1 = raised.requisitions[0];
  ok('the MR is raised HELD for acceptance; nothing earmarked, no customer PO', raised.heldForAcceptance === true && mr1.heldForAcceptance === true && raised.earmarked.length === 0 && raised.customerPurchaseOrders.length === 0, j([raised.heldForAcceptance, raised.earmarked]));
  let screen = await PRS.mrScreen(db, COMPANY, mr1.id);
  ok('the MR screen in Purchase cannot be edited yet, and says why', screen.canEdit === false && /waits for the customer's acceptance/.test(screen.reason), screen.reason);
  const held = await refusal(() => PRS.saveMr(db, c, mr1.id, { lines: [] }));
  ok('saving the MR (stock take, the PR) is refused while held', held?.code === 'HELD_FOR_ACCEPTANCE', held?.message);
  const [[{ prs0 }]] = await db.query('SELECT COUNT(*) AS prs0 FROM cf_buy_requests WHERE company_id = ? AND order_id = ? AND deleted_at IS NULL', [COMPANY, O1.id]);
  ok('no purchase request exists', Number(prs0) === 0);
  const pdf = await DOC.mrDocument(db, COMPANY, O1.id, 'pdf');
  const xlsx = await DOC.mrDocument(db, COMPANY, O1.id, 'xlsx');
  ok('the MR as a PDF for the customer', pdf.buffer.subarray(0, 4).toString() === '%PDF' && pdf.rows === 3 && /\.pdf$/.test(pdf.filename), `${pdf.rows} rows`);
  ok('the MR as an Excel file', xlsx.buffer.subarray(0, 2).toString() === 'PK' && xlsx.rows === 3 && /\.xlsx$/.test(xlsx.filename));
  ok('the PDF text is drawable (× becomes x)', DOC.pdfText('14 × 3000 ₹') === '14 x 3000 Rs ');
  let proc = await PROC.orderProcess(db, COMPANY, O1.id);
  const st = (p, k) => p.stages.find((s) => s.stageKey === k);
  ok('Material request is done once the MR is raised and shared', st(proc, 'buying').state === 'done' && /shared with the customer/.test(st(proc, 'buying').detail), j(st(proc, 'buying')));
  ok('Customer acceptance is to do; Production waits for it', st(proc, 'acceptance').state === 'todo' && st(proc, 'production').waitingOn?.stageKey === 'acceptance', j([st(proc, 'acceptance'), st(proc, 'production').waitingOn]));
  ok('the stage catalogue puts acceptance after the MR, before production', proc.stages.map((s) => s.stageKey).join(',') === 'structure,lock,nesting,buying,acceptance,production', proc.stages.map((s) => s.stageKey).join(','));

  /* ════════════════════ 5. confirm only through the acceptance ════════════════════ */
  section('5. Confirmed = accepted: the plain Confirm is gone');
  const viaRoute = await refusal(() => SO.setOrderStatus(db, c, O1.id, 'confirmed', { fromRoute: true }));
  ok('the status route refuses to confirm a customer order', viaRoute?.code === 'ACCEPTANCE_FIRST', viaRoute?.message);
  const viaService = await refusal(() => SO.setOrderStatus(db, c, O1.id, 'confirmed'));
  ok('…and so does any other caller, when the process has the acceptance stage', viaService?.code === 'ACCEPTANCE_FIRST');
  const o1 = await SO.getOrder(db, COMPANY, O1.id);
  ok('the order offers no Confirm move', !o1.allowedTransitions.includes('confirmed') && o1.allowedTransitions.includes('quoted'), j(o1.allowedTransitions));

  /* ════════════════════ 6. save → pending ════════════════════ */
  section('6. Save the acceptance → pending approval');
  A1 = await ACC.saveAcceptance(db, c, O1.id, { ...base(), note: 'Customer agreed on the call.' });
  ok('pending, version 1, an approval in the inbox', A1.state === 'pending' && A1.pending.version === 1 && !!A1.pending.approvalId, j([A1.state, A1.pending?.version]));
  const firstApproval = A1.pending.approvalId;
  A1 = await ACC.saveAcceptance(db, c, O1.id, { ...base(), note: 'Customer agreed — transport added.' });
  ok('saving again replaces the pending version (still v1, one approval)', A1.pending.version === 1 && A1.pending.approvalId === firstApproval && A1.versions.length === 1);
  proc = await PROC.orderProcess(db, COMPANY, O1.id);
  ok('the stage says it waits for Management', st(proc, 'acceptance').state === 'partial' && /waiting for approval/.test(st(proc, 'acceptance').detail));
  let board = await BOARD.orderBoard(db, COMPANY, { search: tag });
  const card = (b, id) => b.lanes.flatMap((l) => l.cards).find((x) => x.id === id);
  ok('the board shows it in Pending approval', card(board, O1.id)?.lane === 'pending_approval', card(board, O1.id)?.lane);
  // Supply stays editable until accepted; the held MR follows.
  await SO.setLineSupply(db, c, O1.lineId, { supply: 'customer' });
  let [[mrRow]] = await db.query('SELECT supply FROM cf_requisitions WHERE id = ?', [mr1.id]);
  ok('while held, the MR follows a change of who supplies the line', mrRow.supply === 'customer');
  await SO.setLineSupply(db, c, O1.lineId, { supply: null });
  [[mrRow]] = await db.query('SELECT supply FROM cf_requisitions WHERE id = ?', [mr1.id]);
  ok('…and back', mrRow.supply === 'we_buy');

  /* ════════════════════ 7. the inbox, per permission; requester ≠ approver; reject ════════════════════ */
  section('7. Management inbox — per permission, requester ≠ approver, sent back');
  const onlyPo = (t) => t === 'cf_erp_approve_purchase_order';
  const inboxPo = await AP.listApprovals(db, COMPANY, onlyPo, {});
  ok('a PO approver does not see acceptances', !inboxPo.rows.some((r) => r.id === firstApproval) && inboxPo.types.length === 1 && inboxPo.types[0].key === 'purchase_order');
  const none = await AP.listApprovals(db, COMPANY, () => false, {});
  ok('no approval tag → nothing (and no types)', none.rows.length === 0 && none.types.length === 0);
  let inbox = await AP.listApprovals(db, COMPANY, (t) => t === 'cf_erp_approve_order_acceptance', {});
  let row = inbox.rows.find((r) => r.id === firstApproval);
  ok('the acceptance approver sees it, with its context: charges, milestones, stages, estimate', !!row && row.context?.terms?.charges?.length === 2 && row.context.terms.charges[0].operation === `Fabrication ${tag}` && row.context.terms.stages.length === 2 && near(row.context.estimate.value, value), j(row?.context?.estimate?.value));
  ok('…who asked, the amount and the note', row.requestedBy.id === c.userId && near(row.amount, value) && /transport added/.test(row.requestNote ?? ''), j([row.requestedBy, row.amount, row.requestNote]));
  ok('the inbox counts what waits per type', inbox.counts.order_acceptance >= 1);
  const own = await refusal(() => AP.decide(db, c, firstApproval, { decision: 'approve' }, { can: all, isAdmin: false }));
  ok('the person who asked cannot approve it', own?.code === 'OWN_REQUEST' && own.status === 403, own?.message);
  const noTag = await refusal(() => AP.decide(db, md, firstApproval, { decision: 'approve' }, { can: onlyPo, isAdmin: false }));
  ok('Management without the acceptance tag cannot approve it', noTag?.status === 403);
  const noWhy = await refusal(() => AP.decide(db, md, firstApproval, { decision: 'reject' }, asMd));
  ok('a rejection needs a reason', noWhy?.code === 'REASON');
  await AP.decide(db, md, firstApproval, { decision: 'reject', note: 'Painting rate is too low.' }, asMd);
  A1 = await ACC.getAcceptance(db, COMPANY, O1.id);
  ok('sent back: the reason is shown, the order is not confirmed', A1.state === 'rejected' && A1.sentBack.decisionNote === 'Painting rate is too low.' && A1.order.status === 'inquiry', j([A1.state, A1.order.status]));
  proc = await PROC.orderProcess(db, COMPANY, O1.id);
  ok('the stage says it was sent back, and why', /Sent back: Painting rate is too low/.test(st(proc, 'acceptance').detail), st(proc, 'acceptance').detail);
  const twice = await refusal(() => AP.decide(db, md, firstApproval, { decision: 'approve' }, asMd));
  ok('a decided approval cannot be decided again', twice?.code === 'NOT_PENDING');

  /* ════════════════════ 8. approve → confirmed, MR released, terms locked ════════════════════ */
  section('8. Approve — confirmed, MR released to Purchase, terms locked');
  const t2 = base(); t2.charges[1].rate = 150;
  A1 = await ACC.saveAcceptance(db, c, O1.id, t2);
  ok('a new version after a rejection (v2), pending', A1.pending.version === 2 && A1.versions.length === 2);
  const r8 = await AP.decide(db, md, A1.pending.approvalId, { decision: 'approve', note: 'OK.' }, asMd);
  ok('approved: the order is confirmed', r8.result?.confirmed === true && r8.approval.status === 'approved', j(r8.result));
  A1 = await ACC.getAcceptance(db, COMPANY, O1.id);
  ok('the terms are LOCKED (approved v2 in force)', A1.locked === true && A1.approved.version === 2 && A1.order.status === 'confirmed' && A1.state === 'approved', j([A1.locked, A1.approved?.version, A1.order.status]));
  ok('a change now is a rate change (said before the save)', /rate change/.test(A1.saveMeans));
  ok('who supplies the material is fixed now', A1.supplyEditable === false);
  const fixedSupply = await refusal(() => SO.setLineSupply(db, c, O1.lineId, { supply: 'customer' }));
  ok('…and the server refuses a change', fixedSupply?.status === 422);
  screen = await PRS.mrScreen(db, COMPANY, mr1.id);
  ok('the MR is released: Purchase can edit it', screen.heldForAcceptance === false && screen.canEdit === true);
  screen = await PRS.saveMr(db, c, mr1.id, { lines: screen.lines.map((l) => ({ lineId: l.id, takeFromStock: 0 })) });
  ok('saving the MR now makes its purchase request', !!screen.purchaseRequest?.id, j(screen.purchaseRequest));
  ok('the post-production checklist is made from the stages', A1.postStages.map((s) => s.name).join(' | ') === 'Inspection by RITES | Erection at site');
  let events = await ACC.orderEvents(db, COMPANY, O1.id);
  ok('an event "order_accepted" is recorded', events.some((e) => e.type === 'order_accepted'));
  proc = await PROC.orderProcess(db, COMPANY, O1.id);
  ok('Customer acceptance is done', st(proc, 'acceptance').state === 'done' && /approved/.test(st(proc, 'acceptance').detail));
  board = await BOARD.orderBoard(db, COMPANY, { search: tag });
  ok('the board moves it to Material by itself', card(board, O1.id)?.lane === 'material' && /locked/.test(card(board, O1.id).facts.material), j(card(board, O1.id)?.facts));

  /* ════════════════════ 9. rate change after acceptance ════════════════════ */
  section('9. Rate change after acceptance — a new approval');
  const same = await refusal(() => ACC.saveAcceptance(db, c, O1.id, A1.terms));
  ok('saving the approved terms unchanged is refused', said(same, /Nothing changed/), j([same?.message, same?.problems]));
  const t3 = JSON.parse(JSON.stringify(A1.terms)); t3.charges[0].rate = 48000;
  A1 = await ACC.saveAcceptance(db, c, O1.id, t3);
  ok('a rate change is pending (v3); the approved v2 stays in force', A1.pending.kind === 'rate_change' && A1.pending.version === 3 && A1.approved.version === 2 && A1.locked);
  inbox = await AP.listApprovals(db, COMPANY, (t) => t === 'cf_erp_approve_rate_change', {});
  row = inbox.rows.find((r) => r.subject.id === A1.pending.id);
  ok('it is a "rate change" approval, with what changed', row?.type === 'rate_change' && row.context.changes.some((x) => /Fabrication: rate 45000 → 48000/.test(x)), j(row?.context?.changes));
  const accOnly = await AP.listApprovals(db, COMPANY, (t) => t === 'cf_erp_approve_order_acceptance', {});
  ok('…which the acceptance tag alone does not see', !accOnly.rows.some((r) => r.id === row.id));
  await AP.decide(db, md, row.id, { decision: 'approve' }, asMd);
  A1 = await ACC.getAcceptance(db, COMPANY, O1.id);
  ok('approved: v3 in force, v2 superseded', A1.approved.version === 3 && A1.versions.find((v) => v.version === 2).status === 'superseded' && A1.terms.charges[0].rate === 48000);
  events = await ACC.orderEvents(db, COMPANY, O1.id);
  ok('an event "terms_changed" is recorded', events.some((e) => e.type === 'terms_changed'));

  /* ════════════════════ 10. a PO's approval through the inbox ════════════════════ */
  section('10. A purchase order is approved in the inbox — with how its rates compare');
  let pr = await PRS.addVendor(db, c, screen.purchaseRequest.id, { supplierId: VA });
  pr = await PRS.addVendor(db, c, pr.id, { supplierId: VB });
  const col = (p, s) => p.vendors.find((v) => Number(v.supplier.id) === Number(s));
  pr = await PRS.setQuotes(db, c, col(pr, VA).id, { quotes: pr.lines.map((l) => ({ lineId: l.id, rate: 100, deliveryDays: 7 })) });
  pr = await PRS.setQuotes(db, c, col(pr, VB).id, { quotes: pr.lines.map((l) => ({ lineId: l.id, rate: 90, deliveryDays: 9 })) });
  const [l1, l2] = pr.lines;
  const rA = await PRS.raisePo(db, c, col(pr, VA).id, { lines: [{ lineId: l1.id, quantity: l1.open }] });
  const poA = rA.purchaseOrder;
  ok('the PO waits for approval and says so', poA.stage === 'pending_approval' && poA.pendingApprovals.length === 1 && poA.pendingApprovals[0].type === 'purchase_order', j(poA.pendingApprovals));
  inbox = await AP.listApprovals(db, COMPANY, onlyPo, {});
  row = inbox.rows.find((r) => r.subject.id === poA.id);
  const ctxLine = row?.context?.lines?.[0];
  ok('the inbox shows vendor, lines, rate, and the other vendor\'s quote', row?.context?.vendor?.id === VA && ctxLine?.rate === 100 && ctxLine.quotes.some((q) => q.supplier.id === VB && q.rate === 90) && /above the lowest/.test(ctxLine.comparison), j(ctxLine));
  ok('…and the amount', near(row.amount, 100 * l1.open));
  const ownPo = await refusal(() => AP.decide(db, c, row.id, { decision: 'approve' }, { can: all, isAdmin: false }));
  ok('the buyer who raised it cannot approve it', ownPo?.code === 'OWN_REQUEST');
  const adminOwn = await AP.decide(db, c, row.id, { decision: 'approve' }, { can: all, isAdmin: true });
  ok('an admin may approve their own (as elsewhere): the PO is placed', adminOwn.result?.stage === 'waiting' && adminOwn.approval.status === 'approved', j(adminOwn.result?.stage));
  const rB = await PRS.raisePo(db, c, col(pr, VB).id, { lines: [{ lineId: l2.id, quantity: l2.open }] });
  const rowB = (await AP.listApprovals(db, COMPANY, onlyPo, {})).rows.find((r) => r.subject.id === rB.purchaseOrder.id);
  ok('the lowest quote says so', rowB.context.lines[0].comparison === 'The lowest quote.', rowB.context.lines[0].comparison);
  const rej = await AP.decide(db, md, rowB.id, { decision: 'reject', note: 'Wait for a better date.' }, asMd);
  ok('sent back: the PO is not placed, the reason is on it', rej.result?.stage === 'requested' && /Sent back by Management: Wait for a better date/.test(rej.result.notes ?? ''), j([rej.result?.stage]));
  const again = await PS.markOrdered(db, c, rB.purchaseOrder.id, {});
  ok('sent for approval again → a new pending approval', again.stage === 'pending_approval' && again.pendingApprovals.length === 1);
  const direct = await PS.approvePurchaseOrder(db, md, rB.purchaseOrder.id, {});
  ok('approved another way (a script): its inbox row closes too', direct.stage === 'waiting' && direct.pendingApprovals.length === 0);

  /* ════════════════════ 11. close short needs approval ════════════════════ */
  section('11. Closing a PO short needs approval');
  const lineA = poA.lines[0];
  await PS.receiveLine(db, c, lineA.id, { quantity: Math.max(1, Math.floor(lineA.quantity / 2)), stockingAreaId: G.store });
  const asked = await PS.requestCloseShort(db, c, poA.id, { reason: 'The mill stopped this size.' });
  ok('asking to close short changes nothing yet', asked.closed === null && asked.pendingApprovals.some((a) => a.type === 'po_close_short'), j(asked.pendingApprovals));
  const noReason = await refusal(() => PS.requestCloseShort(db, c, poA.id, {}));
  ok('a reason is needed', noReason?.code === 'REASON');
  const cs = (await AP.listApprovals(db, COMPANY, (t) => t === 'cf_erp_approve_po_close_short', {})).rows.find((r) => r.subject.id === poA.id);
  ok('the inbox shows the reason and what would not come', cs?.type === 'po_close_short' && /mill stopped/.test(cs.context.reason) && cs.context.lines[0].pending > 0, j(cs?.context?.reason));
  const closed = await AP.decide(db, md, cs.id, { decision: 'approve' }, asMd);
  ok('approved: the PO is closed short with that reason', closed.result?.stage === 'closed_short' && closed.result.closed.reason === 'The mill stopped this size.', j(closed.result?.closed));

  /* ════════════════════ 12. the board, from facts; the checklist ════════════════════ */
  section('12. The board moves by itself; the post-production checklist');
  await db.query('INSERT INTO cf_production_releases (company_id, order_id, order_line_id, item_id, quantity) SELECT company_id, order_id, id, item_id, quantity FROM cf_sales_order_lines WHERE id = ?', [O1.lineId]);
  board = await BOARD.orderBoard(db, COMPANY, { search: tag });
  ok('released → In production', card(board, O1.id).lane === 'in_production');
  await db.query('UPDATE cf_sales_order_lines SET delivered_qty = 1 WHERE id = ?', [O1.lineId]);
  board = await BOARD.orderBoard(db, COMPANY, { search: tag });
  ok('one girder of two shipped → Dispatched', card(board, O1.id).lane === 'dispatched' && /0 of 1 line/.test(card(board, O1.id).facts.dispatched));
  await db.query('UPDATE cf_sales_order_lines SET delivered_qty = 2 WHERE id = ?', [O1.lineId]);
  board = await BOARD.orderBoard(db, COMPANY, { search: tag });
  let c1 = card(board, O1.id);
  ok('everything shipped → Post-production, with its own stages as a checklist', c1.lane === 'post_production' && c1.stages.length === 2 && c1.stagesDone === 0 && !c1.canClose);
  const s1 = c1.stages[0];
  const future = await refusal(() => BOARD.markStageDone(db, c, s1.id, { date: '2099-01-01' }));
  ok('a stage cannot be done in the future', future?.status === 422);
  const d1 = await BOARD.markStageDone(db, c, s1.id, { date: '2026-10-17', note: 'RITES IC no. 4411' });
  ok('ticked: date, note and who are recorded', d1.stage.done && d1.stage.doneOn === '2026-10-17' && d1.stage.doneNote === 'RITES IC no. 4411' && d1.stage.doneBy.id === c.userId && !d1.orderClosed);
  const dup = await refusal(() => BOARD.markStageDone(db, c, s1.id, {}));
  ok('a stage done once cannot be done twice', dup?.code === 'DONE');
  await BOARD.undoStageDone(db, c, s1.id, { note: 'Wrong order.' });
  await BOARD.markStageDone(db, c, s1.id, { date: '2026-10-18', note: 'RITES IC no. 4412' });
  events = await ACC.orderEvents(db, COMPANY, O1.id);
  ok('every tick and undo is an event billing reads', events.filter((e) => e.type === 'post_stage_done').length === 2 && events.some((e) => e.type === 'post_stage_undone') && events.find((e) => e.type === 'post_stage_done').date === '2026-10-18');
  const d2 = await BOARD.markStageDone(db, c, c1.stages[1].id, { note: 'Erected.' });
  ok('the last stage done → the order closes by itself', d2.orderClosed === true);
  board = await BOARD.orderBoard(db, COMPANY, { search: tag });
  ok('…and the board shows it Closed', card(board, O1.id)?.lane === 'closed');
  events = await ACC.orderEvents(db, COMPANY, O1.id);
  ok('an event "order_closed" is recorded', events.some((e) => e.type === 'order_closed'));
  ok('the lanes are the seven, in order', board.lanes.map((l) => l.key).join(',') === 'inquiry,pending_approval,material,in_production,dispatched,post_production,closed');
  ok('laneOf: an inquiry with nothing pending is Inquiry', BOARD.laneOf({ status: 'inquiry', acceptancePending: false }) === 'inquiry');

  /* ════════════════════ 8b. a customer-supplied order: its ₹0 PO waits for the acceptance ════════════════════ */
  section('8b. Customer supplies the material — the ₹0 PO is made only on approval, dated as promised');
  const O2 = await makeOrder('C', 1);
  await SO.updateOrder(db, c, O2.id, { materialSupply: 'customer' });
  const r2 = await RQ.raiseRequisitions(db, c, O2.id, { customerDate: '2026-11-05' });
  ok('held: no ₹0 PO to the customer yet', r2.heldForAcceptance && r2.customerPurchaseOrders.length === 0);
  await SO.updateOrder(db, c, O2.id, { materialSupply: 'we_buy' });
  let [[mr2]] = await db.query('SELECT supply FROM cf_requisitions WHERE order_id = ? AND deleted_at IS NULL', [O2.id]);
  ok('the order\'s supply is still editable while the MR is held — the MR follows', mr2.supply === 'we_buy');
  await SO.updateOrder(db, c, O2.id, { materialSupply: 'customer' });
  [[mr2]] = await db.query('SELECT supply FROM cf_requisitions WHERE order_id = ? AND deleted_at IS NULL', [O2.id]);
  ok('…and back to the customer', mr2.supply === 'customer');
  let A2 = await ACC.getAcceptance(db, COMPANY, O2.id);
  const t4 = JSON.parse(JSON.stringify(A2.terms));
  const noMat = (await ACC.saveAcceptance(db, c, O2.id, { ...t4, dryRun: true })).problems;
  ok('no material row when the customer supplies everything', noMat.some((p) => /customer supplies every line/.test(p)), j(noMat));
  t4.material = null;
  t4.milestones[1].trigger = { type: 'customer_material_received' };
  t4.milestones[1].proRata = true;
  A2 = await ACC.saveAcceptance(db, c, O2.id, t4);
  await AP.decide(db, md, A2.pending.approvalId, { decision: 'approve' }, asMd);
  const [cpo] = await db.query('SELECT p.id, p.expected_date, p.supplied_by_customer, p.status FROM cf_purchase_orders p WHERE p.company_id = ? AND p.for_order_id = ? AND p.deleted_at IS NULL', [COMPANY, O2.id]);
  ok('approved: the customer\'s ₹0 PO, placed, dated as they promised', cpo.length === 1 && Number(cpo[0].supplied_by_customer) === 1 && cpo[0].status === 'ordered' && String(cpo[0].expected_date instanceof Date ? `${cpo[0].expected_date.getFullYear()}-${String(cpo[0].expected_date.getMonth() + 1).padStart(2, '0')}-${String(cpo[0].expected_date.getDate()).padStart(2, '0')}` : cpo[0].expected_date).slice(0, 10) === '2026-11-05', j(cpo));

  /* ════════════════════ 13. a stock order; a revision ════════════════════ */
  section('13. A stock order confirms with its button; a revision carries the acceptance');
  const so = await SO.createOrder(db, c, { orderType: 'stock', code: `${tag}-STK` });
  await SO.addOrderLine(db, c, so.id, { recordId: S.FG, quantity: 1 });
  const stk = await SO.setOrderStatus(db, c, so.id, 'confirmed', { fromRoute: true });
  ok('a stock order: draft → confirmed by its button', stk.status === 'confirmed');
  const rev = await REV.reviseOrder(db, c, O2.id);
  const Arev = await ACC.getAcceptance(db, COMPANY, rev.id);
  ok('the revision is confirmed and its acceptance came with it, locked', rev.status === 'confirmed' && Arev.locked && Arev.approved.version === 1 && Arev.postStages.length === 2, j([rev.status, Arev.state, Arev.postStages.length]));

  const [[l923b]] = await db.query('SELECT id, locked_at, (SELECT COUNT(*) FROM cf_production_releases r WHERE r.order_line_id = 923 AND r.deleted_at IS NULL) AS rel FROM cf_sales_order_lines WHERE id = 923');
  ok('line 923 untouched', JSON.stringify(l923 ?? null) === JSON.stringify(l923b ?? null));
} catch (e) {
  console.error(e);
  ok(`no crash: ${e.message}`, false, e.problems ? j(e.problems) : '');
} finally {
  await db.rollback();
  detachNodeCache(db);
  db.release();
}
const after = await H.counts();
const changed = after.filter((a) => Number(before.find((b) => b.name === a.name)?.n) !== Number(a.n));
ok('rolled back: every cf_ table is as it was', changed.length === 0, j(changed));
console.log(`\n${H.state.passed} passed, ${H.state.failed} failed${H.state.failed ? `\n  ${H.state.fails.join('\n  ')}` : ''}`);
await pool.end();
process.exit(H.state.failed ? 1 : 0);
