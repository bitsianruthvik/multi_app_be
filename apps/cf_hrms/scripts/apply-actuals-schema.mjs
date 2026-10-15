/**
 * apply-actuals-schema.mjs — actuals against performance plans
 * (TM/CF_HRMS_HIRING_SPEC.md §19; models/init.sql §21).
 *
 *   node apply-actuals-schema.mjs                       DRY RUN on local — says what it would do
 *   node apply-actuals-schema.mjs --apply
 *   node apply-actuals-schema.mjs --apply --target=prod
 *
 *   1. hrms_performance_plan_kpis.combine_rule   (SUM | AVERAGE | LAST);
 *   2. hrms_performance_settings.band_on_track / band_at_risk (90 / 70);
 *   3. the table hrms_performance_actuals — exactly the CREATE TABLE of
 *      models/init.sql §21 (read from that file, so the two cannot differ);
 *   4. DATA: every existing plan KPI with no combine rule gets the one its
 *      unit gives (services/performance/scoring.js defaultCombine — the same
 *      function new plans use). A rule somebody set is never touched.
 *
 * Needs apply-performance-schema.mjs first (the plan tables). One change per
 * statement (TiDB). DDL commits by itself: every step is guarded, the backfill
 * only fills NULLs, and a second run finds nothing to do. The old backend
 * never reads any of it, so run this BEFORE deploying the backend that does.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import mysql from 'mysql2/promise';
import { resolveTarget, announce } from './dbTarget.mjs';
import { defaultCombine } from '../services/performance/scoring.js';

const APPLY = process.argv.includes('--apply');
const INIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../models/init.sql');

export const ACTUALS_TABLE = 'hrms_performance_actuals';

/** The CREATE TABLE of init.sql §21. */
export function createStatement() {
  const text = fs.readFileSync(INIT, 'utf8');
  const at = text.indexOf('## 21. ACTUALS AGAINST PERFORMANCE PLANS');
  if (at < 0) throw new Error('models/init.sql has no section 21 (actuals).');
  const m = /CREATE TABLE IF NOT EXISTS hrms_performance_actuals \([\s\S]*?\) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;/.exec(text.slice(at));
  if (!m) throw new Error('models/init.sql §21 has no CREATE TABLE for hrms_performance_actuals.');
  return m[0].replace(/\s+--[^\r\n]*/g, '');
}

const one = async (conn, sql, params) => (await conn.query(sql, params))[0][0] ?? null;
const table = async (conn, t) => Boolean(await one(conn, 'SELECT 1 AS x FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', [t]));
const column = async (conn, t, c) => Boolean(await one(conn, 'SELECT 1 AS x FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?', [t, c]));

/** What is still missing in the schema, in the order it must run: [{ what, sql }]. Reads only. */
export async function schemaSteps(conn) {
  for (const t of ['hrms_performance_settings', 'hrms_performance_plans', 'hrms_performance_plan_kpis']) {
    if (!await table(conn, t)) throw new Error(`${t} is not there — run apply-performance-schema.mjs first.`);
  }
  const steps = [];
  if (!await column(conn, 'hrms_performance_plan_kpis', 'combine_rule')) {
    steps.push({ what: 'add hrms_performance_plan_kpis.combine_rule', sql: 'ALTER TABLE hrms_performance_plan_kpis ADD COLUMN combine_rule VARCHAR(8) NULL' });
  }
  if (!await column(conn, 'hrms_performance_settings', 'band_on_track')) {
    steps.push({ what: 'add hrms_performance_settings.band_on_track (90)', sql: 'ALTER TABLE hrms_performance_settings ADD COLUMN band_on_track DECIMAL(5,2) NOT NULL DEFAULT 90.00' });
  }
  if (!await column(conn, 'hrms_performance_settings', 'band_at_risk')) {
    steps.push({ what: 'add hrms_performance_settings.band_at_risk (70)', sql: 'ALTER TABLE hrms_performance_settings ADD COLUMN band_at_risk DECIMAL(5,2) NOT NULL DEFAULT 70.00' });
  }
  if (!await table(conn, ACTUALS_TABLE)) steps.push({ what: `create ${ACTUALS_TABLE}`, sql: createStatement() });
  return steps;
}

/** The plan KPIs with no combine rule, grouped by the rule they get: Map<rule, ids[]>. Reads only (needs the column). */
export async function backfillPlan(conn) {
  const [rows] = await conn.query('SELECT id, unit, direction FROM hrms_performance_plan_kpis WHERE combine_rule IS NULL');
  const byRule = new Map();
  for (const r of rows) {
    const rule = defaultCombine(r.unit, r.direction);
    byRule.set(rule, [...(byRule.get(rule) ?? []), r.id]);
  }
  return byRule;
}

/** Fill them in: one UPDATE per rule and 1,000 ids. Only NULLs are written. */
export async function backfill(conn, byRule) {
  let n = 0;
  for (const [rule, ids] of byRule) {
    for (let i = 0; i < ids.length; i += 1000) {
      const [res] = await conn.query('UPDATE hrms_performance_plan_kpis SET combine_rule = ? WHERE combine_rule IS NULL AND id IN (?)', [rule, ids.slice(i, i + 1000)]);
      n += res.affectedRows;
    }
  }
  return n;
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
    // The backfill needs the column; on a dry run before it exists, every plan KPI would get one.
    const hasColumn = await column(conn, 'hrms_performance_plan_kpis', 'combine_rule');
    let byRule;
    if (hasColumn) byRule = await backfillPlan(conn);
    else {
      const [rows] = await conn.query('SELECT unit, direction FROM hrms_performance_plan_kpis');
      byRule = new Map();
      for (const r of rows) { const rule = defaultCombine(r.unit, r.direction); byRule.set(rule, [...(byRule.get(rule) ?? []), 0]); }
    }
    const total = [...byRule.values()].reduce((t, ids) => t + ids.length, 0);
    const said = [...byRule].map(([rule, ids]) => `${ids.length} ${rule}`).join(', ');
    if (!total) console.log('  combine rules: every plan KPI has one — nothing to do');
    else if (APPLY) console.log(`  combine rules: ${await backfill(conn, byRule)} plan KPIs given the rule their unit gives (${said})`);
    else console.log(`  combine rules: would give ${total} plan KPIs the rule their unit gives (${said})`);

    if (APPLY) {
      const again = await schemaSteps(conn);
      const left = [...(await backfillPlan(conn)).values()].reduce((t, ids) => t + ids.length, 0);
      if (again.length || left) throw new Error(`after applying, still to do: ${[...again.map((s) => s.what), left ? `${left} combine rules` : ''].filter(Boolean).join('; ')}`);
      console.log('  checked: a second run plans nothing');
    }
    console.log(APPLY ? '\n  done. No actuals are written by this script.\n' : `\n  nothing written — ${steps.length} schema step(s) and ${total} combine rule(s) would be written. Run again with --apply.\n`);
  } finally {
    await conn.end();
  }
}

// Run only when called as a script; a test imports schemaSteps.
if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) main().then(() => process.exit(0)).catch((e) => { console.error(`\n  FAILED: ${e.message}\n`); process.exit(1); });
