/**
 * drawings.js — upload, list and fetch item drawings.
 *
 * Multer keeps the file in MEMORY rather than on disk, unlike the Excel routes.
 * Those write to a temp path and read it back; here the bytes go straight into
 * the row, so a disk round trip would only create a file to forget to delete —
 * and on Render's free plan that disk is wiped anyway.
 */

import express from 'express';
import multer from 'multer';
import { protect } from '../../../core/middleware/authmiddleware.js';
import { logger } from '../../../core/utils/logger.js';
import {
  drawingsForItem, drawingsForTask, addDrawing, readDrawing, deleteDrawing,
  MAX_STORED_BYTES,
} from '../services/drawingService.js';

const router = express.Router();

// Defined here, as in every other fab_erp route file — there is no shared
// middleware module and inventing one for this would leave two conventions.
const requirePerm = (tag) => (req, res, next) => {
  if (!Array.isArray(req.user?.uiPermissions) || !req.user.uiPermissions.includes(tag)) {
    return res.status(403).json({ message: `Permission required: ${tag}` });
  }
  next();
};
const companyId = (req) => req.user?.companyId ?? req.user?.company_id;

// A generous multipart ceiling; drawingService applies the real limit against
// the COMPRESSED size, which is the number that has to fit in the row.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 32 * 1024 * 1024 },
});

const fail = (res, err, what) => {
  if (err.status) return res.status(err.status).json({ message: err.message });
  logger.error({ err }, `fab_erp: ${what} failed`);
  return res.status(500).json({ message: err.message });
};

/** GET — this item's drawings plus every ancestor's. */
router.get('/items/:itemId/drawings', protect, async (req, res) => {
  try {
    res.json({ drawings: await drawingsForItem(companyId(req), Number(req.params.itemId)) });
  } catch (err) { fail(res, err, 'drawingsForItem'); }
});

/**
 * GET — the drawings an operator can see from a task.
 *
 * Read-only and gated only by `protect`: somebody at a machine needs the
 * drawing for the job in front of them, and requiring a manage permission to
 * LOOK at it would put the drawing behind the same gate as editing the order.
 */
router.get('/tasks/:taskId/drawings', protect, async (req, res) => {
  try {
    res.json({ drawings: await drawingsForTask(companyId(req), Number(req.params.taskId)) });
  } catch (err) { fail(res, err, 'drawingsForTask'); }
});

/** POST — attach a PDF to an item. */
router.post(
  '/items/:itemId/drawings',
  protect,
  requirePerm('fab_erp_projects_manage'),
  upload.single('file'),
  async (req, res) => {
    try {
      const result = await addDrawing(
        companyId(req), Number(req.params.itemId), req.file,
        { revision: req.body?.revision, notes: req.body?.notes },
        req.user?.id ?? null,
      );
      res.json({ ok: true, ...result, limitBytes: MAX_STORED_BYTES });
    } catch (err) { fail(res, err, 'addDrawing'); }
  },
);

/** GET — the file itself, inline so a browser tab can render the PDF. */
router.get('/drawings/:id/file', protect, async (req, res) => {
  try {
    const { buffer, fileName, mimeType } = await readDrawing(companyId(req), Number(req.params.id));
    res.setHeader('Content-Type', mimeType);
    // `inline` so clicking opens the drawing rather than downloading it — on a
    // shop floor tablet, a downloaded file is one nobody finds again.
    res.setHeader('Content-Disposition', `inline; filename="${fileName.replace(/"/g, '')}"`);
    res.send(buffer);
  } catch (err) { fail(res, err, 'readDrawing'); }
});

router.delete('/drawings/:id', protect, requirePerm('fab_erp_projects_manage'), async (req, res) => {
  try {
    res.json(await deleteDrawing(companyId(req), Number(req.params.id)));
  } catch (err) { fail(res, err, 'deleteDrawing'); }
});

export default router;
