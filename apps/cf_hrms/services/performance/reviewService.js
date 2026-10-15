/**
 * reviewService.js — check-ins, reviews and action items on performance plans.
 * (TM/CF_HRMS_HIRING_SPEC.md §20; models/init.sql §22.)
 *
 * A REVIEW is a conversation about one plan:
 *   CHECK_IN   for one slot of the plan; opened by HR or the manager; due on the slot's end
 *   FINAL      one per plan, made by the app (lazily, on read; idempotent) once the
 *              period's last slot has opened — the later of the first day of the
 *              period's last month and the start of the last slot of any of its KPIs;
 *              due on the period's end + the company's grace days (7)
 *
 *   OPEN ──(the person finishes their part)──> EMPLOYEE_DONE ──(the manager closes)──> DONE
 *     └──────────────────────(the manager closes)───────────────────────────────────┘
 *   A CHECK_IN may be CANCELLED; a FINAL goes only with its plan (a cancelled plan
 *   cancels its reviews that are not done).
 *
 * WHO WRITES WHAT — checked here, field by field, whoever calls:
 *   the person         employeeComment, blockers — on their OWN review while it is OPEN;
 *                      then "my part is done" (OPEN -> EMPLOYEE_DONE). Nothing else.
 *   HR / the manager   managerComment, rating (FINAL only, a value of the company's
 *                      rating scale), close, cancel a check-in, open a check-in.
 *   the Owner          a DONE review's manager comment and rating — with a reason (amended_*).
 * A DONE review is read-only for everybody else; a CANCELLED one for everybody.
 *
 * An ACTION ITEM belongs to a plan (and maybe a review): an owner (the person, or
 * someone in their manager's position, or the login raising it), a due date, OPEN |
 * DONE | DROPPED. Overdue = OPEN and the due date passed. The owner marks their own
 * action done; HR and the manager add, change, mark done and drop.
 *
 * WHAT A REVIEW SHOWS of the plan — KPIs, target, actual, achievement, band, the
 * plan score — comes from actualsService.reviewKpiTable(), i.e. scoring.js: never a
 * second computation.
 *
 * ROUND TRIPS. Production costs ~49 ms per query. No query per row: the Reviews and
 * Actions lists are a fixed handful of queries (reviews_test.mjs counts them); making
 * FINAL reviews for a whole period is four statements.
 *
 * WHO MAY reach a review is the route's business (the right + the department scope,
 * or teamScopeService's "below me", or "it is mine"); this file takes `mode`:
 * 'MANAGE' (HR, a manager) or 'SELF' (the person).
 */
import { HrmsError, invalid, conflict, notFound } from '../../lib/errors.js';
import { audit } from '../peopleService.js';
import { HOLDS_SEAT_SQL } from '../seatCount.js';
import { dateText, today } from '../positionService.js';
import { readSettings } from './settingsService.js';
import { slotsOf } from './slots.js';
import { loadPlanParts, reviewKpiTable, periodOfRow } from './actualsService.js';

export const REVIEW_KINDS = ['CHECK_IN', 'FINAL'];
export const REVIEW_STATUSES = ['OPEN', 'EMPLOYEE_DONE', 'DONE', 'CANCELLED'];
export const ACTION_STATUSES = ['OPEN', 'DONE', 'DROPPED'];
export const KIND_WORDS = { CHECK_IN: 'Check-in', FINAL: 'Final review' };
export const STATUS_WORDS = { OPEN: 'Open', EMPLOYEE_DONE: 'Person has written', DONE: 'Done', CANCELLED: 'Cancelled' };
export const STATE_WORDS = { DUE: 'Due', OVERDUE: 'Overdue', DONE: 'Done', CANCELLED: 'Cancelled' };
export const ACTION_WORDS = { OPEN: 'Open', DONE: 'Done', DROPPED: 'Dropped' };

const iso = (v) => dateText(v);
const clip = (s, n) => (s == null ? null : String(s).replace(/[ \t]+/g, ' ').trim().slice(0, n) || null);
const longDay = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const addDays = (d, n) => { const x = new Date(`${String(d).slice(0, 10)}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
const why = (status, code, message, extra) => new HrmsError(status, code, message, extra);

/* ══════════════════════════════════════════════════════════════════════════
 * When a FINAL review is due to exist, and the slots a check-in may be for
 * ══════════════════════════════════════════════════════════════════════════ */

/** The first day of the period's last month. */
const lastMonthStart = (period) => `${String(period.end).slice(0, 7)}-01` < period.start ? period.start : `${String(period.end).slice(0, 7)}-01`;

/**
 * The day a plan's FINAL review is made: the period's last slot opens — the later of
 * the first day of the period's last month and the start of the last slot of any of
 * its KPIs (a weekly KPI's last week, a daily KPI's last day). Pure.
 */
export function finalOpensOn(period, entryFrequencies = []) {
  let day = lastMonthStart(period);
  for (const f of entryFrequencies) {
    const list = slotsOf(period, f);
    const last = list[list.length - 1];
    if (last && last.start > day) day = last.start;
  }
  return day;
}

/**
 * The slots a check-in may be for: every slot of the plan's KPIs, and each month of
 * the period (so a monthly check-in is possible on a plan whose KPIs are entered once
 * per period). Pure. [{ start, end, name, whole, open }]
 */
export function checkInSlots(period, entryFrequencies = [], on = today()) {
  const map = new Map();
  for (const s of [...slotsOf(period, 'MONTHLY'), ...entryFrequencies.flatMap((f) => slotsOf(period, f))]) {
    const key = `${s.start}|${s.end}`;
    if (!map.has(key)) map.set(key, { start: s.start, end: s.end, name: s.name, whole: s.whole, open: s.start <= on });
  }
  // The whole period last: it is what the FINAL review covers.
  return [...map.values()].sort((a, b) => (Number(a.whole) - Number(b.whole)) || (a.start === b.start ? (a.end < b.end ? -1 : 1) : (a.start < b.start ? -1 : 1)));
}

/**
 * Make the FINAL review of every ACTIVE (or since closed) plan whose period's last
 * slot has opened and that has none. Idempotent (the unique live key; INSERT IGNORE).
 * One query when there is nothing to make; five when there is, whatever their number.
 * @param opts { planIds?: number[] } — only these plans
 * @returns { created }
 */
export async function ensureFinalReviews(db, c, { planIds = null } = {}) {
  const on = today();
  const where = ['pl.company_id = ?', "pl.status IN ('ACTIVE', 'CLOSED')", 'pp.start_date <= ?',
    "NOT EXISTS (SELECT 1 FROM hrms_performance_reviews r WHERE r.company_id = pl.company_id AND r.plan_id = pl.id AND r.kind = 'FINAL')"];
  const params = [c.companyId, on];
  if (planIds) {
    if (!planIds.length) return { created: 0 };
    where.push('pl.id IN (?)');
    params.push(planIds.map(Number));
  }
  const [cands] = await db.query(
    `SELECT pl.id, pl.period_id, pp.name AS period_name, pp.frequency, pp.start_date, pp.end_date, pp.status AS period_status,
            (SELECT GROUP_CONCAT(COALESCE(k.entry_frequency, '-')) FROM hrms_performance_plan_kpis k
              WHERE k.company_id = pl.company_id AND k.plan_id = pl.id AND k.deleted_at IS NULL) AS freqs
       FROM hrms_performance_plans pl JOIN hrms_performance_periods pp ON pp.company_id = pl.company_id AND pp.id = pl.period_id
      WHERE ${where.join(' AND ')}`, params);
  if (!cands.length) return { created: 0 };
  const freqsOf = (p) => (p.freqs ? String(p.freqs).split(',').map((f) => (f === '-' ? null : f)) : []);
  const due = cands.filter((p) => finalOpensOn(periodOfRow(p), freqsOf(p)) <= on);
  if (!due.length) return { created: 0 };
  const settings = await readSettings(db, c.companyId);
  const rows = due.map((p) => ({ planId: Number(p.id), due: addDays(iso(p.end_date), settings.reviewGraceDays), period: p.period_name }));
  const [res] = await db.query(
    `INSERT IGNORE INTO hrms_performance_reviews (company_id, plan_id, kind, status, due_date) VALUES ${rows.map(() => "(?, ?, 'FINAL', 'OPEN', ?)").join(', ')}`,
    rows.flatMap((r) => [c.companyId, r.planId, r.due]));
  if (res.affectedRows > 0) {
    const [made] = await db.query(
      "SELECT id, plan_id FROM hrms_performance_reviews WHERE company_id = ? AND kind = 'FINAL' AND plan_id IN (?) AND id >= ?",
      [c.companyId, rows.map((r) => r.planId), res.insertId]);
    const info = new Map(rows.map((r) => [r.planId, r]));
    if (made.length) {
      await db.query(
        `INSERT INTO hrms_audit_log (company_id, actor_user_id, entity_type, entity_id, action, before_json, after_json, created_by)
         VALUES ${made.map(() => "(?, ?, 'hrms_performance_reviews', ?, 'CREATE', NULL, ?, ?)").join(', ')}`,
        made.flatMap((m) => [c.companyId, c.userId, m.id,
          JSON.stringify({ kind: 'FINAL', planId: Number(m.plan_id), dueDate: info.get(Number(m.plan_id))?.due, by: 'APP', why: `the last slot of ${info.get(Number(m.plan_id))?.period} has opened` }), c.userId]));
    }
  }
  return { created: res.affectedRows };
}

/* ══════════════════════════════════════════════════════════════════════════
 * Reading reviews
 * ══════════════════════════════════════════════════════════════════════════ */

const REVIEW_SQL = `
  SELECT r.*, pl.employee_id, pl.status AS plan_status, pl.position_id, pl.position_code, pl.position_title, pl.role_id, pl.role_title,
         pl.department_id, pl.department_name, pl.manager_position_id,
         pp.id AS period_id, pp.name AS period_name, pp.frequency, pp.start_date, pp.end_date, pp.status AS period_status,
         e.full_name, e.employee_code,
         mp.position_code AS manager_position_code, COALESCE(mp.position_title, mr.title) AS manager_position_title,
         (SELECT me.full_name FROM hrms_work_assignments wa JOIN hrms_employees me ON me.company_id = wa.company_id AND me.id = wa.employee_id
           WHERE wa.company_id = r.company_id AND wa.position_id = pl.manager_position_id AND ${HOLDS_SEAT_SQL('wa')}
             AND (wa.effective_from IS NULL OR wa.effective_from <= ?) AND (wa.effective_to IS NULL OR wa.effective_to >= ?)
           ORDER BY wa.is_primary DESC, wa.id LIMIT 1) AS manager_name,
         ou.name AS opened_by_name, cu.name AS closed_by_name, au.name AS amended_by_name, xu.name AS cancelled_by_name,
         (SELECT COUNT(*) FROM hrms_performance_actions x WHERE x.company_id = r.company_id AND x.review_id = r.id AND x.status = 'OPEN') AS open_actions
    FROM hrms_performance_reviews r
    JOIN hrms_performance_plans pl ON pl.company_id = r.company_id AND pl.id = r.plan_id
    JOIN hrms_performance_periods pp ON pp.company_id = pl.company_id AND pp.id = pl.period_id
    JOIN hrms_employees e ON e.company_id = pl.company_id AND e.id = pl.employee_id
    LEFT JOIN hrms_positions mp ON mp.company_id = pl.company_id AND mp.id = pl.manager_position_id
    LEFT JOIN hrms_roles mr ON mr.company_id = mp.company_id AND mr.id = mp.role_id
    LEFT JOIN users ou ON ou.id = r.opened_by
    LEFT JOIN users cu ON cu.id = r.closed_by
    LEFT JOIN users au ON au.id = r.amended_by
    LEFT JOIN users xu ON xu.id = r.cancelled_by`;

/** due / overdue / done / cancelled, from the status and the due date. */
function stateOf(status, dueDate, on) {
  if (status === 'DONE') return 'DONE';
  if (status === 'CANCELLED') return 'CANCELLED';
  return dueDate < on ? 'OVERDUE' : 'DUE';
}

function shapeReview(r, on = today()) {
  const due = iso(r.due_date);
  const state = stateOf(r.status, due, on);
  return {
    id: r.id,
    kind: r.kind, kindLabel: KIND_WORDS[r.kind] ?? r.kind,
    status: r.status, statusLabel: STATUS_WORDS[r.status] ?? r.status,
    state, stateLabel: STATE_WORDS[state],
    dueDate: due, overdue: state === 'OVERDUE', daysOverdue: state === 'OVERDUE' ? daysBetween(due, on) : 0,
    slot: r.kind === 'CHECK_IN' && r.slot_start ? { start: iso(r.slot_start), end: iso(r.slot_end), name: r.slot_name } : null,
    title: r.kind === 'FINAL' ? `Final review · ${r.period_name}` : `Check-in · ${r.slot_name ?? r.period_name}`,
    planId: Number(r.plan_id), planStatus: r.plan_status,
    period: { id: Number(r.period_id), name: r.period_name, frequency: r.frequency, start: iso(r.start_date), end: iso(r.end_date), status: r.period_status },
    periodId: Number(r.period_id), periodName: r.period_name,
    employee: { id: Number(r.employee_id), name: r.full_name, employeeCode: r.employee_code ?? null },
    employeeId: Number(r.employee_id), employeeName: r.full_name, employeeCode: r.employee_code ?? null,
    positionId: r.position_id, positionCode: r.position_code, positionTitle: r.position_title,
    roleId: r.role_id, roleTitle: r.role_title, departmentId: r.department_id, departmentName: r.department_name,
    managerPositionId: r.manager_position_id ?? null, managerPositionCode: r.manager_position_code ?? null,
    managerPositionTitle: r.manager_position_title ?? null, managerName: r.manager_name ?? null,
    employeeComment: r.employee_comment ?? null, blockers: r.blockers ?? null, managerComment: r.manager_comment ?? null,
    rating: r.rating_value != null ? { value: Number(r.rating_value), label: r.rating_label } : null,
    ratingValue: r.rating_value != null ? Number(r.rating_value) : null,
    openedBy: r.opened_by ? (r.opened_by_name ?? 'Someone') : null,
    employeeDoneAt: r.employee_done_at ?? null,
    closedAt: r.closed_at ?? null, closedBy: r.closed_by_name ?? null,
    cancelledAt: r.cancelled_at ?? null, cancelledBy: r.cancelled_by_name ?? null, cancelReason: r.cancel_reason ?? null,
    amendedAt: r.amended_at ?? null, amendedBy: r.amended_by_name ?? null, amendReason: r.amend_reason ?? null,
    openActions: Number(r.open_actions ?? 0),
    createdAt: r.created_at,
  };
}

/** The reviews of a WHERE. One query. */
async function reviewRows(db, companyId, where, params) {
  const on = today();
  const [rows] = await db.query(`${REVIEW_SQL} WHERE r.company_id = ? AND ${where.join(' AND ')}
    ORDER BY (r.status IN ('OPEN', 'EMPLOYEE_DONE')) DESC, r.due_date, e.full_name, r.id`, [on, on, companyId, ...params]);
  return rows;
}

/**
 * GET /performance/reviews — every review the login reaches, newest periods first;
 * the FINALs that are due are made first. Two queries when none are to be made
 * (the check and the list); the filters (lib/listFilters.js) run in memory.
 * @param opts { employeeIds?, scopeDeptIds? }
 */
export async function listReviews(db, c, opts = {}) {
  await ensureFinalReviews(db, c);
  const where = ['1 = 1'];
  const params = [];
  if (opts.employeeIds) { where.push('pl.employee_id IN (?)'); params.push(opts.employeeIds.length ? opts.employeeIds : [0]); }
  if (opts.scopeDeptIds) { where.push('pl.department_id IN (?)'); params.push(opts.scopeDeptIds.length ? opts.scopeDeptIds : [0]); }
  const rows = await reviewRows(db, c.companyId, where, params);
  const on = today();
  const items = rows.map((r) => shapeReview(r, on));
  const periods = [...new Map(items.map((x) => [x.periodId, x.period])).values()].sort((a, b) => (a.start < b.start ? 1 : -1));
  const managers = [...new Map(items.filter((x) => x.managerPositionId).map((x) => [Number(x.managerPositionId), {
    id: Number(x.managerPositionId), code: x.managerPositionCode, title: x.managerPositionTitle, name: x.managerName,
  }])).values()].sort((a, b) => String(a.code ?? '').localeCompare(String(b.code ?? '')));
  return {
    items, periods, managers,
    counts: {
      due: items.filter((x) => x.state === 'DUE').length, overdue: items.filter((x) => x.state === 'OVERDUE').length, done: items.filter((x) => x.state === 'DONE').length,
    },
  };
}

/** A review row, or 404. One query. */
async function reviewRow(db, companyId, reviewId, { lock = false } = {}) {
  if (lock) await db.query('SELECT id FROM hrms_performance_reviews WHERE company_id = ? AND id = ? FOR UPDATE', [companyId, Number(reviewId)]);
  const [rows] = await db.query(`${REVIEW_SQL} WHERE r.company_id = ? AND r.id = ?`, [today(), today(), companyId, Number(reviewId)]);
  if (!rows[0]) throw notFound('Review');
  return rows[0];
}

/** The person a review is about — what the scope and the team rule are checked against. */
export async function reviewEmployeeId(db, companyId, reviewId) {
  const [[r]] = await db.query(
    'SELECT pl.employee_id FROM hrms_performance_reviews r JOIN hrms_performance_plans pl ON pl.company_id = r.company_id AND pl.id = r.plan_id WHERE r.company_id = ? AND r.id = ?',
    [companyId, Number(reviewId)]);
  return r ? Number(r.employee_id) : null;
}

/** What a caller may do on a review. mode 'MANAGE' (HR, a manager) or 'SELF' (the person). */
function reviewCan(r, mode, { owner = false, cancel = false, edit = true } = {}) {
  const live = r.status === 'OPEN' || r.status === 'EMPLOYEE_DONE';
  if (mode === 'SELF') {
    return {
      writeOwn: r.status === 'OPEN', finishOwn: r.status === 'OPEN',
      writeManager: false, rate: false, close: false, cancel: false, amend: false, addAction: false,
    };
  }
  return {
    writeOwn: false, finishOwn: false,
    writeManager: edit && live, rate: edit && live && r.kind === 'FINAL', close: edit && live,
    cancel: cancel && live && r.kind === 'CHECK_IN',
    amend: Boolean(owner) && r.status === 'DONE',
    addAction: edit && live && r.plan_status !== 'CANCELLED',
  };
}

/**
 * One review, whole: header, the KPI table and plan score (scoring.js, through
 * actualsService.reviewKpiTable), the person's and the manager's parts, the rating,
 * its action items, and what this caller may do. Six queries.
 * @param mode 'MANAGE' | 'SELF'; can { owner, cancel, edit }
 */
export async function readReview(db, companyId, reviewId, mode = 'MANAGE', can = {}) {
  const r = await reviewRow(db, companyId, reviewId);
  const [parts, settings, actions] = await Promise.all([
    loadPlanParts(db, companyId, [r.plan_id]),
    readSettings(db, companyId),
    actionRows(db, companyId, ['x.review_id = ?'], [r.id]),
  ]);
  const period = periodOfRow(r);
  const slot = r.kind === 'CHECK_IN' && r.slot_start ? { start: iso(r.slot_start), end: iso(r.slot_end) } : null;
  const table = reviewKpiTable(period, parts.kras.get(Number(r.plan_id)) ?? [], parts.kpis.get(Number(r.plan_id)) ?? [], parts.actuals, settings.bands, slot);
  const ability = reviewCan(r, mode, can);
  const on = today();
  return {
    review: { ...shapeReview(r, on), can: ability },
    kpis: table.rows,
    kras: table.kras,
    planScore: table.score,
    tableLine: slot && !(slot.start === period.start && slot.end === period.end)
      ? `Actuals for ${r.slot_name}. A KPI entered once for the whole period shows the period so far. The plan score is the whole period's so far.`
      : `Actuals for the whole of ${r.period_name}.`,
    ratingScale: settings.ratingScale,
    bands: settings.bands,
    actions: actions.map((a) => shapeAction(a, on, actionCanFor(a, mode, can))),
  };
}

/** The reviews and actions of one plan (the plan page): reviews, actions, the slots a check-in may be for, owners on offer. Six or seven queries. */
export async function planReviews(db, c, planId, mode = 'MANAGE', can = {}) {
  await ensureFinalReviews(db, c, { planIds: [Number(planId)] });
  const [[plan]] = await db.query(
    `SELECT pl.*, pp.name AS period_name, pp.frequency, pp.start_date, pp.end_date, pp.status AS period_status
       FROM hrms_performance_plans pl JOIN hrms_performance_periods pp ON pp.company_id = pl.company_id AND pp.id = pl.period_id
      WHERE pl.company_id = ? AND pl.id = ?`, [c.companyId, Number(planId)]);
  if (!plan) throw notFound('Plan');
  const on = today();
  const [rows, actions, [kpis], owners] = await Promise.all([
    reviewRows(db, c.companyId, ['r.plan_id = ?'], [plan.id]),
    actionRows(db, c.companyId, ['x.plan_id = ?'], [plan.id]),
    db.query('SELECT entry_frequency FROM hrms_performance_plan_kpis WHERE company_id = ? AND plan_id = ? AND deleted_at IS NULL', [c.companyId, plan.id]),
    ownerOptions(db, c, plan),
  ]);
  const period = periodOfRow(plan);
  const taken = new Set(rows.filter((r) => r.kind === 'CHECK_IN' && r.status !== 'CANCELLED').map((r) => `${iso(r.slot_start)}|${iso(r.slot_end)}`));
  const slots = checkInSlots(period, kpis.map((k) => k.entry_frequency ?? null), on).map((s) => ({ ...s, hasCheckIn: taken.has(`${s.start}|${s.end}`) }));
  const live = plan.status === 'ACTIVE';
  return {
    plan: { id: Number(plan.id), status: plan.status, employeeId: Number(plan.employee_id), period: { id: plan.period_id, name: plan.period_name, start: iso(plan.start_date), end: iso(plan.end_date) } },
    reviews: rows.map((r) => ({ ...shapeReview(r, on), can: reviewCan(r, mode, can) })),
    actions: actions.map((a) => shapeAction(a, on, actionCanFor(a, mode, can))),
    slots,
    owners,
    finalOpensOn: finalOpensOn(period, kpis.map((k) => k.entry_frequency ?? null)),
    can: {
      openCheckIn: mode === 'MANAGE' && can.edit !== false && live,
      addAction: mode === 'MANAGE' && can.edit !== false && plan.status !== 'CANCELLED',
    },
    line: plan.status === 'DRAFT' ? 'Reviews start once the plan is activated.'
      : plan.status === 'CANCELLED' ? 'This plan was cancelled: its reviews are kept as they were.' : null,
  };
}

/* ══════════════════════════════════════════════════════════════════════════
 * Writing reviews
 * ══════════════════════════════════════════════════════════════════════════ */

const FIELD_WORDS = {
  employeeComment: 'the person’s comment', blockers: 'the blockers and support needed', managerComment: 'the manager’s comment',
  rating: 'the rating', reason: 'a reason',
};
/** Only these keys may be sent; anything else is refused by name. */
function onlyFields(body, allowed, who) {
  for (const k of Object.keys(body ?? {})) {
    if (!allowed.includes(k)) {
      throw why(422, 'FIELD_NOT_ALLOWED', `${who} cannot write ${FIELD_WORDS[k] ?? `“${k}”`} here.`, { field: k });
    }
  }
}

/** POST …/plans/:id/check-ins { slotStart } — an ACTIVE plan; a slot that has begun; one live check-in per slot. */
export async function openCheckIn(db, c, planId, body = {}) {
  const [[plan]] = await db.query(
    `SELECT pl.id, pl.status, pp.id AS period_id, pp.name AS period_name, pp.frequency, pp.start_date, pp.end_date, pp.status AS period_status
       FROM hrms_performance_plans pl JOIN hrms_performance_periods pp ON pp.company_id = pl.company_id AND pp.id = pl.period_id
      WHERE pl.company_id = ? AND pl.id = ? FOR UPDATE`, [c.companyId, Number(planId)]);
  if (!plan) throw notFound('Plan');
  if (plan.status !== 'ACTIVE') {
    throw conflict('NOT_ACTIVE', plan.status === 'DRAFT' ? 'This plan is still a draft. Check-ins start once it is activated.' : `This plan is ${String(plan.status).toLowerCase()}: no new check-in can be opened.`);
  }
  const period = periodOfRow(plan);
  const [kpis] = await db.query('SELECT entry_frequency FROM hrms_performance_plan_kpis WHERE company_id = ? AND plan_id = ? AND deleted_at IS NULL', [c.companyId, plan.id]);
  const slots = checkInSlots(period, kpis.map((k) => k.entry_frequency ?? null));
  // A slot is named by its first day — and its last, where two slots start together (a month and the whole period).
  const day = dateText(body.slotStart);
  const slot = day ? slots.find((s) => s.start === day && (!body.slotEnd || s.end === dateText(body.slotEnd))) ?? (body.slotEnd ? null : slots.find((s) => s.start === day)) : null;
  if (!slot) throw invalid('NOT_A_SLOT', day ? `${longDay(day)} does not start a slot of this plan. Choose one of: ${slots.map((s) => s.name).join(', ')}.` : 'Choose the slot the check-in is for.');
  if (slot.start > today()) throw invalid('FUTURE_SLOT', `${slot.name} has not begun. A check-in for it can be opened from ${longDay(slot.start)}.`);
  const [[taken]] = await db.query(
    "SELECT id FROM hrms_performance_reviews WHERE company_id = ? AND plan_id = ? AND kind = 'CHECK_IN' AND slot_start = ? AND slot_end = ? AND status <> 'CANCELLED'", [c.companyId, plan.id, slot.start, slot.end]);
  if (taken) throw conflict('ALREADY_OPEN', `There is already a check-in for ${slot.name}.`, { reviewId: taken.id });
  const [res] = await db.query(
    "INSERT INTO hrms_performance_reviews (company_id, plan_id, kind, slot_start, slot_end, slot_name, status, due_date, opened_by) VALUES (?, ?, 'CHECK_IN', ?, ?, ?, 'OPEN', ?, ?)",
    [c.companyId, plan.id, slot.start, slot.end, slot.name, slot.end, c.userId]);
  await audit(db, c, 'hrms_performance_reviews', res.insertId, 'CREATE', null, { kind: 'CHECK_IN', planId: Number(plan.id), slot: slot.name, dueDate: slot.end });
  return { id: res.insertId, slot: { start: slot.start, end: slot.end, name: slot.name }, dueDate: slot.end };
}

/** The rating sent, checked against the company's scale. null clears it. */
function readRating(value, scale) {
  if (value === null || value === '') return null;
  const n = Number(typeof value === 'object' && value ? value.value : value);
  const step = scale.find((s) => Number(s.value) === n);
  if (!step) throw invalid('INVALID', `The rating is one of the company’s scale: ${scale.map((s) => `${s.value} ${s.label}`).join(', ')}.`);
  return { value: Number(step.value), label: step.label };
}

/**
 * PUT …/reviews/:id { managerComment?, rating?, reason? } — HR or the manager.
 * OPEN / EMPLOYEE_DONE: freely. DONE: the Owner only, with a reason (an amendment).
 * The person's own fields are refused here by name.
 */
export async function writeManagerPart(db, c, reviewId, body = {}) {
  onlyFields(body, ['managerComment', 'rating', 'reason'], 'The manager');
  const r = await reviewRow(db, c.companyId, reviewId, { lock: true });
  if (r.status === 'CANCELLED') throw conflict('CANCELLED', 'This review was cancelled: it cannot be changed.');
  const settings = await readSettings(db, c.companyId);
  const next = {};
  if (body.managerComment !== undefined) next.manager_comment = clip(body.managerComment, 4000);
  if (body.rating !== undefined) {
    if (r.kind !== 'FINAL') throw invalid('NO_RATING', 'A check-in has no rating. The final review is rated.');
    const rating = readRating(body.rating, settings.ratingScale);
    next.rating_value = rating?.value ?? null;
    next.rating_label = rating?.label ?? null;
  }
  if (!Object.keys(next).length) throw invalid('INVALID', 'Nothing to save.');
  const reason = clip(body.reason, 500);
  if (r.status === 'DONE') {
    if (!c.owner) throw conflict('DONE', 'This review is done and is kept as it was closed. Only the Owner can change it, with a reason.');
    if (!reason) throw invalid('REASON_REQUIRED', 'Say why a review that is done is being changed.');
    if (next.rating_value === null && r.kind === 'FINAL') throw invalid('RATING_REQUIRED', 'A final review that is done keeps a rating: choose one.');
    Object.assign(next, { amended_at: new Date(), amended_by: c.userId, amend_reason: reason });
  }
  const before = { managerComment: r.manager_comment, rating: r.rating_value != null ? Number(r.rating_value) : null };
  await db.query(`UPDATE hrms_performance_reviews SET ${Object.keys(next).map((k) => `${k} = ?`).join(', ')} WHERE company_id = ? AND id = ?`,
    [...Object.values(next), c.companyId, r.id]);
  await audit(db, c, 'hrms_performance_reviews', r.id, 'UPDATE', before, {
    ...(next.manager_comment !== undefined ? { managerComment: next.manager_comment } : {}),
    ...(next.rating_value !== undefined ? { rating: next.rating_value, ratingLabel: next.rating_label } : {}),
    ...(r.status === 'DONE' ? { amended: true, reason } : {}),
  });
  return { ok: true, amended: r.status === 'DONE' };
}

/**
 * POST …/reviews/:id/close { managerComment?, rating? } — DONE. From OPEN or
 * EMPLOYEE_DONE. A FINAL needs its rating (given now or before).
 */
export async function closeReview(db, c, reviewId, body = {}) {
  onlyFields(body, ['managerComment', 'rating'], 'The manager');
  const r = await reviewRow(db, c.companyId, reviewId, { lock: true });
  if (r.status === 'DONE') throw conflict('ALREADY_DONE', 'This review is already done.');
  if (r.status === 'CANCELLED') throw conflict('CANCELLED', 'This review was cancelled.');
  const settings = await readSettings(db, c.companyId);
  const next = {};
  if (body.managerComment !== undefined) next.manager_comment = clip(body.managerComment, 4000);
  let ratingValue = r.rating_value != null ? Number(r.rating_value) : null;
  if (body.rating !== undefined) {
    if (r.kind !== 'FINAL') throw invalid('NO_RATING', 'A check-in has no rating. The final review is rated.');
    const rating = readRating(body.rating, settings.ratingScale);
    next.rating_value = rating?.value ?? null;
    next.rating_label = rating?.label ?? null;
    ratingValue = next.rating_value;
  }
  if (r.kind === 'FINAL' && ratingValue == null) throw invalid('RATING_REQUIRED', 'Give the rating before closing the final review.');
  await db.query(
    `UPDATE hrms_performance_reviews SET ${[...Object.keys(next).map((k) => `${k} = ?`), "status = 'DONE'", 'closed_at = NOW()', 'closed_by = ?'].join(', ')} WHERE company_id = ? AND id = ?`,
    [...Object.values(next), c.userId, c.companyId, r.id]);
  await audit(db, c, 'hrms_performance_reviews', r.id, 'APPROVE', { status: r.status }, {
    status: 'DONE', ...(r.kind === 'FINAL' ? { rating: ratingValue } : {}), ...(next.manager_comment !== undefined ? { managerComment: next.manager_comment } : {}),
  });
  return { ok: true };
}

/** POST …/reviews/:id/cancel { reason? } — a CHECK_IN that is not done. A FINAL goes with its plan. */
export async function cancelReview(db, c, reviewId, body = {}) {
  const r = await reviewRow(db, c.companyId, reviewId, { lock: true });
  if (r.kind === 'FINAL') throw conflict('FINAL_STAYS', 'A final review belongs to its plan and cannot be cancelled on its own. Cancel the plan instead.');
  if (r.status === 'DONE') throw conflict('DONE', 'This check-in is done and is kept as it was closed.');
  if (r.status === 'CANCELLED') throw conflict('CANCELLED', 'This check-in is already cancelled.');
  const reason = clip(body.reason, 500);
  await db.query("UPDATE hrms_performance_reviews SET status = 'CANCELLED', cancelled_at = NOW(), cancelled_by = ?, cancel_reason = ? WHERE company_id = ? AND id = ?",
    [c.userId, reason, c.companyId, r.id]);
  await audit(db, c, 'hrms_performance_reviews', r.id, 'UPDATE', { status: r.status }, { status: 'CANCELLED', reason });
  return { ok: true };
}

/** When a plan is cancelled: its reviews that are not done are cancelled with it. Two statements. */
export async function cancelPlanReviews(db, c, planId) {
  const [rows] = await db.query("SELECT id, status FROM hrms_performance_reviews WHERE company_id = ? AND plan_id = ? AND status IN ('OPEN', 'EMPLOYEE_DONE')", [c.companyId, planId]);
  if (!rows.length) return 0;
  await db.query("UPDATE hrms_performance_reviews SET status = 'CANCELLED', cancelled_at = NOW(), cancelled_by = ?, cancel_reason = 'The plan was cancelled.' WHERE company_id = ? AND id IN (?)",
    [c.userId, c.companyId, rows.map((r) => r.id)]);
  await db.query(
    `INSERT INTO hrms_audit_log (company_id, actor_user_id, entity_type, entity_id, action, before_json, after_json, created_by)
     VALUES ${rows.map(() => "(?, ?, 'hrms_performance_reviews', ?, 'UPDATE', ?, ?, ?)").join(', ')}`,
    rows.flatMap((r) => [c.companyId, c.userId, r.id, JSON.stringify({ status: r.status }), JSON.stringify({ status: 'CANCELLED', reason: 'The plan was cancelled.' }), c.userId]));
  return rows.length;
}

/* ── the person's own part (self view) ─────────────────────────────────── */

/** The employee of the login, or null. */
async function myEmployee(db, c) {
  const [[e]] = await db.query('SELECT id, full_name FROM hrms_employees WHERE company_id = ? AND user_id = ? AND deleted_at IS NULL LIMIT 1', [c.companyId, c.userId]);
  return e ?? null;
}

/** A review of MY plan, or 404 (another person's reads exactly like one that does not exist). */
async function myReviewRow(db, c, reviewId, { lock = false } = {}) {
  const me = await myEmployee(db, c);
  const owner = await reviewEmployeeId(db, c.companyId, reviewId);
  if (!me || owner == null || owner !== Number(me.id)) throw notFound('Review');
  return reviewRow(db, c.companyId, reviewId, { lock });
}

/** GET /user/me/reviews — my reviews (not cancelled) and my actions. */
export async function myReviews(db, c) {
  const me = await myEmployee(db, c);
  if (!me) return { linked: false, line: 'This login is not linked to an employee record, so there are no reviews to show.', reviews: [], actions: [] };
  const [plans] = await db.query("SELECT id FROM hrms_performance_plans WHERE company_id = ? AND employee_id = ? AND status IN ('ACTIVE', 'CLOSED')", [c.companyId, me.id]);
  if (plans.length) await ensureFinalReviews(db, c, { planIds: plans.map((p) => Number(p.id)) });
  const on = today();
  const [rows, actions] = await Promise.all([
    reviewRows(db, c.companyId, ['pl.employee_id = ?', "r.status <> 'CANCELLED'"], [me.id]),
    actionRows(db, c.companyId, ['x.owner_employee_id = ?'], [me.id]),
  ]);
  return {
    linked: true,
    line: rows.length ? null : 'You have no reviews yet.',
    reviews: rows.map((r) => ({ ...shapeReview(r, on), can: reviewCan(r, 'SELF') })),
    actions: actions.map((a) => shapeAction(a, on, { done: a.status === 'OPEN', edit: false, drop: false })),
  };
}

export async function myReview(db, c, reviewId) {
  await myReviewRow(db, c, reviewId);
  return readReview(db, c.companyId, reviewId, 'SELF');
}

/**
 * PUT /user/me/reviews/:id { employeeComment?, blockers? } — the ONLY fields a person
 * writes; on their own review, while it is OPEN. Every other key is refused by name.
 */
export async function writeMyPart(db, c, reviewId, body = {}) {
  onlyFields(body, ['employeeComment', 'blockers'], 'You');
  const r = await myReviewRow(db, c, reviewId, { lock: true });
  if (r.status !== 'OPEN') {
    throw conflict('NOT_OPEN', r.status === 'EMPLOYEE_DONE' ? 'You have finished your part of this review. Your manager closes it.'
      : r.status === 'DONE' ? 'This review is done and is kept as it was closed.' : 'This review was cancelled.');
  }
  const next = {};
  if (body.employeeComment !== undefined) next.employee_comment = clip(body.employeeComment, 4000);
  if (body.blockers !== undefined) next.blockers = clip(body.blockers, 4000);
  if (!Object.keys(next).length) throw invalid('INVALID', 'Nothing to save.');
  await db.query(`UPDATE hrms_performance_reviews SET ${Object.keys(next).map((k) => `${k} = ?`).join(', ')} WHERE company_id = ? AND id = ?`, [...Object.values(next), c.companyId, r.id]);
  await audit(db, c, 'hrms_performance_reviews', r.id, 'UPDATE',
    { employeeComment: r.employee_comment, blockers: r.blockers },
    { ...(next.employee_comment !== undefined ? { employeeComment: next.employee_comment } : {}), ...(next.blockers !== undefined ? { blockers: next.blockers } : {}), by: 'EMPLOYEE' });
  return { ok: true };
}

/** POST /user/me/reviews/:id/done — my part is written: OPEN -> EMPLOYEE_DONE. */
export async function finishMyPart(db, c, reviewId) {
  const r = await myReviewRow(db, c, reviewId, { lock: true });
  if (r.status !== 'OPEN') throw conflict('NOT_OPEN', r.status === 'EMPLOYEE_DONE' ? 'You have already finished your part.' : r.status === 'DONE' ? 'This review is done.' : 'This review was cancelled.');
  if (!clip(r.employee_comment, 4000)) throw invalid('COMMENT_REQUIRED', 'Write your comment before saying your part is done.');
  await db.query("UPDATE hrms_performance_reviews SET status = 'EMPLOYEE_DONE', employee_done_at = NOW(), employee_done_by = ? WHERE company_id = ? AND id = ?", [c.userId, c.companyId, r.id]);
  await audit(db, c, 'hrms_performance_reviews', r.id, 'UPDATE', { status: 'OPEN' }, { status: 'EMPLOYEE_DONE', by: 'EMPLOYEE' });
  return { ok: true };
}

/* ══════════════════════════════════════════════════════════════════════════
 * Action items
 * ══════════════════════════════════════════════════════════════════════════ */

const ACTION_SQL = `
  SELECT x.*, oe.full_name AS owner_name, oe.employee_code AS owner_code,
         pl.employee_id, pl.status AS plan_status, pl.department_id, pl.department_name, pl.position_id, pl.position_code, pl.position_title,
         pl.role_id, pl.manager_position_id,
         pe.full_name, pe.employee_code, pp.id AS period_id, pp.name AS period_name,
         r.kind AS review_kind, r.slot_name AS review_slot_name, r.status AS review_status,
         cu.name AS closed_by_name, ku.name AS created_by_name
    FROM hrms_performance_actions x
    JOIN hrms_performance_plans pl ON pl.company_id = x.company_id AND pl.id = x.plan_id
    JOIN hrms_performance_periods pp ON pp.company_id = pl.company_id AND pp.id = pl.period_id
    JOIN hrms_employees pe ON pe.company_id = pl.company_id AND pe.id = pl.employee_id
    JOIN hrms_employees oe ON oe.company_id = x.company_id AND oe.id = x.owner_employee_id
    LEFT JOIN hrms_performance_reviews r ON r.company_id = x.company_id AND r.id = x.review_id
    LEFT JOIN users cu ON cu.id = x.closed_by
    LEFT JOIN users ku ON ku.id = x.created_by`;

async function actionRows(db, companyId, where, params) {
  const [rows] = await db.query(`${ACTION_SQL} WHERE x.company_id = ? AND x.deleted_at IS NULL AND ${where.join(' AND ')}
    ORDER BY (x.status = 'OPEN') DESC, (x.status = 'OPEN' AND x.due_date < ?) DESC, x.due_date, x.id`, [companyId, ...params, today()]);
  return rows;
}

/** What a caller may do on an action. */
function actionCanFor(a, mode, can = {}) {
  const open = a.status === 'OPEN';
  if (mode === 'SELF') return { done: false, edit: false, drop: false };
  const edit = can.edit !== false;
  return { done: edit && open, edit: edit && open, drop: edit && open };
}

function shapeAction(a, on = today(), can = null) {
  const due = iso(a.due_date);
  const overdue = a.status === 'OPEN' && due < on;
  return {
    id: a.id, planId: Number(a.plan_id), reviewId: a.review_id ?? null,
    review: a.review_id ? { id: a.review_id, kind: a.review_kind, label: a.review_kind === 'FINAL' ? 'Final review' : `Check-in${a.review_slot_name ? ` · ${a.review_slot_name}` : ''}` } : null,
    text: a.action_text,
    owner: { employeeId: Number(a.owner_employee_id), name: a.owner_name, employeeCode: a.owner_code ?? null, isThePerson: Number(a.owner_employee_id) === Number(a.employee_id) },
    ownerEmployeeId: Number(a.owner_employee_id), ownerName: a.owner_name,
    dueDate: due, overdue, daysOverdue: overdue ? daysBetween(due, on) : 0,
    status: a.status, statusLabel: ACTION_WORDS[a.status] ?? a.status,
    state: overdue ? 'OVERDUE' : a.status,
    doneOn: iso(a.done_on), note: a.note ?? null, closedAt: a.closed_at ?? null, closedBy: a.closed_by_name ?? null,
    createdBy: a.created_by_name ?? null, createdAt: a.created_at,
    employee: { id: Number(a.employee_id), name: a.full_name, employeeCode: a.employee_code ?? null },
    employeeId: Number(a.employee_id), employeeName: a.full_name, employeeCode: a.employee_code ?? null,
    periodId: Number(a.period_id), periodName: a.period_name,
    positionId: a.position_id, positionCode: a.position_code, positionTitle: a.position_title, roleId: a.role_id,
    departmentId: a.department_id, departmentName: a.department_name, managerPositionId: a.manager_position_id ?? null,
    planStatus: a.plan_status,
    ...(can ? { can } : {}),
  };
}

/**
 * GET /performance/actions — the actions the login reaches, overdue first, then by
 * due date. One query; the filters (lib/listFilters.js) run in memory.
 * @param opts { employeeIds?, scopeDeptIds? }
 */
export async function listActions(db, c, opts = {}, can = {}) {
  const where = ['1 = 1'];
  const params = [];
  if (opts.employeeIds) { where.push('pl.employee_id IN (?)'); params.push(opts.employeeIds.length ? opts.employeeIds : [0]); }
  if (opts.scopeDeptIds) { where.push('pl.department_id IN (?)'); params.push(opts.scopeDeptIds.length ? opts.scopeDeptIds : [0]); }
  const rows = await actionRows(db, c.companyId, where, params);
  const on = today();
  const items = rows.map((a) => shapeAction(a, on, actionCanFor(a, 'MANAGE', can)));
  const owners = [...new Map(items.map((x) => [x.ownerEmployeeId, { id: x.ownerEmployeeId, name: x.ownerName }])).values()].sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return { items, owners, counts: { open: items.filter((x) => x.status === 'OPEN').length, overdue: items.filter((x) => x.overdue).length } };
}

/** The people an action on this plan may be owned by: the person, whoever holds the manager's position today, and the login raising it. One query. */
async function ownerOptions(db, c, plan) {
  const on = today();
  const [rows] = await db.query(
    `SELECT e.id, e.full_name, e.employee_code,
            (e.id = ?) AS is_person,
            EXISTS (SELECT 1 FROM hrms_work_assignments wa WHERE wa.company_id = e.company_id AND wa.employee_id = e.id AND wa.position_id = ? AND ${HOLDS_SEAT_SQL('wa')}
                      AND (wa.effective_from IS NULL OR wa.effective_from <= ?) AND (wa.effective_to IS NULL OR wa.effective_to >= ?)) AS is_manager,
            (e.user_id = ?) AS is_me
       FROM hrms_employees e
      WHERE e.company_id = ? AND e.deleted_at IS NULL
        AND (e.id = ? OR e.user_id = ? OR EXISTS (SELECT 1 FROM hrms_work_assignments wa WHERE wa.company_id = e.company_id AND wa.employee_id = e.id AND wa.position_id = ? AND ${HOLDS_SEAT_SQL('wa')}
                      AND (wa.effective_from IS NULL OR wa.effective_from <= ?) AND (wa.effective_to IS NULL OR wa.effective_to >= ?)))
      ORDER BY (e.id = ?) DESC, e.full_name`,
    [plan.employee_id, plan.manager_position_id ?? 0, on, on, c.userId ?? 0, c.companyId, plan.employee_id, c.userId ?? 0, plan.manager_position_id ?? 0, on, on, plan.employee_id]);
  return rows.map((r) => ({
    employeeId: Number(r.id), name: r.full_name, employeeCode: r.employee_code ?? null,
    relation: Number(r.is_person) ? 'PERSON' : Number(r.is_manager) ? 'MANAGER' : 'YOU',
    label: Number(r.is_person) ? 'The person' : Number(r.is_manager) ? 'Their manager' : 'You',
  }));
}

/** The due date sent: a real day, today or later (an existing action's own past date may stay). */
function readDue(value, keep = null) {
  const d = dateText(value);
  if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d)) throw invalid('INVALID', 'Give the day the action is due.');
  if (d < today() && d !== keep) throw invalid('INVALID', 'An action cannot be due on a day that has passed. Choose today or a later day.');
  return d;
}

async function planForAction(db, companyId, planId) {
  const [[plan]] = await db.query('SELECT id, status, employee_id, manager_position_id FROM hrms_performance_plans WHERE company_id = ? AND id = ? FOR UPDATE', [companyId, Number(planId)]);
  if (!plan) throw notFound('Plan');
  return plan;
}

async function checkOwner(db, c, plan, ownerId) {
  const id = Number(ownerId);
  if (!Number.isInteger(id) || id <= 0) throw invalid('INVALID', 'Say who owns the action.');
  const owners = await ownerOptions(db, c, plan);
  if (!owners.some((o) => o.employeeId === id)) throw invalid('NOT_AN_OWNER', 'An action is owned by the person, by whoever holds their manager’s position, or by you.');
  return id;
}

/** POST …/plans/:id/actions { text, ownerEmployeeId, dueDate, reviewId?, note? } */
export async function addAction(db, c, planId, body = {}) {
  onlyFields(body, ['text', 'ownerEmployeeId', 'dueDate', 'reviewId', 'note'], 'An action');
  const plan = await planForAction(db, c.companyId, planId);
  if (plan.status === 'CANCELLED') throw conflict('PLAN_CANCELLED', 'This plan was cancelled: no action can be raised on it.');
  if (plan.status === 'DRAFT') throw conflict('NOT_ACTIVE', 'This plan is still a draft. Actions are raised once it is activated.');
  const text = clip(body.text, 1000);
  if (!text) throw invalid('INVALID', 'Write what is to be done.');
  let reviewId = null;
  if (body.reviewId != null && body.reviewId !== '') {
    const [[r]] = await db.query('SELECT id, status FROM hrms_performance_reviews WHERE company_id = ? AND id = ? AND plan_id = ?', [c.companyId, Number(body.reviewId), plan.id]);
    if (!r) throw notFound('Review');
    if (r.status === 'DONE') throw conflict('DONE', 'This review is done and is kept as it was closed. Raise the action on the plan instead.');
    if (r.status === 'CANCELLED') throw conflict('CANCELLED', 'This review was cancelled.');
    reviewId = r.id;
  }
  const owner = await checkOwner(db, c, plan, body.ownerEmployeeId);
  const due = readDue(body.dueDate);
  const note = clip(body.note, 1000);
  const [res] = await db.query(
    "INSERT INTO hrms_performance_actions (company_id, plan_id, review_id, owner_employee_id, action_text, due_date, status, note, created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?, 'OPEN', ?, ?, ?)",
    [c.companyId, plan.id, reviewId, owner, text, due, note, c.userId, c.userId]);
  await audit(db, c, 'hrms_performance_actions', res.insertId, 'CREATE', null, { planId: Number(plan.id), reviewId, owner, text, dueDate: due, note });
  return { id: res.insertId };
}

async function actionRow(db, companyId, actionId, { lock = false } = {}) {
  const [[a]] = await db.query(`SELECT * FROM hrms_performance_actions WHERE company_id = ? AND id = ? AND deleted_at IS NULL${lock ? ' FOR UPDATE' : ''}`, [companyId, Number(actionId)]);
  if (!a) throw notFound('Action');
  return a;
}

/** The person whose plan an action is on — what the scope and the team rule are checked against. */
export async function actionEmployeeId(db, companyId, actionId) {
  const [[r]] = await db.query(
    'SELECT pl.employee_id FROM hrms_performance_actions x JOIN hrms_performance_plans pl ON pl.company_id = x.company_id AND pl.id = x.plan_id WHERE x.company_id = ? AND x.id = ? AND x.deleted_at IS NULL',
    [companyId, Number(actionId)]);
  return r ? Number(r.employee_id) : null;
}
export async function actionPlanId(db, companyId, actionId) {
  const [[r]] = await db.query('SELECT plan_id FROM hrms_performance_actions WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [companyId, Number(actionId)]);
  return r ? Number(r.plan_id) : null;
}

/** PUT …/actions/:id { text?, ownerEmployeeId?, dueDate?, note? } — an OPEN action. */
export async function changeAction(db, c, actionId, body = {}) {
  onlyFields(body, ['text', 'ownerEmployeeId', 'dueDate', 'note'], 'An action');
  const a = await actionRow(db, c.companyId, actionId, { lock: true });
  if (a.status !== 'OPEN') throw conflict('NOT_OPEN', `This action is ${ACTION_WORDS[a.status].toLowerCase()}: it is kept as it was.`);
  const next = {};
  if (body.text !== undefined) { next.action_text = clip(body.text, 1000); if (!next.action_text) throw invalid('INVALID', 'Write what is to be done.'); }
  if (body.ownerEmployeeId !== undefined && Number(body.ownerEmployeeId) !== Number(a.owner_employee_id)) {
    const plan = await planForAction(db, c.companyId, a.plan_id);
    next.owner_employee_id = await checkOwner(db, c, plan, body.ownerEmployeeId);
  }
  if (body.dueDate !== undefined) next.due_date = readDue(body.dueDate, iso(a.due_date));
  if (body.note !== undefined) next.note = clip(body.note, 1000);
  if (!Object.keys(next).length) return { ok: true, unchanged: true };
  await db.query(`UPDATE hrms_performance_actions SET ${Object.keys(next).map((k) => `${k} = ?`).join(', ')}, updated_by = ? WHERE company_id = ? AND id = ?`,
    [...Object.values(next), c.userId, c.companyId, a.id]);
  await audit(db, c, 'hrms_performance_actions', a.id, 'UPDATE',
    { text: a.action_text, owner: a.owner_employee_id, dueDate: iso(a.due_date), note: a.note },
    { ...(next.action_text !== undefined ? { text: next.action_text } : {}), ...(next.owner_employee_id !== undefined ? { owner: next.owner_employee_id } : {}),
      ...(next.due_date !== undefined ? { dueDate: next.due_date } : {}), ...(next.note !== undefined ? { note: next.note } : {}) });
  return { ok: true };
}

/**
 * POST …/actions/:id/done { note? } · …/drop { note } — an OPEN action is done (today)
 * or dropped (with a word why). `by` 'OWNER' when the owner marks their own done.
 */
export async function closeAction(db, c, actionId, status, body = {}, by = 'MANAGE') {
  onlyFields(body, ['note'], by === 'OWNER' ? 'You' : 'An action');
  const a = await actionRow(db, c.companyId, actionId, { lock: true });
  if (a.status !== 'OPEN') throw conflict('NOT_OPEN', `This action is already ${ACTION_WORDS[a.status].toLowerCase()}.`);
  const note = body.note !== undefined ? clip(body.note, 1000) : a.note;
  if (status === 'DROPPED' && !clip(body.note, 1000)) throw invalid('REASON_REQUIRED', 'Say why the action is dropped.');
  await db.query('UPDATE hrms_performance_actions SET status = ?, done_on = ?, note = ?, closed_at = NOW(), closed_by = ?, updated_by = ? WHERE company_id = ? AND id = ?',
    [status, status === 'DONE' ? today() : null, note, c.userId, c.userId, c.companyId, a.id]);
  await audit(db, c, 'hrms_performance_actions', a.id, 'UPDATE', { status: 'OPEN' }, { status, note, by });
  return { ok: true };
}

/** POST /user/me/actions/:id/done { note? } — only an action I own. Another's reads as not found. */
export async function markMyActionDone(db, c, actionId, body = {}) {
  const me = await myEmployee(db, c);
  const a = me ? await actionRow(db, c.companyId, actionId).catch(() => null) : null;
  if (!a || Number(a.owner_employee_id) !== Number(me.id)) throw notFound('Action');
  return closeAction(db, c, actionId, 'DONE', body, 'OWNER');
}

/* ══════════════════════════════════════════════════════════════════════════
 * The org chart panel: the latest rating and open actions of a person
 * ══════════════════════════════════════════════════════════════════════════ */

/** GET /performance/employees/:id/review-summary — three queries, side by side. Another company's person: 404. */
export async function reviewSummary(db, companyId, employeeId) {
  const on = today();
  const [[[last]], [[acts]], [[who]]] = await Promise.all([
    db.query(
      `SELECT r.id, r.rating_value, r.rating_label, r.closed_at, pp.name AS period_name
         FROM hrms_performance_reviews r
         JOIN hrms_performance_plans pl ON pl.company_id = r.company_id AND pl.id = r.plan_id
         JOIN hrms_performance_periods pp ON pp.company_id = pl.company_id AND pp.id = pl.period_id
        WHERE r.company_id = ? AND pl.employee_id = ? AND r.kind = 'FINAL' AND r.status = 'DONE' AND r.rating_value IS NOT NULL
        ORDER BY pp.end_date DESC, r.closed_at DESC, r.id DESC LIMIT 1`, [companyId, Number(employeeId)]),
    db.query(
      `SELECT COUNT(*) AS open, COALESCE(SUM(x.due_date < ?), 0) AS overdue
         FROM hrms_performance_actions x JOIN hrms_performance_plans pl ON pl.company_id = x.company_id AND pl.id = x.plan_id
        WHERE x.company_id = ? AND x.deleted_at IS NULL AND x.status = 'OPEN' AND pl.employee_id = ?`, [on, companyId, Number(employeeId)]),
    db.query('SELECT id FROM hrms_employees WHERE company_id = ? AND id = ?', [companyId, Number(employeeId)]),
  ]);
  if (!who) throw notFound('Employee');
  return {
    employeeId: Number(employeeId),
    latestRating: last ? { reviewId: last.id, value: Number(last.rating_value), label: last.rating_label, periodName: last.period_name, closedAt: last.closed_at } : null,
    openActions: Number(acts?.open ?? 0),
    overdueActions: Number(acts?.overdue ?? 0),
  };
}

export default {
  REVIEW_KINDS, REVIEW_STATUSES, ACTION_STATUSES, finalOpensOn, checkInSlots, ensureFinalReviews, listReviews, readReview, reviewEmployeeId, planReviews,
  openCheckIn, writeManagerPart, closeReview, cancelReview, cancelPlanReviews, myReviews, myReview, writeMyPart, finishMyPart,
  listActions, addAction, changeAction, closeAction, markMyActionDone, actionEmployeeId, actionPlanId, reviewSummary,
};
