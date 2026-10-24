/**
 * so_restructure_test.mjs — the sales order's steps, restructured (step 2 of the redesign, user 2026-10-18;
 * TM/CF_ERP_ORDER_FLOW_PLAN.md "2026-10-18 — Sales order steps v2", init.sql §72 / TM/s72.sql).
 *
 *   cd multi_app_be
 *   node scripts/cf_kepl/so_restructure_test.mjs
 *
 *   CF_FLOW_COMPANY (2 — the local KEPL copy, its "Bridge span" template)
 *
 * EVERYTHING HAPPENS INSIDE ONE TRANSACTION THAT IS ROLLED BACK (a TEST-SO-… order of its own); the last thing it
 * does is re-count every cf_ table.
 *
 *   1. the stage train: Structure & values → Execution plan → Freeze design → Nesting → Material request →
 *      Production; Line items retired (a stored row is kept, hidden; a process with Line items and no Structure
 *      reads it as Structure); order-wide steps say scope 'order'
 *   2. the order-wide structure: every line read in one answer; several lines' changes written in one call —
 *      all or none; lines reordered, a frozen line keeps its number
 *   3. the execution plan: defaults, the BOM levels, previews for whole order / line / unit / sub-assembly and
 *      for the dispatch levels, the checks (whole numbers, a level a line lacks, a dispatch unit bigger than a
 *      production order), a line's own plan, saving
 *   4. readiness: the Execution plan stage is to do until saved, then done; Freeze design points at it
 *   5. locked after freeze: a frozen line's plan cannot change, the order's change pins it, every line frozen =
 *      read only; a revision takes the plan with it; a removed line takes its own row
 */
import path from 'path';
import { pathToFileURL } from 'url';

const BE = process.cwd();
const imp = (p) => import(pathToFileURL(path.join(BE, p)).href);
const { pool } = await imp('db.js');
await imp('apps/cf_erp/services/codegenProvider.js');
const { attachNodeCache, detachNodeCache } = await imp('apps/cf_erp/lib/db.js');
const PROC = await imp('apps/cf_erp/services/processService.js');
const SO = await imp('apps/cf_erp/services/salesOrderService.js');
const B = await imp('apps/cf_erp/services/bomService.js');
const EP = await imp('apps/cf_erp/services/executionPlanService.js');
const M = await imp('apps/cf_erp/services/executionPlanModel.js');
const OS = await imp('apps/cf_erp/services/orderStructureService.js');
const REV = await imp('apps/cf_erp/services/revisionService.js');
const LOCK = await imp('apps/cf_erp/services/lockService.js');

const COMPANY = Number(process.env.CF_FLOW_COMPANY ?? 2);
const RUN = `TEST-SO-R${Date.now().toString(36).toUpperCase()}`;

let passed = 0;
let failed = 0;
const fails = [];
function ok(label, cond, detail = '') {
  if (typeof label !== 'string' || typeof cond !== 'boolean') throw new Error(`ok(label, cond) takes a string and a boolean — got ${typeof label}, ${typeof cond}`);
  if (cond) { passed += 1; console.log(`  PASS  ${label}`); }
  else { failed += 1; fails.push(label); console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (label, got, want) => ok(label, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)?.slice(0, 400)}, wanted ${JSON.stringify(want)?.slice(0, 400)}`);
const refusal = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };
const section = (s) => console.log(`\n${s}`);
const said = (e, re) => !!e && (re.test(e.message ?? '') || (e.problems ?? []).some((p) => re.test(p)));

async function census(db) {
  const [rows] = await db.query("SHOW TABLES LIKE 'cf\\_%'");
  const out = {};
  for (const t of rows.map((r) => Object.values(r)[0]).sort()) {
    const [[r]] = await db.query(`SELECT COUNT(*) AS n FROM \`${t}\``);
    out[t] = Number(r.n);
  }
  return out;
}
/** Runs fn inside a savepoint and goes back to it — a refusal mid-way leaves the suite's transaction as it was. */
async function undone(conn, fn) {
  await conn.query('SAVEPOINT so_t');
  try { return await fn(); } finally { await conn.query('ROLLBACK TO SAVEPOINT so_t'); }
}

const conn = await pool.getConnection();
let exitCode = 0;
try {
  const before = await census(conn);
  await conn.beginTransaction();
  attachNodeCache(conn);
  const [[user]] = await conn.query('SELECT id FROM users WHERE company_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 1', [COMPANY]);
  const c = { companyId: COMPANY, userId: user?.id ?? null };
  const defId = async (name) => {
    const [[r]] = await conn.query("SELECT id FROM cf_master_records WHERE company_id = ? AND record_kind = 'definition' AND name = ? AND status = 'active' AND deleted_at IS NULL ORDER BY id LIMIT 1", [COMPANY, name]);
    if (!r) throw new Error(`Company ${COMPANY} has no active definition "${name}".`);
    return r.id;
  };
  const SPAN = await defId('Bridge span');
  const GL = await defId('Girder line');
  const GS = await defId('Girder segment');
  const [[stockItem]] = await conn.query(
    `SELECT m.id FROM cf_item_details i JOIN cf_master_records m ON m.id = i.master_id
      WHERE m.company_id = ? AND m.status = 'active' AND m.deleted_at IS NULL AND i.item_type = 'catalog' AND i.sourcing = 'stock' AND i.deleted_at IS NULL
      ORDER BY m.id LIMIT 1`, [COMPANY]);
  const [[cust]] = await conn.query("SELECT id FROM cf_parties WHERE company_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 1", [COMPANY]);
  console.log(`\nCompany ${COMPANY}, run ${RUN}: Bridge span ${SPAN}, Girder line ${GL}, Girder segment ${GS}, stock item ${stockItem?.id}`);

  /* ------------------------------------------------------------------------ */
  section('1. The stage train');
  eq('the catalogue, in order (§73: Customer acceptance after the material request)', PROC.STAGE_KEYS, ['structure', 'values', 'execution_plan', 'lock', 'nesting', 'buying', 'acceptance', 'production']);
  ok('Line items is retired (with confirm and cut pieces)', PROC.RETIRED_STAGE_KEYS.has('lines') && PROC.RETIRED_STAGE_KEYS.has('confirm') && PROC.RETIRED_STAGE_KEYS.has('cut_pieces'));
  const kinds = PROC.stageCatalogue();
  eq('order-wide steps say so; per-line steps say line', kinds.map((k) => `${k.key}:${k.scope}`),
    ['structure:order', 'values:order', 'execution_plan:order', 'lock:line', 'nesting:line', 'buying:order', 'acceptance:order', 'production:line']);
  eq('labels', kinds.map((k) => k.label), ['Structure & values', 'Values', 'Execution plan', 'Freeze design', 'Nesting', 'Material request', 'Customer acceptance', 'Production']);

  // A process of our own, as an older screen would send it: Line items first, the old order.
  const prc = await PROC.createProcess(conn, c, { code: `${RUN}-P`, name: 'Restructure test' });
  let saved = await PROC.replaceStages(conn, c, prc.id, { stages: ['lines', 'structure', 'values', 'execution_plan', 'lock', 'nesting', 'buying', 'production'].map((stageKey) => ({ stageKey })) });
  eq('Line items sent by an older screen is dropped; the rest in catalogue order', saved.stages.map((s) => s.stageKey), ['structure', 'values', 'execution_plan', 'lock', 'nesting', 'buying', 'production']);
  const [[{ n: storedLines }]] = await conn.query("SELECT COUNT(*) AS n FROM cf_process_stages WHERE process_id = ? AND stage_key = 'lines' AND deleted_at IS NULL", [prc.id]);
  eq('…and nothing stored for it', Number(storedLines), 0);
  // A stored process with Line items and NO Structure (as Placebo's first one was) reads its Line items row as Structure.
  const old = await PROC.createProcess(conn, c, { code: `${RUN}-OLD`, name: 'Old process' });
  await conn.query("INSERT INTO cf_process_stages (company_id, process_id, stage_key, sequence, label) VALUES (?, ?, 'lines', 10, 'Line items'), (?, ?, 'lock', 20, NULL)", [COMPANY, old.id, COMPANY, old.id]);
  const oldRead = await PROC.getProcess(conn, COMPANY, old.id);
  eq('a process with Line items and no Structure reads it as Structure & values', oldRead.stages.map((s) => `${s.stageKey}:${s.label}`), ['structure:Structure & values', 'lock:Freeze design']);
  await PROC.setProcessStatus(conn, c, prc.id, 'active');

  /* ------------------------------------------------------------------------ */
  section('2. The whole order: three lines, one structure answer, one write');
  const order0 = await SO.createOrder(conn, c, { orderType: 'customer', customerId: cust.id, title: 'restructure test', code: RUN, committedDate: '2026-12-31' });
  await conn.query('UPDATE cf_sales_orders SET process_id = ? WHERE id = ?', [prc.id, order0.id]);
  await SO.addOrderLine(conn, c, order0.id, { recordId: SPAN, quantity: 3 });
  await SO.addOrderLine(conn, c, order0.id, { recordId: SPAN, quantity: 1 });
  let order = await SO.addOrderLine(conn, c, order0.id, { recordId: stockItem.id, quantity: 2 });
  const [L1, L2, L3] = order.lines;
  eq('three lines: two spans (×3, ×1) and a stock item ×2', order.lines.map((l) => [l.lineNo, l.lineType, l.quantity]), [[1, 'custom', 3], [2, 'custom', 1], [3, 'standard', 2]]);

  const whole = await SO.orderStructure(conn, COMPANY, order.id, { c });
  eq('GET /orders/:id/structure: every line, in order', whole.lines.map((l) => l.lineNo), [1, 2, 3]);
  ok('each with its own tree, rooted at what the line sells', whole.lines.every((l, i) => l.structure?.root?.id === order.lines[i].item.id));
  ok('the spans have their rows; the stock item none', whole.lines[0].structure.stats.nodes > 100 && whole.lines[1].structure.stats.nodes > 100 && whole.lines[2].structure.stats.nodes === 1);
  ok('…and say they can be edited (not frozen)', whole.lines.every((l) => l.frozen === false && l.structure.order.editable === true));

  // One write for two lines.
  // A leaf part (a flange), so the BOM levels below keep their counts.
  const firstRow = (s) => { const walk = (x) => (x.lineId != null && x.kind === 'temporary' && x.children.length === 0 && x.depth >= 3 ? x : x.children.map(walk).find(Boolean) ?? null); return walk(s.root); };
  const r1 = firstRow(whole.lines[0].structure);
  const r2 = firstRow(whole.lines[1].structure);
  const qtyOf = async (bomLineId) => Number((await conn.query('SELECT quantity FROM cf_bom_lines WHERE id = ?', [bomLineId]))[0][0].quantity);
  const q1 = await qtyOf(r1.lineId);
  const q2 = await qtyOf(r2.lineId);
  const dry = await OS.applyOrderStructureChanges(conn, c, order.id, { dryRun: true, lines: [
    { lineId: L1.id, changes: [{ op: 'quantity', lineId: r1.lineId, quantity: q1 + 1 }] },
    { lineId: L2.id, changes: [{ op: 'quantity', lineId: r2.lineId, quantity: q2 + 2 }] },
  ] });
  ok('a dry run over two lines: both rehearsed, nothing written', dry.applied === false && dry.lines.length === 2 && await qtyOf(r1.lineId) === q1 && await qtyOf(r2.lineId) === q2);
  const wrote = await OS.applyOrderStructureChanges(conn, c, order.id, { lines: [
    { lineId: L1.id, changes: [{ op: 'quantity', lineId: r1.lineId, quantity: q1 + 1 }] },
    { lineId: L2.id, changes: [{ op: 'quantity', lineId: r2.lineId, quantity: q2 + 2 }] },
  ] });
  ok('POST /orders/:id/structure/changes: both lines saved in one call', wrote.applied === true && await qtyOf(r1.lineId) === q1 + 1 && await qtyOf(r2.lineId) === q2 + 2);
  ok('…each line\'s answer says what its cut pieces did', wrote.lines.every((l) => 'cutPieces' in l));
  const allOrNone = await undone(conn, async () => {
    const e = await refusal(() => OS.applyOrderStructureChanges(conn, c, order.id, { lines: [
      { lineId: L1.id, changes: [{ op: 'quantity', lineId: r1.lineId, quantity: q1 + 5 }] },
      { lineId: L2.id, changes: [{ op: 'quantity', lineId: 999999999, quantity: 1 }] },
    ] }));
    return { e, q: await qtyOf(r1.lineId) };
  });
  ok('a refusal on line 2 is a refusal (the route\'s transaction then undoes line 1 as well)', !!allOrNone.e, String(allOrNone.e?.message));
  const stray = await refusal(() => OS.applyOrderStructureChanges(conn, c, order.id, { lines: [{ lineId: 923, changes: [] }] }));
  ok('a line of another order is refused by name', said(stray, /not a line of this order/));

  // Reorder.
  order = await SO.reorderLines(conn, c, order.id, { lineIds: [L3.id, L1.id, L2.id] });
  eq('PUT /orders/:id/line-order: the numbers are handed out again in the new order', order.lines.map((l) => [l.id, l.lineNo]), [[L3.id, 1], [L1.id, 2], [L2.id, 3]]);
  const bad = await refusal(() => SO.reorderLines(conn, c, order.id, { lineIds: [L1.id, L2.id] }));
  ok('every line, once — or it is refused', said(bad, /every line/i));
  await conn.query('UPDATE cf_sales_order_lines SET locked_at = NOW() WHERE id = ?', [L1.id]);
  const frozenMove = await refusal(() => SO.reorderLines(conn, c, order.id, { lineIds: [L1.id, L3.id, L2.id] }));
  ok('a move that renumbers a frozen line is refused, the line named', said(frozenMove, /Line 2 is frozen/));
  order = await SO.reorderLines(conn, c, order.id, { lineIds: [L2.id, L1.id, L3.id] });
  eq('…moving the others around it is fine', order.lines.map((l) => [l.id, l.lineNo]), [[L2.id, 1], [L1.id, 2], [L3.id, 3]]);
  order = await SO.reorderLines(conn, c, order.id, { lineIds: [L3.id, L1.id, L2.id] }).catch(() => order);
  await conn.query('UPDATE cf_sales_order_lines SET locked_at = NULL WHERE id = ?', [L1.id]);
  order = await SO.reorderLines(conn, c, order.id, { lineIds: [L1.id, L2.id, L3.id] });
  eq('back in the first order', order.lines.map((l) => [l.id, l.lineNo]), [[L1.id, 1], [L2.id, 2], [L3.id, 3]]);
  // A line with CUT PIECES keeps its number too — their codes carry it (coordinator, 2026-10-18).
  const [[blanks]] = await conn.query('SELECT blanks_node_id AS id FROM cf_cut_places WHERE company_id = ? AND blanks_node_id IS NOT NULL ORDER BY id LIMIT 1', [COMPANY]);
  await undone(conn, async () => {
    const [[tmp]] = await conn.query('SELECT i.master_id AS id FROM cf_item_details i WHERE i.company_id = ? AND i.owner_order_line_id = ? AND i.deleted_at IS NULL AND i.master_id <> ? ORDER BY i.master_id LIMIT 1', [COMPANY, L2.id, L2.item.id]);
    await conn.query('UPDATE cf_master_records SET classification_id = ? WHERE id = ?', [blanks.id, tmp.id]);
    const withCut = await SO.getOrder(conn, COMPANY, order.id);
    ok('getOrder says line 2 has a cut piece', withCut.lines.find((l) => l.id === L2.id).structure.cutPieces === 1, JSON.stringify(withCut.lines.find((l) => l.id === L2.id).structure));
    const cutMove = await refusal(() => SO.reorderLines(conn, c, order.id, { lineIds: [L2.id, L1.id, L3.id] }));
    ok('a line with cut pieces cannot move — said why', said(cutMove, /Line 2 cannot move: its cut pieces carry its line number/), cutMove?.message);
  });

  /* ------------------------------------------------------------------------ */
  section('3. The execution plan');
  let plan = await EP.getExecutionPlan(conn, COMPANY, order.id);
  eq('nothing saved: the default is one production order per line, dispatched the same way', [plan.saved, plan.plan], [null, { production: { level: 'line', levelId: null }, dispatch: { level: 'same', levelId: null } }]);
  ok('editable, with the note that the Production step makes the production orders (§76)', plan.editable === true && /makes the production orders from this plan/.test(plan.note));
  eq('the stock item makes nothing: no production order for it', plan.lines.map((l) => [l.lineNo, l.made, l.productionCount]), [[1, true, 1], [2, true, 1], [3, false, 0]]);
  eq('preview: 2 production orders, one per span line', [plan.preview.production.count, plan.preview.production.items], [2, [`${RUN} · Line 1 · Bridge span ×3`, `${RUN} · Line 2 · Bridge span ×1`]]);
  ok('…in a plain sentence', plan.preview.production.sentence === `This order will make 2 production orders: ${RUN} · Line 1 · Bridge span ×3, ${RUN} · Line 2 · Bridge span ×1.`, plan.preview.production.sentence);
  eq('dispatch: the same 2', plan.preview.dispatch.count, 2);
  const lv1 = plan.lines[0].levels;
  const glv = lv1.find((x) => x.id === GL);
  const gsv = lv1.find((x) => x.id === GS);
  ok('the BOM levels of a span: Girder line (4 a span, level 1) and Girder segment (level 2)', !!glv && glv.depth === 1 && glv.perUnit === 4 && !!gsv && gsv.depth === 2 && gsv.perUnit > 4, JSON.stringify(lv1));
  ok('order-wide levels name the lines that have them', plan.levels.some((x) => x.id === GL && x.onEveryLine && x.lineNos.join() === '1,2'));
  ok('templates: one per line (usual) first, then whole order, per unit, per Girder line', plan.templates[0].key === 'per_line' && plan.templates.some((t) => t.key === 'whole_order') && plan.templates.some((t) => t.key === 'per_unit') && plan.templates.some((t) => t.plan.production.levelId === GL));
  // Choose by result (2026-10-24): every option labelled with what it produces.
  ok('two span lines: something to choose — the plan must be saved', plan.nothingToChoose === false && plan.summary === '2 production orders, ships as 2 dispatch units.', plan.summary);
  const barLabel = (v, kind, key) => v.options[kind].options.find((o) => o.key === key);
  eq('the production bar, labelled by result', ['order', 'line', 'unit', `assembly:${GL}`].map((k) => barLabel(plan, 'production', k)?.label),
    ['Whole order — 1 production order', 'Per line — 2 production orders', 'Per unit — 4 production orders (one per unit)', 'Per sub-assembly: Girder line — 20 production orders (each Girder line + the rest)']);
  ok('…none hidden (each gives something different), no note', plan.options.production.options.every((o) => !o.hidden) && plan.options.production.note === null, JSON.stringify(plan.options.production.options.filter((o) => o.hidden)));
  eq('the dispatch bar: Per line gives the same as the production orders — hidden, named in the note', [barLabel(plan, 'dispatch', 'same').label, barLabel(plan, 'dispatch', 'line').hidden, plan.options.dispatch.note],
    ['Same as production orders — 2 dispatch units', true, 'Per line gives the same here (it matches the production orders).']);
  const pl2 = plan.lines.find((l) => l.lineId === L2.id).options;
  ok('line 2 (×1): its Per unit select option is hidden — the line is 1 unit', pl2.production.options.find((o) => o.key === 'unit').hidden === true && /Per unit gives the same here \(the line is 1 unit\)/.test(pl2.production.note ?? ''), pl2.production.note);
  ok('line 1 (×3): its Per unit shows — 3 production orders', plan.lines.find((l) => l.lineId === L1.id).options.production.options.find((o) => o.key === 'unit').label === 'Per unit — 3 production orders (one per unit)');
  eq('…"As the order" says what it gives', pl2.production.asOrder, 'As the order: Per line — 1 production order');
  eq('the stock line has no selects', plan.lines.find((l) => l.lineId === L3.id).options, null);

  const tryPlan = (body) => EP.saveExecutionPlan(conn, c, order.id, { ...body, dryRun: true });
  let d = await tryPlan({ production: { level: 'order' } });
  eq('whole order: 1 production order (the stock item makes nothing, so every line that makes is in it)', [d.preview.production.count, d.preview.production.items], [1, [`${RUN} · whole order`]]);
  d = await tryPlan({ production: { level: 'unit' } });
  eq('per unit: 3 + 1 = 4', [d.preview.production.count, d.preview.production.items[0], d.preview.production.items[3]], [4, `${RUN} · Line 1 · Bridge span 1 of 3`, `${RUN} · Line 2 · Bridge span 1 of 1`]);
  d = await tryPlan({ production: { level: 'assembly', levelId: GL } });
  eq('per Girder line: (4 + the rest) × 3 spans + (4 + the rest) × 1 = 20', d.preview.production.count, 20);
  eq('…each Girder line named, then the rest and final assembly of the span', d.preview.production.items.slice(0, 5),
    [1, 2, 3, 4].map((i) => `${RUN} · Line 1 · Bridge span 1 of 3 · Girder line ${i}`).concat(`${RUN} · Line 1 · Bridge span 1 of 3 · the rest and final assembly`));
  ok('…and the sentence counts them all', /^This order will make 20 production orders: .* and 17 more\.$/.test(d.preview.production.sentence), d.preview.production.sentence);
  ok('a dry run writes nothing and refuses nothing', d.dryRun === true && d.problems.length === 0 && (await EP.planRowsOf(conn, COMPANY, [order.id])).length === 0);

  d = await tryPlan({ production: { level: 'line' }, dispatch: { level: 'assembly', levelId: GS } });
  const segs = gsv.perUnit;
  eq(`dispatch per Girder segment: (${segs} + loose items) × 3 + (${segs} + loose items) × 1`, d.preview.dispatch.count, (segs + 1) * 3 + (segs + 1));
  eq('…while the production orders stay 2', d.preview.production.count, 2);
  d = await tryPlan({ production: { level: 'unit' }, dispatch: { level: 'unit' } });
  eq('dispatch per unit with production per unit: 4 and 4', [d.preview.production.count, d.preview.dispatch.count], [4, 4]);

  d = await tryPlan({ production: { level: 'assembly', levelId: GS }, dispatch: { level: 'unit' } });
  ok('a dispatch unit bigger than a production order is refused (per unit vs per segment)', d.problems.some((p) => /cannot be bigger than a production order/.test(p)), JSON.stringify(d.problems));
  d = await tryPlan({ production: { level: 'assembly', levelId: GS }, dispatch: { level: 'assembly', levelId: GL } });
  ok('…and a Girder line (holds segments) against production per segment', d.problems.some((p) => /cannot be bigger/.test(p)));
  d = await tryPlan({ production: { level: 'assembly', levelId: GL }, dispatch: { level: 'assembly', levelId: GS } });
  ok('a Girder segment inside a per-Girder-line production order is fine', d.problems.length === 0, JSON.stringify(d.problems));
  d = await tryPlan({ production: { level: 'assembly' } });
  ok('per sub-assembly needs its BOM level', d.problems.some((p) => /choose the BOM level/i.test(p)));
  const notJson = await refusal(() => EP.saveExecutionPlan(conn, c, order.id, { production: { level: 'girders' } }));
  ok('an unknown level is refused, the choices named', said(notJson, /choose one of order, line, unit, assembly/));

  // A line whose quantity is not whole cannot be split per unit.
  await conn.query('UPDATE cf_sales_order_lines SET quantity = 2.5 WHERE id = ?', [L2.id]);
  d = await tryPlan({ production: { level: 'unit' } });
  ok('per unit needs a whole quantity — line 2 is 2.5', d.problems.some((p) => /Line 2's quantity is 2.5/.test(p)), JSON.stringify(d.problems));
  await conn.query('UPDATE cf_sales_order_lines SET quantity = 1 WHERE id = ?', [L2.id]);

  // A line's own plan.
  d = await tryPlan({ production: { level: 'unit' }, lines: [{ lineId: L2.id, own: { production: { level: 'line' }, dispatch: { level: 'same' } } }] });
  eq('line 2 its own way (per line), line 1 per unit: 3 + 1', [d.preview.production.count, d.lines.map((l) => l.source)], [4, ['order', 'line', 'order']]);
  d = await tryPlan({ production: { level: 'unit' }, lines: [{ lineId: L2.id, own: { production: { level: 'unit' }, dispatch: { level: 'same' } } }] });
  eq('a line\'s own plan that equals the order\'s is not kept as its own', d.lines[1].source, 'order');

  /* ------------------------------------------------------------------------ */
  section('4. Readiness — the stages');
  let proc = await PROC.orderProcess(conn, COMPANY, order.id);
  eq('the order\'s stages, in order', proc.stages.map((s) => s.stageKey), ['structure', 'values', 'execution_plan', 'lock', 'nesting', 'buying', 'production']);
  ok('no Line items stage anywhere', !proc.stages.some((s) => s.stageKey === 'lines') && proc.lines.every((l) => !l.stages.some((s) => s.stageKey === 'lines')));
  const st = (p, key) => p.stages.find((s) => s.stageKey === key);
  const lst = (p, lineId, key) => p.lines.find((l) => l.lineId === lineId)?.stages.find((s) => s.stageKey === key);
  ok('Structure & values carries the order-wide scope; Freeze design does not', st(proc, 'structure').scope === 'order' && st(proc, 'execution_plan').scope === 'order' && st(proc, 'buying').scope === 'order' && st(proc, 'lock').scope === undefined);
  eq('the stock item line: Structure is "sold as it is" and done', [lst(proc, L3.id, 'structure').state, /sold as it is/.test(lst(proc, L3.id, 'structure').detail)], ['done', true]);
  eq('…and needs no execution plan', lst(proc, L3.id, 'execution_plan').state, 'not_applicable');
  eq('Execution plan is to do until it is saved', st(proc, 'execution_plan').state, 'todo');
  ok('…its blocker said once for the order, not once a line', st(proc, 'execution_plan').blockers.filter((b) => /not saved yet/.test(b.message)).length === 1, JSON.stringify(st(proc, 'execution_plan').blockers));
  // Freeze design points at it when nothing else is in the way (the stage function, on a clean line).
  const lockKind = PROC.STAGE_CATALOGUE.find((k) => k.key === 'lock');
  const cleanLine = { line: { line_no: 1, line_type: 'custom' }, lock: { lockedAt: null, pieces: 0 }, values: { missing: [], required: 3 }, unresolved: [], cut: { parts: [] } };
  const held = lockKind.state({ ...cleanLine, planStage: true, plan: { saved: false } });
  eq('Freeze design waits on the plan when it is not saved — held, not just pointed at', [held.waitingOn?.stageKey, held.state, held.blockers.length], ['execution_plan', 'todo', 1]);
  eq('…not once it is saved', lockKind.state({ ...cleanLine, planStage: true, plan: { saved: true } }).waitingOn ?? null, null);
  eq('…and not on a process without the stage', lockKind.state({ ...cleanLine, planStage: false, plan: { saved: false } }).waitingOn ?? null, null);

  // Freeze design REFUSES while the order has no saved plan (coordinator, 2026-10-18): a check on the freeze, and a blocker on its stage.
  const look = await LOCK.lockPlan(conn, COMPANY, L1.id);
  const planCheck = look.checks.find((x) => x.key === 'execution_plan');
  ok('the freeze checks the plan: not saved, the sentence names the step and the button', !!planCheck && planCheck.ok === false && look.problems.some((p) => /Save the execution plan first — it is filled in already .* press Save the plan./.test(p)), JSON.stringify(planCheck));
  ok('…and the Freeze design stage is held by it', lst(proc, L1.id, 'lock').blockers.some((b) => /cannot be frozen until the execution plan is saved/.test(b.message)) && lst(proc, L1.id, 'lock').state === 'todo');
  const lockNo = await refusal(() => LOCK.lockLine(conn, c, L1.id));
  ok('lockLine refuses', said(lockNo, /Save the execution plan first/), lockNo?.message);

  plan = await EP.saveExecutionPlan(conn, c, order.id, { production: { level: 'assembly', levelId: GL }, dispatch: { level: 'same' } });
  ok('saved: the plan check of the freeze passes', (await LOCK.lockPlan(conn, COMPANY, L1.id)).checks.find((x) => x.key === 'execution_plan')?.ok === true);
  ok('PUT saves: per Girder line, saved by the user, now', plan.plan.production.level === 'assembly' && plan.plan.production.levelId === GL && !!plan.saved?.at && plan.saved.by?.id === c.userId);
  const rows = await EP.planRowsOf(conn, COMPANY, [order.id]);
  eq('one row: the order\'s own (no line differs)', rows.map((r) => [r.order_line_id, r.production_level, r.production_level_id, r.dispatch_level]), [[null, 'assembly', GL, 'same']]);
  proc = await PROC.orderProcess(conn, COMPANY, order.id);
  eq('Execution plan is done for both span lines', [lst(proc, L1.id, 'execution_plan').state, lst(proc, L2.id, 'execution_plan').state], ['done', 'done']);
  ok('…its detail in plain words', /^One production order per Girder line, dispatched the same way/.test(lst(proc, L1.id, 'execution_plan').detail), lst(proc, L1.id, 'execution_plan').detail);
  ok('the NEXT stage is never Execution plan once saved', proc.nextStage !== 'execution_plan');
  const again = await EP.saveExecutionPlan(conn, c, order.id, { production: { level: 'assembly', levelId: GL } });
  eq('saving the same again writes nothing new', (await EP.planRowsOf(conn, COMPANY, [order.id])).map((r) => r.id), rows.map((r) => r.id));
  ok('…and answers the same plan', again.plan.production.levelId === GL);

  /* ------------------------------------------------------------------------ */
  section('5. Fixed by the freeze');
  await conn.query('UPDATE cf_sales_order_lines SET locked_at = NOW() WHERE id = ?', [L1.id]);
  const e1 = await refusal(() => EP.saveExecutionPlan(conn, c, order.id, { lines: [{ lineId: L1.id, own: { production: { level: 'unit' }, dispatch: { level: 'same' } } }] }));
  ok('a frozen line\'s own plan cannot change — a revision is needed', said(e1, /Line 1's design is frozen, so its plan is fixed. A change needs a revision/), JSON.stringify(e1?.problems));
  plan = await EP.saveExecutionPlan(conn, c, order.id, { production: { level: 'unit' } });
  const l1 = plan.lines.find((l) => l.lineId === L1.id);
  const l2 = plan.lines.find((l) => l.lineId === L2.id);
  ok('changing the order\'s choice PINS the frozen line to what it had (per Girder line)', l1.source === 'line' && l1.plan.production.level === 'assembly' && l1.plan.production.levelId === GL && l1.frozen === true);
  ok('…while the open line follows the order (per unit)', l2.source === 'order' && l2.plan.production.level === 'unit');
  eq('…so the preview: 3 spans × 5 + 1 unit = 16', plan.preview.production.count, 16);
  proc = await PROC.orderProcess(conn, COMPANY, order.id);
  ok('the frozen line\'s stage: "Fixed at the freeze"', lst(proc, L1.id, 'execution_plan').state === 'done' && /^Fixed at the freeze/.test(lst(proc, L1.id, 'execution_plan').detail), lst(proc, L1.id, 'execution_plan').detail);
  await conn.query('UPDATE cf_sales_order_lines SET locked_at = NOW() WHERE id = ?', [L2.id]);
  plan = await EP.getExecutionPlan(conn, COMPANY, order.id);
  ok('every line frozen: the plan is read only, and says why', plan.editable === false && /Every line is frozen/.test(plan.readOnlyReason ?? ''), plan.readOnlyReason);

  // A revision carries the plan: the order's row and the pinned line's row, onto the new lines.
  const rev = await REV.reviseOrder(conn, c, order.id);
  const revRows = await EP.planRowsOf(conn, COMPANY, [rev.id]);
  const newL1 = rev.lines.find((l) => l.revisesLineId === L1.id);
  ok('a revision takes the plan with it: the order\'s choice and line 1\'s own, onto its copy', revRows.length === 2
    && revRows.some((r) => r.order_line_id == null && r.production_level === 'unit')
    && revRows.some((r) => Number(r.order_line_id) === newL1?.id && r.production_level === 'assembly' && Number(r.production_level_id) === GL), JSON.stringify(revRows.map((r) => [r.order_line_id, r.production_level])));
  const revPlan = await EP.getExecutionPlan(conn, COMPANY, rev.id);
  ok('…and the new revision is editable again (nothing frozen in it)', revPlan.editable === true && revPlan.lines.every((l) => !l.frozen));
  const stopped = await refusal(() => EP.saveExecutionPlan(conn, c, order.id, { production: { level: 'line' } }));
  ok('the revised order does not change at all', said(stopped, /is revised — its plan does not change/));

  // A removed line takes its own row.
  const newL2 = rev.lines.find((l) => l.revisesLineId === L2.id);
  await EP.saveExecutionPlan(conn, c, rev.id, { lines: [{ lineId: newL2.id, own: { production: { level: 'line' }, dispatch: { level: 'same' } } }] });
  ok('line 2 of the revision has its own row', (await EP.planRowsOf(conn, COMPANY, [rev.id])).some((r) => Number(r.order_line_id) === newL2.id));
  await SO.removeOrderLine(conn, c, newL2.id);
  ok('…removing the line retires it', !(await EP.planRowsOf(conn, COMPANY, [rev.id])).some((r) => Number(r.order_line_id) === newL2.id));

  /* ------------------------------------------------------------------------ */
  section('6. The model, pure');
  const tiny = { root: { id: 1, code: 'R', depth: 0, quantity: 2, total: 2, kind: 'temporary', flow: null, children: [
    { id: 2, code: 'R-A', name: 'A', depth: 1, quantity: 2, total: 4, kind: 'temporary', children: [{ id: 3, code: 'R-A-P', name: 'P', depth: 2, quantity: 1, total: 4, kind: 'temporary', children: [] }] },
  ] } };
  const defs = new Map([[2, { id: 20, name: 'Assy' }], [3, { id: 30, name: 'Part' }]]);
  const shape = M.levelsOf(tiny, (id) => defs.get(id) ?? null);
  eq('levelsOf: only a level with rows below it; per unit', shape.levels, [{ id: 20, name: 'Assy', depth: 1, perUnit: 2 }]);
  eq('…nothing outside the Assy rows, no final-assembly flow: no "rest"', shape.outside.get(20), false);
  eq('instance labels: a row of 2 is two instances', M.instanceLabels(tiny, (id) => defs.get(id) ?? null, 20), ['A #1', 'A #2']);
  eq('per Assy over 2 units: 4 production orders', M.productionCount({ quantity: 2 }, { production: { level: 'assembly', levelId: 20 }, dispatch: { level: 'same' } }, shape), 4);
  eq('effectivePlan: own row over the order\'s over the default', [
    M.effectivePlan([], 5).source,
    M.effectivePlan([{ order_line_id: null, production_level: 'unit', dispatch_level: 'same' }], 5).source,
    M.effectivePlan([{ order_line_id: null, production_level: 'unit', dispatch_level: 'same' }, { order_line_id: 5, production_level: 'order', dispatch_level: 'same' }], 5).plan.production.level,
  ], ['default', 'order', 'order']);

  /* ------------------------------------------------------------------------ */
  section('6b. Nothing to choose, and choose by result — the model, pure (2026-10-24)');
  const DEF = () => ({ production: { level: 'line', levelId: null }, dispatch: { level: 'same', levelId: null } });
  const GL4 = { levels: [{ id: 7, name: 'Girder line', depth: 1, perUnit: 4 }], below: new Map(), outside: new Map([[7, false]]), hasRootFlow: false };
  const GL1 = { levels: [{ id: 8, name: 'Deck', depth: 1, perUnit: 1 }], below: new Map(), outside: new Map([[8, false]]), hasRootFlow: false };
  const ln = (id, quantity, shape = null, more = {}) => ({ lineId: id, lineNo: id, quantity, plan: DEF(), source: 'default', frozen: false, shape, ...more });
  const shownLabels = (part) => part.options.filter((o) => !o.hidden).map((o) => o.label);
  // One line, quantity 1.
  let one = [ln(1, 1)];
  let ch = M.choicesOf(one, DEF());
  ok('one line ×1: nothing to choose', M.nothingToChoose(one) === true);
  eq('…its sentence', M.planSummary(one, true), '1 production order, ships as 1 dispatch unit — nothing to choose for this order.');
  eq('…the production bar shows only Per line (chosen); Whole order and Per unit folded in', shownLabels(ch.production), ['Per line — 1 production order']);
  eq('…the note names them', ch.production.note, 'Whole order gives the same here (the order has one line); Per unit gives the same here (the line is 1 unit).');
  eq('…the dispatch bar: only Same as production orders', [shownLabels(ch.dispatch), ch.dispatch.note],
    [['Same as production orders — 1 dispatch unit'], 'Per line gives the same here (it matches the production orders); Per unit gives the same here (the line is 1 unit).']);
  ok('a sub-assembly level with one to a unit and nothing beside it changes nothing', M.nothingToChoose([ln(1, 1, GL1)]) === true);
  ok('…but with a final-assembly flow it does (the rest is a production order of its own)', M.nothingToChoose([ln(1, 1, { ...GL1, hasRootFlow: true })]) === false);
  ok('a line of 2.5 (not whole): per unit cannot be taken, so nothing to choose', M.nothingToChoose([ln(1, 2.5)]) === true);
  // One line, quantity 3.
  one = [ln(1, 3)];
  ch = M.choicesOf(one, DEF());
  ok('one line ×3: something to choose', M.nothingToChoose(one) === false);
  eq('…Per line and Per unit show; Whole order folded into Per line', [shownLabels(ch.production), ch.production.note],
    [['Per line — 1 production order', 'Per unit — 3 production orders (one per unit)'], 'Whole order gives the same here (the order has one line).']);
  // Two lines.
  const two = [ln(1, 1), ln(2, 1)];
  ch = M.choicesOf(two, DEF());
  ok('two lines: something to choose (whole order 1, per line 2)', M.nothingToChoose(two) === false);
  eq('…Per unit never shows when every line is 1 unit', [shownLabels(ch.production), ch.production.note],
    [['Whole order — 1 production order', 'Per line — 2 production orders'], 'Per unit gives the same here (every line is 1 unit).']);
  ok('…nor in a line\'s own select', ch.perLine.get(1).production.options.find((o) => o.key === 'unit').hidden === true);
  eq('…a line\'s Whole order joins the other lines (never folded)', ch.perLine.get(2).production.options.find((o) => o.key === 'order').label, "Whole order — together with the order's other lines");
  // A Girder-line level giving 4.
  const gl = [ln(1, 1, GL4)];
  ch = M.choicesOf(gl, DEF());
  ok('a line ×1 with 4 Girder lines: something to choose', M.nothingToChoose(gl) === false);
  eq('…labelled by result', shownLabels(ch.production), ['Per line — 1 production order', 'Per sub-assembly: Girder line — 4 production orders (each Girder line)']);
  eq('…with "the rest" when a unit has more than its Girder lines', M.choicesOf([ln(1, 2, { ...GL4, outside: new Map([[7, true]]) })], DEF()).production.options.find((o) => o.key === 'assembly:7').label,
    'Per sub-assembly: Girder line — 10 production orders (each Girder line + the rest)');
  eq('…dispatch in dispatch units, the rest as loose items', M.choicesOf([ln(1, 2, { ...GL4, outside: new Map([[7, true]]) })], DEF()).dispatch.options.find((o) => o.key === 'assembly:7').label,
    'Per sub-assembly: Girder line — 10 dispatch units (each Girder line + loose items)');
  // A saved plan whose option would be hidden: never hidden.
  const unitPlan = { production: { level: 'unit', levelId: null }, dispatch: { level: 'same', levelId: null } };
  ch = M.choicesOf([ln(1, 1, null, { plan: unitPlan, source: 'order' })], unitPlan, { keep: { order: [unitPlan] } });
  eq('a saved Per unit on a line of 1 stays shown (chosen and saved); the simpler ones fold into it', [shownLabels(ch.production), ch.production.options.find((o) => o.key === 'line').sameAs],
    [['Per unit — 1 production order'], 'unit']);
  ch = M.choicesOf([ln(1, 1)], DEF(), { keep: { order: [unitPlan] } });
  ok('…saved but not chosen (a draft back on Per line): both show', shownLabels(ch.production).includes('Per unit — 1 production order') && shownLabels(ch.production).includes('Per line — 1 production order'), JSON.stringify(shownLabels(ch.production)));
  ok('…and the order still has nothing to choose (worked out against the default)', M.nothingToChoose([ln(1, 1, null, { plan: unitPlan, source: 'order' })]) === true);
  // A level a line lacks, and a dispatch bigger than a production order: shown with why, never folded.
  ch = M.choicesOf([ln(1, 1, GL4), ln(2, 1)], DEF());
  eq('a level missing on a line says so', ch.production.options.find((o) => o.key === 'assembly:7').label, 'Per sub-assembly: Girder line — none on line 2');
  const perUnitProd = { production: { level: 'unit', levelId: null }, dispatch: { level: 'same', levelId: null } };
  ch = M.choicesOf([ln(1, 3, null, { plan: perUnitProd })], perUnitProd);
  eq('dispatch per line against production per unit: bigger than a production order', ch.dispatch.options.find((o) => o.key === 'line').label, 'Per line — bigger than a production order');

  // The stage function: Freeze design does not wait when there is nothing to choose.
  const lockKind2 = PROC.STAGE_CATALOGUE.find((k) => k.key === 'lock');
  const clean2 = { line: { line_no: 1, line_type: 'custom' }, lock: { lockedAt: null, pieces: 0 }, values: { missing: [], required: 3 }, unresolved: [], cut: { parts: [] } };
  eq('Freeze design is not held by an unsaved plan with nothing to choose', lockKind2.state({ ...clean2, planStage: true, plan: { saved: false, nothingToChoose: true } }).waitingOn ?? null, null);
  const planKind = PROC.STAGE_CATALOGUE.find((k) => k.key === 'execution_plan');
  const planCtx = { line: { line_no: 1 }, lock: { lockedAt: null }, tree: { stats: { nodes: 5 } }, fromTemplate: true };
  eq('the Execution plan stage is done by itself', [planKind.state({ ...planCtx, plan: { saved: false, nothingToChoose: true, problems: [], words: 'x', summary: '1 production order, ships as 1 dispatch unit — nothing to choose for this order.' } }).state],
    ['done']);

  /* ------------------------------------------------------------------------ */
  section('7. Nothing to choose, on an order (the revision, cut down to one span ×1 with no BOM levels)');
  await undone(conn, async () => {
    const revLines = (await SO.getOrder(conn, COMPANY, rev.id)).lines;
    const span = revLines.find((l) => l.lineType === 'custom');
    // One line that makes: the stock line goes, the span is ×1, its rows lose their definitions (no BOM levels).
    await conn.query('UPDATE cf_sales_order_lines SET deleted_at = NOW() WHERE order_id = ? AND id <> ?', [rev.id, span.id]);
    await conn.query('UPDATE cf_sales_order_lines SET quantity = 1 WHERE id = ?', [span.id]);
    await conn.query('UPDATE cf_item_details SET source_definition_id = NULL WHERE company_id = ? AND owner_order_line_id = ?', [COMPANY, span.id]);
    await EP.retirePlanRowsOfOrder(conn, COMPANY, rev.id);
    const v = await EP.getExecutionPlan(conn, COMPANY, rev.id);
    eq('GET: nothing to choose, nothing saved, one sentence', [v.nothingToChoose, v.saved, v.summary], [true, null, '1 production order, ships as 1 dispatch unit — nothing to choose for this order.']);
    eq('…the bars show one option each', [shownLabels(v.options.production), shownLabels(v.options.dispatch)], [['Per line — 1 production order'], ['Same as production orders — 1 dispatch unit']]);
    const gate = await EP.planGate(conn, COMPANY, rev.id);
    eq('planGate: required, not saved, nothing to choose', [gate.required, gate.saved, gate.nothingToChoose], [true, false, true]);
    const pr = await PROC.orderProcess(conn, COMPANY, rev.id);
    const planSt = lst(pr, span.id, 'execution_plan');
    ok('the Execution plan stage is done by itself', planSt?.state === 'done' && /^Nothing to choose — 1 production order, ships as 1 dispatch unit$/.test(planSt.detail), JSON.stringify(planSt));
    ok('…and Freeze design is not held by it', !lst(pr, span.id, 'lock').blockers.some((b) => /execution plan/.test(b.message)) && lst(pr, span.id, 'lock').waitingOn?.stageKey !== 'execution_plan', JSON.stringify(lst(pr, span.id, 'lock')));
    const lp = await LOCK.lockPlan(conn, COMPANY, span.id);
    const chk = lp.checks.find((x) => x.key === 'execution_plan');
    ok('the freeze\'s plan check passes without a save', chk?.ok === true && /^Nothing to choose — 1 production order, ships as 1 dispatch unit\. The default plan is the plan\.$/.test(chk.detail) && !lp.problems.some((p) => /Save the execution plan/.test(p)), JSON.stringify(chk));
    // A saved plan stays authoritative — and its option is shown though it gives the same.
    const sv = await EP.saveExecutionPlan(conn, c, rev.id, { production: { level: 'unit' } });
    ok('saved Per unit: still nothing to choose, the saved option shown', sv.nothingToChoose === true && !!sv.saved && sv.options.production.options.find((o) => o.key === 'unit').hidden === false, JSON.stringify(sv.options.production));
    const pr2 = await PROC.orderProcess(conn, COMPANY, rev.id);
    ok('…the stage says the saved plan', /^One production order per unit/.test(lst(pr2, span.id, 'execution_plan').detail), lst(pr2, span.id, 'execution_plan').detail);
  });

  await conn.rollback();
  detachNodeCache(conn);
  const afterCensus = await census(conn);
  const moved = Object.keys(before).filter((t) => before[t] !== afterCensus[t]);
  ok('every cf_ table is back to its count', moved.length === 0, moved.map((t) => `${t} ${before[t]} -> ${afterCensus[t]}`).join(', '));
  const [[l923]] = await conn.query('SELECT (SELECT COUNT(*) FROM cf_production_releases WHERE order_line_id = 923 AND deleted_at IS NULL) AS rel FROM DUAL');
  ok('local line 923 is not released', Number(l923.rel) === 0);
} catch (err) {
  try { await conn.rollback(); } catch { /* the error below is the one that matters */ }
  console.error(`\nERROR: ${err.stack ?? err.message}${err.problems?.length ? `\n  ${err.problems.slice(0, 10).join('\n  ')}` : ''}`);
  exitCode = 1;
} finally {
  conn.release();
  await pool.end();
}
console.log(`\n${passed} passed, ${failed} failed${fails.length ? `\n  ${fails.join('\n  ')}` : ''}`);
process.exitCode = exitCode || (failed ? 1 : 0);
