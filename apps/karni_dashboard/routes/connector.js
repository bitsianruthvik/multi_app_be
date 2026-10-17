import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import { Router } from 'express';
import { pool } from '../../../db.js';
import { DATASETS, byKey, pathFor, keyOf, dateOf } from '../lib/datasets.js';
import { invalidate } from '../services/reportService.js';

/**
 * The connector's side: no platform login. A connector proves itself with the
 * secret it made at setup (we keep its SHA-256 only) and works only after an
 * admin approves it on the Connection screen.
 *
 *   POST /connector/register  { connectorUid, secretHash, machine, winUser }  → pending
 *   GET  /connector/plan                                                     → what to read
 *   POST /connector/push      { dataset, rows, done, startedAt }             → stored
 *   POST /connector/report    { startedAt, finishedAt, results }             → run logged
 *
 * Headers on all but register: X-Connector-Id, Authorization: Bearer <secret>.
 */
const router = Router({ mergeParams: true });
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const MAX_PENDING = 5;
const INTERVAL_MIN = 10;

function needCompany(req, res) {
  if (!req.company?.id || !req.appCtx) {
    res.status(404).json({ error: 'This company has no karni_dashboard app.' });
    return false;
  }
  return true;
}

/** The connector's scripts, for setup on the customer's machine. No secrets in them. */
const CONNECTOR_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'connector');
router.get('/connector/files/:name', (req, res) => {
  if (!['run.ps1', 'setup.ps1'].includes(req.params.name)) return res.status(404).end();
  res.type('text/plain').sendFile(path.join(CONNECTOR_DIR, req.params.name));
});

router.post('/connector/register', async (req, res) => {
  if (!needCompany(req, res)) return;
  const { connectorUid, secretHash, machine, winUser } = req.body || {};
  if (!/^[A-Za-z0-9-]{16,64}$/.test(connectorUid || '') || !/^[0-9a-f]{64}$/.test(secretHash || '')) {
    return res.status(400).json({ error: 'connectorUid and secretHash (sha256 hex) are required.' });
  }
  const [[existing]] = await pool.query('SELECT status, company_id FROM kd_connectors WHERE connector_uid = ?', [connectorUid]);
  if (existing) return res.json({ status: existing.status });
  const [[{ n }]] = await pool.query(
    "SELECT COUNT(*) AS n FROM kd_connectors WHERE company_id = ? AND status = 'pending'", [req.company.id]);
  if (n >= MAX_PENDING) return res.status(429).json({ error: 'Too many connectors waiting for approval.' });
  await pool.query(
    'INSERT INTO kd_connectors (company_id, connector_uid, secret_hash, machine, win_user) VALUES (?, ?, ?, ?, ?)',
    [req.company.id, connectorUid, secretHash, String(machine || '').slice(0, 120), String(winUser || '').slice(0, 120)]);
  res.status(201).json({ status: 'pending' });
});

/** Every other connector call: an approved connector of THIS company, or 401/403. */
async function connectorAuth(req, res, next) {
  if (!needCompany(req, res)) return;
  const uid = req.get('X-Connector-Id');
  const m = /^Bearer\s+(.+)$/.exec(req.get('Authorization') || '');
  if (!uid || !m) return res.status(401).json({ error: 'Connector id and secret required.' });
  const [[c]] = await pool.query('SELECT * FROM kd_connectors WHERE connector_uid = ?', [uid]);
  const ok = c && c.company_id === req.company.id
    && crypto.timingSafeEqual(Buffer.from(c.secret_hash), Buffer.from(sha256(m[1].trim())));
  if (!ok) return res.status(401).json({ error: 'Unknown connector.' });
  await pool.query('UPDATE kd_connectors SET last_seen_at = NOW() WHERE id = ?', [c.id]);
  if (c.status !== 'approved') return res.status(403).json({ status: c.status, error: `Connector is ${c.status}.` });
  req.connector = c;
  next();
}

router.get('/connector/plan', connectorAuth, async (req, res) => {
  const [state] = await pool.query('SELECT dataset, since_date FROM kd_dataset_state WHERE company_id = ?', [req.company.id]);
  const since = Object.fromEntries(state.map((s) => [s.dataset, s.since_date]));
  res.json({
    intervalMin: INTERVAL_MIN,
    pageSize: 500,
    // full: the connector gathers every page and pushes once (see /push).
    datasets: DATASETS.map((d) => ({ key: d.key, path: pathFor(d, since[d.key]), full: !!d.full })),
  });
});

router.post('/connector/push', connectorAuth, async (req, res) => {
  const { dataset, pages, done, startedAt } = req.body || {};
  // The connector forwards SAP's pages untouched; the rows are each page's "value".
  const rows = Array.isArray(pages) ? pages.flatMap((p) => (Array.isArray(p?.value) ? p.value : [])) : req.body?.rows;
  const ds = byKey[dataset];
  if (!ds || !Array.isArray(rows)) return res.status(400).json({ error: 'dataset and rows[] are required.' });
  const cid = req.company.id;
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500).filter((r) => r && typeof r === 'object');
    if (!chunk.length) continue;
    const values = chunk.map((r) => {
      const { 'odata.etag': _etag, ...clean } = r;
      return [cid, ds.key, keyOf(ds, clean).slice(0, 120), dateOf(ds, clean), JSON.stringify(clean)];
    });
    await pool.query(
      `INSERT INTO kd_rows (company_id, dataset, sap_key, doc_date, data) VALUES ?
       ON DUPLICATE KEY UPDATE doc_date = VALUES(doc_date), data = VALUES(data), synced_at = NOW()`,
      [values]);
  }
  if (done) {
    // A full list comes in ONE push and is the whole truth: rows SAP no longer
    // returns are gone. An empty push removes nothing (a glitch, not a wipe).
    if (ds.full && rows.length) {
      const keep = rows.map((r) => keyOf(ds, r).slice(0, 120));
      await pool.query('DELETE FROM kd_rows WHERE company_id = ? AND dataset = ? AND sap_key NOT IN (?)',
        [cid, ds.key, keep]);
    }
    // Next run reads what changed since the day before this run began.
    const since = startedAt ? new Date(new Date(startedAt).getTime() - 86400000) : null;
    const [[{ n }]] = await pool.query('SELECT COUNT(*) AS n FROM kd_rows WHERE company_id = ? AND dataset = ?', [cid, ds.key]);
    await pool.query(
      `INSERT INTO kd_dataset_state (company_id, dataset, since_date, last_ok_at, last_error, last_rows)
       VALUES (?, ?, ?, NOW(), NULL, ?)
       ON DUPLICATE KEY UPDATE since_date = VALUES(since_date), last_ok_at = NOW(), last_error = NULL, last_rows = VALUES(last_rows)`,
      [cid, ds.key, since, n]);
    invalidate(cid);
  }
  res.json({ ok: true, stored: rows.length });
});

router.post('/connector/report', connectorAuth, async (req, res) => {
  const { startedAt, finishedAt, results } = req.body || {};
  const cid = req.company.id;
  const list = results && typeof results === 'object' ? results : {};
  for (const [key, r] of Object.entries(list)) {
    if (byKey[key] && r && r.error) {
      await pool.query(
        `INSERT INTO kd_dataset_state (company_id, dataset, last_error) VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE last_error = VALUES(last_error)`,
        [cid, key, String(r.error).slice(0, 2000)]);
    }
  }
  const ok = Object.values(list).every((r) => r && !r.error);
  await pool.query(
    'INSERT INTO kd_sync_runs (company_id, connector_id, started_at, finished_at, ok, summary) VALUES (?, ?, ?, ?, ?, ?)',
    [cid, req.connector.id, new Date(startedAt || Date.now()), new Date(finishedAt || Date.now()), ok ? 1 : 0, JSON.stringify(list)]);
  invalidate(cid);
  res.json({ ok: true });
});

export default router;
