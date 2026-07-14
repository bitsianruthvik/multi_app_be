/**
 * taskEngineService.js
 * ---------------------
 * EU-6: Dependency-clearing engine for fab_erp (event-driven).
 *
 * Exported function:
 *   onTaskComplete(companyId, taskId)
 *
 * Called (by a later unit, EU-8's task lifecycle "stop"/complete route — not
 * built here) right after a fab_project_tasks row has been set to
 * status = 'done'. Finds sibling tasks that were waiting on it and, for each
 * one whose full predecessor set is now done, flips it to 'eligible'.
 *
 * Scoping rationale (non-obvious, load-bearing): depends_on stores seq_no
 * values, not row ids, and seq_no is only unique WITHIN one flow's step
 * sequence — it is not globally unique. materializeTasks() gives every
 * fab_items instance its own full copy of a flow's steps as separate
 * fab_project_tasks rows, so two different item_id instances running the
 * same flow_id both have a row with seq_no = 2. Every query in this file is
 * therefore scoped to (company_id, item_id, flow_id) of the just-completed
 * task, never to seq_no/flow_id alone, so completing task seq_no=2 for one
 * item instance can never clear a step on a sibling instance.
 *
 * "Runs after previous step" semantics (mirrors materializeTasks()): a task
 * whose depends_on is NULL/empty depends on the task in the same item_id +
 * flow_id scope with the largest seq_no strictly less than its own seq_no
 * (i.e. the step immediately before it in the flow). The very first step in
 * a flow has no such predecessor and is handled by materializeTasks() at
 * creation time, not here.
 */

import { pool } from '../../../db.js';

function parseDependsOn(csv) {
  if (csv === null || csv === undefined) return [];
  const str = String(csv).trim();
  if (str === '') return [];
  return str
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n));
}

/**
 * @param {number} companyId
 * @param {number} taskId - id of the fab_project_tasks row that just completed
 * @returns {Promise<{ ok: boolean, completedTaskId: number, successorsCleared: number[] }>}
 */
export async function onTaskComplete(companyId, taskId) {
  const conn = await pool.getConnection();

  try {
    await conn.beginTransaction();

    // ── 1. The just-completed task, scoped to this company ──────────────────
    const [completedRows] = await conn.query(
      `SELECT id, company_id, item_id, flow_id, seq_no, status
         FROM fab_project_tasks
        WHERE company_id = ? AND id = ? AND deleted_at IS NULL
        LIMIT 1`,
      [companyId, taskId],
    );

    if (completedRows.length === 0) {
      await conn.commit();
      return { ok: false, completedTaskId: taskId, successorsCleared: [] };
    }

    const completedTask = completedRows[0];
    const { item_id: itemId, flow_id: flowId, seq_no: completedSeqNo } = completedTask;

    // ── 2. All sibling tasks for this exact item_id + flow_id instance ──────
    // (same company_id + item_id + flow_id — see file header for why this
    // triple, not flow_id alone, is required)
    const [siblingRows] = await conn.query(
      `SELECT id, seq_no, depends_on, status
         FROM fab_project_tasks
        WHERE company_id = ? AND item_id = ? AND flow_id = ? AND deleted_at IS NULL`,
      [companyId, itemId, flowId],
    );

    const statusBySeqNo = new Map(siblingRows.map((r) => [r.seq_no, r.status]));
    const seqNos = siblingRows.map((r) => r.seq_no).sort((a, b) => a - b);

    // previous seq_no in this flow instance, for NULL/empty depends_on tasks
    function previousSeqNo(seqNo) {
      let prev = null;
      for (const s of seqNos) {
        if (s < seqNo && (prev === null || s > prev)) prev = s;
      }
      return prev;
    }

    // ── 3. Successors of the completed task ──────────────────────────────────
    const successors = [];
    for (const row of siblingRows) {
      if (row.status !== 'blocked') continue;

      const deps = parseDependsOn(row.depends_on);
      let predecessorSeqNos;

      if (deps.length > 0) {
        if (!deps.includes(completedSeqNo)) continue;
        predecessorSeqNos = deps;
      } else {
        const prev = previousSeqNo(row.seq_no);
        if (prev === null || prev !== completedSeqNo) continue;
        predecessorSeqNos = [prev];
      }

      const allPredecessorsDone = predecessorSeqNos.every(
        (sn) => statusBySeqNo.get(sn) === 'done',
      );

      if (allPredecessorsDone) successors.push(row.id);
    }

    // ── 4. Clear eligible successors ─────────────────────────────────────────
    const successorsCleared = [];
    for (const successorId of successors) {
      const [result] = await conn.query(
        `UPDATE fab_project_tasks
            SET status = 'eligible', deps_cleared_at = NOW(), queued_at = NOW()
          WHERE company_id = ? AND item_id = ? AND flow_id = ? AND id = ?
            AND status = 'blocked' AND deleted_at IS NULL`,
        [companyId, itemId, flowId, successorId],
      );

      if (result.affectedRows > 0) successorsCleared.push(successorId);
    }

    await conn.commit();

    return { ok: true, completedTaskId: taskId, successorsCleared };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}
