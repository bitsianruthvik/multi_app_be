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
