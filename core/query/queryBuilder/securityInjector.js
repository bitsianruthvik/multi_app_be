// Injects mandatory company/team scoping and soft-delete filter into WHERE clause.
// Takes and returns { sql, params } so the full query stays parameterized.
//
// Signature: injectSecurity(whereSql, whereParams, jwt, resource, options)
//   options.includeDeleted  — when true and jwt.role === 'admin', omit deleted_at filter
//   options.alias           — table alias to qualify deleted_at (e.g. "ar")
export function injectSecurity(whereSql, whereParams, jwt, resource, options = {}) {
  const includeDeleted = options.includeDeleted === true;
  const alias = options.alias || null;

  const conditions = [];
  const extraParams = [];

  // hasCompanyId is passed by queryBuilder, which reads the table's real
  // columns. Tables without a company_id (features, features_capability,
  // companies) are skipped by that alone.
  //
  // There used to be a `globalTables` list here as well, and it was the bug:
  // it named `roles`, `teams`, `role_capability` and `apps`, all four of which
  // DO have a company_id, so every read of them spanned all tenants — a read of
  // `roles` from one company returned seven companies' rows. The list was added
  // (see architecture/errors.md) only because those tables once lacked a
  // deleted_at column; they all have one now, and in this version the list did
  // not gate the soft-delete filter anyway. One list doing two jobs, long after
  // the second job stopped existing.
  const hasCompanyId = options.hasCompanyId !== false;

  if (hasCompanyId) {
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
