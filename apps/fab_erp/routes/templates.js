/**
 * templates.js — build an order's structure from a BOM, generically.
 *
 *   GET  /templates                        what can be built
 *   GET  /templates/:itemId/parameters     the questions this one asks
 *   POST /templates/:itemId/preview        the shape it would produce (writes nothing)
 *   POST /orders/:orderId/instantiate      create it
 *
 * THE REPLACEMENT FOR buildWizardRows, which is a hardcoded four-level nest —
 * `span`, `girders`, `segmentsPerGirder` written into the source, an
 * `if (!girders)` branch for a PEB, and defaults of 6 and 5 typed into React
 * state. None of that is here. Depth is whatever the BOM has, the questions are
 * whatever the BOM asks, and a PEB is a template with no Girder line.
 *
 * PREVIEW WRITES NOTHING, and that is the shape of the whole thing: a person
 * sees the structure before it exists, so a wrong answer costs a re-run rather
 * than a half-built order. It is the same guarantee the old wizard gave by
 * producing a spreadsheet, kept without the spreadsheet.
 */

import { Router } from 'express';
import { protect } from '../../../core/middleware/authmiddleware.js';
import { pool } from '../../../db.js';
import { logger } from '../../../core/utils/logger.js';
import {
  parametersFor, expand, instantiate, bomFor,
} from '../services/bomService.js';
import { refreshOrderStage } from '../services/orderReadinessService.js';
import { orderCodePrefix } from '../services/itemCodeService.js';

const router = Router();
const companyId = (req) => req.user?.companyId ?? req.user?.company_id;

const requirePerm = (tag) => (req, res, next) => {
  if (!Array.isArray(req.user?.uiPermissions) || !req.user.uiPermissions.includes(tag)) {
    return res.status(403).json({ message: `Permission required: ${tag}` });
  }
  next();
};

const fail = (res, err, what) => {
  if (err.status) return res.status(err.status).json({ message: err.message });
  logger.error({ err }, `fab_erp: ${what} failed`);
  return res.status(500).json({ message: err.message });
};

/**
 * Catalog items that are templates — anything with BOM lines under it and
 * nothing above it.
 *
 * Derived rather than flagged. A separate `is_template` column would be a
 * second place to keep a fact the structure already states, and it would go
 * wrong the first time somebody made a Girder buildable on its own.
 */
router.get('/templates', protect, async (req, res) => {
  try {
    const cid = companyId(req);
    const [rows] = await pool.query(
      `SELECT c.id, c.code, c.name, c.level_kind AS levelKind,
              cat.name AS categoryName, cat.id AS categoryId,
              (SELECT COUNT(*) FROM fab_item_bom b
                WHERE b.company_id = c.company_id AND b.parent_item_id = c.id
                  AND b.deleted_at IS NULL AND b.active = 1) AS childLines
         FROM fab_item_catalog c
         LEFT JOIN fab_item_categories cat ON cat.id = c.category_id
        WHERE c.company_id = ? AND c.deleted_at IS NULL
          AND EXISTS (SELECT 1 FROM fab_item_bom b
                       WHERE b.company_id = c.company_id AND b.parent_item_id = c.id
                         AND b.deleted_at IS NULL AND b.active = 1)
          AND NOT EXISTS (SELECT 1 FROM fab_item_bom b2
                           WHERE b2.company_id = c.company_id AND b2.child_item_id = c.id
                             AND b2.deleted_at IS NULL AND b2.active = 1)
        ORDER BY cat.name, c.name`,
      [cid],
    );
    res.json({ templates: rows });
  } catch (err) { fail(res, err, 'templates'); }
});

/** The questions, and the immediate BOM, so a client can show what it is building. */
router.get('/templates/:itemId/parameters', protect, async (req, res) => {
  try {
    const cid = companyId(req);
    const itemId = Number(req.params.itemId);
    const [parameters, lines] = await Promise.all([
      parametersFor(cid, itemId),
      bomFor(cid, itemId),
    ]);
    res.json({ itemId, parameters, lines });
  } catch (err) { fail(res, err, 'template parameters'); }
});

/**
 * The shape it would produce. WRITES NOTHING.
 *
 * Returns counts and a shallow sample rather than the whole tree: a six-girder
 * span is 247 nodes, and a client that has to receive all of them to show
 * "247 items" is paying for something nobody reads. The sample is the first few
 * of each level, which is what makes the codes checkable at a glance.
 */
router.post('/templates/:itemId/preview', protect, async (req, res) => {
  try {
    const cid = companyId(req);
    const { params = {}, perInstance = {} } = req.body ?? {};
    const tree = await expand(cid, Number(req.params.itemId), params, { perInstance });

    const sample = [];
    const take = (node, depth) => {
      if (sample.filter((s) => s.depth === depth).length < 3) {
        sample.push({ depth, name: node.name, code: node.code });
      }
      node.children.forEach((c) => take(c, depth + 1));
    };
    take(tree.root, 0);

    res.json({ nodes: tree.nodes, byLevel: tree.byLevel, sample });
  } catch (err) { fail(res, err, 'template preview'); }
});

/**
 * Create the structure on an order line.
 *
 * The order's code prefix is resolved here rather than asked for, because it is
 * derived from the order and the customer and nobody should be able to type a
 * different one — a code that does not match its order is a code nobody can
 * find later.
 */
router.post(
  '/orders/:orderId/instantiate',
  protect,
  requirePerm('fab_erp_projects_manage'),
  async (req, res) => {
    try {
      const cid = companyId(req);
      const orderId = Number(req.params.orderId);
      const { itemId, orderLineId = null, params = {}, perInstance = {}, lineCode = null } = req.body ?? {};
      if (!itemId) return res.status(400).json({ message: 'itemId is required.' });

      // `<order prefix>-<line code>` — the line's own code is the top level of
      // the structure, exactly as the BOQ sheet's Span column always was.
      const prefix = await orderCodePrefix(cid, orderId);
      const codePrefix = lineCode ? `${prefix}-${lineCode}` : prefix;

      const result = await instantiate(cid, {
        orderId, orderLineId, rootItemId: Number(itemId), params, perInstance, codePrefix,
      });
      res.json({ ok: true, ...result, readiness: await refreshOrderStage(cid, orderId) });
    } catch (err) { fail(res, err, 'instantiate'); }
  },
);

export default router;
