/**
 * templates.js — build an order's structure from a BOM, generically.
 *
 *   GET  /templates                        what can be built
 *   GET  /templates/:itemId/parameters     the questions this one asks
 *   POST /templates/:itemId/preview        the shape it would produce (writes nothing)
 *   POST /orders/:orderId/instantiate      create it
 *
 *   GET    /item-bom/:itemId               the lines under one catalog item
 *   POST   /item-bom                       add or edit a line
 *   DELETE /item-bom/:id                   remove a line
 *
 * There is deliberately no /item-bom preview: /templates/:itemId/preview already
 * expands any catalog item, and a second implementation of "what would this
 * build" is exactly the duplication that let a Span look like it had no BOM.
 *
 * The item-bom four are the EDITOR's half. `fab_item_bom` had no surface at all
 * until now — no route, and not in resourceDef, so the generic API could not
 * reach it either. The catalog page's "Bill of Materials" tab was pointed at
 * `fab_material_boms`, a different table holding zero rows, so a Span with a
 * perfectly good BOM read as having none.
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
  parametersFor, expand, instantiate, bomFor, setBomLine, removeBomLine,
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

    res.json({ nodes: tree.nodes, byName: tree.byName, sample });
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
      const {
        itemId, orderLineId = null, params = {}, perInstance = {}, lineCode = null,
        replace = false,
      } = req.body ?? {};
      if (!itemId) return res.status(400).json({ message: 'itemId is required.' });

      // `<order prefix>-<line code>` — the line's own code is the top level of
      // the structure, exactly as the BOQ sheet's Span column always was.
      const prefix = await orderCodePrefix(cid, orderId);
      const codePrefix = lineCode ? `${prefix}-${lineCode}` : prefix;

      const result = await instantiate(cid, {
        orderId, orderLineId, rootItemId: Number(itemId), params, perInstance, codePrefix,
        replace: replace === true,
      });
      res.json({ ok: true, ...result, readiness: await refreshOrderStage(cid, orderId) });
    } catch (err) {
      // ALREADY_BUILT and WORK_STARTED carry a code the dialog offers a choice on,
      // so they travel as more than a message.
      if (err.status === 409) {
        return res.status(409).json({ message: err.message, code: err.code, existing: err.existing });
      }
      return fail(res, err, 'instantiate');
    }
  },
);


/**
 * GET /item-bom/:itemId — the lines directly under one catalog item.
 *
 * Everything needed to edit them, plus the children's own line COUNT so the
 * editor can show which rows go deeper without a request per row. A Segment
 * with seven parts under it and a Top Flange with none look identical in a flat
 * list, and the difference is the whole structure.
 */
router.get('/item-bom/:itemId', protect, async (req, res) => {
  try {
    const cid = companyId(req);
    const parentItemId = Number(req.params.itemId);
    if (!parentItemId) return res.status(400).json({ message: 'itemId is required.' });

    const lines = await bomFor(cid, parentItemId);
    const childIds = lines.map((l) => l.childItemId);
    let childCounts = new Map();
    if (childIds.length) {
      const [rows] = await pool.query(
        `SELECT parent_item_id AS id, COUNT(*) AS n FROM fab_item_bom
          WHERE company_id = ? AND parent_item_id IN (?) AND deleted_at IS NULL
          GROUP BY parent_item_id`,
        [cid, childIds],
      );
      childCounts = new Map(rows.map((r) => [Number(r.id), Number(r.n)]));
    }

    const [[parent]] = await pool.query(
      `SELECT id, code, name, unit, level_kind AS levelKind FROM fab_item_catalog
        WHERE company_id = ? AND id = ? AND deleted_at IS NULL`,
      [cid, parentItemId],
    );
    if (!parent) return res.status(404).json({ message: 'That item does not exist.' });

    return res.json({
      ok: true,
      parent,
      lines: lines.map((l) => ({ ...l, childLineCount: childCounts.get(Number(l.childItemId)) ?? 0 })),
      /** The questions the whole tree under this item would ask. */
      parameters: await parametersFor(cid, parentItemId),
    });
  } catch (err) { return fail(res, err, 'item BOM read'); }
});

/**
 * POST /item-bom — add or edit one line.
 *
 * Validation lives in bomService, not here: exactly one of a fixed quantity or
 * a parameter, no self-containment, and no cycle. Those are properties of a
 * BOM rather than of an HTTP request, and every caller needs them.
 */
router.post('/item-bom', protect, requirePerm('fab_erp_projects_manage'), async (req, res) => {
  try {
    const cid = companyId(req);
    const b = req.body ?? {};
    if (!b.parentItemId || !b.childItemId) {
      return res.status(400).json({ message: 'parentItemId and childItemId are required.' });
    }
    await setBomLine(cid, {
      id: b.id ?? null,
      parentItemId: Number(b.parentItemId),
      childItemId: Number(b.childItemId),
      qtyNum: b.qtyNum,
      qtyParam: b.qtyParam,
      defaultQty: b.defaultQty,
      perInstanceQty: !!b.perInstanceQty,
      codeSegment: b.codeSegment ?? null,
      helpText: b.helpText ?? null,
      sortOrder: b.sortOrder ?? 0,
    });
    return res.json({ ok: true });
  } catch (err) { return fail(res, err, 'item BOM save'); }
});

/** DELETE /item-bom/:id — remove one line. The child item itself is untouched. */
router.delete('/item-bom/:id', protect, requirePerm('fab_erp_projects_manage'), async (req, res) => {
  try {
    await removeBomLine(companyId(req), Number(req.params.id));
    return res.json({ ok: true });
  } catch (err) { return fail(res, err, 'item BOM delete'); }
});

export default router;
