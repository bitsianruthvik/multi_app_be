/**
 * WHERE clause builder — returns { sql, params } using ? placeholders.
 * MySQL2 handles all value escaping; no manual string escaping is done here.
 */

const MAX_IN_VALUES_SAFE = 200;

function escapeIdentifierSafe(identifier) {
  return `\`${String(identifier).replace(/`/g, "``")}\``;
}

export function buildWhere(filters, fieldTypes = {}, fieldMap = {}) {
  if (!filters || Object.keys(filters).length === 0) return { sql: "", params: [] };

  const conditions = [];
  const params = [];

  for (const [key, value] of Object.entries(filters)) {
    let field, operator;
    if (key.includes(".")) {
      [field, operator] = key.split(".");
      operator = operator ? operator.toUpperCase() : null;
    } else {
      field = key;
      operator = null;
    }

    if (!/^[a-zA-Z0-9_]+$/.test(field)) {
      throw new Error(`Invalid field name: ${field}`);
    }

    const type = fieldTypes[field] || "string";
    // Use the resolved SQL expression from resourceDef (e.g. "fpp.id") when available,
    // otherwise fall back to a quoted identifier built from the raw key name.
    const ident = fieldMap[field] || escapeIdentifierSafe(field);

    if (!operator) {
      if (value === null) operator = "IS NULL";
      else if (Array.isArray(value)) operator = "IN";
      else operator = type === "string" ? "LIKE" : "=";
    }

    switch (operator) {
      case "=":
      case "EQ":
        conditions.push(`${ident} = ?`);
        params.push(value);
        break;
      case "!=":
      case "NEQ":
        conditions.push(`${ident} != ?`);
        params.push(value);
        break;
      case "LIKE":
        conditions.push(`${ident} LIKE ?`);
        params.push(value);
        break;
      case "NOT LIKE":
        conditions.push(`${ident} NOT LIKE ?`);
        params.push(value);
        break;
      case "IN":
      case "NOT IN":
        if (!Array.isArray(value))
          throw new Error(`IN operator requires array value for ${field}`);
        if (value.length === 0) {
          conditions.push(operator === "IN" ? "0=1" : "1=1");
          break;
        }
        if (value.length > MAX_IN_VALUES_SAFE)
          throw new Error(`Too many values in IN clause (max ${MAX_IN_VALUES_SAFE})`);
        conditions.push(`${ident} ${operator} (${value.map(() => "?").join(", ")})`);
        params.push(...value);
        break;
      case "BETWEEN":
      case "NOT BETWEEN":
        if (!Array.isArray(value) || value.length !== 2)
          throw new Error(`BETWEEN requires array of two values for ${field}`);
        conditions.push(`${ident} ${operator} ? AND ?`);
        params.push(value[0], value[1]);
        break;
      case "IS NULL":
        conditions.push(`${ident} IS NULL`);
        break;
      case "IS NOT NULL":
        conditions.push(`${ident} IS NOT NULL`);
        break;
      case "<":
      case ">":
      case "<=":
      case ">=":
      case "LT":
      case "GT":
      case "LTE":
      case "GTE": {
        const op =
          operator.length > 2
            ? operator === "LT" ? "<" : operator === "GT" ? ">" : operator === "LTE" ? "<=" : ">="
            : operator;
        conditions.push(`${ident} ${op} ?`);
        params.push(value);
        break;
      }
      default:
        throw new Error(`Unsupported operator: ${operator}`);
    }
  }

  return {
    sql: conditions.length ? `WHERE ${conditions.join(" AND ")}` : "",
    params,
  };
}
