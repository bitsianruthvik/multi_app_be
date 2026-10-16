/**
 * leavePolicyRead.js — a leave rule in words, and which policy applies where.
 * (TM/CF_HRMS_HIRING_SPEC.md §8.)
 *
 * Its own file, importing no other service, like hiringRead.js and exitRead.js:
 * positionService, orgChartService, roleContentService and selfService each say
 * which leave policy applies, and leavePolicyService — which writes policies —
 * imports none of them back.
 *
 * TWO THINGS LIVE HERE AND NOWHERE ELSE.
 *
 * 1. THE SENTENCE. `summaryOf(rule)` is the one description of a rule, written
 *    by the server and shown as written: the editor's card, the policy page and
 *    the employee's "Your leave" all print it. Short plain sentences, no codes,
 *    one per fact that is set — nothing is said about an option left off.
 *
 * 2. THE RESOLUTION. A position's policy is its ROLE's assignment, else its
 *    department's LABEL's (spec §17), else its LOCATION's, else the COMPANY
 *    default, else none. `resolveEffective` is the only implementation; every
 *    read loads the assignments once (`loadAssignmentIndex`, one round trip)
 *    and asks it — never a query per row.
 */

export const BASES = ['PER_YEAR', 'PER_EVENT', 'UNLIMITED_UNPAID'];
export const ACCRUALS = ['UPFRONT', 'MONTHLY', 'PER_DAYS_WORKED', 'ON_REQUEST', 'EARNED_BY_WORK'];
export const CARRY_FORWARDS = ['NONE', 'CAPPED', 'ALL'];
export const APPLIES_TO = ['ANYONE', 'WOMEN', 'MEN'];
export const POLICY_STATUSES = ['DRAFT', 'ACTIVE', 'ARCHIVED'];
export const SCOPES = ['COMPANY', 'LOCATION', 'ROLE', 'LABEL'];

/** A plain rule: so many days a year, all given at the start, lapsing at the end. */
export const RULE_DEFAULTS = {
  basis: 'PER_YEAR', days: null, accrual: 'UPFRONT', daysWorkedPerLeaveDay: null,
  prorateOnJoining: false, allowedInProbation: true, waitDaysAfterJoining: 0,
  carryForward: 'NONE', carryForwardCapDays: null, encashable: false, encashCapDays: null,
  maxDaysAtOnce: null, minNoticeDays: 0, halfDayAllowed: false, countDaysOffBetween: false,
  proofAfterDays: null, appliesTo: 'ANYONE', maxTimesInService: null,
  expiresAfterDays: null, negativeBalanceAllowed: false, notes: null,
};

/* ══════════════════════════════════════════════════════════════════════════
 * The sentence
 * ══════════════════════════════════════════════════════════════════════════ */

const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
/** 12 -> "12", 1.25 -> "1.25", 0.5 -> "0.5". */
const plain = (n) => String(Math.round(Number(n) * 100) / 100);
/** "1 day", "12 days", "half a day", "1.25 days". */
const days = (n) => { const v = Math.round(Number(n) * 100) / 100; return v === 0.5 ? 'half a day' : `${plain(v)} day${v === 1 ? '' : 's'}`; };
/** "30 unused days carry forward", "1 unused day carries forward". */
const unused = (n) => `${plain(n)} unused day${Number(n) === 1 ? ' carries' : 's carry'} forward`;
const times = (n) => (n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`);

/** Which parts of a rule its basis and accrual give a meaning to. The summary and the save both read this. */
export function applicability(rule) {
  const basis = rule.basis;
  const accrual = rule.accrual;
  const yearly = basis === 'PER_YEAR';
  const banked = yearly && accrual !== 'ON_REQUEST';          // days are credited and can be left over
  const earnedByWork = yearly && accrual === 'EARNED_BY_WORK';
  return {
    days: basis !== 'UNLIMITED_UNPAID',
    daysWorkedPerLeaveDay: yearly && accrual === 'PER_DAYS_WORKED',
    prorateOnJoining: yearly && (accrual === 'UPFRONT' || accrual === 'ON_REQUEST'),
    carryForward: banked && !earnedByWork,
    encashable: banked,
    expiresAfterDays: earnedByWork,
    maxTimesInService: basis === 'PER_EVENT',
    negativeBalanceAllowed: banked,
    halfDayAllowed: basis !== 'PER_EVENT',
  };
}

/** Is this the leave a medical certificate goes with? Only the wording of the proof sentence turns on it. */
const isSickLeave = (type) => /^SL$/i.test(type?.code ?? '') || /sick|medical/i.test(type?.name ?? '');

/**
 * THE SENTENCE(S) for one rule.
 *
 * @param rule a rule in the wire shape (camelCase). Fields that do not apply to
 *             its basis and accrual are ignored whatever they hold.
 * @param type optional { code, name } of the leave type — only to say "medical
 *             certificate" for sick leave and "proof" for the rest.
 *
 * Order: how much and how it is earned · who it is for · when it starts ·
 * what happens to what is left · the rules when taking it.
 */
export function summaryOf(rule, type = null) {
  const r = { ...RULE_DEFAULTS, ...rule };
  const a = applicability(r);
  const d = num(r.days);
  const out = [];

  // ── how much, and how it is earned ──
  if (r.basis === 'UNLIMITED_UNPAID') {
    out.push('Unpaid leave with no fixed limit, given when it is asked for.');
  } else if (r.basis === 'PER_EVENT') {
    const n = num(r.maxTimesInService);
    if (d === null) out.push('Given each time it is needed.');
    else if (n === 1) out.push(`${cap(days(d))}, once in the whole of a person’s service.`);
    else if (n) out.push(`${cap(days(d))} each time, up to ${times(n)} in a person’s service.`);
    else out.push(`${cap(days(d))} each time it is needed.`);
  } else if (r.accrual === 'MONTHLY') {
    if (d === null) out.push('Earned month by month.');
    else out.push(`${cap(days(d))} a year, earned ${d === 12 ? 'a day' : days(d / 12)} each month.`);
  } else if (r.accrual === 'PER_DAYS_WORKED') {
    const per = num(r.daysWorkedPerLeaveDay);
    out.push(`One day for every ${per ?? '…'} days worked${d !== null ? `, up to ${days(d)} a year` : ''}.`);
  } else if (r.accrual === 'EARNED_BY_WORK') {
    out.push(`Earned by working on a holiday or a weekly off${d !== null ? `, up to ${days(d)} a year` : ''}.`);
  } else if (r.accrual === 'ON_REQUEST') {
    out.push(d === null ? 'Given when it is asked for.' : `Up to ${days(d)} a year, given when it is asked for.`);
  } else {
    out.push(d === null ? 'Given at the start of the year.' : `${cap(days(d))} a year, all given at the start of the year.`);
  }

  // ── who it is for ──
  if (r.appliesTo === 'WOMEN') out.push('For women.');
  if (r.appliesTo === 'MEN') out.push('For men.');

  // ── when it starts ──
  if (a.prorateOnJoining && r.prorateOnJoining) out.push('Someone who joins part-way through the year gets a share for the months left.');
  const wait = num(r.waitDaysAfterJoining) ?? 0;
  if (wait > 0 && !r.allowedInProbation) out.push(`Not during probation, and not in the first ${days(wait)} in the job.`);
  else if (wait > 0) out.push(`Can be taken after ${days(wait)} in the job.`);
  else if (!r.allowedInProbation) out.push('Not during probation.');

  // ── what happens to what is left ──
  if (a.expiresAfterDays && num(r.expiresAfterDays)) out.push(`Must be used within ${days(num(r.expiresAfterDays))} of earning it.`);
  if (a.carryForward) {
    const capDays = num(r.carryForwardCapDays);
    if (r.carryForward === 'ALL') out.push('All unused days carry forward to the next year.');
    else if (r.carryForward === 'CAPPED') out.push(`Up to ${unused(capDays ?? 0)} to the next year.`);
    else out.push('Unused days lapse at the year end.');
  }
  if (a.encashable && r.encashable) {
    const capDays = num(r.encashCapDays);
    out.push(capDays ? `Up to ${plain(capDays)} unused day${capDays === 1 ? '' : 's'} can be paid out.` : 'Unused days can be paid out.');
  }

  // ── the rules when taking it ──
  const most = num(r.maxDaysAtOnce);
  if (most) out.push(`No more than ${days(most)} at a stretch.`);
  const notice = num(r.minNoticeDays) ?? 0;
  if (notice > 0) out.push(`Ask ${days(notice)} ahead.`);
  if (a.halfDayAllowed && r.halfDayAllowed) out.push('Half days can be taken.');
  if (r.countDaysOffBetween) out.push('A weekly off or holiday between two leave days counts as leave.');
  const proof = num(r.proofAfterDays);
  if (proof !== null) {
    const what = isSickLeave(type) ? 'A medical certificate' : 'Proof';
    out.push(proof === 0 ? `${what} is needed every time.` : `${what} is needed beyond ${days(proof)}.`);
  }
  if (a.negativeBalanceAllowed && r.negativeBalanceAllowed) out.push('Can be taken before it has been earned.');

  return out.join(' ');
}

function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

/* ══════════════════════════════════════════════════════════════════════════
 * A rule and a policy on the wire
 * ══════════════════════════════════════════════════════════════════════════ */

/** A rule row (joined to its leave type as lt_code, lt_name, lt_is_paid) -> the spec's `Rule`. */
export function shapeRule(r) {
  const rule = {
    id: r.id,
    leaveTypeId: r.leave_type_id,
    leaveTypeCode: r.lt_code,
    leaveTypeName: r.lt_name,
    isPaid: Boolean(r.lt_is_paid),
    sortOrder: Number(r.sort_order) || 0,
    basis: r.basis,
    days: num(r.days),
    accrual: r.accrual,
    daysWorkedPerLeaveDay: num(r.days_worked_per_leave_day),
    prorateOnJoining: Boolean(r.prorate_on_joining),
    allowedInProbation: Boolean(r.allowed_in_probation),
    waitDaysAfterJoining: Number(r.wait_days_after_joining) || 0,
    carryForward: r.carry_forward,
    carryForwardCapDays: num(r.carry_forward_cap_days),
    encashable: Boolean(r.encashable),
    encashCapDays: num(r.encash_cap_days),
    maxDaysAtOnce: num(r.max_days_at_once),
    minNoticeDays: Number(r.min_notice_days) || 0,
    halfDayAllowed: Boolean(r.half_day_allowed),
    countDaysOffBetween: Boolean(r.count_days_off_between),
    proofAfterDays: num(r.proof_after_days),
    appliesTo: r.applies_to,
    maxTimesInService: num(r.max_times_in_service),
    expiresAfterDays: num(r.expires_after_days),
    negativeBalanceAllowed: Boolean(r.negative_balance_allowed),
    notes: r.notes ?? null,
  };
  return { ...rule, summary: summaryOf(rule, { code: r.lt_code, name: r.lt_name }) };
}

/** "Casual leave" -> "Casual"; "Leave without pay" and "Compensatory off" stay as they are. */
const shortName = (name) => String(name ?? '').replace(/\s+leave$/i, '').trim() || String(name ?? '');

/** "Casual 12 · Sick 12 · Earned 15 · Maternity · Paternity" — a number only where the leave is so many days a year. */
export function headlineOf(rules) {
  return rules.map((r) => (r.basis === 'PER_YEAR' && r.days !== null ? `${shortName(r.leaveTypeName)} ${plain(r.days)}` : shortName(r.leaveTypeName))).join(' · ');
}

export const refOf = (p) => (p ? { id: p.id, name: p.name, status: p.status } : null);

/* ══════════════════════════════════════════════════════════════════════════
 * Which policy applies where
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * Every live assignment of a company as an index the resolution reads: the
 * company default, and the policy of each location, role and LABEL that has its
 * own — and, for the labels that have one, which departments carry them.
 * TWO queries, sent together (one round trip's wait), whatever the size of the
 * company. With `labels: false` (the role page, which shows only the role's own
 * policy) the second is not sent.
 *
 * A department has ONE label, its OWN (the one its department_type names,
 * without case) — never a parent department's.
 */
export async function loadAssignmentIndex(db, companyId, { labels = true } = {}) {
  const [[rows], [carried]] = await Promise.all([
    db.query(
      `SELECT a.scope, a.location_id, a.role_id, a.label_id, p.id, p.name, p.status, l.name AS location_name, dl.name AS label_name
         FROM hrms_leave_policy_assignments a
         JOIN hrms_leave_policies p ON p.company_id = a.company_id AND p.id = a.policy_id AND p.deleted_at IS NULL
         LEFT JOIN hrms_locations l ON l.company_id = a.company_id AND l.id = a.location_id
         LEFT JOIN hrms_label_groups g ON g.company_id = a.company_id AND g.is_kind = 1 AND g.deleted_at IS NULL
         LEFT JOIN hrms_department_labels dl ON dl.company_id = a.company_id AND dl.id = a.label_id AND dl.group_id = g.id AND dl.deleted_at IS NULL
        WHERE a.company_id = ? AND a.deleted_at IS NULL`,
      [companyId],
    ),
    labels
      ? db.query(
        `SELECT d.id AS department_id, l.id AS label_id
           FROM hrms_departments d
           JOIN hrms_department_labels l ON l.company_id = d.company_id AND l.deleted_at IS NULL AND LOWER(l.name) = LOWER(d.department_type)
           JOIN hrms_label_groups g ON g.company_id = l.company_id AND g.id = l.group_id AND g.is_kind = 1 AND g.deleted_at IS NULL
           JOIN hrms_leave_policy_assignments a ON a.company_id = l.company_id AND a.label_id = l.id AND a.scope = 'LABEL' AND a.deleted_at IS NULL
          WHERE d.company_id = ? AND d.deleted_at IS NULL`,
        [companyId],
      )
      : [[]],
  ]);
  const index = {
    company: null, byLocation: new Map(), byRole: new Map(), byLabel: new Map(), locationName: new Map(), labelOfDepartment: new Map(),
  };
  for (const r of rows) {
    const ref = refOf(r);
    if (r.scope === 'COMPANY') index.company = ref;
    else if (r.scope === 'LOCATION' && r.location_id != null) { index.byLocation.set(r.location_id, ref); index.locationName.set(r.location_id, r.location_name ?? null); }
    else if (r.scope === 'ROLE' && r.role_id != null) index.byRole.set(r.role_id, ref);
    // A label that is gone applies nowhere.
    else if (r.scope === 'LABEL' && r.label_id != null && r.label_name != null) {
      index.byLabel.set(r.label_id, { policy: ref, label: { id: r.label_id, name: r.label_name } });
    }
  }
  for (const k of carried) if (index.byLabel.has(k.label_id)) index.labelOfDepartment.set(k.department_id, k.label_id);
  return index;
}

/**
 * THE RESOLUTION (spec §8, §17): ROLE, else LABEL, else LOCATION, else the
 * COMPANY default, else none. The only implementation — every read that shows a
 * leave policy asks it. A position's label is its department's own
 * (`departmentId`); a department has one label, so there is never a choice.
 *
 * @returns the spec's `Effective`:
 *   { policy: Ref | null, from: 'ROLE' | 'LABEL' | 'LOCATION' | 'COMPANY' | null, line }
 *   and, only when from is LABEL: label: { id, name }
 *   line: "Office staff — from the role" · "Shop floor — from the label Machine" ·
 *         "Shop floor — from Unit 2" (a location) · "Office staff — the company default" · "No leave policy"
 */
export function resolveEffective(index, { roleId = null, locationId = null, departmentId = null } = {}) {
  const role = roleId != null ? index.byRole.get(Number(roleId)) : null;
  if (role) return { policy: role, from: 'ROLE', line: `${role.name} — from the role` };
  const labelId = departmentId != null ? index.labelOfDepartment?.get(Number(departmentId)) : null;
  const byLabel = labelId != null ? index.byLabel.get(labelId) : null;
  if (byLabel) {
    return { policy: byLabel.policy, from: 'LABEL', label: { ...byLabel.label }, line: `${byLabel.policy.name} — from the label ${byLabel.label.name}` };
  }
  const location = locationId != null ? index.byLocation.get(Number(locationId)) : null;
  if (location) return { policy: location, from: 'LOCATION', line: `${location.name} — from ${index.locationName.get(Number(locationId)) ?? 'the location'}` };
  if (index.company) return { policy: index.company, from: 'COMPANY', line: `${index.company.name} — the company default` };
  return { policy: null, from: null, line: 'No leave policy' };
}

/** The effective policy of one position (role, location, department), for a read that has nothing loaded: one round trip. */
export async function effectiveFor(db, companyId, target) {
  return resolveEffective(await loadAssignmentIndex(db, companyId), target);
}

const RULE_SELECT = `
  SELECT r.*, lt.code AS lt_code, lt.name AS lt_name, lt.is_paid AS lt_is_paid
    FROM hrms_leave_policy_rules r
    JOIN hrms_leave_types lt ON lt.company_id = r.company_id AND lt.id = r.leave_type_id`;

/** The rules of some policies, shaped, by policy id: one query. */
export async function rulesOfPolicies(db, companyId, policyIds) {
  const by = new Map(policyIds.map((id) => [id, []]));
  if (!policyIds.length) return by;
  const [rows] = await db.query(
    `${RULE_SELECT} WHERE r.company_id = ? AND r.policy_id IN (?) AND r.deleted_at IS NULL ORDER BY r.policy_id, r.sort_order, r.id`,
    [companyId, policyIds],
  );
  for (const r of rows) by.get(r.policy_id)?.push(shapeRule(r));
  return by;
}

export default {
  BASES, ACCRUALS, CARRY_FORWARDS, APPLIES_TO, POLICY_STATUSES, SCOPES, RULE_DEFAULTS,
  applicability, summaryOf, shapeRule, headlineOf, refOf, loadAssignmentIndex, resolveEffective, effectiveFor, rulesOfPolicies,
};
