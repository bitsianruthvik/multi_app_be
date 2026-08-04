/**
 * workers.js — the floor roster and who is on which machine.
 *
 *   GET    /workers                      roster (optionally ?resourceId= for one machine's crew)
 *   POST   /workers                      add somebody — including a vendor with no login
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

import { Router } from 'express';
import { protect } from '../../../core/middleware/authmiddleware.js';
import { pool } from '../../../db.js';
import { logger } from '../../../core/utils/logger.js';
import {
  crewForWindow, assignWorker, unassignWorker, setAway, removeInterval,
} from '../services/workerService.js';

const router = Router();
const TAG = 'fab_erp_machine_state_manage';

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
              a.resource_id AS currentResourceId, r.name AS currentResourceName
         FROM fab_workers w
         LEFT JOIN fab_worker_assignments a
                ON a.worker_id = w.id AND a.kind = 'assigned'
               AND a.deleted_at IS NULL AND a.to_ts IS NULL
         LEFT JOIN fab_resources r ON r.id = a.resource_id AND r.deleted_at IS NULL
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
    }
    return res.status(201).json({ ok: true, id: ins.insertId });
  } catch (err) {
    logger.error({ err, companyId }, 'fab_erp workers: create failed');
    return res.status(500).json({ message: 'Failed to add the worker.' });
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
    return res.json({ ok: true, ...out });
  } catch (err) {
    logger.error({ err, companyId, id }, 'fab_erp workers: remove interval failed');
    return res.status(500).json({ message: 'Failed to remove.' });
  }
});

export default router;
