/**
 * routes/actuals.js — the Actuals Board.
 *
 * Mounted separately in app.js alongside routes/planner.js, matching that
 * precedent: it is a screen's worth of endpoints rather than a resource, and it
 * shares the planner's window-parsing conventions deliberately so the two boards
 * cannot drift apart about what "this month" means.
 *
 * One endpoint, one verb, no writes. Everything this board can do is look.
 */

import { Router } from 'express';
import { protect } from '../../../core/middleware/authmiddleware.js';
import { logger } from '../../../core/utils/logger.js';
import { getActualsBoard, ACTUALS_LEVELS } from '../services/actualsBoardService.js';

const router = Router();

/**
 * Its own tag rather than the planner's.
 *
 * The audiences differ: a production manager wants to know what the shop did
 * last month without being able to touch next month's plan, and reusing
 * `fab_erp_planner_view` would make the two inseparable. Admins bypass both.
 */
const VIEW_TAG = 'fab_erp_actuals_view';

function isAuthorized(user, tag) {
  const isAdmin = user?.role && String(user.role).toLowerCase() === 'admin';
  if (isAdmin) return true;
  return Array.isArray(user?.uiPermissions) && user.uiPermissions.includes(tag);
}

function parseIdList(raw) {
  if (raw == null || raw === '') return [];
  const list = Array.isArray(raw) ? raw : String(raw).split(',');
  return [...new Set(list.map((v) => Number(v)).filter((v) => Number.isFinite(v) && v > 0))];
}

/**
 * Both ends required, at most a quarter apart.
 *
 * Same rule as the planner's, for the same reason plus one of its own: the
 * working-time clip walks the shift calendar across every day in the window, and
 * a request for "everything" would walk years of it to draw a month's worth of
 * pixels.
 */
function parseWindow(q) {
  const from = new Date(q.from);
  const to = new Date(q.to);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return null;
  if (!(to > from)) return null;
  if (to.getTime() - from.getTime() > 92 * 86400000) return null;
  return { from, to };
}

/**
 * GET /actuals/board — what the shop did in this window.
 *
 * ?from&to        ISO instants, required
 * ?mode           unit | machine          (default machine)
 * ?level          order…part | operation  (default girder)
 * ?orderIds       CSV, optional
 * ?resourceTypeIds CSV, optional (machine mode)
 *
 * Returns the same payload shape as GET /plan/board — lanes of flat number
 * tuples plus the words once, in lookup tables — so the client's boardModel
 * consumes it unchanged. See actualsBoardService for the additions.
 */
router.get('/actuals/board', protect, async (req, res) => {
  const user = req.user;
  if (!isAuthorized(user, VIEW_TAG)) {
    return res.status(403).json({ message: `Permission denied. Required: "${VIEW_TAG}".` });
  }
  const companyId = user?.companyId;
  if (!companyId) return res.status(400).json({ message: 'Unable to determine companyId from token.' });

  const win = parseWindow(req.query);
  if (!win) {
    return res.status(400).json({ message: 'from/to are required ISO dates, to > from, at most 92 days apart.' });
  }

  const level = ACTUALS_LEVELS.includes(String(req.query.level)) ? String(req.query.level) : 'girder';
  const mode = req.query.mode === 'unit' ? 'unit' : 'machine';

  try {
    const board = await getActualsBoard(companyId, {
      ...win,
      mode,
      level,
      orderIds: parseIdList(req.query.orderIds),
      resourceTypeIds: parseIdList(req.query.resourceTypeIds),
    });
    return res.status(200).json({ ok: true, ...board });
  } catch (err) {
    logger.error({ err, companyId }, 'actuals board read failed');
    return res.status(500).json({ message: 'Failed to load the actuals board.' });
  }
});

export default router;
