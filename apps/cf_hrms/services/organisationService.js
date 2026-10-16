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
import { ensureLabels, resolveKindLabel } from './departmentLabelService.js';
import { DEPARTMENT_LABEL_ID_SQL, readModel, linkDepartmentLabel, retireDepartmentLabels } from './labelGroupService.js';
import { issueDepartmentCode, issueLocationCode, acceptImportedCode } from './codeService.js';
import { DEPARTMENT_ENTITY, LOCATION_ENTITY } from './codegenProvider.js';
import { inBatch } from '../lib/batch.js';

import {
  WEEKDAY_NAMES, hhmm, spanMinutes, shapeDay, defaultWeek, weekOf, summaryOf, weeklyHoursOf, mirrorOf, weekdayName,
} from './shiftRead.js';

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
    `SELECT id, code, name, department_type, is_shared, parent_department_id, status FROM hrms_departments
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
    departments: departments.map((r) => ({
      id: r.id, code: r.code, name: r.name, status: r.status,
      parentId: r.parent_department_id ?? null, type: r.department_type ?? null, isShared: Boolean(r.is_shared),
    })),
    shifts: shifts.map((r) => ({ id: r.id, code: r.code, name: r.name, status: r.status })),
    locationTypes: LOCATION_TYPES,
    contextTypes: CONTEXT_TYPES,
    statuses: STATUSES,
  };
}

/* ------------------------------------------------------------ departments */
// THE ONE TREE (init.sql §1b). A machine, an area and a shared crew are
// departments; `type` is the company's own label for the level and NOTHING here
// or anywhere else may branch on its text. `isShared` + `serves` are the facts:
// a shared department serves other departments (hrms_department_serves) and is
// drawn as one box pointing at each.

const mapDepartment = (r, serves = []) => ({
  id: r.id,
  code: r.code,
  name: r.name,
  parentId: r.parent_department_id,
  type: r.department_type ?? null,
  isShared: Boolean(r.is_shared),
  serves,
  status: r.status,
  createdAt: r.created_at,
  // Its ONE label: `type` is the label's name, `labelId` its id (null only for a name the list no longer has).
  labelId: r.label_id == null ? null : Number(r.label_id),
});

/** departmentId -> [served department ids], live rows only. One query for the company (or one department). */
async function servesByDepartment(db, companyId, departmentId = null) {
  const [rows] = await db.query(
    `SELECT s.department_id, s.serves_department_id
       FROM hrms_department_serves s
       JOIN hrms_departments d ON d.company_id = s.company_id AND d.id = s.serves_department_id AND d.deleted_at IS NULL
      WHERE s.company_id = ? AND s.deleted_at IS NULL${departmentId ? ' AND s.department_id = ?' : ''}
      ORDER BY s.department_id, s.serves_department_id`,
    departmentId ? [companyId, departmentId] : [companyId],
  );
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.department_id)) map.set(r.department_id, []);
    map.get(r.department_id).push(r.serves_department_id);
  }
  return map;
}

export async function listDepartments(db, companyId) {
  // The labels first: ensureLabels makes the company's list when it has none.
  const types = (await ensureLabels(db, companyId)).map((l) => l.name);
  const [rows] = await db.query(
    `SELECT d.id, d.code, d.name, d.parent_department_id, d.department_type, d.is_shared, d.status, d.created_at,
            ${DEPARTMENT_LABEL_ID_SQL('d')} AS label_id
       FROM hrms_departments d WHERE d.company_id = ? AND d.deleted_at IS NULL
      ORDER BY d.name`,
    [companyId],
  );
  const serves = await servesByDepartment(db, companyId);
  // `types`: the company's labels' names, in its order.
  return { rows: toPreOrder(rows, 'parent_department_id', (r) => mapDepartment(r, serves.get(r.id) ?? [])), types };
}

/**
 * Replace a shared department's serves list. Validates in words (TiDB holds no
 * CHECK): every id must be a live department of this company, none may be the
 * department itself, and the list is only meaningful on a shared department.
 * Rows are retired, never erased; a pair that comes back is a new row.
 */
async function writeServes(db, c, departmentId, isShared, wanted) {
  const ids = [...new Set((wanted ?? []).map((v) => Number(v)))];
  if (ids.some((v) => !Number.isInteger(v) || v <= 0)) {
    throw invalid('VALIDATION', 'Serves: every entry must be a department.', { problems: ['Serves: every entry must be a department id.'] });
  }
  if (ids.includes(departmentId)) {
    throw invalid('VALIDATION', 'A department cannot serve itself.', { problems: ['A department cannot serve itself. List the OTHER departments this one works for.'] });
  }
  if (ids.length && !isShared) {
    throw invalid('VALIDATION', 'Only a shared department serves other departments.', {
      problems: ['Only a shared department serves other departments. Mark this one as shared first, or clear the list.'],
    });
  }
  if (ids.length) {
    const [found] = await db.query(
      `SELECT id FROM hrms_departments WHERE company_id = ? AND deleted_at IS NULL AND id IN (${ids.map(() => '?').join(',')})`,
      [c.companyId, ...ids],
    );
    const have = new Set(found.map((r) => r.id));
    const missing = ids.filter((v) => !have.has(v));
    if (missing.length) {
      throw invalid('BAD_REFERENCE', 'A department this one is said to serve does not exist.', {
        problems: [`${missing.length === 1 ? 'A department' : `${missing.length} departments`} in the serves list ${missing.length === 1 ? 'does' : 'do'} not exist in this company.`],
      });
    }
  }
  const current = (await servesByDepartment(db, c.companyId, departmentId)).get(departmentId) ?? [];
  const gone = current.filter((v) => !ids.includes(v));
  const added = ids.filter((v) => !current.includes(v));
  if (gone.length) {
    await db.query(
      `UPDATE hrms_department_serves SET deleted_at = NOW()
        WHERE company_id = ? AND department_id = ? AND deleted_at IS NULL AND serves_department_id IN (${gone.map(() => '?').join(',')})`,
      [c.companyId, departmentId, ...gone],
    );
  }
  if (added.length) {
    await db.query(
      `INSERT INTO hrms_department_serves (company_id, department_id, serves_department_id, created_by)
       VALUES ${added.map(() => '(?, ?, ?, ?)').join(', ')}`,
      added.flatMap((v) => [c.companyId, departmentId, v, c.userId]),
    );
  }
  return { before: current, after: ids };
}

function departmentFields(input, problems, { partial = false } = {}) {
  const out = {};
  if (!partial || input.name !== undefined) {
    const name = str(input.name);
    if (!name || name.length > 200) problems.push('Name is required, up to 200 characters.');
    out.name = name;
  }
  // NO CODE HERE. A department's code is issued when it is created
  // (codeService) and never changes; `input.code` is not read. The label
  // (`input.type`) is checked against the company's list by the caller.
  if (input.isShared !== undefined) {
    if (![true, false, 0, 1, '0', '1'].includes(input.isShared)) problems.push('Shared must be yes or no.');
    out.is_shared = [true, 1, '1'].includes(input.isShared) ? 1 : 0;
  }
  if (input.status !== undefined) out.status = enumOf(input.status, STATUSES, 'Status', problems, 'ACTIVE');
  return out;
}

function servesInput(input, problems) {
  if (input.serves === undefined) return undefined;
  if (!Array.isArray(input.serves)) { problems.push('Serves must be a list of departments.'); return undefined; }
  return input.serves;
}

/**
 * `options.importedCode` — a code the department ALREADY HOLDS elsewhere. Only
 * the retired workbook and import scripts pass it; no route does. Everybody
 * else gets the next code of the company's rule.
 * `options.addMissingLabel` — theirs too: a label the list lacks is added to it.
 */
/**
 * A department's ONE label from a create / update body:
 *   labelId                       the label's id
 *   type / departmentType         the label by NAME (older callers, Excel, the command bar)
 * `labelId` wins when both are given. A create naming none takes the first label.
 * -> the label row, or undefined when an update does not touch it.
 */
async function departmentLabelOf(db, c, input, { creating, options }) {
  if (input.labelId !== undefined && input.labelId !== null && input.labelId !== '') {
    const model = await readModel(db, c.companyId);
    const hit = model.labelById.get(Number(input.labelId));
    if (!hit) {
      const choices = model.labels.map((l) => l.name).join(', ');
      throw invalid('INVALID', 'Choose one of this company’s labels.', { problems: [`That is not one of this company’s labels. Choose one of ${choices}.`] });
    }
    return hit;
  }
  const text = input.type !== undefined ? input.type : input.departmentType;
  if (text === undefined && !creating) return undefined;
  // The retired import may add a label to the list here.
  return resolveKindLabel(db, c.companyId, text, {
    fallbackToFirst: creating || options.addMissingLabel === true, addIfMissing: options.addMissingLabel === true, userId: c.userId,
  });
}

export async function createDepartment(db, c, input = {}, options = {}) {
  const problems = [];
  const fields = departmentFields(input, problems);
  const parentId = idOrNull(input.parentId, 'Parent department', problems);
  const serves = servesInput(input, problems);
  assertNoProblems(problems);
  // The label must be one of the company's list; a department created with none takes the first.
  const label = await departmentLabelOf(db, c, input, { creating: true, options });
  fields.department_type = label.name;
  await assertNoCycle(db, 'hrms_departments', 'parent_department_id', c.companyId, null, parentId, 'Department');
  fields.code = (await acceptImportedCode(db, c.companyId, DEPARTMENT_ENTITY, options.importedCode))
    ?? await issueDepartmentCode(db, c.companyId, { name: fields.name, type: fields.department_type, parentId, userId: c.userId });
  const id = await insertRow(db, 'hrms_departments', c.companyId, c.userId, {
    ...fields,
    parent_department_id: parentId,
    status: fields.status ?? 'ACTIVE',
  });
  await linkDepartmentLabel(db, c, id, { groupId: label.group_id, labelId: label.id });
  const served = serves ? await writeServes(db, c, id, fields.is_shared === 1, serves) : null;
  await audit(db, c, 'hrms_departments', id, 'CREATE', null, { ...fields, parent_department_id: parentId, labelId: label.id, ...(served ? { serves: served.after } : {}) });
  // A bulk run (lib/batch.js) throws the read-back away: every rule above has run as on a screen.
  if (inBatch(db)) return { id, code: fields.code };
  return getDepartment(db, c.companyId, id);
}

export async function updateDepartment(db, c, id, input = {}, options = {}) {
  const before = await requireRow(db, 'hrms_departments', c.companyId, id, 'Department');
  const problems = [];
  const fields = departmentFields(input, problems, { partial: true });
  assertNoProblems(problems);
  const label = await departmentLabelOf(db, c, input, { creating: false, options });
  if (label) {
    fields.department_type = label.name;
    await linkDepartmentLabel(db, c, id, { groupId: label.group_id, labelId: label.id });
  }
  if (input.parentId !== undefined) {
    const parentId = idOrNull(input.parentId, 'Parent department', problems);
    assertNoProblems(problems);
    await assertNoCycle(db, 'hrms_departments', 'parent_department_id', c.companyId, id, parentId, 'Department');
    fields.parent_department_id = parentId;
  }
  const serves = servesInput(input, problems);
  assertNoProblems(problems);
  const sharedAfter = fields.is_shared !== undefined ? fields.is_shared === 1 : Boolean(before.is_shared);
  await updateRow(db, 'hrms_departments', c.companyId, id, fields);
  // Un-sharing a department retires what it served: a serves row on a department
  // that is not shared is a line on the chart from a box that no longer has one.
  const served = serves !== undefined
    ? await writeServes(db, c, id, sharedAfter, serves)
    : (!sharedAfter && before.is_shared ? await writeServes(db, c, id, false, []) : null);
  const beforeServes = served ? served.before : [];
  await audit(db, c, 'hrms_departments', id, 'UPDATE', mapDepartment(before, beforeServes), { ...fields, ...(label ? { labelId: label.id } : {}), ...(served ? { serves: served.after } : {}) });
  if (inBatch(db)) return { id };
  return getDepartment(db, c.companyId, id);
}

export async function deleteDepartment(db, c, id) {
  const before = await requireRow(db, 'hrms_departments', c.companyId, id, 'Department');
  await assertNoLiveChildren(db, 'hrms_departments', 'parent_department_id', c.companyId, id, 'Department');
  await assertNotReferenced(db, c.companyId, id, [
    { table: 'hrms_work_contexts', column: 'department_id', label: 'work context' },
    { table: 'hrms_department_serves', column: 'serves_department_id', label: 'shared department that serves it', plural: 'shared departments that serve it' },
    { table: 'hrms_roles', column: 'default_department_id', label: 'role' },
    { table: 'hrms_positions', column: 'department_id', label: 'position' },
    { table: 'hrms_work_assignments', column: 'department_id', label: 'work assignment' },
  ]);
  // What it served goes with it; what serves IT was refused above.
  const served = await writeServes(db, c, id, false, []);
  await softDelete(db, 'hrms_departments', c.companyId, id);
  await retireDepartmentLabels(db, c, id);
  await audit(db, c, 'hrms_departments', id, 'DELETE', mapDepartment(before, served.before), null);
  return { ok: true, id };
}

async function getDepartment(db, companyId, id) {
  const [[row]] = await db.query(
    `SELECT d.*, ${DEPARTMENT_LABEL_ID_SQL('d')} AS label_id FROM hrms_departments d WHERE d.company_id = ? AND d.id = ? AND d.deleted_at IS NULL`,
    [companyId, id],
  );
  if (!row) throw notFound('Department');
  const serves = await servesByDepartment(db, companyId, id);
  return mapDepartment(row, serves.get(id) ?? []);
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
  // No code here: a location's code is issued when it is created and never changes.
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

/** `options.importedCode`: as for a department — the retired import scripts only. */
export async function createLocation(db, c, input = {}, options = {}) {
  const problems = [];
  const fields = locationFields(input, problems);
  const parentId = idOrNull(input.parentId, 'Parent location', problems);
  assertNoProblems(problems);
  await assertNoCycle(db, 'hrms_locations', 'parent_location_id', c.companyId, null, parentId, 'Location');
  fields.code = (await acceptImportedCode(db, c.companyId, LOCATION_ENTITY, options.importedCode))
    ?? await issueLocationCode(db, c.companyId, { name: fields.name, address: fields.address_json ?? null, userId: c.userId });
  const id = await insertRow(db, 'hrms_locations', c.companyId, c.userId, {
    ...fields,
    parent_location_id: parentId,
    status: fields.status ?? 'ACTIVE',
  });
  await audit(db, c, 'hrms_locations', id, 'CREATE', null, { ...fields, parent_location_id: parentId });
  if (inBatch(db)) return { id, code: fields.code };
  return getLocation(db, c.companyId, id);
}

export async function updateLocation(db, c, id, input = {}) {
  const before = await requireRow(db, 'hrms_locations', c.companyId, id, 'Location');
  const problems = [];
  const fields = locationFields(input, problems, { partial: true });
  assertNoProblems(problems);
  if (input.parentId !== undefined) {
    const parentId = idOrNull(input.parentId, 'Parent location', problems);
    assertNoProblems(problems);
    await assertNoCycle(db, 'hrms_locations', 'parent_location_id', c.companyId, id, parentId, 'Location');
    fields.parent_location_id = parentId;
  }
  await updateRow(db, 'hrms_locations', c.companyId, id, fields);
  await audit(db, c, 'hrms_locations', id, 'UPDATE', mapLocation(before), fields);
  if (inBatch(db)) return { id };
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
/*
 * A SHIFT HAS HOURS PER DAY OF THE WEEK (spec §6, 2026-10-11). Seven rows in
 * hrms_shift_days, weekday 1 = Monday … 7 = Sunday; the day logic — hours, the
 * night shift that ends next day, the summary line — is services/shiftRead.js.
 *
 * WHAT IS KEPT IN STEP ON THE SHIFT ROW, on every write, so older readers and
 * every position read keep working without a query of their own:
 *   start_time / end_time / crosses_midnight   mirror the first working day with hours
 *   week_summary                                the line "Mon–Sat 08:00–20:00"
 *
 * A shift may also SELECT ONE HOLIDAY CALENDAR (holiday_calendar_id; NULL = no
 * holidays). Several shifts may share one.
 *
 * THE FIRST SHAPE STILL WORKS. A body with startTime / endTime and no `days`
 * (what the first Shifts screen sends) sets those hours on every working day —
 * Monday to Saturday for a new shift — and every answer still carries
 * startTime, endTime, isFlexible, crossesMidnight beside the new fields.
 */

const SHIFT_COLUMNS = `s.id, s.code, s.name, s.start_time, s.end_time, s.crosses_midnight, s.grace_in_minutes, s.grace_out_minutes,
       s.status, s.created_at, s.week_summary, s.holiday_calendar_id, hc.name AS holiday_calendar_name`;
const SHIFT_FROM = `FROM hrms_shifts s
       LEFT JOIN hrms_holiday_calendars hc ON hc.company_id = s.company_id AND hc.id = s.holiday_calendar_id AND hc.deleted_at IS NULL`;

function mapShift(r, dayRows = [], positionCount = 0) {
  const days = weekOf(dayRows, r);
  return {
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
    // Seven days, always (shiftRead.weekOf fills a weekday that has no row).
    days,
    weeklyHours: weeklyHoursOf(days),
    workingDays: days.filter((d) => d.isWorking).length,
    summary: summaryOf(days),
    holidayCalendar: r.holiday_calendar_id && r.holiday_calendar_name ? { id: r.holiday_calendar_id, name: r.holiday_calendar_name } : null,
    positionCount: Number(positionCount) || 0,
  };
}

async function shiftDayRows(db, companyId, shiftId = null) {
  const [rows] = await db.query(
    `SELECT shift_id, weekday, is_working, start_time, end_time, break_minutes
       FROM hrms_shift_days WHERE company_id = ? AND deleted_at IS NULL${shiftId == null ? '' : ' AND shift_id = ?'}
      ORDER BY shift_id, weekday`,
    shiftId == null ? [companyId] : [companyId, shiftId],
  );
  const by = new Map();
  for (const r of rows) by.set(r.shift_id, [...(by.get(r.shift_id) ?? []), r]);
  return by;
}

async function shiftPositionCounts(db, companyId, shiftId = null) {
  const [rows] = await db.query(
    `SELECT default_shift_id AS shift_id, COUNT(*) AS n FROM hrms_positions
      WHERE company_id = ? AND deleted_at IS NULL AND status <> 'CLOSED' AND default_shift_id IS NOT NULL${shiftId == null ? '' : ' AND default_shift_id = ?'}
      GROUP BY default_shift_id`,
    shiftId == null ? [companyId] : [companyId, shiftId],
  );
  return new Map(rows.map((r) => [r.shift_id, Number(r.n)]));
}

/** GET /organisation/shifts -> { shifts } (and `rows`, the name the first screen read). Three reads, whatever the number of shifts. */
export async function listShifts(db, companyId) {
  const [[rows], days, counts] = await Promise.all([
    db.query(`SELECT ${SHIFT_COLUMNS} ${SHIFT_FROM} WHERE s.company_id = ? AND s.deleted_at IS NULL ORDER BY s.status, s.code`, [companyId]),
    shiftDayRows(db, companyId),
    shiftPositionCounts(db, companyId),
  ]);
  const shifts = rows.map((r) => mapShift(r, days.get(r.id), counts.get(r.id)));
  return { shifts, rows: shifts };
}

async function loadShift(db, companyId, id) {
  const [[row]] = await db.query(`SELECT ${SHIFT_COLUMNS} ${SHIFT_FROM} WHERE s.company_id = ? AND s.id = ? AND s.deleted_at IS NULL`, [companyId, id]);
  if (!row) throw notFound('Shift');
  const [days, counts] = await Promise.all([shiftDayRows(db, companyId, id), shiftPositionCounts(db, companyId, id)]);
  return mapShift(row, days.get(id), counts.get(id));
}

/** `{ shift }`, with the shift's own fields beside it — what the first screen read off a create or an update. */
const shiftAnswer = (shift) => ({ ...shift, shift });

/** GET /organisation/shifts/:id -> { shift } */
export async function getShiftDetail(db, companyId, id) {
  return shiftAnswer(await loadShift(db, companyId, id));
}

/**
 * The seven days of a body, checked. Returns the days in the wire shape, or
 * null when the body has no `days`. Every problem is pushed, in plain words.
 */
function readShiftDays(input, problems) {
  if (input.days === undefined) return null;
  if (!Array.isArray(input.days) || input.days.length !== 7) {
    problems.push('A shift has seven days, Monday to Sunday. Send all seven.');
    return null;
  }
  const seen = new Set();
  const out = [];
  for (const raw of input.days) {
    const weekday = Number(raw?.weekday);
    const day = WEEKDAY_NAMES[weekday - 1];
    if (!Number.isInteger(weekday) || !day) { problems.push('A day of the week is a number from 1 (Monday) to 7 (Sunday).'); continue; }
    if (seen.has(weekday)) { problems.push(`${day} is there twice.`); continue; }
    seen.add(weekday);
    const isWorking = raw.isWorking === true || raw.isWorking === 1 || raw.isWorking === 'true';
    if (!isWorking) { out.push(shapeDay({ weekday, isWorking: false })); continue; }
    const start = timeOrNull(raw.startTime, `${day}: the start time`, problems);
    const end = timeOrNull(raw.endTime, `${day}: the end time`, problems);
    if (!!start !== !!end) {
      problems.push(`${day}: give both a start and an end time, or leave both blank for a working day without fixed hours.`);
      continue;
    }
    const breakRaw = raw.breakMinutes === undefined || raw.breakMinutes === null || raw.breakMinutes === '' ? 0 : Number(raw.breakMinutes);
    if (!Number.isInteger(breakRaw) || breakRaw < 0) { problems.push(`${day}: the break is a whole number of minutes.`); continue; }
    const span = spanMinutes(hhmm(start), hhmm(end));
    if (span === null && breakRaw > 0) { problems.push(`${day}: a break needs a start and an end time to be taken from.`); continue; }
    if (span !== null && breakRaw >= span) { problems.push(`${day}: the break (${breakRaw} minutes) is as long as the working day or longer.`); continue; }
    out.push(shapeDay({ weekday, isWorking: true, startTime: start, endTime: end, breakMinutes: breakRaw }));
  }
  return out.length === 7 ? out.sort((a, b) => a.weekday - b.weekday) : null;
}

/** The first screen's times, HH:MM or null; `undefined` when the body does not touch them. */
function readLegacyTimes(input, problems) {
  if (input.startTime === undefined && input.endTime === undefined) return undefined;
  const start = timeOrNull(input.startTime, 'Start time', problems);
  const end = timeOrNull(input.endTime, 'End time', problems);
  // A half-specified shift is the one state the attendance service cannot
  // read: it is neither "flexible" nor "these are the hours".
  if (!!start !== !!end) problems.push('Give both a start and an end time, or leave both blank for a flexible shift with no fixed hours.');
  return { start: hhmm(start), end: hhmm(end) };
}

function shiftFields(input, problems, { partial = false } = {}) {
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
  if (input.graceInMinutes !== undefined) out.grace_in_minutes = intInRange(input.graceInMinutes, 0, 240, 'Grace in', problems);
  if (input.graceOutMinutes !== undefined) out.grace_out_minutes = intInRange(input.graceOutMinutes, 0, 240, 'Grace out', problems);
  if (input.status !== undefined) out.status = enumOf(input.status, STATUSES, 'Status', problems, 'ACTIVE');
  return out;
}

/** `holidayCalendarId` of a body: a calendar of this company, null for "no holidays", `undefined` when not sent. */
async function readShiftCalendar(db, companyId, input, problems) {
  if (input.holidayCalendarId === undefined) return undefined;
  const id = idOrNull(input.holidayCalendarId, 'Holiday calendar', problems);
  if (id == null) return null;
  const [[row]] = await db.query('SELECT id FROM hrms_holiday_calendars WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [companyId, id]);
  if (!row) problems.push('That holiday calendar does not exist. Pick one from the list, or "No holidays".');
  return id;
}

/** Writes the seven rows (in place — there is one row per weekday, for good) and what the shift row mirrors. */
async function writeShiftDays(db, c, shiftId, days) {
  for (const d of days) {
    await db.query(
      `INSERT INTO hrms_shift_days (company_id, shift_id, weekday, is_working, start_time, end_time, crosses_midnight, break_minutes, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE is_working = VALUES(is_working), start_time = VALUES(start_time), end_time = VALUES(end_time),
                               crosses_midnight = VALUES(crosses_midnight), break_minutes = VALUES(break_minutes), deleted_at = NULL`,
      [c.companyId, shiftId, d.weekday, d.isWorking ? 1 : 0, d.startTime, d.endTime, d.crossesMidnight ? 1 : 0, d.breakMinutes, c.userId],
    );
  }
  await updateRow(db, 'hrms_shifts', c.companyId, shiftId, { ...mirrorOf(days), week_summary: summaryOf(days) });
}

export async function createShift(db, c, input = {}) {
  const problems = [];
  const fields = shiftFields(input, problems);
  const sentDays = readShiftDays(input, problems);
  const legacy = readLegacyTimes(input, problems);
  const calendarId = await readShiftCalendar(db, c.companyId, input, problems);
  assertNoProblems(problems);
  await assertCodeFree(db, 'hrms_shifts', c.companyId, fields.code, null, 'Shift');
  // No days sent: the week every shift starts with — its times Monday to Saturday, Sunday off.
  const days = sentDays ?? defaultWeek(legacy?.start ?? null, legacy?.end ?? null);
  const id = await insertRow(db, 'hrms_shifts', c.companyId, c.userId, {
    ...fields,
    ...mirrorOf(days),
    week_summary: summaryOf(days),
    holiday_calendar_id: calendarId ?? null,
    grace_in_minutes: fields.grace_in_minutes ?? 0,
    grace_out_minutes: fields.grace_out_minutes ?? 0,
    status: fields.status ?? 'ACTIVE',
  });
  await writeShiftDays(db, c, id, days);
  await audit(db, c, 'hrms_shifts', id, 'CREATE', null, { ...fields, holidayCalendarId: calendarId ?? null, summary: summaryOf(days) });
  return shiftAnswer(await loadShift(db, c.companyId, id));
}

export async function updateShift(db, c, id, input = {}) {
  const before = await loadShift(db, c.companyId, id);
  const problems = [];
  const fields = shiftFields(input, problems, { partial: true });
  const sentDays = readShiftDays(input, problems);
  const legacy = readLegacyTimes(input, problems);
  const calendarId = await readShiftCalendar(db, c.companyId, input, problems);
  assertNoProblems(problems);
  if (fields.code !== undefined) await assertCodeFree(db, 'hrms_shifts', c.companyId, fields.code, id, 'Shift');
  if (calendarId !== undefined) fields.holiday_calendar_id = calendarId;
  await updateRow(db, 'hrms_shifts', c.companyId, id, fields);
  // Days as sent; or the first screen's two times, put on every day that is a working day today.
  const days = sentDays ?? (legacy
    ? before.days.map((d) => shapeDay({ ...d, startTime: d.isWorking ? legacy.start : null, endTime: d.isWorking ? legacy.end : null, breakMinutes: legacy.start ? d.breakMinutes : 0 }))
    : null);
  if (days) await writeShiftDays(db, c, id, days);
  await audit(db, c, 'hrms_shifts', id, 'UPDATE', { code: before.code, name: before.name, status: before.status, summary: before.summary, holidayCalendarId: before.holidayCalendar?.id ?? null },
    { ...fields, ...(days ? { summary: summaryOf(days) } : {}) });
  return shiftAnswer(await loadShift(db, c.companyId, id));
}

export async function deleteShift(db, c, id) {
  const before = await loadShift(db, c.companyId, id);
  // Said first and by number: it is the one reference a person can do something about from here.
  const [[used]] = await db.query('SELECT COUNT(*) AS n FROM hrms_positions WHERE company_id = ? AND default_shift_id = ? AND deleted_at IS NULL', [c.companyId, id]);
  if (Number(used.n) > 0) {
    const n = Number(used.n);
    throw conflict('IN_USE', `${n} position${n === 1 ? ' is' : 's are'} on this shift. Move ${n === 1 ? 'it' : 'them'} to another shift first, or set this one inactive.`, {
      problems: [`${n} position${n === 1 ? ' is' : 's are'} on the ${before.name} shift.`],
      detail: { positionCount: n },
    });
  }
  await assertNotReferenced(db, c.companyId, id, [
    { table: 'hrms_work_assignments', column: 'default_shift_id', label: 'work assignment' },
    { table: 'hrms_shift_rosters', column: 'shift_id', label: 'roster entry', plural: 'roster entries' },
    { table: 'hrms_attendance_records', column: 'shift_id', label: 'attendance record' },
    { table: 'hrms_manpower_requirements', column: 'shift_id', label: 'manpower requirement' },
  ]);
  await softDelete(db, 'hrms_shifts', c.companyId, id);
  // Its seven days go with it.
  await db.query('UPDATE hrms_shift_days SET deleted_at = NOW() WHERE company_id = ? AND shift_id = ?', [c.companyId, id]);
  await audit(db, c, 'hrms_shifts', id, 'DELETE', { code: before.code, name: before.name, summary: before.summary }, null);
  return { ok: true, id };
}

/* ------------------------------------------------- holiday calendars */
/*
 * A HOLIDAY CALENDAR is a named list of dated holidays; a shift selects one.
 * Nothing is invented here: a new calendar starts empty.
 *
 * A date is in a calendar once (409 DUPLICATE, naming the holiday already
 * there); the same date may be in two calendars.
 *
 * Holidays written before calendars existed (POST /organisation/holidays, which
 * still works) belong to the company's "Company holidays" calendar, created the
 * first time it is needed.
 */

export const DEFAULT_CALENDAR_NAME = 'Company holidays';
const COPY_YEAR_NOTE = 'Only holidays on a fixed date repeat. Festival dates move each year — check each one before relying on this calendar.';

const dayText = (v) => (v instanceof Date
  ? `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`
  : String(v).slice(0, 10));

const mapHoliday = (r) => {
  const date = dayText(r.holiday_date);
  return {
    id: r.id,
    date,
    weekday: weekdayName(date),
    name: r.name,
    isOptional: !!r.is_optional,
    calendarId: r.calendar_id ?? null,
    // The first shape's names, kept.
    holidayDate: date,
    locationId: r.location_id ?? null,
    locationName: r.location_name ?? null,
    createdAt: r.created_at,
  };
};

const mapCalendar = (r, extra = {}) => ({
  id: r.id,
  name: r.name,
  description: r.description ?? null,
  status: r.status,
  holidayCount: Number(extra.holidayCount ?? 0),
  nextHoliday: extra.nextHoliday ?? null,
  shiftCount: Number(extra.shiftCount ?? 0),
});

async function requireCalendar(db, companyId, id) {
  const [[row]] = await db.query('SELECT * FROM hrms_holiday_calendars WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [companyId, id]);
  if (!row) throw notFound('Holiday calendar');
  return row;
}

/** Counts, next holiday and shifts using it — for every calendar (or one), in three grouped reads. */
async function calendarFacts(db, companyId, calendarId = null) {
  const one = calendarId == null ? '' : ' AND calendar_id = ?';
  const args = calendarId == null ? [companyId] : [companyId, calendarId];
  const today = dayText(new Date());
  const [[counts], [upcoming], [shifts]] = await Promise.all([
    db.query(`SELECT calendar_id, COUNT(*) AS n FROM hrms_holidays WHERE company_id = ? AND deleted_at IS NULL${one} GROUP BY calendar_id`, args),
    db.query(`SELECT calendar_id, holiday_date, name FROM hrms_holidays WHERE company_id = ? AND deleted_at IS NULL AND holiday_date >= ?${one} ORDER BY holiday_date, id`,
      calendarId == null ? [companyId, today] : [companyId, today, calendarId]),
    db.query(`SELECT holiday_calendar_id AS calendar_id, COUNT(*) AS n FROM hrms_shifts WHERE company_id = ? AND deleted_at IS NULL${calendarId == null ? '' : ' AND holiday_calendar_id = ?'} GROUP BY holiday_calendar_id`, args),
  ]);
  const next = new Map();
  for (const h of upcoming) if (!next.has(h.calendar_id)) next.set(h.calendar_id, { date: dayText(h.holiday_date), name: h.name });
  const countOf = new Map(counts.map((r) => [r.calendar_id, Number(r.n)]));
  const shiftsOf = new Map(shifts.map((r) => [r.calendar_id, Number(r.n)]));
  return (id) => ({ holidayCount: countOf.get(id) ?? 0, nextHoliday: next.get(id) ?? null, shiftCount: shiftsOf.get(id) ?? 0 });
}

/** GET /organisation/holiday-calendars -> { calendars } */
export async function listHolidayCalendars(db, companyId) {
  const [[rows], facts] = await Promise.all([
    db.query('SELECT * FROM hrms_holiday_calendars WHERE company_id = ? AND deleted_at IS NULL ORDER BY status, name, id', [companyId]),
    calendarFacts(db, companyId),
  ]);
  return { calendars: rows.map((r) => mapCalendar(r, facts(r.id))) };
}

/** GET /organisation/holiday-calendars/:id?year= -> { calendar, holidays, years } — every year when none is asked for. */
export async function getHolidayCalendar(db, companyId, id, { year } = {}) {
  const row = await requireCalendar(db, companyId, id);
  let y = null;
  if (year !== undefined && year !== null && year !== '') {
    y = Number(year);
    if (!Number.isInteger(y) || y < 1900 || y > 2200) throw invalid('INVALID', 'year is a four-digit year.');
  }
  const [[holidays], [years], facts] = await Promise.all([
    db.query(
      `SELECT h.* FROM hrms_holidays h WHERE h.company_id = ? AND h.calendar_id = ? AND h.deleted_at IS NULL${y ? ' AND YEAR(h.holiday_date) = ?' : ''} ORDER BY h.holiday_date, h.id`,
      y ? [companyId, id, y] : [companyId, id]),
    db.query('SELECT DISTINCT YEAR(holiday_date) AS y FROM hrms_holidays WHERE company_id = ? AND calendar_id = ? AND deleted_at IS NULL ORDER BY y', [companyId, id]),
    calendarFacts(db, companyId, id),
  ]);
  return { calendar: mapCalendar(row, facts(id)), holidays: holidays.map(mapHoliday), years: years.map((r) => Number(r.y)) };
}

function calendarFields(input, problems, { partial = false } = {}) {
  const out = {};
  if (!partial || input.name !== undefined) {
    const name = str(input.name);
    if (!name || name.length > 150) problems.push('A calendar needs a name, up to 150 characters.');
    out.name = name;
  }
  if (input.description !== undefined) {
    const description = nullableStr(input.description);
    if (description && description.length > 500) problems.push('The description is up to 500 characters.');
    out.description = description;
  }
  if (input.status !== undefined) out.status = enumOf(input.status, STATUSES, 'Status', problems, 'ACTIVE');
  return out;
}

export async function createHolidayCalendar(db, c, input = {}) {
  const problems = [];
  const fields = calendarFields(input, problems);
  assertNoProblems(problems);
  await assertNameFree(db, 'hrms_holiday_calendars', c.companyId, fields.name, null, 'Holiday calendar', 'Open that calendar instead of making a second one with the same name.');
  const id = await insertRow(db, 'hrms_holiday_calendars', c.companyId, c.userId, { ...fields, status: fields.status ?? 'ACTIVE' });
  await audit(db, c, 'hrms_holiday_calendars', id, 'CREATE', null, fields);
  return { calendar: mapCalendar(await requireCalendar(db, c.companyId, id)) };
}

export async function updateHolidayCalendar(db, c, id, input = {}) {
  const before = await requireCalendar(db, c.companyId, id);
  const problems = [];
  const fields = calendarFields(input, problems, { partial: true });
  assertNoProblems(problems);
  if (fields.name !== undefined) {
    await assertNameFree(db, 'hrms_holiday_calendars', c.companyId, fields.name, id, 'Holiday calendar', 'Two calendars with one name cannot be told apart on a shift.');
  }
  await updateRow(db, 'hrms_holiday_calendars', c.companyId, id, fields);
  await audit(db, c, 'hrms_holiday_calendars', id, 'UPDATE', { name: before.name, description: before.description, status: before.status }, fields);
  const facts = await calendarFacts(db, c.companyId, id);
  return { calendar: mapCalendar(await requireCalendar(db, c.companyId, id), facts(id)) };
}

/** 409 IN_USE while a shift selects it. Its holidays go with it. */
export async function deleteHolidayCalendar(db, c, id) {
  const before = await requireCalendar(db, c.companyId, id);
  const [shifts] = await db.query('SELECT id, name FROM hrms_shifts WHERE company_id = ? AND holiday_calendar_id = ? AND deleted_at IS NULL ORDER BY name', [c.companyId, id]);
  if (shifts.length) {
    const names = shifts.map((s) => s.name).join(', ');
    throw conflict('IN_USE', `${shifts.length === 1 ? 'The ' : ''}${names} shift${shifts.length === 1 ? ' uses' : 's use'} this calendar. Choose another calendar on ${shifts.length === 1 ? 'that shift' : 'those shifts'} first.`, {
      problems: shifts.map((s) => `The ${s.name} shift uses this calendar.`),
      detail: { shiftCount: shifts.length, shiftIds: shifts.map((s) => s.id) },
    });
  }
  const [gone] = await db.query('UPDATE hrms_holidays SET deleted_at = NOW() WHERE company_id = ? AND calendar_id = ? AND deleted_at IS NULL', [c.companyId, id]);
  await softDelete(db, 'hrms_holiday_calendars', c.companyId, id);
  await audit(db, c, 'hrms_holiday_calendars', id, 'DELETE', { name: before.name, holidays: gone.affectedRows }, null);
  return { ok: true, id, deletedHolidays: gone.affectedRows };
}

/** The calendar a holiday goes to when none is named: "Company holidays", made on first use. */
async function defaultCalendarId(db, c) {
  const [[row]] = await db.query(
    'SELECT id FROM hrms_holiday_calendars WHERE company_id = ? AND deleted_at IS NULL AND LOWER(name) = LOWER(?) ORDER BY id LIMIT 1',
    [c.companyId, DEFAULT_CALENDAR_NAME],
  );
  if (row) return row.id;
  const id = await insertRow(db, 'hrms_holiday_calendars', c.companyId, c.userId, { name: DEFAULT_CALENDAR_NAME, description: 'Holidays entered before calendars existed.', status: 'ACTIVE' });
  await audit(db, c, 'hrms_holiday_calendars', id, 'CREATE', null, { name: DEFAULT_CALENDAR_NAME, reason: 'a holiday was added without naming a calendar' });
  return id;
}

/* --------------------------------------------------------------- holidays */

/** GET /organisation/holidays?year= — every calendar's holidays, by date (the first screen's list). */
export async function listHolidays(db, companyId, { year } = {}) {
  const params = [companyId];
  let where = '';
  if (year) {
    where = ' AND YEAR(h.holiday_date) = ?';
    params.push(Number(year));
  }
  const [rows] = await db.query(
    `SELECT h.id, h.holiday_date, h.name, h.location_id, h.calendar_id, h.is_optional, h.created_at, l.name AS location_name
       FROM hrms_holidays h
       LEFT JOIN hrms_locations l ON l.company_id = h.company_id AND l.id = h.location_id AND l.deleted_at IS NULL
      WHERE h.company_id = ? AND h.deleted_at IS NULL${where}
      ORDER BY h.holiday_date, h.id`,
    params,
  );
  const holidays = rows.map(mapHoliday);
  return { rows: holidays, holidays };
}

/** `date` (or the first shape's `holidayDate`), `name`, `isOptional`. */
function holidayFields(input, problems, { partial = false } = {}) {
  const out = {};
  const sentDate = input.date !== undefined ? input.date : input.holidayDate;
  if (!partial || sentDate !== undefined) out.holiday_date = dateOnly(sentDate, 'Date', problems);
  if (!partial || input.name !== undefined) {
    const name = str(input.name);
    if (!name || name.length > 200) problems.push('Name is required, up to 200 characters.');
    out.name = name;
  }
  if (input.isOptional !== undefined) out.is_optional = bool(input.isOptional);
  return out;
}

/** `{ holiday }`, with the holiday's own fields beside it for the first screen. */
const holidayAnswer = (holiday) => ({ ...holiday, holiday });

async function addHoliday(db, c, calendarId, input) {
  const problems = [];
  const fields = holidayFields(input, problems);
  const locationId = idOrNull(input.locationId, 'Location', problems);
  assertNoProblems(problems);
  await assertHolidayFree(db, c.companyId, calendarId, fields.holiday_date, locationId, null);
  const id = await insertRow(db, 'hrms_holidays', c.companyId, c.userId, {
    ...fields, calendar_id: calendarId, location_id: locationId, is_optional: fields.is_optional ?? 0,
  });
  await audit(db, c, 'hrms_holidays', id, 'CREATE', null, { ...fields, calendar_id: calendarId, location_id: locationId });
  return holidayAnswer(await getHoliday(db, c.companyId, id));
}

/** POST /organisation/holiday-calendars/:id/holidays { date, name, isOptional? } -> { holiday } — 409 DUPLICATE for a date already in it. */
export async function createCalendarHoliday(db, c, calendarId, input = {}) {
  await requireCalendar(db, c.companyId, calendarId);
  return addHoliday(db, c, calendarId, input);
}

/** POST /organisation/holidays — the first screen's route: into the calendar named by `calendarId`, else "Company holidays". */
export async function createHoliday(db, c, input = {}) {
  let calendarId = null;
  if (input.calendarId !== undefined && input.calendarId !== null && input.calendarId !== '') {
    calendarId = Number(input.calendarId);
    await requireCalendar(db, c.companyId, calendarId);
  } else calendarId = await defaultCalendarId(db, c);
  return addHoliday(db, c, calendarId, input);
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
  const date = fields.holiday_date ?? dayText(before.holiday_date);
  await assertHolidayFree(db, c.companyId, before.calendar_id, date, locationId, id);
  await updateRow(db, 'hrms_holidays', c.companyId, id, fields);
  await audit(db, c, 'hrms_holidays', id, 'UPDATE', mapHoliday(before), fields);
  return holidayAnswer(await getHoliday(db, c.companyId, id));
}

export async function deleteHoliday(db, c, id) {
  const before = await requireRow(db, 'hrms_holidays', c.companyId, id, 'Holiday');
  await softDelete(db, 'hrms_holidays', c.companyId, id);
  await audit(db, c, 'hrms_holidays', id, 'DELETE', mapHoliday(before), null);
  return { ok: true, id };
}

/**
 * The unique index (uq_hhol_calday) covers calendar, location and date — but an
 * index only names itself. "15 August is already in this calendar: Independence
 * Day" is what a person can act on.
 */
async function assertHolidayFree(db, companyId, calendarId, date, locationId, excludeId) {
  const [[clash]] = await db.query(
    `SELECT id, name FROM hrms_holidays
      WHERE company_id = ? AND deleted_at IS NULL AND holiday_date = ?
        AND IFNULL(calendar_id, 0) = ? AND IFNULL(location_id, 0) = ? AND id <> ?`,
    [companyId, date, calendarId ?? 0, locationId ?? 0, excludeId ?? 0],
  );
  if (clash) {
    throw conflict('DUPLICATE', `${date} is already a holiday in this calendar: ${clash.name}.`, {
      problems: [`${date} is already in this calendar as "${clash.name}". Edit that one instead of adding a second.`],
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

/**
 * POST /organisation/holiday-calendars/:id/copy-year { fromYear, toYear }
 * -> { copied, skipped: [{ date, name, why }], note }
 *
 * Each holiday of one year, on the same day and month of another. A date the
 * calendar already has is skipped (never overwritten), and so is 29 February
 * into a year that has none. `note` says what nobody should forget: a festival
 * does not fall on the same date twice.
 */
export async function copyHolidayYear(db, c, calendarId, input = {}) {
  await requireCalendar(db, c.companyId, calendarId);
  const fromYear = Number(input.fromYear);
  const toYear = Number(input.toYear);
  const problems = [];
  for (const [y, label] of [[fromYear, 'The year to copy from'], [toYear, 'The year to copy to']]) {
    if (!Number.isInteger(y) || y < 1900 || y > 2200) problems.push(`${label} is a four-digit year.`);
  }
  if (!problems.length && fromYear === toYear) problems.push('Copy to a different year.');
  assertNoProblems(problems);

  const [source] = await db.query(
    'SELECT holiday_date, name, is_optional FROM hrms_holidays WHERE company_id = ? AND calendar_id = ? AND deleted_at IS NULL AND location_id IS NULL AND YEAR(holiday_date) = ? ORDER BY holiday_date, id',
    [c.companyId, calendarId, fromYear],
  );
  const [existing] = await db.query(
    'SELECT holiday_date, name FROM hrms_holidays WHERE company_id = ? AND calendar_id = ? AND deleted_at IS NULL AND location_id IS NULL AND YEAR(holiday_date) = ?',
    [c.companyId, calendarId, toYear],
  );
  const taken = new Map(existing.map((h) => [dayText(h.holiday_date), h.name]));
  const skipped = [];
  let copied = 0;
  for (const h of source) {
    const monthDay = dayText(h.holiday_date).slice(5);
    const date = `${toYear}-${monthDay}`;
    const real = new Date(`${date}T00:00:00Z`);
    if (Number.isNaN(real.getTime()) || real.toISOString().slice(5, 10) !== monthDay) {
      skipped.push({ date, name: h.name, why: `${toYear} has no 29 February.` });
      continue;
    }
    if (taken.has(date)) {
      skipped.push({ date, name: h.name, why: `${date} is already in this calendar${taken.get(date) === h.name ? '' : ` as "${taken.get(date)}"`}.` });
      continue;
    }
    await insertRow(db, 'hrms_holidays', c.companyId, c.userId, { calendar_id: calendarId, holiday_date: date, name: h.name, is_optional: h.is_optional ? 1 : 0 });
    taken.set(date, h.name);
    copied += 1;
  }
  await audit(db, c, 'hrms_holiday_calendars', calendarId, 'UPDATE', null, { copiedYear: { fromYear, toYear, copied, skipped: skipped.length } });
  return { copied, skipped, note: COPY_YEAR_NOTE };
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
