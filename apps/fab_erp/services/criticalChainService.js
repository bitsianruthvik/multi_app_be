// criticalChainService.js — EU-3: turn a leveled schedule into a critical chain,
// size the CCPM time buffers (50% cut-and-paste), and persist a frozen baseline.
//
// This builds directly on EU-2's resourceLevelingService (leveling + edge-building
// are REUSED, never reimplemented here) and EU-1's fab_cc_* tables. The one piece of
// genuine algorithm this module owns is the CRITICAL CHAIN derivation: unlike a
// critical path, the chain must account for resource contention. Two tasks with no
// precedence edge that share a single-unit machine are still sequenced by that
// machine; if task B could only start because task A freed the shared resource, the
// A→B link is part of the chain. We recover those links from the leveled schedule
// via a binding-predecessor backward walk (see buildCriticalChain below).
//
// Calendar math (for committed_finish) is NOT reinvented: it reuses taskWaitService's
// workingIntervalsInWindow the same chunked way resourceLevelingService.computeSpan
// does, since neither service exports an "advance a datetime by N working-minutes"
// helper.

import { pool } from '../../../db.js';
import {
  buildEdges,
  levelSchedule,
  loadResourceCapacity,
} from './resourceLevelingService.js';
import {
  resolveTaskCalendarIds,
  workingIntervalsInWindow,
} from './taskWaitService.js';

// ─── helpers ──────────────────────────────────────────────────────────────────

// Store instants as UTC 'YYYY-MM-DD HH:MM:SS' strings (mirrors mrpService's
// toDateTimeStr). The schedule/calendar math is all UTC-based, so the UTC wall-clock
// string round-trips into DATETIME without a timezone shift.
function toDateTimeStr(d) {
  return d == null ? null : (d instanceof Date ? d : new Date(d)).toISOString().slice(0, 19).replace('T', ' ');
}

const CHUNK_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_SCAN_MS = 366 * 24 * 60 * 60 * 1000;

/**
 * Aggressive (50%) minutes snapshot for a task: computed_hours × 60, rounded.
 * Tasks with no/zero computed_hours contribute 0.
 */
function aggressiveMinutes(task) {
  const h = Number(task.computed_hours);
  return h > 0 ? Math.round(h * 60) : 0;
}

/**
 * The contention scope + capacity for a task — identical classification to
 * resourceLevelingService.resourceContext (which is not exported): a pinned resource
 * contends on its own unit (default cap 1), an unpinned task on a type that declares
 * num_units contends on that type pool, everything else is unconstrained. Only a
 * finite-capacity key can create a resource-sequencing link between two tasks.
 */
function resourceKeyFor(task, cap) {
  const rid = task.assigned_resource_id;
  if (rid != null) {
    const c = cap.resourceUnits.get(Number(rid));
    return { key: `r:${rid}`, capacity: c != null && c > 0 ? c : 1 };
  }
  const tid = task.resource_type_id;
  if (tid != null) {
    const c = cap.typeUnits.get(Number(tid));
    if (c != null && c > 0) return { key: `t:${tid}`, capacity: c };
  }
  return { key: null, capacity: Infinity };
}

/**
 * Advance `from` forward by `minutes` WORKING minutes across the given calendars,
 * returning the resulting instant. Mirrors resourceLevelingService.computeSpan's
 * chunked consumption of workingIntervalsInWindow. With no calendars (or non-positive
 * minutes) it degrades to a wall-clock add — the same optimistic 24/7 fallback EU-2
 * uses when no shift calendar resolves.
 */
async function advanceWorkingMinutes(companyId, calendarIds, from, minutes) {
  if (calendarIds.length === 0 || !(minutes > 0)) {
    return new Date(from.getTime() + Math.max(0, minutes) * 60000);
  }
  let remaining = minutes;
  let windowStart = new Date(from.getTime());
  let scanned = 0;
  while (remaining > 1e-9) {
    if (scanned > MAX_SCAN_MS) {
      throw new Error(
        `criticalChainService: could not advance ${minutes} working minutes within ${MAX_SCAN_MS / 86400000} days after ${from.toISOString()} for calendars [${calendarIds.join(', ')}]`,
      );
    }
    const windowEnd = new Date(windowStart.getTime() + CHUNK_MS);
    const ivs = await workingIntervalsInWindow(companyId, calendarIds, windowStart, windowEnd);
    for (const iv of ivs) {
      const lenMin = (iv.end.getTime() - iv.start.getTime()) / 60000;
      if (remaining <= lenMin + 1e-9) {
        return new Date(iv.start.getTime() + remaining * 60000);
      }
      remaining -= lenMin;
    }
    windowStart = windowEnd;
    scanned += CHUNK_MS;
  }
  return new Date(windowStart.getTime());
}

// ─── critical chain (binding-predecessor backward walk) ────────────────────────

/**
 * Derive the critical chain from a resource-feasible leveled schedule.
 *
 * The chain's tail is the makespan task (latest end). Walking backward, a task T's
 * BINDING predecessor is the constraint that actually determined T.start — the one
 * whose end lands exactly on T.start. Candidates come from two sources:
 *   (a) precedence predecessors of T (from the edge graph), and
 *   (b) resource-sequencing peers: tasks that ran on the SAME finite-capacity
 *       resource as T and freed it exactly at T.start (end == T.start). This is
 *       what makes it a critical CHAIN, not a critical PATH — a machine handoff with
 *       no precedence edge is still a binding link.
 * Tie-break (deterministic): prefer a precedence edge over a pure resource link,
 * then lower seq_no, then lower id. The walk stops when no candidate ends at T.start
 * (T is a chain head, its start pinned to the anchor). Returned tail→head, then
 * reversed to head→tail order.
 *
 * @returns {number[]} critical task ids in chain order (seq 0..n)
 */
function buildCriticalChain({ tasks, sched, predsOf, cap }) {
  const taskById = new Map(tasks.map((t) => [t.id, t]));

  // Group finite-capacity tasks by resource key for resource-peer lookup.
  const byResourceKey = new Map(); // key -> [taskId]
  for (const t of tasks) {
    const { key, capacity } = resourceKeyFor(t, cap);
    if (key !== null && capacity < Infinity) {
      if (!byResourceKey.has(key)) byResourceKey.set(key, []);
      byResourceKey.get(key).push(t.id);
    }
  }
  const resKeyOf = new Map(tasks.map((t) => {
    const { key, capacity } = resourceKeyFor(t, cap);
    return [t.id, key !== null && capacity < Infinity ? key : null];
  }));

  // Tail = latest end (tie-break: latest start, then higher id) — deterministic.
  let tail = null;
  for (const t of tasks) {
    const s = sched.get(t.id);
    if (!s) continue;
    if (
      tail === null ||
      s.end.getTime() > tail.end.getTime() ||
      (s.end.getTime() === tail.end.getTime() && s.start.getTime() > tail.start.getTime()) ||
      (s.end.getTime() === tail.end.getTime() && s.start.getTime() === tail.start.getTime() && t.id > tail.id)
    ) {
      tail = { id: t.id, start: s.start, end: s.end };
    }
  }
  if (tail === null) return [];

  const bindingPredecessorOf = (id) => {
    const tStart = sched.get(id).start.getTime();
    // A predecessor is BINDING if it ends at (or, across a shift-calendar gap,
    // just before) T's start. We collect every predecessor ending ≤ T.start and
    // pick the one ending LATEST — the tightest constraint — rather than requiring
    // an exact end===start match (which would silently break the chain wherever a
    // non-working gap sits between a predecessor's end and the successor's start).
    const candidates = [];
    // (a) precedence predecessors
    for (const pid of predsOf.get(id) || []) {
      const p = sched.get(pid);
      if (p && p.end.getTime() <= tStart) candidates.push({ id: pid, precedence: true, end: p.end.getTime() });
    }
    // (b) resource-sequencing peers that freed the shared resource before T started
    const key = resKeyOf.get(id);
    if (key !== null) {
      const precedenceIds = new Set(candidates.map((c) => c.id));
      for (const pid of byResourceKey.get(key) || []) {
        if (pid === id || precedenceIds.has(pid)) continue;
        const p = sched.get(pid);
        if (p && p.end.getTime() <= tStart) candidates.push({ id: pid, precedence: false, end: p.end.getTime() });
      }
    }
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => {
      if (b.end !== a.end) return b.end - a.end; // latest-ending (tightest) first
      if (a.precedence !== b.precedence) return a.precedence ? -1 : 1; // then precedence over resource link
      const ta = taskById.get(a.id);
      const tb = taskById.get(b.id);
      return (Number(ta.seq_no) || 0) - (Number(tb.seq_no) || 0) || a.id - b.id;
    });
    return candidates[0].id;
  };

  const reversed = [];
  const visited = new Set();
  let cur = tail.id;
  while (cur != null && !visited.has(cur)) {
    visited.add(cur);
    reversed.push(cur);
    cur = bindingPredecessorOf(cur);
  }
  return reversed.reverse();
}

// ─── main entry ────────────────────────────────────────────────────────────────

/**
 * Build and persist a frozen CCPM baseline for an order.
 *
 * @param {object} args
 * @param {number} args.companyId
 * @param {number} args.orderId
 * @param {Date}   [args.anchor]  earliest allowed start / baseline timestamp (default now).
 * @returns {Promise<object>} the created plan (id + summary), or a no-op result.
 */
export async function buildBaseline({ companyId, orderId, anchor } = {}) {
  const anchorDate = anchor instanceof Date ? anchor : new Date();

  // 1. Load the order's live tasks. NOTE: fab_project_tasks' order column is
  //    `order_id` (project_id was repointed/renamed to order_id in the fab_projects
  //    → fab_orders collapse); the /tasks/graph route filters on order_id too.
  const [tasks] = await pool.query(
    `SELECT id, order_id, item_id, flow_id, seq_no, depends_on,
            resource_type_id, assigned_resource_id, computed_hours, status
       FROM fab_project_tasks
      WHERE company_id = ? AND order_id = ? AND status <> 'cancelled' AND deleted_at IS NULL`,
    [companyId, orderId],
  );

  if (tasks.length === 0) {
    return { ok: true, created: false, reason: 'no_tasks', companyId, orderId };
  }

  // 2. Level (REUSES EU-2): edges + resource-feasible schedule.
  const edges = await buildEdges({ companyId, tasks });
  const cap = await loadResourceCapacity(companyId);
  const sched = await levelSchedule({ companyId, tasks, edges, resourceCapacity: cap, anchor: anchorDate });

  // Precedence predecessor map (deduped, restricted to in-set edges).
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  const predsOf = new Map(tasks.map((t) => [t.id, []]));
  const succOf = new Map(tasks.map((t) => [t.id, []]));
  const seenEdge = new Set();
  for (const e of edges) {
    if (!taskById.has(e.from) || !taskById.has(e.to) || e.from === e.to) continue;
    const k = `${e.from}->${e.to}`;
    if (seenEdge.has(k)) continue;
    seenEdge.add(k);
    predsOf.get(e.to).push(e.from);
    succOf.get(e.from).push(e.to);
  }

  const aggById = new Map(tasks.map((t) => [t.id, aggressiveMinutes(t)]));

  // 3. Critical chain.
  const criticalIds = buildCriticalChain({ tasks, sched, predsOf, cap });
  const criticalSet = new Set(criticalIds);
  const criticalSeqOf = new Map(criticalIds.map((id, i) => [id, i]));

  // 4. Feeding paths: every non-critical task merges into a critical task. Its merge
  //    target is the EARLIEST-seq critical task reachable going forward along the
  //    precedence graph (the point where the feeding path joins the chain). Memoized
  //    over the DAG; deterministic tie-breaks. Any task with no forward path to the
  //    chain falls back to the tail (last critical) so it is still grouped.
  const tailCriticalId = criticalIds.length > 0 ? criticalIds[criticalIds.length - 1] : null;
  const mergeMemo = new Map();
  const cmpTask = (a, b) => {
    const ta = taskById.get(a);
    const tb = taskById.get(b);
    return (Number(ta.seq_no) || 0) - (Number(tb.seq_no) || 0) || a - b;
  };
  const firstCriticalForward = (id, stack) => {
    if (mergeMemo.has(id)) return mergeMemo.get(id);
    if (criticalSet.has(id)) { mergeMemo.set(id, id); return id; }
    if (stack.has(id)) return null; // cycle guard (levelSchedule already rejects cycles)
    stack.add(id);
    let best = null; // {seq, id}
    for (const s of [...(succOf.get(id) || [])].sort(cmpTask)) {
      const r = firstCriticalForward(s, stack);
      if (r == null) continue;
      const seq = criticalSeqOf.get(r);
      if (best === null || seq < best.seq || (seq === best.seq && r < best.id)) best = { seq, id: r };
    }
    stack.delete(id);
    const result = best ? best.id : null;
    mergeMemo.set(id, result);
    return result;
  };

  const feedingByGroup = new Map(); // criticalTaskId -> [taskId]
  for (const t of tasks) {
    if (criticalSet.has(t.id)) continue;
    let group = firstCriticalForward(t.id, new Set());
    if (group == null) group = tailCriticalId; // orphan fallback
    if (group == null) continue; // no critical chain at all (shouldn't happen with tasks)
    if (!feedingByGroup.has(group)) feedingByGroup.set(group, []);
    feedingByGroup.get(group).push(t.id);
  }

  // 5. Buffers (50% cut-and-paste).
  const chainLengthMinutes = criticalIds.reduce((sum, id) => sum + (aggById.get(id) || 0), 0);
  const projectBufferMinutes = Math.round(0.5 * chainLengthMinutes);

  const feedingBuffers = [];
  for (const [groupCriticalId, taskIds] of feedingByGroup) {
    const groupSum = taskIds.reduce((sum, id) => sum + (aggById.get(id) || 0), 0);
    // Feeding path's last task = the group's latest-ending task (the one merging in).
    let last = null;
    for (const id of taskIds) {
      const s = sched.get(id);
      if (!s) continue;
      if (last === null || s.end.getTime() > last.end.getTime() || (s.end.getTime() === last.end.getTime() && id > last.id)) {
        last = { id, end: s.end };
      }
    }
    feedingBuffers.push({
      feeds_task_id: groupCriticalId,
      after_task_id: last ? last.id : null,
      size_minutes: Math.round(0.5 * groupSum),
    });
  }

  // 6. Plan fields.
  const tailSched = tailCriticalId != null ? sched.get(tailCriticalId) : null;
  const aggressiveFinish = tailSched ? tailSched.end : null;

  // committed_finish = aggressive_finish advanced FORWARD by project_buffer_minutes
  // working-minutes on the order's (tail task's) calendar. Empty calendar ⇒ wall-clock.
  let committedFinish = null;
  let calendarFallback = false;
  if (aggressiveFinish) {
    const tailTask = taskById.get(tailCriticalId);
    const calendarIds = await resolveTaskCalendarIds(companyId, tailTask);
    calendarFallback = calendarIds.length === 0;
    committedFinish = await advanceWorkingMinutes(companyId, calendarIds, aggressiveFinish, projectBufferMinutes);
  }

  // Snapshot the order's due date into the plan. The live fab_orders table (the
  // MRP-owned order table, not the dropped fab_projects) carries the due date as
  // `required_date`.
  const [[orderRow]] = await pool.query(
    `SELECT required_date FROM fab_orders WHERE id = ? AND company_id = ? AND deleted_at IS NULL LIMIT 1`,
    [orderId, companyId],
  );
  const dueDate = orderRow ? orderRow.required_date ?? null : null;

  // 7. Persist in a transaction.
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [planRes] = await conn.query(
      `INSERT INTO fab_cc_plans
         (company_id, order_id, status, due_date, chain_length_minutes,
          project_buffer_minutes, aggressive_finish, committed_finish, baselined_at)
       VALUES (?, ?, 'baselined', ?, ?, ?, ?, ?, ?)`,
      [
        companyId, orderId, dueDate, chainLengthMinutes, projectBufferMinutes,
        toDateTimeStr(aggressiveFinish), toDateTimeStr(committedFinish), toDateTimeStr(anchorDate),
      ],
    );
    const planId = planRes.insertId;

    // Supersede any prior baselined plan for this order, pointing it at the new one.
    const [supRes] = await conn.query(
      `UPDATE fab_cc_plans
          SET status = 'superseded', superseded_by_plan_id = ?
        WHERE company_id = ? AND order_id = ? AND status = 'baselined'
          AND id <> ? AND deleted_at IS NULL`,
      [planId, companyId, orderId, planId],
    );

    // chain_tasks / buffers are rebuildable caches — delete-then-insert per plan so
    // re-baselining is clean (no prior rows exist for a brand-new plan id).
    await conn.query(`DELETE FROM fab_cc_chain_tasks WHERE company_id = ? AND plan_id = ?`, [companyId, planId]);
    await conn.query(`DELETE FROM fab_cc_buffers WHERE company_id = ? AND plan_id = ?`, [companyId, planId]);

    // One chain-task row per task (critical + feeding), with planned start/end.
    const chainRows = [];
    for (const t of tasks) {
      const s = sched.get(t.id);
      const isCritical = criticalSet.has(t.id);
      chainRows.push([
        companyId, planId, t.id,
        isCritical ? criticalSeqOf.get(t.id) : 0,
        isCritical ? 'critical' : 'feeding',
        isCritical ? null : (mergeMemo.get(t.id) ?? tailCriticalId),
        aggById.get(t.id) || 0,
        toDateTimeStr(s ? s.start : null),
        toDateTimeStr(s ? s.end : null),
      ]);
    }
    if (chainRows.length > 0) {
      await conn.query(
        `INSERT INTO fab_cc_chain_tasks
           (company_id, plan_id, task_id, seq, chain_role, feeding_group_id,
            aggressive_minutes, planned_start, planned_end)
         VALUES ?`,
        [chainRows],
      );
    }

    // Buffers: one project buffer + one per feeding group.
    const bufferRows = [];
    bufferRows.push([companyId, planId, 'project', projectBufferMinutes, null, tailCriticalId]);
    for (const fb of feedingBuffers) {
      bufferRows.push([companyId, planId, 'feeding', fb.size_minutes, fb.feeds_task_id, fb.after_task_id]);
    }
    await conn.query(
      `INSERT INTO fab_cc_buffers
         (company_id, plan_id, kind, size_minutes, feeds_task_id, after_task_id)
       VALUES ?`,
      [bufferRows],
    );

    await conn.commit();

    return {
      ok: true,
      created: true,
      planId,
      companyId,
      orderId,
      status: 'baselined',
      dueDate,
      chainLengthMinutes,
      projectBufferMinutes,
      aggressiveFinish: toDateTimeStr(aggressiveFinish),
      committedFinish: toDateTimeStr(committedFinish),
      calendarFallback,
      criticalTaskCount: criticalIds.length,
      criticalTaskIds: criticalIds,
      feedingTaskCount: tasks.length - criticalIds.length,
      feedingGroupCount: feedingByGroup.size,
      feedingBufferCount: feedingBuffers.length,
      supersededCount: supRes.affectedRows || 0,
    };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}
