import { pool } from '../../../db.js';
import { logger } from '../../../core/utils/logger.js';

export async function teamPerformance(req, res) {
  if (req.user.role !== 'salesmanager') {
    return res.status(403).json({ message: 'Forbidden' });
  }

  const companyId = req.user.company_id;
  const teamId = req.user.team_id;

  if (!teamId) {
    return res.status(400).json({ message: 'No team assigned to this user' });
  }

  const { dateFrom, dateTo } = req.body || {};

  try {
    // Step 1 — Fetch all salesmen on this team
    const [salesmen] = await pool.query(
      `SELECT u.id, u.name
       FROM users u
       JOIN roles r ON u.role_id = r.id
       WHERE u.team_id = ? AND u.company_id = ? AND r.name = 'salesman' AND u.deleted_at IS NULL`,
      [teamId, companyId]
    );

    // Step 2 — Fetch all recordings for this team's salesmen
    let recSql = `SELECT ar.id, ar.recorded_by, ar.action_id, ar.score, ar.medicine, ar.analysis, ar.created_at,
       a.name AS action_name
FROM audio_recordings ar
JOIN actions a ON ar.action_id = a.id
JOIN users u ON ar.recorded_by = u.name AND u.company_id = ar.company_id
JOIN roles r ON u.role_id = r.id
WHERE u.team_id = ? AND ar.company_id = ?
  AND r.name = 'salesman'
  AND ar.deleted_at IS NULL`;

    const recParams = [teamId, companyId];

    if (dateFrom) {
      recSql += ' AND ar.created_at >= ?';
      recParams.push(dateFrom);
    }
    if (dateTo) {
      recSql += ` AND ar.created_at <= CONCAT(?, ' 23:59:59')`;
      recParams.push(dateTo);
    }

    const [rows] = await pool.query(recSql, recParams);

    // Step 3 — Compute aggregates in JavaScript
    const totalRecordings = rows.length;

    const scoredRows = rows.filter(r => r.score != null);
    const avgScore =
      scoredRows.length > 0
        ? Math.round((scoredRows.reduce((sum, r) => sum + Number(r.score), 0) / scoredRows.length) * 10) / 10
        : null;

    const subScoreAccum = {
      modelCommunication: { sum: 0, count: 0 },
      languageQuality: { sum: 0, count: 0 },
      medicalAccuracy: { sum: 0, count: 0 },
      closingAction: { sum: 0, count: 0 },
    };

    for (const row of rows) {
      if (row.analysis == null) continue;
      try {
        const parsed = typeof row.analysis === 'string' ? JSON.parse(row.analysis) : row.analysis;
        const sections = parsed?.sections;
        if (!sections) continue;

        const mcc = sections?.Model_Communication_Compliance?.total;
        const lt = sections?.Language_Tonality?.total;
        const msa = sections?.Medical_Scientific_Accuracy?.total;
        const cao = sections?.Closing_Action_Orientation?.total;

        if (mcc != null) { subScoreAccum.modelCommunication.sum += Number(mcc); subScoreAccum.modelCommunication.count++; }
        if (lt != null)  { subScoreAccum.languageQuality.sum  += Number(lt);  subScoreAccum.languageQuality.count++; }
        if (msa != null) { subScoreAccum.medicalAccuracy.sum  += Number(msa); subScoreAccum.medicalAccuracy.count++; }
        if (cao != null) { subScoreAccum.closingAction.sum    += Number(cao); subScoreAccum.closingAction.count++; }
      } catch (_) {
        // skip unparseable analysis
      }
    }

    const avgSubScores = {
      modelCommunication: subScoreAccum.modelCommunication.count > 0
        ? Math.round((subScoreAccum.modelCommunication.sum / subScoreAccum.modelCommunication.count) * 10) / 10
        : null,
      languageQuality: subScoreAccum.languageQuality.count > 0
        ? Math.round((subScoreAccum.languageQuality.sum / subScoreAccum.languageQuality.count) * 10) / 10
        : null,
      medicalAccuracy: subScoreAccum.medicalAccuracy.count > 0
        ? Math.round((subScoreAccum.medicalAccuracy.sum / subScoreAccum.medicalAccuracy.count) * 10) / 10
        : null,
      closingAction: subScoreAccum.closingAction.count > 0
        ? Math.round((subScoreAccum.closingAction.sum / subScoreAccum.closingAction.count) * 10) / 10
        : null,
    };

    // Step 4 — Build per-salesman breakdown
    // Group recordings by recorded_by name
    const recByName = {};
    for (const row of rows) {
      if (!recByName[row.recorded_by]) recByName[row.recorded_by] = [];
      recByName[row.recorded_by].push(row);
    }

    const salesmenBreakdown = salesmen.map(sm => {
      const smRows = recByName[sm.name] || [];

      const smScoredRows = smRows.filter(r => r.score != null);
      const smAvgScore =
        smScoredRows.length > 0
          ? Math.round((smScoredRows.reduce((sum, r) => sum + Number(r.score), 0) / smScoredRows.length) * 10) / 10
          : null;

      // Group by action_id
      const actionMap = {};
      for (const row of smRows) {
        const key = row.action_id;
        if (!actionMap[key]) {
          actionMap[key] = { actionId: row.action_id, actionName: row.action_name, count: 0, brandsSet: new Set() };
        }
        actionMap[key].count++;
        if (row.medicine != null) actionMap[key].brandsSet.add(row.medicine);
      }

      const byAction = Object.values(actionMap).map(a => ({
        actionId: a.actionId,
        actionName: a.actionName,
        count: a.count,
        brands: Array.from(a.brandsSet),
      }));

      return {
        id: sm.id,
        name: sm.name,
        totalRecordings: smRows.length,
        avgScore: smAvgScore,
        byAction,
      };
    });

    return res.json({
      aggregates: {
        totalRecordings,
        avgScore,
        avgSubScores,
      },
      salesmen: salesmenBreakdown,
    });
  } catch (e) {
    logger.error({ err: e }, 'teamPerformance error');
    return res.status(500).json({ message: 'Internal server error' });
  }
}

export async function teamRecordings(req, res) {
  if (req.user.role !== 'salesmanager') {
    return res.status(403).json({ message: 'Forbidden' });
  }

  const companyId = req.user.company_id;
  const teamId = req.user.team_id;

  if (!teamId) {
    return res.status(400).json({ message: 'No team assigned to this user' });
  }

  const { salesmanName, actionId, medicine, dateFrom, dateTo } = req.body || {};

  try {
    let sql = `SELECT ar.id, ar.title, ar.score, ar.medicine, ar.action_id, ar.status, ar.created_at,
       a.name AS action_name
FROM audio_recordings ar
JOIN actions a ON ar.action_id = a.id
JOIN users u ON ar.recorded_by = u.name AND u.company_id = ar.company_id
WHERE ar.recorded_by = ? AND u.team_id = ? AND ar.company_id = ?
  AND ar.deleted_at IS NULL`;

    const params = [salesmanName, teamId, companyId];

    if (actionId != null) {
      sql += ' AND ar.action_id = ?';
      params.push(actionId);
    }
    if (medicine != null) {
      sql += ' AND ar.medicine = ?';
      params.push(medicine);
    }
    if (dateFrom) {
      sql += ' AND ar.created_at >= ?';
      params.push(dateFrom);
    }
    if (dateTo) {
      sql += ` AND ar.created_at <= CONCAT(?, ' 23:59:59')`;
      params.push(dateTo);
    }

    sql += ' ORDER BY ar.created_at DESC';

    const [recordings] = await pool.query(sql, params);

    return res.json({ recordings });
  } catch (e) {
    logger.error({ err: e }, 'teamRecordings error');
    return res.status(500).json({ message: 'Internal server error' });
  }
}
