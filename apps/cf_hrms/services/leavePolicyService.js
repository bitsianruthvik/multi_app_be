/**
 * leavePolicyService.js — leave types, leave policies, and where each policy
 * applies. (TM/CF_HRMS_HIRING_SPEC.md §8.)
 *
 * THIS ROUND IS THE POLICY, NOT THE LEAVE. Nothing here computes a balance,
 * runs an accrual or takes a request. It defines what a company's leave IS and
 * says which definition a position falls under.
 *
 *   leave type   a company-wide name (Casual leave). Quantities do not live on
 *                it any more: hrms_leave_types.annual_entitlement is not read.
 *   policy       a named set of rules, one per leave type it grants. Standalone.
 *   assignment   company default -> location -> label -> role; the most specific
 *                wins (a label: a department label, spec §17).
 *                The resolution is leavePolicyRead.resolveEffective and nothing
 *                here re-derives it.
 *
 * RULES OF THIS FILE
 *   - A policy's rules are saved as a SET, in one transaction: validated whole
 *     first (every problem at once, each naming its leave type), then replaced.
 *     A policy is never half-changed.
 *   - What a rule's basis and accrual make meaningless is CLEARED on save
 *     (leavePolicyRead.applicability) — the editor hides those fields, and a
 *     stale number from a hidden field must not survive to be read later.
 *   - Only an ACTIVE policy can be assigned (422 otherwise), and a policy that
 *     is assigned cannot be archived, put back to draft or deleted (409 IN_USE,
 *     saying where it is used). So an assignment always points at an ACTIVE
 *     policy, and no read has to ask.
 *   - Everything is audited, in the caller's transaction.
 */
import { leavePolicyGate } from './complianceChecks/wire.js';
import { invalid, notFound, conflict, assertNoProblems } from '../lib/errors.js';
import { audit } from './peopleService.js';
import {
  BASES, ACCRUALS, CARRY_FORWARDS, APPLIES_TO, POLICY_STATUSES, SCOPES, RULE_DEFAULTS,
  applicability, summaryOf, shapeRule, headlineOf, refOf, loadAssignmentIndex, resolveEffective, rulesOfPolicies, leaveTypeNames,
} from './leavePolicyRead.js';
import { TEMPLATE_NOTE, LEAVE_TYPES_OFFERED, TEMPLATES } from './leavePolicyTemplates.js';
import { isDate } from './leave/days.js';

const has = (o, k) => Object.prototype.hasOwnProperty.call(o ?? {}, k);
const clean = (v) => (v === null || v === undefined ? null : (String(v).trim() || null));
const flag = (v) => v === true || v === 1 || v === '1' || v === 'true';
const CODE_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
/** A policy code may also carry slashes, as a numbered document does: KPPL/HR/POL/004. */
const POLICY_CODE_RE = /^[A-Za-z0-9][A-Za-z0-9_./-]*$/;
const pad2 = (n) => String(n).padStart(2, '0');
/** A DATE as text, whether the driver hands back a string or a local-midnight Date. */
const dateOnly = (d) => (d == null || d === '' ? null : d instanceof Date ? `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` : String(d).slice(0, 10));
/** The most steps a "notice by length" may have. */
const MAX_NOTICE_TIERS = 10;
const UNITS = ['DAY', 'HALF_DAY', 'HOUR'];
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/* ══════════════════════════════════════════════════════════════════════════
 * Leave types
 * ══════════════════════════════════════════════════════════════════════════ */

const shapeType = (r) => ({
  id: r.id, code: r.code, name: r.name, unit: r.unit, isPaid: Boolean(r.is_paid), status: r.status,
  // How many policies grant it — why it cannot be deleted.
  policyCount: Number(r.policy_count ?? 0),
});

const TYPE_SELECT = `
  SELECT t.id, t.code, t.name, t.unit, t.is_paid, t.status,
         (SELECT COUNT(*) FROM hrms_leave_policy_rules r
            JOIN hrms_leave_policies p ON p.company_id = r.company_id AND p.id = r.policy_id AND p.deleted_at IS NULL
           WHERE r.company_id = t.company_id AND r.leave_type_id = t.id AND r.deleted_at IS NULL) AS policy_count
    FROM hrms_leave_types t`;

export async function listLeaveTypes(db, companyId) {
  const [rows] = await db.query(`${TYPE_SELECT} WHERE t.company_id = ? AND t.deleted_at IS NULL ORDER BY t.status, t.name, t.id`, [companyId]);
  return { types: rows.map(shapeType) };
}

async function loadType(db, companyId, id) {
  const [[row]] = await db.query(`${TYPE_SELECT} WHERE t.company_id = ? AND t.id = ? AND t.deleted_at IS NULL`, [companyId, id]);
  if (!row) throw notFound('That leave type');
  return row;
}

function typeFields(body, problems, { partial = false } = {}) {
  const out = {};
  if (!partial || has(body, 'code')) {
    const code = clean(body.code);
    if (!code || !CODE_RE.test(code) || code.length > 50) problems.push('A leave type needs a short code: letters and digits, no spaces (CL, SL).');
    out.code = code;
  }
  if (!partial || has(body, 'name')) {
    const name = clean(body.name);
    if (!name || name.length > 100) problems.push('A leave type needs a name, up to 100 characters.');
    out.name = name;
  }
  if (has(body, 'unit')) {
    const unit = String(body.unit ?? '').trim().toUpperCase();
    if (!UNITS.includes(unit)) problems.push('A leave type is counted in days, half days or hours.');
    out.unit = unit;
  }
  if (has(body, 'isPaid')) out.is_paid = flag(body.isPaid) ? 1 : 0;
  if (has(body, 'status')) {
    const status = String(body.status ?? '').trim().toUpperCase();
    if (!['ACTIVE', 'INACTIVE'].includes(status)) problems.push('A leave type is active or inactive.');
    out.status = status;
  }
  return out;
}

async function assertTypeCodeFree(db, companyId, code, exceptId = null) {
  const [[clash]] = await db.query(
    'SELECT id, name FROM hrms_leave_types WHERE company_id = ? AND deleted_at IS NULL AND LOWER(code) = LOWER(?) AND id <> ?', [companyId, code, exceptId ?? 0]);
  if (clash) throw conflict('DUPLICATE', `The code ${code} is already used by ${clash.name}.`, { existing: { id: clash.id, name: clash.name } });
}

export async function createLeaveType(conn, c, body = {}, requestId = null) {
  const problems = [];
  const f = typeFields(body, problems);
  assertNoProblems(problems, 'This leave type cannot be saved yet.');
  await assertTypeCodeFree(conn, c.companyId, f.code);
  const [ins] = await conn.query(
    'INSERT INTO hrms_leave_types (company_id, code, name, unit, is_paid, status, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [c.companyId, f.code, f.name, f.unit ?? 'DAY', f.is_paid ?? 1, f.status ?? 'ACTIVE', c.userId],
  );
  await audit(conn, c, 'hrms_leave_types', ins.insertId, 'CREATE', null, f, requestId);
  return { type: shapeType(await loadType(conn, c.companyId, ins.insertId)) };
}

export async function updateLeaveType(conn, c, id, body = {}, requestId = null) {
  const before = await loadType(conn, c.companyId, id);
  const problems = [];
  const f = typeFields(body, problems, { partial: true });
  assertNoProblems(problems, 'This leave type cannot be saved yet.');
  if (f.code !== undefined) await assertTypeCodeFree(conn, c.companyId, f.code, id);
  const cols = Object.keys(f);
  if (cols.length) await conn.query(`UPDATE hrms_leave_types SET ${cols.map((k) => `${k} = ?`).join(', ')} WHERE company_id = ? AND id = ?`, [...cols.map((k) => f[k]), c.companyId, id]);
  await audit(conn, c, 'hrms_leave_types', id, 'UPDATE', { code: before.code, name: before.name, status: before.status }, f, requestId);
  return { type: shapeType(await loadType(conn, c.companyId, id)) };
}

/** 409 IN_USE while a policy grants it (or a balance or a request is recorded against it). */
export async function deleteLeaveType(conn, c, id, requestId = null) {
  const before = await loadType(conn, c.companyId, id);
  const [policies] = await conn.query(
    `SELECT DISTINCT p.id, p.name FROM hrms_leave_policy_rules r
       JOIN hrms_leave_policies p ON p.company_id = r.company_id AND p.id = r.policy_id AND p.deleted_at IS NULL
      WHERE r.company_id = ? AND r.leave_type_id = ? AND r.deleted_at IS NULL ORDER BY p.name`, [c.companyId, id]);
  if (policies.length) {
    throw conflict('IN_USE', `${before.name} is part of ${plural(policies.length, 'leave policy', 'leave policies')}: ${policies.map((p) => p.name).join(', ')}. Take it out of ${policies.length === 1 ? 'that policy' : 'those policies'} first.`, {
      problems: policies.map((p) => `The policy ${p.name} grants ${before.name}.`), detail: { policyIds: policies.map((p) => p.id) },
    });
  }
  const [[used]] = await conn.query(
    `SELECT (SELECT COUNT(*) FROM hrms_leave_balances WHERE company_id = ? AND leave_type_id = ? AND deleted_at IS NULL)
          + (SELECT COUNT(*) FROM hrms_leave_requests WHERE company_id = ? AND leave_type_id = ? AND deleted_at IS NULL) AS n`, [c.companyId, id, c.companyId, id]);
  if (Number(used.n) > 0) throw conflict('IN_USE', `${before.name} has leave recorded against it. Set it inactive instead of deleting it.`);
  await conn.query('UPDATE hrms_leave_types SET deleted_at = NOW() WHERE company_id = ? AND id = ?', [c.companyId, id]);
  await audit(conn, c, 'hrms_leave_types', id, 'DELETE', { code: before.code, name: before.name }, null, requestId);
  return { ok: true, id: Number(id) };
}

/* ══════════════════════════════════════════════════════════════════════════
 * A rule, read from a body and checked
 * ══════════════════════════════════════════════════════════════════════════ */

/** A number field: null when blank; a problem (and null) when not a number in range. */
function number(raw, label, problems, { min = 0, max = 100000, whole = false, exclusiveMin = false } = {}) {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || (whole && !Number.isInteger(n)) || n < min || (exclusiveMin && n <= min) || n > max) {
    problems.push(`${label} must be ${whole ? 'a whole number' : 'a number'}${exclusiveMin ? ' above' : ' from'} ${min}${exclusiveMin ? '' : ` to ${max}`}.`);
    return null;
  }
  return Math.round(n * 100) / 100;
}

/**
 * One rule of a body -> a clean rule, with what does not apply cleared. Every
 * problem is pushed as "<leave type>: <what is wrong>". Pure: no database.
 *
 * @param input a RuleInput (camelCase)
 * @param typeName the leave type's name, for the problems
 * @param leaveTypeId the rule's own leave type, when known — it cannot be "not with" itself
 * @param typeNames Map<id, name> of the company's leave types, when known — "not with" must name them
 */
export function readRule(input, typeName, problems, { leaveTypeId = null, typeNames = null } = {}) {
  const mine = [];
  const say = (text) => mine.push(`${typeName}: ${text}`);
  const pick = (key) => (has(input, key) ? input[key] : RULE_DEFAULTS[key]);
  const upper = (key) => String(pick(key) ?? '').trim().toUpperCase();
  const local = [];
  const n = (key, label, opts) => number(pick(key), label, local, opts);

  const r = { ...RULE_DEFAULTS };
  r.basis = upper('basis');
  r.accrual = upper('accrual');
  r.carryForward = upper('carryForward') || 'NONE';
  r.appliesTo = upper('appliesTo') || 'ANYONE';
  if (!BASES.includes(r.basis)) { say('choose whether it is so many days a year, so many days each time, or unpaid without a limit.'); r.basis = 'PER_YEAR'; }
  if (r.basis === 'UNLIMITED_UNPAID' || r.basis === 'PER_EVENT') {
    // Leave given when something happens is not earned over the year, whatever the hidden field still holds.
    r.accrual = 'ON_REQUEST';
  } else if (!ACCRUALS.includes(r.accrual)) { say('choose how it is earned.'); r.accrual = 'UPFRONT'; }
  if (!CARRY_FORWARDS.includes(r.carryForward)) { say('choose what happens to unused days.'); r.carryForward = 'NONE'; }
  if (!APPLIES_TO.includes(r.appliesTo)) { say('choose who it is for: anyone, women or men.'); r.appliesTo = 'ANYONE'; }

  r.days = n('days', 'the number of days', { min: 0, max: 366, exclusiveMin: true });
  r.daysWorkedPerLeaveDay = n('daysWorkedPerLeaveDay', 'the days worked for each day of leave', { min: 1, max: 366, whole: true });
  r.waitDaysAfterJoining = n('waitDaysAfterJoining', 'the waiting days after joining', { min: 0, max: 3650, whole: true }) ?? 0;
  r.carryForwardCapDays = n('carryForwardCapDays', 'the days that carry forward', { min: 0, max: 1000, exclusiveMin: true });
  r.encashCapDays = n('encashCapDays', 'the days that can be paid out', { min: 0, max: 1000, exclusiveMin: true });
  r.maxDaysAtOnce = n('maxDaysAtOnce', 'the longest stretch', { min: 0, max: 366, exclusiveMin: true });
  r.minNoticeDays = n('minNoticeDays', 'the notice', { min: 0, max: 365, whole: true }) ?? 0;
  r.proofAfterDays = n('proofAfterDays', 'the days after which proof is needed', { min: 0, max: 366 });
  r.maxTimesInService = n('maxTimesInService', 'the number of times in service', { min: 1, max: 100, whole: true });
  r.expiresAfterDays = n('expiresAfterDays', 'the days it must be used within', { min: 1, max: 3650, whole: true });
  r.minPresentDaysForCredit = n('minPresentDaysForCredit', 'the present days a month needs to be credited', { min: 1, max: 31, whole: true });
  r.joiningCutoffDay = n('joiningCutoffDay', 'the day of the month after which a joining month does not count', { min: 1, max: 30, whole: true });

  // ── the notice by length (§23.1): steps from the shortest leave to the longest, the last open ──
  const rawTiers = pick('noticeTiers');
  r.noticeTiers = null;
  if (rawTiers !== null && rawTiers !== undefined && !(Array.isArray(rawTiers) && rawTiers.length === 0)) {
    if (!Array.isArray(rawTiers)) local.push('the notice by length is a list of steps.');
    else if (rawTiers.length > MAX_NOTICE_TIERS) local.push(`the notice by length has at most ${MAX_NOTICE_TIERS} steps.`);
    else {
      const steps = rawTiers.map((t, i) => {
        const at = `step ${i + 1} of the notice by length`;
        const last = i === rawTiers.length - 1;
        const upToDays = number(t?.upToDays, `the "up to" days of ${at}`, local, { min: 0, max: 366, exclusiveMin: true });
        const ahead = number(t?.days, `the days ahead of ${at}`, local, { min: 0, max: 365, whole: true });
        if (ahead === null && (t?.days === null || t?.days === undefined || t?.days === '')) local.push(`${at} needs the days ahead.`);
        if (!last && upToDays === null && (t?.upToDays === null || t?.upToDays === undefined || t?.upToDays === '')) local.push(`${at} needs the length it is for ("up to" days). Only the last step is for anything longer.`);
        return { upToDays: last && (t?.upToDays === null || t?.upToDays === undefined || t?.upToDays === '') ? null : upToDays, days: ahead ?? 0 };
      });
      const last = steps[steps.length - 1];
      if (last.upToDays !== null) local.push('the last step of the notice by length is for anything longer — leave its "up to" empty.');
      for (let i = 1; i < steps.length; i += 1) {
        const a = steps[i - 1].upToDays;
        const b = steps[i].upToDays;
        if (a !== null && b !== null && b <= a) { local.push('the steps of the notice by length go from the shortest leave to the longest.'); break; }
      }
      r.noticeTiers = steps;
    }
  }

  // ── leave types it cannot be next to (§23.1) ──
  const rawNotWith = pick('notWithLeaveTypeIds');
  r.notWithLeaveTypeIds = [];
  if (rawNotWith !== null && rawNotWith !== undefined) {
    if (!Array.isArray(rawNotWith)) local.push('the leave types it cannot be next to come as a list.');
    else {
      const ids = [...new Set(rawNotWith.map(Number))];
      if (ids.some((x) => !Number.isInteger(x) || x <= 0)) local.push('a leave type it cannot be next to is not a leave type.');
      else {
        if (leaveTypeId !== null && ids.includes(Number(leaveTypeId))) local.push('it cannot be "not next to" itself.');
        if (typeNames && ids.some((x) => !typeNames.has(x))) local.push('a leave type it cannot be next to is not one of this company’s leave types.');
        r.notWithLeaveTypeIds = ids.filter((x) => x !== Number(leaveTypeId) && (!typeNames || typeNames.has(x))).sort((a, b) => a - b);
      }
    }
  }
  for (const p of local) say(p);

  r.prorateOnJoining = flag(pick('prorateOnJoining'));
  r.allowedInProbation = has(input, 'allowedInProbation') ? flag(input.allowedInProbation) : true;
  r.encashable = flag(pick('encashable'));
  r.halfDayAllowed = flag(pick('halfDayAllowed'));
  r.countDaysOffBetween = flag(pick('countDaysOffBetween'));
  r.negativeBalanceAllowed = flag(pick('negativeBalanceAllowed'));
  r.creditInArrears = flag(pick('creditInArrears'));
  r.notes = clean(pick('notes'));
  if (r.notes && r.notes.length > 500) say('the note is up to 500 characters.');

  // ── what the combination needs ──
  if (r.basis === 'PER_EVENT' && r.days === null && !local.length) say('say how many days it is each time.');
  if (r.basis === 'PER_YEAR') {
    if (['UPFRONT', 'MONTHLY', 'ON_REQUEST', 'HALF_YEARLY'].includes(r.accrual) && r.days === null && !local.length) say('say how many days a year.');
    if (r.accrual === 'PER_DAYS_WORKED' && r.daysWorkedPerLeaveDay === null && !local.length) say('say how many days worked earn one day of leave.');
  }

  // ── what the combination makes meaningless is cleared, not refused ──
  const a = applicability(r);
  if (!a.days) r.days = null;
  if (!a.daysWorkedPerLeaveDay) r.daysWorkedPerLeaveDay = null;
  if (!a.prorateOnJoining) r.prorateOnJoining = false;
  if (!a.carryForward) r.carryForward = 'NONE';
  if (r.carryForward !== 'CAPPED') r.carryForwardCapDays = null;
  if (!a.encashable) r.encashable = false;
  if (!r.encashable) r.encashCapDays = null;
  if (!a.expiresAfterDays) r.expiresAfterDays = null;
  if (!a.maxTimesInService) r.maxTimesInService = null;
  if (!a.negativeBalanceAllowed) r.negativeBalanceAllowed = false;
  if (!a.halfDayAllowed) r.halfDayAllowed = false;
  // The joining cut-off means something to a MONTHLY rule, or to one that prorates on joining.
  if (!a.joiningCutoffDay || (r.accrual !== 'MONTHLY' && !r.prorateOnJoining)) r.joiningCutoffDay = null;
  if (!a.creditInArrears) r.creditInArrears = false;
  if (!a.minPresentDaysForCredit) r.minPresentDaysForCredit = null;
  // The notice by length replaces the one notice.
  if (r.noticeTiers) r.minNoticeDays = 0;

  // ── what remains must hang together ──
  if (r.carryForward === 'CAPPED' && r.carryForwardCapDays === null && !local.length) say('say how many unused days carry forward, or choose that they lapse.');
  if (r.days !== null && r.maxDaysAtOnce !== null && r.maxDaysAtOnce > r.days) say(`the longest stretch (${r.maxDaysAtOnce} days) is more than the ${r.days} days it gives${r.basis === 'PER_YEAR' ? ' in a year' : ''}.`);
  if (r.days !== null && r.proofAfterDays !== null && r.proofAfterDays >= r.days && r.proofAfterDays > 0) say(`proof is asked for beyond ${r.proofAfterDays} days, which is all ${r.days} days of it — it would never be asked for.`);

  problems.push(...mine);
  return r;
}

const RULE_COLUMNS = {
  basis: 'basis', days: 'days', accrual: 'accrual', daysWorkedPerLeaveDay: 'days_worked_per_leave_day',
  prorateOnJoining: 'prorate_on_joining', allowedInProbation: 'allowed_in_probation', waitDaysAfterJoining: 'wait_days_after_joining',
  carryForward: 'carry_forward', carryForwardCapDays: 'carry_forward_cap_days', encashable: 'encashable', encashCapDays: 'encash_cap_days',
  maxDaysAtOnce: 'max_days_at_once', minNoticeDays: 'min_notice_days', halfDayAllowed: 'half_day_allowed',
  countDaysOffBetween: 'count_days_off_between', proofAfterDays: 'proof_after_days', appliesTo: 'applies_to',
  maxTimesInService: 'max_times_in_service', expiresAfterDays: 'expires_after_days', negativeBalanceAllowed: 'negative_balance_allowed', notes: 'notes',
  joiningCutoffDay: 'joining_cutoff_day', creditInArrears: 'credit_in_arrears', noticeTiers: 'notice_tiers_json', notWithLeaveTypeIds: 'not_with_json',
  minPresentDaysForCredit: 'min_present_days_for_credit',
};

/** A rule value as its column stores it: a flag as 1/0, a list as JSON (an empty list as NULL). */
const columnValue = (v) => {
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (Array.isArray(v)) return v.length ? JSON.stringify(v) : null;
  if (v !== null && typeof v === 'object') return JSON.stringify(v);
  return v ?? null;
};

/**
 * A body's `rules` -> clean rules, checked as a set against the company's leave
 * types. Throws 422 INVALID with every problem; writes nothing.
 */
async function readRuleSet(conn, companyId, rules) {
  const problems = [];
  if (!Array.isArray(rules)) throw invalid('INVALID', 'The leave types of a policy come as a list.', { problems: ['The leave types of a policy come as a list.'] });
  const [types] = await conn.query('SELECT id, code, name FROM hrms_leave_types WHERE company_id = ? AND deleted_at IS NULL', [companyId]);
  const typeOf = new Map(types.map((t) => [t.id, t]));
  const typeNames = new Map(types.map((t) => [t.id, t.name]));
  const seen = new Set();
  const out = [];
  rules.forEach((input, i) => {
    const type = typeOf.get(Number(input?.leaveTypeId));
    if (!type) { problems.push(`Leave type ${i + 1} of the list is not one of this company’s leave types.`); return; }
    if (seen.has(type.id)) { problems.push(`${type.name} is in the policy twice. A policy has one set of rules for each leave type.`); return; }
    seen.add(type.id);
    const rule = readRule(input ?? {}, type.name, problems, { leaveTypeId: type.id, typeNames });
    const order = Number(input.sortOrder);
    out.push({ ...rule, leaveTypeId: type.id, sortOrder: Number.isInteger(order) ? order : i + 1 });
  });
  assertNoProblems(problems, 'This policy cannot be saved yet.');
  return out;
}

/** Replaces a policy's whole rule set. The caller's transaction makes it one act. */
async function writeRuleSet(conn, c, policyId, rules) {
  await conn.query('DELETE FROM hrms_leave_policy_rules WHERE company_id = ? AND policy_id = ?', [c.companyId, policyId]);
  const keys = Object.keys(RULE_COLUMNS);
  for (const r of rules) {
    await conn.query(
      `INSERT INTO hrms_leave_policy_rules (company_id, policy_id, leave_type_id, sort_order, ${keys.map((k) => RULE_COLUMNS[k]).join(', ')}, created_by)
       VALUES (?, ?, ?, ?, ${keys.map(() => '?').join(', ')}, ?)`,
      [c.companyId, policyId, r.leaveTypeId, r.sortOrder, ...keys.map((k) => columnValue(r[k])), c.userId],
    );
  }
}

/** POST /leave/policies/preview-summary { rule } -> { summary, problems } — the sentence as the editor types. Writes nothing. */
export async function previewRuleSummary(db, companyId, body = {}) {
  const input = body.rule ?? {};
  let type = { code: clean(input.leaveTypeCode) ?? '', name: clean(input.leaveTypeName) ?? 'This leave type' };
  const [names, [[row]]] = await Promise.all([
    leaveTypeNames(db, companyId),
    input.leaveTypeId != null
      ? db.query('SELECT code, name FROM hrms_leave_types WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [companyId, Number(input.leaveTypeId)])
      : [[null]],
  ]);
  if (row) type = row;
  const problems = [];
  const rule = readRule(input, type.name, problems, { leaveTypeId: input.leaveTypeId != null ? Number(input.leaveTypeId) : null, typeNames: names });
  return { summary: summaryOf(rule, type, { typeNames: names }), problems };
}

/* ══════════════════════════════════════════════════════════════════════════
 * Policies
 * ══════════════════════════════════════════════════════════════════════════ */

/** Live positions of the company with what the resolution needs of each: one query. */
async function livePositions(db, companyId) {
  const [rows] = await db.query(
    `SELECT p.id, p.role_id, p.location_id, p.department_id
       FROM hrms_positions p
      WHERE p.company_id = ? AND p.deleted_at IS NULL AND p.status <> 'CLOSED'`, [companyId]);
  return rows;
}

/** What the resolution needs of a position row. */
const targetOf = (p) => ({ roleId: p.role_id, locationId: p.location_id, departmentId: p.department_id });

/** For every policy: is it the company default, how many locations, labels and roles name it, how many positions end up under it. */
function usageOf(index, positions) {
  const blank = () => ({ company: false, locations: 0, roles: 0, labels: 0, positions: 0 });
  const by = new Map();
  const of = (id) => { if (!by.has(id)) by.set(id, blank()); return by.get(id); };
  if (index.company) of(index.company.id).company = true;
  for (const ref of index.byLocation.values()) of(ref.id).locations += 1;
  for (const ref of index.byRole.values()) of(ref.id).roles += 1;
  for (const l of index.byLabel.values()) of(l.policy.id).labels += 1;
  let unassigned = 0;
  for (const p of positions) {
    const effective = resolveEffective(index, targetOf(p));
    if (effective.policy) of(effective.policy.id).positions += 1; else unassigned += 1;
  }
  return { usedBy: (id) => by.get(id) ?? blank(), unassigned };
}

function shapeSummary(p, rules, usedBy) {
  return {
    id: p.id,
    code: p.code ?? null,
    name: p.name,
    description: p.description ?? null,
    status: p.status,
    yearStartsMonth: Number(p.year_starts_month),
    /** §23.1: nothing is earned before this date; null = from the start. */
    effectiveFrom: dateOnly(p.effective_from),
    leaveTypes: rules.map((r) => ({ code: r.leaveTypeCode, name: r.leaveTypeName, days: r.days, basis: r.basis })),
    headline: headlineOf(rules),
    usedBy,
  };
}

/** GET /leave/policies -> { policies: PolicySummary[] } — four reads, whatever the number of policies. */
export async function listPolicies(db, companyId) {
  const [[rows], index, positions] = await Promise.all([
    db.query('SELECT * FROM hrms_leave_policies WHERE company_id = ? AND deleted_at IS NULL ORDER BY FIELD(status, \'ACTIVE\', \'DRAFT\', \'ARCHIVED\'), name, id', [companyId]),
    loadAssignmentIndex(db, companyId),
    livePositions(db, companyId),
  ]);
  const rules = await rulesOfPolicies(db, companyId, rows.map((r) => r.id));
  const usage = usageOf(index, positions);
  return { policies: rows.map((p) => shapeSummary(p, rules.get(p.id) ?? [], usage.usedBy(p.id))) };
}

async function loadPolicyRow(db, companyId, id, { lock = false } = {}) {
  const [[row]] = await db.query(`SELECT * FROM hrms_leave_policies WHERE company_id = ? AND id = ? AND deleted_at IS NULL${lock ? ' FOR UPDATE' : ''}`, [companyId, id]);
  if (!row) throw notFound('That leave policy');
  return row;
}

/** GET /leave/policies/:id -> { policy: Policy } */
export async function getPolicy(db, companyId, id) {
  const row = await loadPolicyRow(db, companyId, id);
  const [index, positions, rules] = await Promise.all([loadAssignmentIndex(db, companyId), livePositions(db, companyId), rulesOfPolicies(db, companyId, [row.id])]);
  const mine = rules.get(row.id) ?? [];
  return { policy: { ...shapeSummary(row, mine, usageOf(index, positions).usedBy(row.id)), rules: mine } };
}

function policyFields(body, problems, { partial = false } = {}) {
  const out = {};
  if (!partial || has(body, 'name')) {
    const name = clean(body.name);
    if (!name || name.length > 150) problems.push('A leave policy needs a name, up to 150 characters.');
    out.name = name;
  }
  if (has(body, 'code')) {
    const code = clean(body.code);
    if (code && (!POLICY_CODE_RE.test(code) || code.length > 50)) problems.push('A policy code is letters and digits (and - _ . /), no spaces.');
    out.code = code;
  }
  if (has(body, 'effectiveFrom')) {
    const raw = body.effectiveFrom === null || body.effectiveFrom === undefined ? '' : String(body.effectiveFrom).trim();
    if (raw === '') out.effective_from = null;
    else if (!isDate(raw) || raw < '2000-01-01' || raw > '2100-12-31') problems.push('The date the policy takes effect must be a date, like 2026-10-01.');
    else out.effective_from = raw;
  }
  if (has(body, 'description')) {
    const description = clean(body.description);
    if (description && description.length > 1000) problems.push('The description is up to 1000 characters.');
    out.description = description;
  }
  if (has(body, 'yearStartsMonth')) {
    const m = Number(body.yearStartsMonth);
    if (!Number.isInteger(m) || m < 1 || m > 12) problems.push('The leave year starts in a month from 1 (January) to 12.');
    out.year_starts_month = m;
  }
  if (has(body, 'status')) {
    const status = String(body.status ?? '').trim().toUpperCase();
    if (!POLICY_STATUSES.includes(status)) problems.push('A policy is a draft, active or archived.');
    out.status = status;
  }
  return out;
}

async function assertPolicyNameFree(conn, companyId, { name, code }, exceptId = null) {
  if (name) {
    const [[clash]] = await conn.query('SELECT id FROM hrms_leave_policies WHERE company_id = ? AND deleted_at IS NULL AND LOWER(name) = LOWER(?) AND id <> ?', [companyId, name, exceptId ?? 0]);
    if (clash) throw conflict('DUPLICATE', `A leave policy named "${name}" already exists.`, { existing: { id: clash.id } });
  }
  if (code) {
    const [[clash]] = await conn.query('SELECT id, name FROM hrms_leave_policies WHERE company_id = ? AND deleted_at IS NULL AND LOWER(code) = LOWER(?) AND id <> ?', [companyId, code, exceptId ?? 0]);
    if (clash) throw conflict('DUPLICATE', `The code ${code} is already used by the policy ${clash.name}.`, { existing: { id: clash.id } });
  }
}

/** Where a policy is assigned, in sentences. Empty when nowhere. */
async function whereUsed(conn, companyId, policyId) {
  const [rows] = await conn.query(
    `SELECT a.scope, l.name AS location_name, r.title AS role_title, dl.name AS label_name
       FROM hrms_leave_policy_assignments a
       LEFT JOIN hrms_locations l ON l.company_id = a.company_id AND l.id = a.location_id
       LEFT JOIN hrms_roles r ON r.company_id = a.company_id AND r.id = a.role_id
       LEFT JOIN hrms_department_labels dl ON dl.company_id = a.company_id AND dl.id = a.label_id
      WHERE a.company_id = ? AND a.policy_id = ? AND a.deleted_at IS NULL
      ORDER BY FIELD(a.scope, 'COMPANY', 'LOCATION', 'LABEL', 'ROLE'), l.name, dl.name, r.title`,
    [companyId, policyId],
  );
  return rows.map((a) => (a.scope === 'COMPANY' ? 'It is the company default.'
    : a.scope === 'LOCATION' ? `The location ${a.location_name ?? ''} uses it.`
      : a.scope === 'LABEL' ? `The label ${a.label_name ?? ''} uses it.`
        : `The role ${a.role_title ?? ''} uses it.`));
}

/** The leave types a template needs, by code -> id; the ones the company lacks are created. */
async function ensureLeaveTypes(conn, c, codes, requestId) {
  const [rows] = await conn.query('SELECT id, code FROM hrms_leave_types WHERE company_id = ? AND deleted_at IS NULL', [c.companyId]);
  const idOf = new Map(rows.map((t) => [String(t.code).toUpperCase(), t.id]));
  const created = [];
  for (const code of codes) {
    if (idOf.has(code)) continue;
    const offered = LEAVE_TYPES_OFFERED.find((t) => t.code === code);
    if (!offered) throw invalid('INVALID', `The template names a leave type (${code}) this application does not offer.`);
    const [ins] = await conn.query(
      "INSERT INTO hrms_leave_types (company_id, code, name, unit, is_paid, status, created_by) VALUES (?, ?, ?, 'DAY', ?, 'ACTIVE', ?)",
      [c.companyId, offered.code, offered.name, offered.isPaid ? 1 : 0, c.userId],
    );
    idOf.set(code, ins.insertId);
    created.push(offered.code);
    await audit(conn, c, 'hrms_leave_types', ins.insertId, 'CREATE', null, { code: offered.code, name: offered.name, reason: 'needed by a policy template' }, requestId);
  }
  return { idOf, created };
}

/**
 * POST /leave/policies { name, code?, description?, yearStartsMonth?, status?, fromTemplate?, copyOf? } -> { policy }
 * Starts as a DRAFT unless a status is sent. From a template: its rules, with
 * the leave types the company lacks created. From `copyOf`: that policy's rules.
 */
export async function createPolicy(conn, c, body = {}, requestId = null) {
  const problems = [];
  const f = policyFields(body, problems);
  const templateKey = clean(body.fromTemplate)?.toUpperCase() ?? null;
  const copyOf = body.copyOf === undefined || body.copyOf === null || body.copyOf === '' ? null : Number(body.copyOf);
  const template = templateKey ? TEMPLATES.find((t) => t.key === templateKey) : null;
  if (templateKey && !template) problems.push('That starting point does not exist. Pick one from the list.');
  if (templateKey && copyOf !== null) problems.push('Start from a template or copy a policy — not both.');
  if (copyOf !== null && (!Number.isInteger(copyOf) || copyOf <= 0)) problems.push('The policy to copy is not a policy.');
  assertNoProblems(problems, 'This policy cannot be created yet.');
  await assertPolicyNameFree(conn, c.companyId, f);

  let rules = [];
  let yearStartsMonth = f.year_starts_month ?? 1;
  if (template) {
    const { idOf } = await ensureLeaveTypes(conn, c, [...new Set(template.rules.map((r) => r.type))], requestId);
    const ruleProblems = [];
    rules = template.rules.map(({ type, ...rest }, i) => ({
      ...readRule(rest, LEAVE_TYPES_OFFERED.find((t) => t.code === type)?.name ?? type, ruleProblems), leaveTypeId: idOf.get(type), sortOrder: i + 1,
    }));
    if (ruleProblems.length) throw new Error(`The template ${template.key} is not valid: ${ruleProblems.join(' ')}`);
  } else if (copyOf !== null) {
    const source = await loadPolicyRow(conn, c.companyId, copyOf);
    if (f.year_starts_month === undefined) yearStartsMonth = Number(source.year_starts_month);
    rules = (await rulesOfPolicies(conn, c.companyId, [source.id])).get(source.id) ?? [];
  }

  const [ins] = await conn.query(
    'INSERT INTO hrms_leave_policies (company_id, code, name, description, year_starts_month, effective_from, status, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [c.companyId, f.code ?? null, f.name, f.description ?? (template && template.key !== 'BLANK' ? template.description : null), yearStartsMonth, f.effective_from ?? null, f.status ?? 'DRAFT', c.userId],
  );
  await writeRuleSet(conn, c, ins.insertId, rules);
  await audit(conn, c, 'hrms_leave_policies', ins.insertId, 'CREATE', null,
    { name: f.name, code: f.code ?? null, status: f.status ?? 'DRAFT', effectiveFrom: f.effective_from ?? null, fromTemplate: template?.key ?? null, copyOf, leaveTypes: rules.length }, requestId);
  // Spec §36.2: an ACTIVE policy below the legal annual-leave minimum is refused (the transaction rolls back).
  const compliance = await leavePolicyGate(conn, c, ins.insertId);
  return { ...(await getPolicy(conn, c.companyId, ins.insertId)), compliance };
}

/**
 * PUT /leave/policies/:id { name?, description?, yearStartsMonth?, status?, rules? } -> { policy }
 * `rules`, when sent, REPLACES the policy's rule set. 422 INVALID with every
 * problem; 409 IN_USE when an assigned policy is archived or put back to draft.
 */
export async function updatePolicy(conn, c, id, body = {}, requestId = null) {
  const before = await loadPolicyRow(conn, c.companyId, id, { lock: true });
  const problems = [];
  const f = policyFields(body, problems, { partial: true });
  assertNoProblems(problems, 'This policy cannot be saved yet.');
  const rules = has(body, 'rules') ? await readRuleSet(conn, c.companyId, body.rules) : null;
  await assertPolicyNameFree(conn, c.companyId, f, id);

  if (f.status !== undefined && f.status !== 'ACTIVE' && f.status !== before.status) {
    const used = await whereUsed(conn, c.companyId, id);
    if (used.length) {
      throw conflict('IN_USE', `${before.name} is in use, so it cannot be ${f.status === 'ARCHIVED' ? 'archived' : 'put back to draft'}. Choose another policy where it applies first.`, { problems: used });
    }
  }
  const cols = Object.keys(f);
  if (cols.length) await conn.query(`UPDATE hrms_leave_policies SET ${cols.map((k) => `${k} = ?`).join(', ')} WHERE company_id = ? AND id = ?`, [...cols.map((k) => f[k]), c.companyId, id]);
  if (rules) await writeRuleSet(conn, c, id, rules);
  await audit(conn, c, 'hrms_leave_policies', id, 'UPDATE', { name: before.name, status: before.status, effectiveFrom: dateOnly(before.effective_from) },
    { ...f, ...(rules ? { leaveTypes: rules.length } : {}) }, requestId);
  const compliance = await leavePolicyGate(conn, c, id);
  return { ...(await getPolicy(conn, c.companyId, id)), compliance };
}

/** DELETE /leave/policies/:id — 409 IN_USE listing where it is assigned. */
export async function deletePolicy(conn, c, id, requestId = null) {
  const before = await loadPolicyRow(conn, c.companyId, id, { lock: true });
  const used = await whereUsed(conn, c.companyId, id);
  if (used.length) throw conflict('IN_USE', `${before.name} is in use, so it cannot be deleted. Choose another policy where it applies first.`, { problems: used });
  await conn.query('DELETE FROM hrms_leave_policy_rules WHERE company_id = ? AND policy_id = ?', [c.companyId, id]);
  await conn.query('UPDATE hrms_leave_policies SET deleted_at = NOW() WHERE company_id = ? AND id = ?', [c.companyId, id]);
  await audit(conn, c, 'hrms_leave_policies', id, 'DELETE', { name: before.name, status: before.status }, null, requestId);
  return { ok: true, id: Number(id) };
}

/** GET /leave/policy-templates -> { note, templates: [{ key, name, description, rules }] } — each rule with its sentence. */
export function listTemplates() {
  return {
    note: TEMPLATE_NOTE,
    leaveTypes: LEAVE_TYPES_OFFERED.map((t) => ({ ...t })),
    templates: TEMPLATES.map((t) => ({
      key: t.key,
      name: t.name,
      description: t.description,
      rules: t.rules.map(({ type, ...rest }, i) => {
        const offered = LEAVE_TYPES_OFFERED.find((x) => x.code === type);
        const rule = readRule(rest, offered.name, []);
        return { leaveTypeId: null, leaveTypeCode: offered.code, leaveTypeName: offered.name, isPaid: offered.isPaid, sortOrder: i + 1, ...rule, summary: summaryOf(rule, offered) };
      }),
    })),
  };
}

/* ══════════════════════════════════════════════════════════════════════════
 * Where a policy applies
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * GET /leave/assignments — five reads sent together, whatever the size of the company.
 *
 * `labels` (spec §17): every label of the company, in its order, each with its
 * own policy (or null) and `positionCount` = the positions whose policy comes
 * from this label (a role's own policy beats it; a department's OWN label only).
 */
export async function getAssignments(db, companyId) {
  const [index, positions, [locations], [roles], [labels]] = await Promise.all([
    loadAssignmentIndex(db, companyId),
    livePositions(db, companyId),
    db.query('SELECT id, name FROM hrms_locations WHERE company_id = ? AND deleted_at IS NULL ORDER BY name, id', [companyId]),
    db.query('SELECT id, title FROM hrms_roles WHERE company_id = ? AND deleted_at IS NULL', [companyId]),
    db.query(
      `SELECT l.id, l.name
         FROM hrms_department_labels l
         JOIN hrms_label_groups g ON g.company_id = l.company_id AND g.id = l.group_id AND g.is_kind = 1 AND g.deleted_at IS NULL
        WHERE l.company_id = ? AND l.deleted_at IS NULL
        ORDER BY l.sort_order, l.id`, [companyId]),
  ]);
  const positionsOfRole = new Map();
  for (const p of positions) positionsOfRole.set(p.role_id, (positionsOfRole.get(p.role_id) ?? 0) + 1);
  const reached = new Map();
  for (const p of positions) {
    const e = resolveEffective(index, targetOf(p));
    if (e.from === 'LABEL') reached.set(e.label.id, (reached.get(e.label.id) ?? 0) + 1);
  }
  return {
    company: { policy: index.company },
    locations: locations.map((l) => ({
      locationId: l.id,
      name: l.name,
      policy: index.byLocation.get(l.id) ?? null,
      // What a position at this location gets when its role has no policy of its own.
      effective: resolveEffective(index, { locationId: l.id }),
    })),
    labels: labels.map((l) => ({
      labelId: l.id,
      name: l.name,
      policy: index.byLabel.get(l.id)?.policy ?? null,
      positionCount: reached.get(l.id) ?? 0,
    })),
    // Only the roles that have a policy of their own.
    roles: roles.filter((r) => index.byRole.has(r.id)).map((r) => ({
      roleId: r.id, title: r.title, positionCount: positionsOfRole.get(r.id) ?? 0, policy: index.byRole.get(r.id),
    })).sort((a, b) => a.title.localeCompare(b.title)),
    unassignedPositions: usageOf(index, positions).unassigned,
  };
}

/**
 * PUT /leave/assignments { scope, locationId?, roleId?, labelId?, policyId | null } -> { assignments }
 * null removes the assignment at that level (the next level up then applies).
 * Only an ACTIVE policy can be assigned.
 */
export async function putAssignment(conn, c, body = {}, requestId = null) {
  const problems = [];
  const scope = String(body.scope ?? '').trim().toUpperCase();
  if (!SCOPES.includes(scope)) problems.push('Say where the policy applies: the company, a location, a label or a role.');
  const idOf = (v) => (v === undefined || v === null || v === '' ? null : Number(v));
  const locationId = scope === 'LOCATION' ? idOf(body.locationId) : null;
  const roleId = scope === 'ROLE' ? idOf(body.roleId) : null;
  const labelId = scope === 'LABEL' ? idOf(body.labelId) : null;
  if (scope === 'LOCATION' && !(Number.isInteger(locationId) && locationId > 0)) problems.push('Choose the location.');
  if (scope === 'ROLE' && !(Number.isInteger(roleId) && roleId > 0)) problems.push('Choose the role.');
  if (scope === 'LABEL' && !(Number.isInteger(labelId) && labelId > 0)) problems.push('Choose the label.');
  if (!has(body, 'policyId')) problems.push('Choose the policy, or none to remove it.');
  const policyId = idOf(body.policyId);
  if (policyId !== null && !(Number.isInteger(policyId) && policyId > 0)) problems.push('That policy is not a policy.');
  assertNoProblems(problems, 'This cannot be saved yet.');

  if (scope === 'LOCATION') {
    const [[row]] = await conn.query('SELECT id FROM hrms_locations WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [c.companyId, locationId]);
    if (!row) throw notFound('That location');
  }
  if (scope === 'ROLE') {
    const [[row]] = await conn.query('SELECT id FROM hrms_roles WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [c.companyId, roleId]);
    if (!row) throw notFound('That role');
  }
  if (scope === 'LABEL') {
    // A live label of THIS company's list.
    const [[row]] = await conn.query(
      `SELECT l.id FROM hrms_department_labels l
         JOIN hrms_label_groups g ON g.company_id = l.company_id AND g.id = l.group_id AND g.is_kind = 1 AND g.deleted_at IS NULL
        WHERE l.company_id = ? AND l.id = ? AND l.deleted_at IS NULL`, [c.companyId, labelId]);
    if (!row) throw notFound('That label');
  }
  let policy = null;
  if (policyId !== null) {
    policy = await loadPolicyRow(conn, c.companyId, policyId);
    if (policy.status !== 'ACTIVE') {
      const sentence = `${policy.name} is ${policy.status === 'DRAFT' ? 'still a draft' : 'archived'}. Only an active policy can be applied — make it active first.`;
      throw invalid('INVALID', sentence, { problems: [sentence] });
    }
  }

  const key = `${scope}:${locationId ?? roleId ?? labelId ?? 0}`;
  const [[current]] = await conn.query('SELECT id, policy_id FROM hrms_leave_policy_assignments WHERE company_id = ? AND target_key = ? FOR UPDATE', [c.companyId, key]);
  let madeId = null;
  if (policy === null) {
    if (current) await conn.query('UPDATE hrms_leave_policy_assignments SET deleted_at = NOW() WHERE company_id = ? AND id = ?', [c.companyId, current.id]);
  } else if (current) {
    await conn.query('UPDATE hrms_leave_policy_assignments SET policy_id = ? WHERE company_id = ? AND id = ?', [policy.id, c.companyId, current.id]);
  } else {
    const [ins] = await conn.query('INSERT INTO hrms_leave_policy_assignments (company_id, scope, location_id, role_id, label_id, policy_id, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [c.companyId, scope, locationId, roleId, labelId, policy.id, c.userId]);
    madeId = ins.insertId;
  }
  if (current || policy) {
    await audit(conn, c, 'hrms_leave_policy_assignments', current?.id ?? madeId, policy ? (current ? 'UPDATE' : 'CREATE') : 'DELETE',
      current ? { policyId: current.policy_id } : null, { scope, locationId, roleId, labelId, policyId: policy?.id ?? null }, requestId);
  }
  return { assignments: await getAssignments(conn, c.companyId) };
}

/** GET /leave/policy-for?positionId=  (or roleId=&locationId=&departmentId=) -> { effective } */
export async function policyFor(db, companyId, query = {}) {
  const idOf = (v, label) => {
    if (v === undefined || v === null || v === '') return null;
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0) throw invalid('INVALID', `${label} must be a positive whole number.`);
    return n;
  };
  let roleId = idOf(query.roleId, 'roleId');
  let locationId = idOf(query.locationId, 'locationId');
  let departmentId = idOf(query.departmentId, 'departmentId');
  const positionId = idOf(query.positionId, 'positionId');
  if (positionId !== null) {
    const [[p]] = await db.query('SELECT role_id, location_id, department_id FROM hrms_positions WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [companyId, positionId]);
    if (!p) throw notFound('That position');
    roleId = p.role_id;
    locationId = p.location_id;
    departmentId = p.department_id;
  } else if (roleId === null && locationId === null && departmentId === null) {
    throw invalid('INVALID', 'Say which position — or which role, org unit and location — to answer for.');
  }
  return { effective: resolveEffective(await loadAssignmentIndex(db, companyId), { roleId, locationId, departmentId }) };
}

/**
 * A person's own leave: the policy their position falls under, with its rules
 * and their sentences. For /user/me/place. Two reads.
 */
export async function leaveOfPosition(db, companyId, { roleId = null, locationId = null, departmentId = null } = {}) {
  const effective = resolveEffective(await loadAssignmentIndex(db, companyId), { roleId, locationId, departmentId });
  if (!effective.policy) return { ...effective, rules: [] };
  return { ...effective, rules: (await rulesOfPolicies(db, companyId, [effective.policy.id])).get(effective.policy.id) ?? [] };
}

export default {
  listLeaveTypes, createLeaveType, updateLeaveType, deleteLeaveType,
  listPolicies, getPolicy, createPolicy, updatePolicy, deletePolicy, listTemplates, previewRuleSummary, readRule,
  getAssignments, putAssignment, policyFor, leaveOfPosition,
};
