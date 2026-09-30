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
 *   2. a night shift crossing midnight belongs to the day it starts; the
 *      previous night's tail is not in the period
 *   3. output: operations done, pieces, tonnes (piece WEIGHT × good), standard minutes
 *   4. status now: running / stopped / off shift
 *   5. by order: progress (the line's steps, minutes or count), pace forecast,
 *      plan forecast, risk (late / at risk / on track), hold reasons, material,
 *      money (rate × weight), period gain
 *   6. risk rules, pure
 *   7. round trips: a fixed handful whatever the size (the KEPL line: ~17k steps)
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

  // Two machines with shifts of our own: a day shift and a night shift, every day.
  const [M, M2] = await qa("SELECT id, code FROM cf_machines WHERE company_id = ? AND deleted_at IS NULL AND status = 'active' ORDER BY code LIMIT 2", [COMPANY]);
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
  const other = md.machines.find((m) => m.id !== M.id && m.id !== M2.id && m.hasShifts);
  ok('a machine with shifts and no log reads 0 % run and its whole shift not recorded', !other || (other.runMin === 0 && other.notRecordedMin === other.shiftMin));
  const bad = await (async () => { try { await D.machinesDashboard(conn, COMPANY, { from: D2, to: D1 }); return null; } catch (e) { return e; } })();
  ok('to before from is refused', !!bad && /before/.test(bad.message));
  const long = await (async () => { try { await D.machinesDashboard(conn, COMPANY, { from: '2026-01-01', to: '2026-09-01' }); return null; } catch (e) { return e; } })();
  ok('more than 92 days is refused', !!long && /92/.test(long.message));

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
  section('7. Round trips (whatever the number of machines, orders or steps)');
  const w1 = await D.machinesDashboard(conn, COMPANY, { from: addDays(today, -29), to: today });
  const w2 = await D.ordersDashboard(conn, COMPANY, { from: addDays(today, -29), to: today });
  ok(`GET machines: ≤ 10 reads in ≤ 2 stages (took ${w1.meta.queries} in ${w1.meta.stages})`, w1.meta.queries <= 10 && w1.meta.stages <= 2);
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
