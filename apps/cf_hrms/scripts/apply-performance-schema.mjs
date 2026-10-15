/**
 * apply-performance-schema.mjs — the tables of performance plans
 * (TM/CF_HRMS_HIRING_SPEC.md §18; models/init.sql §20).
 *
 *   node apply-performance-schema.mjs                       DRY RUN on local — says what it would do
 *   node apply-performance-schema.mjs --apply
 *   node apply-performance-schema.mjs --apply --target=prod
 *
 * THE SCHEMA ONLY — no settings, no periods, no plans (setup-performance.mjs
 * writes a company's settings and role frequencies):
 *   1. hrms_roles.performance_frequency (VARCHAR, NULL = the company default);
 *   2. the six new tables — settings, periods, plans, plan KRAs, plan KPIs,
 *      target changes — with exactly the CREATE TABLE statements of
 *      models/init.sql §20 (read from that file, so the two cannot differ).
 *
 * One change per statement (TiDB). DDL commits by itself: every step is
 * guarded and a second run finds nothing to do. The old backend never reads
 * any of it, so run this BEFORE deploying the backend that does.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import mysql from 'mysql2/promise';
import { resolveTarget, announce } from './dbTarget.mjs';

const APPLY = process.argv.includes('--apply');
const INIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../models/init.sql');

export const PERFORMANCE_TABLES = [
  'hrms_performance_settings', 'hrms_performance_periods', 'hrms_performance_plans',
  'hrms_performance_plan_kras', 'hrms_performance_plan_kpis', 'hrms_performance_target_changes',
];

/** The CREATE TABLE statements of init.sql §20, by table. */
export function createStatements() {
  const text = fs.readFileSync(INIT, 'utf8');
  const at = text.indexOf('## 20. PERFORMANCE PLANS');
  if (at < 0) throw new Error('models/init.sql has no section 20 (performance plans).');
  const section = text.slice(at);
  const out = new Map();
  const re = /CREATE TABLE IF NOT EXISTS (\w+) \([\s\S]*?\) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;/g;
  for (const m of section.matchAll(re)) {
    // Comments inside the statement are fine for the server; strip them anyway so the printed plan is short.
    out.set(m[1], m[0].replace(/\s+--[^\r\n]*/g, ''));
  }
  for (const t of PERFORMANCE_TABLES) if (!out.has(t)) throw new Error(`models/init.sql §20 has no CREATE TABLE for ${t}.`);
  return out;
}

const one = async (conn, sql, params) => (await conn.query(sql, params))[0][0] ?? null;
const table = async (conn, t) => Boolean(await one(conn, 'SELECT 1 AS x FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', [t]));
const column = async (conn, t, c) => Boolean(await one(conn, 'SELECT 1 AS x FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?', [t, c]));

/** What is still missing, in the order it must run: [{ what, sql }]. Reads only. */
export async function schemaSteps(conn) {
  for (const t of ['hrms_roles', 'hrms_employees', 'hrms_positions', 'hrms_work_assignments']) {
    if (!await table(conn, t)) throw new Error(`${t} is not there — apply models/init.sql first.`);
  }
  const steps = [];
  if (!await column(conn, 'hrms_roles', 'performance_frequency')) {
    steps.push({ what: 'add hrms_roles.performance_frequency', sql: 'ALTER TABLE hrms_roles ADD COLUMN performance_frequency VARCHAR(20) NULL' });
  }
  const creates = createStatements();
  for (const t of PERFORMANCE_TABLES) {
    if (!await table(conn, t)) steps.push({ what: `create ${t}`, sql: creates.get(t) });
  }
  return steps;
}

async function main() {
  const target = resolveTarget();
  announce(target);
  const conn = await mysql.createConnection({ ...target.cfg, dateStrings: true });
  try {
    if (!APPLY) console.log('  DRY RUN — nothing is written without --apply\n');
    const steps = await schemaSteps(conn);
    if (!steps.length) console.log('  schema: already there — nothing to do');
    for (const s of steps) {
      if (APPLY) { await conn.query(s.sql); console.log(`  schema: ${s.what} — done`); } else console.log(`  schema: would ${s.what}`);
    }
    if (APPLY && steps.length) {
      const again = await schemaSteps(conn);
      if (again.length) throw new Error(`after applying, still missing: ${again.map((s) => s.what).join('; ')}`);
      console.log('  checked: a second run plans nothing');
    }
    console.log(APPLY ? '\n  done. No settings, periods or plans are written by this script.\n' : `\n  nothing written — ${steps.length} step(s) would run. Run again with --apply.\n`);
  } finally {
    await conn.end();
  }
}

// Run only when called as a script; a test imports schemaSteps.
if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) main().then(() => process.exit(0)).catch((e) => { console.error(`\n  FAILED: ${e.message}\n`); process.exit(1); });
