/**
 * exitRead.js — reading a person's leaving: the reasons, the shape of a
 * record, and the "on notice" mark other reads carry.
 * (TM/CF_HRMS_HIRING_SPEC.md §4.3, §4.5.)
 *
 * Its own small file, importing no other service, for the same reason as
 * hiringRead.js: peopleService, positionService, orgChartService and
 * hiringService all need to say that somebody is on notice, and exitService —
 * which writes the record — imports several of them.
 *
 * NO QUERY PER ROW. The org chart, the position card and the Positions list do
 * not ask here for each occupant: they LEFT JOIN the open record onto the
 * occupants read they already make (NOTICE_JOIN_SQL, on the unique key that
 * allows one open record per employee) and shape the columns with noticeOf().
 */

export const EXIT_TYPES = ['RESIGNED', 'REMOVED'];
export const EXIT_STATUSES = ['OPEN', 'WITHDRAWN', 'CLOSED'];

/** Who decided, and why — most likely first. The list the screen shows, and the list a write is checked against. */
export const EXIT_REASONS = [
  {
    type: 'RESIGNED',
    label: 'The employee resigned',
    short: 'resigned',
    reasons: [
      { code: 'BETTER_JOB', label: 'Better job elsewhere', noteRequired: false },
      { code: 'PERSONAL', label: 'Personal or family reasons', noteRequired: false },
      { code: 'RELOCATION', label: 'Moving to another place', noteRequired: false },
      { code: 'PAY', label: 'Pay', noteRequired: false },
      { code: 'WORK_CONDITIONS', label: 'Work, shift or conditions', noteRequired: false },
      { code: 'HEALTH', label: 'Health', noteRequired: false },
      { code: 'STUDIES', label: 'Further studies', noteRequired: false },
      { code: 'RETIRED', label: 'Retirement', noteRequired: false },
      { code: 'OTHER', label: 'Something else', noteRequired: true },
    ],
  },
  {
    type: 'REMOVED',
    label: 'We ended the employment',
    short: 'employment ended',
    reasons: [
      { code: 'ABSENT', label: 'Stopped coming to work', noteRequired: false },
      { code: 'PERFORMANCE', label: 'Performance', noteRequired: false },
      { code: 'PROBATION', label: 'Not confirmed after probation', noteRequired: false },
      { code: 'MISCONDUCT', label: 'Misconduct', noteRequired: false },
      { code: 'CONTRACT_END', label: 'Contract or project ended', noteRequired: false },
      { code: 'ROLE_REMOVED', label: 'Position no longer needed', noteRequired: false },
      { code: 'DECEASED', label: 'Passed away', noteRequired: false },
      { code: 'OTHER', label: 'Something else', noteRequired: true },
    ],
  },
];

export const exitTypeOf = (type) => EXIT_REASONS.find((t) => t.type === type) ?? null;
export const exitReasonOf = (type, code) => exitTypeOf(type)?.reasons.find((r) => r.code === code) ?? null;

/** GET /people/exit-reasons. */
export function listExitReasons() {
  return { types: EXIT_REASONS.map(({ type, label, reasons }) => ({ type, label, reasons: reasons.map((r) => ({ ...r })) })) };
}

/* ── dates ───────────────────────────────────────────────────────────────── */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n) => String(n).padStart(2, '0');

export const isoDay = (v) => {
  if (v == null || v === '') return null;
  if (v instanceof Date) return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
  return String(v).slice(0, 10);
};
export const todayIso = () => isoDay(new Date());

/** 2026-11-10 -> "10 Nov 2026". */
export function shortDay(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDay(v) ?? '');
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : '';
}

/** Whole days from one date to another; negative when `to` is before `from`. */
export function daysBetween(from, to) {
  const a = Date.parse(`${isoDay(from)}T00:00:00Z`);
  const b = Date.parse(`${isoDay(to)}T00:00:00Z`);
  return Number.isNaN(a) || Number.isNaN(b) ? null : Math.round((b - a) / 86400000);
}

/** Days still to work, never below zero: a last day that has passed is 0 left, not -3. */
const daysLeftOn = (lastWorkingDay, on) => Math.max(0, daysBetween(on, lastWorkingDay) ?? 0);

/* ── the record ──────────────────────────────────────────────────────────── */

/**
 * The wire shape of one leaving record (spec §4.4 `Exit`).
 * `daysLeft` is only for an OPEN record. `statusLine` is the one wording:
 *   "On notice · last day 10 Nov 2026" / "Left on 10 Nov 2026 · resigned" /
 *   "Notice withdrawn on 2 Nov 2026"
 */
export function shapeExit(r, on = todayIso()) {
  if (!r) return null;
  const type = exitTypeOf(r.exit_type);
  const reason = exitReasonOf(r.exit_type, r.reason_code);
  const lastWorkingDay = isoDay(r.last_working_day);
  let statusLine;
  if (r.status === 'OPEN') statusLine = `On notice · last day ${shortDay(lastWorkingDay)}`;
  else if (r.status === 'CLOSED') statusLine = `Left on ${shortDay(lastWorkingDay)} · ${type?.short ?? 'left'}`;
  else statusLine = `Notice withdrawn on ${shortDay(r.withdrawn_on)}`;
  return {
    id: r.id,
    exitType: r.exit_type,
    typeLabel: type?.label ?? r.exit_type,
    reasonCode: r.reason_code,
    reasonLabel: reason?.label ?? r.reason_code,
    note: r.note ?? null,
    noticeDate: isoDay(r.notice_date),
    lastWorkingDay,
    status: r.status,
    closedOn: isoDay(r.closed_on),
    daysLeft: r.status === 'OPEN' ? daysLeftOn(lastWorkingDay, on) : null,
    statusLine,
    // Beyond the spec's shape, and only set where they apply.
    withdrawnOn: isoDay(r.withdrawn_on),
    withdrawNote: r.withdraw_note ?? null,
    closeNote: r.close_note ?? null,
  };
}

/**
 * The record an employee read carries: the OPEN one, or — for somebody who has
 * left — the latest CLOSED one. One query for any number of employees.
 * @returns {Map<number, object>} employee id -> Exit
 */
export async function exitsForEmployees(db, companyId, employeeIds, on = todayIso()) {
  if (!employeeIds.length) return new Map();
  const [rows] = await db.query(
    `SELECT x.*, e.employment_status
       FROM hrms_employee_exits x
       JOIN hrms_employees e ON e.company_id = x.company_id AND e.id = x.employee_id
      WHERE x.company_id = ? AND x.deleted_at IS NULL AND x.employee_id IN (?)
        AND (x.status = 'OPEN' OR (x.status = 'CLOSED' AND e.employment_status = 'EXITED'))
      ORDER BY (x.status = 'OPEN') DESC, x.closed_on DESC, x.id DESC`,
    [companyId, employeeIds],
  );
  const by = new Map();
  for (const r of rows) if (!by.has(r.employee_id)) by.set(r.employee_id, shapeExit(r, on));
  return by;
}

/* ── the mark on an occupant ─────────────────────────────────────────────── */

/**
 * Joins a person's OPEN leaving record onto a read that already has their
 * employee id. `uq_hexi_open` allows one, so the join adds no rows.
 */
export const NOTICE_JOIN_SQL = (employee = 'wa', x = 'x') =>
  `LEFT JOIN hrms_employee_exits ${x} ON ${x}.company_id = ${employee}.company_id AND ${x}.open_employee = ${employee}.employee_id`;

/** The columns noticeOf() reads, for the SELECT list. */
export const NOTICE_COLUMNS_SQL = (x = 'x') =>
  `${x}.id AS exit_id, ${x}.exit_type AS exit_type, ${x}.last_working_day AS exit_last_working_day`;

/**
 * `notice` on an occupant (spec §4.5), or null:
 *   { exitId, exitType, lastWorkingDay, daysLeft }
 */
export function noticeOf(row, on = todayIso()) {
  if (!row || row.exit_id == null) return null;
  const lastWorkingDay = isoDay(row.exit_last_working_day);
  return { exitId: row.exit_id, exitType: row.exit_type, lastWorkingDay, daysLeft: daysLeftOn(lastWorkingDay, on) };
}

export default {
  EXIT_TYPES, EXIT_STATUSES, EXIT_REASONS, exitTypeOf, exitReasonOf, listExitReasons,
  isoDay, todayIso, shortDay, daysBetween, shapeExit, exitsForEmployees,
  NOTICE_JOIN_SQL, NOTICE_COLUMNS_SQL, noticeOf,
};
