// Injects mandatory company/team scoping and soft-delete filter into WHERE clause.
// Takes and returns { sql, params } so the full query stays parameterized.
//
// Signature: injectSecurity(whereSql, whereParams, jwt, resource, options)
//   options.includeDeleted  — when true and jwt.role === 'admin', omit deleted_at filter
//   options.alias           — table alias to qualify deleted_at (e.g. "ar")
export function injectSecurity(whereSql, whereParams, jwt, resource, options = {}) {
  const globalTables = ["features", "features_capability", "companies", "apps", "roles", "teams", "role_capability"];

  const includeDeleted = options.includeDeleted === true;
  const alias = options.alias || null;

  const isGlobal = resource && globalTables.includes(resource);

  const conditions = [];
  const extraParams = [];

  // hasCompanyId is passed by queryBuilder when the main table's resourceDef confirms it
  // has a company_id column. Child tables (e.g. fab_nodes) don't — skip injection there.
  const hasCompanyId = options.hasCompanyId !== false;

  if (!isGlobal && hasCompanyId) {
    const companyId = jwt?.company_id || jwt?.companyId;
    if (companyId !== undefined && companyId !== null) {
      const companyCol = alias ? `${alias}.company_id` : "company_id";
      conditions.push(`${companyCol} = ?`);
      extraParams.push(companyId);
    }

    if (jwt?.team_ids && jwt.team_ids.length > 0) {
      conditions.push(`team_id IN (${jwt.team_ids.map(() => "?").join(",")})`);
      extraParams.push(...jwt.team_ids);
    }
  }

  // Soft-delete filter: always inject unless caller is admin AND explicitly opts in.
  // Non-admins cannot bypass this filter even if they pass include_deleted: true.
  const isAdmin =
    jwt?.role && String(jwt.role).toLowerCase() === "admin";
  const skipDeletedFilter = includeDeleted && isAdmin;

  if (!skipDeletedFilter) {
    const col = alias ? `${alias}.deleted_at` : "deleted_at";
    conditions.push(`${col} IS NULL`);
  }

  if (conditions.length === 0) return { sql: whereSql, params: whereParams };

  const combinedParams = [...whereParams, ...extraParams];
  if (!whereSql.trim()) {
    return { sql: "WHERE " + conditions.join(" AND "), params: combinedParams };
  }
  return { sql: whereSql + " AND " + conditions.join(" AND "), params: combinedParams };
}
