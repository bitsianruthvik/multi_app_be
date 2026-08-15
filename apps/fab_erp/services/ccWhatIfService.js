// ccWhatIfService.js — EU-12: the "Google-Maps detour" engine.
//
// When an operator is about to START a task on a resource, whatIf() answers:
// does picking THIS task instead of the resource's most-urgent critical task
// push any project's promised finish out? Occupying a machine with a task for
// its duration delays whatever critical-chain task was waiting on that same
// machine — and delaying a critical task eats that project's project buffer
// (execution variance on the critical chain), so the fever zone can worsen too.
//
// This is intentionally a cheap, local estimate (not a full re-level): the
// delay imposed on each competing critical project ≈ the chosen task's own
// duration. Reuses EU-5's CC_FEVER thresholds so the projected zone matches the
// board, and mirrors the shift-calendar fallbacks used across the CC services.

import { pool } from '../../../db.js';
import { CC_FEVER } from './ccBufferService.js';
import { taskMinutes } from './taskDuration.js';

// Working minutes per day used to translate a delay into whole "slip days" for
// the warning. One shift; deliberately coarse — this is a preview, not a plan.
const WORKING_MIN_PER_DAY = 480;

function durationMinutes(computedHours) {
  const h = Number(computedHours);
  return h > 0 ? Math.round(h * 60) : 0;
}

function slipDays(delayMin) {
  if (!(delayMin > 0)) return 0;
  return Math.ceil(delayMin / WORKING_MIN_PER_DAY);
}

function addDays(dateish, days) {
  if (dateish == null) return null;
  const d = new Date(dateish);
  if (Number.isNaN(d.getTime())) return null;
  return new Date(d.getTime() + days * 86400000);
}

function toDateTimeStr(d) {
  return d == null ? null : (d instanceof Date ? d : new Date(d)).toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * @param {object} args
 * @param {number} args.companyId
 * @param {number} args.taskId      the task the operator wants to start
 * @param {number} [args.resourceId] the machine they'd run it on (optional; falls
 *                                    back to the task's own resource assignment)
 * @returns {Promise<object>} { ok, taskId, resourceId, isCritical, delayMinutes,
 *   impacts:[{orderId, orderNumber, oldFinish, newFinish, deltaDays, oldZone, newZone}],
 *   recommended:{taskId, orderNumber, label} | null }
 */
export async function whatIf({ companyId, taskId, resourceId } = {}) {
  const [[task]] = await pool.query(
    `SELECT id, order_id, resource_type_id, assigned_resource_id, computed_hours, task_qty, status, operation_id
       FROM fab_project_tasks
      WHERE id = ? AND company_id = ? AND deleted_at IS NULL`,
    [taskId, companyId],
  );
  if (!task) return { ok: false, reason: 'task_not_found', taskId };
  // Can't "detour" something already running/finished.
  if (['in_progress', 'done', 'cancelled'].includes(task.status)) {
    return { ok: true, taskId, resourceId: resourceId ?? task.assigned_resource_id ?? null, isCritical: false, delayMinutes: 0, impacts: [], recommended: null };
  }

  // resourceId → type map (to compare effective resource classes).
  const [resRows] = await pool.query(
    `SELECT id, resource_type_id FROM fab_resources WHERE company_id = ? AND deleted_at IS NULL`,
    [companyId],
  );
  const resType = new Map(resRows.map((r) => [Number(r.id), r.resource_type_id == null ? null : Number(r.resource_type_id)]));

  const effTypeOf = (rtId, arId) => {
    if (rtId != null) return Number(rtId);
    if (arId != null && resType.has(Number(arId))) return resType.get(Number(arId));
    return null;
  };

  // The effective resource class the operator would occupy. Prefer the explicit
  // resourceId's type, else the task's own effective type.
  const pinnedType = resourceId != null ? resType.get(Number(resourceId)) : null;
  const taskEffType = pinnedType != null ? pinnedType : effTypeOf(task.resource_type_id, task.assigned_resource_id);

  // The whole task, not one piece of it — starting a 20-piece job detours the
  // machine for all 20.
  const delayMinutes = taskMinutes(task);

  // Is the chosen task itself on a critical chain?
  const [[selfCrit]] = await pool.query(
    `SELECT 1 AS yes
       FROM fab_cc_chain_tasks ct
       JOIN fab_cc_plans p ON p.id = ct.plan_id AND p.status = 'baselined' AND p.deleted_at IS NULL
      WHERE ct.company_id = ? AND ct.task_id = ? AND ct.chain_role = 'critical' AND ct.deleted_at IS NULL
      LIMIT 1`,
    [companyId, taskId],
  );
  const isCritical = !!selfCrit;

  // Not-started critical tasks (of baselined sales plans) competing for a resource.
  const [critRows] = await pool.query(
    `SELECT ct.task_id, pt.order_id, pt.resource_type_id, pt.assigned_resource_id,
            pt.computed_hours, pt.task_qty, pt.operation_id, pt.status,
            p.buffer_consumed_pct AS bufConsumedPct, p.chain_complete_pct AS chainPct,
            p.project_buffer_minutes AS projBufMin, p.committed_finish AS committedFinish,
            p.fever_zone AS feverZone,
            o.order_number AS orderNumber,
            op.name AS operationName
       FROM fab_cc_chain_tasks ct
       JOIN fab_cc_plans p ON p.id = ct.plan_id AND p.status = 'baselined' AND p.deleted_at IS NULL
       JOIN fab_project_tasks pt ON pt.id = ct.task_id AND pt.company_id = ct.company_id AND pt.deleted_at IS NULL
       JOIN fab_orders o ON o.id = pt.order_id AND o.company_id = pt.company_id AND o.deleted_at IS NULL
       LEFT JOIN fab_operations op ON op.id = pt.operation_id AND op.company_id = ct.company_id AND op.deleted_at IS NULL
      WHERE ct.company_id = ? AND ct.chain_role = 'critical' AND ct.deleted_at IS NULL
        AND pt.status IN ('blocked', 'eligible')`,
    [companyId],
  );

  // Keep only the critical tasks that would compete for the SAME resource class,
  // excluding the chosen task itself. Dedupe to one (most-urgent) per project.
  const competingByOrder = new Map();
  for (const r of critRows) {
    if (Number(r.task_id) === Number(taskId)) continue;
    const et = effTypeOf(r.resource_type_id, r.assigned_resource_id);
    if (et == null || taskEffType == null || et !== taskEffType) continue;
    const prev = competingByOrder.get(r.order_id);
    // Most-penetrated project wins; tie-break earlier committed_finish.
    if (!prev
      || Number(r.bufConsumedPct || 0) > Number(prev.bufConsumedPct || 0)
      || (Number(r.bufConsumedPct || 0) === Number(prev.bufConsumedPct || 0)
          && new Date(r.committedFinish || 0).getTime() < new Date(prev.committedFinish || 0).getTime())) {
      competingByOrder.set(r.order_id, r);
    }
  }

  const competing = [...competingByOrder.values()];
  const days = slipDays(delayMinutes);

  const impacts = competing.map((r) => {
    const oldPct = Number(r.bufConsumedPct || 0);
    const projBuf = Number(r.projBufMin || 0);
    const addPct = projBuf > 0 ? Math.round((100 * delayMinutes) / projBuf) : (delayMinutes > 0 ? 100 : 0);
    const newPct = oldPct + addPct;
    const chainPct = Number(r.chainPct || 0);
    return {
      orderId: r.order_id,
      orderNumber: r.orderNumber,
      oldFinish: toDateTimeStr(r.committedFinish),
      newFinish: toDateTimeStr(addDays(r.committedFinish, days)),
      deltaDays: days,
      oldZone: r.feverZone ?? CC_FEVER.zoneFor(chainPct, oldPct),
      newZone: CC_FEVER.zoneFor(chainPct, newPct),
    };
  });

  // Recommended alternative = the most buffer-penetrated competing critical task
  // (tie-break earliest committed finish). If nothing competes, no detour.
  let recommended = null;
  if (competing.length > 0) {
    const best = [...competing].sort((a, b) =>
      Number(b.bufConsumedPct || 0) - Number(a.bufConsumedPct || 0)
      || new Date(a.committedFinish || 0).getTime() - new Date(b.committedFinish || 0).getTime()
      || Number(a.task_id) - Number(b.task_id),
    )[0];
    recommended = {
      taskId: Number(best.task_id),
      orderNumber: best.orderNumber,
      label: `${best.operationName || `Task ${best.task_id}`} · ${best.orderNumber}`,
    };
  }

  // Sort impacts most-severe first (worse projected zone, then bigger slip).
  const zoneRank = { red: 0, yellow: 1, green: 2 };
  impacts.sort((a, b) => (zoneRank[a.newZone] ?? 3) - (zoneRank[b.newZone] ?? 3) || b.deltaDays - a.deltaDays);

  return { ok: true, taskId, resourceId: resourceId ?? task.assigned_resource_id ?? null, isCritical, delayMinutes, impacts, recommended };
}

export default { whatIf };
