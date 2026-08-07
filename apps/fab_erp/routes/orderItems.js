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
router.post('/orders/:orderId/items/generate-codes', protect, requirePerm('fab_erp_projects_manage'), generateOrderItemCodesHandler);
// Read-only: gated on view, not manage — anyone who can open the order sees its tonnage.
router.get('/orders/:orderId/items/weight-summary', protect, orderWeightSummaryHandler);

export default router;
