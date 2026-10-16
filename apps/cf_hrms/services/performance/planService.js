/**
 * planService.js — performance plans. (TM/CF_HRMS_HIRING_SPEC.md §18.)
 *
 * A plan is made for one person for one period by COPYING the KRA headings and
 * the KPIs of their job as it stood on the period's start (role -> position ->
 * person, through contentResolver — the one resolver). Responsibilities are
 * not copied. The manager then changes only what differs.
 *
 *   preview -> create      who gets a plan, who is skipped and why; then the plans
 *   DRAFT                  freely editable: KRA weights, KPI targets, add / remove a KPI
 *   ACTIVE                 the list is locked; a target can still change — dated, with a reason
 *   CLOSED                 when the period is closed
 *   CANCELLED              a plan made by mistake; kept, never deleted
 *
 * ROUND TRIPS. Production costs ~49 ms per query. Nothing here runs a query per
 * person or per line: creating plans for a whole period is a fixed handful of
 * statements (performance_test.mjs counts them), and every list and every plan
 * read is a fixed number of queries whatever its size.
 *
 * WHO MAY: the routes decide the right (performance view / edit / remove) and
 * the department scope; a manager login (self view) reaches a plan only through
 * teamScopeService's rule — the same "below me" as their chart.
 */
import { HrmsError, invalid, conflict, notFound } from '../../lib/errors.js';
import { audit } from '../peopleService.js';
import { HOLDS_SEAT_SQL } from '../seatCount.js';
import { dateText, today } from '../positionService.js';
import { resolveJobsForAssignments, wholeWording } from '../contentResolver.js';
import { readSettings } from './settingsService.js';
import {
  FREQUENCIES, FREQUENCY_LABEL, isFrequency, periodStartingOn, periodsOfYear, yearOf, yearLabel,
} from './periods.js';
import { DIRECTIONS, planTargetOf, planTargetText, planTargetShort, valueText } from './targets.js';
import { COMBINE_RULES, COMBINE_WORDS, defaultCombine, resultTone, RESULT_WORDS } from './scoring.js';
import {
  loadPlanParts, planScoreParts, scorePlans, scoreSummary, kpiActualsView, periodOfRow, actualHistory, reviewKpiTable,
} from './actualsService.js';
import { cancelPlanReviews } from './reviewService.js';

export const PLAN_STATUSES = ['DRAFT', 'ACTIVE', 'CLOSED', 'CANCELLED'];
export const ENTRY_FREQUENCIES = ['DAILY', 'WEEKLY', 'MONTHLY', 'QUARTERLY', 'HALF_YEARLY', 'YEARLY'];

const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
const iso = (v) => dateText(v);
const clip = (s, n) => (s == null ? null : String(s).replace(/\s+/g, ' ').trim().slice(0, n) || null);
const longDay = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const sameNum = (a, b) => (a == null && b == null) || (a != null && b != null && Math.abs(Number(a) - Number(b)) < 0.00005);

/* ══════════════════════════════════════════════════════════════════════════
 * Periods
 * ══════════════════════════════════════════════════════════════════════════ */

function shapePeriodRow(r) {
  return { id: r.id, frequency: r.frequency, name: r.name, start: iso(r.start_date), end: iso(r.end_date), status: r.status };
}

/** The period a frequency + start date name, computed, plus its row when it has been made. Refuses a start that is no period's. */
export async function periodOf(db, companyId, { frequency, start }, settings = null) {
  const f = String(frequency ?? '').toUpperCase();
  if (!isFrequency(f)) throw invalid('INVALID', `Choose a frequency: ${FREQUENCIES.map((x) => FREQUENCY_LABEL[x].toLowerCase()).join(', ')}.`);
  const day = dateText(start);
  if (!day) throw invalid('INVALID', 'Choose the period.');
  const s = settings ?? await readSettings(db, companyId);
  const computed = periodStartingOn(f, s.yearStartMonth, day);
  if (!computed) throw invalid('NOT_A_PERIOD', `No ${FREQUENCY_LABEL[f].toLowerCase()} period starts on ${longDay(day)}.`);
  const [[row]] = await db.query('SELECT * FROM hrms_performance_periods WHERE company_id = ? AND frequency = ? AND start_date = ?', [companyId, f, computed.start]);
  return { ...computed, id: row?.id ?? null, status: row?.status ?? 'OPEN', made: Boolean(row) };
}

/** Make the period's row if it is not there. Never two periods of one frequency that overlap. */
async function ensurePeriod(db, c, period) {
  if (period.id) return period.id;
  const [over] = await db.query(
    `SELECT name FROM hrms_performance_periods WHERE company_id = ? AND frequency = ? AND start_date <= ? AND end_date >= ? LIMIT 1`,
    [c.companyId, period.frequency, period.end, period.start],
  );
  if (over.length) throw conflict('PERIOD_OVERLAP', `${period.name} would overlap ${over[0].name}, which already exists.`);
  const [res] = await db.query(
    'INSERT INTO hrms_performance_periods (company_id, frequency, name, start_date, end_date, status, created_by) VALUES (?, ?, ?, ?, ?, \'OPEN\', ?)',
    [c.companyId, period.frequency, period.name, period.start, period.end, c.userId],
  );
  await audit(db, c, 'hrms_performance_periods', res.insertId, 'CREATE', null, { frequency: period.frequency, name: period.name, start: period.start, end: period.end });
  return res.insertId;
}

/**
 * GET /performance/periods?year=&frequency= — every period of a performance
 * year (made or not), with how many plans each holds. Three queries.
 */
export async function listPeriods(db, companyId, { year, frequency } = {}, scopeDeptIds = null) {
  const settings = await readSettings(db, companyId);
  const thisYear = yearOf(today(), settings.yearStartMonth);
  const y = Number.isInteger(Number(year)) && Number(year) > 2000 ? Number(year) : thisYear;
  const freqs = frequency ? [String(frequency).toUpperCase()].filter(isFrequency) : FREQUENCIES;
  const computed = freqs.flatMap((f) => periodsOfYear(f, settings.yearStartMonth, y));
  const first = computed.reduce((m, p) => (p.start < m ? p.start : m), '9999-12-31');
  const last = computed.reduce((m, p) => (p.end > m ? p.end : m), '0000-01-01');
  const scopeSql = scopeDeptIds ? ' AND pl.department_id IN (?)' : '';
  const [rows] = await db.query(
    `SELECT pp.*, (SELECT COUNT(*) FROM hrms_performance_plans pl WHERE pl.company_id = pp.company_id AND pl.period_id = pp.id AND pl.status <> 'CANCELLED'${scopeSql}) AS plan_count
       FROM hrms_performance_periods pp WHERE pp.company_id = ? AND pp.start_date >= ? AND pp.end_date <= ?`,
    scopeDeptIds ? [scopeDeptIds.length ? scopeDeptIds : [0], companyId, first, last] : [companyId, first, last],
  );
  const made = new Map(rows.map((r) => [`${r.frequency}|${iso(r.start_date)}`, r]));
  const on = today();
  return {
    year: y,
    yearLabel: yearLabel(y, settings.yearStartMonth),
    years: [thisYear - 1, thisYear, thisYear + 1].map((v) => ({ value: v, label: yearLabel(v, settings.yearStartMonth) })),
    yearStartMonth: settings.yearStartMonth,
    defaultFrequency: settings.defaultFrequency,
    frequencies: FREQUENCIES.map((f) => ({ value: f, label: FREQUENCY_LABEL[f] })),
    periods: computed.map((p) => {
      const r = made.get(`${p.frequency}|${p.start}`);
      return {
        id: r?.id ?? null, frequency: p.frequency, name: p.name, start: p.start, end: p.end,
        status: r?.status ?? 'OPEN', made: Boolean(r), planCount: Number(r?.plan_count ?? 0), current: p.start <= on && on <= p.end,
      };
    }),
  };
}

/** POST /performance/periods/:id/close — ACTIVE plans close with it; refused while drafts are open. */
export async function closePeriod(db, c, periodId) {
  const [[p]] = await db.query('SELECT * FROM hrms_performance_periods WHERE company_id = ? AND id = ? FOR UPDATE', [c.companyId, periodId]);
  if (!p) throw notFound('Period');
  if (p.status === 'CLOSED') throw conflict('ALREADY_CLOSED', `${p.name} is already closed.`);
  const [[d]] = await db.query("SELECT COUNT(*) AS n FROM hrms_performance_plans WHERE company_id = ? AND period_id = ? AND status = 'DRAFT'", [c.companyId, periodId]);
  if (Number(d.n) > 0) {
    throw conflict('DRAFTS_OPEN', `${d.n} plan${Number(d.n) === 1 ? ' is' : 's are'} still a draft. Activate or cancel ${Number(d.n) === 1 ? 'it' : 'them'} before closing ${p.name}.`, { count: Number(d.n) });
  }
  const [res] = await db.query("UPDATE hrms_performance_plans SET status = 'CLOSED', closed_at = NOW() WHERE company_id = ? AND period_id = ? AND status = 'ACTIVE'", [c.companyId, periodId]);
  await db.query("UPDATE hrms_performance_periods SET status = 'CLOSED', closed_at = NOW(), closed_by = ? WHERE company_id = ? AND id = ?", [c.userId, c.companyId, periodId]);
  await audit(db, c, 'hrms_performance_periods', Number(periodId), 'UPDATE', { status: 'OPEN' }, { status: 'CLOSED', plansClosed: res.affectedRows });
  return { period: { ...shapePeriodRow(p), status: 'CLOSED' }, plansClosed: res.affectedRows };
}

/* ══════════════════════════════════════════════════════════════════════════
 * Who gets a plan
 * ══════════════════════════════════════════════════════════════════════════ */

const SKIP_LINE = {
  HAS_PLAN: 'Already has a plan for this period.',
  NO_POSITION: 'Not in a position during this period.',
  OTHER_FREQUENCY: null, // written per person: "Their role is on monthly plans."
};

/**
 * Everybody active, sorted into: gets a plan (in a position on the start date,
 * their role on this frequency), joined during the period (can be given one),
 * skipped (and why). Four queries plus the resolver's six, whatever the size.
 */
async function sortPeople(db, companyId, period, settings, scopeDeptIds) {
  const [rows] = await db.query(
    `SELECT e.id AS employee_id, e.full_name, e.employee_code,
            wa.id AS wa_id, wa.effective_from, wa.effective_to, wa.is_primary, wa.position_id,
            COALESCE(wa.role_id, p.role_id) AS role_id,
            p.position_code, COALESCE(p.position_title, r.title) AS position_title,
            COALESCE(p.department_id, wa.department_id) AS department_id, d.name AS department_name,
            r.title AS role_title, r.performance_frequency
       FROM hrms_employees e
       LEFT JOIN hrms_work_assignments wa ON wa.company_id = e.company_id AND wa.employee_id = e.id AND ${HOLDS_SEAT_SQL('wa')}
            AND (wa.effective_from IS NULL OR wa.effective_from <= ?) AND (wa.effective_to IS NULL OR wa.effective_to >= ?)
       LEFT JOIN hrms_positions p ON p.company_id = wa.company_id AND p.id = wa.position_id
       LEFT JOIN hrms_roles r ON r.company_id = e.company_id AND r.id = COALESCE(wa.role_id, p.role_id)
       LEFT JOIN hrms_departments d ON d.company_id = e.company_id AND d.id = COALESCE(p.department_id, wa.department_id)
      WHERE e.company_id = ? AND e.deleted_at IS NULL AND e.employment_status IN ('ACTIVE', 'NOTICE')
      ORDER BY e.full_name, e.id, wa.is_primary DESC, wa.effective_from DESC, wa.id DESC`,
    [period.end, period.start, companyId],
  );
  const existing = period.id
    ? (await db.query("SELECT id, employee_id, status FROM hrms_performance_plans WHERE company_id = ? AND period_id = ? AND status <> 'CANCELLED'", [companyId, period.id]))[0]
    : [];
  const planOf = new Map(existing.map((r) => [Number(r.employee_id), r]));

  const byEmployee = new Map();
  for (const r of rows) {
    const id = Number(r.employee_id);
    if (!byEmployee.has(id)) byEmployee.set(id, { id, name: r.full_name, code: r.employee_code ?? null, seats: [] });
    if (r.wa_id) byEmployee.get(id).seats.push(r);
  }
  const person = (e, seat, extra = {}) => ({
    employeeId: e.id, name: e.name, employeeCode: e.code,
    workAssignmentId: seat?.wa_id ?? null, positionId: seat?.position_id ?? null, positionCode: seat?.position_code ?? null,
    positionTitle: seat?.position_title ?? null, roleId: seat?.role_id ?? null, roleTitle: seat?.role_title ?? null,
    departmentId: seat?.department_id ?? null, departmentName: seat?.department_name ?? null, ...extra,
  });
  const inScope = (seat) => !scopeDeptIds || (seat && scopeDeptIds.includes(Number(seat.department_id)));
  const frequencyOf = (seat) => seat?.performance_frequency ?? settings.defaultFrequency;

  const willGet = [];
  const joiners = [];
  const skipped = [];
  for (const e of byEmployee.values()) {
    const onStart = e.seats.find((s) => (!s.effective_from || iso(s.effective_from) <= period.start) && (!s.effective_to || iso(s.effective_to) >= period.start));
    const later = onStart ? null : e.seats.filter((s) => s.effective_from && iso(s.effective_from) > period.start)
      .sort((a, b) => (iso(a.effective_from) < iso(b.effective_from) ? -1 : 1))[0] ?? null;
    const seat = onStart ?? later;
    if (!inScope(seat)) continue; // outside the login's department: not shown at all
    if (planOf.has(e.id)) { skipped.push(person(e, seat, { reason: 'HAS_PLAN', line: SKIP_LINE.HAS_PLAN, planId: planOf.get(e.id).id })); continue; }
    if (!seat) { skipped.push(person(e, null, { reason: 'NO_POSITION', line: SKIP_LINE.NO_POSITION })); continue; }
    const f = frequencyOf(seat);
    if (f !== period.frequency) {
      skipped.push(person(e, seat, { reason: 'OTHER_FREQUENCY', line: `Their role is on ${FREQUENCY_LABEL[f]?.toLowerCase() ?? f} plans.`, frequency: f }));
      continue;
    }
    if (onStart) willGet.push(person(e, seat, { copyOn: period.start }));
    else joiners.push(person(e, seat, { copyOn: iso(later.effective_from), joinedOn: iso(later.effective_from) }));
  }

  // What each would get: their job as on the day it is copied. Most share the period start; joiners their first day.
  const days = [...new Set([...willGet, ...joiners].map((p) => p.copyOn))];
  const jobs = new Map();
  for (const day of days) {
    const people = [...willGet, ...joiners].filter((p) => p.copyOn === day);
    const resolved = await resolveJobsForAssignments(db, companyId, people.map((p) => ({ workAssignmentId: p.workAssignmentId, positionId: p.positionId, roleId: p.roleId })), { on: day });
    for (const [waId, job] of resolved) jobs.set(`${waId}|${day}`, job);
  }
  for (const p of [...willGet, ...joiners]) {
    const job = jobs.get(`${p.workAssignmentId}|${p.copyOn}`) ?? { kras: [], additional: { kpis: [] } };
    p.job = job;
    p.kraCount = job.kras.length;
    p.kpiCount = job.kras.reduce((t, k) => t + k.kpis.length, 0) + job.additional.kpis.length;
    p.noKpis = p.kpiCount === 0;
  }
  return { willGet, joiners, skipped };
}

const publicPerson = ({ job, workAssignmentId, ...rest }) => rest;

/** POST /performance/plans/preview { frequency, start } — nothing is written. */
export async function previewPlans(db, companyId, body = {}, scopeDeptIds = null) {
  const settings = await readSettings(db, companyId);
  const period = await periodOf(db, companyId, body, settings);
  const { willGet, joiners, skipped } = await sortPeople(db, companyId, period, settings, scopeDeptIds);
  const count = (reason) => skipped.filter((s) => s.reason === reason).length;
  return {
    period: { id: period.id, frequency: period.frequency, name: period.name, start: period.start, end: period.end, status: period.status, made: period.made },
    willGet: willGet.map(publicPerson),
    joiners: joiners.map(publicPerson),
    skipped,
    counts: {
      willGet: willGet.length, noKpis: willGet.filter((p) => p.noKpis).length, joiners: joiners.length,
      hasPlan: count('HAS_PLAN'), noPosition: count('NO_POSITION'), otherFrequency: count('OTHER_FREQUENCY'),
    },
  };
}

/**
 * POST /performance/plans/create { frequency, start, employeeIds? }
 *   no employeeIds: everybody "gets a plan" in the preview;
 *   employeeIds:    those of them, and joiners named here (a joiner is never given one unasked).
 * Idempotent: whoever already has a plan is skipped. One transaction (the route's).
 */
export async function createPlans(db, c, body = {}, scopeDeptIds = null) {
  const settings = await readSettings(db, c.companyId);
  const period = await periodOf(db, c.companyId, body, settings);
  if (period.status === 'CLOSED') throw conflict('PERIOD_CLOSED', `${period.name} is closed. Plans cannot be made for it.`);
  const { willGet, joiners, skipped } = await sortPeople(db, c.companyId, period, settings, scopeDeptIds);
  let chosen = willGet;
  if (Array.isArray(body.employeeIds)) {
    const want = new Set(body.employeeIds.map(Number));
    chosen = [...willGet, ...joiners].filter((p) => want.has(p.employeeId));
    const known = new Set([...willGet, ...joiners, ...skipped].map((p) => p.employeeId));
    const unknown = [...want].filter((id) => !known.has(id));
    if (unknown.length) throw invalid('INVALID', 'Some of the people chosen are not in this company, or not in your department.', { detail: unknown });
  }
  const periodId = await ensurePeriod(db, c, period);
  if (!chosen.length) {
    return { period: { ...period, id: periodId, made: true }, created: 0, plans: [], skipped: skipped.length, line: 'Nobody needed a plan: everybody chosen already has one.' };
  }

  // The manager's position on the copy day: primary reporting lines of these positions, read once.
  const positionIds = [...new Set(chosen.map((p) => p.positionId).filter(Boolean))];
  const [edges] = positionIds.length ? await db.query(
    `SELECT rr.from_position_id, rr.to_position_id, rr.effective_from, rr.effective_to
       FROM hrms_position_reporting_relationships rr
       JOIN hrms_reporting_relationship_types t ON t.company_id = rr.company_id AND t.id = rr.relationship_type_id
      WHERE rr.company_id = ? AND rr.from_position_id IN (?) AND rr.deleted_at IS NULL AND t.code = 'PRIMARY_MANAGER'
        AND rr.effective_from <= ? AND (rr.effective_to IS NULL OR rr.effective_to >= ?)
      ORDER BY rr.is_primary DESC, rr.id`,
    [c.companyId, positionIds, period.end, period.start],
  ) : [[]];
  const managerOf = (p) => edges.find((e) => Number(e.from_position_id) === Number(p.positionId)
    && iso(e.effective_from) <= p.copyOn && (!e.effective_to || iso(e.effective_to) >= p.copyOn))?.to_position_id ?? null;

  // 1. the plans, in one statement; read back their ids in one.
  await db.query(
    `INSERT INTO hrms_performance_plans
       (company_id, period_id, employee_id, copied_on, work_assignment_id, position_id, role_id, department_id, manager_position_id,
        position_code, position_title, role_title, department_name, status, no_kpis, created_by)
     VALUES ${chosen.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, \'DRAFT\', ?, ?)').join(', ')}`,
    chosen.flatMap((p) => [c.companyId, periodId, p.employeeId, p.copyOn, p.workAssignmentId, p.positionId, p.roleId, p.departmentId, managerOf(p),
      clip(p.positionCode, 60), clip(p.positionTitle, 250), clip(p.roleTitle, 200), clip(p.departmentName, 200), p.noKpis ? 1 : 0, c.userId]),
  );
  const [made] = await db.query(
    "SELECT id, employee_id FROM hrms_performance_plans WHERE company_id = ? AND period_id = ? AND employee_id IN (?) AND status <> 'CANCELLED'",
    [c.companyId, periodId, chosen.map((p) => p.employeeId)],
  );
  const planIdOf = new Map(made.map((r) => [Number(r.employee_id), Number(r.id)]));

  // 2. the KRA headings of every plan, in one statement; their ids in one.
  const kraRows = [];
  for (const p of chosen) {
    p.job.kras.forEach((k, i) => kraRows.push({ planId: planIdOf.get(p.employeeId), sort: i, k }));
  }
  const kraIdOf = new Map();
  if (kraRows.length) {
    await db.query(
      `INSERT INTO hrms_performance_plan_kras (company_id, plan_id, name, kra_definition_id, line_key, weight_percent, job_weight_percent, added_on_plan, sort_order, created_by)
       VALUES ${kraRows.map(() => '(?, ?, ?, ?, ?, ?, ?, 0, ?, ?)').join(', ')}`,
      kraRows.flatMap(({ planId, sort, k }) => [c.companyId, planId, clip(wholeWording(k.name, k.description), 250) ?? 'KRA', k.definitionId ?? null, k.lineKey ?? null,
        num(k.weightPercent), num(k.weightPercent), sort, c.userId]),
    );
    const [ids] = await db.query('SELECT id, plan_id, sort_order FROM hrms_performance_plan_kras WHERE company_id = ? AND plan_id IN (?)', [c.companyId, [...planIdOf.values()]]);
    for (const r of ids) kraIdOf.set(`${r.plan_id}|${r.sort_order}`, Number(r.id));
  }

  // 3. the KPIs of every plan, in one statement.
  const kpiRows = [];
  let parsed = 0;
  let asWords = 0;
  for (const p of chosen) {
    const planId = planIdOf.get(p.employeeId);
    let sort = 0;
    const add = (item, kraSort) => {
      const t = planTargetOf(item);
      if (t.jobTargetText != null) { if (t.parsed) parsed += 1; else asWords += 1; }
      kpiRows.push([c.companyId, planId, kraSort == null ? null : kraIdOf.get(`${planId}|${kraSort}`) ?? null,
        clip(wholeWording(item.name, item.description), 250) ?? 'KPI', item.definitionId ?? null, item.lineKey ?? null,
        clip(t.unit, 30), t.direction, t.targetNumber, clip(t.targetText, 500), num(item.weightPercent), sort,
        clip(t.unit, 30), t.direction, t.targetNumber, clip(t.jobTargetText, 500), num(item.weightPercent), defaultCombine(t.unit, t.direction), c.userId]);
      sort += 1;
    };
    p.job.kras.forEach((k, i) => k.kpis.forEach((item) => add(item, i)));
    p.job.additional.kpis.forEach((item) => add(item, null));
  }
  if (kpiRows.length) {
    await db.query(
      `INSERT INTO hrms_performance_plan_kpis
         (company_id, plan_id, plan_kra_id, name, kpi_definition_id, line_key, unit, direction, target_number, target_text, weight_percent, sort_order,
          job_unit, job_direction, job_target_number, job_target_text, job_weight_percent, combine_rule, created_by)
       VALUES ${kpiRows.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}`,
      kpiRows.flat(),
    );
  }

  // 4. one audit row per plan, in one statement.
  await db.query(
    `INSERT INTO hrms_audit_log (company_id, actor_user_id, entity_type, entity_id, action, before_json, after_json, created_by)
     VALUES ${chosen.map(() => '(?, ?, \'hrms_performance_plans\', ?, \'CREATE\', NULL, ?, ?)').join(', ')}`,
    chosen.flatMap((p) => [c.companyId, c.userId, planIdOf.get(p.employeeId),
      JSON.stringify({ period: period.name, employeeId: p.employeeId, copiedOn: p.copyOn, positionId: p.positionId, kras: p.kraCount, kpis: p.kpiCount }), c.userId]),
  );

  return {
    period: { id: periodId, frequency: period.frequency, name: period.name, start: period.start, end: period.end, status: 'OPEN', made: true },
    created: chosen.length,
    plans: chosen.map((p) => ({ id: planIdOf.get(p.employeeId), employeeId: p.employeeId, name: p.name, kraCount: p.kraCount, kpiCount: p.kpiCount, noKpis: p.noKpis, copiedOn: p.copyOn })),
    kpis: { total: kpiRows.length, targetsAsNumbers: parsed, targetsAsWords: asWords },
    skipped: skipped.length,
  };
}

/* ══════════════════════════════════════════════════════════════════════════
 * Reading plans
 * ══════════════════════════════════════════════════════════════════════════ */

const PLAN_LIST_SQL = `
  SELECT pl.*, pp.name AS period_name, pp.frequency, pp.start_date, pp.end_date, pp.status AS period_status,
         e.full_name, e.employee_code,
         COALESCE(k.kra_count, 0) AS kra_count, COALESCE(k.weighted, 0) AS kra_weighted, COALESCE(k.weight_total, 0) AS weight_total,
         COALESCE(i.kpi_count, 0) AS kpi_count
    FROM hrms_performance_plans pl
    JOIN hrms_performance_periods pp ON pp.company_id = pl.company_id AND pp.id = pl.period_id
    JOIN hrms_employees e ON e.company_id = pl.company_id AND e.id = pl.employee_id
    LEFT JOIN (SELECT plan_id, COUNT(*) AS kra_count, SUM(weight_percent IS NOT NULL) AS weighted, SUM(COALESCE(weight_percent, 0)) AS weight_total
                 FROM hrms_performance_plan_kras WHERE company_id = ? AND deleted_at IS NULL GROUP BY plan_id) k ON k.plan_id = pl.id
    LEFT JOIN (SELECT plan_id, COUNT(*) AS kpi_count
                 FROM hrms_performance_plan_kpis WHERE company_id = ? AND deleted_at IS NULL GROUP BY plan_id) i ON i.plan_id = pl.id`;

function weightState(weighted, total, count) {
  const any = Number(weighted) > 0;
  const t = Math.round(Number(total) * 100) / 100;
  const ok = !any || Math.abs(t - 100) < 0.005;
  const problems = [];
  if (any && !ok) problems.push(`The KRA weights add up to ${t}%. They must add up to 100% when any weight is set.`);
  if (any && Number(weighted) < Number(count)) problems.push(`${Number(count) - Number(weighted)} KRA${Number(count) - Number(weighted) === 1 ? ' has' : 's have'} no weight. Give every KRA a weight, or none.`);
  return { anySet: any, total: t, ok: ok && !(any && Number(weighted) < Number(count)), problems };
}

function shapeListRow(r) {
  const weights = weightState(r.kra_weighted, r.weight_total, r.kra_count);
  return {
    id: r.id,
    status: r.status,
    period: { id: r.period_id, name: r.period_name, frequency: r.frequency, start: iso(r.start_date), end: iso(r.end_date), status: r.period_status },
    employee: { id: r.employee_id, name: r.full_name, employeeCode: r.employee_code ?? null },
    employeeName: r.full_name,
    employeeCode: r.employee_code ?? null,
    positionId: r.position_id, positionCode: r.position_code, positionTitle: r.position_title,
    roleId: r.role_id, roleTitle: r.role_title,
    departmentId: r.department_id, departmentName: r.department_name,
    frequency: r.frequency,
    copiedOn: iso(r.copied_on),
    kraCount: Number(r.kra_count), kpiCount: Number(r.kpi_count),
    noKpis: Boolean(r.no_kpis),
    weightsOk: weights.ok, weightTotal: weights.total, weightsSet: weights.anySet,
    activatedAt: r.activated_at ?? null, cancelledAt: r.cancelled_at ?? null, cancelReason: r.cancel_reason ?? null,
  };
}

/**
 * GET /performance/plans?periodId=&status=&band=… — five queries: the list, the settings and
 * the scores' three (the list filters run in memory, lib/listFilters.js).
 * Cancelled plans are listed only when asked for (status=CANCELLED).
 */
export async function listPlans(db, companyId, { periodId, employeeIds = null } = {}, scopeDeptIds = null) {
  const where = ['pl.company_id = ?'];
  const params = [companyId, companyId, companyId];
  if (periodId) { where.push('pl.period_id = ?'); params.push(Number(periodId)); }
  if (employeeIds) { where.push('pl.employee_id IN (?)'); params.push(employeeIds.length ? employeeIds : [0]); }
  if (scopeDeptIds) { where.push('pl.department_id IN (?)'); params.push(scopeDeptIds.length ? scopeDeptIds : [0]); }
  const [rows] = await db.query(`${PLAN_LIST_SQL} WHERE ${where.join(' AND ')} ORDER BY pp.start_date DESC, e.full_name, pl.id`, params);
  // The Score column (spec §19.3): every plan scored in three more queries, whatever their number.
  const scores = await scorePlans(db, companyId, rows);
  const none = { score: null, band: 'NO_DATA', bandLabel: 'No data', basedOn: { counted: 0, total: 0 }, scoreLine: null };
  return { items: rows.map((r) => ({ ...shapeListRow(r), ...(scores.get(Number(r.id)) ?? none) })) };
}

/** The plan row with what a read needs, or 404. */
async function planRow(db, companyId, planId, { lock = false } = {}) {
  // The lock is taken on the plan row alone; the read below joins counts.
  if (lock) await db.query('SELECT id FROM hrms_performance_plans WHERE company_id = ? AND id = ? FOR UPDATE', [companyId, Number(planId)]);
  const [[r]] = await db.query(
    `${PLAN_LIST_SQL} WHERE pl.company_id = ? AND pl.id = ?`,
    [companyId, companyId, companyId, Number(planId)],
  );
  if (!r) throw notFound('Plan');
  return r;
}

/** The employee a plan is for — what the scope and the team rule are checked against. */
export async function planEmployeeId(db, companyId, planId) {
  const [[r]] = await db.query('SELECT employee_id FROM hrms_performance_plans WHERE company_id = ? AND id = ?', [companyId, Number(planId)]);
  return r ? Number(r.employee_id) : null;
}

const MARK = { FROM_JOB: 'From the job', CHANGED: 'Changed for this period', ADDED: 'Added for this period' };

function shapeKpi(r, changes) {
  const mark = r.added_on_plan ? 'ADDED' : (r.changed_on_plan ? 'CHANGED' : 'FROM_JOB');
  const target = { direction: r.direction, targetNumber: num(r.target_number), targetText: r.target_text ?? null, unit: r.unit ?? null };
  const job = r.added_on_plan ? null : {
    direction: r.job_direction, targetNumber: num(r.job_target_number), targetText: r.job_direction === 'TEXT' ? r.job_target_text : null,
    unit: r.job_unit ?? null, weightPercent: num(r.job_weight_percent), written: r.job_target_text ?? null,
  };
  return {
    id: r.id,
    planKraId: r.plan_kra_id ?? null,
    name: r.name,
    lineKey: r.line_key ?? null,
    unit: target.unit,
    direction: target.direction,
    targetNumber: target.targetNumber,
    targetText: target.targetText,
    target: planTargetText(target),
    frequency: r.entry_frequency ?? null,
    weightPercent: num(r.weight_percent),
    combine: r.combine_rule ?? defaultCombine(r.unit, r.direction),
    mark,
    markLabel: MARK[mark],
    job: job ? { ...job, target: job.written ?? planTargetText(job) } : null,
    targetChanges: changes,
  };
}

/**
 * One plan, whole: header, KRA headings (weights, running total), their KPIs
 * with the mark and what the job says, KPIs under no KRA, dated target
 * changes — and (spec §19.3) each KPI's slots with their actuals, the combined
 * actual, achievement and band; each KRA's score; the plan's score "based on N
 * of M KPIs". Seven queries.
 * `can`: what THIS caller may do, given by the route ({ edit, activate, cancel, changeTarget, enterActuals }).
 */
export async function readPlan(db, companyId, planId, can = {}) {
  const r = await planRow(db, companyId, planId);
  const [parts, [changes], [manager], settings] = await Promise.all([
    loadPlanParts(db, companyId, [r.id]),
    db.query(
      `SELECT tc.*, u.name AS by_name FROM hrms_performance_target_changes tc LEFT JOIN users u ON u.id = tc.created_by
        WHERE tc.company_id = ? AND tc.plan_id = ? ORDER BY tc.effective_from, tc.id`, [companyId, r.id]),
    r.manager_position_id ? db.query(
      `SELECT p.id, p.position_code, COALESCE(p.position_title, ro.title) AS title,
              (SELECT e.full_name FROM hrms_work_assignments wa JOIN hrms_employees e ON e.company_id = wa.company_id AND e.id = wa.employee_id
                WHERE wa.company_id = p.company_id AND wa.position_id = p.id AND ${HOLDS_SEAT_SQL('wa')}
                  AND (wa.effective_from IS NULL OR wa.effective_from <= ?) AND (wa.effective_to IS NULL OR wa.effective_to >= ?)
                ORDER BY wa.is_primary DESC, wa.id LIMIT 1) AS occupant
         FROM hrms_positions p LEFT JOIN hrms_roles ro ON ro.company_id = p.company_id AND ro.id = p.role_id
        WHERE p.company_id = ? AND p.id = ?`,
      [iso(r.copied_on), iso(r.copied_on), companyId, r.manager_position_id],
    ).then(([rows]) => rows) : [],
    readSettings(db, companyId),
  ]);
  const kras = parts.kras.get(Number(r.id)) ?? [];
  const kpis = parts.kpis.get(Number(r.id)) ?? [];
  const period = periodOfRow(r);
  const score = planScoreParts(period, kras, kpis, parts.actuals, settings.bands);
  const unitOf = new Map(kpis.map((k) => [Number(k.id), k.unit ?? null]));
  const changesOf = new Map();
  for (const ch of changes) {
    const unit = unitOf.get(Number(ch.plan_kpi_id)) ?? null;
    const list = changesOf.get(Number(ch.plan_kpi_id)) ?? [];
    list.push({
      id: ch.id, effectiveFrom: iso(ch.effective_from), reason: ch.reason, by: ch.by_name ?? null, at: ch.created_at,
      from: planTargetText({ direction: ch.from_direction, targetNumber: num(ch.from_number), targetText: ch.from_text, unit }),
      to: planTargetText({ direction: ch.to_direction, targetNumber: num(ch.to_number), targetText: ch.to_text, unit }),
    });
    changesOf.set(Number(ch.plan_kpi_id), list);
  }
  const shaped = kpis.map((k) => ({ ...shapeKpi(k, changesOf.get(Number(k.id)) ?? []), actuals: kpiActualsView(k, score, parts.actuals) }));
  const list = { ...shapeListRow(r), ...scoreSummary(score) };
  const takesActuals = r.status === 'ACTIVE' && r.period_status !== 'CLOSED';
  const weights = weightState(kras.filter((k) => k.weight_percent != null).length, list.weightTotal, kras.length);
  const m = manager ?? null;
  return {
    plan: {
      ...list,
      manager: m ? { positionId: m.id, positionCode: m.position_code, positionTitle: m.title, name: m.occupant ?? null } : null,
      weights,
      can: {
        edit: Boolean(can.edit) && r.status === 'DRAFT',
        activate: Boolean(can.activate ?? can.edit) && r.status === 'DRAFT',
        cancel: Boolean(can.cancel) && (r.status === 'DRAFT' || r.status === 'ACTIVE'),
        changeTarget: Boolean(can.edit) && r.status === 'ACTIVE',
        enterActuals: Boolean(can.enterActuals ?? can.edit) && takesActuals,
      },
      actualsLine: takesActuals ? null : (r.status === 'DRAFT' ? 'Actuals are entered once the plan is activated.'
        : r.status === 'CANCELLED' ? 'This plan was cancelled: it takes no actuals.' : `${period.name} is closed: its actuals can be read, not changed.`),
    },
    kras: kras.map((k) => ({
      id: k.id, name: k.name, lineKey: k.line_key ?? null, weightPercent: num(k.weight_percent), jobWeightPercent: num(k.job_weight_percent),
      mark: k.added_on_plan ? 'ADDED' : (sameNum(k.weight_percent, k.job_weight_percent) ? 'FROM_JOB' : 'CHANGED'),
      kpis: shaped.filter((x) => Number(x.planKraId) === Number(k.id)),
      score: score.kras.get(Number(k.id))?.score ?? null,
      band: score.kras.get(Number(k.id))?.band ?? 'NO_DATA',
      basedOn: { counted: score.kras.get(Number(k.id))?.counted ?? 0, total: score.kras.get(Number(k.id))?.total ?? 0 },
    })),
    ungroupedKpis: shaped.filter((x) => x.planKraId == null),
    ungroupedScore: score.ungrouped ? { score: score.ungrouped.score, band: score.ungrouped.band, basedOn: { counted: score.ungrouped.counted, total: score.ungrouped.total } } : null,
    bands: settings.bands,
    combineRules: COMBINE_RULES.map((v) => ({ value: v, label: COMBINE_WORDS[v] })),
    marks: MARK,
    directions: DIRECTIONS.map((d) => ({ value: d, label: { HIGHER_BETTER: 'Higher is better', LOWER_BETTER: 'Lower is better', EXACT: 'Exactly', TEXT: 'Written as words' }[d] })),
    entryFrequencies: ENTRY_FREQUENCIES,
  };
}

/**
 * A person's plans — the employee page's Performance tab, and My plan. One query.
 */
export async function plansOfEmployee(db, companyId, employeeId) {
  const { items } = await listPlans(db, companyId, { employeeIds: [Number(employeeId)] });
  const on = today();
  const live = items.filter((p) => p.status !== 'CANCELLED');
  return {
    current: live.filter((p) => p.period.start <= on && on <= p.period.end),
    past: live.filter((p) => p.period.end < on),
    upcoming: live.filter((p) => p.period.start > on),
    cancelled: items.filter((p) => p.status === 'CANCELLED'),
  };
}

/** GET /user/me/plan — my plans for the period(s) that hold today, whole; read-only. */
export async function myPlans(db, c) {
  const [[e]] = await db.query('SELECT id, full_name FROM hrms_employees WHERE company_id = ? AND user_id = ? AND deleted_at IS NULL LIMIT 1', [c.companyId, c.userId]);
  if (!e) return { linked: false, line: 'This login is not linked to an employee record, so there is no plan to show.', plans: [] };
  const mine = await plansOfEmployee(db, c.companyId, e.id);
  const plans = [];
  for (const p of mine.current) plans.push(await readPlan(db, c.companyId, p.id, {}));
  return {
    linked: true,
    line: plans.length ? null : 'There is no plan for you for this period yet.',
    plans,
    past: mine.past.map(({ id, period, status, kraCount, kpiCount }) => ({ id, period, status, kraCount, kpiCount })),
  };
}

/** GET /user/me/plan/:id/kpis/:kpiId/actuals — a KPI's actuals on one of MY plans, corrections included. */
export async function myActualHistory(db, c, planId, kpiId) {
  const [[e]] = await db.query('SELECT id FROM hrms_employees WHERE company_id = ? AND user_id = ? AND deleted_at IS NULL LIMIT 1', [c.companyId, c.userId]);
  const owner = await planEmployeeId(db, c.companyId, planId);
  if (!e || owner == null || owner !== Number(e.id)) throw notFound('Plan');
  return actualHistory(db, c.companyId, planId, kpiId);
}

/* ══════════════════════════════════════════════════════════════════════════
 * The scorecard — the org chart panel's KPIs for one person (draft v1)
 * ══════════════════════════════════════════════════════════════════════════ */

const SLOT_NOUN = { DAILY: 'day', WEEKLY: 'week', MONTHLY: 'month', QUARTERLY: 'quarter', HALF_YEARLY: 'half', YEARLY: 'year' };
const SCORECARD_RANK = { ACTIVE: 0, CLOSED: 1, DRAFT: 2 };
const plural = (n, noun) => `${n} ${noun}${n === 1 ? '' : 's'}`;

/** A KRA's name cut to a chip: "Artwork approval & version control" -> "Artwork approval". */
export function shortKraName(name) {
  const whole = String(name ?? '').replace(/\s+/g, ' ').trim();
  const first = whole.split(/\s*(?:&|,|;|:|\(|—|–| - | and )\s*/i)[0] || whole;
  if (first.length <= 24) return first;
  const cut = first.slice(0, 23);
  return `${cut.slice(0, cut.lastIndexOf(' ') > 10 ? cut.lastIndexOf(' ') : 23)}…`;
}

/** "92% · average of 2 of 3 months" — the current value and how it is combined. null when nothing is in. */
function currentLine(row, entryFrequency) {
  if (!row.counted || row.actual == null) return null;
  const noun = SLOT_NOUN[entryFrequency] ?? 'slot';
  if (row.direction === 'TEXT') {
    const word = row.actual === 'YES' ? 'Met' : row.actual === 'NO' ? 'Not met' : String(row.actual);
    if (row.slotCount <= 1) return row.achievement === 100 ? 'Met' : row.achievement === 0 ? 'Not met' : word;
    return row.combine === 'LAST' ? `${word} · latest of ${row.counted} of ${plural(row.slotCount, noun)}` : `${word} · ${row.counted} of ${plural(row.slotCount, noun)} answered`;
  }
  const value = valueText(row.actual, row.unit);
  if (row.slotCount <= 1) return value;
  const how = { SUM: 'added up over', AVERAGE: 'average of', LAST: 'latest of' }[row.combine] ?? 'from';
  return `${value} · ${how} ${row.counted} of ${plural(row.slotCount, noun)}`;
}

/**
 * GET /performance/employees/:id/scorecard?on= — the person's KPIs on one day, for the org chart panel.
 *
 *   source PLAN   their plan whose period holds the day (ACTIVE first, then CLOSED, then DRAFT): each KPI
 *                 with its KRA, target, the current value and how it is combined, achievement and band —
 *                 reviewKpiTable(), i.e. scoring.js; the plan's score. Rows in KRA order.
 *   source JOB    no plan: the KPIs of the job they hold that day (contentResolver), with targets; no values.
 *   source NONE   no plan and no position.
 * Each KPI row and the plan carry `tone` (scoring.resultTone: MET / CLOSE / BELOW / NO_DATA) — what they are coloured by.
 * A fixed handful of queries.
 */
export async function scorecardOf(db, companyId, employeeId, { on } = {}) {
  const day = dateText(on) || today();
  const [[who]] = await db.query('SELECT id FROM hrms_employees WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [companyId, Number(employeeId)]);
  if (!who) throw notFound('Employee');
  const [plans] = await db.query(
    `${PLAN_LIST_SQL} WHERE pl.company_id = ? AND pl.employee_id = ? AND pl.status <> 'CANCELLED' AND pp.start_date <= ? AND pp.end_date >= ?`,
    [companyId, companyId, companyId, Number(employeeId), day, day],
  );
  plans.sort((a, b) => (SCORECARD_RANK[a.status] ?? 9) - (SCORECARD_RANK[b.status] ?? 9) || (iso(b.start_date) > iso(a.start_date) ? 1 : -1));
  const settings = await readSettings(db, companyId);
  const base = { employeeId: Number(employeeId), on: day, bands: settings.bands };

  const r = plans[0];
  if (r) {
    const parts = await loadPlanParts(db, companyId, [r.id]);
    const kras = parts.kras.get(Number(r.id)) ?? [];
    const kpis = parts.kpis.get(Number(r.id)) ?? [];
    const period = periodOfRow(r);
    const table = reviewKpiTable(period, kras, kpis, parts.actuals, settings.bands);
    const entryOf = new Map(kpis.map((k) => [Number(k.id), String(k.entry_frequency || period.frequency || '').toUpperCase()]));
    return {
      ...base,
      source: 'PLAN',
      plan: {
        id: Number(r.id), status: r.status, period, ...table.score, kpiCount: kpis.length,
        tone: resultTone(table.score.score, settings.bands),
        /** Another plan of theirs also holds the day (e.g. a monthly and a quarterly one). */ otherPlans: plans.length - 1,
      },
      kras: table.kras.map((k) => ({ key: `kra-${k.id}`, name: k.name, short: shortKraName(k.name), weightPercent: k.weightPercent, score: k.score, band: k.band })),
      kpis: table.rows.map((row) => ({
        key: `kpi-${row.kpiId}`, kpiId: row.kpiId, kraKey: row.kraId ? `kra-${row.kraId}` : null,
        name: row.name, unit: row.unit, direction: row.direction,
        target: row.target, targetShort: planTargetShort(row),
        actual: row.actual, current: currentLine(row, entryOf.get(row.kpiId)),
        combine: row.combine, combineLabel: row.combineLabel, counted: row.counted, slotCount: row.slotCount,
        achievement: row.achievement, band: row.band, bandLabel: row.bandLabel,
        gap: row.gap, gapText: row.gapText, pace: row.pace, paceNote: row.paceNote,
        tone: resultTone(row.achievement, settings.bands), toneLabel: RESULT_WORDS[resultTone(row.achievement, settings.bands)],
      })),
      line: null, // the plan's own score line says it ("No actuals yet.", "This plan has no KPIs.")
    };
  }

  // No plan for the day: the job's KPIs, as it stands that day.
  const [[seat]] = await db.query(
    `SELECT wa.id, wa.position_id, COALESCE(wa.role_id, p.role_id) AS role_id
       FROM hrms_work_assignments wa JOIN hrms_positions p ON p.company_id = wa.company_id AND p.id = wa.position_id
      WHERE wa.company_id = ? AND wa.employee_id = ? AND ${HOLDS_SEAT_SQL('wa')}
        AND (wa.effective_from IS NULL OR wa.effective_from <= ?) AND (wa.effective_to IS NULL OR wa.effective_to >= ?)
      ORDER BY wa.is_primary DESC, wa.effective_from DESC, wa.id DESC LIMIT 1`,
    [companyId, Number(employeeId), day, day],
  );
  if (!seat) return { ...base, source: 'NONE', plan: null, kras: [], kpis: [], line: 'They hold no position on this day, so there are no KPIs to show.' };
  const jobs = await resolveJobsForAssignments(db, companyId, [{ workAssignmentId: seat.id, positionId: seat.position_id, roleId: seat.role_id }], { on: day });
  const job = jobs.get(Number(seat.id)) ?? { kras: [], additional: { kpis: [] } };
  const outKras = [];
  const outKpis = [];
  const addKpi = (item, kraKey, i) => {
    const t = planTargetOf(item);
    outKpis.push({
      key: `job-${item.lineKey ?? `${kraKey}-${i}`}`, kpiId: null, kraKey,
      name: wholeWording(item.name, item.description), unit: t.unit ?? null, direction: t.direction,
      // The job's own words ("100% adoption by end of Nov'26"): what a plan would copy, as written.
      target: t.jobTargetText ?? planTargetText(t), targetShort: t.jobTargetText ?? planTargetShort(t),
      actual: null, current: null, combine: null, combineLabel: null, counted: 0, slotCount: 0, achievement: null, band: 'NO_DATA', bandLabel: 'No data',
      gap: null, gapText: null, pace: null, paceNote: null, tone: 'NO_DATA', toneLabel: RESULT_WORDS.NO_DATA,
    });
  };
  job.kras.forEach((k, i) => {
    const key = `job-kra-${k.lineKey ?? i}`;
    const name = wholeWording(k.name, k.description);
    outKras.push({ key, name, short: shortKraName(name), weightPercent: num(k.weightPercent), score: null, band: 'NO_DATA' });
    k.kpis.forEach((item, j) => addKpi(item, key, j));
  });
  job.additional.kpis.forEach((item, j) => addKpi(item, null, j));
  return {
    ...base, source: 'JOB', plan: null, kras: outKras, kpis: outKpis,
    line: 'No plan for this period yet — current values come once a plan is active.',
  };
}

/** GET /user/me/scorecard?on= — my own KPIs (the same read as HR's), for My place; read-only. */
export async function myScorecard(db, c, { on } = {}) {
  const [[e]] = await db.query('SELECT id FROM hrms_employees WHERE company_id = ? AND user_id = ? AND deleted_at IS NULL LIMIT 1', [c.companyId, c.userId]);
  if (!e) {
    return { linked: false, employeeId: null, on: dateText(on) || today(), source: 'NONE', plan: null, kras: [], kpis: [], line: 'This login is not linked to an employee record, so there are no KPIs to show.' };
  }
  return { linked: true, ...(await scorecardOf(db, c.companyId, e.id, { on })) };
}

/* ══════════════════════════════════════════════════════════════════════════
 * Changing a plan
 * ══════════════════════════════════════════════════════════════════════════ */

async function draftPlan(db, companyId, planId) {
  const r = await planRow(db, companyId, planId, { lock: true });
  if (r.status !== 'DRAFT') {
    throw conflict('NOT_DRAFT', r.status === 'ACTIVE'
      ? 'This plan is active: its list of KRAs and KPIs is locked. A target can still be changed, from a date and with a reason.'
      : `This plan is ${r.status.toLowerCase()} and cannot be changed.`);
  }
  return r;
}

const readWeight = (v, problems, what) => {
  if (v === null || v === '' || v === undefined) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 100) { problems.push(`${what} is a percentage from 0 to 100.`); return null; }
  return Math.round(n * 100) / 100;
};

/** Target fields from a body, checked together: { direction, targetNumber, targetText, unit }. */
function readTarget(body, current, problems) {
  const direction = body.direction !== undefined ? String(body.direction ?? '').toUpperCase() : current.direction;
  if (!DIRECTIONS.includes(direction)) problems.push('Choose which way is better: higher, lower, exactly, or written as words.');
  let targetNumber = body.targetNumber !== undefined ? body.targetNumber : current.targetNumber;
  let targetText = body.targetText !== undefined ? clip(body.targetText, 500) : current.targetText;
  const unit = body.unit !== undefined ? clip(body.unit, 30) : current.unit;
  if (direction === 'TEXT') {
    if (!targetText) problems.push('Write the target in words.');
    targetNumber = null;
  } else {
    const n = targetNumber === '' || targetNumber === null || targetNumber === undefined ? NaN : Number(targetNumber);
    if (!Number.isFinite(n)) problems.push('The target is a number (or choose "written as words").');
    targetNumber = Number.isFinite(n) ? n : null;
    targetText = null;
  }
  return { direction, targetNumber, targetText, unit };
}

/** PUT …/plans/:id/kras/:kraId { weightPercent } — draft only. */
export async function setKraWeight(db, c, planId, kraId, body = {}) {
  await draftPlan(db, c.companyId, planId);
  const [[k]] = await db.query('SELECT * FROM hrms_performance_plan_kras WHERE company_id = ? AND plan_id = ? AND id = ? AND deleted_at IS NULL', [c.companyId, planId, kraId]);
  if (!k) throw notFound('KRA');
  const problems = [];
  const w = readWeight(body.weightPercent, problems, 'A weight');
  if (problems.length) throw invalid('INVALID', problems[0], { problems });
  await db.query('UPDATE hrms_performance_plan_kras SET weight_percent = ? WHERE company_id = ? AND id = ?', [w, c.companyId, kraId]);
  await audit(db, c, 'hrms_performance_plan_kras', Number(kraId), 'UPDATE', { weightPercent: num(k.weight_percent) }, { weightPercent: w, planId: Number(planId) });
  return { ok: true };
}

/** The combine rule a body asks for (spec §19.1): SUM | AVERAGE | LAST, or undefined when it says nothing. */
function readCombine(body, problems) {
  if (body.combine === undefined || body.combine === null || body.combine === '') return undefined;
  const v = String(body.combine).toUpperCase();
  if (!COMBINE_RULES.includes(v)) { problems.push('Choose how the slots make one actual: added up, average, or latest.'); return undefined; }
  return v;
}

/** POST …/plans/:id/kpis { planKraId?, name, direction, targetNumber | targetText, unit?, frequency?, weightPercent?, combine? } — draft only. */
export async function addKpi(db, c, planId, body = {}) {
  await draftPlan(db, c.companyId, planId);
  const problems = [];
  const name = clip(body.name, 250);
  if (!name) problems.push('Name the KPI.');
  let planKraId = null;
  if (body.planKraId != null && body.planKraId !== '') {
    const [[k]] = await db.query('SELECT id FROM hrms_performance_plan_kras WHERE company_id = ? AND plan_id = ? AND id = ? AND deleted_at IS NULL', [c.companyId, planId, Number(body.planKraId)]);
    if (!k) problems.push('That KRA is not on this plan.');
    else planKraId = k.id;
  }
  const t = readTarget(body, { direction: 'HIGHER_BETTER', targetNumber: null, targetText: null, unit: null }, problems);
  const frequency = body.frequency ? String(body.frequency).toUpperCase() : null;
  if (frequency && !ENTRY_FREQUENCIES.includes(frequency)) problems.push('Choose how often it is measured.');
  const weight = readWeight(body.weightPercent, problems, 'A weight');
  const combine = readCombine(body, problems) ?? defaultCombine(t.unit, t.direction);
  if (problems.length) throw invalid('INVALID', problems[0], { problems });
  const [[s]] = await db.query('SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM hrms_performance_plan_kpis WHERE company_id = ? AND plan_id = ?', [c.companyId, planId]);
  const [res] = await db.query(
    `INSERT INTO hrms_performance_plan_kpis
       (company_id, plan_id, plan_kra_id, name, unit, direction, target_number, target_text, entry_frequency, weight_percent, combine_rule, sort_order, added_on_plan, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
    [c.companyId, planId, planKraId, name, t.unit, t.direction, t.targetNumber, t.targetText, frequency, weight, combine, Number(s.next), c.userId],
  );
  await db.query('UPDATE hrms_performance_plans SET no_kpis = 0 WHERE company_id = ? AND id = ?', [c.companyId, planId]);
  await audit(db, c, 'hrms_performance_plan_kpis', res.insertId, 'CREATE', null, { planId: Number(planId), name, ...t, frequency, weightPercent: weight, combine });
  return { ok: true, id: res.insertId };
}

async function kpiOf(db, companyId, planId, kpiId) {
  const [[k]] = await db.query('SELECT * FROM hrms_performance_plan_kpis WHERE company_id = ? AND plan_id = ? AND id = ? AND deleted_at IS NULL', [companyId, planId, kpiId]);
  if (!k) throw notFound('KPI');
  return k;
}
const differsFromJob = (k) => !k.added_on_plan && (
  (k.unit ?? null) !== (k.job_unit ?? null) || k.direction !== k.job_direction || !sameNum(k.target_number, k.job_target_number)
  || (k.direction === 'TEXT' && (k.target_text ?? null) !== (k.job_target_text ?? null)) || !sameNum(k.weight_percent, k.job_weight_percent)
  || k.entry_frequency != null);

/** PUT …/plans/:id/kpis/:kpiId { direction?, targetNumber?, targetText?, unit?, frequency?, weightPercent?, combine?, name? (added ones only) } — draft only. */
export async function changeKpi(db, c, planId, kpiId, body = {}) {
  await draftPlan(db, c.companyId, planId);
  const k = await kpiOf(db, c.companyId, planId, kpiId);
  const problems = [];
  const t = readTarget(body, { direction: k.direction, targetNumber: num(k.target_number), targetText: k.target_text, unit: k.unit }, problems);
  let name = k.name;
  if (body.name !== undefined && clip(body.name, 250) !== k.name) {
    if (!k.added_on_plan) problems.push('A KPI from the job keeps its wording. Add a KPI for this period instead.');
    else if (!clip(body.name, 250)) problems.push('Name the KPI.');
    else name = clip(body.name, 250);
  }
  const frequency = body.frequency !== undefined ? (body.frequency ? String(body.frequency).toUpperCase() : null) : k.entry_frequency;
  if (frequency && !ENTRY_FREQUENCIES.includes(frequency)) problems.push('Choose how often it is measured.');
  const weight = body.weightPercent !== undefined ? readWeight(body.weightPercent, problems, 'A weight') : num(k.weight_percent);
  // The combine rule: as asked; else, when it was the old unit's default, the new unit's default follows.
  const wasDefault = (k.combine_rule ?? defaultCombine(k.unit, k.direction)) === defaultCombine(k.unit, k.direction);
  const combine = readCombine(body, problems) ?? (wasDefault ? defaultCombine(t.unit, t.direction) : k.combine_rule);
  if (problems.length) throw invalid('INVALID', problems[0], { problems });
  const next = { ...k, name, unit: t.unit, direction: t.direction, target_number: t.targetNumber, target_text: t.targetText, entry_frequency: frequency, weight_percent: weight };
  const changed = differsFromJob(next) ? 1 : 0;
  await db.query(
    `UPDATE hrms_performance_plan_kpis SET name = ?, unit = ?, direction = ?, target_number = ?, target_text = ?, entry_frequency = ?, weight_percent = ?, combine_rule = ?, changed_on_plan = ?
      WHERE company_id = ? AND id = ?`,
    [name, t.unit, t.direction, t.targetNumber, t.targetText, frequency, weight, combine, changed, c.companyId, kpiId],
  );
  await audit(db, c, 'hrms_performance_plan_kpis', Number(kpiId), 'UPDATE',
    { name: k.name, unit: k.unit, direction: k.direction, targetNumber: num(k.target_number), targetText: k.target_text, frequency: k.entry_frequency, weightPercent: num(k.weight_percent), combine: k.combine_rule },
    { name, ...t, frequency, weightPercent: weight, combine, planId: Number(planId) });
  return { ok: true, changedFromJob: Boolean(changed) };
}

/** DELETE …/plans/:id/kpis/:kpiId — draft only; the row is kept, marked removed. */
export async function removeKpi(db, c, planId, kpiId) {
  await draftPlan(db, c.companyId, planId);
  const k = await kpiOf(db, c.companyId, planId, kpiId);
  await db.query('UPDATE hrms_performance_plan_kpis SET deleted_at = NOW(), deleted_by = ? WHERE company_id = ? AND id = ?', [c.userId, c.companyId, kpiId]);
  await audit(db, c, 'hrms_performance_plan_kpis', Number(kpiId), 'DELETE', { name: k.name, planId: Number(planId) }, null);
  return { ok: true };
}

/** What stops a draft from being activated, in words. */
async function activationProblems(db, companyId, r) {
  const [[k]] = await db.query('SELECT COUNT(*) AS n, SUM(weight_percent IS NOT NULL) AS w, SUM(COALESCE(weight_percent, 0)) AS t FROM hrms_performance_plan_kras WHERE company_id = ? AND plan_id = ? AND deleted_at IS NULL', [companyId, r.id]);
  const [[i]] = await db.query('SELECT COUNT(*) AS n FROM hrms_performance_plan_kpis WHERE company_id = ? AND plan_id = ? AND deleted_at IS NULL', [companyId, r.id]);
  const problems = [...weightState(k.w ?? 0, k.t ?? 0, k.n).problems];
  if (Number(k.n) === 0 && Number(i.n) === 0) problems.push('This plan has no KRAs and no KPIs. Add a KPI, or cancel the plan.');
  return problems;
}

/** POST …/plans/:id/activate — the list of KRAs and KPIs is locked from here. */
export async function activatePlan(db, c, planId) {
  const r = await draftPlan(db, c.companyId, planId);
  const problems = await activationProblems(db, c.companyId, r);
  if (problems.length) throw invalid('NOT_READY', problems[0], { problems });
  await db.query("UPDATE hrms_performance_plans SET status = 'ACTIVE', activated_at = NOW(), activated_by = ? WHERE company_id = ? AND id = ?", [c.userId, c.companyId, planId]);
  await audit(db, c, 'hrms_performance_plans', Number(planId), 'APPROVE', { status: 'DRAFT' }, { status: 'ACTIVE' });
  return { ok: true };
}

/** POST …/plans/:id/cancel { reason? } — kept, never deleted; frees the person's slot in the period. */
export async function cancelPlan(db, c, planId, body = {}) {
  const r = await planRow(db, c.companyId, planId, { lock: true });
  if (!['DRAFT', 'ACTIVE'].includes(r.status)) throw conflict('NOT_CANCELLABLE', `This plan is ${r.status.toLowerCase()} and cannot be cancelled.`);
  const reason = clip(body.reason, 500);
  await db.query("UPDATE hrms_performance_plans SET status = 'CANCELLED', cancelled_at = NOW(), cancelled_by = ?, cancel_reason = ? WHERE company_id = ? AND id = ?", [c.userId, reason, c.companyId, planId]);
  await audit(db, c, 'hrms_performance_plans', Number(planId), 'UPDATE', { status: r.status }, { status: 'CANCELLED', reason });
  // Its reviews that are not done go with it (spec §20.1); a draft has none.
  const reviewsCancelled = r.status === 'ACTIVE' ? await cancelPlanReviews(db, c, Number(planId)) : 0;
  return { ok: true, reviewsCancelled };
}

/** Bulk activate / cancel — each plan on its own terms; what could not be done is listed, the rest is done. */
export async function forEachPlan(db, c, ids, fn) {
  const list = [...new Set((Array.isArray(ids) ? ids : []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if (!list.length) throw invalid('INVALID', 'Choose at least one plan.');
  const done = [];
  const refused = [];
  for (const id of list) {
    try {
      await db.query(`SAVEPOINT perf_${id}`);
      await fn(id);
      await db.query(`RELEASE SAVEPOINT perf_${id}`);
      done.push(id);
    } catch (err) {
      await db.query(`ROLLBACK TO SAVEPOINT perf_${id}`);
      if (!(err instanceof HrmsError)) throw err;
      refused.push({ id, code: err.code, message: err.message, problems: err.problems ?? [] });
    }
  }
  return { done: done.length, doneIds: done, refused };
}

/**
 * POST …/plans/:id/kpis/:kpiId/target { direction?, targetNumber? | targetText?, unit?, effectiveFrom?, reason }
 * An ACTIVE plan only. Dated (today by default; within the period; never before
 * the last change; a past day is the Owner's alone) and with a reason. The plan
 * KPI holds the target now in force; every change is its own row.
 */
export async function changeTarget(db, c, planId, kpiId, body = {}) {
  const r = await planRow(db, c.companyId, planId, { lock: true });
  if (r.status !== 'ACTIVE') {
    throw conflict('NOT_ACTIVE', r.status === 'DRAFT' ? 'This plan is a draft: change the target directly.' : `This plan is ${r.status.toLowerCase()} and cannot be changed.`);
  }
  const k = await kpiOf(db, c.companyId, planId, kpiId);
  const problems = [];
  const reason = clip(body.reason, 500);
  if (!reason) problems.push('Say why the target changes.');
  const t = readTarget(body, { direction: k.direction, targetNumber: num(k.target_number), targetText: k.target_text, unit: k.unit }, problems);
  const on = body.effectiveFrom ? dateText(body.effectiveFrom) : today();
  const start = iso(r.start_date);
  const end = iso(r.end_date);
  if (!on) problems.push('Give the day the new target takes effect.');
  else {
    if (on < start || on > end) problems.push(`The new target must take effect inside the period (${longDay(start)} to ${longDay(end)}).`);
    if (on < today() && !c.owner) problems.push('A target cannot change on a day that has passed. Choose today or a later day.');
    const [[last]] = await db.query('SELECT MAX(effective_from) AS d FROM hrms_performance_target_changes WHERE company_id = ? AND plan_kpi_id = ?', [c.companyId, kpiId]);
    if (last?.d && on < iso(last.d)) problems.push(`The target was last changed from ${longDay(iso(last.d))}; a new change takes effect on that day or later.`);
  }
  if (!problems.length && t.direction === k.direction && sameNum(t.targetNumber, k.target_number) && (t.targetText ?? null) === (k.target_text ?? null) && (t.unit ?? null) === (k.unit ?? null)) {
    problems.push('That is the target it already has.');
  }
  if (problems.length) throw invalid('INVALID', problems[0], { problems });
  await db.query(
    `INSERT INTO hrms_performance_target_changes
       (company_id, plan_id, plan_kpi_id, effective_from, from_number, from_text, from_direction, to_number, to_text, to_direction, reason, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [c.companyId, planId, kpiId, on, k.target_number, k.target_text, k.direction, t.targetNumber, t.targetText, t.direction, reason, c.userId],
  );
  const next = { ...k, unit: t.unit, direction: t.direction, target_number: t.targetNumber, target_text: t.targetText };
  await db.query(
    'UPDATE hrms_performance_plan_kpis SET unit = ?, direction = ?, target_number = ?, target_text = ?, changed_on_plan = ? WHERE company_id = ? AND id = ?',
    [t.unit, t.direction, t.targetNumber, t.targetText, differsFromJob(next) ? 1 : 0, c.companyId, kpiId],
  );
  await audit(db, c, 'hrms_performance_plan_kpis', Number(kpiId), 'UPDATE',
    { direction: k.direction, targetNumber: num(k.target_number), targetText: k.target_text, unit: k.unit },
    { ...t, effectiveFrom: on, reason, planId: Number(planId) });
  return { ok: true, effectiveFrom: on };
}

export default {
  PLAN_STATUSES, periodOf, listPeriods, closePeriod, previewPlans, createPlans, listPlans, readPlan, planEmployeeId, plansOfEmployee, myPlans, myActualHistory, scorecardOf, myScorecard, shortKraName,
  setKraWeight, addKpi, changeKpi, removeKpi, activatePlan, cancelPlan, forEachPlan, changeTarget,
};
