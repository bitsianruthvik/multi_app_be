/**
 * dispatchService.js — what should each machine work on next, and why.
 *
 * The ranking deliberately uses only inputs that are sound today. Three obvious
 * candidates are not used, each for a verified reason:
 *
 *   planned_start (fab_cc_chain_tasks) — self-erasing. levelSchedule re-lays the
 *     whole DAG forward from `new Date()` and no caller passes an anchor, so
 *     immediately after any baseline every task has planned_start >= now. A past
 *     date only means time has elapsed since the last baseline, and re-baselining
 *     is routine (it fires on materialize AND re-materialize). A task seven days
 *     late gets a fresh future date the moment someone edits the BOM.
 *
 *   buffer_consumed_pct — structurally blind to exactly what dispatch exists to
 *     catch. It is driven by COMPLETED touch time, so a task running 10x over
 *     estimate contributes zero until it finishes, and an idle shop reads 0%
 *     while the due date goes past.
 *
 *   fab_orders.priority — free text, user-visible, read by no backend code.
 *
 * What is used instead is order-level slack, the one formulation whose inputs
 * survive both re-baselining and re-materialization:
 *
 *   slack = workingMinutes(now -> required_date)
 *         - aggressive minutes of not-done critical-chain tasks
 *         - remaining project buffer
 *
 * required_date has no backend writer at all, and the chain figures come from
 * the baselined plan. Negative slack means genuinely behind — and it worsens on
 * its own every day work sits idle, because `now` advances while required_date
 * does not. No re-baseline can reset it.
 */

import { pool } from '../../../db.js';
import { logger } from '../../../core/utils/logger.js';
import { isOutputBlocked } from './taskGatingService.js';
import { workingMinutesInWindow, resolveTaskCalendarIds } from './taskWaitService.js';

/** Slack for an order we cannot compute one for. Sorts after every real value. */
const NO_SLACK = Number.POSITIVE_INFINITY;

/**
 * Order-level slack in working minutes, per order.
 *
 * Only orders with a baselined plan get a number. An order with no plan has no
 * critical chain and no buffer, so there is nothing to be behind ON — it ranks
 * last rather than pretending to a slack of zero, which would put it ahead of
 * genuinely comfortable projects.
 */
export async function computeOrderSlack(companyId, now = new Date()) {
  const [plans] = await pool.query(
    `SELECT p.id                     AS planId,
            p.order_id               AS orderId,
            p.project_buffer_minutes AS projBuf,
            o.required_date          AS requiredDate
       FROM fab_cc_plans p
       JOIN fab_orders o ON o.id = p.order_id AND o.company_id = p.company_id
                        AND o.deleted_at IS NULL
      WHERE p.company_id = ? AND p.status = 'baselined' AND p.deleted_at IS NULL`,
    [companyId],
  );
  if (plans.length === 0) return { slackByOrder: new Map(), criticalTaskIds: new Set() };

  // One plan per order — the newest wins, matching drumService.
  const planByOrder = new Map();
  for (const p of plans) {
    const cur = planByOrder.get(p.orderId);
    if (!cur || p.planId > cur.planId) planByOrder.set(p.orderId, p);
  }
  const planIds = [...planByOrder.values()].map((p) => p.planId);

  // Remaining critical work, and a representative task per plan to resolve the
  // calendar from — there is no order-level calendar, so the highest-seq
  // critical task's machine calendar stands in (same rule as ccBufferService).
  const [chain] = await pool.query(
    `SELECT c.plan_id            AS planId,
            c.task_id            AS taskId,
            c.seq                AS seq,
            c.chain_role         AS chainRole,
            c.aggressive_minutes AS aggressiveMinutes,
            t.status             AS status,
            t.started_at         AS startedAt,
            t.assigned_resource_id, t.item_id, t.flow_id, t.company_id
       FROM fab_cc_chain_tasks c
       JOIN fab_project_tasks t ON t.id = c.task_id AND t.deleted_at IS NULL
      WHERE c.company_id = ? AND c.plan_id IN (?) AND c.deleted_at IS NULL`,
    [companyId, planIds],
  );

  const remainingByPlan = new Map();
  const repByPlan = new Map();
  const criticalTaskIds = new Set();
  for (const c of chain) {
    if (c.chainRole !== 'critical') continue;
    criticalTaskIds.add(c.taskId);
    if (c.status !== 'done') {
      const aggressive = Number(c.aggressiveMinutes) || 0;

      // A task that is ALREADY running longer than its estimate is overrun that
      // has happened, not overrun that might. The stored buffer consumption
      // cannot see it — that figure is driven by completed touch time, so a task
      // running ten times over contributes nothing until the moment it finishes,
      // and a project can sit visibly stuck while its numbers read fine.
      //
      // Counted at rank time and never written back: fab_cc_buffers is
      // deliberately a record of execution variance on FINISHED work, and
      // persisting a projection into it would corrupt that meaning.
      let overrun = 0;
      if (c.status === 'in_progress' && c.startedAt) {
        const elapsed = (now.getTime() - new Date(c.startedAt).getTime()) / 60000;
        if (Number.isFinite(elapsed) && elapsed > aggressive) overrun = elapsed - aggressive;
      }

      remainingByPlan.set(c.planId, (remainingByPlan.get(c.planId) ?? 0) + aggressive + overrun);
    }
    const rep = repByPlan.get(c.planId);
    if (!rep || Number(c.seq) > Number(rep.seq)) repByPlan.set(c.planId, c);
  }

  // Buffer already consumed, so we subtract what is LEFT rather than the full
  // baselined size — consistent with how the fever chart reads the same buffer.
  const [buffers] = await pool.query(
    `SELECT plan_id AS planId, size_minutes AS sizeMinutes, consumed_minutes AS consumedMinutes
       FROM fab_cc_buffers
      WHERE company_id = ? AND plan_id IN (?) AND kind = 'project'
        AND deleted_at IS NULL`,
    [companyId, planIds],
  );
  const bufByPlan = new Map(buffers.map((b) => [b.planId, b]));

  const slackByOrder = new Map();
  for (const [orderId, plan] of planByOrder) {
    if (!plan.requiredDate) { slackByOrder.set(orderId, { slack: NO_SLACK, reason: 'no required date' }); continue; }

    // required_date is a DATE, i.e. midnight. Due "on the 12th" means by the end
    // of the 12th on a shop floor, so the window runs to the end of that day.
    const due = new Date(plan.requiredDate);
    due.setHours(23, 59, 59, 999);

    const rep = repByPlan.get(plan.planId);
    let calendarIds = [];
    try {
      if (rep) calendarIds = await resolveTaskCalendarIds(companyId, rep);
    } catch { /* fall through to wall clock */ }

    // workingMinutesInWindow walks forward and returns 0 for a reversed window,
    // so an overdue order would tie at zero with a just-in-time one. Measure the
    // overdue span in the correct direction and negate it.
    const overdue = due.getTime() < now.getTime();
    const [from, to] = overdue ? [due, now] : [now, due];
    let minutes;
    if (calendarIds.length > 0) {
      minutes = await workingMinutesInWindow(companyId, calendarIds, from, to);
    } else {
      // No calendar resolvable (no baselined critical task with a machine).
      // Wall-clock is a worse estimate but an honest one; it never silently
      // reports "plenty of time".
      minutes = (to.getTime() - from.getTime()) / 60000;
    }
    const available = overdue ? -minutes : minutes;

    const buf = bufByPlan.get(plan.planId);
    const remainingBuffer = buf
      ? Math.max(0, (Number(buf.sizeMinutes) || 0) - (Number(buf.consumedMinutes) || 0))
      : (Number(plan.projBuf) || 0);
    const remainingWork = remainingByPlan.get(plan.planId) ?? 0;

    slackByOrder.set(orderId, {
      slack: Math.round(available - remainingWork - remainingBuffer),
      reason: null,
    });
  }

  return { slackByOrder, criticalTaskIds };
}

/**
 * Rank the eligible work for every active machine.
 *
 * Returns [{ resourceId, resourceName, tasks: [{...task, rank, reason}] }].
 * Nothing is written; this is what the confirmation dialog shows.
 */
export async function computeDispatch(companyId, { limitPerMachine = 5, now = new Date() } = {}) {
  const { slackByOrder, criticalTaskIds } = await computeOrderSlack(companyId, now);

  const [machines] = await pool.query(
    `SELECT id, name, resource_type_id AS resourceTypeId, plant_id AS plantId, stock_location_id
       FROM fab_resources
      WHERE company_id = ? AND deleted_at IS NULL
      ORDER BY name ASC`,
    [companyId],
  );
  if (machines.length === 0) return { machines: [], skipped: { blocked: 0, claimed: 0 } };

  const [tasks] = await pool.query(
    `SELECT t.id, t.order_id AS orderId, t.item_id, t.flow_id, t.seq_no AS seqNo,
            t.status, t.queued_at AS queuedAt, t.resource_type_id AS resourceTypeId,
            t.assigned_resource_id AS assignedResourceId,
            op.name AS operationName, o.order_number AS orderNumber,
            o.priority_rank AS priorityRank, o.required_date AS requiredDate,
            it.name AS itemName
       FROM fab_project_tasks t
       LEFT JOIN fab_operations op ON op.id = t.operation_id
       LEFT JOIN fab_orders o      ON o.id = t.order_id
       LEFT JOIN fab_items it      ON it.id = t.item_id AND it.deleted_at IS NULL
      WHERE t.company_id = ? AND t.status = 'eligible' AND t.deleted_at IS NULL`,
    [companyId],
  );

  const slackOf = (orderId) => slackByOrder.get(orderId)?.slack ?? NO_SLACK;

  /**
   * Manual rank first, then how much trouble the order is in.
   *
   * priority_rank is a planner's explicit instruction and outranks the
   * computed signal — that is the point of having it. Orders without one fall
   * through to slack, so a partially-ranked shop still behaves sensibly.
   */
  const compare = (a, b) => {
    const ra = a.priorityRank ?? Number.POSITIVE_INFINITY;
    const rb = b.priorityRank ?? Number.POSITIVE_INFINITY;
    if (ra !== rb) return ra - rb;

    const sa = slackOf(a.orderId);
    const sb = slackOf(b.orderId);
    if (sa !== sb) return sa - sb;                       // least slack first

    const ca = criticalTaskIds.has(a.id) ? 0 : 1;
    const cb = criticalTaskIds.has(b.id) ? 0 : 1;
    if (ca !== cb) return ca - cb;                       // critical chain first

    if (a.seqNo !== b.seqNo) return (a.seqNo ?? 0) - (b.seqNo ?? 0);

    // Longest-waiting last resort. queued_at is nullable; a task with no queue
    // timestamp has no claim to have been waiting, so it goes behind.
    const qa = a.queuedAt ? new Date(a.queuedAt).getTime() : Number.POSITIVE_INFINITY;
    const qb = b.queuedAt ? new Date(b.queuedAt).getTime() : Number.POSITIVE_INFINITY;
    if (qa !== qb) return qa - qb;
    return a.id - b.id;
  };

  // Slack is computed in working minutes, but nobody reads "42122 min". Shown
  // in working days at 8h, which is the unit a shop floor actually plans in.
  const humanSlack = (minutes) => {
    const abs = Math.abs(minutes);
    if (abs < 60) return `${abs} min`;
    if (abs < 480) return `${(abs / 60).toFixed(1)} h`;
    return `${(abs / 480).toFixed(1)} days`;
  };

  const reasonFor = (t) => {
    const bits = [];
    if (t.priorityRank != null) bits.push(`priority #${t.priorityRank}`);
    const s = slackByOrder.get(t.orderId);
    if (s && s.slack !== NO_SLACK) {
      bits.push(s.slack < 0
        ? `${humanSlack(s.slack)} behind`
        : `${humanSlack(s.slack)} spare`);
    } else {
      bits.push('no baseline');
    }
    if (criticalTaskIds.has(t.id)) bits.push('critical chain');
    return bits.join(' · ');
  };

  // A task assigned to nobody is eligible on every machine of its type. Handing
  // it to all of them is the bug this whole feature is supposed to fix, so each
  // one is claimed by exactly one machine — the first to want it, in machine
  // name order, which keeps runs stable rather than arbitrary.
  const claimed = new Set();
  let blockedCount = 0;
  let claimedCount = 0;
  const out = [];

  for (const m of machines) {
    const candidates = tasks
      .filter((t) => t.assignedResourceId === m.id
        || (t.assignedResourceId == null && t.resourceTypeId === m.resourceTypeId))
      .sort(compare);

    const picked = [];
    for (const t of candidates) {
      if (picked.length >= limitPerMachine) break;
      if (t.assignedResourceId == null) {
        if (claimed.has(t.id)) { claimedCount += 1; continue; }
      }

      // isOutputBlocked returns not-blocked for an unassigned task, so the
      // candidate machine has to be injected or this filter does nothing for
      // exactly the tasks dispatch is deciding.
      let blocked = false;
      try {
        const r = await isOutputBlocked(companyId, { ...t, assigned_resource_id: m.id });
        blocked = !!r.blocked;
      } catch (err) {
        // A gating hiccup must not empty the board. Showing the task is the
        // safer failure: Start re-checks and refuses if it really is blocked.
        logger.warn({ err, taskId: t.id, resourceId: m.id }, 'dispatch: gating check failed');
      }
      if (blocked) { blockedCount += 1; continue; }

      if (t.assignedResourceId == null) claimed.add(t.id);
      const slackEntry = slackByOrder.get(t.orderId);
      picked.push({
        ...t,
        rank: picked.length + 1,
        reason: reasonFor(t),
        // Frozen alongside the rank so the persisted run can explain itself.
        orderSlackMinutes: slackEntry && slackEntry.slack !== NO_SLACK ? slackEntry.slack : null,
        isCriticalChain: criticalTaskIds.has(t.id),
      });
    }

    out.push({ resourceId: m.id, resourceName: m.name, tasks: picked });
  }

  return { machines: out, skipped: { blocked: blockedCount, claimed: claimedCount } };
}

/**
 * Persist a computed dispatch as a confirmed run.
 *
 * The component scores are copied in, not joined at read time: buffer levels and
 * task statuses move within minutes, so "why was this ranked first?" is only
 * answerable later if the answer is frozen now.
 */
export async function confirmDispatch(companyId, computed, userId) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const taskCount = computed.machines.reduce((n, m) => n + m.tasks.length, 0);
    // Machines that were actually given work, not every machine considered.
    // computed.machines includes idle ones so the UI can say "11 have nothing
    // eligible"; counting those here would report a run bigger than the rows it
    // wrote.
    const machineCount = computed.machines.filter((m) => m.tasks.length > 0).length;
    const [runRes] = await conn.query(
      `INSERT INTO fab_dispatch_runs
         (company_id, status, computed_at, confirmed_at, confirmed_by, machine_count, task_count)
       VALUES (?, 'confirmed', NOW(), NOW(), ?, ?, ?)`,
      [companyId, userId ?? null, machineCount, taskCount],
    );
    const runId = runRes.insertId;

    for (const m of computed.machines) {
      for (const t of m.tasks) {
        await conn.query(
          `INSERT INTO fab_dispatch_run_items
             (company_id, run_id, resource_id, task_id, order_id, rank_in_machine,
              order_slack_minutes, is_critical_chain, seq_no, queued_at, reason)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [companyId, runId, m.resourceId, t.id, t.orderId ?? null, t.rank,
           Number.isFinite(t.orderSlackMinutes) ? t.orderSlackMinutes : null,
           t.isCriticalChain ? 1 : 0, t.seqNo ?? null, t.queuedAt ?? null, t.reason ?? null],
        );
      }
    }

    await conn.commit();
    return { runId, taskCount, machineCount };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}
