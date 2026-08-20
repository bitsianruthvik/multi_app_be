/**
 * resources.js — the Resource Catalog: bulk export/import via Excel, and the
 * one write that cannot go through the generic `/mutate` path.
 *
 * GET  /resources/export-template  — download a fill-in .xlsx template
 *                                      (Resource Types sheet + Resources sheet + Reference + Instructions)
 * POST /resources/import           — upload a filled template; creates resource types and resources
 * GET  /resources/:id/area         — what a reassignment would move, without moving it
 * POST /resources/:id/area         — reassign the machine's WORK AREA and carry
 *                                      its stock across, in one transaction
 *
 * WHY /area IS NOT `/mutate`. `fab_resources.stock_location_id` is the area a
 * machine's work-in-process lives in. Written as a plain column update — which
 * is all `/mutate` can do, correctly — the pointer moves and the stock does
 * not, leaving an orphaned area nothing points at and no ledger row explaining
 * it. Production has two such areas. Reassignment is therefore a resource edit
 * AND a stock movement, and both have to land together or neither does; that
 * needs an explicit endpoint with a transaction behind it.
 *
 * Permissions: `fab_erp_resources_manage` for everything here, matching the
 * import/export routes and `assets.js` — the subject is the machine catalog.
 * `/area` additionally requires `fab_erp_inventory_manage`, but ONLY when the
 * reassignment would actually move pieces; that check lives in the service,
 * because whether anything moves is not knowable until the old area has been
 * looked at. Pointing a machine at an empty area stays a plain resource edit.
 */

import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import { protect } from '../../../core/middleware/authmiddleware.js';
import { logger } from '../../../core/utils/logger.js';
import { exportResourcesTemplateHandler, importResourcesHandler } from '../controllers/resourcesImportController.js';
import { reassignResourceArea, previewResourceArea } from '../services/resourceAreaService.js';

const router = Router();
const upload = multer({ dest: path.join(process.cwd(), 'tmp') });

const isAdmin = (req) => String(req.user?.role ?? '').toLowerCase() === 'admin';

const requirePerm = (tag) => (req, res, next) => {
  // Admin bypass, as in assets.js / mutateController. The import routes did not
  // have it and now do — an admin being told they lack a permission they define
  // is the sort of thing that gets worked around with a direct DB edit.
  if (isAdmin(req)) return next();
  if (!Array.isArray(req.user?.uiPermissions) || !req.user.uiPermissions.includes(tag)) {
    return res.status(403).json({ message: `Permission required: ${tag}` });
  }
  next();
};

const canManage = requirePerm('fab_erp_resources_manage');
const companyOf = (req) => req.user.companyId ?? req.user.company_id;

const fail = (res, err, what) => {
  if (err?.status) {
    return res.status(err.status).json({ message: err.message, code: err.code ?? undefined });
  }
  logger.error({ err }, `fab_erp resources: ${what} failed`);
  return res.status(500).json({ message: err?.message ?? 'Something went wrong.' });
};

router.get('/resources/export-template', protect, canManage, exportResourcesTemplateHandler);
router.post('/resources/import', protect, canManage, upload.single('excel_file'), importResourcesHandler);

/**
 * GET /resources/:id/area
 *
 * → { resourceId, currentLocationId, areaOwnership, sharedWith[], pieceCount }
 *
 * So the editor can say "this area is shared with 14 other machines, 3 pieces
 * will stay behind" BEFORE somebody presses Save, rather than reporting it
 * afterwards.
 */
router.get('/resources/:id/area', protect, canManage, async (req, res) => {
  try {
    res.json(await previewResourceArea(companyOf(req), Number(req.params.id)));
  } catch (err) { fail(res, err, 'area preview'); }
});

/**
 * POST /resources/:id/area
 *
 * Body: { toLocationId?: number, mode?: 'dedicated', note?: string }
 *   - `toLocationId` — move the machine's work area to this existing area.
 *   - `mode: 'dedicated'` — provision the machine's own `WIP-M<id>` area
 *     (find-or-create) and move it there. Ignores `toLocationId`. This is the
 *     "give this crane its own area instead of the pool" case.
 *
 * → the service's summary: what moved (`moved`, `moveRefs`), what deliberately
 *   did not (`skipped`, each with a reason), why the split came out that way
 *   (`areaOwnership`, `sharedWith`), what happened to the canonical
 *   `fab_resource_stock_areas` link (`link`), and a plain-English `message`.
 *
 *   200 + `changed: false` when the machine is already in that area — a no-op,
 *   not a 409, because the edit dialog re-sends every field on every Save.
 */
router.post('/resources/:id/area', protect, canManage, async (req, res) => {
  try {
    const { toLocationId = null, mode = 'area', note = null } = req.body ?? {};
    const out = await reassignResourceArea(companyOf(req), Number(req.params.id), {
      toLocationId: toLocationId == null || toLocationId === '' ? null : Number(toLocationId),
      mode: mode === 'dedicated' ? 'dedicated' : 'area',
      note: note ? String(note) : null,
      // null = admin, so the service skips the inventory check entirely.
      grants: isAdmin(req) ? null : (req.user?.uiPermissions ?? []),
      userId: req.user?.id ?? null,
    });
    res.json(out);
  } catch (err) { fail(res, err, 'area reassignment'); }
});

export default router;
