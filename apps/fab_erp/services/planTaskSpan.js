/**
 * planTaskSpan.js — where one task sits inside its bar. ONE definition.
 *
 * A plan entry can be a bundle: several tasks batched onto one machine as one
 * setup. The bar records the span of the whole batch, and the individual task
 * times the leveller produced are not stored anywhere.
 *
 * That loss caused a real and quiet bug. `assertDagAllows` asked "when does the
 * predecessor finish" and answered with the predecessor's BAR — so a task that
 * was second of seven in a bundle appeared to finish when the seventh did, four
 * hours later than it does. Every successor of a bundled task therefore looked
 * illegally early, and any attempt to move one was refused with a violation the
 * plan did not actually have. Accepting a suggestion with bundling on was enough
 * to produce it, which is to say: almost every plan.
 *
 * The fix is to reconstruct the task's own span from what IS stored — each
 * member's `planned_minutes` and `sort_order`, laid end to end inside the bar in
 * proportion. For a bundle the suggestor built, this reproduces the leveller's
 * original task-level schedule exactly, because that is how the bar was formed.
 * For one a human split or dragged, it is the same reading the Plan Board draws,
 * so the picture and the rule agree.
 *
 * Used by planService (the DAG gate, and the board's blocks) and by
 * planGroupService (the group DAG check). It must stay one function: two
 * apportionments that disagree is the same bug again, wearing a different hat.
 */

import { pool } from '../../../db.js';

/**
 * Lay a bar's member tasks end to end inside its span, in proportion to their
 * minutes.
 *
 * @param {Date|string|number} entryStart
 * @param {Date|string|number} entryEnd
 * @param {Array<{taskId:number, plannedMinutes:number|string}>} members
 *        Already in the order they run — `sort_order`, which is how they were
 *        inserted. Order is NOT re-derived here; the caller owns it.
 * @returns {Map<number, {start:Date, end:Date}>}
 */
export function apportionEntry(entryStart, entryEnd, members) {
  const out = new Map();
  const list = members ?? [];
  if (list.length === 0) return out;

  const s = new Date(entryStart).getTime();
  const e = new Date(entryEnd).getTime();
  const span = Math.max(0, e - s);
  const total = list.reduce((n, m) => n + (Number(m.plannedMinutes) || 0), 0);

  let cursor = s;
  for (const m of list) {
    // An equal share when nothing declares minutes, rather than collapsing every
    // member onto the bar's start instant — which would make a whole bundle
    // look finishable the moment it began.
    const share = total > 0 ? (Number(m.plannedMinutes) || 0) / total : 1 / list.length;
    const dur = Math.round(span * share);
    out.set(Number(m.taskId), { start: new Date(cursor), end: new Date(cursor + dur) });
    cursor += dur;
  }
  // Rounding must not lose the bar's own end: the last member owns it, so a
  // successor placed exactly at the bar's end is never rejected by a stray ms.
  const last = out.get(Number(list[list.length - 1].taskId));
  if (last && span > 0) last.end = new Date(e);
  return out;
}

/**
 * Where the named tasks currently sit ON THE PLAN, each inside its own bar.
 *
 * Reads the WHOLE membership of every bar involved, not just the tasks asked
 * about — apportionment needs the siblings' minutes to know what share of the
 * bar each one takes. That is why this cannot be a `task_id IN (?)` query with
 * a MAX() over it, which is what it replaced.
 *
 * @param {number} companyId
 * @param {number[]} taskIds
 * @param {{excludeEntryId?: number|null}} [opts] Ignore one bar — the one being
 *        moved, so it does not constrain itself.
 * @returns {Promise<Map<number, {entryId:number, start:Date, end:Date}>>}
 */
export async function taskPlannedSpans(companyId, taskIds, { excludeEntryId = null } = {}) {
  const ids = [...new Set((taskIds ?? []).map(Number))].filter(Boolean);
  const out = new Map();
  if (ids.length === 0) return out;

  const params = [companyId];
  let excl = '';
  if (excludeEntryId != null) { excl = ' AND e.id <> ?'; params.push(excludeEntryId); }
  params.push(companyId, ids);

  const [rows] = await pool.query(
    `SELECT et.plan_entry_id AS entryId, et.task_id AS taskId,
            et.planned_minutes AS plannedMinutes,
            e.planned_start AS plannedStart, e.planned_end AS plannedEnd
       FROM fab_plan_entry_tasks et
       JOIN fab_plan_entries e ON e.id = et.plan_entry_id AND e.company_id = et.company_id
      WHERE et.company_id = ? AND et.deleted_at IS NULL
        AND e.status = 'planned' AND e.deleted_at IS NULL${excl}
        AND et.plan_entry_id IN (
          SELECT plan_entry_id FROM fab_plan_entry_tasks
           WHERE company_id = ? AND task_id IN (?) AND deleted_at IS NULL
        )
      ORDER BY et.plan_entry_id ASC, et.sort_order ASC, et.id ASC`,
    params,
  );

  const byEntry = new Map();
  for (const r of rows) {
    if (!byEntry.has(r.entryId)) {
      byEntry.set(r.entryId, { start: r.plannedStart, end: r.plannedEnd, members: [] });
    }
    byEntry.get(r.entryId).members.push({ taskId: r.taskId, plannedMinutes: r.plannedMinutes });
  }

  const wanted = new Set(ids);
  for (const [entryId, bar] of byEntry) {
    const spans = apportionEntry(bar.start, bar.end, bar.members);
    for (const [taskId, span] of spans) {
      if (!wanted.has(taskId)) continue;
      // A task should sit on at most one live bar (assertNotAlreadyPlanned), but
      // if the data ever says otherwise, the later finish is the safe answer.
      const cur = out.get(taskId);
      if (cur && cur.end >= span.end) continue;
      out.set(taskId, { entryId, start: span.start, end: span.end });
    }
  }
  return out;
}
