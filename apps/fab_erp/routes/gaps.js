/**
 * gaps.js — explaining unaccounted machine time.
 *
 *   GET    /gap-reasons                 the catalogue (built-ins + site additions)
 *   GET    /gaps?resourceId=&date=      one machine-day: working, explained, left over
 *   POST   /gaps/explain                assert a reason over a span
 *   DELETE /gaps/explained/:stream/:id  withdraw one assertion
 *
 * The operator picks a reason; the reason's SCOPE decides which stream the
 * explanation is written to. They never learn the word "scope" — they pick
 * "Rain" and one plant event is written instead of nine machine events.
 *
 * Permission: `fab_erp_time_backfill`, the same tag that already gates the Shift
 * Log. This is end-of-day reconstruction and belongs with it, not behind a new
 * tag nobody has granted.
 */

import path from 'path';
import { Router } from 'express';
import multer from 'multer';
import { protect } from '../../../core/middleware/authmiddleware.js';
import { pool } from '../../../db.js';
import { logger } from '../../../core/utils/logger.js';
import { dayGaps, dayBoundsForResource } from '../services/gapService.js';
import { reasonCatalogue, findReason, SCOPE_SITE, SCOPE_MACHINE, SCOPE_TASK } from '../services/gapReasons.js';
import { recomputeForResourceWindow } from '../services/taskAttributionService.js';
import { zonedWallClockToUtc } from '../services/plantTime.js';
import { exportDayGaps, importDayGaps } from '../services/gapsImportService.js';

const router = Router();
const upload = multer({ dest: path.join(process.cwd(), 'tmp') });
const TAG = 'fab_erp_time_backfill';

function requirePerm(req, res) {
  const u = req.user;
  if (u?.role && String(u.role).toLowerCase() === 'admin') return true;
  if (Array.isArray(u?.uiPermissions) && u.uiPermissions.includes(TAG)) return true;
  res.status(403).json({ message: `Permission denied. Required: "${TAG}".` });
  return false;
}

const sqlUtc = (d) => new Date(d).toISOString().slice(0, 19).replace('T', ' ');
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

// ── GET /gap-reasons ─────────────────────────────────────────────────────────

router.get('/gap-reasons', protect, async (req, res) => {
  if (!requirePerm(req, res)) return;
  try {
    return res.json({ ok: true, reasons: await reasonCatalogue(req.user.companyId) });
  } catch (err) {
    logger.error({ err }, 'fab_erp gaps: reason catalogue failed');
    return res.status(500).json({ message: 'Failed to load reasons.' });
  }
});

// ── GET /gaps ────────────────────────────────────────────────────────────────

router.get('/gaps', protect, async (req, res) => {
  if (!requirePerm(req, res)) return;
  const resourceId = Number(req.query.resourceId);
  const date = String(req.query.date ?? '');
  if (!(resourceId > 0)) return res.status(400).json({ message: 'resourceId is required.' });
  if (!isDate(date)) return res.status(400).json({ message: 'date must be YYYY-MM-DD.' });

  try {
    const out = await dayGaps(req.user.companyId, resourceId, date);
    if (!out) return res.status(404).json({ message: 'Machine not found.' });
    return res.json({ ok: true, ...out });
  } catch (err) {
    logger.error({ err, resourceId, date }, 'fab_erp gaps: day read failed');
    return res.status(500).json({ message: 'Failed to load the day.' });
  }
});

// ── POST /gaps/explain ───────────────────────────────────────────────────────
// Body: { resourceId, date, code, fromTime, toTime, taskId?, party?, reference?, note? }
//
// Times are WALL CLOCK at the site — the same convention as leave. Converting in
// the browser would be right only while whoever is typing sits in the same
// country as the plant.

router.post('/gaps/explain', protect, async (req, res) => {
  if (!requirePerm(req, res)) return;
  const companyId = req.user.companyId;
  const { resourceId, date, code, fromTime, toTime, taskId, party, reference, note } = req.body ?? {};

  if (!(Number(resourceId) > 0)) return res.status(400).json({ message: 'resourceId is required.' });
  if (!isDate(date)) return res.status(400).json({ message: 'date must be YYYY-MM-DD.' });
  if (!code) return res.status(400).json({ message: 'A reason is required.' });
  if (!fromTime || !toTime) return res.status(400).json({ message: 'Both times are required.' });

  try {
    const reason = await findReason(companyId, code);
    if (!reason) return res.status(400).json({ message: `Unknown reason "${code}".` });

    const bounds = await dayBoundsForResource(companyId, Number(resourceId), date);
    if (!bounds) return res.status(404).json({ message: 'Machine not found.' });

    const norm = (t) => (/^\d{2}:\d{2}$/.test(String(t)) ? `${t}:00` : String(t));
    const from = zonedWallClockToUtc(date, norm(fromTime), bounds.tz);
    let to = zonedWallClockToUtc(date, norm(toTime), bounds.tz);
    if (!from || !to) return res.status(400).json({ message: 'Times are not valid.' });
    // Runs past midnight — a night shift's tail belongs to the next day.
    if (to <= from) {
      const next = new Date(`${date}T00:00:00Z`);
      next.setUTCDate(next.getUTCDate() + 1);
      to = zonedWallClockToUtc(next.toISOString().slice(0, 10), norm(toTime), bounds.tz);
    }

    // Must land inside a real gap. Explaining time that is already accounted for
    // is meaningless — the engine's segments do not overlap, so the UI must not
    // be able to express something the model cannot store.
    const day = await dayGaps(companyId, Number(resourceId), date);
    const insideAGap = day.gaps.some((g) => from >= g.start && to <= g.end);
    if (!insideAGap) {
      return res.status(409).json({
        code: 'NOT_IN_GAP',
        message: 'That span is outside the unaccounted time — it overlaps work or something already explained.',
        gaps: day.gaps,
      });
    }

    // The reason's scope picks the stream.
    let wrote;
    if (reason.scope === SCOPE_SITE) {
      const [ins] = await pool.query(
        `INSERT INTO fab_plant_events (company_id, plant_id, event_code, from_ts, to_ts, note, source, entered_by)
         VALUES (?, ?, ?, ?, ?, ?, 'backfill', ?)`,
        [companyId, bounds.plantId, code, sqlUtc(from), sqlUtc(to), note ?? null, req.user.id],
      );
      wrote = { stream: 'plant', id: ins.insertId, scope: 'site' };
    } else if (reason.scope === SCOPE_TASK) {
      if (!(Number(taskId) > 0)) {
        return res.status(400).json({ message: `"${reason.label}" applies to a job — pick which task.` });
      }
      const [ins] = await pool.query(
        `INSERT INTO fab_task_holds (company_id, task_id, hold_code, from_ts, to_ts, party, reference, note, source, entered_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'backfill', ?)`,
        [companyId, Number(taskId), code, sqlUtc(from), sqlUtc(to), party ?? null, reference ?? null, note ?? null, req.user.id],
      );
      wrote = { stream: 'hold', id: ins.insertId, scope: 'task' };
    } else if (reason.scope === SCOPE_MACHINE) {
      // Machine state is a TIMELINE, so a closed period is two events: it went
      // down, then it came back. Without the second the board reads the machine
      // as still down forever — the same pairing the Shift Log already does.
      const [ins] = await pool.query(
        `INSERT INTO fab_resource_events (company_id, resource_id, state, reason_code, at, source, entered_by, note)
         VALUES (?, ?, 'down', ?, ?, 'backfill', ?, ?)`,
        [companyId, Number(resourceId), code, sqlUtc(from), req.user.id, note ?? null],
      );
      await pool.query(
        `INSERT INTO fab_resource_events (company_id, resource_id, state, reason_code, at, source, entered_by, note)
         VALUES (?, ?, 'idle', NULL, ?, 'backfill', ?, ?)`,
        [companyId, Number(resourceId), sqlUtc(to), req.user.id, `end of ${code}`],
      );
      wrote = { stream: 'resource', id: ins.insertId, scope: 'machine' };
    } else {
      return res.status(400).json({ message: `Reason "${code}" has no usable scope.` });
    }

    // Re-derive over the day so the residual the user sees is the engine's.
    recomputeForResourceWindow(companyId, Number(resourceId), bounds.start, bounds.end)
      .catch((err) => logger.error({ err, resourceId }, 'gaps: recompute failed'));

    const after = await dayGaps(companyId, Number(resourceId), date);
    return res.status(201).json({ ok: true, wrote, ...after });
  } catch (err) {
    logger.error({ err, companyId, resourceId, date }, 'fab_erp gaps: explain failed');
    return res.status(500).json({ message: 'Failed to record the reason.' });
  }
});

// ── Excel round-trip ─────────────────────────────────────────────────────────
// GET  /gaps/export?date=      the day's gaps, one row each, with dropdowns and
//                              per-row time bounds already in the file
// POST /gaps/import?date=      sense-check (default) or commit=true

router.get('/gaps/export', protect, async (req, res) => {
  if (!requirePerm(req, res)) return;
  const date = String(req.query.date ?? '');
  if (!isDate(date)) return res.status(400).json({ message: 'date must be YYYY-MM-DD.' });
  const ids = String(req.query.resourceIds ?? '').split(',').map(Number).filter((n) => n > 0);
  try {
    const { buffer } = await exportDayGaps(req.user.companyId, date, ids.length ? ids : null);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="Gaps_${date}.xlsx"`);
    return res.send(Buffer.from(buffer));
  } catch (err) {
    logger.error({ err, date }, 'fab_erp gaps: export failed');
    return res.status(500).json({ message: 'Failed to build the sheet.' });
  }
});

router.post('/gaps/import', protect, upload.single('excel_file'), async (req, res) => {
  if (!requirePerm(req, res)) return;
  const date = String(req.query.date ?? req.body?.date ?? '');
  if (!isDate(date)) return res.status(400).json({ message: 'date must be YYYY-MM-DD.' });
  if (!req.file) return res.status(400).json({ message: 'No file uploaded.' });

  // Default is the SENSE CHECK. Committing has to be asked for, so the operator
  // always sees what would happen before anything is written.
  const commit = req.query.commit === 'true' || req.body?.commit === true;
  try {
    const out = await importDayGaps(req.file, req.user.companyId, date, req.user.id, { commit });
    // A file that fails validation is a 200 with ok:false — the caller needs the
    // per-row list to render, and an error status sends it down the generic
    // "request failed" path where that list is lost.
    return res.json({ ...out, committed: commit && out.ok });
  } catch (err) {
    logger.error({ err, date }, 'fab_erp gaps: import failed');
    return res.status(400).json({ message: err.message });
  }
});

// ── DELETE /gaps/explained/:stream/:id ───────────────────────────────────────
// Withdraw one assertion. Soft-delete: the gap reopens rather than the record
// vanishing, so a mistaken explanation stays visible as having been made.

router.delete('/gaps/explained/:stream/:id', protect, async (req, res) => {
  if (!requirePerm(req, res)) return;
  const companyId = req.user.companyId;
  const id = Number(req.params.id);
  const stream = String(req.params.stream);
  const resourceId = Number(req.query.resourceId);
  const date = String(req.query.date ?? '');
  if (!(id > 0)) return res.status(400).json({ message: 'A valid id is required.' });

  const TABLES = { plant: 'fab_plant_events', hold: 'fab_task_holds', resource: 'fab_resource_events' };
  const table = TABLES[stream];
  if (!table) return res.status(400).json({ message: `Unknown stream "${stream}".` });

  try {
    await pool.query(
      `UPDATE ${table} SET deleted_at = UTC_TIMESTAMP() WHERE id = ? AND company_id = ?`,
      [id, companyId],
    );
    if (resourceId > 0 && isDate(date)) {
      const bounds = await dayBoundsForResource(companyId, resourceId, date);
      if (bounds) {
        recomputeForResourceWindow(companyId, resourceId, bounds.start, bounds.end)
          .catch((err) => logger.error({ err }, 'gaps: recompute after withdraw failed'));
      }
      return res.json({ ok: true, ...(await dayGaps(companyId, resourceId, date)) });
    }
    return res.json({ ok: true });
  } catch (err) {
    logger.error({ err, stream, id }, 'fab_erp gaps: withdraw failed');
    return res.status(500).json({ message: 'Failed to withdraw.' });
  }
});

export default router;
