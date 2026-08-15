/**
 * maintenanceService.js — planned maintenance, and the machine state it implies.
 *
 * The model is deliberately small:
 *
 *   PLAN   what has to be done and how often, in DAYS. One row per job per
 *          machine ("grease the rails", every 30 days).
 *   LOG    one row per occurrence. Open (completed_at IS NULL) means the
 *          machine is in maintenance right now.
 *
 * WHY CALENDAR DAYS AND NOT RUNNING HOURS. Runtime triggers are the other real
 * model and the event data to support them exists, but a shop that cannot yet
 * say when a machine was last greased is not helped by a second trigger type it
 * also cannot populate. One rule that gets used beats two that do not.
 *
 * STARTING MAINTENANCE TAKES THE MACHINE DOWN, and that is not decoration:
 * `planService` skips any resource whose latest state is 'down' when it builds
 * the plan (see its `machineState === 'down'` guards), so a machine under
 * maintenance stops being scheduled the moment the job starts. Stopping brings
 * it back to 'idle' — not 'running', which is a state the floor earns by
 * starting a task, not one maintenance can confer.
 *
 * The state is written to `fab_resource_events`, the same append-only timeline
 * the Shift Log and machine board already read, so nothing else has to learn
 * that this feature exists. This table records WHY; that one records WHAT.
 */

import { pool } from '../../../db.js';

/** Reason code stamped on the down/idle events a maintenance start/stop writes. */
export const MAINTENANCE_REASON = 'maintenance';

/**
 * A calendar date as YYYY-MM-DD, read in LOCAL time.
 *
 * Not `toISOString()`, which is UTC and is wrong here twice over. A MySQL DATE
 * comes back as a JS Date at LOCAL midnight, so east of Greenwich
 * `toISOString()` rolls it back a day — every stored due date would read one
 * day early. And "today" at 09:00 in UTC+5:30 is still yesterday in UTC, so a
 * service completed this morning would be dated to yesterday and the next one
 * scheduled a day early. A maintenance date is a calendar fact about the shop,
 * so it is read in the shop's own day.
 */
const asDateOnly = (d) => {
  const x = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(x.getTime())) return null;
  const pad = (n) => String(n).padStart(2, '0');
  return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`;
};

const addDays = (dateStr, days) => {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + Number(days));
  return d.toISOString().slice(0, 10);
};

/**
 * When a plan is next due.
 *
 * Never serviced yet ⇒ due now rather than never: a plan somebody created and
 * has not acted on is exactly the thing a due list exists to surface, and
 * leaving `next_due_at` NULL would hide it until the first service, which is
 * the service that is being forgotten.
 */
export function computeNextDue(plan, lastDoneAt = null) {
  const last = lastDoneAt ?? plan?.last_done_at ?? plan?.lastDoneAt ?? null;
  const freq = Number(plan?.frequency_days ?? plan?.frequencyDays);
  if (!Number.isFinite(freq) || freq <= 0) return null;
  const lastStr = last ? asDateOnly(last) : null;
  if (!lastStr) return asDateOnly(new Date());
  return addDays(lastStr, freq);
}

/**
 * Where a plan stands today: 'ok' | 'due' | 'overdue' | 'in_progress'.
 *
 * 'due' is the LEAD window — `lead_days` before the date — because a warning
 * that arrives on the day it is needed is not a warning, it is a surprise.
 */
export function planStatus(plan, openLog = null, today = new Date()) {
  if (openLog) return 'in_progress';
  const due = plan?.next_due_at ?? plan?.nextDueAt;
  if (!due) return 'ok';
  const dueStr = asDateOnly(due);
  const todayStr = asDateOnly(today);
  if (!dueStr || !todayStr) return 'ok';
  if (dueStr < todayStr) return 'overdue';
  const lead = Number(plan?.lead_days ?? plan?.leadDays ?? 0) || 0;
  if (dueStr <= addDays(todayStr, lead)) return 'due';
  return 'ok';
}

/** Every plan for a company (optionally one machine), with its live status. */
export async function maintenanceOverview(companyId, { resourceId = null, conn = null } = {}) {
  const exec = conn ?? pool;
  const params = [companyId];
  let where = 'p.company_id = ? AND p.deleted_at IS NULL AND p.active = 1';
  if (resourceId) { where += ' AND p.resource_id = ?'; params.push(resourceId); }

  const [plans] = await exec.query(
    `SELECT p.id, p.resource_id AS resourceId, p.name, p.frequency_days AS frequencyDays,
            p.lead_days AS leadDays, p.last_done_at AS lastDoneAt, p.next_due_at AS nextDueAt,
            p.notes, r.name AS resourceName, r.code AS resourceCode
       FROM fab_maintenance_plans p
       JOIN fab_resources r ON r.id = p.resource_id AND r.deleted_at IS NULL
      WHERE ${where}
      ORDER BY p.next_due_at IS NULL, p.next_due_at, r.name`,
    params,
  );

  // Open logs, so a plan being worked on right now reads as in_progress rather
  // than as overdue — those need opposite actions from whoever is looking.
  const [open] = await exec.query(
    `SELECT id, resource_id AS resourceId, plan_id AS planId, started_at AS startedAt, due_at AS dueAt
       FROM fab_maintenance_logs
      WHERE company_id = ? AND deleted_at IS NULL AND completed_at IS NULL`,
    [companyId],
  );
  const openByPlan = new Map(open.filter((o) => o.planId != null).map((o) => [Number(o.planId), o]));
  const openByResource = new Map(open.map((o) => [Number(o.resourceId), o]));

  const today = new Date();
  const rows = plans.map((p) => {
    const o = openByPlan.get(Number(p.id)) ?? null;
    return { ...p, openLogId: o?.id ?? null, startedAt: o?.startedAt ?? null, status: planStatus(p, o, today) };
  });

  return {
    plans: rows,
    counts: {
      overdue: rows.filter((r) => r.status === 'overdue').length,
      due: rows.filter((r) => r.status === 'due').length,
      inProgress: rows.filter((r) => r.status === 'in_progress').length,
    },
    /** Machines with maintenance open, including ad-hoc jobs with no plan. */
    openByResource: [...openByResource.values()],
  };
}

/** Create or update a plan. `next_due_at` is always derived, never taken from the caller. */
export async function savePlan(companyId, payload, conn = null) {
  const exec = conn ?? pool;
  const {
    id = null, resourceId, name, frequencyDays, leadDays = 7,
    lastDoneAt = null, notes = null, active = 1,
  } = payload ?? {};

  if (!resourceId) throw new Error('A maintenance plan needs a machine.');
  if (!name || !String(name).trim()) throw new Error('A maintenance plan needs a name.');
  const freq = Number(frequencyDays);
  if (!Number.isFinite(freq) || freq <= 0) throw new Error('Frequency must be a number of days above zero.');

  const nextDue = computeNextDue({ frequency_days: freq }, lastDoneAt);

  if (id) {
    await exec.query(
      `UPDATE fab_maintenance_plans
          SET name = ?, frequency_days = ?, lead_days = ?, last_done_at = ?,
              next_due_at = ?, notes = ?, active = ?
        WHERE id = ? AND company_id = ? AND deleted_at IS NULL`,
      [String(name).trim(), freq, Number(leadDays) || 0, lastDoneAt || null,
       nextDue, notes, active ? 1 : 0, id, companyId],
    );
    return { id: Number(id), nextDueAt: nextDue };
  }
  const [ins] = await exec.query(
    `INSERT INTO fab_maintenance_plans
       (company_id, resource_id, name, frequency_days, lead_days, last_done_at, next_due_at, notes, active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [companyId, resourceId, String(name).trim(), freq, Number(leadDays) || 0,
     lastDoneAt || null, nextDue, notes, active ? 1 : 0],
  );
  return { id: ins.insertId, nextDueAt: nextDue };
}

export async function deletePlan(companyId, planId, conn = null) {
  const exec = conn ?? pool;
  await exec.query(
    `UPDATE fab_maintenance_plans SET deleted_at = NOW()
      WHERE id = ? AND company_id = ? AND deleted_at IS NULL`,
    [planId, companyId],
  );
}

/**
 * Begin maintenance on a machine, and take it out of the schedule.
 *
 * Refuses if maintenance is already open on that machine: two open logs would
 * make "when did this start" and the downtime figure ambiguous, and the second
 * 'down' event would be a no-op anyway.
 */
export async function startMaintenance(companyId, { resourceId, planId = null, note = null }, userId = null) {
  if (!resourceId) throw new Error('Which machine?');
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [[res]] = await conn.query(
      `SELECT id, name FROM fab_resources
        WHERE id = ? AND company_id = ? AND deleted_at IS NULL LIMIT 1`,
      [resourceId, companyId],
    );
    if (!res) { const e = new Error('Machine not found.'); e.status = 404; throw e; }

    const [[already]] = await conn.query(
      `SELECT id FROM fab_maintenance_logs
        WHERE company_id = ? AND resource_id = ? AND completed_at IS NULL AND deleted_at IS NULL
        LIMIT 1`,
      [companyId, resourceId],
    );
    if (already) {
      const e = new Error(`${res.name} is already in maintenance.`);
      e.status = 409;
      throw e;
    }

    let dueAt = null;
    if (planId) {
      const [[plan]] = await conn.query(
        `SELECT next_due_at FROM fab_maintenance_plans
          WHERE id = ? AND company_id = ? AND deleted_at IS NULL LIMIT 1`,
        [planId, companyId],
      );
      dueAt = plan?.next_due_at ?? null;
    }

    const [ins] = await conn.query(
      `INSERT INTO fab_maintenance_logs
         (company_id, resource_id, plan_id, due_at, started_at, started_by, notes)
       VALUES (?, ?, ?, ?, NOW(), ?, ?)`,
      [companyId, resourceId, planId, dueAt, userId, note],
    );

    // The machine leaves the schedule here — planService skips 'down'.
    await conn.query(
      `INSERT INTO fab_resource_events
         (company_id, resource_id, state, reason_code, at, source, entered_by, note)
       VALUES (?, ?, 'down', ?, NOW(), 'system', ?, ?)`,
      [companyId, resourceId, MAINTENANCE_REASON, userId, note ?? 'Maintenance started'],
    );

    await conn.commit();
    return { logId: ins.insertId, resourceId: Number(resourceId), dueAt };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * Finish maintenance: close the log, roll the plan forward, put the machine back.
 *
 * The plan's `last_done_at` is set to the COMPLETION date, not the due date, so
 * a service done three weeks late resets the clock from when the work actually
 * happened. Dating it from the due date would schedule the next one from a day
 * nobody touched the machine.
 */
export async function stopMaintenance(companyId, { resourceId, note = null }, userId = null) {
  if (!resourceId) throw new Error('Which machine?');
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [[log]] = await conn.query(
      `SELECT id, plan_id, started_at FROM fab_maintenance_logs
        WHERE company_id = ? AND resource_id = ? AND completed_at IS NULL AND deleted_at IS NULL
        ORDER BY started_at DESC LIMIT 1`,
      [companyId, resourceId],
    );
    if (!log) {
      const e = new Error('That machine is not in maintenance.');
      e.status = 409;
      throw e;
    }

    await conn.query(
      `UPDATE fab_maintenance_logs
          SET completed_at = NOW(), completed_by = ?,
              downtime_minutes = TIMESTAMPDIFF(MINUTE, started_at, NOW()),
              notes = CONCAT(COALESCE(notes, ''), ?)
        WHERE id = ? AND company_id = ?`,
      [userId, note ? `\n${note}` : '', log.id, companyId],
    );

    let nextDueAt = null;
    if (log.plan_id) {
      const [[plan]] = await conn.query(
        `SELECT frequency_days FROM fab_maintenance_plans
          WHERE id = ? AND company_id = ? AND deleted_at IS NULL LIMIT 1`,
        [log.plan_id, companyId],
      );
      if (plan) {
        const today = asDateOnly(new Date());
        nextDueAt = addDays(today, Number(plan.frequency_days));
        await conn.query(
          `UPDATE fab_maintenance_plans SET last_done_at = ?, next_due_at = ?
            WHERE id = ? AND company_id = ?`,
          [today, nextDueAt, log.plan_id, companyId],
        );
      }
    }

    // Back to 'idle', not 'running': being available is not the same as
    // working, and 'running' is a state the floor earns by starting a task.
    await conn.query(
      `INSERT INTO fab_resource_events
         (company_id, resource_id, state, reason_code, at, source, entered_by, note)
       VALUES (?, ?, 'idle', ?, NOW(), 'system', ?, ?)`,
      [companyId, resourceId, MAINTENANCE_REASON, userId, note ?? 'Maintenance completed'],
    );

    await conn.commit();
    return { logId: log.id, planId: log.plan_id ?? null, nextDueAt };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/** History for one machine — what was done and how long it took. */
export async function maintenanceHistory(companyId, resourceId, limit = 50) {
  const [rows] = await pool.query(
    `SELECT l.id, l.plan_id AS planId, p.name AS planName, l.due_at AS dueAt,
            l.started_at AS startedAt, l.completed_at AS completedAt,
            l.downtime_minutes AS downtimeMinutes, l.notes
       FROM fab_maintenance_logs l
       LEFT JOIN fab_maintenance_plans p ON p.id = l.plan_id
      WHERE l.company_id = ? AND l.resource_id = ? AND l.deleted_at IS NULL
      ORDER BY l.started_at DESC
      LIMIT ?`,
    [companyId, resourceId, Number(limit) || 50],
  );
  return rows;
}
