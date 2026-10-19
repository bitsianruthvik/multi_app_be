/**
 * access.js — THE CATALOGUE OF RIGHTS. (TM/CF_HRMS_HIRING_SPEC.md §12.1, §12.2.)
 *
 * One tag = one thing a person may do. Eleven areas, each with up to four rights
 * (view, edit, remove, upload), and seven named rights. Everything else in the
 * app that speaks of rights reads this file: the `PERM` object the routes are
 * guarded with (lib/http.js), the ready-made roles, the migration of the old
 * tags (scripts/setup-access.mjs), the catalogue the screen draws
 * (GET /access/catalog) and the generated route table (ACCESS.md).
 *
 * Pure data and pure functions. No database, no request.
 */

export const RIGHTS = ['view', 'edit', 'remove', 'upload'];
const RIGHT_LABEL = { view: 'View', edit: 'Add and change', remove: 'Remove', upload: 'Upload from Excel' };

/** The areas, in the order the screen lists them. `rights` are the ones that exist. */
export const AREAS = [
  { key: 'org', label: 'Organisation', screens: ['Departments', 'Department labels', 'Locations'], rights: ['view', 'edit', 'remove', 'upload'] },
  { key: 'roles', label: 'Roles', screens: ['Roles', 'Job content of a role', 'Libraries'], rights: ['view', 'edit', 'remove', 'upload'] },
  {
    key: 'positions', label: 'Positions',
    screens: ['Positions', 'Org chart', 'Job content of a position', 'Shift of a position', 'Reporting lines', 'Moving a person'],
    rights: ['view', 'edit', 'remove', 'upload'],
  },
  { key: 'employees', label: 'Employees', screens: ['Employees', 'Their documents and identifiers', 'Positions held'], rights: ['view', 'edit', 'upload'] },
  { key: 'hiring', label: 'Hiring', screens: ['Hiring, every step except the final create'], rights: ['view', 'edit'] },
  { key: 'documents', label: 'Documents', screens: ['Job descriptions', 'Responsibility profiles'], rights: ['view', 'edit', 'remove'] },
  { key: 'time', label: 'Time', screens: ['Shifts', 'Holidays'], rights: ['view', 'edit', 'remove', 'upload'] },
  { key: 'leave', label: 'Leave', screens: ['Leave policies', 'Leave requests', 'Leave balances'], rights: ['view', 'edit', 'remove'] },
  { key: 'setup', label: 'Setup', screens: ['Code formats', 'Letters', 'Reporting types', 'Performance settings'], rights: ['view', 'edit', 'remove'] },
  // Spec §18 (2026-10-15). Added after companies were set up: scripts/setup-access.mjs grants it to
  // the ready-made roles of an existing company once (LATE_AREAS below), and nothing else.
  { key: 'performance', label: 'Performance', screens: ['Plans', 'A person’s plan', 'Periods', 'Actuals', 'Reviews and check-ins', 'Actions'], rights: ['view', 'edit', 'remove', 'upload'] },
  // Spec §25.2 (2026-10-19): running payroll. Salary AMOUNTS also need the named right cf_hrms_pay_view.
  // A late area like performance: setup-access grants it to the ready-made roles of an existing company once.
  { key: 'payroll', label: 'Payroll', screens: ['Payroll runs', 'Salaries', 'Salary structures', 'Pay components', 'Statutory settings'], rights: ['view', 'edit', 'remove', 'upload'] },
  // Spec §28 (2026-10-19): attendance — the day board, the muster, requests, penalties, policies, devices,
  // imports, closing a month. A late area: setup-access grants it to the ready-made roles of an existing company once.
  { key: 'attendance', label: 'Attendance', screens: ['Today', 'Month (muster)', 'Requests', 'Penalties', 'Attendance policies', 'Devices and API keys', 'Imports', 'Close month'], rights: ['view', 'edit', 'remove', 'upload'] },
];

export const areaTag = (area, right) => `cf_hrms_${area}_${right}`;

/** The named rights. All but the self view are `sensitive`: each of those is a decision, not a screen. */
export const NAMED = [
  { key: 'employeeCreate', tag: 'cf_hrms_employee_create', label: 'Create an employee', hint: 'The appointment step of a hiring: it creates the employee and issues the employee code.' },
  { key: 'employeeClose', tag: 'cf_hrms_employee_close', label: 'Close an employee', hint: 'Start, change, cancel and close a person’s leaving.' },
  { key: 'employeeBulkAdd', tag: 'cf_hrms_employee_bulk_add', label: 'Add employees from Excel', hint: 'The Excel upload that adds employees and skips hiring.' },
  { key: 'contactView', tag: 'cf_hrms_contact_view', label: 'See contact details', hint: 'Phone, email and address, and statutory identifiers in full.' },
  { key: 'payView', tag: 'cf_hrms_pay_view', label: 'See pay', hint: 'CTC and everything made from it: the hiring terms, the letters and their signed copies.' },
  { key: 'accessManage', tag: 'cf_hrms_access_manage', label: 'Manage logins and access', hint: 'Create logins, change what each access role may do, disable a login, reset a password.' },
  { key: 'selfView', tag: 'cf_hrms_self_view', label: 'See their own place', hint: 'A person’s own position, managers, team and responsibilities — and the team rule of a manager.' },
];

/** Every tag of the model, areas first. */
export const ALL_TAGS = [
  ...AREAS.flatMap((a) => a.rights.map((r) => areaTag(a.key, r))),
  ...NAMED.map((n) => n.tag),
];
const KNOWN = new Set(ALL_TAGS);
export const isKnownTag = (tag) => KNOWN.has(tag);

/** What a feature row is called (features.feature_name). */
export function tagName(tag) {
  const named = NAMED.find((n) => n.tag === tag);
  if (named) return `CF HRMS: ${named.label.toLowerCase()}`;
  for (const a of AREAS) for (const r of a.rights) if (areaTag(a.key, r) === tag) return `CF HRMS: ${a.label.toLowerCase()} — ${RIGHT_LABEL[r].toLowerCase()}`;
  return tag;
}

const views = (keys) => keys.map((k) => areaTag(k, 'view'));
const edits = (keys) => keys.map((k) => areaTag(k, 'edit'));
const named = (key) => NAMED.find((n) => n.key === key).tag;
const everyArea = AREAS.map((a) => a.key);

/**
 * The ready-made roles (spec §12.2). `platformName` is the `roles.name` the
 * role has — `admin` and `Employee` exist already; the Owner's is never
 * renamed, because the platform's bypass is on that name.
 */
export const TEMPLATES = [
  {
    key: 'OWNER', label: 'Owner', platformName: 'admin', scope: 'COMPANY', locked: true,
    description: 'Everything, including logins and access. Its rights cannot be reduced.',
    tags: [...ALL_TAGS],
  },
  {
    key: 'HR_MANAGER', label: 'HR manager', platformName: 'HR manager', scope: 'COMPANY', locked: false,
    description: 'Everything in HR — add, change, remove and upload — except logins and access.',
    tags: ALL_TAGS.filter((t) => t !== named('accessManage')),
  },
  {
    key: 'HR_EXECUTIVE', label: 'HR executive', platformName: 'HR executive', scope: 'COMPANY', locked: false,
    description: 'Sees everything; changes employees, hiring, positions, documents, performance and payroll; creates employees. Cannot remove, upload, change the setup or close an employee.',
    tags: [...views(everyArea), ...edits(['employees', 'hiring', 'positions', 'documents', 'performance', 'payroll', 'attendance']), named('employeeCreate'), named('contactView'), named('payView'), named('selfView')],
  },
  {
    key: 'DEPARTMENT_HEAD', label: 'Department head', platformName: 'Department head', scope: 'DEPARTMENT', locked: false,
    description: 'Sees the organisation and the people of their own department and below; changes the positions there.',
    tags: [...views(['org', 'roles', 'positions', 'employees', 'time', 'leave', 'performance', 'attendance']), ...edits(['positions', 'performance']), named('contactView'), named('selfView')],
  },
  {
    key: 'EMPLOYEE', label: 'Employee', platformName: 'Employee', scope: 'DEPARTMENT', locked: true,
    description: 'Their own place in the organisation, and nothing else.',
    tags: [named('selfView')],
  },
];
/**
 * Areas added AFTER companies were set up on the rights model. setup-access
 * gives a ready-made role its template only the first time (a role somebody
 * edited is left alone), so a company set up before an area existed would
 * never get it. `services/accessSetup.js` grants each ready-made role exactly
 * the tags of these areas its template holds — once per role and area, marked
 * in the audit log, so a right somebody later takes away is not handed back.
 */
export const LATE_AREAS = ['performance', 'payroll', 'attendance'];
export const lateAreaTags = (area) => {
  const a = AREAS.find((x) => x.key === area);
  return a ? a.rights.map((r) => areaTag(a.key, r)) : [];
};

export const templateOf = (key) => TEMPLATES.find((t) => t.key === String(key ?? '').toUpperCase()) ?? null;

export const SCOPES = ['COMPANY', 'DEPARTMENT'];

/**
 * The 14 old tags and what each becomes (spec §12.4 step 3). `cf_hrms_org_view`
 * and `cf_hrms_leave_view` keep their names with a narrower meaning; the rest
 * are read by nothing after this round.
 */
const T = (area, ...rights) => rights.map((r) => areaTag(area, r));
export const OLD_TAG_MAP = {
  cf_hrms_org_view: [...views(['org', 'roles', 'positions', 'time', 'setup'])],
  cf_hrms_org_manage: [...T('org', 'edit', 'remove', 'upload'), ...T('positions', 'edit', 'remove', 'upload'), ...T('time', 'edit', 'remove', 'upload'), ...T('setup', 'edit', 'remove')],
  cf_hrms_roles_manage: [...T('roles', 'edit', 'remove', 'upload')],
  cf_hrms_people_view: [...views(['employees', 'hiring'])],
  cf_hrms_people_manage: [...edits(['employees', 'hiring']), areaTag('employees', 'upload'), named('employeeCreate'), named('employeeClose')],
  cf_hrms_people_pii: [named('contactView'), named('payView')],
  cf_hrms_assignments_manage: [areaTag('positions', 'edit')],
  cf_hrms_documents_generate: [...T('documents', 'view', 'edit')],
  cf_hrms_leave_view: [areaTag('leave', 'view')],
  cf_hrms_leave_manage: [...T('leave', 'edit', 'remove')],
  // Since §28 `cf_hrms_attendance_view` is also the name of the attendance area's view right, so — like
  // leave_view — it keeps its name. attendance_manage stays mapped to nothing (it never opened a screen).
  cf_hrms_attendance_view: [areaTag('attendance', 'view')],
  cf_hrms_attendance_manage: [],
  cf_hrms_import_manage: [],
  cf_hrms_self_view: [named('selfView')],
};
export const OLD_TAGS = Object.keys(OLD_TAG_MAP);

/** The new tags a set of old ones maps to, in catalogue order. */
export function mapOldTags(oldTags) {
  const out = new Set();
  for (const t of oldTags) for (const n of OLD_TAG_MAP[t] ?? []) out.add(n);
  return ALL_TAGS.filter((t) => out.has(t));
}

/**
 * Is this a set a role may be saved with? Returns the problems, in words.
 *   - every tag must be one of the catalogue;
 *   - edit, remove or upload on an area without its view means nothing.
 */
export function tagSetProblems(tags) {
  const problems = [];
  if (!Array.isArray(tags)) return ['Send the rights as a list.'];
  const unknown = [...new Set(tags.filter((t) => !isKnownTag(t)))];
  if (unknown.length) problems.push(`${unknown.length === 1 ? 'This is not a right' : 'These are not rights'} of this app: ${unknown.map((t) => String(t).slice(0, 60)).join(', ')}.`);
  const have = new Set(tags);
  for (const a of AREAS) {
    const more = a.rights.filter((r) => r !== 'view' && have.has(areaTag(a.key, r)));
    if (more.length && !have.has(areaTag(a.key, 'view'))) {
      problems.push(`${a.label}: “${more.map((r) => RIGHT_LABEL[r].toLowerCase()).join('”, “')}” needs “view” as well. A person cannot change what they cannot see.`);
    }
  }
  return problems;
}

/** The set in catalogue order, without repeats. */
export const orderTags = (tags) => { const have = new Set(tags); return ALL_TAGS.filter((t) => have.has(t)); };

const list = (words) => (words.length <= 1 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`);

/**
 * "Sees everything · changes employees, hiring and positions · cannot remove" —
 * the sentence on a role's card. Written here so the screen never composes it.
 */
export function summaryOf(tags) {
  const have = new Set(tags);
  const areasWith = (right) => AREAS.filter((a) => a.rights.includes(right) && have.has(areaTag(a.key, right)));
  const possible = (right) => AREAS.filter((a) => a.rights.includes(right));
  const part = (right, verb, none) => {
    const got = areasWith(right);
    if (!got.length) return none;
    if (got.length === possible(right).length) return `${verb} everything`;
    return `${verb} ${list(got.map((a) => a.label.toLowerCase()))}`;
  };
  const parts = [];
  const sees = part('view', 'Sees', null);
  if (sees) parts.push(sees);
  else if (have.has(named('selfView'))) parts.push('Sees their own place only');
  else parts.push('Sees nothing');
  const changes = part('edit', 'changes', null);
  if (changes) parts.push(changes);
  if (areasWith('view').length) {
    const removes = part('remove', 'removes', 'cannot remove');
    parts.push(removes === 'removes everything' ? 'can remove' : removes.replace(/^removes /, 'removes in '));
  }
  const extras = [];
  if (have.has(named('employeeCreate'))) extras.push('creates employees');
  if (have.has(named('employeeClose'))) extras.push('closes employees');
  if (have.has(named('payView'))) extras.push('sees pay');
  if (have.has(named('accessManage'))) extras.push('manages logins and access');
  if (extras.length) parts.push(list(extras));
  return parts.join(' · ');
}

/** GET /access/catalog — the tick-box table, the named rights, the ready-made roles. */
export function catalog() {
  return {
    areas: AREAS.map((a) => ({
      key: a.key, label: a.label, screens: a.screens,
      rights: a.rights.map((r) => ({ right: r, tag: areaTag(a.key, r), label: RIGHT_LABEL[r] })),
    })),
    named: NAMED.map((n) => ({ tag: n.tag, label: n.label, hint: n.hint, sensitive: n.key !== 'selfView' })),
    // What a new role may be started from. Not the Owner (nobody else is everything) and not Employee (it is the self view alone).
    templates: TEMPLATES.filter((t) => !t.locked).map((t) => ({ key: t.key, label: t.label, scope: t.scope, tags: [...t.tags], description: t.description })),
  };
}

export default { RIGHTS, AREAS, NAMED, ALL_TAGS, TEMPLATES, LATE_AREAS, lateAreaTags, SCOPES, OLD_TAG_MAP, OLD_TAGS, areaTag, isKnownTag, tagName, templateOf, mapOldTags, tagSetProblems, orderTags, summaryOf, catalog };
