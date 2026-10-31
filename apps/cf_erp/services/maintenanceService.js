/**
 * maintenanceService.js — MAINTENANCE (init.sql §82, TM/CF_ERP_NEXT_STEPS_PLAN.md S6, user decisions 2026-10-18).
 *
 *   PLANNED DOWNTIME   a rule per machine (once / weekly / monthly, with a reason) WRITTEN INTO the machine calendar
 *                      the planner already reads: each occurrence becomes 'closed' timed rows of
 *                      cf_machine_calendar_exceptions (one per day it touches, stamped downtime_id). Chosen over
 *                      teaching the calendar reader the rules because every reader (planner, machine log, dashboard)
 *                      then sees it with no code change and no extra read. Expanded EXPANSION_DAYS ahead and topped up
 *                      (topUp) whenever Maintenance is opened; an edit rewrites the rule's rows from today on, the past
 *                      stays as it was.
 *   RAISE A FAULT      anyone on the floor: a cf_machine_stops row (the floor's own table; jobs running on the machine
 *                      are paused, an operator's open stop ends) and a MAINTENANCE ORDER that holds it. An open stop
 *                      named by an open MO is a FAULT: shiftService.machinesCalendar gives that machine NO capacity
 *                      from the stop's start until it is closed. A false alarm ends the stop and cancels the MO.
 *   MAINTENANCE ORDERS open → in_progress → waiting_parts → done, or cancelled. Starting a preventive / manual MO
 *                      takes the machine down too (a "Cleaning / maintenance" stop, unless told not to). Closing ends
 *                      the stop (machine back up) and records downtime minutes and cost (parts issued against the MO,
 *                      when the stores record them — S8 — plus any other cost typed with a note).
 *   PREVENTIVE PLANS   every N days / N run hours / N tonnes since the last service (baseline_at). Hours and tonnes
 *                      come from the machine log: run minutes of cf_work_sessions, tonnes = good count x the piece's
 *                      WEIGHT. A plan that is due gets ONE open MO (uq_cmo_open_plan), raised when Maintenance is read.
 *   MR FROM AN MO      requisitionService.createRequisition({ forType: 'maintenance_order', maintenanceOrderId, orderId? })
 *                      — lines prefilled from the machine's tools / spares / consumables (machineResources, §81).
 *
 * Times on the floor are the PLANT clock (floorService.plantZone); every write is set-based, the reads are a fixed
 * number per call whatever the number of machines.
 */
import { invalid, notFound, conflict, assertNoProblems } from '../lib/errors.js';
import { insertRows } from '../lib/db.js';
import { plantZone, wallOf, listReasons } from './floorService.js';
import { productionMachineIds } from './operationService.js';
import { WEEKDAYS } from './shiftService.js';
import * as requisitions from './requisitionService.js';
import * as resources from './machineResourceService.js';

export const MO_STATUSES = ['open', 'in_progress', 'waiting_parts', 'done', 'cancelled'];
export const MO_STATUS_LABEL = { open: 'Open', in_progress: 'In progress', waiting_parts: 'Waiting for parts', done: 'Done', cancelled: 'Cancelled' };
export const ACTIVE_STATUSES = ['open', 'in_progress', 'waiting_parts'];
/** Moves the MO's own buttons make; done and cancelled have their own calls (they end the stop and count). */
export const TRANSITIONS = { open: ['in_progress', 'waiting_parts'], in_progress: ['waiting_parts'], waiting_parts: ['in_progress'] };
export const DOWNTIME_KINDS = ['once', 'weekly', 'monthly'];
/** Written into the calendar this far ahead; topped up once less than TOP_UP_DAYS is left (the planner reads ≤ 400). */
export const EXPANSION_DAYS = 730;
const TOP_UP_DAYS = 420;
const DAY = 1440;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)(:\d{2})?$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const blank = (v) => v == null || String(v).trim() === '';
const missingSchema = (e) => e?.code === 'ER_NO_SUCH_TABLE' || e?.errno === 1146 || e?.code === 'ER_BAD_FIELD_ERROR' || e?.errno === 1054;

// --- dates as text (UTC arithmetic: no daylight saving can move a day) ---------------------------------------
const dms = (s) => Date.parse(`${s}T00:00:00Z`);
const dstr = (ms) => new Date(ms).toISOString().slice(0, 10);
export const addDaysS = (s, n) => dstr(dms(s) + n * 86400000);
const weekdayOfS = (s) => WEEKDAYS[(new Date(dms(s)).getUTCDay() + 6) % 7];
const mondayOf = (s) => addDaysS(s, -WEEKDAYS.indexOf(weekdayOfS(s)));
const daysBetween = (a, b) => Math.round((dms(b) - dms(a)) / 86400000);
const lastDayOfMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate(); // m is 1-based
const toMin = (t) => { const m = TIME_RE.exec(String(t ?? '')); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
const hhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
const dbDate = (d) => (d == null ? null : d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));
/** A DATETIME read with timezone 'Z' (its UTC fields ARE the plant wall clock) as 'YYYY-MM-DD HH:MM:SS'. */
const dbWall = (d) => (d == null ? null : d instanceof Date ? d.toISOString().slice(0, 19).replace('T', ' ') : String(d).replace('T', ' ').slice(0, 19));
const wallMs = (w) => Date.parse(`${String(w).replace(' ', 'T')}Z`);
const minutesBetween = (a, b) => Math.max(0, Math.round((wallMs(b) - wallMs(a)) / 60000));

async function plantNow(db, companyId) {
  const tz = await plantZone(db, companyId);
  const wall = wallOf(Date.now(), tz);
  return { tz, wall, today: wall.slice(0, 10) };
}

/* =================================================================================================
 * PLANNED DOWNTIME — the pure part
 * ============================================================================================== */

/** Does the rule fall on date s (the day an occurrence STARTS)? */
export function ruleOnDate(r, s) {
  if (s < r.startsOn || (r.endsOn && s > r.endsOn)) return false;
  if (r.kind === 'once') return s === r.startsOn;
  const n = Math.max(1, Number(r.everyN) || 1);
  if (r.kind === 'weekly') {
    if (!r.weekdays.includes(weekdayOfS(s))) return false;
    return (daysBetween(mondayOf(r.startsOn), mondayOf(s)) / 7) % n === 0;
  }
  // monthly
  const [y, m, d] = s.split('-').map(Number);
  const [y0, m0] = r.startsOn.split('-').map(Number);
  if (((y - y0) * 12 + (m - m0)) % n !== 0) return false;
  if (r.monthDay) return d === Math.min(r.monthDay, lastDayOfMonth(y, m));
  if (weekdayOfS(s) !== r.monthWeekday) return false;
  if (r.monthWeek === 5) return d + 7 > lastDayOfMonth(y, m);
  return Math.ceil(d / 7) === r.monthWeek;
}

/** Occurrences STARTING from..to: [{ start: 'YYYY-MM-DD HH:MM', end, minutes }]. */
export function occurrences(r, fromS, toS) {
  const out = [];
  const st = toMin(r.startTime);
  for (let s = fromS < r.startsOn ? r.startsOn : fromS; s <= toS; s = addDaysS(s, 1)) {
    if (r.endsOn && s > r.endsOn) break;
    if (!ruleOnDate(r, s)) continue;
    const a = dms(s) + st * 60000;
    const b = a + r.durationMinutes * 60000;
    const txt = (ms) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
    out.push({ start: txt(a), end: txt(b), minutes: r.durationMinutes });
    if (r.kind === 'once') break;
  }
  return out;
}

/**
 * The calendar rows of a rule for dates from..to: every occurrence cut at midnight into one 'closed' timed row per day
 * (end '00:00' = to midnight; 00:00-00:00 = the whole day, which calendarDays reads as 24 h). Occurrences that started
 * up to their length before `from` are included, so a window crossing `from` keeps its tail.
 */
export function expandRule(r, fromS, toS) {
  const back = Math.ceil(r.durationMinutes / DAY);
  const rows = [];
  for (const o of occurrences(r, addDaysS(fromS, -back), toS)) {
    let a = wallMs(o.start);
    const b = wallMs(o.end);
    while (a < b) {
      const ds = dstr(a);
      const nextMidnight = dms(ds) + 86400000;
      const e = Math.min(b, nextMidnight);
      if (ds >= fromS && ds <= toS) {
        rows.push({ date: ds, start: hhmm(Math.round((a - dms(ds)) / 60000)), end: e === nextMidnight ? '00:00' : hhmm(Math.round((e - dms(ds)) / 60000)) });
      }
      a = e;
    }
  }
  return rows;
}

/** Plain words for a rule: "Every 1st Sunday, 08:00 for 8 h". */
export function ruleText(r) {
  const len = r.durationMinutes % 60 === 0 ? `${r.durationMinutes / 60} h` : `${r.durationMinutes} min`;
  const at = `${r.startTime} for ${len}`;
  const day = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' };
  if (r.kind === 'once') return `Once, ${r.startsOn} ${at}`;
  if (r.kind === 'weekly') {
    const every = r.everyN > 1 ? `Every ${r.everyN} weeks on` : 'Every';
    return `${every} ${r.weekdays.map((w) => day[w]).join(', ')}, ${at}`;
  }
  const every = r.everyN > 1 ? ` of every ${r.everyN} months` : ' of the month';
  if (r.monthDay) return `Day ${r.monthDay}${every}, ${at}`;
  const nth = { 1: '1st', 2: '2nd', 3: '3rd', 4: '4th', 5: 'last' }[r.monthWeek];
  return `Every ${nth} ${day[r.monthWeekday]}${r.everyN > 1 ? ` (every ${r.everyN} months)` : ''}, ${at}`;
}

function shapeRule(row) {
  const r = {
    id: row.id, machineId: row.machine_id, kind: row.kind, reason: row.reason,
    startsOn: dbDate(row.starts_on), endsOn: dbDate(row.ends_on), startTime: hhmm(toMin(String(row.start_time))),
    durationMinutes: Number(row.duration_minutes), weekdays: row.weekdays ? String(row.weekdays).split(',').filter(Boolean) : [],
    everyN: Number(row.every_n) || 1, monthDay: row.month_day == null ? null : Number(row.month_day),
    monthWeek: row.month_week == null ? null : Number(row.month_week), monthWeekday: row.month_weekday ?? null,
    expandedTo: dbDate(row.expanded_to), notes: row.notes ?? null,
    machineCode: row.machine_code ?? undefined, machineName: row.machine_name ?? undefined,
  };
  r.text = ruleText(r);
  return r;
}

/** Reads and checks a rule; `existing` (shaped) fills what the input leaves out. */
export function readRule(input = {}, existing = null) {
  const pick = (k) => (input[k] !== undefined ? input[k] : existing?.[k]);
  const problems = [];
  const kind = pick('kind');
  if (!DOWNTIME_KINDS.includes(kind)) problems.push('Choose once, weekly or monthly.');
  const reason = String(pick('reason') ?? '').trim();
  if (!reason) problems.push('Say why the machine is down (the reason).');
  else if (reason.length > 255) problems.push('The reason is up to 255 characters.');
  const startsOn = String(pick('startsOn') ?? '').trim();
  if (!DATE_RE.test(startsOn) || dstr(dms(startsOn)) !== startsOn) problems.push('Give the first date as YYYY-MM-DD.');
  const endsRaw = pick('endsOn');
  const endsOn = kind === 'once' || blank(endsRaw) ? null : String(endsRaw).trim();
  if (endsOn && (!DATE_RE.test(endsOn) || endsOn < startsOn)) problems.push('The last date is a date on or after the first.');
  const st = toMin(pick('startTime'));
  if (st == null) problems.push('Give the start time as HH:MM.');
  const durationMinutes = Number(pick('durationMinutes'));
  const maxLen = kind === 'once' ? 60 * DAY : 7 * DAY;
  if (!Number.isInteger(durationMinutes) || durationMinutes <= 0) problems.push('Give how long it is down, in whole minutes.');
  else if (durationMinutes > maxLen) problems.push(kind === 'once' ? 'A one-off window is at most 60 days.' : 'A repeating window is at most 7 days long.');
  const everyN = Number(pick('everyN') ?? 1) || 1;
  if (!Number.isInteger(everyN) || everyN < 1 || everyN > 52) problems.push('"Every" is a whole number from 1 to 52.');
  let weekdays = [];
  let monthDay = null;
  let monthWeek = null;
  let monthWeekday = null;
  if (kind === 'weekly') {
    const raw = pick('weekdays');
    weekdays = (Array.isArray(raw) ? raw : String(raw ?? '').split(',')).map((w) => String(w).trim().toLowerCase()).filter(Boolean);
    if (!weekdays.length) problems.push('Choose the days of the week.');
    if (weekdays.some((w) => !WEEKDAYS.includes(w))) problems.push('Days are mon, tue, wed, thu, fri, sat, sun.');
    weekdays = WEEKDAYS.filter((w) => weekdays.includes(w));
    if (durationMinutes > 0 && durationMinutes > 7 * DAY / Math.max(1, weekdays.length)) problems.push('The windows would overlap — shorten it or choose fewer days.');
  }
  if (kind === 'monthly') {
    const md = pick('monthDay');
    if (!blank(md)) {
      monthDay = Number(md);
      if (!Number.isInteger(monthDay) || monthDay < 1 || monthDay > 31) problems.push('The day of the month is 1 to 31.');
    } else {
      monthWeek = Number(pick('monthWeek'));
      monthWeekday = String(pick('monthWeekday') ?? '').toLowerCase();
      if (![1, 2, 3, 4, 5].includes(monthWeek)) problems.push('Choose 1st, 2nd, 3rd, 4th or last.');
      if (!WEEKDAYS.includes(monthWeekday)) problems.push('Choose the day of the week.');
    }
  }
  const notes = blank(pick('notes')) ? null : String(pick('notes')).slice(0, 500);
  assertNoProblems(problems, problems.length === 1 ? problems[0] : 'The planned downtime has problems.');
  const r = { kind, reason, startsOn, endsOn, startTime: hhmm(st), durationMinutes, everyN: kind === 'once' ? 1 : everyN, weekdays, monthDay, monthWeek, monthWeekday, notes };
  r.text = ruleText(r);
  return r;
}

/* =================================================================================================
 * PLANNED DOWNTIME — reads and writes
 * ============================================================================================== */

const EX_COLS = ['company_id', 'machine_id', 'exception_date', 'kind', 'shift_id', 'start_time', 'end_time', 'reason', 'downtime_id', 'created_by'];

/**
 * Rewrites the calendar rows of these rules from `fromS` to `toS`: one soft delete, the inserts (1000 rows a statement),
 * one expanded_to update — 3 round trips for any number of rules. `keep` = do not delete (a top-up appends).
 */
async function writeExpansion(db, c, rules, fromS, toS, { keep = false } = {}) {
  if (!rules.length) return 0;
  const ids = rules.map((r) => r.id);
  if (!keep) {
    await db.query('UPDATE cf_machine_calendar_exceptions SET deleted_at = NOW() WHERE company_id = ? AND downtime_id IN (?) AND exception_date >= ? AND deleted_at IS NULL', [c.companyId, ids, fromS]);
  }
  const rows = [];
  for (const r of rules) {
    for (const p of expandRule(r, fromS, toS)) rows.push([c.companyId, r.machineId, p.date, 'closed', null, p.start, p.end, `Planned: ${r.reason}`.slice(0, 255), r.id, c.userId ?? null]);
  }
  if (rows.length) await insertRows(db, 'cf_machine_calendar_exceptions', EX_COLS, rows, 1000);
  await db.query('UPDATE cf_planned_downtimes SET expanded_to = ? WHERE company_id = ? AND id IN (?)', [toS, c.companyId, ids]);
  return rows.length;
}

/** Rules whose calendar rows run out within TOP_UP_DAYS get EXPANSION_DAYS more. 1 read; 3 writes only when needed. */
export async function topUp(db, c, today) {
  let rows;
  try {
    [rows] = await db.query(
      `SELECT * FROM cf_planned_downtimes WHERE company_id = ? AND deleted_at IS NULL
          AND expanded_to < ? AND (ends_on IS NULL OR ends_on > expanded_to)`,
      [c.companyId, addDaysS(today, TOP_UP_DAYS)],
    );
  } catch (e) { if (missingSchema(e)) return 0; throw e; }
  if (!rows.length) return 0;
  const to = addDaysS(today, EXPANSION_DAYS);
  // Rules with different expanded_to are appended from their own day; usually there is one group.
  const groups = new Map();
  for (const row of rows) { const k = addDaysS(dbDate(row.expanded_to), 1); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(shapeRule(row)); }
  let n = 0;
  for (const [from, rules] of groups) n += await writeExpansion(db, c, rules, from, to, { keep: true });
  return n;
}

export async function listDowntimes(db, companyId, q = {}) {
  const args = [companyId];
  let where = '';
  if (!blank(q.machineId)) { where = ' AND d.machine_id = ?'; args.push(Number(q.machineId)); }
  const [rows] = await db.query(
    `SELECT d.*, m.code AS machine_code, m.name AS machine_name FROM cf_planned_downtimes d JOIN cf_machines m ON m.id = d.machine_id
      WHERE d.company_id = ? AND d.deleted_at IS NULL${where} ORDER BY m.code, d.starts_on, d.id`,
    args,
  );
  const { today } = await plantNow(db, companyId);
  const horizon = addDaysS(today, 60);
  return {
    today,
    rows: rows.map((row) => {
      const r = shapeRule(row);
      r.next = occurrences(r, today, horizon).slice(0, 3);
      return r;
    }),
  };
}

async function requireRule(db, companyId, id) {
  const [[row]] = await db.query('SELECT * FROM cf_planned_downtimes WHERE company_id = ? AND id = ? AND deleted_at IS NULL FOR UPDATE', [companyId, id]);
  if (!row) throw notFound('Planned downtime');
  return shapeRule(row);
}

async function requireActiveMachine(db, companyId, raw) {
  if (blank(raw) || !Number.isInteger(Number(raw)) || Number(raw) <= 0) throw invalid('INVALID', 'Choose the machine.');
  const [[m]] = await db.query('SELECT id, code, name, status FROM cf_machines WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [companyId, Number(raw)]);
  if (!m) throw notFound('Machine');
  if (m.status !== 'active') throw invalid('INACTIVE', `${m.code} is not active.`);
  return m;
}

/**
 * POST /maintenance/downtime { machineId, kind, reason, startsOn, endsOn?, startTime, durationMinutes, weekdays?,
 * everyN?, monthDay? | monthWeek + monthWeekday, notes?, dryRun? } — dryRun returns the next occurrences only.
 * Written from its first day (past days too: a one-off yesterday is recorded as it was).
 */
export async function createDowntime(db, c, input = {}) {
  const machine = await requireActiveMachine(db, c.companyId, input.machineId);
  const r = readRule(input);
  const { today } = await plantNow(db, c.companyId);
  if (input.dryRun) return { rule: r, next: occurrences(r, today, addDaysS(today, 120)).slice(0, 6) };
  const to = addDaysS(today, EXPANSION_DAYS);
  const [res] = await db.query(
    `INSERT INTO cf_planned_downtimes (company_id, machine_id, kind, reason, starts_on, ends_on, start_time, duration_minutes, weekdays, every_n,
       month_day, month_week, month_weekday, expanded_to, notes, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [c.companyId, machine.id, r.kind, r.reason, r.startsOn, r.endsOn, r.startTime, r.durationMinutes, r.weekdays.join(',') || null, r.everyN,
      r.monthDay, r.monthWeek, r.monthWeekday, to, r.notes, c.userId ?? null],
  );
  const rule = { ...r, id: res.insertId, machineId: machine.id };
  const rows = await writeExpansion(db, c, [rule], r.startsOn < today ? r.startsOn : today, to, { keep: true });
  return { id: res.insertId, rule, calendarRows: rows, next: occurrences(rule, today, addDaysS(today, 120)).slice(0, 6) };
}

/** PUT /maintenance/downtime/:id — the change applies from today on; the past keeps what happened. */
export async function updateDowntime(db, c, id, input = {}) {
  const old = await requireRule(db, c.companyId, id);
  const r = readRule(input, old);
  const machineId = blank(input.machineId) ? old.machineId : (await requireActiveMachine(db, c.companyId, input.machineId)).id;
  const { today } = await plantNow(db, c.companyId);
  const to = addDaysS(today, EXPANSION_DAYS);
  await db.query(
    `UPDATE cf_planned_downtimes SET machine_id = ?, kind = ?, reason = ?, starts_on = ?, ends_on = ?, start_time = ?, duration_minutes = ?, weekdays = ?,
       every_n = ?, month_day = ?, month_week = ?, month_weekday = ?, notes = ? WHERE company_id = ? AND id = ?`,
    [machineId, r.kind, r.reason, r.startsOn, r.endsOn, r.startTime, r.durationMinutes, r.weekdays.join(',') || null, r.everyN,
      r.monthDay, r.monthWeek, r.monthWeekday, r.notes, c.companyId, id],
  );
  const rule = { ...r, id, machineId };
  const rows = await writeExpansion(db, c, [rule], today, to);
  return { id, rule, calendarRows: rows, next: occurrences(rule, today, addDaysS(today, 120)).slice(0, 6) };
}

/** DELETE /maintenance/downtime/:id — its calendar rows from today on go with it. */
export async function deleteDowntime(db, c, id) {
  await requireRule(db, c.companyId, id);
  const { today } = await plantNow(db, c.companyId);
  await db.query('UPDATE cf_machine_calendar_exceptions SET deleted_at = NOW() WHERE company_id = ? AND downtime_id = ? AND exception_date >= ? AND deleted_at IS NULL', [c.companyId, id, today]);
  await db.query('UPDATE cf_planned_downtimes SET deleted_at = NOW() WHERE company_id = ? AND id = ?', [c.companyId, id]);
  return { ok: true };
}

/* =================================================================================================
 * MAINTENANCE ORDERS
 * ============================================================================================== */

/** New MOs, set-based: one multi-row INSERT, their 'raised' events, their codes (MO-000123). 3 round trips. */
async function insertOrders(db, c, rows) {
  const cols = ['company_id', 'machine_id', 'source', 'plan_id', 'stop_id', 'reason_id', 'title', 'note', 'status', 'raised_at', 'operator_id', 'started_at', 'created_by'];
  await insertRows(db, 'cf_maintenance_orders', cols, rows.map((r) => [c.companyId, r.machineId, r.source, r.planId ?? null, r.stopId ?? null, r.reasonId ?? null,
    String(r.title).slice(0, 255), r.note ? String(r.note).slice(0, 1000) : null, r.status ?? 'open', r.raisedAt, r.operatorId ?? null, r.startedAt ?? null, c.userId ?? null]));
  await db.query(
    `INSERT INTO cf_maintenance_events (company_id, maintenance_order_id, event, to_status, note, created_by)
     SELECT company_id, id, 'raised', status, note, ? FROM cf_maintenance_orders WHERE company_id = ? AND code IS NULL AND deleted_at IS NULL`,
    [c.userId ?? null, c.companyId],
  );
  await db.query("UPDATE cf_maintenance_orders SET code = CONCAT('MO-', LPAD(id, 6, '0')) WHERE company_id = ? AND code IS NULL", [c.companyId]);
}

const event = (db, c, moId, ev, from, to, note) => db.query(
  'INSERT INTO cf_maintenance_events (company_id, maintenance_order_id, event, from_status, to_status, note, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
  [c.companyId, moId, ev, from ?? null, to ?? null, note ? String(note).slice(0, 1000) : null, c.userId ?? null],
);

/**
 * Takes a machine down at `wall`: an open stop that is not a fault ends there, jobs running on it are paused (a machine
 * is stopped or working, not both — the floor's rule), and a live stop starts. Returns the new stop's id.
 */
async function takeDown(db, c, machine, { reasonId, note, operatorId, wall }) {
  const [[open], [running]] = await Promise.all([
    db.query(
      `SELECT st.id, r.label, mo.code AS mo_code FROM cf_machine_stops st JOIN cf_stop_reasons r ON r.id = st.reason_id
         LEFT JOIN cf_maintenance_orders mo ON mo.company_id = st.company_id AND mo.deleted_at IS NULL AND mo.status IN ('open','in_progress','waiting_parts')
              AND (mo.stop_id = st.id OR mo.stop_id = st.replaces_id)
        WHERE st.company_id = ? AND st.machine_id = ? AND st.ended_at IS NULL AND st.deleted_at IS NULL FOR UPDATE`,
      [c.companyId, machine.id],
    ),
    db.query('SELECT id FROM cf_work_sessions WHERE company_id = ? AND machine_id = ? AND ended_at IS NULL AND deleted_at IS NULL FOR UPDATE', [c.companyId, machine.id]),
  ]);
  const fault = open.find((s) => s.mo_code);
  if (fault) throw conflict('ALREADY_DOWN', `${machine.code} is already down — ${fault.mo_code} (${fault.label}).`);
  if (open.length) await db.query('UPDATE cf_machine_stops SET ended_at = GREATEST(started_at, ?) WHERE company_id = ? AND id IN (?)', [wall, c.companyId, open.map((s) => s.id)]);
  if (running.length) {
    await db.query("UPDATE cf_work_sessions SET ended_at = GREATEST(started_at, ?), end_kind = 'pause' WHERE company_id = ? AND id IN (?)", [wall, c.companyId, running.map((s) => s.id)]);
  }
  const [res] = await db.query(
    `INSERT INTO cf_machine_stops (company_id, machine_id, started_at, reason_id, note, operator_id, source, entered_by)
     VALUES (?, ?, ?, ?, ?, ?, 'live', ?)`,
    [c.companyId, machine.id, wall, reasonId, note ? String(note).slice(0, 500) : null, operatorId ?? null, c.userId ?? null],
  );
  return { stopId: res.insertId, endedStops: open.length, pausedSessions: running.length };
}

/** Ends the MO's stop now (if still open). Returns { started, ended } of the stop, or null when it has none. */
async function endStopOf(db, c, mo, wall) {
  if (!mo.stop_id) return null;
  const [[st]] = await db.query(
    'SELECT id, started_at, ended_at FROM cf_machine_stops WHERE company_id = ? AND (id = ? OR replaces_id = ?) AND deleted_at IS NULL ORDER BY id DESC LIMIT 1 FOR UPDATE',
    [c.companyId, mo.stop_id, mo.stop_id],
  );
  if (!st) return null;
  let ended = dbWall(st.ended_at);
  if (!ended) {
    await db.query('UPDATE cf_machine_stops SET ended_at = GREATEST(started_at, ?) WHERE company_id = ? AND id = ?', [wall, c.companyId, st.id]);
    ended = wall < dbWall(st.started_at) ? dbWall(st.started_at) : wall;
  }
  return { started: dbWall(st.started_at), ended };
}

/** A stop reason by code (seeded with the floor's twelve when the company has none). */
async function reasonByCode(db, companyId, codes) {
  const reasons = await listReasons(db, companyId);
  for (const code of codes) { const r = reasons.find((x) => String(x.code).toUpperCase() === code); if (r) return r; }
  return reasons[0] ?? null;
}

/**
 * POST /maintenance/faults { machineId, reasonId?, note?, operatorId? } — anyone on the floor marks a machine down:
 * a live stop (reason default "Breakdown") and an MO that holds it; the planner sees no capacity at once.
 */
export async function raiseFault(db, c, input = {}) {
  const machine = await requireActiveMachine(db, c.companyId, input.machineId);
  const { wall } = await plantNow(db, c.companyId);
  const reasons = await listReasons(db, c.companyId);
  let reason;
  if (!blank(input.reasonId)) {
    reason = reasons.find((r) => r.id === Number(input.reasonId));
    if (!reason) throw invalid('INVALID', 'That reason is not on the list.');
  } else {
    reason = reasons.find((r) => String(r.code).toUpperCase() === 'BREAKDOWN') ?? reasons[0];
  }
  const note = blank(input.note) ? null : String(input.note).trim();
  if (reason?.needsNote && !note) throw invalid('INVALID', `Say what happened — "${reason.label}" needs a note.`);
  let operatorId = null;
  if (!blank(input.operatorId)) {
    const [[o]] = await db.query('SELECT id FROM cf_operators WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [c.companyId, Number(input.operatorId)]);
    if (!o) throw invalid('INVALID', 'That operator is not on the list.');
    operatorId = o.id;
  }
  const down = await takeDown(db, c, machine, { reasonId: reason.id, note, operatorId, wall });
  const title = `${reason.label}${note ? ` — ${note}` : ''}`;
  await insertOrders(db, c, [{ machineId: machine.id, source: 'fault', stopId: down.stopId, reasonId: reason.id, title, note, raisedAt: wall, operatorId }]);
  const [[mo]] = await db.query('SELECT id, code FROM cf_maintenance_orders WHERE company_id = ? AND stop_id = ? AND deleted_at IS NULL ORDER BY id DESC LIMIT 1', [c.companyId, down.stopId]);
  return { order: { id: mo.id, code: mo.code }, stopId: down.stopId, pausedSessions: down.pausedSessions, message: `${machine.code} is down. ${mo.code} is open for maintenance.` };
}

/** POST /maintenance/orders { machineId, title, note? } — a job maintenance raises itself (the machine stays up until it starts). */
export async function createOrder(db, c, input = {}) {
  const machine = await requireActiveMachine(db, c.companyId, input.machineId);
  const title = String(input.title ?? '').trim();
  if (!title) throw invalid('INVALID', 'Say what the job is.');
  const { wall } = await plantNow(db, c.companyId);
  await insertOrders(db, c, [{ machineId: machine.id, source: 'manual', title, note: input.note, raisedAt: wall }]);
  const [[mo]] = await db.query("SELECT id, code FROM cf_maintenance_orders WHERE company_id = ? AND machine_id = ? AND source = 'manual' AND deleted_at IS NULL ORDER BY id DESC LIMIT 1", [c.companyId, machine.id]);
  return { order: mo };
}

async function requireOrder(db, companyId, id) {
  const [[mo]] = await db.query('SELECT * FROM cf_maintenance_orders WHERE company_id = ? AND id = ? AND deleted_at IS NULL FOR UPDATE', [companyId, id]);
  if (!mo) throw notFound('Maintenance order');
  return mo;
}

const assertActive = (mo) => {
  if (!ACTIVE_STATUSES.includes(mo.status)) throw invalid('CLOSED', `${mo.code} is ${MO_STATUS_LABEL[mo.status].toLowerCase()}.`);
};

/**
 * POST /maintenance/orders/:id/status { status: in_progress | waiting_parts, note?, stopMachine? } — starting a
 * preventive or manual job takes the machine down ("Cleaning / maintenance") unless stopMachine is false.
 */
export async function setStatus(db, c, id, input = {}) {
  const mo = await requireOrder(db, c.companyId, id);
  assertActive(mo);
  const to = input.status;
  if (!(TRANSITIONS[mo.status] ?? []).includes(to)) throw invalid('INVALID', `${mo.code} cannot go from ${MO_STATUS_LABEL[mo.status]} to ${MO_STATUS_LABEL[to] ?? to}.`);
  const { wall } = await plantNow(db, c.companyId);
  let stopId = mo.stop_id;
  if (to === 'in_progress' && !stopId && input.stopMachine !== false) {
    const machine = await requireActiveMachine(db, c.companyId, mo.machine_id);
    const reason = await reasonByCode(db, c.companyId, ['CLEANING', 'MAINT', 'PM', 'BREAKDOWN']);
    stopId = (await takeDown(db, c, machine, { reasonId: reason.id, note: `${mo.code}: ${mo.title}`, wall })).stopId;
  }
  await db.query('UPDATE cf_maintenance_orders SET status = ?, stop_id = ?, started_at = COALESCE(started_at, IF(? = \'in_progress\', ?, NULL)) WHERE company_id = ? AND id = ?',
    [to, stopId, to, wall, c.companyId, id]);
  await event(db, c, id, 'status', mo.status, to, input.note);
  return getOrder(db, c.companyId, id);
}

/** Parts issued against the MO — Stores' issues naming it (init.sql §95: cf_stock_movements.maintenance_order_id; the MR's
 * "Issue now" puts it there). null = none recorded. */
async function partsCost(db, companyId, id) {
  return (await partsCosts(db, companyId, [id])).get(Number(id)) ?? null;
}

/** The parts cost of several MOs at once: Map moId → rupees (an MO with no issue is not in it). 1 read. */
async function partsCosts(db, companyId, ids) {
  const out = new Map();
  if (!ids.length) return out;
  try {
    const [rows] = await db.query(
      `SELECT m.maintenance_order_id AS mo, -SUM(l.value) AS cost, COUNT(*) AS n FROM cf_stock_ledger l JOIN cf_stock_movements m ON m.id = l.movement_id
        WHERE m.company_id = ? AND m.maintenance_order_id IN (?) AND m.reversal_of_id IS NULL AND m.reversed_by_id IS NULL AND l.deleted_at IS NULL
        GROUP BY m.maintenance_order_id`,
      [companyId, ids.map(Number)],
    );
    for (const r of rows) if (Number(r.n)) out.set(Number(r.mo), Math.round(Number(r.cost ?? 0) * 100) / 100);
    return out;
  } catch (e) { if (missingSchema(e)) return out; throw e; }
}

/** An open MO's money so far: the parts issued to it, read live (stored on the MO only when it is closed). */
function withLiveParts(o, parts) {
  if (!ACTIVE_STATUSES.includes(o.status)) return o;
  const partsCost = parts ?? null;
  return { ...o, partsCost, cost: partsCost == null && !o.otherCost ? null : Number(partsCost ?? 0) + Number(o.otherCost ?? 0) };
}

const readMoney = (raw, label) => {
  if (blank(raw)) return 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw invalid('INVALID', `${label} is an amount, zero or more.`);
  return Math.round(n * 100) / 100;
};

/** Done / cancelled: ends the stop (machine back up), counts the downtime, moves a preventive plan's baseline. */
async function finish(db, c, mo, { status, falseAlarm = false, note = null, workDone = null, otherCost = 0, costNote = null }) {
  const { wall } = await plantNow(db, c.companyId);
  const span = await endStopOf(db, c, mo, wall);
  const downtime = span ? minutesBetween(span.started, span.ended) : null;
  const parts = status === 'done' ? await partsCost(db, c.companyId, mo.id) : null;
  await db.query(
    `UPDATE cf_maintenance_orders SET status = ?, false_alarm = ?, downtime_minutes = ?, parts_cost = ?, other_cost = ?, cost_note = ?, work_done = ?,
       done_at = IF(? = 'done', ?, done_at), cancelled_at = IF(? = 'cancelled', ?, cancelled_at) WHERE company_id = ? AND id = ?`,
    [status, falseAlarm ? 1 : 0, downtime, parts, otherCost, costNote, workDone, status, wall, status, wall, c.companyId, mo.id],
  );
  // Done or skipped, the plan counts again from now — a cancelled preventive job is not raised again at once.
  if (mo.plan_id) await db.query('UPDATE cf_maintenance_plans SET baseline_at = ? WHERE company_id = ? AND id = ?', [wall, c.companyId, mo.plan_id]);
  await event(db, c, mo.id, falseAlarm ? 'false_alarm' : status, mo.status, status, note ?? workDone);
  return { downtimeMinutes: downtime };
}

/** POST /maintenance/orders/:id/false-alarm { note? } — a fault that was not one: the stop ends, the MO is cancelled. */
export async function falseAlarm(db, c, id, input = {}) {
  const mo = await requireOrder(db, c.companyId, id);
  assertActive(mo);
  if (mo.source !== 'fault') throw invalid('INVALID', `${mo.code} was not raised by a fault.`);
  const out = await finish(db, c, mo, { status: 'cancelled', falseAlarm: true, note: blank(input.note) ? 'False alarm' : String(input.note) });
  return { ...out, order: await getOrder(db, c.companyId, id), message: `${mo.code} was a false alarm — the machine is back up.` };
}

/** POST /maintenance/orders/:id/cancel { note } — not needed (a reason is required). */
export async function cancelOrder(db, c, id, input = {}) {
  const mo = await requireOrder(db, c.companyId, id);
  assertActive(mo);
  if (blank(input.note)) throw invalid('INVALID', 'Say why it is cancelled.');
  const out = await finish(db, c, mo, { status: 'cancelled', note: String(input.note) });
  return { ...out, order: await getOrder(db, c.companyId, id) };
}

/** POST /maintenance/orders/:id/close { workDone?, otherCost?, costNote? } — done: the machine is back up. */
export async function closeOrder(db, c, id, input = {}) {
  const mo = await requireOrder(db, c.companyId, id);
  assertActive(mo);
  const otherCost = readMoney(input.otherCost, 'Other cost');
  const costNote = blank(input.costNote) ? null : String(input.costNote).slice(0, 500);
  if (otherCost > 0 && !costNote) throw invalid('INVALID', 'Say what the other cost was for.');
  const workDone = blank(input.workDone) ? null : String(input.workDone).slice(0, 1000);
  const out = await finish(db, c, mo, { status: 'done', workDone, otherCost, costNote });
  return { ...out, order: await getOrder(db, c.companyId, id), message: `${mo.code} is done — the machine is back up.` };
}

/** MRs raised from an MO (cf_requisitions.maintenance_order_id, §79). [] before the Stores section is there. */
async function requisitionsOf(db, companyId, ids) {
  if (!ids.length) return [];
  try {
    const [rows] = await db.query(
      'SELECT id, code, maintenance_order_id, created_at FROM cf_requisitions WHERE company_id = ? AND maintenance_order_id IN (?) AND deleted_at IS NULL ORDER BY id',
      [companyId, ids],
    );
    return rows;
  } catch (e) { if (missingSchema(e)) return []; throw e; }
}

const MO_SELECT = `SELECT mo.*, m.code AS machine_code, m.name AS machine_name, r.label AS reason_label, p.title AS plan_title,
       st.started_at AS stop_started, st.ended_at AS stop_ended, op.name AS operator_name, u.name AS raised_by_name
  FROM cf_maintenance_orders mo
  JOIN cf_machines m ON m.id = mo.machine_id
  LEFT JOIN cf_stop_reasons r ON r.id = mo.reason_id
  LEFT JOIN cf_maintenance_plans p ON p.id = mo.plan_id
  LEFT JOIN cf_machine_stops st ON st.id = mo.stop_id
  LEFT JOIN cf_operators op ON op.id = mo.operator_id
  LEFT JOIN users u ON u.id = mo.created_by`;

function shapeOrder(r, nowWall, mrs = []) {
  const stopStarted = dbWall(r.stop_started);
  const stopEnded = dbWall(r.stop_ended);
  const active = ACTIVE_STATUSES.includes(r.status);
  return {
    id: r.id, code: r.code, status: r.status, statusLabel: MO_STATUS_LABEL[r.status], source: r.source,
    machine: { id: r.machine_id, code: r.machine_code, name: r.machine_name },
    title: r.title, note: r.note ?? null, reason: r.reason_label ?? null, plan: r.plan_id ? { id: r.plan_id, title: r.plan_title } : null,
    raisedAt: dbWall(r.raised_at), raisedBy: r.operator_name ?? r.raised_by_name ?? null, startedAt: dbWall(r.started_at), doneAt: dbWall(r.done_at), cancelledAt: dbWall(r.cancelled_at),
    falseAlarm: !!Number(r.false_alarm), workDone: r.work_done ?? null,
    stop: r.stop_id ? { id: r.stop_id, startedAt: stopStarted, endedAt: stopEnded, open: !!stopStarted && !stopEnded } : null,
    machineDown: !!stopStarted && !stopEnded,
    downtimeMinutes: r.downtime_minutes != null ? Number(r.downtime_minutes) : stopStarted ? minutesBetween(stopStarted, stopEnded ?? nowWall) : null,
    partsCost: r.parts_cost == null ? null : Number(r.parts_cost), otherCost: Number(r.other_cost ?? 0), costNote: r.cost_note ?? null,
    cost: r.parts_cost == null && !Number(r.other_cost) ? null : Number(r.parts_cost ?? 0) + Number(r.other_cost ?? 0),
    requisitions: mrs.filter((x) => x.maintenance_order_id === r.id).map((x) => ({ id: x.id, code: x.code })),
    canFalseAlarm: active && r.source === 'fault',
    next: TRANSITIONS[r.status] ?? [],
  };
}

/** GET /maintenance/orders?status=active|done|cancelled|all&machineId=&search= — newest first, 500 at most. */
export async function listOrders(db, companyId, q = {}) {
  const { wall } = await plantNow(db, companyId);
  const where = ['mo.company_id = ?', 'mo.deleted_at IS NULL'];
  const args = [companyId];
  const status = q.status ?? 'active';
  if (status === 'active') where.push("mo.status IN ('open','in_progress','waiting_parts')");
  else if (MO_STATUSES.includes(status)) { where.push('mo.status = ?'); args.push(status); }
  if (!blank(q.machineId)) { where.push('mo.machine_id = ?'); args.push(Number(q.machineId)); }
  if (!blank(q.search)) {
    const s = `%${String(q.search).trim()}%`;
    where.push('(mo.code LIKE ? OR mo.title LIKE ? OR m.code LIKE ? OR m.name LIKE ?)');
    args.push(s, s, s, s);
  }
  let rows;
  try {
    [rows] = await db.query(`${MO_SELECT} WHERE ${where.join(' AND ')} ORDER BY mo.id DESC LIMIT 500`, args);
  } catch (e) { if (missingSchema(e)) return { now: wall, rows: [] }; throw e; }
  const active = rows.filter((r) => ACTIVE_STATUSES.includes(r.status)).map((r) => r.id);
  const [mrs, parts] = await Promise.all([requisitionsOf(db, companyId, rows.map((r) => r.id)), partsCosts(db, companyId, active)]);
  return { now: wall, rows: rows.map((r) => withLiveParts(shapeOrder(r, wall, mrs), parts.get(Number(r.id)))) };
}

/** GET /maintenance/orders/:id — the MO with its history and MRs (and the parts cost so far). 4 reads. */
export async function getOrder(db, companyId, id) {
  const { wall } = await plantNow(db, companyId);
  const [[[row]], [events], mrs, parts] = await Promise.all([
    db.query(`${MO_SELECT} WHERE mo.company_id = ? AND mo.id = ? AND mo.deleted_at IS NULL`, [companyId, id]),
    db.query(
      `SELECT e.*, u.name AS user_name FROM cf_maintenance_events e LEFT JOIN users u ON u.id = e.created_by
        WHERE e.company_id = ? AND e.maintenance_order_id = ? ORDER BY e.id`,
      [companyId, id],
    ),
    requisitionsOf(db, companyId, [id]),
    partsCost(db, companyId, id),
  ]);
  if (!row) throw notFound('Maintenance order');
  const out = withLiveParts(shapeOrder(row, wall, mrs), parts);
  out.events = events.map((e) => ({ id: e.id, event: e.event, from: e.from_status, to: e.to_status, note: e.note, by: e.user_name ?? null, at: e.created_at }));
  out.now = wall;
  return out;
}

/* =================================================================================================
 * MR FROM AN MO — the shared chain (Stores → PR → PO → Management → GRN)
 * ============================================================================================== */

/** The Tools section's machineResources(db, companyId, machineId) (§81); null if that service lacks it. */
export async function findMachineResources() {
  return typeof resources.machineResources === 'function' ? resources.machineResources : null;
}

/** GET /maintenance/orders/:id/mr-lines — the machine's tools / spares / consumables as the MR's starting lines. */
export async function mrLines(db, companyId, id) {
  const [[mo]] = await db.query('SELECT id, code, machine_id FROM cf_maintenance_orders WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [companyId, id]);
  if (!mo) throw notFound('Maintenance order');
  const fn = await findMachineResources();
  let lines = [];
  if (fn) {
    try { lines = await fn(db, companyId, mo.machine_id); } catch (e) { if (!missingSchema(e)) throw e; }
  }
  return {
    resourcesKnown: !!fn,
    canRaise: typeof requisitions.createRequisition === 'function',
    lines: (lines ?? []).map((l) => ({ itemId: l.itemId, code: l.code ?? null, name: l.name ?? null, kind: l.kind ?? null, qty: Number(l.qty ?? 1) || 1, uom: l.uom ?? null })),
  };
}

/**
 * POST /maintenance/orders/:id/requisition { lines: [{ itemId, qty, uom? }], note?, orderId? } — an MR for the MO
 * (orderId: optional, the sales order the spares are for — user 2026-10-18). An open / in-progress MO now waits for parts.
 */
export async function raiseRequisition(db, c, id, input = {}) {
  const mo = await requireOrder(db, c.companyId, id);
  assertActive(mo);
  if (typeof requisitions.createRequisition !== 'function') {
    throw invalid('NOT_READY', 'Material requests for maintenance come with the Stores update — it is not installed yet.');
  }
  const lines = (Array.isArray(input.lines) ? input.lines : [])
    .map((l) => ({ itemId: Number(l.itemId), qty: Number(l.qty), uom: blank(l.uom) ? undefined : String(l.uom) }))
    .filter((l) => l.qty > 0);
  if (!lines.length) throw invalid('INVALID', 'Add at least one item with a quantity.');
  if (lines.some((l) => !Number.isInteger(l.itemId) || l.itemId <= 0)) throw invalid('INVALID', 'Every line needs an item.');
  const orderId = blank(input.orderId) ? undefined : Number(input.orderId);
  const note = blank(input.note) ? `${mo.code}: ${mo.title}` : String(input.note);
  const mr = await requisitions.createRequisition(db, c, { forType: 'maintenance_order', maintenanceOrderId: mo.id, orderId, note, lines });
  if (mo.status !== 'waiting_parts') await db.query("UPDATE cf_maintenance_orders SET status = 'waiting_parts' WHERE company_id = ? AND id = ?", [c.companyId, mo.id]);
  await event(db, c, mo.id, 'mr', mo.status, 'waiting_parts', `${mr?.code ?? 'MR'} raised (${lines.length} line${lines.length === 1 ? '' : 's'})`);
  return { requisition: mr, order: await getOrder(db, c.companyId, id), message: `${mr?.code ?? 'The MR'} went to Stores. ${mo.code} waits for parts.` };
}

/* =================================================================================================
 * PREVENTIVE PLANS
 * ============================================================================================== */

function readPlan(input = {}, existing = null) {
  const pick = (k, col) => (input[k] !== undefined ? input[k] : existing?.[col]);
  const problems = [];
  const title = String(pick('title', 'title') ?? '').trim();
  if (!title) problems.push('Name the job (e.g. "Monthly lubrication").');
  const num = (k, col, label, int) => {
    const v = pick(k, col);
    if (blank(v)) return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0 || (int && !Number.isInteger(n))) { problems.push(`${label} is a ${int ? 'whole ' : ''}number above zero.`); return null; }
    return n;
  };
  const everyDays = num('everyDays', 'every_days', 'Every … days', true);
  const everyRunHours = num('everyRunHours', 'every_run_hours', 'Every … run hours', false);
  const everyTonnes = num('everyTonnes', 'every_tonnes', 'Every … tonnes', false);
  if (everyDays == null && everyRunHours == null && everyTonnes == null) problems.push('Say how often: every N days, N run hours or N tonnes.');
  const status = pick('status', 'status') ?? 'active';
  if (!['active', 'inactive'].includes(status)) problems.push('A plan is active or inactive.');
  const lastDone = input.lastDoneOn;
  if (!blank(lastDone) && !DATE_RE.test(String(lastDone))) problems.push('Last done is a date, YYYY-MM-DD.');
  assertNoProblems(problems, problems.length === 1 ? problems[0] : 'The plan has problems.');
  return { title: title.slice(0, 255), everyDays, everyRunHours, everyTonnes, status, notes: blank(pick('notes', 'notes')) ? null : String(pick('notes', 'notes')).slice(0, 500), lastDone: blank(lastDone) ? null : String(lastDone) };
}

const KG_PER = { kg: 1, g: 0.001, t: 1000, ton: 1000, tonne: 1000, mt: 1000, lb: 0.45359237 };

/**
 * Every active plan with how far it is: days, run hours and tonnes since its baseline, and whether it is due.
 * 2 reads (plans; usage from the machine log, grouped by plan — only when a plan counts hours or tonnes).
 */
export async function planStatus(db, companyId, { wall, machineId = null, includeInactive = false } = {}) {
  const args = [companyId];
  let where = '';
  if (machineId) { where += ' AND p.machine_id = ?'; args.push(machineId); }
  if (!includeInactive) where += " AND p.status = 'active'";
  let plans;
  try {
    [plans] = await db.query(
      `SELECT p.*, m.code AS machine_code, m.name AS machine_name,
              (SELECT mo.id FROM cf_maintenance_orders mo WHERE mo.company_id = p.company_id AND mo.open_plan = p.id LIMIT 1) AS open_mo_id,
              (SELECT mo.code FROM cf_maintenance_orders mo WHERE mo.company_id = p.company_id AND mo.open_plan = p.id LIMIT 1) AS open_mo_code
         FROM cf_maintenance_plans p JOIN cf_machines m ON m.id = p.machine_id
        WHERE p.company_id = ? AND p.deleted_at IS NULL${where} ORDER BY m.code, p.title`,
      args,
    );
  } catch (e) { if (missingSchema(e)) return []; throw e; }
  const usage = new Map();
  const counted = plans.filter((p) => p.every_run_hours != null || p.every_tonnes != null).map((p) => p.id);
  if (counted.length) {
    // Run time after the baseline (an open session counts to now); good pieces of sessions ending after it x WEIGHT.
    const [rows] = await db.query(
      `SELECT p.id AS plan_id, COALESCE(wv.uom, wsp.default_uom) AS w_uom,
              SUM(GREATEST(0, TIMESTAMPDIFF(SECOND, GREATEST(ws.started_at, p.baseline_at), COALESCE(ws.ended_at, ?)))) AS run_s,
              SUM(IF(ws.ended_at IS NOT NULL AND ws.ended_at > p.baseline_at, ws.qty_good * wv.value_number, 0)) AS w_sum
         FROM cf_maintenance_plans p
         JOIN cf_work_sessions ws ON ws.company_id = p.company_id AND ws.machine_id = p.machine_id AND ws.deleted_at IS NULL
              AND COALESCE(ws.ended_at, ?) > p.baseline_at
         JOIN cf_production_steps s ON s.id = ws.step_id
         JOIN cf_production_items pi ON pi.id = s.production_item_id
         LEFT JOIN cf_spec_values wv ON wv.company_id = p.company_id AND wv.subject_type = 'master' AND wv.subject_id = pi.item_id
              AND wv.deleted_at IS NULL AND wv.value_number IS NOT NULL
              AND wv.specification_id = (SELECT id FROM cf_specifications WHERE company_id = ? AND code = 'WEIGHT' AND deleted_at IS NULL ORDER BY id LIMIT 1)
         LEFT JOIN cf_specifications wsp ON wsp.id = wv.specification_id
        WHERE p.company_id = ? AND p.id IN (?)
        GROUP BY p.id, w_uom`,
      [wall, wall, companyId, companyId, counted],
    );
    for (const r of rows) {
      const u = usage.get(r.plan_id) ?? { runMinutes: 0, kg: 0 };
      u.runMinutes += Number(r.run_s ?? 0) / 60;
      u.kg += Number(r.w_sum ?? 0) * (KG_PER[String(r.w_uom ?? 'kg').toLowerCase()] ?? 0);
      usage.set(r.plan_id, u);
    }
  }
  return plans.map((p) => {
    const baseline = dbWall(p.baseline_at);
    const u = usage.get(p.id) ?? { runMinutes: 0, kg: 0 };
    const days = Math.floor(minutesBetween(baseline, wall) / DAY);
    const hours = Math.round(u.runMinutes / 6) / 10;
    const tonnes = Math.round(u.kg / 10) / 100;
    const ratios = [];
    if (p.every_days != null) ratios.push(days / Number(p.every_days));
    if (p.every_run_hours != null) ratios.push(hours / Number(p.every_run_hours));
    if (p.every_tonnes != null) ratios.push(tonnes / Number(p.every_tonnes));
    const progress = ratios.length ? Math.max(...ratios) : 0;
    return {
      id: p.id, machine: { id: p.machine_id, code: p.machine_code, name: p.machine_name }, title: p.title, status: p.status, notes: p.notes ?? null,
      everyDays: p.every_days == null ? null : Number(p.every_days), everyRunHours: p.every_run_hours == null ? null : Number(p.every_run_hours),
      everyTonnes: p.every_tonnes == null ? null : Number(p.every_tonnes),
      baselineAt: baseline, since: { days, runHours: hours, tonnes },
      nextDueOn: p.every_days != null ? addDaysS(baseline.slice(0, 10), Number(p.every_days)) : null,
      progressPct: Math.round(progress * 100), due: p.status === 'active' && progress >= 1,
      openOrder: p.open_mo_id ? { id: p.open_mo_id, code: p.open_mo_code } : null,
    };
  });
}

/** Every due plan without an open MO gets one — set-based, 3 writes whatever their number. Returns the new MOs' plan ids. */
export async function raiseDue(db, c, { wall = null, statuses = null } = {}) {
  const now = wall ?? (await plantNow(db, c.companyId)).wall;
  const list = statuses ?? await planStatus(db, c.companyId, { wall: now });
  const due = list.filter((p) => p.due && !p.openOrder);
  if (!due.length) return [];
  const why = (p) => [p.everyDays != null ? `${p.since.days} of ${p.everyDays} days` : null, p.everyRunHours != null ? `${p.since.runHours} of ${p.everyRunHours} run hours` : null,
    p.everyTonnes != null ? `${p.since.tonnes} of ${p.everyTonnes} t` : null].filter(Boolean).join(' · ');
  await insertOrders(db, c, due.map((p) => ({ machineId: p.machine.id, source: 'preventive', planId: p.id, title: p.title, note: `Due: ${why(p)}`, raisedAt: now })));
  return due.map((p) => p.id);
}

export async function listPlans(db, c, q = {}) {
  const { wall } = await plantNow(db, c.companyId);
  const raised = q.raise === false ? [] : await raiseDue(db, c, { wall });
  return { now: wall, raised: raised.length, rows: await planStatus(db, c.companyId, { wall, machineId: blank(q.machineId) ? null : Number(q.machineId), includeInactive: true }) };
}

export async function createPlan(db, c, input = {}) {
  const machine = await requireActiveMachine(db, c.companyId, input.machineId);
  const p = readPlan(input);
  const { wall } = await plantNow(db, c.companyId);
  const baseline = p.lastDone ? `${p.lastDone} 00:00:00` : wall;
  const [r] = await db.query(
    `INSERT INTO cf_maintenance_plans (company_id, machine_id, title, every_days, every_run_hours, every_tonnes, baseline_at, status, notes, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [c.companyId, machine.id, p.title, p.everyDays, p.everyRunHours, p.everyTonnes, baseline, p.status, p.notes, c.userId ?? null],
  );
  return { id: r.insertId };
}

export async function updatePlan(db, c, id, input = {}) {
  const [[row]] = await db.query('SELECT * FROM cf_maintenance_plans WHERE company_id = ? AND id = ? AND deleted_at IS NULL FOR UPDATE', [c.companyId, id]);
  if (!row) throw notFound('Preventive plan');
  const p = readPlan(input, row);
  const machineId = blank(input.machineId) ? row.machine_id : (await requireActiveMachine(db, c.companyId, input.machineId)).id;
  await db.query(
    `UPDATE cf_maintenance_plans SET machine_id = ?, title = ?, every_days = ?, every_run_hours = ?, every_tonnes = ?, status = ?, notes = ?,
       baseline_at = COALESCE(?, baseline_at) WHERE company_id = ? AND id = ?`,
    [machineId, p.title, p.everyDays, p.everyRunHours, p.everyTonnes, p.status, p.notes, p.lastDone ? `${p.lastDone} 00:00:00` : null, c.companyId, id],
  );
  return { id };
}

export async function deletePlan(db, c, id) {
  const [r] = await db.query('UPDATE cf_maintenance_plans SET deleted_at = NOW() WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [c.companyId, id]);
  if (!r.affectedRows) throw notFound('Preventive plan');
  return { ok: true };
}

/* =================================================================================================
 * THE MACHINES BOARD and the dashboard card
 * ============================================================================================== */

/**
 * GET /maintenance/board — every production machine (and any machine with an open MO): down (a fault) / stopped (an
 * operator's stop) / planned downtime now / running (a job on it) / idle; planned downtime today and the next 14 days;
 * the open MOs. Tops up the calendar and raises due preventive MOs first. Reads: 1 (top-up) + 2 (plans) + 1 stage of 6.
 */
export async function machinesBoard(db, c) {
  const { wall, today } = await plantNow(db, c.companyId);
  await topUp(db, c, today);
  await raiseDue(db, c, { wall });
  const prodIds = [...await productionMachineIds(db, c.companyId)];
  const safe = (p) => p.catch((e) => { if (missingSchema(e)) return [[]]; throw e; });
  const [[machines], [stops], [orders], [rules], [sessions], reasons] = await Promise.all([
    db.query(
      `SELECT m.id, m.code, m.name, n.name AS type_name FROM cf_machines m LEFT JOIN cf_classification_nodes n ON n.id = m.classification_id
        WHERE m.company_id = ? AND m.deleted_at IS NULL AND m.status = 'active'
          AND (m.id IN (?) OR m.id IN (SELECT machine_id FROM cf_maintenance_orders WHERE company_id = ? AND deleted_at IS NULL AND status IN ('open','in_progress','waiting_parts')))
        ORDER BY m.code`,
      [c.companyId, prodIds.length ? prodIds : [0], c.companyId],
    ),
    db.query(
      `SELECT st.id, st.machine_id, st.started_at, st.replaces_id, r.label FROM cf_machine_stops st JOIN cf_stop_reasons r ON r.id = st.reason_id
        WHERE st.company_id = ? AND st.ended_at IS NULL AND st.deleted_at IS NULL`,
      [c.companyId],
    ),
    safe(db.query(
      `SELECT mo.id, mo.code, mo.machine_id, mo.status, mo.source, mo.title, mo.stop_id, mo.raised_at FROM cf_maintenance_orders mo
        WHERE mo.company_id = ? AND mo.deleted_at IS NULL AND mo.status IN ('open','in_progress','waiting_parts') ORDER BY mo.id`,
      [c.companyId],
    )),
    safe(db.query('SELECT * FROM cf_planned_downtimes WHERE company_id = ? AND deleted_at IS NULL AND (ends_on IS NULL OR ends_on >= ?)', [c.companyId, addDaysS(today, -60)])),
    db.query('SELECT machine_id, COUNT(*) AS n FROM cf_work_sessions WHERE company_id = ? AND ended_at IS NULL AND deleted_at IS NULL GROUP BY machine_id', [c.companyId]),
    listReasons(db, c.companyId),
  ]);
  const ruleList = rules.map(shapeRule);
  const horizon = addDaysS(today, 14);
  const upcoming = [];
  for (const r of ruleList) {
    for (const o of occurrences(r, addDaysS(today, -Math.ceil(r.durationMinutes / DAY)), horizon)) {
      if (o.end.replace(' ', 'T') <= wall.slice(0, 16).replace(' ', 'T')) continue;
      upcoming.push({ ruleId: r.id, machineId: r.machineId, reason: r.reason, start: o.start, end: o.end, minutes: o.minutes, now: o.start <= wall.slice(0, 16) });
    }
  }
  upcoming.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  const ordersOf = new Map();
  for (const o of orders) { if (!ordersOf.has(o.machine_id)) ordersOf.set(o.machine_id, []); ordersOf.get(o.machine_id).push(o); }
  const running = new Map(sessions.map((s) => [s.machine_id, Number(s.n)]));
  const stopOf = new Map(stops.map((s) => [s.machine_id, s]));
  const rows = machines.map((m) => {
    const mos = ordersOf.get(m.id) ?? [];
    const st = stopOf.get(m.id);
    const fault = st ? mos.find((o) => o.stop_id === st.id || o.stop_id === st.replaces_id) : null;
    const plannedNow = upcoming.find((u) => u.machineId === m.id && u.now);
    const next = upcoming.find((u) => u.machineId === m.id && !u.now) ?? null;
    let status = 'idle';
    if (fault) status = 'down';
    else if (plannedNow) status = 'planned';
    else if (st) status = 'stopped';
    else if (running.get(m.id)) status = 'running';
    return {
      id: m.id, code: m.code, name: m.name, type: m.type_name ?? null, status,
      since: st ? dbWall(st.started_at) : null, stopReason: st?.label ?? null,
      downMinutes: fault && st ? minutesBetween(dbWall(st.started_at), wall) : null,
      fault: fault ? { id: fault.id, code: fault.code, status: fault.status, title: fault.title } : null,
      plannedNow: plannedNow ?? null, nextPlanned: next,
      openOrders: mos.map((o) => ({ id: o.id, code: o.code, status: o.status, source: o.source, title: o.title })),
      jobsRunning: running.get(m.id) ?? 0,
    };
  });
  const count = (s) => rows.filter((r) => r.status === s).length;
  const codeOf = new Map(machines.map((m) => [m.id, m.code]));
  return {
    now: wall, today,
    counts: { machines: rows.length, down: count('down'), planned: count('planned'), stopped: count('stopped'), running: count('running'), idle: count('idle'), openOrders: orders.length },
    machines: rows,
    planned: upcoming.filter((u) => codeOf.has(u.machineId)).slice(0, 200).map((u) => ({ ...u, machineCode: codeOf.get(u.machineId) })),
    reasons,
  };
}

/** Minutes of [a, b) inside [lo, hi) (all plant wall text). */
const overlapMin = (a, b, lo, hi) => Math.max(0, Math.round((Math.min(wallMs(b), wallMs(hi)) - Math.max(wallMs(a), wallMs(lo))) / 60000));

/**
 * GET /maintenance/summary — the dashboard card: this week (Monday to now, plant clock) downtime hours (faults; other
 * maintenance jobs; planned windows), maintenance cost of MOs done this week, open MOs, machines down. 1 stage of 4 reads.
 */
export async function maintenanceSummary(db, companyId) {
  const { wall, today } = await plantNow(db, companyId);
  const monday = mondayOf(today);
  const lo = `${monday} 00:00:00`;
  const empty = { weekFrom: monday, now: wall, faultHours: 0, maintenanceHours: 0, plannedHours: 0, downtimeHours: 0, cost: 0, doneThisWeek: 0, openOrders: 0, machinesDown: 0 };
  let rows;
  try {
    rows = await Promise.all([
      db.query(
        `SELECT mo.source, st.started_at, st.ended_at FROM cf_maintenance_orders mo JOIN cf_machine_stops st ON st.id = mo.stop_id
          WHERE mo.company_id = ? AND mo.deleted_at IS NULL AND mo.false_alarm = 0 AND st.deleted_at IS NULL AND (st.ended_at IS NULL OR st.ended_at > ?)`,
        [companyId, lo],
      ),
      db.query(
        "SELECT COUNT(*) AS n, COALESCE(SUM(COALESCE(parts_cost, 0) + other_cost), 0) AS cost FROM cf_maintenance_orders WHERE company_id = ? AND deleted_at IS NULL AND status = 'done' AND done_at >= ?",
        [companyId, lo],
      ),
      db.query(
        `SELECT COUNT(*) AS n, COUNT(DISTINCT IF(mo.stop_id IS NOT NULL AND st.ended_at IS NULL AND st.deleted_at IS NULL, mo.machine_id, NULL)) AS down
           FROM cf_maintenance_orders mo LEFT JOIN cf_machine_stops st ON st.id = mo.stop_id
          WHERE mo.company_id = ? AND mo.deleted_at IS NULL AND mo.status IN ('open','in_progress','waiting_parts')`,
        [companyId],
      ),
      db.query('SELECT * FROM cf_planned_downtimes WHERE company_id = ? AND deleted_at IS NULL AND starts_on <= ? AND (ends_on IS NULL OR ends_on >= ?)', [companyId, today, addDaysS(monday, -60)]),
    ]);
  } catch (e) { if (missingSchema(e)) return empty; throw e; }
  const [[stops], [[done]], [[open]], [rules]] = rows;
  let fault = 0;
  let maint = 0;
  for (const s of stops) {
    const m = overlapMin(dbWall(s.started_at), dbWall(s.ended_at) ?? wall, lo, wall);
    if (s.source === 'fault') fault += m; else maint += m;
  }
  let planned = 0;
  for (const r of rules.map(shapeRule)) {
    for (const o of occurrences(r, addDaysS(monday, -Math.ceil(r.durationMinutes / DAY)), today)) planned += overlapMin(`${o.start}:00`, `${o.end}:00`, lo, wall);
  }
  const h = (m) => Math.round(m / 6) / 10;
  return {
    weekFrom: monday, now: wall,
    faultHours: h(fault), maintenanceHours: h(maint), plannedHours: h(planned), downtimeHours: h(fault + maint + planned),
    cost: Math.round(Number(done.cost) * 100) / 100, doneThisWeek: Number(done.n), openOrders: Number(open.n), machinesDown: Number(open.down),
  };
}
