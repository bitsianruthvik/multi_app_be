/**
 * apply-dashboard-alerts-schema.mjs — the absence alerts' tables and the two duty components
 * (TM/CF_HRMS_HIRING_SPEC.md §42; models/init.sql §43 DASHBOARD AND ALERTS).
 *
 *   node apply-dashboard-alerts-schema.mjs                       DRY RUN on local — says what it would do
 *   node apply-dashboard-alerts-schema.mjs --apply
 *   node apply-dashboard-alerts-schema.mjs --apply --target=prod
 *
 *   1. the four tables of §43 that are missing — the CREATE statements are READ FROM init.sql §43 (one source):
 *      hrms_absence_alert_settings, hrms_absence_alert_runs, hrms_notifications, hrms_alert_deliveries;
 *   2. the ready-made components SUNDAY_DUTY and FESTIVAL_DUTY (services/payroll/seed.js) for every company
 *      that has payroll components and not that code.
 *
 * Every table has company_id and deleted_at (checked before anything runs). Each step is guarded, so a second
 * run plans nothing. Adding a component to a company with a CALCULATED run makes that run "changed since
 * calculation" once — calculate it again. Run this BEFORE deploying the backend that reads the tables.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import mysql from 'mysql2/promise';
import { resolveTarget, announce } from './dbTarget.mjs';
import { READY_MADE_COMPONENTS } from '../services/payroll/seed.js';

const APPLY = process.argv.includes('--apply');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const INIT = path.join(HERE, '..', 'models', 'init.sql');
const HEADER = '-- ## 43. DASHBOARD AND ALERTS';
export const DUTY_CODES = ['SUNDAY_DUTY', 'FESTIVAL_DUTY'];

function sectionText() {
  const text = fs.readFileSync(INIT, 'utf8').replace(/\r\n/g, '\n');
  const start = text.indexOf(HEADER);
  if (start < 0) throw new Error('init.sql has no §43 DASHBOARD AND ALERTS section.');
  const rest = text.slice(start + 10);
  const next = rest.search(/\n-- ## \d+\./);
  return next < 0 ? text.slice(start) : text.slice(start, start + 10 + next);
}

/** The CREATE TABLE statements of §43, in order: [{ table, sql }]. */
export function alertTables() {
  const out = [];
  const re = /CREATE TABLE IF NOT EXISTS (hrms_[a-z0-9_]+) \([\s\S]*?\) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;/g;
  for (const m of sectionText().matchAll(re)) out.push({ table: m[1], sql: m[0] });
  return out;
}
export const ALERT_TABLES = alertTables().map((t) => t.table);

const one = async (conn, sql, params) => (await conn.query(sql, params))[0][0] ?? null;
const table = async (conn, t) => Boolean(await one(conn, 'SELECT 1 AS x FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', [t]));

/** What is still missing, in order: [{ what, sql, params? }]. Reads only. */
export async function schemaSteps(conn) {
  for (const t of ['companies', 'users', 'hrms_shifts', 'hrms_pay_components', 'hrms_compliance_emails', 'hrms_attendance_settings']) {
    if (!await table(conn, t)) throw new Error(`${t} is not there — run the earlier schema scripts first (attendance, payroll, compliance).`);
  }
  const steps = [];
  for (const t of alertTables()) if (!await table(conn, t.table)) steps.push({ what: `create ${t.table}`, sql: t.sql });
  for (const code of DUTY_CODES) {
    const k = READY_MADE_COMPONENTS.find((x) => x.code === code);
    const [companies] = await conn.query(
      `SELECT DISTINCT p.company_id FROM hrms_pay_components p WHERE p.deleted_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM hrms_pay_components x WHERE x.company_id = p.company_id AND x.code = ? AND x.deleted_at IS NULL)`, [code]);
    for (const c of companies) {
      steps.push({
        what: `add component ${code} to company ${c.company_id}`,
        sql: `INSERT INTO hrms_pay_components (company_id, code, name, kind, taxable, exemption_rule, in_pf_wage, in_esi_wage, in_gratuity_wage, frequency, prorate_on_lop,
                statutory_key, sort_order, status, is_ready_made) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', 1)`,
        params: [c.company_id, k.code, k.name, k.kind, k.taxable, k.exemptionRule, k.inPfWage, k.inEsiWage, k.inGratuityWage, k.frequency, k.prorateOnLop, k.statutoryKey, k.sortOrder],
      });
    }
  }
  return steps;
}

async function main() {
  const target = resolveTarget();
  announce(target);
  const conn = await mysql.createConnection({ ...target.cfg, dateStrings: true });
  try {
    if (!APPLY) console.log('  DRY RUN — nothing is written without --apply\n');
    const tables = alertTables();
    if (tables.length !== 4) throw new Error(`init.sql §43 should declare 4 tables; it declares ${tables.length}.`);
    for (const t of tables) {
      if (!/\bdeleted_at\b/.test(t.sql)) throw new Error(`${t.table} lacks deleted_at.`);
      if (!/\bcompany_id\b/.test(t.sql)) throw new Error(`${t.table} lacks company_id.`);
    }
    for (const code of DUTY_CODES) if (!READY_MADE_COMPONENTS.some((k) => k.code === code)) throw new Error(`services/payroll/seed.js has no ${code}.`);
    const steps = await schemaSteps(conn);
    if (!steps.length) console.log('  schema: already there — nothing to do');
    for (const s of steps) {
      if (APPLY) {
        // eslint-disable-next-line no-await-in-loop -- DDL and seed rows, one at a time, in order
        await conn.query(s.sql, s.params ?? []);
        console.log(`  ${s.what} — done`);
      } else console.log(`  would ${s.what}`);
    }
    if (APPLY) {
      const again = await schemaSteps(conn);
      if (again.length) throw new Error(`after applying, still to do: ${again.map((s) => s.what).join('; ')}`);
      console.log('  checked: a second run plans nothing');
    }
    console.log(APPLY ? '\n  done.\n' : `\n  nothing written — ${steps.length} step(s) would run. Run again with --apply.\n`);
  } finally {
    await conn.end();
  }
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) main().then(() => process.exit(0)).catch((e) => { console.error(`\n  FAILED: ${e.message}\n`); process.exit(1); });
