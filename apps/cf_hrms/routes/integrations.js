/**
 * integrations.js — punches from other devices and middleware (Matrix COSEC, Realtime,
 * eTimeTrackLite exports, custom readers). (TM/CF_HRMS_HIRING_SPEC.md §28.1, way in 2.)
 *
 *   POST /api/integrations/attendance/punches
 *        Authorization: Bearer hrk_…   (or X-Api-Key: hrk_…) — a per-company key the Owner made
 *        { "punches": [ { "employeeCode": "E0123", "time": "2026-10-05 09:02:11", "direction": "IN" },
 *                       { "deviceSerial": "GATE-01", "deviceUserId": "23", "time": "…" } ] }
 *     -> { received, inserted, duplicates, unmapped, rejected: [{ index, why }] }
 *        Idempotent: a punch already stored is a duplicate, not an error. At most 5,000 in the
 *        whole call (413 TOO_MANY above it). Every punch keeps the caller's address.
 *
 * No login, no company in the address: the KEY is the company. Mounted by multi_app_be/index.js
 * BEFORE the platform's appContext (which would read "integrations" as a company slug) AND before
 * the platform's 50 MB JSON parser: this router has its own, small (BODY_LIMIT), and runs the rate
 * limits and the key check BEFORE it parses anything. Rate-limited per key, and per address
 * (req.ip; the server trusts one proxy hop) for a key that is wrong.
 */
import express, { Router } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { pool, withTransaction } from '../lib/db.js';
import { HrmsError, translateDbError } from '../lib/errors.js';
import { logger } from '../../../core/utils/logger.js';
import { companyOfKey, apiPunches } from '../services/attendance/devices.js';
import { processAfterCommit } from '../services/attendance/punches.js';

/** 5,000 punches of ~150 bytes each fit well inside this. */
export const BODY_LIMIT = '2mb';

const router = Router();

const keyOf = (req) => {
  const h = String(req.headers.authorization ?? '');
  if (/^Bearer\s+/i.test(h)) return h.replace(/^Bearer\s+/i, '').trim();
  return String(req.headers['x-api-key'] ?? '').trim();
};

const perKey = rateLimit({
  windowMs: 60 * 1000, limit: 120, standardHeaders: true, legacyHeaders: false,
  keyGenerator: (req) => { const k = keyOf(req).slice(0, 13); return k ? `k:${k}` : `ip:${ipKeyGenerator(req.ip ?? '')}`; },
  message: { code: 'TOO_MANY', message: 'Too many calls with this key in a minute. Send punches in batches.' },
});
const badKeys = rateLimit({
  windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false, skipSuccessfulRequests: true,
  message: { code: 'TOO_MANY', message: 'Too many wrong keys from this address.' },
});

/** The key, checked BEFORE the body is parsed: a wrong key never gets a body read. */
async function keyCheck(req, res, next) {
  try {
    const key = await companyOfKey(pool, keyOf(req));
    if (!key) {
      logger.warn({ ip: req.ip }, '[cf_hrms] attendance API: a call with a missing, wrong or revoked key');
      res.set('Connection', 'close');
      return res.status(401).json({ code: 'BAD_KEY', message: 'The API key is missing, wrong or revoked.' });
    }
    req.attendanceKey = key;
    return next();
  } catch (err) {
    logger.error({ err: err.message }, '[cf_hrms] attendance API key check failed');
    return res.status(500).json({ code: 'ERROR', message: 'Something went wrong.' });
  }
}

/** Its own JSON parser: small, and a body that is too large or not JSON is said in words. */
const jsonBody = express.json({ limit: BODY_LIMIT });
function parseBody(req, res, next) {
  jsonBody(req, res, (err) => {
    if (!err) return next();
    if (err.type === 'entity.too.large') { res.set('Connection', 'close'); return res.status(413).json({ code: 'TOO_LARGE', message: `The body is larger than ${BODY_LIMIT.toUpperCase()}. Send punches in batches of at most 5,000.` }); }
    return res.status(400).json({ code: 'INVALID', message: 'The body is not JSON.' });
  });
}

router.post('/attendance/punches', badKeys, perKey, keyCheck, parseBody, async (req, res) => {
  try {
    const key = req.attendanceKey;
    const out = await withTransaction((conn) => apiPunches(conn, key, req.body ?? {}, req.ip));
    // Committed. Processing the days cannot fail the call (it logs and marks a retry).
    await processAfterCommit({ companyId: key.companyId, userId: null }, out.toProcess, { what: 'API' });
    return res.json(out);
  } catch (err) {
    const e = translateDbError(err);
    if (e instanceof HrmsError) return res.status(e.status).json({ code: e.code, message: e.message, ...(e.problems ? { problems: e.problems } : {}) });
    logger.error({ err: err.message }, '[cf_hrms] attendance API failed');
    return res.status(500).json({ code: 'ERROR', message: 'Something went wrong.' });
  }
});

export default router;
