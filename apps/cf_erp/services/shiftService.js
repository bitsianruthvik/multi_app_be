/**
 * shiftService.js — when each machine works (decided 2026-09-22: "shifts will
 * change per machine", so every machine keeps its own shifts; no plant
 * calendar underneath).
 *
 * A shift pattern is a weekly rhythm; an exception changes one day. A shift
 * belongs to the day it STARTS: Night 22:00-06:00 on Monday is Monday's shift,
 * and a day off on Tuesday does not cut it short. Times are the plant's local
 * clock, stored and returned without a time zone.
 */
import { invalid, notFound, assertNoProblems } from '../lib/errors.js';
import { requireMachine } from './records.js';
import { dateText } from './resolutionService.js';

export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const DAY = 1440;
const WEEK = 7 * DAY;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)(:([0-5]\d))?$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RANGE_DAYS = 92;
const blank = (v) => v == null || String(v).trim() === '';

const toMinutes = (t) => { const m = TIME_RE.exec(String(t)); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
const hhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
const spanOf = (start, end) => (end > start ? end - start : end + DAY - start);
/** Monday = 0 … Sunday = 6, from a local date. */
const weekdayIndex = (d) => (d.getDay() + 6) % 7;
const parseDate = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const weekdaysOf = (set) => (Array.isArray(set) ? set : String(set ?? '').split(',').filter(Boolean));

function readTime(raw, label, problems) {
  if (blank(raw)) { problems.push(`${label} is required (HH:MM).`); return null; }
  const m = toMinutes(String(raw).trim());
  if (m == null) problems.push(`${label} is a time of day, HH:MM.`);
  return m;
}

function readDate(raw, label, problems) {
  if (blank(raw)) return null;
  const s = String(raw).trim();
  if (!DATE_RE.test(s) || dateText(parseDate(s)) !== s) { problems.push(`${label} needs a date as YYYY-MM-DD.`); return null; }
  return s;
}

function shapeShift(s) {
  const start = toMinutes(s.start_time);
  const end = toMinutes(s.end_time);
  const span = spanOf(start, end);
  return {
    id: s.id,
    machineId: s.machine_id,
    name: s.name,
    weekdays: weekdaysOf(s.weekdays),
    startTime: hhmm(start),
    endTime: hhmm(end),
    crossesMidnight: end <= start,
    breakMinutes: s.break_minutes,
    minutes: span - s.break_minutes,
    effectiveFrom: dateText(s.effective_from),
    effectiveTo: dateText(s.effective_to),
    sortOrder: s.sort_order,
    notes: s.notes,
  };
}

async function liveShifts(db, companyId, machineId) {
  const [rows] = await db.query(
    'SELECT * FROM cf_machine_shifts WHERE company_id = ? AND machine_id = ? AND deleted_at IS NULL ORDER BY sort_order, start_time, id',
    [companyId, machineId],
  );
  return rows;
}

export async function listShifts(db, companyId, machineId) {
  await requireMachine(db, companyId, machineId);
  return (await liveShifts(db, companyId, machineId)).map(shapeShift);
}

/** Minute-of-week intervals a pattern covers, split where the week wraps. */
function weekIntervals(p) {
  const out = [];
  for (const wd of p.weekdays) {
    const start = WEEKDAYS.indexOf(wd) * DAY + p.start;
    const end = start + p.span;
    if (end <= WEEK) out.push([start, end]);
    else { out.push([start, WEEK]); out.push([0, end - WEEK]); }
  }
  return out;
}

const rangesMeet = (a, b) => (a.from ?? '0000') <= (b.to ?? '9999') && (b.from ?? '0000') <= (a.to ?? '9999');

function clash(a, b) {
  if (!rangesMeet(a, b)) return false;
  return weekIntervals(a).some(([s1, e1]) => weekIntervals(b).some(([s2, e2]) => s1 < e2 && s2 < e1));
}

function readShift(input, problems, existing = null) {
  const pick = (k, fallback) => (input[k] !== undefined ? input[k] : fallback);
  const name = String(pick('name', existing?.name) ?? '').trim();
  if (!name || name.length > 50) problems.push('Give the shift a name (up to 50 characters).');
  const days = weekdaysOf(pick('weekdays', existing ? weekdaysOf(existing.weekdays) : []));
  if (!days.length) problems.push('Choose the days it runs.');
  if (days.some((d) => !WEEKDAYS.includes(d))) problems.push('Days are mon, tue, wed, thu, fri, sat, sun.');
  const start = readTime(pick('startTime', existing?.start_time), 'Start', problems);
  const end = readTime(pick('endTime', existing?.end_time), 'End', problems);
  if (start != null && end != null && start === end) problems.push('Start and end are the same time — split a 24-hour day into two shifts.');
  const span = start != null && end != null && start !== end ? spanOf(start, end) : null;
  const breakMinutes = Number(pick('breakMinutes', existing?.break_minutes ?? 0) ?? 0);
  if (!Number.isInteger(breakMinutes) || breakMinutes < 0) problems.push('Break is a whole number of minutes, zero or more.');
  else if (span != null && breakMinutes >= span) problems.push('The break is as long as the shift.');
  const from = readDate(pick('effectiveFrom', dateText(existing?.effective_from)), 'Valid from', problems);
  const to = readDate(pick('effectiveTo', dateText(existing?.effective_to)), 'Valid to', problems);
  if (from && to && from > to) problems.push('Valid from comes after valid to.');
  const notes = pick('notes', existing?.notes);
  const sortOrder = Number(pick('sortOrder', existing?.sort_order ?? 0)) || 0;
  return {
    name, weekdays: WEEKDAYS.filter((d) => days.includes(d)), start, end, span, breakMinutes, from, to, sortOrder,
    notes: blank(notes) ? null : String(notes),
  };
}

async function assertNoClash(db, companyId, machineId, p, ignoreId = null) {
  const others = (await liveShifts(db, companyId, machineId)).filter((s) => s.id !== ignoreId);
  for (const o of others) {
    const start = toMinutes(o.start_time);
    const end = toMinutes(o.end_time);
    const other = { weekdays: weekdaysOf(o.weekdays), start, span: spanOf(start, end), from: dateText(o.effective_from), to: dateText(o.effective_to) };
    if (clash(p, other)) {
      throw invalid('SHIFT_CLASH', `It overlaps the ${o.name} shift (${hhmm(start)}-${hhmm(end)}) — a machine works one shift at a time.`);
    }
  }
}

const INSERT_SHIFT = `INSERT INTO cf_machine_shifts
  (company_id, machine_id, name, weekdays, start_time, end_time, break_minutes, effective_from, effective_to, sort_order, notes, created_by)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

/** input: { name, weekdays: ['mon',…], startTime, endTime, breakMinutes?, effectiveFrom?, effectiveTo?, notes?, sortOrder? } */
export async function createShift(db, c, machineId, input = {}) {
  await requireMachine(db, c.companyId, machineId);
  const problems = [];
  const p = readShift(input, problems);
  assertNoProblems(problems, 'The shift has problems.');
  await assertNoClash(db, c.companyId, machineId, p);
  await db.query(INSERT_SHIFT, [c.companyId, machineId, p.name, p.weekdays.join(','), hhmm(p.start), hhmm(p.end), p.breakMinutes, p.from, p.to, p.sortOrder, p.notes, c.userId]);
  return listShifts(db, c.companyId, machineId);
}

async function requireShift(db, companyId, id) {
  const [[row]] = await db.query('SELECT * FROM cf_machine_shifts WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [companyId, id]);
  if (!row) throw notFound('Shift');
  return row;
}

export async function updateShift(db, c, id, input = {}) {
  const s = await requireShift(db, c.companyId, id);
  const problems = [];
  const p = readShift(input, problems, s);
  assertNoProblems(problems, 'The shift has problems.');
  await assertNoClash(db, c.companyId, s.machine_id, p, s.id);
  await db.query(
    `UPDATE cf_machine_shifts SET name = ?, weekdays = ?, start_time = ?, end_time = ?, break_minutes = ?, effective_from = ?, effective_to = ?, sort_order = ?, notes = ?
      WHERE company_id = ? AND id = ?`,
    [p.name, p.weekdays.join(','), hhmm(p.start), hhmm(p.end), p.breakMinutes, p.from, p.to, p.sortOrder, p.notes, c.companyId, id],
  );
  return listShifts(db, c.companyId, s.machine_id);
}

/** A shift goes with the day-offs that named it. */
export async function deleteShift(db, c, id) {
  const s = await requireShift(db, c.companyId, id);
  await db.query('UPDATE cf_machine_calendar_exceptions SET deleted_at = NOW() WHERE company_id = ? AND shift_id = ? AND deleted_at IS NULL', [c.companyId, id]);
  await db.query('UPDATE cf_machine_shifts SET deleted_at = NOW() WHERE company_id = ? AND id = ?', [c.companyId, id]);
  return listShifts(db, c.companyId, s.machine_id);
}

/** Replaces a machine's shifts with copies of another's — the quick way to set up a second identical machine. */
export async function copyShifts(db, c, machineId, fromMachineId) {
  await requireMachine(db, c.companyId, machineId);
  if (blank(fromMachineId)) throw invalid('INVALID', 'Choose the machine to copy from.');
  const source = await requireMachine(db, c.companyId, Number(fromMachineId));
  if (source.id === Number(machineId)) throw invalid('INVALID', 'A machine cannot copy its own shifts.');
  const rows = await liveShifts(db, c.companyId, source.id);
  if (!rows.length) throw invalid('NOTHING_TO_COPY', `${source.code} has no shifts to copy.`);
  for (const o of await liveShifts(db, c.companyId, machineId)) await deleteShift(db, c, o.id);
  for (const r of rows) {
    await db.query(INSERT_SHIFT, [c.companyId, machineId, r.name, r.weekdays, r.start_time, r.end_time, r.break_minutes, r.effective_from, r.effective_to, r.sort_order, r.notes, c.userId]);
  }
  return listShifts(db, c.companyId, machineId);
}

// --- one-day exceptions ----------------------------------------------------------

function shapeException(e, shiftName = null) {
  const start = e.start_time ? toMinutes(e.start_time) : null;
  const end = e.end_time ? toMinutes(e.end_time) : null;
  let text;
  if (e.kind === 'extra') text = `Extra ${hhmm(start)}-${hhmm(end)}`;
  else if (e.shift_id) text = `${shiftName ?? 'Shift'} off`;
  else if (start != null) text = `Stopped ${hhmm(start)}-${hhmm(end)}`;
  else text = 'Closed all day';
  return {
    id: e.id, machineId: e.machine_id, date: dateText(e.exception_date), kind: e.kind, shiftId: e.shift_id, shiftName,
    startTime: start != null ? hhmm(start) : null, endTime: end != null ? hhmm(end) : null, reason: e.reason, text,
  };
}

const todayDate = () => { const t = new Date(); return new Date(t.getFullYear(), t.getMonth(), t.getDate()); };

export async function listExceptions(db, companyId, machineId, q = {}) {
  await requireMachine(db, companyId, machineId);
  const problems = [];
  const from = readDate(q.from, 'From', problems) ?? dateText(addDays(todayDate(), -30));
  const to = readDate(q.to, 'To', problems) ?? dateText(addDays(todayDate(), 365));
  assertNoProblems(problems);
  const [rows] = await db.query(
    `SELECT e.*, s.name AS shift_name FROM cf_machine_calendar_exceptions e
       LEFT JOIN cf_machine_shifts s ON s.id = e.shift_id
      WHERE e.company_id = ? AND e.machine_id = ? AND e.deleted_at IS NULL AND e.exception_date BETWEEN ? AND ?
      ORDER BY e.exception_date, e.start_time, e.id`,
    [companyId, machineId, from, to],
  );
  return rows.map((e) => shapeException(e, e.shift_name));
}

/** input: { date, kind: closed | extra, shiftId?, startTime?, endTime?, reason? } — see models/init.sql §11b. */
export async function createException(db, c, machineId, input = {}) {
  await requireMachine(db, c.companyId, machineId);
  const problems = [];
  const date = readDate(input.date, 'Date', problems);
  if (!date && blank(input.date)) problems.push('Date is required.');
  const kind = input.kind;
  if (!['closed', 'extra'].includes(kind)) problems.push('An exception closes time or adds it (closed or extra).');
  let shiftId = null;
  if (!blank(input.shiftId)) {
    const [[s]] = await db.query('SELECT id, machine_id FROM cf_machine_shifts WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [c.companyId, Number(input.shiftId)]);
    if (!s || s.machine_id !== Number(machineId)) problems.push('That shift is not one of this machine’s.');
    else if (kind === 'extra') problems.push('Extra time is a window of its own — it does not name a shift.');
    else shiftId = s.id;
  }
  const hasTimes = !blank(input.startTime) || !blank(input.endTime);
  let start = null;
  let end = null;
  if (hasTimes || kind === 'extra') {
    start = readTime(input.startTime, 'Start', problems);
    end = readTime(input.endTime, 'End', problems);
    if (start != null && start === end) problems.push('Start and end are the same time.');
    if (shiftId) problems.push('Name a shift or give times, not both.');
  }
  const reason = blank(input.reason) ? null : String(input.reason).trim();
  if (reason && reason.length > 255) problems.push('Reason is up to 255 characters.');
  assertNoProblems(problems, 'The exception has problems.');
  if (kind === 'extra') {
    // Extra time is time outside the shifts; overlapping them would count it twice.
    const cal = await machineCalendar(db, c.companyId, machineId, { from: date, to: date });
    const a = `${date}T${hhmm(start)}`;
    const endDay = end <= start ? dateText(addDays(parseDate(date), 1)) : date;
    const b = `${endDay}T${hhmm(end)}`;
    const hit = cal.days[0].windows.find((w) => w.source === 'shift' && a < w.end && w.start < b);
    if (hit) throw invalid('OVERLAPS_SHIFT', `It overlaps the ${hit.label} shift (${hit.start.slice(11)}-${hit.end.slice(11)}) — extra time is time outside the shifts.`);
  }
  await db.query(
    `INSERT INTO cf_machine_calendar_exceptions (company_id, machine_id, exception_date, kind, shift_id, start_time, end_time, reason, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [c.companyId, machineId, date, kind, shiftId, start != null ? hhmm(start) : null, end != null ? hhmm(end) : null, reason, c.userId],
  );
  return listExceptions(db, c.companyId, machineId);
}

export async function deleteException(db, c, id) {
  const [[e]] = await db.query('SELECT id, machine_id FROM cf_machine_calendar_exceptions WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [c.companyId, id]);
  if (!e) throw notFound('Exception');
  await db.query('UPDATE cf_machine_calendar_exceptions SET deleted_at = NOW() WHERE company_id = ? AND id = ?', [c.companyId, id]);
  return listExceptions(db, c.companyId, e.machine_id);
}

// --- the calendar ------------------------------------------------------------------

/** Cuts [cs, ce) out of every window it meets. */
const cut = (windows, cs, ce) => windows.flatMap((w) => {
  if (ce <= w.start || cs >= w.end) return [w];
  const parts = [];
  if (cs > w.start) parts.push({ ...w, end: cs });
  if (ce < w.end) parts.push({ ...w, start: ce });
  return parts;
});

/**
 * When a machine works, day by day: its shift windows (a shift listed on the
 * day it starts), minus day-offs and stoppages, plus extra time. A shift's
 * break comes off its minutes in proportion to what is left of it.
 * q: { from?, to? } — default the next 14 days, at most 92.
 */
export async function machineCalendar(db, companyId, machineId, q = {}) {
  const machine = await requireMachine(db, companyId, machineId);
  const problems = [];
  const fromS = readDate(q.from, 'From', problems) ?? dateText(todayDate());
  const toS = readDate(q.to, 'To', problems) ?? dateText(addDays(parseDate(fromS), 13));
  assertNoProblems(problems);
  const from = parseDate(fromS);
  const days = Math.round((parseDate(toS) - from) / 86400000) + 1;
  if (days < 1) throw invalid('INVALID', 'To comes before from.');
  if (days > MAX_RANGE_DAYS) throw invalid('INVALID', `Ask for up to ${MAX_RANGE_DAYS} days at a time.`);
  // Day 0 is the evening before `from`: a stoppage on the first morning can cut its night shift.
  const day0 = addDays(from, -1);
  const shifts = (await liveShifts(db, companyId, machineId)).map((s) => {
    const start = toMinutes(s.start_time);
    return { id: s.id, name: s.name, weekdays: weekdaysOf(s.weekdays), start, span: spanOf(start, toMinutes(s.end_time)), brk: s.break_minutes, from: dateText(s.effective_from), to: dateText(s.effective_to) };
  });
  const [exRows] = await db.query(
    `SELECT * FROM cf_machine_calendar_exceptions
      WHERE company_id = ? AND machine_id = ? AND deleted_at IS NULL AND exception_date BETWEEN ? AND ?`,
    [companyId, machineId, dateText(day0), toS],
  );
  const exByDay = new Map();
  for (const e of exRows) { const k = dateText(e.exception_date); exByDay.set(k, [...(exByDay.get(k) ?? []), e]); }

  let shiftWindows = [];
  let extraWindows = [];
  for (let i = 0; i <= days; i++) {
    const d = addDays(day0, i);
    const ds = dateText(d);
    const wd = WEEKDAYS[weekdayIndex(d)];
    const ex = exByDay.get(ds) ?? [];
    const dayOff = ex.some((e) => e.kind === 'closed' && !e.shift_id && !e.start_time);
    const offShifts = new Set(ex.filter((e) => e.kind === 'closed' && e.shift_id).map((e) => e.shift_id));
    if (!dayOff) {
      for (const s of shifts) {
        if (!s.weekdays.includes(wd) || offShifts.has(s.id)) continue;
        if ((s.from && ds < s.from) || (s.to && ds > s.to)) continue;
        const st = i * DAY + s.start;
        shiftWindows.push({ day: i, start: st, end: st + s.span, label: s.name, source: 'shift', full: s.span, brk: s.brk });
      }
    }
    for (const e of ex.filter((x) => x.kind === 'extra')) {
      const a = toMinutes(e.start_time);
      const st = i * DAY + a;
      const span = spanOf(a, toMinutes(e.end_time));
      extraWindows.push({ day: i, start: st, end: st + span, label: e.reason ? `Extra — ${e.reason}` : 'Extra', source: 'extra', full: span, brk: 0 });
    }
  }
  // Extra time only counts outside the shifts; stoppages cut whatever they meet.
  for (const w of shiftWindows) extraWindows = cut(extraWindows, w.start, w.end);
  let windows = [...shiftWindows, ...extraWindows];
  for (let i = 0; i <= days; i++) {
    for (const e of (exByDay.get(dateText(addDays(day0, i))) ?? []).filter((x) => x.kind === 'closed' && !x.shift_id && x.start_time)) {
      const a = toMinutes(e.start_time);
      const cs = i * DAY + a;
      windows = cut(windows, cs, cs + spanOf(a, toMinutes(e.end_time)));
    }
  }

  const stamp = (m) => `${dateText(addDays(day0, Math.floor(m / DAY)))}T${hhmm(m % DAY)}`;
  const out = [];
  for (let i = 1; i <= days; i++) {
    const d = addDays(day0, i);
    const ds = dateText(d);
    const shaped = windows.filter((w) => w.day === i).sort((a, b) => a.start - b.start).map((w) => {
      const len = w.end - w.start;
      return { start: stamp(w.start), end: stamp(w.end), label: w.label, source: w.source, minutes: w.source === 'shift' ? Math.round(len * (1 - w.brk / w.full)) : len };
    });
    const exceptions = (exByDay.get(ds) ?? []).map((e) => shapeException(e, shifts.find((s) => s.id === e.shift_id)?.name ?? null));
    out.push({ date: ds, weekday: WEEKDAYS[weekdayIndex(d)], windows: shaped, exceptions, minutes: shaped.reduce((t, w) => t + w.minutes, 0) });
  }
  return {
    machine: { id: machine.id, code: machine.code, name: machine.name },
    from: fromS, to: toS, days: out, minutes: out.reduce((t, d) => t + d.minutes, 0),
  };
}
