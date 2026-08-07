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
import { dayGaps, rangeGaps, dayBoundsForResource } from '../services/gapService.js';
import { reasonCatalogue, findReason, SCOPE_SITE, SCOPE_MACHINE, SCOPE_TASK } from '../services/gapReasons.js';
import { recomputeForResourceWindow } from '../services/taskAttributionService.js';
import { zonedWallClockToUtc, zonedYMD } from '../services/plantTime.js';
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

// `?date=` returns ONE day, flat — kept because the Exception Feed deep-links
// straight to the day an idle segment sits on.
// `?from=&to=` returns the range grouped by SHIFT INSTANCE, which is what the
// Shift Log uses: a 22:00–06:00 shift is one thing a crew worked, and the
// calendar day splits it across two sheets.
router.get('/gaps', protect, async (req, res) => {
  if (!requirePerm(req, res)) return;
  const resourceId = Number(req.query.resourceId);
  const date = String(req.query.date ?? '');
  const from = String(req.query.from ?? '');
  const to = String(req.query.to ?? '');
  if (!(resourceId > 0)) return res.status(400).json({ message: 'resourceId is required.' });

  try {
    if (isDate(from) && isDate(to)) {
      if (from > to) return res.status(400).json({ message: '"from" must not be after "to".' });
      const out = await rangeGaps(req.user.companyId, resourceId, from, to);
      if (!out) return res.status(404).json({ message: 'Machine not found.' });
      return res.json({ ok: true, ...out });
    }
    if (!isDate(date)) {
      return res.status(400).json({ message: 'Provide date=YYYY-MM-DD, or from= and to=.' });
    }
    const out = await dayGaps(req.user.companyId, resourceId, date);
    if (!out) return res.status(404).json({ message: 'Machine not found.' });
    return res.json({ ok: true, ...out });
  } catch (err) {
    logger.error({ err, resourceId, date, from, to }, 'fab_erp gaps: read failed');
    return res.status(500).json({ message: 'Failed to load.' });
  }
});

// ── GET /gaps/coverage ───────────────────────────────────────────────────────
// Totals only, every machine, one request. The Shift Log tab strip colours a dot
// per machine; asking dayGaps per machine would be 43 round trips in prod for
// numbers that fit in one row each.

router.get('/gaps/coverage', protect, async (req, res) => {
  if (!requirePerm(req, res)) return;
  const companyId = req.user.companyId;
  const from = String(req.query.from ?? '');
  const to = String(req.query.to ?? '');
  if (!isDate(from) || !isDate(to)) {
    return res.status(400).json({ message: 'from and to must be YYYY-MM-DD.' });
  }

  try {
    const [machines] = await pool.query(
      `SELECT id, name, code FROM fab_resources
        WHERE company_id = ? AND deleted_at IS NULL ORDER BY name`,
      [companyId],
    );

    const out = [];
    for (const m of machines) {
      try {
        const r = await rangeGaps(companyId, m.id, from, to);
        out.push({
          resourceId: m.id, name: m.name, code: m.code,
          workingMinutes: r?.workingMinutes ?? 0,
          explainedMinutes: r?.explainedMinutes ?? 0,
          gapMinutes: r?.gapMinutes ?? 0,
          // GREY, not red, when there is nothing to account for. A machine with
          // no shift has no obligation, and colouring it red would train people
          // to ignore the dot in the first week — it only works if it is
          // believed. Amber means real unaccounted time; green means done.
          state: (r?.workingMinutes ?? 0) === 0 ? 'none'
            : (r.gapMinutes > 0 ? 'partial' : 'complete'),
        });
      } catch (err) {
        // One bad machine must not blank the whole strip.
        logger.warn({ err, resourceId: m.id }, 'gaps coverage: machine failed');
        out.push({ resourceId: m.id, name: m.name, code: m.code, workingMinutes: 0, explainedMinutes: 0, gapMinutes: 0, state: 'none' });
      }
    }
    return res.json({ ok: true, from, to, machines: out });
  } catch (err) {
    logger.error({ err, companyId }, 'fab_erp gaps: coverage failed');
    return res.status(500).json({ message: 'Failed to load coverage.' });
  }
});

// ── POST /gaps/explain ───────────────────────────────────────────────────────
// Body: { resourceId, date, code, fromTime, toTime, windowStart?, taskId?, ... }
//
// Times are WALL CLOCK at the site — the same convention as leave. Converting in
// the browser would be right only while whoever is typing sits in the same
// country as the plant.
//
// `windowStart` is the instant the shift being written up began, and it exists
// because wall clock alone is ambiguous on a night shift. A 22:00–06:00 shift
// whose gap runs 01:00–06:00 has BOTH times after midnight: resolved against the
// shift's start date they land 24h early, in the PREVIOUS night's shift — which
// is itself usually unaccounted, so the write would have succeeded silently and
// filed the reason against the wrong night. Sending the window start lets the
// server roll times forward onto the correct side of midnight.

router.post('/gaps/explain', protect, async (req, res) => {
  if (!requirePerm(req, res)) return;
  const companyId = req.user.companyId;
  const { resourceId, date, code, fromTime, toTime, windowStart, taskId, party, reference, note } = req.body ?? {};

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
    // Resolve wall clock N days after the anchor date. Re-resolving through the
    // timezone rather than adding 24h is what keeps this right across a DST
    // boundary, where a "day" is 23 or 25 hours.
    const nDaysOn = (t, n) => {
      const d = new Date(`${date}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() + n);
      return zonedWallClockToUtc(d.toISOString().slice(0, 10), norm(t), bounds.tz);
    };

    let from = nDaysOn(fromTime, 0);
    let to = nDaysOn(toTime, 0);
    if (!from || !to) return res.status(400).json({ message: 'Times are not valid.' });

    // Both times sit after midnight on a night shift — push the pair forward.
    const anchor = windowStart ? new Date(windowStart) : null;
    if (anchor && !Number.isNaN(+anchor) && from < anchor) {
      const rolled = nDaysOn(fromTime, 1);
      if (rolled) { from = rolled; to = nDaysOn(toTime, 1) ?? to; }
    }
    // Runs past midnight — a night shift's tail belongs to the next day.
    if (to <= from) to = nDaysOn(toTime, from >= nDaysOn(fromTime, 1) ? 2 : 1) ?? to;

    // Must land inside a real gap. Explaining time that is already accounted for
    // is meaningless — the engine's segments do not overlap, so the UI must not
    // be able to express something the model cannot store.
    //
    // Checked against SHIFT gaps over the days the span actually touches, not
    // against one calendar day's gaps. A day's gaps are clipped at midnight, so
    // a 23:00–01:00 breakdown could never sit inside one and was rejected outright
    // — the very entry a night shift most needs to make.
    const spanFrom = zonedYMD(from, bounds.tz);
    const spanTo = zonedYMD(to, bounds.tz);
    const span = await rangeGaps(companyId, Number(resourceId), spanFrom, spanTo);
    const candidateGaps = span.instances.flatMap((i) => i.gaps);
    const insideAGap = candidateGaps.some((g) => from >= new Date(g.start) && to <= new Date(g.end));
    if (!insideAGap) {
      return res.status(409).json({
        code: 'NOT_IN_GAP',
        message: 'That span is outside the unaccounted time — it overlaps work or something already explained.',
        gaps: candidateGaps,
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

    // Re-derive so the residual the user sees is the engine's. The window has to
    // cover the span as written, which for a post-midnight entry reaches past the
    // anchor day's end.
    const reFrom = from < bounds.start ? from : bounds.start;
    const reTo = to > bounds.end ? to : bounds.end;
    recomputeForResourceWindow(companyId, Number(resourceId), reFrom, reTo)
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
