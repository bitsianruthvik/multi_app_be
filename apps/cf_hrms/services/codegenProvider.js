/**
 * codegenProvider.js — how employees and hiring letters take part in the code
 * generator (apps/cf_erp/modules/codegen, reused by import: the module knows
 * tokens and conditions, this file knows what a department and a joining date
 * are). Contract: TM/CF_HRMS_HIRING_SPEC.md §1.2.
 *
 *   hrms_employee   hrms_employees.employee_code
 *   hrms_hiring     hrms_hirings.ref_no — the offer and the appointment letter share it
 *
 * Imported for its side effect of registering the two entity types. The
 * module's registry throws on a second registration, so the registration is
 * guarded by what the registry already holds — this file may be reached from
 * app.js, from a service and from a test in one process, and under two
 * spellings of its path on Windows.
 *
 * THE GUIDE. Like cf_erp's providers, every token and condition carries its own
 * plain words (`phrase`, `help`, `example`) and the Code formats screen shows
 * them as written.
 */
import { registerEntity, listEntities } from '../../cf_erp/modules/codegen/index.js';

export const EMPLOYEE_ENTITY = 'hrms_employee';
export const HIRING_ENTITY = 'hrms_hiring';

const EMPLOYMENT_TYPES = ['EMPLOYEE', 'CONTRACT', 'TRAINEE', 'CONSULTANT', 'OTHER'];

const pad2 = (n) => String(n).padStart(2, '0');

/** A date's parts as codes print them. `fy` is the Indian financial year, April to March: 20 Aug 2026 is 26-27. */
export function dateParts(value) {
  const s = value instanceof Date
    ? `${value.getFullYear()}-${pad2(value.getMonth() + 1)}-${pad2(value.getDate())}`
    : String(value ?? '').slice(0, 10);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const start = month >= 4 ? year : year - 1;
  return {
    yyyy: String(year),
    yy: String(year).slice(-2),
    mm: pad2(month),
    fy: `${String(start).slice(-2)}-${String(start + 1).slice(-2)}`,
  };
}

const todayText = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
};

/**
 * The department, location, role and shift a code may print, in ONE read (a
 * round trip to production costs ~49 ms). Every department of the company comes
 * back, because "is under" walks up the tree.
 */
async function loadFacts(db, companyId, { departmentId = null, locationId = null, roleId = null, shiftId = null }) {
  const [rows] = await db.query(
    `SELECT 'D' AS kind, id, code, name, parent_department_id AS parent_id
       FROM hrms_departments WHERE company_id = ? AND deleted_at IS NULL
     UNION ALL
     SELECT 'L', id, code, name, NULL FROM hrms_locations WHERE company_id = ? AND id = ? AND deleted_at IS NULL
     UNION ALL
     SELECT 'R', id, role_code, title, NULL FROM hrms_roles WHERE company_id = ? AND id = ? AND deleted_at IS NULL
     UNION ALL
     SELECT 'S', id, code, name, NULL FROM hrms_shifts WHERE company_id = ? AND id = ? AND deleted_at IS NULL`,
    [companyId, companyId, Number(locationId) || 0, companyId, Number(roleId) || 0, companyId, Number(shiftId) || 0],
  );
  const departments = new Map(rows.filter((r) => r.kind === 'D').map((r) => [r.id, r]));
  const one = (kind) => rows.find((r) => r.kind === kind) ?? null;

  // The department and everything above it, nearest first. The bound guards a loop in bad data.
  const chain = [];
  for (let d = departments.get(Number(departmentId)) ?? null, i = 0; d && i < 64; i += 1) {
    chain.push(d);
    d = d.parent_id == null ? null : departments.get(d.parent_id) ?? null;
  }
  // Depth from the top of the tree: a root department is 0.
  const depthOf = new Map(chain.map((d, i) => [d.id, chain.length - 1 - i]));
  return { department: chain[0] ?? null, depthOf, location: one('L'), role: one('R'), shift: one('S') };
}

const listOf = (cond) => (cond.operator === 'in' ? cond.value.split(',').map((s) => s.trim()).filter(Boolean) : [cond.value.trim()]);

// ---- Employees ---------------------------------------------------------------
// A code is issued once, when the employee is created, and never changes
// (services/codeService.js). What it may print is where the person starts work:
// the department, location, role and shift of the position they are appointed
// to, and the date they join. An employee created without a position has none
// of the first four — a rule that prints one then waits for it.

const EMPLOYEE_TOKENS = [
  {
    key: 'department.code', label: 'Department code', available: true,
    phrase: 'the department code', example: 'QC', help: 'The code of the department the person joins. Empty when the employee is created without a position.',
  },
  {
    key: 'department.name', label: 'Department name', available: true,
    phrase: 'the department name', example: 'Quality', help: 'The name of the department the person joins. Long for a code — give it a length limit.',
  },
  {
    key: 'location.code', label: 'Location code', available: true,
    phrase: 'the location code', example: 'U2', help: 'The code of the location the person is posted at. Empty when the position has no location.',
  },
  {
    key: 'location.name', label: 'Location name', available: true,
    phrase: 'the location name', example: 'Unit 2', help: 'The name of the location the person is posted at.',
  },
  {
    key: 'role.code', label: 'Role code', available: true,
    phrase: 'the role code', example: 'R014', help: 'The code of the role the person is appointed to.',
  },
  {
    key: 'shift.code', label: 'Shift code', available: true,
    phrase: 'the shift code', example: 'D', help: 'The code of the shift of the position the person is appointed to — G, D or N.',
  },
  {
    key: 'joining.yy', label: 'Joining year, two digits', available: true,
    phrase: 'the joining year (two digits)', example: '26', help: 'The last two digits of the year the person joins.',
  },
  {
    key: 'joining.yyyy', label: 'Joining year', available: true,
    phrase: 'the joining year', example: '2026', help: 'The year the person joins.',
  },
  {
    key: 'joining.mm', label: 'Joining month', available: true,
    phrase: 'the joining month', example: '08', help: 'The month the person joins, as two digits.',
  },
  {
    key: 'joining.fy', label: 'Financial year of joining', available: true,
    phrase: 'the financial year of joining', example: '26-27', help: 'The financial year the joining date falls in, April to March: 20 August 2026 is 26-27.',
  },
  {
    key: 'employment.type', label: 'Employment type', available: true,
    phrase: 'the employment type', example: 'EMPLOYEE', help: `One of ${EMPLOYMENT_TYPES.join(', ')}. Give it a length limit to print a letter or two.`,
  },
];

const EMPLOYEE_CONDITIONS = [
  {
    key: 'department', label: 'Department', operators: ['under', 'eq', 'in'], valueKind: 'department',
    phrase: 'the department',
    help: '“Is under” holds for the department you choose and every department below it, and scores more the deeper that department is: a top department 1, one below it 2. “Is” names exact departments and scores more than any “is under”.',
  },
  {
    key: 'location', label: 'Location', operators: ['eq', 'in'], valueKind: 'location',
    phrase: 'the location', help: 'Holds for people posted at the locations you choose. Scores 1 point.',
  },
  {
    key: 'employment.type', label: 'Employment type', operators: ['eq', 'in'], valueKind: 'enum', values: EMPLOYMENT_TYPES,
    phrase: 'the employment type', help: 'Holds for the employment types you choose. Scores 1 point.',
  },
];

async function employeeContext(db, companyId, draft = {}) {
  const facts = await loadFacts(db, companyId, draft);
  const joining = dateParts(draft.joiningDate) ?? dateParts(todayText());
  const employmentType = EMPLOYMENT_TYPES.includes(String(draft.employmentType ?? '').toUpperCase())
    ? String(draft.employmentType).toUpperCase() : 'EMPLOYEE';
  const ownDepth = facts.department ? facts.depthOf.get(facts.department.id) : 0;

  return {
    get(key) {
      switch (key) {
        case 'department.code': return facts.department?.code ?? null;
        case 'department.name': return facts.department?.name ?? null;
        case 'location.code': return facts.location?.code ?? null;
        case 'location.name': return facts.location?.name ?? null;
        case 'role.code': return facts.role?.code ?? null;
        case 'shift.code': return facts.shift?.code ?? null;
        case 'joining.yy': return joining.yy;
        case 'joining.yyyy': return joining.yyyy;
        case 'joining.mm': return joining.mm;
        case 'joining.fy': return joining.fy;
        case 'employment.type': return employmentType;
        default: return null;
      }
    },
    /**
     * A location or an employment type is 1. "Under" a department is 1 + that
     * department's depth; naming the exact department is one more than the
     * deepest "under" this person could match, so it always wins.
     */
    test(cond) {
      const values = listOf(cond);
      switch (cond.token_key) {
        case 'department': {
          if (cond.operator === 'under') {
            const id = Number(values[0]);
            return { ok: facts.depthOf.has(id), weight: 1 + (facts.depthOf.get(id) ?? 0) };
          }
          return { ok: !!facts.department && values.map(Number).includes(facts.department.id), weight: 2 + ownDepth };
        }
        case 'location': return { ok: !!facts.location && values.map(Number).includes(facts.location.id), weight: 1 };
        case 'employment.type': return { ok: values.includes(employmentType), weight: 1 };
        default: return { ok: false, weight: 0 };
      }
    },
  };
}

const idsExist = async (db, companyId, table, ids) => {
  const [rows] = await db.query(`SELECT id FROM ${table} WHERE company_id = ? AND deleted_at IS NULL AND id IN (?)`, [companyId, ids]);
  return rows.length === new Set(ids).size;
};

const employeeProvider = {
  label: 'Employee codes',
  tokens: EMPLOYEE_TOKENS,
  tokenPatterns: [],
  conditionTokens: EMPLOYEE_CONDITIONS,
  async validateToken(db, companyId, key) {
    return EMPLOYEE_TOKENS.some((t) => t.key === key) ? null : `"${key}" is not a value an employee code can insert.`;
  },
  async validateCondition(db, companyId, cond) {
    const values = listOf(cond);
    if (cond.token_key === 'employment.type') {
      return values.every((v) => EMPLOYMENT_TYPES.includes(v)) ? null : `Employment type is one of ${EMPLOYMENT_TYPES.join(', ')}.`;
    }
    if (!values.length || values.some((v) => !/^\d+$/.test(v))) return 'Choose from the list.';
    if (cond.token_key === 'department') {
      return (await idsExist(db, companyId, 'hrms_departments', values.map(Number))) ? null : 'That department does not exist.';
    }
    if (cond.token_key === 'location') {
      return (await idsExist(db, companyId, 'hrms_locations', values.map(Number))) ? null : 'That location does not exist.';
    }
    return null;
  },
  /** A saved employee: where their primary work is today, and the day they joined. */
  async loadContext(db, companyId, entityId) {
    const [[e]] = await db.query(
      `SELECT e.id, e.date_of_joining, e.employment_type
         FROM hrms_employees e WHERE e.company_id = ? AND e.id = ? AND e.deleted_at IS NULL`,
      [companyId, entityId],
    );
    if (!e) { const err = new Error('Employee not found.'); err.status = 404; throw err; }
    const [[a]] = await db.query(
      `SELECT wa.department_id, wa.location_id, wa.role_id, wa.default_shift_id
         FROM hrms_work_assignments wa
        WHERE wa.company_id = ? AND wa.employee_id = ? AND wa.deleted_at IS NULL AND wa.status <> 'ENDED'
        ORDER BY wa.is_primary DESC, wa.effective_from DESC, wa.id DESC LIMIT 1`,
      [companyId, entityId],
    );
    return employeeContext(db, companyId, {
      departmentId: a?.department_id, locationId: a?.location_id, roleId: a?.role_id, shiftId: a?.default_shift_id,
      joiningDate: e.date_of_joining, employmentType: e.employment_type,
    });
  },
  /** draft: { departmentId?, locationId?, roleId?, shiftId?, joiningDate?, employmentType? } */
  async draftContext(db, companyId, draft) {
    return employeeContext(db, companyId, draft ?? {});
  },
};

// ---- Letter reference numbers ------------------------------------------------
// One number per hiring, issued with its first offer letter and printed on the
// appointment letter too. The date parts are the LETTER's date, so a pattern of
// HR/{fy}/### restarts every April without anybody resetting a counter.

const HIRING_TOKENS = [
  {
    key: 'fy', label: 'Financial year of the letter', available: true,
    phrase: 'the financial year', example: '26-27', help: 'The financial year the letter date falls in, April to March: 20 August 2026 is 26-27.',
  },
  {
    key: 'yy', label: 'Year of the letter, two digits', available: true,
    phrase: 'the year (two digits)', example: '26', help: 'The last two digits of the year of the letter date.',
  },
  {
    key: 'yyyy', label: 'Year of the letter', available: true,
    phrase: 'the year', example: '2026', help: 'The year of the letter date.',
  },
  {
    key: 'mm', label: 'Month of the letter', available: true,
    phrase: 'the month', example: '08', help: 'The month of the letter date, as two digits.',
  },
  {
    key: 'department.code', label: 'Department code', available: true,
    phrase: 'the department code', example: 'QC', help: 'The code of the department of the position being filled.',
  },
  {
    key: 'location.code', label: 'Location code', available: true,
    phrase: 'the location code', example: 'U2', help: 'The code of the location of the position being filled. Empty when the position has no location.',
  },
];

async function hiringContext(db, companyId, draft = {}) {
  const facts = await loadFacts(db, companyId, draft);
  const date = dateParts(draft.letterDate) ?? dateParts(todayText());
  return {
    get(key) {
      switch (key) {
        case 'fy': return date.fy;
        case 'yy': return date.yy;
        case 'yyyy': return date.yyyy;
        case 'mm': return date.mm;
        case 'department.code': return facts.department?.code ?? null;
        case 'location.code': return facts.location?.code ?? null;
        default: return null;
      }
    },
    test() { return { ok: false, weight: 0 }; },
  };
}

const hiringProvider = {
  label: 'Letter reference numbers',
  tokens: HIRING_TOKENS,
  tokenPatterns: [],
  conditionTokens: [],
  async validateToken(db, companyId, key) {
    return HIRING_TOKENS.some((t) => t.key === key) ? null : `"${key}" is not a value a letter reference can insert.`;
  },
  async validateCondition() {
    return 'Letter reference numbers take no conditions.';
  },
  async loadContext(db, companyId, entityId) {
    const [[h]] = await db.query(
      `SELECT h.offer_date, p.department_id, p.location_id
         FROM hrms_hirings h
         JOIN hrms_positions p ON p.company_id = h.company_id AND p.id = h.position_id
        WHERE h.company_id = ? AND h.id = ? AND h.deleted_at IS NULL`,
      [companyId, entityId],
    );
    if (!h) { const err = new Error('Hiring not found.'); err.status = 404; throw err; }
    return hiringContext(db, companyId, { letterDate: h.offer_date, departmentId: h.department_id, locationId: h.location_id });
  },
  /** draft: { letterDate?, departmentId?, locationId? } */
  async draftContext(db, companyId, draft) {
    return hiringContext(db, companyId, draft ?? {});
  },
};

const registered = new Set(listEntities().map((e) => e.entityType));
if (!registered.has(EMPLOYEE_ENTITY)) registerEntity(EMPLOYEE_ENTITY, employeeProvider);
if (!registered.has(HIRING_ENTITY)) registerEntity(HIRING_ENTITY, hiringProvider);
