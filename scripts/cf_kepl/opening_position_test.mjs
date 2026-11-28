/**
 * opening_position_test.mjs — "Set opening position" (openingPositionService, init.sql §121; user 2026-11-28): a
 * released line's steps marked done up to a stage, as work done before the system — no stock, material, finished-stock
 * or billing posting. Against the local database.
 *
 *   cd multi_app_be
 *   node scripts/cf_kepl/opening_position_test.mjs
 *
 *   CF_OPEN_COMPANY (2), CF_OPEN_LINE (923 — the local KEPL copy), CF_OPEN_OTHER_COMPANY (any other company)
 *
 * EVERYTHING HAPPENS INSIDE ONE TRANSACTION THAT IS ROLLED BACK (the line is NEVER left released): it borrows the
 * line as step_batch_test does, WITHOUT reserving or issuing its material. The last thing it does is re-count every
 * cf_ table and prove each is back where it started.
 */
import path from 'path';
import { pathToFileURL } from 'url';

const BE = process.cwd();
const imp = (p) => import(pathToFileURL(path.join(BE, p)).href);
const { pool } = await imp('db.js');
await imp('apps/cf_erp/services/codegenProvider.js');
const { attachNodeCache } = await imp('apps/cf_erp/lib/db.js');
const REL = await imp('apps/cf_erp/services/releaseService.js');
const LOCK = await imp('apps/cf_erp/services/lockService.js');
const SO = await imp('apps/cf_erp/services/salesOrderService.js');
const AREAS = await imp('apps/cf_erp/services/stockingAreaService.js');
const SET = await imp('apps/cf_erp/services/settingsService.js');
const OPEN = await imp('apps/cf_erp/services/openingPositionService.js');
const BILL = await imp('apps/cf_erp/services/billingService.js');
const TREE = await imp('apps/cf_erp/services/trackerTreeService.js');

const COMPANY = Number(process.env.CF_OPEN_COMPANY ?? 2);
const LINE = Number(process.env.CF_OPEN_LINE ?? 923);

let passed = 0;
let failed = 0;
const fails = [];
function ok(label, cond, detail = '') {
  if (typeof label !== 'string' || typeof cond !== 'boolean') throw new Error(`ok(label, cond) takes a string and then a boolean — got ok(${typeof label}, ${typeof cond})`);
  if (cond) { passed += 1; console.log(`  PASS  ${label}`); } else { failed += 1; fails.push(label); console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
}
async function census(db) {
  const [rows] = await db.query("SHOW TABLES LIKE 'cf\\_%'");
  const out = {};
  for (const t of rows.map((r) => Object.values(r)[0]).sort()) { const [[r]] = await db.query(`SELECT COUNT(*) AS n FROM \`${t}\``); out[t] = Number(r.n); }
  return out;
}
const refusal = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

// --- 0. the stage rule on its own (no database) -------------------------------------------------------------------
console.log('\n0. The stage rule');
{
  const stageOf = new Map([['CUT', 0], ['HBFIT', 1], ['JACKBEND', 1], ['STIFFFIT', 1], ['STUDWELD', 1], ['MANDRILL', 2], ['TRIALASM', 3], ['BLAST', 4]]);
  // GIRDER-SEGMENT visits MANDRILL twice, between fit/weld passes.
  const flow = ['HBFIT', 'JACKBEND', 'MANDRILL', 'STIFFFIT', 'MANDRILL', 'MANDRILL', 'STUDWELD', 'BLAST'].map((op_code) => ({ op_code }));
  const idx = OPEN.stagesOfSteps(flow, stageOf);
  ok('each step takes its operation\'s stage', idx.join(',') === '1,1,2,1,2,2,1,4', idx.join(','));
  ok('"Drill" = through the last step of stage ≤ Drill: every fit/weld pass before the last drill, not the blasting', OPEN.cutOf(idx, 2) === 7);
  ok('"Fit-up & weld" also takes the drill passes that come before its last weld (one prefix of the flow)', OPEN.cutOf(idx, 1) === 7);
  ok('"Cut" on a flow with no cut marks nothing', OPEN.cutOf(idx, 0) === 0);
  ok('the last stage marks the whole flow', OPEN.cutOf(idx, 5) === flow.length);
  const unknown = OPEN.stagesOfSteps(['MARK', 'CUT', 'GRIND', 'HBFIT', 'PACK'].map((op_code) => ({ op_code })), stageOf);
  ok('an operation in no stage takes the step before it; a leading one the first stage after it', unknown.join(',') === '0,0,0,1,1', unknown.join(','));
  ok('a flow with no staged operation counts as the first stage', OPEN.stagesOfSteps([{ op_code: 'X' }, { op_code: 'Y' }], stageOf).join(',') === '0,0');
  const p = SET.parseStages('Cut: cncp-cut, GASCUT\nFit-up & weld: HBFIT SAWWELD');
  ok('stages are read from "Name: CODE, CODE" lines, codes upper-cased', JSON.stringify(p.stages) === JSON.stringify([{ name: 'Cut', ops: ['CNCP-CUT', 'GASCUT'] }, { name: 'Fit-up & weld', ops: ['HBFIT', 'SAWWELD'] }]));
  ok('an operation in two stages is refused, in words', /belongs to one stage/.test(SET.parseStages('A: X\nB: X').problems?.[0] ?? ''));
  ok('a line without a colon is refused, in words', /Name: CODE/.test(SET.parseStages('Cut CNCP-CUT').problems?.[0] ?? ''));
  ok('the default stages are the six asked for', SET.DEFAULT_STAGES.map((s) => s.name).join('|') === 'Cut|Fit-up & weld|Drill|Trial assembly|Blast & paint|Dispatched');
  ok('an as-of day still to come is refused', (await refusal(() => OPEN.asOfOf('2999-01-01')))?.code === 'IN_FUTURE');

  // Billing over opening steps (review 2026-11-28): left out of the totals, so an operation completes on its real work.
  const line = (id) => ({ id, lineNo: id, itemId: 1, quantity: 1, delivered: 0, kgEach: 1000, tonnes: 1, lockedOn: '2026-10-01' });
  const st = (lineId, opId, { done = false, on = null, opening = false, q = 1 } = {}) => ({ lineId, opId, itemId: 1, done, finishedOn: on, quantity: q, kgEach: 1000, firstStart: null, opening });
  const F = {
    lines: [line(1), line(2)], events: [], acceptance: { decidedOn: '2026-10-01' }, shipments: [], stages: [], customerMaterial: null,
    steps: [
      st(1, 7, { opening: true, q: 3 }), st(2, 7, { done: true, on: '2026-11-20' }),            // op 7: line 1 opening, line 2 real and done
      st(1, 8, { opening: true }), st(2, 8, { opening: true }),                                // op 8: all opening
      st(1, 9, { opening: true }), st(1, 9, { done: true, on: '2026-11-21' }), st(1, 9), st(2, 9), // op 9: real steps half done
    ],
  };
  const P = BILL.orderProgress(F);
  ok('billing: an operation is complete when all its REAL steps are done — on the day of the last one', P.ops.get(7).done > 0.999 && P.ops.get(7).completeOn === '2026-11-20', JSON.stringify(P.ops.get(7)));
  ok('billing: an operation whose steps are all opening is complete with no date (never billed here)', P.ops.get(8).openingOnly === true && P.ops.get(8).completeOn == null);
  ok('billing: opening steps are not in the totals (pro-rata share of the real work only)', Math.abs(P.ops.get(9).done - 0.25) < 1e-6 && P.ops.get(9).completeOn == null, JSON.stringify(P.ops.get(9)));
  const noOpening = BILL.orderProgress({ ...F, steps: [st(1, 5, { done: true, on: '2026-11-01' }), st(2, 5)] });
  ok('billing: an order with no opening steps is billed as before', Math.abs(noOpening.ops.get(5).done - 0.5) < 1e-6);
}

const conn = await pool.getConnection();
let exitCode = 0;
try {
  const before = await census(conn);
  await conn.beginTransaction();
  attachNodeCache(conn);
  const [[user]] = await conn.query('SELECT id FROM users WHERE company_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 1', [COMPANY]);
  const c = { companyId: COMPANY, userId: user?.id ?? null };
  const [[line]] = await conn.query(
    'SELECT l.id, l.line_no, l.locked_at, l.order_id, l.made_qty, o.code AS order_code, o.status FROM cf_sales_order_lines l JOIN cf_sales_orders o ON o.id = l.order_id WHERE l.company_id = ? AND l.id = ?',
    [COMPANY, LINE],
  );
  if (!line) throw new Error(`Line ${LINE} is not a line of company ${COMPANY}.`);
  if (await REL.liveReleaseOfLine(conn, COMPANY, LINE)) throw new Error(`Line ${LINE} is already released — it must not be; stopping.`);
  console.log(`\nCompany ${COMPANY}, ${line.order_code} line ${line.line_no} (${LINE})`);

  console.log('\n1. Before release');
  ok('a line not released is refused, in words', (await refusal(() => OPEN.setOpeningPosition(conn, c, LINE, { stage: 1, dryRun: true })))?.code === 'NOT_RELEASED');

  if (!line.locked_at) await LOCK.lockLine(conn, c, LINE);
  if (line.status !== 'confirmed') {
    await conn.query("UPDATE cf_sales_orders SET committed_date = COALESCE(committed_date, '2026-12-31') WHERE company_id = ? AND id = ?", [COMPANY, line.order_id]);
    await SO.setOrderStatus(conn, c, line.order_id, 'confirmed');
  }
  let check = await REL.releaseCheck(conn, COMPANY, LINE);
  if (check.needsFinishedArea && !check.areas.some((a) => a.purpose === 'dispatch')) {
    await AREAS.createArea(conn, c, { code: 'OPT-DSP', name: 'Opening test dispatch', purpose: 'dispatch' });
    check = await REL.releaseCheck(conn, COMPANY, LINE);
  }
  if (!check.ok) throw new Error(`The line cannot be released: ${check.problems.slice(0, 5).join(' | ')}`);
  const rel = await REL.releaseLine(conn, c, LINE, { view: 'none', ...(check.needsFinishedArea ? { finishedAreaId: check.areas.find((a) => a.purpose === 'dispatch')?.id } : {}) });
  const releaseId = rel.id;
  // NO reservation, NO issue: the opening position must not need material, and neither must the real step after it.

  // The company's stages, for the local KEPL copy's operation codes (the default list names Placebo's codes).
  const [ops] = await conn.query(
    `SELECT DISTINCT o.code FROM cf_production_steps s JOIN cf_production_items pi ON pi.id = s.production_item_id JOIN cf_operations o ON o.id = s.operation_id
      WHERE s.company_id = ? AND pi.release_id = ? AND s.deleted_at IS NULL`, [COMPANY, releaseId]);
  const codes = new Set(ops.map((o) => String(o.code).toUpperCase()));
  const pick = (...want) => want.filter((w) => codes.has(w));
  const stagesText = [
    `Cut: ${pick('CUT', 'CG-GASCUT', 'CNCP-CUT', 'GASCUT').join(', ')}`,
    `Fit-up & weld: ${pick('ASSY', 'SAW', 'WQC', 'HBFIT', 'SAWWELD').join(', ')}`,
    `Drill: ${pick('DRILL', 'CNCDRILL', 'MANDRILL').join(', ')}`,
    `Blast & paint: ${pick('BLAST', 'METAL', 'PAINT', 'PQC').join(', ')}`,
    `Final: ${pick('FQC').join(', ')}`,
  ].join('\n');
  console.log(`  operations on the line: ${[...codes].sort().join(' ')}`);
  const page = await SET.saveSettings(conn, c, { values: { production_stages: stagesText } });
  const item = page.groups.flatMap((g) => g.items).find((i) => i.key === 'production_stages');
  ok('the stages are saved from the settings page\'s text and shown back as text', item?.value === SET.parseStages(stagesText).stages.map((s) => `${s.name}: ${s.ops.join(', ')}`).join('\n') && item.changed === true, item?.value);
  const [[stored]] = await conn.query("SELECT value FROM cf_settings WHERE company_id = ? AND skey = 'production_stages'", [COMPANY]);
  ok('…kept as JSON', Array.isArray(JSON.parse(stored?.value ?? 'null')));
  ok('an operation in two stages is refused by the settings page', (await refusal(() => SET.saveSettings(conn, c, { values: { production_stages: 'A: CUT\nB: CUT' } })))?.problems?.some((p) => /one stage/.test(p)) === true);

  const view = await OPEN.openingPositionView(conn, COMPANY, LINE);
  ok('the dialog reads the stages, the pieces to tick and the counts', view.stages.length === 5 && view.pieces.length > 0 && view.steps > 0 && view.openingSteps === 0, JSON.stringify({ stages: view.stages.length, pieces: view.pieces.length }));
  console.log(`  released inside the transaction: ${view.steps} steps, ${view.pieces.length} pieces on the top two levels, ${view.units.length} units`);

  const counts = async () => {
    const [[r]] = await conn.query(
      `SELECT (SELECT COUNT(*) FROM cf_stock_ledger WHERE company_id = ?) AS ledger, (SELECT COUNT(*) FROM cf_stock_movements WHERE company_id = ?) AS movements,
              (SELECT COUNT(*) FROM cf_wip_joins WHERE company_id = ?) AS joins, (SELECT COUNT(*) FROM cf_stock_reservations WHERE company_id = ?) AS reservations,
              (SELECT COUNT(*) FROM cf_stock_batches WHERE company_id = ?) AS lots,
              (SELECT made_qty FROM cf_sales_order_lines WHERE id = ?) AS made, (SELECT COALESCE(SUM(stocked_qty), 0) FROM cf_production_items WHERE company_id = ? AND release_id = ?) AS stocked,
              (SELECT COALESCE(SUM(issued), 0) FROM cf_material_requirements WHERE company_id = ? AND release_id = ?) AS issued`,
      [COMPANY, COMPANY, COMPANY, COMPANY, COMPANY, LINE, COMPANY, releaseId, COMPANY, releaseId]);
    return Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Number(v)]));
  };
  const readSteps = async () => {
    const [rows] = await conn.query(
      `SELECT s.id, s.production_item_id, s.state, s.quantity, s.qty_good, s.opening, s.started_at, s.finished_at, s.ledger_in, s.ledger_out, o.code AS op_code
         FROM cf_production_steps s JOIN cf_production_items pi ON pi.id = s.production_item_id JOIN cf_operations o ON o.id = s.operation_id
        WHERE s.company_id = ? AND pi.release_id = ? AND s.deleted_at IS NULL ORDER BY s.production_item_id, s.sequence, s.id`, [COMPANY, releaseId]);
    return rows;
  };
  const stageOf = new Map();
  SET.parseStages(stagesText).stages.forEach((s, i) => { for (const code of s.ops) stageOf.set(code, i); });
  const [treeItems] = await conn.query('SELECT id, parent_id FROM cf_production_items WHERE company_id = ? AND release_id = ? AND deleted_at IS NULL', [COMPANY, releaseId]);
  const parentOf = new Map(treeItems.map((i) => [i.id, i.parent_id]));
  const ancestors = (id) => { const out = []; let p = parentOf.get(id); while (p != null) { out.push(p); p = parentOf.get(p); } return out; };
  /** What stage x should leave done, worked out here independently: each piece by its own flow, and a piece under any
   *  piece (in scope) with an opening step is done through its whole flow. */
  const expected = (rows, x, inScope = () => true) => {
    const want = new Set();
    const byItem = new Map();
    for (const s of rows) { if (!byItem.has(s.production_item_id)) byItem.set(s.production_item_id, []); byItem.get(s.production_item_id).push(s); }
    const ownCut = new Map([...byItem].map(([id, own]) => [id, x < 0 ? 0 : OPEN.cutOf(OPEN.stagesOfSteps(own, stageOf), x)]));
    for (const [itemId, own] of byItem) {
      if (!inScope(itemId)) continue;
      const assembled = ancestors(itemId).some((a) => inScope(a) && (ownCut.get(a) ?? 0) > 0);
      own.slice(0, assembled ? own.length : ownCut.get(itemId)).forEach((s) => want.add(s.id));
    }
    return want;
  };

  // --- 2. dry run ------------------------------------------------------------------------------------------
  console.log('\n2. A dry run to "Fit-up & weld" (stage 2), the whole line');
  const base = await counts();
  const dry = await OPEN.setOpeningPosition(conn, c, LINE, { stage: 'fit-up & weld', dryRun: true });
  const rows0 = await readSteps();
  const want2 = expected(rows0, 1);
  ok('it says what it would mark, per stage and per row', dry.dryRun === true && dry.counts.mark === want2.size && dry.byStage.length > 0 && dry.rows.length > 0, JSON.stringify(dry.counts));
  ok('…in a sentence naming the rows', /^Would mark \d+ steps? done on /.test(dry.message), dry.message);
  ok('…and changes nothing', rows0.every((s) => s.state === 'pending' && Number(s.opening) === 0));
  {
    // Pieces cut from one nested plate: ticking one without the others is said in the preview (review item 4).
    const [nest] = await conn.query(
      `SELECT a.production_item_id AS a, b.production_item_id AS b FROM cf_step_dependencies d
         JOIN cf_production_steps a ON a.id = d.step_id JOIN cf_production_steps b ON b.id = d.target_step_id
         JOIN cf_production_items pa ON pa.id = a.production_item_id
        WHERE d.company_id = ? AND d.origin = 'nest' AND d.deleted_at IS NULL AND pa.release_id = ? AND a.production_item_id <> b.production_item_id LIMIT 1`, [COMPANY, releaseId]);
    if (nest.length) {
      const w = await OPEN.setOpeningPosition(conn, c, LINE, { stage: 1, pieceIds: [nest[0].a], dryRun: true });
      ok('ticking a piece cut from a nested plate without the others warns, naming them', w.warnings.length === 1 && /same nested plate/.test(w.warnings[0]), JSON.stringify(w.warnings));
      console.log(`    ${w.warnings[0] ?? ''}`);
    } else console.log('    (the line has no nest waits — the nest warning is not exercised)');
    ok('the whole line warns of nothing', dry.warnings.length === 0);
  }
  console.log(`    ${dry.message}`);

  // --- 3. apply ------------------------------------------------------------------------------------------------
  console.log('\n3. Applied');
  const t0 = Date.now();
  const done = await OPEN.setOpeningPosition(conn, c, LINE, { stage: 2 });
  console.log(`    ${done.message} (${Date.now() - t0} ms)`);
  const rows1 = await readSteps();
  const marked = rows1.filter((s) => s.state === 'done');
  ok('exactly the steps the rule names are done', marked.length === want2.size && marked.every((s) => want2.has(s.id)), `${marked.length} vs ${want2.size}`);
  ok('…each with its whole quantity good, flagged opening', marked.every((s) => Number(s.opening) === 1 && Math.abs(Number(s.qty_good) - Number(s.quantity)) < 1e-6 && s.finished_at != null));
  ok('steps after the stage are left as they were', rows1.filter((s) => !want2.has(s.id)).every((s) => s.state === 'pending' && Number(s.opening) === 0));
  ok('a piece not inside an assembled one is done through its welding only (its later steps wait)', rows1.some((s) => s.state === 'pending' && ['DRILL', 'BLAST', 'PAINT', 'FQC'].includes(s.op_code)));
  // Review 2026-11-28: under a piece whose first (joining) step is opening, nothing is left pending.
  const firstOf = new Map();
  for (const s of rows1) if (!firstOf.has(s.production_item_id)) firstOf.set(s.production_item_id, s);
  const assembledIds = [...firstOf.values()].filter((s) => Number(s.opening) === 1).map((s) => s.production_item_id);
  const assembledSet = new Set(assembledIds);
  const pendingUnder = rows1.filter((s) => s.state === 'pending' && ancestors(s.production_item_id).some((a) => assembledSet.has(a)));
  ok('no pending step remains under any piece whose first step is opening (a parent assembled = everything under it done)', assembledIds.length > 0 && pendingUnder.length === 0, `${pendingUnder.length} pending, e.g. ${pendingUnder.slice(0, 3).map((s) => s.op_code).join(',')}`);
  ok('…and the answer counts what the parent rule added', done.counts.markedUnderAssembled >= 0 && typeof done.counts.markedUnderAssembled === 'number');
  console.log(`    ${done.counts.markedUnderAssembled} steps marked because a piece above them is assembled`);
  const [ev] = await conn.query("SELECT step_id, event, source, qty_good FROM cf_step_events WHERE company_id = ? AND step_id IN (?)", [COMPANY, marked.map((s) => s.id)]);
  ok('every marked step has one opening event (event and source "opening"), and no start or progress', ev.length === marked.length && ev.every((e) => e.event === 'opening' && e.source === 'opening'));
  const after = await counts();
  ok('nothing is posted: no ledger row, movement, WIP join, lot or reservation', ['ledger', 'movements', 'joins', 'lots', 'reservations'].every((k) => after[k] === base[k]), JSON.stringify({ base, after }));
  ok('no material issued, nothing in finished stock, no made quantity', after.issued === base.issued && after.stocked === base.stocked && after.made === base.made);
  ok('steps marked again: nothing changes', (await OPEN.setOpeningPosition(conn, c, LINE, { stage: 2, dryRun: true })).counts.mark === 0);
  const F = await BILL.billingFacts(conn, COMPANY, { orderIds: [line.order_id] });
  if (F.length) ok('billing counts no opening step as done', F[0].steps.every((s) => !s.done), JSON.stringify(F[0].steps.filter((s) => s.done).slice(0, 2)));
  else console.log('    (the order has no approved acceptance — billing has nothing to read; its query is covered by the test of §121\'s SQL below)');
  const [[bill]] = await conn.query(
    `SELECT SUM(s.state = 'done' AND s.opening = 0) AS billable FROM cf_production_steps s JOIN cf_production_items pi ON pi.id = s.production_item_id WHERE s.company_id = ? AND pi.release_id = ?`, [COMPANY, releaseId]);
  ok('…the done steps billing would count are none', Number(bill.billable) === 0);

  // --- 4. the tracker reads them as done, tagged; the next real step goes ahead without material -------------
  console.log('\n4. The floor carries on');
  const data = await REL.evaluatedTracker(conn, COMPANY, [releaseId]);
  const tree = await TREE.lineGrid(conn, COMPANY, { lineId: LINE, depth: 50 });
  const openingCells = tree.nodes.flatMap((n) => Object.values(n.cells)).filter((cell) => cell.opening);
  ok('the line\'s grid tags opening steps', openingCells.length > 0);
  const stepById = new Map(data.steps.map((s) => [s.id, s]));
  const itemsWithOpening = new Set(marked.map((s) => s.production_item_id));
  // A pending step right after an opening one on its piece, nothing in its way.
  const next = data.steps.find((s) => s.state === 'pending' && itemsWithOpening.has(s.production_item_id) && s._status === 'ready');
  const reqSteps = new Set(data.reqs.filter((q) => q.step_id).map((q) => q.step_id));
  const cutWithMaterial = marked.filter((s) => reqSteps.has(s.id));
  ok('opening steps include cuts whose plates were never reserved', cutWithMaterial.length > 0 && data.reqs.filter((q) => cutWithMaterial.some((s) => s.id === q.step_id)).every((q) => !q._covered));
  ok('the next real step is ready: opening steps count as done, their unreserved material does not hold it', !!next);
  if (next) {
    const shaped = REL.shapeStep(next, '');
    ok('…and says nothing about material', !shaped.blockers.some((b) => b.kind === 'material'));
    await REL.startStep(conn, c, next.id, { view: 'none' });
    await REL.recordProgress(conn, c, next.id, { good: Number(next.quantity), view: 'none' });
    const [[s]] = await conn.query('SELECT state, opening FROM cf_production_steps WHERE id = ?', [next.id]);
    ok('it is started and finished on the floor as real work (not opening)', s.state === 'done' && Number(s.opening) === 0);
    const [[o]] = await conn.query('SELECT COUNT(*) AS n FROM cf_production_steps WHERE company_id = ? AND id IN (?) AND (ledger_in <> 0 OR ledger_out <> 0)', [COMPANY, marked.map((m) => m.id)]);
    ok('the real step posts nothing for the opening steps before it', Number(o.n) === 0);
  }

  // --- 5. going back ----------------------------------------------------------------------------------------
  console.log('\n5. Going back');
  const realItem = next?.production_item_id;
  const otherTop = view.units.length > 1 ? view.units.find((u) => {
    // a unit that does not hold the piece with the real step
    const under = new Set([u.id]);
    for (const p of data.items) if (under.has(p.parent_id)) under.add(p.id);
    return !under.has(realItem);
  }) : null;
  if (realItem) {
    const e = await refusal(() => OPEN.setOpeningPosition(conn, c, LINE, { stage: 0, pieceIds: [`p${realItem}`] }));
    ok('going back past real work is refused, with a sentence and the piece named', e?.code === 'REAL_WORK_AFTER' && /real work/.test(e.message) && e.problems?.length > 0, e?.message);
    const [[still]] = await conn.query('SELECT COUNT(*) AS n FROM cf_production_steps WHERE company_id = ? AND production_item_id = ? AND opening = 1', [COMPANY, realItem]);
    ok('…and nothing was re-opened', Number(still.n) > 0);
  }
  const backScope = otherTop ? { units: [otherTop.number] } : {};
  const backTo = 1;   // "Cut"
  const inUnit = otherTop ? (() => { const u = new Set([otherTop.id]); for (const p of data.items) if (u.has(p.parent_id)) u.add(p.id); return (id) => u.has(id); })() : () => true;
  if (otherTop || !realItem) {
    const back = await OPEN.setOpeningPosition(conn, c, LINE, { stage: backTo, ...backScope });
    const rows2 = await readSteps();
    const wantCut = expected(rows0, 0, inUnit);
    const reopened = rows1.filter((s) => s.state === 'done' && inUnit(s.production_item_id) && !wantCut.has(s.id)).map((s) => s.id);
    const now = new Map(rows2.map((s) => [s.id, s]));
    ok(`back to "Cut"${otherTop ? ` on unit ${otherTop.number}` : ''}: the later opening steps are pending again, flag cleared`, back.counts.reopen === reopened.length && reopened.every((id) => now.get(id).state === 'pending' && Number(now.get(id).opening) === 0 && Number(now.get(id).qty_good) === 0), `${back.counts.reopen} vs ${reopened.length}`);
    ok('…the cut stays done', [...wantCut].every((id) => now.get(id).state === 'done'));
    ok('…the other unit is untouched', rows2.filter((s) => !inUnit(s.production_item_id)).every((s) => s.state === rows1.find((r) => r.id === s.id).state || s.id === next?.id));
    const [[evBack]] = await conn.query("SELECT COUNT(*) AS n FROM cf_step_events WHERE company_id = ? AND step_id IN (?) AND event = 'opening' AND qty_good < 0", [COMPANY, reopened.length ? reopened : [0]]);
    ok('…each re-opened step has its take-back event', Number(evBack.n) === reopened.length);
  } else console.log('    (one unit only, and it holds the real step — the take-back is covered by the refusal above)');

  // --- 6. an as-of before the release is history: allowed and recorded ------------------------------------------
  console.log('\n6. As of a day before the release');
  // The unit taken back to "Cut" above (or, with one unit, the whole line), forward to "Fit-up & weld" again.
  const asOf = await OPEN.setOpeningPosition(conn, c, LINE, { stage: 2, ...(otherTop ? { pieceIds: [otherTop.id] } : {}), asOf: '2026-01-15' });
  const [[t]] = await conn.query("SELECT COUNT(*) AS n, MIN(DATE_FORMAT(finished_at, '%Y-%m-%d')) AS d FROM cf_production_steps s JOIN cf_production_items pi ON pi.id = s.production_item_id WHERE s.company_id = ? AND pi.release_id = ? AND s.opening = 1 AND DATE(s.finished_at) = '2026-01-15'", [COMPANY, releaseId]);
  ok('allowed, said, and the steps carry that date', asOf.beforeRelease === true && asOf.asOf === '2026-01-15' && (otherTop ? asOf.counts.mark > 0 : true) && (asOf.counts.mark === 0 || Number(t.n) === asOf.counts.mark), JSON.stringify({ mark: asOf.counts.mark, n: t.n }));
  const [[evAt]] = await conn.query("SELECT COUNT(*) AS n FROM cf_step_events WHERE company_id = ? AND event = 'opening' AND DATE(at) = '2026-01-15'", [COMPANY]);
  ok('…and so do their opening events', Number(evAt.n) === asOf.counts.mark);

  // --- 6b. a step on hold before it started is not floor work ---------------------------------------------------
  console.log('\n6b. A step on hold that never started');
  const [[pend]] = await conn.query(
    `SELECT s.id FROM cf_production_steps s JOIN cf_production_items pi ON pi.id = s.production_item_id
      WHERE s.company_id = ? AND pi.release_id = ? AND s.state = 'pending' AND s.deleted_at IS NULL ORDER BY s.id DESC LIMIT 1`, [COMPANY, releaseId]);
  await conn.query("UPDATE cf_production_steps SET state = 'on_hold', held_from = 'pending' WHERE id = ?", [pend.id]);
  const last = await OPEN.setOpeningPosition(conn, c, LINE, { stage: 5, dryRun: true });
  ok('a step on hold that never started is left on hold and counted on its own, not as started', last.counts.leftHeld === 1 && /on hold before starting/.test(last.message), JSON.stringify(last.counts));
  await conn.query("UPDATE cf_production_steps SET state = 'pending', held_from = NULL WHERE id = ?", [pend.id]);

  // --- 7. no company learns of another -------------------------------------------------------------------------
  console.log('\n7. Another company');
  const [[other]] = await conn.query('SELECT id FROM companies WHERE id <> ? ORDER BY id LIMIT 1', [COMPANY]);
  const other404 = await refusal(() => OPEN.setOpeningPosition(conn, { companyId: other.id, userId: null }, LINE, { stage: 1, dryRun: true }));
  ok('another company\'s line is not found (404)', other404?.status === 404, other404?.message);
  const view404 = await refusal(() => OPEN.openingPositionView(conn, other.id, LINE));
  ok('…and its view too', view404?.status === 404);
  const piece404 = await refusal(() => OPEN.setOpeningPosition(conn, c, LINE, { stage: 1, pieceIds: [999999999], dryRun: true }));
  ok('a piece that is not on the line is not found', piece404?.status === 404);

  await conn.rollback();
  SET.clearSettingsCache(COMPANY);
  const afterAll = await census(conn);
  const changed = Object.keys(before).filter((k) => before[k] !== afterAll[k]);
  ok('every cf_ table is back where it started', changed.length === 0, changed.map((k) => `${k} ${before[k]}→${afterAll[k]}`).join(', '));
} catch (err) {
  try { await conn.rollback(); } catch { /* the error below matters */ }
  console.error(`\nERROR: ${err.stack}${err.problems?.length ? `\n  ${err.problems.slice(0, 10).join('\n  ')}` : ''}`);
  exitCode = 1;
} finally {
  conn.release();
  await pool.end();
}
console.log(`\n${passed} passed, ${failed} failed${fails.length ? `\n  ${fails.join('\n  ')}` : ''}`);
process.exitCode = exitCode || (failed ? 1 : 0);
