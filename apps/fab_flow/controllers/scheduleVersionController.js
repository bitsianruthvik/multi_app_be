import { pool } from '../../../db.js';
import { logger } from '../../../core/utils/logger.js';

const cid = (req) => req.user?.companyId ?? req.user?.company_id;

// GET /plans/:planId/schedule/versions
export const listVersionsHandler = async (req, res) => {
  try {
    const planId    = Number(req.params.planId);
    const companyId = cid(req);
    const [rows] = await pool.query(
      `SELECT id, version_no, triggered_by, task_count, created_at
       FROM fab_schedule_snapshots
       WHERE plan_id=? AND company_id=?
       ORDER BY version_no DESC`,
      [planId, companyId],
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    logger.error({ err }, 'listVersions failed');
    res.status(500).json({ success: false, error: err.message });
  }
};

// GET /plans/:planId/schedule/versions/:versionId
export const getVersionHandler = async (req, res) => {
  try {
    const planId    = Number(req.params.planId);
    const companyId = cid(req);
    const versionId = Number(req.params.versionId);
    const [[row]] = await pool.query(
      `SELECT id, version_no, triggered_by, task_count, snapshot_data, created_at
       FROM fab_schedule_snapshots
       WHERE id=? AND plan_id=? AND company_id=?`,
      [versionId, planId, companyId],
    );
    if (!row) return res.status(404).json({ success: false, error: 'Version not found' });
    const snapshotData = typeof row.snapshot_data === 'string'
      ? JSON.parse(row.snapshot_data) : row.snapshot_data;
    res.json({ success: true, data: {
      id:          row.id,
      versionNo:   row.version_no,
      triggeredBy: row.triggered_by,
      taskCount:   row.task_count,
      createdAt:   row.created_at,
      schedule:    snapshotData,
    }});
  } catch (err) {
    logger.error({ err }, 'getVersion failed');
    res.status(500).json({ success: false, error: err.message });
  }
};
