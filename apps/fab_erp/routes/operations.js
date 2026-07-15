/**
 * operations.js — Operations bulk export/import via Excel.
 *
 * GET  /operations/export-template  — download a fill-in .xlsx template
 *                                       (Operations sheet + Resource Types reference + Instructions)
 * POST /operations/import           — upload a filled template; creates operations and
 *                                       resource-type mappings (time formula/variables excluded)
 *
 * Both require: fab_erp_operations_manage
 */

import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import { protect } from '../../../core/middleware/authmiddleware.js';
import { exportOperationsTemplateHandler, importOperationsHandler } from '../controllers/operationsImportController.js';

const router = Router();
const upload = multer({ dest: path.join(process.cwd(), 'tmp') });

const requirePerm = (tag) => (req, res, next) => {
  if (!Array.isArray(req.user?.uiPermissions) || !req.user.uiPermissions.includes(tag)) {
    return res.status(403).json({ message: `Permission required: ${tag}` });
  }
  next();
};

router.get('/operations/export-template', protect, requirePerm('fab_erp_operations_manage'), exportOperationsTemplateHandler);
router.post('/operations/import', protect, requirePerm('fab_erp_operations_manage'), upload.single('excel_file'), importOperationsHandler);

export default router;
