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
 * SO THE LEVELLER'S ANSWER IS NOW KEPT, and inference is only the fallback.
 * `fab_plan_entry_tasks.planned_start/_end` hold each member's own span, copied
 * from the frozen run when a suggestion is accepted and carried through every
 * move, stretch and split. When they are there, they are used.
 *
 * The fallback — laying the members end to end inside the bar in proportion to
 * their minutes — still runs for bars written before those columns existed and
 * for bars a human built by hand, which never had a per-task levelling to keep.
 * It is an APPROXIMATION and this is why it had to stop being the primary path:
 * it is exact only when the bundled tasks happened to run back to back, and of
 * 602 bundles in one real order 136 span MORE wall-clock than their members'
 * minutes (the leveller left gaps) while others span LESS (a two-machine lane
 * ran them in parallel). Either way a member's inferred end drifts off its real
 * one, a successor planned at the true end reads as starting early, and a move
 * is refused for an ordering problem the plan does not have — which is exactly
 * what happened to every girder in the production plan.
 *
 * Used by planService (the DAG gate, and the board's blocks) and by
 * planGroupService (the group DAG check). It must stay one function: two
 * apportionments that disagree is the same bug again, wearing a different hat.
 */

import { pool } from '../../../db.js';

/**
 * Tolerance when checking stored times against their bar, in ms.
 *
 * A stored span should sit inside the bar it belongs to. A second of slack
 * absorbs the DATETIME second-rounding on the way in and out; anything past
 * that means the bar moved without its members and the stored times are stale.
 */
const CONTAINMENT_TOLERANCE_MS = 1000;

/**
 * Do these members carry their own levelled times, and do those times still
 * describe this bar?
 *
 * The second half is a safety net, not paranoia: every path that moves a bar is
 * supposed to remap its members, and if one is ever missed the stored times
 * would quietly describe where the bar USED to be. Falling back to inference
 * then degrades to the old approximation instead of asserting a lie.
 */
function storedSpans(entryStart, entryEnd, list) {
  const lo = new Date(entryStart).getTime() - CONTAINMENT_TOLERANCE_MS;
  const hi = new Date(entryEnd).getTime() + CONTAINMENT_TOLERANCE_MS;
  const out = new Map();
  for (const m of list) {
    const ms = m.plannedStart ?? m.planned_start;
    const me = m.plannedEnd ?? m.planned_end;
    if (ms == null || me == null) return null;
    const a = new Date(ms).getTime();
    const b = new Date(me).getTime();
    if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return null;
    if (a < lo || b > hi) return null;
    out.set(Number(m.taskId), { start: new Date(a), end: new Date(b) });
  }
  return out;
}

/**
 * Where each of a bar's member tasks runs.
 *
 * Their own levelled times when the bar has them; otherwise laid end to end
 * inside the bar in proportion to their minutes. See the file header for why
 * the second is a fallback and not the rule.
 *
 * @param {Date|string|number} entryStart
 * @param {Date|string|number} entryEnd
 * @param {Array<{taskId:number, plannedMinutes:number|string,
 *                plannedStart?:any, plannedEnd?:any}>} members
 *        Already in the order they run — `sort_order`, which is how they were
 *        inserted. Order is NOT re-derived here; the caller owns it.
 * @returns {Map<number, {start:Date, end:Date}>}
 */
export function apportionEntry(entryStart, entryEnd, members) {
  const out = new Map();
  const list = members ?? [];
  if (list.length === 0) return out;

  const stored = storedSpans(entryStart, entryEnd, list);
  if (stored) return stored;

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
            et.planned_start AS taskStart, et.planned_end AS taskEnd,
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
    byEntry.get(r.entryId).members.push({
      taskId: r.taskId,
      plannedMinutes: r.plannedMinutes,
      plannedStart: r.taskStart,
      plannedEnd: r.taskEnd,
    });
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

/**
 * A bar's span may differ from its old one by this much and still count as the
 * same shape — rounding, not a reshaping.
 */
const SAME_SHAPE_MS = 1000;

/**
 * Carry a bar's members with it when the bar moves.
 *
 * A PURE SHIFT carries them exactly: same duration, so every member keeps its
 * offset and the layout is preserved to the millisecond.
 *
 * A CHANGE OF SPAN DOES NOT. It is tempting to scale the members proportionally,
 * and that is what this did until it produced a plan that could not be undone.
 * A bar's wall-clock span is not a property of its work — it is where the work
 * fell relative to the shift calendar. Re-place a bar and it may cross a night
 * it did not cross before: the same 24 minutes of welding that spanned 24
 * minutes inside one shift spans FIFTEEN HOURS across two. Scaling the members
 * into that squashes a real layout into a proportional one, and scaling back out
 * cannot recover it — the leveller's layout was never proportional. On the
 * production plan that round trip left a predecessor five seconds past its
 * successor and the undo was refused.
 *
 * So when the shape changes the stored layout is DISCARDED, and reading falls
 * back to apportioning inside the new span. That is a real loss of precision,
 * and it is the honest one: the information genuinely stopped applying the
 * moment the bar changed shape. It is also self-consistent, which scaling was
 * not — two bars that end up the same shape now describe their members the same
 * way however they got there.
 *
 * Every path that writes `fab_plan_entries.planned_start/_end` must call this
 * in the same transaction. Missing one does not corrupt anything (the
 * containment check in storedSpans catches stale times and falls back), but it
 * does silently lose the precision this whole change exists to keep.
 *
 * @param {object} conn  the transaction's connection, not the pool
 */
export async function remapMemberTimes(conn, companyId, entryId, oldStart, oldEnd, newStart, newEnd) {
  const os = new Date(oldStart).getTime();
  const oe = new Date(oldEnd).getTime();
  const ns = new Date(newStart).getTime();
  const ne = new Date(newEnd).getTime();
  if (![os, oe, ns, ne].every(Number.isFinite)) return;

  const oldSpan = oe - os;
  const newSpan = ne - ns;
  const reshaped = Math.abs(newSpan - oldSpan) > SAME_SHAPE_MS;
  if (os === ns && !reshaped) return;

  if (reshaped) {
    // The layout stopped describing this bar. Say so, rather than inventing a
    // proportional one that cannot be undone.
    await conn.query(
      `UPDATE fab_plan_entry_tasks SET planned_start = NULL, planned_end = NULL
        WHERE company_id = ? AND plan_entry_id = ? AND deleted_at IS NULL`,
      [companyId, entryId],
    );
    return;
  }

  const shift = ns - os;
  const [rows] = await conn.query(
    `SELECT id, planned_start AS s, planned_end AS e
       FROM fab_plan_entry_tasks
      WHERE company_id = ? AND plan_entry_id = ? AND deleted_at IS NULL
        AND planned_start IS NOT NULL AND planned_end IS NOT NULL`,
    [companyId, entryId],
  );
  for (const r of rows) {
    const move = (t) => new Date(new Date(t).getTime() + shift);
    await conn.query(
      `UPDATE fab_plan_entry_tasks SET planned_start = ?, planned_end = ?
        WHERE company_id = ? AND id = ?`,
      [toDateTime(move(r.s)), toDateTime(move(r.e)), companyId, r.id],
    );
  }
}

/** MySQL DATETIME, UTC. */
function toDateTime(d) {
  return new Date(d).toISOString().slice(0, 19).replace('T', ' ');
}
