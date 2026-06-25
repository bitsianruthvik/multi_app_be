import express from 'express';
import multer from 'multer';
import path from 'path';
import { protect } from '../../../core/middleware/authmiddleware.js';
import { appContext } from '../../../core/middleware/appContext.js';
import {
  exportCapacityHandler,
  uploadCapacityHandler,
  importCapacityBatchHandler,
  syncWorkAreaCapsHandler,
  syncMachineCapsHandler,
  syncCalendarSubHandler,
} from '../controllers/capacityController.js';

const router = express.Router();
const upload = multer({ dest: path.join(process.cwd(), 'tmp') });

router.get('/capacity/export',                            appContext, protect, exportCapacityHandler);
router.post('/capacity/upload',                           appContext, protect, upload.single('excel_file'), uploadCapacityHandler);
router.post('/capacity/batches/:batchId/import',          appContext, protect, importCapacityBatchHandler);
router.post('/capacity/work-areas/:waId/sync-caps',       appContext, protect, syncWorkAreaCapsHandler);
router.post('/capacity/machines/:machineId/sync-caps',    appContext, protect, syncMachineCapsHandler);
router.post('/capacity/calendars/:calendarId/sync-sub',   appContext, protect, syncCalendarSubHandler);

export default router;
