import { mapJoins } from "./joinMapper.js";
import { pool } from "../../db.js";

export async function buildSelectQuery(parsedResource) {
  const { table, alias, fields, relations } = parsedResource;

  // Build alias -> table map (main + relations)
  const aliasToTable = { [alias]: table };
  if (relations) {
    Object.values(relations).forEach((r) => {
      if (r.alias && r.table) aliasToTable[r.alias] = r.table;
    });
  }

  // Fetch columns for each table once
  const tableColumns = {};
  for (const [a, tbl] of Object.entries(aliasToTable)) {
    try {
      const [cols] = await pool.query(`SHOW COLUMNS FROM \`${tbl}\``);
      tableColumns[a] = new Set((cols || []).map((c) => c.Field));
    } catch (e) {
      // If SHOW COLUMNS fails, leave undefined to skip filtering for this table
      tableColumns[a] = null;
    }
  }

  // Filter fields: only keep those whose column exists on the target table (if known)
  const kept = Object.entries(fields).filter(([key, val]) => {
    // val is expected to be like 'alias.column' or an expression - handle simple case
    const m = String(val).match(/^(\w+)\.(\w+)$/);
    if (!m) {
      // keep complex expressions (assume they are valid)
      return true;
    }
    const [, a, col] = m;
    const colsSet = tableColumns[a];
    if (!colsSet) return true; // can't validate, so keep
    if (colsSet.has(col)) return true;
    console.warn(`Dropping unknown column from select: ${val}`);
    return false;
  });

  const filteredFields = Object.fromEntries(kept);

  // Build SELECT clause
  let selectClause;
  const fieldEntries = Object.entries(filteredFields || {});
  if (!fieldEntries.length) {
    // Nothing matched; return a safe fallback
    selectClause = "SELECT 1 AS _empty";
  } else {
    selectClause =
      "SELECT " +
      fieldEntries.map(([key, val]) => `${val} AS ${key}`).join(", ");
  }

  // FROM clause
  const fromClause = `FROM ${table} ${alias}`;

  // JOIN clause
  const joinClause = mapJoins(parsedResource);

  return `${selectClause} ${fromClause} ${joinClause}`;
}
