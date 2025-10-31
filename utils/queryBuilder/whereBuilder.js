/**
 * WHERE clause builder module
 * Builds SQL WHERE conditions based on provided filters and field types.
 *
 * This implementation focuses on correctness and clearing syntax errors.
 * It performs basic identifier validation and escapes string values.
 * NOTE: For maximum security prefer parameterized queries at the DB driver layer.
 */

const MAX_IN_VALUES_SAFE = 200;

function escapeIdentifierSafe(identifier) {
  // escape backticks and wrap in backticks
  return `\`${String(identifier).replace(/`/g, "``")}\``;
}

function escapeValueSafe(value) {
  if (value === null) return "NULL";
  if (typeof value === "number" || typeof value === "bigint")
    return String(value);
  if (typeof value === "boolean") return value ? "1" : "0";
  // simple escape single quotes for SQL literals
  return `'${String(value).replace(/'/g, "''")}'`;
}

export function buildWhere(filters, fieldTypes = {}) {
  // empty filters -> no WHERE clause
  if (!filters || Object.keys(filters).length === 0) return "";

  const conditions = [];

  for (const [key, value] of Object.entries(filters)) {
    // key may be 'field' or 'field.operator'
    let field, operator;
    if (key.includes(".")) {
      [field, operator] = key.split(".");
      operator = operator ? operator.toUpperCase() : null;
    } else {
      field = key;
      operator = null;
    }

    // validate field name - allow only safe chars
    if (!/^[a-zA-Z0-9_]+$/.test(field)) {
      throw new Error(`Invalid field name: ${field}`);
    }

    const type = fieldTypes[field] || "string";
    const ident = escapeIdentifierSafe(field);

    // choose default operator when not provided
    if (!operator) {
      if (value === null) operator = "IS NULL";
      else if (Array.isArray(value)) operator = "IN";
      else operator = type === "string" ? "LIKE" : "=";
    }

    switch (operator) {
      case "=":
      case "EQ":
        conditions.push(`${ident} = ${escapeValueSafe(value)}`);
        break;
      case "!=":
      case "NEQ":
        conditions.push(`${ident} != ${escapeValueSafe(value)}`);
        break;
      case "LIKE":
        conditions.push(`${ident} LIKE ${escapeValueSafe(value)}`);
        break;
      case "NOT LIKE":
        conditions.push(`${ident} NOT LIKE ${escapeValueSafe(value)}`);
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
          throw new Error(
            `Too many values in IN clause (max ${MAX_IN_VALUES_SAFE})`
          );
        conditions.push(
          `${ident} ${operator} (${value.map(escapeValueSafe).join(", ")})`
        );
        break;
      case "BETWEEN":
      case "NOT BETWEEN":
        if (!Array.isArray(value) || value.length !== 2)
          throw new Error(`BETWEEN requires array of two values for ${field}`);
        conditions.push(
          `${ident} ${operator} ${escapeValueSafe(
            value[0]
          )} AND ${escapeValueSafe(value[1])}`
        );
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
      case "GTE":
        const op =
          operator.length > 2
            ? operator === "LT"
              ? "<"
              : operator === "GT"
              ? ">"
              : operator === "LTE"
              ? "<="
              : ">="
            : operator;
        conditions.push(`${ident} ${op} ${escapeValueSafe(value)}`);
        break;
      default:
        throw new Error(`Unsupported operator: ${operator}`);
    }
  }

  return conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
}
// checking change thing's for git

//another change to just test
// more changes to test git
