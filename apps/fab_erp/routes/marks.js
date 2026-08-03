/**
 * marks.js — piece-mark endpoints (Issue 2).
 *
 *   POST /orders/:orderId/marks/generate   assign marks to unmarked items
 *   PATCH /items/:itemId/mark              set or clear one mark by hand
 *   GET  /orders/:orderId/cut-list         the marked parts, for the shop
 *
 * Generation is deliberately explicit rather than automatic on BOM save: marks
 * get painted onto steel, so minting them should be a decision someone makes,
 * not a side effect of editing a quantity.
 */

import { Router } from 'express';
import { protect } from '../../../core/middleware/authmiddleware.js';
import { pool } from '../../../db.js';
import { logger } from '../../../core/utils/logger.js';
import { generateMarksForOrder, setItemMark } from '../services/markService.js';

const router = Router();

/** Mirrors the permission style used across fab_erp routes. */
function requireManage(req, res) {
  const user = req.user;
  const isAdmin = user?.role && String(user.role).toLowerCase() === 'admin';
  if (isAdmin) return true;
  const granted =
    Array.isArray(user?.uiPermissions) && user.uiPermissions.includes('fab_erp_projects_manage');
  if (!granted) {
    res.status(403).json({ message: 'Permission denied. Required: "fab_erp_projects_manage".' });
    return false;
  }
  return true;
}

router.post('/orders/:orderId/marks/generate', protect, async (req, res) => {
  if (!requireManage(req, res)) return;

  const companyId = req.user.companyId ?? req.user.company_id;
  const orderId = Number(req.params.orderId);
  if (!orderId || Number.isNaN(orderId)) {
    return res.status(400).json({ message: 'A valid orderId is required.' });
  }

  try {
    const result = await generateMarksForOrder(companyId, orderId);
    return res.json({ ok: true, ...result });
  } catch (err) {
    logger?.error?.({ err, orderId }, 'fab_erp marks: generate failed');
    return res.status(500).json({ message: 'Failed to generate marks.' });
  }
});

router.patch('/items/:itemId/mark', protect, async (req, res) => {
  if (!requireManage(req, res)) return;

  const companyId = req.user.companyId ?? req.user.company_id;
  const itemId = Number(req.params.itemId);
  if (!itemId || Number.isNaN(itemId)) {
    return res.status(400).json({ message: 'A valid itemId is required.' });
  }

  try {
    const result = await setItemMark(companyId, itemId, req.body?.mark, {
      cascadeChildren: !!req.body?.cascadeChildren,
    });
    return res.json({ ok: true, ...result });
  } catch (err) {
    // A taken mark is a user-correctable conflict, not a server fault — 409 so
    // the dialog can show the message inline instead of a generic failure.
    if (err.code === 'MARK_TAKEN') return res.status(409).json({ message: err.message });
    if (err.code === 'NOT_FOUND') return res.status(404).json({ message: err.message });
    logger?.error?.({ err, itemId }, 'fab_erp marks: set failed');
    return res.status(500).json({ message: 'Failed to set mark.' });
  }
});

/**
 * The cut list: every marked part on an order, flat, ordered by mark.
 * This is the artefact the shop actually carries — so it leads with the mark,
 * not with an internal id, and includes the parent mark for context.
 */
router.get('/orders/:orderId/cut-list', protect, async (req, res) => {
  const companyId = req.user.companyId ?? req.user.company_id;
  const orderId = Number(req.params.orderId);
  if (!orderId || Number.isNaN(orderId)) {
    return res.status(400).json({ message: 'A valid orderId is required.' });
  }

  try {
    const [rows] = await pool.query(
      `SELECT i.id, i.mark, i.name, i.qty, i.unit,
              p.mark AS parentMark,
              ic.code AS catalogCode, ic.name AS catalogName
         FROM fab_items i
         LEFT JOIN fab_items p ON p.id = i.parent_item_id AND p.deleted_at IS NULL
         LEFT JOIN fab_item_catalog ic ON ic.id = i.catalog_item_id AND ic.deleted_at IS NULL
        WHERE i.company_id = ? AND i.order_id = ? AND i.deleted_at IS NULL
        ORDER BY i.mark IS NULL, i.mark_prefix, i.mark_seq, i.mark, i.id`,
      [companyId, orderId],
    );
    return res.json({ ok: true, items: rows });
  } catch (err) {
    logger?.error?.({ err, orderId }, 'fab_erp marks: cut-list failed');
    return res.status(500).json({ message: 'Failed to build cut list.' });
  }
});

export default router;
