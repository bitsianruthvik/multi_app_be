/**
 * flowSteps.js — per-flow Operation Flow Steps bulk export/import via Excel.
 *
 * GET  /flows/:flowId/export-template  — download the flow's steps as a fill-in .xlsx
 *                                          (pre-filled with current steps + reference sheets)
 * POST /flows/:flowId/import           — upload a filled template; REPLACES the flow's
 *                                          entire step list with the file's rows
 *
 * Both require: fab_erp_flows_manage
 */

import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import { protect } from '../../../core/middleware/authmiddleware.js';
import { exportFlowStepsTemplateHandler, importFlowStepsHandler } from '../controllers/flowStepsImportController.js';

const router = Router();
const upload = multer({ dest: path.join(process.cwd(), 'tmp') });

const requirePerm = (tag) => (req, res, next) => {
  if (!Array.isArray(req.user?.uiPermissions) || !req.user.uiPermissions.includes(tag)) {
    return res.status(403).json({ message: `Permission required: ${tag}` });
  }
  next();
};

router.get('/flows/:flowId/export-template', protect, requirePerm('fab_erp_flows_manage'), exportFlowStepsTemplateHandler);
router.post('/flows/:flowId/import', protect, requirePerm('fab_erp_flows_manage'), upload.single('excel_file'), importFlowStepsHandler);

export default router;
