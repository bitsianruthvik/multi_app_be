import { mapJoins } from "./joinMapper.js";
import { logger } from "../../utils/logger.js";
import { getTableColumns } from "./schemaCache.js";

const ALLOWED_AGG_FUNCTIONS = new Set(["COUNT", "SUM", "AVG", "MIN", "MAX"]);

export async function buildSelectQuery(parsedResource, aggregate) {
  const { table, alias, fields, relations } = parsedResource;

  // Build alias -> table map (main + relations)
  const aliasToTable = { [alias]: table };
  if (relations) {
    Object.values(relations).forEach((r) => {
      if (r.alias && r.table) aliasToTable[r.alias] = r.table;
    });
  }

  // Fetch columns for each table once (cached after first call)
  const tableColumns = {};
  for (const [a, tbl] of Object.entries(aliasToTable)) {
    try {
      tableColumns[a] = await getTableColumns(tbl);
    } catch (e) {
      tableColumns[a] = null;
    }
  }

  // Fields that we allow through even if SHOW COLUMNS doesn't report them
  // Only `processed_url` is valid in the current schema; do not allow
  // legacy/removed processed_* fields or transcription_error.
  // Also allow score and keywords_of_improvement for analysis results.
  // Also allow track, history_block, and updated_at for historical tracking.
  const passthroughAllowed = new Set([
    "processed_url",
    "score",
    "keywords_of_improvement",
    "track",
    "history_block",
    "updated_at",
  ]);

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
    if (passthroughAllowed.has(col)) return true;
    logger.warn(`Dropping unknown column from select: ${val}`);
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

  // JOIN clause — pass the projected field names so mapJoins only joins what is needed
  const joinClause = mapJoins(parsedResource, Object.keys(filteredFields));

  // When aggregate is provided, replace the SELECT clause with aggregate expressions
  if (aggregate) {
    const allowedFields = new Set(Object.keys(fields || {}));

    // Validate and build aggregate function expressions
    const aggParts = [];
    for (const fn of aggregate.functions || []) {
      const fnUpper = String(fn.function || fn.fn || "").toUpperCase();
      if (!ALLOWED_AGG_FUNCTIONS.has(fnUpper)) {
        throw new Error(`Unsupported aggregate function: ${fnUpper}`);
      }
      const fieldName = fn.field;
      let resolvedField;
      if (fieldName === "*") {
        resolvedField = "*";
      } else {
        if (!allowedFields.has(fieldName)) {
          throw new Error(`Invalid aggregate field: ${fieldName}`);
        }
        resolvedField = fields[fieldName]; // e.g. "ar.title"
      }
      const aggAlias = fn.alias || `${fnUpper.toLowerCase()}_${fieldName}`;
      aggParts.push(`${fnUpper}(${resolvedField}) AS \`${aggAlias}\``);
    }

    // Validate and include groupBy columns in SELECT
    const groupByParts = [];
    for (const gb of aggregate.groupBy || []) {
      if (!allowedFields.has(gb)) {
        throw new Error(`Invalid groupBy field: ${gb}`);
      }
      groupByParts.push(`${fields[gb]} AS ${gb}`);
    }

    const allSelectParts = [...groupByParts, ...aggParts];
    if (allSelectParts.length === 0) {
      throw new Error("Aggregate query must specify at least one function or groupBy field");
    }
    const aggSelectClause = `SELECT ${allSelectParts.join(", ")}`;
    return `${aggSelectClause} ${fromClause} ${joinClause}`;
  }

  return `${selectClause} ${fromClause} ${joinClause}`;
}
