/**
 * planMachineService.js — which actual machine does this work run on.
 *
 * WHY THIS IS PER TASK AND NOT PER BAR
 * ------------------------------------
 * The board drew one lane per resource TYPE, because that is all the plan knew:
 * of 2,927 planned bars, zero named a machine. "SAW Welding" was one lane where
 * up to four bars ran side by side and nothing had decided which of the four
 * welders had what.
 *
 * The obvious fix — put a machine on each bar — does not work, and the data says
 * so plainly. 645 of those bars carry MORE work than their own wall-clock span:
 * bundling groups tasks that overlap in time, so one bar can be five members
 * running across three machines at once. One of them holds 356 minutes of work
 * in a 148-minute window. A bar is not a machine-sized thing.
 *
 * A TASK is. The leveller schedules tasks against a type's capacity, one machine
 * each, and every member carries its own levelled span. So the assignment lives
 * on fab_plan_entry_tasks.
 *
 * WHY GREEDY IS ENOUGH
 * --------------------
 * Assigning machines to overlapping intervals is interval-graph colouring, and
 * for intervals a greedy pass in start order uses exactly as many colours as the
 * maximum overlap. The leveller has already held that overlap at or below the
 * machine count — measured on the production plan, peak concurrent tasks per
 * type is 2/2, 3/3, 2/4, 1/1 and so on, never above. So a machine is always free
 * when one is needed, and there is nothing to backtrack over.
 *
 * A planner's own choice is not overwritten. Members that already name a machine
 * are laid down first and the rest fit around them; if a hand assignment has made
 * the rest impossible, the leftovers are reported rather than silently moved.
 */

import { pool } from '../../../db.js';
import { PlanError, plannerTimezone } from './planService.js';
import { zonedYMD } from './plantTime.js';

/** MySQL DATETIME, UTC. */
function toDateTimeStr(d) {
  return (d instanceof Date ? d : new Date(d)).toISOString().slice(0, 19).replace('T', ' ');
}

/** Non-overlapping check against what a machine already holds. */
function fits(busy, start, end) {
  for (const iv of busy) {
    if (start < iv.end && end > iv.start) return false;
  }
  return true;
}

/**
 * Give every planned task a machine.
 *
 * @param {number} companyId
 * @param {object} [opts]
 * @param {number[]} [opts.resourceTypeIds]  limit to these types (default all)
 * @param {boolean}  [opts.reassign]         also move members that already name
 *                   a machine. Off by default: a planner who dragged a job onto
 *                   Welder 3 meant it.
 * @returns {Promise<{assigned:number, kept:number, unplaceable:number, byType:object[]}>}
 */
export async function assignMachines(companyId, { resourceTypeIds = [], reassign = false } = {}) {
  const params = [companyId];
  let filter = '';
  if (resourceTypeIds.length > 0) { filter = ' AND e.resource_type_id IN (?)'; params.push(resourceTypeIds); }

  const [machines] = await pool.query(
    `SELECT id, resource_type_id AS typeId, name FROM fab_resources
      WHERE company_id = ? AND deleted_at IS NULL ORDER BY name ASC`,
    [companyId],
  );
  const byType = new Map();
  for (const m of machines) {
    if (!byType.has(m.typeId)) byType.set(m.typeId, []);
    byType.get(m.typeId).push(m);
  }

  const [members] = await pool.query(
    `SELECT et.id, et.plan_entry_id AS entryId, et.resource_id AS resourceId,
            e.resource_type_id AS typeId,
            COALESCE(et.planned_start, e.planned_start) AS s,
            COALESCE(et.planned_end,   e.planned_end)   AS e2
       FROM fab_plan_entry_tasks et
       JOIN fab_plan_entries e ON e.id = et.plan_entry_id AND e.company_id = et.company_id
      WHERE et.company_id = ? AND et.deleted_at IS NULL
        AND e.status = 'planned' AND e.deleted_at IS NULL${filter}
      ORDER BY COALESCE(et.planned_start, e.planned_start) ASC, et.id ASC`,
    params,
  );

  const updates = [];
  let kept = 0;
  let unplaceable = 0;
  const report = [];

  const groups = new Map();
  for (const m of members) {
    if (!groups.has(m.typeId)) groups.set(m.typeId, []);
    groups.get(m.typeId).push(m);
  }

  for (const [typeId, list] of groups) {
    const pool_ = byType.get(typeId) ?? [];
    if (pool_.length === 0) continue;               // nothing to assign to

    // One machine, one answer — no colouring needed, and six of ten types here.
    if (pool_.length === 1) {
      const only = pool_[0].id;
      for (const m of list) {
        if (m.resourceId === only) { kept += 1; continue; }
        if (m.resourceId != null && !reassign) { kept += 1; continue; }
        updates.push([m.id, only]);
      }
      report.push({ typeId, machines: 1, members: list.length });
      continue;
    }

    const busy = new Map(pool_.map((m) => [m.id, []]));
    const free = [];
    // A planner's own assignments go down first, so the rest fit around them.
    for (const m of list) {
      const start = new Date(m.s).getTime();
      const end = new Date(m.e2).getTime();
      if (m.resourceId != null && !reassign && busy.has(m.resourceId)) {
        busy.get(m.resourceId).push({ start, end });
        kept += 1;
        continue;
      }
      free.push({ ...m, start, end });
    }

    for (const m of free) {
      const machine = pool_.find((r) => fits(busy.get(r.id), m.start, m.end));
      if (!machine) { unplaceable += 1; continue; }
      busy.get(machine.id).push({ start: m.start, end: m.end });
      if (m.resourceId !== machine.id) updates.push([m.id, machine.id]);
      else kept += 1;
    }
    report.push({ typeId, machines: pool_.length, members: list.length });
  }

  // Written in chunks with a CASE, the same shape as every other bulk write here.
  const CHUNK = 300;
  for (let i = 0; i < updates.length; i += CHUNK) {
    const batch = updates.slice(i, i + CHUNK);
    const cases = batch.map(() => 'WHEN ? THEN ?').join(' ');
    await pool.query(
      `UPDATE fab_plan_entry_tasks
          SET resource_id = CASE id ${cases} END
        WHERE company_id = ? AND id IN (?) AND deleted_at IS NULL`,
      [...batch.flat(), companyId, batch.map((b) => b[0])],
    );
  }

  return { assigned: updates.length, kept, unplaceable, byType: report };
}

/**
 * Move named tasks onto a particular machine.
 *
 * The planner's override. It is checked rather than trusted: a machine runs one
 * job at a time, so a move that would double-book it is refused with the job it
 * would have collided with, not silently accepted and left for somebody to find
 * on the floor.
 *
 * Tasks are addressed by (entryId, taskId) because that is what the board has in
 * its hand — the member row's own id never travels to the client.
 *
 * @param {number} companyId
 * @param {object} input
 * @param {{entryId:number, taskId:number}[]} input.pairs
 * @param {number} input.resourceId  the machine to move them to
 */
export async function assignTasksToMachine(companyId, { pairs = [], resourceId } = {}) {
  if (!Array.isArray(pairs) || pairs.length === 0) {
    throw new PlanError('NO_TASKS', 'No tasks were named.');
  }
  const machineId = Number(resourceId);
  if (!Number.isFinite(machineId) || machineId <= 0) {
    throw new PlanError('NO_MACHINE', 'A machine must be named.');
  }

  const [[machine]] = await pool.query(
    `SELECT r.id, r.name, r.resource_type_id AS typeId FROM fab_resources r
      WHERE r.company_id = ? AND r.id = ? AND r.deleted_at IS NULL`,
    [companyId, machineId],
  );
  if (!machine) throw new PlanError('NO_MACHINE', 'That machine does not exist.');

  const entryIds = [...new Set(pairs.map((p) => Number(p.entryId)).filter(Boolean))];
  const taskIds = [...new Set(pairs.map((p) => Number(p.taskId)).filter(Boolean))];
  const [members] = await pool.query(
    `SELECT et.id, et.plan_entry_id AS entryId, et.task_id AS taskId, et.resource_id AS resourceId,
            e.resource_type_id AS typeId,
            COALESCE(et.planned_start, e.planned_start) AS s,
            COALESCE(et.planned_end,   e.planned_end)   AS e2
       FROM fab_plan_entry_tasks et
       JOIN fab_plan_entries e ON e.id = et.plan_entry_id AND e.company_id = et.company_id
      WHERE et.company_id = ? AND et.plan_entry_id IN (?) AND et.task_id IN (?)
        AND et.deleted_at IS NULL AND e.status = 'planned' AND e.deleted_at IS NULL`,
    [companyId, entryIds, taskIds],
  );
  const wanted = new Set(pairs.map((p) => `${Number(p.entryId)}:${Number(p.taskId)}`));
  const moving = members.filter((m) => wanted.has(`${m.entryId}:${m.taskId}`));
  if (moving.length === 0) throw new PlanError('NO_TASKS', 'None of those tasks are on the plan.');

  /**
   * A machine can only run what its type can do.
   *
   * Without this a planner could park a welding job on a paint booth by mistake,
   * and nothing downstream would notice — the leveller's capacity check is per
   * type, so the plan would still look legal.
   */
  const wrongType = moving.find((m) => m.typeId !== machine.typeId);
  if (wrongType) {
    throw new PlanError(
      'WRONG_TYPE',
      `${machine.name} cannot run that work — it is a different kind of machine.`,
      { taskId: wrongType.taskId, machineId },
    );
  }

  // What the target already holds, ignoring the tasks being moved onto it.
  const movingIds = new Set(moving.map((m) => m.id));
  const [busy] = await pool.query(
    `SELECT et.id, et.task_id AS taskId,
            COALESCE(et.planned_start, e.planned_start) AS s,
            COALESCE(et.planned_end,   e.planned_end)   AS e2
       FROM fab_plan_entry_tasks et
       JOIN fab_plan_entries e ON e.id = et.plan_entry_id AND e.company_id = et.company_id
      WHERE et.company_id = ? AND et.resource_id = ? AND et.deleted_at IS NULL
        AND e.status = 'planned' AND e.deleted_at IS NULL`,
    [companyId, machineId],
  );
  const held = busy.filter((b) => !movingIds.has(b.id))
    .map((b) => ({ taskId: b.taskId, start: new Date(b.s).getTime(), end: new Date(b.e2).getTime() }));

  const placed = [];
  for (const m of moving) {
    const start = new Date(m.s).getTime();
    const end = new Date(m.e2).getTime();
    const clash = held.find((h) => start < h.end && end > h.start)
      ?? placed.find((h) => start < h.end && end > h.start);
    if (clash) {
      throw new PlanError(
        'MACHINE_BUSY',
        `${machine.name} is already running task ${clash.taskId} then.`,
        { taskId: m.taskId, machineId, clashesWith: clash.taskId },
      );
    }
    placed.push({ taskId: m.taskId, start, end });
  }

  await pool.query(
    `UPDATE fab_plan_entry_tasks SET resource_id = ?
      WHERE company_id = ? AND id IN (?) AND deleted_at IS NULL`,
    [machineId, companyId, moving.map((m) => m.id)],
  );
  return { moved: moving.length, machineId, machineName: machine.name };
}

/**
 * One machine's next few days, task by task.
 *
 * The panel beside the day view: what this machine is doing today, and what is
 * coming for the rest of the week. Per DAY rather than per week, because the
 * question being asked while looking at a single day is "and then what".
 */
export async function machineAgenda(companyId, { machineId, from, days = 7 } = {}) {
  const [[machine]] = await pool.query(
    `SELECT r.id, r.name, rt.name AS typeName, r.resource_type_id AS typeId
       FROM fab_resources r
       LEFT JOIN fab_resource_types rt ON rt.id = r.resource_type_id
      WHERE r.company_id = ? AND r.id = ? AND r.deleted_at IS NULL`,
    [companyId, machineId],
  );
  if (!machine) throw new PlanError('NO_MACHINE', 'That machine does not exist.');

  const tz = await plannerTimezone(companyId);
  const to = new Date(from.getTime() + days * 86400000);

  const [rows] = await pool.query(
    `SELECT et.plan_entry_id AS entryId, et.task_id AS taskId,
            COALESCE(et.planned_start, e.planned_start) AS s,
            COALESCE(et.planned_end,   e.planned_end)   AS e2,
            et.planned_minutes AS minutes,
            i.code AS itemCode, i.name AS itemName,
            op.name AS operationName,
            o.order_number AS orderNumber,
            COALESCE(i.computed_unit_weight, i.unit_weight, 0) * COALESCE(t.task_qty, 1) AS kg
       FROM fab_plan_entry_tasks et
       JOIN fab_plan_entries e ON e.id = et.plan_entry_id AND e.company_id = et.company_id
       JOIN fab_project_tasks t ON t.id = et.task_id AND t.deleted_at IS NULL
       LEFT JOIN fab_items i ON i.id = t.item_id AND i.deleted_at IS NULL
       LEFT JOIN fab_operations op ON op.id = t.operation_id
       LEFT JOIN fab_orders o ON o.id = t.order_id AND o.deleted_at IS NULL
      WHERE et.company_id = ? AND et.resource_id = ? AND et.deleted_at IS NULL
        AND e.status = 'planned' AND e.deleted_at IS NULL
        AND COALESCE(et.planned_start, e.planned_start) >= ?
        AND COALESCE(et.planned_start, e.planned_start) <  ?
      ORDER BY s ASC`,
    [companyId, machine.id, toDateTimeStr(from), toDateTimeStr(to)],
  );

  const byDay = new Map();
  for (const r of rows) {
    const at = new Date(r.s);
    const day = zonedYMD(at, tz);
    const bucket = byDay.get(day) ?? { day, tonnes: 0, hours: 0, tasks: [] };
    bucket.tonnes += (Number(r.kg) || 0) / 1000;
    bucket.hours += (Number(r.minutes) || 0) / 60;
    bucket.tasks.push({
      entryId: r.entryId,
      taskId: r.taskId,
      start: at.toISOString(),
      end: new Date(r.e2).toISOString(),
      minutes: Number(r.minutes) || 0,
      itemCode: r.itemCode,
      itemName: r.itemName,
      operationName: r.operationName,
      orderNumber: r.orderNumber,
      tonnes: +((Number(r.kg) || 0) / 1000).toFixed(3),
    });
    byDay.set(day, bucket);
  }

  const agenda = [...byDay.values()]
    .sort((a, b) => a.day.localeCompare(b.day))
    .map((d) => ({ ...d, tonnes: +d.tonnes.toFixed(2), hours: +d.hours.toFixed(1) }));

  return {
    machineId: machine.id,
    machineName: machine.name,
    typeId: machine.typeId,
    typeName: machine.typeName,
    from: from.toISOString(),
    days,
    totalTonnes: +agenda.reduce((a, b) => a + b.tonnes, 0).toFixed(2),
    totalHours: +agenda.reduce((a, b) => a + b.hours, 0).toFixed(1),
    agenda,
  };
}

/** The machines a task could move to — its type's, with whether each is free. */
export async function machinesForTask(companyId, { entryId, taskId } = {}) {
  const [[m]] = await pool.query(
    `SELECT et.id, e.resource_type_id AS typeId, et.resource_id AS resourceId,
            COALESCE(et.planned_start, e.planned_start) AS s,
            COALESCE(et.planned_end,   e.planned_end)   AS e2
       FROM fab_plan_entry_tasks et
       JOIN fab_plan_entries e ON e.id = et.plan_entry_id AND e.company_id = et.company_id
      WHERE et.company_id = ? AND et.plan_entry_id = ? AND et.task_id = ?
        AND et.deleted_at IS NULL AND e.status = 'planned' AND e.deleted_at IS NULL`,
    [companyId, entryId, taskId],
  );
  if (!m) throw new PlanError('NO_TASKS', 'That task is not on the plan.');

  const start = new Date(m.s).getTime();
  const end = new Date(m.e2).getTime();
  const [machines] = await pool.query(
    `SELECT id, name FROM fab_resources
      WHERE company_id = ? AND resource_type_id = ? AND deleted_at IS NULL ORDER BY name ASC`,
    [companyId, m.typeId],
  );
  const [busy] = await pool.query(
    `SELECT et.resource_id AS machineId, et.task_id AS taskId,
            COALESCE(et.planned_start, e.planned_start) AS s,
            COALESCE(et.planned_end,   e.planned_end)   AS e2
       FROM fab_plan_entry_tasks et
       JOIN fab_plan_entries e ON e.id = et.plan_entry_id AND e.company_id = et.company_id
      WHERE et.company_id = ? AND et.resource_id IS NOT NULL AND et.id <> ?
        AND et.deleted_at IS NULL AND e.status = 'planned' AND e.deleted_at IS NULL
        AND COALESCE(et.planned_start, e.planned_start) < ?
        AND COALESCE(et.planned_end,   e.planned_end)   > ?`,
    [companyId, m.id, toDateTimeStr(new Date(end)), toDateTimeStr(new Date(start))],
  );
  const clash = new Map();
  for (const b of busy) if (!clash.has(b.machineId)) clash.set(b.machineId, b.taskId);

  return {
    entryId: Number(entryId),
    taskId: Number(taskId),
    currentMachineId: m.resourceId ?? null,
    start: new Date(start).toISOString(),
    end: new Date(end).toISOString(),
    machines: machines.map((x) => ({
      machineId: x.id,
      name: x.name,
      free: !clash.has(x.id),
      busyWithTaskId: clash.get(x.id) ?? null,
      current: x.id === m.resourceId,
    })),
  };
}
