import express from 'express';
import { appContext } from '../../../core/middleware/appContext.js';
import { protect } from '../../../core/middleware/authmiddleware.js';
import { teamPerformance, teamRecordings } from '../controllers/managerController.js';

const router = express.Router();
router.post('/team-performance', appContext, protect, teamPerformance);
router.post('/team-recordings', appContext, protect, teamRecordings);
export default router;
