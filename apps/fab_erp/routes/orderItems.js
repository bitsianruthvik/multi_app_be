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
  exportNestingHandler,
  importNestingHandler,
  flowSummaryHandler,
  applyFlowRulesHandler,
  setItemFlowHandler,
  orderReadinessHandler,
  confirmOrderHandler,
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
router.post('/orders/:orderId/boq/import', protect, requirePerm('fab_erp_projects_manage'), upload.single('excel_file'), importBoqHandler);

// ── Nesting: stage 2, its own document (2026-08) ───────────────────────────
router.get('/orders/:orderId/nesting/export', protect, requirePerm('fab_erp_projects_manage'), exportNestingHandler);
router.post('/orders/:orderId/nesting/import', protect, requirePerm('fab_erp_projects_manage'), upload.single('excel_file'), importNestingHandler);

// ── Flow allocation: stage 3 (2026-08) ─────────────────────────────────────
router.get('/orders/:orderId/flows/summary', protect, flowSummaryHandler);
router.post('/orders/:orderId/flows/apply', protect, requirePerm('fab_erp_projects_manage'), applyFlowRulesHandler);
router.post('/items/:itemId/flow', protect, requirePerm('fab_erp_projects_manage'), setItemFlowHandler);

// ── The wizard: where the order stands, and the act that ends it (2026-08) ──
// Readiness is read-only, so it is gated on view, not manage.
router.get('/orders/:orderId/readiness', protect, orderReadinessHandler);
router.post('/orders/:orderId/confirm', protect, requirePerm('fab_erp_projects_manage'), confirmOrderHandler);

router.post('/orders/:orderId/items/generate-codes', protect, requirePerm('fab_erp_projects_manage'), generateOrderItemCodesHandler);
// Read-only: gated on view, not manage — anyone who can open the order sees its tonnage.
router.get('/orders/:orderId/items/weight-summary', protect, orderWeightSummaryHandler);
// Read-only too — seeing what the order is waiting on is not a manage action.
router.get('/orders/:orderId/items/nesting', protect, orderNestingHandler);

export default router;
