/**
 * one-json-audit.mjs — every live sales order line should have its structure's ONE JSON (user, 2026-11-02, again 2026-11-05: "every
 * sales order should have the same single json only"). Lists each live line, its standard and that standard's model. READ ONLY.
 * Exit 1 when a line has no standard, no model, or a model older than /2.
 *   node scripts/cf_kepl/one-json-audit.mjs --company 30005 [--prod]
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
const __dir = path.dirname(fileURLToPath(import.meta.url));
const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
const COMPANY = Number(arg('company')); if (!COMPANY) { console.error('Usage: --company <id> [--prod]'); process.exit(2); }
if (process.argv.includes('--prod')) {
  const env = {}; fs.readFileSync(path.join(__dir, '..', '..', '..', '.env.tidb'), 'utf8').split('\n').forEach((l) => { l = l.trim(); if (!l || l.startsWith('#')) return; const [k, ...r] = l.split('='); env[k.trim()] = r.join('=').trim(); });
  Object.assign(process.env, { DB_HOST: env.DB_HOST, DB_PORT: env.DB_PORT ?? '4000', DB_USER: env.DB_USER, DB_PASSWORD: env.DB_PASSWORD, DB_NAME: env.DB_NAME, DB_SSL: 'true' });
}
const { pool } = await import(pathToFileURL(path.join(__dir, '..', '..', 'db.js')).href);
const [lines] = await pool.query(`SELECT o.code, o.status, l.id AS line, l.quantity, l.standard_id, s.number
  FROM cf_sales_orders o JOIN cf_sales_order_lines l ON l.order_id = o.id AND l.deleted_at IS NULL LEFT JOIN cf_standard_drawings s ON s.id = l.standard_id
  WHERE o.company_id = ? AND o.deleted_at IS NULL ORDER BY o.id, l.id`, [COMPANY]);
const [files] = await pool.query(`SELECT standard_id, JSON_UNQUOTE(JSON_EXTRACT(file_text, '$.schema')) AS sch, LENGTH(file_text) AS len FROM cf_standard_drawing_files WHERE company_id = ? AND kind = 'model' AND deleted_at IS NULL ORDER BY id`, [COMPANY]);
const newest = new Map(files.map((f) => [Number(f.standard_id), f]));   // ordered by id: the newest wins, as the viewer reads it
let bad = 0;
for (const r of lines) {
  const f = newest.get(Number(r.standard_id));
  const ok = f && /\/2$/.test(f.sch ?? ''); if (!ok) bad++;
  console.log(`${ok ? 'ok ' : 'BAD'} ${r.code} ${r.status} line ${r.line} x${Number(r.quantity)} ${r.number ?? '(no standard)'}: ${f ? `${f.sch}, ${Math.round(f.len / 1024)} kB` : 'NO MODEL'}`);
}
console.log(bad ? `${bad} of ${lines.length} lines without one /2 JSON` : `all ${lines.length} live lines have one /2 JSON`);
await pool.end(); process.exit(bad ? 1 : 0);
