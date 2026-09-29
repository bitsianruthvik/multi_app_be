/**
 * floorService.js — the machine log (TM/CF_ERP_FLOOR_LOG_PLAN.md, init.sql §32).
 *
 * The user (2026-09-30): "a very easy way to enter, per machine, what work
 * happened and the blocks of time when no work happened, with a reason from a
 * list." A worker notes the day on paper and enters it at the machine at the
 * end of the day, or records it live: start, pause, stop. Several jobs can run
 * together. Work = one operation on one coded piece (a production step).
 *
 * What it keeps:
 *   work session  one continuous span of ONE step on ONE machine (cf_work_sessions)
 *   stop          a span the machine stood still, with a reason (cf_machine_stops)
 *   quantities    stay on the step — finishing a session with a count records
 *                 progress exactly as the tracker does (same rules: done when
 *                 the good ones reach the quantity, never more than is left)
 *
 * TWO CLOCKS. Sessions, stops and shifts are the PLANT's clock — full local
 * date-times ("store FULL date-times, never wall-clock times: night shifts
 * cross midnight"). The step's started_at / finished_at and cf_step_events.at
 * stay in the frame NOW() writes, as the tracker always has; a plant time is
 * turned into an instant with the plant's zone (cf_floor_settings) and written
 * with FROM_UNIXTIME, which lands in NOW()'s frame on every host.
 *
 * Rules that came from the user, in one place:
 *   - Readiness is NOT a gate for logging actuals: work recorded on a step the
 *     system thought "waiting" is saved and flagged before_ready. A done step
 *     takes no more work; a step on hold is resumed first.
 *   - Deleting / lowering the row that finished a step REOPENS it (lead,
 *     2026-09-30) — unless a step waiting for it has started or its piece is
 *     already in finished stock: then a supervisor corrects it.
 *   - A stop never overlaps work on the same machine, nor another stop. Work
 *     sessions of different steps may overlap (jobs together); one step has at
 *     most one open session, and never two overlapping spans on one machine.
 *   - A gap may stay unexplained ("not recorded" is shown, never forced), and
 *     reasons belong to the machine's time, not to a person.
 *   - Steps on a contractor work order are not in-house work: never queued.
 *
 * Round trips matter (TiDB ~49 ms each): every write is set-based — a fixed
 * handful of statements whatever the number of rows; the day read is ~7.
 */
import { invalid, notFound, conflict, assertNoProblems } from '../lib/errors.js';
import { insertRows } from '../lib/db.js';
import { evaluatedTracker, openReleaseIds, stockFinished } from './releaseService.js';
import { operationsForMachine } from './operationService.js';
import { machineCalendar } from './shiftService.js';
import { LOCKED_ORDER_STATUSES } from './records.js';

const EPS = 1e-9;
const round6 = (n) => Number(Number(n).toFixed(6));
const fmt = (n) => String(round6(n));
const blank = (v) => v == null || String(v).trim() === '';
const MIN = 60000;
const DAY_MS = 86400000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const WALL_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?$/;
const ZONED_RE = /(Z|[+-]\d{2}:?\d{2})$/i;

/** The plan's twelve (init.sql §32 seeds the same list) — for a company set up later. */
export const DEFAULT_STOP_REASONS = [
  ['NO_MATERIAL', 'No material'], ['CRANE', 'Waiting for crane'], ['PREV_JOB', 'Waiting for previous job'],
  ['BREAKDOWN', 'Breakdown'], ['POWER', 'Power cut'], ['NO_OPERATOR', 'No operator'], ['SETUP', 'Setup / changeover'],
  ['BREAK', 'Meal / tea break'], ['QUALITY', 'Quality hold'], ['DRAWING', 'Waiting for drawing'],
  ['CLEANING', 'Cleaning / maintenance'], ['OTHER', 'Other'],
].map(([code, label], i) => ({ code, label, sortOrder: (i + 1) * 10, needsNote: code === 'OTHER' }));

/** Every tenant today is in India; a company elsewhere sets cf_floor_settings.timezone. */
export const DEFAULT_TIMEZONE = process.env.CF_PLANT_TIMEZONE || 'Asia/Kolkata';
const DAY_SLACK_MS = 12 * 3600000;     // a day entry may reach 12 h either side of its date
const STOP_SINCE_MAX_MS = DAY_MS;      // a live stop may start up to a day back

// --- the plant clock ------------------------------------------------------------

const zoneCache = new Map();           // companyId -> { tz, until }
const validZone = (tz) => { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; } };

async function plantZone(db, companyId) {
  const hit = zoneCache.get(companyId);
  if (hit && hit.until > Date.now()) return hit.tz;
  const [[row]] = await db.query('SELECT timezone FROM cf_floor_settings WHERE company_id = ?', [companyId]);
  const tz = row && validZone(row.timezone) ? row.timezone : DEFAULT_TIMEZONE;
  zoneCache.set(companyId, { tz, until: Date.now() + 60000 });
  return tz;
}

const pad = (n, w = 2) => String(n).padStart(w, '0');
const partsCache = new Map();
function zoneParts(ms, tz) {
  let f = partsCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    partsCache.set(tz, f);
  }
  const o = {};
  for (const p of f.formatToParts(new Date(ms))) o[p.type] = p.value;
  return o;
}
/** An instant (epoch ms) as the plant's wall clock, 'YYYY-MM-DD HH:MM:SS'. */
export function wallOf(ms, tz) {
  const o = zoneParts(ms, tz);
  return `${o.year}-${o.month}-${o.day} ${o.hour === '24' ? '00' : o.hour}:${o.minute}:${o.second}`;
}
/** A wall-clock text on a zone-free number line (ms) — for interval arithmetic only. */
const wms = (wall) => Date.parse(`${String(wall).replace(' ', 'T')}Z`);
const wallOfWms = (n) => new Date(n).toISOString().slice(0, 19).replace('T', ' ');
/** The instant (epoch ms) a plant wall-clock time names. */
export function epochOfWall(wall, tz) {
  const guess = wms(wall);
  let t = guess;
  for (let i = 0; i < 2; i++) t = guess - (wms(wallOf(t, tz)) - t);
  return t;
}
/** A DATETIME the driver read (timezone 'Z': its UTC fields ARE the stored wall clock) as ISO text. */
const iso = (d) => (d == null ? null : d instanceof Date ? d.toISOString().slice(0, 19) : String(d).replace(' ', 'T').slice(0, 19));
const wallOfDb = (d) => (d == null ? null : d instanceof Date ? d.toISOString().slice(0, 19).replace('T', ' ') : String(d).replace('T', ' ').slice(0, 19));

/**
 * A time from the floor screens: the plant's wall clock ('YYYY-MM-DDTHH:MM[:SS]'),
 * or an instant carrying its zone (Z / ±hh:mm), turned into the plant's clock.
 */
function readWall(raw, label, problems, tz) {
  if (blank(raw)) { problems.push(`${label} is required.`); return null; }
  const s = String(raw).trim();
  if (ZONED_RE.test(s)) {
    const ms = Date.parse(s);
    if (!Number.isFinite(ms)) { problems.push(`${label} is not a date and time.`); return null; }
    return wallOf(ms, tz);
  }
  const m = WALL_RE.exec(s);
  if (!m) { problems.push(`${label} is a date and time, YYYY-MM-DDTHH:MM.`); return null; }
  const wall = `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6] ?? '00'}`;
  if (!Number.isFinite(wms(wall)) || wallOfWms(wms(wall)) !== wall) { problems.push(`${label} is not a real date and time.`); return null; }
  return wall;
}

const minutesBetween = (a, b) => Math.max(0, Math.round((b - a) / MIN));

/** The union of [s, e) intervals (numbers), merged and sorted. */
function union(intervals) {
  const xs = intervals.filter(([s, e]) => e > s).sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [s, e] of xs) {
    const last = out[out.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}
const total = (xs) => xs.reduce((t, [s, e]) => t + (e - s), 0);
/** [s, e) minus a sorted, merged union. */
function subtract([s, e], covered) {
  const out = [];
  let at = s;
  for (const [cs, ce] of covered) {
    if (ce <= at) continue;
    if (cs >= e) break;
    if (cs > at) out.push([at, Math.min(cs, e)]);
    at = Math.max(at, ce);
    if (at >= e) break;
  }
  if (at < e) out.push([at, e]);
  return out;
}

// --- shared reads ---------------------------------------------------------------

async function requireActiveMachine(db, companyId, raw) {
  const id = Number(raw);
  if (blank(raw) || !Number.isInteger(id) || id <= 0) throw invalid('INVALID', 'Choose the machine.');
  const [[m]] = await db.query(
    `SELECT m.*, n.name AS type_name FROM cf_machines m JOIN cf_classification_nodes n ON n.id = m.classification_id
      WHERE m.company_id = ? AND m.id = ? AND m.deleted_at IS NULL`,
    [companyId, id],
  );
  if (!m) throw notFound('Machine');
  if (m.status !== 'active') throw invalid('INVALID', `${m.code} is inactive.`);
  return m;
}

async function optionalOperator(db, companyId, raw) {
  if (blank(raw)) return null;
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw invalid('INVALID', 'Choose who you are from the list.');
  const [[o]] = await db.query('SELECT id, name, status FROM cf_operators WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [companyId, id]);
  if (!o) throw invalid('INVALID', 'That operator is not on the list.');
  if (o.status !== 'active') throw invalid('INVALID', `${o.name} is marked inactive.`);
  return o;
}

/** Operation ids this machine may do (cf_operation_machine_rules, the same precedence as start). */
async function eligibleOperations(db, companyId, machine) {
  const ops = await operationsForMachine(db, companyId, machine);
  return new Set(ops.filter((o) => o.eligible).map((o) => o.operation.id));
}

const STEP_SQL = `SELECT s.*, pi.release_id, pi.parent_id AS item_parent_id, pi.stocked_qty AS item_stocked_qty, pi.code AS piece_code, m.name AS piece_name,
         UNIX_TIMESTAMP(r.created_at) AS release_epoch, r.order_id, o.code AS order_code, o.status AS order_status,
         op.code AS op_code, op.name AS op_name, mc.code AS step_machine_code
    FROM cf_production_steps s
    JOIN cf_production_items pi ON pi.id = s.production_item_id AND pi.deleted_at IS NULL
    JOIN cf_production_releases r ON r.id = pi.release_id AND r.deleted_at IS NULL
    JOIN cf_sales_orders o ON o.id = r.order_id
    JOIN cf_master_records m ON m.id = pi.item_id
    JOIN cf_operations op ON op.id = s.operation_id
    LEFT JOIN cf_machines mc ON mc.id = s.machine_id`;

/** The steps a write touches, row-locked, all in one read. Missing ids are a 404. */
async function lockSteps(db, companyId, ids) {
  const want = [...new Set(ids.map(Number))];
  if (!want.length) return new Map();
  const [rows] = await db.query(`${STEP_SQL} WHERE s.company_id = ? AND s.id IN (?) AND s.deleted_at IS NULL FOR UPDATE`, [companyId, want]);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const missing = want.filter((id) => !byId.has(id));
  if (missing.length) throw notFound(missing.length === 1 ? `Step ${missing[0]}` : `Steps ${missing.join(', ')}`);
  return byId;
}

const shortCode = (code, orderCode) => {
  if (!code) return null;
  const prefix = orderCode ? `${orderCode}-` : null;
  return prefix && code.startsWith(prefix) && code.length > prefix.length ? code.slice(prefix.length) : code;
};

/** Refusals shared by every way work is recorded on a step. */
function stepProblem(s, machine, eligible) {
  const name = `${s.piece_code ?? s.piece_name} · ${s.op_name}`;
  if (LOCKED_ORDER_STATUSES.has(s.order_status)) return `${name}: order ${s.order_code} is ${s.order_status} — nothing more is recorded on it.`;
  if (s.work_order_id) return `${name} is on a contractor work order — it is not done in-house.`;
  if (s.state === 'on_hold') return `${name} is on hold — resume it first.`;
  if (eligible && !eligible.has(s.operation_id)) return `${machine.code} is not set up to do ${s.op_name} (${s.op_code}).`;
  return null;
}

/** Status of the given steps as the tracker works it out (ready / not_ready / …) and the first reason. */
async function readinessOf(db, companyId, steps) {
  const releaseIds = [...new Set(steps.map((s) => s.release_id))];
  const out = new Map();
  if (!releaseIds.length) return out;
  const data = await evaluatedTracker(db, companyId, releaseIds);
  const want = new Set(steps.map((s) => s.id));
  for (const s of data?.steps ?? []) if (want.has(s.id)) out.set(s.id, { status: s._status, why: s._blockers?.map((b) => b.text) ?? [] });
  return out;
}

// --- step changes, set-based ------------------------------------------------------

/**
 * Applies work to steps in a fixed number of statements, whatever the count:
 *   starts   [{ step, atSec, sessionId, operatorId, source, machineId, beforeReady }]
 *            a pending step goes in progress (started_at = atSec); a started
 *            one only moves its started_at earlier when atSec is before it
 *   counts   [{ step, good, scrap, atSec, sessionId, operatorId, source, machineId, note }]
 *            deltas (a correction may be negative) — the same rules as
 *            recordProgress: never more good than is left, done when it reaches
 *            the quantity (finished_at = atSec), scrap does not count
 * Returns the ids of steps that became done. The piece a line SELLS goes into
 * stock when its last step is done (stockFinished), as with the tracker.
 */
async function applyStepChanges(db, c, { starts = [], counts = [] }) {
  const events = [];
  const startBy = new Map();
  for (const x of starts) {
    const cur = startBy.get(x.step.id);
    if (!cur || x.atSec < cur.atSec) startBy.set(x.step.id, x);
  }
  // Start: pending -> in progress; the earliest start wins.
  if (startBy.size) {
    const list = [...startBy.values()];
    const ids = list.map((x) => x.step.id);
    const caseAt = list.map(() => 'WHEN ? THEN FROM_UNIXTIME(?)').join(' ');
    const caseMachine = list.map(() => 'WHEN ? THEN ?').join(' ');
    await db.query(
      `UPDATE cf_production_steps
          SET started_at = CASE WHEN started_at IS NULL THEN (CASE id ${caseAt} END)
                                ELSE LEAST(started_at, CASE id ${caseAt} END) END,
              machine_id = CASE WHEN state = 'pending' THEN (CASE id ${caseMachine} END) ELSE machine_id END,
              state = CASE WHEN state = 'pending' THEN 'in_progress' ELSE state END
        WHERE company_id = ? AND id IN (?)`,
      [...list.flatMap((x) => [x.step.id, x.atSec]), ...list.flatMap((x) => [x.step.id, x.atSec]),
        ...list.flatMap((x) => [x.step.id, x.machineId]), c.companyId, ids],
    );
    for (const x of list) {
      if (x.step.state !== 'pending') continue;
      events.push([c.companyId, x.step.id, 'start', 0, 0, x.machineId, null, c.userId, x.atSec, x.operatorId, x.source, x.sessionId, x.beforeReady ? 1 : 0]);
      x.step.state = 'in_progress';
    }
  }
  // Counts, summed per step; one UPDATE for all of them.
  const doneNow = [];
  const byStep = new Map();
  for (const x of counts) {
    if (Math.abs(x.good) <= EPS && Math.abs(x.scrap) <= EPS) continue;
    if (!byStep.has(x.step.id)) byStep.set(x.step.id, { step: x.step, good: 0, scrap: 0, lastAt: x.atSec });
    const g = byStep.get(x.step.id);
    g.good = round6(g.good + x.good);
    g.scrap = round6(g.scrap + x.scrap);
    g.lastAt = Math.max(g.lastAt, x.atSec);
    events.push([c.companyId, x.step.id, 'progress', round6(x.good), round6(x.scrap), x.machineId, x.note ?? null, c.userId, x.atSec, x.operatorId, x.source, x.sessionId, 0]);
  }
  if (byStep.size) {
    const list = [...byStep.values()];
    for (const g of list) {
      g.newGood = round6(Number(g.step.qty_good) + g.good);
      g.newScrap = round6(Math.max(0, Number(g.step.qty_scrap) + g.scrap));
      g.done = g.newGood >= Number(g.step.quantity) - EPS;
      if (g.done) doneNow.push(g.step);
    }
    const when = (f) => list.flatMap((g) => [g.step.id, f(g)]);
    await db.query(
      `UPDATE cf_production_steps
          SET qty_good = CASE id ${list.map(() => 'WHEN ? THEN ?').join(' ')} END,
              qty_scrap = CASE id ${list.map(() => 'WHEN ? THEN ?').join(' ')} END,
              state = CASE id ${list.map(() => 'WHEN ? THEN ?').join(' ')} END,
              finished_at = CASE id ${list.map(() => 'WHEN ? THEN FROM_UNIXTIME(?)').join(' ')} END
        WHERE company_id = ? AND id IN (?)`,
      [...when((g) => g.newGood), ...when((g) => g.newScrap), ...when((g) => (g.done ? 'done' : 'in_progress')),
        ...list.flatMap((g) => [g.step.id, g.done ? g.lastAt : null]), c.companyId, list.map((g) => g.step.id)],
    );
    for (const g of list) { g.step.qty_good = g.newGood; g.step.qty_scrap = g.newScrap; g.step.state = g.done ? 'done' : 'in_progress'; }
  }
  if (events.length) {
    const cols = ['company_id', 'step_id', 'event', 'qty_good', 'qty_scrap', 'machine_id', 'note', 'created_by', 'at', 'operator_id', 'source', 'session_id', 'before_ready'];
    const holes = `(${cols.map((k) => (k === 'at' ? 'FROM_UNIXTIME(?)' : '?')).join(', ')})`;
    for (let i = 0; i < events.length; i += 500) {
      const part = events.slice(i, i + 500);
      await db.query(`INSERT INTO cf_step_events (${cols.join(', ')}) VALUES ${part.map(() => holes).join(', ')}`, part.flat());
    }
  }
  // Only the piece a line sells becomes stock, and only when all its steps are done.
  const tops = [...new Set(doneNow.filter((s) => s.item_parent_id == null).map((s) => s.production_item_id))];
  for (const itemId of tops) await stockFinished(db, c, itemId);
  return doneNow.map((s) => s.id);
}

/**
 * The count rules on one step's summed change, before anything is written:
 * never below zero, never more good than the quantity, and no new work on a
 * done step. A count going DOWN on a done step is not refused here — it
 * REOPENS the step, and reopenProblems() decides whether that is allowed.
 */
function countProblem(step, good, scrap, { newWork }) {
  const name = `${step.piece_code ?? step.piece_name} · ${step.op_name}`;
  const qty = Number(step.quantity);
  const have = Number(step.qty_good);
  if (step.state === 'done' && newWork) return `${name} is already done — it takes no more work.`;
  if (have + good < -EPS) return `${name}: that would leave fewer than none good.`;
  if (Number(step.qty_scrap) + scrap < -EPS) return `${name}: that would leave fewer than none scrapped.`;
  const left = round6(qty - have);
  if (good > left + EPS) return `${name}: only ${fmt(left)} more good ${left === 1 ? 'piece is' : 'pieces are'} needed at this step.`;
  return null;
}

/** The floor screen shows these as they are (lead, 2026-09-30) — one plain sentence each. */
export const REOPEN_USED_BY_NEXT = 'This job is already used by the next step — ask a supervisor to correct it.';
export const REOPEN_IN_STOCK = 'This piece is already in finished stock — ask a supervisor to correct it.';

/**
 * A lower count on a DONE step (a paper row deleted, or its count lowered)
 * REOPENS it: done -> in progress, finished_at cleared, and the correction
 * event says "Reopened". Allowed only while nothing has built on it:
 *   - the piece is not in finished stock: a top piece already received into
 *     stock (stocked_qty > 0, stockFinished) is refused outright;
 *   - no step that waits for it to be DONE — the next flow sequence, a rule
 *     "waits for … to finish", a parent's first steps waiting for this piece
 *     to be COMPLETE (cf_step_dependencies, required done | complete) — has
 *     started, has a count, has any work session, or gets work in this entry.
 * A wait for a step to be STARTED is not broken by reopening (the step stays
 * started), so it does not block. One read for all the steps, row-locked.
 * Returns the problems — sentences the floor screen shows as they are.
 */
async function reopenProblems(db, companyId, reopening, { workStepIds = new Set() } = {}) {
  if (!reopening.length) return [];
  const problems = new Set();
  const open = [];
  for (const s of reopening) {
    if (s.item_parent_id == null && Number(s.item_stocked_qty) > EPS) problems.add(REOPEN_IN_STOCK);
    else open.push(s);
  }
  if (!open.length) return [...problems];
  const [deps] = await db.query(
    `SELECT d.step_id,
            (s.state <> 'pending' OR s.started_at IS NOT NULL OR s.qty_good > 0 OR s.qty_scrap > 0
              OR EXISTS (SELECT 1 FROM cf_work_sessions w WHERE w.company_id = s.company_id AND w.step_id = s.id AND w.deleted_at IS NULL)) AS used
       FROM cf_step_dependencies d
       JOIN cf_production_steps s ON s.company_id = d.company_id AND s.id = d.step_id AND s.deleted_at IS NULL
      WHERE d.company_id = ? AND d.deleted_at IS NULL AND d.required IN ('done', 'complete')
        AND (d.target_step_id IN (?) OR d.target_item_id IN (?))
      FOR UPDATE`,
    [companyId, open.map((s) => s.id), [...new Set(open.map((s) => s.production_item_id))]],
  );
  if (deps.some((d) => Number(d.used) || workStepIds.has(d.step_id))) problems.add(REOPEN_USED_BY_NEXT);
  return [...problems];
}

// --- reads ------------------------------------------------------------------------

/** GET /floor/machines — every active machine with what it is doing now. 3 reads. */
export async function listMachines(db, companyId) {
  const [machines] = await db.query(
    `SELECT m.id, m.code, m.name, n.name AS type_name FROM cf_machines m JOIN cf_classification_nodes n ON n.id = m.classification_id
      WHERE m.company_id = ? AND m.deleted_at IS NULL AND m.status = 'active' ORDER BY m.code`,
    [companyId],
  );
  const [[activity], [stops]] = await Promise.all([
    db.query(
      `SELECT machine_id, SUM(running) AS running, MAX(last_at) AS last_at FROM (
         SELECT machine_id, SUM(ended_at IS NULL) AS running, MAX(COALESCE(ended_at, started_at)) AS last_at
           FROM cf_work_sessions WHERE company_id = ? AND deleted_at IS NULL GROUP BY machine_id
         UNION ALL
         SELECT machine_id, 0, MAX(COALESCE(ended_at, started_at)) FROM cf_machine_stops WHERE company_id = ? AND deleted_at IS NULL GROUP BY machine_id
       ) x GROUP BY machine_id`,
      [companyId, companyId],
    ),
    db.query(
      `SELECT s.id, s.machine_id, s.started_at, r.label FROM cf_machine_stops s JOIN cf_stop_reasons r ON r.id = s.reason_id
        WHERE s.company_id = ? AND s.ended_at IS NULL AND s.deleted_at IS NULL`,
      [companyId],
    ),
  ]);
  const act = new Map(activity.map((a) => [a.machine_id, a]));
  const stopOf = new Map(stops.map((s) => [s.machine_id, s]));
  return machines.map((m) => {
    const a = act.get(m.id);
    const st = stopOf.get(m.id);
    return {
      id: m.id, code: m.code, name: m.name, type: m.type_name,
      running: Number(a?.running ?? 0),
      stopped: !!st,
      stopReason: st ? st.label : null,
      stop: st ? { id: st.id, reason: st.label, reasonLabel: st.label, since: iso(st.started_at), startedAt: iso(st.started_at) } : null,
      lastActivityAt: iso(a?.last_at ?? null),
    };
  });
}

/** GET /floor/operators?machineId= — the machine's usual operators first, then every active one. 1 read. */
export async function listFloorOperators(db, companyId, q = {}) {
  const machineId = blank(q.machineId) || !Number.isInteger(Number(q.machineId)) ? null : Number(q.machineId);
  const [rows] = await db.query(
    `SELECT o.id, o.code, o.name, EXISTS (SELECT 1 FROM cf_operator_machines om
              WHERE om.company_id = o.company_id AND om.operator_id = o.id AND om.machine_id = ? AND om.deleted_at IS NULL) AS usual
       FROM cf_operators o WHERE o.company_id = ? AND o.deleted_at IS NULL AND o.status = 'active'
      ORDER BY usual DESC, o.name, o.id`,
    [machineId ?? 0, companyId],
  );
  return rows.map((o) => ({ id: o.id, code: o.code, name: o.name, usual: !!Number(o.usual) }));
}

/** A company that has never had a reason list gets the twelve (init.sql §32 seeds existing companies). */
async function ensureReasons(db, companyId) {
  const [[any]] = await db.query('SELECT id FROM cf_stop_reasons WHERE company_id = ? LIMIT 1', [companyId]);
  if (any) return false;
  await insertRows(db, 'cf_stop_reasons', ['company_id', 'code', 'label', 'sort_order', 'needs_note'],
    DEFAULT_STOP_REASONS.map((r) => [companyId, r.code, r.label, r.sortOrder, r.needsNote ? 1 : 0]));
  return true;
}

const shapeReason = (r) => ({ id: r.id, code: r.code, label: r.label, sortOrder: r.sort_order, needsNote: !!Number(r.needs_note), status: r.status });

/** GET /floor/reasons — the active stop reasons in their order. */
export async function listReasons(db, companyId) {
  const read = () => db.query("SELECT * FROM cf_stop_reasons WHERE company_id = ? AND deleted_at IS NULL AND status = 'active' ORDER BY sort_order, label, id", [companyId]);
  let [rows] = await read();
  if (!rows.length && await ensureReasons(db, companyId)) [rows] = await read();
  return rows.map(shapeReason);
}

/**
 * Where the planner ships the unit that holds each production item
 * (cf_plan_entries, keys p<piece> | g<parent piece>.<bom line> | l<line>).
 * The nearest planned unit wins: the piece itself, its lot, then up the
 * locked-piece tree, then the whole line. A grouped tracker node (no locked
 * piece of its own) is looked up through its parent's piece and its BOM row.
 */
function shipDateResolver(items, pieces, entries) {
  const pieceById = new Map(pieces.map((p) => [p.id, p]));
  const itemById = new Map(items.map((x) => [x.id, x]));
  const entry = new Map(entries.map((e) => [e.unit_key, e.ship_date]));
  const memo = new Map();
  const fromPiece = (pid) => {
    if (memo.has(pid)) return memo.get(pid);
    const p = pieceById.get(pid);
    let d = null;
    if (p) {
      d = entry.get(`p${p.id}`) ?? (p.parent_id != null && p.bom_line_id != null ? entry.get(`g${p.parent_id}.${p.bom_line_id}`) : null) ?? null;
      if (d == null && p.parent_id != null) d = fromPiece(p.parent_id);
    }
    memo.set(pid, d);
    return d;
  };
  const pieceOfItem = (it) => {
    for (let x = it, hop = 0; x && hop < 50; x = itemById.get(x.parent_id), hop++) if (x.order_piece_id) return x.order_piece_id;
    return null;
  };
  const sortOf = (it) => {
    const pid = it.order_piece_id ?? pieceOfItem(it);
    return pid && pieceById.has(pid) ? pieceById.get(pid).sort_order : null;
  };
  return {
    shipDate(it, lineId) {
      let d = null;
      if (it.order_piece_id) d = fromPiece(it.order_piece_id);
      else {
        const parent = itemById.get(it.parent_id);
        const parentPiece = parent ? pieceOfItem(parent) : null;
        if (parentPiece && it.bom_line_id != null) d = entry.get(`g${parentPiece}.${it.bom_line_id}`) ?? null;
        if (d == null && parentPiece) d = fromPiece(parentPiece);
      }
      return d ?? entry.get(`l${lineId}`) ?? null;
    },
    sortOf,
  };
}

const dateStr = (d) => (d == null ? null : d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));
const cmpNullLast = (a, b) => (a == null && b == null ? 0 : a == null ? 1 : b == null ? -1 : a < b ? -1 : a > b ? 1 : 0);

/** The shape of one step on the floor (queue rows and running cards). */
function shapeFloorStep(s, it, rel, extra = {}) {
  const orderCode = rel?.order_code ?? s.order_code ?? null;
  const code = it?.code ?? s.piece_code ?? null;
  return {
    id: s.id,
    pieceCode: shortCode(code, orderCode),
    pieceCodeFull: code,
    pieceName: it?.item_name ?? s.piece_name ?? null,
    pieceLabel: it?._label ?? null,
    operation: s._opLabel ?? s.op_name,
    operationId: s.operation_id,
    operationCode: s.op_code,
    qtyTotal: Number(s.quantity),
    qtyGood: Number(s.qty_good),
    qtyLeft: round6(Number(s.quantity) - Number(s.qty_good)),
    orderCode,
    orderId: rel?.order_id ?? s.order_id ?? null,
    lineNo: rel?.line_no ?? null,
    sequence: s.sequence,
    state: s.state,
    ...extra,
  };
}

/**
 * GET /floor/machines/:id/queue?search=&limit= — { running, next, total }.
 * next: released, not-done in-house steps whose operation this machine may do,
 * on confirmed orders; not the ones running now (anywhere). Order (the plan's
 * contract): started here or elsewhere and paused → ready → waiting; within
 * each, the planner's ship date of the unit holding the piece, then the
 * order's plan priority, its committed date, the piece's place in the tree,
 * the step's sequence.
 */
export async function machineQueue(db, companyId, machineId, q = {}) {
  const machine = await requireActiveMachine(db, companyId, machineId);
  const eligible = await eligibleOperations(db, companyId, machine);
  const [[openSessions], [stops]] = await Promise.all([
    db.query(
      `SELECT ws.*, op.name AS operator_name, mc.code AS machine_code FROM cf_work_sessions ws
         LEFT JOIN cf_operators op ON op.id = ws.operator_id JOIN cf_machines mc ON mc.id = ws.machine_id
        WHERE ws.company_id = ? AND ws.ended_at IS NULL AND ws.deleted_at IS NULL ORDER BY ws.started_at, ws.id`,
      [companyId],
    ),
    db.query(
      `SELECT st.id, st.reason_id, st.started_at, st.note, r.label FROM cf_machine_stops st JOIN cf_stop_reasons r ON r.id = st.reason_id
        WHERE st.company_id = ? AND st.machine_id = ? AND st.ended_at IS NULL AND st.deleted_at IS NULL`,
      [companyId, machine.id],
    ),
  ]);
  const st = stops[0];
  // The machine's open stop, so the Now tab can show "Back to work" without another call.
  const stop = st ? { id: st.id, reasonId: st.reason_id, reasonLabel: st.label, startedAt: iso(st.started_at), note: st.note } : null;
  const releaseIds = await openReleaseIds(db, companyId);
  const data = releaseIds.length ? await evaluatedTracker(db, companyId, releaseIds) : null;
  const limit = Math.min(Math.max(Number(q.limit) || 100, 1), 2000);
  if (!data) {
    return { machine: { id: machine.id, code: machine.code, name: machine.name }, stop, running: [], next: [], total: 0, limit };
  }
  const relById = new Map(data.releases.map((r) => [r.id, r]));
  const itemById = data.itemById;
  const lineIds = [...new Set(data.releases.map((r) => r.order_line_id))];
  const orderIds = [...new Set(data.releases.map((r) => r.order_id))];
  const [[pieces], [entries], [orders]] = await Promise.all([
    db.query('SELECT id, parent_id, bom_line_id, sort_order FROM cf_order_pieces WHERE company_id = ? AND order_line_id IN (?) AND deleted_at IS NULL', [companyId, lineIds]),
    db.query('SELECT unit_key, ship_date FROM cf_plan_entries WHERE company_id = ? AND order_line_id IN (?) AND deleted_at IS NULL', [companyId, lineIds]),
    db.query('SELECT id, plan_priority FROM cf_sales_orders WHERE company_id = ? AND id IN (?)', [companyId, orderIds]),
  ]);
  const priority = new Map(orders.map((o) => [o.id, o.plan_priority == null ? null : Number(o.plan_priority)]));
  const resolver = shipDateResolver(data.items, pieces, entries);

  const openByStep = new Map(openSessions.map((ws) => [ws.step_id, ws]));
  const stepById = new Map(data.steps.map((s) => [s.id, s]));
  const running = openSessions.filter((ws) => ws.machine_id === machine.id).map((ws) => {
    const s = stepById.get(ws.step_id);
    const it = s ? itemById.get(s.production_item_id) : null;
    const rel = it ? relById.get(it.release_id) : null;
    return {
      sessionId: ws.id, startedAt: iso(ws.started_at), operator: ws.operator_id ? { id: ws.operator_id, name: ws.operator_name } : null,
      beforeReady: !!ws.before_ready, source: ws.source,
      step: s ? shapeFloorStep(s, it, rel, { ready: true }) : { id: ws.step_id },
    };
  });

  const term = blank(q.search) ? null : String(q.search).trim().toLowerCase();
  const rows = [];
  for (const s of data.steps) {
    if (s.state === 'done' || s.work_order_id || !eligible.has(s.operation_id) || openByStep.has(s.id)) continue;
    const it = itemById.get(s.production_item_id);
    const rel = relById.get(it.release_id);
    const shaped = shapeFloorStep(s, it, rel);
    if (term && ![shaped.pieceCodeFull, shaped.pieceName, shaped.pieceLabel, shaped.orderCode, shaped.operation, s.op_code, s.op_name]
      .some((t) => t && String(t).toLowerCase().includes(term))) continue;
    const ready = s._status === 'ready' || s._status === 'in_progress';
    const group = s._status === 'in_progress' ? 0 : ready ? 1 : 2;
    const why = s._status === 'on_hold' ? 'On hold.' : !ready ? (s._blockers ?? []).map((b) => b.text).slice(0, 2).join(' ') || null : null;
    const shipDate = dateStr(resolver.shipDate(it, rel.order_line_id));
    rows.push({
      shaped: { ...shaped, ready, why, shipDate, priority: priority.get(rel.order_id) ?? null, committedDate: dateStr(rel.line_committed ?? rel.order_committed) },
      key: [group, shipDate, priority.get(rel.order_id) ?? null, dateStr(rel.line_committed ?? rel.order_committed), rel.order_line_id, resolver.sortOf(it) ?? it.sort_order, s.sequence, s.id],
    });
  }
  // A step paused on THIS machine resumes (POST /floor/resume) rather than starting again.
  const startedIds = rows.filter((r) => r.shaped.state === 'in_progress').map((r) => r.shaped.id);
  if (startedIds.length) {
    const [last] = await db.query(
      `SELECT step_id, id, end_kind FROM cf_work_sessions WHERE company_id = ? AND machine_id = ? AND step_id IN (?) AND deleted_at IS NULL
        ORDER BY step_id, started_at, id`,
      [companyId, machine.id, startedIds],
    );
    const latest = new Map();
    for (const l of last) latest.set(l.step_id, l);
    for (const r of rows) {
      const l = latest.get(r.shaped.id);
      if (l && l.end_kind === 'pause') r.shaped.pausedSessionId = l.id;
    }
  }
  rows.sort((a, b) => {
    const x = a.key; const y = b.key;
    return (x[0] - y[0]) || cmpNullLast(x[1], y[1]) || cmpNullLast(x[2], y[2]) || cmpNullLast(x[3], y[3])
      || (x[4] - y[4]) || (x[5] - y[5]) || (x[6] - y[6]) || (x[7] - y[7]);
  });
  return {
    machine: { id: machine.id, code: machine.code, name: machine.name },
    stop,
    running,
    next: rows.slice(0, limit).map((r) => r.shaped),
    total: rows.length,
    limit,
  };
}

/** What the machine is doing now: its open sessions (as cards) and its open stop. 2 reads. */
async function machineNow(db, companyId, machineId) {
  const [[sessions], [stops]] = await Promise.all([
    db.query(
      `SELECT ws.id AS session_id, ws.started_at AS session_start, ws.operator_id AS session_operator, ws.before_ready AS session_before_ready,
              ws.source AS session_source, opr.name AS operator_name, x.*
         FROM cf_work_sessions ws
         JOIN (${STEP_SQL}) x ON x.id = ws.step_id
         LEFT JOIN cf_operators opr ON opr.id = ws.operator_id
        WHERE ws.company_id = ? AND ws.machine_id = ? AND ws.ended_at IS NULL AND ws.deleted_at IS NULL ORDER BY ws.started_at, ws.id`,
      [companyId, machineId],
    ),
    db.query(
      `SELECT s.*, r.label AS reason_label, opr.name AS operator_name FROM cf_machine_stops s JOIN cf_stop_reasons r ON r.id = s.reason_id
         LEFT JOIN cf_operators opr ON opr.id = s.operator_id
        WHERE s.company_id = ? AND s.machine_id = ? AND s.ended_at IS NULL AND s.deleted_at IS NULL`,
      [companyId, machineId],
    ),
  ]);
  const st = stops[0];
  return {
    machineId: Number(machineId),
    running: sessions.map((r) => ({
      sessionId: r.session_id, startedAt: iso(r.session_start),
      operator: r.session_operator ? { id: r.session_operator, name: r.operator_name } : null,
      beforeReady: !!r.session_before_ready, source: r.session_source,
      step: shapeFloorStep(r, null, null),
    })),
    stop: st ? { id: st.id, reasonId: st.reason_id, reason: st.reason_label, reasonLabel: st.reason_label, note: st.note, since: iso(st.started_at), startedAt: iso(st.started_at), operator: st.operator_id ? { id: st.operator_id, name: st.operator_name } : null } : null,
  };
}

/** GET for a machine's Now on its own (the screen refreshes it). */
export async function getMachineNow(db, companyId, machineId) {
  await requireActiveMachine(db, companyId, machineId);
  return machineNow(db, companyId, Number(machineId));
}

// --- the day ------------------------------------------------------------------------

const SESSION_DAY_SQL = `SELECT ws.*, s.quantity AS step_quantity, s.qty_good AS step_good, s.state AS step_state, s.sequence,
         pi.code AS piece_code, m.name AS piece_name, op.code AS op_code, op.name AS op_name, o.code AS order_code,
         opr.name AS operator_name
    FROM cf_work_sessions ws
    JOIN cf_production_steps s ON s.id = ws.step_id
    JOIN cf_production_items pi ON pi.id = s.production_item_id
    JOIN cf_production_releases r ON r.id = pi.release_id
    JOIN cf_sales_orders o ON o.id = r.order_id
    JOIN cf_master_records m ON m.id = pi.item_id
    JOIN cf_operations op ON op.id = s.operation_id
    LEFT JOIN cf_operators opr ON opr.id = ws.operator_id`;
const STOP_DAY_SQL = `SELECT st.*, r.label AS reason_label, r.code AS reason_code, opr.name AS operator_name
    FROM cf_machine_stops st JOIN cf_stop_reasons r ON r.id = st.reason_id
    LEFT JOIN cf_operators opr ON opr.id = st.operator_id`;

function readDate(raw) {
  const s = String(raw ?? '').trim();
  if (!DATE_RE.test(s) || new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) !== s) throw invalid('INVALID', 'The date is YYYY-MM-DD.');
  return s;
}
const addDaysText = (ds, n) => new Date(Date.parse(`${ds}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

/**
 * GET /floor/machines/:id/day?date= — the machine's day: its shift windows
 * (a shift belongs to the day it STARTS, so a 22:00–06:00 night is one day),
 * the sessions and stops of that day, what is not recorded (shift time covered
 * by neither, up to now), and the totals in minutes. An entry belongs to the
 * day of the shift window its start falls in (else the first window it meets,
 * else the calendar date it starts on). ~7 reads.
 */
export async function getDay(db, companyId, machineId, date, { tz: tzGiven = null } = {}) {
  const ds = readDate(date);
  const tz = tzGiven ?? await plantZone(db, companyId);
  const cal = await machineCalendar(db, companyId, Number(machineId), { from: addDaysText(ds, -1), to: addDaysText(ds, 1) });
  const windows = cal.days.flatMap((d) => d.windows.map((w) => ({ day: d.date, s: wms(`${w.start}:00`), e: wms(`${w.end}:00`), label: w.label, source: w.source })));
  const lo = wallOfWms(wms(`${addDaysText(ds, -1)} 00:00:00`));
  const hi = wallOfWms(wms(`${addDaysText(ds, 2)} 12:00:00`));
  const [[sessions], [stops]] = await Promise.all([
    db.query(`${SESSION_DAY_SQL} WHERE ws.company_id = ? AND ws.machine_id = ? AND ws.deleted_at IS NULL
               AND ws.started_at < ? AND (ws.ended_at IS NULL OR ws.ended_at > ?) ORDER BY ws.started_at, ws.id`, [companyId, Number(machineId), hi, lo]),
    db.query(`${STOP_DAY_SQL} WHERE st.company_id = ? AND st.machine_id = ? AND st.deleted_at IS NULL
               AND st.started_at < ? AND (st.ended_at IS NULL OR st.ended_at > ?) ORDER BY st.started_at, st.id`, [companyId, Number(machineId), hi, lo]),
  ]);
  const nowW = wms(wallOf(Date.now(), tz));
  const span = (x) => [wms(wallOfDb(x.started_at)), x.ended_at == null ? Math.max(nowW, wms(wallOfDb(x.started_at))) : wms(wallOfDb(x.ended_at))];
  const dayOf = (s, e) => {
    const inside = windows.find((w) => s >= w.s && s < w.e);
    if (inside) return inside.day;
    const meets = windows.find((w) => s < w.e && w.s < e);
    if (meets) return meets.day;
    return wallOfWms(s).slice(0, 10);
  };
  const daySessions = sessions.filter((x) => { const [s, e] = span(x); return dayOf(s, e) === ds; });
  const dayStops = stops.filter((x) => { const [s, e] = span(x); return dayOf(s, e) === ds; });
  const shifts = windows.filter((w) => w.day === ds).sort((a, b) => a.s - b.s);

  // Time covered by ANY entry (of this day or a neighbour's) is recorded.
  const covered = union([...sessions, ...stops].map(span));
  const notRecorded = [];
  for (const w of shifts) {
    const upTo = Math.min(w.e, nowW);           // shift time still to come is not "missing"
    if (upTo <= w.s) continue;
    for (const [s, e] of subtract([w.s, upTo], covered)) if (e - s >= MIN) notRecorded.push({ start: wallOfWms(s).replace(' ', 'T'), end: wallOfWms(e).replace(' ', 'T'), minutes: minutesBetween(s, e) });
  }
  const workU = union(daySessions.map(span));
  const stopU = union(dayStops.map(span));
  return {
    machine: cal.machine,
    date: ds,
    timezone: tz,
    now: wallOfWms(nowW).replace(' ', 'T'),
    shifts: shifts.map((w) => ({ start: wallOfWms(w.s).replace(' ', 'T'), end: wallOfWms(w.e).replace(' ', 'T'), label: w.label, source: w.source, minutes: minutesBetween(w.s, w.e) })),
    sessions: daySessions.map((x) => {
      const [s, e] = span(x);
      return {
        id: x.id, kind: 'work', stepId: x.step_id,
        pieceCode: shortCode(x.piece_code, x.order_code), pieceCodeFull: x.piece_code, pieceName: x.piece_name,
        operation: x.op_name, operationCode: x.op_code, orderCode: x.order_code,
        start: iso(x.started_at), end: iso(x.ended_at), startedAt: iso(x.started_at), endedAt: iso(x.ended_at), running: x.ended_at == null, endKind: x.end_kind,
        good: Number(x.qty_good), scrap: Number(x.qty_scrap), minutes: minutesBetween(s, e),
        stepQtyTotal: Number(x.step_quantity), stepQtyGood: Number(x.step_good), stepState: x.step_state,
        operator: x.operator_id ? { id: x.operator_id, name: x.operator_name } : null,
        source: x.source, beforeReady: !!x.before_ready, note: x.note,
      };
    }),
    stops: dayStops.map((x) => {
      const [s, e] = span(x);
      return {
        id: x.id, kind: 'stop', reasonId: x.reason_id, reason: x.reason_label, reasonCode: x.reason_code, note: x.note,
        start: iso(x.started_at), end: iso(x.ended_at), startedAt: iso(x.started_at), endedAt: iso(x.ended_at), running: x.ended_at == null, minutes: minutesBetween(s, e),
        operator: x.operator_id ? { id: x.operator_id, name: x.operator_name } : null, source: x.source,
      };
    }),
    notRecorded,
    totals: {
      work: minutesBetween(0, total(workU)),
      stopped: minutesBetween(0, total(stopU)),
      notRecorded: notRecorded.reduce((t, g) => t + g.minutes, 0),
      shift: shifts.reduce((t, w) => t + minutesBetween(w.s, w.e), 0),
    },
  };
}

// --- overlap ------------------------------------------------------------------------

const overlaps = (a, b) => a[0] < b[1] && b[0] < a[1];
const hhmmOf = (n) => wallOfWms(n).slice(11, 16);
const spanText = ([s, e]) => `${hhmmOf(s)}–${hhmmOf(e)}`;

/**
 * The machine's rules on time, over what will be live after a write:
 * a stop never overlaps work or another stop; one step never has two
 * overlapping spans on the machine. Entries are { kind, span:[s,e], stepId?, label, isNew }.
 * Only pairs with at least one new entry are reported (old data is not re-judged).
 */
function overlapProblems(entries) {
  const problems = [];
  const xs = [...entries].sort((a, b) => a.span[0] - b.span[0]);
  for (let i = 0; i < xs.length; i++) {
    for (let j = i + 1; j < xs.length && xs[j].span[0] < xs[i].span[1]; j++) {
      const a = xs[i]; const b = xs[j];
      if (!a.isNew && !b.isNew) continue;
      if (!overlaps(a.span, b.span)) continue;
      const stopA = a.kind === 'stop'; const stopB = b.kind === 'stop';
      if (stopA && stopB) problems.push(`The stop ${spanText(a.span)} (${a.label}) overlaps the stop ${spanText(b.span)} (${b.label}).`);
      else if (stopA || stopB) {
        const [st, wk] = stopA ? [a, b] : [b, a];
        problems.push(`The stop ${spanText(st.span)} (${st.label}) overlaps work ${spanText(wk.span)} (${wk.label}) — a machine is stopped or working, not both.`);
      } else if (a.stepId === b.stepId) problems.push(`${a.label} is entered twice for overlapping times (${spanText(a.span)} and ${spanText(b.span)}).`);
    }
  }
  return problems;
}

/** Live entries of the machine meeting [lo, hi) (wall ms), open ones running to now. 2 reads. */
async function liveEntriesAround(db, companyId, machineId, lo, hi, nowW, { lock = false } = {}) {
  const loW = wallOfWms(lo); const hiW = wallOfWms(hi);
  const tail = ` AND deleted_at IS NULL AND started_at < ? AND (ended_at IS NULL OR ended_at > ?)${lock ? ' FOR UPDATE' : ''}`;
  const [[ws], [st]] = await Promise.all([
    db.query(`SELECT id, step_id, started_at, ended_at, end_kind, qty_good, qty_scrap, operator_id, source FROM cf_work_sessions WHERE company_id = ? AND machine_id = ?${tail}`, [companyId, machineId, hiW, loW]),
    db.query(`SELECT st.id, st.started_at, st.ended_at, r.label FROM cf_machine_stops st JOIN cf_stop_reasons r ON r.id = st.reason_id
               WHERE st.company_id = ? AND st.machine_id = ?${tail.replace(/deleted_at/g, 'st.deleted_at').replace(/started_at/g, 'st.started_at').replace(/ended_at/g, 'st.ended_at')}`, [companyId, machineId, hiW, loW]),
  ]);
  const sp = (x) => [wms(wallOfDb(x.started_at)), x.ended_at == null ? Math.max(nowW, wms(wallOfDb(x.started_at)) + 1) : wms(wallOfDb(x.ended_at))];
  return { sessions: ws.map((x) => ({ ...x, span: sp(x) })), stops: st.map((x) => ({ ...x, span: sp(x) })) };
}

// --- live ---------------------------------------------------------------------------

function idList(raw, name) {
  const list = Array.isArray(raw) ? raw : raw == null ? [] : [raw];
  const ids = list.map(Number);
  if (!ids.length) throw invalid('INVALID', `Choose at least one ${name}.`);
  if (ids.some((n) => !Number.isInteger(n) || n <= 0)) throw invalid('INVALID', `${name} ids are positive whole numbers.`);
  return [...new Set(ids)];
}

const SESSION_COLS = ['company_id', 'machine_id', 'step_id', 'operator_id', 'started_at', 'ended_at', 'end_kind', 'source', 'qty_good', 'qty_scrap', 'before_ready', 'replaces_id', 'note', 'entered_by'];

/** Inserts sessions and reads their ids back by (machine, step, started_at) — unique among live rows. */
async function insertSessions(db, c, rows) {
  if (!rows.length) return [];
  await insertRows(db, 'cf_work_sessions', SESSION_COLS, rows.map((r) => [
    c.companyId, r.machineId, r.stepId, r.operatorId ?? null, r.start, r.end ?? null, r.endKind ?? null, r.source,
    r.good ?? 0, r.scrap ?? 0, r.beforeReady ? 1 : 0, r.replacesId ?? null, r.note ?? null, c.userId,
  ]), 500);
  const [back] = await db.query(
    `SELECT id, machine_id, step_id, started_at FROM cf_work_sessions
      WHERE company_id = ? AND deleted_at IS NULL AND step_id IN (?) AND machine_id IN (?)`,
    [c.companyId, [...new Set(rows.map((r) => r.stepId))], [...new Set(rows.map((r) => r.machineId))]],
  );
  const key = (m, s, t) => `${m}:${s}:${t}`;
  const idOf = new Map(back.map((b) => [key(b.machine_id, b.step_id, wallOfDb(b.started_at)), b.id]));
  for (const r of rows) {
    r.id = idOf.get(key(r.machineId, r.stepId, r.start));
    if (!r.id) throw new Error('cf_erp: a work session vanished between insert and read-back.');
  }
  return rows;
}

/** Ends the machine's open stop at `wall` (starting work means it is back to work). */
async function endOpenStop(db, c, machineId, wall) {
  const [r] = await db.query(
    'UPDATE cf_machine_stops SET ended_at = GREATEST(started_at, ?) WHERE company_id = ? AND machine_id = ? AND ended_at IS NULL AND deleted_at IS NULL',
    [wall, c.companyId, machineId],
  );
  return r.affectedRows > 0;
}

/**
 * POST /floor/start { machineId, operatorId, stepIds[] } — one session per step,
 * starting now. A step still waiting starts anyway (flagged before_ready); a
 * done, held, contractor or already-running step is refused, and so is an
 * operation this machine is not set up for. An open stop on the machine ends:
 * starting work means the machine is back to work.
 */
export async function startWork(db, c, input = {}) {
  const tz = await plantZone(db, c.companyId);
  const machine = await requireActiveMachine(db, c.companyId, input.machineId);
  const operator = await optionalOperator(db, c.companyId, input.operatorId);
  const stepIds = idList(input.stepIds, 'step');
  const steps = await lockSteps(db, c.companyId, stepIds);
  const eligible = await eligibleOperations(db, c.companyId, machine);
  const problems = [];
  for (const s of steps.values()) {
    const p = stepProblem(s, machine, eligible) ?? (s.state === 'done' ? `${s.piece_code ?? s.piece_name} · ${s.op_name} is already done.` : null);
    if (p) problems.push(p);
  }
  const [open] = await db.query(
    `SELECT ws.step_id, mc.code FROM cf_work_sessions ws JOIN cf_machines mc ON mc.id = ws.machine_id
      WHERE ws.company_id = ? AND ws.step_id IN (?) AND ws.ended_at IS NULL AND ws.deleted_at IS NULL`,
    [c.companyId, stepIds],
  );
  for (const o of open) {
    const s = steps.get(o.step_id);
    problems.push(`${s.piece_code ?? s.piece_name} · ${s.op_name} is already running on ${o.code}.`);
  }
  assertNoProblems(problems, problems.length === 1 ? problems[0] : 'Some of these cannot start.');
  const nowMs = Date.now();
  const nowSec = Math.floor(nowMs / 1000);
  const wall = wallOf(nowMs, tz);
  const pending = [...steps.values()].filter((s) => s.state === 'pending');
  const ready = pending.length ? await readinessOf(db, c.companyId, pending) : new Map();
  const endedStop = await endOpenStop(db, c, machine.id, wall);
  const rows = await insertSessions(db, c, [...steps.values()].map((s) => ({
    machineId: machine.id, stepId: s.id, operatorId: operator?.id, start: wall, source: 'live',
    beforeReady: s.state === 'pending' && ready.get(s.id)?.status !== 'ready',
  })));
  await applyStepChanges(db, c, {
    starts: rows.map((r) => ({ step: steps.get(r.stepId), atSec: nowSec, sessionId: r.id, operatorId: operator?.id ?? null, source: 'live', machineId: machine.id, beforeReady: r.beforeReady })),
  });
  return {
    started: rows.map((r) => ({ sessionId: r.id, stepId: r.stepId, beforeReady: r.beforeReady, why: r.beforeReady ? ready.get(r.stepId)?.why ?? [] : [] })),
    endedStop,
    now: await machineNow(db, c.companyId, machine.id),
  };
}

async function lockSessions(db, companyId, ids) {
  const [rows] = await db.query('SELECT * FROM cf_work_sessions WHERE company_id = ? AND id IN (?) AND deleted_at IS NULL FOR UPDATE', [companyId, ids]);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length) throw notFound(missing.length === 1 ? `Session ${missing[0]}` : `Sessions ${missing.join(', ')}`);
  return byId;
}

/** POST /floor/pause { sessionIds[] } — ends each running span now (end_kind pause). The step stays in progress. */
export async function pauseWork(db, c, input = {}) {
  const tz = await plantZone(db, c.companyId);
  const ids = idList(input.sessionIds, 'session');
  const sessions = await lockSessions(db, c.companyId, ids);
  const notRunning = [...sessions.values()].filter((s) => s.ended_at != null);
  if (notRunning.length) throw invalid('NOT_RUNNING', notRunning.length === 1 ? 'That job is not running.' : 'Some of these jobs are not running.');
  const wall = wallOf(Date.now(), tz);
  await db.query(
    "UPDATE cf_work_sessions SET ended_at = GREATEST(started_at, ?), end_kind = 'pause' WHERE company_id = ? AND id IN (?)",
    [wall, c.companyId, ids],
  );
  return { paused: ids, now: await machineNow(db, c.companyId, [...sessions.values()][0].machine_id) };
}

/**
 * POST /floor/resume { sessionIds[] } — a new span from now for each paused
 * session's step, on the same machine, by the same operator. An open stop on
 * the machine ends.
 */
export async function resumeWork(db, c, input = {}) {
  const tz = await plantZone(db, c.companyId);
  const ids = idList(input.sessionIds, 'session');
  const sessions = await lockSessions(db, c.companyId, ids);
  const list = [...sessions.values()];
  const problems = [];
  for (const s of list) if (s.ended_at == null || s.end_kind !== 'pause') problems.push(`Session ${s.id} is not paused.`);
  const steps = await lockSteps(db, c.companyId, list.map((s) => s.step_id));
  for (const s of steps.values()) {
    const p = stepProblem(s, null, null) ?? (s.state === 'done' ? `${s.piece_code ?? s.piece_name} · ${s.op_name} is already done.` : null);
    if (p) problems.push(p);
  }
  const [open] = await db.query(
    'SELECT step_id FROM cf_work_sessions WHERE company_id = ? AND step_id IN (?) AND ended_at IS NULL AND deleted_at IS NULL',
    [c.companyId, [...steps.keys()]],
  );
  for (const o of open) { const s = steps.get(o.step_id); problems.push(`${s.piece_code ?? s.piece_name} · ${s.op_name} is already running.`); }
  if (new Set(list.map((s) => s.step_id)).size !== list.length) problems.push('Two of these sessions are the same job — resume it once.');
  assertNoProblems(problems, problems.length === 1 ? problems[0] : 'Some of these cannot resume.');
  const wall = wallOf(Date.now(), tz);
  for (const m of new Set(list.map((s) => s.machine_id))) await endOpenStop(db, c, m, wall);
  const rows = await insertSessions(db, c, list.map((s) => ({
    machineId: s.machine_id, stepId: s.step_id, operatorId: s.operator_id, start: wall, source: 'live', beforeReady: !!s.before_ready,
  })));
  return { resumed: rows.map((r) => ({ sessionId: r.id, stepId: r.stepId })), now: await machineNow(db, c.companyId, list[0].machine_id) };
}

function readQty(raw, label, problems) {
  if (blank(raw)) return 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) { problems.push(`${label} is a number, zero or more.`); return 0; }
  return round6(n);
}

/**
 * POST /floor/finish { sessionId, good, scrap, done } — ends the running span
 * now and records its count on the step (the tracker's progress rules). done
 * = the worker says the job is finished (end_kind 'done'); false = stopped
 * without finishing (end_kind 'stop'). The step itself is done when its good
 * count reaches its quantity — saying "done" with pieces still to make leaves
 * it in progress and says how many are left.
 */
export async function finishWork(db, c, input = {}) {
  const tz = await plantZone(db, c.companyId);
  const [id] = idList(input.sessionId, 'session');
  const session = (await lockSessions(db, c.companyId, [id])).get(id);
  if (session.ended_at != null) throw invalid('NOT_RUNNING', 'That job is not running.');
  const step = (await lockSteps(db, c.companyId, [session.step_id])).get(session.step_id);
  const problems = [];
  const good = readQty(input.good, 'Finished', problems);
  const scrap = readQty(input.scrap, 'Scrapped', problems);
  assertNoProblems(problems);
  const p = stepProblem(step, null, null) ?? countProblem(step, good, scrap, { newWork: false });
  if (p) throw invalid('INVALID', p);
  const nowMs = Date.now();
  const wall = wallOf(nowMs, tz);
  const done = input.done === undefined ? true : !!input.done && input.done !== 'false';
  await db.query(
    'UPDATE cf_work_sessions SET ended_at = GREATEST(started_at, ?), end_kind = ?, qty_good = ?, qty_scrap = ? WHERE company_id = ? AND id = ?',
    [wall, done ? 'done' : 'stop', good, scrap, c.companyId, id],
  );
  const doneNow = await applyStepChanges(db, c, {
    counts: [{ step, good, scrap, atSec: Math.floor(nowMs / 1000), sessionId: id, operatorId: session.operator_id, source: 'live', machineId: session.machine_id }],
  });
  return {
    sessionId: id,
    step: { id: step.id, state: step.state, qtyGood: Number(step.qty_good), qtyTotal: Number(step.quantity), qtyLeft: round6(Number(step.quantity) - Number(step.qty_good)), done: doneNow.includes(step.id) || step.state === 'done' },
    now: await machineNow(db, c.companyId, session.machine_id),
  };
}

async function requireReason(db, companyId, raw, note) {
  if (blank(raw) || !Number.isInteger(Number(raw)) || Number(raw) <= 0) throw invalid('INVALID', 'Choose why the machine stopped.');
  const [[r]] = await db.query('SELECT * FROM cf_stop_reasons WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [companyId, Number(raw)]);
  if (!r) throw invalid('INVALID', 'That reason is not on the list.');
  if (r.status !== 'active') throw invalid('INVALID', `"${r.label}" is no longer used.`);
  if (Number(r.needs_note) && blank(note)) throw invalid('INVALID', `Say what happened — "${r.label}" needs a note.`);
  return r;
}

/**
 * POST /floor/stop { machineId, operatorId, reasonId, note?, since? } — the
 * machine stopped, now or since a time (at most a day back). Jobs running on
 * the machine are PAUSED at that moment — a machine is stopped or working, not
 * both; a job that started after `since`, or finished work after it, is a
 * clash and refused.
 */
export async function startStop(db, c, input = {}) {
  const tz = await plantZone(db, c.companyId);
  const machine = await requireActiveMachine(db, c.companyId, input.machineId);
  const operator = await optionalOperator(db, c.companyId, input.operatorId);
  const reason = await requireReason(db, c.companyId, input.reasonId, input.note);
  const nowMs = Date.now();
  const nowW = wms(wallOf(nowMs, tz));
  let since = wallOfWms(nowW);
  if (!blank(input.since)) {
    const problems = [];
    since = readWall(input.since, 'Since', problems, tz);
    assertNoProblems(problems);
    if (wms(since) > nowW + MIN) throw invalid('IN_FUTURE', 'That time is in the future.');
    if (wms(since) < nowW - STOP_SINCE_MAX_MS) throw invalid('INVALID', 'A stop entered live starts within the last day — enter older ones in My day.');
  }
  const sinceW = wms(since);
  const around = await liveEntriesAround(db, c.companyId, machine.id, sinceW - DAY_MS, nowW + MIN, nowW, { lock: true });
  const open = around.stops.find((s) => s.ended_at == null);
  if (open) throw conflict('ALREADY_STOPPED', `${machine.code} is already stopped (${open.label}, since ${hhmmOf(open.span[0])}).`);
  const problems = [];
  for (const s of around.stops) if (s.span[1] > sinceW) problems.push(`It overlaps the stop ${spanText(s.span)} (${s.label}).`);
  const toPause = [];
  for (const w of around.sessions) {
    if (w.ended_at == null && w.span[0] <= sinceW) toPause.push(w.id);
    else if (w.span[1] > sinceW) problems.push(`It overlaps work ${spanText(w.span)} — a machine is stopped or working, not both.`);
  }
  assertNoProblems(problems, problems.length === 1 ? problems[0] : 'The stop clashes with what is recorded.');
  if (toPause.length) {
    await db.query("UPDATE cf_work_sessions SET ended_at = GREATEST(started_at, ?), end_kind = 'pause' WHERE company_id = ? AND id IN (?)", [since, c.companyId, toPause]);
  }
  await db.query(
    `INSERT INTO cf_machine_stops (company_id, machine_id, started_at, reason_id, note, operator_id, source, entered_by)
     VALUES (?, ?, ?, ?, ?, ?, 'live', ?)`,
    [c.companyId, machine.id, since, reason.id, blank(input.note) ? null : String(input.note).slice(0, 500), operator?.id ?? null, c.userId],
  );
  return { pausedSessionIds: toPause, now: await machineNow(db, c.companyId, machine.id) };
}

/** POST /floor/stop/:id/end — back to work: the stop ends now. */
export async function endStop(db, c, stopId) {
  const tz = await plantZone(db, c.companyId);
  const [[st]] = await db.query('SELECT * FROM cf_machine_stops WHERE company_id = ? AND id = ? AND deleted_at IS NULL FOR UPDATE', [c.companyId, Number(stopId)]);
  if (!st) throw notFound('Stop');
  if (st.ended_at != null) throw invalid('NOT_RUNNING', 'That stop has already ended.');
  await db.query('UPDATE cf_machine_stops SET ended_at = GREATEST(started_at, ?) WHERE company_id = ? AND id = ?', [wallOf(Date.now(), tz), c.companyId, st.id]);
  return { now: await machineNow(db, c.companyId, st.machine_id) };
}

// --- the day entry --------------------------------------------------------------------

/**
 * PUT /floor/machines/:id/day { date, operatorId, rows, deleted } — the day as
 * written from paper, in ONE transaction:
 *   rows: [{ kind:'work', id?, stepId, start, end, good, scrap, note? }
 *        | { kind:'stop', id?, reasonId, note, start, end }]
 *   deleted: [{ kind, id }] (a bare id is accepted when it names only one entry of this machine)
 * A row with an id EDITS that entry: the old row is soft-deleted and a new one
 * written (replaces_id), so history is kept. Checks: inside the day ±12 h,
 * start before end, not in the future, stops overlap neither work nor each
 * other, one step never twice at once on the machine, work not before its
 * release, no new work on a done step. Counts are the difference from what the
 * edited/deleted rows had recorded — a lower count is a correction on the step;
 * on a DONE step it reopens the step (reopenProblems: refused once a step that
 * waits for it has started, or the piece is in finished stock). Returns the
 * day, plus reopened: [{ stepId, label, qtyLeft, … }] for the steps reopened.
 */
export async function putDay(db, c, machineId, input = {}) {
  const tz = await plantZone(db, c.companyId);
  const machine = await requireActiveMachine(db, c.companyId, machineId);
  const ds = readDate(input.date);
  const operator = await optionalOperator(db, c.companyId, input.operatorId);
  const rowsIn = Array.isArray(input.rows) ? input.rows : [];
  // deletedRows [{ kind, id }] wins over deleted (the two tables' ids can collide).
  const deletedIn = Array.isArray(input.deletedRows) ? input.deletedRows : Array.isArray(input.deleted) ? input.deleted : [];
  if (!rowsIn.length && !deletedIn.length) throw invalid('INVALID', 'Nothing to save.');
  const nowW = wms(wallOf(Date.now(), tz));
  const dayLo = wms(`${ds} 00:00:00`) - DAY_SLACK_MS;
  const dayHi = wms(`${addDaysText(ds, 1)} 00:00:00`) + DAY_SLACK_MS;

  // 1. Shape every row; collect every problem before a single write.
  const problems = [];
  const rows = rowsIn.map((r, i) => {
    const at = `Row ${i + 1}`;
    const kind = r?.kind;
    if (kind !== 'work' && kind !== 'stop') { problems.push(`${at}: kind is work or stop.`); return null; }
    const start = readWall(r.start, `${at}: From`, problems, tz);
    const end = readWall(r.end, `${at}: To`, problems, tz);
    const out = { i, kind, id: blank(r.id) ? null : Number(r.id), start, end, note: blank(r.note) ? null : String(r.note).slice(0, 500) };
    if (out.id != null && (!Number.isInteger(out.id) || out.id <= 0)) problems.push(`${at}: id is a positive whole number.`);
    if (start && end) {
      out.span = [wms(start), wms(end)];
      if (out.span[0] >= out.span[1]) problems.push(`${at}: From must be before To.`);
      if (out.span[1] > nowW + MIN) problems.push(`${at}: it ends in the future.`);
      if (out.span[0] < dayLo || out.span[1] > dayHi) problems.push(`${at}: it is not on ${ds} (a day entry reaches 12 hours either side of the date).`);
    }
    if (kind === 'work') {
      out.stepId = Number(r.stepId);
      if (!Number.isInteger(out.stepId) || out.stepId <= 0) problems.push(`${at}: choose the job.`);
      out.good = readQty(r.good, `${at}: Finished`, problems);
      out.scrap = readQty(r.scrap, `${at}: Scrapped`, problems);
    } else {
      out.reasonId = blank(r.reasonId) ? null : Number(r.reasonId);
      if (out.reasonId == null || !Number.isInteger(out.reasonId) || out.reasonId <= 0) problems.push(`${at}: choose why the machine stopped.`);
    }
    return out;
  }).filter(Boolean);
  assertNoProblems(problems, problems.length === 1 ? problems[0] : 'Some rows need attention.');

  // 2. The entries edited or deleted — this machine's, live, row-locked (2 reads).
  const editSessionIds = rows.filter((r) => r.kind === 'work' && r.id).map((r) => r.id);
  const editStopIds = rows.filter((r) => r.kind === 'stop' && r.id).map((r) => r.id);
  const delTyped = deletedIn.map((d) => (d && typeof d === 'object' ? { kind: d.kind, id: Number(d.id) } : { kind: null, id: Number(d) }));
  if (delTyped.some((d) => !Number.isInteger(d.id) || d.id <= 0 || (d.kind && d.kind !== 'work' && d.kind !== 'stop'))) {
    throw invalid('INVALID', 'deleted lists { kind: work | stop, id }.');
  }
  const anyIds = (k) => [...new Set([...(k === 'work' ? editSessionIds : editStopIds), ...delTyped.filter((d) => d.kind === k || d.kind == null).map((d) => d.id)])];
  const [[oldSessions], [oldStops]] = await Promise.all([
    anyIds('work').length ? db.query('SELECT * FROM cf_work_sessions WHERE company_id = ? AND machine_id = ? AND id IN (?) AND deleted_at IS NULL FOR UPDATE', [c.companyId, machine.id, anyIds('work')]) : [[]],
    anyIds('stop').length ? db.query('SELECT * FROM cf_machine_stops WHERE company_id = ? AND machine_id = ? AND id IN (?) AND deleted_at IS NULL FOR UPDATE', [c.companyId, machine.id, anyIds('stop')]) : [[]],
  ]);
  const sessById = new Map(oldSessions.map((x) => [x.id, x]));
  const stopById = new Map(oldStops.map((x) => [x.id, x]));
  for (const r of rows) {
    if (!r.id) continue;
    const old = r.kind === 'work' ? sessById.get(r.id) : stopById.get(r.id);
    if (!old) problems.push(`Row ${r.i + 1}: that ${r.kind === 'work' ? 'work' : 'stop'} entry is not one of ${machine.code}'s.`);
    else if (old.ended_at == null) problems.push(`Row ${r.i + 1}: it is running now — finish it on Now first.`);
    else if (r.kind === 'work' && old.step_id !== r.stepId) problems.push(`Row ${r.i + 1}: an entry keeps its job — delete it and add the other job.`);
  }
  const delSessions = []; const delStops = [];
  for (const d of delTyped) {
    const s = d.kind !== 'stop' ? sessById.get(d.id) : null;
    const t = d.kind !== 'work' ? stopById.get(d.id) : null;
    if (d.kind == null && s && t) { problems.push(`Entry ${d.id} could be work or a stop — say which ({ kind, id }).`); continue; }
    if (!s && !t) { problems.push(`Entry ${d.id} is not one of ${machine.code}'s.`); continue; }
    if ((s ?? t).ended_at == null) { problems.push(`Entry ${d.id} is running now — finish it on Now first.`); continue; }
    if (s) delSessions.push(s); else delStops.push(t);
  }
  const editedIds = new Set(rows.filter((r) => r.id).map((r) => `${r.kind}:${r.id}`));
  if (delSessions.some((s) => editedIds.has(`work:${s.id}`)) || delStops.some((s) => editedIds.has(`stop:${s.id}`))) problems.push('An entry is both edited and deleted.');
  if (editedIds.size !== rows.filter((r) => r.id).length) problems.push('An entry is edited twice.');
  assertNoProblems(problems, problems.length === 1 ? problems[0] : 'Some rows need attention.');

  // 3. The jobs: row-locked, eligible here, not on hold / contractor / closed order, not before release.
  const workRows = rows.filter((r) => r.kind === 'work');
  const stepIds = [...new Set([...workRows.map((r) => r.stepId), ...delSessions.map((s) => s.step_id)])];
  const steps = await lockSteps(db, c.companyId, stepIds);
  const eligible = workRows.length ? await eligibleOperations(db, c.companyId, machine) : null;
  for (const r of workRows) {
    const s = steps.get(r.stepId);
    const p = stepProblem(s, machine, eligible);
    if (p) problems.push(`Row ${r.i + 1}: ${p}`);
    if (epochOfWall(r.start, tz) / 1000 < Number(s.release_epoch) - 1) problems.push(`Row ${r.i + 1}: it starts before the job was released to production.`);
  }
  const reasonIds = [...new Set(rows.filter((r) => r.kind === 'stop').map((r) => r.reasonId))];
  if (reasonIds.length) {
    const [reasons] = await db.query('SELECT id, label, needs_note, status FROM cf_stop_reasons WHERE company_id = ? AND id IN (?) AND deleted_at IS NULL', [c.companyId, reasonIds]);
    const rById = new Map(reasons.map((x) => [x.id, x]));
    for (const r of rows.filter((x) => x.kind === 'stop')) {
      const reason = rById.get(r.reasonId);
      if (!reason) problems.push(`Row ${r.i + 1}: that reason is not on the list.`);
      else if (reason.status !== 'active' && !(r.id && stopById.get(r.id)?.reason_id === reason.id)) problems.push(`Row ${r.i + 1}: "${reason.label}" is no longer used.`);
      else if (Number(reason.needs_note) && !r.note) problems.push(`Row ${r.i + 1}: say what happened — "${reason.label}" needs a note.`);
      r.label = reason?.label ?? 'stop';
    }
  }

  // 4. Counts per step: new rows' counts minus what the replaced / deleted rows recorded.
  const delta = new Map();
  const bump = (stepId, g, sc, fresh) => {
    const d = delta.get(stepId) ?? { good: 0, scrap: 0, newWork: false };
    d.good = round6(d.good + g); d.scrap = round6(d.scrap + sc); d.newWork = d.newWork || fresh;
    delta.set(stepId, d);
  };
  for (const r of workRows) {
    bump(r.stepId, r.good, r.scrap, !r.id);
    if (r.id) { const o = sessById.get(r.id); bump(o.step_id, -Number(o.qty_good), -Number(o.qty_scrap), false); }
  }
  for (const o of delSessions) bump(o.step_id, -Number(o.qty_good), -Number(o.qty_scrap), false);
  // A lower count on a done step reopens it — only while nothing has built on it.
  const reopening = [];
  for (const [stepId, d] of delta) {
    const s = steps.get(stepId);
    const p = countProblem(s, d.good, d.scrap, { newWork: d.newWork });
    if (p) problems.push(p);
    else if (s.state === 'done' && round6(Number(s.qty_good) + d.good) < Number(s.quantity) - EPS) reopening.push(s);
  }
  if (!problems.length) problems.push(...await reopenProblems(db, c.companyId, reopening, { workStepIds: new Set(workRows.map((r) => r.stepId)) }));
  const reopenIds = new Set(reopening.map((s) => s.id));

  // 5. Time rules over what will be live afterwards (2 reads).
  const spans = rows.map((r) => r.span);
  const lo = Math.min(...spans.map((s) => s[0]), dayLo);
  const hi = Math.max(...spans.map((s) => s[1]), dayHi);
  const around = await liveEntriesAround(db, c.companyId, machine.id, lo, hi, nowW);
  const gone = new Set([...rows.filter((r) => r.id).map((r) => `${r.kind}:${r.id}`), ...delSessions.map((s) => `work:${s.id}`), ...delStops.map((s) => `stop:${s.id}`)]);
  const labelOf = (s) => (s ? `${s.piece_code ?? s.piece_name} · ${s.op_name}` : 'a job');
  const [stepNames] = around.sessions.length
    ? await db.query(`SELECT s.id, pi.code AS piece_code, m.name AS piece_name, op.name AS op_name FROM cf_production_steps s
                        JOIN cf_production_items pi ON pi.id = s.production_item_id JOIN cf_master_records m ON m.id = pi.item_id
                        JOIN cf_operations op ON op.id = s.operation_id WHERE s.company_id = ? AND s.id IN (?)`, [c.companyId, [...new Set(around.sessions.map((x) => x.step_id))]])
    : [[]];
  const nameOf = new Map(stepNames.map((x) => [x.id, labelOf(x)]));
  const entries = [
    ...around.sessions.filter((x) => !gone.has(`work:${x.id}`)).map((x) => ({ kind: 'work', span: x.span, stepId: x.step_id, label: nameOf.get(x.step_id) ?? 'a job', isNew: false })),
    ...around.stops.filter((x) => !gone.has(`stop:${x.id}`)).map((x) => ({ kind: 'stop', span: x.span, label: x.label, isNew: false })),
    ...rows.map((r) => (r.kind === 'work'
      ? { kind: 'work', span: r.span, stepId: r.stepId, label: labelOf(steps.get(r.stepId)), isNew: true }
      : { kind: 'stop', span: r.span, label: r.label, isNew: true })),
  ];
  problems.push(...overlapProblems(entries));
  assertNoProblems(problems, problems.length === 1 ? problems[0] : 'Some rows need attention.');

  // 6. Readiness of the steps that start with this entry — flagged, never refused.
  const starting = workRows.filter((r) => !r.id && steps.get(r.stepId).state === 'pending');
  const ready = starting.length ? await readinessOf(db, c.companyId, [...new Set(starting.map((r) => steps.get(r.stepId)))]) : new Map();

  // 7. Writes: retire edited + deleted, insert the new rows, move the steps.
  const retireS = [...delSessions.map((s) => s.id), ...editSessionIds];
  const retireT = [...delStops.map((s) => s.id), ...editStopIds];
  if (retireS.length) await db.query('UPDATE cf_work_sessions SET deleted_at = NOW() WHERE company_id = ? AND id IN (?)', [c.companyId, retireS]);
  if (retireT.length) await db.query('UPDATE cf_machine_stops SET deleted_at = NOW() WHERE company_id = ? AND id IN (?)', [c.companyId, retireT]);
  const newSessions = await insertSessions(db, c, workRows.map((r) => {
    const old = r.id ? sessById.get(r.id) : null;
    const s = steps.get(r.stepId);
    return {
      machineId: machine.id, stepId: r.stepId, operatorId: operator?.id ?? old?.operator_id ?? null, start: r.start, end: r.end,
      endKind: old ? (old.end_kind === 'done' && reopenIds.has(r.stepId) ? 'stop' : old.end_kind) : (r.good > EPS && round6(Number(s.qty_good) + (delta.get(r.stepId)?.good ?? 0)) >= Number(s.quantity) - EPS ? 'done' : 'stop'),
      source: 'day_entry', good: r.good, scrap: r.scrap, replacesId: r.id, note: r.note,
      beforeReady: old ? !!old.before_ready : (s.state === 'pending' && ready.get(s.id)?.status !== 'ready'),
    };
  }));
  const stopRows = rows.filter((r) => r.kind === 'stop');
  if (stopRows.length) {
    await insertRows(db, 'cf_machine_stops', ['company_id', 'machine_id', 'started_at', 'ended_at', 'reason_id', 'note', 'operator_id', 'source', 'replaces_id', 'entered_by'],
      stopRows.map((r) => [c.companyId, machine.id, r.start, r.end, r.reasonId, r.note, operator?.id ?? (r.id ? stopById.get(r.id)?.operator_id : null) ?? null, 'day_entry', r.id, c.userId]), 500);
  }
  const sec = (wall) => Math.floor(epochOfWall(wall, tz) / 1000);
  const starts = newSessions.map((r) => ({ step: steps.get(r.stepId), atSec: sec(r.start), sessionId: r.id, operatorId: r.operatorId ?? null, source: 'day_entry', machineId: machine.id, beforeReady: r.beforeReady }));
  const counts = [
    ...newSessions.map((r) => ({ step: steps.get(r.stepId), good: r.good, scrap: r.scrap, atSec: sec(r.end), sessionId: r.id, operatorId: r.operatorId ?? null, source: 'day_entry', machineId: machine.id })),
    ...workRows.filter((r) => r.id).map((r) => { const o = sessById.get(r.id); return { step: steps.get(o.step_id), good: -Number(o.qty_good), scrap: -Number(o.qty_scrap), atSec: sec(r.end), sessionId: o.id, operatorId: operator?.id ?? o.operator_id, source: 'day_entry', machineId: machine.id, note: 'Corrected in the machine log' }; }),
    ...delSessions.map((o) => ({ step: steps.get(o.step_id), good: -Number(o.qty_good), scrap: -Number(o.qty_scrap), atSec: Math.floor(Date.now() / 1000), sessionId: o.id, operatorId: operator?.id ?? o.operator_id, source: 'day_entry', machineId: machine.id, note: 'Deleted in the machine log' })),
  ];
  // A correction that reopens a done step says so in the step's history.
  const merged = mergeCounts(counts).map((x) => (reopenIds.has(x.step.id)
    ? { ...x, note: `Reopened — ${String(x.note ?? 'Corrected in the machine log').replace(/^\w/, (ch) => ch.toLowerCase())}` }
    : x));
  // Edits of a step already started keep their start (only an earlier one moves it).
  // applyStepChanges moves a reopened step back: in_progress, lower qty_good, finished_at NULL.
  await applyStepChanges(db, c, { starts, counts: merged });
  const day = await getDay(db, c.companyId, machine.id, ds, { tz });
  // For the floor screen's quiet "Job reopened — N left".
  day.reopened = reopening.map((s) => ({
    stepId: s.id, label: `${s.piece_code ?? s.piece_name} · ${s.op_name}`, state: s.state,
    qtyGood: Number(s.qty_good), qtyTotal: Number(s.quantity), qtyLeft: round6(Number(s.quantity) - Number(s.qty_good)),
  }));
  return day;
}

/**
 * An edit writes "minus the old count, plus the new" — two events that say
 * nothing when they cancel. They are merged per (step, session chain) so an
 * edit that only moved the times leaves the step's history alone; a real
 * change is one event with the difference.
 */
function mergeCounts(counts) {
  const byStep = new Map();
  for (const x of counts) {
    const k = x.step.id;
    if (!byStep.has(k)) byStep.set(k, []);
    byStep.get(k).push(x);
  }
  const out = [];
  for (const list of byStep.values()) {
    const g = round6(list.reduce((t, x) => t + x.good, 0));
    const sc = round6(list.reduce((t, x) => t + x.scrap, 0));
    if (Math.abs(g) <= EPS && Math.abs(sc) <= EPS) continue;
    const positive = list.filter((x) => x.good > EPS || x.scrap > EPS);
    const anchor = (positive.length ? positive : list).reduce((a, b) => (b.atSec > a.atSec ? b : a));
    const corrected = list.some((x) => x.good < -EPS || x.scrap < -EPS);
    out.push({ ...anchor, good: g, scrap: sc, note: corrected ? (anchor.note ?? 'Corrected in the machine log') : anchor.note ?? null });
  }
  return out;
}

// --- setup: operators ---------------------------------------------------------------

function shapeOperator(o, machines) {
  return { id: o.id, code: o.code, name: o.name, status: o.status, notes: o.notes, machines: machines ?? [] };
}

/** GET /operators?status=all — everyone on the list with their usual machines. 2 reads. */
export async function listOperators(db, companyId, q = {}) {
  const all = String(q.status ?? '') === 'all';
  const [rows] = await db.query(
    `SELECT * FROM cf_operators WHERE company_id = ? AND deleted_at IS NULL${all ? '' : " AND status = 'active'"} ORDER BY name, id`,
    [companyId],
  );
  if (!rows.length) return [];
  const [links] = await db.query(
    `SELECT om.operator_id, m.id, m.code, m.name FROM cf_operator_machines om JOIN cf_machines m ON m.id = om.machine_id
      WHERE om.company_id = ? AND om.operator_id IN (?) AND om.deleted_at IS NULL ORDER BY m.code`,
    [companyId, rows.map((r) => r.id)],
  );
  const by = new Map();
  for (const l of links) { if (!by.has(l.operator_id)) by.set(l.operator_id, []); by.get(l.operator_id).push({ id: l.id, code: l.code, name: l.name }); }
  return rows.map((o) => shapeOperator(o, by.get(o.id)));
}

async function readOperator(db, companyId, input, problems, existing = null) {
  const pick = (k, fb) => (input[k] !== undefined ? input[k] : fb);
  const name = String(pick('name', existing?.name) ?? '').trim();
  if (!name || name.length > 150) problems.push('Give the operator a name (up to 150 characters).');
  const code = String(pick('code', existing?.code) ?? '').trim();
  if (code.length > 50) problems.push('Code is up to 50 characters.');
  const status = pick('status', existing?.status ?? 'active');
  if (!['active', 'inactive'].includes(status)) problems.push('Status is active or inactive.');
  const notes = pick('notes', existing?.notes);
  let machineIds;
  if (input.machineIds !== undefined) {
    machineIds = [...new Set((Array.isArray(input.machineIds) ? input.machineIds : []).map(Number))];
    if (machineIds.some((n) => !Number.isInteger(n) || n <= 0)) problems.push('Usual machines are machine ids.');
    else if (machineIds.length) {
      const [ms] = await db.query('SELECT id FROM cf_machines WHERE company_id = ? AND id IN (?) AND deleted_at IS NULL', [companyId, machineIds]);
      if (ms.length !== machineIds.length) problems.push('One of the usual machines does not exist.');
    }
  }
  return { name, code, status, notes: blank(notes) ? null : String(notes).slice(0, 500), machineIds };
}

async function setOperatorMachines(db, companyId, operatorId, machineIds) {
  if (machineIds === undefined) return;
  await db.query('UPDATE cf_operator_machines SET deleted_at = NOW() WHERE company_id = ? AND operator_id = ? AND deleted_at IS NULL', [companyId, operatorId]);
  if (machineIds.length) await insertRows(db, 'cf_operator_machines', ['company_id', 'operator_id', 'machine_id'], machineIds.map((m) => [companyId, operatorId, m]));
}

async function getOperator(db, companyId, id) {
  return (await listOperators(db, companyId, { status: 'all' })).find((o) => o.id === id) ?? null;
}

/** POST /operators { name, code?, status?, notes?, machineIds? } — code defaults to OP-<id>. */
export async function createOperator(db, c, input = {}) {
  const problems = [];
  const p = await readOperator(db, c.companyId, input, problems);
  assertNoProblems(problems, 'The operator has problems.');
  const temp = p.code || `OP-NEW-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const [r] = await db.query('INSERT INTO cf_operators (company_id, code, name, status, notes, created_by) VALUES (?, ?, ?, ?, ?, ?)',
    [c.companyId, temp, p.name, p.status, p.notes, c.userId]);
  if (!p.code) await db.query('UPDATE cf_operators SET code = ? WHERE company_id = ? AND id = ?', [`OP-${pad(r.insertId, 3)}`, c.companyId, r.insertId]);
  await setOperatorMachines(db, c.companyId, r.insertId, p.machineIds ?? []);
  return getOperator(db, c.companyId, r.insertId);
}

async function requireOperatorRow(db, companyId, id) {
  const [[o]] = await db.query('SELECT * FROM cf_operators WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [companyId, id]);
  if (!o) throw notFound('Operator');
  return o;
}

export async function updateOperator(db, c, id, input = {}) {
  const o = await requireOperatorRow(db, c.companyId, id);
  const problems = [];
  const p = await readOperator(db, c.companyId, input, problems, o);
  if (!p.code) problems.push('Code cannot be blank.');
  assertNoProblems(problems, 'The operator has problems.');
  await db.query('UPDATE cf_operators SET code = ?, name = ?, status = ?, notes = ? WHERE company_id = ? AND id = ?', [p.code, p.name, p.status, p.notes, c.companyId, id]);
  await setOperatorMachines(db, c.companyId, id, p.machineIds);
  return getOperator(db, c.companyId, id);
}

/** An operator leaves the list; what they recorded keeps their name (soft delete). */
export async function deleteOperator(db, c, id) {
  await requireOperatorRow(db, c.companyId, id);
  await db.query('UPDATE cf_operator_machines SET deleted_at = NOW() WHERE company_id = ? AND operator_id = ? AND deleted_at IS NULL', [c.companyId, id]);
  await db.query('UPDATE cf_operators SET deleted_at = NOW() WHERE company_id = ? AND id = ?', [c.companyId, id]);
  return { ok: true };
}

// --- setup: stop reasons ------------------------------------------------------------

/** GET /stop-reasons?status=all */
export async function listStopReasons(db, companyId, q = {}) {
  await ensureReasons(db, companyId);
  const all = String(q.status ?? '') === 'all';
  const [rows] = await db.query(
    `SELECT * FROM cf_stop_reasons WHERE company_id = ? AND deleted_at IS NULL${all ? '' : " AND status = 'active'"} ORDER BY sort_order, label, id`,
    [companyId],
  );
  return rows.map(shapeReason);
}

function readReason(input, problems, existing = null) {
  const pick = (k, fb) => (input[k] !== undefined ? input[k] : fb);
  const label = String(pick('label', existing?.label) ?? '').trim();
  if (!label || label.length > 100) problems.push('Give the reason a label (up to 100 characters).');
  let code = String(pick('code', existing?.code) ?? '').trim();
  if (!code && label) code = label.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
  if (!code || code.length > 40) problems.push('Code is up to 40 characters.');
  const sortOrder = Number(pick('sortOrder', existing?.sort_order ?? 0));
  if (!Number.isInteger(sortOrder)) problems.push('Order is a whole number.');
  const needsNote = !!pick('needsNote', existing ? !!Number(existing.needs_note) : false);
  const status = pick('status', existing?.status ?? 'active');
  if (!['active', 'inactive'].includes(status)) problems.push('Status is active or inactive.');
  return { label, code, sortOrder, needsNote, status };
}

async function requireReasonRow(db, companyId, id) {
  const [[r]] = await db.query('SELECT * FROM cf_stop_reasons WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [companyId, id]);
  if (!r) throw notFound('Stop reason');
  return r;
}

/** POST /stop-reasons { label, code?, sortOrder?, needsNote?, status? } */
export async function createStopReason(db, c, input = {}) {
  await ensureReasons(db, c.companyId);
  const problems = [];
  const p = readReason(input, problems);
  if (input.sortOrder === undefined) {
    const [[m]] = await db.query('SELECT COALESCE(MAX(sort_order), 0) AS m FROM cf_stop_reasons WHERE company_id = ? AND deleted_at IS NULL', [c.companyId]);
    p.sortOrder = Number(m.m) + 10;
  }
  assertNoProblems(problems, 'The reason has problems.');
  const [r] = await db.query('INSERT INTO cf_stop_reasons (company_id, code, label, sort_order, needs_note, status) VALUES (?, ?, ?, ?, ?, ?)',
    [c.companyId, p.code, p.label, p.sortOrder, p.needsNote ? 1 : 0, p.status]);
  return shapeReason(await requireReasonRow(db, c.companyId, r.insertId));
}

export async function updateStopReason(db, c, id, input = {}) {
  const old = await requireReasonRow(db, c.companyId, id);
  const problems = [];
  const p = readReason(input, problems, old);
  assertNoProblems(problems, 'The reason has problems.');
  await db.query('UPDATE cf_stop_reasons SET code = ?, label = ?, sort_order = ?, needs_note = ?, status = ? WHERE company_id = ? AND id = ?',
    [p.code, p.label, p.sortOrder, p.needsNote ? 1 : 0, p.status, c.companyId, id]);
  return shapeReason(await requireReasonRow(db, c.companyId, id));
}

/** A reason leaves the list; stops already recorded with it keep it (soft delete). */
export async function deleteStopReason(db, c, id) {
  await requireReasonRow(db, c.companyId, id);
  await db.query('UPDATE cf_stop_reasons SET deleted_at = NOW() WHERE company_id = ? AND id = ?', [c.companyId, id]);
  return { ok: true };
}

// --- setup: the plant clock -----------------------------------------------------------

export async function getFloorSettings(db, companyId) {
  const [[row]] = await db.query('SELECT timezone FROM cf_floor_settings WHERE company_id = ?', [companyId]);
  return { timezone: row?.timezone ?? DEFAULT_TIMEZONE, isDefault: !row };
}

/** PUT /floor/settings { timezone } — the IANA zone the plant's clock (and its shifts) are in. */
export async function putFloorSettings(db, c, input = {}) {
  const tz = String(input.timezone ?? '').trim();
  if (!tz || !validZone(tz)) throw invalid('INVALID', 'Give a time zone such as Asia/Kolkata.');
  await db.query(
    'INSERT INTO cf_floor_settings (company_id, timezone, updated_by) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE timezone = VALUES(timezone), updated_by = VALUES(updated_by)',
    [c.companyId, tz, c.userId],
  );
  zoneCache.delete(c.companyId);
  return getFloorSettings(db, c.companyId);
}
