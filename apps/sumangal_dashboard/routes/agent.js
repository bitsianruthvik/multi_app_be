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
 * Headers on status/push/report: X-Agent-Uid, Authorization: Bearer <key>.
 * For a platform login: GET /agent/runs → the agents and their last runs, and when the data was loaded.
 */
const router = Router({ mergeParams: true });
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const AGENT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'agent', 'dist');
const FILES = ['agent.mjs', 'build-d.mjs', 'supp.mjs', 'hist.mjs', 'build-v15.mjs', 'setup.ps1', 'README.md', 'tables.json'];
const MAX_PENDING = 3;

router.get('/agent/files/:name', (req, res) => {
  if (!FILES.includes(req.params.name)) return res.status(404).end();
  const f = path.join(AGENT_DIR, req.params.name);
  if (!fs.existsSync(f)) return res.status(404).end();
  res.set('Content-Type', 'text/plain; charset=utf-8').set('Cache-Control', 'no-cache');
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
    const out = await storeV15(req.company.id, text, { source: `agent ${a.id}`, end: data.D.end });
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

router.get('/agent/runs', protect, async (req, res) => {
  try {
    const [agents] = await pool.query('SELECT id, machine, win_user, status, created_at, approved_at, last_seen_at, last_run_at, last_ok, last_message, last_seconds FROM sd_agents WHERE company_id = ? ORDER BY id DESC', [req.company.id]);
    res.json({ agents, data: await v15Status(req.company.id) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

export default router;
