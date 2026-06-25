import { pool } from '../../../db.js';
import { logger } from '../../../core/utils/logger.js';

const cid = (req) => req.user?.companyId ?? req.user?.company_id;

// GET /plans/:planId/progress
export const getTaskProgressHandler = async (req, res) => {
  try {
    const planId    = Number(req.params.planId);
    const companyId = cid(req);
    const [rows] = await pool.query(
      `SELECT id, process_step_id, node_id,
              DATE_FORMAT(log_date,'%Y-%m-%d') AS log_date,
              completion_pct, work_start, work_end,
              delay_reason_codes, notes, created_by,
              created_at, updated_at
       FROM fab_task_progress
       WHERE plan_id=? AND company_id=?
       ORDER BY log_date ASC, id ASC`,
      [planId, companyId],
    );
    res.json({ success: true, data: rows.map(r => ({
      ...r,
      completion_pct: parseFloat(r.completion_pct),
      delay_reason_codes: r.delay_reason_codes
        ? (typeof r.delay_reason_codes === 'string'
            ? JSON.parse(r.delay_reason_codes) : r.delay_reason_codes)
        : null,
    })) });
  } catch (err) {
    logger.error({ err }, 'getTaskProgress failed');
    res.status(500).json({ success: false, error: err.message });
  }
};

// PUT /plans/:planId/progress
// body: { processStepId, nodeId, logDate, completionPct, workStart, workEnd, delayReasonCodes, notes }
export const upsertTaskProgressHandler = async (req, res) => {
  try {
    const planId    = Number(req.params.planId);
    const companyId = cid(req);
    const {
      processStepId, nodeId = null, logDate,
      completionPct, workStart = null, workEnd = null,
      delayReasonCodes = null, notes = null,
    } = req.body;

    if (!processStepId || logDate == null || completionPct == null)
      return res.status(400).json({ success: false, error: 'processStepId, logDate, completionPct required' });

    const pct         = Math.max(0, Math.min(100, parseFloat(completionPct)));
    const reasonsJson = delayReasonCodes?.length ? JSON.stringify(delayReasonCodes) : null;

    await pool.query(
      `INSERT INTO fab_task_progress
         (plan_id, company_id, process_step_id, node_id, log_date,
          completion_pct, work_start, work_end, delay_reason_codes, notes, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE
         completion_pct=VALUES(completion_pct),
         work_start=VALUES(work_start),
         work_end=VALUES(work_end),
         delay_reason_codes=VALUES(delay_reason_codes),
         notes=VALUES(notes),
         updated_at=CURRENT_TIMESTAMP`,
      [planId, companyId, processStepId, nodeId, logDate,
       pct, workStart || null, workEnd || null, reasonsJson, notes || null,
       req.user?.id ?? null],
    );
    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, 'upsertTaskProgress failed');
    res.status(500).json({ success: false, error: err.message });
  }
};
