/**
 * maintenance_test.mjs — MAINTENANCE (init.sql §82, services/maintenanceService.js, routes/maintenance.js;
 * contract TM/CF_ERP_ORDER_FLOW_PLAN.md "2026-10-18 — Maintenance (S6)"). Against the local database.
 *
 *   cd multi_app_be && node scripts/cf_kepl/maintenance_test.mjs      (CF_MAINT_COMPANY, default 2)
 *
 * EVERYTHING HAPPENS INSIDE ONE TRANSACTION THAT IS ROLLED BACK; the last thing it does is re-count every cf_ table.
 *   1. the pure rules: weekly / every 1st Sunday / last Friday / once across midnight → calendar rows
 *   2. planned downtime written into the calendar: the planner's machinesCalendar sees it; edit and delete
 *   3. raise a fault → a stop + an MO, NO capacity at once, the board says down, a second fault refused
 *   4. false alarm → stop ended, MO cancelled, capacity back
 *   5. fault → in progress → MR from the MO (createRequisition, lines from machineResources) → close: machine up,
 *      downtime and cost recorded; the dashboard card counts it
 *   6. preventive plan due (days) → one MO; not twice; closing moves the baseline; run hours read from the machine log
 *   7. round trips: fault, board, calendar
 */
import { pool } from '../../db.js';
import '../../apps/cf_erp/services/codegenProvider.js';
import { attachNodeCache, detachNodeCache } from '../../apps/cf_erp/lib/db.js';
import { createShift, machinesCalendar, faultCuts } from '../../apps/cf_erp/services/shiftService.js';
import { productionMachineIds, clearProductionMachines } from '../../apps/cf_erp/services/operationService.js';
import * as M from '../../apps/cf_erp/services/maintenanceService.js';

if (!/^(localhost|127\.0\.0\.1|::1)$/.test(process.env.DB_HOST ?? 'localhost')) throw new Error('This suite is local only.');
const COMPANY = Number(process.env.CF_MAINT_COMPANY ?? 2);
const tag = `MT${Date.now().toString(36).toUpperCase()}`;

let passed = 0;
let failed = 0;
const fails = [];
function ok(label, condition, detail = '') {
  if (typeof label !== 'string' || typeof condition !== 'boolean') throw new Error('ok(label, condition) takes a string and then a boolean');
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${!condition && detail ? ` — ${detail}` : ''}`);
  if (condition) passed++; else { failed++; fails.push(label); }
}
const section = (s) => console.log(`\n${s}`);
async function refusal(fn) { try { await fn(); return null; } catch (e) { return e; } }

const [tables] = await pool.query("SELECT TABLE_NAME name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME LIKE 'cf\\_%' ORDER BY TABLE_NAME");
const counts = async () => (await pool.query(tables.map((t) => `SELECT '${t.name}' AS name,COUNT(*) AS n FROM \`${t.name}\``).join(' UNION ALL ')))[0];
const before = await counts();
const conn = await pool.getConnection();
let n = 0;
const db = new Proxy(conn, { get: (t, p) => (p === 'query' ? (...a) => { n++; return t.query(...a); } : Reflect.get(t, p)) });
const measured = async (fn) => { const at = n; const result = await fn(); return { result, queries: n - at }; };
let exitCode = 0;

try {
  await conn.beginTransaction();
  attachNodeCache(conn);
  const [[user]] = await conn.query('SELECT id FROM users WHERE company_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 1', [COMPANY]);
  const c = { companyId: COMPANY, userId: user?.id ?? null };
  const q1 = async (sql, args) => (await conn.query(sql, args))[0][0];

  /* ------------------------------------------------------------------------------------------- */
  section('1. The rules, pure');
  const weekly = { kind: 'weekly', startsOn: '2026-10-01', endsOn: null, startTime: '08:00', durationMinutes: 480, weekdays: ['sun'], everyN: 1 };
  ok('weekly Sunday: 2026-10-18 is one, 2026-10-19 is not', M.ruleOnDate(weekly, '2026-10-18') && !M.ruleOnDate(weekly, '2026-10-19'));
  const fortnight = { ...weekly, everyN: 2 };
  ok('every 2 weeks: 04 Oct yes, 11 Oct no, 18 Oct yes', M.ruleOnDate(fortnight, '2026-10-04') && !M.ruleOnDate(fortnight, '2026-10-11') && M.ruleOnDate(fortnight, '2026-10-18'));
  const firstSunday = { kind: 'monthly', startsOn: '2026-10-01', endsOn: null, startTime: '08:00', durationMinutes: 480, everyN: 1, monthWeek: 1, monthWeekday: 'sun', monthDay: null };
  const fs = M.occurrences(firstSunday, '2026-10-01', '2027-01-31').map((o) => o.start);
  ok('every 1st Sunday, 08:00 for 8 h → 4 Oct, 1 Nov, 6 Dec, 3 Jan', JSON.stringify(fs) === JSON.stringify(['2026-10-04 08:00', '2026-11-01 08:00', '2026-12-06 08:00', '2027-01-03 08:00']), JSON.stringify(fs));
  ok('its words', M.ruleText(firstSunday) === 'Every 1st Sunday, 08:00 for 8 h', M.ruleText(firstSunday));
  const lastFriday = { ...firstSunday, monthWeek: 5, monthWeekday: 'fri' };
  const lf = M.occurrences(lastFriday, '2026-10-01', '2026-12-31').map((o) => o.start.slice(0, 10));
  ok('last Friday → 30 Oct, 27 Nov, 25 Dec', JSON.stringify(lf) === '["2026-10-30","2026-11-27","2026-12-25"]', JSON.stringify(lf));
  const day31 = { ...firstSunday, monthWeek: null, monthWeekday: null, monthDay: 31 };
  ok('day 31 falls on a short month\'s last day', JSON.stringify(M.occurrences(day31, '2026-11-01', '2027-02-28').map((o) => o.start.slice(0, 10))) === '["2026-11-30","2026-12-31","2027-01-31","2027-02-28"]');
  const once = { kind: 'once', startsOn: '2026-11-10', startTime: '22:00', durationMinutes: 27 * 60, weekdays: [], everyN: 1 };
  const rows = M.expandRule(once, '2026-11-01', '2026-11-30');
  ok('a once window 22:00 + 27 h → three calendar rows cut at midnight',
    JSON.stringify(rows) === JSON.stringify([{ date: '2026-11-10', start: '22:00', end: '00:00' }, { date: '2026-11-11', start: '00:00', end: '00:00' }, { date: '2026-11-12', start: '00:00', end: '01:00' }]), JSON.stringify(rows));
  ok('a rewrite from the 11th keeps the tail of a window that began before', JSON.stringify(M.expandRule(once, '2026-11-11', '2026-11-30').map((r) => r.date)) === '["2026-11-11","2026-11-12"]');
  const bad = await refusal(async () => M.readRule({ kind: 'weekly', reason: 'x', startsOn: '2026-10-01', startTime: '08:00', durationMinutes: 60, weekdays: [] }));
  ok('a weekly rule with no days is refused', !!bad && /days of the week/.test(bad.message), bad?.message);
  const cuts = faultCuts(5, '2026-10-18 10:30:00', '2026-10-17', '2026-10-20');
  ok('an open fault cuts from its start to the end of the horizon', cuts.length === 3 && cuts[0].start_time === '10:30' && cuts[1].start_time === '00:00' && cuts[2].exception_date === '2026-10-20');

  /* ------------------------------------------------------------------------------------------- */
  section('2. Planned downtime written into the machine calendar');
  clearProductionMachines();
  const prod = [...await productionMachineIds(conn, COMPANY)];
  const [[machine]] = await conn.query("SELECT * FROM cf_machines WHERE company_id = ? AND deleted_at IS NULL AND status = 'active' AND id IN (?) ORDER BY id LIMIT 1", [COMPANY, prod.length ? prod : [0]]);
  if (!machine) throw new Error(`Company ${COMPANY} has no active production machine.`);
  const MID = machine.id;
  console.log(`  machine ${machine.code} (${MID})`);
  // Its own day: every day 08:00-16:00, no break, nothing else (rolled back at the end).
  await conn.query('UPDATE cf_machine_calendar_exceptions SET deleted_at = NOW() WHERE company_id = ? AND machine_id = ? AND deleted_at IS NULL', [COMPANY, MID]);
  await conn.query('UPDATE cf_machine_shifts SET deleted_at = NOW() WHERE company_id = ? AND machine_id = ? AND deleted_at IS NULL', [COMPANY, MID]);
  await conn.query("UPDATE cf_machine_stops SET ended_at = started_at WHERE company_id = ? AND machine_id = ? AND ended_at IS NULL", [COMPANY, MID]);
  await createShift(conn, c, MID, { name: `${tag} Day`, weekdays: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], startTime: '08:00', endTime: '16:00', breakMinutes: 0 });
  const board0 = await M.machinesBoard(conn, c);
  const today = board0.today;
  const nextSunday = (() => { for (let i = 1; i <= 7; i++) { const d = M.addDaysS(today, i); if (new Date(`${d}T00:00:00Z`).getUTCDay() === 0) return d; } return null; })();
  const dayAfter = M.addDaysS(nextSunday, 1);
  const cal = async (from, to) => (await machinesCalendar(conn, COMPANY, { from, to, machineIds: [MID] })).get(MID);
  const minutesOn = async (d) => (await cal(d, d)).minutes;
  ok('before: 480 minutes on the next Sunday', await minutesOn(nextSunday) === 480);

  const dry = await M.createDowntime(conn, c, { machineId: MID, kind: 'weekly', reason: `${tag} weekly service`, startsOn: today, startTime: '08:00', durationMinutes: 480, weekdays: ['sun'], dryRun: true });
  ok('dry run: the next occurrences, nothing written', dry.next.length === 6 && (dry.next[0].start.startsWith(today) || dry.next[0].start.startsWith(nextSunday)) && !(await q1('SELECT id FROM cf_planned_downtimes WHERE company_id = ? AND reason = ?', [COMPANY, `${tag} weekly service`])));
  const made = await measured(() => M.createDowntime(db, c, { machineId: MID, kind: 'weekly', reason: `${tag} weekly service`, startsOn: today, startTime: '08:00', durationMinutes: 480, weekdays: ['sun'] }));
  const W = made.result;
  ok('weekly Sunday 8 h: ~104 calendar rows over two years', W.calendarRows >= 104 && W.calendarRows <= 106, String(W.calendarRows));
  ok(`creating it is a few round trips (${made.queries})`, made.queries <= 8, String(made.queries));
  ok('the planner sees it: 0 minutes on the Sunday, 480 on the Monday', await minutesOn(nextSunday) === 0 && await minutesOn(dayAfter) === 480);
  const far = M.addDaysS(nextSunday, 7 * 50);
  ok('…and 50 weeks out', await minutesOn(far) === 0);
  const exRow = await q1('SELECT reason, start_time, end_time FROM cf_machine_calendar_exceptions WHERE company_id = ? AND downtime_id = ? AND exception_date = ? AND deleted_at IS NULL', [COMPANY, W.id, nextSunday]);
  ok('the calendar row says it is planned, 08:00-16:00', !!exRow && /^Planned: /.test(exRow.reason) && String(exRow.start_time).startsWith('08:00') && String(exRow.end_time).startsWith('16:00'));

  await M.updateDowntime(conn, c, W.id, { startTime: '12:00', durationMinutes: 120 });
  ok('an edit applies from today: the Sunday now has 360 minutes', await minutesOn(nextSunday) === 360);
  const live = await q1('SELECT COUNT(*) n FROM cf_machine_calendar_exceptions WHERE company_id = ? AND downtime_id = ? AND deleted_at IS NULL AND exception_date >= ?', [COMPANY, W.id, today]);
  ok('…with no doubled rows', Number(live.n) >= 104 && Number(live.n) <= 106, String(live.n));
  const listed = await M.listDowntimes(conn, COMPANY, { machineId: MID });
  ok('listed with its words and next dates', listed.rows.some((r) => r.id === W.id && r.text === 'Every Sunday, 12:00 for 2 h' && r.next.length === 3));
  const O = await M.createDowntime(conn, c, { machineId: MID, kind: 'once', reason: `${tag} overhaul`, startsOn: M.addDaysS(nextSunday, 2), startTime: '12:00', durationMinutes: 48 * 60 });
  ok('a once window of 48 h from Tuesday noon: 240 / 0 / 240 minutes', await minutesOn(M.addDaysS(nextSunday, 2)) === 240 && await minutesOn(M.addDaysS(nextSunday, 3)) === 0 && await minutesOn(M.addDaysS(nextSunday, 4)) === 240);
  await M.deleteDowntime(conn, c, O.id);
  ok('deleting it gives the days back', await minutesOn(M.addDaysS(nextSunday, 3)) === 480);
  // A rule whose rows run out gets topped up when Maintenance is opened.
  await conn.query('UPDATE cf_machine_calendar_exceptions SET deleted_at = NOW() WHERE company_id = ? AND downtime_id = ? AND exception_date > ?', [COMPANY, W.id, M.addDaysS(today, 30)]);
  await conn.query('UPDATE cf_planned_downtimes SET expanded_to = ? WHERE company_id = ? AND id = ?', [M.addDaysS(today, 30), COMPANY, W.id]);
  const topped = await M.topUp(conn, c, today);
  ok('top-up writes the rest again', topped >= 95 && await minutesOn(far) === 360, String(topped));

  /* ------------------------------------------------------------------------------------------- */
  section('3. Raise a fault');
  const tomorrow = M.addDaysS(today, 1);
  const beforeFault = (await cal(tomorrow, M.addDaysS(today, 3))).minutes;
  const f = await measured(() => M.raiseFault(db, c, { machineId: MID, note: `${tag} hydraulic leak` }));
  console.log(`  ${f.result.message}`);
  const mo1 = await M.getOrder(conn, COMPANY, f.result.order.id);
  ok('an MO is open, raised by the fault, holding an open stop', mo1.status === 'open' && mo1.source === 'fault' && mo1.machineDown && mo1.stop?.open === true);
  ok('the stop reason defaults to Breakdown', mo1.reason === 'Breakdown', String(mo1.reason));
  ok(`raising a fault is ${f.queries} round trips`, f.queries <= 14, String(f.queries));
  ok('the planner sees NO capacity from tomorrow on', beforeFault > 0 && (await cal(tomorrow, M.addDaysS(today, 3))).minutes === 0, String(beforeFault));
  const b1 = await measured(() => M.machinesBoard(db, c));
  const row1 = b1.result.machines.find((m) => m.id === MID);
  ok('the board says down, with its MO', row1?.status === 'down' && row1.fault?.code === mo1.code);
  ok(`the board is a fixed number of round trips (${b1.queries})`, b1.queries <= 14, String(b1.queries));
  const again = await refusal(() => M.raiseFault(conn, c, { machineId: MID }));
  ok('a second fault on a machine that is down is refused', again?.code === 'ALREADY_DOWN', again?.message);

  /* ------------------------------------------------------------------------------------------- */
  section('4. False alarm');
  const fa = await M.falseAlarm(conn, c, mo1.id, { note: 'Oil was from the next machine' });
  ok('the MO is cancelled as a false alarm and the stop ended', fa.order.status === 'cancelled' && fa.order.falseAlarm && fa.order.stop?.open === false);
  ok('capacity is back', (await cal(tomorrow, M.addDaysS(today, 3))).minutes === beforeFault);
  const twice = await refusal(() => M.falseAlarm(conn, c, mo1.id, {}));
  ok('a cancelled MO cannot be a false alarm again', !!twice);

  /* ------------------------------------------------------------------------------------------- */
  section('5. Fault → in progress → MR → close');
  const f2 = await M.raiseFault(conn, c, { machineId: MID, note: `${tag} motor burnt` });
  const id2 = f2.order.id;
  // The machine went down two hours ago (so there is downtime to count).
  await conn.query('UPDATE cf_machine_stops SET started_at = DATE_SUB(started_at, INTERVAL 2 HOUR) WHERE company_id = ? AND id = ?', [COMPANY, f2.stopId]);
  const wrong = await refusal(() => M.setStatus(conn, c, id2, { status: 'done' }));
  ok('done is not a status move (it is Close)', !!wrong);
  const s2 = await M.setStatus(conn, c, id2, { status: 'in_progress', note: 'Electrician on it' });
  ok('in progress keeps the fault\'s stop (no second stop)', s2.status === 'in_progress' && s2.stop?.id === f2.stopId && !!s2.startedAt);
  const lines = await M.mrLines(conn, COMPANY, id2);
  ok('MR lines: createRequisition and machineResources are there', lines.canRaise === true && lines.resourcesKnown === true);
  let itemLines = lines.lines.map((l) => ({ itemId: l.itemId, qty: l.qty }));
  if (!itemLines.length) {
    const it = await q1("SELECT m.id FROM cf_master_records m JOIN cf_item_details i ON i.master_id = m.id AND i.deleted_at IS NULL WHERE m.company_id = ? AND m.deleted_at IS NULL AND m.status = 'active' AND i.item_type IN ('catalog') ORDER BY m.id LIMIT 1", [COMPANY])
      ?? await q1("SELECT m.id FROM cf_master_records m JOIN cf_item_details i ON i.master_id = m.id AND i.deleted_at IS NULL WHERE m.company_id = ? AND m.deleted_at IS NULL AND m.status = 'active' ORDER BY m.id LIMIT 1", [COMPANY]);
    itemLines = [{ itemId: it.id, qty: 2 }];
    console.log('  (the machine has no resource list — one catalog item instead)');
  }
  const emptyMr = await refusal(() => M.raiseRequisition(conn, c, id2, { lines: [] }));
  ok('an MR with no lines is refused', !!emptyMr);
  const mr = await M.raiseRequisition(conn, c, id2, { lines: itemLines, note: `${tag} spares` });
  ok('the MR is raised and the MO waits for parts', !!mr.requisition?.id && mr.order.status === 'waiting_parts' && mr.order.requisitions.some((r) => r.id === mr.requisition.id), JSON.stringify(mr.requisition));
  const rq = await q1('SELECT for_type, maintenance_order_id FROM cf_requisitions WHERE company_id = ? AND id = ?', [COMPANY, mr.requisition.id]);
  ok('…as an MR for the maintenance order (the shared chain)', rq?.for_type === 'maintenance_order' && Number(rq.maintenance_order_id) === id2);
  ok('still no capacity while waiting for parts', (await cal(tomorrow, tomorrow)).minutes === 0);
  const noNote = await refusal(() => M.closeOrder(conn, c, id2, { otherCost: 1500 }));
  ok('an other cost needs a note', !!noNote);
  const closed = await M.closeOrder(conn, c, id2, { workDone: 'Rewound the motor', otherCost: 1500, costNote: 'Rewinding, outside shop' });
  ok('closed: done, the machine is back up', closed.order.status === 'done' && !closed.order.machineDown && closed.order.stop?.open === false);
  ok('downtime recorded (~120 min)', closed.downtimeMinutes >= 119 && closed.downtimeMinutes <= 125, String(closed.downtimeMinutes));
  ok('cost recorded (other cost; parts when stores record issues against it — S8)', closed.order.otherCost === 1500 && closed.order.cost >= 1500);
  ok('capacity is back after the close', (await cal(tomorrow, tomorrow)).minutes === 480);
  const hist = (await M.getOrder(conn, COMPANY, id2)).events.map((e) => e.event);
  ok('its history: raised, status, mr, done', JSON.stringify(hist) === '["raised","status","mr","done"]', JSON.stringify(hist));
  const sum = await M.maintenanceSummary(conn, COMPANY);
  ok('the dashboard card counts the downtime and the cost this week', sum.faultHours >= 2 && sum.cost >= 1500 && sum.doneThisWeek >= 1, JSON.stringify(sum));
  ok('…and the planned downtime hours this week (a number)', typeof sum.plannedHours === 'number' && sum.downtimeHours >= sum.faultHours);

  /* ------------------------------------------------------------------------------------------- */
  section('6. Preventive plans');
  const lastDone = M.addDaysS(today, -40);
  const P = await M.createPlan(conn, c, { machineId: MID, title: `${tag} Lubrication`, everyDays: 30, lastDoneOn: lastDone });
  const H = await M.createPlan(conn, c, { machineId: MID, title: `${tag} Filter`, everyRunHours: 500, everyTonnes: 1000 });
  const noRule = await refusal(() => M.createPlan(conn, c, { machineId: MID, title: 'x' }));
  ok('a plan needs days, run hours or tonnes', !!noRule);
  const pl = await M.listPlans(conn, c, { machineId: MID });
  const pRow = pl.rows.find((p) => p.id === P.id);
  const hRow = pl.rows.find((p) => p.id === H.id);
  ok('the 30-day plan is due (40 days) and got an MO', pl.raised >= 1 && pRow?.since.days >= 40 && !!pRow.openOrder, JSON.stringify(pRow));
  ok('the hours / tonnes plan reads the machine log and is not due', hRow && typeof hRow.since.runHours === 'number' && typeof hRow.since.tonnes === 'number' && !hRow.due && !hRow.openOrder);
  const pl2 = await M.listPlans(conn, c, { machineId: MID });
  const openOfPlan = await q1("SELECT COUNT(*) n FROM cf_maintenance_orders WHERE company_id = ? AND plan_id = ? AND status IN ('open','in_progress','waiting_parts')", [COMPANY, P.id]);
  ok('reading again raises no second MO', pl2.raised === 0 && Number(openOfPlan.n) === 1);
  const pmo = await M.getOrder(conn, COMPANY, pRow.openOrder.id);
  ok('the preventive MO says why it is due', pmo.source === 'preventive' && /40 of 30 days|4\d of 30 days/.test(pmo.note ?? ''), pmo.note);
  const started = await M.setStatus(conn, c, pmo.id, { status: 'in_progress' });
  ok('starting it takes the machine down (a maintenance stop)', started.machineDown && (await cal(tomorrow, tomorrow)).minutes === 0);
  const b2 = await M.machinesBoard(conn, c);
  ok('the board says down while maintenance works on it', b2.machines.find((m) => m.id === MID)?.status === 'down');
  await M.closeOrder(conn, c, pmo.id, { workDone: 'Greased' });
  const pl3 = await M.listPlans(conn, c, { machineId: MID, raise: false });
  ok('closing moves the plan\'s baseline: 0 days, not due', pl3.rows.find((p) => p.id === P.id)?.since.days === 0 && !pl3.rows.find((p) => p.id === P.id).due);
  // Run hours: give the machine log an hour of work on this machine since the filter plan's baseline.
  const step = await q1('SELECT s.id FROM cf_production_steps s WHERE s.company_id = ? ORDER BY s.id LIMIT 1', [COMPANY]);
  if (step) {
    await conn.query("UPDATE cf_maintenance_plans SET baseline_at = DATE_SUB(baseline_at, INTERVAL 1 DAY) WHERE id = ?", [H.id]);
    const base = (await q1('SELECT baseline_at FROM cf_maintenance_plans WHERE id = ?', [H.id])).baseline_at;
    const at = new Date(base.getTime() + 3600000).toISOString().slice(0, 19).replace('T', ' ');
    const end = new Date(base.getTime() + 7200000).toISOString().slice(0, 19).replace('T', ' ');
    await conn.query("INSERT INTO cf_work_sessions (company_id, machine_id, step_id, started_at, ended_at, end_kind, source) VALUES (?, ?, ?, ?, ?, 'pause', 'day_entry')", [COMPANY, MID, step.id, at, end]);
    const pl4 = await M.listPlans(conn, c, { machineId: MID, raise: false });
    ok('run hours since the baseline come from the machine log (1 h)', pl4.rows.find((p) => p.id === H.id)?.since.runHours === 1, JSON.stringify(pl4.rows.find((p) => p.id === H.id)?.since));
  } else console.log('  (no production step in this company — run hours checked for shape only; CF_MAINT_COMPANY=1 has steps)');

  /* ------------------------------------------------------------------------------------------- */
  section('7. Lists');
  const done = await M.listOrders(conn, COMPANY, { status: 'all', machineId: MID });
  ok('all MOs of the machine are listed, newest first', done.rows.length >= 3 && done.rows[0].id > done.rows.at(-1).id);
  const search = await M.listOrders(conn, COMPANY, { status: 'all', search: 'motor burnt' });
  ok('search finds the MO by its title', search.rows.some((r) => r.id === id2));
  const manual = await M.createOrder(conn, c, { machineId: MID, title: `${tag} check guards` });
  ok('maintenance raises its own MO (machine stays up)', !!manual.order.code && !(await M.getOrder(conn, COMPANY, manual.order.id)).machineDown);
  const nf = await refusal(() => M.cancelOrder(conn, c, manual.order.id, {}));
  ok('cancelling needs a reason', !!nf);
  const cx = await M.cancelOrder(conn, c, manual.order.id, { note: 'Not needed' });
  ok('…and with one it is cancelled', cx.order.status === 'cancelled');
} catch (e) {
  console.error(e);
  exitCode = 1;
} finally {
  try { await conn.rollback(); } catch { /* */ }
  detachNodeCache(conn);
  conn.release();
}

const after = await counts();
const changed = after.filter((a) => Number(before.find((b) => b.name === a.name)?.n) !== Number(a.n));
ok('every cf_ table has the rows it had (rolled back)', changed.length === 0, changed.map((x) => x.name).join(', '));
console.log(`\n${passed} passed, ${failed} failed${fails.length ? `\n  ${fails.join('\n  ')}` : ''}`);
await pool.end();
process.exit(failed || exitCode ? 1 : 0);
