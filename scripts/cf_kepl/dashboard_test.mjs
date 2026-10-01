/**
 * dashboard_test.mjs — Production › Dashboard (services/dashboardService.js,
 * routes/dashboard.js). Against the local database.
 *
 *   cd multi_app_be && node scripts/cf_kepl/dashboard_test.mjs
 *   CF_DASH_COMPANY=2 CF_DASH_LINE=923 (the defaults: the local KEPL copy)
 *
 * EVERYTHING HAPPENS INSIDE ONE TRANSACTION THAT IS ROLLED BACK — the lock (if
 * needed), the confirm, the release, the shifts, every session, stop, event,
 * hold, plan entry and price — and the last thing it does is re-count every
 * cf_ table. The HTTP checks run on the pool and only read.
 *
 *   1. by machine: a day shift with overlapping jobs, stops with reasons,
 *      overtime and a gap nobody recorded → shift / run / overtime / stop /
 *      not recorded / utilisation / reasons, to the minute
 *   1b. where the shift time went: buckets (run, each stop reason, break,
 *      not recorded) add up to the shift minutes EXACTLY per machine, type and
 *      plant; work beats stop, overlapping stops count once, meal breaks,
 *      worked-through break, overtime and stops outside the shift apart, a
 *      machine with no shift listed apart; the rules pure
 *   2. a night shift crossing midnight belongs to the day it starts; the
 *      previous night's tail is not in the period
 *   3. output: operations done, pieces, tonnes (piece WEIGHT × good), standard minutes
 *   4. status now: running / stopped / off shift
 *   5. by order: progress (the line's steps, minutes or count), pace forecast,
 *      plan forecast, risk (late / at risk / on track), hold reasons, material,
 *      money (rate × weight), period gain
 *   6. risk rules, pure
 *   7. round trips: a fixed handful whatever the size (the KEPL line: ~17k steps)
 *   6b. work orders: contractors, cells, steps, partial completion, overdue, contractor summary,
 *      the period's progress, full tree rows, round trips
 *   8. permission (HTTP): production view reads both; orders view gets money
 */
import express from 'express';
import { pool } from '../../db.js';
import '../../apps/cf_erp/services/codegenProvider.js';
import { attachNodeCache, detachNodeCache } from '../../apps/cf_erp/lib/db.js';
import { lockLine } from '../../apps/cf_erp/services/lockService.js';
import { releaseLine, releaseCheck, liveReleaseOfLine } from '../../apps/cf_erp/services/releaseService.js';
import { setOrderStatus } from '../../apps/cf_erp/services/salesOrderService.js';
import { createArea } from '../../apps/cf_erp/services/stockingAreaService.js';
import { createShift } from '../../apps/cf_erp/services/shiftService.js';
import { listReasons, wallOf } from '../../apps/cf_erp/services/floorService.js';
import { measuresOf } from '../../apps/cf_erp/services/priceService.js';
import * as D from '../../apps/cf_erp/services/dashboardService.js';
import { productionMachineIds, clearProductionMachines } from '../../apps/cf_erp/services/operationService.js';
import { signToken } from '../../core/utils/jwt.js';

if (!/^(localhost|127\.0\.0\.1|::1)$/.test(process.env.DB_HOST ?? 'localhost')) throw new Error('This suite is local only.');
const COMPANY = Number(process.env.CF_DASH_COMPANY ?? 2);
const LINE = Number(process.env.CF_DASH_LINE ?? 923);
const TZ = 'Asia/Kolkata';

let passed = 0;
let failed = 0;
const fails = [];
function ok(label, condition, detail = '') {
  if (typeof label !== 'string' || typeof condition !== 'boolean') throw new Error('ok(label, condition) takes a string and then a boolean');
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${!condition && detail ? ` — ${detail}` : ''}`);
  if (condition) passed++; else { failed++; fails.push(label); }
}
const section = (s) => console.log(`\n${s}`);
const near = (a, b, tol = 0.01) => a != null && b != null && Math.abs(Number(a) - Number(b)) <= tol;
const addDays = (ds, n) => new Date(Date.parse(`${ds}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);

const [tables] = await pool.query("SELECT TABLE_NAME name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME LIKE 'cf\\_%' ORDER BY TABLE_NAME");
const counts = async () => (await pool.query(tables.map((t) => `SELECT '${t.name}' AS name,COUNT(*) AS n FROM \`${t.name}\``).join(' UNION ALL ')))[0];
const before = await counts();
const conn = await pool.getConnection();
let server = null;
let exitCode = 0;
const report = {};

try {
  await conn.beginTransaction();
  attachNodeCache(conn);
  const [[user]] = await conn.query('SELECT id FROM users WHERE company_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 1', [COMPANY]);
  const c = { companyId: COMPANY, userId: user?.id ?? null };
  const q1 = async (sql, args) => (await conn.query(sql, args))[0][0];
  const qa = async (sql, args) => (await conn.query(sql, args))[0];
  await conn.query('INSERT INTO cf_floor_settings (company_id, timezone) VALUES (?, ?) ON DUPLICATE KEY UPDATE timezone = VALUES(timezone)', [COMPANY, TZ]);
  const today = wallOf(Date.now(), TZ).slice(0, 10);

  /* ------------------------------------------------------------------------ */
  section('0. Setup inside the transaction: lock, confirm, release; a one-line order');
  const line = await q1(`SELECT l.id, l.line_no, l.locked_at, l.order_id, l.item_id, l.quantity, o.code AS order_code, o.status FROM cf_sales_order_lines l
                           JOIN cf_sales_orders o ON o.id = l.order_id WHERE l.company_id = ? AND l.id = ?`, [COMPANY, LINE]);
  if (!line) throw new Error(`Line ${LINE} is not a line of company ${COMPANY}.`);
  if (await liveReleaseOfLine(conn, COMPANY, LINE)) throw new Error(`Line ${LINE} is already released — this suite releases it itself.`);
  if (!line.locked_at) await lockLine(conn, c, LINE);
  // Own the fixture: this order is the line alone, and no other order is confirmed.
  await conn.query('UPDATE cf_sales_order_lines SET deleted_at = NOW() WHERE company_id = ? AND order_id = ? AND id <> ? AND deleted_at IS NULL', [COMPANY, line.order_id, LINE]);
  await conn.query("UPDATE cf_sales_orders SET status = 'closed' WHERE company_id = ? AND status = 'confirmed' AND id <> ?", [COMPANY, line.order_id]);
  if (line.status !== 'confirmed') {
    await conn.query("UPDATE cf_sales_orders SET committed_date = COALESCE(committed_date, '2026-12-31') WHERE company_id = ? AND id = ?", [COMPANY, line.order_id]);
    await setOrderStatus(conn, c, line.order_id, 'confirmed');
  }
  let check = await releaseCheck(conn, COMPANY, LINE);
  if (check.needsFinishedArea && !check.areas.some((a) => a.purpose === 'dispatch')) {
    await createArea(conn, c, { code: 'DASHT-DSP', name: 'Dashboard test dispatch', purpose: 'dispatch' });
    check = await releaseCheck(conn, COMPANY, LINE);
  }
  if (!check.ok) throw new Error(`The line cannot be released: ${check.problems.slice(0, 5).join(' | ')}`);
  const rel = await releaseLine(conn, c, LINE, check.needsFinishedArea ? { finishedAreaId: check.areas.find((a) => a.purpose === 'dispatch')?.id } : {});
  await conn.query("UPDATE cf_production_releases SET created_at = '2026-08-01 00:00:00' WHERE company_id = ? AND id = ?", [COMPANY, rel.id]);
  const steps = await qa(
    `SELECT s.*, pi.item_id FROM cf_production_steps s JOIN cf_production_items pi ON pi.id = s.production_item_id
      WHERE pi.release_id = ? AND s.deleted_at IS NULL ORDER BY s.id`, [rel.id]);
  console.log(`  released ${line.order_code} line ${line.line_no}: ${steps.length} steps`);
  ok('the release has plenty of steps to work with', steps.length > 50, String(steps.length));

  // The dashboard shows production machines only, so the test machines are drawn from those.
  clearProductionMachines();
  const prod = [...await productionMachineIds(conn, COMPANY)];
  const [M, M2] = await qa("SELECT id, code FROM cf_machines WHERE company_id = ? AND deleted_at IS NULL AND status = 'active' AND id IN (?) ORDER BY code LIMIT 2", [COMPANY, prod]);
  for (const m of [M, M2]) {
    await conn.query('UPDATE cf_machine_shifts SET deleted_at = NOW() WHERE company_id = ? AND machine_id = ? AND deleted_at IS NULL', [COMPANY, m.id]);
    await conn.query('UPDATE cf_machine_calendar_exceptions SET deleted_at = NOW() WHERE company_id = ? AND machine_id = ? AND deleted_at IS NULL', [COMPANY, m.id]);
  }
  const ALL = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  await createShift(conn, c, M.id, { name: 'Day', weekdays: ALL, startTime: '08:00', endTime: '16:00', breakMinutes: 60 });
  await createShift(conn, c, M2.id, { name: 'Night', weekdays: ALL, startTime: '22:00', endTime: '06:00', breakMinutes: 0 });
  const reasons = await listReasons(conn, COMPANY);
  const reason = (code) => reasons.find((r) => r.code === code).id;
  // Our sessions only: nobody else's on these machines in the window.
  await conn.query('UPDATE cf_work_sessions SET deleted_at = NOW() WHERE company_id = ? AND machine_id IN (?, ?) AND deleted_at IS NULL', [COMPANY, M.id, M2.id]);
  await conn.query('UPDATE cf_machine_stops SET deleted_at = NOW() WHERE company_id = ? AND machine_id IN (?, ?) AND deleted_at IS NULL', [COMPANY, M.id, M2.id]);

  const D1 = addDays(today, -16);
  const D2 = addDays(D1, 1);
  const D0 = addDays(D1, -1);
  const D3 = addDays(D2, 1);
  const withEst = steps.filter((s) => s.est_work_minutes != null);
  const pickFrom = withEst.length >= 12 ? withEst : steps;
  const [s1, s2, s3, s4, s5, s6, s7, s8] = pickFrom;
  const sess = (machineId, step, start, end, extra = {}) => ({
    company_id: COMPANY, machine_id: machineId, step_id: step.id, started_at: start, ended_at: end, source: 'day_entry', qty_good: 0, qty_scrap: 0, ...extra,
  });
  const rowsS = [
    sess(M.id, s1, `${D1} 08:00:00`, `${D1} 10:00:00`, { qty_good: 2, end_kind: 'done' }),
    sess(M.id, s2, `${D1} 09:00:00`, `${D1} 11:00:00`, { end_kind: 'pause' }),
    sess(M.id, s3, `${D1} 16:00:00`, `${D1} 18:00:00`, { qty_good: 1, qty_scrap: 1, end_kind: 'pause' }),
    sess(M2.id, s5, `${D1} 23:00:00`, `${D2} 02:00:00`, { end_kind: 'pause' }),
    sess(M2.id, s6, `${D1} 05:00:00`, `${D1} 06:00:00`, { qty_good: 5, end_kind: 'pause' }),   // the night of D0: not in the period
    sess(M2.id, s7, `${D3} 01:00:00`, `${D3} 02:00:00`, { end_kind: 'pause' }),                // the night of D2: in the period
    sess(M2.id, s8, `${D2} 07:00:00`, `${D2} 08:00:00`, { end_kind: 'pause' }),                // outside any shift: overtime
  ];
  for (const r of rowsS) await conn.query('INSERT INTO cf_work_sessions SET ?', r);
  const stop = (machineId, code, start, end) => ({ company_id: COMPANY, machine_id: machineId, reason_id: reason(code), started_at: start, ended_at: end, source: 'day_entry' });
  for (const r of [
    stop(M.id, 'BREAKDOWN', `${D1} 11:00:00`, `${D1} 12:00:00`),
    stop(M.id, 'BREAKDOWN', `${D1} 12:00:00`, `${D1} 12:30:00`),
    stop(M.id, 'POWER', `${D1} 13:00:00`, `${D1} 13:30:00`),
  ]) await conn.query('INSERT INTO cf_machine_stops SET ?', r);
  // Where the shift time went: two machines of ONE type (M3 logged in detail, M5 not at all)
  // and a machine with no shift (M4).
  const [pair] = await qa(
    `SELECT classification_id FROM cf_machines WHERE company_id = ? AND deleted_at IS NULL AND status = 'active' AND id NOT IN (?, ?) AND id IN (?)
      GROUP BY classification_id HAVING COUNT(*) >= 2 ORDER BY classification_id LIMIT 1`, [COMPANY, M.id, M2.id, prod]);
  if (!pair) throw new Error('Need a machine type with two active machines.');
  const [M3, M5] = await qa("SELECT id, code FROM cf_machines WHERE company_id = ? AND classification_id = ? AND deleted_at IS NULL AND status = 'active' AND id IN (?) ORDER BY code LIMIT 2", [COMPANY, pair.classification_id, prod]);
  const [M4] = await qa("SELECT id, code FROM cf_machines WHERE company_id = ? AND deleted_at IS NULL AND status = 'active' AND id NOT IN (?, ?, ?, ?) AND id IN (?) ORDER BY code LIMIT 1", [COMPANY, M.id, M2.id, M3.id, M5.id, prod]);
  for (const m of [M3, M4, M5]) {
    await conn.query('UPDATE cf_machine_shifts SET deleted_at = NOW() WHERE company_id = ? AND machine_id = ? AND deleted_at IS NULL', [COMPANY, m.id]);
    await conn.query('UPDATE cf_machine_calendar_exceptions SET deleted_at = NOW() WHERE company_id = ? AND machine_id = ? AND deleted_at IS NULL', [COMPANY, m.id]);
    await conn.query('UPDATE cf_work_sessions SET deleted_at = NOW() WHERE company_id = ? AND machine_id = ? AND deleted_at IS NULL', [COMPANY, m.id]);
    await conn.query('UPDATE cf_machine_stops SET deleted_at = NOW() WHERE company_id = ? AND machine_id = ? AND deleted_at IS NULL', [COMPANY, m.id]);
  }
  await createShift(conn, c, M3.id, { name: 'Long day', weekdays: ALL, startTime: '08:00', endTime: '20:00', breakMinutes: 60 });
  await createShift(conn, c, M5.id, { name: 'Day', weekdays: ALL, startTime: '08:00', endTime: '16:00', breakMinutes: 30 });
  for (const r of [
    sess(M3.id, s1, `${D1} 08:00:00`, `${D1} 10:00:00`, { end_kind: 'pause' }),
    sess(M3.id, s2, `${D1} 09:30:00`, `${D1} 10:30:00`, { end_kind: 'pause' }),   // jobs together: one span 08:00–10:30
    sess(M3.id, s3, `${D1} 21:00:00`, `${D1} 22:00:00`, { end_kind: 'pause' }),   // after the shift: overtime 60
    sess(M3.id, s4, `${D2} 08:00:00`, `${D2} 19:45:00`, { end_kind: 'pause' }),   // worked through the break
    sess(M4.id, s5, `${D1} 10:00:00`, `${D1} 11:00:00`, { end_kind: 'pause' }),   // a machine with no shift
  ]) await conn.query('INSERT INTO cf_work_sessions SET ?', r);
  // Raw rows on purpose: the floor screens refuse overlaps, the dashboard must still count each minute once.
  for (const r of [
    stop(M3.id, 'SETUP', `${D1} 10:00:00`, `${D1} 11:00:00`),        // 10:00–10:30 under work → 30
    stop(M3.id, 'NO_MATERIAL', `${D1} 10:45:00`, `${D1} 12:00:00`),  // 10:45–11:00 under SETUP (started first) → 60
    stop(M3.id, 'BREAK', `${D1} 13:00:00`, `${D1} 13:30:00`),        // a logged meal break → 30, uses up half the pattern's break
    stop(M3.id, 'CRANE', `${D1} 14:00:00`, `${D1} 15:00:00`),        // 60
    stop(M3.id, 'BREAKDOWN', `${D1} 19:30:00`, `${D1} 21:00:00`),    // 30 in shift; 20:00–21:00 is outside it
  ]) await conn.query('INSERT INTO cf_machine_stops SET ?', r);

  // Now: M runs a job, M2 is stopped.
  const nowWall = wallOf(Date.now(), TZ);
  const minusMin = (n) => wallOf(Date.now() - n * 60000, TZ);
  await conn.query('INSERT INTO cf_work_sessions SET ?', sess(M.id, s4, minusMin(30), null, { source: 'live' }));
  await conn.query('INSERT INTO cf_machine_stops SET ?', { ...stop(M2.id, 'CRANE', minusMin(10), null), source: 'live' });

  /* ------------------------------------------------------------------------ */
  section(`1–4. By machine, ${D1} to ${D2}`);
  const md = await D.machinesDashboard(conn, COMPANY, { from: D1, to: D2 });
  report.machines = md.meta;
  const m1 = md.machines.find((m) => m.id === M.id);
  const m2 = md.machines.find((m) => m.id === M2.id);
  ok('the period is the two days asked for', md.period.from === D1 && md.period.to === D2 && md.period.days === 2);
  ok('day shift: 2 × (8 h − 1 h break) = 840 min of shift', m1.shiftMin === 840, String(m1.shiftMin));
  ok('run = the UNION of overlapping jobs (08–11) plus overtime 16–18 = 300', m1.runMin === 300, String(m1.runMin));
  ok('run inside the shift = 180, overtime = 120', m1.runInShiftMin === 180 && m1.overtimeMin === 120, `${m1.runInShiftMin} / ${m1.overtimeMin}`);
  ok('stopped = 120 min', m1.stopMin === 120, String(m1.stopMin));
  ok('not recorded = 840 − (270 + 30 covered in the shift) = 540', m1.notRecordedMin === 540, String(m1.notRecordedMin));
  ok('utilisation = 180 / 840 = 21.4 %', m1.utilisationPct === 21.4, String(m1.utilisationPct));
  ok('reasons: Breakdown 90 min ×2 first, then Power cut 30 min', m1.reasons[0]?.code === 'BREAKDOWN' && m1.reasons[0].minutes === 90 && m1.reasons[0].count === 2
    && m1.reasons[1]?.code === 'POWER' && m1.reasons[1].minutes === 30, JSON.stringify(m1.reasons));
  const d1 = m1.days.find((d) => d.date === D1);
  const d2 = m1.days.find((d) => d.date === D2);
  ok('day series: D1 420 shift / 300 run / 120 overtime; D2 420 shift, nothing run', d1.shift === 420 && d1.run === 300 && d1.overtime === 120 && d2.shift === 420 && d2.run === 0, JSON.stringify(m1.days));

  ok('night shift: 2 × 480 = 960 min', m2.shiftMin === 960, String(m2.shiftMin));
  ok('night: the D1 23:00–02:00 job and the D2 night 01:00–02:00 job count; the D0 night tail does not', m2.runInShiftMin === 240, String(m2.runInShiftMin));
  ok('night: 07:00–08:00 on D2 is overtime; run = 300', m2.overtimeMin === 60 && m2.runMin === 300, `${m2.overtimeMin} / ${m2.runMin}`);
  ok('night: utilisation 240 / 960 = 25 %', m2.utilisationPct === 25, String(m2.utilisationPct));
  const n1 = m2.days.find((d) => d.date === D1);
  ok('night: the job across midnight is all D1\'s (180 min)', n1.runIn === 180, JSON.stringify(m2.days));
  ok('night: the D0 tail\'s 5 good pieces are not in the period', m2.output.piecesGood === 0, String(m2.output.piecesGood));

  const meas = await measuresOf(conn, COMPANY, [s1.item_id, s3.item_id]);
  const kg1 = meas.get(s1.item_id)?.weightKg;
  const kg3 = meas.get(s3.item_id)?.weightKg;
  ok('output: 1 operation done, 3 good, 1 scrap, 3 steps worked (the open job is today)', m1.output.operationsDone === 1 && m1.output.piecesGood === 3 && m1.output.piecesScrap === 1 && m1.output.stepsWorked === 3,
    JSON.stringify(m1.output));
  if (kg1 != null && kg3 != null) ok('tonnes = 2 × piece WEIGHT + 1 × piece WEIGHT', near(m1.output.tonnes, (2 * kg1 + kg3) / 1000, 0.002), `${m1.output.tonnes} vs ${(2 * kg1 + kg3) / 1000}`);
  else ok('a piece with no WEIGHT is counted as not weighed, never as 0 t', m1.output.unweighedSessions > 0, JSON.stringify(m1.output));
  if (s1.est_work_minutes != null && s3.est_work_minutes != null) {
    const earned = 2 * Number(s1.est_work_minutes) + Number(s1.est_setup_minutes ?? 0) + Number(s3.est_work_minutes);
    ok('standard minutes = good × work time (+ setup when the job finished)', Math.abs(m1.standard.earnedMin - Math.round(earned)) <= 1, `${m1.standard.earnedMin} vs ${earned}`);
    ok('performance = standard ÷ run', m1.standard.performancePct === Math.round((earned / 300) * 1000) / 10, String(m1.standard.performancePct));
  }
  ok('now: M runs a job (named), M2 is stopped for the crane', m1.now.state === 'running' && m1.now.running[0]?.operation && m2.now.state === 'stopped' && /crane/i.test(m2.now.stop?.reason ?? ''),
    JSON.stringify([m1.now, m2.now]));
  ok('the plant strip adds the machines up', md.plant.shiftMin === md.machines.reduce((t, m) => t + m.shiftMin, 0) && md.plant.runningNow >= 1 && md.plant.stoppedNow >= 1);
  ok('plant top reasons put Breakdown first', md.plant.topReasons[0]?.code === 'BREAKDOWN', JSON.stringify(md.plant.topReasons.slice(0, 2)));
  const other = md.machines.find((m) => ![M.id, M2.id, M3.id, M4.id, M5.id].includes(m.id) && m.hasShifts);
  ok('a machine with shifts and no log reads 0 % run and its whole shift not recorded', !other || (other.runMin === 0 && other.notRecordedMin === other.shiftMin));
  const bad = await (async () => { try { await D.machinesDashboard(conn, COMPANY, { from: D2, to: D1 }); return null; } catch (e) { return e; } })();
  ok('to before from is refused', !!bad && /before/.test(bad.message));
  const long = await (async () => { try { await D.machinesDashboard(conn, COMPANY, { from: '2026-01-01', to: '2026-09-01' }); return null; } catch (e) { return e; } })();
  ok('more than 92 days is refused', !!long && /92/.test(long.message));

  /* ------------------------------------------------------------------------ */
  section('1b. Where the shift time went — buckets that make up exactly 100 % of the shift');
  const TT = md.time;
  const bmin = (t, key) => t.buckets.find((b) => b.key === key)?.minutes ?? 0;
  const rmin = (t, code) => t.buckets.find((b) => b.code === code)?.minutes ?? 0;
  const sumB = (t) => t.buckets.reduce((s, b) => s + b.minutes, 0);
  const t1 = m1.time;
  ok('day shift M: 960 min of shift WINDOW (the break is a bucket, not taken off)', t1.shiftMinutes === 960 && t1.netShiftMinutes === 840, `${t1.shiftMinutes} / ${t1.netShiftMinutes}`);
  ok('M: Running 180, Breakdown 90, Power cut 30, Break 120, Not recorded 540', bmin(t1, 'run') === 180 && rmin(t1, 'BREAKDOWN') === 90 && rmin(t1, 'POWER') === 30
    && bmin(t1, 'break') === 120 && bmin(t1, 'unrecorded') === 540, JSON.stringify(t1.buckets));
  ok('M: overtime 120 outside the 100 %; utilisation = 180 / 840 net, same as the card', t1.overtimeMinutes === 120 && t1.utilisationPct === m1.utilisationPct, `${t1.overtimeMinutes} / ${t1.utilisationPct}`);
  ok('M: the Breakdown bucket knows its 2 stops; kinds are unplanned', t1.buckets.find((b) => b.code === 'BREAKDOWN')?.stops === 2 && t1.buckets.filter((b) => b.reasonId).every((b) => b.kind === 'unplanned'));
  const t2 = m2.time;
  ok('night shift M2: 960 = Running 240 + Not recorded 720; overtime 60 (07–08); the D0 tail is not in it', t2.shiftMinutes === 960 && bmin(t2, 'run') === 240 && bmin(t2, 'unrecorded') === 720 && t2.overtimeMinutes === 60,
    JSON.stringify(t2));
  const m3 = md.machines.find((m) => m.id === M3.id);
  const t3 = m3.time;
  ok('M3: 2 × 12 h windows = 1440 min', t3.shiftMinutes === 1440, String(t3.shiftMinutes));
  ok('M3: overlapping jobs are one span, plus the day worked through: Running 150 + 705 = 855', bmin(t3, 'run') === 855, String(bmin(t3, 'run')));
  ok('M3: work beats a stop — Setup gets only 10:30–11:00 (30)', rmin(t3, 'SETUP') === 30, String(rmin(t3, 'SETUP')));
  ok('M3: overlapping stops count once, the earlier stop first — No material 60', rmin(t3, 'NO_MATERIAL') === 60, String(rmin(t3, 'NO_MATERIAL')));
  ok('M3: Crane 60; Breakdown 30 (clipped to the shift)', rmin(t3, 'CRANE') === 60 && rmin(t3, 'BREAKDOWN') === 30);
  ok('M3: the logged meal break (30) uses up half the pattern break; worked through it on D2 leaves 15 → Break 30 + 15 = 45', rmin(t3, 'BREAK') === 30 && bmin(t3, 'break') === 45, `${rmin(t3, 'BREAK')} / ${bmin(t3, 'break')}`);
  ok('M3: Not recorded = 720 − 150 − 210 − 30 = 330 (D2 has none)', bmin(t3, 'unrecorded') === 330, String(bmin(t3, 'unrecorded')));
  ok('M3: Setup / changeover and Meal break are PLANNED, No material / Crane / Breakdown UNPLANNED',
    ['SETUP', 'BREAK'].every((c) => t3.buckets.find((b) => b.code === c)?.kind === 'planned') && ['NO_MATERIAL', 'CRANE', 'BREAKDOWN'].every((c) => t3.buckets.find((b) => b.code === c)?.kind === 'unplanned'));
  ok('M3: buckets ordered run → planned → break → unplanned → not recorded', (() => {
    const rank = { run: 0, planned: 1, break: 2, unplanned: 3, unrecorded: 4 };
    return t3.buckets.every((b, i) => i === 0 || rank[t3.buckets[i - 1].kind] <= rank[b.kind]);
  })(), t3.buckets.map((b) => b.kind).join(','));
  ok('M3: overtime 60 (21–22); stop time outside the shift 60 (20–21), neither in the 100 %', t3.overtimeMinutes === 60 && t3.stopOutsideShiftMinutes === 60, `${t3.overtimeMinutes} / ${t3.stopOutsideShiftMinutes}`);
  ok('M3: utilisation = 855 / (1440 − 120) = 64.8 %', t3.utilisationPct === 64.8, String(t3.utilisationPct));
  const m5 = md.machines.find((m) => m.id === M5.id);
  ok('M5 (nothing logged): 960 = Break 60 + Not recorded 900', m5.time.shiftMinutes === 960 && bmin(m5.time, 'break') === 60 && bmin(m5.time, 'unrecorded') === 900, JSON.stringify(m5.time.buckets));
  const m4 = md.machines.find((m) => m.id === M4.id);
  ok('M4 has no shift: listed apart with its 60 min of work, not in any bar', m4.time.noShift && m4.time.shiftMinutes === 0 && TT.noShift.some((x) => x.id === M4.id && x.runMinutes === 60), JSON.stringify(m4.time));
  const badMachines = md.machines.filter((m) => sumB(m.time) !== m.time.shiftMinutes);
  ok(`EVERY machine (${md.machines.length}): its buckets add up to its shift minutes exactly`, badMachines.length === 0, badMachines.map((m) => `${m.code} ${sumB(m.time)}≠${m.time.shiftMinutes}`).join(', '));
  const badTypes = TT.types.filter((t) => sumB(t) !== t.shiftMinutes
    || t.shiftMinutes !== md.machines.filter((m) => t.machineIds.includes(m.id) && !m.time.noShift).reduce((s, m) => s + m.time.shiftMinutes, 0));
  ok(`EVERY type (${TT.types.length}): buckets add up to its shift minutes = Σ of its machines`, badTypes.length === 0, badTypes.map((t) => t.name).join(', '));
  ok('the plant: buckets add up to its shift minutes = Σ of the types', sumB(TT.plant) === TT.plant.shiftMinutes && TT.plant.shiftMinutes === TT.types.reduce((s, t) => s + t.shiftMinutes, 0));
  const ty = TT.types.find((t) => t.id === pair.classification_id);
  ok('the M3 + M5 type: 2 machines, 2400 min, Running 855, Break 105, Not recorded 1230', ty.machines === 2 && ty.shiftMinutes === 2400 && bmin(ty, 'run') === 855 && bmin(ty, 'break') === 105 && bmin(ty, 'unrecorded') === 1230,
    JSON.stringify({ ...ty, buckets: ty.buckets.map((b) => `${b.key}:${b.minutes}`) }));
  ok('the type carries its path in the type tree (for the areas)', Array.isArray(ty.path) && ty.path.length >= 1 && ty.path.at(-1).id === pair.classification_id, JSON.stringify(ty.path));
  ok('the legend lists every active reason, with time and stops, planned first', TT.reasons.length >= 12 && TT.reasons.find((r) => r.code === 'BREAKDOWN').minutes === 120
    && TT.reasons.find((r) => r.code === 'BREAKDOWN').stops === 3 && TT.reasons.find((r) => r.code === 'DRAWING').minutes === 0 && TT.reasons[0].kind === 'planned', JSON.stringify(TT.reasons.slice(0, 4)));

  // Pure: the rules on their own, with the clock in the middle of a minute.
  const W = (h, m = 0) => Date.UTC(2026, 0, 5, h, m);
  const pure = D.accountShiftTime({
    windows: [{ s: W(8), e: W(16), breakMin: 60 }, { s: W(15), e: W(17), breakMin: 0 }],  // the second overlaps: counted once
    sessions: [{ s: W(8), e: W(9) }, { s: W(8, 30), e: W(9, 30) }],
    stops: [{ id: 2, s: W(9), e: W(10), reasonId: 7 }, { id: 1, s: W(9, 15), e: W(10, 30), reasonId: 8 }],
    nowW: W(12) + 30500,
  });
  const ms2m = (x) => x / 60000;
  ok('pure: shift counted to the clock (4 h 0.5 min)', near(ms2m(pure.shiftMs), 240 + 30.5 / 60, 1e-9), String(ms2m(pure.shiftMs)));
  ok('pure: run 90, reason 7 gets 9:30–10:00, reason 8 10:00–10:30', near(ms2m(pure.runMs), 90) && near(ms2m(pure.reasonMs.get(7)), 30) && near(ms2m(pure.reasonMs.get(8)), 30));
  ok('pure: run + stops + break + not recorded = shift, to the ms', Math.abs(pure.runMs + [...pure.reasonMs.values()].reduce((a, b) => a + b, 0) + pure.breakMs + pure.unrecordedMs - pure.shiftMs) < 1e-6);
  const rounded = D.roundToTotal([{ ms: 100.4 * 60000 }, { ms: 50.4 * 60000 }, { ms: 49.2 * 60000 }], 200);
  ok('rounding hands the spare minutes to the largest remainders and hits the total', rounded.map((r) => r.minutes).join() === '101,50,49', rounded.map((r) => r.minutes).join());
  ok('reason kinds: SETUP / CLEANING / BREAK / PM_PRESS planned; BREAKDOWN / OTHER / anything new unplanned',
    ['SETUP', 'CLEANING', 'BREAK', 'PM_PRESS', 'MAINTENANCE'].every((c) => D.reasonKind(c) === 'planned') && ['BREAKDOWN', 'OTHER', 'NO_MATERIAL', 'XYZ'].every((c) => D.reasonKind(c) === 'unplanned'));

  /* ------------------------------------------------------------------------ */
  section('5. By order');
  // Some done long ago, some done three days ago (the pace), one on hold.
  const pending = steps.filter((s) => s.state === 'pending');
  const oldDone = pending.slice(10, 1010);
  const recentDone = pending.slice(1010, 5010);
  const held = pending[6000];
  for (const [set, ago] of [[oldDone, 20], [recentDone, 3]]) {
    await conn.query(`UPDATE cf_production_steps SET state = 'done', qty_good = quantity, started_at = NOW() - INTERVAL ${ago} DAY, finished_at = NOW() - INTERVAL ${ago} DAY WHERE id IN (?)`, [set.map((s) => s.id)]);
    await conn.query(`INSERT INTO cf_step_events (company_id, step_id, event, qty_good, at) SELECT company_id, id, 'progress', quantity, NOW() - INTERVAL ${ago} DAY FROM cf_production_steps WHERE id IN (?)`, [set.map((s) => s.id)]);
  }
  await conn.query("UPDATE cf_production_steps SET state = 'on_hold', held_from = 'pending' WHERE id = ?", [held.id]);
  await conn.query("INSERT INTO cf_step_events (company_id, step_id, event, note) VALUES (?, ?, 'hold', 'Crane broken')", [COMPANY, held.id]);
  await conn.query("UPDATE cf_sales_order_lines SET rate = 85000, rate_basis = 'tonne' WHERE id = ?", [LINE]);
  await conn.query('UPDATE cf_plan_entries SET deleted_at = NOW() WHERE company_id = ? AND order_line_id = ? AND deleted_at IS NULL', [COMPANY, LINE]);

  // The expected progress, worked out here from the raw steps.
  const raw = await qa('SELECT s.state, s.quantity, s.qty_good, s.est_minutes FROM cf_production_steps s JOIN cf_production_items pi ON pi.id = s.production_item_id WHERE pi.release_id = ? AND s.deleted_at IS NULL', [rel.id]);
  const frac = (s) => (s.state === 'done' ? 1 : Math.min(1, Number(s.qty_good) / Number(s.quantity)));
  const cover = raw.filter((s) => s.est_minutes != null).length / raw.length;
  const estSum = raw.reduce((t, s) => t + Number(s.est_minutes ?? 0), 0);
  const byWork = cover >= D.MIN_EST_COVERAGE && estSum > 0;
  const expPct = byWork ? (raw.reduce((t, s) => t + Number(s.est_minutes ?? 0) * frac(s), 0) / estSum) * 100 : (raw.reduce((t, s) => t + frac(s), 0) / raw.length) * 100;
  const shareOf = (set) => (byWork ? (set.reduce((t, s) => t + Number(s.est_minutes ?? 0), 0) / estSum) * 100 : (set.length / raw.length) * 100);
  const expPace = shareOf(recentDone);
  console.log(`  progress basis ${byWork ? 'minutes' : 'steps'} (${Math.round(cover * 100)} % of steps have a time); expected ${expPct.toFixed(2)} %, pace ${expPace.toFixed(2)} % in ${D.PACE_DAYS} days`);

  const setCommitted = (d) => conn.query('UPDATE cf_sales_orders SET committed_date = ? WHERE id = ?', [d, line.order_id]);
  await setCommitted(addDays(today, 10));
  let od = await D.ordersDashboard(conn, COMPANY, { from: addDays(today, -5), to: today });
  report.orders = od.meta;
  let o = od.orders.find((x) => x.id === line.order_id);
  ok('the confirmed order is on the board, alone', od.orders.length === 1 && !!o, String(od.orders.length));
  ok('progress matches the steps (minutes when ≥ 80 % have a time, else step count)', near(o.progress.pct, expPct, 0.11) && o.lineRows[0].basis === (byWork ? 'work' : 'count'), `${o.progress.pct} vs ${expPct}`);
  const perDay = expPace / D.PACE_DAYS;
  const expPaceDate = addDays(today, Math.ceil((100 - expPct) / perDay));
  ok('pace forecast = today + what is left ÷ the last 14 days\' pace', o.forecast.pace === expPaceDate || Math.abs(daysBetween(o.forecast.pace, expPaceDate)) <= 1, `${o.forecast.pace} vs ${expPaceDate}`);
  ok('the forecast says it is an estimate; no plan yet', o.forecast.estimate === true && o.forecast.plan === null && o.forecast.planComplete === false);
  ok('committed in 10 days, forecast later → At risk, with the slip in days', o.risk.status === 'at_risk' && o.risk.daysLeft === 10 && o.risk.slipDays === daysBetween(addDays(today, 10), o.forecast.date), JSON.stringify(o.risk));
  ok('this period gained the recent work (three days ago)', near(o.period.pctGained, expPace, 0.11), `${o.period.pctGained} vs ${expPace}`);
  ok('a hold names its reason', o.blocked.onHold === 1 && o.blocked.holdReasons[0]?.reason === 'Crane broken', JSON.stringify(o.blocked));
  const reqRows = (await q1('SELECT COUNT(*) AS n FROM cf_material_requirements WHERE release_id = ? AND deleted_at IS NULL', [rel.id])).n;
  ok('material counts every requirement of the release', o.material.requirements === Number(reqRows), `${o.material.requirements} vs ${reqRows}`);
  ok('short material is split in stock / on order / to buy', o.material.short.every((mt) => ['in_stock', 'on_order', 'to_buy'].includes(mt.status) && mt.short > 0)
    && o.material.inStock + o.material.onOrder + o.material.toBuy + o.material.covered === o.material.items, JSON.stringify({ ...o.material, short: o.material.short.length }));
  ok('stages are the order\'s operations, each with its share done', o.stages.length > 2 && o.stages.every((s) => s.pctDone >= 0 && s.pctDone <= 100 && s.steps > 0));
  ok('the bottleneck is the stage with the most work left', !!o.bottleneck && o.stages.every((s) => (o.bottleneck.basis === 'work' ? (s.workMinLeft ?? 0) <= o.bottleneck.workMinLeft : s.steps - s.done <= o.bottleneck.stepsLeft)), JSON.stringify(o.bottleneck));
  const lm = (await measuresOf(conn, COMPANY, [line.item_id])).get(line.item_id);
  if (lm?.weightKg != null) {
    ok('tonnes = the line item\'s WEIGHT × quantity', near(o.tonnes.total, (lm.weightKg * Number(line.quantity)) / 1000, 0.002), `${o.tonnes.total}`);
    ok('order value = ₹85,000 per tonne × tonnes', near(o.money.value, 85000 * (lm.weightKg * Number(line.quantity)) / 1000, 1), `${o.money.value}`);
  }
  ok('nothing invoiced or dispatched yet', o.money.invoiced === 0 && (o.tonnes.dispatched ?? 0) === 0);

  const planDate = addDays(today, 100);
  await conn.query('INSERT INTO cf_plan_entries (company_id, order_line_id, unit_key, ship_date) VALUES (?, ?, ?, ?)', [COMPANY, LINE, `l${LINE}`, planDate]);
  await setCommitted(addDays(today, 400));
  od = await D.ordersDashboard(conn, COMPANY, {});
  o = od.orders[0];
  ok('a plan for every line gives a plan date; the forecast takes the LATER of plan and pace', o.forecast.plan === planDate && o.forecast.planComplete && o.forecast.date === [planDate, o.forecast.pace].sort().at(-1), JSON.stringify(o.forecast));
  ok('committed after the forecast → On track', o.risk.status === 'on_track', JSON.stringify(o.risk));
  await setCommitted(addDays(today, -2));
  od = await D.ordersDashboard(conn, COMPANY, {});
  ok('committed two days ago and not dispatched → Late by 2 days', od.orders[0].risk.status === 'late' && od.orders[0].risk.slipDays === 2 && od.totals.late === 1, JSON.stringify(od.orders[0].risk));
  const noMoney = await D.ordersDashboard(conn, COMPANY, {}, { withMoney: false });
  ok('without orders view there is no money anywhere', noMoney.orders[0].money === null && noMoney.totals.value === null && noMoney.orders[0].lineRows.every((l) => l.amount === undefined));

  /* ------------------------------------------------------------------------ */
  section('6. Risk rules (pure)');
  const T = '2026-10-01';
  ok('delivered → done', D.riskOf({ committedDate: '2026-09-01', pct: 100, delivered: true, forecastDate: null, todayS: T }).status === 'done');
  ok('no committed date → no date', D.riskOf({ committedDate: null, pct: 10, delivered: false, forecastDate: '2026-12-01', todayS: T }).status === 'no_date');
  ok('past the date → late', D.riskOf({ committedDate: '2026-09-28', pct: 99, delivered: false, forecastDate: null, todayS: T }).status === 'late');
  ok('forecast after the date → at risk', D.riskOf({ committedDate: '2026-10-20', pct: 50, delivered: false, forecastDate: '2026-10-25', todayS: T }).slipDays === 5);
  ok('forecast on the date → on track', D.riskOf({ committedDate: '2026-10-20', pct: 50, delivered: false, forecastDate: '2026-10-20', todayS: T }).status === 'on_track');
  ok('due in 5 days, 40 % done, no forecast → at risk', D.riskOf({ committedDate: '2026-10-06', pct: 40, delivered: false, forecastDate: null, todayS: T }).status === 'at_risk');
  ok('due in a month, no forecast → no forecast (not guessed)', D.riskOf({ committedDate: '2026-11-01', pct: 40, delivered: false, forecastDate: null, todayS: T }).status === 'no_forecast');
  ok('line progress: minutes when 80 % of steps have a time', D.lineProgress([{ steps: 10, withEst: 8, estTotal: 100, estDone: 25, countDone: 5 }]).pct === 25);
  ok('line progress: step count below that', D.lineProgress([{ steps: 10, withEst: 7, estTotal: 100, estDone: 25, countDone: 5 }]).pct === 50);

  /* ------------------------------------------------------------------------ */
  section('6b. Work orders: contractors, cells, steps, completion');
  const tag = `DWO${Date.now().toString(36).toUpperCase()}`;
  // Own the fixture: no other work order is live inside this transaction.
  await conn.query('UPDATE cf_work_order_cells SET deleted_at = NOW() WHERE company_id = ? AND deleted_at IS NULL', [COMPANY]);
  await conn.query('UPDATE cf_production_steps SET work_order_id = NULL WHERE company_id = ? AND work_order_id IS NOT NULL', [COMPANY]);
  await conn.query('UPDATE cf_work_orders SET deleted_at = NOW() WHERE company_id = ? AND deleted_at IS NULL', [COMPANY]);
  const ins = async (table, body) => (await conn.query(`INSERT INTO ${table} SET ?`, body))[0].insertId;
  const cA = await ins('cf_parties', { company_id: COMPANY, code: `${tag}-A`, name: `${tag} Alpha Fab`, is_subcontractor: 1 });
  const cB = await ins('cf_parties', { company_id: COMPANY, code: `${tag}-B`, name: `${tag} Beta Welding`, is_subcontractor: 1 });
  const mkWo = (n, contractor, status, due, start = null) => ins('cf_work_orders', { company_id: COMPANY, code: `${tag}-${n}`, order_id: line.order_id, order_line_id: LINE, contractor_id: contractor, status, due_date: due, start_date: start });
  const wo1 = await mkWo(1, cA, 'in_progress', addDays(today, -3), addDays(today, -20));
  const wo2 = await mkWo(2, cB, 'issued', addDays(today, 10));
  const wo3 = await mkWo(3, cA, 'draft', null);
  const wo4 = await mkWo(4, cB, 'done', addDays(today, -30));
  await mkWo(5, cB, 'cancelled', null);
  const freeAll = await qa(
    `SELECT s.id, s.quantity, s.operation_id, pi.order_piece_id FROM cf_production_steps s JOIN cf_production_items pi ON pi.id = s.production_item_id
      WHERE pi.release_id = ? AND pi.order_piece_id IS NOT NULL AND s.deleted_at IS NULL AND pi.deleted_at IS NULL AND s.state = 'pending' AND s.qty_good = 0
      ORDER BY s.id LIMIT 400`, [rel.id]);
  // One step per (piece, operation) cell, from different pieces.
  const seenCell = new Set();
  const free = freeAll.filter((s) => { const k = `${s.order_piece_id}:${s.operation_id}`; if (seenCell.has(k)) return false; seenCell.add(k); return true; });
  ok('the release has pending steps on locked pieces to hand out', free.length >= 12, String(free.length));
  const [a, b, cc, d, e, f, g, h, k] = free;
  const give = async (woId, rows) => {
    for (const s of rows) {
      await conn.query('UPDATE cf_production_steps SET work_order_id = ? WHERE id = ?', [woId, s.id]);
      await ins('cf_work_order_cells', { company_id: COMPANY, work_order_id: woId, order_line_id: LINE, order_piece_id: s.order_piece_id, operation_id: s.operation_id });
    }
  };
  // WO1: one step done, one half made, one not started -> (1 + 0.5 + 0) / 3 = 50 %.
  await give(wo1, [a, b, cc]);
  await conn.query("UPDATE cf_production_steps SET state = 'done', qty_good = quantity, started_at = ?, finished_at = ? WHERE id = ?", [`${today} 07:00:00`, `${today} 09:00:00`, a.id]);
  await conn.query("UPDATE cf_production_steps SET state = 'in_progress', qty_good = quantity / 2, started_at = ? WHERE id = ?", [`${addDays(today, -2)} 08:00:00`, b.id]);
  // WO2: two untouched steps -> 0 %.
  await give(wo2, [d, e]);
  // WO4 (done): one finished step.
  await give(wo4, [f]);
  await conn.query("UPDATE cf_production_steps SET state = 'done', qty_good = quantity, started_at = ?, finished_at = ? WHERE id = ?", [`${addDays(today, -40)} 08:00:00`, `${addDays(today, -39)} 08:00:00`, f.id]);
  // WO3 (draft): cells only, no steps carry it -> not released.
  for (const s of [g, h, k]) await ins('cf_work_order_cells', { company_id: COMPANY, work_order_id: wo3, order_line_id: LINE, order_piece_id: s.order_piece_id, operation_id: s.operation_id });
  // Progress events: today (in the period) and 30 days ago.
  const ev = (step, qty, at) => ins('cf_step_events', { company_id: COMPANY, step_id: step.id, event: 'progress', qty_good: qty, at });
  await ev(a, Number(a.quantity), `${today} 09:00:00`);
  await ev(b, Number(b.quantity) / 2, `${today} 10:00:00`);
  await ev(d, Number(d.quantity) / 4, `${addDays(today, -30)} 10:00:00`);

  const wd = await D.workOrdersDashboard(conn, COMPANY, { from: addDays(today, -5), to: today });
  report.workOrders = wd.meta;
  const byCode = (n) => wd.workOrders.find((w) => w.code === `${tag}-${n}`);
  const W1 = byCode(1); const W2 = byCode(2); const W3 = byCode(3); const W4 = byCode(4);
  ok('four work orders listed (the cancelled one is not)', wd.workOrders.length === 4 && !byCode(5), String(wd.workOrders.length));
  ok('each carries its contractor, order and line', W1.contractor.id === cA && W1.contractor.name === `${tag} Alpha Fab` && W1.order.id === line.order_id && W1.line.id === LINE && W1.line.lineNo === line.line_no);
  ok('operations: assigned cells, released steps, done', W1.operations.assigned === 3 && W1.operations.steps === 3 && W1.operations.done === 1 && W1.operations.inProgress === 1, JSON.stringify(W1.operations));
  ok('completion counts a partial step by its share: (1 + 0.5 + 0) / 3 = 50 %', near(W1.operations.pct, 50, 0.11), String(W1.operations.pct));
  ok('an untouched work order is 0 %, not null', W2.operations.pct === 0 && W2.operations.steps === 2 && W2.released === true);
  ok('a work order whose steps are not on it says not released: pct null, cells counted', W3.released === false && W3.operations.pct === null && W3.operations.assigned === 3 && W3.operations.steps === 0);
  ok('pieces = distinct pieces of its cells', W1.pieces === new Set([a, b, cc].map((s) => s.order_piece_id)).size);
  ok('overdue: open and the due date has passed (3 days)', W1.overdue === true && W1.daysOverdue === 3 && W2.overdue === false && W3.overdue === false);
  ok('a done work order past its date is not overdue; it is 100 %', W4.overdue === false && W4.open === false && W4.operations.pct === 100);
  ok('first started is the earliest step start; last activity the latest', W1.firstStartedAt === `${addDays(today, -2)}T08:00:00` && String(W1.lastActivityAt).startsWith(today), `${W1.firstStartedAt} / ${W1.lastActivityAt}`);
  ok('work done this period = progress events in the period (1 + 0.5)', near(W1.period.opsDone, 1.5, 0.002) && W1.period.stepsTouched === 2, JSON.stringify(W1.period));
  ok('progress outside the period is not counted (30 days ago)', W2.period.opsDone === 0);
  const wdLong = await D.workOrdersDashboard(conn, COMPANY, { from: addDays(today, -60), to: today });
  ok('...but a longer period takes it in (a quarter of a step)', near(wdLong.workOrders.find((w) => w.code === `${tag}-2`).period.opsDone, 0.25, 0.002));
  ok('per-operation rows add up to the work order', W1.byOperation.reduce((t, x) => t + x.assigned, 0) === W1.operations.assigned
    && W1.byOperation.reduce((t, x) => t + x.steps, 0) === W1.operations.steps && W1.byOperation.every((x) => x.code && x.name));
  ok('sorted: overdue first, then open by least complete, done last', wd.workOrders[0].id === wo1 && wd.workOrders.at(-1).id === wo4, wd.workOrders.map((w) => w.code.slice(-1)).join(''));
  const cs = (id) => wd.contractors.find((x) => x.id === id);
  ok('contractor summary: Alpha has WO1 + WO3, Beta WO2 + WO4', wd.contractors.length === 2 && cs(cA).workOrders === 2 && cs(cB).workOrders === 2 && cs(cA).open === 2 && cs(cB).open === 1);
  ok('contractor completion pools the steps: Alpha (1.5 of 3) = 50 %; Beta (0 + 1 of 3) = 33.3 %', near(cs(cA).pct, 50, 0.11) && near(cs(cB).pct, 33.3, 0.11), `${cs(cA).pct} ${cs(cB).pct}`);
  ok('contractor: overdue and ops done this period', cs(cA).overdue === 1 && cs(cB).overdue === 0 && near(cs(cA).periodOps, 1.5, 0.002));
  ok('plant strip: open 3, contractors active 2 (issued / in progress), overdue 1, not released 1', wd.plant.open === 3 && wd.plant.workOrders === 4 && wd.plant.contractorsActive === 2 && wd.plant.overdue === 1 && wd.plant.notReleased === 1, JSON.stringify(wd.plant));
  ok('plant strip: ops assigned 3+2+3+1, released 3+2+1, done 2, % pools the steps', wd.plant.operationsAssigned === 9 && wd.plant.operationsReleased === 6 && wd.plant.operationsDone === 2 && near(wd.plant.pct, ((1.5 + 0 + 1) / 6) * 100, 0.11), JSON.stringify(wd.plant));
  ok('no value is invented: work orders carry no amount', wd.plant.value === null);
  ok(`work orders: ≤ 8 reads in 2 stages whatever the count (took ${wd.meta.queries} in ${wd.meta.stages})`, wd.meta.queries <= 8 && wd.meta.stages <= 2);
  let wdBad = null;
  try { await D.workOrdersDashboard(conn, COMPANY, { from: '2026-13-01' }); } catch (err) { wdBad = err; }
  ok('a bad date is refused (422)', wdBad?.status === 422, wdBad?.message);

  const tr = await D.orderTreeRows(conn, COMPANY);
  const [[trCount]] = await conn.query(
    `SELECT COUNT(*) AS n FROM cf_production_items pi JOIN cf_production_releases r ON r.id = pi.release_id AND r.deleted_at IS NULL
       JOIN cf_sales_orders o ON o.id = r.order_id AND o.status = 'confirmed' AND o.deleted_at IS NULL WHERE pi.company_id = ? AND pi.deleted_at IS NULL`, [COMPANY]);
  ok('full tree rows: every production item of the confirmed order, one row each', tr.rows.length === Number(trCount.n) && tr.rows.length > 50, `${tr.rows.length} vs ${trCount.n}`);
  ok('tree rows: roots have no parent; a child names its parent\'s code', tr.rows.some((x) => x.parentCode === null && x.level === 0) && tr.rows.some((x) => x.parentCode && x.level > 0)
    && tr.rows.every((x) => x.orderCode === line.order_code));
  const stepSum = tr.rows.reduce((t, x) => t + x.steps, 0);
  const [[stepCount]] = await conn.query(
    'SELECT COUNT(*) AS n FROM cf_production_steps s JOIN cf_production_items pi ON pi.id = s.production_item_id AND pi.deleted_at IS NULL WHERE s.company_id = ? AND pi.release_id = ? AND s.deleted_at IS NULL', [COMPANY, rel.id]);
  ok('tree rows: steps add up to the release\'s steps', stepSum === Number(stepCount.n), `${stepSum} vs ${stepCount.n}`);
  ok(`tree rows: 2 reads in 2 stages (took ${tr.meta.queries})`, tr.meta.queries <= 3 && tr.meta.stages <= 2);

  /* ------------------------------------------------------------------------ */
  section('7. Round trips (whatever the number of machines, orders or steps)');
  const w1 = await D.machinesDashboard(conn, COMPANY, { from: addDays(today, -29), to: today });
  const w2 = await D.ordersDashboard(conn, COMPANY, { from: addDays(today, -29), to: today });
  ok('the days carry what the download needs: ops / pieces add up to the machine, reasons by day add up to its stop reasons',
    w1.machines.every((m) => m.days.reduce((t, x) => t + x.ops, 0) === m.output.operationsDone && Math.abs(m.days.reduce((t, x) => t + x.pieces, 0) - m.output.piecesGood) < 0.01
      && m.days.every((x) => typeof x.stopIn === 'number' && typeof x.notRecorded === 'number' && x.reasons && typeof x.reasons === 'object'))
    && w1.machines.some((m) => m.days.some((x) => Object.keys(x.reasons).length > 0)));
  ok(`GET machines: ≤ 11 reads in ≤ 2 stages (took ${w1.meta.queries} in ${w1.meta.stages})`, w1.meta.queries <= 11 && w1.meta.stages <= 2);
  ok(`GET orders: ≤ 15 reads in ≤ 3 stages (took ${w2.meta.queries} in ${w2.meta.stages})`, w2.meta.queries <= 15 && w2.meta.stages <= 3);
  console.log(`  machines (30 days, ${w1.machines.length} machines): ${w1.meta.queries} reads, ${w1.meta.stages} stages, ${w1.meta.ms} ms`);
  console.log(`  orders (${steps.length} steps on the line): ${w2.meta.queries} reads, ${w2.meta.stages} stages, ${w2.meta.ms} ms`);
  report.warm = { machines: w1.meta, orders: w2.meta };
  if (w2.meta.profile) for (const x of w2.meta.profile) console.log(`    ${String(x.ms).padStart(5)} ms  ${x.sql}`);

  /* ------------------------------------------------------------------------ */
  section('8. Permission (HTTP, reads only — on the pool, outside the transaction)');
  const { default: cfRouter } = await import('../../apps/cf_erp/routes/index.js');
  const app = express();
  app.use(express.json());
  app.use('/x', cfRouter);
  server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/x`;
  const token = (perms) => signToken({ id: user?.id ?? 1, companyId: COMPANY, role: 'viewer', uiPermissions: perms });
  const get = async (path, perms) => {
    const r = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${token(perms)}` } });
    return { status: r.status, body: r.status === 200 ? await r.json() : null };
  };
  const pv = ['cf_erp_production_view'];
  ok('production view reads the machines tab', (await get('/dashboard/machines', pv)).status === 200);
  const ordersPv = await get('/dashboard/orders', pv);
  ok('production view reads the orders tab, without money', ordersPv.status === 200 && ordersPv.body.withMoney === false);
  const ordersBoth = await get('/dashboard/orders', [...pv, 'cf_erp_orders_view']);
  ok('with orders view too, the money is there', ordersBoth.status === 200 && ordersBoth.body.withMoney === true);
  ok('a floor-only tablet sees neither', (await get('/dashboard/machines', ['cf_erp_floor'])).status === 403 && (await get('/dashboard/orders', ['cf_erp_floor'])).status === 403);
  ok('a bad date is a 422', (await get('/dashboard/machines?from=2026-13-01', pv)).status === 422);
  const woHttp = await get(`/dashboard/work-orders?from=${addDays(today, -5)}&to=${today}`, pv);
  ok('production view reads the work orders tab', woHttp.status === 200 && Array.isArray(woHttp.body.workOrders) && !!woHttp.body.plant && woHttp.body.meta.queries <= 8);
  ok('orders view alone also opens it; a floor-only tablet gets 403; a bad date 422',
    (await get('/dashboard/work-orders', ['cf_erp_orders_view'])).status === 200 && (await get('/dashboard/work-orders', ['cf_erp_floor'])).status === 403
    && (await get('/dashboard/work-orders?to=nope', pv)).status === 422);
  ok('the full tree download is the same gate', (await get('/dashboard/orders/tree-rows', pv)).status === 200 && (await get('/dashboard/orders/tree-rows', ['cf_erp_floor'])).status === 403);
} catch (e) {
  console.error(e);
  exitCode = 1;
} finally {
  if (server) await new Promise((r) => server.close(r));
  try { await conn.rollback(); } catch { /* the error above is the one that matters */ }
  detachNodeCache(conn);
  conn.release();
}
const after = await counts();
const moved = before.filter((b) => after.find((a) => a.name === b.name)?.n !== b.n);
ok('every cf_ table is back to its count', moved.length === 0, moved.map((m) => m.name).join(', '));
await pool.end();
console.log(`\nRound trips: ${JSON.stringify(report)}`);
console.log(`\n${passed} passed, ${failed} failed${fails.length ? `\n  ${fails.join('\n  ')}` : ''}`);
process.exitCode = exitCode || (failed ? 1 : 0);
