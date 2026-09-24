/**
 * organisationService.js — the fixed points everything else in cf_hrms hangs
 * off: locations, departments, work contexts, contractors, shifts, holidays and
 * the reporting relationship type catalogue (plan §5.1).
 *
 * WHY THIS FILE EXISTS AT ALL, when six of the seven are plain lists the generic
 * query API could serve: production is TiDB v8.5.3 with
 * `tidb_enable_check_constraint = 0`, so three rules this section depends on are
 * not — and cannot be — held by the database:
 *
 *   1. NO CYCLES. Departments, locations and work contexts all self-parent. A
 *      row made its own ancestor does not fail an insert; it makes every later
 *      tree walk (the org chart, a JD's department path, a holiday's location
 *      scope) loop forever. The check walks up from the proposed parent with a
 *      guard counter, so an ALREADY broken chain is caught too, not just the
 *      edge being added.
 *   2. A PARENT WITH LIVE CHILDREN IS NOT DELETED. Soft delete only clears
 *      `deleted_at`, so the FK never fires and the children silently become
 *      orphans pointing at an invisible parent. The refusal names them — "and 3
 *      others" is not something a person can act on.
 *   3. CODES ARE UNIQUE PER COMPANY, CASE-INSENSITIVELY. The `*_active` virtual
 *      columns in init.sql do enforce this, but they surface as errno 1062 with
 *      an index name. The service checks first so the answer is a sentence about
 *      the row that already holds the code, and errors.js catches the race.
 *
 * Everything here also refuses a delete whose row is still referenced elsewhere
 * (a shift on a roster, a contractor on an employee, a context on a position).
 * The FKs would stop a hard delete; they say nothing about a soft one, and a
 * "deleted" shift still named on 400 attendance rows is worse than a refusal.
 *
 * Every write records an hrms_audit_log row in the same transaction — TiDB has
 * no triggers, so an audit row written anywhere else is an audit row that can go
 * missing (init.sql §9c).
 */
import { invalid, notFound, conflict, assertNoProblems } from '../lib/errors.js';

// Codes travel through imports, exports and spreadsheets. No spaces, no commas.
const CODE_RE = /^[A-Za-z0-9][A-Za-z0-9_.\-]*$/;
const STATUSES = ['ACTIVE', 'INACTIVE'];
const LOCATION_TYPES = ['PLANT', 'OFFICE', 'UNIT', 'BRANCH', 'SITE', 'OTHER'];
const CONTEXT_TYPES = ['MACHINE', 'LINE', 'AREA', 'PROJECT', 'CELL', 'OTHER'];
const ADDRESS_KEYS = ['line1', 'line2', 'city', 'state', 'pincode', 'country'];
const CONTACT_KEYS = ['contactPerson', 'phone', 'email', 'address', 'notes'];
// A tree deeper than this is a loop that predates the cycle check, or a mistake.
const MAX_DEPTH = 64;

/* ------------------------------------------------------------------ helpers */

const str = (v) => (v === undefined || v === null ? '' : String(v).trim());
const nullableStr = (v) => (str(v) === '' ? null : str(v));
const bool = (v) => (v === true || v === 1 || v === '1' || v === 'true' ? 1 : 0);

function idOrNull(v, name, problems) {
  if (v === undefined || v === null || v === '' || v === 0) return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) {
    problems.push(`${name} is not a valid selection.`);
    return null;
  }
  return n;
}

/** A JSON object narrowed to the keys we understand; anything else is dropped. */
function jsonObject(value, keys) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const src = typeof value === 'string' ? safeParse(value) : value;
  if (!src || typeof src !== 'object' || Array.isArray(src)) return null;
  const out = {};
  for (const k of keys) {
    const v = str(src[k]);
    if (v) out[k] = v.slice(0, 500);
  }
  return Object.keys(out).length ? out : null;
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const readJson = (v) => (typeof v === 'string' ? safeParse(v) : (v ?? null));

/** HH:MM or HH:MM:SS, or null. Both times must be given together or not at all. */
function timeOrNull(value, name, problems) {
  if (value === undefined || value === null || str(value) === '') return null;
  const s = str(value);
  const m = /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/.exec(s);
  if (!m) {
    problems.push(`${name} must be a time as HH:MM.`);
    return null;
  }
  return `${m[1]}:${m[2]}:${m[3] ?? '00'}`;
}

function dateOnly(value, name, problems) {
  const s = str(value).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s))) {
    problems.push(`${name} must be a date as YYYY-MM-DD.`);
    return null;
  }
  return s;
}

function enumOf(value, allowed, name, problems, fallback) {
  if (value === undefined) return fallback;
  const v = str(value).toUpperCase();
  if (!allowed.includes(v)) {
    problems.push(`${name} must be one of ${allowed.join(', ')}.`);
    return fallback;
  }
  return v;
}

function intInRange(value, min, max, name, problems, fallback = 0) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    problems.push(`${name} must be a whole number between ${min} and ${max}.`);
    return fallback;
  }
  return n;
}

async function requireRow(db, table, companyId, id, label) {
  const [[row]] = await db.query(
    `SELECT * FROM ${table} WHERE company_id = ? AND id = ? AND deleted_at IS NULL`,
    [companyId, id],
  );
  if (!row) throw notFound(label);
  return row;
}

/**
 * Rule 3. The unique index would catch this, but as errno 1062 on an index name.
 * Naming the row that already holds the code is the difference between "fix it"
 * and "try something else and see".
 */
async function assertCodeFree(db, table, companyId, code, excludeId, label) {
  if (!code) return;
  const [[clash]] = await db.query(
    `SELECT id, name FROM ${table}
      WHERE company_id = ? AND deleted_at IS NULL AND LOWER(code) = LOWER(?) AND id <> ?`,
    [companyId, code, excludeId ?? 0],
  );
  if (clash) {
    throw conflict('DUPLICATE', `${label} code "${code}" is already used by ${clash.name}.`, {
      problems: [`Code "${code}" is already used by ${clash.name}. Codes are matched without case, so "u2" and "U2" are the same code.`],
      existing: { id: clash.id, name: clash.name },
    });
  }
}

async function assertNameFree(db, table, companyId, name, excludeId, label, why) {
  const [[clash]] = await db.query(
    `SELECT id FROM ${table}
      WHERE company_id = ? AND deleted_at IS NULL AND LOWER(name) = LOWER(?) AND id <> ?`,
    [companyId, name, excludeId ?? 0],
  );
  if (clash) {
    throw conflict('DUPLICATE', `A ${label.toLowerCase()} named "${name}" already exists.`, {
      problems: [`"${name}" already exists. ${why}`],
      existing: { id: clash.id },
    });
  }
}

/**
 * Rule 1. Walks UP from the proposed parent. The guard counter matters as much
 * as the check: if a loop already exists above the parent (imported data, a row
 * edited before this service existed), an unguarded walk never returns and the
 * request hangs instead of failing.
 */
async function assertNoCycle(db, table, parentCol, companyId, id, parentId, label) {
  if (!parentId) return;
  if (id && parentId === id) {
    throw invalid('CYCLE', `A ${label.toLowerCase()} cannot be its own parent.`, {
      problems: [`A ${label.toLowerCase()} cannot be its own parent.`],
    });
  }
  let cursor = parentId;
  let guard = 0;
  while (cursor) {
    guard += 1;
    if (guard > MAX_DEPTH) {
      throw invalid('CYCLE', `The ${label.toLowerCase()} hierarchy above this row is more than ${MAX_DEPTH} levels deep or already contains a loop.`, {
        problems: [`The hierarchy above the chosen parent is more than ${MAX_DEPTH} levels deep, or already loops. Fix that branch before moving anything into it.`],
      });
    }
    // eslint-disable-next-line no-await-in-loop -- a walk up a parent chain is inherently serial
    const [[row]] = await db.query(
      `SELECT id, ${parentCol} AS parent_id, name FROM ${table} WHERE company_id = ? AND id = ? AND deleted_at IS NULL`,
      [companyId, cursor],
    );
    if (!row) {
      throw invalid('BAD_REFERENCE', `The chosen parent ${label.toLowerCase()} does not exist.`, {
        problems: [`The chosen parent ${label.toLowerCase()} does not exist in this company.`],
      });
    }
    if (id && row.id === id) {
      throw invalid('CYCLE', `That would put ${label.toLowerCase()} inside itself.`, {
        problems: [`"${row.name}" is already below this ${label.toLowerCase()}, so it cannot also be its parent.`],
      });
    }
    cursor = row.parent_id;
  }
}

/** Rule 2. Names the children, up to four of them, then counts the rest. */
async function assertNoLiveChildren(db, table, parentCol, companyId, id, label) {
  const [kids] = await db.query(
    `SELECT id, name FROM ${table} WHERE company_id = ? AND ${parentCol} = ? AND deleted_at IS NULL ORDER BY name`,
    [companyId, id],
  );
  if (!kids.length) return;
  const named = kids.slice(0, 4).map((k) => k.name);
  const rest = kids.length - named.length;
  const list = named.join(', ') + (rest > 0 ? ` and ${rest} more` : '');
  throw conflict('HAS_CHILDREN', `${label} still has ${kids.length} ${kids.length === 1 ? 'child' : 'children'}: ${list}.`, {
    problems: [`Move or delete ${list} first — deleting this row would leave ${kids.length === 1 ? 'it' : 'them'} pointing at a ${label.toLowerCase()} nobody can see.`],
  });
}

/**
 * Refuses a soft delete that would leave dangling references. `refs` is a list
 * of { table, column, label } — one COUNT each, which is cheap and readable, and
 * says exactly what is in the way rather than "record in use".
 */
async function assertNotReferenced(db, companyId, id, refs) {
  const blocking = [];
  for (const ref of refs) {
    // eslint-disable-next-line no-await-in-loop -- a handful of counts; parallelising them on one pooled connection is not safe
    const [[row]] = await db.query(
      `SELECT COUNT(*) AS n FROM ${ref.table} WHERE company_id = ? AND ${ref.column} = ? AND deleted_at IS NULL`,
      [companyId, id],
    );
    const n = Number(row.n);
    if (n > 0) blocking.push(`${n} ${n === 1 ? ref.label : (ref.plural ?? `${ref.label}s`)}`);
  }
  if (blocking.length) {
    throw conflict('IN_USE', `Still in use by ${blocking.join(', ')}.`, {
      problems: [`This is still referenced by ${blocking.join(', ')}. Set it inactive instead — an inactive row keeps its history and stops appearing in pickers.`],
    });
  }
}

/** Append-only; written in the caller's transaction (init.sql §9c). */
async function audit(db, c, entityType, entityId, action, before, after) {
  await db.query(
    `INSERT INTO hrms_audit_log (company_id, actor_user_id, entity_type, entity_id, action, before_json, after_json, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      c.companyId,
      c.userId,
      entityType,
      entityId,
      action,
      before ? JSON.stringify(before) : null,
      after ? JSON.stringify(after) : null,
      c.userId,
    ],
  );
}

/** INSERT/UPDATE from a column->value map, so each entity says its fields once. */
async function insertRow(db, table, companyId, userId, fields) {
  const cols = Object.keys(fields);
  const [r] = await db.query(
    `INSERT INTO ${table} (company_id, ${cols.join(', ')}, created_by)
     VALUES (?, ${cols.map(() => '?').join(', ')}, ?)`,
    [companyId, ...cols.map((k) => fields[k]), userId],
  );
  return r.insertId;
}

async function updateRow(db, table, companyId, id, fields) {
  const cols = Object.keys(fields);
  if (!cols.length) return;
  await db.query(
    `UPDATE ${table} SET ${cols.map((k) => `${k} = ?`).join(', ')} WHERE company_id = ? AND id = ?`,
    [...cols.map((k) => fields[k]), companyId, id],
  );
}

async function softDelete(db, table, companyId, id) {
  await db.query(`UPDATE ${table} SET deleted_at = NOW() WHERE company_id = ? AND id = ?`, [companyId, id]);
}

/**
 * Flattens a self-parenting table into PRE-ORDER with depth and child counts —
 * the shape a Hierarchy screen (DESIGN_SYSTEM.md §4.7) renders directly, one row
 * per line, indented by depth.
 *
 * A row whose parent is missing or soft-deleted is treated as a root rather than
 * dropped. Hiding it would make a row invisible with no way to fix it; showing
 * it at the top with `orphaned` set is recoverable. The same pass is the last
 * line of defence against a pre-existing loop: a node already emitted is never
 * emitted again, so a cycle truncates instead of hanging the request.
 */
function toPreOrder(rows, parentKey, mapRow) {
  const byId = new Map();
  for (const r of rows) byId.set(r.id, r);
  const childrenOf = new Map();
  const roots = [];
  for (const r of rows) {
    const parentId = r[parentKey];
    if (parentId && byId.has(parentId)) {
      if (!childrenOf.has(parentId)) childrenOf.set(parentId, []);
      childrenOf.get(parentId).push(r);
    } else {
      roots.push(r);
    }
  }
  const out = [];
  const seen = new Set();
  const walk = (row, depth, path) => {
    if (seen.has(row.id)) return;
    seen.add(row.id);
    const kids = childrenOf.get(row.id) ?? [];
    const here = [...path, row.name];
    out.push({
      ...mapRow(row),
      depth,
      childCount: kids.length,
      path: here.join(' › '),
      orphaned: !!row[parentKey] && !byId.has(row[parentKey]),
    });
    for (const kid of kids) walk(kid, depth + 1, here);
  };
  for (const root of roots) walk(root, 0, []);
  // Anything left is inside a cycle that predates the check — surface it flat
  // rather than silently losing rows from a screen that is meant to show all.
  for (const r of rows) if (!seen.has(r.id)) {
    seen.add(r.id);
    out.push({ ...mapRow(r), depth: 0, childCount: 0, path: r.name, orphaned: true, inCycle: true });
  }
  return out;
}

/* --------------------------------------------------------------- lookups */

/**
 * One request for every picker on these screens. Work contexts need locations
 * and departments; holidays need locations. Three round trips to draw one dialog
 * is how a screen starts feeling slow for no reason a user can name.
 */
export async function lookups(db, companyId) {
  const [locations] = await db.query(
    `SELECT id, code, name, location_type, status FROM hrms_locations
      WHERE company_id = ? AND deleted_at IS NULL ORDER BY name`,
    [companyId],
  );
  const [departments] = await db.query(
    `SELECT id, code, name, status FROM hrms_departments
      WHERE company_id = ? AND deleted_at IS NULL ORDER BY name`,
    [companyId],
  );
  const [shifts] = await db.query(
    `SELECT id, code, name, status FROM hrms_shifts
      WHERE company_id = ? AND deleted_at IS NULL ORDER BY code`,
    [companyId],
  );
  return {
    locations: locations.map((r) => ({ id: r.id, code: r.code, name: r.name, locationType: r.location_type, status: r.status })),
    departments: departments.map((r) => ({ id: r.id, code: r.code, name: r.name, status: r.status })),
    shifts: shifts.map((r) => ({ id: r.id, code: r.code, name: r.name, status: r.status })),
    locationTypes: LOCATION_TYPES,
    contextTypes: CONTEXT_TYPES,
    statuses: STATUSES,
  };
}

/* ------------------------------------------------------------ departments */

const mapDepartment = (r) => ({
  id: r.id,
  code: r.code,
  name: r.name,
  parentId: r.parent_department_id,
  status: r.status,
  createdAt: r.created_at,
});

export async function listDepartments(db, companyId) {
  const [rows] = await db.query(
    `SELECT id, code, name, parent_department_id, status, created_at
       FROM hrms_departments WHERE company_id = ? AND deleted_at IS NULL
      ORDER BY name`,
    [companyId],
  );
  return { rows: toPreOrder(rows, 'parent_department_id', mapDepartment) };
}

function departmentFields(input, problems, { partial = false } = {}) {
  const out = {};
  if (!partial || input.name !== undefined) {
    const name = str(input.name);
    if (!name || name.length > 200) problems.push('Name is required, up to 200 characters.');
    out.name = name;
  }
  if (!partial || input.code !== undefined) {
    const code = nullableStr(input.code);
    if (code && (!CODE_RE.test(code) || code.length > 50)) {
      problems.push('Code: up to 50 letters, digits, "_", "-" or "." with no spaces. Leave it blank if you do not use codes.');
    }
    out.code = code;
  }
  if (input.status !== undefined) out.status = enumOf(input.status, STATUSES, 'Status', problems, 'ACTIVE');
  return out;
}

export async function createDepartment(db, c, input = {}) {
  const problems = [];
  const fields = departmentFields(input, problems);
  const parentId = idOrNull(input.parentId, 'Parent department', problems);
  assertNoProblems(problems);
  await assertCodeFree(db, 'hrms_departments', c.companyId, fields.code, null, 'Department');
  await assertNoCycle(db, 'hrms_departments', 'parent_department_id', c.companyId, null, parentId, 'Department');
  const id = await insertRow(db, 'hrms_departments', c.companyId, c.userId, {
    ...fields,
    parent_department_id: parentId,
    status: fields.status ?? 'ACTIVE',
  });
  await audit(db, c, 'hrms_departments', id, 'CREATE', null, { ...fields, parent_department_id: parentId });
  return getDepartment(db, c.companyId, id);
}

export async function updateDepartment(db, c, id, input = {}) {
  const before = await requireRow(db, 'hrms_departments', c.companyId, id, 'Department');
  const problems = [];
  const fields = departmentFields(input, problems, { partial: true });
  assertNoProblems(problems);
  if (fields.code !== undefined) await assertCodeFree(db, 'hrms_departments', c.companyId, fields.code, id, 'Department');
  if (input.parentId !== undefined) {
    const parentId = idOrNull(input.parentId, 'Parent department', problems);
    assertNoProblems(problems);
    await assertNoCycle(db, 'hrms_departments', 'parent_department_id', c.companyId, id, parentId, 'Department');
    fields.parent_department_id = parentId;
  }
  await updateRow(db, 'hrms_departments', c.companyId, id, fields);
  await audit(db, c, 'hrms_departments', id, 'UPDATE', mapDepartment(before), fields);
  return getDepartment(db, c.companyId, id);
}

export async function deleteDepartment(db, c, id) {
  const before = await requireRow(db, 'hrms_departments', c.companyId, id, 'Department');
  await assertNoLiveChildren(db, 'hrms_departments', 'parent_department_id', c.companyId, id, 'Department');
  await assertNotReferenced(db, c.companyId, id, [
    { table: 'hrms_work_contexts', column: 'department_id', label: 'work context' },
    { table: 'hrms_roles', column: 'default_department_id', label: 'role' },
    { table: 'hrms_positions', column: 'department_id', label: 'position' },
    { table: 'hrms_work_assignments', column: 'department_id', label: 'work assignment' },
  ]);
  await softDelete(db, 'hrms_departments', c.companyId, id);
  await audit(db, c, 'hrms_departments', id, 'DELETE', mapDepartment(before), null);
  return { ok: true, id };
}

async function getDepartment(db, companyId, id) {
  const row = await requireRow(db, 'hrms_departments', companyId, id, 'Department');
  return mapDepartment(row);
}

/* -------------------------------------------------------------- locations */

const mapLocation = (r) => ({
  id: r.id,
  code: r.code,
  name: r.name,
  locationType: r.location_type,
  parentId: r.parent_location_id,
  address: readJson(r.address_json),
  status: r.status,
  createdAt: r.created_at,
});

export async function listLocations(db, companyId) {
  const [rows] = await db.query(
    `SELECT id, code, name, location_type, parent_location_id, address_json, status, created_at
       FROM hrms_locations WHERE company_id = ? AND deleted_at IS NULL
      ORDER BY name`,
    [companyId],
  );
  return { rows: toPreOrder(rows, 'parent_location_id', mapLocation), locationTypes: LOCATION_TYPES };
}

function locationFields(input, problems, { partial = false } = {}) {
  const out = {};
  if (!partial || input.name !== undefined) {
    const name = str(input.name);
    if (!name || name.length > 200) problems.push('Name is required, up to 200 characters.');
    out.name = name;
  }
  if (!partial || input.code !== undefined) {
    const code = nullableStr(input.code);
    if (code && (!CODE_RE.test(code) || code.length > 50)) {
      problems.push('Code: up to 50 letters, digits, "_", "-" or "." with no spaces. Leave it blank if you do not use codes.');
    }
    out.code = code;
  }
  if (!partial || input.locationType !== undefined) {
    out.location_type = enumOf(input.locationType, LOCATION_TYPES, 'Type', problems, 'PLANT');
  }
  if (input.address !== undefined) {
    const address = jsonObject(input.address, ADDRESS_KEYS);
    out.address_json = address ? JSON.stringify(address) : null;
  }
  if (input.status !== undefined) out.status = enumOf(input.status, STATUSES, 'Status', problems, 'ACTIVE');
  return out;
}

export async function createLocation(db, c, input = {}) {
  const problems = [];
  const fields = locationFields(input, problems);
  const parentId = idOrNull(input.parentId, 'Parent location', problems);
  assertNoProblems(problems);
  await assertCodeFree(db, 'hrms_locations', c.companyId, fields.code, null, 'Location');
  await assertNoCycle(db, 'hrms_locations', 'parent_location_id', c.companyId, null, parentId, 'Location');
  const id = await insertRow(db, 'hrms_locations', c.companyId, c.userId, {
    ...fields,
    parent_location_id: parentId,
    status: fields.status ?? 'ACTIVE',
  });
  await audit(db, c, 'hrms_locations', id, 'CREATE', null, { ...fields, parent_location_id: parentId });
  return getLocation(db, c.companyId, id);
}

export async function updateLocation(db, c, id, input = {}) {
  const before = await requireRow(db, 'hrms_locations', c.companyId, id, 'Location');
  const problems = [];
  const fields = locationFields(input, problems, { partial: true });
  assertNoProblems(problems);
  if (fields.code !== undefined) await assertCodeFree(db, 'hrms_locations', c.companyId, fields.code, id, 'Location');
  if (input.parentId !== undefined) {
    const parentId = idOrNull(input.parentId, 'Parent location', problems);
    assertNoProblems(problems);
    await assertNoCycle(db, 'hrms_locations', 'parent_location_id', c.companyId, id, parentId, 'Location');
    fields.parent_location_id = parentId;
  }
  await updateRow(db, 'hrms_locations', c.companyId, id, fields);
  await audit(db, c, 'hrms_locations', id, 'UPDATE', mapLocation(before), fields);
  return getLocation(db, c.companyId, id);
}

export async function deleteLocation(db, c, id) {
  const before = await requireRow(db, 'hrms_locations', c.companyId, id, 'Location');
  await assertNoLiveChildren(db, 'hrms_locations', 'parent_location_id', c.companyId, id, 'Location');
  await assertNotReferenced(db, c.companyId, id, [
    { table: 'hrms_work_contexts', column: 'location_id', label: 'work context' },
    { table: 'hrms_holidays', column: 'location_id', label: 'holiday' },
    { table: 'hrms_positions', column: 'location_id', label: 'position' },
    { table: 'hrms_work_assignments', column: 'location_id', label: 'work assignment' },
  ]);
  await softDelete(db, 'hrms_locations', c.companyId, id);
  await audit(db, c, 'hrms_locations', id, 'DELETE', mapLocation(before), null);
  return { ok: true, id };
}

async function getLocation(db, companyId, id) {
  const row = await requireRow(db, 'hrms_locations', companyId, id, 'Location');
  return mapLocation(row);
}

/* ---------------------------------------------------------- work contexts */

const mapContext = (r) => ({
  id: r.id,
  code: r.code,
  name: r.name,
  contextType: r.context_type,
  locationId: r.location_id,
  locationName: r.location_name ?? null,
  departmentId: r.department_id,
  departmentName: r.department_name ?? null,
  parentId: r.parent_context_id,
  externalRef: r.external_ref,
  status: r.status,
  createdAt: r.created_at,
});

export async function listWorkContexts(db, companyId) {
  const [rows] = await db.query(
    `SELECT w.id, w.code, w.name, w.context_type, w.location_id, w.department_id, w.parent_context_id,
            w.external_ref, w.status, w.created_at,
            l.name AS location_name, d.name AS department_name
       FROM hrms_work_contexts w
       LEFT JOIN hrms_locations   l ON l.company_id = w.company_id AND l.id = w.location_id   AND l.deleted_at IS NULL
       LEFT JOIN hrms_departments d ON d.company_id = w.company_id AND d.id = w.department_id AND d.deleted_at IS NULL
      WHERE w.company_id = ? AND w.deleted_at IS NULL
      ORDER BY w.name`,
    [companyId],
  );
  return { rows: toPreOrder(rows, 'parent_context_id', mapContext), contextTypes: CONTEXT_TYPES };
}

function contextFields(input, problems, { partial = false } = {}) {
  const out = {};
  if (!partial || input.name !== undefined) {
    const name = str(input.name);
    if (!name || name.length > 200) problems.push('Name is required, up to 200 characters.');
    out.name = name;
  }
  if (!partial || input.code !== undefined) {
    const code = nullableStr(input.code);
    if (code && (!CODE_RE.test(code) || code.length > 50)) {
      problems.push('Code: up to 50 letters, digits, "_", "-" or "." with no spaces. Leave it blank if you do not use codes.');
    }
    out.code = code;
  }
  if (!partial || input.contextType !== undefined) {
    out.context_type = enumOf(input.contextType, CONTEXT_TYPES, 'Type', problems, 'MACHINE');
  }
  if (input.externalRef !== undefined) {
    const ref = nullableStr(input.externalRef);
    if (ref && ref.length > 100) problems.push('External reference is up to 100 characters.');
    out.external_ref = ref;
  }
  if (input.status !== undefined) out.status = enumOf(input.status, STATUSES, 'Status', problems, 'ACTIVE');
  return out;
}

export async function createWorkContext(db, c, input = {}) {
  const problems = [];
  const fields = contextFields(input, problems);
  const parentId = idOrNull(input.parentId, 'Parent context', problems);
  const locationId = idOrNull(input.locationId, 'Location', problems);
  const departmentId = idOrNull(input.departmentId, 'Department', problems);
  assertNoProblems(problems);
  await assertCodeFree(db, 'hrms_work_contexts', c.companyId, fields.code, null, 'Work context');
  // uq_hwct_name exists so the org-chart import collapses the same machine
  // appearing under two nodes into one context. Say that, rather than 1062.
  await assertNameFree(db, 'hrms_work_contexts', c.companyId, fields.name, null, 'Work context',
    'A machine, line or area is named once and then linked to as many positions and assignments as cover it.');
  await assertNoCycle(db, 'hrms_work_contexts', 'parent_context_id', c.companyId, null, parentId, 'Work context');
  const id = await insertRow(db, 'hrms_work_contexts', c.companyId, c.userId, {
    ...fields,
    parent_context_id: parentId,
    location_id: locationId,
    department_id: departmentId,
    status: fields.status ?? 'ACTIVE',
  });
  await audit(db, c, 'hrms_work_contexts', id, 'CREATE', null, { ...fields, parent_context_id: parentId, location_id: locationId, department_id: departmentId });
  return getWorkContext(db, c.companyId, id);
}

export async function updateWorkContext(db, c, id, input = {}) {
  const before = await requireRow(db, 'hrms_work_contexts', c.companyId, id, 'Work context');
  const problems = [];
  const fields = contextFields(input, problems, { partial: true });
  assertNoProblems(problems);
  if (fields.code !== undefined) await assertCodeFree(db, 'hrms_work_contexts', c.companyId, fields.code, id, 'Work context');
  if (fields.name !== undefined) {
    await assertNameFree(db, 'hrms_work_contexts', c.companyId, fields.name, id, 'Work context',
      'A machine, line or area is named once and then linked to as many positions and assignments as cover it.');
  }
  if (input.parentId !== undefined) {
    const parentId = idOrNull(input.parentId, 'Parent context', problems);
    assertNoProblems(problems);
    await assertNoCycle(db, 'hrms_work_contexts', 'parent_context_id', c.companyId, id, parentId, 'Work context');
    fields.parent_context_id = parentId;
  }
  if (input.locationId !== undefined) {
    fields.location_id = idOrNull(input.locationId, 'Location', problems);
    assertNoProblems(problems);
  }
  if (input.departmentId !== undefined) {
    fields.department_id = idOrNull(input.departmentId, 'Department', problems);
    assertNoProblems(problems);
  }
  await updateRow(db, 'hrms_work_contexts', c.companyId, id, fields);
  await audit(db, c, 'hrms_work_contexts', id, 'UPDATE', mapContext(before), fields);
  return getWorkContext(db, c.companyId, id);
}

export async function deleteWorkContext(db, c, id) {
  const before = await requireRow(db, 'hrms_work_contexts', c.companyId, id, 'Work context');
  await assertNoLiveChildren(db, 'hrms_work_contexts', 'parent_context_id', c.companyId, id, 'Work context');
  await assertNotReferenced(db, c.companyId, id, [
    { table: 'hrms_position_work_contexts', column: 'work_context_id', label: 'position link' },
    { table: 'hrms_work_assignment_contexts', column: 'work_context_id', label: 'assignment link' },
    { table: 'hrms_position_reporting_relationships', column: 'scope_work_context_id', label: 'reporting scope' },
    { table: 'hrms_assignment_reporting_relationships', column: 'scope_work_context_id', label: 'reporting scope' },
    { table: 'hrms_manpower_requirements', column: 'work_context_id', label: 'manpower requirement' },
    { table: 'hrms_shift_rosters', column: 'work_context_id', label: 'roster entry', plural: 'roster entries' },
  ]);
  await softDelete(db, 'hrms_work_contexts', c.companyId, id);
  await audit(db, c, 'hrms_work_contexts', id, 'DELETE', mapContext(before), null);
  return { ok: true, id };
}

async function getWorkContext(db, companyId, id) {
  const [[row]] = await db.query(
    `SELECT w.*, l.name AS location_name, d.name AS department_name
       FROM hrms_work_contexts w
       LEFT JOIN hrms_locations   l ON l.company_id = w.company_id AND l.id = w.location_id
       LEFT JOIN hrms_departments d ON d.company_id = w.company_id AND d.id = w.department_id
      WHERE w.company_id = ? AND w.id = ? AND w.deleted_at IS NULL`,
    [companyId, id],
  );
  if (!row) throw notFound('Work context');
  return mapContext(row);
}

/* ------------------------------------------------------------ contractors */

const mapContractor = (r) => ({
  id: r.id,
  code: r.code,
  name: r.name,
  contact: readJson(r.contact_json),
  status: r.status,
  employeeCount: Number(r.employee_count ?? 0),
  createdAt: r.created_at,
});

export async function listContractors(db, companyId) {
  const [rows] = await db.query(
    `SELECT k.id, k.code, k.name, k.contact_json, k.status, k.created_at,
            (SELECT COUNT(*) FROM hrms_employees e
              WHERE e.company_id = k.company_id AND e.contractor_id = k.id AND e.deleted_at IS NULL) AS employee_count
       FROM hrms_contractors k
      WHERE k.company_id = ? AND k.deleted_at IS NULL
      ORDER BY k.name`,
    [companyId],
  );
  return { rows: rows.map(mapContractor) };
}

function contractorFields(input, problems, { partial = false } = {}) {
  const out = {};
  if (!partial || input.name !== undefined) {
    const name = str(input.name);
    if (!name || name.length > 200) problems.push('Name is required, up to 200 characters.');
    out.name = name;
  }
  if (!partial || input.code !== undefined) {
    const code = nullableStr(input.code);
    if (code && (!CODE_RE.test(code) || code.length > 50)) {
      problems.push('Code: up to 50 letters, digits, "_", "-" or "." with no spaces. Leave it blank if you do not use codes.');
    }
    out.code = code;
  }
  if (input.contact !== undefined) {
    const contact = jsonObject(input.contact, CONTACT_KEYS);
    if (contact?.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(contact.email)) problems.push('Email does not look like an email address.');
    out.contact_json = contact ? JSON.stringify(contact) : null;
  }
  if (input.status !== undefined) out.status = enumOf(input.status, STATUSES, 'Status', problems, 'ACTIVE');
  return out;
}

export async function createContractor(db, c, input = {}) {
  const problems = [];
  const fields = contractorFields(input, problems);
  assertNoProblems(problems);
  await assertCodeFree(db, 'hrms_contractors', c.companyId, fields.code, null, 'Contractor');
  await assertNameFree(db, 'hrms_contractors', c.companyId, fields.name, null, 'Contractor',
    'One row per employer — the same agency supplying two departments is still one contractor.');
  const id = await insertRow(db, 'hrms_contractors', c.companyId, c.userId, { ...fields, status: fields.status ?? 'ACTIVE' });
  await audit(db, c, 'hrms_contractors', id, 'CREATE', null, fields);
  return getContractor(db, c.companyId, id);
}

export async function updateContractor(db, c, id, input = {}) {
  const before = await requireRow(db, 'hrms_contractors', c.companyId, id, 'Contractor');
  const problems = [];
  const fields = contractorFields(input, problems, { partial: true });
  assertNoProblems(problems);
  if (fields.code !== undefined) await assertCodeFree(db, 'hrms_contractors', c.companyId, fields.code, id, 'Contractor');
  if (fields.name !== undefined) {
    await assertNameFree(db, 'hrms_contractors', c.companyId, fields.name, id, 'Contractor',
      'One row per employer — the same agency supplying two departments is still one contractor.');
  }
  await updateRow(db, 'hrms_contractors', c.companyId, id, fields);
  await audit(db, c, 'hrms_contractors', id, 'UPDATE', mapContractor(before), fields);
  return getContractor(db, c.companyId, id);
}

export async function deleteContractor(db, c, id) {
  const before = await requireRow(db, 'hrms_contractors', c.companyId, id, 'Contractor');
  await assertNotReferenced(db, c.companyId, id, [
    { table: 'hrms_employees', column: 'contractor_id', label: 'employee' },
  ]);
  await softDelete(db, 'hrms_contractors', c.companyId, id);
  await audit(db, c, 'hrms_contractors', id, 'DELETE', mapContractor(before), null);
  return { ok: true, id };
}

async function getContractor(db, companyId, id) {
  const row = await requireRow(db, 'hrms_contractors', companyId, id, 'Contractor');
  return mapContractor(row);
}

/* ----------------------------------------------------------------- shifts */

const mapShift = (r) => ({
  id: r.id,
  code: r.code,
  name: r.name,
  // NULL start/end is the FLEXIBLE shift and is deliberate (init.sql §1e): a
  // General shift in an SME has no fixed hours, and writing 09:00–18:00 would
  // turn every late arrival into a fabricated exception.
  startTime: r.start_time ? String(r.start_time).slice(0, 5) : null,
  endTime: r.end_time ? String(r.end_time).slice(0, 5) : null,
  isFlexible: !r.start_time && !r.end_time,
  crossesMidnight: !!r.crosses_midnight,
  graceInMinutes: Number(r.grace_in_minutes),
  graceOutMinutes: Number(r.grace_out_minutes),
  status: r.status,
  createdAt: r.created_at,
});

export async function listShifts(db, companyId) {
  const [rows] = await db.query(
    `SELECT id, code, name, start_time, end_time, crosses_midnight, grace_in_minutes, grace_out_minutes, status, created_at
       FROM hrms_shifts WHERE company_id = ? AND deleted_at IS NULL
      ORDER BY status, code`,
    [companyId],
  );
  return { rows: rows.map(mapShift) };
}

function shiftFields(input, problems, { partial = false, current = null } = {}) {
  const out = {};
  if (!partial || input.code !== undefined) {
    const code = str(input.code);
    if (!code || !CODE_RE.test(code) || code.length > 50) {
      problems.push('Code is required: up to 50 letters, digits, "_", "-" or "." with no spaces (G, D, N).');
    }
    out.code = code;
  }
  if (!partial || input.name !== undefined) {
    const name = str(input.name);
    if (!name || name.length > 100) problems.push('Name is required, up to 100 characters.');
    out.name = name;
  }
  const touchesTimes = !partial || input.startTime !== undefined || input.endTime !== undefined;
  if (touchesTimes) {
    const start = timeOrNull(input.startTime, 'Start time', problems);
    const end = timeOrNull(input.endTime, 'End time', problems);
    // A half-specified shift is the one state the attendance service cannot
    // read: it is neither "flexible" nor "these are the hours".
    if (!!start !== !!end) {
      problems.push('Give both a start and an end time, or leave both blank for a flexible shift with no fixed hours.');
    }
    out.start_time = start;
    out.end_time = end;
  }
  if (!partial || input.crossesMidnight !== undefined) out.crosses_midnight = bool(input.crossesMidnight);
  if (input.graceInMinutes !== undefined) out.grace_in_minutes = intInRange(input.graceInMinutes, 0, 240, 'Grace in', problems);
  if (input.graceOutMinutes !== undefined) out.grace_out_minutes = intInRange(input.graceOutMinutes, 0, 240, 'Grace out', problems);
  if (input.status !== undefined) out.status = enumOf(input.status, STATUSES, 'Status', problems, 'ACTIVE');

  // crosses_midnight is STORED, not derived (init.sql §1e) — so it can disagree
  // with the clock, and a night shift filed as a day shift silently halves every
  // shift-length calculation downstream.
  const start = out.start_time !== undefined ? out.start_time : current?.start_time ?? null;
  const end = out.end_time !== undefined ? out.end_time : current?.end_time ?? null;
  const crosses = out.crosses_midnight !== undefined ? out.crosses_midnight : (current?.crosses_midnight ? 1 : 0);
  if (start && end) {
    if (end <= start && !crosses) problems.push('This shift ends before it starts, so tick "crosses midnight" — or correct the times.');
    if (end > start && crosses) problems.push('"Crosses midnight" is ticked but the end time is later the same day. Untick it, or correct the times.');
  }
  return out;
}

export async function createShift(db, c, input = {}) {
  const problems = [];
  const fields = shiftFields(input, problems);
  assertNoProblems(problems);
  await assertCodeFree(db, 'hrms_shifts', c.companyId, fields.code, null, 'Shift');
  const id = await insertRow(db, 'hrms_shifts', c.companyId, c.userId, {
    ...fields,
    crosses_midnight: fields.crosses_midnight ?? 0,
    grace_in_minutes: fields.grace_in_minutes ?? 0,
    grace_out_minutes: fields.grace_out_minutes ?? 0,
    status: fields.status ?? 'ACTIVE',
  });
  await audit(db, c, 'hrms_shifts', id, 'CREATE', null, fields);
  return getShift(db, c.companyId, id);
}

export async function updateShift(db, c, id, input = {}) {
  const before = await requireRow(db, 'hrms_shifts', c.companyId, id, 'Shift');
  const problems = [];
  const fields = shiftFields(input, problems, { partial: true, current: before });
  assertNoProblems(problems);
  if (fields.code !== undefined) await assertCodeFree(db, 'hrms_shifts', c.companyId, fields.code, id, 'Shift');
  await updateRow(db, 'hrms_shifts', c.companyId, id, fields);
  await audit(db, c, 'hrms_shifts', id, 'UPDATE', mapShift(before), fields);
  return getShift(db, c.companyId, id);
}

export async function deleteShift(db, c, id) {
  const before = await requireRow(db, 'hrms_shifts', c.companyId, id, 'Shift');
  await assertNotReferenced(db, c.companyId, id, [
    { table: 'hrms_positions', column: 'default_shift_id', label: 'position' },
    { table: 'hrms_work_assignments', column: 'default_shift_id', label: 'work assignment' },
    { table: 'hrms_shift_rosters', column: 'shift_id', label: 'roster entry', plural: 'roster entries' },
    { table: 'hrms_attendance_records', column: 'shift_id', label: 'attendance record' },
    { table: 'hrms_manpower_requirements', column: 'shift_id', label: 'manpower requirement' },
  ]);
  await softDelete(db, 'hrms_shifts', c.companyId, id);
  await audit(db, c, 'hrms_shifts', id, 'DELETE', mapShift(before), null);
  return { ok: true, id };
}

async function getShift(db, companyId, id) {
  const row = await requireRow(db, 'hrms_shifts', companyId, id, 'Shift');
  return mapShift(row);
}

/* --------------------------------------------------------------- holidays */

const mapHoliday = (r) => ({
  id: r.id,
  holidayDate: r.holiday_date instanceof Date
    ? r.holiday_date.toISOString().slice(0, 10)
    : String(r.holiday_date).slice(0, 10),
  name: r.name,
  locationId: r.location_id,
  locationName: r.location_name ?? null,
  isOptional: !!r.is_optional,
  createdAt: r.created_at,
});

export async function listHolidays(db, companyId, { year } = {}) {
  const params = [companyId];
  let where = '';
  if (year) {
    where = ' AND YEAR(h.holiday_date) = ?';
    params.push(Number(year));
  }
  const [rows] = await db.query(
    `SELECT h.id, h.holiday_date, h.name, h.location_id, h.is_optional, h.created_at, l.name AS location_name
       FROM hrms_holidays h
       LEFT JOIN hrms_locations l ON l.company_id = h.company_id AND l.id = h.location_id AND l.deleted_at IS NULL
      WHERE h.company_id = ? AND h.deleted_at IS NULL${where}
      ORDER BY h.holiday_date`,
    params,
  );
  return { rows: rows.map(mapHoliday) };
}

function holidayFields(input, problems, { partial = false } = {}) {
  const out = {};
  if (!partial || input.holidayDate !== undefined) {
    out.holiday_date = dateOnly(input.holidayDate, 'Date', problems);
  }
  if (!partial || input.name !== undefined) {
    const name = str(input.name);
    if (!name || name.length > 200) problems.push('Name is required, up to 200 characters.');
    out.name = name;
  }
  if (input.isOptional !== undefined) out.is_optional = bool(input.isOptional);
  return out;
}

export async function createHoliday(db, c, input = {}) {
  const problems = [];
  const fields = holidayFields(input, problems);
  const locationId = idOrNull(input.locationId, 'Location', problems);
  assertNoProblems(problems);
  await assertHolidayFree(db, c.companyId, fields.holiday_date, locationId, null);
  const id = await insertRow(db, 'hrms_holidays', c.companyId, c.userId, {
    ...fields,
    location_id: locationId,
    is_optional: fields.is_optional ?? 0,
  });
  await audit(db, c, 'hrms_holidays', id, 'CREATE', null, { ...fields, location_id: locationId });
  return getHoliday(db, c.companyId, id);
}

export async function updateHoliday(db, c, id, input = {}) {
  const before = await requireRow(db, 'hrms_holidays', c.companyId, id, 'Holiday');
  const problems = [];
  const fields = holidayFields(input, problems, { partial: true });
  const locationId = input.locationId !== undefined
    ? idOrNull(input.locationId, 'Location', problems)
    : before.location_id;
  assertNoProblems(problems);
  if (input.locationId !== undefined) fields.location_id = locationId;
  const date = fields.holiday_date ?? (before.holiday_date instanceof Date
    ? before.holiday_date.toISOString().slice(0, 10)
    : String(before.holiday_date).slice(0, 10));
  await assertHolidayFree(db, c.companyId, date, locationId, id);
  await updateRow(db, 'hrms_holidays', c.companyId, id, fields);
  await audit(db, c, 'hrms_holidays', id, 'UPDATE', mapHoliday(before), fields);
  return getHoliday(db, c.companyId, id);
}

export async function deleteHoliday(db, c, id) {
  const before = await requireRow(db, 'hrms_holidays', c.companyId, id, 'Holiday');
  await softDelete(db, 'hrms_holidays', c.companyId, id);
  await audit(db, c, 'hrms_holidays', id, 'DELETE', mapHoliday(before), null);
  return { ok: true, id };
}

/**
 * uq_hhol_day covers (company, location_key, date) — but the index only names
 * itself. "Republic Day is already on the calendar for this location" is what a
 * person can act on.
 */
async function assertHolidayFree(db, companyId, date, locationId, excludeId) {
  const [[clash]] = await db.query(
    `SELECT id, name FROM hrms_holidays
      WHERE company_id = ? AND deleted_at IS NULL AND holiday_date = ?
        AND IFNULL(location_id, 0) = ? AND id <> ?`,
    [companyId, date, locationId ?? 0, excludeId ?? 0],
  );
  if (clash) {
    throw conflict('DUPLICATE', `${date} is already a holiday${locationId ? ' for this location' : ''}: ${clash.name}.`, {
      problems: [`${date} is already on the calendar as "${clash.name}"${locationId ? ' for this location' : ' company-wide'}. Edit that row instead of adding a second one.`],
      existing: { id: clash.id, name: clash.name },
    });
  }
}

async function getHoliday(db, companyId, id) {
  const [[row]] = await db.query(
    `SELECT h.*, l.name AS location_name FROM hrms_holidays h
       LEFT JOIN hrms_locations l ON l.company_id = h.company_id AND l.id = h.location_id
      WHERE h.company_id = ? AND h.id = ? AND h.deleted_at IS NULL`,
    [companyId, id],
  );
  if (!row) throw notFound('Holiday');
  return mapHoliday(row);
}

/* -------------------------------------------------- reporting types */

const mapReportingType = (r) => ({
  id: r.id,
  code: r.code,
  name: r.name,
  isFormal: !!r.is_formal,
  allowMultiple: !!r.allow_multiple,
  sortOrder: Number(r.sort_order),
  status: r.status,
  inUse: Number(r.in_use ?? 0),
  createdAt: r.created_at,
});

export async function listReportingTypes(db, companyId) {
  const [rows] = await db.query(
    `SELECT t.id, t.code, t.name, t.is_formal, t.allow_multiple, t.sort_order, t.status, t.created_at,
            (SELECT COUNT(*) FROM hrms_position_reporting_relationships p
              WHERE p.company_id = t.company_id AND p.relationship_type_id = t.id AND p.deleted_at IS NULL)
          + (SELECT COUNT(*) FROM hrms_assignment_reporting_relationships a
              WHERE a.company_id = t.company_id AND a.relationship_type_id = t.id AND a.deleted_at IS NULL) AS in_use
       FROM hrms_reporting_relationship_types t
      WHERE t.company_id = ? AND t.deleted_at IS NULL
      ORDER BY t.sort_order, t.code`,
    [companyId],
  );
  return { rows: rows.map(mapReportingType) };
}

function reportingTypeFields(input, problems, { partial = false } = {}) {
  const out = {};
  if (!partial || input.name !== undefined) {
    const name = str(input.name);
    if (!name || name.length > 100) problems.push('Name is required, up to 100 characters.');
    out.name = name;
  }
  if (input.isFormal !== undefined) out.is_formal = bool(input.isFormal);
  if (input.allowMultiple !== undefined) out.allow_multiple = bool(input.allowMultiple);
  if (input.sortOrder !== undefined) out.sort_order = intInRange(input.sortOrder, 0, 9999, 'Order', problems);
  if (input.status !== undefined) out.status = enumOf(input.status, STATUSES, 'Status', problems, 'ACTIVE');
  return out;
}

export async function createReportingType(db, c, input = {}) {
  const problems = [];
  const fields = reportingTypeFields(input, problems);
  const code = str(input.code).toUpperCase().replace(/\s+/g, '_');
  if (!code || !CODE_RE.test(code) || code.length > 50) {
    problems.push('Code is required: up to 50 letters, digits, "_", "-" or "." with no spaces (e.g. QUALITY_MENTOR).');
  }
  assertNoProblems(problems);
  await assertCodeFree(db, 'hrms_reporting_relationship_types', c.companyId, code, null, 'Reporting type');
  const id = await insertRow(db, 'hrms_reporting_relationship_types', c.companyId, c.userId, {
    ...fields,
    code,
    is_formal: fields.is_formal ?? 1,
    allow_multiple: fields.allow_multiple ?? 1,
    sort_order: fields.sort_order ?? 100,
    status: fields.status ?? 'ACTIVE',
  });
  await audit(db, c, 'hrms_reporting_relationship_types', id, 'CREATE', null, { ...fields, code });
  return getReportingType(db, c.companyId, id);
}

export async function updateReportingType(db, c, id, input = {}) {
  const before = await requireRow(db, 'hrms_reporting_relationship_types', c.companyId, id, 'Reporting type');
  const problems = [];
  const fields = reportingTypeFields(input, problems, { partial: true });
  // The code is the API of this table: reportingResolver, the org chart and the
  // importer all look a type up by PRIMARY_MANAGER / DOTTED_LINE. Renaming one
  // in place would quietly retarget every one of them. The display name is what
  // a company personalises.
  if (input.code !== undefined && str(input.code).toUpperCase() !== String(before.code).toUpperCase()) {
    problems.push(`The code "${before.code}" is permanent — the org chart and the importer look this type up by it. Change the name instead, or add a new type.`);
  }
  assertNoProblems(problems);
  await updateRow(db, 'hrms_reporting_relationship_types', c.companyId, id, fields);
  await audit(db, c, 'hrms_reporting_relationship_types', id, 'UPDATE', mapReportingType(before), fields);
  return getReportingType(db, c.companyId, id);
}

export async function deleteReportingType(db, c, id) {
  const before = await requireRow(db, 'hrms_reporting_relationship_types', c.companyId, id, 'Reporting type');
  await assertNotReferenced(db, c.companyId, id, [
    { table: 'hrms_position_reporting_relationships', column: 'relationship_type_id', label: 'formal reporting line' },
    { table: 'hrms_assignment_reporting_relationships', column: 'relationship_type_id', label: 'actual reporting line' },
  ]);
  await softDelete(db, 'hrms_reporting_relationship_types', c.companyId, id);
  await audit(db, c, 'hrms_reporting_relationship_types', id, 'DELETE', mapReportingType(before), null);
  return { ok: true, id };
}

async function getReportingType(db, companyId, id) {
  const row = await requireRow(db, 'hrms_reporting_relationship_types', companyId, id, 'Reporting type');
  return mapReportingType(row);
}
