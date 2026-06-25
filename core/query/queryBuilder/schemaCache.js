import { pool } from "../../../db.js";

const schemaCache = new Map();

export async function getTableColumns(table) {
  if (schemaCache.has(table)) return schemaCache.get(table);
  const [cols] = await pool.query(`SHOW COLUMNS FROM \`${table}\``);
  const colSet = new Set((cols || []).map((c) => c.Field));
  schemaCache.set(table, colSet);
  return colSet;
}

export function clearSchemaCache() {
  schemaCache.clear();
}
