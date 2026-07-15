/**
 * resources.js — Resource Catalog (Resource Types + Resources) bulk export/import via Excel.
 *
 * GET  /resources/export-template  — download a fill-in .xlsx template
 *                                      (Resource Types sheet + Resources sheet + Reference + Instructions)
 * POST /resources/import           — upload a filled template; creates resource types and resources
 *
 * Both require: fab_erp_resources_manage
 */

import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import { protect } from '../../../core/middleware/authmiddleware.js';
import { exportResourcesTemplateHandler, importResourcesHandler } from '../controllers/resourcesImportController.js';

const router = Router();
const upload = multer({ dest: path.join(process.cwd(), 'tmp') });

const requirePerm = (tag) => (req, res, next) => {
  if (!Array.isArray(req.user?.uiPermissions) || !req.user.uiPermissions.includes(tag)) {
    return res.status(403).json({ message: `Permission required: ${tag}` });
  }
  next();
};

router.get('/resources/export-template', protect, requirePerm('fab_erp_resources_manage'), exportResourcesTemplateHandler);
router.post('/resources/import', protect, requirePerm('fab_erp_resources_manage'), upload.single('excel_file'), importResourcesHandler);

export default router;
