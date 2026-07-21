/**
 * taskEventService.js
 * --------------------
 * EU-2: Dual-write lifecycle events into fab_task_events alongside the
 * existing fab_project_tasks timestamp columns. Event logging must never
 * break the caller's main write — all failures are caught and logged.
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
}) {
  try {
    await pool.query(
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
export async function recordEvents(events) {
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
    await pool.query(
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
