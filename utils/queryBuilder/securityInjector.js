export function injectSecurity(whereClause, jwt, resource) {
  // Global tables that are shared across all companies (no company_id filtering)
  const globalTables = ["features", "features_capability", "companies", "apps"];

  // Skip security injection for global tables
  if (resource && globalTables.includes(resource)) {
    return whereClause;
  }

  let securityConditions = [];

  // Check for company_id in JWT (could be company_id or companyId)
  const companyId = jwt?.company_id || jwt?.companyId;
  if (companyId !== undefined && companyId !== null) {
    securityConditions.push(`company_id = ${companyId}`);
  }

  // Check for team_ids
  if (jwt?.team_ids && jwt.team_ids.length > 0) {
    securityConditions.push(`team_id IN (${jwt.team_ids.join(",")})`);
  }

  if (securityConditions.length === 0) return whereClause;

  // Merge with existing WHERE clause
  if (whereClause.trim() === "") {
    return "WHERE " + securityConditions.join(" AND ");
  } else {
    return whereClause + " AND " + securityConditions.join(" AND ");
  }
}
