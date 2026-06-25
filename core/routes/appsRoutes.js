import { Router } from 'express';
import { pool } from '../../db.js';
import { protect } from '../middleware/authmiddleware.js';

const router = Router();

async function getAppAccessForUser(userId, companyId) {
  const [accessRows] = await pool.query(`
    SELECT aua.app_id, aua.role_id, a.name, a.slug
    FROM app_user_access aua
    JOIN apps a ON a.id = aua.app_id
    WHERE aua.user_id = ? AND aua.company_id = ?
      AND aua.deleted_at IS NULL AND a.deleted_at IS NULL
    ORDER BY a.name
  `, [userId, companyId]);

  const result = await Promise.all(accessRows.map(async (row) => {
    const [perms] = await pool.query(`
      SELECT DISTINCT f.feature_tag
      FROM role_capability rc
      JOIN features_capability fca ON fca.capability_id = rc.capability_id AND fca.deleted_at IS NULL
      JOIN JSON_TABLE(fca.features_json, '$[*]' COLUMNS (fid INT PATH '$')) jt ON TRUE
      JOIN features f ON f.id = jt.fid AND f.deleted_at IS NULL
      WHERE rc.role_id = ?
        AND (rc.app_id = ? OR rc.app_id IS NULL)
        AND rc.deleted_at IS NULL
    `, [row.role_id, row.app_id]);

    return {
      id: row.app_id,
      name: row.name,
      slug: row.slug,
      userRoleId: row.role_id,
      uiPermissions: perms.map(p => p.feature_tag),
    };
  }));

  return result;
}

// GET /api/:companySlug/apps
router.get('/', protect, async (req, res) => {
  try {
    const userId = req.user.id;
    const companyId = req.user.companyId;
    const result = await getAppAccessForUser(userId, companyId);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export { getAppAccessForUser };
export default router;
