// node scripts/cf_kepl/migrate-s100.mjs [--prod]
// Applies init.sql §100 (value source 'model' + cf_model_value_runs) — idempotent — and prints S100-OK / S100-MISSING.
// --prod: the production database from TM/.env.tidb (never printed).
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import mysql from 'mysql2/promise';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const BE = path.join(__dir, '..', '..');
const sql = fs.readFileSync(path.join(BE, 'apps', 'cf_erp', 'models', 'init.sql'), 'utf8');
const at = sql.indexOf('-- §100');
if (at < 0) { console.error('init.sql has no §100'); process.exit(2); }
const block = sql.slice(sql.lastIndexOf('-- ====', at - 5));

let cfg;
if (process.argv.includes('--prod')) {
  const env = {};
  fs.readFileSync(path.join(BE, '..', '.env.tidb'), 'utf8').split('\n').forEach((l) => { l = l.trim(); if (!l || l.startsWith('#')) return; const [k, ...r] = l.split('='); env[k.trim()] = r.join('=').trim(); });
  cfg = { host: env.DB_HOST, port: Number(env.DB_PORT ?? 4000), user: env.DB_USER, password: env.DB_PASSWORD, database: env.DB_NAME, ssl: { minVersion: 'TLSv1.2', rejectUnauthorized: true } };
} else {
  cfg = { host: process.env.DB_HOST ?? 'localhost', port: Number(process.env.DB_PORT ?? 3306), user: process.env.DB_USER ?? 'root', password: process.env.DB_PASSWORD ?? '1234', database: process.env.DB_NAME ?? 'sqldb' };
}
const c = await mysql.createConnection({ ...cfg, multipleStatements: true });
const [res] = await c.query(block);
const last = Array.isArray(res) ? res[res.length - 1] : res;
console.log(`${cfg.database} at ${cfg.host}:`, JSON.stringify(Array.isArray(last) ? last[0] : last));
await c.end();
