/**
 * taskEventService.js
 * --------------------
 * EU-2: Dual-write lifecycle events into fab_task_events alongside the
 * existing fab_project_tasks timestamp columns. Event logging must never
 * break the caller's main write — all failures are caught and logged.
 *
 * RUNNING INSIDE A CALLER'S TRANSACTION (`exec`)
 * ---------------------------------------------
 * Both writers take an optional `exec` — a transaction connection — and fall
 * back to the pool when it is absent.
 *
 * That parameter is not a convenience. Until 2026-08-04 these always used the
 * pool, so a caller holding a transaction (applyRematerialize → materializeOrderTasks
 * → tryClearTask) wrote its task rows on one connection and its events on a
 * SECOND one. The second connection then waited for locks the first would only
 * release on commit — and the first could not commit, because it was waiting on
 * the second. A textbook self-deadlock, which surfaced as "Lock wait timeout
 * exceeded" roughly a minute into any re-materialize big enough to matter.
 * Preview never hit it (read-only, no transaction), so it looked fine.
 *
 * If you call these from inside a transaction, PASS THE CONNECTION.
 */

import { pool } from '../../../db.js';
import { logger } from '../../../core/utils/logger.js';

/**
 * @param {object} params
 * @param {number} params.companyId
 * @param {number} params.taskId
 * @param {string} params.type - fab_task_events.event_type
 * @param {Date|string|null} [params.at] - defaults to NOW() in SQL when null
 * @param {'live'|'backfill'|'system'} [params.source]
 * @param {number|null} [params.enteredBy]
 * @param {string|null} [params.note]
 * @returns {Promise<{ok: boolean}>}
 */
export async function recordEvent({
  companyId,
  taskId,
  type,
  at = null,
  source = 'live',
  enteredBy = null,
  note = null,
}, exec = pool) {
  try {
    await exec.query(
      `INSERT INTO fab_task_events (company_id, task_id, event_type, at, source, entered_by, note)
       VALUES (?, ?, ?, COALESCE(?, NOW()), ?, ?, ?)`,
      [companyId, taskId, type, at, source, enteredBy, note],
    );
    return { ok: true };
  } catch (err) {
    logger.error({ err, companyId, taskId, type }, 'taskEventService.recordEvent: failed to record event');
    return { ok: false };
  }
}

/**
 * Batch variant — single multi-row INSERT.
 * @param {Array<{companyId:number, taskId:number, type:string, at?:Date|string|null, source?:string, enteredBy?:number|null, note?:string|null}>} events
 * @returns {Promise<{ok: boolean}>}
 */
export async function recordEvents(events, exec = pool) {
  if (!Array.isArray(events) || events.length === 0) return { ok: true };
  try {
    const placeholders = [];
    const params = [];
    for (const e of events) {
      placeholders.push('(?, ?, ?, COALESCE(?, NOW()), ?, ?, ?)');
      params.push(
        e.companyId,
        e.taskId,
        e.type,
        e.at ?? null,
        e.source ?? 'live',
        e.enteredBy ?? null,
        e.note ?? null,
      );
    }
    await exec.query(
      `INSERT INTO fab_task_events (company_id, task_id, event_type, at, source, entered_by, note)
       VALUES ${placeholders.join(', ')}`,
      params,
    );
    return { ok: true };
  } catch (err) {
    logger.error({ err, count: events.length }, 'taskEventService.recordEvents: failed to record events');
    return { ok: false };
  }
}

/**
 * EU-10: supersede a fab_task_events row by inserting a corrected copy (same
 * task_id + event_type, corrected `at`, source 'backfill') and stamping the old
 * row's superseded_by_event_id with the new id — in ONE transaction. The old
 * row's `at` is never mutated; corrections are append-only for auditability.
 *
 * Unlike recordEvent/recordEvents (which swallow errors so lifecycle writes are
 * never broken by event logging), this is user-initiated correction: a genuine
 * DB failure MUST surface, so this rethrows after rolling back.
 *
 * @param {object} params
 * @param {number} params.companyId
 * @param {number} params.oldEventId
 * @param {Date|string|null} params.newAt   corrected timestamp (COALESCE→NOW() if null)
 * @param {number|null} [params.enteredBy]
 * @param {string|null} [params.note]
 * @returns {Promise<{oldEventId:number, newEventId:number}>}
 * @throws if the event is missing/already-superseded or on any DB error
 */
export async function supersedeEvent({ companyId, oldEventId, newAt, enteredBy = null, note = null }) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [rows] = await conn.query(
      `SELECT task_id, event_type FROM fab_task_events
        WHERE id = ? AND company_id = ? AND deleted_at IS NULL AND superseded_by_event_id IS NULL
        LIMIT 1`,
      [oldEventId, companyId],
    );
    if (rows.length === 0) {
      throw new Error(`supersedeEvent: event ${oldEventId} not found or already superseded`);
    }
    const { task_id, event_type } = rows[0];

    const [ins] = await conn.query(
      `INSERT INTO fab_task_events (company_id, task_id, event_type, at, source, entered_by, note)
       VALUES (?, ?, ?, COALESCE(?, NOW()), 'backfill', ?, ?)`,
      [companyId, task_id, event_type, newAt, enteredBy, note],
    );
    const newEventId = ins.insertId;

    await conn.query(
      `UPDATE fab_task_events SET superseded_by_event_id = ?
        WHERE id = ? AND company_id = ?`,
      [newEventId, oldEventId, companyId],
    );

    await conn.commit();
    return { oldEventId, newEventId };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}
