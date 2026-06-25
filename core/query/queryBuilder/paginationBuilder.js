// Handles LIMIT/OFFSET for pagination
export function addPagination(pagination) {
  if (!pagination) return "";
  const { limit, offset } = pagination;
  let clause = "";
  if (limit !== undefined) {
    const limitInt = parseInt(limit, 10);
    if (isNaN(limitInt) || limitInt < 0) throw new Error(`Invalid LIMIT value: ${limit}`);
    clause += ` LIMIT ${limitInt}`;
  }
  if (offset !== undefined) {
    const offsetInt = parseInt(offset, 10);
    if (isNaN(offsetInt) || offsetInt < 0) throw new Error(`Invalid OFFSET value: ${offset}`);
    clause += ` OFFSET ${offsetInt}`;
  }
  return clause;
}

const ALLOWED_DIRECTIONS = new Set(["ASC", "DESC"]);

// Handles ORDER BY — allowedFields must be the resource's fields map to prevent injection.
// Accepts two formats:
//   Array: [{ field: "created_at", direction: "DESC" }, ...]
//   Object: { created_at: "DESC", ... }
export function buildOrderBy(orderBy, allowedFields) {
  if (!orderBy) return "";
  const allowed = allowedFields ? new Set(Object.keys(allowedFields)) : null;
  const parts = [];

  // Normalise to array of { field, direction }
  const entries = Array.isArray(orderBy)
    ? orderBy.map((item) => [item.field, item.direction])
    : Object.entries(orderBy);

  for (const [field, direction] of entries) {
    if (!field || typeof field !== "string") continue;
    if (allowed && !allowed.has(field)) {
      throw new Error(`Invalid orderBy field: ${field}`);
    }
    const dir = String(direction || "ASC").toUpperCase();
    if (!ALLOWED_DIRECTIONS.has(dir)) {
      throw new Error(`Invalid orderBy direction: ${direction}`);
    }
    parts.push(`${field} ${dir}`);
  }
  return parts.length ? ` ORDER BY ${parts.join(", ")}` : "";
}
