/**
 * orderItems.js — Items/BOM tree bulk export/import via Excel, scoped to one sales order.
 *
 * GET  /orders/:orderId/items/export-template  — download a fill-in .xlsx template
 *                                                  (Data sheet + Flows reference + Instructions)
 * POST /orders/:orderId/items/import            — upload a filled template; bulk-creates the
 *                                                  order's fab_items parent/child tree
 *
 * Both require: fab_erp_projects_manage
 */

import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import { protect } from '../../../core/middleware/authmiddleware.js';
import { exportOrderItemsTemplateHandler, importOrderItemsHandler } from '../controllers/orderItemsImportController.js';

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

export default router;
