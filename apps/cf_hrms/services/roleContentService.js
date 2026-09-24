/**
 * roleContentService.js — roles, the six reusable content masters, and the ten
 * tables that attach that content to a role. Phase 3 of CF_HRMS_PLAN.md.
 *
 * THE IDEA THIS FILE EXISTS TO PROTECT (taxonomy §6, plan §2 rule 4):
 *
 *   KRA            an AREA of outcome the role is accountable for   "Production efficiency"
 *   Responsibility an activity or duty expected of the role         "Review machine-wise output"
 *   KPI            a measurable indicator                           "Plan achievement %"
 *
 * Three tables, three masters, three screens. They are never one text list, and
 * a role never gets free text typed into it: a definition is created once in a
 * master and then ASSIGNED to a role ("define once, assign to a context"). The
 * only thing the assignment row itself carries is context — order, weight,
 * mandatory, target, effective dates and the optional KRA it is grouped under.
 *
 * WHAT THE DATABASE CANNOT ENFORCE. TiDB runs with tidb_enable_check_constraint
 * off (plan §3), so every rule below lives here or nowhere:
 *
 *   1. A responsibility or KPI may only be grouped under a role_kra_assignment
 *      belonging to the SAME role. Nothing in the schema stops role 7's KPI from
 *      pointing at role 9's KRA; that would silently corrupt every JD.
 *   2. Effective-dated rows are ENDED, not overwritten (plan §2 rule 8). See
 *      `supersede` below for exactly what that means against a schema whose
 *      unique key allows only one live row per (role, definition).
 *   3. hrms_roles.title is unique per company — the org-chart import's
 *      "reuse a Role when titles match" rule depends on it (plan §3.2), so the
 *      conflict has to read as a sentence naming the role, not as a duplicate key.
 *   4. A master definition that is in use cannot be deleted. The refusal names
 *      the roles, because "it is in use" without saying where is a dead end.
 *
 * WHAT THIS FILE IS NOT. It returns the ROLE layer only. Position and work
 * assignment overlays (SUPPRESS → OVERRIDE → ADD, plan §2 rule 6) resolve in
 * services/contentResolver.js in a later phase. Every row this file returns
 * carries `layer: 'ROLE'` and its definition id so an overlay can be applied on
 * top without re-querying.
 */
import { invalid, conflict, notFound, assertNoProblems } from '../lib/errors.js';

// ---------------------------------------------------------------------------
// Vocabularies. These mirror models/init.sql; routes/index.js /meta serves the
// same lists to the screens so a picker never hard-codes an ENUM value.
// ---------------------------------------------------------------------------
const STATUSES = ['ACTIVE', 'INACTIVE'];
const ROLE_STATUSES = ['DRAFT', 'ACTIVE', 'RETIRED'];
const RESPONSIBILITY_CLASSES = ['OWNER', 'JOINT_OWNER', 'SUPPORT', 'BACKUP', 'APPROVER', 'REVIEWER', 'GENERIC'];
const MEASUREMENT_TYPES = ['NUMBER', 'PERCENTAGE', 'CURRENCY', 'DURATION', 'BOOLEAN', 'RATING', 'TEXT'];
const KPI_DIRECTIONS = ['HIGHER_BETTER', 'LOWER_BETTER', 'TARGET_RANGE', 'NEUTRAL'];
const FREQUENCIES = ['DAILY', 'WEEKLY', 'MONTHLY', 'QUARTERLY', 'YEARLY', 'ON_EVENT'];
const TARGET_OPERATORS = ['GTE', 'LTE', 'EQ', 'BETWEEN', 'INFO'];
const SKILL_TYPES = ['TECHNICAL', 'BEHAVIOURAL', 'SYSTEM', 'MACHINE', 'OTHER'];
const QUALIFICATION_TYPES = ['EDUCATION', 'CERTIFICATION', 'LICENCE', 'OTHER'];
const AUTHORITY_TYPES = ['APPROVE', 'DECIDE', 'STOP', 'ISSUE', 'ESCALATE', 'FINANCIAL', 'OTHER'];
const REQUIREMENT_LEVELS = ['REQUIRED', 'PREFERRED'];
const RELATIONSHIP_SCOPES = ['INTERNAL', 'EXTERNAL'];
const WORKING_CONDITION_TYPES = ['SHIFT', 'PHYSICAL', 'ENVIRONMENT', 'PPE', 'TRAVEL', 'OTHER'];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

const today = () => new Date().toISOString().slice(0, 10);

/** A DATE column as YYYY-MM-DD, whatever the driver handed back. */
function isoDate(value) {
  if (!value) return null;
  if (value instanceof Date) {
    const z = new Date(value.getTime() - value.getTimezoneOffset() * 60000);
    return z.toISOString().slice(0, 10);
  }
  return String(value).slice(0, 10);
}

/** The day before an ISO date — where a superseded row's window closes. */
function dayBefore(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** mysql2 gives JSON columns back parsed on some paths and as text on others. */
function readJson(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function str(value, max, problems, label, { required = false } = {}) {
  const s = value === null || value === undefined ? '' : String(value).trim();
  if (!s) {
    if (required) problems.push(`${label} is required.`);
    return required ? '' : null;
  }
  if (s.length > max) problems.push(`${label} is up to ${max} characters.`);
  return s;
}

function enumValue(value, allowed, problems, label, { required = false } = {}) {
  if (value === null || value === undefined || value === '') {
    if (required) problems.push(`${label} is required — one of ${allowed.join(', ')}.`);
    return required ? allowed[0] : null;
  }
  const v = String(value).trim().toUpperCase();
  if (!allowed.includes(v)) {
    problems.push(`${label} is one of ${allowed.join(', ')}.`);
    return null;
  }
  return v;
}

function decimal(value, problems, label, { min = 0, max = 100 } = {}) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) {
    problems.push(`${label} is a number between ${min} and ${max}.`);
    return null;
  }
  return n;
}

function bool(value, fallback = true) {
  if (value === null || value === undefined || value === '') return fallback ? 1 : 0;
  return value === true || value === 1 || value === '1' || value === 'true' ? 1 : 0;
}

function dateValue(value, problems, label) {
  if (value === null || value === undefined || value === '') return null;
  const s = String(value).slice(0, 10);
  if (!DATE_RE.test(s) || Number.isNaN(Date.parse(s))) {
    problems.push(`${label} is a date as YYYY-MM-DD.`);
    return null;
  }
  return s;
}

function intValue(value, problems, label) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isInteger(n)) {
    problems.push(`${label} is a whole number.`);
    return null;
  }
  return n;
}

/**
 * An audit row, in the same transaction as the write it describes. TiDB has no
 * triggers, and an audit row written after the commit is an audit row that can
 * go missing (lib/db.js).
 */
async function audit(db, c, entityType, entityId, action, before, after) {
  await db.query(
    `INSERT INTO hrms_audit_log (company_id, actor_user_id, entity_type, entity_id, action, before_json, after_json, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [c.companyId, c.userId, entityType, entityId, action,
      before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null, c.userId],
  );
}

// ===========================================================================
// 1. The six content masters
// ===========================================================================

/**
 * One descriptor per master. `usedBy` lists every assignment table that points
 * at it — that is what turns "in use" into "used by these seven roles", and
 * what makes the delete refusal readable.
 */
export const MASTERS = {
  kras: {
    label: 'KRA',
    plural: 'KRAs',
    table: 'hrms_kra_definitions',
    hasCode: true,
    nameMax: 200,
    usedBy: [{ table: 'hrms_role_kra_assignments', column: 'kra_definition_id' }],
    fields: (input, problems, { creating }) => {
      const out = {};
      if (creating || input.code !== undefined) out.code = str(input.code, 50, problems, 'Code');
      if (creating || input.name !== undefined) out.name = str(input.name, 200, problems, 'Name', { required: true });
      if (creating || input.description !== undefined) out.description = str(input.description, 4000, problems, 'Description');
      if (creating || input.category !== undefined) out.category = str(input.category, 100, problems, 'Category');
      if (creating || input.status !== undefined) out.status = enumValue(input.status ?? 'ACTIVE', STATUSES, problems, 'Status', { required: true });
      return out;
    },
    shape: (r) => ({ code: r.code, name: r.name, description: r.description, category: r.category, status: r.status }),
  },

  responsibilities: {
    label: 'Responsibility',
    plural: 'Responsibilities',
    table: 'hrms_responsibility_definitions',
    hasCode: true,
    nameMax: 250,
    usedBy: [{ table: 'hrms_role_responsibility_assignments', column: 'responsibility_definition_id' }],
    // `name` is deliberately NOT unique here (plan §3.2): the Karni import makes
    // ~595 of these from free text and two duties can share a short label.
    fields: (input, problems, { creating }) => {
      const out = {};
      if (creating || input.code !== undefined) out.code = str(input.code, 50, problems, 'Code');
      if (creating || input.name !== undefined) out.name = str(input.name, 250, problems, 'Name', { required: true });
      if (creating || input.description !== undefined) {
        out.description = str(input.description, 4000, problems, 'Statement', { required: true });
      }
      if (creating || input.responsibilityClass !== undefined) {
        out.responsibility_class = enumValue(input.responsibilityClass, RESPONSIBILITY_CLASSES, problems, 'Class');
      }
      if (creating || input.status !== undefined) out.status = enumValue(input.status ?? 'ACTIVE', STATUSES, problems, 'Status', { required: true });
      return out;
    },
    shape: (r) => ({
      code: r.code, name: r.name, description: r.description,
      responsibilityClass: r.responsibility_class, status: r.status,
    }),
  },

  kpis: {
    label: 'KPI',
    plural: 'KPIs',
    table: 'hrms_kpi_definitions',
    hasCode: true,
    nameMax: 250,
    usedBy: [{ table: 'hrms_role_kpi_assignments', column: 'kpi_definition_id' }],
    fields: (input, problems, { creating }) => {
      const out = {};
      if (creating || input.code !== undefined) out.code = str(input.code, 50, problems, 'Code');
      if (creating || input.name !== undefined) out.name = str(input.name, 250, problems, 'Name', { required: true });
      if (creating || input.description !== undefined) out.description = str(input.description, 4000, problems, 'Description');
      if (creating || input.measurementType !== undefined) {
        out.measurement_type = enumValue(input.measurementType ?? 'NUMBER', MEASUREMENT_TYPES, problems, 'Measurement type', { required: true });
      }
      if (creating || input.unit !== undefined) out.unit = str(input.unit, 50, problems, 'Unit');
      if (creating || input.direction !== undefined) out.direction = enumValue(input.direction, KPI_DIRECTIONS, problems, 'Direction');
      if (creating || input.formulaText !== undefined) out.formula_text = str(input.formulaText, 4000, problems, 'Formula');
      if (creating || input.dataSource !== undefined) out.data_source = str(input.dataSource, 250, problems, 'Data source');
      if (creating || input.defaultFrequency !== undefined) {
        out.default_frequency = enumValue(input.defaultFrequency, FREQUENCIES, problems, 'Frequency');
      }
      if (creating || input.status !== undefined) out.status = enumValue(input.status ?? 'ACTIVE', STATUSES, problems, 'Status', { required: true });
      return out;
    },
    shape: (r) => ({
      code: r.code, name: r.name, description: r.description,
      measurementType: r.measurement_type, unit: r.unit, direction: r.direction,
      formulaText: r.formula_text, dataSource: r.data_source,
      defaultFrequency: r.default_frequency, status: r.status,
    }),
  },

  skills: {
    label: 'Skill',
    plural: 'Skills',
    table: 'hrms_skill_definitions',
    hasCode: false,
    nameMax: 200,
    usedBy: [{ table: 'hrms_role_skill_requirements', column: 'skill_definition_id' }],
    fields: (input, problems, { creating }) => {
      const out = {};
      if (creating || input.name !== undefined) out.name = str(input.name, 200, problems, 'Name', { required: true });
      if (creating || input.skillType !== undefined) {
        out.skill_type = enumValue(input.skillType ?? 'TECHNICAL', SKILL_TYPES, problems, 'Skill type', { required: true });
      }
      if (creating || input.description !== undefined) out.description = str(input.description, 4000, problems, 'Description');
      if (creating || input.status !== undefined) out.status = enumValue(input.status ?? 'ACTIVE', STATUSES, problems, 'Status', { required: true });
      return out;
    },
    shape: (r) => ({ name: r.name, skillType: r.skill_type, description: r.description, status: r.status }),
  },

  qualifications: {
    label: 'Qualification',
    plural: 'Qualifications',
    table: 'hrms_qualification_definitions',
    hasCode: false,
    nameMax: 250,
    usedBy: [{ table: 'hrms_role_qualification_requirements', column: 'qualification_definition_id' }],
    fields: (input, problems, { creating }) => {
      const out = {};
      if (creating || input.name !== undefined) out.name = str(input.name, 250, problems, 'Name', { required: true });
      if (creating || input.qualificationType !== undefined) {
        out.qualification_type = enumValue(input.qualificationType ?? 'EDUCATION', QUALIFICATION_TYPES, problems, 'Qualification type', { required: true });
      }
      if (creating || input.description !== undefined) out.description = str(input.description, 4000, problems, 'Description');
      if (creating || input.status !== undefined) out.status = enumValue(input.status ?? 'ACTIVE', STATUSES, problems, 'Status', { required: true });
      return out;
    },
    shape: (r) => ({ name: r.name, qualificationType: r.qualification_type, description: r.description, status: r.status }),
  },

  authorities: {
    label: 'Authority',
    plural: 'Authorities',
    table: 'hrms_authority_definitions',
    hasCode: false,
    nameMax: 250,
    usedBy: [{ table: 'hrms_role_authority_assignments', column: 'authority_definition_id' }],
    fields: (input, problems, { creating }) => {
      const out = {};
      if (creating || input.name !== undefined) out.name = str(input.name, 250, problems, 'Name', { required: true });
      if (creating || input.authorityType !== undefined) {
        out.authority_type = enumValue(input.authorityType ?? 'APPROVE', AUTHORITY_TYPES, problems, 'Authority type', { required: true });
      }
      if (creating || input.description !== undefined) {
        out.description = str(input.description, 4000, problems, 'What the holder may do', { required: true });
      }
      if (creating || input.status !== undefined) out.status = enumValue(input.status ?? 'ACTIVE', STATUSES, problems, 'Status', { required: true });
      return out;
    },
    shape: (r) => ({ name: r.name, authorityType: r.authority_type, description: r.description, status: r.status }),
  },
};

export function masterOf(kind) {
  const m = MASTERS[kind];
  if (!m) throw notFound(`Master "${kind}"`);
  return m;
}

/** `COUNT(*)` over every assignment table pointing at this master, live rows of live roles only. */
function usageCountSql(master, alias = 'm') {
  return master.usedBy
    .map((u) => `(SELECT COUNT(DISTINCT a.role_id) FROM ${u.table} a
                   JOIN hrms_roles r ON r.company_id = a.company_id AND r.id = a.role_id AND r.deleted_at IS NULL
                  WHERE a.company_id = ${alias}.company_id AND a.${u.column} = ${alias}.id AND a.deleted_at IS NULL)`)
    .join(' + ');
}

export async function listMaster(db, companyId, kind) {
  const m = masterOf(kind);
  const [rows] = await db.query(
    `SELECT m.*, ${usageCountSql(m)} AS usage_count
       FROM ${m.table} m
      WHERE m.company_id = ? AND m.deleted_at IS NULL
      ORDER BY m.name`,
    [companyId],
  );
  return {
    kind,
    label: m.label,
    items: rows.map((r) => ({ id: r.id, ...m.shape(r), usageCount: Number(r.usage_count ?? 0) })),
  };
}

export async function getMaster(db, companyId, kind, id) {
  const m = masterOf(kind);
  const [[row]] = await db.query(
    `SELECT m.*, ${usageCountSql(m)} AS usage_count
       FROM ${m.table} m WHERE m.company_id = ? AND m.id = ? AND m.deleted_at IS NULL`,
    [companyId, id],
  );
  if (!row) throw notFound(m.label);
  return { id: row.id, ...m.shape(row), usageCount: Number(row.usage_count ?? 0) };
}

/**
 * The roles that use one definition. The delete refusal reads from this, and so
 * does the master screen's "used by 7 roles" chip — DESIGN_SYSTEM principle #4
 * says a record shows what points at it, and a count with no way to see the
 * seven is a dead end.
 */
export async function masterUsage(db, companyId, kind, id) {
  const m = masterOf(kind);
  const parts = m.usedBy.map((u) => `
    SELECT r.id, r.role_code, r.title, r.status
      FROM ${u.table} a
      JOIN hrms_roles r ON r.company_id = a.company_id AND r.id = a.role_id AND r.deleted_at IS NULL
     WHERE a.company_id = ? AND a.${u.column} = ? AND a.deleted_at IS NULL`);
  const params = m.usedBy.flatMap(() => [companyId, id]);
  const [rows] = await db.query(`${parts.join(' UNION ')} ORDER BY title`, params);
  return { kind, id, roles: rows.map((r) => ({ id: r.id, roleCode: r.role_code, title: r.title, status: r.status })) };
}

export async function createMasterItem(db, c, kind, input = {}) {
  const m = masterOf(kind);
  const problems = [];
  const fields = m.fields(input ?? {}, problems, { creating: true });
  assertNoProblems(problems);

  const cols = Object.keys(fields);
  const [r] = await db.query(
    `INSERT INTO ${m.table} (company_id, ${cols.join(', ')}, created_by) VALUES (?, ${cols.map(() => '?').join(', ')}, ?)`,
    [c.companyId, ...cols.map((k) => fields[k]), c.userId],
  );
  await audit(db, c, m.table, r.insertId, 'CREATE', null, fields);
  return getMaster(db, c.companyId, kind, r.insertId);
}

export async function updateMasterItem(db, c, kind, id, input = {}) {
  const m = masterOf(kind);
  const [[before]] = await db.query(`SELECT * FROM ${m.table} WHERE company_id = ? AND id = ? AND deleted_at IS NULL`, [c.companyId, id]);
  if (!before) throw notFound(m.label);

  const problems = [];
  const fields = m.fields(input ?? {}, problems, { creating: false });
  assertNoProblems(problems);
  const cols = Object.keys(fields);
  if (!cols.length) return getMaster(db, c.companyId, kind, id);

  await db.query(
    `UPDATE ${m.table} SET ${cols.map((k) => `${k} = ?`).join(', ')} WHERE company_id = ? AND id = ?`,
    [...cols.map((k) => fields[k]), c.companyId, id],
  );
  await audit(db, c, m.table, id, 'UPDATE', m.shape(before), fields);
  return getMaster(db, c.companyId, kind, id);
}

/**
 * Soft-deletes a definition — and refuses while any role still uses it, naming
 * the roles. Rule 4: a definition in use is not deletable. The way out is to
 * unassign it, or to set it INACTIVE so it stops appearing in pickers while the
 * roles that already carry it keep their content.
 */
export async function deleteMasterItem(db, c, kind, id) {
  const m = masterOf(kind);
  const [[row]] = await db.query(`SELECT * FROM ${m.table} WHERE company_id = ? AND id = ? AND deleted_at IS NULL`, [c.companyId, id]);
  if (!row) throw notFound(m.label);

  const { roles } = await masterUsage(db, c.companyId, kind, id);
  if (roles.length) {
    const named = roles.slice(0, 5).map((r) => r.title).join(', ');
    const more = roles.length > 5 ? `, and ${roles.length - 5} more` : '';
    throw conflict(
      'IN_USE',
      `${row.name} is used by ${roles.length} role${roles.length === 1 ? '' : 's'}: ${named}${more}. Unassign it there first, or set it inactive to keep it out of pickers.`,
      { problems: roles.map((r) => `${r.title}${r.roleCode ? ` (${r.roleCode})` : ''}`) },
    );
  }

  await db.query(`UPDATE ${m.table} SET deleted_at = NOW() WHERE company_id = ? AND id = ?`, [c.companyId, id]);
  await audit(db, c, m.table, id, 'DELETE', m.shape(row), null);
  return { ok: true, id, deleted: true };
}

// ===========================================================================
// 2. Roles
// ===========================================================================

function shapeRole(r) {
  return {
    id: r.id,
    roleCode: r.role_code,
    title: r.title,
    rolePurpose: r.role_purpose,
    roleSummary: r.role_summary,
    defaultDepartmentId: r.default_department_id,
    departmentName: r.department_name ?? null,
    departmentCode: r.department_code ?? null,
    status: r.status,
    effectiveFrom: isoDate(r.effective_from),
    effectiveTo: isoDate(r.effective_to),
    kraCount: Number(r.kra_count ?? 0),
    responsibilityCount: Number(r.responsibility_count ?? 0),
    kpiCount: Number(r.kpi_count ?? 0),
    skillCount: Number(r.skill_count ?? 0),
    authorityCount: Number(r.authority_count ?? 0),
    positionCount: Number(r.position_count ?? 0),
    /**
     * The readiness signal the Roles list surfaces. A role with no purpose or no
     * KRA cannot produce a JD worth reading — it would open with a blank line
     * and list duties under no outcome at all — so it is worth a number at the
     * top of the screen rather than a discovery three clicks in.
     */
    hasPurpose: !!(r.role_purpose && String(r.role_purpose).trim()),
    jdReady: !!(r.role_purpose && String(r.role_purpose).trim()) && Number(r.kra_count ?? 0) > 0,
  };
}

const ROLE_COUNTS = `
  (SELECT COUNT(*) FROM hrms_role_kra_assignments a            WHERE a.company_id = r.company_id AND a.role_id = r.id AND a.deleted_at IS NULL) AS kra_count,
  (SELECT COUNT(*) FROM hrms_role_responsibility_assignments a WHERE a.company_id = r.company_id AND a.role_id = r.id AND a.deleted_at IS NULL) AS responsibility_count,
  (SELECT COUNT(*) FROM hrms_role_kpi_assignments a            WHERE a.company_id = r.company_id AND a.role_id = r.id AND a.deleted_at IS NULL) AS kpi_count,
  (SELECT COUNT(*) FROM hrms_role_skill_requirements a         WHERE a.company_id = r.company_id AND a.role_id = r.id AND a.deleted_at IS NULL) AS skill_count,
  (SELECT COUNT(*) FROM hrms_role_authority_assignments a      WHERE a.company_id = r.company_id AND a.role_id = r.id AND a.deleted_at IS NULL) AS authority_count,
  (SELECT COUNT(*) FROM hrms_positions p                       WHERE p.company_id = r.company_id AND p.role_id = r.id AND p.deleted_at IS NULL) AS position_count`;

export async function listRoles(db, companyId) {
  const [rows] = await db.query(
    `SELECT r.*, d.name AS department_name, d.code AS department_code, ${ROLE_COUNTS}
       FROM hrms_roles r
       LEFT JOIN hrms_departments d ON d.company_id = r.company_id AND d.id = r.default_department_id AND d.deleted_at IS NULL
      WHERE r.company_id = ? AND r.deleted_at IS NULL
      ORDER BY r.title`,
    [companyId],
  );
  return { items: rows.map(shapeRole) };
}

export async function getRole(db, companyId, id) {
  const [[row]] = await db.query(
    `SELECT r.*, d.name AS department_name, d.code AS department_code, ${ROLE_COUNTS}
       FROM hrms_roles r
       LEFT JOIN hrms_departments d ON d.company_id = r.company_id AND d.id = r.default_department_id AND d.deleted_at IS NULL
      WHERE r.company_id = ? AND r.id = ? AND r.deleted_at IS NULL`,
    [companyId, id],
  );
  if (!row) throw notFound('Role');
  return shapeRole(row);
}

async function requireRole(db, companyId, id) {
  const [[row]] = await db.query('SELECT * FROM hrms_roles WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [companyId, id]);
  if (!row) throw notFound('Role');
  return row;
}

function roleFields(input, problems, { creating }) {
  const out = {};
  if (creating || input.roleCode !== undefined) out.role_code = str(input.roleCode, 50, problems, 'Role code');
  if (creating || input.title !== undefined) out.title = str(input.title, 200, problems, 'Title', { required: true });
  if (creating || input.rolePurpose !== undefined) out.role_purpose = str(input.rolePurpose, 4000, problems, 'Purpose');
  if (creating || input.roleSummary !== undefined) out.role_summary = str(input.roleSummary, 4000, problems, 'Summary');
  if (creating || input.defaultDepartmentId !== undefined) {
    out.default_department_id = input.defaultDepartmentId ? intValue(input.defaultDepartmentId, problems, 'Department') : null;
  }
  if (creating || input.status !== undefined) out.status = enumValue(input.status ?? 'DRAFT', ROLE_STATUSES, problems, 'Status', { required: true });
  if (creating || input.effectiveFrom !== undefined) out.effective_from = dateValue(input.effectiveFrom, problems, 'Effective from');
  if (creating || input.effectiveTo !== undefined) out.effective_to = dateValue(input.effectiveTo, problems, 'Effective to');
  if (out.effective_from && out.effective_to && out.effective_to < out.effective_from) {
    problems.push('Effective to cannot be before effective from.');
  }
  return out;
}

/**
 * Titles are unique per company (plan §3.2) and the database says so, but a
 * duplicate-key error tells a person nothing. This looks first and names the
 * role they should go and edit instead.
 */
async function assertTitleFree(db, companyId, title, exceptId = null) {
  if (!title) return;
  const [[clash]] = await db.query(
    `SELECT id, role_code, title, status FROM hrms_roles
      WHERE company_id = ? AND deleted_at IS NULL AND LOWER(title) = LOWER(?) AND (? IS NULL OR id <> ?)`,
    [companyId, title, exceptId, exceptId],
  );
  if (clash) {
    throw conflict(
      'DUPLICATE_TITLE',
      `A role titled "${clash.title}" already exists${clash.role_code ? ` (${clash.role_code})` : ''}. One title is one role — open that one and assign the work to it rather than creating a second.`,
      { roleId: clash.id },
    );
  }
}

async function assertDepartment(db, companyId, departmentId) {
  if (!departmentId) return;
  const [[dept]] = await db.query('SELECT id FROM hrms_departments WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [companyId, departmentId]);
  if (!dept) throw invalid('BAD_REFERENCE', 'That department does not exist in this company.');
}

export async function createRole(db, c, input = {}) {
  const problems = [];
  const fields = roleFields(input ?? {}, problems, { creating: true });
  assertNoProblems(problems);
  await assertTitleFree(db, c.companyId, fields.title);
  await assertDepartment(db, c.companyId, fields.default_department_id);

  const cols = Object.keys(fields);
  const [r] = await db.query(
    `INSERT INTO hrms_roles (company_id, ${cols.join(', ')}, created_by) VALUES (?, ${cols.map(() => '?').join(', ')}, ?)`,
    [c.companyId, ...cols.map((k) => fields[k]), c.userId],
  );
  await audit(db, c, 'hrms_roles', r.insertId, 'CREATE', null, fields);
  return getRole(db, c.companyId, r.insertId);
}

export async function updateRole(db, c, id, input = {}) {
  const before = await requireRole(db, c.companyId, id);
  const problems = [];
  const fields = roleFields(input ?? {}, problems, { creating: false });
  assertNoProblems(problems);
  if (fields.title !== undefined) await assertTitleFree(db, c.companyId, fields.title, id);
  if (fields.default_department_id !== undefined) await assertDepartment(db, c.companyId, fields.default_department_id);

  const cols = Object.keys(fields);
  if (cols.length) {
    await db.query(
      `UPDATE hrms_roles SET ${cols.map((k) => `${k} = ?`).join(', ')} WHERE company_id = ? AND id = ?`,
      [...cols.map((k) => fields[k]), c.companyId, id],
    );
    await audit(db, c, 'hrms_roles', id, 'UPDATE', { title: before.title, status: before.status }, fields);
  }
  return getRole(db, c.companyId, id);
}

/**
 * Soft-deletes a role and, in the same transaction, every content row attached
 * to it — otherwise a master would keep reporting "used by 7 roles" for roles
 * nobody can open. Refused while a Position or a Work Assignment points at it:
 * those are other people's screens and deleting the role under them would leave
 * a position with no definition of the work.
 */
export async function deleteRole(db, c, id) {
  const role = await requireRole(db, c.companyId, id);

  const [[refs]] = await db.query(
    `SELECT (SELECT COUNT(*) FROM hrms_positions p        WHERE p.company_id = ? AND p.role_id = ? AND p.deleted_at IS NULL) AS positions,
            (SELECT COUNT(*) FROM hrms_work_assignments w WHERE w.company_id = ? AND w.role_id = ? AND w.deleted_at IS NULL) AS assignments`,
    [c.companyId, id, c.companyId, id],
  );
  const blockers = [];
  if (Number(refs.positions)) blockers.push(`${refs.positions} position${refs.positions === 1 ? '' : 's'}`);
  if (Number(refs.assignments)) blockers.push(`${refs.assignments} work assignment${refs.assignments === 1 ? '' : 's'}`);
  if (blockers.length) {
    throw conflict(
      'IN_USE',
      `${role.title} is still used by ${blockers.join(' and ')}. Retire the role instead — retiring keeps the definition readable for the work already attached to it.`,
      { problems: blockers },
    );
  }

  for (const kind of Object.keys(CONTENT)) {
    await db.query(`UPDATE ${CONTENT[kind].table} SET deleted_at = NOW() WHERE company_id = ? AND role_id = ? AND deleted_at IS NULL`, [c.companyId, id]);
  }
  await db.query('UPDATE hrms_roles SET deleted_at = NOW() WHERE company_id = ? AND id = ?', [c.companyId, id]);
  await audit(db, c, 'hrms_roles', id, 'DELETE', { title: role.title, status: role.status }, null);
  return { ok: true, id, deleted: true };
}

// ===========================================================================
// 3. Role content — the ten assignment tables
// ===========================================================================

/**
 * One descriptor per content kind. `def` names the master it draws from (a role
 * never types content; it picks a definition and adds context). `grouped` marks
 * the two kinds that may hang under a KRA.
 *
 * `fields` returns database columns; `shape` returns the object a screen reads.
 * Both live beside each other on purpose — a column added to one and forgotten
 * in the other is the classic way a field starts saving and never displaying.
 */
export const CONTENT = {
  kras: {
    label: 'KRA',
    table: 'hrms_role_kra_assignments',
    itemPath: 'role-kras',
    def: { table: 'hrms_kra_definitions', column: 'kra_definition_id', apiField: 'kraDefinitionId', label: 'KRA' },
    grouped: false,
    weighted: true,
    defSelect: 'd.name AS def_name, d.code AS def_code, d.description AS def_description, d.category AS def_category, d.status AS def_status',
    defShape: (r) => ({ name: r.def_name, code: r.def_code, description: r.def_description, category: r.def_category, status: r.def_status }),
    fields: (input, problems, { creating }) => {
      const out = {};
      if (creating || input.weightPercent !== undefined) out.weight_percent = decimal(input.weightPercent, problems, 'Weight');
      if (creating || input.isMandatory !== undefined) out.is_mandatory = bool(input.isMandatory, true);
      return out;
    },
    shape: (r) => ({ weightPercent: r.weight_percent === null ? null : Number(r.weight_percent), isMandatory: !!r.is_mandatory }),
  },

  responsibilities: {
    label: 'Responsibility',
    table: 'hrms_role_responsibility_assignments',
    itemPath: 'role-responsibilities',
    def: { table: 'hrms_responsibility_definitions', column: 'responsibility_definition_id', apiField: 'responsibilityDefinitionId', label: 'Responsibility' },
    grouped: true,
    defSelect: 'd.name AS def_name, d.code AS def_code, d.description AS def_description, d.responsibility_class AS def_class, d.status AS def_status',
    defShape: (r) => ({ name: r.def_name, code: r.def_code, description: r.def_description, responsibilityClass: r.def_class, status: r.def_status }),
    fields: (input, problems, { creating }) => {
      const out = {};
      if (creating || input.responsibilityClassOverride !== undefined) {
        out.responsibility_class_override = enumValue(input.responsibilityClassOverride, RESPONSIBILITY_CLASSES, problems, 'Class');
      }
      if (creating || input.isMandatory !== undefined) out.is_mandatory = bool(input.isMandatory, true);
      return out;
    },
    shape: (r) => ({
      responsibilityClassOverride: r.responsibility_class_override,
      responsibilityClass: r.responsibility_class_override ?? r.def_class ?? null,
      isMandatory: !!r.is_mandatory,
    }),
  },

  kpis: {
    label: 'KPI',
    table: 'hrms_role_kpi_assignments',
    itemPath: 'role-kpis',
    def: { table: 'hrms_kpi_definitions', column: 'kpi_definition_id', apiField: 'kpiDefinitionId', label: 'KPI' },
    grouped: true,
    weighted: true,
    defSelect: `d.name AS def_name, d.code AS def_code, d.description AS def_description, d.measurement_type AS def_measurement_type,
                d.unit AS def_unit, d.direction AS def_direction, d.formula_text AS def_formula_text, d.data_source AS def_data_source,
                d.default_frequency AS def_default_frequency, d.status AS def_status`,
    defShape: (r) => ({
      name: r.def_name, code: r.def_code, description: r.def_description,
      measurementType: r.def_measurement_type, unit: r.def_unit, direction: r.def_direction,
      formulaText: r.def_formula_text, dataSource: r.def_data_source,
      defaultFrequency: r.def_default_frequency, status: r.def_status,
    }),
    fields: (input, problems, { creating, definition }) => {
      const out = {};
      const wantsTarget = creating || input.targetOperator !== undefined || input.targetValue !== undefined;
      if (creating || input.targetOperator !== undefined) out.target_operator = enumValue(input.targetOperator, TARGET_OPERATORS, problems, 'Target operator');
      if (wantsTarget) {
        out.target_value = validateTarget(
          out.target_operator ?? null,
          input.targetValue,
          definition?.measurement_type ?? 'NUMBER',
          problems,
        );
      }
      if (creating || input.weightPercent !== undefined) out.weight_percent = decimal(input.weightPercent, problems, 'Weight');
      if (creating || input.frequencyOverride !== undefined) out.frequency_override = enumValue(input.frequencyOverride, FREQUENCIES, problems, 'Frequency');
      if (creating || input.isMandatory !== undefined) out.is_mandatory = bool(input.isMandatory, true);
      return out;
    },
    shape: (r) => ({
      targetOperator: r.target_operator,
      targetValue: readJson(r.target_value),
      weightPercent: r.weight_percent === null ? null : Number(r.weight_percent),
      frequencyOverride: r.frequency_override,
      frequency: r.frequency_override ?? r.def_default_frequency ?? null,
      isMandatory: !!r.is_mandatory,
    }),
  },

  skills: {
    label: 'Skill requirement',
    table: 'hrms_role_skill_requirements',
    itemPath: 'role-skills',
    def: { table: 'hrms_skill_definitions', column: 'skill_definition_id', apiField: 'skillDefinitionId', label: 'Skill' },
    grouped: false,
    defSelect: 'd.name AS def_name, d.skill_type AS def_skill_type, d.description AS def_description, d.status AS def_status',
    defShape: (r) => ({ name: r.def_name, skillType: r.def_skill_type, description: r.def_description, status: r.def_status }),
    fields: (input, problems, { creating }) => {
      const out = {};
      if (creating || input.requirementLevel !== undefined) {
        out.requirement_level = enumValue(input.requirementLevel ?? 'REQUIRED', REQUIREMENT_LEVELS, problems, 'Requirement level', { required: true });
      }
      if (creating || input.proficiencyLevel !== undefined) out.proficiency_level = str(input.proficiencyLevel, 50, problems, 'Proficiency');
      return out;
    },
    shape: (r) => ({ requirementLevel: r.requirement_level, proficiencyLevel: r.proficiency_level }),
  },

  qualifications: {
    label: 'Qualification requirement',
    table: 'hrms_role_qualification_requirements',
    itemPath: 'role-qualifications',
    def: { table: 'hrms_qualification_definitions', column: 'qualification_definition_id', apiField: 'qualificationDefinitionId', label: 'Qualification' },
    grouped: false,
    defSelect: 'd.name AS def_name, d.qualification_type AS def_qualification_type, d.description AS def_description, d.status AS def_status',
    defShape: (r) => ({ name: r.def_name, qualificationType: r.def_qualification_type, description: r.def_description, status: r.def_status }),
    fields: (input, problems, { creating }) => {
      const out = {};
      if (creating || input.requirementLevel !== undefined) {
        out.requirement_level = enumValue(input.requirementLevel ?? 'REQUIRED', REQUIREMENT_LEVELS, problems, 'Requirement level', { required: true });
      }
      return out;
    },
    shape: (r) => ({ requirementLevel: r.requirement_level }),
  },

  experience: {
    label: 'Experience requirement',
    table: 'hrms_role_experience_requirements',
    itemPath: 'role-experience',
    // Free-standing: experience has no master. Years and an area are the whole
    // statement, and nothing else in the model needs to reuse them.
    def: null,
    grouped: false,
    fields: (input, problems, { creating }) => {
      const out = {};
      if (creating || input.minYears !== undefined) out.min_years = decimal(input.minYears, problems, 'Minimum years', { min: 0, max: 60 });
      if (creating || input.preferredYears !== undefined) out.preferred_years = decimal(input.preferredYears, problems, 'Preferred years', { min: 0, max: 60 });
      if (creating || input.experienceArea !== undefined) out.experience_area = str(input.experienceArea, 250, problems, 'Area');
      if (creating || input.requirementLevel !== undefined) {
        out.requirement_level = enumValue(input.requirementLevel ?? 'REQUIRED', REQUIREMENT_LEVELS, problems, 'Requirement level', { required: true });
      }
      if (out.min_years != null && out.preferred_years != null && out.preferred_years < out.min_years) {
        problems.push('Preferred years cannot be less than minimum years.');
      }
      if (creating && out.min_years == null && out.preferred_years == null && !out.experience_area) {
        problems.push('Give at least a number of years or an area of experience.');
      }
      return out;
    },
    shape: (r) => ({
      minYears: r.min_years === null ? null : Number(r.min_years),
      preferredYears: r.preferred_years === null ? null : Number(r.preferred_years),
      experienceArea: r.experience_area,
      requirementLevel: r.requirement_level,
    }),
  },

  authorities: {
    label: 'Authority',
    table: 'hrms_role_authority_assignments',
    itemPath: 'role-authorities',
    def: { table: 'hrms_authority_definitions', column: 'authority_definition_id', apiField: 'authorityDefinitionId', label: 'Authority' },
    grouped: false,
    defSelect: 'd.name AS def_name, d.authority_type AS def_authority_type, d.description AS def_description, d.status AS def_status',
    defShape: (r) => ({ name: r.def_name, authorityType: r.def_authority_type, description: r.def_description, status: r.def_status }),
    fields: (input, problems, { creating }) => {
      const out = {};
      if (creating || input.limitJson !== undefined) out.limit_json = validateLimit(input.limitJson, problems);
      return out;
    },
    shape: (r) => ({ limitJson: readJson(r.limit_json) }),
  },

  relationships: {
    label: 'Relationship expectation',
    table: 'hrms_role_relationship_expectations',
    itemPath: 'role-relationships',
    def: null,
    grouped: false,
    noNotes: true,
    // JD-facing only (plan §2 rule 9). Who a role coordinates with is not who
    // manages the person doing it; actual reporting lives on positions and work
    // assignments. Nothing here ever becomes a manager.
    fields: (input, problems, { creating }) => {
      const out = {};
      if (creating || input.relationshipScope !== undefined) {
        out.relationship_scope = enumValue(input.relationshipScope ?? 'INTERNAL', RELATIONSHIP_SCOPES, problems, 'Scope', { required: true });
      }
      if (creating || input.counterparty !== undefined) out.counterparty = str(input.counterparty, 250, problems, 'Counterparty', { required: true });
      if (creating || input.purpose !== undefined) out.purpose = str(input.purpose, 4000, problems, 'Purpose');
      return out;
    },
    shape: (r) => ({ relationshipScope: r.relationship_scope, counterparty: r.counterparty, purpose: r.purpose }),
  },

  conditions: {
    label: 'Working condition',
    table: 'hrms_role_working_conditions',
    itemPath: 'role-conditions',
    def: null,
    grouped: false,
    noNotes: true,
    fields: (input, problems, { creating }) => {
      const out = {};
      if (creating || input.conditionType !== undefined) {
        out.condition_type = enumValue(input.conditionType ?? 'OTHER', WORKING_CONDITION_TYPES, problems, 'Condition type', { required: true });
      }
      if (creating || input.description !== undefined) out.description = str(input.description, 4000, problems, 'Description', { required: true });
      if (creating || input.isMandatory !== undefined) out.is_mandatory = bool(input.isMandatory, true);
      return out;
    },
    shape: (r) => ({ conditionType: r.condition_type, description: r.description, isMandatory: !!r.is_mandatory }),
  },
};

export function contentOf(kind) {
  const k = CONTENT[kind];
  if (!k) throw notFound(`Content kind "${kind}"`);
  return k;
}

/**
 * A KPI target must mean something against its operator and its measurement
 * type. BETWEEN takes a range, INFO takes nothing at all, and a percentage with
 * a target of "good" is a target nobody can check.
 */
function validateTarget(operator, value, measurementType, problems) {
  const empty = value === null || value === undefined || value === '';
  if (!operator || operator === 'INFO') {
    if (!empty) problems.push('An INFO KPI is tracked, not judged — it carries no target value.');
    return null;
  }
  if (operator === 'BETWEEN') {
    const v = typeof value === 'string' ? readJson(value) : value;
    const min = Number(v?.min);
    const max = Number(v?.max);
    if (!v || !Number.isFinite(min) || !Number.isFinite(max)) {
      problems.push('A BETWEEN target needs a minimum and a maximum.');
      return null;
    }
    if (max <= min) problems.push('The BETWEEN maximum must be above the minimum.');
    return JSON.stringify({ min, max });
  }
  if (empty) {
    problems.push(`A ${operator} target needs a value.`);
    return null;
  }
  if (measurementType === 'BOOLEAN') {
    const v = value === true || value === 'true' || value === 1 || value === '1';
    return JSON.stringify(v);
  }
  if (measurementType === 'TEXT') {
    return JSON.stringify(String(value));
  }
  const n = Number(typeof value === 'object' ? NaN : value);
  if (!Number.isFinite(n)) {
    problems.push(`This KPI is measured as ${measurementType}, so its target is a number.`);
    return null;
  }
  if (measurementType === 'PERCENTAGE' && (n < 0 || n > 1000)) problems.push('A percentage target is between 0 and 1000.');
  return JSON.stringify(n);
}

/** `limit_json` is the sentence "up to ₹50,000, for plant consumables, with the CFO informed". */
function validateLimit(value, problems) {
  if (value === null || value === undefined || value === '') return null;
  const v = typeof value === 'string' ? readJson(value) : value;
  if (!v || typeof v !== 'object' || Array.isArray(v)) {
    problems.push('An authority limit is a set of fields: amount, currency, scope, condition.');
    return null;
  }
  const out = {};
  if (v.amount !== undefined && v.amount !== null && v.amount !== '') {
    const n = Number(v.amount);
    if (!Number.isFinite(n) || n < 0) problems.push('An authority amount is a number of 0 or more.');
    else out.amount = n;
  }
  if (v.currency) out.currency = String(v.currency).trim().slice(0, 10);
  if (v.scope) out.scope = String(v.scope).trim().slice(0, 250);
  if (v.condition) out.condition = String(v.condition).trim().slice(0, 500);
  return Object.keys(out).length ? JSON.stringify(out) : null;
}

/** sequence / effective dates / notes — the columns every content table shares. */
function commonFields(kindDef, input, problems, { creating }) {
  const out = {};
  if (creating || input.sequence !== undefined) {
    const seq = input.sequence === undefined || input.sequence === null || input.sequence === '' ? 0 : intValue(input.sequence, problems, 'Order');
    out.sequence = seq ?? 0;
  }
  if (creating || input.effectiveFrom !== undefined) out.effective_from = dateValue(input.effectiveFrom, problems, 'Effective from');
  if (creating || input.effectiveTo !== undefined) out.effective_to = dateValue(input.effectiveTo, problems, 'Effective to');
  if (!kindDef.noNotes && (creating || input.notes !== undefined)) out.notes = str(input.notes, 4000, problems, 'Notes');
  return out;
}

/**
 * Rule 1. A responsibility or a KPI may be grouped under one of the role's own
 * KRA assignments, and only its own. The FK checks the company; nothing checks
 * the role, so a mis-typed id would quietly file this role's duty under another
 * role's outcome area — which is exactly the kind of wrong that never surfaces
 * until a JD is read aloud in a meeting.
 */
async function resolveGroup(db, companyId, roleId, value, problems) {
  if (value === null || value === undefined || value === '') return null;
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    problems.push('The KRA to group under must be one of this role\'s KRAs.');
    return null;
  }
  const [[row]] = await db.query(
    'SELECT id, role_id FROM hrms_role_kra_assignments WHERE company_id = ? AND id = ? AND deleted_at IS NULL',
    [companyId, id],
  );
  if (!row) {
    problems.push('That KRA assignment no longer exists.');
    return null;
  }
  if (Number(row.role_id) !== Number(roleId)) {
    problems.push('A responsibility or KPI can only be grouped under a KRA that belongs to the same role.');
    return null;
  }
  return id;
}

function shapeContentRow(kind, kindDef, r) {
  return {
    id: r.id,
    kind,
    /**
     * Every row says which layer it came from. Position and assignment overlays
     * land on top of this set in a later phase (plan §2 rule 6); they need to be
     * able to say "this one is SUPPRESSED by the position" without guessing
     * which layer produced the row.
     */
    layer: 'ROLE',
    roleId: r.role_id,
    definitionId: kindDef.def ? r[kindDef.def.column] : null,
    definition: kindDef.def ? kindDef.defShape(r) : null,
    roleKraAssignmentId: kindDef.grouped ? r.role_kra_assignment_id : null,
    sequence: Number(r.sequence ?? 0),
    effectiveFrom: isoDate(r.effective_from),
    effectiveTo: isoDate(r.effective_to),
    notes: kindDef.noNotes ? null : (r.notes ?? null),
    retired: !!r.deleted_at,
    ...kindDef.shape(r),
  };
}

/**
 * Which rows count as being in force on a date.
 *
 * A live row is in force when the date sits inside its window. A RETIRED row is
 * in force for a past date when it was closed before today — that is what makes
 * "ended, not overwritten" visible: a weight that changed on 1 June still reads
 * as the old weight when you ask for 1 May. Retiring never edits the past, and
 * it never keeps a row in the present.
 */
function effectiveWhere(alias, { on, scope }) {
  if (scope === 'all') return { sql: `${alias}.deleted_at IS NULL`, params: [] };
  return {
    sql: `(${alias}.deleted_at IS NULL OR (${alias}.effective_to IS NOT NULL AND ${alias}.effective_to < CURDATE()))
          AND (${alias}.effective_from IS NULL OR ${alias}.effective_from <= ?)
          AND (${alias}.effective_to   IS NULL OR ${alias}.effective_to   >= ?)`,
    params: [on, on],
  };
}

async function listContentRows(db, companyId, roleId, kind, opts) {
  const k = contentOf(kind);
  const where = effectiveWhere('a', opts);
  const join = k.def
    ? `LEFT JOIN ${k.def.table} d ON d.company_id = a.company_id AND d.id = a.${k.def.column}`
    : '';
  const [rows] = await db.query(
    `SELECT a.*${k.defSelect ? `, ${k.defSelect}` : ''}
       FROM ${k.table} a ${join}
      WHERE a.company_id = ? AND a.role_id = ? AND ${where.sql}
      ORDER BY a.sequence, a.id`,
    [companyId, roleId, ...where.params],
  );
  return rows.map((r) => shapeContentRow(kind, k, r));
}

/**
 * THE role content read (plan §7). Returns the role layer, grouped the way the
 * model means it: each KRA carries the responsibilities and KPIs assigned under
 * it, and everything ungrouped is collected under "Additional" — visible, not
 * dropped. A responsibility that belongs to no KRA is still a duty of the role;
 * hiding it because it has no parent is how content silently disappears.
 *
 * `on` selects the date. `scope=all` ignores dates and returns every live row,
 * which is what the editing screen needs so a future-dated assignment does not
 * vanish while someone is working on it.
 */
export async function getRoleContent(db, companyId, roleId, { on = today(), scope = 'effective' } = {}) {
  const role = await getRole(db, companyId, roleId);
  const opts = { on, scope };

  const [kras, responsibilities, kpis, skills, qualifications, experience, authorities, relationships, conditions] =
    await Promise.all([
      listContentRows(db, companyId, roleId, 'kras', opts),
      listContentRows(db, companyId, roleId, 'responsibilities', opts),
      listContentRows(db, companyId, roleId, 'kpis', opts),
      listContentRows(db, companyId, roleId, 'skills', opts),
      listContentRows(db, companyId, roleId, 'qualifications', opts),
      listContentRows(db, companyId, roleId, 'experience', opts),
      listContentRows(db, companyId, roleId, 'authorities', opts),
      listContentRows(db, companyId, roleId, 'relationships', opts),
      listContentRows(db, companyId, roleId, 'conditions', opts),
    ]);

  /**
   * Grouping resolves through the KRA's DEFINITION, not through the assignment
   * row id. A KRA assignment that has been superseded (a weight that changed on
   * a date) is a different row for the same outcome area, and a read for a past
   * date returns the older row — so a child that points at either row must land
   * under whichever row is in force on the date being asked about.
   */
  const [allKraRows] = await db.query(
    'SELECT id, kra_definition_id FROM hrms_role_kra_assignments WHERE company_id = ? AND role_id = ?',
    [companyId, roleId],
  );
  const definitionOfAssignment = new Map(allKraRows.map((r) => [Number(r.id), Number(r.kra_definition_id)]));

  const byKra = new Map(kras.map((k) => [k.id, { ...k, responsibilities: [], kpis: [] }]));
  const kraIdByDefinition = new Map(kras.map((k) => [Number(k.definitionId), k.id]));
  const parentOf = (row) => {
    if (!row.roleKraAssignmentId) return null;
    const defId = definitionOfAssignment.get(Number(row.roleKraAssignmentId));
    const kraId = defId === undefined ? row.roleKraAssignmentId : kraIdByDefinition.get(defId);
    return kraId === undefined ? null : byKra.get(kraId) ?? null;
  };

  const additional = { responsibilities: [], kpis: [] };
  for (const r of responsibilities) {
    const parent = parentOf(r);
    (parent ? parent.responsibilities : additional.responsibilities).push(r);
  }
  for (const k of kpis) {
    const parent = parentOf(k);
    (parent ? parent.kpis : additional.kpis).push(k);
  }

  const sum = (rows) => rows.reduce((t, r) => t + (Number(r.weightPercent) || 0), 0);
  const kraWeight = sum(kras);
  const kpiWeight = sum(kpis);

  return {
    role,
    on,
    scope,
    layer: 'ROLE',
    kras: [...byKra.values()],
    additional,
    skills,
    qualifications,
    experience,
    authorities,
    relationships,
    conditions,
    weights: {
      // Weights are optional by design — many SMEs never use them. When some are
      // set they should add up, so the screen shows a running total and warns.
      kraTotal: Math.round(kraWeight * 100) / 100,
      kraWeighted: kras.filter((k) => k.weightPercent != null).length,
      kraBalanced: kras.every((k) => k.weightPercent == null) || Math.abs(kraWeight - 100) < 0.005,
      kpiTotal: Math.round(kpiWeight * 100) / 100,
      kpiWeighted: kpis.filter((k) => k.weightPercent != null).length,
    },
    counts: {
      kras: kras.length,
      responsibilities: responsibilities.length,
      kpis: kpis.length,
      skills: skills.length,
      qualifications: qualifications.length,
      experience: experience.length,
      authorities: authorities.length,
      relationships: relationships.length,
      conditions: conditions.length,
      ungrouped: additional.responsibilities.length + additional.kpis.length,
    },
  };
}

async function getContentRow(db, companyId, kind, id, { includeRetired = false } = {}) {
  const k = contentOf(kind);
  const join = k.def ? `LEFT JOIN ${k.def.table} d ON d.company_id = a.company_id AND d.id = a.${k.def.column}` : '';
  const [[row]] = await db.query(
    `SELECT a.*${k.defSelect ? `, ${k.defSelect}` : ''} FROM ${k.table} a ${join}
      WHERE a.company_id = ? AND a.id = ?${includeRetired ? '' : ' AND a.deleted_at IS NULL'}`,
    [companyId, id],
  );
  if (!row) throw notFound(k.label);
  return row;
}

async function requireDefinition(db, companyId, kindDef, value) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    throw invalid('INVALID', `Pick a ${kindDef.def.label} from the master list — role content is assigned, never typed.`);
  }
  const [[row]] = await db.query(
    `SELECT * FROM ${kindDef.def.table} WHERE company_id = ? AND id = ? AND deleted_at IS NULL`,
    [companyId, id],
  );
  if (!row) throw invalid('BAD_REFERENCE', `That ${kindDef.def.label.toLowerCase()} does not exist in this company.`);
  return row;
}

/** The next free order number, so a new row lands at the end instead of on top of another. */
async function nextSequence(db, companyId, table, roleId) {
  const [[row]] = await db.query(
    `SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM ${table} WHERE company_id = ? AND role_id = ? AND deleted_at IS NULL`,
    [companyId, roleId],
  );
  return Number(row.next ?? 1);
}

export async function addContent(db, c, roleId, kind, input = {}) {
  const k = contentOf(kind);
  await requireRole(db, c.companyId, roleId);

  const problems = [];
  let definition = null;
  const cols = { role_id: roleId };

  if (k.def) {
    definition = await requireDefinition(db, c.companyId, k, input[k.def.apiField] ?? input.definitionId);
    cols[k.def.column] = definition.id;
    if (definition.status === 'INACTIVE') {
      problems.push(`${definition.name} is inactive. Reactivate it in the ${k.def.label} master before assigning it.`);
    }
  }
  if (k.grouped) {
    cols.role_kra_assignment_id = await resolveGroup(db, c.companyId, roleId, input.roleKraAssignmentId, problems);
  }

  Object.assign(cols, k.fields(input, problems, { creating: true, definition }));
  Object.assign(cols, commonFields(k, input, problems, { creating: true }));
  if (cols.effective_from && cols.effective_to && cols.effective_to < cols.effective_from) {
    problems.push('Effective to cannot be before effective from.');
  }
  assertNoProblems(problems);

  if (!cols.sequence) cols.sequence = await nextSequence(db, c.companyId, k.table, roleId);

  const names = Object.keys(cols);
  const [r] = await db.query(
    `INSERT INTO ${k.table} (company_id, ${names.join(', ')}, created_by) VALUES (?, ${names.map(() => '?').join(', ')}, ?)`,
    [c.companyId, ...names.map((n) => cols[n]), c.userId],
  );
  await audit(db, c, k.table, r.insertId, 'CREATE', null, cols);
  return shapeContentRow(kind, k, await getContentRow(db, c.companyId, kind, r.insertId));
}

/**
 * Rule 2 — effective-dated rows are ENDED, not overwritten (plan §2 rule 8).
 *
 * A plain correction (a typo in the notes, an order change, a weight that was
 * always meant to be 40) edits the row. A DATED change — the caller passes an
 * `effectiveFrom` later than the row's own start — is a different fact about a
 * different period, so the current row is CLOSED the day before and a successor
 * opens on the new date.
 *
 * The schema allows only one live row per (role, definition): `uq_hrka_pair` and
 * its siblings are built on a virtual column that is the definition id while
 * `deleted_at IS NULL`. So the closed predecessor is retired from the live set
 * as it is closed. It keeps its dates and its values, `GET /content?on=<past>`
 * still returns it for the period it applied to, and the full before/after is in
 * hrms_audit_log. That is the honest reading of "ended, not overwritten" against
 * this schema — the alternative would be to overwrite the row and lose the fact
 * that it ever said something else.
 */
export async function updateContent(db, c, kind, id, input = {}) {
  const k = contentOf(kind);
  const before = await getContentRow(db, c.companyId, kind, id);
  const roleId = before.role_id;

  const problems = [];
  const definition = k.def
    ? await requireDefinition(db, c.companyId, k, before[k.def.column])
    : null;

  const changes = {};
  if (k.grouped && input.roleKraAssignmentId !== undefined) {
    changes.role_kra_assignment_id = await resolveGroup(db, c.companyId, roleId, input.roleKraAssignmentId, problems);
  }
  Object.assign(changes, k.fields(input, problems, { creating: false, definition }));
  Object.assign(changes, commonFields(k, input, problems, { creating: false }));

  const nextFrom = changes.effective_from !== undefined ? changes.effective_from : isoDate(before.effective_from);
  const nextTo = changes.effective_to !== undefined ? changes.effective_to : isoDate(before.effective_to);
  if (nextFrom && nextTo && nextTo < nextFrom) problems.push('Effective to cannot be before effective from.');
  assertNoProblems(problems);

  const currentFrom = isoDate(before.effective_from);
  const dated =
    input.effectiveFrom !== undefined &&
    !!changes.effective_from &&
    changes.effective_from !== currentFrom &&
    (!currentFrom || changes.effective_from > currentFrom);

  if (!dated) {
    const names = Object.keys(changes);
    if (names.length) {
      await db.query(
        `UPDATE ${k.table} SET ${names.map((n) => `${n} = ?`).join(', ')} WHERE company_id = ? AND id = ?`,
        [...names.map((n) => changes[n]), c.companyId, id],
      );
      await audit(db, c, k.table, id, 'UPDATE', shapeContentRow(kind, k, before), changes);
    }
    return shapeContentRow(kind, k, await getContentRow(db, c.companyId, kind, id));
  }

  // --- supersede -----------------------------------------------------------
  const newFrom = changes.effective_from;
  const closeOn = dayBefore(newFrom);
  await db.query(
    `UPDATE ${k.table} SET effective_to = ?, deleted_at = NOW() WHERE company_id = ? AND id = ?`,
    [closeOn, c.companyId, id],
  );

  const carried = {
    role_id: roleId,
    sequence: before.sequence,
    effective_from: newFrom,
    effective_to: changes.effective_to !== undefined ? changes.effective_to : isoDate(before.effective_to),
  };
  if (k.def) carried[k.def.column] = before[k.def.column];
  if (k.grouped) carried.role_kra_assignment_id = before.role_kra_assignment_id;
  if (!k.noNotes) carried.notes = before.notes;
  for (const col of Object.keys(k.fields({}, [], { creating: true, definition }))) carried[col] = before[col];
  for (const [col, value] of Object.entries(changes)) carried[col] = value;
  // JSON columns come back from the driver as objects; they go in as text.
  for (const col of ['target_value', 'limit_json']) {
    if (carried[col] && typeof carried[col] === 'object') carried[col] = JSON.stringify(carried[col]);
  }

  const names = Object.keys(carried);
  const [r] = await db.query(
    `INSERT INTO ${k.table} (company_id, ${names.join(', ')}, created_by) VALUES (?, ${names.map(() => '?').join(', ')}, ?)`,
    [c.companyId, ...names.map((n) => carried[n]), c.userId],
  );
  /**
   * A superseded KRA takes its children with it. Without this, changing a KRA's
   * weight on a date would silently drop every responsibility and KPI grouped
   * under it into "Additional" — the structure the whole screen exists to show,
   * undone by a weight edit.
   */
  if (kind === 'kras') {
    for (const child of ['responsibilities', 'kpis']) {
      await db.query(
        `UPDATE ${CONTENT[child].table} SET role_kra_assignment_id = ?
          WHERE company_id = ? AND role_kra_assignment_id = ? AND deleted_at IS NULL`,
        [r.insertId, c.companyId, id],
      );
    }
  }

  await audit(db, c, k.table, id, 'UPDATE', shapeContentRow(kind, k, before), { supersededBy: r.insertId, closedOn: closeOn, ...carried });

  const next = shapeContentRow(kind, k, await getContentRow(db, c.companyId, kind, r.insertId));
  return { ...next, supersededId: id, supersededOn: closeOn };
}

/**
 * Unassigning. The row is CLOSED on the end date and retired — it is not
 * silently erased, because a role that carried a KRA until March genuinely
 * carried it until March, and the JD generated in February must still be
 * explicable.
 */
export async function removeContent(db, c, kind, id, { endOn } = {}) {
  const k = contentOf(kind);
  const before = await getContentRow(db, c.companyId, kind, id);
  const problems = [];
  const end = endOn ? dateValue(endOn, problems, 'End date') : today();
  assertNoProblems(problems);

  const from = isoDate(before.effective_from);
  // A row that never came into force has no history worth keeping a window for.
  const closeOn = from && from > end ? from : end;
  await db.query(
    `UPDATE ${k.table} SET effective_to = ?, deleted_at = NOW() WHERE company_id = ? AND id = ?`,
    [closeOn, c.companyId, id],
  );
  await audit(db, c, k.table, id, 'DELETE', shapeContentRow(kind, k, before), { endedOn: closeOn });
  return { ok: true, id, kind, endedOn: closeOn };
}

/**
 * Reorder in one write. `sequence` is what the JD prints in, so dragging a
 * responsibility above another has to be one atomic renumber — a half-applied
 * reorder leaves two rows claiming position 3 and the JD order becomes the
 * insertion order again.
 */
export async function reorderContent(db, c, roleId, kind, ids) {
  const k = contentOf(kind);
  await requireRole(db, c.companyId, roleId);
  if (!Array.isArray(ids) || !ids.length) throw invalid('INVALID', 'Send the ids in their new order.');

  const [rows] = await db.query(
    `SELECT id FROM ${k.table} WHERE company_id = ? AND role_id = ? AND deleted_at IS NULL`,
    [c.companyId, roleId],
  );
  const known = new Set(rows.map((r) => Number(r.id)));
  const wanted = ids.map(Number);
  if (wanted.some((id) => !known.has(id))) {
    throw invalid('INVALID', 'That order lists a row that is not part of this role — reload the screen and try again.');
  }

  for (const [i, id] of wanted.entries()) {
    await db.query(`UPDATE ${k.table} SET sequence = ? WHERE company_id = ? AND id = ?`, [i + 1, c.companyId, id]);
  }
  await audit(db, c, k.table, roleId, 'UPDATE', null, { reordered: wanted });
  return { ok: true, kind, order: wanted };
}

/**
 * Regrouping a responsibility or a KPI under a different KRA (or out to
 * Additional). Its own endpoint because it is the one edit that has to re-check
 * rule 1, and because the screen does it by drag, not by form.
 */
export async function regroupContent(db, c, kind, id, roleKraAssignmentId) {
  const k = contentOf(kind);
  if (!k.grouped) throw invalid('INVALID', `${k.label} is not grouped under a KRA.`);
  const before = await getContentRow(db, c.companyId, kind, id);
  const problems = [];
  const group = await resolveGroup(db, c.companyId, before.role_id, roleKraAssignmentId, problems);
  assertNoProblems(problems);

  await db.query(`UPDATE ${k.table} SET role_kra_assignment_id = ? WHERE company_id = ? AND id = ?`, [group, c.companyId, id]);
  await audit(db, c, k.table, id, 'UPDATE', { roleKraAssignmentId: before.role_kra_assignment_id }, { roleKraAssignmentId: group });
  return shapeContentRow(kind, k, await getContentRow(db, c.companyId, kind, id));
}

/**
 * The Roles list's readiness numbers, computed once in SQL rather than by
 * counting rows the screen happens to have loaded.
 */
export async function rolesOverview(db, companyId) {
  const [[row]] = await db.query(
    `SELECT COUNT(*) AS total,
            SUM(r.status = 'ACTIVE')  AS active,
            SUM(r.status = 'DRAFT')   AS draft,
            SUM(r.status = 'RETIRED') AS retired,
            SUM(r.role_purpose IS NULL OR TRIM(r.role_purpose) = '') AS no_purpose,
            SUM((SELECT COUNT(*) FROM hrms_role_kra_assignments a WHERE a.company_id = r.company_id AND a.role_id = r.id AND a.deleted_at IS NULL) = 0) AS no_kras
       FROM hrms_roles r WHERE r.company_id = ? AND r.deleted_at IS NULL`,
    [companyId],
  );
  return {
    total: Number(row.total ?? 0),
    active: Number(row.active ?? 0),
    draft: Number(row.draft ?? 0),
    retired: Number(row.retired ?? 0),
    noPurpose: Number(row.no_purpose ?? 0),
    noKras: Number(row.no_kras ?? 0),
  };
}

/** Departments, for the role form's picker. Read-only; the org screens own them. */
export async function listDepartments(db, companyId) {
  const [rows] = await db.query(
    'SELECT id, code, name FROM hrms_departments WHERE company_id = ? AND deleted_at IS NULL ORDER BY name',
    [companyId],
  );
  return { items: rows.map((r) => ({ id: r.id, code: r.code, name: r.name })) };
}
