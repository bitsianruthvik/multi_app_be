import { pool } from '../../../db.js';
import { attachNodeCache, detachNodeCache } from './nodeCache.js';

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
 *
 * The transaction also owns the classification-node memo (lib/nodeCache.js):
 * a fresh Map on the way in, deleted in the finally on the way out, so it can
 * never ride a pooled connection into the next company's request.
 */
export async function withTransaction(fn) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    attachNodeCache(conn);
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    try { await conn.rollback(); } catch { /* the original error is the one that matters */ }
    throw err;
  } finally {
    detachNodeCache(conn);
    conn.release();
  }
}

export { pool };
export { attachNodeCache, detachNodeCache, invalidateNodeCache } from './nodeCache.js';
