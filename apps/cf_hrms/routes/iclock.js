/**
 * iclock.js — the ZKTeco / eSSL ADMS push ("iclock"), at the SERVER ROOT: the protocol fixes the
 * path, so it cannot live under /api/<company>/cf_hrms. (TM/CF_HRMS_HIRING_SPEC.md §28.1, way in 1;
 * the protocol in services/attendance/adms.js.)
 *
 *   GET  /iclock/cdata?SN=…            handshake -> the options text
 *   POST /iclock/cdata?SN=…&table=…    ATTLOG (punches) / OPERLOG (stored, not acted on) -> "OK: n"
 *   GET  /iclock/getrequest?SN=…       commands for the device -> "OK" (none, ever)
 *   POST /iclock/devicecmd?SN=…        a command's result -> "OK"
 *   GET|POST /iclock/fdata, /iclock/ping  -> "OK"
 *
 * THE ORDER, for every request (2026-10-20 hardening):
 *   1. the rate limit, per address (req.ip — the server sets `trust proxy` to 1 hop, Render's);
 *   2. the serial: unknown or disabled -> 403, logged, and NOTHING of the body is read;
 *   3. the device's allowed addresses, if it has any: another address -> 403, logged and noted
 *      on the Devices screen (IP_REFUSED), nothing read;
 *   4. only then the body, read here with a 1 MB cap: a declared Content-Length above it is
 *      refused (413) before a byte is read, and a body that grows past it is cut off with 413.
 * The company is the one the SERIAL is registered to (Attendance › Devices). Nothing a device
 * sends can do more than add punches. The punches commit first; their days are processed after
 * (punches.processAfterCommit) — a processing error never fails the device or loses a punch.
 *
 * Mounted by multi_app_be/index.js BEFORE the JSON / form body parsers: a device sends plain
 * text (often with no content type, or "application/x-www-form-urlencoded").
 */
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { pool, withTransaction } from '../lib/db.js';
import { logger } from '../../../core/utils/logger.js';
import { deviceBySerial, addressAllowed, admsHandshake, admsUpload, admsPoll } from '../services/attendance/devices.js';
import { processAfterCommit } from '../services/attendance/punches.js';

/** The most a device may send in one request. 12,000 ATTLOG lines are about 0.5 MB. */
export const MAX_BODY_BYTES = 1024 * 1024;

const router = Router();
// FIRST: a device polls every few seconds; a busy plant has many devices behind one address.
// Keyed by req.ip (the default key generator; IPv6 by /56), which `trust proxy` makes the client's.
router.use(rateLimit({ windowMs: 60 * 1000, limit: 1200, standardHeaders: false, legacyHeaders: false, message: 'Too many requests' }));

const text = (res, status, body) => res.status(status).type('text/plain').send(body);
/** A refusal before the body is read: the connection is closed after it, so the unread body is not waited for. */
const refuse = (res, status, body) => { res.set('Connection', 'close'); return text(res, status, body); };
const serialOf = (req) => String(req.query.SN ?? req.query.sn ?? '').trim();

/** The registered device of this request, allowed from this address — or a 403 already sent. Reads no body. */
async function deviceOf(req, res) {
  const sn = serialOf(req);
  const d = sn ? await deviceBySerial(pool, sn) : null;
  if (!d) {
    logger.warn({ sn: sn.slice(0, 64), ip: req.ip, path: req.path }, '[cf_hrms] iclock: unknown or disabled device serial refused');
    refuse(res, 403, 'Unknown device');
    return null;
  }
  if (!await addressAllowed(pool, d, req.ip)) {
    logger.warn({ deviceId: d.id, companyId: d.company_id, ip: req.ip, path: req.path }, '[cf_hrms] iclock: a device serial from an address outside its allowed addresses refused');
    refuse(res, 403, 'Address not allowed');
    return null;
  }
  return d;
}

/**
 * The request body as text, at most `limit` bytes — or null with a 413 already sent. A declared
 * Content-Length over the limit is refused before reading; a body that grows past it is cut off.
 */
export function readCappedBody(req, res, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) { refuse(res, 413, 'Too large'); resolve(null); return; }
    if (req.readableEnded) { resolve(typeof req.body === 'string' ? req.body : ''); return; }
    const chunks = [];
    let size = 0;
    let done = false;
    const finish = (v, err) => {
      if (done) return;
      done = true;
      req.off('data', onData); req.off('end', onEnd); req.off('error', onError);
      if (err) reject(err); else resolve(v);
    };
    const onData = (chunk) => {
      size += chunk.length;
      if (size > limit) { req.pause(); refuse(res, 413, 'Too large'); finish(null); return; }
      chunks.push(chunk);
    };
    const onEnd = () => finish(Buffer.concat(chunks).toString('utf8'));
    const onError = (err) => finish(null, err);
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
  });
}

const wrap = (fn) => async (req, res) => {
  try { await fn(req, res); } catch (err) {
    logger.error({ err: err.message, sn: serialOf(req).slice(0, 64) }, '[cf_hrms] iclock failed');
    if (!res.headersSent) text(res, 500, 'ERROR');
  }
};

router.get('/cdata', wrap(async (req, res) => {
  const d = await deviceOf(req, res);
  if (!d) return;
  text(res, 200, await admsHandshake(pool, d, { ip: req.ip, query: req.query }));
}));

router.post('/cdata', wrap(async (req, res) => {
  const d = await deviceOf(req, res);
  if (!d) return;
  const body = await readCappedBody(req, res);
  if (body === null) return;
  const out = await withTransaction((conn) => admsUpload(conn, d, { ip: req.ip, query: req.query, body }));
  // The punches are committed. Processing their days cannot fail this request (it logs and marks a retry).
  await processAfterCommit({ companyId: d.company_id, userId: null }, out.toProcess, { what: 'ADMS' });
  text(res, 200, out.text);
}));

router.get('/getrequest', wrap(async (req, res) => {
  const d = await deviceOf(req, res);
  if (!d) return;
  text(res, 200, await admsPoll(pool, d, { ip: req.ip }));
}));

router.post('/devicecmd', wrap(async (req, res) => {
  const d = await deviceOf(req, res);
  if (!d) return;
  if (await readCappedBody(req, res) === null) return; // a command's result: read (capped) and dropped
  await admsPoll(pool, d, { ip: req.ip });
  text(res, 200, 'OK');
}));

for (const path of ['/fdata', '/ping']) {
  router.all(path, wrap(async (req, res) => {
    const d = await deviceOf(req, res);
    if (!d) return;
    if (req.method === 'POST' && await readCappedBody(req, res) === null) return;
    text(res, 200, 'OK');
  }));
}

export default router;
