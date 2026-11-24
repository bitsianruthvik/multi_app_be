// joinMapper.js

/**
 * Iteratively finds the required fields by traversing all related tables
 * until found or all options are exhausted.
 *
 * @param {Object} parsedResource - Resource definition (contains base + relations)
 * @param {Array} requestedFields - List of requested field names
 * @returns {String} SQL JOIN clause string
 */
export function mapJoins(parsedResource, requestedFields = [], companyAliases = null) {
  const { alias, fields, relations } = parsedResource || {};
  if (!relations || Object.keys(relations).length === 0) return "";

  // A JOIN NEVER REACHES ANOTHER COMPANY (2026-11-24): when both the base table and the joined one carry company_id,
  // the join also matches it. The relations join on id alone, so a row pointing at another company's id (an order's
  // customer, a plan's approver) showed that company's names and codes.
  const joinOf = (rel) => {
    const sameCompany = companyAliases && companyAliases.has(alias) && companyAliases.has(rel.alias)
      ? ` AND ${rel.alias}.company_id = ${alias}.company_id` : "";
    return `LEFT JOIN ${rel.table} ${rel.alias} ON (${rel.on})${sameCompany}`;
  };

  // If no specific fields are requested → join all relations (legacy fallback)
  if (!requestedFields || requestedFields.length === 0) {
    return Object.values(relations).map(joinOf).join(" ");
  }

  // Derive base-table field names from the resourceDef: any field whose expression
  // starts with the primary table alias (e.g. "fpp.id" → base table field "id").
  const baseTableFields = new Set(
    Object.entries(fields || {})
      .filter(([, expr]) => String(expr).startsWith(`${alias}.`))
      .map(([key]) => key)
  );

  const joinClauses = [];
  const resolvedFields = new Set();

  for (const field of requestedFields) {
    if (resolvedFields.has(field)) continue;

    if (baseTableFields.has(field)) {
      resolvedFields.add(field);
      continue;
    }

    let found = false;
    for (const rel of Object.values(relations)) {
      if (Array.isArray(rel.fields) && rel.fields.includes(field)) {
        const alreadyJoined = joinClauses.some(
          (j) => j.includes(` ${rel.alias} `) || j.includes(`${rel.alias}.`)
        );
        if (!alreadyJoined) {
          joinClauses.push(joinOf(rel));
        }
        resolvedFields.add(field);
        found = true;
        break;
      }
    }

    if (!found) {
      throw new Error(`Field "${field}" not found in any table or relation.`);
    }
  }

  return joinClauses.join(" ");
}
