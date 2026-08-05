/**
 * shiftLog.js — end-of-day back-entry for one machine, one day (Issue 3).
 *
 * THE WORKFLOW THIS EXISTS FOR
 * ---------------------------
 * A supervisor's clipboard at 5pm reads something like:
 *
 *     Cutter-1, Tuesday
 *       09:00–11:30   WP-01 cut         12 good
 *       11:30–13:00   DOWN — blade change
 *       13:00–16:00   WP-02 cut         10 good, 2 scrap
 *       Ramesh absent
 *
 * Every one of those lines was already expressible in this system, and not one
 * of them was reachable from the same place:
 *
 *   - Work went through `POST /tasks/:id/events/backfill` — **one task at a
 *     time, and you had to find the task first.** Six jobs meant six searches
 *     and six dialogs, which is exactly why the clipboard never got typed up.
 *   - Downtime went through `POST /machines/:id/state`, which has accepted a
 *     past `at` since Phase 1 — but the Machine Board never sent one, so you
 *     could only ever say "this machine is down NOW".
 *   - Absence went through `POST /machines/:id/operator-absent`, same story
 *     with `absent_on`: the capability existed, the UI only ever said "today".
 *
 * So this is one GET that loads everything that machine could have done on a
 * date, and one POST that writes work + downtime + absence in a single
 * transaction.
 *
 * WHAT IT WILL NOT DO
 * -------------------
 * Overwrite. Back-entry only ever ADDS events; a task that already has a
 * started/completed pair for that day is returned with `alreadyLogged` so the
 * UI can show it as done rather than inviting a duplicate. Corrections have
 * their own audited path (`POST /task-events/:id/correct`) and this route
 * deliberately does not duplicate it.
 */

import { Router } from 'express';
import { protect } from '../../../core/middleware/authmiddleware.js';
import { pool } from '../../../db.js';
import { logger } from '../../../core/utils/logger.js';
import { recordEvents } from '../services/taskEventService.js';
import { resolveCalendarIds, workingIntervalsInWindow } from '../services/taskWaitService.js';
import { crewForWindow } from '../services/workerService.js';
import { recomputeForResource } from '../services/taskAttributionService.js';
import { onTaskComplete } from '../services/taskEngineService.js';
import { openOrMoveWipOnStart, finalizeWipOnComplete } from '../services/wipInventoryService.js';

const router = Router();

const REQUIRED_TAG = 'fab_erp_time_backfill';

function requireBackfill(req, res) {
  const user = req.user;
  if (user?.role && String(user.role).toLowerCase() === 'admin') return true;
  const granted = Array.isArray(user?.uiPermissions) && user.uiPermissions.includes(REQUIRED_TAG);
  if (!granted) {
    res.status(403).json({ message: `Permission denied. Required: "${REQUIRED_TAG}".` });
    return false;
  }
  return true;
}

/** 'YYYY-MM-DD' → [dayStart, dayEnd) as UTC wall-clock, matching taskWaitService. */
function dayBounds(dateStr) {
  const start = new Date(`${dateStr}T00:00:00Z`);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start, end };
}

function toSqlUtc(d) {
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

// ── GET /shift-log ───────────────────────────────────────────────────────────

router.get('/shift-log', protect, async (req, res) => {
  if (!requireBackfill(req, res)) return;

  const companyId = req.user.companyId;
  const resourceId = Number(req.query.resourceId);
  const date = String(req.query.date ?? '');

  if (!(resourceId > 0)) return res.status(400).json({ message: 'resourceId is required.' });
  if (!isDate(date)) return res.status(400).json({ message: 'date must be YYYY-MM-DD.' });

  const { start, end } = dayBounds(date);

  try {
    const [[resource]] = await pool.query(
      `SELECT id, name, code, plant_id AS plantId, resource_type_id AS resourceTypeId,
              shift_calendar_id AS shiftCalendarId
         FROM fab_resources WHERE id = ? AND company_id = ? AND deleted_at IS NULL LIMIT 1`,
      [resourceId, companyId],
    );
    if (!resource) return res.status(404).json({ message: 'Machine not found.' });

    // The shift itself — what "a full day" means for this machine, so the UI can
    // show how much of the day is accounted for and default the first row's
    // start to when the shift actually began.
    // The machine's own calendar wins over its plant's, matching how the backend
    // now attributes its time and what MachineTimeline already shows.
    const calendarIds = await resolveCalendarIds(
      companyId, resource.plantId, resource.shiftCalendarId,
    );
    const intervals = calendarIds.length
      ? await workingIntervalsInWindow(companyId, calendarIds, start, end)
      : [];
    const shiftMinutes = intervals.reduce((a, iv) => a + (iv.end - iv.start) / 60000, 0);

    // Candidate work: anything this machine could plausibly have run that day.
    // Deliberately wide — the whole point is that the planner's idea of what
    // should have happened is not what the clipboard says did.
    const [tasks] = await pool.query(
      `SELECT t.id, t.status, t.operation_id AS operationId, op.name AS operationName,
              t.item_id AS itemId, it.name AS itemName, it.mark AS itemMark,
              COALESCE(it.qty, 1) AS plannedQty,
              t.order_id AS orderId, fo.order_number AS orderNumber,
              t.seq_no AS seqNo, t.computed_hours AS computedHours,
              t.assigned_resource_id AS assignedResourceId,
              t.started_at AS startedAt, t.completed_at AS completedAt,
              t.produced_qty AS producedQty, t.scrap_qty AS scrapQty
         FROM fab_project_tasks t
         LEFT JOIN fab_operations op ON op.id = t.operation_id
         LEFT JOIN fab_items it ON it.id = t.item_id AND it.deleted_at IS NULL
         LEFT JOIN fab_orders fo ON fo.id = t.order_id
        WHERE t.company_id = ? AND t.deleted_at IS NULL
          AND (
            t.assigned_resource_id = ?
            OR (t.assigned_resource_id IS NULL AND t.resource_type_id = ?)
          )
          AND (
            t.status IN ('eligible','in_progress','paused')
            OR (t.status = 'done' AND t.completed_at >= ? AND t.completed_at < ?)
          )
        ORDER BY t.seq_no ASC, t.id ASC`,
      [companyId, resourceId, resource.resourceTypeId, toSqlUtc(start), toSqlUtc(end)],
    );

    // Which of those already have events on this date — so the screen can say
    // "already logged" instead of quietly inviting a duplicate entry.
    const taskIds = tasks.map((t) => t.id);
    const loggedIds = new Set();
    if (taskIds.length) {
      const [ev] = await pool.query(
        `SELECT DISTINCT task_id FROM fab_task_events
          WHERE company_id = ? AND task_id IN (?)
            AND event_type IN ('started','completed')
            AND superseded_by_event_id IS NULL AND deleted_at IS NULL
            AND at >= ? AND at < ?`,
        [companyId, taskIds, toSqlUtc(start), toSqlUtc(end)],
      );
      for (const r of ev) loggedIds.add(r.task_id);
    }

    const [downtime] = await pool.query(
      `SELECT id, state, reason_code AS reasonCode, at, note
         FROM fab_resource_events
        WHERE company_id = ? AND resource_id = ? AND deleted_at IS NULL
          AND superseded_by_event_id IS NULL AND at >= ? AND at < ?
        ORDER BY at ASC`,
      [companyId, resourceId, toSqlUtc(start), toSqlUtc(end)],
    );

    // The crew that machine had on THAT day, with any time away — intervals, so
    // "left at 4" survives as a fact instead of collapsing into "absent".
    const crew = await crewForWindow(pool, companyId, resourceId, start, end);
    const operators = crew.map((c) => ({
      workerId: c.workerId,
      userId: c.userId,
      name: c.name,
      workerType: c.workerType,
      vendorName: c.vendorName,
      away: c.away.map((a) => ({ id: a.id, from: a.fromTs, to: a.toTs, reason: a.reason })),
      // True only for a full-day absence; a part-day is described by `away`.
      absent: c.away.some((a) => new Date(a.fromTs) <= start && (a.toTs == null || new Date(a.toTs) >= end)),
    }));

    const [reasons] = await pool.query(
      `SELECT code, label FROM fab_resource_downtime_reasons
        WHERE company_id = ? AND active = 1 AND deleted_at IS NULL ORDER BY label`,
      [companyId],
    );

    return res.json({
      ok: true,
      resource,
      date,
      shift: {
        minutes: Math.round(shiftMinutes),
        intervals: intervals.map((iv) => ({ start: iv.start, end: iv.end })),
      },
      tasks: tasks.map((t) => ({ ...t, alreadyLogged: loggedIds.has(t.id) })),
      downtime,
      operators: operators.map((o) => ({ ...o, absent: !!Number(o.absent) })),
      // Same 5 built-in defaults the machine board falls back to when a company
      // hasn't configured its own list.
      downtimeReasons: reasons.length ? reasons : [
        { code: 'breakdown', label: 'Breakdown' },
        { code: 'maintenance', label: 'Maintenance' },
        { code: 'no_operator', label: 'No operator' },
        { code: 'no_power', label: 'No power' },
        { code: 'other', label: 'Other' },
      ],
    });
  } catch (err) {
    logger.error({ err, companyId, resourceId, date }, 'fab_erp shift-log: load failed');
    return res.status(500).json({ message: 'Failed to load the shift log.' });
  }
});

// ── POST /shift-log ──────────────────────────────────────────────────────────

router.post('/shift-log', protect, async (req, res) => {
  if (!requireBackfill(req, res)) return;

  const user = req.user;
  const companyId = user.companyId;
  const resourceId = Number(req.body?.resourceId);
  const date = String(req.body?.date ?? '');
  const work = Array.isArray(req.body?.work) ? req.body.work : [];
  const downtime = Array.isArray(req.body?.downtime) ? req.body.downtime : [];
  const absences = Array.isArray(req.body?.absences) ? req.body.absences : [];

  if (!(resourceId > 0)) return res.status(400).json({ message: 'resourceId is required.' });
  if (!isDate(date)) return res.status(400).json({ message: 'date must be YYYY-MM-DD.' });
  if (!work.length && !downtime.length && !absences.length) {
    return res.status(400).json({ message: 'Nothing to log.' });
  }

  // ── Parse and validate up front, so a bad row never half-writes ────────────
  const parsedWork = [];
  for (const [i, row] of work.entries()) {
    const taskId = Number(row?.taskId);
    if (!(taskId > 0)) return res.status(400).json({ message: `Row ${i + 1}: a task is required.` });

    const startedAt = row?.startedAt ? new Date(row.startedAt) : null;
    if (!startedAt || Number.isNaN(startedAt.getTime())) {
      return res.status(400).json({ message: `Row ${i + 1}: a valid start time is required.` });
    }
    let completedAt = null;
    if (row?.completedAt) {
      completedAt = new Date(row.completedAt);
      if (Number.isNaN(completedAt.getTime())) {
        return res.status(400).json({ message: `Row ${i + 1}: stop time is not a valid time.` });
      }
      if (completedAt <= startedAt) {
        return res.status(400).json({ message: `Row ${i + 1}: stop must be after start.` });
      }
    }
    const num = (v) => (v == null || v === '' ? null : Number(v));
    const producedQty = num(row?.producedQty);
    const scrapQty = num(row?.scrapQty);
    if (producedQty != null && !(producedQty >= 0)) return res.status(400).json({ message: `Row ${i + 1}: good qty must be ≥ 0.` });
    if (scrapQty != null && !(scrapQty >= 0)) return res.status(400).json({ message: `Row ${i + 1}: scrap must be ≥ 0.` });

    parsedWork.push({
      taskId, startedAt, completedAt, producedQty, scrapQty,
      qcResult: row?.qcResult === 'fail' ? 'fail' : 'pass',
      note: typeof row?.note === 'string' ? row.note.slice(0, 400) : null,
    });
  }

  const parsedDowntime = [];
  for (const [i, row] of downtime.entries()) {
    const from = row?.from ? new Date(row.from) : null;
    if (!from || Number.isNaN(from.getTime())) {
      return res.status(400).json({ message: `Downtime ${i + 1}: a valid start time is required.` });
    }
    let until = null;
    if (row?.until) {
      until = new Date(row.until);
      if (Number.isNaN(until.getTime())) return res.status(400).json({ message: `Downtime ${i + 1}: end time is not valid.` });
      if (until <= from) return res.status(400).json({ message: `Downtime ${i + 1}: end must be after start.` });
    }
    parsedDowntime.push({
      from, until,
      state: row?.state === 'off' ? 'off' : 'down',
      reasonCode: row?.reasonCode ? String(row.reasonCode).slice(0, 64) : null,
      note: typeof row?.note === 'string' ? row.note.slice(0, 400) : null,
    });
  }

  // Nothing may be logged into the future — a shift log is a record of what
  // happened, and a future timestamp is always a typo.
  const now = Date.now();
  for (const w of parsedWork) {
    if (w.startedAt.getTime() > now || (w.completedAt && w.completedAt.getTime() > now)) {
      return res.status(400).json({ message: 'Work times cannot be in the future.' });
    }
  }
  for (const d of parsedDowntime) {
    if (d.from.getTime() > now || (d.until && d.until.getTime() > now)) {
      return res.status(400).json({ message: 'Downtime cannot be in the future.' });
    }
  }

  // ── Overlap check (warn, never block) ──────────────────────────────────────
  // Two jobs on one machine at once is physically impossible unless the machine
  // batches (Issue 4) — but the person typing up a clipboard at 5pm is often
  // reconstructing approximate times, and refusing their entry outright means
  // the data never gets in at all. So: say so, write it anyway.
  const warnings = [];
  const spans = parsedWork
    .filter((w) => w.completedAt)
    .map((w) => ({ id: w.taskId, s: w.startedAt.getTime(), e: w.completedAt.getTime() }))
    .sort((a, b) => a.s - b.s);
  for (let i = 1; i < spans.length; i += 1) {
    if (spans[i].s < spans[i - 1].e) {
      warnings.push(`Tasks #${spans[i - 1].id} and #${spans[i].id} overlap in time on this machine.`);
    }
  }
  for (const d of parsedDowntime) {
    const dEnd = d.until ? d.until.getTime() : Infinity;
    for (const s of spans) {
      if (s.s < dEnd && d.from.getTime() < s.e) {
        warnings.push(`Task #${s.id} overlaps a period this machine was marked ${d.state}.`);
      }
    }
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // Every task must belong to this company; assign it to this machine while
    // we're here, since the whole premise is "this machine ran this work".
    //
    // item_id / seq_no / order_id come back too because the WIP hooks below need
    // them — they take the same task shape the live start/stop route passes.
    const taskIds = parsedWork.map((w) => w.taskId);
    const taskById = new Map();
    if (taskIds.length) {
      const [rows] = await conn.query(
        `SELECT id, item_id, seq_no, order_id FROM fab_project_tasks
          WHERE company_id = ? AND id IN (?) AND deleted_at IS NULL FOR UPDATE`,
        [companyId, taskIds],
      );
      if (rows.length !== taskIds.length) {
        await conn.rollback();
        return res.status(404).json({ message: 'One or more tasks no longer exist.' });
      }
      for (const r of rows) taskById.set(r.id, r);
    }

    // The machine, in the shape ensureMachineWipLocation expects.
    const [[machine]] = await conn.query(
      `SELECT id, name, plant_id, stock_location_id FROM fab_resources
        WHERE id = ? AND company_id = ? AND deleted_at IS NULL LIMIT 1`,
      [resourceId, companyId],
    );

    for (const w of parsedWork) {
      await conn.query(
        `UPDATE fab_project_tasks
            SET started_at = ?,
                completed_at = ?,
                status = ?,
                assigned_resource_id = COALESCE(assigned_resource_id, ?),
                produced_qty = COALESCE(?, produced_qty),
                scrap_qty = COALESCE(?, scrap_qty),
                qc_result = CASE WHEN ? IS NULL THEN qc_result ELSE ? END
          WHERE id = ? AND company_id = ? AND deleted_at IS NULL`,
        [
          toSqlUtc(w.startedAt),
          w.completedAt ? toSqlUtc(w.completedAt) : null,
          w.completedAt ? 'done' : 'in_progress',
          resourceId,
          w.producedQty, w.scrapQty,
          w.completedAt ? w.qcResult : null, w.qcResult,
          w.taskId, companyId,
        ],
      );

      // Move the material, exactly as POST /tasks/:id/start and /stop do.
      //
      // Until 2026-08-05 this route wrote task times and events and stopped
      // there. Back-entry is not a lesser path — 572 of the 578 start/stop
      // events in production came through it — so a whole girder could be
      // fabricated without a kilogram of steel being consumed: every stock
      // piece stayed 'in_stock', no WIP was ever opened, no machine ever got
      // its stock area, and finished goods never appeared. A material gate
      // could keep passing on steel that was notionally used weeks earlier.
      //
      // Best-effort per row: a material problem on one back-entered job must
      // not reject a supervisor's whole shift sheet, which is a record of what
      // already happened and cannot be "declined". The live path is stricter
      // because there the work has not started yet and can still be stopped.
      //
      // SAVEPOINT per row, because "best-effort" without one is not best-effort
      // at all. consumeStock walks pieces FIFO and decrements them one at a
      // time; if it runs out partway it throws INSUFFICIENT_STOCK having already
      // deducted several. Catching that and carrying on used to commit those
      // deductions with no WIP piece to show for them — steel gone from stock
      // and present nowhere. Rolling back to the savepoint undoes the partial
      // consumption while leaving every earlier row of the sheet intact.
      const task = taskById.get(w.taskId);
      if (task && machine) {
        const sp = `wip_${w.taskId}`;
        await conn.query(`SAVEPOINT ${sp}`);
        try {
          await openOrMoveWipOnStart(conn, companyId, task, machine);
          if (w.completedAt && w.qcResult !== 'fail') {
            await finalizeWipOnComplete(conn, companyId, task, {
              goodQty: w.producedQty ?? null,
              scrapQty: w.scrapQty ?? null,
            });
          }
          await conn.query(`RELEASE SAVEPOINT ${sp}`);
        } catch (wipErr) {
          await conn.query(`ROLLBACK TO SAVEPOINT ${sp}`);
          // The times and events for this job are written outside this block and
          // survive — the supervisor's record of what happened stands, and only
          // the material movement is undone. Reported back so the sheet does not
          // look like it landed cleanly.
          warnings.push(
            wipErr?.code === 'INSUFFICIENT_STOCK'
              ? `Task #${w.taskId}: times recorded, but no material was issued — ${wipErr.message || 'not enough stock on hand'}.`
              : `Task #${w.taskId}: times recorded, but the material movement failed and was rolled back.`,
          );
          logger.warn(
            { err: wipErr, taskId: w.taskId, resourceId },
            'shift-log: WIP movement rolled back for a back-entered job; times and events still recorded',
          );
        }
      }
    }

    for (const d of parsedDowntime) {
      await conn.query(
        `INSERT INTO fab_resource_events (company_id, resource_id, state, reason_code, at, source, entered_by, note)
         VALUES (?, ?, ?, ?, ?, 'backfill', ?, ?)`,
        [companyId, resourceId, d.state, d.reasonCode, toSqlUtc(d.from), user.id, d.note],
      );
      // A closed downtime period is two events: it went down, then it came back.
      // Without the second one the machine reads as still down forever, which is
      // how a board ends up showing yesterday's breakdown as today's state.
      if (d.until) {
        await conn.query(
          `INSERT INTO fab_resource_events (company_id, resource_id, state, reason_code, at, source, entered_by, note)
           VALUES (?, ?, 'idle', NULL, ?, 'backfill', ?, ?)`,
          [companyId, resourceId, toSqlUtc(d.until), user.id, `end of ${d.state}${d.reasonCode ? ` (${d.reasonCode})` : ''}`],
        );
      }
    }

    // Absence writes an interval. `from`/`to` are optional: without them it's a
    // whole day (midnight to midnight), with them it's "left at 4" — the same
    // record at a different scale, which is the point of the interval model.
    for (const a of absences) {
      const workerId = Number(a?.workerId);
      if (!(workerId > 0)) continue;
      if (a?.absent) {
        const from = a.from ? new Date(a.from) : start;
        const to = a.to ? new Date(a.to) : end;
        if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from) {
          await conn.rollback();
          return res.status(400).json({ message: 'Time away must end after it starts.' });
        }
        await conn.query(
          `INSERT INTO fab_worker_assignments
             (company_id, worker_id, resource_id, kind, from_ts, to_ts, reason, note, entered_by)
           VALUES (?, ?, NULL, 'away', ?, ?, ?, ?, ?)`,
          [companyId, workerId, toSqlUtc(from), toSqlUtc(to), a.reason ?? 'leave', a.note ?? null, user.id],
        );
      } else {
        // Un-ticking someone withdraws the away intervals that overlap this day.
        await conn.query(
          `UPDATE fab_worker_assignments SET deleted_at = NOW()
            WHERE company_id = ? AND worker_id = ? AND kind = 'away' AND deleted_at IS NULL
              AND from_ts < ? AND (to_ts IS NULL OR to_ts > ?)`,
          [companyId, workerId, toSqlUtc(end), toSqlUtc(start)],
        );
      }
    }

    await conn.commit();
  } catch (err) {
    await conn.rollback();
    logger.error({ err, companyId, resourceId, date }, 'fab_erp shift-log: save failed');
    return res.status(500).json({ message: 'Failed to save the shift log.' });
  } finally {
    conn.release();
  }

  // Events post-commit — recordEvents uses its own connection, same as every
  // other lifecycle route in this app.
  const events = [];
  for (const w of parsedWork) {
    events.push({ companyId, taskId: w.taskId, type: 'started', at: toSqlUtc(w.startedAt), source: 'backfill', enteredBy: user.id, note: w.note });
    if (w.completedAt) {
      events.push({ companyId, taskId: w.taskId, type: 'completed', at: toSqlUtc(w.completedAt), source: 'backfill', enteredBy: user.id, note: w.note });
    }
  }
  if (events.length) {
    try { await recordEvents(events); } catch (err) {
      logger.error({ err, resourceId }, 'shift-log: event write failed after commit');
    }
  }

  // Advance the DAG for every job written up, exactly as /tasks/:id/stop does.
  // Without this the Shift Log recorded work as done and left every successor
  // sitting blocked — so a shift entered from paper looked complete on the task
  // itself while the rest of the order never moved. Sequential, not parallel:
  // onTaskComplete clears successors, and two jobs in one shift can feed the
  // same downstream task.
  let successorsCleared = 0;
  for (const w of parsedWork.filter((x) => x.completedAt)) {
    try {
      const r = await onTaskComplete(companyId, w.taskId);
      successorsCleared += r?.successorsCleared ?? 0;
    } catch (err) {
      logger.error({ err, taskId: w.taskId }, 'shift-log: onTaskComplete failed');
    }
  }

  recomputeForResource(companyId, resourceId, new Date()).catch((err) =>
    logger.error({ err, resourceId }, 'shift-log: attribution recompute failed'));

  return res.json({
    ok: true,
    workLogged: parsedWork.length,
    successorsCleared,
    downtimeLogged: parsedDowntime.length,
    absencesSet: absences.length,
    warnings,
  });
});

export default router;
