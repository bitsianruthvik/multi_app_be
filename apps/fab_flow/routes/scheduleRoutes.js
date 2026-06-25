import express from 'express';
import { protect } from '../../../core/middleware/authmiddleware.js';
import { appContext } from '../../../core/middleware/appContext.js';
import { runScheduleHandler, getScheduleHandler, replanScheduleHandler } from '../controllers/scheduleController.js';
import { getTaskProgressHandler, upsertTaskProgressHandler } from '../controllers/taskProgressController.js';
import { listVersionsHandler, getVersionHandler } from '../controllers/scheduleVersionController.js';

const router = express.Router();

// Schedule
router.post('/plans/:planId/schedule',                    appContext, protect, runScheduleHandler);
router.post('/plans/:planId/schedule/replan',             appContext, protect, replanScheduleHandler);
router.get( '/plans/:planId/schedule',                    appContext, protect, getScheduleHandler);

// Version history
router.get( '/plans/:planId/schedule/versions',           appContext, protect, listVersionsHandler);
router.get( '/plans/:planId/schedule/versions/:versionId',appContext, protect, getVersionHandler);

// Task progress
router.get( '/plans/:planId/progress',                    appContext, protect, getTaskProgressHandler);
router.put( '/plans/:planId/progress',                    appContext, protect, upsertTaskProgressHandler);

export default router;
