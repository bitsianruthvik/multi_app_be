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
 * The company is the one the SERIAL is registered to (Attendance › Devices). An unknown or
 * disabled serial gets 403 and is logged; nothing it sends is read. Nothing a device sends can
 * do more than add punches. Rate-limited per address.
 *
 * Mounted by multi_app_be/index.js BEFORE the JSON / form body parsers: a device sends plain
 * text (often with no content type, or "application/x-www-form-urlencoded"), and this router
 * reads the raw body itself.
 */
import express, { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { pool, withTransaction } from '../lib/db.js';
import { logger } from '../../../core/utils/logger.js';
import { deviceBySerial, admsHandshake, admsUpload, admsPoll } from '../services/attendance/devices.js';

const router = Router();
router.use(express.text({ type: () => true, limit: '5mb' }));
// A device polls every few seconds; a busy plant has many devices behind one address.
router.use(rateLimit({ windowMs: 60 * 1000, limit: 1200, standardHeaders: false, legacyHeaders: false, validate: false, message: 'Too many requests' }));

const text = (res, status, body) => res.status(status).type('text/plain').send(body);
const serialOf = (req) => String(req.query.SN ?? req.query.sn ?? '').trim();

/** The registered device of this request, or a 403 already sent. */
async function deviceOf(req, res) {
  const sn = serialOf(req);
  const d = sn ? await deviceBySerial(pool, sn) : null;
  if (!d) {
    logger.warn({ sn: sn.slice(0, 64), ip: req.ip, path: req.path }, '[cf_hrms] iclock: unknown or disabled device serial refused');
    text(res, 403, 'Unknown device');
    return null;
  }
  return d;
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
  const body = typeof req.body === 'string' ? req.body : '';
  const out = await withTransaction((conn) => admsUpload(conn, d, { ip: req.ip, query: req.query, body }));
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
  await admsPoll(pool, d, { ip: req.ip });
  text(res, 200, 'OK');
}));

for (const path of ['/fdata', '/ping']) {
  router.all(path, wrap(async (req, res) => {
    const d = await deviceOf(req, res);
    if (!d) return;
    text(res, 200, 'OK');
  }));
}

export default router;
