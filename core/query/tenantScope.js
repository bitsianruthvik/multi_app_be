/**
 * tenantScope.js — how the generic query API ties a row to a company (2026-11-24 isolation audit).
 *
 * The rule: a signed-in person reads and writes only their own company's rows; nothing answers without a company,
 * and nothing that cannot be tied to a company is reachable at all. Before this, three holes:
 *   - a read with no company (the public paths) simply LEFT OUT the company filter — every company's rows;
 *   - an update kept `company_id` if the caller sent it, so a row (a user, an app grant) could be moved into another
 *     company — an admin could make themselves an admin of another company;
 *   - tables with no company_id (companies, fab_nodes, …) were read and written by id alone, across companies.
 *
 * A table is one of:
 *   - has company_id            → `alias.company_id = ?`
 *   - SCOPE_VIA[table]          → tied through a parent row (a plan's company)
 *   - GLOBAL_TABLES             → the platform's own catalogue: readable when signed in, never written through the API
 *   - anything else             → nobody (fails closed)
 * The worker service token stays unscoped (it acts across companies by design).
 */
import { pool } from "../../db.js";
import { getTableColumns } from "./queryBuilder/schemaCache.js";

const PLAN_OF_COMPANY = "SELECT fpp.id FROM fab_project_plans fpp WHERE fpp.company_id = ?";

/** Tables without company_id that belong to a company through a parent row: alias → SQL condition with one `?`. */
export const SCOPE_VIA = {
  companies: (a) => `${a}.id = ?`,
  fab_nodes: (a) => `${a}.project_plan_id IN (${PLAN_OF_COMPANY})`,
  fab_node_relationships: (a) => `${a}.project_plan_id IN (${PLAN_OF_COMPANY})`,
  fab_excel_import_batches: (a) => `${a}.project_plan_id IN (${PLAN_OF_COMPANY})`,
  fab_excel_import_issues: (a) => `${a}.import_batch_id IN (SELECT feib.id FROM fab_excel_import_batches feib WHERE feib.project_plan_id IN (${PLAN_OF_COMPANY}))`,
};

/** The platform's catalogue (features and their groups): no company in it. Read when signed in; written by no one here. */
export const GLOBAL_TABLES = new Set(["features", "features_capability"]);

/** Tables that may be written through the generic API although they have no company_id (scoped through a parent). */
const WRITABLE_VIA = new Set(["fab_nodes", "fab_node_relationships", "fab_excel_import_batches", "fab_excel_import_issues"]);

export const companyOf = (jwt) => {
  const c = Number(jwt?.company_id ?? jwt?.companyId);
  return Number.isFinite(c) && c > 0 ? c : null;
};
export const isService = (jwt) => !!jwt?.is_service;

/**
 * The read condition for a table: { sql, params } (sql without WHERE/AND), or null for no condition (service only).
 * `hasCompanyId` comes from the table's real columns.
 */
export function readScope(table, alias, hasCompanyId, jwt) {
  if (isService(jwt)) return null;
  const a = alias || table;
  const cid = companyOf(jwt);
  if (hasCompanyId) return cid ? { sql: `${a}.company_id = ?`, params: [cid] } : { sql: "1 = 0", params: [] };
  if (SCOPE_VIA[table]) return cid ? { sql: SCOPE_VIA[table](a), params: [cid] } : { sql: "1 = 0", params: [] };
  if (GLOBAL_TABLES.has(table)) return cid ? null : { sql: "1 = 0", params: [] };
  return { sql: "1 = 0", params: [] };
}

/** May this table be written through the generic API by a person (not the service token)? */
export async function writeMode(table) {
  const cols = await getTableColumns(table);
  if (cols.has("company_id")) return "company";
  if (WRITABLE_VIA.has(table) && SCOPE_VIA[table]) return "via";
  return "none";
}

/** Does row `id` of `table` belong to company `cid`? (Tables tied through a parent use SCOPE_VIA; global ones: yes.) */
export async function rowIsCompanys(table, id, cid) {
  if (id === null || id === undefined || id === "") return true;
  if (GLOBAL_TABLES.has(table)) return true;
  const cols = await getTableColumns(table);
  let sql;
  if (cols.has("company_id")) sql = `SELECT 1 FROM \`${table}\` t WHERE t.id = ? AND t.company_id = ? LIMIT 1`;
  else if (SCOPE_VIA[table]) sql = `SELECT 1 FROM \`${table}\` t WHERE t.id = ? AND ${SCOPE_VIA[table]("t")} LIMIT 1`;
  else return false;
  const [rows] = await pool.query(sql, [id, cid]);
  return rows.length > 0;
}

/** Core references every resource may carry, beside the ones its own relations name. */
const CORE_REFS = { role_id: "roles", team_id: "teams", app_id: "apps", user_id: "users", project_plan_id: "fab_project_plans", import_batch_id: "fab_excel_import_batches" };

/**
 * The columns of a write that point at another row, and the table each points at: the resource's own relations
 * (`on: "<base>.<col> = <rel>.id"`) plus CORE_REFS. → Map col → table.
 */
export function referenceColumns(def) {
  const out = new Map(Object.entries(CORE_REFS));
  for (const rel of Object.values(def?.relations || {})) {
    const m = String(rel?.on || "").match(/^\s*(\w+)\.(\w+)\s*=\s*(\w+)\.id\s*$/);
    if (m && m[1] === def.alias && m[3] === rel.alias && rel.table) out.set(m[2], rel.table);
    const r = String(rel?.on || "").match(/^\s*(\w+)\.id\s*=\s*(\w+)\.(\w+)\s*$/);
    if (r && r[2] === def.alias && r[1] === rel.alias && rel.table) out.set(r[3], rel.table);
  }
  return out;
}

/** The first column of `data` that points at another company's row, or null. */
export async function foreignReference(def, data, cid) {
  const refs = referenceColumns(def);
  for (const [col, value] of Object.entries(data || {})) {
    const table = refs.get(col);
    if (!table || value === null || value === undefined || value === "") continue;
    if (!(await rowIsCompanys(table, value, cid))) return col;
  }
  return null;
}
