/**
 * selfService.js — "where do I sit, and who do I answer to?", answered for the
 * signed-in person and for nobody else.
 *
 * This is the fourth world (DESIGN_SYSTEM_APPENDIX.md §A3's "Employee — self
 * only"). For a shop-floor employee it is the ONLY thing in the product they
 * can reach: one tag, `cf_hrms_self_view`, one route, `GET /user/me/place`.
 *
 * ── THE SECURITY BOUNDARY, IN ONE SENTENCE ────────────────────────────────
 * The employee is resolved from `req.user.id` through `hrms_employees.user_id`.
 * No function in this file takes an employee id, an assignment id or a position
 * id from a caller, and `routes/self.js` has no `:id` parameter to pass one
 * through. That is the whole protection: there is no identifier to tamper with.
 * Keep it that way — the moment this file accepts "whose place?" it becomes a
 * people-directory endpoint wearing a self-view permission.
 *
 * ── WHY IT IS NOT orgChartService ─────────────────────────────────────────
 * `buildOrgChart` returns every position and every person in the company in one
 * payload, on purpose (114 positions at Karni, paging a graph costs more than it
 * saves). Handing that to a shop-floor login would disclose the entire
 * organisation — every name, every seat, every vacancy — to answer "who is my
 * supervisor". So this file queries the SLICE: the caller's own rows, the rows
 * that name the caller's seats as a manager, and the rows that name the
 * caller's own managers. Nothing else is read.
 *
 * ── WHY IT DOES NOT DERIVE REPORTING ITSELF ───────────────────────────────
 * `reportingResolver.resolveReporting` is the one implementation of "who does
 * this person answer to" (plan §2 rule 9). It is called per active assignment
 * and its rows are re-dressed for a reader with no HR training — never
 * re-derived, never flattened to a manager_id. Responsibilities and KRAs come
 * through `contentResolver.resolveContent`, which is what a Role JD and an
 * Employee Responsibility Profile are rendered from, so this screen and the
 * document a person is handed cannot disagree.
 *
 * ── PII ───────────────────────────────────────────────────────────────────
 * Names and seats are public inside a company; phone, email, date of birth,
 * address and emergency contact are not. The caller always gets their OWN
 * contact block — it is their own data, and "my emergency contact is wrong" is
 * one of the few things a self-service screen is genuinely for. Everyone else
 * in the payload (managers, reports, peers) is a name and a seat, and gains a
 * contact block only when the caller also holds `cf_hrms_people_pii`.
 * Statutory identifiers (Aadhaar, PAN, UAN) are NOT in this payload at any
 * permission level: `people.js` is the sole read path for those and it logs
 * every unmasked read.
 *
 * ── ROUND TRIPS ───────────────────────────────────────────────────────────
 * Plan §16. Per seat: 4 for `resolveReporting` and a dozen for `resolveContent`.
 * Everything this file adds on top is bulk — the team is 4 queries whether a
 * person has two reports or fifty, because a per-report service call is free on
 * localhost and ruinous over the production link.
 */
import { pool } from '../lib/db.js';
import { dateText, today, LIVE_ON } from './positionService.js';
import { resolveReporting, scopeSentence } from './reportingResolver.js';
import { resolveContent } from './contentResolver.js';

/* ── words ──────────────────────────────────────────────────────────────── */

/**
 * A scope as a phrase that completes "reports to X …".
 *
 * The point of this function is that a second manager with a narrow scope must
 * read as a narrowing and not as a contradiction. "Reports to Samir Sahu" and
 * "Reports to Mohit Kakani" side by side look like the system cannot make up
 * its mind; "Reports to Samir Sahu for all of this work" and "Reports to Mohit
 * Kakani for statutory compliance" are plainly two true facts.
 *
 * Returns null for a general scope, so a caller can leave the sentence alone
 * rather than printing "for everything" on every ordinary line.
 */
export function scopePhrase(scope) {
  if (!scope || scope.type === 'GENERAL') return null;
  const what = scope.label || scope.workContextName;
  if (!what) {
    return {
      FUNCTION: 'for one function of this work',
      RESPONSIBILITY: 'for one responsibility of this work',
      WORK_CONTEXT: 'for one machine or area',
      PROJECT: 'for one project',
      OTHER: 'for part of this work',
    }[scope.type] ?? 'for part of this work';
  }
  if (scope.type === 'PROJECT') return `for the ${what} project`;
  if (scope.type === 'WORK_CONTEXT') return `for ${what}`;
  return `for ${what}`;
}

/** One sentence saying what a reporting line means, for somebody with no HR training. */
function relationshipMeaning(row) {
  const kind = row.relationshipType.code;
  const base = {
    PRIMARY_MANAGER: 'Your main manager for this work — the person who sets it and signs it off.',
    FUNCTIONAL_MANAGER: 'Guides how the work is done, alongside your main manager.',
    ADMINISTRATIVE_MANAGER: 'Handles the administrative side — attendance, leave, paperwork.',
    DOTTED_LINE: 'A dotted line. Real, but not your main manager.',
    PROJECT_MANAGER: 'Manages you on a project, for as long as that project runs.',
    SHIFT_SUPERVISOR: 'Your supervisor on shift.',
  }[kind] ?? 'A reporting line recorded against this work.';
  const phrase = scopePhrase(row.scope);
  return phrase ? `${base} It covers only this part of your work: ${phrase.replace(/^for /, '')}.` : base;
}

/* ── shaping ────────────────────────────────────────────────────────────── */

const personContact = (r) => ({
  phone: r.phone ?? null,
  email: r.email ?? null,
  dateOfBirth: dateText(r.date_of_birth),
  address: r.address_json ?? null,
  emergencyContact: r.emergency_contact_json ?? null,
});

/**
 * Another person, as this screen shows them: a name, a code, and what they do.
 * Contact details only when the caller holds the PII tag — see the header.
 */
function otherPerson(r, canSeePii) {
  const out = {
    employeeId: r.employee_id ?? r.employeeId ?? null,
    employeeCode: r.employee_code ?? r.employeeCode ?? null,
    name: r.full_name ?? r.name ?? null,
    roleTitle: r.role_title ?? r.roleTitle ?? null,
    positionTitle: r.position_title ?? r.positionTitle ?? null,
    assignmentTitle: r.assignment_title ?? r.assignmentTitle ?? null,
  };
  if (canSeePii) out.contact = personContact(r);
  return out;
}

/**
 * One resolved reporting line, re-dressed for a reader with no training.
 *
 * `lineStyle` is not decoration invented here — it is the model's own
 * definition. `hrms_reporting_relationship_types.is_formal` is documented in
 * seed.sql §5 as "does this type draw a solid line in the org chart", so a
 * DOTTED_LINE, a PROJECT_MANAGER and a SHIFT_SUPERVISOR are dotted because the
 * vocabulary says they are, not because a screen chose a border style.
 */
function selfRelationship(row, seat, canSeePii) {
  const phrase = scopePhrase(row.scope);
  return {
    key: row.key,
    origin: row.origin,                       // POSITION (the design) | ASSIGNMENT (this person)
    inherited: row.inherited,
    fromText: row.origin === 'POSITION'
      ? 'From the organisation chart'
      : 'Recorded for you on this work',
    relationshipType: {
      code: row.relationshipType.code,
      name: row.relationshipType.name,
      isFormal: row.relationshipType.isFormal,
    },
    isPrimary: row.isPrimary,
    lineStyle: row.relationshipType.isFormal ? 'SOLID' : 'DOTTED',
    scope: {
      type: row.scope.type,
      label: row.scope.label,
      workContextName: row.scope.workContextName,
      isGeneral: row.scope.type === 'GENERAL',
      sentence: scopeSentence(row.scope),      // "Function: Statutory compliance"
      phrase,                                  // "for statutory compliance", or null
    },
    meaning: relationshipMeaning(row),
    person: row.manager ? otherPerson(row.manager, canSeePii) : null,
    /** A formal line names a SEAT. When nobody is in it, say so rather than showing nothing. */
    seatTitle: row.managerPosition?.title ?? null,
    /**
     * The manager's seat and this line's scope identity. They are here because
     * "who else reports to my manager" has to match on the same three things
     * `resolveReporting` keys replacement on — the manager, the relationship
     * type and the scope — and a formal line's manager IS a seat, not a person.
     */
    seatPositionId: row.managerPosition?.id ?? null,
    scopeKey: row.scope.key,
    vacant: row.vacant,
    /** A seat with sanctioned headcount > 1 can hold several people; all of them are the answer. */
    alsoHeldBy: (row.managerCandidates ?? []).slice(1).map((m) => otherPerson(m, canSeePii)),
    endsOn: row.endsOn,
    note: row.note,
    /** Which of the caller's own jobs this line belongs to. */
    seat,
  };
}

/* ── the caller ─────────────────────────────────────────────────────────── */

const EMPLOYEE_BY_USER = `
  SELECT e.id, e.employee_code, e.full_name, e.date_of_birth, e.gender, e.phone, e.email,
         e.address_json, e.emergency_contact_json, e.date_of_joining, e.employment_type,
         e.employment_status, e.exit_date, e.user_id,
         e.photo_file_name IS NOT NULL AS has_photo,
         c.name AS contractor_name
    FROM hrms_employees e
    LEFT JOIN hrms_contractors c ON c.company_id = e.company_id AND c.id = e.contractor_id
   WHERE e.company_id = ? AND e.user_id = ? AND e.deleted_at IS NULL
   LIMIT 1`;

const MY_ASSIGNMENTS = `
  SELECT wa.id, wa.assignment_title, wa.allocation_percent, wa.is_primary, wa.status,
         wa.effective_from, wa.effective_to, wa.role_id, wa.position_id,
         r.title AS role_title, r.role_purpose,
         p.position_code, COALESCE(p.position_title, pr.title) AS position_title,
         d.name AS department_name, l.name AS location_name,
         s.code AS shift_code, s.name AS shift_name, s.start_time, s.end_time, s.crosses_midnight
    FROM hrms_work_assignments wa
    LEFT JOIN hrms_roles r ON r.company_id = wa.company_id AND r.id = wa.role_id
    LEFT JOIN hrms_positions p ON p.company_id = wa.company_id AND p.id = wa.position_id
    LEFT JOIN hrms_roles pr ON pr.company_id = wa.company_id AND pr.id = p.role_id
    LEFT JOIN hrms_departments d ON d.company_id = wa.company_id
         AND d.id = COALESCE(wa.department_id, p.department_id)
    LEFT JOIN hrms_locations l ON l.company_id = wa.company_id
         AND l.id = COALESCE(wa.location_id, p.location_id)
    LEFT JOIN hrms_shifts s ON s.company_id = wa.company_id
         AND s.id = COALESCE(wa.default_shift_id, p.default_shift_id)
   WHERE wa.company_id = ? AND wa.employee_id = ? AND wa.deleted_at IS NULL
     AND wa.status IN ('ACTIVE', 'PLANNED', 'SUSPENDED')
     AND ${LIVE_ON('wa')}
   ORDER BY wa.is_primary DESC, wa.effective_from DESC, wa.id`;

/**
 * Contact details for the people already in the payload, in ONE query.
 *
 * `reportingResolver` deliberately carries no contact columns — it answers "who
 * is the manager", not "how do I reach them" — so a manager row shaped from it
 * has an empty contact block. Rather than widen the resolver (it is shared with
 * the org chart and the JD, neither of which should start carrying phone
 * numbers), the ids already in the answer are hydrated here.
 *
 * Only called when the caller holds `cf_hrms_people_pii`. Without it the
 * `contact` key is never added, so there is nothing to fill: a contact block
 * full of nulls is worse than no block, because it reads as "we have no number
 * for your manager" when the truth is "you are not allowed to see it".
 */
async function contactsFor(db, companyId, employeeIds) {
  if (!employeeIds.length) return new Map();
  const [rows] = await db.query(
    `SELECT id, phone, email, date_of_birth, address_json, emergency_contact_json
       FROM hrms_employees
      WHERE company_id = ? AND deleted_at IS NULL
        AND id IN (${employeeIds.map(() => '?').join(',')})`,
    [companyId, ...employeeIds],
  );
  return new Map(rows.map((r) => [r.id, personContact(r)]));
}

/** The machines, lines and areas one of the caller's jobs covers. One query for all of them. */
async function contextsFor(db, companyId, assignmentIds) {
  if (!assignmentIds.length) return new Map();
  const [rows] = await db.query(
    `SELECT wc.work_assignment_id, wc.is_primary, c.id, c.name, c.context_type
       FROM hrms_work_assignment_contexts wc
       JOIN hrms_work_contexts c ON c.company_id = wc.company_id AND c.id = wc.work_context_id
      WHERE wc.company_id = ? AND wc.deleted_at IS NULL AND c.deleted_at IS NULL
        AND wc.work_assignment_id IN (${assignmentIds.map(() => '?').join(',')})
      ORDER BY wc.is_primary DESC, c.name`,
    [companyId, ...assignmentIds],
  );
  const by = new Map();
  for (const r of rows) {
    const list = by.get(r.work_assignment_id) ?? [];
    list.push({ id: r.id, name: r.name, contextType: r.context_type, isPrimary: Boolean(r.is_primary) });
    by.set(r.work_assignment_id, list);
  }
  return by;
}

/* ── the team: who reports into a set of manager seats and people ───────── */

const SELECT_PERSON_COLS = `
  wa.id AS assignment_id, wa.employee_id, wa.assignment_title, wa.position_id, wa.is_primary AS seat_primary,
  e.employee_code, e.full_name, e.phone, e.email, e.date_of_birth, e.address_json, e.emergency_contact_json,
  r.title AS role_title, p.position_code, COALESCE(p.position_title, pr.title) AS position_title,
  d.name AS department_name, sh.code AS shift_code, sh.name AS shift_name`;

const JOIN_PERSON = `
  JOIN hrms_employees e ON e.company_id = wa.company_id AND e.id = wa.employee_id AND e.deleted_at IS NULL
  LEFT JOIN hrms_roles r ON r.company_id = wa.company_id AND r.id = wa.role_id
  LEFT JOIN hrms_positions p ON p.company_id = wa.company_id AND p.id = wa.position_id
  LEFT JOIN hrms_roles pr ON pr.company_id = wa.company_id AND pr.id = p.role_id
  LEFT JOIN hrms_departments d ON d.company_id = wa.company_id AND d.id = COALESCE(wa.department_id, p.department_id)
  LEFT JOIN hrms_shifts sh ON sh.company_id = wa.company_id AND sh.id = COALESCE(wa.default_shift_id, p.default_shift_id)`;

/**
 * Everyone who reports into a given set of PEOPLE (assignment-level lines) and
 * a given set of SEATS (position-level lines), with the relationship that says
 * so. Four queries, whatever the size of the answer.
 *
 * It applies the SAME replacement rule `resolveReporting` applies, from the
 * other end: an inherited formal line does not reach a person whose own
 * assignment carries a line of the same relationship type over the same scope,
 * because that assignment row replaced it. Without that check a manager would
 * be shown reports who have since been moved to somebody else — the chart's
 * version of the truth presented as today's.
 *
 * Returns a Map keyed `E:<employeeId>` / `P:<positionId>` → rows. Both keys are
 * needed because an assignment line names a PERSON and a formal line names a
 * SEAT, and the caller's own managers are a mixture of the two.
 */
async function reportsInto(db, companyId, { managerEmployeeIds, managerPositionIds }, on) {
  const out = new Map();
  const push = (key, row) => {
    const list = out.get(key) ?? [];
    list.push(row);
    out.set(key, list);
  };

  const live = (alias) => LIVE_ON(alias);
  const activeAssignment = `wa.deleted_at IS NULL AND wa.status = 'ACTIVE' AND ${live('wa')}`;

  // ── 1. assignment-level lines: these name a person directly ─────────────
  if (managerEmployeeIds.length) {
    const [rows] = await db.query(
      `SELECT ${SELECT_PERSON_COLS},
              ar.manager_employee_id, ar.relationship_type_id, ar.scope_key, ar.is_primary,
              ar.scope_type, ar.scope_label, ar.scope_work_context_id, ar.scope_notes,
              t.code AS type_code, t.name AS type_name, t.is_formal, t.sort_order,
              sc.name AS scope_context_name
         FROM hrms_assignment_reporting_relationships ar
         JOIN hrms_reporting_relationship_types t
              ON t.company_id = ar.company_id AND t.id = ar.relationship_type_id
         JOIN hrms_work_assignments wa ON wa.company_id = ar.company_id AND wa.id = ar.work_assignment_id
         ${JOIN_PERSON}
         LEFT JOIN hrms_work_contexts sc ON sc.company_id = ar.company_id AND sc.id = ar.scope_work_context_id
        WHERE ar.company_id = ? AND ar.deleted_at IS NULL AND ${live('ar')}
          AND ar.manager_employee_id IN (${managerEmployeeIds.map(() => '?').join(',')})
          AND ${activeAssignment}
        ORDER BY t.sort_order, e.full_name`,
      [companyId, on, on, ...managerEmployeeIds, on, on],
    );
    for (const r of rows) push(`E:${r.manager_employee_id}`, { ...r, origin: 'ASSIGNMENT' });
  }

  // ── 2. position-level lines: these name a seat, so the people are its ───
  //      occupants, resolved now.
  if (managerPositionIds.length) {
    const [formal] = await db.query(
      `SELECT rr.id, rr.from_position_id, rr.to_position_id, rr.relationship_type_id, rr.scope_key,
              rr.is_primary, rr.scope_type, rr.scope_label, rr.scope_work_context_id, rr.notes AS scope_notes,
              t.code AS type_code, t.name AS type_name, t.is_formal, t.sort_order,
              sc.name AS scope_context_name
         FROM hrms_position_reporting_relationships rr
         JOIN hrms_reporting_relationship_types t
              ON t.company_id = rr.company_id AND t.id = rr.relationship_type_id
         LEFT JOIN hrms_work_contexts sc ON sc.company_id = rr.company_id AND sc.id = rr.scope_work_context_id
        WHERE rr.company_id = ? AND rr.deleted_at IS NULL AND ${live('rr')}
          AND rr.to_position_id IN (${managerPositionIds.map(() => '?').join(',')})
        ORDER BY t.sort_order, rr.id`,
      [companyId, on, on, ...managerPositionIds],
    );

    const fromIds = [...new Set(formal.map((r) => r.from_position_id))];
    if (fromIds.length) {
      const [people] = await db.query(
        `SELECT ${SELECT_PERSON_COLS}
           FROM hrms_work_assignments wa
           ${JOIN_PERSON}
          WHERE wa.company_id = ? AND ${activeAssignment}
            AND wa.position_id IN (${fromIds.map(() => '?').join(',')})
          ORDER BY e.full_name`,
        [companyId, on, on, ...fromIds],
      );

      // The replacement check, in one query rather than one per person.
      const assignmentIds = people.map((p) => p.assignment_id);
      const replaced = new Set();
      if (assignmentIds.length) {
        const [own] = await db.query(
          `SELECT ar.work_assignment_id, ar.relationship_type_id, ar.scope_key
             FROM hrms_assignment_reporting_relationships ar
            WHERE ar.company_id = ? AND ar.deleted_at IS NULL AND ${live('ar')}
              AND ar.work_assignment_id IN (${assignmentIds.map(() => '?').join(',')})`,
          [companyId, on, on, ...assignmentIds],
        );
        for (const r of own) {
          replaced.add(`${r.work_assignment_id}|${r.relationship_type_id}|${r.scope_key}`);
        }
      }

      const byPosition = new Map();
      for (const p of people) {
        const list = byPosition.get(p.position_id) ?? [];
        list.push(p);
        byPosition.set(p.position_id, list);
      }

      for (const f of formal) {
        for (const p of byPosition.get(f.from_position_id) ?? []) {
          if (replaced.has(`${p.assignment_id}|${f.relationship_type_id}|${f.scope_key}`)) continue;
          push(`P:${f.to_position_id}`, {
            ...p,
            origin: 'POSITION',
            relationship_type_id: f.relationship_type_id,
            scope_key: f.scope_key,
            is_primary: f.is_primary,
            scope_type: f.scope_type,
            scope_label: f.scope_label,
            scope_work_context_id: f.scope_work_context_id,
            scope_notes: f.scope_notes,
            type_code: f.type_code,
            type_name: f.type_name,
            is_formal: f.is_formal,
            sort_order: f.sort_order,
            scope_context_name: f.scope_context_name,
          });
        }
      }
    }
  }

  return out;
}

/** A team member — a person plus the kind of line that puts them there. */
function teamMember(r, canSeePii) {
  const scope = {
    type: r.scope_type,
    label: r.scope_label ?? null,
    workContextName: r.scope_context_name ?? null,
  };
  const phrase = scopePhrase(scope);
  return {
    key: `${r.origin}:${r.assignment_id}:${r.relationship_type_id}:${r.scope_key}`,
    assignmentId: r.assignment_id,
    person: otherPerson(r, canSeePii),
    departmentName: r.department_name ?? null,
    shift: r.shift_code ? { code: r.shift_code, name: r.shift_name } : null,
    relationshipType: { code: r.type_code, name: r.type_name, isFormal: Boolean(r.is_formal) },
    lineStyle: r.is_formal ? 'SOLID' : 'DOTTED',
    isPrimary: Boolean(r.is_primary),
    origin: r.origin,
    scope: {
      ...scope,
      isGeneral: r.scope_type === 'GENERAL',
      phrase,
    },
  };
}

/* ── responsibilities ───────────────────────────────────────────────────── */

/**
 * What one of the caller's jobs makes them responsible for, as the resolved
 * content — the same resolution a Role JD and a Responsibility Profile are
 * rendered from, so the screen and the document a person is handed can never
 * disagree (plan §17.1).
 *
 * It keeps the KRA grouping and the `additional` bucket separate, because an
 * ungrouped responsibility must never vanish, and it says out loud when a
 * section is empty BECAUSE NOTHING HAS BEEN WRITTEN YET (plan §17.5 — Karni's
 * 63 roles have no KRAs at all today). "This has not been written down yet" and
 * "you have no responsibilities" are different sentences and the second one is
 * insulting as well as wrong.
 */
function shapeResponsibilities(resolved) {
  const item = (i) => ({
    key: i.key,
    name: i.name,
    description: i.description ?? null,
    responsibilityClass: i.responsibilityClass ?? null,
    origin: i.origin,
    isSpecificToThisSeat: i.origin !== 'ROLE',
    // The role says it and this seat does it differently (a different target,
    // say). Additive, 2026-10-10: the grouped view marks it "Changed for this seat".
    isChangedForThisSeat: i.overridden === true,
    notes: i.notes ?? null,
  });
  const kpi = (i) => ({
    key: i.key,
    name: i.name,
    targetText: i.targetText ?? null,
    frequency: i.frequency ?? null,
    origin: i.origin,
    isChangedForThisSeat: i.overridden === true,
  });

  const areas = (resolved.kras ?? []).map((k) => ({
    key: k.key,
    name: k.name,
    description: k.description ?? null,
    weightPercent: k.weightPercent ?? null,
    origin: k.origin,
    responsibilities: (k.responsibilities ?? []).map(item),
    measures: (k.kpis ?? []).map(kpi),
  }));

  const additional = {
    responsibilities: (resolved.additional?.responsibilities ?? []).map(item),
    measures: (resolved.additional?.kpis ?? []).map(kpi),
  };

  const total = resolved.counts.responsibilities + resolved.counts.kpis + resolved.counts.kras;

  return {
    asOf: resolved.asOf,
    rolePurpose: resolved.role?.rolePurpose ?? null,
    areas,
    additional,
    counts: {
      areas: areas.length,
      responsibilities: resolved.counts.responsibilities,
      measures: resolved.counts.kpis,
    },
    /**
     * Nothing written yet is a fact about the DATA, not about the person. The
     * screen prints this sentence instead of an empty list.
     */
    emptyBecauseUnwritten: total === 0,
    skills: (resolved.skills ?? []).map((s) => ({ name: s.name, text: s.text ?? null })),
    authorities: (resolved.authorities ?? []).map((a) => ({ name: a.name, text: a.text ?? null })),
  };
}

/* ── the one public read ────────────────────────────────────────────────── */

/**
 * The signed-in person's place in the organisation.
 *
 * `ctx` is `lib/http.js`'s `{ companyId, userId }` — both from the token. There
 * is deliberately no third argument naming a person.
 *
 * Returns `{ linked: false }` rather than a 404 when the login has no employee
 * row. That is not an error: most logins on this platform are administrators
 * who were never imported as employees, and an HR admin clicking "My place"
 * deserves a sentence, not a red error panel.
 */
export async function myPlace(db, ctx, { on, canSeePii = false } = {}) {
  const { companyId, userId } = ctx;
  const asOf = dateText(on) || today();

  const [[employee]] = await db.query(EMPLOYEE_BY_USER, [companyId, userId]);
  if (!employee) {
    return {
      asOf,
      linked: false,
      reason: 'This login is not linked to an employee record, so there is no place in the '
        + 'organisation to show. An HR administrator can link it on the employee\'s record.',
      me: null,
      seats: [],
      reportsTo: [],
      reports: [],
      peers: [],
      pii: { included: canSeePii, note: null },
    };
  }

  const [assignments] = await db.query(MY_ASSIGNMENTS, [companyId, employee.id, asOf, asOf]);
  const assignmentIds = assignments.map((a) => a.id);
  const contexts = await contextsFor(db, companyId, assignmentIds);

  // ── reporting and content, per job. A person may hold several at once
  //    (plan §2 rule 5 and the Karni data: "Ram Babu does three jobs").
  const seats = [];
  const reportsTo = [];
  for (const a of assignments) {
    const seat = {
      assignmentId: a.id,
      label: a.assignment_title || a.role_title || a.position_title || 'This work',
    };

    const resolved = await resolveReporting(db, companyId, a.id, { on: asOf });
    const lines = resolved.relationships.map((r) => selfRelationship(r, seat, canSeePii));
    reportsTo.push(...lines);

    let responsibilities = null;
    try {
      responsibilities = shapeResponsibilities(
        await resolveContent(db, companyId, { workAssignmentId: a.id, on: asOf }),
      );
    } catch {
      // A job whose role was retired or whose content cannot resolve must not
      // take the whole screen down — the person still needs to see their seat
      // and their manager. The absence is reported, not swallowed into a zero.
      responsibilities = null;
    }

    seats.push({
      ...seat,
      roleTitle: a.role_title ?? null,
      positionCode: a.position_code ?? null,
      positionTitle: a.position_title ?? null,
      allocationPercent: a.allocation_percent == null ? null : Number(a.allocation_percent),
      isPrimary: Boolean(a.is_primary),
      status: a.status,
      effectiveFrom: dateText(a.effective_from),
      effectiveTo: dateText(a.effective_to),
      departmentName: a.department_name ?? null,
      locationName: a.location_name ?? null,
      shift: a.shift_code
        ? {
          code: a.shift_code,
          name: a.shift_name,
          // The general shift has no times on purpose (seed.sql §6), so this
          // is null for staff and a real window for the plant's D and N.
          startTime: a.start_time == null ? null : String(a.start_time).slice(0, 5),
          endTime: a.end_time == null ? null : String(a.end_time).slice(0, 5),
          crossesMidnight: Boolean(a.crosses_midnight),
        }
        : null,
      workContexts: contexts.get(a.id) ?? [],
      reportsTo: lines,
      responsibilities,
      /** Said out loud so the screen can explain a shortfall rather than hide it. */
      hasNoManager: lines.length === 0,
    });
  }

  // ── the team, in four queries: who reports into me, and who sits beside me
  const mySeatIds = [...new Set(assignments.map((a) => a.position_id).filter((x) => x != null))];
  const managerEmployeeIds = [...new Set(
    reportsTo.map((r) => r.person?.employeeId).filter((x) => x != null),
  )];
  const managerSeatIds = [...new Set(
    reportsTo.filter((r) => r.origin === 'POSITION')
      .map((r) => r.seatPositionId)
      .filter((x) => x != null),
  )];

  const teamMap = await reportsInto(
    db,
    companyId,
    {
      // Me as a manager, plus my managers — the first answers "who reports to
      // me", the second answers "who else reports to my manager".
      managerEmployeeIds: [...new Set([employee.id, ...managerEmployeeIds])],
      managerPositionIds: [...new Set([...mySeatIds, ...managerSeatIds])],
    },
    asOf,
  );

  // Who reports to me: lines naming me as a person, plus lines naming one of my
  // seats. One person can arrive by both routes; the assignment is the identity.
  const reportsSeen = new Map();
  const collect = (key) => {
    for (const r of teamMap.get(key) ?? []) {
      if (r.employee_id === employee.id) continue;        // never myself
      const m = teamMember(r, canSeePii);
      const prior = reportsSeen.get(m.assignmentId);
      // Prefer the line a person would call their real one: primary first, then
      // a formal type over a dotted one.
      if (!prior
        || (!prior.isPrimary && m.isPrimary)
        || (!prior.relationshipType.isFormal && m.relationshipType.isFormal && !prior.isPrimary)) {
        reportsSeen.set(m.assignmentId, m);
      }
    }
  };
  collect(`E:${employee.id}`);
  for (const pid of mySeatIds) collect(`P:${pid}`);

  // Peers: same manager, same relationship type, same scope. Matching on the
  // scope is what stops the night-shift crew being shown as peers of the day
  // crew just because both answer to the same incharge.
  const peersSeen = new Map();
  for (const line of reportsTo) {
    const keys = [];
    if (line.person?.employeeId != null) keys.push(`E:${line.person.employeeId}`);
    if (line.seatPositionId != null) keys.push(`P:${line.seatPositionId}`);
    for (const key of keys) {
      for (const r of teamMap.get(key) ?? []) {
        if (r.employee_id === employee.id) continue;
        if (assignmentIds.includes(r.assignment_id)) continue;
        if (String(r.type_code) !== line.relationshipType.code) continue;
        if (String(r.scope_key) !== String(line.scopeKey)) continue;
        const m = teamMember(r, canSeePii);
        if (!peersSeen.has(m.assignmentId)) {
          peersSeen.set(m.assignmentId, { ...m, sharedManager: line.person?.name ?? line.seatTitle ?? null });
        }
      }
    }
  }

  const reports = [...reportsSeen.values()].sort(
    (a, b) => String(a.person.name).localeCompare(String(b.person.name)),
  );
  const peers = [...peersSeen.values()].sort(
    (a, b) => String(a.person.name).localeCompare(String(b.person.name)),
  );

  // Fill in the contact blocks the resolver could not supply. One query, and
  // only for a caller who is allowed to see them.
  if (canSeePii) {
    const ids = new Set();
    for (const r of reportsTo) {
      if (r.person?.employeeId != null) ids.add(r.person.employeeId);
      for (const m of r.alsoHeldBy) if (m.employeeId != null) ids.add(m.employeeId);
    }
    const contacts = await contactsFor(db, companyId, [...ids]);
    for (const r of reportsTo) {
      if (r.person && contacts.has(r.person.employeeId)) r.person.contact = contacts.get(r.person.employeeId);
      for (const m of r.alsoHeldBy) if (contacts.has(m.employeeId)) m.contact = contacts.get(m.employeeId);
    }
  }

  const primarySeat = seats.find((s) => s.isPrimary) ?? seats[0] ?? null;

  return {
    asOf,
    linked: true,

    me: {
      employeeId: employee.id,
      employeeCode: employee.employee_code,
      fullName: employee.full_name,
      gender: employee.gender ?? null,
      dateOfJoining: dateText(employee.date_of_joining),
      employmentType: employee.employment_type,
      employmentStatus: employee.employment_status,
      exitDate: dateText(employee.exit_date),
      contractorName: employee.contractor_name ?? null,
      hasPhoto: Boolean(employee.has_photo),
      departmentName: primarySeat?.departmentName ?? null,
      locationName: primarySeat?.locationName ?? null,
      /**
       * The caller's OWN contact block, always. It is their data; withholding a
       * person's own phone number from them is not privacy, it is a bug.
       * Everyone else in this payload is a name and a seat unless the caller
       * also holds cf_hrms_people_pii.
       */
      contact: personContact(employee),
    },

    seats,
    reportsTo,
    reports,
    peers,

    summary: {
      seatCount: seats.length,
      managerCount: reportsTo.length,
      scopedManagerCount: reportsTo.filter((r) => !r.scope.isGeneral).length,
      dottedManagerCount: reportsTo.filter((r) => r.lineStyle === 'DOTTED').length,
      vacantManagerSeats: reportsTo.filter((r) => r.vacant).length,
      reportCount: reports.length,
      peerCount: peers.length,
      responsibilityCount: seats.reduce(
        (t, s) => t + (s.responsibilities?.counts.responsibilities ?? 0), 0,
      ),
    },

    /**
     * What the caller was and was not allowed to see, said in the payload. A
     * screen that silently shows no phone numbers looks broken; one that says
     * "contact details are not shown here" is understood.
     */
    pii: {
      included: canSeePii,
      note: canSeePii
        ? null
        : 'Other people are shown by name and job only. Phone numbers, email addresses '
          + 'and personal details are not shown here.',
    },
  };
}

export default { myPlace, scopePhrase };
