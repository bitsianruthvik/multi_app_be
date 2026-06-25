import { parseResource } from "./resourceParser.js";
import { buildSelectQuery } from "./sqlBuilder.js";
import { buildWhere } from "./whereBuilder.js";
import { addPagination, buildOrderBy } from "./paginationBuilder.js";
import { injectSecurity } from "./securityInjector.js";

// Returns { sql, params } — callers must pass both to pool.query(sql, params).
export async function buildQuery(config) {
  const { resource, filters, orderBy, pagination, jwt, includeDeleted, aggregate } = config;

  // 1. Parse resource definition
  const parsedResource = parseResource(resource);

  // 2. Build SELECT + JOIN part (validates columns against schema cache)
  const selectJoinSQL = await buildSelectQuery(parsedResource, aggregate);

  // 3. Build WHERE clause — returns { sql, params }
  let whereSql = "";
  let whereParams = [];
  if (filters) {
    const whereResult = buildWhere(filters, parsedResource.fieldTypes || {}, parsedResource.fields || {});
    whereSql = whereResult.sql;
    whereParams = whereResult.params;
  }

  // 4. Inject company/team security scoping and soft-delete filter
  // Only inject company_id filter when the main table's resourceDef maps a field to
  // `<alias>.company_id` — child tables (e.g. fab_nodes) don't have their own company_id.
  const mainAlias = parsedResource.alias;
  const hasCompanyId = Object.values(parsedResource.fields || {}).some(
    (expr) => String(expr) === `${mainAlias}.company_id`,
  );
  const secured = injectSecurity(whereSql, whereParams, jwt || null, resource, {
    includeDeleted: !!includeDeleted,
    alias: mainAlias,
    hasCompanyId,
  });
  whereSql = secured.sql;
  whereParams = secured.params;

  // 5. ORDER BY — field validated against resource allowlist
  const orderSQL = orderBy ? buildOrderBy(orderBy, parsedResource.fields) : "";

  // 6. LIMIT/OFFSET — values are cast to integer inside addPagination
  const paginationSQL = pagination ? addPagination(pagination) : "";

  // 7. GROUP BY / HAVING when aggregate is present
  let groupBySQL = "";
  let havingSQL = "";
  if (aggregate) {
    if (aggregate.groupBy && aggregate.groupBy.length > 0) {
      // Validate groupBy fields against resource allowlist
      const allowedFields = new Set(Object.keys(parsedResource.fields || {}));
      for (const gb of aggregate.groupBy) {
        if (!allowedFields.has(gb)) {
          throw new Error(`Invalid groupBy field: ${gb}`);
        }
      }
      groupBySQL = `GROUP BY ${aggregate.groupBy.join(", ")}`;
    }
    if (aggregate.having) {
      // Build HAVING using the aggregate aliases as synthetic fieldTypes (numeric)
      const syntheticFieldTypes = {};
      for (const fn of aggregate.functions || []) {
        if (fn.alias) syntheticFieldTypes[fn.alias] = "integer";
      }
      const havingResult = buildWhere(aggregate.having, syntheticFieldTypes);
      // Replace "WHERE" prefix with "HAVING"
      havingSQL = havingResult.sql.replace(/^WHERE\s+/i, "HAVING ");
      whereParams = [...whereParams, ...havingResult.params];
    }
  }

  // 8. Combine
  const sql =
    [selectJoinSQL, whereSql, groupBySQL, havingSQL, orderSQL, paginationSQL]
      .filter(Boolean)
      .map((part) => part.trim())
      .join(" ") + ";";

  return { sql, params: whereParams };
}
