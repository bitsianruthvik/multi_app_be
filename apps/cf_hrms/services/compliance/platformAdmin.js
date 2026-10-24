/**
 * platformAdmin.js — who may open the platform console (/api/platform/*, spec §36.4): the PRODUCT
 * team, outside any company.
 *
 * THE RULE. A login is a platform admin only while ALL of these hold, checked on every request:
 *   - its JWT verifies (the platform's own `protect`), and it is not a service token;
 *   - platform_admins has a live row for its user id;
 *   - that user still exists, is not deleted, and still has the email the row was granted for
 *     (an id that was re-used or an address that was changed loses the right).
 * Nothing else counts: not the role name `admin` (every company's Owner has it), not a right of any
 * app, not the company. No route writes platform_admins — only scripts/grant-platform-admin.mjs, run
 * by hand against a named database.
 */
import { protect } from '../../../../core/middleware/authmiddleware.js';
import { pool } from '../../lib/db.js';

export async function platformAdminOf(userId, db = pool) {
  const id = Number(userId);
  if (!id) return null;
  const [[r]] = await db.query(
    `SELECT p.id, p.user_id, u.name, u.email, u.company_id FROM platform_admins p JOIN users u ON u.id = p.user_id
      WHERE p.user_id = ? AND p.deleted_at IS NULL AND u.deleted_at IS NULL AND LOWER(TRIM(u.email)) = LOWER(TRIM(p.email))`, [id]);
  return r ? { id: r.user_id, name: r.name, email: r.email, companyId: r.company_id } : null;
}

const refuse = (res) => res.status(403).json({ error: 'FORBIDDEN', code: 'NOT_PLATFORM_ADMIN', message: 'This is the product team’s console. Your login is not a platform admin.' });

/** The guard of every /api/platform route: `protect`, then the platform_admins check. */
async function check(req, res, next) {
  try {
    if (!req.user || req.user.is_service) return refuse(res);
    const admin = await platformAdminOf(req.user.id);
    if (!admin) return refuse(res);
    req.platformAdmin = admin;
    return next();
  } catch (err) {
    return res.status(500).json({ error: 'SERVER', message: 'Could not check the platform rights.' });
  }
}
check.platformGuard = true;
export const platformGuard = [protect, check];

export default { platformGuard, platformAdminOf };
