import { parseResource } from "./resourceParser.js";
import { buildSelectQuery } from "./sqlBuilder.js";
import { buildWhere } from "./whereBuilder.js";
import { addPagination, buildOrderBy } from "./paginationBuilder.js";
import { injectSecurity } from "./securityInjector.js";

export function buildQuery(config) {
  const { resource, filters, orderBy, pagination, jwt } = config;

  // 1️⃣ Parse resource definition
  const parsedResource = parseResource(resource);

  // 2️⃣ Build SELECT + JOIN part
  const selectJoinSQL = buildSelectQuery(parsedResource);

  // 3️⃣ Build WHERE clause with field types for proper operator handling
  let whereSQL = "";
  if (filters) whereSQL = buildWhere(filters, parsedResource.fieldTypes || {});

  // 4️⃣ Inject security filters (company, team) - pass resource name to check if it's global
  if (jwt) whereSQL = injectSecurity(whereSQL, jwt, resource);

  // 5️⃣ Build ORDER BY
  const orderSQL = orderBy ? buildOrderBy(orderBy) : "";

  // 6️⃣ Add Pagination (LIMIT/OFFSET)
  const paginationSQL = pagination ? addPagination(pagination) : "";

  // 7️⃣ Combine everything
  const finalQuery =
    [selectJoinSQL, whereSQL, orderSQL, paginationSQL]
      .filter(Boolean)
      .map((part) => part.trim())
      .join(" ") + ";";

  return finalQuery;
}
