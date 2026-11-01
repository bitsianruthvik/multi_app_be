/**
 * bolt-weights.mjs — give every catalog bolt set (name "… bolt set M<d> x <L> …") its unit WEIGHT, so a line with
 * Bolt set rows still rolls its weight up (a row with no weight leaves its parents' weight blank — the line's tonnes
 * and price by the tonne with it). Then the rows that hold bolt sets are refreshed (valueService.refreshValues).
 * Weight of a set = shank (π/4 · d² · L · 7850) + head + nut + 2 hardened washers (IS 3757 / 6623 / 6649 typical):
 *   M10 0.03 kg · M16 0.12 · M20 0.20 · M22 0.26 · M24 0.33 · M27 0.45 · M30 0.60 (head + nut + washers).
 * DRY RUN BY DEFAULT (rolled back); --apply saves.
 *   node scripts/cf_kepl/bolt-weights.mjs --company 30005 --prod [--apply]
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
const __dir = path.dirname(fileURLToPath(import.meta.url));
const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
const COMPANY = Number(arg('company')); const APPLY = process.argv.includes('--apply');
if (!COMPANY) { console.error('Usage: --company <id> [--prod] [--apply]'); process.exit(2); }
if (process.argv.includes('--prod')) {
  const env = {}; fs.readFileSync(path.join(__dir, '..', '..', '..', '.env.tidb'), 'utf8').split('\n').forEach((l) => { l = l.trim(); if (!l || l.startsWith('#')) return; const [k, ...r] = l.split('='); env[k.trim()] = r.join('=').trim(); });
  Object.assign(process.env, { DB_HOST: env.DB_HOST, DB_PORT: env.DB_PORT ?? '4000', DB_USER: env.DB_USER, DB_PASSWORD: env.DB_PASSWORD, DB_NAME: env.DB_NAME, DB_SSL: 'true' });
}
const imp = (p) => import(pathToFileURL(path.join(__dir, '..', '..', p)).href);
const { pool } = await imp('db.js');
await imp('apps/cf_erp/services/codegenProvider.js');
const { refreshValues } = await imp('apps/cf_erp/services/valueService.js');
const FIXED = { 10: 0.03, 12: 0.05, 16: 0.12, 20: 0.2, 22: 0.26, 24: 0.33, 27: 0.45, 30: 0.6 };
export const boltSetKg = (d, L) => Math.round(((Math.PI / 4) * d * d * L * 7850e-9 + (FIXED[d] ?? 0.0006 * d * d)) * 1000) / 1000;

const db = await pool.getConnection();
try {
  const [[admin]] = await db.query("SELECT id FROM users WHERE company_id = ? AND email LIKE 'admin@%' ORDER BY id LIMIT 1", [COMPANY]);
  const c = { companyId: COMPANY, userId: admin.id };
  await db.beginTransaction();
  const [[spec]] = await db.query("SELECT id, default_uom FROM cf_specifications WHERE company_id = ? AND code = 'WEIGHT' AND deleted_at IS NULL", [COMPANY]);
  const [items] = await db.query("SELECT m.id, m.name FROM cf_master_records m JOIN cf_item_details i ON i.master_id = m.id AND i.item_type = 'catalog' WHERE m.company_id = ? AND m.deleted_at IS NULL AND LOWER(m.name) LIKE '%bolt set m%'", [COMPANY]);
  let set = 0;
  for (const it of items) {
    const m = /\bM(\d{2})\s*x\s*(\d{2,3})\b/i.exec(it.name); if (!m) continue;
    const kg = boltSetKg(Number(m[1]), Number(m[2]));
    await db.query("UPDATE cf_spec_values SET deleted_at = NOW() WHERE company_id = ? AND specification_id = ? AND subject_type = 'master' AND subject_id = ? AND deleted_at IS NULL", [COMPANY, spec.id, it.id]);
    await db.query("INSERT INTO cf_spec_values (company_id, specification_id, subject_type, subject_id, value_number, uom, source) VALUES (?, ?, 'master', ?, ?, 'kg', 'entered')", [COMPANY, spec.id, it.id, kg]);
    set++; console.log(`  ${it.name.slice(0, 60).padEnd(60)} ${kg} kg`);
  }
  // The rows that hold a bolt set (their BOM's parent) — refreshed, and everything above them with them.
  const [parents] = items.length ? await db.query(
    `SELECT DISTINCT b.parent_id FROM cf_bom_lines l JOIN cf_boms b ON b.id = l.bom_id AND b.deleted_at IS NULL
      WHERE l.company_id = ? AND l.deleted_at IS NULL AND l.child_id IN (?)`, [COMPANY, items.map((i) => i.id)]) : [[]];
  const ids = parents.map((p) => Number(p.parent_id));
  for (let i = 0; i < ids.length; i += 50) await refreshValues(db, c, ids.slice(i, i + 50));
  console.log(`${set} bolt sets weighed; ${ids.length} rows holding them refreshed — ${APPLY ? 'APPLY' : 'DRY RUN, rolled back'}`);
  if (APPLY) await db.commit(); else await db.rollback();
} catch (e) { try { await db.rollback(); } catch { /* none */ } console.error('FAILED (rolled back):', e.message); process.exitCode = 1; } finally { db.release(); await pool.end(); process.exit(process.exitCode ?? 0); }
