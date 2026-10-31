/**
 * timing_sheets_test.mjs — timings as Excel (timingSheetService, 2026-10-31), against the local database:
 *   1. standard times (every operation's timing rules)   2. an order's time per operation   3. floor progress
 * For each: the round trip, a PREPARED file matched by business keys (no hidden ids, columns in another order, grey
 * columns left out), the refusals (every problem at once, nothing written), and that a dry run writes nothing.
 *
 *   cd multi_app_be
 *   node scripts/cf_kepl/timing_sheets_test.mjs
 *
 *   CF_TIMING_COMPANY (2), CF_TIMING_LINE (923 — the local KEPL copy, released INSIDE the transaction as step_batch_test does)
 *
 * EVERYTHING HAPPENS INSIDE ONE TRANSACTION THAT IS ROLLED BACK; the floor sheet's per-row transactions are SAVEPOINTs.
 * The last thing it does is re-count every cf_ table and prove each is back where it started.
 */
import path from 'path';
import { pathToFileURL } from 'url';
import ExcelJS from 'exceljs';

const BE = process.cwd();
const imp = (p) => import(pathToFileURL(path.join(BE, p)).href);
const { pool } = await imp('db.js');
await imp('apps/cf_erp/services/codegenProvider.js');
const { attachNodeCache } = await imp('apps/cf_erp/lib/db.js');
const REL = await imp('apps/cf_erp/services/releaseService.js');
const LOCK = await imp('apps/cf_erp/services/lockService.js');
const SO = await imp('apps/cf_erp/services/salesOrderService.js');
const AREAS = await imp('apps/cf_erp/services/stockingAreaService.js');
const OPS = await imp('apps/cf_erp/services/operationService.js');
const TS = await imp('apps/cf_erp/services/timingSheetService.js');

const COMPANY = Number(process.env.CF_TIMING_COMPANY ?? 2);
const LINE = Number(process.env.CF_TIMING_LINE ?? 923);
const RUN = `TS${Date.now().toString(36).toUpperCase().slice(-5)}`;

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
/** Reads a downloaded sheet: header row 2, data from row 3, as objects by header. */
async function readOut(out) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(out.buffer);
  const ws = wb.worksheets[0];
  const heads = [];
  ws.getRow(2).eachCell((cell, c) => { heads[c] = String(cell.value); });
  const rows = [];
  for (let r = 3; r <= ws.rowCount; r += 1) {
    const o = {};
    let any = false;
    heads.forEach((h, c) => { if (!h) return; const v = ws.getRow(r).getCell(c).value; o[h] = v; if (v != null && v !== '') any = true; });
    if (any) rows.push(o);
  }
  return rows;
}
/** A hand-made file: a header row then rows (arrays), no banner — as someone would type it. */
async function prepared(headers, rows) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Mine');
  ws.addRow(headers);
  for (const r of rows) ws.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer()).toString('base64');
}
const b64 = (out) => out.buffer.toString('base64');
const refusal = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

const conn = await pool.getConnection();
let exitCode = 0;
try {
  const before = await census(conn);
  await conn.beginTransaction();
  attachNodeCache(conn);
  const [[user]] = await conn.query('SELECT id FROM users WHERE company_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 1', [COMPANY]);
  const c = { companyId: COMPANY, userId: user?.id ?? null };
  console.log(`\nCompany ${COMPANY}, run ${RUN}`);

  /* ======================================================================================================= */
  console.log('\n1. Standard times');
  const opA = await OPS.createOperation(conn, c, { code: `${RUN}-CUT`, name: `${RUN} cut` });
  const opB = await OPS.createOperation(conn, c, { code: `${RUN}-DRL`, name: `${RUN} drill` });
  const [tr] = await conn.query("INSERT INTO cf_classification_nodes (company_id, parent_id, depth, scope, code, name) VALUES (?, NULL, 1, 'machine', ?, ?)", [COMPANY, `${RUN}MT`, `${RUN} machine type`]);
  const typeId = tr.insertId;
  const [mr] = await conn.query('INSERT INTO cf_machines (company_id, code, name, classification_id) VALUES (?, ?, ?, ?)', [COMPANY, `${RUN}-M1`, `${RUN} machine 1`, typeId]);
  const machineId = mr.insertId;
  const ruleA = await OPS.createTimingRule(conn, c, opA.id, { subjectType: 'classification', subjectId: typeId, setupMinutes: 5, workExpression: 'MAX(1, 2)' });
  const rulesOf = async (opId) => OPS.listTimingRules(conn, COMPANY, opId);

  const out1 = await TS.exportOperationTimesSheet(conn, COMPANY);
  const sheet1 = await readOut(out1);
  const rowA = sheet1.find((r) => r['Operation code'] === opA.code);
  const rowB = sheet1.find((r) => r['Operation code'] === opB.code);
  ok('download: a .xlsx with every operation', out1.contentType.includes('spreadsheetml') && !!rowA && !!rowB);
  ok('download: the rule by its business keys and its two times as the screen shows them',
    rowA?.Subject === 'Machine type' && rowA?.['Machine type or machine code'] === `${RUN}MT` && Number(rowA?.['Setup time (min)']) === 5 && rowA?.['Time per quantity (min)'] === 'MAX(1, 2)', JSON.stringify(rowA));
  ok('download: an operation with no rule is one row with no subject', !rowB?.Subject && !rowB?.['Machine type or machine code']);
  const same1 = await TS.importOperationTimesSheet(conn, c, { fileBase64: b64(out1), dryRun: true });
  ok('round trip: the download uploaded as it is changes nothing', same1.ok && same1.changes.length === 0 && /nothing to change/.test(same1.summary.sentence), same1.summary.sentence);

  // A prepared file: columns in another order, no grey columns, codes in lower case.
  const headers1 = ['Time per quantity (min)', 'Operation code', 'Machine type or machine code', 'Setup time (min)', 'Subject'];
  const file1 = await prepared(headers1, [
    ['MAX(1, 2)', opA.code.toLowerCase(), `${RUN}mt`, 7, 'Machine type'], // setup 5 -> 7
    [4, opB.code, `${RUN}MT`, '', ''], // a new rule (Subject left empty: found as a machine type)
    [3, opA.code, `${RUN}-M1`, '', 'Machine'], // a new rule on one machine
  ]);
  const dry1 = await TS.importOperationTimesSheet(conn, c, { fileBase64: file1, dryRun: true });
  ok('dry run: the plan in words', dry1.ok && dry1.dryRun && dry1.summary.rulesUpdated === 1 && dry1.summary.rulesAdded === 2, JSON.stringify(dry1.summary) + JSON.stringify(dry1.problems));
  ok('dry run: writes nothing', (await rulesOf(opA.id)).length === 1 && (await rulesOf(opA.id))[0].setup.minutes === 5 && (await rulesOf(opB.id)).length === 0);
  const run1 = await TS.importOperationTimesSheet(conn, c, { fileBase64: file1 });
  const aAfter = await rulesOf(opA.id);
  const bAfter = await rulesOf(opB.id);
  ok('applied: matched by operation code + machine type code (case aside), only setup changed', run1.applied === true && aAfter.find((r) => r.id === ruleA.id)?.setup.minutes === 7 && aAfter.find((r) => r.id === ruleA.id)?.work.expression === 'MAX(1, 2)');
  ok('applied: a rule added where the operation had none for that subject', bAfter.length === 1 && bAfter[0].subject.id === typeId && bAfter[0].work.minutes === 4);
  ok('applied: a rule added on one machine', aAfter.some((r) => r.subject.type === 'machine' && r.subject.id === machineId && r.work.minutes === 3));
  const again1 = await TS.importOperationTimesSheet(conn, c, { fileBase64: b64(await TS.exportOperationTimesSheet(conn, COMPANY)), dryRun: true });
  ok('round trip after the change: nothing more to change', again1.ok && again1.changes.length === 0);

  // Refusals — every problem at once, nothing written (the good row in the same file included).
  const bad1 = await prepared(['Operation code', 'Subject', 'Machine type or machine code', 'Setup time (min)', 'Time per quantity (min)', 'Valid from'], [
    [opA.code, 'Machine type', `${RUN}MT`, 9, 'MAX(1, 2)', ''], // fine on its own
    ['NO-SUCH-OP', 'Machine type', `${RUN}MT`, 1, 1, ''],
    [opB.code, 'Machine type', 'NO-SUCH-TYPE', 1, 1, ''],
    [opB.code, 'Machine type', `${RUN}MT`, '', 'item.X +', ''], // the screen's expression check
    [opA.code, 'Machine', `${RUN}-M1`, '', 3, '31-10-2026'],
    [opA.code, 'Machine type', `${RUN}MT`, 9, 'MAX(1, 2)', ''], // twice
    [opB.code, 'Robot', `${RUN}MT`, '', 1, ''],
  ]);
  const dryBad1 = await TS.importOperationTimesSheet(conn, c, { fileBase64: bad1, dryRun: true });
  const p1 = dryBad1.problems.join(' | ');
  ok('refused: an unknown operation, machine type, a bad date, a repeated row and a bad Subject — all at once',
    !dryBad1.ok && /NO-SUCH-OP/.test(p1) && /NO-SUCH-TYPE/.test(p1) && /YYYY-MM-DD/.test(p1) && /twice/.test(p1) && /Robot/.test(p1), p1);
  ok('refused: a broken expression, in the rule service\'s own words', dryBad1.problems.some((p) => /Sheet row 5/.test(p) && /Work/.test(p)), p1);
  ok('refused: nothing written, not even the good row', (await rulesOf(opA.id)).find((r) => r.id === ruleA.id)?.setup.minutes === 7);
  const applyBad1 = await refusal(() => TS.importOperationTimesSheet(conn, c, { fileBase64: bad1 }));
  ok('refused on apply: 422 with the problems, nothing written', applyBad1?.status === 422 && applyBad1.problems?.length >= 5 && (await rulesOf(opA.id)).find((r) => r.id === ruleA.id)?.setup.minutes === 7);
  const fooFile = await prepared(['Foo', 'Bar'], [[1, 2]]);
  const notSheet = await refusal(() => TS.importOperationTimesSheet(conn, c, { fileBase64: fooFile, dryRun: true }));
  ok('a workbook that is not this sheet is refused in words', notSheet?.code === 'BAD_FILE' && /Operation code/.test(notSheet.message));

  /* ======================================================================================================= */
  console.log('\n2. An order\'s time per operation');
  const [[line]] = await conn.query(
    'SELECT l.id, l.line_no, l.locked_at, l.order_id, o.code AS order_code, o.status FROM cf_sales_order_lines l JOIN cf_sales_orders o ON o.id = l.order_id WHERE l.company_id = ? AND l.id = ?',
    [COMPANY, LINE],
  );
  if (!line) throw new Error(`Line ${LINE} is not a line of company ${COMPANY}.`);
  if (await REL.liveReleaseOfLine(conn, COMPANY, LINE)) throw new Error(`Line ${LINE} is already released — it must not be; stopping.`);
  if (!line.locked_at) await LOCK.lockLine(conn, c, LINE);
  if (line.status !== 'confirmed') {
    await conn.query("UPDATE cf_sales_orders SET committed_date = COALESCE(committed_date, '2026-12-31') WHERE company_id = ? AND id = ?", [COMPANY, line.order_id]);
    await SO.setOrderStatus(conn, c, line.order_id, 'confirmed');
  }
  await conn.query('UPDATE cf_sales_orders SET time_override_seconds = NULL WHERE company_id = ? AND id = ?', [COMPANY, line.order_id]);
  // Only this line of the order is looked at: the order's other lines are taken out inside the transaction.
  await conn.query('UPDATE cf_sales_order_lines SET deleted_at = NOW() WHERE company_id = ? AND order_id = ? AND id <> ? AND deleted_at IS NULL', [COMPANY, line.order_id, LINE]);
  let check = await REL.releaseCheck(conn, COMPANY, LINE);
  if (check.needsFinishedArea && !check.areas.some((a) => a.purpose === 'dispatch')) {
    await AREAS.createArea(conn, c, { code: `${RUN}-DSP`, name: 'Timing sheets test dispatch', purpose: 'dispatch' });
    check = await REL.releaseCheck(conn, COMPANY, LINE);
  }
  if (!check.ok) throw new Error(`The line cannot be released: ${check.problems.slice(0, 5).join(' | ')}`);
  const rel = await REL.releaseLine(conn, c, LINE, { view: 'none', ...(check.needsFinishedArea ? { finishedAreaId: check.areas.find((a) => a.purpose === 'dispatch')?.id } : {}) });
  const releaseId = rel.id;
  await REL.reserveRelease(conn, c, releaseId, { view: 'none' }).catch(() => null);
  await conn.query('UPDATE cf_material_requirements SET issued = quantity WHERE company_id = ? AND release_id = ?', [COMPANY, releaseId]);
  console.log(`  ${line.order_code} line ${line.line_no} released inside the transaction (release ${releaseId})`);

  const out2 = await TS.exportOrderOperationTimesSheet(conn, COMPANY, line.order_id);
  const sheet2 = await readOut(out2);
  const [opSteps] = await conn.query(
    `SELECT o.id, o.code, COUNT(*) AS n, SUM(s.state <> 'done') AS open_n FROM cf_production_steps s JOIN cf_production_items pi ON pi.id = s.production_item_id
       JOIN cf_operations o ON o.id = s.operation_id WHERE pi.release_id = ? AND s.deleted_at IS NULL GROUP BY o.id, o.code ORDER BY n DESC`, [releaseId]);
  ok('download: one row per operation the order\'s steps use', sheet2.length === opSteps.length && opSteps.every((o) => sheet2.some((r) => r['Operation code'] === o.code)), `${sheet2.length} vs ${opSteps.length}`);
  ok('download: each with its steps and the standard times', sheet2.every((r) => Number(r['Steps released']) > 0) && 'Standard setup (min)' in sheet2[0]);
  const target = opSteps[0];
  const same2 = await TS.importOrderOperationTimesSheet(conn, c, line.order_id, { fileBase64: b64(out2), dryRun: true });
  ok('round trip: the download uploaded as it is changes nothing', same2.ok && same2.changes.length === 0, same2.summary.sentence);

  const stepTimes = async () => {
    const [rows] = await conn.query(`SELECT s.id, s.state, s.est_setup_minutes, s.est_work_minutes FROM cf_production_steps s JOIN cf_production_items pi ON pi.id = s.production_item_id
      WHERE pi.release_id = ? AND s.operation_id = ? AND s.deleted_at IS NULL`, [releaseId, target.id]);
    return rows;
  };
  const overrides = async () => (await conn.query('SELECT COUNT(*) AS n FROM cf_time_overrides WHERE company_id = ? AND order_line_id = ? AND operation_id = ? AND deleted_at IS NULL', [COMPANY, LINE, target.id]))[0][0].n;
  const t0 = await stepTimes();
  const ov0 = Number(await overrides());
  const file2 = await prepared(['Operation code', 'Order time per quantity (min)', 'Order setup (min)'], [[target.code.toLowerCase(), 2.5, 1.5]]);
  const dry2 = await TS.importOrderOperationTimesSheet(conn, c, line.order_id, { fileBase64: file2, dryRun: true });
  ok('dry run: the operation and how many steps it re-times', dry2.ok && dry2.summary.operationsChanged === 1 && dry2.summary.stepsToRetime === Number(target.open_n), JSON.stringify(dry2.summary));
  const t1 = await stepTimes();
  ok('dry run: writes nothing', Number(await overrides()) === ov0 && t1.every((s, i) => s.est_work_minutes === t0[i].est_work_minutes));
  const run2 = await TS.importOrderOperationTimesSheet(conn, c, line.order_id, { fileBase64: file2 });
  const t2 = await stepTimes();
  ok('applied: matched by operation code — every step not done of it re-timed to 1.5 + 2.5', run2.applied === true && t2.filter((s) => s.state !== 'done').every((s) => Number(s.est_setup_minutes) === 1.5 && Number(s.est_work_minutes) === 2.5), JSON.stringify(t2.slice(0, 2)));
  ok('applied: kept as the order\'s typed times (cf_time_overrides), one per row', Number(await overrides()) > 0);
  const sheet2b = await readOut(await TS.exportOrderOperationTimesSheet(conn, COMPANY, line.order_id));
  const rowT = sheet2b.find((r) => r['Operation code'] === target.code);
  ok('round trip: the next download shows the order\'s times', Number(rowT?.['Order setup (min)']) === 1.5 && Number(rowT?.['Order time per quantity (min)']) === 2.5, JSON.stringify(rowT));
  // Emptied cells: back to the standard.
  const clear2 = await prepared(['Operation code', 'Order setup (min)', 'Order time per quantity (min)'], [[target.code, '', '']]);
  const runClear = await TS.importOrderOperationTimesSheet(conn, c, line.order_id, { fileBase64: clear2 });
  const t3 = await stepTimes();
  ok('emptied: the typed times go and the steps take the standard again', runClear.applied === true && Number(await overrides()) === ov0
    && t3.every((s, i) => s.state === 'done' || (String(s.est_work_minutes) === String(t0[i].est_work_minutes) && String(s.est_setup_minutes) === String(t0[i].est_setup_minutes))), JSON.stringify([t0[0], t3[0]]));
  const bad2 = await prepared(['Operation code', 'Order setup (min)', 'Order time per quantity (min)'], [
    ['NOT-IN-ORDER', 1, 1], [target.code, -1, 'abc'], [opA.code, 1, 1],
  ]);
  const dryBad2 = await TS.importOrderOperationTimesSheet(conn, c, line.order_id, { fileBase64: bad2, dryRun: true });
  const p2 = dryBad2.problems.join(' | ');
  ok('refused: an operation the order does not use, negative and non-numbers — all at once', !dryBad2.ok && /NOT-IN-ORDER/.test(p2) && /"-1"/.test(p2) && /"abc"/.test(p2) && new RegExp(opA.code).test(p2), p2);
  const applyBad2 = await refusal(() => TS.importOrderOperationTimesSheet(conn, c, line.order_id, { fileBase64: bad2 }));
  ok('refused on apply: 422, nothing written', applyBad2?.status === 422 && Number(await overrides()) === ov0);
  // The one-number override still wins, and the preview says so.
  await conn.query('UPDATE cf_sales_orders SET time_override_seconds = 30 WHERE company_id = ? AND id = ?', [COMPANY, line.order_id]);
  const warn2 = await TS.importOrderOperationTimesSheet(conn, c, line.order_id, { fileBase64: file2, dryRun: true });
  ok('with "Override all times" on, the preview says it wins', /Override all times to 30 s/.test(warn2.summary.sentence) && !!warn2.summary.warning);
  await conn.query('UPDATE cf_sales_orders SET time_override_seconds = NULL WHERE company_id = ? AND id = ?', [COMPANY, line.order_id]);

  /* ======================================================================================================= */
  console.log('\n3. Floor progress');
  let sp = 0;
  const tx = async (fn) => {
    sp += 1;
    const name = `ts${sp}`;
    await conn.query(`SAVEPOINT ${name}`);
    try { const r = await fn(conn); await conn.query(`RELEASE SAVEPOINT ${name}`); return r; } catch (e) { await conn.query(`ROLLBACK TO SAVEPOINT ${name}`); throw e; }
  };
  const opts = { db: conn, tx };
  const ev = async () => { const d = await REL.evaluatedTracker(conn, COMPANY, [releaseId]); return { d, byId: new Map(d.steps.map((s) => [s.id, s])) }; };
  let { d, byId } = await ev();
  const out3 = await TS.exportFloorSheet(conn, COMPANY, line.order_id);
  const sheet3 = await readOut(out3);
  ok('download: one row per step of the order', sheet3.length === d.steps.length, `${sheet3.length} vs ${d.steps.length}`);
  const code = (s) => d.itemById.get(s.production_item_id)?.code;
  const keyCount = new Map();
  for (const s of d.steps) { const k = `${code(s)}|${s.op_code}`; keyCount.set(k, (keyCount.get(k) ?? 0) + 1); }
  const unique = (s) => keyCount.get(`${code(s)}|${s.op_code}`) === 1 && !!code(s);
  const rowOf = (s) => sheet3.find((r) => r['Piece code'] === code(s) && r['Operation code'] === s.op_code);
  // Two ready steps and one that waits only on the first.
  const depsOf = new Map();
  for (const x of d.deps) { if (!depsOf.has(x.step_id)) depsOf.set(x.step_id, []); depsOf.get(x.step_id).push(x); }
  const stepsOfItem = new Map();
  for (const s of d.steps) { if (!stepsOfItem.has(s.production_item_id)) stepsOfItem.set(s.production_item_id, []); stepsOfItem.get(s.production_item_id).push(s); }
  const ready = d.steps.filter((s) => s._status === 'ready' && s.state === 'pending' && unique(s));
  let r1 = null;
  let w = null;
  for (const cand of ready) {
    const held = (x) => (x.target_step_id != null ? x.target_step_id === cand.id : (stepsOfItem.get(x.target_item_id) ?? []).every((t) => t.id === cand.id));
    w = d.steps.find((s) => s.state === 'pending' && s._status === 'not_ready' && unique(s) && (depsOf.get(s.id) ?? []).length && depsOf.get(s.id).every(held)
      && !(s._blockers ?? []).some((b) => b.kind === 'production_order'));
    if (w) { r1 = cand; break; }
  }
  const r2 = ready.find((s) => s !== r1 && Number(s.quantity) >= 1);
  if (!r1 || !w || !r2) throw new Error('The fixture needs two ready steps and one that waits only on one of them.');
  ok('download: a step by its piece code and operation code, its state and whether it is ready', rowOf(r1)?.['Ready?'] === 'Yes' && /^No/.test(String(rowOf(w)?.['Ready?'])) && Number(rowOf(r1)?.Quantity) === Number(r1.quantity));
  const same3 = await TS.importFloorSheet(c, line.order_id, { fileBase64: b64(out3), dryRun: true }, opts);
  ok('round trip: the download uploaded as it is records nothing', same3.ok && same3.changes.length === 0 && same3.summary.rowsToRecord === 0, same3.summary.sentence);

  // The prepared file, the waiting step FIRST: it goes after r1 in a later round.
  // Now as an IST wall clock, to the second (the release was made a moment ago; a floor time cannot be before it).
  const atMs = Math.floor(Date.now() / 1000) * 1000;
  const ist = new Date(atMs + 330 * 60000).toISOString();
  const atText = `${ist.slice(0, 10)} ${ist.slice(11, 19)}`;
  const half = Number(r2.quantity) > 1 ? Math.floor(Number(r2.quantity) / 2) : null;
  const file3 = await prepared(['Operation code', 'Piece code', 'Done (Yes/No)', 'Good to add', 'Scrap to add', 'Finished at'], [
    [w.op_code, code(w), 'Yes', '', '', ''],
    [r1.op_code.toLowerCase(), code(r1), 'yes', '', '', atText],
    [r2.op_code, code(r2), half ? 'No' : 'Yes', half ?? '', 1, ''],
  ]);
  const dry3 = await TS.importFloorSheet(c, line.order_id, { fileBase64: file3, dryRun: true, tz: 330 }, opts);
  ok('dry run: three steps to record, which are ready now and which wait', dry3.ok && dry3.summary.rowsToRecord === 3 && dry3.summary.readyNow === 2
    && dry3.changes.some((x) => x.stepId === w.id && /waits/.test(x.detail)), JSON.stringify(dry3.summary) + JSON.stringify(dry3.problems));
  ({ byId } = await ev());
  ok('dry run: writes nothing', [r1, r2, w].every((s) => byId.get(s.id).state === 'pending' && Number(byId.get(s.id).qty_good) === 0));
  const run3 = await TS.importFloorSheet(c, line.order_id, { fileBase64: file3, tz: 330 }, opts);
  ({ d, byId } = await ev());
  const waveOf = new Map(run3.done.map((x) => [x.stepId, x.wave]));
  ok('applied: matched by piece code + operation code, all three recorded', run3.done.length === 3 && run3.refused.length === 0, JSON.stringify(run3.refused));
  ok('applied: Done = Yes with no quantity finishes with what is left good', byId.get(r1.id).state === 'done' && Number(byId.get(r1.id).qty_good) === Number(r1.quantity));
  ok('applied: the waiting row went after the row it waits on, in a later round', waveOf.get(w.id) > waveOf.get(r1.id) && byId.get(w.id).state === 'done');
  ok('applied: good and scrap as the row says', half
    ? byId.get(r2.id).state === 'in_progress' && Number(byId.get(r2.id).qty_good) === half && Number(byId.get(r2.id).qty_scrap) === 1
    : byId.get(r2.id).state === 'done' && Number(byId.get(r2.id).qty_scrap) === 1);
  const [[fin]] = await conn.query('SELECT UNIX_TIMESTAMP(finished_at) AS t FROM cf_production_steps WHERE id = ?', [r1.id]);
  ok(`applied: Finished at read in the uploader's zone (${atText} IST)`, Number(fin.t) === atMs / 1000, `${fin.t} vs ${atMs / 1000}`);
  const [evs] = await conn.query("SELECT step_id, event FROM cf_step_events WHERE company_id = ? AND step_id IN (?) AND note = 'From the floor progress sheet'", [COMPANY, [r1.id, w.id]]);
  ok('applied: through the tracker\'s own start and progress (their events)', [r1.id, w.id].every((id) => evs.some((e) => e.step_id === id && e.event === 'start') && evs.some((e) => e.step_id === id && e.event === 'progress')));
  const doneFile = await prepared(['Piece code', 'Operation code', 'Done'], [[code(r1), r1.op_code, 'Yes']]);
  const again3 = await TS.importFloorSheet(c, line.order_id, { fileBase64: doneFile }, opts);
  ok('a step already done is refused, with why', again3.done.length === 0 && again3.refused.length === 1 && again3.refused[0].reason === 'It is already done.');

  // Refusals in the file: every problem at once, nothing recorded.
  const [ready2, ready3] = d.steps.filter((s) => s._status === 'ready' && s.state === 'pending' && unique(s));
  const bad3 = await prepared(['Piece code', 'Operation code', 'Good to add', 'Scrap to add', 'Done (Yes/No)', 'Finished at'], [
    [`${RUN}-NOPIECE`, ready2.op_code, 1, '', '', ''],
    [code(ready2), ready2.op_code, Number(ready2.quantity) + 5, '', '', ''],
    [code(ready2), ready2.op_code, '', '', 'Maybe', ''],
    [code(ready3), ready3.op_code, '', '', 'Yes', '2099-01-01 10:00'],
    [code(ready2), ready2.op_code, '', '', 'Yes', ''],
  ]);
  const dryBad3 = await TS.importFloorSheet(c, line.order_id, { fileBase64: bad3, dryRun: true }, opts);
  const p3 = dryBad3.problems.join(' | ');
  ok('refused: an unknown piece, too many good, a bad Done, a time in the future, a repeated step — all at once',
    !dryBad3.ok && /NOPIECE/.test(p3) && /more good/.test(p3) && /Maybe/.test(p3) && /future/.test(p3) && /twice/.test(p3), p3);
  const applyBad3 = await refusal(() => TS.importFloorSheet(c, line.order_id, { fileBase64: bad3 }, opts));
  ({ byId } = await ev());
  ok('refused on apply: 422, nothing recorded', applyBad3?.status === 422 && byId.get(ready2.id).state === 'pending');

  await conn.rollback();
  const after = await census(conn);
  const changed = Object.keys(before).filter((t) => before[t] !== after[t]);
  ok('every cf_ table is back where it started', changed.length === 0, changed.map((t) => `${t} ${before[t]}→${after[t]}`).join(', '));
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
