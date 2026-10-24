/**
 * listFilters.js — search and filters, the same way on every list.
 * (TM/CF_HRMS_HIRING_SPEC.md §13.1; the names are listed in §13.6.)
 *
 *   router.get('/positions', guard(…), listed('positions'), handle(…))
 *
 * `listed(name)` reads the address (`?q=&department=&state=`), narrows the rows
 * of the answer the handler gives, and adds two numbers to it:
 *
 *   total   how many rows the list holds for this login before these filters
 *   count   how many are left ("38 of 220")
 *
 * IT COSTS NO QUERY of its own, with two exceptions, each read only when its
 * filter is used: "department and below" needs the department tree (one read),
 * and `label` needs every department's label (two reads). The rows
 * are already in memory — every one of these lists is read whole — so narrowing
 * them here is exact and cannot disagree with what a row shows.
 *
 * THE SAME FUNCTION FEEDS THE EXCEL DOWNLOAD (services/excel/engine.js):
 * "Download Excel" holds what the list shows because it asks `filterRows` with
 * the same address and the same spec.
 *
 * Filters a list service already took in its own query (`status`, `roleId`,
 * `search` …) keep working as they did; they are applied by the service, before
 * `total` is counted.
 */
import { pool } from './db.js';
import { ctx } from './http.js';
import { fail } from '../../../core/middleware/requirePerm.js';
import { invalid } from './errors.js';
import { labelIndex, labelMatcher } from '../services/labelGroupService.js';

const blank = (v) => v === undefined || v === null || String(v).trim() === '';
const lower = (v) => String(v ?? '').trim().toLowerCase();
const csv = (v) => String(v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const idSet = (v) => new Set(csv(v).map(Number).filter((n) => Number.isInteger(n) && n > 0));
/** yes / no from an address: 1, true, yes — 0, false, no. Anything else is not a filter. */
const yesNo = (v) => (['1', 'true', 'yes'].includes(lower(v)) ? true : (['0', 'false', 'no'].includes(lower(v)) ? false : null));
const day = (v) => (v == null ? null : (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10)));

const matchesText = (fields) => (row, value) => {
  const needle = lower(value);
  return fields.some((f) => lower(typeof f === 'function' ? f(row) : row[f]).includes(needle));
};
const oneOfIds = (pick) => (row, value) => { const ids = idSet(value); return !ids.size || ids.has(Number(pick(row))); };
const oneOfWords = (pick) => (row, value) => { const words = csv(value).map(lower); return !words.length || words.includes(lower(pick(row))); };
const flag = (pick) => (row, value) => { const want = yesNo(value); return want === null || Boolean(pick(row)) === want; };
/**
 * `label=<labelId>[,<labelId>…]`: the department `pick(row)` gives carries
 * one of the labels asked for ("any of"). A department's OWN label only, never
 * its parents'. A label's name is still taken (§13.6 had `label=Section`).
 */
const byLabel = (pick) => (row, value, aux) => aux.labelTest(value)(pick(row));
/**
 * "This org unit and everything below it", for ONE OR MORE units (spec §34.2):
 * `department=12` or `department=12,40` — a row passes when its unit is at or
 * under ANY of them. `tree.below(id)` is that set of ids. Every id must be a
 * live org unit of this company (`assertUnitIds`, run by filterRows): a bad
 * or foreign id is refused (422), never quietly dropped.
 */
const inDepartment = (pick) => (row, value, tree) => {
  const ids = idSet(value);
  if (!ids.size) return true;
  const own = Number(pick(row));
  return [...ids].some((id) => tree.below(id).has(own));
};

/**
 * One entry per list: `key` is where the rows are in the answer (several keys
 * when an answer carries the same rows under two names), `filters` is
 * parameter -> test. A parameter that is absent or blank is no filter.
 */
export const LIST_SPECS = {
  departments: {
    key: ['rows'],
    filters: {
      q: matchesText(['name', 'code']),
      label: byLabel((r) => r.id),
      shared: flag((r) => r.isShared),
      status: oneOfWords((r) => r.status),
      // Under this department, at any depth (the department itself is not "under" itself).
      parent: (row, value, tree) => { const ids = idSet(value); return !ids.size || [...ids].some((id) => id !== row.id && tree.below(id).has(row.id)); },
    },
    needsTree: ['parent'],
    needsLabels: ['label'],
  },
  locations: { key: ['rows'], filters: { q: matchesText(['name', 'code']), status: oneOfWords((r) => r.status) } },
  roles: {
    key: ['items'],
    filters: {
      q: matchesText(['title', 'roleCode']),
      status: oneOfWords((r) => r.status),
      hasPositions: flag((r) => r.positionCount > 0),
      jdReady: flag((r) => r.jdReady),
      hasPurpose: flag((r) => r.hasPurpose),
    },
  },
  positions: {
    key: ['items'],
    filters: {
      q: matchesText(['positionCode', 'positionTitle', 'roleTitle', (r) => r.occupant?.name, (r) => r.occupant?.employeeCode]),
      department: inDepartment((r) => r.departmentId),
      label: byLabel((r) => r.departmentId),
      role: oneOfIds((r) => r.roleId),
      shift: oneOfIds((r) => r.defaultShiftId),
      location: oneOfIds((r) => r.locationId),
      // filled | vacant | hiring | notice — several, comma-separated, are "any of".
      state: (row, value) => {
        const want = csv(value).map(lower);
        if (!want.length) return true;
        const is = {
          filled: Boolean(row.occupant), vacant: !row.occupant, hiring: Boolean(row.hiring), notice: Boolean(row.occupant?.notice),
        };
        return want.some((w) => is[w]);
      },
    },
    needsTree: ['department'],
    needsLabels: ['label'],
  },
  employees: {
    key: ['items'],
    filters: {
      q: matchesText(['fullName', 'employeeCode']),
      department: inDepartment((r) => r.departmentId),
      label: byLabel((r) => r.departmentId),
      role: oneOfIds((r) => r.roleId),
      shift: oneOfIds((r) => r.shiftId),
      location: oneOfIds((r) => r.locationId),
      joinedFrom: (row, value) => { const d = day(row.dateOfJoining); return blank(value) || (d != null && d >= String(value).slice(0, 10)); },
      joinedTo: (row, value) => { const d = day(row.dateOfJoining); return blank(value) || (d != null && d <= String(value).slice(0, 10)); },
      hasLogin: flag((r) => r.userId != null),
    },
    needsTree: ['department'],
    needsLabels: ['label'],
  },
  hirings: {
    key: ['hirings'],
    filters: {
      q: matchesText(['candidateName', 'positionCode', 'roleTitle', 'refNo']),
      stage: oneOfWords((r) => r.stage),
      department: inDepartment((r) => r.departmentId),
      label: byLabel((r) => r.departmentId),
      role: oneOfIds((r) => r.roleId),
    },
    needsTree: ['department'],
    needsLabels: ['label'],
  },
  documents: {
    key: ['items'],
    filters: {
      q: matchesText(['title', (r) => r.target?.label, (r) => r.target?.roleTitle, (r) => r.target?.positionCode, (r) => r.target?.employeeName]),
      role: oneOfIds((r) => r.target?.roleId),
      from: (row, value) => { const d = day(row.generatedAt); return blank(value) || (d != null && d >= String(value).slice(0, 10)); },
      to: (row, value) => { const d = day(row.generatedAt); return blank(value) || (d != null && d <= String(value).slice(0, 10)); },
    },
  },
  shifts: {
    key: ['shifts', 'rows'],
    filters: { q: matchesText(['name', 'code']), status: oneOfWords((r) => r.status), calendar: oneOfIds((r) => r.holidayCalendar?.id) },
  },
  holidays: {
    key: ['holidays', 'rows'],
    filters: { q: matchesText(['name']), calendar: oneOfIds((r) => r.calendarId), optional: flag((r) => r.isOptional) },
  },
  holidayCalendars: { key: ['calendars', 'rows'], filters: { q: matchesText(['name']), status: oneOfWords((r) => r.status) } },
  leavePolicies: {
    key: ['policies'],
    filters: {
      q: matchesText(['name', 'code']),
      status: oneOfWords((r) => r.status),
      used: flag((r) => Boolean(r.usedBy?.company) || (r.usedBy?.locations ?? 0) > 0 || (r.usedBy?.roles ?? 0) > 0 || (r.usedBy?.labels ?? 0) > 0),
    },
  },
  libraries: {
    key: ['items'],
    filters: { q: matchesText(['name', 'code', 'description']), status: oneOfWords((r) => r.status), used: flag((r) => (r.usageCount ?? 0) > 0) },
  },
  reportingTypes: { key: ['rows'], filters: { q: matchesText(['name', 'code']), status: oneOfWords((r) => r.status) } },
  // Performance plans (spec §18.3). Cancelled plans are hidden unless status asks for them (the route does that).
  plans: {
    key: ['items'],
    filters: {
      q: matchesText(['employeeName', 'employeeCode', 'positionCode', 'positionTitle', 'roleTitle']),
      status: oneOfWords((r) => r.status),
      department: inDepartment((r) => r.departmentId),
      label: byLabel((r) => r.departmentId),
      frequency: oneOfWords((r) => r.frequency),
      weightsOk: flag((r) => r.weightsOk),
      // spec §19.3: ON_TRACK, AT_RISK, BEHIND, NO_DATA (comma-separated = any of)
      band: oneOfWords((r) => r.band),
    },
    needsTree: ['department'],
    needsLabels: ['label'],
  },
  // Performance › Actuals (spec §19.3): one row per person × KPI × slot.
  actuals: {
    key: ['rows'],
    filters: {
      q: matchesText(['employeeName', 'employeeCode', 'positionCode', 'positionTitle', 'kpiName', 'kraName']),
      department: inDepartment((r) => r.departmentId),
      label: byLabel((r) => r.departmentId),
      role: oneOfIds((r) => r.roleId),
      manager: oneOfIds((r) => r.managerPositionId),
      band: oneOfWords((r) => r.band),
      missing: flag((r) => !r.actual),
    },
    needsTree: ['department'],
    needsLabels: ['label'],
  },
  // Performance › Reviews (spec §20.3): check-ins and final reviews.
  reviews: {
    key: ['items'],
    filters: {
      q: matchesText(['employeeName', 'employeeCode', 'positionCode', 'positionTitle', 'roleTitle', 'managerName']),
      period: oneOfIds((r) => r.periodId),
      kind: oneOfWords((r) => r.kind),
      status: oneOfWords((r) => r.status),
      // DUE, OVERDUE, DONE, CANCELLED (comma-separated = any of)
      state: oneOfWords((r) => r.state),
      department: inDepartment((r) => r.departmentId),
      label: byLabel((r) => r.departmentId),
      manager: oneOfIds((r) => r.managerPositionId),
    },
    needsTree: ['department'],
    needsLabels: ['label'],
  },
  // Performance › Actions (spec §20.3). Open ones unless `status` asks otherwise (the route does that).
  actions: {
    key: ['items'],
    filters: {
      q: matchesText(['text', 'ownerName', 'employeeName', 'employeeCode', 'positionCode']),
      status: (row, value) => lower(value) === 'all' || csv(value).map(lower).includes(lower(row.status)),
      overdue: flag((r) => r.overdue),
      owner: oneOfIds((r) => r.ownerEmployeeId),
      period: oneOfIds((r) => r.periodId),
      department: inDepartment((r) => r.departmentId),
      label: byLabel((r) => r.departmentId),
      manager: oneOfIds((r) => r.managerPositionId),
    },
    needsTree: ['department'],
    needsLabels: ['label'],
  },
  // The service narrows these itself (q, roleId, state); here only the two numbers are added.
  logins: { key: ['logins'], filters: {} },
};

/** The department tree of a company, as "this one and everything below it". One read. */
export async function departmentTree(db, companyId) {
  const [rows] = await db.query('SELECT id, parent_department_id FROM hrms_departments WHERE company_id = ? AND deleted_at IS NULL', [companyId]);
  const live = new Set(rows.map((r) => r.id));
  const childrenOf = new Map();
  for (const r of rows) if (r.parent_department_id != null) childrenOf.set(r.parent_department_id, [...(childrenOf.get(r.parent_department_id) ?? []), r.id]);
  const memo = new Map();
  return {
    has: (id) => live.has(Number(id)),
    below(id) {
      const key = Number(id);
      if (memo.has(key)) return memo.get(key);
      const out = new Set();
      const walk = [key];
      while (walk.length) { const x = walk.pop(); if (out.has(x)) continue; out.add(x); walk.push(...(childrenOf.get(x) ?? [])); }
      memo.set(key, out);
      return out;
    },
  };
}
const NO_TREE = { has: () => true, below: (id) => new Set([Number(id)]) };

/**
 * The org unit ids of a `department` address value — "12" or "12,40" — each a
 * live unit of this company, or 422 INVALID naming what is wrong. `tree` from
 * departmentTree (read here when not given). -> number[] (blank -> []).
 */
export async function assertUnitIds(db, companyId, value, tree = null) {
  const tokens = csv(value);
  if (!tokens.length) return [];
  const bad = tokens.filter((t) => !/^\d+$/.test(t) || Number(t) <= 0);
  if (bad.length) {
    throw invalid('INVALID', 'The org unit filter holds something that is not an org unit.', {
      problems: [`"${bad[0].slice(0, 30)}" is not an org unit. The org unit filter takes org unit ids, separated by commas.`],
    });
  }
  const ids = [...new Set(tokens.map(Number))];
  const t = tree ?? await departmentTree(db, companyId);
  const unknown = ids.filter((id) => !t.has(id));
  if (unknown.length) {
    throw invalid('INVALID', `${unknown.length === 1 ? 'An org unit' : 'Some org units'} in the filter ${unknown.length === 1 ? 'is' : 'are'} not in this company.`, {
      problems: [`${unknown.length === 1 ? 'One org unit' : `${unknown.length} org units`} in the filter ${unknown.length === 1 ? 'does' : 'do'} not exist in this company (removed, or never here). Choose the org units again.`],
    });
  }
  return ids;
}

/**
 * For services that filter in SQL (leave requests and balances, attendance):
 * `departmentId=12,40` -> every unit id at or under 12 or 40, checked as above.
 * -> number[] ([] when the value is blank).
 */
export async function unitIdsAndBelow(db, companyId, value) {
  if (blank(value)) return [];
  const tree = await departmentTree(db, companyId);
  const ids = await assertUnitIds(db, companyId, value, tree);
  const out = new Set();
  for (const id of ids) for (const x of tree.below(id)) out.add(x);
  return [...out];
}

/** Which of a spec's filters the address actually uses. */
export const activeFilters = (spec, query = {}) => Object.keys(spec.filters).filter((name) => !blank(query[name]));

/** The rows a spec and an address leave. Reads the department tree / the labels only when a filter needs them. */
export async function filterRows(db, companyId, rows, query, spec) {
  const active = activeFilters(spec, query);
  if (!active.length) return rows;
  const tree = (spec.needsTree ?? []).some((n) => active.includes(n)) ? await departmentTree(db, companyId) : NO_TREE;
  // One or more org units, each "and below": refused when one is not a unit of this company (spec §34.2).
  if (active.includes('department') && spec.filters.department) await assertUnitIds(db, companyId, query.department, tree);
  const index = (spec.needsLabels ?? []).some((n) => active.includes(n)) ? await labelIndex(db, companyId) : null;
  const tests = new Map();
  const aux = {
    below: (id) => tree.below(id),
    labelTest: (value) => {
      if (!tests.has(value)) tests.set(value, index ? labelMatcher(index, value) : () => true);
      return tests.get(value);
    },
  };
  return rows.filter((row) => active.every((name) => spec.filters[name](row, query[name], aux)));
}

/** Narrows an answer in place of its rows, and adds `total` and `count`. */
export async function applyListFilters(db, companyId, body, query, spec) {
  if (!body || typeof body !== 'object') return body;
  const key = spec.key.find((k) => Array.isArray(body[k]));
  if (!key) return body;
  const all = body[key];
  const rows = await filterRows(db, companyId, all, query, spec);
  const out = { ...body, total: all.length, count: rows.length };
  for (const k of spec.key) if (Array.isArray(body[k])) out[k] = rows;
  return out;
}

/** The step for a route: `listed('positions')`, between the guard and the handler. */
export const listed = (name) => {
  const spec = LIST_SPECS[name];
  if (!spec) throw new Error(`[cf_hrms] listed(): no list called "${name}".`);
  return Object.assign((req, res, next) => {
    const send = res.json.bind(res);
    res.json = (body) => {
      if (res.statusCode >= 400) return send(body);
      // A filter refused in words (a bad org unit id: 422) answers as a handler's refusal does; anything else sends the rows unfiltered.
      applyListFilters(pool, ctx(req).companyId, body, req.query, spec).then(send, (err) => (err?.status && err.status < 500 ? fail(res, err) : send(body)));
      return res;
    };
    next();
  }, { hrmsStep: Object.keys(spec.filters).length ? `filters: ${Object.keys(spec.filters).join(', ')}` : 'adds total and count' });
};

export default { LIST_SPECS, listed, filterRows, applyListFilters, departmentTree, activeFilters, assertUnitIds, unitIdsAndBelow };
