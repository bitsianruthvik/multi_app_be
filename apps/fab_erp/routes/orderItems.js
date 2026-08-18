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
import { missingFieldsForOrder } from '../services/itemFieldService.js';
import {
  exportOrderItemsTemplateHandler,
  importOrderItemsHandler,
  recomputeOrderWeightsHandler,
  orderWeightSummaryHandler,
  generateOrderItemCodesHandler,
  orderNestingHandler,
  exportBoqHandler,
  importBoqHandler,
  boqWizardHandler,
  applyBoqWizardHandler,
  exportNestingHandler,
  importNestingHandler,
  flowSummaryHandler,
  applyFlowRulesHandler,
  setItemFlowHandler,
  setItemMaterialHandler,
  parameterGridHandler,
  exportParametersHandler,
  importParametersHandler,
  setParametersHandler,
  similarGroupsHandler,
  markSimilarHandler,
  orderReadinessHandler,
  confirmOrderHandler,
  nestingBoardHandler,
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
// ── BOQ: one sheet, four level-code columns (2026-08) ──────────────────────
router.get('/orders/:orderId/boq/export', protect, requirePerm('fab_erp_projects_manage'), exportBoqHandler);
router.post('/orders/:orderId/boq/wizard', protect, requirePerm('fab_erp_projects_manage'), boqWizardHandler);
// Same body as /boq/wizard, but SAVES the generated structure instead of
// returning a spreadsheet — so a structure that needs no editing does not have
// to round-trip through Excel just to exist on the order.
router.post('/orders/:orderId/boq/wizard/apply', protect, requirePerm('fab_erp_projects_manage'), applyBoqWizardHandler);
router.post('/orders/:orderId/boq/import', protect, requirePerm('fab_erp_projects_manage'), upload.single('excel_file'), importBoqHandler);

// ── Nesting: stage 2, its own document (2026-08) ───────────────────────────
router.get('/orders/:orderId/nesting/export', protect, requirePerm('fab_erp_projects_manage'), exportNestingHandler);
router.post('/orders/:orderId/nesting/import', protect, requirePerm('fab_erp_projects_manage'), upload.single('excel_file'), importNestingHandler);

// The drag-and-drop board (2026-08-10). Reading it is a view action; arranging
// plates is not.
router.get('/orders/:orderId/nesting/board', protect, nestingBoardHandler);
router.post('/orders/:orderId/nesting/assign', protect, requirePerm('fab_erp_projects_manage'), assignPartsHandler);
router.patch('/orders/:orderId/nests/:nestNo', protect, requirePerm('fab_erp_projects_manage'), updateNestHandler);
router.delete('/orders/:orderId/nests/:nestNo', protect, requirePerm('fab_erp_projects_manage'), clearNestHandler);

// ── Flow allocation: stage 3 (2026-08) ─────────────────────────────────────
router.get('/orders/:orderId/flows/summary', protect, flowSummaryHandler);
router.post('/orders/:orderId/flows/apply', protect, requirePerm('fab_erp_projects_manage'), applyFlowRulesHandler);
router.post('/items/:itemId/flow', protect, requirePerm('fab_erp_projects_manage'), setItemFlowHandler);
// The screen equivalent of the BOQ sheet Raw Material column, so setting what a
// part is cut from no longer needs an Excel round trip.
router.post('/items/:itemId/material', protect, requirePerm('fab_erp_projects_manage'), setItemMaterialHandler);

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
