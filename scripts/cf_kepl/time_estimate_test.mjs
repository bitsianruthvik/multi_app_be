/**
 * time_estimate_test.mjs — operation times per BOM row (services/timeEstimateService.js,
 * init.sql §30): the formula's estimate on the machine TYPE's chart, the slowest
 * machine where only single machines carry values, typed overrides, refusals,
 * totals and round trips. Against the local database.
 *
 *   cd multi_app_be && node scripts/cf_kepl/time_estimate_test.mjs
 *   CF_TIME_COMPANY=2 CF_TIME_ORDER=887 CF_TIME_LINE=923 (the defaults: the local KEPL copy)
 *
 * EVERYTHING HAPPENS INSIDE ONE TRANSACTION THAT IS ROLLED BACK, and the last
 * thing it does is re-count every cf_ table.
 *
 * Part 1 OWNS ITS FIXTURE (every name tagged with this run's id): a machine
 * family with two machine types — V1 carries the rate on the TYPE, V2 only on
 * its two machines — a number spec, a chart spec, operations and rules.
 * Part 2 reads the KEPL line (company 2, order 887, line 923) and, inside the
 * transaction, gives two of its operation rules a time so there is something
 * to see (every local rule is empty: "sets no work time yet").
 */
import { pool } from '../../db.js';
import '../../apps/cf_erp/services/codegenProvider.js';
import { attachNodeCache, detachNodeCache } from '../../apps/cf_erp/lib/db.js';
import { loadMachineSide, getLineTimes, setLineTimes, RELEASED_WHY } from '../../apps/cf_erp/services/timeEstimateService.js';
import { timingPreview, valueReaders } from '../../apps/cf_erp/services/operationService.js';
import { resolveLineRecords } from '../../apps/cf_erp/services/orderValuesService.js';
import { effectiveByCode } from '../../apps/cf_erp/services/resolutionService.js';

if (!/^(localhost|127\.0\.0\.1|::1)$/.test(process.env.DB_HOST ?? 'localhost')) throw new Error('This suite is local only.');
const COMPANY = Number(process.env.CF_TIME_COMPANY ?? 2);
const ORDER = Number(process.env.CF_TIME_ORDER ?? 887);
const LINE = Number(process.env.CF_TIME_LINE ?? 923);
const tag = `TE${Date.now().toString(36).toUpperCase()}`;

let passed = 0;
let failed = 0;
function ok(label, condition, detail = '') {
  if (typeof label !== 'string' || typeof condition !== 'boolean') throw new Error('ok(label, condition) takes a string and then a boolean');
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${!condition && detail ? ` — ${detail}` : ''}`);
  condition ? passed++ : failed++;
}
const near = (a, b) => a != null && b != null && Math.abs(Number(a) - Number(b)) < 1e-6;
const section = (s) => console.log(`\n${s}`);
async function refusal(fn) {
  try { await fn(); return null; } catch (e) { return e; }
}

const [tables] = await pool.query("SELECT TABLE_NAME name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME LIKE 'cf\\_%' ORDER BY TABLE_NAME");
const counts = async () => (await pool.query(tables.map((t) => `SELECT '${t.name}' AS name,COUNT(*) AS n FROM \`${t.name}\``).join(' UNION ALL ')))[0];
const before = await counts();
const conn = await pool.getConnection();
let n = 0;
const db = new Proxy(conn, { get: (t, p) => (p === 'query' ? (...a) => { n++; return t.query(...a); } : Reflect.get(t, p)) });
const measured = async (fn) => { const at = n; const result = await fn(); return { result, queries: n - at }; };
const report = {};

try {
  await conn.beginTransaction();
  attachNodeCache(conn);
  const c = { companyId: COMPANY, userId: null };
  const insert = async (table, body) => { const [r] = await conn.query(`INSERT INTO ${table} SET ?`, body); return r.insertId; };

  /* ------------------------------------------------------------------------
   * Part 1 — which machine an estimate reads (owned fixture)
   * --------------------------------------------------------------------- */
  section('Part 1 — machine choice, formulas, missing inputs');
  const node = (suffix, parent_id = null, depth = 0) => insert('cf_classification_nodes', {
    company_id: COMPANY, code: `${tag}-${suffix}`, name: `${tag} ${suffix}`, scope: 'machine', parent_id, depth,
  });
  const fam = await node('F');
  const v1 = await node('V1', fam, 1);
  const v2 = await node('V2', fam, 1);
  const machine = (suffix, classification_id) => insert('cf_machines', { company_id: COMPANY, code: `${tag}-${suffix}`, name: `${tag} ${suffix}`, classification_id });
  const m1 = await machine('M1', v1);
  const m2a = await machine('M2A', v2);
  const m2b = await machine('M2B', v2);
  const spec = (code, data_type = 'number', extra = {}) => insert('cf_specifications', { company_id: COMPANY, code: `${tag}_${code}`, name: `${tag} ${code}`, data_type, ...extra });
  const speed = await spec('SPEED');
  const chart = await spec('CHART', 'table', { table_config: JSON.stringify({ mode: 'step_up', axes: [{ label: 'Thickness', unit: 'mm' }] }) });
  const SPEED = `${tag}_SPEED`;
  const CHART = `${tag}_CHART`;
  await insert('cf_spec_assignments', { company_id: COMPANY, specification_id: speed, subject_type: 'classification', subject_id: fam, value_rule: 'defaulted' });
  await insert('cf_spec_assignments', { company_id: COMPANY, specification_id: chart, subject_type: 'classification', subject_id: fam, value_rule: 'defaulted' });
  const value = (specification_id, subject_type, subject_id, extra) => insert('cf_spec_values', { company_id: COMPANY, specification_id, subject_type, subject_id, ...extra });
  await value(speed, 'classification', v1, { value_number: 100, source: 'defaulted' });   // V1: the TYPE's rate
  await value(speed, 'machine', m2a, { value_number: 50 });                               // V2: only its machines
  await value(speed, 'machine', m2b, { value_number: 25 });
  await value(chart, 'classification', v1, { value_json: JSON.stringify({ x: [10, 20], v: [2, 4] }) });
  const formula = (code, expression) => insert('cf_formulas', { company_id: COMPANY, code: `${tag}-${code}`, name: `${tag} ${code}`, expression });
  const fSpeed = await formula('SPEED', `1000 / machine.${SPEED}`);
  const fLen = await formula('LEN', `item.${tag}_LEN / machine.${SPEED}`);
  const fChart = await formula('CHART', `LOOKUP(machine.${CHART}, item.${tag}_THK) * 3`);
  const op = (suffix) => insert('cf_operations', { company_id: COMPANY, code: `${tag}-${suffix}`, name: `${tag} ${suffix}` });
  const opA = await op('A');
  const opB = await op('B');
  const opC = await op('C');
  const opEmpty = await op('EMPTY');
  const opNone = await op('NONE');
  const rule = (operation_id, subject_id, extra) => insert('cf_operation_machine_rules', { company_id: COMPANY, operation_id, subject_type: 'classification', subject_id, ...extra });
  await rule(opA, fam, { setup_minutes: 3, work_formula_id: fSpeed });
  await rule(opB, fam, { work_formula_id: fLen });
  await rule(opC, fam, { work_formula_id: fChart });
  await rule(opEmpty, fam, {});
  const opsMap = new Map([[opA, { id: opA, code: `${tag}-A` }], [opB, { id: opB, code: `${tag}-B` }], [opC, { id: opC, code: `${tag}-C` }],
    [opEmpty, { id: opEmpty, code: `${tag}-EMPTY` }], [opNone, { id: opNone, code: `${tag}-NONE` }]]);
  const item = (vals) => valueReaders(new Map(Object.entries(vals).map(([k, v]) => [`${tag}_${k}`, { raw: v, dataType: 'number', tableConfig: null }])));

  let side = await measured(() => loadMachineSide(db, COMPANY, opsMap, '2026-09-29'));
  ok('machine side loads in five reads (rules, machines, tree, spec rules, values)', side.queries === 5, `${side.queries}`);
  let e = side.result.estimate(opA, null);
  // V1 type: 1000/100 = 10. V2 has no type rate, so its machines: 20 and 40. Slowest wins.
  ok('only single machines carry V2\'s rate: the slowest machine is taken (40 min)', near(e.work, 40) && e.machineInfo?.basis === 'machine' && e.machineInfo?.id === m2b, JSON.stringify(e));
  ok('setup comes from the rule (3 min per run)', near(e.setup, 3));
  ok('the cell names the machine it read', typeof e.machine === 'string' && e.machine.includes(`${tag}-M2B`) && e.machine.includes('slowest'), e.machine);
  const preview = await timingPreview(conn, COMPANY, opA, { machineId: m2b, date: '2026-09-29' });
  ok('the bulk estimate equals timingPreview for that machine', near(preview.workMinutesPerPiece, e.work) && near(preview.setupMinutes, e.setup), JSON.stringify({ w: preview.workMinutesPerPiece, s: preview.setupMinutes }));
  const previewM1 = await timingPreview(conn, COMPANY, opA, { machineId: m1, date: '2026-09-29' });
  ok('a V1 machine reads its type\'s rate through timingPreview too (10 min)', near(previewM1.workMinutesPerPiece, 10));

  // Give V2 a TYPE rate: the type's chart now wins over its single machines.
  await value(speed, 'classification', v2, { value_number: 30, source: 'defaulted' });
  side = await measured(() => loadMachineSide(db, COMPANY, opsMap, '2026-09-29'));
  e = side.result.estimate(opA, null);
  ok('with a type rate, the TYPE is used (1000/30), not its slower single machine', near(e.work, 33.333) && e.machineInfo?.basis === 'type' && e.machineInfo?.id === v2, JSON.stringify(e));
  ok('the type\'s tooltip says machine type', e.machine.includes('machine type'));

  e = side.result.estimate(opB, null);
  ok('a missing item input is named, never guessed', e.work == null && /item · .*_LEN/.test(e.missing ?? ''), e.missing);
  e = side.result.estimate(opB, item({ LEN: 600 }));
  ok('item.LEN / machine.SPEED: the slowest type (600/30 = 20)', near(e.work, 20), JSON.stringify(e));
  e = side.result.estimate(opC, item({ THK: 15 }));
  ok('LOOKUP on the type\'s chart, step up (15 mm reads the 20 mm row: 4 × 3 = 12)', near(e.work, 12) && e.machineInfo?.id === v1, JSON.stringify(e));
  e = side.result.estimate(opC, item({ THK: 25 }));
  ok('outside the chart: missing, with the chart\'s own reason', e.work == null && /above the chart/.test(e.missing ?? ''), e.missing);
  e = side.result.estimate(opEmpty, null);
  ok('a rule with no time: "sets no work time yet"', e.work == null && /sets no work time/.test(e.missing ?? ''), e.missing);
  e = side.result.estimate(opNone, null);
  ok('no rule at all: "no machine rule"', e.work == null && /no machine rule/.test(e.missing ?? ''), e.missing);
  // A machine rule that takes V2 out leaves only V1.
  await insert('cf_operation_machine_rules', { company_id: COMPANY, operation_id: opA, subject_type: 'classification', subject_id: v2, eligible: 0 });
  e = (await loadMachineSide(conn, COMPANY, opsMap, '2026-09-29')).estimate(opA, null);
  ok('an ineligible type is never chosen', near(e.work, 10) && e.machineInfo?.id === v1, JSON.stringify(e));

  /* ------------------------------------------------------------------------
   * Part 2 — the KEPL line
   * --------------------------------------------------------------------- */
  section(`Part 2 — the grid on line ${LINE} (company ${COMPANY})`);
  let g = await measured(() => getLineTimes(db, COMPANY, ORDER, LINE));
  report.getQueries = g.queries;
  report.rows = g.result.rows.length;
  report.operations = g.result.operations.length;
  ok(`GET reads the whole line in a fixed number of round trips (${g.queries}, ${g.result.rows.length} rows)`, g.queries <= 35, `${g.queries}`);
  let view = g.result;
  ok('the line is editable before release', view.line.editable === true && view.line.released === false);
  ok('the root row has no bom line', view.rows[0].bomLineId === null && view.rows[0].parentKey === null);
  ok('a row of the order has no code', view.rows.filter((r) => r.bomLineId != null).every((r) => r.code === null || typeof r.code === 'string'));
  ok('every row carries its item id; the root row is the line item', view.rows.every((r) => Number.isInteger(r.itemId) && r.itemId > 0));
  const sameItem = new Map();
  for (const r of view.rows) sameItem.set(r.itemId, (sameItem.get(r.itemId) ?? 0) + 1);
  report.repeatedItems = [...sameItem.values()].filter((n) => n > 1).length;
  const opIds = new Set(view.operations.map((o) => o.id));
  ok('every cell key is an operation column', view.rows.every((r) => Object.keys(r.cells).every((k) => opIds.has(Number(k)))));
  ok('no number is invented where the input is missing', view.rows.every((r) => Object.values(r.cells).every((cl) => (cl.work == null) === (cl.missing != null))));

  const wrong = await refusal(() => getLineTimes(conn, COMPANY, ORDER + 100000, LINE));
  ok('a line addressed through the wrong order is refused', wrong?.code === 'WRONG_ORDER', wrong?.message);

  // Give two operations a time on this line's own rules (inside the transaction).
  const opByCode = new Map(view.operations.map((o) => [o.code, o]));
  const crn = opByCode.get('CRNMV');
  const edge = opByCode.get('EDGEP');
  ok('the line runs CRNMV and EDGEP', !!crn && !!edge);
  await conn.query('UPDATE cf_operation_machine_rules SET work_minutes = 5, setup_minutes = 2 WHERE company_id = ? AND operation_id = ? AND deleted_at IS NULL', [COMPANY, crn.id]);
  // FQC stays without a number (local rules may carry placeholder times since 2026-09-30).
  const fqc = opByCode.get('FQC');
  if (fqc) await conn.query('UPDATE cf_operation_machine_rules SET work_minutes = NULL, setup_minutes = NULL, work_formula_id = NULL WHERE company_id = ? AND operation_id = ? AND deleted_at IS NULL', [COMPANY, fqc.id]);
  // EDGEP: a formula over an item value the plate parts really carry.
  const resolutions = await resolveLineRecords(conn, COMPANY, LINE);
  const edgeRows = view.rows.filter((r) => r.cells[edge.id]);
  const itemOfRow = new Map();
  {
    const [rows] = await conn.query('SELECT id, child_id FROM cf_bom_lines WHERE company_id = ? AND id IN (?)', [COMPANY, edgeRows.map((r) => r.bomLineId ?? 0)]);
    for (const r of rows) itemOfRow.set(r.id, r.child_id);
  }
  const freq = new Map();
  for (const r of edgeRows) {
    const eff = effectiveByCode(resolutions.get(itemOfRow.get(r.bomLineId)) ?? { specs: [] });
    for (const [code, v] of eff) if (v.dataType === 'number' && v.raw != null) freq.set(code, (freq.get(code) ?? 0) + 1);
  }
  const itemCode = [...freq.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  ok('the plate parts carry a number to time from', !!itemCode, JSON.stringify([...freq.entries()].slice(0, 5)));
  const fEdge = await formula('EDGE', `item.${itemCode} / 10 + 1`);
  await conn.query('UPDATE cf_operation_machine_rules SET work_formula_id = ?, work_minutes = NULL WHERE company_id = ? AND operation_id = ? AND deleted_at IS NULL', [fEdge, COMPANY, edge.id]);

  g = await measured(() => getLineTimes(db, COMPANY, ORDER, LINE));
  view = g.result;
  const crnCells = view.rows.map((r) => r.cells[crn.id]).filter(Boolean);
  ok(`CRNMV: every row reads 5 work + 2 setup (${crnCells.length} cells)`, crnCells.length > 0 && crnCells.every((cl) => near(cl.work, 5) && near(cl.setup, 2) && !cl.overridden));
  ok('CRNMV names a machine type', crnCells.every((cl) => cl.machineInfo?.basis === 'type' && /machine type/.test(cl.machine)), JSON.stringify(crnCells[0]));
  ok('a flow running CRNMV five times says so (passes)', crnCells.some((cl) => cl.passes > 1));
  let formulaChecked = 0;
  let formulaWrong = 0;
  let missingNamed = 0;
  for (const r of view.rows) {
    const cl = r.cells[edge.id];
    if (!cl) continue;
    const eff = effectiveByCode(resolutions.get(itemOfRow.get(r.bomLineId)) ?? { specs: [] });
    const raw = eff.get(itemCode)?.raw;
    if (raw != null) { formulaChecked++; if (!near(cl.formulaWork, Number((raw / 10 + 1).toFixed(3)))) formulaWrong++; } else if (cl.work == null && cl.missing?.includes(itemCode)) missingNamed++;
  }
  ok(`EDGEP = item.${itemCode} / 10 + 1 on every plate part that has it (${formulaChecked} cells)`, formulaChecked > 0 && formulaWrong === 0, `${formulaWrong} wrong`);
  ok('EDGEP rows without the value say which input is missing', formulaChecked + missingNamed === edgeRows.length, `${formulaChecked}+${missingNamed} of ${edgeRows.length}`);
  // Totals are Σ (setup + work × total quantity) × passes over the rows.
  let all = 0;
  const byOp = {};
  for (const r of view.rows) {
    for (const [k, cl] of Object.entries(r.cells)) {
      if (cl.work == null) continue;
      const m = ((cl.setup ?? 0) + cl.work * r.totalQty) * cl.passes;
      byOp[k] = (byOp[k] ?? 0) + m;
      all += m;
    }
  }
  ok('totals.all = Σ (setup + work × total qty) × passes', Math.abs(view.totals.all - all) < 0.01, `${view.totals.all} vs ${all}`);
  ok('totals.byOperation per column', Object.entries(byOp).every(([k, v]) => Math.abs(view.totals.byOperation[k] - v) < 0.01));
  ok('a column with no number has no total', view.totals.byOperation[opByCode.get('FQC')?.id] === undefined);

  section('Overrides');
  const target = view.rows.find((r) => r.bomLineId != null && r.cells[crn.id]);
  const rootRow = view.rows[0];
  const rootOp = Number(Object.keys(rootRow.cells)[0]);
  let p = await measured(() => setLineTimes(db, c, ORDER, LINE, { cells: [
    { bomLineId: target.bomLineId, operationId: crn.id, work: 9, note: 'contractor quoted' },
    { bomLineId: null, operationId: rootOp, work: 12.5 },
  ] }));
  report.putQueries = p.queries;
  ok(`PUT sets overrides in a fixed number of round trips (${p.queries})`, p.queries <= 40, `${p.queries}`);
  let cell = p.result.rows.find((r) => r.key === target.key).cells[crn.id];
  ok('a typed work time is shown, marked overridden, formula kept beside it', near(cell.work, 9) && cell.overridden && near(cell.formulaWork, 5) && cell.note === 'contractor quoted');
  ok('the setup stays the formula\'s', near(cell.setup, 2) && !cell.setupOverridden);
  ok('the line\'s own item (bomLineId null) takes an override', near(p.result.rows[0].cells[rootOp].work, 12.5) && p.result.rows[0].cells[rootOp].overridden && p.result.rows[0].cells[rootOp].missing === null);
  const again = await getLineTimes(conn, COMPANY, ORDER, LINE);
  ok('what PUT returned is what GET reads back', JSON.stringify(again) === JSON.stringify(p.result));
  ok('an override moves the totals', again.totals.all > view.totals.all);
  p = await measured(() => setLineTimes(db, c, ORDER, LINE, { cells: [{ bomLineId: target.bomLineId, operationId: crn.id, setup: 1 }] }));
  cell = p.result.rows.find((r) => r.key === target.key).cells[crn.id];
  ok('setup can be typed over too (Show setup)', near(cell.setup, 1) && cell.setupOverridden && near(cell.work, 9));
  p = await measured(() => setLineTimes(db, c, ORDER, LINE, { cells: [{ bomLineId: target.bomLineId, operationId: crn.id, work: null }] }));
  cell = p.result.rows.find((r) => r.key === target.key).cells[crn.id];
  ok('null clears the work override: the formula comes back, setup override stays', near(cell.work, 5) && !cell.overridden && near(cell.setup, 1) && cell.setupOverridden);
  await setLineTimes(conn, c, ORDER, LINE, { cells: [{ bomLineId: target.bomLineId, operationId: crn.id, setup: '' }] });
  const [[{ live }]] = await conn.query('SELECT COUNT(*) AS live FROM cf_time_overrides WHERE company_id = ? AND order_line_id = ? AND bom_line_id = ? AND deleted_at IS NULL', [COMPANY, LINE, target.bomLineId]);
  ok('clearing both retires the override row', Number(live) === 0);

  // Many cells in ONE call (the grid's "apply to the other rows") cost no more round trips.
  const many = view.rows.filter((r) => r.cells[crn.id]).map((r) => ({ bomLineId: r.bomLineId, operationId: crn.id, work: 4 }));
  p = await measured(() => setLineTimes(db, c, ORDER, LINE, { cells: many }));
  ok(`PUT of ${many.length} cells stays in the same round trips (${p.queries})`, p.queries <= 40, `${p.queries}`);
  ok('every one of those cells took the value', p.result.rows.filter((r) => r.cells[crn.id]).every((r) => near(r.cells[crn.id].work, 4) && r.cells[crn.id].overridden));
  p = await measured(() => setLineTimes(db, c, ORDER, LINE, { cells: many.map((m) => ({ ...m, work: null })) }));
  ok(`clearing ${many.length} cells in one call stays in the same round trips (${p.queries})`, p.queries <= 40, `${p.queries}`);
  ok('all of them back to the formula', p.result.rows.filter((r) => r.cells[crn.id]).every((r) => !r.cells[crn.id].overridden));

  section('Refusals');
  const [[{ liveBefore }]] = await conn.query('SELECT COUNT(*) AS liveBefore FROM cf_time_overrides WHERE company_id = ? AND order_line_id = ? AND deleted_at IS NULL', [COMPANY, LINE]);
  const notInFlow = view.operations.find((o) => !target.cells[o.id]);
  let err = await refusal(() => setLineTimes(conn, c, ORDER, LINE, { cells: [
    { bomLineId: target.bomLineId, operationId: crn.id, work: 7 },
    { bomLineId: target.bomLineId, operationId: notInFlow.id, work: 3 },
  ] }));
  ok('an operation not in the row\'s flow is refused (422)', err?.status === 422 && (err.problems ?? []).some((x) => /not in its flow/.test(x)), err?.message);
  err = await refusal(() => setLineTimes(conn, c, ORDER, LINE, { cells: [{ bomLineId: target.bomLineId, operationId: crn.id, work: -1 }] }));
  ok('a negative time is refused (422)', err?.status === 422 && (err.problems ?? []).some((x) => /negative/.test(x)), err?.message);
  err = await refusal(() => setLineTimes(conn, c, ORDER, LINE, { cells: [{ bomLineId: 999999999, operationId: crn.id, work: 1 }] }));
  ok('a row of another line is refused', err?.status === 422, err?.message);
  const [[{ liveAfter }]] = await conn.query('SELECT COUNT(*) AS liveAfter FROM cf_time_overrides WHERE company_id = ? AND order_line_id = ? AND deleted_at IS NULL', [COMPANY, LINE]);
  ok('a refused save writes nothing — not even its good cells', Number(liveAfter) === Number(liveBefore));

  // Released: times are on the production steps now.
  const [[line]] = await conn.query('SELECT order_id, item_id, quantity FROM cf_sales_order_lines WHERE id = ?', [LINE]);
  await insert('cf_production_releases', { company_id: COMPANY, order_id: line.order_id, order_line_id: LINE, item_id: line.item_id, quantity: line.quantity });
  const rel = await getLineTimes(conn, COMPANY, ORDER, LINE);
  ok('a released line is read-only, with one line of why', rel.line.released === true && rel.line.editable === false && rel.line.why === RELEASED_WHY);
  err = await refusal(() => setLineTimes(conn, c, ORDER, LINE, { cells: [{ bomLineId: target.bomLineId, operationId: crn.id, work: 4 }] }));
  ok('a released line refuses a time (422, "fixed at release")', err?.status === 422 && err.code === 'RELEASED' && /fixed at release/.test(err.message), err?.message);
} catch (e) {
  failed++;
  console.error('FAIL', e.stack, e.problems ?? '');
} finally {
  await conn.rollback();
  detachNodeCache(conn);
  conn.release();
}
ok('every CF table count restored', JSON.stringify(before) === JSON.stringify(await counts()));
await pool.end();
console.log(`\nround trips: GET ${report.getQueries} (${report.rows} rows × ${report.operations} operations), PUT ${report.putQueries}`);
console.log(`${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
