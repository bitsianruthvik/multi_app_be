/**
 * templates.js — build an order's structure from a BOM, generically.
 *
 *   POST /templates/:itemId/preview        the shape it would produce (writes nothing)
 *   GET  /templates/:itemId/draft          the BOM as an editable tree (writes nothing)
 *   POST /orders/:orderId/build            write that tree onto the order
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
import multer from 'multer';
import { protect } from '../../../core/middleware/authmiddleware.js';
import { pool } from '../../../db.js';
import { logger } from '../../../core/utils/logger.js';
import {
  parametersFor, expand, bomFor, setBomLine, removeBomLine,
  draftTree, buildFromTree, currentTree, applyTree,
} from '../services/bomService.js';
import { refreshOrderStage } from '../services/orderReadinessService.js';
import { exportStructure, importStructure } from '../services/structureSheetService.js';
import { pickableItems, catalogSizes } from '../services/catalogPickerService.js';

const router = Router();
// In memory: the sheet is parsed and thrown away, never stored.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });
const companyId = (req) => req.user?.companyId ?? req.user?.company_id;

/**
 * Admin bypasses the tag, as it does on every other fab_erp write.
 *
 * `mutateController` has always let an admin through; this file did not, so the
 * same person could rename an item and not edit its BOM. One surface, one rule.
 */
const requirePerm = (tag) => (req, res, next) => {
  const isAdmin = req.user?.role && String(req.user.role).toLowerCase() === 'admin';
  if (isAdmin) return next();
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
    const { params = {}, perInstance = {}, structure = null } = req.body ?? {};
    const tree = await expand(cid, Number(req.params.itemId), params, {
      perInstance, spec: structure,
    });

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
 * GET /templates/:itemId/draft — the BOM as a tree to EDIT.
 *
 * One node per BOM line carrying its default quantity, NOT an expansion: a
 * Girder line comes back as one node reading ×6. That is the shape somebody
 * edits — change a 6 to a 4 in one place, not in six — and the shape the order
 * should end up in. Writes nothing.
 */
router.get('/templates/:itemId/draft', protect, async (req, res) => {
  try {
    const cid = companyId(req);
    res.json({ tree: await draftTree(cid, Number(req.params.itemId)) });
  } catch (err) { fail(res, err, 'draft tree'); }
});

/**
 * GET /orders/:orderId/structure/tree — what was decided, not what the
 * catalogue says. The editor loads this to EDIT rather than to rebuild.
 */
router.get('/orders/:orderId/structure/tree', protect, async (req, res) => {
  try {
    const cid = companyId(req);
    const tree = await currentTree(
      cid, Number(req.params.orderId),
      req.query.orderLineId ? Number(req.query.orderLineId) : null,
    );
    res.json({ tree });
  } catch (err) { return fail(res, err, 'structure tree'); }
});

/**
 * POST /orders/:orderId/structure/apply — save an edited structure.
 *
 * A DIFF, not a replace. A row still in the tree keeps its id, and with it the
 * dimensions somebody typed and the plate it was nested onto — replacing would
 * make changing one quantity cost all of that.
 */
router.post(
  '/orders/:orderId/structure/apply',
  protect,
  requirePerm('fab_erp_projects_manage'),
  async (req, res) => {
    try {
      const cid = companyId(req);
      const orderId = Number(req.params.orderId);
      const { tree, orderLineId = null } = req.body ?? {};
      const result = await applyTree(cid, { orderId, orderLineId, tree });
      res.json({ ok: true, ...result, readiness: await refreshOrderStage(cid, orderId) });
    } catch (err) {
      if (err.status === 409) {
        return res.status(409).json({ message: err.message, code: err.code });
      }
      return fail(res, err, 'structure apply');
    }
  },
);

/**
 * GET /orders/:orderId/structure/export — the structure as a sheet.
 *
 * Not the old BOQ sheet: that one's four code columns WERE the structure, and
 * both halves of that are gone — no codes at BOM time, and a row is a design
 * with a quantity rather than one piece. A level column carries the shape now.
 */
router.get(
  '/orders/:orderId/structure/export',
  protect,
  requirePerm('fab_erp_projects_manage'),
  async (req, res) => {
    try {
      const cid = companyId(req);
      const { buffer, filename } = await exportStructure(cid, Number(req.params.orderId));
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(Buffer.from(buffer));
    } catch (err) { return fail(res, err, 'structure export'); }
  },
);

/**
 * POST /orders/:orderId/structure/import — read one back.
 *
 * Parses the WHOLE sheet before writing anything. A structure half-imported
 * because row 180 named an item that does not exist is worse than one not
 * imported at all: the order looks built, and the missing branch is found by
 * somebody counting.
 */
router.post(
  '/orders/:orderId/structure/import',
  protect,
  requirePerm('fab_erp_projects_manage'),
  upload.single('excel_file'),
  async (req, res) => {
    try {
      const cid = companyId(req);
      const orderId = Number(req.params.orderId);
      if (!req.file?.buffer) return res.status(400).json({ message: 'No file was uploaded.' });

      const { tree, rows, dimsGiven } = await importStructure(cid, orderId, req.file.buffer);
      const result = await buildFromTree(cid, {
        orderId,
        orderLineId: req.body?.orderLineId ? Number(req.body.orderLineId) : null,
        tree,
        replace: String(req.body?.replace) === 'true',
      });
      res.json({
        ok: true, rowsInSheet: rows, dimsGiven, ...result,
        readiness: await refreshOrderStage(cid, orderId),
      });
    } catch (err) {
      if (err.status === 409) {
        return res.status(409).json({ message: err.message, code: err.code, existing: err.existing });
      }
      if (err.status === 400) return res.status(400).json({ message: err.message, problems: err.problems });
      return fail(res, err, 'structure import');
    }
  },
);

/**
 * POST /orders/:orderId/build — write the tree exactly as sent.
 *
 * The editor has already said what it wants. Re-deriving it from a spec here
 * would be a second chance to build something else.
 */
router.post(
  '/orders/:orderId/build',
  protect,
  requirePerm('fab_erp_projects_manage'),
  async (req, res) => {
    try {
      const cid = companyId(req);
      const orderId = Number(req.params.orderId);
      // No code prefix: the BOM step mints no codes at all. See buildFromTree.
      const { tree, orderLineId = null, replace = false } = req.body ?? {};
      const result = await buildFromTree(cid, {
        orderId, orderLineId, tree, replace: replace === true,
      });
      res.json({ ok: true, ...result, readiness: await refreshOrderStage(cid, orderId) });
    } catch (err) {
      if (err.status === 409) {
        return res.status(409).json({ message: err.message, code: err.code, existing: err.existing });
      }
      return fail(res, err, 'build structure');
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
      `SELECT id, code, name, unit FROM fab_item_catalog
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
 * GET /item-bom/:itemId/tree — the WHOLE recipe under one item, nested.
 *
 * The one-level endpoint above answers "what is directly inside this", which is
 * what a breadcrumb walk needs. It is the wrong shape for an editor: to change
 * a stiffener count somebody had to walk Span > Line > Segment, losing sight of
 * everything else, and could never see two levels at once.
 *
 * This is the same tree `draftTree` builds for an order's Structure step, from
 * the same recipe — so the BOM and the order that takes it are looking at one
 * thing rendered one way, rather than two screens that have to be kept in step.
 *
 * Every node carries its `bomLineId`, which is what makes the tree editable:
 * a row knows which line it came from, so a quantity typed on it writes back to
 * that line and nothing else.
 */
router.get('/item-bom/:itemId/tree', protect, async (req, res) => {
  try {
    const cid = companyId(req);
    const itemId = Number(req.params.itemId);
    if (!itemId) return res.status(400).json({ message: 'itemId is required.' });
    const tree = await draftTree(cid, itemId);
    return res.json({ ok: true, tree });
  } catch (err) { return fail(res, err, 'item BOM tree'); }
});

/**
 * POST /item-bom — add or edit one line.
 *
 * Validation lives in bomService, not here: exactly one of a fixed quantity or
 * a parameter, no self-containment, and no cycle. Those are properties of a
 * BOM rather than of an HTTP request, and every caller needs them.
 */
router.post('/item-bom', protect, requirePerm('fab_erp_items_meta_manage'), async (req, res) => {
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
      // What every item expanded from this line starts life being made by.
      defaultFlowId: b.defaultFlowId ?? null,
      // Sizes the recipe states, if it states any. A blank clears one.
      defaults: b.defaults ?? null,
    });
    return res.json({ ok: true });
  } catch (err) { return fail(res, err, 'item BOM save'); }
});

/** DELETE /item-bom/:id — remove one line. The child item itself is untouched. */
router.delete('/item-bom/:id', protect, requirePerm('fab_erp_items_meta_manage'), async (req, res) => {
  try {
    await removeBomLine(companyId(req), Number(req.params.id));
    return res.json({ ok: true });
  } catch (err) { return fail(res, err, 'item BOM delete'); }
});

/**
 * GET /catalog/pickable — everything a structure row may point at, with what it
 * takes to choose between two similar names: size, material, make or bought,
 * the flow its BOM usually gives it, and how used it is.
 *
 * `?orderId=` marks the items this order already has, so the picker can offer
 * those first.
 */
router.get("/catalog/pickable", protect, async (req, res) => {
  try {
    const orderId = req.query.orderId ? Number(req.query.orderId) : null;
    return res.json({ items: await pickableItems(companyId(req), orderId) });
  } catch (err) { return fail(res, err, "catalog pickable"); }
});

/** GET /catalog/sizes — id -> {thickness_mm,width_mm,length_mm,material,grade}, for search. */
router.get("/catalog/sizes", protect, async (req, res) => {
  try {
    const m = await catalogSizes(companyId(req));
    return res.json({ sizes: Object.fromEntries(m) });
  } catch (err) { return fail(res, err, "catalog sizes"); }
});

export default router;
