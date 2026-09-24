import { pool } from '../../../db.js';

/**
 * Runs fn(conn) inside one transaction on one connection.
 *
 * Every cf_hrms write goes through here, because this model's writes come in
 * groups that must land together or not at all:
 *   - ending an effective-dated row and inserting its replacement (that is what
 *     "ended, not overwritten" means in practice — two statements, one truth);
 *   - approving a leave request: the request, the balance and the attendance
 *     rows for every affected date;
 *   - approving a regularisation: the request and the attendance row it corrects;
 *   - generating a document: the snapshot, the rendered files and the demotion
 *     of the previous is_current row;
 *   - committing an org-chart import: thousands of rows across a dozen tables,
 *     plus the hrms_import_runs id map that makes it reversible;
 *   - and every one of those also writes its hrms_audit_log row, in the SAME
 *     transaction, because TiDB has no triggers and an audit row written
 *     afterwards is an audit row that can go missing.
 *
 * Services never open transactions themselves — they take the connection they
 * are given. That keeps them composable (the importer calls the same
 * assignment service a screen does) and lets a test run a whole flow and roll
 * it back.
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
