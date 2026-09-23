import { pool } from '../../../db.js';

/**
 * Runs fn(conn) inside one transaction on one connection.
 *
 * Every cf_erp write goes through here, because the model's writes come in
 * pairs that must land together or not at all: a master row and its detail
 * row, a value and its history row, a generated code and the counter that
 * produced it.
 *
 * Services never open transactions themselves — they take the connection they
 * are given. That keeps them composable (creating an item sets values, runs the
 * code generator and materialises defaults, all on one connection) and lets a
 * test run a whole flow and roll it back.
 */
export async function withTransaction(fn) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    try { await conn.rollback(); } catch { /* the original error is the one that matters */ }
    throw err;
  } finally {
    conn.release();
  }
}

export { pool };
