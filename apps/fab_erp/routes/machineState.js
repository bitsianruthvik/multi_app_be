/**
 * routes/machineState.js
 * -----------------------
 * EU-4 (Shop-Floor Time Intelligence): Machine state API — the "Machine
 * Board" backend. Reads/writes fab_resource_events (explicit machine state:
 * running/idle/down/off), fab_resource_downtime_reasons (per-company reason
 * codes with built-in fallback), and fab_resource_operators (standing
 * operator assignments + daily absence marking).
 *
 * Mounted under /api/:companySlug/fab_erp
 *
 * Permission: every endpoint below (including the board GET) requires the
 * single tag 'fab_erp_machine_state_manage', per the EU-4 plan — admins
 * bypass as usual.
 *
 * Routes:
 *   GET  /machines/board                    — whole-shop machine state board
 *   POST /machines/:id/state                — log an explicit state change
 *   POST /machines/:id/operator-absent      — mark/clear an operator absent
 *   GET  /machines/downtime-reasons         — reason codes (company or defaults)
 */

import { Router } from 'express';
import { protect } from '../../../core/middleware/authmiddleware.js';
import { logger } from '../../../core/utils/logger.js';
import { pool } from '../../../db.js';
import { recomputeForResource } from '../services/taskAttributionService.js';

const router = Router();

const REQUIRED_TAG = 'fab_erp_machine_state_manage';

/** Shared authz check — admin bypass, else require the tag in uiPermissions. */
function isAuthorized(user) {
  const isAdmin = user?.role && String(user.role).toLowerCase() === 'admin';
  if (isAdmin) return true;
  return Array.isArray(user?.uiPermissions) && user.uiPermissions.includes(REQUIRED_TAG);
}

function denyPermission(res, user, routeLabel) {
  logger.warn(
    { userId: user?.id, requiredTag: REQUIRED_TAG },
    `fab_erp ${routeLabel}: permission denied`,
  );
  return res.status(403).json({ message: `Permission denied. Required: "${REQUIRED_TAG}".` });
}

const DEFAULT_DOWNTIME_REASONS = [
  { code: 'breakdown', label: 'Breakdown' },
  { code: 'maintenance', label: 'Maintenance' },
  { code: 'no_operator', label: 'No Operator' },
  { code: 'no_power', label: 'No Power' },
  { code: 'other', label: 'Other' },
];

const POSTABLE_STATES = ['down', 'off', 'idle'];

function todayDateString() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function isValidDateString(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(new Date(s).getTime());
}

// ── GET /machines/board ─────────────────────────────────────────────────────
// Whole-shop board built from a fixed small number of set-based queries (no
// per-machine N+1). Effective state: an in_progress task means 'running'
// UNLESS the explicit state is 'down'/'off', which always wins (a machine
// marked down with a task still assigned is a data conflict the UI surfaces,
// not one this endpoint resolves).

router.get('/machines/board', protect, async (req, res) => {
  const user = req.user;

  if (!isAuthorized(user)) return denyPermission(res, user, 'machines/board');

  const companyId = user.companyId;
  if (!companyId) {
    return res.status(400).json({ message: 'Unable to determine companyId from token.' });
  }

  try {
    const [resources] = await pool.query(
      `SELECT id, name, code, plant_id AS plantId, resource_type_id AS resourceTypeId
         FROM fab_resources
        WHERE company_id = ? AND deleted_at IS NULL
        ORDER BY name ASC`,
      [companyId],
    );

    if (resources.length === 0) {
      return res.status(200).json({ ok: true, machines: [] });
    }

    // Latest non-superseded explicit state per resource, via a window function
    // (single query, no N+1) — ties on `at` broken by id DESC.
    const [latestEvents] = await pool.query(
      `SELECT resource_id AS resourceId, state, reason_code AS reasonCode, at
         FROM (
           SELECT resource_id, state, reason_code, at,
                  ROW_NUMBER() OVER (PARTITION BY resource_id ORDER BY at DESC, id DESC) AS rn
             FROM fab_resource_events
            WHERE company_id = ? AND deleted_at IS NULL AND superseded_by_event_id IS NULL
         ) ranked
        WHERE rn = 1`,
      [companyId],
    );

    const [inProgressTasks] = await pool.query(
      `SELECT t.id, t.assigned_resource_id AS assignedResourceId, op.name AS operationName,
              it.name AS itemName, it.mark AS itemMark, t.started_at AS startedAt
         FROM fab_project_tasks t
         LEFT JOIN fab_operations op ON t.operation_id = op.id
         LEFT JOIN fab_items it ON t.item_id = it.id
        WHERE t.company_id = ? AND t.status = 'in_progress'
          AND t.assigned_resource_id IS NOT NULL AND t.deleted_at IS NULL`,
      [companyId],
    );

    // Crew now comes from fab_worker_assignments — intervals, not flags — so a
    // person who left at 4pm or moved machines after lunch is reflected on the
    // board immediately, rather than only being expressible as a whole-day
    // absence. `absentToday` is retained as a name but now means "away right
    // now", which is what the board was always trying to say.
    const [operatorRows] = await pool.query(
      `SELECT a.resource_id AS resourceId, w.id AS workerId, w.user_id AS userId,
              w.name AS name, w.worker_type AS workerType, w.vendor_name AS vendorName
         FROM fab_worker_assignments a
         JOIN fab_workers w ON w.id = a.worker_id AND w.deleted_at IS NULL
        WHERE a.company_id = ? AND a.kind = 'assigned' AND a.deleted_at IS NULL
          AND a.from_ts <= UTC_TIMESTAMP() AND (a.to_ts IS NULL OR a.to_ts > UTC_TIMESTAMP())`,
      [companyId],
    );

    const [absentRows] = await pool.query(
      `SELECT worker_id AS workerId, reason
         FROM fab_worker_assignments
        WHERE company_id = ? AND kind = 'away' AND deleted_at IS NULL
          AND from_ts <= UTC_TIMESTAMP() AND (to_ts IS NULL OR to_ts > UTC_TIMESTAMP())`,
      [companyId],
    );

    const eventByResource = new Map(latestEvents.map((e) => [e.resourceId, e]));

    // Several in_progress tasks on one machine is a double-booking. Batching
    // (Issue 4) used to make it legitimate; that feature was removed 2026-08-05,
    // so any count above one means something is wrong again.
    //
    // Still keep the earliest-started task as the card's headline — it is the
    // one whose clock the run is measured on — and carry the count alongside so
    // the card can say how many are double-booked rather than silently naming
    // one and hiding the rest.
    const tasksByResource = new Map();
    for (const t of inProgressTasks) {
      if (!tasksByResource.has(t.assignedResourceId)) tasksByResource.set(t.assignedResourceId, []);
      tasksByResource.get(t.assignedResourceId).push(t);
    }

    const taskByResource = new Map();
    for (const [resourceId, list] of tasksByResource) {
      list.sort((a, b) => new Date(a.startedAt) - new Date(b.startedAt));
      const head = list[0];
      taskByResource.set(resourceId, {
        ...head,
        taskCount: list.length,
      });
    }

    // Away is per-PERSON, not per-machine — someone who went home is away from
    // every machine they're on, so this is keyed by worker rather than by pair.
    const awayByWorker = new Map(absentRows.map((r) => [r.workerId, r.reason]));

    const operatorsByResource = new Map();
    for (const o of operatorRows) {
      if (!operatorsByResource.has(o.resourceId)) operatorsByResource.set(o.resourceId, []);
      operatorsByResource.get(o.resourceId).push({
        workerId: o.workerId,
        userId: o.userId,
        name: o.name,
        workerType: o.workerType,
        vendorName: o.vendorName,
        isPrimary: false,
        absentToday: awayByWorker.has(o.workerId),
        awayReason: awayByWorker.get(o.workerId) ?? null,
      });
    }

    const machines = resources.map((r) => {
      const ev = eventByResource.get(r.id);
      const explicitState = ev ? ev.state : 'idle';
      const reasonCode = ev ? ev.reasonCode : null;
      const stateSince = ev ? ev.at : null;
      const task = taskByResource.get(r.id) ?? null;

      let effectiveState;
      if (explicitState === 'down' || explicitState === 'off') {
        effectiveState = explicitState;
      } else if (task) {
        effectiveState = 'running';
      } else {
        effectiveState = explicitState;
      }

      return {
        id: r.id,
        name: r.name,
        code: r.code,
        plantId: r.plantId,
        resourceTypeId: r.resourceTypeId,
        effectiveState,
        explicitState,
        reasonCode,
        stateSince,
        currentTask: task
          ? {
            id: task.id,
            operationName: task.operationName,
            itemName: task.itemName,
            itemMark: task.itemMark,
            startedAt: task.startedAt,
            taskCount: task.taskCount,
          }
          : null,
        operators: operatorsByResource.get(r.id) ?? [],
      };
    });

    return res.status(200).json({ ok: true, machines });
  } catch (err) {
    logger.error({ err, companyId }, 'fab_erp machines/board: unexpected error');
    return res.status(500).json({ message: 'Internal server error fetching machine board.' });
  }
});

// ── POST /machines/:id/state ────────────────────────────────────────────────
// Logs an explicit state change (down/off/idle — 'running' is derived, never
// posted). Returns the resulting effective state (idle collapses to
// 'running' if the machine still has an in_progress task assigned).

router.post('/machines/:id/state', protect, async (req, res) => {
  const user = req.user;

  if (!isAuthorized(user)) return denyPermission(res, user, 'machines/:id/state');

  const resourceId = Number(req.params.id);
  if (!req.params.id || isNaN(resourceId) || resourceId <= 0) {
    return res.status(400).json({ message: 'Machine id must be a positive integer.' });
  }

  const { state, reason_code, note, at } = req.body ?? {};

  if (!state || !POSTABLE_STATES.includes(state)) {
    return res.status(400).json({
      message: `state is required and must be one of: ${POSTABLE_STATES.join(', ')}.`,
    });
  }

  let eventAt = new Date();
  if (at !== undefined && at !== null && at !== '') {
    const parsed = new Date(at);
    if (isNaN(parsed.getTime())) {
      return res.status(400).json({ message: 'at must be a valid datetime.' });
    }
    if (parsed.getTime() > Date.now()) {
      return res.status(400).json({ message: 'at cannot be in the future.' });
    }
    eventAt = parsed;
  }

  const companyId = user.companyId;
  if (!companyId) {
    return res.status(400).json({ message: 'Unable to determine companyId from token.' });
  }

  try {
    const [resourceRows] = await pool.query(
      `SELECT id FROM fab_resources WHERE id = ? AND company_id = ? AND deleted_at IS NULL LIMIT 1`,
      [resourceId, companyId],
    );

    if (resourceRows.length === 0) {
      return res.status(404).json({ message: `Machine with id ${resourceId} not found.` });
    }

    await pool.query(
      `INSERT INTO fab_resource_events (company_id, resource_id, state, reason_code, at, source, entered_by, note)
       VALUES (?, ?, ?, ?, ?, 'live', ?, ?)`,
      [companyId, resourceId, state, reason_code ?? null, eventAt, user.id, note ?? null],
    );

    // EU-3: a state change re-attributes every waiting task on this machine
    // (fire-and-forget — never fails the state-log response).
    recomputeForResource(companyId, resourceId).catch((err) =>
      logger.error({ err, companyId, resourceId }, 'attribution recomputeForResource failed'),
    );

    // 'idle' can still collapse to 'running' if a task is in progress on this
    // machine — 'down'/'off' always win (mirrors GET /machines/board).
    let effectiveState = state;
    if (state === 'idle') {
      const [taskRows] = await pool.query(
        `SELECT id FROM fab_project_tasks
          WHERE company_id = ? AND assigned_resource_id = ? AND status = 'in_progress' AND deleted_at IS NULL
          LIMIT 1`,
        [companyId, resourceId],
      );
      if (taskRows.length > 0) effectiveState = 'running';
    }

    return res.status(200).json({
      ok: true,
      machineId: resourceId,
      explicitState: state,
      effectiveState,
    });
  } catch (err) {
    logger.error({ err, companyId, resourceId }, 'fab_erp machines/:id/state: unexpected error');
    return res.status(500).json({ message: 'Internal server error logging machine state.' });
  }
});

// ── POST /machines/:id/operator-absent ──────────────────────────────────────
// Marks (or clears) an operator absent on a given date. absent_on defaults to
// today (server date). clear=true soft-deletes the absence row; otherwise we
// try to un-soft-delete an existing row first and only insert if none existed.

router.post('/machines/:id/operator-absent', protect, async (req, res) => {
  const user = req.user;

  if (!isAuthorized(user)) return denyPermission(res, user, 'machines/:id/operator-absent');

  const resourceId = Number(req.params.id);
  if (!req.params.id || isNaN(resourceId) || resourceId <= 0) {
    return res.status(400).json({ message: 'Machine id must be a positive integer.' });
  }

  const { user_id, absent_on, clear } = req.body ?? {};
  const userId = Number(user_id);
  if (!user_id || isNaN(userId) || userId <= 0) {
    return res.status(400).json({ message: 'user_id is required and must be a positive integer.' });
  }

  let absentOn = absent_on;
  if (absentOn === undefined || absentOn === null || absentOn === '') {
    absentOn = todayDateString();
  } else if (!isValidDateString(absentOn)) {
    return res.status(400).json({ message: 'absent_on must be a YYYY-MM-DD date.' });
  }

  const companyId = user.companyId;
  if (!companyId) {
    return res.status(400).json({ message: 'Unable to determine companyId from token.' });
  }

  try {
    const [resourceRows] = await pool.query(
      `SELECT id FROM fab_resources WHERE id = ? AND company_id = ? AND deleted_at IS NULL LIMIT 1`,
      [resourceId, companyId],
    );
    if (resourceRows.length === 0) {
      return res.status(404).json({ message: `Machine with id ${resourceId} not found.` });
    }

    const [operatorUserRows] = await pool.query(
      `SELECT id FROM users WHERE id = ? AND company_id = ? AND deleted_at IS NULL LIMIT 1`,
      [userId, companyId],
    );
    if (operatorUserRows.length === 0) {
      return res.status(404).json({ message: `User with id ${userId} not found.` });
    }

    if (clear === true) {
      await pool.query(
        `UPDATE fab_resource_operators
            SET deleted_at = UTC_TIMESTAMP()
          WHERE company_id = ? AND resource_id = ? AND user_id = ? AND absent_on = ? AND deleted_at IS NULL`,
        [companyId, resourceId, userId, absentOn],
      );
      return res.status(200).json({ ok: true, resourceId, userId, absentOn, absent: false });
    }

    const [updateResult] = await pool.query(
      `UPDATE fab_resource_operators
          SET deleted_at = NULL
        WHERE company_id = ? AND resource_id = ? AND user_id = ? AND absent_on = ?`,
      [companyId, resourceId, userId, absentOn],
    );

    if (updateResult.affectedRows === 0) {
      // INSERT IGNORE: if a concurrent request already inserted this exact
      // row, the unique key silently skips the duplicate.
      await pool.query(
        `INSERT IGNORE INTO fab_resource_operators (company_id, resource_id, user_id, is_primary, absent_on)
         VALUES (?, ?, ?, 0, ?)`,
        [companyId, resourceId, userId, absentOn],
      );
    }

    return res.status(200).json({ ok: true, resourceId, userId, absentOn, absent: true });
  } catch (err) {
    logger.error({ err, companyId, resourceId, userId }, 'fab_erp machines/:id/operator-absent: unexpected error');
    return res.status(500).json({ message: 'Internal server error updating operator absence.' });
  }
});

// ── GET /machines/downtime-reasons ──────────────────────────────────────────
// Company-configured reason codes, falling back to the 5 built-in defaults
// when the company has none.

router.get('/machines/downtime-reasons', protect, async (req, res) => {
  const user = req.user;

  if (!isAuthorized(user)) return denyPermission(res, user, 'machines/downtime-reasons');

  const companyId = user.companyId;
  if (!companyId) {
    return res.status(400).json({ message: 'Unable to determine companyId from token.' });
  }

  try {
    const [rows] = await pool.query(
      `SELECT code, label
         FROM fab_resource_downtime_reasons
        WHERE company_id = ? AND deleted_at IS NULL AND active = 1
        ORDER BY label ASC`,
      [companyId],
    );

    const reasons = rows.length > 0 ? rows : DEFAULT_DOWNTIME_REASONS;

    return res.status(200).json({ ok: true, reasons });
  } catch (err) {
    logger.error({ err, companyId }, 'fab_erp machines/downtime-reasons: unexpected error');
    return res.status(500).json({ message: 'Internal server error fetching downtime reasons.' });
  }
});

export default router;
