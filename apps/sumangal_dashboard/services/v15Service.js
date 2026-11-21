import zlib from 'zlib';
import { pool } from '../../../db.js';

/**
 * The ERP dashboard (V15) dataset: one JSON document stored in chunks (sd_rows, dataset "v15",
 * loaded by scripts/v15/load-v15.mjs). Joined and gzipped once per company, then kept in memory
 * until the stored chunks change.
 */
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
