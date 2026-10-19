/**
 * integrations.js — punches from other devices and middleware (Matrix COSEC, Realtime,
 * eTimeTrackLite exports, custom readers). (TM/CF_HRMS_HIRING_SPEC.md §28.1, way in 2.)
 *
 *   POST /api/integrations/attendance/punches
 *        Authorization: Bearer hrk_…   (or X-Api-Key: hrk_…) — a per-company key the Owner made
 *        { "punches": [ { "employeeCode": "E0123", "time": "2026-10-05 09:02:11", "direction": "IN" },
 *                       { "deviceSerial": "GATE-01", "deviceUserId": "23", "time": "…" } ] }
 *     -> { received, inserted, duplicates, unmapped, rejected: [{ index, why }] }
 *        Idempotent: a punch already stored is a duplicate, not an error. At most 5,000 a call.
 *
 * No login, no company in the address: the KEY is the company. Mounted by multi_app_be/index.js
 * before the platform's appContext (which would read "integrations" as a company slug).
 * Rate-limited per key, and per address for a key that is wrong.
 */
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { pool, withTransaction } from '../lib/db.js';
import { HrmsError, translateDbError } from '../lib/errors.js';
import { logger } from '../../../core/utils/logger.js';
import { companyOfKey, apiPunches } from '../services/attendance/devices.js';

const router = Router();

const keyOf = (req) => {
  const h = String(req.headers.authorization ?? '');
  if (/^Bearer\s+/i.test(h)) return h.replace(/^Bearer\s+/i, '').trim();
  return String(req.headers['x-api-key'] ?? '').trim();
};

const perKey = rateLimit({
  windowMs: 60 * 1000, limit: 120, standardHeaders: true, legacyHeaders: false, validate: false,
  keyGenerator: (req) => `k:${keyOf(req).slice(0, 13) || req.ip}`,
  message: { code: 'TOO_MANY', message: 'Too many calls with this key in a minute. Send punches in batches.' },
});
const badKeys = rateLimit({
  windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false, validate: false, skipSuccessfulRequests: true,
  message: { code: 'TOO_MANY', message: 'Too many wrong keys from this address.' },
});

router.post('/attendance/punches', badKeys, perKey, async (req, res) => {
  try {
    const key = await companyOfKey(pool, keyOf(req));
    if (!key) {
      logger.warn({ ip: req.ip }, '[cf_hrms] attendance API: a call with a missing, wrong or revoked key');
      return res.status(401).json({ code: 'BAD_KEY', message: 'The API key is missing, wrong or revoked.' });
    }
    const out = await withTransaction((conn) => apiPunches(conn, key, req.body ?? {}, req.ip));
    return res.json(out);
  } catch (err) {
    const e = translateDbError(err);
    if (e instanceof HrmsError) return res.status(e.status).json({ code: e.code, message: e.message, ...(e.problems ? { problems: e.problems } : {}) });
    logger.error({ err: err.message }, '[cf_hrms] attendance API failed');
    return res.status(500).json({ code: 'ERROR', message: 'Something went wrong.' });
  }
});

export default router;
