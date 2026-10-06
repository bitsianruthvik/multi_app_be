/**
 * planner_test.mjs — the Planner's backend (services/plannerService.js,
 * routes/planner.js, init.sql §31; contract TM/CF_ERP_PLANNER_PLAN.md §2).
 * Against the local database.
 *
 *   cd multi_app_be && node scripts/cf_kepl/planner_test.mjs
 *   CF_PLAN_COMPANY=2 CF_PLAN_ORDER=887 CF_PLAN_LINE=923 (the defaults: the local KEPL copy)
 *
 * EVERYTHING HAPPENS INSIDE ONE TRANSACTION THAT IS ROLLED BACK — the lock, the
 * SHIP_UNIT mark, the times, the shifts, the stock and purchase lines, the
 * contractor — and the last thing it does is re-count every cf_ table.
 *
 *   1. before lock: one unit, the whole line; a level below it is refused
 *   2. inside the transaction: every timing rule of the company gets a time, one
 *      row gets a typed override, line 923 is locked, the Girder segment
 *      definition says SHIP_UNIT = yes, two machines get shifts (one a day off,
 *      one extra time), a plate gets free stock and two open purchase lines (and
 *      a draft suggestion that must NOT count), one segment's cell goes to a
 *      contractor
 *   3. GET: units at every level, marks and groups, tonnes that add up, work
 *      that adds up to the Times tab's total at every level, capacity equal to
 *      machineCalendar, supply by date, round trips (not growing with pieces)
 *   4. writes round-trip: entries, priorities, line level, targets, settings,
 *      and what each refuses
 *   4b. (2026-10-01) machine-type paths for the machine areas, unit ranks and
 *      PUT /planner/changes (moves + a line's unit order in one transaction)
 */
import { pool } from '../../db.js';
import '../../apps/cf_erp/services/codegenProvider.js';
import { attachNodeCache, detachNodeCache } from '../../apps/cf_erp/lib/db.js';
import { lockLine } from '../../apps/cf_erp/services/lockService.js';
import { getLineTimes } from '../../apps/cf_erp/services/timeEstimateService.js';
import { setValues } from '../../apps/cf_erp/services/valueService.js';
import { createShift, createException, machineCalendar, machinesCalendar } from '../../apps/cf_erp/services/shiftService.js';
import { createArea } from '../../apps/cf_erp/services/stockingAreaService.js';
import { postMovement } from '../../apps/cf_erp/services/stockService.js';
import { getAssignment, assignCells } from '../../apps/cf_erp/services/workOrderService.js';
import { productionMachineIds } from '../../apps/cf_erp/services/operationService.js';
import {
  getPlanner, horizonOf, putEntries, putChanges, putPriorities, putLineLevel, putTargets, putSettings, putLineSplit, CONTRACTOR,
} from '../../apps/cf_erp/services/plannerService.js';

if (!/^(localhost|127\.0\.0\.1|::1)$/.test(process.env.DB_HOST ?? 'localhost')) throw new Error('This suite is local only.');
const COMPANY = Number(process.env.CF_PLAN_COMPANY ?? 2);
const ORDER = Number(process.env.CF_PLAN_ORDER ?? 887);
const LINE = Number(process.env.CF_PLAN_LINE ?? 923);
const tag = `PL${Date.now().toString(36).toUpperCase()}`;

let passed = 0;
let failed = 0;
function ok(label, condition, detail = '') {
  if (typeof label !== 'string' || typeof condition !== 'boolean') throw new Error('ok(label, condition) takes a string and then a boolean');
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${!condition && detail ? ` — ${detail}` : ''}`);
  condition ? passed++ : failed++;
}
const near = (a, b, tol = 1e-3) => a != null && b != null && Math.abs(Number(a) - Number(b)) <= tol;
const section = (s) => console.log(`\n${s}`);
async function refusal(fn) {
  try { await fn(); return null; } catch (e) { return e; }
}
const sumWork = (w) => Object.values(w).reduce((t, v) => t + v, 0);

const [tables] = await pool.query("SELECT TABLE_NAME name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME LIKE 'cf\\_%' ORDER BY TABLE_NAME");
const counts = async () => (await pool.query(tables.map((t) => `SELECT '${t.name}' AS name,COUNT(*) AS n FROM \`${t.name}\``).join(' UNION ALL ')))[0];
const before = await counts();
const conn = await pool.getConnection();
let n = 0;
const db = new Proxy(conn, { get: (t, p) => (p === 'query' ? (...a) => { n++; return t.query(...a); } : Reflect.get(t, p)) });
const measured = async (fn) => { const at = n; const t0 = Date.now(); const result = await fn(); return { result, queries: n - at, ms: Date.now() - t0 }; };
const report = {};

try {
  await conn.beginTransaction();
  attachNodeCache(conn);
  const c = { companyId: COMPANY, userId: null };
  const insert = async (table, body) => { const [r] = await conn.query(`INSERT INTO ${table} SET ?`, body); return r.insertId; };

  /* ------------------------------------------------------------------------ */
  section('0. Periods');
  const hz = horizonOf('2026-09-01');
  ok('the horizon is the month and the next two', hz.from === '2026-09-01' && hz.to === '2026-11-30', `${hz.from} ${hz.to}`);
  ok('every period sits inside one month', hz.periods.every((p) => p.start.slice(0, 7) === p.end.slice(0, 7) && p.month === p.start.slice(0, 7)));
  ok('periods are contiguous and cover the horizon', hz.periods[0].start === hz.from && hz.periods.at(-1).end === hz.to
    && hz.periods.every((p, i) => i === 0 || new Date(`${p.start}T00:00:00`) - new Date(`${hz.periods[i - 1].end}T00:00:00`) === 86400000));
  ok('a period starts on a Monday or the first of a month', hz.periods.every((p) => new Date(`${p.start}T00:00:00`).getDay() === 1 || p.start.endsWith('-01')));
  ok('a week that spans two months is two periods (29 Sep – 5 Oct)', hz.periods.some((p) => p.start === '2026-09-28' && p.end === '2026-09-30')
    && hz.periods.some((p) => p.start === '2026-10-01' && p.end === '2026-10-04'));
  ok(`about 15 periods (${hz.periods.length})`, hz.periods.length >= 13 && hz.periods.length <= 17);
  const badFrom = await refusal(() => getPlanner(conn, COMPANY, { from: '2026-02-30' }));
  ok('a from that is not a date is refused (422)', badFrom?.status === 422);

  /* ------------------------------------------------------------------------ */
  section('1. Before lock');
  // The line may already be locked locally (it is since 2026-09-30): then it is
  // unlocked for this section only — locked_at cleared inside the transaction
  // (the planner reads pieces only of a locked line) and put back after.
  const [[lockState]] = await conn.query('SELECT locked_at FROM cf_sales_order_lines WHERE company_id = ? AND id = ?', [COMPANY, LINE]);
  const wasLocked = !!lockState?.locked_at;
  if (wasLocked) {
    console.log('        (line already locked — unlocked inside the transaction for this section)');
    await conn.query('UPDATE cf_sales_order_lines SET locked_at = NULL WHERE company_id = ? AND id = ?', [COMPANY, LINE]);
  }
  let g = await measured(() => getPlanner(db, COMPANY, {}));
  report.unlockedTrips = g.queries;
  let s = g.result;
  let lineUnits = s.units.filter((u) => u.lineId === LINE);
  const lineOut0 = s.orders.flatMap((o) => o.lines).find((l) => l.id === LINE);
  ok('the KEPL line is on the planner', !!lineOut0);
  ok('an unlocked line is one unit — the whole line', lineUnits.length === 1 && lineUnits[0].key === `l${LINE}` && lineUnits[0].level === 'line');
  ok('its levels are just the whole line', lineOut0?.levels.length === 1 && lineOut0.level === 'line' && lineOut0.locked === false);
  ok(`the line's tonnes are its rolled-up weight (${lineUnits[0]?.tonnes} t)`, near(lineUnits[0]?.tonnes, 669.288, 0.01));
  ok('it lists the material it draws', lineUnits[0]?.materials.length > 0);
  let err = await refusal(() => putLineLevel(conn, c, LINE, { level: '1' }));
  ok('a level below the line is refused on an unlocked line (422 NOT_LOCKED)', err?.status === 422 && err.code === 'NOT_LOCKED', err?.message);

  /* ------------------------------------------------------------------------ */
  section('2. The fixture (inside the transaction)');
  // Every timing rule of the company gets a time (every local rule is empty).
  await conn.query(
    `UPDATE cf_operation_machine_rules SET work_minutes = COALESCE(work_minutes, 3), setup_minutes = COALESCE(setup_minutes, 1)
      WHERE company_id = ? AND deleted_at IS NULL AND work_formula_id IS NULL`, [COMPANY]);
  if (wasLocked) await conn.query('UPDATE cf_sales_order_lines SET locked_at = ? WHERE company_id = ? AND id = ?', [lockState.locked_at, COMPANY, LINE]);
  else await lockLine(conn, c, LINE);
  const [pieces] = await conn.query('SELECT id, parent_id, item_id, bom_line_id, quantity, depth, code FROM cf_order_pieces WHERE company_id = ? AND order_line_id = ? AND deleted_at IS NULL', [COMPANY, LINE]);
  ok(`the line is locked (${pieces.length} pieces)`, pieces.length > 1000);
  // A typed override on one row.
  const timesBefore = await getLineTimes(conn, COMPANY, ORDER, LINE);
  const overRow = timesBefore.rows.find((r) => r.bomLineId && Object.keys(r.cells).length);
  const overOp = Number(Object.keys(overRow.cells)[0]);
  await insert('cf_time_overrides', { company_id: COMPANY, order_line_id: LINE, bom_line_id: overRow.bomLineId, operation_id: overOp, work_minutes: 42.5 });
  // The Girder segment definition ships as one unit.
  const [[segDef]] = await conn.query(
    `SELECT DISTINCT i.source_definition_id AS id FROM cf_order_pieces p JOIN cf_item_details i ON i.master_id = p.item_id
       JOIN cf_master_records m ON m.id = p.item_id
      WHERE p.company_id = ? AND p.order_line_id = ? AND p.deleted_at IS NULL AND m.name = 'Girder segment' LIMIT 1`, [COMPANY, LINE]);
  ok('the Girder segment pieces come from a template definition', !!segDef?.id);
  await setValues(conn, c, 'master', segDef.id, [{ specCode: 'SHIP_UNIT', value: true }]);
  // Shifts: two machines of types the line uses.
  // Plan usage counts production machines only.
  const prodIds = [...await productionMachineIds(conn, COMPANY)];
  const [machines] = await conn.query("SELECT id, classification_id FROM cf_machines WHERE company_id = ? AND status = 'active' AND deleted_at IS NULL AND id IN (?) ORDER BY id", [COMPANY, prodIds]);
  const mA = machines[0];
  const mB = machines.find((m) => m.classification_id === mA.classification_id && m.id !== mA.id) ?? machines[1];
  // Machines may already have shifts locally: inside the transaction, mA and mB
  // start from none, and so does one other machine type (a function without shifts).
  const bare = machines.find((m) => m.classification_id !== mA.classification_id && m.classification_id !== mB.classification_id);
  const bareIds = machines.filter((m) => bare && m.classification_id === bare.classification_id).map((m) => m.id);
  await conn.query('UPDATE cf_machine_shifts SET deleted_at = NOW() WHERE company_id = ? AND machine_id IN (?) AND deleted_at IS NULL', [COMPANY, [mA.id, mB.id, ...bareIds]]);
  await createShift(conn, c, mA.id, { name: `${tag} Day`, weekdays: ['mon', 'tue', 'wed', 'thu', 'fri'], startTime: '08:00', endTime: '17:00', breakMinutes: 60 });
  await createShift(conn, c, mA.id, { name: `${tag} Night`, weekdays: ['mon', 'tue', 'wed'], startTime: '22:00', endTime: '06:00', breakMinutes: 30 });
  await createShift(conn, c, mB.id, { name: `${tag} Day`, weekdays: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat'], startTime: '09:00', endTime: '18:00', breakMinutes: 45 });
  await createException(conn, c, mA.id, { date: '2026-10-02', kind: 'closed', reason: tag });
  await createException(conn, c, mB.id, { date: '2026-10-11', kind: 'extra', startTime: '10:00', endTime: '14:00', reason: tag });
  // Supply: free stock and two open purchase lines for one plate; a draft suggestion that does not count.
  const plate = lineUnits.find((u) => u.key === `l${LINE}`).materials.slice().sort((a, b) => b.qty - a.qty).find((m) => m.qty < 1000);
  const area = await createArea(conn, c, { code: `${tag}-STO`, name: `${tag} storage`, purpose: 'storage' });
  await postMovement(conn, c, { movementType: 'receipt', movementDate: '2026-09-20', toAreaId: area.id, reference: tag, lines: [{ itemId: plate.itemId, quantity: 2 }] });
  const po = async (status, suggested, expected, qty, received = 0) => {
    const id = await insert('cf_purchase_orders', { company_id: COMPANY, code: `${tag}-${status}-${expected}`, status, suggested, expected_date: expected });
    await insert('cf_purchase_order_lines', { company_id: COMPANY, purchase_order_id: id, line_no: 1, item_id: plate.itemId, quantity: qty, qty_received: received, expected_date: expected });
  };
  await po('ordered', 0, '2026-11-14', 3);
  await po('partially_received', 0, '2026-10-20', 5, 2);
  await po('draft', 1, '2026-10-05', 99);
  // A contractor takes one operation of one segment.
  const sub = await insert('cf_parties', { company_id: COMPANY, code: `${tag}-SUB`, name: `${tag} Sub`, is_subcontractor: 1 });
  const assignment = await getAssignment(conn, COMPANY, ORDER, LINE);
  const segPiece = pieces.find((p) => assignment.rows.find((r) => r.pieceId === p.id && r.name === 'Girder segment' && Object.keys(r.cells).length));
  const segRow = assignment.rows.find((r) => r.pieceId === segPiece.id);
  const contractOp = Number(Object.keys(segRow.cells)[0]);
  await assignCells(conn, c, ORDER, LINE, { cells: [{ pieceId: segPiece.id, operationId: contractOp }], contractorId: sub });

  /* ------------------------------------------------------------------------ */
  section('3. GET /planner on the locked line');
  g = await measured(() => getPlanner(db, COMPANY, {}));
  report.lockedTrips = g.queries;
  report.lockedMs = g.ms;
  s = g.result;
  lineUnits = s.units.filter((u) => u.lineId === LINE);
  report.units = lineUnits.length;
  const L = s.orders.flatMap((o) => o.lines).find((l) => l.id === LINE);
  const byKey = new Map(s.units.map((u) => [u.key, u]));
  const lineUnit = byKey.get(`l${LINE}`);
  const at = (lv) => lineUnits.filter((u) => u.levels.includes(lv));
  const children = (u) => lineUnits.filter((x) => x.parentKey === u.key);
  console.log(`        levels: ${L.levels.map((l) => `${l.value}=${l.label}`).join(', ')}; units ${lineUnits.length}; default ${L.defaultLevel}`);
  ok('the line is locked on the planner, with levels down to the marks', L.locked && L.levels.map((l) => l.value).join(',') === 'line,0,1,2', JSON.stringify(L.levels));
  ok('the levels are named by their items', /Bridge span/.test(L.levels[1].label) && /Girder line/.test(L.levels[2].label) && /Girder segment/.test(L.levels[3].label), JSON.stringify(L.levels));
  ok('the default level is the shipping line (girder line)', L.defaultLevel === '1' && L.level === '1');
  ok('every unit key is p<piece>, l<line> or g<parent piece>.<bom line> (a lot)', lineUnits.every((u) => /^([pl]\d+|g\d+\.\d+)$/.test(u.key)));
  const spans = lineUnits.filter((u) => u.level === '0');
  const girderLines = lineUnits.filter((u) => u.name === 'Girder line');
  const segments = lineUnits.filter((u) => u.name === 'Girder segment');
  ok('two spans at level 0', spans.length === 2 && at('0').length === 2);
  ok('8 girder lines and 40 segments are units', girderLines.length === 8 && segments.length === 40, `${girderLines.length} ${segments.length}`);
  ok('nothing under a segment is a unit (units stop at the marks)', !lineUnits.some((u) => u.depth > 2));
  ok('segments are marks', segments.every((u) => u.isMark && u.marks === 1));
  ok('a segment belongs to its girder line (groupKey = its parent)', segments.every((u) => u.groupKey === u.parentKey && byKey.get(u.parentKey)?.name === 'Girder line'));
  ok('a girder line is its own group, and not a mark', girderLines.every((u) => u.groupKey === u.key && !u.isMark));
  ok('a girder line counts the marks under it (its segments, and a splice set with no mark of its own)', girderLines.every((u) => u.marks === children(u).filter((x) => x.isMark).length
    && segments.filter((x) => x.parentKey === u.key).length > 0 && children(u).every((x) => x.isMark && x.groupKey === u.key)));
  const diaphragms = lineUnits.filter((u) => u.depth === 1 && u.name !== 'Girder line');
  ok('a diaphragm (no mark under it) is a mark of its span', diaphragms.length > 0 && diaphragms.every((u) => u.isMark && u.groupKey === u.parentKey && byKey.get(u.parentKey)?.level === '0'));
  // Loose pieces of one design row under one parent are ONE lot.
  const [looseRows] = await conn.query(
    `SELECT p.parent_id, p.bom_line_id, COUNT(*) AS n, SUM(p.quantity) AS q FROM cf_order_pieces p
       JOIN cf_master_records m ON m.id = p.item_id
       JOIN cf_order_pieces par ON par.id = p.parent_id
      WHERE p.company_id = ? AND p.order_line_id = ? AND p.deleted_at IS NULL AND par.depth = 0 AND m.name = 'Intermediate diaphragm'
      GROUP BY p.parent_id, p.bom_line_id`, [COMPANY, LINE]);
  const idia = lineUnits.filter((u) => u.name === 'Intermediate diaphragm');
  const edia = lineUnits.filter((u) => u.name === 'End diaphragm');
  console.log(`        lots: ${[...idia, ...edia].map((u) => `${u.key} "${u.code}" ×${u.quantity} ${u.tonnes} t`).join(', ')}`);
  // PLANNER V2 (user, 2026-10-04): each quantity ships on its own — no lot cards.
  const totalIdia = looseRows.reduce((t, r) => t + Number(r.q), 0);
  ok('the intermediate diaphragms are one unit EACH (no lot card) — 45 per span', idia.length === totalIdia && totalIdia === 90 && idia.every((u) => u.quantity === 1), `${idia.length} units of ${totalIdia}`);
  ok('keyed p<piece> (or p<piece>#n for one row of N), never g…', idia.every((u) => /^p[0-9]+(#[0-9]+)?$/.test(u.key)) && !lineUnits.some((u) => u.key.startsWith('g')), idia.slice(0, 4).map((u) => u.key).join(' '));
  ok('each diaphragm is one mark of its span', idia.every((u) => u.isMark && u.marks === 1 && u.groupKey === u.parentKey && byKey.get(u.parentKey)?.level === '0'));
  ok('the end diaphragms are 6 units per span', edia.length === 12 && edia.every((u) => u.quantity === 1));
  ok('every unit carries its work as stages, deepest level first', lineUnits.every((u) => Array.isArray(u.stages) && u.stages.every((st, i) => i === 0 || st.depth < u.stages[i - 1].depth)));
  ok('a real mark (a segment) is never grouped', segments.every((u) => u.key.startsWith('p') && !u.lot));
  ok('a span counts each piece as one mark', spans.every((u) => u.marks === children(u).reduce((t, x) => t + x.marks, 0)), spans.map((u) => u.marks).join(','));
  ok('a diaphragm weighs something, less than a span', idia.every((u) => u.tonnes > 0 && u.tonnes < 76));
  ok('a span holds marks and is its own group', spans.every((u) => !u.isMark && u.groupKey === u.key && u.marks > 0));
  ok('level 2 shows the segments and the diaphragms whole (a mark is never split)', at('2').some((u) => u.name === 'Girder segment') && diaphragms.every((u) => u.levels.includes('2')) && !at('2').some((u) => u.name === 'Girder line'));
  ok('every level covers the whole line exactly once', ['0', '1', '2'].every((lv) => {
    const shown = new Set(at(lv).map((u) => u.key));
    // no unit shown together with one of its ancestors
    return at(lv).every((u) => { for (let p = byKey.get(u.parentKey); p && p.key !== lineUnit.key; p = byKey.get(p.parentKey)) if (shown.has(p.key)) return false; return true; });
  }));

  // Tonnes.
  ok(`the line's tonnes = Σ its spans (${lineUnit.tonnes} t)`, near(lineUnit.tonnes, spans.reduce((t, u) => t + u.tonnes, 0), 0.01));
  const spanGap = spans.map((u) => Math.abs(u.tonnes - children(u).reduce((t, x) => t + x.tonnes, 0)) / u.tonnes);
  console.log(`        span vs Σ its lines and diaphragms: ${spans.map((u, i) => `${u.tonnes} t (gap ${(spanGap[i] * 100).toFixed(2)}%)`).join(', ')}`);
  ok('a span\'s tonnes = Σ its girder lines and diaphragms (within 2% — studs sit on the span itself)', spanGap.every((x) => x < 0.02));
  ok('a girder line weighs about 40 t and more than its segments', girderLines.every((u) => u.tonnes > 20 && u.tonnes >= children(u).filter((x) => x.isMark).reduce((t, x) => t + x.tonnes, 0) - 0.01));
  ok('every unit has a weight', lineUnits.every((u) => !u.noWeight));
  ok(`levels add up: Σ tonnes at 0, 1 and 2 are within 2% of the line`, ['0', '1', '2'].every((lv) => Math.abs(at(lv).reduce((t, u) => t + u.tonnes, 0) - lineUnit.tonnes) / lineUnit.tonnes < 0.02));

  // Work.
  const times = await getLineTimes(conn, COMPANY, ORDER, LINE);
  report.timesTotal = times.totals.all;
  console.log(`        work: line ${sumWork(lineUnit.work).toFixed(1)} min; Times tab ${times.totals.all} min; ${Object.keys(lineUnit.work).length} functions; noRate ${lineUnit.noRate}`);
  ok('there is work to plan', times.totals.all > 0 && sumWork(lineUnit.work) > 0);
  ok('the line\'s work = the Times tab\'s total (override and contractor included)', near(sumWork(lineUnit.work), times.totals.all, 0.01), `${sumWork(lineUnit.work)} vs ${times.totals.all}`);
  for (const lv of ['0', '1', '2']) {
    const fns = new Set([...at(lv).flatMap((u) => Object.keys(u.work)), ...Object.keys(lineUnit.work)]);
    const bad = [...fns].filter((fn) => !near(at(lv).reduce((t, u) => t + (u.work[fn] ?? 0), 0), lineUnit.work[fn] ?? 0, 0.05));
    ok(`level ${lv}: Σ work per function = the line's, function by function`, bad.length === 0, bad.join(','));
  }
  ok('work is keyed by function (machine type) keys the functions list names', Object.keys(lineUnit.work).every((k) => s.functions.some((f) => f.key === k)));
  const segWithContract = byKey.get(`p${segPiece.id}`);
  ok('the contractor\'s cell loads Contractors, not a machine', (segWithContract?.work[CONTRACTOR] ?? 0) > 0 && (lineUnit.work[CONTRACTOR] ?? 0) === segWithContract.work[CONTRACTOR]);
  ok('Contractors is listed, unlimited', s.functions.some((f) => f.key === CONTRACTOR && f.unlimited === true));
  ok('a unit knows how many operations have no rate (a number)', lineUnits.every((u) => Number.isInteger(u.noRate)));
  ok('nothing is done or begun before release', lineUnits.every((u) => !u.done && u.progress === 0));

  // Materials.
  const matSum = (list, item) => list.reduce((t, u) => t + (u.materials.find((m) => m.itemId === item)?.qty ?? 0), 0);
  const items = lineUnit.materials.map((m) => m.itemId);
  ok('materials at level 0, 1 and 2 add up to the line\'s, item by item', ['0', '1', '2'].every((lv) => items.every((it) => near(matSum(at(lv), it), lineUnit.materials.find((m) => m.itemId === it).qty, 1e-3))));
  ok('every material has supply information', items.every((it) => s.supply[it] && Array.isArray(s.supply[it].lots)));

  // Supply.
  const lots = s.supply[plate.itemId].lots;
  console.log(`        supply of ${s.supply[plate.itemId].code}: ${lots.map((l) => `${l.date} ${l.qty} ${l.source}`).join(' | ')}`);
  ok('free stock comes first, dated today, received', lots[0]?.source === 'stock' && lots[0].received === true && lots[0].date === s.horizon.today && lots[0].qty >= 2);
  ok('then the open purchase lines by date, what is still to come', lots.filter((l) => l.source.startsWith(tag)).map((l) => `${l.date}:${l.qty}`).join(',') === '2026-10-20:3,2026-11-14:3');
  ok('a draft suggestion is not supply', !lots.some((l) => l.source.startsWith(`${tag}-draft`)));
  ok('lots are in date order', lots.every((l, i) => i === 0 || String(lots[i - 1].date) <= String(l.date)));

  // Capacity.
  const fnA = s.functions.find((f) => f.key === String(mA.classification_id));
  const periods = s.horizon.periods;
  const typeMachines = machines.filter((m) => m.classification_id === mA.classification_id);
  const expected = Object.fromEntries(periods.map((p) => [p.key, 0]));
  for (const m of typeMachines) {
    const cal = await machineCalendar(conn, COMPANY, m.id, { from: s.horizon.from, to: s.horizon.to });
    for (const d of cal.days) { const p = periods.find((x) => x.start <= d.date && d.date <= x.end); if (p) expected[p.key] += d.minutes; }
  }
  ok(`capacity of ${fnA?.name} per period = Σ machineCalendar of its ${typeMachines.length} machines`, !!fnA && periods.every((p) => fnA.capacity[p.key] === expected[p.key]), JSON.stringify({ got: fnA?.capacity, expected }));
  ok('a function with shifts is not flagged; one without is', fnA?.noShifts === false && s.functions.some((f) => f.noShifts && !f.unlimited));
  const bulk = await machinesCalendar(conn, COMPANY, { from: '2026-09-28', to: '2026-10-18', machineIds: [mA.id, mB.id] });
  const oneA = await machineCalendar(conn, COMPANY, mA.id, { from: '2026-09-28', to: '2026-10-18' });
  const oneB = await machineCalendar(conn, COMPANY, mB.id, { from: '2026-09-28', to: '2026-10-18' });
  ok('the bulk calendar counts every day as machineCalendar does (two machines, 3 weeks)',
    oneA.days.every((d, i) => bulk.get(mA.id).days[i].minutes === d.minutes) && oneB.days.every((d, i) => bulk.get(mB.id).days[i].minutes === d.minutes)
    && bulk.get(mA.id).minutes === oneA.minutes && bulk.get(mB.id).minutes === oneB.minutes);
  ok('the day off is 0 minutes; the extra Sunday is 240', oneA.days.find((d) => d.date === '2026-10-02').minutes === 0 && oneB.days.find((d) => d.date === '2026-10-11').minutes === 240);

  // Round trips.
  console.log(`        round trips: GET ${report.unlockedTrips} unlocked (1 unit), ${report.lockedTrips} locked (${lineUnits.length} units, ${pieces.length} pieces), ${report.lockedMs} ms`);
  ok(`GET round trips do not grow with pieces (${report.unlockedTrips} → ${report.lockedTrips})`, report.lockedTrips <= report.unlockedTrips + 6 && report.lockedTrips <= 60, `${report.unlockedTrips} ${report.lockedTrips}`);

  /* ------------------------------------------------------------------------ */
  section('4. Writes');
  const gl = girderLines[0];
  const sg = segments[0];
  let w = await measured(() => putEntries(db, c, { entries: [{ unitKey: gl.key, shipDate: '2026-10-12', pinned: true }, { unitKey: sg.key, shipDate: '2026-10-05', pinned: false }] }));
  report.putEntriesTrips = w.queries;
  ok(`PUT entries returns what it changed (${w.queries} round trips)`, w.result.entries[gl.key]?.shipDate === '2026-10-12' && w.result.entries[gl.key].pinned === true && w.result.entries[sg.key]?.pinned === false);
  s = await getPlanner(conn, COMPANY, {});
  ok('GET shows them', s.entries[gl.key]?.shipDate === '2026-10-12' && s.entries[gl.key].pinned === true && s.entries[sg.key]?.shipDate === '2026-10-05');
  w = await measured(() => putEntries(db, c, { entries: [{ unitKey: gl.key, shipDate: '2026-11-02', pinned: false }, { unitKey: sg.key, shipDate: null }] }));
  ok('moving updates the one live row; null unplans', w.result.entries[gl.key]?.shipDate === '2026-11-02' && w.result.entries[sg.key] === null);
  const [[{ live }]] = await conn.query('SELECT COUNT(*) AS live FROM cf_plan_entries WHERE company_id = ? AND unit_key = ? AND deleted_at IS NULL', [COMPANY, gl.key]);
  ok('still one live row for the unit', Number(live) === 1);
  s = await getPlanner(conn, COMPANY, {});
  ok('GET: moved, and the unplanned one is gone', s.entries[gl.key]?.shipDate === '2026-11-02' && !s.entries[sg.key]);
  // Planner v2: a stretched bar keeps its first week.
  w = await measured(() => putEntries(db, c, { entries: [{ unitKey: gl.key, shipDate: '2026-11-02', startDate: '2026-10-12', pinned: true }] }));
  ok('a stretch saves its start week', w.result.entries[gl.key]?.startDate === '2026-10-12' && w.result.entries[gl.key].shipDate === '2026-11-02');
  ok('GET shows the start week', (await getPlanner(conn, COMPANY, {})).entries[gl.key]?.startDate === '2026-10-12');
  err = await refusal(() => putEntries(conn, c, { entries: [{ unitKey: gl.key, shipDate: '2026-11-02', startDate: '2026-11-02' }] }));
  ok('a start on or after the ship date is refused (422)', err?.status === 422);
  w = await measured(() => putEntries(db, c, { entries: [{ unitKey: gl.key, shipDate: '2026-11-02', startDate: null, pinned: true }] }));
  ok('a null start drops the stretch', w.result.entries[gl.key]?.startDate === null);

  // Planner v2: "Plan its parts separately" on a mark row, and back.
  s = await getPlanner(conn, COMPANY, {});
  const mark = s.units.find((u) => u.lineId === LINE && u.splittable && u.isMark);
  ok('a mark with parts below offers the split', !!mark, 'none splittable');
  ok('a girder line (not a mark) does not', !s.units.find((u) => u.key === gl.key)?.splittable);
  if (mark) {
    const kidsBefore = s.units.filter((u) => u.parentKey === mark.key).length;
    w = await measured(() => putLineSplit(db, c, LINE, { bomLineId: mark.bomLineId, split: true }));
    ok(`PUT splits records the row (${w.queries} round trips)`, w.result.split === true && Number(w.result.bomLineId) === Number(mark.bomLineId));
    const s2 = await getPlanner(conn, COMPANY, {});
    const was = s2.units.find((u) => u.key === mark.key);
    const kids = s2.units.filter((u) => u.parentKey === mark.key);
    ok('the split row is no longer a card at any level', was?.split === true && was.levels.length === 0 && !was.isMark, JSON.stringify(was && { split: was.split, levels: was.levels, isMark: was.isMark }));
    ok(`its parts are the marks now (${kids.length}, before ${kidsBefore})`, kids.length > 0 && kids.every((k) => k.isMark && k.levels.length > 0));
    ok('its parts carry work in stages', kids.every((k) => Array.isArray(k.stages)));
    await putLineSplit(conn, c, LINE, { bomLineId: mark.bomLineId, split: true });
    const [[{ cnt }]] = await conn.query('SELECT COUNT(*) cnt FROM cf_plan_splits WHERE company_id = ? AND order_line_id = ? AND bom_line_id = ? AND deleted_at IS NULL', [COMPANY, LINE, mark.bomLineId]);
    ok('splitting twice keeps one row', Number(cnt) === 1);
    await putLineSplit(conn, c, LINE, { bomLineId: mark.bomLineId, split: false });
    const s3 = await getPlanner(conn, COMPANY, {});
    ok('"Plan as one unit again" puts it back', s3.units.find((u) => u.key === mark.key)?.isMark === true && !s3.units.some((u) => u.parentKey === mark.key && u.isMark));
  }
  err = await refusal(() => putLineSplit(conn, c, LINE, { bomLineId: 999999999, split: true }));
  ok('a row not on the line is refused', err?.status === 422 || err?.status === 404, String(err?.status));
  const lotUnit = idia[0];
  w = await measured(() => putEntries(db, c, { entries: [{ unitKey: lotUnit.key, shipDate: '2026-10-19', pinned: true }] }));
  ok(`a lot is planned by its key (${lotUnit.key}, ${w.queries} round trips)`, w.result.entries[lotUnit.key]?.shipDate === '2026-10-19');
  ok('GET shows the lot\'s entry', (await getPlanner(conn, COMPANY, {})).entries[lotUnit.key]?.pinned === true);
  err = await refusal(() => putEntries(conn, c, { entries: [{ unitKey: `g${lotUnit.pieceId}.1`, shipDate: '2026-10-05' }] }));
  ok('a lot key that names no pieces is refused (422)', err?.status === 422);
  await putEntries(conn, c, { entries: [{ unitKey: `l${LINE}`, shipDate: '2026-11-23', pinned: false }] });
  ok('a line unit can be planned too', (await getPlanner(conn, COMPANY, {})).entries[`l${LINE}`]?.shipDate === '2026-11-23');
  err = await refusal(() => putEntries(conn, c, { entries: [{ unitKey: 'x12', shipDate: '2026-10-05' }] }));
  ok('a bad unit key is refused (422)', err?.status === 422);
  err = await refusal(() => putEntries(conn, c, { entries: [{ unitKey: 'p999999999', shipDate: '2026-10-05' }] }));
  ok('a piece that is not here is refused (422), nothing written', err?.status === 422);
  err = await refusal(() => putEntries(conn, c, { entries: [{ unitKey: gl.key, shipDate: '2026-13-01' }] }));
  ok('a bad date is refused', err?.status === 422);
  err = await refusal(() => putEntries(conn, c, { entries: [{ unitKey: gl.key, shipDate: '2026-10-05' }, { unitKey: gl.key, shipDate: null }] }));
  ok('a unit named twice is refused', err?.status === 422);
  const [[other]] = await conn.query('SELECT p.id FROM cf_order_pieces p WHERE p.company_id <> ? AND p.deleted_at IS NULL LIMIT 1', [COMPANY]);
  if (other) {
    err = await refusal(() => putEntries(conn, c, { entries: [{ unitKey: `p${other.id}`, shipDate: '2026-10-05' }] }));
    ok('another company\'s piece is refused', err?.status === 422);
  }

  w = await measured(() => putPriorities(db, c, { orderIds: [ORDER] }));
  ok(`PUT priorities ranks the order (${w.queries} round trips)`, w.result.orders[0]?.id === ORDER && w.result.orders[0].priority === 1);
  s = await getPlanner(conn, COMPANY, {});
  ok('GET shows priority 1 and puts it first', s.orders[0].id === ORDER && s.orders[0].priority === 1);
  await putPriorities(conn, c, { orderIds: [] });
  ok('an empty ranking clears it', (await getPlanner(conn, COMPANY, {})).orders.find((o) => o.id === ORDER).priority === null);
  err = await refusal(() => putPriorities(conn, c, { orderIds: [ORDER, ORDER] }));
  ok('an order twice is refused', err?.status === 422);
  err = await refusal(() => putPriorities(conn, c, { orderIds: [999999999] }));
  ok('an order that is not here is refused', err?.status === 422 && err.code === 'UNKNOWN_ORDER');

  w = await measured(() => putLineLevel(db, c, LINE, { level: '2' }));
  ok(`PUT level stores it (${w.queries} round trips)`, w.result.line.level === '2');
  ok('GET shows it', (await getPlanner(conn, COMPANY, {})).orders.flatMap((o) => o.lines).find((l) => l.id === LINE).level === '2');
  await putLineLevel(conn, c, LINE, { level: 'line' });
  ok('the whole line is a level too', (await getPlanner(conn, COMPANY, {})).orders.flatMap((o) => o.lines).find((l) => l.id === LINE).level === 'line');
  await putLineLevel(conn, c, LINE, { level: null });
  ok('null goes back to the default', (await getPlanner(conn, COMPANY, {})).orders.flatMap((o) => o.lines).find((l) => l.id === LINE).level === '1');
  err = await refusal(() => putLineLevel(conn, c, LINE, { level: '9' }));
  ok('a depth the pieces do not reach is refused', err?.status === 422);
  err = await refusal(() => putLineLevel(conn, c, LINE, { level: 'span' }));
  ok('a word that is not a level is refused', err?.status === 422);
  err = await refusal(() => putLineLevel(conn, c, 999999999, { level: 'line' }));
  ok('a line that is not here is 404', err?.status === 404);

  w = await measured(() => putTargets(db, c, { '2026-10': 450, '2026-11': '500.5' }));
  ok(`PUT targets (${w.queries} round trips)`, w.result.targets['2026-10'] === 450 && w.result.targets['2026-11'] === 500.5);
  s = await getPlanner(conn, COMPANY, {});
  ok('GET shows them by month', s.targets['2026-10'] === 450 && s.targets['2026-11'] === 500.5);
  await putTargets(conn, c, { '2026-10': 460, '2026-11': null });
  s = await getPlanner(conn, COMPANY, {});
  ok('a new number replaces; null clears', s.targets['2026-10'] === 460 && s.targets['2026-11'] === undefined);
  err = await refusal(() => putTargets(conn, c, { '2026-13': 1 }));
  ok('a month that is not a month is refused', err?.status === 422);
  err = await refusal(() => putTargets(conn, c, { '2026-10': -5 }));
  ok('negative tonnes are refused', err?.status === 422);

  ok('settings default to 1 line a month, partial lines allowed', s.settings.minLinesPerMonth === 1 && s.settings.allowPartialLines === true);
  w = await measured(() => putSettings(db, c, { minLinesPerMonth: 2 }));
  ok(`PUT settings (${w.queries} round trips)`, w.result.settings.minLinesPerMonth === 2 && w.result.settings.allowPartialLines === true);
  await putSettings(conn, c, { allowPartialLines: false });
  s = await getPlanner(conn, COMPANY, {});
  ok('GET shows both, the untouched one kept', s.settings.minLinesPerMonth === 2 && s.settings.allowPartialLines === false);
  err = await refusal(() => putSettings(conn, c, { minLinesPerMonth: -1 }));
  ok('a bad number is refused', err?.status === 422);
  err = await refusal(() => putSettings(conn, c, { allowPartialLines: 'maybe' }));
  ok('a bad yes/no is refused', err?.status === 422);


  /* ------------------------------------------------------------------------ */
  section('4b. The rework (2026-10-01): machine-type paths, unit ranks, PUT /planner/changes');
  s = await getPlanner(conn, COMPANY, {});
  const typed = s.functions.filter((f) => !f.unlimited);
  ok('every machine type carries its path, root first, ending at itself', typed.length > 0 && typed.every((f) => Array.isArray(f.path) && f.path.length >= 1
    && String(f.path.at(-1).id) === f.key && f.path.every((n, i) => i === 0 || n.depth > f.path[i - 1].depth)), JSON.stringify(typed.slice(0, 2).map((f) => f.path)));
  const subfamilies = new Set(typed.map((f) => f.path.find((n) => n.depth === 1)?.id).filter((x) => x != null));
  console.log(`        machine areas at the Subfamily level: ${subfamilies.size} (${[...new Set(typed.map((f) => f.path.find((n) => n.depth === 1)?.name))].join(', ')})`);
  ok('the snapshot has ranks (unit key → 1..)', !!s.ranks && typeof s.ranks === 'object' && Object.values(s.ranks).every((n) => Number.isInteger(n) && n > 0));
  const [g1, g2, g3] = girderLines;
  w = await measured(() => putChanges(db, c, {
    entries: [{ unitKey: g1.key, shipDate: '2026-10-19', pinned: true }, { unitKey: g2.key, shipDate: '2026-10-26', pinned: true }],
    ranks: [{ lineId: LINE, unitKeys: [g2.key, g1.key, g3.key] }],
  }));
  report.putChangesTrips = w.queries;
  ok(`PUT changes: entries and the line's order in one call (${w.queries} round trips)`, w.result.entries[g1.key]?.shipDate === '2026-10-19' && w.result.entries[g2.key]?.shipDate === '2026-10-26'
    && JSON.stringify(w.result.ranks[LINE]) === JSON.stringify([g2.key, g1.key, g3.key]), JSON.stringify(w.result));
  ok('PUT changes stays small (≤ 8 round trips)', w.queries <= 8, String(w.queries));
  s = await getPlanner(conn, COMPANY, {});
  ok('GET shows the moves and the ranks (1 = first)', s.entries[g1.key]?.shipDate === '2026-10-19' && s.ranks[g2.key] === 1 && s.ranks[g1.key] === 2 && s.ranks[g3.key] === 3);
  // a move = the same unit to another week; a reorder = the whole order again
  await putChanges(conn, c, { entries: [{ unitKey: g1.key, shipDate: '2026-11-02', pinned: true }], ranks: [{ lineId: LINE, unitKeys: [g3.key, g2.key] }] });
  s = await getPlanner(conn, COMPANY, {});
  ok('moving updates the one live entry; a new order replaces the old (g1 no longer ranked)', s.entries[g1.key]?.shipDate === '2026-11-02' && s.ranks[g3.key] === 1 && s.ranks[g2.key] === 2 && s.ranks[g1.key] === undefined);
  const [[{ liveG1 }]] = await conn.query('SELECT COUNT(*) AS liveG1 FROM cf_plan_entries WHERE company_id = ? AND unit_key = ? AND deleted_at IS NULL', [COMPANY, g1.key]);
  ok('still one live entry row for the moved unit', Number(liveG1) === 1);
  const [[{ rankRows }]] = await conn.query('SELECT COUNT(*) AS rankRows FROM cf_plan_ranks WHERE company_id = ? AND order_line_id = ?', [COMPANY, LINE]);
  ok('the line has exactly its two rank rows', Number(rankRows) === 2);
  await putChanges(conn, c, { ranks: [{ lineId: LINE, unitKeys: [] }] });
  ok('an empty order clears the line', Object.keys((await getPlanner(conn, COMPANY, {})).ranks).length === 0);
  w = await measured(() => putChanges(db, c, { entries: [], ranks: [] }));
  ok(`nothing to save costs nothing (${w.queries} round trips)`, w.queries === 0);
  // refusals — and all or nothing
  const g3Before = JSON.stringify((await getPlanner(conn, COMPANY, {})).entries[g3.key] ?? null);
  err = await refusal(() => putChanges(conn, c, { entries: [{ unitKey: g3.key, shipDate: '2026-12-07', pinned: true }], ranks: [{ lineId: LINE, unitKeys: ['nope'] }] }));
  ok('a bad unit key in the ranks is refused (422) …', err?.status === 422);
  ok('… and the entry beside it was not written', JSON.stringify((await getPlanner(conn, COMPANY, {})).entries[g3.key] ?? null) === g3Before);
  err = await refusal(() => putChanges(conn, c, { ranks: [{ lineId: LINE, unitKeys: [g1.key, g1.key] }] }));
  ok('a unit twice in an order is refused', err?.status === 422);
  err = await refusal(() => putChanges(conn, c, { ranks: [{ lineId: LINE, unitKeys: [g1.key] }, { lineId: LINE, unitKeys: [g2.key] }] }));
  ok('a line twice is refused', err?.status === 422);
  err = await refusal(() => putChanges(conn, c, { ranks: [{ lineId: 999999999, unitKeys: [] }] }));
  ok('a line that is not here is refused', err?.status === 422);
  const otherLineUnit = s.units.find((u) => u.lineId !== LINE);
  if (otherLineUnit) {
    err = await refusal(() => putChanges(conn, c, { ranks: [{ lineId: LINE, unitKeys: [otherLineUnit.key] }] }));
    ok(`a unit of another line (${otherLineUnit.key}) is refused in this line's order`, err?.status === 422);
  }
  if (other) {
    err = await refusal(() => putChanges(conn, c, { ranks: [{ lineId: LINE, unitKeys: [`p${other.id}`] }] }));
    ok('another company\'s piece is refused in a rank', err?.status === 422);
  }
  err = await refusal(() => putChanges(conn, c, { entries: 'x' }));
  ok('a body that is not lists is refused', err?.status === 422);

  // The route is mounted.
  const indexRouter = (await import('../../apps/cf_erp/routes/index.js')).default;
  const paths = [];
  const walk = (stack) => { for (const l of stack) { if (l.route) paths.push(`${Object.keys(l.route.methods).join(',')} ${l.route.path}`); else if (l.handle?.stack) walk(l.handle.stack); } };
  walk(indexRouter.stack);
  ok('GET /planner and the seven PUTs are mounted', ['get /planner', 'put /planner/entries', 'put /planner/changes', 'put /planner/priorities', 'put /planner/lines/:id/level', 'put /planner/lines/:id/splits', 'put /planner/targets', 'put /planner/settings'].every((p) => paths.includes(p)), paths.filter((p) => p.includes('planner')).join(' | '));

  // A trimmed example for the report.
  const ex = await getPlanner(conn, COMPANY, {});
  const exUnits = ex.units.filter((u) => u.lineId === LINE);
  report.example = {
    horizon: { ...ex.horizon, periods: ex.horizon.periods.slice(0, 3) },
    settings: ex.settings, targets: ex.targets,
    functions: ex.functions.slice(0, 2).map((f) => ({ ...f, capacity: Object.fromEntries(Object.entries(f.capacity).slice(0, 3)) })).concat(ex.functions.filter((f) => f.key === CONTRACTOR)),
    orders: ex.orders,
    units: [exUnits.find((u) => u.level === 'line'), exUnits.find((u) => u.level === '0'), exUnits.find((u) => u.name === 'Girder line'), exUnits.find((u) => u.name === 'Girder segment')]
      .map((u) => ({ ...u, materials: u.materials.slice(0, 2) })),
    supply: { [plate.itemId]: ex.supply[plate.itemId] },
    entries: ex.entries,
  };
} catch (e) {
  failed++;
  console.error('  ERROR', e);
} finally {
  try { await conn.rollback(); } catch { /* reported above */ }
  detachNodeCache(conn);
  conn.release();
}

section('5. Nothing survived the rollback');
const after = await counts();
const changed = after.filter((a) => Number(before.find((b) => b.name === a.name)?.n) !== Number(a.n));
ok(`every cf_ table is back where it started (${after.length} tables)`, changed.length === 0, changed.map((x) => x.name).join(', '));
if (process.env.PLAN_EXAMPLE) console.log(JSON.stringify(report.example, null, 1));
console.log(`\nround trips: ${JSON.stringify({ getUnlocked: report.unlockedTrips, getLocked: report.lockedTrips, getLockedMs: report.lockedMs, units: report.units, putEntries: report.putEntriesTrips, putChanges: report.putChangesTrips })}`);
console.log(`${passed} passed, ${failed} failed`);
await pool.end();
process.exit(failed ? 1 : 0);
