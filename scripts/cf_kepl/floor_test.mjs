/**
 * floor_test.mjs — the machine log's backend (services/floorService.js,
 * routes/floor.js, init.sql §32; contract TM/CF_ERP_FLOOR_LOG_PLAN.md §2).
 * Against the local database.
 *
 *   cd multi_app_be && node scripts/cf_kepl/floor_test.mjs
 *   CF_FLOOR_COMPANY=2 CF_FLOOR_LINE=923 (the defaults: the local KEPL copy)
 *
 * EVERYTHING HAPPENS INSIDE ONE TRANSACTION THAT IS ROLLED BACK — the lock (if
 * the line is not locked yet), the confirm, the release, the operators, the
 * plan entries, the night shift, every session and stop — and the last thing
 * it does is re-count every cf_ table. The permission checks go through HTTP
 * on the pool and only READ or are refused before any write.
 *
 *   1. queue: eligible steps only, contractor steps out, done steps out, order
 *      (started → ready → waiting, then planner ship date …), search
 *   2. live: two steps together, pause, resume, finish with a count (the step
 *      progresses; done when complete), a stop with a reason, back to work
 *   3. refusals: overlaps, a done step, a machine not set up, a note missing
 *   4. the day from paper notes: work + stops + an edit + a delete → the right
 *      "not recorded" gaps and totals; counts corrected on the step
 *   5. a night shift crossing midnight stays one day
 *   6. back-dated `at` on events and the step (and the tracker's own start)
 *   7. readiness is flagged, never a gate (and the tracker's gate is unchanged)
 *   8. permission: a floor-only user records, and reaches no other write
 *   9. round trips of GET queue and GET day on the KEPL line
 */
import express from 'express';
import { pool } from '../../db.js';
import '../../apps/cf_erp/services/codegenProvider.js';
import { attachNodeCache, detachNodeCache } from '../../apps/cf_erp/lib/db.js';
import { lockLine } from '../../apps/cf_erp/services/lockService.js';
import { releaseLine, releaseCheck, liveReleaseOfLine, evaluatedTracker, startStep, recordProgress } from '../../apps/cf_erp/services/releaseService.js';
import { setOrderStatus } from '../../apps/cf_erp/services/salesOrderService.js';
import { createArea } from '../../apps/cf_erp/services/stockingAreaService.js';
import { operationsForMachine } from '../../apps/cf_erp/services/operationService.js';
import { createShift } from '../../apps/cf_erp/services/shiftService.js';
import * as F from '../../apps/cf_erp/services/floorService.js';
import { signToken } from '../../core/utils/jwt.js';

if (!/^(localhost|127\.0\.0\.1|::1)$/.test(process.env.DB_HOST ?? 'localhost')) throw new Error('This suite is local only.');
const COMPANY = Number(process.env.CF_FLOOR_COMPANY ?? 2);
const LINE = Number(process.env.CF_FLOOR_LINE ?? 923);
const TZ = 'Asia/Kolkata';
const tag = `FL${Date.now().toString(36).toUpperCase()}`;

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
const said = (e, re) => !!e && (re.test(e.message) || (e.problems ?? []).some((p) => re.test(p)));
/** Epoch seconds of a plant wall-clock time in India (+05:30, no DST). */
const istSec = (wall) => Math.floor((Date.parse(`${wall.replace(' ', 'T')}Z`) - 5.5 * 3600000) / 1000);

const [tables] = await pool.query("SELECT TABLE_NAME name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME LIKE 'cf\\_%' ORDER BY TABLE_NAME");
const counts = async () => (await pool.query(tables.map((t) => `SELECT '${t.name}' AS name,COUNT(*) AS n FROM \`${t.name}\``).join(' UNION ALL ')))[0];
const before = await counts();
const conn = await pool.getConnection();
let n = 0;
const db = new Proxy(conn, { get: (t, p) => (p === 'query' ? (...a) => { n++; return t.query(...a); } : Reflect.get(t, p)) });
const measured = async (fn) => { const at = n; const t0 = Date.now(); const result = await fn(); return { result, queries: n - at, ms: Date.now() - t0 }; };
const report = {};
let server = null;
let exitCode = 0;

try {
  await conn.beginTransaction();
  attachNodeCache(conn);
  const [[user]] = await conn.query('SELECT id FROM users WHERE company_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 1', [COMPANY]);
  const c = { companyId: COMPANY, userId: user?.id ?? null };
  const q1 = async (sql, args) => (await conn.query(sql, args))[0][0];

  /* ------------------------------------------------------------------------ */
  section('0. Setup inside the transaction: lock (if needed), confirm, release');
  const line = await q1(`SELECT l.id, l.line_no, l.locked_at, l.order_id, o.code AS order_code, o.status FROM cf_sales_order_lines l
                           JOIN cf_sales_orders o ON o.id = l.order_id WHERE l.company_id = ? AND l.id = ?`, [COMPANY, LINE]);
  if (!line) throw new Error(`Line ${LINE} is not a line of company ${COMPANY}.`);
  if (await liveReleaseOfLine(conn, COMPANY, LINE)) throw new Error(`Line ${LINE} is already released — this suite releases it itself.`);
  if (!line.locked_at) await lockLine(conn, c, LINE);
  if (line.status !== 'confirmed') {
    await conn.query("UPDATE cf_sales_orders SET committed_date = COALESCE(committed_date, '2026-12-31') WHERE company_id = ? AND id = ?", [COMPANY, line.order_id]);
    await setOrderStatus(conn, c, line.order_id, 'confirmed');
  }
  let check = await releaseCheck(conn, COMPANY, LINE);
  if (check.needsFinishedArea && !check.areas.some((a) => a.purpose === 'dispatch')) {
    await createArea(conn, c, { code: `${tag}-DSP`, name: `${tag} dispatch`, purpose: 'dispatch' });
    check = await releaseCheck(conn, COMPANY, LINE);
  }
  if (!check.ok) throw new Error(`The line cannot be released: ${check.problems.slice(0, 5).join(' | ')}`);
  const t0 = Date.now();
  const rel = await releaseLine(conn, c, LINE, check.needsFinishedArea ? { finishedAreaId: check.areas.find((a) => a.purpose === 'dispatch')?.id } : {});
  console.log(`  released ${line.order_code} line ${line.line_no}: ${rel.items.length} items (${Date.now() - t0} ms)`);
  // Paper notes from yesterday must be after the release: the release "happened" on 1 Sep.
  await conn.query("UPDATE cf_production_releases SET created_at = '2026-09-01 00:00:00' WHERE company_id = ? AND id = ?", [COMPANY, rel.id]);
  await conn.query('INSERT INTO cf_floor_settings (company_id, timezone) VALUES (?, ?) ON DUPLICATE KEY UPDATE timezone = VALUES(timezone)', [COMPANY, TZ]);
  ok('the plant clock is Asia/Kolkata for the run', (await F.getFloorSettings(conn, COMPANY)).timezone === TZ);

  // The machine with the most in-house work on this line.
  const data = await evaluatedTracker(conn, COMPANY, [rel.id]);
  const [machines] = await conn.query("SELECT * FROM cf_machines WHERE company_id = ? AND deleted_at IS NULL AND status = 'active' ORDER BY code", [COMPANY]);
  let best = null;
  for (const m of machines) {
    const elig = new Set((await operationsForMachine(conn, COMPANY, m)).filter((o) => o.eligible).map((o) => o.operation.id));
    const steps = data.steps.filter((s) => elig.has(s.operation_id) && s.state !== 'done' && !s.work_order_id);
    if (!best || steps.length > best.steps.length) best = { m, elig, steps };
  }
  const M = best.m;
  const elig = best.elig;
  console.log(`  machine ${M.code} (${M.id}): ${best.steps.length} steps it may do`);
  ok('a machine with work was found', best.steps.length >= 8, String(best.steps.length));
  const reasons = await F.listReasons(conn, COMPANY);
  ok('the twelve stop reasons are seeded', reasons.length === 12 && reasons.at(-1).code === 'OTHER' && reasons.at(-1).needsNote, reasons.map((r) => r.code).join(','));
  const reason = (code) => reasons.find((r) => r.code === code).id;
  const opA = await F.createOperator(conn, c, { name: `${tag} Ravi`, machineIds: [M.id] });
  const opB = await F.createOperator(conn, c, { name: `${tag} Anil`, code: `${tag}-B` });
  ok('an operator without a code gets OP-<id>', /^OP-\d{3,}$/.test(opA.code), opA.code);
  const ops = await F.listFloorOperators(conn, COMPANY, { machineId: M.id });
  ok('the machine\'s usual operator comes first', ops[0]?.id === opA.id && ops[0].usual === true && ops.some((o) => o.id === opB.id && !o.usual));

  /* ------------------------------------------------------------------------ */
  section('1. Queue: eligibility, order, contractor steps, search');
  const qm = await measured(() => F.machineQueue(db, COMPANY, M.id, { limit: 2000 }));
  report.queue = { queries: qm.queries, ms: qm.ms, total: qm.result.total };
  let queue = qm.result;
  const stepById = new Map(data.steps.map((s) => [s.id, s]));
  ok('every queued step is an operation this machine may do', queue.next.every((s) => elig.has(s.operationId)));
  ok('no done step and nothing on a work order is queued', queue.next.every((s) => s.state !== 'done' && !stepById.get(s.id).work_order_id));
  ok('the queue holds every eligible open step of the line', queue.total === best.steps.length, `${queue.total} vs ${best.steps.length}`);
  const group = (s) => (s.state === 'in_progress' ? 0 : s.ready ? 1 : 2);
  const monotone = queue.next.every((s, i, a) => i === 0 || group(a[i - 1]) <= group(s));
  ok('started, then ready, then waiting', monotone);
  ok('a waiting step says why in plain words', queue.next.filter((s) => !s.ready).every((s) => typeof s.why === 'string' && s.why.length > 5));
  ok('pieceCode is short (no order prefix) and pieceCodeFull keeps it', queue.next.every((s) => !s.pieceCodeFull || !s.pieceCode.startsWith(`${line.order_code}-`)));
  // Within a group with no plan: tree order, then sequence.
  const waiting = queue.next.filter((s) => group(s) === 2);
  // The planner's ship date pulls a piece forward: plan one late piece first.
  const late = waiting.at(-1) ?? queue.next.at(-1);
  const lateItem = await q1('SELECT pi.id, pi.order_piece_id, pi.parent_id FROM cf_production_steps s JOIN cf_production_items pi ON pi.id = s.production_item_id WHERE s.id = ?', [late.id]);
  let pieceId = lateItem.order_piece_id;
  if (!pieceId) pieceId = (await q1('SELECT order_piece_id FROM cf_production_items WHERE id = ?', [lateItem.parent_id]))?.order_piece_id;
  // Own the fixture: the line's existing plan is retired inside the transaction.
  await conn.query('UPDATE cf_plan_entries SET deleted_at = NOW() WHERE company_id = ? AND order_line_id = ? AND deleted_at IS NULL', [COMPANY, LINE]);
  await conn.query('INSERT INTO cf_plan_entries (company_id, order_line_id, unit_key, ship_date) VALUES (?, ?, ?, ?), (?, ?, ?, ?)',
    [COMPANY, LINE, `p${pieceId}`, '2026-10-01', COMPANY, LINE, `l${LINE}`, '2026-11-01']);
  queue = await F.machineQueue(conn, COMPANY, M.id, { limit: 2000 });
  const lateNow = queue.next.find((s) => s.id === late.id);
  const firstOfGroup = queue.next.find((s) => group(s) === group(lateNow));
  ok('a piece the planner ships first moves to the front of its group', lateNow.shipDate === '2026-10-01' && firstOfGroup.shipDate === '2026-10-01', `${lateNow.shipDate} / first ${firstOfGroup.id} ${firstOfGroup.shipDate}`);
  ok('the rest of the line takes the line\'s ship date', queue.next.filter((s) => s.shipDate !== '2026-10-01').every((s) => s.shipDate === '2026-11-01'));
  const inGroup = queue.next.filter((s) => group(s) === group(lateNow));
  ok('within a group, ship date comes before everything else', inGroup.every((s, i, a) => i === 0 || (a[i - 1].shipDate ?? '9') <= (s.shipDate ?? '9')));

  // A contractor takes one step: it leaves the queue.
  const party = (await conn.query('INSERT INTO cf_parties SET ?', { company_id: COMPANY, code: `${tag}-SUB`, name: `${tag} Sub`, is_subcontractor: 1 }))[0].insertId;
  const wo = (await conn.query('INSERT INTO cf_work_orders SET ?', { company_id: COMPANY, code: `${tag}-WO`, order_id: line.order_id, order_line_id: LINE, contractor_id: party, status: 'issued' }))[0].insertId;
  const contracted = queue.next[1];
  await conn.query('UPDATE cf_production_steps SET work_order_id = ? WHERE id = ?', [wo, contracted.id]);
  queue = await F.machineQueue(conn, COMPANY, M.id, { limit: 2000 });
  ok('a step on a contractor work order is not queued', !queue.next.some((s) => s.id === contracted.id) && queue.total === best.steps.length - 1);

  const someCode = queue.next.find((s) => s.pieceCodeFull)?.pieceCodeFull;
  const frag = someCode ? someCode.slice(-6) : null;
  const sq = await F.machineQueue(conn, COMPANY, M.id, { search: frag, limit: 2000 });
  ok('search matches part of the piece code', !!frag && sq.total > 0 && sq.next.every((s) => [s.pieceCodeFull, s.pieceName, s.pieceLabel, s.orderCode, s.operation, s.operationCode].some((t) => t && t.toLowerCase().includes(frag.toLowerCase()))), frag);
  const opWord = queue.next[0].operation.split(' ')[0];
  const so = await F.machineQueue(conn, COMPANY, M.id, { search: opWord.toLowerCase(), limit: 2000 });
  ok('search matches the operation, any case', so.total > 0 && so.total <= queue.total);
  const sc = await F.machineQueue(conn, COMPANY, M.id, { search: line.order_code, limit: 5 });
  ok('search by order code finds the line; limit caps the list but not the total', sc.next.length === 5 && sc.total === queue.total);

  /* ------------------------------------------------------------------------ */
  // The steps this run works: pending, on M, not the contracted one.
  const pool2 = queue.next.filter((s) => s.state === 'pending');
  const pick = (pred) => { const i = pool2.findIndex(pred); if (i < 0) return null; return pool2.splice(i, 1)[0]; };
  const notReady = queue.next.find((s) => !s.ready && s.state === 'pending');
  const S1 = pick((s) => s.id === notReady?.id) ?? pick(() => true);
  const S2 = pick(() => true);
  const T2 = pick(() => true);
  const T1 = pick(() => true);
  const T3 = pick(() => true);
  const T4 = pick(() => true);
  const U = pick(() => true);
  const V = pick((s) => !s.ready);
  const stepRow = async (id) => q1('SELECT *, UNIX_TIMESTAMP(started_at) AS st, UNIX_TIMESTAMP(finished_at) AS ft FROM cf_production_steps WHERE id = ?', [id]);
  const events = async (id) => (await conn.query('SELECT *, UNIX_TIMESTAMP(at) AS at_sec FROM cf_step_events WHERE step_id = ? ORDER BY id', [id]))[0];

  section('2. Live: two jobs together, pause, resume, finish, a stop, back to work');
  const started = await F.startWork(conn, c, { machineId: M.id, operatorId: opA.id, stepIds: [S1.id, S2.id] });
  ok('one session per step', started.started.length === 2 && started.now.running.length === 2);
  ok('both steps are in progress on the machine', (await stepRow(S1.id)).state === 'in_progress' && (await stepRow(S2.id)).machine_id === M.id);
  const e1 = (await events(S1.id))[0];
  ok('the start event carries the time, the operator and "live"', e1?.event === 'start' && e1.at != null && e1.operator_id === opA.id && e1.source === 'live'
    && e1.session_id === started.started.find((x) => x.stepId === S1.id).sessionId, JSON.stringify({ ...e1, created_at: undefined, updated_at: undefined }));
  ok('the running cards name the piece and operation', started.now.running.every((r) => r.step.pieceCodeFull && r.step.operation && r.startedAt && r.operator?.id === opA.id));
  const again = await refusal(() => F.startWork(conn, c, { machineId: M.id, operatorId: opA.id, stepIds: [S1.id] }));
  ok('a job already running cannot start twice', said(again, /already running/));
  let q = await F.machineQueue(conn, COMPANY, M.id);
  ok('the queue shows them as running, not as next', q.running.length === 2 && !q.next.some((s) => s.id === S1.id || s.id === S2.id));
  const sess1 = started.started.find((x) => x.stepId === S1.id).sessionId;
  const sess2 = started.started.find((x) => x.stepId === S2.id).sessionId;

  const paused = await F.pauseWork(conn, c, { sessionIds: [sess1] });
  ok('pause ends the span; the other job keeps running', paused.now.running.length === 1 && (await q1('SELECT end_kind FROM cf_work_sessions WHERE id = ?', [sess1])).end_kind === 'pause');
  ok('a paused step stays in progress', (await stepRow(S1.id)).state === 'in_progress');
  q = await F.machineQueue(conn, COMPANY, M.id, { limit: 2000 });
  const s1q = q.next.find((s) => s.id === S1.id);
  ok('the paused step is queued first, with the session to resume', s1q?.pausedSessionId === sess1 && q.next[0].id === S1.id);
  const resumed = await F.resumeWork(conn, c, { sessionIds: [sess1] });
  ok('resume opens a new span for the same step, machine and operator', resumed.resumed.length === 1 && resumed.now.running.length === 2 && resumed.now.running.some((r) => r.step.id === S1.id && r.operator?.id === opA.id));
  ok('resume writes no second start event', (await events(S1.id)).filter((e) => e.event === 'start').length === 1);
  const sess1b = resumed.resumed[0].sessionId;

  const s1 = await stepRow(S1.id);
  const fin = await F.finishWork(conn, c, { sessionId: sess1b, good: Number(s1.quantity), done: true });
  ok('finishing with every piece good makes the step done', fin.step.done === true && (await stepRow(S1.id)).state === 'done' && (await stepRow(S1.id)).ft != null);
  ok('the session keeps its count and ends done', (await q1('SELECT end_kind, qty_good FROM cf_work_sessions WHERE id = ?', [sess1b])).end_kind === 'done');
  const p1 = (await events(S1.id)).find((e) => e.event === 'progress');
  ok('the progress event has the count, the time and the session', Number(p1?.qty_good) === Number(s1.quantity) && p1.at != null && p1.session_id === sess1b);

  const fin2 = await F.finishWork(conn, c, { sessionId: sess2, good: 0, scrap: 1, done: false });
  ok('stopping without finishing records scrap and leaves the step in progress', fin2.step.state === 'in_progress' && Number((await stepRow(S2.id)).qty_scrap) === 1
    && (await q1('SELECT end_kind FROM cf_work_sessions WHERE id = ?', [sess2])).end_kind === 'stop');
  const tooMany = await refusal(async () => {
    const r = await F.startWork(conn, c, { machineId: M.id, operatorId: opB.id, stepIds: [S2.id] });
    return F.finishWork(conn, c, { sessionId: r.started[0].sessionId, good: Number(S2.qtyTotal) + 1 });
  });
  ok('more good pieces than are left is refused', said(tooMany, /more good/));
  const s2open = (await q1('SELECT id FROM cf_work_sessions WHERE step_id = ? AND ended_at IS NULL AND deleted_at IS NULL', [S2.id]))?.id;
  ok('an in-progress step can start again (a new span, by another operator)', !!s2open);

  const noNote = await refusal(() => F.startStop(conn, c, { machineId: M.id, reasonId: reason('OTHER') }));
  ok('"Other" needs a note', said(noNote, /needs a note/));
  const stop = await F.startStop(conn, c, { machineId: M.id, operatorId: opB.id, reasonId: reason('BREAKDOWN'), note: 'hydraulic leak' });
  ok('a stop pauses the job running on the machine', stop.pausedSessionIds.includes(s2open) && stop.now.running.length === 0 && stop.now.stop?.reason === 'Breakdown');
  const machinesNow = await F.listMachines(conn, COMPANY);
  const mRow = machinesNow.find((m) => m.id === M.id);
  ok('the machine list shows it stopped, with the reason', mRow.stopped === true && mRow.stopReason === 'Breakdown' && mRow.running === 0 && !!mRow.lastActivityAt);
  q = await F.machineQueue(conn, COMPANY, M.id, { limit: 10 });
  ok('the queue carries the open stop', q.stop?.reasonLabel === 'Breakdown' && !!q.stop.startedAt && q.stop.note === 'hydraulic leak');
  const twice = await refusal(() => F.startStop(conn, c, { machineId: M.id, reasonId: reason('POWER') }));
  ok('a stopped machine cannot stop again', said(twice, /already stopped/));
  const back = await F.endStop(conn, c, stop.now.stop.id);
  ok('back to work ends the stop', back.now.stop === null);
  const res2 = await F.resumeWork(conn, c, { sessionIds: [s2open] });
  const s2 = await stepRow(S2.id);
  const fin3 = await F.finishWork(conn, c, { sessionId: res2.resumed[0].sessionId, good: Number(s2.quantity) - Number(s2.qty_good), done: true });
  ok('the second job finishes done', fin3.step.done === true);
  // Starting work ends an open stop by itself.
  await F.startStop(conn, c, { machineId: M.id, reasonId: reason('CRANE') });
  const st2 = await F.startWork(conn, c, { machineId: M.id, operatorId: opA.id, stepIds: [U.id] });
  ok('starting a job ends the open stop (back to work)', st2.endedStop === true && st2.now.stop === null);
  await F.pauseWork(conn, c, { sessionIds: [st2.started[0].sessionId] });

  /* ------------------------------------------------------------------------ */
  section('3. Refusals');
  const doneAgain = await refusal(() => F.startWork(conn, c, { machineId: M.id, stepIds: [S1.id] }));
  ok('a done step takes no more work', said(doneAgain, /already done/));
  const other = data.steps.find((s) => !elig.has(s.operation_id) && s.state !== 'done');
  const notSetUp = await refusal(() => F.startWork(conn, c, { machineId: M.id, stepIds: [other.id] }));
  ok('a job this machine is not set up for is refused', said(notSetUp, /not set up/));
  const contractorStart = await refusal(() => F.startWork(conn, c, { machineId: M.id, stepIds: [contracted.id] }));
  ok('a contractor\'s step cannot be started on the floor', said(contractorStart, /contractor/));
  const future = await refusal(() => F.putDay(conn, c, M.id, { date: '2026-10-05', rows: [{ kind: 'stop', reasonId: reason('POWER'), start: '2026-10-05T09:00', end: '2026-10-05T10:00' }] }));
  ok('a day entry in the future is refused', said(future, /future/));

  /* ------------------------------------------------------------------------ */
  section('4. The day from paper notes (Tue 29 Sep, shift 08:00–17:00)');
  const D = '2026-09-29';
  // Every KEPL piece is one piece; T2 makes three here, so a count can be part of its quantity.
  await conn.query('UPDATE cf_production_steps SET quantity = 3 WHERE id = ?', [T2.id]);
  const T3row = await stepRow(T3.id);
  const put1 = await F.putDay(conn, c, M.id, {
    date: D, operatorId: opA.id,
    rows: [
      { kind: 'work', stepId: T1.id, start: `${D}T08:00`, end: `${D}T10:00`, good: 0 },
      { kind: 'work', stepId: T2.id, start: `${D}T09:00`, end: `${D}T11:30`, good: 0 },
      { kind: 'stop', reasonId: reason('BREAK'), start: `${D}T11:30`, end: `${D}T12:00` },
      { kind: 'work', stepId: T3.id, start: `${D}T12:00`, end: `${D}T14:00`, good: Number(T3row.quantity) },
      { kind: 'stop', reasonId: reason('NO_MATERIAL'), start: `${D}T15:00`, end: `${D}T16:00` },
    ],
  });
  const gaps = (day) => day.notRecorded.map((g) => `${g.start.slice(11, 16)}-${g.end.slice(11, 16)}`).join(',');
  ok('two jobs together are allowed (overlapping work rows)', put1.sessions.length === 3);
  ok('shifts come as full date-times', put1.shifts.length === 1 && put1.shifts[0].start === `${D}T08:00:00` && put1.shifts[0].end === `${D}T17:00:00`);
  ok('not recorded = shift minus work and stops', gaps(put1) === '14:00-15:00,16:00-17:00', gaps(put1));
  ok('totals: work 330, stopped 90, not recorded 120, shift 540',
    put1.totals.work === 330 && put1.totals.stopped === 90 && put1.totals.notRecorded === 120 && put1.totals.shift === 540, JSON.stringify(put1.totals));
  ok('T3 is done from the paper count', (await stepRow(T3.id)).state === 'done');
  ok('rows carry sessionId-style ids and camelCase times', put1.sessions.every((s) => s.id && s.stepId && s.startedAt && s.endedAt) && put1.stops.every((s) => s.id && s.startedAt && s.reasonId));

  const liveCount = async () => (await q1('SELECT (SELECT COUNT(*) FROM cf_work_sessions WHERE machine_id = ? AND deleted_at IS NULL) + (SELECT COUNT(*) FROM cf_machine_stops WHERE machine_id = ? AND deleted_at IS NULL) AS k', [M.id, M.id])).k;
  const beforeRefusals = await liveCount();
  const overlapStop = await refusal(() => F.putDay(conn, c, M.id, { date: D, rows: [{ kind: 'stop', reasonId: reason('POWER'), start: `${D}T10:00`, end: `${D}T10:30` }] }));
  ok('a stop over work is refused', said(overlapStop, /stopped or working/));
  const overlapStops = await refusal(() => F.putDay(conn, c, M.id, { date: D, rows: [{ kind: 'stop', reasonId: reason('POWER'), start: `${D}T15:30`, end: `${D}T16:30` }] }));
  ok('a stop over a stop is refused', said(overlapStops, /overlaps the stop/));
  const twiceStep = await refusal(() => F.putDay(conn, c, M.id, { date: D, rows: [{ kind: 'work', stepId: T1.id, start: `${D}T09:30`, end: `${D}T10:30` }] }));
  ok('the same job twice at once is refused', said(twiceStep, /twice/));
  const newOnDone = await refusal(() => F.putDay(conn, c, M.id, { date: D, rows: [{ kind: 'work', stepId: T3.id, start: `${D}T16:00`, end: `${D}T16:30` }] }));
  ok('new work on a done step is refused', said(newOnDone, /already done/));
  const backwards = await refusal(() => F.putDay(conn, c, M.id, { date: D, rows: [{ kind: 'stop', reasonId: reason('POWER'), start: `${D}T13:00`, end: `${D}T12:00` }] }));
  ok('From after To is refused', said(backwards, /before To/));
  const farAway = await refusal(() => F.putDay(conn, c, M.id, { date: D, rows: [{ kind: 'stop', reasonId: reason('POWER'), start: '2026-09-27T09:00', end: '2026-09-27T10:00' }] }));
  ok('a row two days off the date is refused', said(farAway, /not on/));
  const t3Session = put1.sessions.find((s) => s.stepId === T3.id);
  // (Deleting the row that finished a step now REOPENS it — section 8b.)
  ok('the T3 session is on the day', !!t3Session);
  ok('refused day entries wrote nothing', Number(await liveCount()) === Number(beforeRefusals));

  const noMat = put1.stops.find((s) => s.reasonCode === 'NO_MATERIAL');
  const brk = put1.stops.find((s) => s.reasonCode === 'BREAK');
  const t2Session = put1.sessions.find((s) => s.stepId === T2.id);
  const put2 = await F.putDay(conn, c, M.id, {
    date: D, operatorId: opA.id,
    rows: [
      { kind: 'stop', id: noMat.id, reasonId: reason('NO_MATERIAL'), start: `${D}T14:30`, end: `${D}T16:00` },
      { kind: 'work', id: t2Session.id, stepId: T2.id, start: `${D}T09:00`, end: `${D}T11:00`, good: 1 },
    ],
    deletedRows: [{ kind: 'stop', id: brk.id }],
  });
  ok('after the edit and the delete the gaps move', gaps(put2) === '11:00-12:00,14:00-14:30,16:00-17:00', gaps(put2));
  ok('totals add up to the shift', put2.totals.work + put2.totals.stopped + put2.totals.notRecorded === put2.totals.shift, JSON.stringify(put2.totals));
  const oldStop = await q1('SELECT deleted_at FROM cf_machine_stops WHERE id = ?', [noMat.id]);
  const newStop = await q1('SELECT * FROM cf_machine_stops WHERE replaces_id = ? AND deleted_at IS NULL', [noMat.id]);
  ok('an edit keeps history: old row retired, new row names it', oldStop.deleted_at != null && !!newStop);
  ok('the edited work row added its count to the step', Number((await stepRow(T2.id)).qty_good) === 1);
  const t2New = put2.sessions.find((s) => s.stepId === T2.id);
  const put3 = await F.putDay(conn, c, M.id, { date: D, rows: [{ kind: 'work', id: t2New.id, stepId: T2.id, start: `${D}T09:00`, end: `${D}T11:00`, good: 0 }] });
  const t2ev = await events(T2.id);
  ok('lowering a count is a correction on the step (not done)', Number((await stepRow(T2.id)).qty_good) === 0 && t2ev.some((e) => e.event === 'progress' && Number(e.qty_good) === -1));
  ok('an edit that changes only the count writes one event with the difference', t2ev.filter((e) => e.event === 'progress').length === 2);
  const put4 = await F.putDay(conn, c, M.id, { date: D, rows: [{ kind: 'work', id: put3.sessions.find((s) => s.stepId === T2.id).id, stepId: T2.id, start: `${D}T09:15`, end: `${D}T11:00`, good: 0 }] });
  ok('an edit of times only writes no count event', (await events(T2.id)).filter((e) => e.event === 'progress').length === 2 && put4.sessions.some((s) => s.stepId === T2.id && s.startedAt.endsWith('09:15:00')));
  const bareId = await refusal(() => F.putDay(conn, c, M.id, { date: D, deleted: [999999999] }));
  ok('a delete of an entry that is not this machine\'s is refused', said(bareId, /not one of/));

  /* ------------------------------------------------------------------------ */
  section('5. A night shift crossing midnight keeps one day');
  await createShift(conn, c, M.id, { name: `${tag} Night`, weekdays: ['mon'], startTime: '22:00', endTime: '06:00' });
  const N = '2026-09-28';
  const night = await F.putDay(conn, c, M.id, {
    date: N, operatorId: opB.id,
    rows: [
      { kind: 'work', stepId: T4.id, start: `${N}T22:30`, end: '2026-09-29T02:00', good: 0 },
      { kind: 'stop', reasonId: reason('POWER'), start: '2026-09-29T02:00', end: '2026-09-29T03:00' },
    ],
  });
  ok('Monday has its day shift and the night shift into Tuesday', night.shifts.length === 2 && night.shifts[1].start === `${N}T22:00:00` && night.shifts[1].end === '2026-09-29T06:00:00');
  ok('the work and the stop after midnight belong to Monday', night.sessions.some((s) => s.stepId === T4.id) && night.stops.some((s) => s.reasonCode === 'POWER'));
  ok('Monday not recorded: its day shift, 22:00–22:30 and 03:00–06:00', gaps(night) === '08:00-17:00,22:00-22:30,03:00-06:00', gaps(night));
  const tue = await F.getDay(conn, COMPANY, M.id, D);
  ok('Tuesday does not show Monday\'s night', !tue.sessions.some((s) => s.stepId === T4.id) && !tue.stops.some((s) => s.reasonCode === 'POWER'));
  ok('Tuesday is unchanged by it', gaps(tue) === gaps(put4) && tue.totals.shift === 540, `${gaps(tue)} vs ${gaps(put4)}`);

  /* ------------------------------------------------------------------------ */
  section('6. Back-dated `at`');
  const t1 = await stepRow(T1.id);
  const t1ev = (await events(T1.id)).find((e) => e.event === 'start');
  ok('the step started when the paper says (08:00 plant time)', Number(t1.st) === istSec(`${D} 08:00:00`), `${t1.st} vs ${istSec(`${D} 08:00:00`)}`);
  ok('its start event says so too, from the day entry', Number(t1ev.at_sec) === istSec(`${D} 08:00:00`) && t1ev.source === 'day_entry');
  ok('T3 finished at 14:00 plant time', Number((await stepRow(T3.id)).ft) === istSec(`${D} 14:00:00`));
  ok('T4 started on Monday night', Number((await stepRow(T4.id)).st) === istSec(`${N} 22:30:00`));
  // The tracker's own start takes `at` too.
  const futureAt = await refusal(() => startStep(conn, c, V?.id ?? U.id, { at: new Date(Date.now() + 3600000).toISOString(), allowNotReady: true }));
  ok('a start in the future is refused', said(futureAt, /future/));
  const early = await refusal(() => startStep(conn, c, V?.id ?? U.id, { at: '2026-08-01T00:00:00Z', allowNotReady: true }));
  ok('a start before the release is refused', said(early, /before the job was released/));
  const zoneless = await refusal(() => startStep(conn, c, V?.id ?? U.id, { at: '2026-09-29T10:00:00', allowNotReady: true }));
  ok('a time without its zone is refused', said(zoneless, /zone/));

  /* ------------------------------------------------------------------------ */
  section('7. Readiness is flagged, not a gate');
  const s1ready = started.started.find((x) => x.stepId === S1.id);
  if (notReady && S1.id === notReady.id) {
    ok('a waiting step started live is flagged, with the reason', s1ready.beforeReady === true && s1ready.why.length > 0
      && (await q1('SELECT before_ready FROM cf_work_sessions WHERE id = ?', [sess1])).before_ready === 1 && e1.before_ready === 1);
  } else ok('(no waiting step on this machine — flag not exercised live)', true);
  if (V) {
    const gate = await refusal(() => startStep(conn, c, V.id, {}));
    ok('the tracker still refuses a waiting step without allowNotReady', said(gate, /cannot start yet/));
    await startStep(conn, c, V.id, { at: '2026-09-29T03:00:00Z', allowNotReady: true, machineId: M.id });
    const vev = (await events(V.id)).find((e) => e.event === 'start');
    ok('with allowNotReady it starts, back-dated and flagged', Number(vev.at_sec) === Date.parse('2026-09-29T03:00:00Z') / 1000 && vev.before_ready === 1
      && Number((await stepRow(V.id)).st) === Date.parse('2026-09-29T03:00:00Z') / 1000);
    const v = await stepRow(V.id);
    await recordProgress(conn, c, V.id, { good: Number(v.quantity), at: '2026-09-29T04:00:00Z' });
    ok('recordProgress back-dates the event and finished_at', Number((await stepRow(V.id)).ft) === Date.parse('2026-09-29T04:00:00Z') / 1000
      && Number((await events(V.id)).find((e) => e.event === 'progress').at_sec) === Date.parse('2026-09-29T04:00:00Z') / 1000);
  } else ok('(no second waiting step — the tracker gate not exercised)', true);
  // A tracker start with no `at`: at stays NULL. With no ready step left, a waiting one through allowNotReady (still no `at`).
  const cand = pool2.find((s) => s.ready) ?? pool2[0];
  const old = await refusal(async () => {
    await startStep(conn, c, cand.id, cand.ready ? {} : { allowNotReady: true });
    const ev = (await events(cand.id))[0];
    if (ev.at !== null || ev.source !== null || ev.before_ready !== (cand.ready ? 0 : 1)) throw new Error('not identical');
    if (!(await stepRow(cand.id)).st) throw new Error('no started_at');
  });
  ok('a tracker start without `at` writes at NULL, source NULL, not flagged', old === null, old?.message);

  /* ------------------------------------------------------------------------ */
  section('8. Setup CRUD');
  const upd = await F.updateOperator(conn, c, opB.id, { name: `${tag} Anil K`, machineIds: [M.id], status: 'inactive' });
  ok('an operator is renamed, given a machine, made inactive', upd.name.endsWith('Anil K') && upd.machines.length === 1 && upd.status === 'inactive');
  ok('an inactive operator is not on the floor list', !(await F.listFloorOperators(conn, COMPANY, { machineId: M.id })).some((o) => o.id === opB.id));
  const inactiveStart = await refusal(() => F.startWork(conn, c, { machineId: M.id, operatorId: opB.id, stepIds: [T1.id] }));
  ok('an inactive operator cannot record', said(inactiveStart, /inactive/));
  await F.deleteOperator(conn, c, opB.id);
  ok('a deleted operator leaves the list', !(await F.listOperators(conn, COMPANY, { status: 'all' })).some((o) => o.id === opB.id));
  const r1 = await F.createStopReason(conn, c, { label: `${tag} Crane hook` });
  ok('a new reason gets a code and goes last', r1.code.startsWith(tag) && r1.sortOrder > 120);
  const r2 = await F.updateStopReason(conn, c, r1.id, { needsNote: true, status: 'inactive' });
  ok('a reason can need a note and be retired', r2.needsNote === true && r2.status === 'inactive' && !(await F.listReasons(conn, COMPANY)).some((r) => r.id === r1.id));
  await F.deleteStopReason(conn, c, r1.id);
  ok('a deleted reason leaves the setup list', !(await F.listStopReasons(conn, COMPANY, { status: 'all' })).some((r) => r.id === r1.id));

  /* ------------------------------------------------------------------------ */
  section('8b. Deleting / lowering the row that finished a job reopens it (Fri 25 Sep)');
  const D2 = '2026-09-25';
  // A pending step on M whose waiting steps (done | complete) are all untouched — and at least one exists.
  const dependentsOf = async (step) => (await conn.query(
    `SELECT DISTINCT s.id, s.state, s.started_at FROM cf_step_dependencies d JOIN cf_production_steps s ON s.id = d.step_id AND s.deleted_at IS NULL
      WHERE d.company_id = ? AND d.deleted_at IS NULL AND d.required IN ('done','complete') AND (d.target_step_id = ? OR d.target_item_id = ?)`,
    [COMPANY, step.id, step.production_item_id]))[0];
  let X = null; let Y = null;
  for (const s of pool2.filter((x) => x.id !== cand?.id)) {
    const row = await stepRow(s.id);
    if (row.state !== 'pending') continue;
    const deps = await dependentsOf(row);
    if (deps.length && deps.every((d) => d.state === 'pending' && !d.started_at)) { X = row; Y = deps[0]; break; }
  }
  ok('a pending step on the machine with an untouched next step was found', !!X && !!Y, X ? String(X.id) : 'none');
  await conn.query('UPDATE cf_production_steps SET quantity = 2 WHERE id = ?', [X.id]);
  const finish = await F.putDay(conn, c, M.id, { date: D2, operatorId: opA.id, rows: [{ kind: 'work', stepId: X.id, start: `${D2}T08:00`, end: `${D2}T09:00`, good: 2 }] });
  ok('the paper row finishes the step', (await stepRow(X.id)).state === 'done' && (await stepRow(X.id)).ft != null && (finish.reopened ?? []).length === 0);
  const xSess = finish.sessions.find((s) => s.stepId === X.id);
  const evBefore = (await events(X.id)).length;
  const del = await F.putDay(conn, c, M.id, { date: D2, operatorId: opA.id, deletedRows: [{ kind: 'work', id: xSess.id }] });
  let xr = await stepRow(X.id);
  ok('deleting it reopens the step: in progress, 0 good, finished_at cleared', xr.state === 'in_progress' && Number(xr.qty_good) === 0 && xr.finished_at === null && xr.started_at !== null,
    JSON.stringify({ state: xr.state, good: xr.qty_good, ft: xr.ft }));
  const reopenEv = (await events(X.id)).slice(evBefore);
  ok('one correction event says "Reopened", with the time, the operator and the source', reopenEv.length === 1 && reopenEv[0].event === 'progress' && Number(reopenEv[0].qty_good) === -2
    && /^Reopened/.test(reopenEv[0].note) && reopenEv[0].at != null && reopenEv[0].operator_id === opA.id && reopenEv[0].source === 'day_entry', JSON.stringify(reopenEv.map((e) => [e.event, e.qty_good, e.note, e.operator_id, e.source])));
  ok('the reply names the reopened job and what is left', del.reopened?.length === 1 && del.reopened[0].stepId === X.id && del.reopened[0].qtyLeft === 2 && del.reopened[0].state === 'in_progress', JSON.stringify(del.reopened));
  ok('the day totals: no work left, still adding up to the shift', del.totals.work === 0 && del.totals.work + del.totals.stopped + del.totals.notRecorded === del.totals.shift, JSON.stringify(del.totals));
  ok('the next step is still untouched', (await stepRow(Y.id)).state === 'pending');

  // Lowering the count: finish again, then 2 -> 1.
  const again2 = await F.putDay(conn, c, M.id, { date: D2, operatorId: opA.id, rows: [{ kind: 'work', stepId: X.id, start: `${D2}T08:00`, end: `${D2}T09:00`, good: 2 }] });
  ok('a new row on the reopened step finishes it again', (await stepRow(X.id)).state === 'done');
  const xSess2 = again2.sessions.find((s) => s.stepId === X.id);
  const lower = await F.putDay(conn, c, M.id, { date: D2, operatorId: opA.id, rows: [{ kind: 'work', id: xSess2.id, stepId: X.id, start: `${D2}T08:00`, end: `${D2}T09:00`, good: 1 }] });
  xr = await stepRow(X.id);
  ok('lowering the count reopens it with the right count (1 of 2)', xr.state === 'in_progress' && Number(xr.qty_good) === 1 && xr.finished_at === null && lower.reopened?.[0]?.qtyLeft === 1, JSON.stringify({ state: xr.state, good: xr.qty_good, r: lower.reopened }));
  const loweredSess = lower.sessions.find((s) => s.stepId === X.id);
  ok('the edited row no longer ends "done"', (await q1('SELECT end_kind FROM cf_work_sessions WHERE id = ?', [loweredSess.id])).end_kind === 'stop');
  ok('the day totals: the hour of work stays, adding up to the shift', lower.totals.work === 60 && lower.totals.work + lower.totals.stopped + lower.totals.notRecorded === lower.totals.shift, JSON.stringify(lower.totals));

  // Refused once the next step has started.
  await F.putDay(conn, c, M.id, { date: D2, operatorId: opA.id, rows: [{ kind: 'work', id: loweredSess.id, stepId: X.id, start: `${D2}T08:00`, end: `${D2}T09:00`, good: 2 }] });
  ok('raising it back finishes the step', (await stepRow(X.id)).state === 'done');
  await startStep(conn, c, Y.id, { allowNotReady: true });
  const usedRow = (await F.getDay(conn, COMPANY, M.id, D2)).sessions.find((s) => s.stepId === X.id);
  const liveBefore = await liveCount();
  const evBefore2 = (await events(X.id)).length;
  const usedDel = await refusal(() => F.putDay(conn, c, M.id, { date: D2, operatorId: opA.id, deletedRows: [{ kind: 'work', id: usedRow.id }] }));
  ok('deleting it once the next step started is refused in one plain sentence', usedDel?.message === F.REOPEN_USED_BY_NEXT && usedDel.problems?.length === 1 && usedDel.problems[0] === F.REOPEN_USED_BY_NEXT, usedDel?.message);
  const usedLower = await refusal(() => F.putDay(conn, c, M.id, { date: D2, operatorId: opA.id, rows: [{ kind: 'work', id: usedRow.id, stepId: X.id, start: `${D2}T08:00`, end: `${D2}T09:00`, good: 1 }] }));
  ok('… and so is lowering it', usedLower?.message === F.REOPEN_USED_BY_NEXT, usedLower?.message);
  ok('the refusals wrote nothing: still done, same entries, same history', (await stepRow(X.id)).state === 'done' && Number(await liveCount()) === Number(liveBefore) && (await events(X.id)).length === evBefore2);
  const timesOnly = await F.putDay(conn, c, M.id, { date: D2, operatorId: opA.id, rows: [{ kind: 'work', id: usedRow.id, stepId: X.id, start: `${D2}T08:15`, end: `${D2}T09:00`, good: 2 }] });
  ok('moving the times of that row (same count) is still allowed', (await stepRow(X.id)).state === 'done' && (timesOnly.reopened ?? []).length === 0);

  // Refused once the piece is in finished stock: the top piece's last step, logged on a machine that may do it.
  const [[top]] = await conn.query('SELECT id FROM cf_production_items WHERE company_id = ? AND release_id = ? AND parent_id IS NULL AND deleted_at IS NULL', [COMPANY, rel.id]);
  const [topSteps] = await conn.query('SELECT * FROM cf_production_steps WHERE production_item_id = ? AND deleted_at IS NULL ORDER BY sequence, id', [top.id]);
  const lastTop = topSteps.at(-1);
  let MT = null;
  for (const m of machines) if ((await operationsForMachine(conn, COMPANY, m)).some((o) => o.eligible && o.operation.id === lastTop.operation_id)) { MT = m; break; }
  ok('a machine that may do the top piece\'s last step was found', !!MT);
  // Everything before it is done (a fixture shortcut inside the transaction); the last one from paper.
  await conn.query("UPDATE cf_production_steps SET state = 'done', qty_good = quantity, started_at = COALESCE(started_at, NOW()), finished_at = NOW(), work_order_id = NULL WHERE production_item_id = ? AND id <> ?", [top.id, lastTop.id]);
  await conn.query('UPDATE cf_production_steps SET work_order_id = NULL WHERE id = ?', [lastTop.id]);
  const topDay = await F.putDay(conn, c, MT.id, { date: D2, operatorId: opA.id, rows: [{ kind: 'work', stepId: lastTop.id, start: `${D2}T10:00`, end: `${D2}T11:00`, good: Number(lastTop.quantity) }] });
  const stocked = await q1('SELECT stocked_qty FROM cf_production_items WHERE id = ?', [top.id]);
  ok('finishing the top piece receives it into finished stock', (await stepRow(lastTop.id)).state === 'done' && Number(stocked.stocked_qty) > 0, String(stocked.stocked_qty));
  const topRow = topDay.sessions.find((s) => s.stepId === lastTop.id);
  const stockDel = await refusal(() => F.putDay(conn, c, MT.id, { date: D2, operatorId: opA.id, deletedRows: [{ kind: 'work', id: topRow.id }] }));
  ok('deleting it is refused: the piece is in finished stock', stockDel?.message === F.REOPEN_IN_STOCK && stockDel.problems?.[0] === F.REOPEN_IN_STOCK, stockDel?.message);
  ok('the top step stays done', (await stepRow(lastTop.id)).state === 'done');

  /* ------------------------------------------------------------------------ */
  section('9. Round trips on the KEPL line');
  const dm = await measured(() => F.getDay(db, COMPANY, M.id, D));
  report.day = { queries: dm.queries, ms: dm.ms };
  const qm2 = await measured(() => F.machineQueue(db, COMPANY, M.id));
  report.queueWarm = { queries: qm2.queries, ms: qm2.ms, total: qm2.result.total };
  ok(`GET day takes at most 12 round trips (took ${dm.queries})`, dm.queries <= 12);
  ok(`GET queue takes a fixed handful (took ${qm2.queries})`, qm2.queries <= 20);
  const mm = await measured(() => F.listMachines(db, COMPANY));
  report.machines = { queries: mm.queries };
  console.log(`  GET queue: ${report.queue.queries} round trips first call (${report.queue.ms} ms, ${report.queue.total} steps), ${qm2.queries} warm (${qm2.ms} ms)`);
  console.log(`  GET day:   ${dm.queries} round trips (${dm.ms} ms)`);
  console.log(`  GET machines: ${mm.queries} round trips`);
  report.sampleQueue = { ...qm2.result, next: qm2.result.next.slice(0, 2) };
  report.sampleDay = put2;

  /* ------------------------------------------------------------------------ */
  section('10. Permission (HTTP, reads and refusals only)');
  const { default: cfRouter } = await import('../../apps/cf_erp/routes/index.js');
  const app = express();
  app.use(express.json());
  app.use('/x', cfRouter);
  server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/x`;
  const token = (perms, role = 'operator') => signToken({ id: user?.id ?? 1, companyId: COMPANY, role, uiPermissions: perms });
  const call = async (method, path, perms, body) => {
    const r = await fetch(`${base}${path}`, { method, headers: { Authorization: `Bearer ${token(perms)}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return r.status;
  };
  const floorOnly = ['cf_erp_floor'];
  ok('a floor-only user reads the machines', await call('GET', '/floor/machines', floorOnly) === 200);
  ok('a floor-only user reads the reasons and operators', await call('GET', '/floor/reasons', floorOnly) === 200 && await call('GET', '/floor/operators', floorOnly) === 200);
  ok('a floor-only user reads a machine\'s day', await call('GET', `/floor/machines/${M.id}/day?date=${D}`, floorOnly) === 200);
  const rec = await call('POST', '/floor/start', floorOnly, {});
  ok('a floor-only user passes the gate to record (refused only for the empty body)', rec !== 401 && rec !== 403 && rec < 500, String(rec));
  const pday = await call('PUT', `/floor/machines/${M.id}/day`, floorOnly, { date: D });
  ok('… and to enter a day', pday === 422, String(pday));
  ok('a floor-only user cannot start a step in the tracker', await call('POST', `/production-steps/${T1.id}/start`, floorOnly, {}) === 403);
  ok('a floor-only user cannot change operators or reasons', await call('POST', '/operators', floorOnly, { name: 'x' }) === 403 && await call('DELETE', `/stop-reasons/${reasons[0].id}`, floorOnly) === 403);
  ok('a floor-only user cannot change the plan, the plant clock or the tracker', await call('PUT', '/planner/targets', floorOnly, {}) === 403
    && await call('PUT', '/floor/settings', floorOnly, { timezone: 'UTC' }) === 403 && await call('GET', '/tracker/steps', floorOnly) === 403);
  ok('someone with neither grant cannot read the floor', await call('GET', '/floor/machines', ['cf_erp_catalog_view']) === 403);
  ok('production manage also passes the floor gate', await call('GET', '/floor/reasons', ['cf_erp_production_manage']) === 200);
  const grant = await q1(`SELECT COUNT(*) AS k FROM role_capability rc JOIN features_capability fc ON fc.capability_id = rc.capability_id
                           WHERE fc.name = 'cf_erp_floor' AND rc.deleted_at IS NULL`);
  const pm = await q1(`SELECT COUNT(*) AS k FROM role_capability rc JOIN features_capability fc ON fc.capability_id = rc.capability_id
                        WHERE fc.name = 'cf_erp_production_manage' AND rc.deleted_at IS NULL
                          AND NOT EXISTS (SELECT 1 FROM role_capability x JOIN features_capability f2 ON f2.capability_id = x.capability_id
                                           WHERE f2.name = 'cf_erp_floor' AND x.deleted_at IS NULL AND x.role_id <=> rc.role_id AND x.team_id <=> rc.team_id
                                             AND x.company_id <=> rc.company_id AND x.app_id <=> rc.app_id)`);
  ok('every role with production manage also holds cf_erp_floor (init.sql §32)', Number(pm.k) === 0 && Number(grant.k) > 0, `${pm.k} without, ${grant.k} grants`);
} catch (err) {
  exitCode = 1;
  console.error(`\nERROR: ${err.stack ?? err.message}${err.problems?.length ? `\n  ${err.problems.slice(0, 10).join('\n  ')}` : ''}`);
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
if (process.env.CF_FLOOR_SAMPLE) {
  const fs = await import('fs');
  fs.writeFileSync(process.env.CF_FLOOR_SAMPLE, JSON.stringify({ queue: report.sampleQueue, day: report.sampleDay }, null, 2));
}
console.log(`\nRound trips: ${JSON.stringify({ queue: report.queue, queueWarm: report.queueWarm, day: report.day, machines: report.machines })}`);
console.log(`\n${passed} passed, ${failed} failed${fails.length ? `\n  ${fails.join('\n  ')}` : ''}`);
process.exitCode = exitCode || (failed ? 1 : 0);
