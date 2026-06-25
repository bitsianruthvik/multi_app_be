import { buildSchedule, getSchedule, saveSnapshot } from '../services/scheduleService.js';
import { logger } from '../../../core/utils/logger.js';

const cid = (req) => req.user?.companyId ?? req.user?.company_id;

export const runScheduleHandler = async (req, res) => {
  try {
    const planId    = Number(req.params.planId);
    const companyId = cid(req);
    await saveSnapshot(planId, companyId, 'manual');
    const summary = await buildSchedule(planId, companyId);
    res.json({ success: true, data: summary });
  } catch (err) {
    logger.error({ err }, 'fab_flow: buildSchedule failed');
    res.status(400).json({ success: false, error: err.message });
  }
};

export const replanScheduleHandler = async (req, res) => {
  try {
    const planId    = Number(req.params.planId);
    const companyId = cid(req);
    const raw       = req.body?.fromDate;
    const fromDate  = (typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw))
      ? raw : new Date().toISOString().slice(0, 10);
    await saveSnapshot(planId, companyId, 'replan');
    const summary = await buildSchedule(planId, companyId, { fromDate });
    res.json({ success: true, data: { ...summary, fromDate } });
  } catch (err) {
    logger.error({ err }, 'fab_flow: replanSchedule failed');
    res.status(400).json({ success: false, error: err.message });
  }
};

export const getScheduleHandler = async (req, res) => {
  try {
    const data = await getSchedule(Number(req.params.planId), cid(req));
    if (!data) return res.status(404).json({ success: false, error: 'No schedule found' });
    res.json({ success: true, data });
  } catch (err) {
    logger.error({ err }, 'fab_flow: getSchedule failed');
    res.status(400).json({ success: false, error: err.message });
  }
};
