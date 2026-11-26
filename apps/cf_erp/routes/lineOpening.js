/**
 * lineOpening.js — AN ORDER LINE'S OPENING READS IN ONE STREAMED ANSWER (speed, 2026-11-26).
 *
 *   GET /orders/:orderId/lines/:lineId/opening?parts=values,drawings,placeholders,drawingImport,standard,curve
 *
 * When the order page opens a line's Structure & values group it reads six things about the line (multi_app_fe
 * api/linePrefetch.ts). Six requests each paid for their own sign-in check (two statements) and, behind a server that
 * speaks HTTP/1.1, waited for one of the browser's six connections to the API among everything else the page asks.
 * Here they are one request: the parts run side by side on the pool and each is sent the moment it is ready, one JSON
 * per line (NDJSON):
 *
 *   {"part":"curve","status":200,"body":{…}}
 *   {"part":"values","status":200,"body":{…}}
 *   {"part":"drawings","status":404}
 *
 * A part's body is EXACTLY what its own endpoint answers (the same service, called the same way), so the screen takes
 * it as if it had asked that endpoint; a part that failed says only its status, and the screen then asks its own
 * endpoint, which answers with the error in full. Every part needs the order view grant, as each endpoint does; the
 * company comes from the token and the line must be on the order and in the company before anything is read. Reads
 * only — the structure (whose read may choose selections) is not a part. The six endpoints stay as they are.
 *
 * NOT ONE MEMO SCOPE: the parts share little (one explosion between drawings and placeholders), and the roll-out
 * (placeholders) marks the memoised tree it is handed (rollOutService: made, parentNode, flows) — a shared scope would
 * hand drawings a tree another part had changed. Each part reads as its endpoint does.
 */
import { Router } from 'express';
import { pool } from '../lib/db.js';
import { PERM, guard, ctx, intParam } from '../lib/http.js';
import { fail } from '../../../core/middleware/requirePerm.js';
import { translateDbError } from '../lib/errors.js';
import { logger } from '../../../core/utils/logger.js';
import { assertLineOnOrder } from '../services/nestingService.js';
import { readLineValues } from '../services/orderValuesService.js';
import { getDrawings } from '../services/partDrawingService.js';
import { linePlaceholders } from '../services/placeholderService.js';
import { lineDrawingImport } from '../services/drawingLineService.js';
import { lineStandard } from '../services/standardDrawingService.js';
import { lineCurve } from '../services/curveService.js';

const router = Router();

/** Each part: the service its own endpoint calls, with the same arguments. */
export const OPENING_PARTS = {
  values: (companyId, lineId) => readLineValues(pool, companyId, lineId),
  drawings: (companyId, lineId) => getDrawings(pool, companyId, null, lineId),
  placeholders: (companyId, lineId) => linePlaceholders(pool, companyId, lineId),
  drawingImport: (companyId, lineId) => lineDrawingImport(pool, companyId, lineId),
  standard: (companyId, lineId) => lineStandard(pool, companyId, lineId),
  curve: (companyId, lineId) => lineCurve(pool, companyId, lineId),
};

/** The handler (exported for the read-only check script; the route below puts the grant in front of it). */
export async function streamOpening(req, res) {
  let lineId;
  let companyId;
  let parts;
  try {
    ({ companyId } = ctx(req));
    const orderId = intParam(req.params.orderId, 'orderId');
    const asked = String(req.query.parts ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    parts = asked.length ? [...new Set(asked)] : Object.keys(OPENING_PARTS);
    const unknown = parts.filter((p) => !Object.hasOwn(OPENING_PARTS, p));
    if (unknown.length) return res.status(422).json({ code: 'INVALID', message: `No such part of a line's opening: ${unknown.join(', ')}.` });
    // The line is on this order and in this company (the drawings endpoint's own check), before anything is read.
    lineId = await assertLineOnOrder(pool, companyId, orderId, intParam(req.params.lineId, 'lineId'));
  } catch (err) {
    return fail(res, translateDbError(err));
  }
  res.status(200);
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  // nginx (the AWS server) would otherwise hold the parts until the last one: they are meant to arrive one by one.
  res.setHeader('X-Accel-Buffering', 'no');
  const send = (line) => {
    if (res.writableEnded || res.destroyed) return;
    res.write(`${JSON.stringify(line)}\n`);
    // Compressed (index.js): push what is written so far through gzip now, not when the answer ends.
    if (typeof res.flush === 'function') res.flush();
  };
  await Promise.all(parts.map(async (part) => {
    try {
      const body = await OPENING_PARTS[part](companyId, lineId);
      send({ part, status: 200, body: body ?? { ok: true } });
    } catch (e) {
      const err = translateDbError(e);
      const status = Number(err?.status) || 500;
      if (status >= 500) logger.error({ err: err?.cause ?? err, part, lineId, companyId }, '[cf_erp] a part of a line opening failed');
      send({ part, status });
    }
  }));
  res.end();
}

router.get('/orders/:orderId/lines/:lineId/opening', guard(PERM.ordersView), streamOpening);

export default router;
