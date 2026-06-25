/**
 * items.js — Item Catalog bulk export/import via Excel.
 *
 * GET  /items/export-template  — download a fill-in .xlsx template
 *                                 (Items sheet + Existing Taxonomy reference + Instructions)
 * POST /items/import           — upload a filled template; creates items and
 *                                 auto-creates any missing Category/Group/Sub-group
 *
 * Both require: fab_erp_items_meta_manage
 */

import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import { protect } from '../../../core/middleware/authmiddleware.js';
import { exportItemsTemplateHandler, importItemsHandler } from '../controllers/itemsImportController.js';

const router = Router();
const upload = multer({ dest: path.join(process.cwd(), 'tmp') });

const requirePerm = (tag) => (req, res, next) => {
  if (!Array.isArray(req.user?.uiPermissions) || !req.user.uiPermissions.includes(tag)) {
    return res.status(403).json({ message: `Permission required: ${tag}` });
  }
  next();
};

router.get('/items/export-template', protect, requirePerm('fab_erp_items_meta_manage'), exportItemsTemplateHandler);
router.post('/items/import', protect, requirePerm('fab_erp_items_meta_manage'), upload.single('excel_file'), importItemsHandler);

export default router;
