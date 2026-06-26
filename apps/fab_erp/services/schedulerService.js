/**
 * schedulerService.js
 * -------------------
 * Finite Capacity Scheduler — backward-first, hour-level.
 *
 * Strategy:
 *   For each manufacturing work order (status = pending_schedule | scheduled):
 *     1. Load its routing plan → operations in sequence.
 *     2. Evaluate time formulas: total_hrs = setup_time + machine_time(qty).
 *     3. Walk operations in REVERSE sequence (backward from required_date).
 *     4. For each op: find the last available slot on the assigned resource type
 *        that fits within working hours and doesn't overlap an existing booking.
 *     5. If the backward start falls before today → switch to forward from today
 *        for that order (flag as late).
 *     6. Write fab_schedule_entries rows.
 *     7. Update fab_orders.status → 'scheduled' (or 'scheduled_late').
 *
 * Calendar resolution (per resource):
 *   fab_resources.shift_calendar_id
 *     → fab_shifts (start_time, end_time, working_minutes)
 *   Working day pattern:
 *     → fab_work_calendar_days (via a work calendar for the company)
 *   Exceptions (holidays):
 *     → fab_work_calendar_exceptions
 *
 * Exported:
 *   runScheduler(companyId, options?)  → { runId, ordersScheduled, lateOrders, entriesCreated }
 *   getScheduleEntries(companyId, filters) → rows
 *   lockEntry(entryId, companyId, locked) → void
 *   getSchedulerRuns(companyId, limit)  → rows
 */

import { pool } from '../../../db.js';
import { logger } from '../../../core/utils/logger.js';

const FREEZE_HORIZON_HOURS = 24; // don't reschedule ops starting within 24h

// ── Public: run scheduler ────────────────────────────────────────────────────

export async function runScheduler(
  companyId,
  { triggeredBy = 'manual', userId = null, orderIds = null } = {},
) {
  const conn = await pool.getConnection();

  const [runRes] = await conn.query(
    `INSERT INTO fab_scheduler_runs (company_id, triggered_by, triggered_by_user_id, status)
     VALUES (?, ?, ?, 'running')`,
    [companyId, triggeredBy, userId ?? null],
  );
  const runId = runRes.insertId;

  let scheduled    = 0;
  let lateOrders   = 0;
  let entriesCreated = 0;

  try {
    // ── A. Load orders to schedule ───────────────────────────────────────────
    let orderQuery = `
      SELECT fo.id, fo.order_number, fo.qty, fo.required_date,
             fo.bom_id, fo.catalog_item_id, fo.plant_id
      FROM fab_orders fo
      WHERE fo.company_id = ?
        AND fo.order_type = 'manufacturing'
        AND fo.status IN ('pending_schedule', 'scheduled', 'scheduled_late')
        AND fo.deleted_at IS NULL`;
    const params = [companyId];

    if (orderIds?.length) {
      orderQuery += ` AND fo.id IN (${orderIds.map(() => '?').join(',')})`;
      params.push(...orderIds);
    }

    const [orders] = await conn.query(orderQuery, params);
    if (orders.length === 0) {
      await conn.query(
        `UPDATE fab_scheduler_runs SET status='success', finished_at=NOW() WHERE id=?`,
        [runId],
      );
      conn.release();
      return { runId, ordersScheduled: 0, lateOrders: 0, entriesCreated: 0 };
    }

    // ── B. Load resource working-hours map ───────────────────────────────────
    // shift_calendar_id → { startHour, endHour, workingHrs }
    const [shiftRows] = await conn.query(
      `SELECT sc.id AS shift_cal_id, s.start_time, s.end_time, s.working_minutes
       FROM fab_shift_calendars sc
       JOIN fab_shifts s ON s.calendar_id = sc.id AND s.deleted_at IS NULL
       WHERE sc.company_id = ?`,
      [companyId],
    );
    const shiftMap = new Map(); // shiftCalId → { startH, startM, endH, endM, workingMins }
    for (const r of shiftRows) {
      const [sh, sm] = r.start_time.split(':').map(Number);
      const [eh, em] = r.end_time.split(':').map(Number);
      shiftMap.set(r.shift_cal_id, {
        startH: sh, startM: sm,
        endH: eh,   endM: em,
        workingMins: r.working_minutes,
      });
    }

    // ── C. Load working-day pattern for the company ──────────────────────────
    // Use the first work calendar found for this company (can be extended per-resource)
    const [dayRows] = await conn.query(
      `SELECT wcd.day_of_week, wcd.is_working_day
       FROM fab_work_calendar_days wcd
       JOIN fab_work_calendars wc ON wc.id = wcd.calendar_id
       WHERE wc.company_id = ? AND wc.deleted_at IS NULL`,
      [companyId],
    );
    const workingDays = new Set(); // e.g. 'Monday', 'Tuesday'...
    for (const r of dayRows) {
      if (r.is_working_day) workingDays.add(r.day_of_week);
    }
    // Fallback: Mon–Fri if no calendar defined
    if (workingDays.size === 0) {
      ['Monday','Tuesday','Wednesday','Thursday','Friday'].forEach(d => workingDays.add(d));
    }

    // Day-of-week names (JS Date: 0=Sun)
    const DOW = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

    // ── D. Load holiday exceptions ───────────────────────────────────────────
    const [excRows] = await conn.query(
      `SELECT wce.exception_date, wce.is_working_day
       FROM fab_work_calendar_exceptions wce
       JOIN fab_work_calendars wc ON wc.id = wce.calendar_id
       WHERE wc.company_id = ? AND wc.deleted_at IS NULL`,
      [companyId],
    );
    const exceptions = new Map(); // 'YYYY-MM-DD' → isWorking (bool)
    for (const r of excRows) {
      exceptions.set(r.exception_date.toISOString?.().slice(0,10) ?? r.exception_date, !!r.is_working_day);
    }

    // ── E. Load resources for this company + their shift calendars ───────────
    const [resRows] = await conn.query(
      `SELECT r.id, r.resource_type_id, r.shift_calendar_id,
              r.capacity_hrs_per_day, r.utilization_pct
       FROM fab_resources r
       WHERE r.company_id = ? AND r.deleted_at IS NULL`,
      [companyId],
    );
    // resource_type_id → [resourceId, ...] (pick first available by type)
    const resourcesByType = new Map();
    const resourceMeta    = new Map();
    for (const r of resRows) {
      if (!resourcesByType.has(r.resource_type_id)) resourcesByType.set(r.resource_type_id, []);
      resourcesByType.get(r.resource_type_id).push(r.id);
      resourceMeta.set(r.id, r);
    }

    // ── F. Load existing (locked or in-progress) bookings ───────────────────
    // bookings[resourceId] = [{ start: Date, end: Date }]
    const freezeCutoff = new Date(Date.now() + FREEZE_HORIZON_HOURS * 3_600_000);
    const [bookingRows] = await conn.query(
      `SELECT fse.resource_id, fse.start_datetime, fse.end_datetime
       FROM fab_schedule_entries fse
       WHERE fse.company_id = ?
         AND fse.deleted_at IS NULL
         AND fse.status NOT IN ('cancelled','done')
         AND (fse.locked = 1 OR fse.start_datetime <= ?)`,
      [companyId, toDateTimeStr(freezeCutoff)],
    );
    const bookings = new Map(); // resourceId → [{ start, end }]
    for (const b of bookingRows) {
      if (!bookings.has(b.resource_id)) bookings.set(b.resource_id, []);
      bookings.get(b.resource_id).push({
        start: new Date(b.start_datetime),
        end:   new Date(b.end_datetime),
      });
    }

    // ── G. Load routing plans for orders ─────────────────────────────────────
    const bomIds = [...new Set(orders.map(o => o.bom_id).filter(Boolean))];
    let routingByBom = new Map(); // bomId → { planId, ops[] }

    if (bomIds.length) {
      const [planRows] = await conn.query(
        `SELECT rp.id AS plan_id, rp.bom_id,
                ops.id AS step_id, ops.seq_no, ops.name AS op_name,
                ops.resource_type_id
         FROM fab_routing_plans rp
         JOIN fab_routing_op_steps ops ON ops.routing_plan_id = rp.id AND ops.deleted_at IS NULL
         WHERE rp.bom_id IN (${bomIds.map(() => '?').join(',')})
           AND rp.is_current = 1 AND rp.status = 'released' AND rp.deleted_at IS NULL
         ORDER BY rp.bom_id, ops.seq_no`,
        bomIds,
      );

      // Load formulas for all steps
      const stepIds = planRows.map(r => r.step_id);
      let formulaMap = new Map(); // stepId → { setup_time, machine_time }
      if (stepIds.length) {
        const [fRows] = await conn.query(
          `SELECT step_id, formula_type, expression
           FROM fab_routing_op_formulas
           WHERE step_id IN (${stepIds.map(() => '?').join(',')})
             AND is_valid = 1 AND deleted_at IS NULL`,
          stepIds,
        );
        for (const f of fRows) {
          if (!formulaMap.has(f.step_id)) formulaMap.set(f.step_id, {});
          formulaMap.get(f.step_id)[f.formula_type] = f.expression;
        }
      }

      // Load deps: fromStepId → { toStepId, lagMinutes }
      let depMap = new Map();
      if (stepIds.length) {
        const [dRows] = await conn.query(
          `SELECT from_step_id, to_step_id, lag_minutes
           FROM fab_routing_op_deps
           WHERE routing_plan_id IN (
             SELECT DISTINCT routing_plan_id FROM fab_routing_op_steps
             WHERE id IN (${stepIds.map(() => '?').join(',')})
           ) AND deleted_at IS NULL`,
          stepIds,
        );
        for (const d of dRows) depMap.set(d.from_step_id, { toStepId: d.to_step_id, lagMinutes: Number(d.lag_minutes) });
      }

      for (const r of planRows) {
        if (!routingByBom.has(r.bom_id)) {
          routingByBom.set(r.bom_id, { planId: r.plan_id, ops: [] });
        }
        routingByBom.get(r.bom_id).ops.push({
          stepId:         r.step_id,
          seqNo:          r.seq_no,
          opName:         r.op_name,
          resourceTypeId: r.resource_type_id,
          formulas:       formulaMap.get(r.step_id) ?? {},
        });
      }
    }

    // ── H. Delete previous non-locked schedule entries for these orders ───────
    const orderIdList = orders.map(o => o.id);
    await conn.beginTransaction();
    await conn.query(
      `DELETE FROM fab_schedule_entries
       WHERE company_id = ?
         AND order_id IN (${orderIdList.map(() => '?').join(',')})
         AND locked = 0
         AND status IN ('planned','scheduled')
         AND deleted_at IS NULL`,
      [companyId, ...orderIdList],
    );

    // ── I. Schedule each order ────────────────────────────────────────────────
    const today8am = (() => {
      const d = new Date();
      d.setHours(8, 0, 0, 0);
      return d;
    })();

    for (const order of orders) {
      const routing = routingByBom.get(order.bom_id);
      if (!routing || routing.ops.length === 0) {
        // No routing plan — just update status
        await conn.query(
          `UPDATE fab_orders SET status='scheduled' WHERE id=? AND company_id=?`,
          [order.id, companyId],
        );
        scheduled++;
        continue;
      }

      const qty = Number(order.qty) || 1;
      const reqDate = order.required_date
        ? setTimeOnDate(new Date(order.required_date), 17, 0) // end of shift on required date
        : setTimeOnDate(addDays(new Date(), 14), 17, 0);

      // Backward-schedule: walk ops in reverse
      const ops = [...routing.ops].sort((a, b) => b.seqNo - a.seqNo);
      const entriesToInsert = [];
      let cursor = new Date(reqDate); // walk backward from here
      let isLate = false;

      for (const op of ops) {
        const durationHrs = evaluateDuration(op.formulas, qty);
        const resourceIds = resourcesByType.get(op.resourceTypeId) ?? [];
        const resourceId  = resourceIds[0] ?? null; // pick first; FCS extension: pick least loaded

        if (!resourceId) {
          logger.warn({ stepId: op.stepId, resourceTypeId: op.resourceTypeId }, '[scheduler] no resource for type');
          continue;
        }

        const resMeta = resourceMeta.get(resourceId) ?? {};
        const shiftCalId = resMeta.shift_calendar_id;
        const shift = shiftMap.get(shiftCalId) ?? { startH: 8, startM: 0, endH: 17, endM: 0, workingMins: 480 };

        // Find the latest slot that fits before cursor
        const slot = findSlotBackward(
          cursor, durationHrs, shift, workingDays, exceptions, bookings.get(resourceId) ?? [], DOW,
        );

        let chosenSlot;
        if (slot.start < today8am) {
          isLate = true;
          // Fall forward: find slot from today
          chosenSlot = findSlotForward(
            today8am, durationHrs, shift, workingDays, exceptions, bookings.get(resourceId) ?? [], DOW,
          );
        } else {
          chosenSlot = slot;
        }

        entriesToInsert.unshift({ op, resourceId, start: chosenSlot.start, end: chosenSlot.end, durationHrs });
        cursor = new Date(chosenSlot.start);

        // Register booking so subsequent ops (in this order) don't overlap
        if (!bookings.has(resourceId)) bookings.set(resourceId, []);
        bookings.get(resourceId).push({ start: chosenSlot.start, end: chosenSlot.end });
      }

      // Re-sort entries chronologically for dep lag application
      entriesToInsert.sort((a, b) => a.op.seqNo - b.op.seqNo);

      // Insert entries
      const [firstLine] = await conn.query(
        `SELECT id FROM fab_order_lines WHERE order_id = ? AND deleted_at IS NULL LIMIT 1`,
        [order.id],
      );
      const orderLineId = firstLine[0]?.id ?? null;

      for (const e of entriesToInsert) {
        await conn.query(
          `INSERT INTO fab_schedule_entries
             (company_id, scheduler_run_id, order_id, order_line_id, step_id, resource_id,
              start_datetime, end_datetime, duration_hrs, status, is_late)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'planned', ?)`,
          [
            companyId, runId, order.id, orderLineId, e.op.stepId, e.resourceId,
            toDateTimeStr(e.start), toDateTimeStr(e.end), e.durationHrs.toFixed(4),
            isLate ? 1 : 0,
          ],
        );
        entriesCreated++;
      }

      // Update order scheduled window + status
      const orderStart = entriesToInsert[0]?.start;
      const orderEnd   = entriesToInsert[entriesToInsert.length - 1]?.end;
      const newStatus  = isLate ? 'scheduled_late' : 'scheduled';
      await conn.query(
        `UPDATE fab_orders
         SET status = ?, scheduled_start = ?, scheduled_end = ?
         WHERE id = ?`,
        [newStatus, orderStart ? toDateTimeStr(orderStart) : null,
         orderEnd   ? toDateTimeStr(orderEnd)   : null, order.id],
      );

      scheduled++;
      if (isLate) lateOrders++;
    }

    await conn.commit();

    await conn.query(
      `UPDATE fab_scheduler_runs
       SET status='success', finished_at=NOW(),
           orders_scheduled=?, entries_created=?, late_orders=?
       WHERE id=?`,
      [scheduled, entriesCreated, lateOrders, runId],
    );

    logger.info({ companyId, runId, ordersScheduled: scheduled, entriesCreated, lateOrders }, '[scheduler] run complete');
    return { runId, ordersScheduled: scheduled, lateOrders, entriesCreated };

  } catch (err) {
    await conn.rollback().catch(() => {});
    logger.error({ err, companyId, runId }, '[scheduler] run failed');
    await conn.query(
      `UPDATE fab_scheduler_runs SET status='error', finished_at=NOW(), error_message=? WHERE id=?`,
      [err.message?.slice(0, 500), runId],
    ).catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
}

// ── Public: fetch schedule entries ───────────────────────────────────────────

export async function getScheduleEntries(companyId, { fromDate, toDate, resourceId, orderId } = {}) {
  let sql = `
    SELECT fse.id, fse.order_id AS orderId, fse.order_line_id AS orderLineId,
           fse.step_id AS stepId, fse.resource_id AS resourceId,
           fse.start_datetime AS startDatetime, fse.end_datetime AS endDatetime,
           fse.duration_hrs AS durationHrs,
           fse.actual_start AS actualStart, fse.actual_end AS actualEnd, fse.actual_hrs AS actualHrs,
           fse.status, fse.locked, fse.is_late AS isLate,
           fo.order_number AS orderNumber, fo.qty AS orderQty,
           fic.name AS itemName, fic.code AS itemCode,
           ops.name AS opName, ops.seq_no AS seqNo,
           r.name AS resourceName, r.code AS resourceCode,
           rt.name AS resourceTypeName
    FROM fab_schedule_entries fse
    JOIN fab_orders            fo  ON fo.id  = fse.order_id
    JOIN fab_item_catalog      fic ON fic.id = fo.catalog_item_id
    JOIN fab_routing_op_steps  ops ON ops.id = fse.step_id
    JOIN fab_resources         r   ON r.id   = fse.resource_id
    JOIN fab_resource_types    rt  ON rt.id  = r.resource_type_id
    WHERE fse.company_id = ? AND fse.deleted_at IS NULL`;
  const params = [companyId];

  if (fromDate) { sql += ' AND fse.end_datetime >= ?';   params.push(fromDate); }
  if (toDate)   { sql += ' AND fse.start_datetime <= ?'; params.push(toDate); }
  if (resourceId) { sql += ' AND fse.resource_id = ?';  params.push(resourceId); }
  if (orderId)    { sql += ' AND fse.order_id = ?';     params.push(orderId); }

  sql += ' ORDER BY fse.start_datetime, fse.resource_id';

  const [rows] = await pool.query(sql, params);
  return rows;
}

export async function lockEntry(entryId, companyId, locked) {
  await pool.query(
    `UPDATE fab_schedule_entries SET locked = ? WHERE id = ? AND company_id = ?`,
    [locked ? 1 : 0, entryId, companyId],
  );
}

export async function getSchedulerRuns(companyId, limit = 20) {
  const [rows] = await pool.query(
    `SELECT id, triggered_by AS triggeredBy, triggered_by_user_id AS triggeredByUserId,
            started_at AS startedAt, finished_at AS finishedAt,
            status, orders_scheduled AS ordersScheduled, entries_created AS entriesCreated,
            late_orders AS lateOrders, error_message AS errorMessage
     FROM fab_scheduler_runs
     WHERE company_id = ? ORDER BY started_at DESC LIMIT ?`,
    [companyId, limit],
  );
  return rows;
}

// ── Slot finders ─────────────────────────────────────────────────────────────

function findSlotBackward(cursor, durationHrs, shift, workingDays, exceptions, existingBookings, DOW) {
  const durationMs = durationHrs * 3_600_000;
  let end = new Date(cursor);

  for (let attempt = 0; attempt < 200; attempt++) {
    const dateStr = toDateStr(end);
    const dow = DOW[end.getDay()];
    const isWorking = exceptions.has(dateStr) ? exceptions.get(dateStr) : workingDays.has(dow);

    if (!isWorking) {
      // Move to end of previous day
      end = setTimeOnDate(addDays(end, -1), shift.endH, shift.endM);
      continue;
    }

    const dayStart = setTimeOnDate(new Date(end), shift.startH, shift.startM);
    const dayEnd   = setTimeOnDate(new Date(end), shift.endH,   shift.endM);

    // Clamp end to shift end
    if (end > dayEnd) end = new Date(dayEnd);

    const candidateStart = new Date(end.getTime() - durationMs);

    if (candidateStart >= dayStart) {
      // Check against existing bookings
      if (!overlaps(candidateStart, end, existingBookings)) {
        return { start: candidateStart, end };
      }
      // Overlaps — push end back to before the conflicting booking
      const conflict = existingBookings
        .filter(b => b.end > candidateStart && b.start < end)
        .sort((a, b) => b.start - a.start)[0];
      end = conflict ? new Date(conflict.start) : new Date(dayStart);
    } else {
      // Doesn't fit in today — go to previous working day
      end = setTimeOnDate(addDays(end, -1), shift.endH, shift.endM);
    }
  }
  // Return best effort
  return { start: new Date(end.getTime() - durationMs), end };
}

function findSlotForward(cursor, durationHrs, shift, workingDays, exceptions, existingBookings, DOW) {
  const durationMs = durationHrs * 3_600_000;
  let start = new Date(cursor);

  for (let attempt = 0; attempt < 60; attempt++) {
    const dateStr = toDateStr(start);
    const dow = DOW[start.getDay()];
    const isWorking = exceptions.has(dateStr) ? exceptions.get(dateStr) : workingDays.has(dow);

    if (!isWorking) {
      start = setTimeOnDate(addDays(start, 1), shift.startH, shift.startM);
      continue;
    }

    const dayStart = setTimeOnDate(new Date(start), shift.startH, shift.startM);
    const dayEnd   = setTimeOnDate(new Date(start), shift.endH,   shift.endM);

    if (start < dayStart) start = new Date(dayStart);
    if (start >= dayEnd) {
      start = setTimeOnDate(addDays(start, 1), shift.startH, shift.startM);
      continue;
    }

    const candidateEnd = new Date(start.getTime() + durationMs);

    if (candidateEnd <= dayEnd) {
      if (!overlaps(start, candidateEnd, existingBookings)) {
        return { start, end: candidateEnd };
      }
      // Push start past the conflicting booking
      const conflict = existingBookings
        .filter(b => b.start < candidateEnd && b.end > start)
        .sort((a, b) => a.end - b.end)[0];
      start = conflict ? new Date(conflict.end) : new Date(dayEnd);
    } else {
      // Doesn't fit today — next day
      start = setTimeOnDate(addDays(start, 1), shift.startH, shift.startM);
    }
  }
  return { start, end: new Date(start.getTime() + durationMs) };
}

function overlaps(start, end, bookings) {
  return bookings.some(b => b.start < end && b.end > start);
}

// ── Formula evaluator ─────────────────────────────────────────────────────────

function evaluateDuration(formulas, qty) {
  const setup   = evalExpr(formulas.setup_time,   qty);
  const machine = evalExpr(formulas.machine_time,  qty);
  const people  = evalExpr(formulas.people_time,   qty);
  // Use max of machine or people time (parallel workers, not additive)
  return setup + Math.max(machine, people, 0);
}

function evalExpr(expr, qty) {
  if (!expr) return 0;
  try {
    // Use fixed-point notation to avoid scientific notation (e.g. 1e-7) bypassing the regex
    const qtyStr = Number.isFinite(qty) ? qty.toFixed(10).replace(/\.?0+$/, '') : '0';
    const safe = expr.replace(/qty/g, qtyStr);
    if (!/^[\d\s\+\-\*\/\.\(\)]+$/.test(safe)) return 0;
    // eslint-disable-next-line no-new-func
    return Number(new Function(`return ${safe}`)()) || 0;
  } catch {
    return 0;
  }
}

// ── Date helpers ──────────────────────────────────────────────────────────────

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function setTimeOnDate(date, h, m) {
  const d = new Date(date);
  d.setHours(h, m, 0, 0);
  return d;
}

function toDateStr(d) {
  return (d instanceof Date ? d : new Date(d)).toISOString().slice(0, 10);
}

function toDateTimeStr(d) {
  return (d instanceof Date ? d : new Date(d)).toISOString().slice(0, 19).replace('T', ' ');
}
