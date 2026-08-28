/**
 * planMachineLoadService.js — what each machine is due to put out, and what is
 * queued in front of it.
 *
 * TONNES, because that is what a fab shop counts. Hours measure whether a
 * machine is full; tonnes measure whether the job is moving, and the customer's
 * order is denominated in steel, not in time.
 *
 * A task's tonnage is the weight of ONE piece of its item times the number of
 * pieces the task covers — `computed_unit_weight × task_qty`. Not
 * `total_weight`, which already carries the item's own quantity and would
 * double-count wherever a task covers a subset of it.
 *
 * THE SAME STEEL IS COUNTED AT EVERY STATION IT PASSES, DELIBERATELY. A segment
 * of 13.4 t that is cut, welded, blasted and painted contributes 13.4 t to each
 * of those four machines, because each of them really does handle 13.4 t. The
 * per-machine numbers are therefore correct and their SUM is meaningless — it is
 * a throughput figure per station, not a total for the shop.
 *
 * "Backlog in front of a machine" is the tonnage planned on it beyond the end of
 * the bucket being looked at: the queue still to come once this week is done.
 */

import { pool } from '../../../db.js';
import { plannerTimezone } from './planService.js';
import { zonedYMD } from './plantTime.js';

/** Monday of the ISO week containing `ymd`, as a YYYY-MM-DD string. */
function weekStart(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  // getUTCDay: 0 = Sunday. Shift so Monday is the start.
  const shift = (dt.getUTCDay() + 6) % 7;
  dt.setUTCDate(dt.getUTCDate() - shift);
  return dt.toISOString().slice(0, 10);
}

/**
 * Planned output and queue per machine, bucketed.
 *
 * @param {number} companyId
 * @param {object} opts
 * @param {Date}   opts.from
 * @param {Date}   opts.to
 * @param {'week'|'month'} [opts.bucket]
 */
export async function machineLoad(companyId, { from, to, bucket = 'week' } = {}) {
  const tz = await plannerTimezone(companyId);

  const [machines] = await pool.query(
    `SELECT r.id, r.name, r.resource_type_id AS typeId, rt.name AS typeName
       FROM fab_resources r
       LEFT JOIN fab_resource_types rt ON rt.id = r.resource_type_id
      WHERE r.company_id = ? AND r.deleted_at IS NULL
      ORDER BY rt.name ASC, r.name ASC`,
    [companyId],
  );

  /**
   * Every planned task with a machine, a weight and a time.
   *
   * Loaded whole rather than filtered to the window, because the backlog figure
   * is about what lies BEYOND the window — filtering first would answer a
   * different question and always report zero queue at the far edge.
   */
  const [rows] = await pool.query(
    `SELECT et.resource_id AS machineId,
            COALESCE(et.planned_start, e.planned_start) AS s,
            et.planned_minutes AS minutes,
            COALESCE(i.computed_unit_weight, i.unit_weight, 0) * COALESCE(t.task_qty, 1) AS kg
       FROM fab_plan_entry_tasks et
       JOIN fab_plan_entries e ON e.id = et.plan_entry_id AND e.company_id = et.company_id
       JOIN fab_project_tasks t ON t.id = et.task_id AND t.deleted_at IS NULL
       LEFT JOIN fab_items i ON i.id = t.item_id AND i.deleted_at IS NULL
      WHERE et.company_id = ? AND et.deleted_at IS NULL
        AND e.status = 'planned' AND e.deleted_at IS NULL
        AND et.resource_id IS NOT NULL`,
    [companyId],
  );

  const fromMs = from.getTime();
  const toMs = to.getTime();
  const bucketOf = (d) => {
    const ymd = zonedYMD(d, tz);
    return bucket === 'month' ? `${ymd.slice(0, 7)}-01` : weekStart(ymd);
  };

  const perMachine = new Map(machines.map((m) => [m.id, {
    machineId: m.id,
    name: m.name,
    typeId: m.typeId,
    typeName: m.typeName,
    buckets: new Map(),
    beyondKg: 0,
    beyondTasks: 0,
  }]));

  for (const r of rows) {
    const at = perMachine.get(r.machineId);
    if (!at) continue;
    const when = new Date(r.s);
    const ms = when.getTime();
    const kg = Number(r.kg) || 0;
    if (ms >= toMs) {
      // Queued beyond the window: this is the backlog in front of the machine.
      at.beyondKg += kg;
      at.beyondTasks += 1;
      continue;
    }
    if (ms < fromMs) continue;
    const key = bucketOf(when);
    const b = at.buckets.get(key) ?? { key, kg: 0, minutes: 0, tasks: 0 };
    b.kg += kg;
    b.minutes += Number(r.minutes) || 0;
    b.tasks += 1;
    at.buckets.set(key, b);
  }

  const out = [...perMachine.values()].map((m) => {
    const buckets = [...m.buckets.values()].sort((a, b) => a.key.localeCompare(b.key));
    /**
     * Backlog is cumulative from the far end backwards: what is still in front
     * of the machine at the END of each bucket is everything planned after it,
     * including the work beyond the window entirely.
     */
    let running = m.beyondKg;
    const withQueue = [];
    for (let i = buckets.length - 1; i >= 0; i -= 1) {
      withQueue.unshift({
        bucket: buckets[i].key,
        tonnes: +(buckets[i].kg / 1000).toFixed(2),
        hours: +(buckets[i].minutes / 60).toFixed(1),
        tasks: buckets[i].tasks,
        backlogTonnes: +(running / 1000).toFixed(2),
      });
      running += buckets[i].kg;
    }
    return {
      machineId: m.machineId,
      name: m.name,
      typeId: m.typeId,
      typeName: m.typeName,
      totalTonnes: +(withQueue.reduce((a, b) => a + b.tonnes, 0)).toFixed(2),
      totalHours: +(withQueue.reduce((a, b) => a + b.hours, 0)).toFixed(1),
      beyondWindowTonnes: +(m.beyondKg / 1000).toFixed(2),
      buckets: withQueue,
    };
  });

  const keys = [...new Set(out.flatMap((m) => m.buckets.map((b) => b.bucket)))].sort();
  return { bucket, from: from.toISOString(), to: to.toISOString(), bucketKeys: keys, machines: out };
}
