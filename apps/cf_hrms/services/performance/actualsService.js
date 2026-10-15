/**
 * actualsService.js — actuals against performance plans. (TM/CF_HRMS_HIRING_SPEC.md §19.)
 *
 * An ACTUAL is what a person achieved on one plan KPI for one SLOT (slots.js).
 * It is NEVER OVERWRITTEN: a correction closes the live row and opens a new one
 * that says who, when and why. One live row per (plan KPI, slot).
 *
 *   enterActuals(db, c, entries)   the ONE writer — the grid's cell, the plan page, the
 *                                  manager login and the Excel upload all come here,
 *                                  one entry or five hundred, in a fixed number of queries
 *   actualsGrid(…)                 Performance › Actuals: one row per person × KPI for a slot
 *   scorePlans(…) / planScoreParts(…)
 *                                  every read that shows a score gets it here, from
 *                                  scoring.js — computed on read, never stored
 *   actualHistory(…)               a KPI's actuals, corrections included
 *   chartBands(…)                  the org chart's "Colour by performance"
 *
 * RULES (spec §19.2)
 *   - only an ACTIVE plan takes actuals; a CLOSED period (and its closed plans) is read-only;
 *   - a slot is open from its first day: a slot in the future is refused;
 *   - a number for a KPI with a number target; met / not met for a target written as words;
 *   - correcting a value already entered needs a reason; a note alone may change without one
 *     (it is still a new row: nothing is overwritten);
 *   - a value once entered is corrected, never removed.
 *
 * ROUND TRIPS. Production costs ~49 ms per query. Nothing here runs a query per
 * row: the grid for a whole period is a fixed handful of reads (actuals_test.mjs
 * counts them), and an upload of 500 values is a fixed handful of writes.
 */
import { HrmsError, invalid, notFound } from '../../lib/errors.js';
import { dateText, today } from '../positionService.js';
import { readSettings } from './settingsService.js';
import { slotsOf } from './slots.js';
import { scorePlan, kpiResult, bandOf, BAND_WORDS, COMBINE_RULES, COMBINE_WORDS, defaultCombine } from './scoring.js';
import { planTargetText } from './targets.js';
import { filterRows, LIST_SPECS } from '../../lib/listFilters.js';

export const SOURCES = ['MANUAL', 'EXCEL', 'SYSTEM', 'FORMULA'];
const iso = (v) => dateText(v);
const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
const clip = (s, n) => (s == null ? null : String(s).replace(/\s+/g, ' ').trim().slice(0, n) || null);
const longDay = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const sameNum = (a, b) => (a == null && b == null) || (a != null && b != null && Math.abs(Number(a) - Number(b)) < 0.00005);

/** The period a plan row carries (PLAN_LIST_SQL's columns, or this file's). */
export const periodOfRow = (r) => ({ id: r.period_id, name: r.period_name, frequency: r.frequency, start: iso(r.start_date), end: iso(r.end_date), status: r.period_status ?? 'OPEN' });

/** A plan KPI row as scoring.js reads it. */
const scoringKpi = (k, period) => ({
  id: Number(k.id), planKraId: k.plan_kra_id == null ? null : Number(k.plan_kra_id), weightPercent: num(k.weight_percent),
  direction: k.direction, targetNumber: num(k.target_number), unit: k.unit ?? null,
  combine: k.combine_rule ?? defaultCombine(k.unit, k.direction), slotCount: slotsOf(period, k.entry_frequency).length,
});
const scoringActual = (a) => ({ slotStart: iso(a.slot_start), valueNumber: num(a.value_number), met: a.met ?? null });

/* ══════════════════════════════════════════════════════════════════════════
 * Loading and scoring — the one place
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * The KRAs, KPIs and LIVE actuals of some plans: three queries, whatever their number.
 * @returns { kras: Map<planId, rows>, kpis: Map<planId, rows>, actuals: Map<kpiId, rows> }
 */
export async function loadPlanParts(db, companyId, planIds) {
  const ids = [...new Set(planIds.map(Number))];
  const empty = { kras: new Map(), kpis: new Map(), actuals: new Map() };
  if (!ids.length) return empty;
  const [[kras], [kpis], [actuals]] = await Promise.all([
    db.query('SELECT * FROM hrms_performance_plan_kras WHERE company_id = ? AND plan_id IN (?) AND deleted_at IS NULL ORDER BY plan_id, sort_order, id', [companyId, ids]),
    db.query('SELECT * FROM hrms_performance_plan_kpis WHERE company_id = ? AND plan_id IN (?) AND deleted_at IS NULL ORDER BY plan_id, sort_order, id', [companyId, ids]),
    db.query(
      `SELECT a.*, u.name AS by_name FROM hrms_performance_actuals a LEFT JOIN users u ON u.id = a.entered_by
        WHERE a.company_id = ? AND a.plan_id IN (?) AND a.closed_at IS NULL ORDER BY a.plan_kpi_id, a.slot_start`, [companyId, ids]),
  ]);
  const group = (rows, key) => { const m = new Map(); for (const r of rows) { const k = Number(r[key]); if (!m.has(k)) m.set(k, []); m.get(k).push(r); } return m; };
  return { kras: group(kras, 'plan_id'), kpis: group(kpis, 'plan_id'), actuals: group(actuals, 'plan_kpi_id') };
}

/**
 * One plan's score from its loaded parts. Pure.
 * @returns the scorePlan() answer, plus `slots` per KPI id ([{ start, end, name, open }]).
 */
export function planScoreParts(period, kraRows, kpiRows, actualsByKpi, bands, on = today()) {
  const kpis = kpiRows.map((k) => scoringKpi(k, period));
  const live = new Map(kpiRows.map((k) => [Number(k.id), (actualsByKpi.get(Number(k.id)) ?? []).map(scoringActual)]));
  const score = scorePlan({ kras: kraRows.map((k) => ({ id: Number(k.id), weightPercent: num(k.weight_percent) })), kpis }, live, bands);
  score.slots = new Map(kpiRows.map((k) => [Number(k.id), slotsOf(period, k.entry_frequency).map((s) => ({ ...s, open: s.start <= on }))]));
  return score;
}

/** The short form a list row carries. */
export const scoreSummary = (s) => ({
  score: s.score, band: s.band, bandLabel: BAND_WORDS[s.band], basedOn: s.basedOn, scoreLine: s.line,
});

/**
 * Scores of several plans (rows that carry their period: PLAN_LIST_SQL's). Three queries.
 * @returns Map<planId, scoreSummary>
 */
export async function scorePlans(db, companyId, planRows, settings = null) {
  const out = new Map();
  const counted = planRows.filter((r) => r.status !== 'CANCELLED');
  if (!counted.length) return out;
  const [s, parts] = await Promise.all([settings ? Promise.resolve(settings) : readSettings(db, companyId), loadPlanParts(db, companyId, counted.map((r) => r.id))]);
  for (const r of counted) {
    const sc = planScoreParts(periodOfRow(r), parts.kras.get(Number(r.id)) ?? [], parts.kpis.get(Number(r.id)) ?? [], parts.actuals, s.bands);
    out.set(Number(r.id), scoreSummary(sc));
  }
  return out;
}

/** An actual as a read shows it. */
const shapeActual = (a) => (a ? {
  id: a.id, value: num(a.value_number), valueText: a.value_text ?? null, met: a.met ?? null, note: a.note ?? null,
  source: a.source, by: a.by_name ?? null, at: a.entered_at, corrected: a.corrects_id != null, reason: a.correction_reason ?? null,
} : null);

/**
 * What the plan page shows of actuals for one KPI: its slots with their values,
 * the combined actual, the achievement and band. From planScoreParts' answer.
 */
export function kpiActualsView(kpiRow, score, actualsByKpi) {
  const id = Number(kpiRow.id);
  const r = score.kpis.get(id);
  const bySlot = new Map((actualsByKpi.get(id) ?? []).map((a) => [iso(a.slot_start), a]));
  const rule = kpiRow.combine_rule ?? defaultCombine(kpiRow.unit, kpiRow.direction);
  return {
    combine: rule, combineLabel: COMBINE_WORDS[rule],
    slots: (score.slots.get(id) ?? []).map((s) => ({ start: s.start, end: s.end, name: s.name, open: s.open, actual: shapeActual(bySlot.get(s.start)) })),
    combined: r?.combined ?? null, combinedTarget: r?.combinedTarget ?? null,
    achievement: r?.achievement ?? null, band: r?.band ?? 'NO_DATA', bandLabel: BAND_WORDS[r?.band ?? 'NO_DATA'],
    counted: r?.counted ?? 0, slotCount: r?.slotCount ?? 1,
  };
}

/* ══════════════════════════════════════════════════════════════════════════
 * Entering — the one writer
 * ══════════════════════════════════════════════════════════════════════════ */

const readMet = (v) => {
  if (v === true) return 'YES';
  if (v === false) return 'NO';
  const t = String(v ?? '').trim().toLowerCase();
  if (['yes', 'y', 'met', 'true', '1'].includes(t)) return 'YES';
  if (['no', 'n', 'not met', 'false', '0'].includes(t)) return 'NO';
  return null;
};

const why = (code, message, status = 422) => new HrmsError(status, code, message);

/**
 * Enter or correct actuals. One entry from a cell, or many from a file — the same
 * rules, the same queries: lock the plans (1), read their KPIs (1) and the live
 * actuals (1), close what is corrected (1), insert the new rows (1), audit (1).
 *
 * @param entries [{ planId, kpiId, slotStart, value?, met?, valueText?, note?, reason?, row? }]
 *   `value` for a KPI with a number target; `met` (YES/NO, true/false, "Met"/"Not met") for words.
 *   Absent keys keep what the live row has; `note: ''` clears the note (a new row).
 * @param opts { source: 'MANUAL' | 'EXCEL', planIds?: Set — the plans the caller may reach (the route's gate) }
 * @returns { entered, corrected, unchanged, results: [{ planId, kpiId, slotStart, action, id? }] }
 *   Throws the first problem (422 / 409) — a whole file is one transaction.
 */
export async function enterActuals(db, c, entries, opts = {}) {
  const source = SOURCES.includes(opts.source) ? opts.source : 'MANUAL';
  const list = Array.isArray(entries) ? entries : [];
  if (!list.length) throw invalid('INVALID', 'Nothing to enter.');
  const where = (e) => (e.row != null ? `Row ${e.row}: ` : '');
  const planIds = [...new Set(list.map((e) => Number(e.planId)))];
  if (planIds.some((id) => !Number.isInteger(id) || id <= 0)) throw invalid('INVALID', 'Say which plan the actual is for.');

  // 1. the plans and their periods, locked against a close or a cancel meanwhile.
  const [plans] = await db.query(
    `SELECT pl.id, pl.status, pl.employee_id, pp.id AS period_id, pp.name AS period_name, pp.frequency, pp.start_date, pp.end_date, pp.status AS period_status
       FROM hrms_performance_plans pl JOIN hrms_performance_periods pp ON pp.company_id = pl.company_id AND pp.id = pl.period_id
      WHERE pl.company_id = ? AND pl.id IN (?) FOR UPDATE`, [c.companyId, planIds]);
  const planOf = new Map(plans.map((p) => [Number(p.id), p]));
  // 2. their KPIs; 3. the live actuals of the KPIs named.
  const kpiIds = [...new Set(list.map((e) => Number(e.kpiId)))];
  const [[kpis], [live]] = await Promise.all([
    db.query('SELECT * FROM hrms_performance_plan_kpis WHERE company_id = ? AND id IN (?) AND deleted_at IS NULL', [c.companyId, kpiIds.length ? kpiIds : [0]]),
    db.query('SELECT * FROM hrms_performance_actuals WHERE company_id = ? AND plan_kpi_id IN (?) AND closed_at IS NULL FOR UPDATE', [c.companyId, kpiIds.length ? kpiIds : [0]]),
  ]);
  const kpiOf = new Map(kpis.map((k) => [Number(k.id), k]));
  const liveOf = new Map(live.map((a) => [`${a.plan_kpi_id}|${iso(a.slot_start)}`, a]));
  const on = today();

  const writes = [];
  const results = [];
  const seen = new Set();
  for (const e of list) {
    const plan = planOf.get(Number(e.planId));
    if (!plan || (opts.planIds && !opts.planIds.has(Number(e.planId)))) throw notFound('Plan');
    const period = periodOfRow(plan);
    if (plan.status !== 'ACTIVE' || period.status === 'CLOSED') {
      if (plan.status === 'CLOSED' || period.status === 'CLOSED') throw why('PERIOD_CLOSED', `${where(e)}${period.name} is closed: its actuals can be read, not changed.`, 409);
      if (plan.status === 'DRAFT') throw why('NOT_ACTIVE', `${where(e)}This plan is still a draft. Actuals are entered once it is activated.`, 409);
      throw why('NOT_ACTIVE', `${where(e)}This plan is ${String(plan.status).toLowerCase()}: it takes no actuals.`, 409);
    }
    const kpi = kpiOf.get(Number(e.kpiId));
    if (!kpi || Number(kpi.plan_id) !== Number(plan.id)) throw notFound('KPI');
    const slots = slotsOf(period, kpi.entry_frequency);
    const day = dateText(e.slotStart) ?? (slots.length === 1 ? slots[0].start : null);
    const slot = slots.find((s) => s.start === day);
    if (!slot) throw why('NOT_A_SLOT', `${where(e)}${day ? `${longDay(day)} does not start a slot of this KPI` : 'Say which slot the actual is for'}: it is entered for ${slots.map((s) => s.name).join(', ')}.`);
    if (slot.start > on) throw why('FUTURE_SLOT', `${where(e)}${slot.name} has not begun. Its actual can be entered from ${longDay(slot.start)}.`);
    const key = `${kpi.id}|${slot.start}`;
    if (seen.has(key)) throw why('TWICE', `${where(e)}${kpi.name} for ${slot.name} is given twice. Give it once.`);
    seen.add(key);

    const was = liveOf.get(key) ?? null;
    const isText = kpi.direction === 'TEXT';
    let value = was ? num(was.value_number) : null;
    let met = was?.met ?? null;
    let valueText = was?.value_text ?? null;
    let note = was?.note ?? null;
    if (e.value !== undefined) {
      if (isText) {
        if (e.value !== null && e.value !== '') throw why('INVALID', `${where(e)}${kpi.name} has a target written as words: say met or not met, not a number.`);
      } else if (e.value === null || e.value === '') {
        if (was) throw why('NO_REMOVE', `${where(e)}A value once entered is corrected, not removed: give the right value and a reason.`);
        value = null;
      } else {
        const n = typeof e.value === 'number' ? e.value : (/^\s*-?\d+(\.\d+)?\s*$/.test(String(e.value)) ? Number(e.value) : NaN);
        if (!Number.isFinite(n) || Math.abs(n) >= 1e14) throw why('INVALID', `${where(e)}The actual for ${kpi.name} is a number${kpi.unit ? ` (${kpi.unit})` : ''}; “${String(e.value).slice(0, 30)}” is not one.`);
        value = Math.round(n * 10000) / 10000;
      }
    }
    if (e.met !== undefined) {
      if (!isText) {
        if (e.met !== null && e.met !== '') throw why('INVALID', `${where(e)}${kpi.name} has a number target: give the number, not met / not met.`);
      } else if (e.met === null || e.met === '') {
        if (was) throw why('NO_REMOVE', `${where(e)}An answer once entered is corrected, not removed: give the right answer and a reason.`);
        met = null;
      } else {
        met = readMet(e.met);
        if (!met) throw why('INVALID', `${where(e)}Say whether ${kpi.name} was met: Met or Not met.`);
      }
    }
    if (e.valueText !== undefined) valueText = clip(e.valueText, 500);
    if (e.note !== undefined) note = clip(e.note, 1000);
    if (isText ? met == null : value == null) {
      throw why('INVALID', `${where(e)}${isText ? `Say whether ${kpi.name} was met.` : `Give the actual for ${kpi.name}.`}`);
    }

    const sameValue = isText ? met === (was?.met ?? null) : sameNum(value, was?.value_number);
    const sameRest = (valueText ?? null) === (was?.value_text ?? null) && (note ?? null) === (was?.note ?? null);
    if (was && sameValue && sameRest) { results.push({ planId: Number(plan.id), kpiId: Number(kpi.id), slotStart: slot.start, action: 'UNCHANGED', id: was.id }); continue; }
    const reason = clip(e.reason, 500);
    if (was && !sameValue && !reason) {
      throw why('REASON_REQUIRED', `${where(e)}${kpi.name} for ${slot.name} already has ${isText ? (was.met === 'YES' ? '“met”' : '“not met”') : `the value ${num(was.value_number)}`}. Say why it is corrected.`);
    }
    writes.push({ plan, kpi, slot, was, value, met, valueText, note, reason: was ? reason : null, action: was ? (sameValue ? 'NOTE' : 'CORRECTED') : 'ENTERED' });
  }

  if (writes.length) {
    // 4. close what is corrected; 5. the new rows; 6. their audit — one statement each.
    const closing = writes.filter((w) => w.was).map((w) => w.was.id);
    if (closing.length) await db.query('UPDATE hrms_performance_actuals SET closed_at = NOW(3), closed_by = ? WHERE company_id = ? AND id IN (?) AND closed_at IS NULL', [c.userId, c.companyId, closing]);
    await db.query(
      `INSERT INTO hrms_performance_actuals
         (company_id, plan_id, plan_kpi_id, slot_start, slot_end, value_number, value_text, met, note, source, entered_by, corrects_id, correction_reason)
       VALUES ${writes.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}`,
      writes.flatMap((w) => [c.companyId, w.plan.id, w.kpi.id, w.slot.start, w.slot.end, w.value, w.valueText, w.met, w.note, source, c.userId, w.was?.id ?? null, w.reason]),
    );
    const [made] = await db.query(
      `SELECT id, plan_kpi_id, slot_start FROM hrms_performance_actuals WHERE company_id = ? AND plan_kpi_id IN (?) AND closed_at IS NULL`,
      [c.companyId, [...new Set(writes.map((w) => w.kpi.id))]],
    );
    const idOf = new Map(made.map((a) => [`${a.plan_kpi_id}|${iso(a.slot_start)}`, a.id]));
    await db.query(
      `INSERT INTO hrms_audit_log (company_id, actor_user_id, entity_type, entity_id, action, before_json, after_json, created_by)
       VALUES ${writes.map(() => '(?, ?, \'hrms_performance_actuals\', ?, ?, ?, ?, ?)').join(', ')}`,
      writes.flatMap((w) => [c.companyId, c.userId, idOf.get(`${w.kpi.id}|${w.slot.start}`) ?? null, w.was ? 'UPDATE' : 'CREATE',
        w.was ? JSON.stringify({ id: w.was.id, value: num(w.was.value_number), met: w.was.met, note: w.was.note }) : null,
        JSON.stringify({ planId: Number(w.plan.id), kpiId: Number(w.kpi.id), slot: w.slot.name, value: w.value, met: w.met, note: w.note, reason: w.reason, source }), c.userId]),
    );
    for (const w of writes) results.push({ planId: Number(w.plan.id), kpiId: Number(w.kpi.id), slotStart: w.slot.start, action: w.action, id: idOf.get(`${w.kpi.id}|${w.slot.start}`) ?? null });
  }
  return {
    entered: results.filter((r) => r.action === 'ENTERED').length,
    corrected: results.filter((r) => r.action === 'CORRECTED' || r.action === 'NOTE').length,
    unchanged: results.filter((r) => r.action === 'UNCHANGED').length,
    results,
  };
}

/**
 * PUT /performance/actuals — one cell. Answers what the grid redraws: the row's
 * new actual and achievement, and the plan's new score.
 */
export async function enterOne(db, c, body = {}, opts = {}) {
  const res = await enterActuals(db, c, [{
    planId: body.planId, kpiId: body.kpiId, slotStart: body.slotStart,
    ...(body.value !== undefined ? { value: body.value } : {}), ...(body.met !== undefined ? { met: body.met } : {}),
    ...(body.valueText !== undefined ? { valueText: body.valueText } : {}), ...(body.note !== undefined ? { note: body.note } : {}),
    reason: body.reason,
  }], { source: 'MANUAL', ...opts });
  const r = res.results[0];
  const view = await cellView(db, c.companyId, Number(body.planId), Number(body.kpiId), r.slotStart);
  return { action: r.action, ...view };
}

/** One grid cell and its plan's score, after a write. Five queries. */
async function cellView(db, companyId, planId, kpiId, slotStart) {
  const [[plan]] = await db.query(
    `SELECT pl.id, pl.status, pp.id AS period_id, pp.name AS period_name, pp.frequency, pp.start_date, pp.end_date, pp.status AS period_status
       FROM hrms_performance_plans pl JOIN hrms_performance_periods pp ON pp.company_id = pl.company_id AND pp.id = pl.period_id
      WHERE pl.company_id = ? AND pl.id = ?`, [companyId, planId]);
  const [settings, parts] = await Promise.all([readSettings(db, companyId), loadPlanParts(db, companyId, [planId])]);
  const period = periodOfRow(plan);
  const kpiRows = parts.kpis.get(planId) ?? [];
  const score = planScoreParts(period, parts.kras.get(planId) ?? [], kpiRows, parts.actuals, settings.bands);
  const kpi = kpiRows.find((k) => Number(k.id) === kpiId);
  const slotActual = (parts.actuals.get(kpiId) ?? []).find((a) => iso(a.slot_start) === slotStart) ?? null;
  const slotResult = slotAchievement(kpi, period, slotActual, settings.bands);
  return {
    actual: shapeActual(slotActual), ...slotResult,
    kpi: kpi ? kpiActualsView(kpi, score, parts.actuals) : null,
    plan: { id: planId, ...scoreSummary(score) },
  };
}

/** The achievement of ONE slot's actual on its own (the grid's chip). */
function slotAchievement(kpiRow, period, actual, bands) {
  if (!kpiRow || !actual) return { achievement: null, band: 'NO_DATA', bandLabel: BAND_WORDS.NO_DATA };
  const k = scoringKpi(kpiRow, period);
  const r = kpiResult(k, [scoringActual(actual)]);
  const band = bandOf(r.achievement, bands);
  return { achievement: r.achievement, band, bandLabel: BAND_WORDS[band] };
}

/* ══════════════════════════════════════════════════════════════════════════
 * Reading
 * ══════════════════════════════════════════════════════════════════════════ */

/** GET …/plans/:id/kpis/:kpiId/actuals — every row of a KPI, corrections included, newest first per slot. Two queries. */
export async function actualHistory(db, companyId, planId, kpiId) {
  const [[k]] = await db.query('SELECT id, name, unit, direction FROM hrms_performance_plan_kpis WHERE company_id = ? AND plan_id = ? AND id = ?', [companyId, planId, kpiId]);
  if (!k) throw notFound('KPI');
  const [rows] = await db.query(
    `SELECT a.*, u.name AS by_name, cu.name AS closed_by_name FROM hrms_performance_actuals a
       LEFT JOIN users u ON u.id = a.entered_by LEFT JOIN users cu ON cu.id = a.closed_by
      WHERE a.company_id = ? AND a.plan_kpi_id = ? ORDER BY a.slot_start, a.entered_at DESC, a.id DESC`, [companyId, kpiId]);
  return {
    kpi: { id: k.id, name: k.name, unit: k.unit ?? null, direction: k.direction },
    rows: rows.map((a) => ({
      ...shapeActual(a), slotStart: iso(a.slot_start), slotEnd: iso(a.slot_end), live: a.closed_at == null,
      replacedAt: a.closed_at ?? null, replacedBy: a.closed_by_name ?? null,
    })),
  };
}

/**
 * The plans an actuals screen covers: of one period (not cancelled) — or the
 * plans of some plan KPIs (an upload: any status, so a plan closed or cancelled
 * since the download is named as such) — narrowed to `employeeIds` (a
 * manager's team) and to the login's departments. One query.
 */
async function gridPlans(db, companyId, { periodId = null, kpiIds = null }, { employeeIds = null, scopeDeptIds = null } = {}) {
  const where = ['pl.company_id = ?'];
  const params = [companyId];
  if (periodId) { where.push('pl.period_id = ?', "pl.status <> 'CANCELLED'"); params.push(periodId); }
  if (kpiIds) {
    where.push('pl.id IN (SELECT k.plan_id FROM hrms_performance_plan_kpis k WHERE k.company_id = ? AND k.id IN (?))');
    params.push(companyId, kpiIds.length ? kpiIds : [0]);
  }
  if (employeeIds) { where.push('pl.employee_id IN (?)'); params.push(employeeIds.length ? employeeIds : [0]); }
  if (scopeDeptIds) { where.push('pl.department_id IN (?)'); params.push(scopeDeptIds.length ? scopeDeptIds : [0]); }
  const [rows] = await db.query(
    `SELECT pl.*, pp.name AS period_name, pp.frequency, pp.start_date, pp.end_date, pp.status AS period_status,
            e.full_name, e.employee_code,
            mp.position_code AS manager_position_code, COALESCE(mp.position_title, mr.title) AS manager_position_title
       FROM hrms_performance_plans pl
       JOIN hrms_performance_periods pp ON pp.company_id = pl.company_id AND pp.id = pl.period_id
       JOIN hrms_employees e ON e.company_id = pl.company_id AND e.id = pl.employee_id
       LEFT JOIN hrms_positions mp ON mp.company_id = pl.company_id AND mp.id = pl.manager_position_id
       LEFT JOIN hrms_roles mr ON mr.company_id = mp.company_id AND mr.id = mp.role_id
      WHERE ${where.join(' AND ')} ORDER BY e.full_name, pl.id`, params);
  return rows;
}

/** Why a slot of a plan cannot take an actual now, or null. */
function lockOf(p, s, on) {
  if (p.status === 'CLOSED' || p.period_status === 'CLOSED') return `${p.period_name} is closed: read only.`;
  if (p.status === 'DRAFT') return 'This plan is still a draft: actuals are entered once it is activated.';
  if (p.status !== 'ACTIVE') return `This plan is ${String(p.status).toLowerCase()}: it takes no actuals.`;
  if (s.start > on) return `${s.name} has not begun.`;
  return null;
}

/**
 * The rows of the Actuals grid (and of the Excel file): one per plan × KPI × slot
 * that `pick(slots)` keeps. In memory, from loaded parts.
 */
function buildRows(plans, parts, pick, settings, canEnter, on = today()) {
  const rows = [];
  for (const p of plans) {
    const kpiRows = parts.kpis.get(Number(p.id)) ?? [];
    const kraName = new Map((parts.kras.get(Number(p.id)) ?? []).map((k) => [Number(k.id), k.name]));
    const pPeriod = periodOfRow(p);
    for (const k of kpiRows) {
      const kSlots = slotsOf(pPeriod, k.entry_frequency);
      for (const s of pick(kSlots, k)) {
        const a = (parts.actuals.get(Number(k.id)) ?? []).find((x) => iso(x.slot_start) === s.start) ?? null;
        const locked = lockOf(p, s, on);
        rows.push({
          key: `${p.id}|${k.id}|${s.start}`,
          planId: Number(p.id), kpiId: Number(k.id), slotStart: s.start, slotEnd: s.end, slotName: s.name, slotIndex: s.index,
          periodId: Number(p.period_id), periodName: p.period_name, planStatus: p.status,
          employeeId: Number(p.employee_id), employeeName: p.full_name, employeeCode: p.employee_code ?? null,
          positionId: p.position_id, positionCode: p.position_code, positionTitle: p.position_title,
          roleId: p.role_id, roleTitle: p.role_title, departmentId: p.department_id, departmentName: p.department_name,
          managerPositionId: p.manager_position_id ?? null,
          kraName: k.plan_kra_id ? kraName.get(Number(k.plan_kra_id)) ?? null : null,
          kpiName: k.name, unit: k.unit ?? null, direction: k.direction,
          targetNumber: num(k.target_number), targetText: k.target_text ?? null,
          target: planTargetText({ direction: k.direction, targetNumber: num(k.target_number), targetText: k.target_text, unit: k.unit }),
          actual: shapeActual(a),
          ...slotAchievement(k, pPeriod, a, settings.bands),
          canEnter: Boolean(canEnter) && !locked,
          locked,
        });
      }
    }
  }
  return rows;
}

/**
 * The rows of some plan KPIs, every slot (an Excel upload names them by id).
 * Five queries. @param opts { employeeIds?, scopeDeptIds? }
 */
export async function rowsForKpis(db, companyId, kpiIds, opts = {}) {
  const want = new Set(kpiIds.map(Number));
  if (!want.size) return [];
  const settings = await readSettings(db, companyId);
  const plans = await gridPlans(db, companyId, { kpiIds: [...want] }, opts);
  const parts = await loadPlanParts(db, companyId, plans.map((p) => p.id));
  return buildRows(plans, parts, (kSlots, k) => (want.has(Number(k.id)) ? kSlots : []), settings, true);
}

/**
 * GET /performance/actuals?periodId=&slot=&department=&label=&role=&manager=&q=&missing=
 * Performance › Actuals: one row per person × KPI for the chosen slot.
 *
 *   slot      a slot's first day (YYYY-MM-DD) — or `all` for every slot open today;
 *             default: the latest slot that has begun (the one most KPIs are entered for)
 *   missing=1 only rows with no actual yet
 *
 * A fixed number of queries: settings, the period, its plans, their KRAs / KPIs /
 * actuals, and — only when those filters are used — the department tree and labels.
 * @param opts { employeeIds?, scopeDeptIds?, canEnter: boolean }
 */
export async function actualsGrid(db, companyId, query = {}, opts = {}) {
  const settings = await readSettings(db, companyId);
  const on = today();
  // The periods on offer: every made period that has plans, newest first, with how many take actuals (one query).
  const [periodRows] = await db.query(
    `SELECT pp.*, (SELECT COUNT(*) FROM hrms_performance_plans pl WHERE pl.company_id = pp.company_id AND pl.period_id = pp.id AND pl.status IN ('ACTIVE', 'CLOSED')) AS taking
       FROM hrms_performance_periods pp
      WHERE pp.company_id = ? AND EXISTS (SELECT 1 FROM hrms_performance_plans pl WHERE pl.company_id = pp.company_id AND pl.period_id = pp.id AND pl.status <> 'CANCELLED')
      ORDER BY pp.start_date DESC, pp.frequency`, [companyId]);
  const periods = periodRows.map((r) => ({
    id: r.id, name: r.name, frequency: r.frequency, start: iso(r.start_date), end: iso(r.end_date), status: r.status,
    plans: Number(r.taking), current: iso(r.start_date) <= on && on <= iso(r.end_date),
  }));
  let pr = query.periodId ? periodRows.find((r) => Number(r.id) === Number(query.periodId)) : null;
  if (query.periodId && !pr) {
    // A period with no plans yet (or not this company's): read it, so another company's is a 404.
    [[pr]] = await db.query('SELECT * FROM hrms_performance_periods WHERE company_id = ? AND id = ?', [companyId, Number(query.periodId)]);
    if (!pr) throw notFound('Period');
  }
  if (!pr) {
    // No period asked for: the one that holds today with the most plans taking actuals; else the latest.
    pr = [...periodRows].sort((a, b) => (Number(periods.find((p) => p.id === b.id).current) - Number(periods.find((p) => p.id === a.id).current))
      || (Number(b.taking) - Number(a.taking)))[0] ?? null;
  }
  const blankAnswer = (period = null, line = 'No plans have been made yet. Make plans on Performance › Plans, and activate them.') => ({
    period, periods, slots: [], slot: null, rows: [], counts: { rows: 0, entered: 0, drafts: 0 }, managers: [], roles: [], bands: settings.bands, bandWords: BAND_WORDS, line,
  });
  if (!pr) return blankAnswer();
  const periodId = Number(pr.id);
  const period = { id: pr.id, name: pr.name, frequency: pr.frequency, start: iso(pr.start_date), end: iso(pr.end_date), status: pr.status };
  const allPlans = await gridPlans(db, companyId, { periodId }, opts);
  const drafts = allPlans.filter((p) => p.status === 'DRAFT').length;
  const plans = allPlans.filter((p) => p.status === 'ACTIVE' || p.status === 'CLOSED');
  const parts = await loadPlanParts(db, companyId, plans.map((p) => p.id));

  // The slots on offer: every slot of every KPI here, once.
  const slotMap = new Map();
  for (const p of plans) {
    for (const k of parts.kpis.get(Number(p.id)) ?? []) {
      for (const s of slotsOf(period, k.entry_frequency)) {
        const key = `${s.start}|${s.end}`;
        if (!slotMap.has(key)) slotMap.set(key, { key, start: s.start, end: s.end, name: s.name, whole: s.whole, open: s.start <= on, kpis: 0 });
        slotMap.get(key).kpis += 1;
      }
    }
  }
  const slots = [...slotMap.values()].sort((a, b) => (a.start === b.start ? (a.end < b.end ? -1 : 1) : (a.start < b.start ? -1 : 1)));
  const wanted = String(query.slot ?? '').trim();
  let chosen = null;
  if (wanted === 'all') chosen = 'all';
  else if (wanted) chosen = slots.find((s) => s.key === wanted || s.start === wanted) ?? null;
  if (!chosen) {
    const open = slots.filter((s) => s.open);
    const latest = open.reduce((m, s) => (!m || s.start > m.start || (s.start === m.start && s.kpis > m.kpis) ? s : m), null);
    chosen = latest ?? slots[0] ?? null;
  }

  const rows = buildRows(plans, parts, (kSlots) => (chosen === 'all' ? kSlots.filter((s) => s.start <= on)
    : kSlots.filter((s) => chosen && s.start === chosen.start && s.end === chosen.end)), settings, opts.canEnter);
  const managers = [...new Map(plans.filter((p) => p.manager_position_id).map((p) => [Number(p.manager_position_id), {
    id: Number(p.manager_position_id), code: p.manager_position_code ?? null, title: p.manager_position_title ?? null,
  }])).values()].sort((a, b) => String(a.code ?? '').localeCompare(String(b.code ?? '')));
  const roles = [...new Map(plans.filter((p) => p.role_id).map((p) => [Number(p.role_id), { id: Number(p.role_id), title: p.role_title }])).values()]
    .sort((a, b) => String(a.title ?? '').localeCompare(String(b.title ?? '')));
  return {
    period,
    periods,
    slots: slots.map(({ kpis, ...s }) => ({ ...s, rows: kpis })),
    slot: chosen === 'all' ? 'all' : chosen?.key ?? null,
    rows,
    counts: { drafts },
    managers, roles,
    bands: settings.bands, bandWords: BAND_WORDS,
    line: !plans.length ? (drafts ? `${drafts} plan${drafts === 1 ? ' is' : 's are'} still a draft. Actuals are entered once a plan is activated.` : `No plans for ${period.name}.`)
      : (drafts ? `${drafts} draft plan${drafts === 1 ? ' is' : 's are'} not shown: actuals are entered once a plan is activated.` : null),
  };
}

/**
 * GET /performance/bands?periodId= — the org chart's "Colour by performance".
 * No period: the plans whose period holds today (a quarterly staff plan and a
 * monthly operator plan side by side). One band per person; people without a
 * plan are not listed. A handful of queries.
 */
export async function chartBands(db, companyId, { periodId = null } = {}, scopeDeptIds = null) {
  const on = today();
  const where = ['pl.company_id = ?', "pl.status IN ('ACTIVE', 'CLOSED')"];
  const params = [companyId];
  if (periodId) { where.push('pl.period_id = ?'); params.push(Number(periodId)); } else { where.push('pp.start_date <= ? AND pp.end_date >= ?'); params.push(on, on); }
  if (scopeDeptIds) { where.push('pl.department_id IN (?)'); params.push(scopeDeptIds.length ? scopeDeptIds : [0]); }
  const [[plans], [periods]] = await Promise.all([
    db.query(
      `SELECT pl.id, pl.status, pl.employee_id, pl.position_id, pp.id AS period_id, pp.name AS period_name, pp.frequency, pp.start_date, pp.end_date, pp.status AS period_status
         FROM hrms_performance_plans pl JOIN hrms_performance_periods pp ON pp.company_id = pl.company_id AND pp.id = pl.period_id
        WHERE ${where.join(' AND ')}`, params),
    db.query(
      `SELECT pp.id, pp.name, pp.frequency, pp.start_date, pp.end_date, pp.status FROM hrms_performance_periods pp
        WHERE pp.company_id = ? AND EXISTS (SELECT 1 FROM hrms_performance_plans pl WHERE pl.company_id = pp.company_id AND pl.period_id = pp.id AND pl.status IN ('ACTIVE', 'CLOSED'))
        ORDER BY pp.start_date DESC, pp.frequency LIMIT 40`, [companyId]),
  ]);
  const scores = await scorePlans(db, companyId, plans);
  return {
    periods: periods.map((p) => ({ id: p.id, name: p.name, frequency: p.frequency, start: iso(p.start_date), end: iso(p.end_date), status: p.status })),
    periodId: periodId ? Number(periodId) : null,
    bandWords: BAND_WORDS,
    people: plans.map((p) => ({
      employeeId: Number(p.employee_id), positionId: p.position_id, planId: Number(p.id), periodName: p.period_name,
      ...scores.get(Number(p.id)),
    })),
  };
}

/**
 * The grid's rows narrowed by the address: every filter but `missing` gives the
 * count line ("312 of 400 entered"); `missing=1` then keeps the empty ones.
 * Shared by the HR grid and the manager login's (routes/performance.js, routes/self.js).
 */
export async function narrowGrid(db, companyId, grid, query) {
  const { missing, ...rest } = query ?? {};
  const shown = await filterRows(db, companyId, grid.rows, rest, LIST_SPECS.actuals);
  const entered = shown.filter((r) => r.actual).length;
  const onlyMissing = ['1', 'true', 'yes'].includes(String(missing ?? '').toLowerCase());
  const rows = onlyMissing ? shown.filter((r) => !r.actual) : shown;
  return { ...grid, rows, total: grid.rows.length, count: rows.length, counts: { ...grid.counts, rows: shown.length, entered } };
}

/** Which plan ids among these are of the given people (a manager's team). */
export async function planIdsOfPeople(db, companyId, employeeIds, planIds) {
  if (!employeeIds.length || !planIds.length) return new Set();
  const [rows] = await db.query('SELECT id FROM hrms_performance_plans WHERE company_id = ? AND id IN (?) AND employee_id IN (?)', [companyId, planIds, employeeIds]);
  return new Set(rows.map((r) => Number(r.id)));
}

export { COMBINE_RULES, COMBINE_WORDS, BAND_WORDS };
export default {
  SOURCES, loadPlanParts, planScoreParts, scorePlans, scoreSummary, kpiActualsView, enterActuals, enterOne, actualHistory, actualsGrid, narrowGrid, chartBands, periodOfRow, planIdsOfPeople,
};
