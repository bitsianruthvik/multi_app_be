/**
 * workers.js — the floor roster and who is on which machine.
 *
 *   GET    /workers                      roster (optionally ?resourceId= for one machine's crew)
 *   GET    /crew-coverage                machines with nobody on them (the pre-scheduling check)
 *   GET    /capacity-mode                calendar- or crew-derived capacity, + whether crew is safe yet
 *   POST   /capacity-mode                switch; refuses 'crew' while queued work has no crew
 *   POST   /workers                      add somebody — including a vendor with no login
 *   POST   /workers/bulk                 add many at once (the multi-add grid / Excel import)
 *   GET    /workers/:id                  one person + full interval history (incl. superseded)
 *   POST   /workers/:id/shift            put them on a shift (people own the calendar)
 *   PATCH  /workers/:id                  edit / deactivate
 *   POST   /workers/:id/assign           put them on a machine (moves them if already on another)
 *   POST   /workers/:id/unassign         take them off
 *   POST   /workers/:id/away             record time away (an hour, a day, a week)
 *   DELETE /worker-intervals/:id         withdraw an interval entered by mistake
 *
 * Permission: reads need `fab_erp_machine_state_manage` (the same tag that
 * already gates the Machine Board, where the crew is shown); writes need it too.
 * Deliberately NOT a new permission — rostering is part of running the board,
 * and a tag nobody has granted is a feature nobody can use.
 */

import path from 'path';
import { Router } from 'express';
import multer from 'multer';
import { protect } from '../../../core/middleware/authmiddleware.js';
import { exportWorkersTemplateHandler, importWorkersHandler } from '../controllers/workersImportController.js';
import { pool } from '../../../db.js';
import { logger } from '../../../core/utils/logger.js';
import {
  crewForWindow, assignWorker, unassignWorker, setAway, removeInterval,
  resourcesTouchedByWorker, crewCoverageGaps, assignShift, workerDetail,
} from '../services/workerService.js';
import { recomputeForResourceWindow } from '../services/taskAttributionService.js';
import {
  capacityMode, setCapacityMode, CAPACITY_CREW, CAPACITY_CALENDAR,
} from '../services/capacityService.js';

const router = Router();
const upload = multer({ dest: path.join(process.cwd(), 'tmp') });
const TAG = 'fab_erp_machine_state_manage';

/**
 * Re-derive wait attribution after a roster write.
 *
 * Until 2026-08-06 this file triggered NOTHING, while machineState.js and
 * shiftLog.js both called recomputeForResource. So assigning somebody, marking
 * them away, or backdating an assignment updated the roster and left every
 * already-computed `no_operator` segment exactly as it was — the roster said one
 * thing and the delay numbers derived from it said another, indefinitely. That
 * made backdated entry worthless: you could record what really happened and
 * nothing downstream would ever notice.
 *
 * The window matters. A live change only affects "now onward", but a backdated
 * one invalidates a past span, and the tasks in that span are usually `done` —
 * so this uses recomputeForResourceWindow (which ignores status) rather than
 * recomputeForResource (which only looks at still-waiting tasks).
 *
 * Fire-and-forget, like every other attribution trigger in this app: the roster
 * write is the user's action and must not fail or block because a downstream
 * recompute did.
 */
function recomputeAfterRosterChange(companyId, workerId, from, to = new Date()) {
  const windowStart = from < to ? from : to;
  const windowEnd = from < to ? to : from;
  Promise.resolve()
    .then(async () => {
      const resourceIds = await resourcesTouchedByWorker(companyId, workerId, windowStart, windowEnd);
      for (const resourceId of resourceIds) {
        await recomputeForResourceWindow(companyId, resourceId, windowStart, windowEnd);
      }
    })
    .catch((err) => logger.error(
      { err, companyId, workerId }, 'fab_erp workers: attribution recompute failed',
    ));
}

function requirePerm(req, res) {
  const user = req.user;
  if (user?.role && String(user.role).toLowerCase() === 'admin') return true;
  if (Array.isArray(user?.uiPermissions) && user.uiPermissions.includes(TAG)) return true;
  res.status(403).json({ message: `Permission denied. Required: "${TAG}".` });
  return false;
}

const WORKER_TYPES = new Set(['employee', 'contractor', 'vendor']);

// ── GET /workers ─────────────────────────────────────────────────────────────

router.get('/workers', protect, async (req, res) => {
  if (!requirePerm(req, res)) return;
  const companyId = req.user.companyId;
  const resourceId = Number(req.query.resourceId);

  try {
    // One machine's crew right now (or over an explicit window).
    if (resourceId > 0) {
      const from = req.query.from ? new Date(String(req.query.from)) : new Date();
      const to = req.query.to ? new Date(String(req.query.to)) : new Date(from.getTime() + 1000);
      const crew = await crewForWindow(pool, companyId, resourceId, from, to);
      return res.json({ ok: true, resourceId, crew });
    }

    // The whole roster, each with where they currently are.
    const [workers] = await pool.query(
      `SELECT w.id, w.name, w.code, w.worker_type AS workerType, w.vendor_name AS vendorName,
              w.user_id AS userId, w.phone, w.active,
              a.resource_id AS currentResourceId, r.name AS currentResourceName,
              ws.shift_id AS currentShiftId, sh.name AS currentShiftName,
              sh.start_time AS currentShiftStart, sh.end_time AS currentShiftEnd
         FROM fab_workers w
         LEFT JOIN fab_worker_assignments a
                ON a.worker_id = w.id AND a.kind = 'assigned'
               AND a.deleted_at IS NULL AND a.superseded_by_id IS NULL AND a.to_ts IS NULL
         LEFT JOIN fab_resources r ON r.id = a.resource_id AND r.deleted_at IS NULL
         LEFT JOIN fab_worker_shifts ws
                ON ws.worker_id = w.id AND ws.deleted_at IS NULL
               AND ws.superseded_by_id IS NULL AND ws.to_ts IS NULL
         LEFT JOIN fab_shifts sh ON sh.id = ws.shift_id AND sh.deleted_at IS NULL
        WHERE w.company_id = ? AND w.deleted_at IS NULL
        ORDER BY w.active DESC, w.name ASC`,
      [companyId],
    );
    return res.json({ ok: true, workers });
  } catch (err) {
    logger.error({ err, companyId }, 'fab_erp workers: list failed');
    return res.status(500).json({ message: 'Failed to load workers.' });
  }
});

// ── GET /crew-coverage ───────────────────────────────────────────────────────
// Which machines have nobody on them. Under the zero-capacity rule an unmanned
// machine cannot be scheduled at all, so this is what the Machine Board badge
// and the pre-scheduling check both read — one list, asked before the planner
// runs, instead of one NoCapacityError per task after it fails.

router.get('/crew-coverage', protect, async (req, res) => {
  if (!requirePerm(req, res)) return;
  const companyId = req.user.companyId;
  const from = req.query.from ? new Date(String(req.query.from)) : new Date();
  const to = req.query.to
    ? new Date(String(req.query.to))
    : new Date(from.getTime() + 7 * 24 * 60 * 60 * 1000);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    return res.status(400).json({ message: 'from/to must be valid times.' });
  }

  try {
    const gaps = await crewCoverageGaps(companyId, {
      from, to, onlyWithWork: req.query.onlyWithWork === 'true',
    });
    return res.json({
      ok: true,
      from: from.toISOString(),
      to: to.toISOString(),
      unmanned: gaps,
      blockingCount: gaps.filter((g) => g.waitingTasks > 0).length,
    });
  } catch (err) {
    logger.error({ err, companyId }, 'fab_erp workers: crew coverage failed');
    return res.status(500).json({ message: 'Failed to check crew coverage.' });
  }
});

// ── Capacity mode ────────────────────────────────────────────────────────────
// GET  /capacity-mode   what this company currently derives capacity from
// POST /capacity-mode   switch it — REFUSES to enable 'crew' while machines with
//                       queued work still have nobody on them

router.get('/capacity-mode', protect, async (req, res) => {
  if (!requirePerm(req, res)) return;
  const companyId = req.user.companyId;
  try {
    const mode = await capacityMode(companyId);
    const gaps = await crewCoverageGaps(companyId, {});
    const blocking = gaps.filter((g) => g.waitingTasks > 0);
    return res.json({
      ok: true,
      mode,
      // What would happen if you switched right now.
      unmannedMachines: gaps.length,
      blockingMachines: blocking.map((g) => ({ resourceId: g.resourceId, name: g.name, waitingTasks: g.waitingTasks })),
      canEnableCrew: blocking.length === 0,
    });
  } catch (err) {
    logger.error({ err, companyId }, 'fab_erp: capacity mode read failed');
    return res.status(500).json({ message: 'Failed to read the capacity mode.' });
  }
});

router.post('/capacity-mode', protect, async (req, res) => {
  if (!requirePerm(req, res)) return;
  const companyId = req.user.companyId;
  const mode = String(req.body?.mode ?? '');
  if (mode !== CAPACITY_CREW && mode !== CAPACITY_CALENDAR) {
    return res.status(400).json({ message: `mode must be "${CAPACITY_CREW}" or "${CAPACITY_CALENDAR}".` });
  }

  try {
    // THE GUARD. Under crew mode an unmanned machine has zero capacity, so
    // switching a company whose roster doesn't cover its working machines would
    // take those machines to zero, the leveller would find no working instant,
    // and every project routed through them would lose its finish date. That is
    // a recoverable mistake only if it is never made silently — so it is refused
    // here, with the list of machines to fix, rather than discovered afterwards
    // as a pile of NoCapacityErrors.
    //
    // Only machines with QUEUED WORK block. An idle or decommissioned machine
    // with no crew is not a problem to solve before switching.
    if (mode === CAPACITY_CREW) {
      const gaps = await crewCoverageGaps(companyId, {});
      const blocking = gaps.filter((g) => g.waitingTasks > 0);
      if (blocking.length > 0) {
        return res.status(409).json({
          code: 'CREW_COVERAGE_INCOMPLETE',
          message: `${blocking.length} machine${blocking.length === 1 ? ' has' : 's have'} queued work and nobody assigned. Assign crew to them before switching, or they will become unschedulable.`,
          machines: blocking.map((g) => ({ resourceId: g.resourceId, name: g.name, waitingTasks: g.waitingTasks })),
        });
      }
    }

    const saved = await setCapacityMode(companyId, mode, req.user.id);
    logger.info({ companyId, mode: saved, userId: req.user.id }, 'fab_erp: capacity mode changed');
    return res.json({ ok: true, mode: saved });
  } catch (err) {
    logger.error({ err, companyId }, 'fab_erp: capacity mode write failed');
    return res.status(500).json({ message: 'Failed to change the capacity mode.' });
  }
});

// ── POST /workers ────────────────────────────────────────────────────────────

router.post('/workers', protect, async (req, res) => {
  if (!requirePerm(req, res)) return;
  const companyId = req.user.companyId;
  const { name, code, workerType, vendorName, phone, userId, resourceId } = req.body ?? {};

  if (!name || !String(name).trim()) {
    return res.status(400).json({ message: 'A name is required.' });
  }
  const type = WORKER_TYPES.has(workerType) ? workerType : 'employee';

  try {
    const [ins] = await pool.query(
      `INSERT INTO fab_workers (company_id, name, code, worker_type, user_id, vendor_name, phone, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
      [
        companyId, String(name).trim(), code ? String(code).trim() : null, type,
        // A contractor has no login and must not be given one — the roster and
        // the login list are different sets (FAB_ERP_PEOPLE_PLAN.md §2A).
        Number(userId) > 0 ? Number(userId) : null,
        vendorName ? String(vendorName).trim() : null,
        phone ? String(phone).trim() : null,
      ],
    );
    // Adding somebody from a machine's crew panel should put them ON it — the
    // whole point is that rostering happens where you already are.
    if (Number(resourceId) > 0) {
      await assignWorker(companyId, { workerId: ins.insertId, resourceId: Number(resourceId), enteredBy: req.user.id });
      recomputeAfterRosterChange(companyId, ins.insertId, new Date());
    }
    return res.status(201).json({ ok: true, id: ins.insertId });
  } catch (err) {
    logger.error({ err, companyId }, 'fab_erp workers: create failed');
    return res.status(500).json({ message: 'Failed to add the worker.' });
  }
});

// ── POST /workers/bulk ───────────────────────────────────────────────────────
// Many people at once. Adding a crew of 40 one modal at a time is the reason
// roster data doesn't get entered, and an un-entered roster is what makes
// `no_operator` confidently wrong — so bulk entry is a correctness feature, not
// a convenience one.
//
// Validated whole-batch BEFORE anything is written: a sheet of 40 with a typo on
// row 37 must not leave 36 people half-created, because the operator's next move
// is to fix the typo and re-submit the whole sheet, which would then duplicate
// the first 36.

router.post('/workers/bulk', protect, async (req, res) => {
  if (!requirePerm(req, res)) return;
  const companyId = req.user.companyId;
  const rows = Array.isArray(req.body?.people) ? req.body.people : [];
  if (!rows.length) return res.status(400).json({ message: 'No people to add.' });
  if (rows.length > 500) return res.status(400).json({ message: 'At most 500 people per batch.' });

  const errors = [];
  const parsed = [];
  rows.forEach((r, i) => {
    const name = String(r?.name ?? '').trim();
    if (!name) { errors.push({ row: i + 1, message: 'A name is required.' }); return; }
    const workerType = WORKER_TYPES.has(r?.workerType) ? r.workerType : 'employee';
    parsed.push({
      name,
      code: r?.code ? String(r.code).trim() : null,
      workerType,
      vendorName: r?.vendorName ? String(r.vendorName).trim() : null,
      phone: r?.phone ? String(r.phone).trim() : null,
      shiftId: Number(r?.shiftId) > 0 ? Number(r.shiftId) : null,
      resourceId: Number(r?.resourceId) > 0 ? Number(r.resourceId) : null,
    });
  });
  if (errors.length) return res.status(400).json({ message: 'Some rows are not valid.', errors });

  try {
    const created = [];
    for (const p of parsed) {
      const [ins] = await pool.query(
        `INSERT INTO fab_workers (company_id, name, code, worker_type, vendor_name, phone, active)
         VALUES (?, ?, ?, ?, ?, ?, 1)`,
        [companyId, p.name, p.code, p.workerType, p.vendorName, p.phone],
      );
      const id = ins.insertId;
      if (p.shiftId) await assignShift(companyId, { workerId: id, shiftId: p.shiftId, enteredBy: req.user.id });
      if (p.resourceId) {
        await assignWorker(companyId, { workerId: id, resourceId: p.resourceId, enteredBy: req.user.id });
        recomputeAfterRosterChange(companyId, id, new Date());
      }
      created.push({ id, name: p.name });
    }
    return res.status(201).json({ ok: true, created: created.length, people: created });
  } catch (err) {
    logger.error({ err, companyId }, 'fab_erp workers: bulk create failed');
    return res.status(500).json({ message: 'Failed to add the people.' });
  }
});

// ── Excel roster load ────────────────────────────────────────────────────────
// Registered BEFORE /workers/:id so 'import-template' is never parsed as an id.

router.get('/workers/import-template', protect, (req, res, next) => {
  if (!requirePerm(req, res)) return;
  return exportWorkersTemplateHandler(req, res, next);
});

router.post('/workers/import', protect, upload.single('excel_file'), (req, res, next) => {
  if (!requirePerm(req, res)) return;
  return importWorkersHandler(req, res, next);
});

// ── GET /workers/:id ─────────────────────────────────────────────────────────
// One person, with every interval ever recorded — superseded and withdrawn rows
// included, so a correction is visible as a correction rather than as history
// that quietly changed.

router.get('/workers/:id', protect, async (req, res) => {
  if (!requirePerm(req, res)) return;
  const id = Number(req.params.id);
  if (!(id > 0)) return res.status(400).json({ message: 'A valid worker id is required.' });
  try {
    const detail = await workerDetail(req.user.companyId, id);
    if (!detail) return res.status(404).json({ message: 'Worker not found.' });
    return res.json({ ok: true, ...detail });
  } catch (err) {
    logger.error({ err, id }, 'fab_erp workers: detail failed');
    return res.status(500).json({ message: 'Failed to load the worker.' });
  }
});

// ── POST /workers/:id/shift ──────────────────────────────────────────────────

router.post('/workers/:id/shift', protect, async (req, res) => {
  if (!requirePerm(req, res)) return;
  const companyId = req.user.companyId;
  const workerId = Number(req.params.id);
  const shiftId = Number(req.body?.shiftId);
  if (!(workerId > 0) || !(shiftId > 0)) {
    return res.status(400).json({ message: 'workerId and shiftId are required.' });
  }
  const at = req.body?.at ? new Date(req.body.at) : new Date();
  if (Number.isNaN(at.getTime())) return res.status(400).json({ message: '"at" is not a valid time.' });

  try {
    const [[shift]] = await pool.query(
      `SELECT id FROM fab_shifts WHERE id = ? AND company_id = ? AND deleted_at IS NULL`,
      [shiftId, companyId],
    );
    if (!shift) return res.status(400).json({ message: 'That shift does not exist.' });

    const out = await assignShift(companyId, {
      workerId, shiftId, fromTs: at, note: req.body?.note, enteredBy: req.user.id,
    });
    // A shift change moves when this person counts as present, so every machine
    // they are on has to be re-derived over the affected span.
    recomputeAfterRosterChange(companyId, workerId, at);
    return res.json({ ok: true, ...out });
  } catch (err) {
    logger.error({ err, companyId, workerId }, 'fab_erp workers: shift assign failed');
    return res.status(500).json({ message: 'Failed to set the shift.' });
  }
});

// ── PATCH /workers/:id ───────────────────────────────────────────────────────

router.patch('/workers/:id', protect, async (req, res) => {
  if (!requirePerm(req, res)) return;
  const companyId = req.user.companyId;
  const id = Number(req.params.id);
  if (!(id > 0)) return res.status(400).json({ message: 'A valid worker id is required.' });

  const sets = [];
  const params = [];
  const body = req.body ?? {};
  if (body.name != null) { sets.push('name = ?'); params.push(String(body.name).trim()); }
  if (body.code !== undefined) { sets.push('code = ?'); params.push(body.code ? String(body.code).trim() : null); }
  if (body.workerType != null && WORKER_TYPES.has(body.workerType)) { sets.push('worker_type = ?'); params.push(body.workerType); }
  if (body.vendorName !== undefined) { sets.push('vendor_name = ?'); params.push(body.vendorName ? String(body.vendorName).trim() : null); }
  if (body.phone !== undefined) { sets.push('phone = ?'); params.push(body.phone ? String(body.phone).trim() : null); }
  if (body.active !== undefined) { sets.push('active = ?'); params.push(body.active ? 1 : 0); }
  if (!sets.length) return res.status(400).json({ message: 'Nothing to update.' });

  try {
    await pool.query(
      `UPDATE fab_workers SET ${sets.join(', ')} WHERE id = ? AND company_id = ? AND deleted_at IS NULL`,
      [...params, id, companyId],
    );
    return res.json({ ok: true });
  } catch (err) {
    logger.error({ err, companyId, id }, 'fab_erp workers: update failed');
    return res.status(500).json({ message: 'Failed to update the worker.' });
  }
});

// ── Assignment ───────────────────────────────────────────────────────────────

router.post('/workers/:id/assign', protect, async (req, res) => {
  if (!requirePerm(req, res)) return;
  const companyId = req.user.companyId;
  const workerId = Number(req.params.id);
  const resourceId = Number(req.body?.resourceId);
  if (!(workerId > 0) || !(resourceId > 0)) {
    return res.status(400).json({ message: 'workerId and resourceId are required.' });
  }
  try {
    const out = await assignWorker(companyId, {
      workerId, resourceId, fromTs: req.body?.at, note: req.body?.note, enteredBy: req.user.id,
    });
    // After the write, so the new interval is visible to the resource lookup.
    recomputeAfterRosterChange(companyId, workerId, req.body?.at ? new Date(req.body.at) : new Date());
    return res.json({ ok: true, ...out });
  } catch (err) {
    logger.error({ err, companyId, workerId }, 'fab_erp workers: assign failed');
    return res.status(500).json({ message: 'Failed to assign.' });
  }
});

router.post('/workers/:id/unassign', protect, async (req, res) => {
  if (!requirePerm(req, res)) return;
  const companyId = req.user.companyId;
  const workerId = Number(req.params.id);
  const resourceId = Number(req.body?.resourceId);
  if (!(workerId > 0) || !(resourceId > 0)) {
    return res.status(400).json({ message: 'workerId and resourceId are required.' });
  }
  try {
    const out = await unassignWorker(companyId, { workerId, resourceId, at: req.body?.at });
    recomputeAfterRosterChange(companyId, workerId, req.body?.at ? new Date(req.body.at) : new Date());
    return res.json({ ok: true, ...out });
  } catch (err) {
    logger.error({ err, companyId, workerId }, 'fab_erp workers: unassign failed');
    return res.status(500).json({ message: 'Failed to unassign.' });
  }
});

// ── Away ─────────────────────────────────────────────────────────────────────

router.post('/workers/:id/away', protect, async (req, res) => {
  if (!requirePerm(req, res)) return;
  const companyId = req.user.companyId;
  const workerId = Number(req.params.id);
  if (!(workerId > 0)) return res.status(400).json({ message: 'A valid worker id is required.' });

  const from = req.body?.from ? new Date(req.body.from) : null;
  if (!from || Number.isNaN(from.getTime())) {
    return res.status(400).json({ message: 'A valid "from" time is required.' });
  }
  let to = null;
  if (req.body?.to) {
    to = new Date(req.body.to);
    if (Number.isNaN(to.getTime())) return res.status(400).json({ message: '"to" is not a valid time.' });
    if (to <= from) return res.status(400).json({ message: '"to" must be after "from".' });
  }

  try {
    const out = await setAway(companyId, {
      workerId, fromTs: from, toTs: to, reason: req.body?.reason, note: req.body?.note, enteredBy: req.user.id,
    });
    // An `away` has no resource_id, but it invalidates `no_operator` on every
    // machine this person was assigned to across the away span — which is why
    // the recompute resolves machines from the worker rather than the request.
    recomputeAfterRosterChange(companyId, workerId, from, to ?? new Date());
    return res.json({ ok: true, ...out });
  } catch (err) {
    logger.error({ err, companyId, workerId }, 'fab_erp workers: away failed');
    return res.status(500).json({ message: 'Failed to record time away.' });
  }
});

router.delete('/worker-intervals/:id', protect, async (req, res) => {
  if (!requirePerm(req, res)) return;
  const companyId = req.user.companyId;
  const id = Number(req.params.id);
  if (!(id > 0)) return res.status(400).json({ message: 'A valid interval id is required.' });
  try {
    const out = await removeInterval(companyId, id);
    // Recompute over the span the withdrawn interval used to cover — `was` is
    // captured before the soft-delete because a deleted row is invisible to the
    // machine lookup.
    if (out.was) {
      recomputeAfterRosterChange(
        companyId, out.was.workerId,
        new Date(out.was.fromTs), out.was.toTs ? new Date(out.was.toTs) : new Date(),
      );
    }
    return res.json({ ok: true, removed: out.removed });
  } catch (err) {
    logger.error({ err, companyId, id }, 'fab_erp workers: remove interval failed');
    return res.status(500).json({ message: 'Failed to remove.' });
  }
});

export default router;
