/**
 * orderItems.js — Items/BOM tree bulk export/import via Excel, scoped to one sales order.
 *
 * GET  /orders/:orderId/items/export-template  — download a fill-in .xlsx template
 *                                                  (Level 1..N sheets + Raw Material +
 *                                                   Flows reference + Instructions)
 * POST /orders/:orderId/items/import            — upload a filled template; builds the
 *                                                  order's fab_items parent/child tree
 *                                                  (form field `mode`: append | replace)
 * POST /orders/:orderId/items/recompute-weights — re-run the bottom-up weight roll-up
 *
 * All require: fab_erp_projects_manage
 */

import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import { protect } from '../../../core/middleware/authmiddleware.js';
import { logger } from '../../../core/utils/logger.js';
import { pool } from '../../../db.js';
import { missingFieldsForOrder } from '../services/itemFieldService.js';
import { demandFor } from '../services/partIdentityService.js';
import { duplicateSubtree } from '../services/bomService.js';
import { blankPlan } from '../services/blankPlanService.js';
import { exportPlan, importPlan } from '../services/blankSheetService.js';
import { acceptNestingPlan } from '../services/blankService.js';
import { refreshOrderStage } from '../services/orderReadinessService.js';
import {
  exportOrderItemsTemplateHandler,
  importOrderItemsHandler,
  recomputeOrderWeightsHandler,
  orderWeightSummaryHandler,
  generateOrderItemCodesHandler,
  orderNestingHandler,
  exportNestingHandler,
  importNestingHandler,
  flowSummaryHandler,
  syncFlowsFromBomHandler,
  setItemFlowHandler,
  setItemSpecHandler,
  getItemSpecHandler,
  deleteOrderHandler,
  parameterGridHandler,
  exportParametersHandler,
  importParametersHandler,
  setParametersHandler,
  similarGroupsHandler,
  markSimilarHandler,
  orderReadinessHandler,
  confirmOrderHandler,
  nestingBoardHandler,
  suggestNestingHandler,
  acceptNestingHandler,
  assignPartsHandler,
  updateNestHandler,
  clearNestHandler,
} from '../controllers/orderItemsImportController.js';

const router = Router();
const upload = multer({ dest: path.join(process.cwd(), 'tmp') });

const requirePerm = (tag) => (req, res, next) => {
  if (!Array.isArray(req.user?.uiPermissions) || !req.user.uiPermissions.includes(tag)) {
    return res.status(403).json({ message: `Permission required: ${tag}` });
  }
  next();
};

router.get('/orders/:orderId/items/export-template', protect, requirePerm('fab_erp_projects_manage'), exportOrderItemsTemplateHandler);
router.post('/orders/:orderId/items/import', protect, requirePerm('fab_erp_projects_manage'), upload.single('excel_file'), importOrderItemsHandler);
router.post('/orders/:orderId/items/recompute-weights', protect, requirePerm('fab_erp_projects_manage'), recomputeOrderWeightsHandler);
/*
 * THE BOQ SHEET'S ROUTES ARE GONE — export, import, and the two wizard ones.
 *
 * That sheet's four code columns (span / girder / segment / part) WERE the
 * structure: position baked into every code, one row per piece. The BOM step
 * no longer works that way — a row is a design, the quantity lives on the row,
 * and codes are issued at production-order time — so an importer speaking the
 * old language would undo it on the first upload.
 *
 * boqSheetService is left on disk unreferenced, so the rewrite has something to
 * read. It wants to speak blanks, lots and quantities.
 */

// ── Nesting: stage 2, its own document (2026-08) ───────────────────────────
router.get('/orders/:orderId/nesting/export', protect, requirePerm('fab_erp_projects_manage'), exportNestingHandler);
router.post('/orders/:orderId/nesting/import', protect, requirePerm('fab_erp_projects_manage'), upload.single('excel_file'), importNestingHandler);

/**
 * What an assembly NEEDS, for a screen that used to read its children.
 *
 * Identical parts are consolidated onto the line, so a diaphragm has no
 * children at all and a tree that asks for them shows an empty assembly — which
 * reads as nothing wrong rather than as a question asked in the wrong place.
 */
router.get('/orders/:orderId/items/:itemId/demand', protect, async (req, res) => {
  try {
    const cid = req.user?.companyId ?? req.user?.company_id;
    const itemId = Number(req.params.itemId);
    const map = await demandFor(cid, [itemId]);
    res.json({ itemId, parts: map.get(itemId) ?? [] });
  } catch (err) {
    return res.status(err.status ?? 500).json({ message: err.message });
  }
});

// The drag-and-drop board (2026-08-10). Reading it is a view action; arranging
// plates is not.
router.get('/orders/:orderId/nesting/board', protect, nestingBoardHandler);
router.post('/orders/:orderId/nesting/assign', protect, requirePerm('fab_erp_projects_manage'), assignPartsHandler);
router.patch('/orders/:orderId/nests/:nestNo', protect, requirePerm('fab_erp_projects_manage'), updateNestHandler);
router.delete('/orders/:orderId/nests/:nestNo', protect, requirePerm('fab_erp_projects_manage'), clearNestHandler);

// The suggestor (2026-08-21) — a third way to fill the board alongside the
// Excel import and dragging plates by hand, not a replacement for either.
// Proposing writes nothing, so it needs only the permission to look; accepting
// repoints material and is an arranging action like the rest.
router.get('/orders/:orderId/nesting/suggest', protect, suggestNestingHandler);
router.post('/orders/:orderId/nesting/suggest/accept', protect, requirePerm('fab_erp_projects_manage'), acceptNestingHandler);

/**
 * THE BLANKS (2026-09-10) — nesting as it now works.
 *
 * `GET  /orders/:orderId/blanks`          what has to be cut, and from what
 * `POST /orders/:orderId/blanks/accept`   make it real and raise the work
 *
 * These replace the board and the suggestor for new work. The difference is the
 * BLANK: the old pair link a plate straight to each part, so 960 identical
 * stiffeners are 960 claims on steel and the rectangle they share exists
 * nowhere. Reading writes nothing, so it needs only the permission to look.
 *
 * NOTE the two are not yet mutually exclusive at the data level — both wipe a
 * part's material rows before writing their own, so using the old board on an
 * order that has been through here would undo the blanks. The old screens are
 * on their way out; until they are gone, one order should use one of them.
 */
router.get('/orders/:orderId/blanks', protect, async (req, res) => {
  try {
    const plan = await blankPlan((req.user?.companyId ?? req.user?.company_id), Number(req.params.orderId), { effort: req.query?.effort });
    return res.json({ ok: true, ...plan });
  } catch (err) {
    logger.error({ err }, 'fab_erp: blank plan');
    return res.status(err.status ?? 500).json({ message: err.message });
  }
});

router.post('/orders/:orderId/blanks/accept', protect, requirePerm('fab_erp_projects_manage'),
  async (req, res) => {
    try {
      const out = await acceptNestingPlan(
        (req.user?.companyId ?? req.user?.company_id), Number(req.params.orderId), req.body?.plan ?? {},
      );
      return res.json({ ok: true, ...out });
    } catch (err) {
      logger.error({ err }, 'fab_erp: accept nesting plan');
      return res.status(err.status ?? 500).json({ message: err.message });
    }
  });

/**
 * THE PLAN AS A SPREADSHEET — the second way in.
 *
 * `GET  /orders/:orderId/blanks/sheet`    download the plan to edit
 * `POST /orders/:orderId/blanks/sheet`    upload a filled one and apply it
 *
 * The packer does not know that the 40 mm is stacked behind the 25 mm, or that
 * the cutter wants the diaphragm plates in one setup. A planner who cannot say
 * so keeps the real plan in a spreadsheet beside the software, and then the
 * software describes a job nobody is doing.
 *
 * Upload APPLIES the plan, so it needs the same permission as accepting one.
 */
router.get('/orders/:orderId/blanks/sheet', protect, async (req, res) => {
  try {
    const { buffer, filename } = await exportPlan(
      (req.user?.companyId ?? req.user?.company_id), Number(req.params.orderId),
      { effort: req.query?.effort },
    );
    res.setHeader('Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.send(Buffer.from(buffer));
  } catch (err) {
    logger.error({ err }, 'fab_erp: cutting plan export');
    return res.status(err.status ?? 500).json({ message: err.message });
  }
});

router.post('/orders/:orderId/blanks/sheet', protect, requirePerm('fab_erp_projects_manage'),
  upload.single('excel_file'), async (req, res) => {
    try {
      if (!req.file?.buffer) return res.status(400).json({ message: 'No file was uploaded.' });
      const cid = req.user?.companyId ?? req.user?.company_id;
      const orderId = Number(req.params.orderId);
      const read = await importPlan(cid, orderId, req.file.buffer);
      const out = await acceptNestingPlan(cid, orderId, read.plan);
      return res.json({ ok: true, ...out, fromSheet: { rows: read.rows, sheets: read.sheets, short: read.short } });
    } catch (err) {
      logger.error({ err }, 'fab_erp: cutting plan import');
      return res.status(err.status ?? 500).json({ message: err.message, problems: err.problems });
    }
  });

// ── Flow allocation: stage 3 (2026-08) ─────────────────────────────────────
router.get('/orders/:orderId/flows/summary', protect, flowSummaryHandler);
router.post('/orders/:orderId/flows/apply', protect, requirePerm('fab_erp_projects_manage'), syncFlowsFromBomHandler);
router.post('/items/:itemId/flow', protect, requirePerm('fab_erp_projects_manage'), setItemFlowHandler);

/**
 * WHAT THE STEEL IS — material, grade, thickness — on a line or on one part.
 *
 * This replaced `POST /items/:itemId/material`, which pointed a part at a
 * specific catalogue item before nesting. That is no longer a question the BOM
 * stage can answer: a catalogue item is now a SIZE as well as a material, and
 * which size to buy depends on what else is cut from the same sheet. Nesting
 * makes the link, and refuses any plate that disagrees with these three values.
 *
 * `lines` is the one people will use. An order is normally one steel throughout,
 * so it is stated once there and every part inherits it; `items` is for the part
 * that genuinely differs.
 *
 * Two routes rather than one `:scope(lines|items)` — Express 5 uses
 * path-to-regexp v8, which dropped inline patterns and throws at mount time.
 */
/**
 * GET /steel-options — the material and grade values that actually exist.
 *
 * Both were free text on the order line, and that is a correctness problem now
 * rather than a tidiness one: a BLANK's identity is material + grade + size, so
 * "E350 BO", "E350BO" and "e350 bo" would mint three catalog items for one piece
 * of steel. The list is short and real — read off the raw materials somebody
 * can actually buy — so there is no reason to let anyone type a fourth spelling.
 *
 * Grades come back PER MATERIAL, not as one flat list. Today every grade pairs
 * with MS and the distinction is invisible; the first time a second material
 * arrives it stops being.
 */
router.get('/steel-options', protect, async (req, res) => {
  try {
    const cid = req.user?.companyId ?? req.user?.company_id;
    const [rows] = await pool.query(
      `SELECT mat.value_text AS material, gr.value_text AS grade, COUNT(*) AS items
         FROM fab_item_catalog ci
         JOIN fab_item_categories k
               ON k.id = ci.category_id AND k.name = 'Raw Materials' AND k.deleted_at IS NULL
         JOIN fab_field_values mat
               ON mat.company_id = ci.company_id AND mat.scope = 'catalog_item'
              AND mat.scope_id = ci.id AND mat.deleted_at IS NULL
         JOIN fab_fields fm ON fm.id = mat.field_id AND fm.field_key = 'material'
         JOIN fab_field_values gr
               ON gr.company_id = ci.company_id AND gr.scope = 'catalog_item'
              AND gr.scope_id = ci.id AND gr.deleted_at IS NULL
         JOIN fab_fields fg ON fg.id = gr.field_id AND fg.field_key = 'grade'
        WHERE ci.company_id = ? AND ci.deleted_at IS NULL
          AND mat.value_text <> '' AND gr.value_text <> ''
        GROUP BY mat.value_text, gr.value_text
        ORDER BY items DESC`,
      [cid],
    );
    const byMaterial = {};
    for (const r of rows) {
      byMaterial[r.material] = [...(byMaterial[r.material] ?? []), r.grade];
    }
    res.json({
      materials: Object.keys(byMaterial).sort(),
      grades: [...new Set(rows.map((r) => r.grade))].sort(),
      byMaterial,
    });
  } catch (err) {
    logger.error({ err }, 'fab_erp: steel options failed');
    res.status(500).json({ message: err.message });
  }
});

router.get('/spec/lines/:id', protect, getItemSpecHandler('lines'));
router.get('/spec/items/:id', protect, getItemSpecHandler('items'));
router.post('/spec/lines/:id', protect, requirePerm('fab_erp_projects_manage'), setItemSpecHandler('lines'));
router.post('/spec/items/:id', protect, requirePerm('fab_erp_projects_manage'), setItemSpecHandler('items'));


// ── parameters: grid, spreadsheet, and marking copies ──────────────────────
//
// The grid asks each part only for what ITS flow needs. The sheet exists
// because a column of three hundred numbers is typed far faster than three
// hundred fields, and people already have the values in a spreadsheet.
router.get('/orders/:orderId/parameters', protect, parameterGridHandler);
router.get('/orders/:orderId/parameters/export', protect, requirePerm('fab_erp_projects_manage'), exportParametersHandler);
router.post('/orders/:orderId/parameters/import', protect, requirePerm('fab_erp_projects_manage'), upload.single('excel_file'), importParametersHandler);
router.post('/orders/:orderId/parameters', protect, requirePerm('fab_erp_projects_manage'), setParametersHandler);

// Marking girders or segments as copies of each other. One decision typed
// once instead of thirty times.
router.get('/orders/:orderId/similar', protect, similarGroupsHandler);
router.post('/orders/:orderId/similar', protect, requirePerm('fab_erp_projects_manage'), markSimilarHandler);

// ── The wizard: where the order stands, and the act that ends it (2026-08) ──
// Readiness is read-only, so it is gated on view, not manage.
router.get('/orders/:orderId/readiness', protect, orderReadinessHandler);
router.post('/orders/:orderId/confirm', protect, requirePerm('fab_erp_projects_manage'), confirmOrderHandler);

/**
 * Deleting a sales order removes the whole tree beneath it.
 *
 * The generic row delete is not adequate here and was doing real damage: it left
 * the order's tasks and reservations live, so a deleted job went on holding steel
 * and loading machines. See orderDeleteService for what is deleted, what is
 * released, and what is deliberately kept.
 */
router.delete('/orders/:orderId', protect, requirePerm('fab_erp_projects_manage'), deleteOrderHandler);

/**
 * POST /orders/:orderId/items/:itemId/duplicate — copy a row and its subtree.
 *
 * The copy lands beside the original, under the same parent. "Six of these and
 * four of those" is: copy the row, change the copy — the same gesture the
 * structure editor gives before anything is written, offered again on the tree
 * after it has been.
 */
router.post(
  '/orders/:orderId/items/:itemId/duplicate',
  protect,
  requirePerm('fab_erp_projects_manage'),
  async (req, res) => {
    try {
      const cid = req.user?.companyId ?? req.user?.company_id;
      const orderId = Number(req.params.orderId);
      const result = await duplicateSubtree(cid, orderId, Number(req.params.itemId));
      res.json({ ok: true, ...result, readiness: await refreshOrderStage(cid, orderId) });
    } catch (err) {
      if (err.status) return res.status(err.status).json({ message: err.message });
      logger.error({ err }, 'fab_erp: duplicate subtree failed');
      return res.status(500).json({ message: err.message });
    }
  },
);

router.post('/orders/:orderId/items/generate-codes', protect, requirePerm('fab_erp_projects_manage'), generateOrderItemCodesHandler);
// Read-only: gated on view, not manage — anyone who can open the order sees its tonnage.
router.get('/orders/:orderId/items/weight-summary', protect, orderWeightSummaryHandler);
// Read-only too — seeing what the order is waiting on is not a manage action.
router.get('/orders/:orderId/items/nesting', protect, orderNestingHandler);

/**
 * GET /orders/:orderId/field-readiness — can this order be estimated honestly?
 *
 * The answer nobody could get before. A missing field value does not error: the
 * formula engine defaults unknown symbols to 0 so `IF()` fallbacks can work, so
 * a part with no thickness is not rejected — it is estimated as free to cut, and
 * every date computed from it downstream is fiction.
 *
 * Read-only and ungated beyond `protect`: knowing an order cannot be estimated
 * is not a manage action, and the people who most need to see it are often the
 * ones who cannot raise the production order.
 */
router.get('/orders/:orderId/field-readiness', protect, async (req, res) => {
  const companyId = req.user?.companyId;
  if (!companyId) return res.status(400).json({ message: 'Unable to determine companyId from token.' });
  const orderId = Number(req.params.orderId);
  if (!(orderId > 0)) return res.status(400).json({ message: 'orderId is required.' });
  try {
    return res.json({ ok: true, orderId, ...(await missingFieldsForOrder(companyId, orderId)) });
  } catch (err) {
    logger.error({ err, companyId, orderId }, 'fab_erp field-readiness failed');
    return res.status(500).json({ message: 'Could not check the order’s field values.' });
  }
});

export default router;
