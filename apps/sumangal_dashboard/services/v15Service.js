import zlib from 'zlib';
import { pool } from '../../../db.js';

/**
 * The ERP dashboard (V15) dataset: one JSON document stored in chunks (sd_rows, dataset "v15"), written by
 * scripts/v15/load-v15.mjs or pushed by the ERP agent (routes/agent.js). A "v15meta" row says when and from where.
 * Joined and gzipped once per company, then kept in memory until the stored chunks change.
 */
const CHUNK = 400000; // TiDB caps a row
const cache = new Map();

export async function v15Data(companyId) {
  const [[sig]] = await pool.query("SELECT COUNT(*) n, MAX(id) m FROM sd_rows WHERE company_id = ? AND dataset = 'v15'", [companyId]);
  if (!sig.n) { const e = new Error('The ERP dashboard data is not loaded for this company yet.'); e.status = 404; throw e; }
  const key = `${sig.n}:${sig.m}`;
  const hit = cache.get(companyId);
  if (hit && hit.key === key) return hit;
  const [rows] = await pool.query("SELECT data FROM sd_rows WHERE company_id = ? AND dataset = 'v15' ORDER BY id", [companyId]);
  const chunks = rows.map((r) => (typeof r.data === 'string' ? JSON.parse(r.data) : r.data)).sort((a, b) => a.i - b.i);
  const gz = zlib.gzipSync(Buffer.from(chunks.map((c) => c.s).join(''), 'utf8'));
  const out = { key, gz };
  cache.set(companyId, out);
  return out;
}

/** Replaces the company's dataset in one transaction. `text` is the dataset JSON ({ D, S, H }). */
export async function storeV15(companyId, text, { source = 'script', end = null } = {}) {
  const parts = []; for (let i = 0; i < text.length; i += CHUNK) parts.push(text.slice(i, i + CHUNK));
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query("DELETE FROM sd_rows WHERE company_id = ? AND dataset IN ('v15', 'v15meta')", [companyId]);
    for (let i = 0; i < parts.length; i++) await conn.query("INSERT INTO sd_rows (company_id, dataset, data) VALUES (?, 'v15', ?)", [companyId, JSON.stringify({ i, s: parts[i] })]);
    await conn.query("INSERT INTO sd_rows (company_id, dataset, data) VALUES (?, 'v15meta', ?)", [companyId, JSON.stringify({ loadedAt: new Date().toISOString(), source, end, bytes: text.length })]);
    await conn.commit();
  } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
  cache.delete(companyId);
  return { chunks: parts.length, bytes: text.length };
}

/** When the dataset was last loaded, from where, and up to which ERP day. */
export async function v15Status(companyId) {
  const [[m]] = await pool.query("SELECT data FROM sd_rows WHERE company_id = ? AND dataset = 'v15meta' ORDER BY id DESC LIMIT 1", [companyId]);
  return m ? (typeof m.data === 'string' ? JSON.parse(m.data) : m.data) : null;
}
