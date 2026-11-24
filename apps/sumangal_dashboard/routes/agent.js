import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import express, { Router } from 'express';
import { fileURLToPath } from 'url';
import { pool } from '../../../db.js';
import { protect } from '../../../core/middleware/authmiddleware.js';
import { storeV15, v15Status } from '../services/v15Service.js';

/**
 * The ERP agent's side (no platform login). The agent runs on the customer's network, reads their ERP read-only,
 * builds the ERP dashboard (V15) dataset there and pushes it here. It proves itself with the key it made at setup
 * (we keep the SHA-256 only) and is ignored until an admin approves it (scripts/v15/approve-agent.mjs).
 *
 *   GET  /agent/files/:name   the agent's files for setup (no secrets in them)
 *   POST /agent/register      { agentUid, keyHash, machine, winUser }        → pending
 *   GET  /agent/status        → { status }                                    (headers below)
 *   POST /agent/push          body: the dataset JSON, gzipped (application/octet-stream)
 *   POST /agent/report        { ok, message, seconds }                        → last run kept
 *   GET  /agent/jobs?wait=25  day mode: waits for a 'Refresh now' request (204 = none); POST /agent/jobs/:id/done
 * Headers on status/push/report: X-Agent-Uid, Authorization: Bearer <key>.
 * For a platform login: GET /agent/runs → the agents, their last runs, when the data was loaded, the last refresh
 * request; POST /agent/refresh → asks the agent for an update now (answered within about a minute in working hours).
 */
const router = Router({ mergeParams: true });
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const AGENT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'agent', 'dist');
const FILES = ['agent.mjs', 'build-d.mjs', 'supp.mjs', 'hist.mjs', 'build-v15.mjs', 'setup.ps1', 'README.md', 'tables.json', 'run-hidden.vbs'];
const MAX_PENDING = 3;

router.get('/agent/files/:name', (req, res) => {
  if (!FILES.includes(req.params.name)) return res.status(404).end();
  const f = path.join(AGENT_DIR, req.params.name);
  if (!fs.existsSync(f)) return res.status(404).end();
  res.set('Content-Type', 'text/plain; charset=utf-8').set('Cache-Control', 'no-cache');
  // git keeps LF; wscript wants CRLF
  if (f.endsWith('.vbs')) return res.send(fs.readFileSync(f, 'utf8').replace(/\r?\n/g, '\r\n'));
  fs.createReadStream(f).pipe(res);
});

router.post('/agent/register', async (req, res) => {
  try {
    const { agentUid, keyHash, machine, winUser } = req.body || {};
    if (!/^[a-f0-9-]{16,64}$/i.test(agentUid || '') || !/^[a-f0-9]{64}$/i.test(keyHash || '')) return res.status(400).json({ error: 'agentUid and keyHash are required.' });
    const cid = req.company.id;
    const [[have]] = await pool.query('SELECT id, company_id, status FROM sd_agents WHERE agent_uid = ?', [agentUid]);
    if (have) return res.json({ id: have.id, status: have.status, note: 'Already registered.' });
    const [[p]] = await pool.query("SELECT COUNT(*) n FROM sd_agents WHERE company_id = ? AND status = 'pending'", [cid]);
    if (p.n >= MAX_PENDING) return res.status(429).json({ error: 'Too many agents are waiting for approval.' });
    const [r] = await pool.query('INSERT INTO sd_agents (company_id, agent_uid, key_hash, machine, win_user) VALUES (?, ?, ?, ?, ?)',
      [cid, agentUid, keyHash.toLowerCase(), String(machine || '').slice(0, 120), String(winUser || '').slice(0, 120)]);
    res.json({ id: r.insertId, status: 'pending' });
  } catch (err) { req.log?.error?.({ err }, 'sumangal agent register'); res.status(500).json({ error: err.message }); }
});

/** Finds the calling agent; answers 401/403 itself when it may not go on. */
async function agentOf(req, res, needApproved = true) {
  const uid = req.get('x-agent-uid'); const key = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!uid || !key) { res.status(401).json({ error: 'Agent headers missing.' }); return null; }
  const [[a]] = await pool.query('SELECT * FROM sd_agents WHERE agent_uid = ? AND company_id = ?', [uid, req.company.id]);
  if (!a || a.key_hash !== sha256(key)) { res.status(401).json({ error: 'Unknown agent or wrong key.' }); return null; }
  await pool.query('UPDATE sd_agents SET last_seen_at = UTC_TIMESTAMP() WHERE id = ?', [a.id]);
  if (needApproved && a.status !== 'approved') { res.status(403).json({ error: `This agent is ${a.status}. An admin has to approve it first.`, status: a.status }); return null; }
  return a;
}

router.get('/agent/status', async (req, res) => {
  try { const a = await agentOf(req, res, false); if (a) res.json({ id: a.id, status: a.status }); } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/agent/push', express.raw({ type: 'application/octet-stream', limit: '80mb' }), async (req, res) => {
  try {
    const a = await agentOf(req, res); if (!a) return;
    if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'Send the dataset gzipped, as application/octet-stream.' });
    const text = zlib.gunzipSync(req.body).toString('utf8');
    const data = JSON.parse(text);
    if (!data.D || !Array.isArray(data.D.items) || !data.S || !data.H) return res.status(400).json({ error: 'Not an ERP dashboard dataset (D, S, H).' });
    const kind = req.get('x-run-kind') === 'update' ? 'update' : 'nightly';
    // D.end is the dashboard's "today" (every age is measured from it) and is the latest date in the
    // ERP. One mistyped record (Sumangal has a 2424 date, 2026-11-24) would put "today" centuries
    // ahead and push all WIP into "over 90 days". Nothing can be newer than the day it arrives.
    const today = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10); // IST
    let body = text;
    if (typeof data.D.end === 'string' && data.D.end > today) { data.D.end = today; body = JSON.stringify(data); }
    const out = await storeV15(req.company.id, body, { source: `agent ${a.id} ${kind}`, end: data.D.end });
    res.json({ ok: true, ...out });
  } catch (err) { req.log?.error?.({ err }, 'sumangal agent push'); res.status(500).json({ error: err.message }); }
});

router.post('/agent/report', async (req, res) => {
  try {
    const a = await agentOf(req, res, false); if (!a) return;
    const { ok, message, seconds } = req.body || {};
    await pool.query('UPDATE sd_agents SET last_run_at = UTC_TIMESTAMP(), last_ok = ?, last_message = ?, last_seconds = ? WHERE id = ?', [ok ? 1 : 0, String(message || '').slice(0, 500), Number.isFinite(+seconds) ? Math.round(+seconds) : null, a.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/** Day mode: the agent waits here (up to ?wait= seconds, max 25) for a "Refresh now" request and takes it. 204 = none. */
router.get('/agent/jobs', async (req, res) => {
  try {
    const a = await agentOf(req, res); if (!a) return;
    const until = Date.now() + Math.min(25, Math.max(0, +req.query.wait || 0)) * 1000;
    for (;;) {
      const [r] = await pool.query("UPDATE sd_agent_jobs SET status = 'running', picked_at = UTC_TIMESTAMP(), picked_by = ? WHERE company_id = ? AND status = 'waiting' ORDER BY id LIMIT 1", [a.id, req.company.id]);
      if (r.affectedRows) {
        const [[job]] = await pool.query("SELECT id, kind, created_at FROM sd_agent_jobs WHERE company_id = ? AND status = 'running' AND picked_by = ? ORDER BY picked_at DESC, id DESC LIMIT 1", [req.company.id, a.id]);
        // requests that came in meanwhile are answered by this same update
        await pool.query("UPDATE sd_agent_jobs SET status = 'running', picked_at = UTC_TIMESTAMP(), picked_by = ? WHERE company_id = ? AND status = 'waiting'", [a.id, req.company.id]);
        return res.json(job);
      }
      if (Date.now() >= until || req.socket.destroyed) return res.status(204).end();
      await new Promise((ok) => setTimeout(ok, 2000));
    }
  } catch (err) { res.status(500).json({ error: err.message }); }
});
router.post('/agent/jobs/:id/done', async (req, res) => {
  try {
    const a = await agentOf(req, res); if (!a) return;
    await pool.query("UPDATE sd_agent_jobs SET status = 'done', done_at = UTC_TIMESTAMP(), ok = ? WHERE company_id = ? AND status = 'running' AND picked_by = ?", [req.body?.ok ? 1 : 0, req.company.id, a.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/** "Refresh now" from the dashboard (platform login). One waiting request per company is enough. */
router.post('/agent/refresh', protect, async (req, res) => {
  try {
    const cid = req.company.id;
    const [[agent]] = await pool.query("SELECT id, last_seen_at, TIMESTAMPDIFF(SECOND, last_seen_at, UTC_TIMESTAMP()) idle FROM sd_agents WHERE company_id = ? AND status = 'approved' ORDER BY last_seen_at DESC LIMIT 1", [cid]);
    if (!agent) return res.status(409).json({ error: 'No approved ERP agent for this company yet.' });
    const [[open]] = await pool.query("SELECT id, status FROM sd_agent_jobs WHERE company_id = ? AND status IN ('waiting', 'running') AND created_at > UTC_TIMESTAMP() - INTERVAL 30 MINUTE ORDER BY id DESC LIMIT 1", [cid]);
    const id = open ? open.id : (await pool.query('INSERT INTO sd_agent_jobs (company_id, requested_by) VALUES (?, ?)', [cid, req.user?.id ?? null]))[0].insertId;
    res.json({ id, status: open ? open.status : 'waiting', agentListening: agent.idle != null && agent.idle < 90 });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/agent/runs', protect, async (req, res) => {
  try {
    const [agents] = await pool.query('SELECT id, machine, win_user, status, created_at, approved_at, last_seen_at, last_run_at, last_ok, last_message, last_seconds, TIMESTAMPDIFF(SECOND, last_seen_at, UTC_TIMESTAMP()) idle_seconds FROM sd_agents WHERE company_id = ? ORDER BY id DESC', [req.company.id]);
    const [[job]] = await pool.query("SELECT id, status, created_at, picked_at, done_at, ok FROM sd_agent_jobs WHERE company_id = ? ORDER BY id DESC LIMIT 1", [req.company.id]);
    res.json({ agents, data: await v15Status(req.company.id), job: job || null });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

export default router;
