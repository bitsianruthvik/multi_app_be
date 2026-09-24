import { Router } from 'express';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { pool } from '../../db.js';
import { protect } from '../middleware/authmiddleware.js';
import crypto from 'crypto';

const router = Router();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

function loadJson(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

// GET /api/:companySlug/schema/resources
router.get('/:companySlug/schema/resources', protect, async (req, res) => {
  try {
    const userId = req.user.id;
    const companyId = req.user.companyId;

    // Get all apps this user has access to
    const [accessRows] = await pool.query(
      `SELECT aua.app_id, a.slug
       FROM app_user_access aua
       JOIN apps a ON a.id = aua.app_id
       WHERE aua.user_id = ? AND aua.company_id = ?
         AND aua.deleted_at IS NULL AND a.deleted_at IS NULL`,
      [userId, companyId]
    );

    // Load core resource defs
    const coreDefs = loadJson(path.join(ROOT, 'resourceDef.json')) || {};

    // Load app-specific resource defs
    let merged = { ...coreDefs };
    for (const row of accessRows) {
      const appDefs = loadJson(path.join(ROOT, 'apps', row.slug, 'resourceDef.json'));
      if (appDefs) {
        merged = { ...merged, ...appDefs };
      }
    }

    // Transform to frontend manifest format.
    //
    // `ops` used to claim post/put/delete for every resource. Most resources
    // are read-only through the generic API — they are written by the service
    // that owns their rules — so report what the write path will actually
    // accept rather than letting a builder offer a write that 403s.
    const resources = Object.entries(merged).map(([key, def]) => {
      const writable = def.writable === true;
      return {
        name: key,
        endpoint: `/api/query/v1/${key}`,
        fields: Object.keys(def.fields || {}),
        writable,
        writeFields: writable ? def.writeFields || [] : [],
        allowedOps: {
          ops: writable ? ['get', 'post', 'put', 'delete'] : ['get'],
        },
      };
    });

    const generatedAt = new Date().toISOString();
    const etag = crypto
      .createHash('md5')
      .update(resources.map(r => r.name).join(',') + generatedAt)
      .digest('hex');

    res.set('Cache-Control', 'private, must-revalidate');
    res.set('Vary', 'Authorization');
    res.set('ETag', `"${etag}"`);

    res.json({ schemaVersion: '2.0', generatedAt, resources });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
