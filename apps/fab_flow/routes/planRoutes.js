import express from 'express';
import multer from 'multer';
import path from 'path';
import { protect } from '../../../core/middleware/authmiddleware.js';
import { appContext } from '../../../core/middleware/appContext.js';
import {
  approvePlanHandler,
  revisePlanHandler,
  importExcelBatch,
  uploadExcelHandler,
  planReadinessHandler,
  exportPlanHandler,
  getNodeDetailHandler,
  uploadNodeDiagramHandler,
  downloadNodeDiagramHandler,
} from '../controllers/planController.js';

const router = express.Router();
const upload = multer({ dest: path.join(process.cwd(), 'tmp') });

// Plan lifecycle (auth required)
router.get('/plans/:planId/export',            appContext, protect, exportPlanHandler);
router.post('/plans/:planId/approve',          appContext, protect, approvePlanHandler);
router.post('/plans/:planId/revise',           appContext, protect, revisePlanHandler);
router.get('/plans/:planId/readiness',         appContext, protect, planReadinessHandler);
router.post('/plans/:planId/excel-upload',     appContext, protect, upload.single('excel_file'), uploadExcelHandler);
router.post('/import-batches/:batchId/import', appContext, protect, importExcelBatch);

// Node detail & diagram
router.get('/nodes/:nodeId',          appContext, protect, getNodeDetailHandler);
router.post('/nodes/:nodeId/diagram', appContext, protect, upload.single('diagram'), uploadNodeDiagramHandler);
router.get('/nodes/:nodeId/diagram',  appContext, protect, downloadNodeDiagramHandler);

export default router;
