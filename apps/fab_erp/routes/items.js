/**
 * items.js — Item Catalog bulk export/import via Excel.
 *
 * GET  /items/export-template  — download a fill-in .xlsx template
 *                                 (Items sheet + Existing Taxonomy reference + Instructions)
 * POST /items/import           — upload a filled template; creates items and
 *                                 auto-creates any missing Category/Group/Sub-group
 *
 * Both require: fab_erp_items_meta_manage
 *
 * Gains the admin bypass here (PLAN.md EU-3) — this router's `requirePerm` used
 * to be a local copy with none, unlike most fab_erp routes.
 */

import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import { protect } from '../../../core/middleware/authmiddleware.js';
import { requirePerm, fail } from '../../../core/middleware/requirePerm.js';
import { exportItemsTemplateHandler, importItemsHandler } from '../controllers/itemsImportController.js';
import { rawMaterialsFor, materialsForThickness } from '../services/rawMaterialService.js';

const router = Router();
const upload = multer({ dest: path.join(process.cwd(), 'tmp') });

router.get('/items/export-template', protect, requirePerm('fab_erp_items_meta_manage'), exportItemsTemplateHandler);
router.post('/items/import', protect, requirePerm('fab_erp_items_meta_manage'), upload.single('excel_file'), importItemsHandler);

/**
 * GET /raw-materials?thickness= — what a part of this thickness can be cut
 * from, ONE definition instead of the rule mirrored by hand in
 * `FE/api/rawMaterials.ts` (PLAN.md EU-11 item 7). Read-only reference data
 * for a picker, so gated on `protect` alone like `/steel-options` in
 * `orderItems.js`, not a manage permission.
 */
router.get('/raw-materials', protect, async (req, res) => {
  try {
    const cid = req.user?.companyId ?? req.user?.company_id;
    const materials = await rawMaterialsFor(cid);
    const thickness = req.query?.thickness;
    res.json({ ok: true, materials: materialsForThickness(materials, thickness) });
  } catch (err) {
    return fail(res, err);
  }
});

export default router;
