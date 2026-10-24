/**
 * apply-compliance-checks-schema.mjs — the compliance checks' tables (TM/CF_HRMS_HIRING_SPEC.md §36.2–36.3;
 * models/init.sql §39 COMPLIANCE CHECKS) and the STAT_TOPUP component.
 *
 *   node apply-compliance-checks-schema.mjs                       DRY RUN on local — says what it would do
 *   node apply-compliance-checks-schema.mjs --apply
 *   node apply-compliance-checks-schema.mjs --apply --target=prod
 *
 * Creates the tables of §39 that are missing (the CREATE statements are READ FROM init.sql §39 — one source),
 * then adds the ready-made "Statutory top-up (minimum wage)" component (code STAT_TOPUP) to every company
 * that has payroll components and not that code. A second run finds nothing to do.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import mysql from 'mysql2/promise';
import { resolveTarget, announce } from './dbTarget.mjs';
import { TOPUP_COMPONENT } from '../services/complianceChecks/constants.js';

const APPLY = process.argv.includes('--apply');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const INIT = path.join(HERE, '..', 'models', 'init.sql');
const HEADER = '-- ## 39. COMPLIANCE CHECKS';

function sectionText() {
  const text = fs.readFileSync(INIT, 'utf8').replace(/\r\n/g, '\n');
  const start = text.indexOf(HEADER);
  if (start < 0) throw new Error('init.sql has no §39 COMPLIANCE CHECKS section.');
  const rest = text.slice(start + 10);
  const next = rest.search(/\n-- ## \d+\./);
  return next < 0 ? text.slice(start) : text.slice(start, start + 10 + next);
}

/** The CREATE TABLE statements of §39, in order: [{ table, sql }]. */
export function checksTables() {
  const out = [];
  const re = /CREATE TABLE IF NOT EXISTS (hrms_[a-z0-9_]+) \([\s\S]*?\) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;/g;
  for (const m of sectionText().matchAll(re)) out.push({ table: m[1], sql: m[0] });
  return out;
}
export const CHECKS_TABLES = checksTables().map((t) => t.table);

const one = async (conn, sql, params) => (await conn.query(sql, params))[0][0] ?? null;
const table = async (conn, t) => Boolean(await one(conn, 'SELECT 1 AS x FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', [t]));

/** What is still missing, in order: [{ what, sql, params? }]. Reads only. */
export async function schemaSteps(conn) {
  for (const t of ['companies', 'users', 'hrms_employees', 'hrms_pay_runs', 'hrms_pay_components', 'hrms_law_rules']) {
    if (!await table(conn, t)) throw new Error(`${t} is not there — run the earlier schema scripts first (apply-law-schema …).`);
  }
  const steps = [];
  for (const t of checksTables()) if (!await table(conn, t.table)) steps.push({ what: `create ${t.table}`, sql: t.sql });
  const [companies] = await conn.query(
    `SELECT DISTINCT k.company_id FROM hrms_pay_components k WHERE k.deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM hrms_pay_components x WHERE x.company_id = k.company_id AND x.code = ? AND x.deleted_at IS NULL)`, [TOPUP_COMPONENT.code]);
  const t = TOPUP_COMPONENT;
  for (const c of companies) {
    steps.push({
      what: `add component ${t.code} to company ${c.company_id}`,
      sql: `INSERT INTO hrms_pay_components (company_id, code, name, kind, taxable, exemption_rule, in_pf_wage, in_esi_wage, in_gratuity_wage, frequency, prorate_on_lop,
              statutory_key, sort_order, status, is_ready_made, description) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', 1, ?)`,
      params: [c.company_id, t.code, t.name, t.kind, t.taxable, t.exemptionRule, t.inPfWage, t.inEsiWage, t.inGratuityWage, t.frequency, t.prorateOnLop, t.statutoryKey, t.sortOrder, t.description],
    });
  }
  return steps;
}

async function main() {
  const target = resolveTarget();
  announce(target);
  const conn = await mysql.createConnection({ ...target.cfg, dateStrings: true });
  try {
    if (!APPLY) console.log('  DRY RUN — nothing is written without --apply\n');
    const tables = checksTables();
    if (tables.length !== 5) throw new Error(`init.sql §39 should declare 5 tables; it declares ${tables.length}.`);
    for (const t of tables) {
      if (!/\bdeleted_at\b/.test(t.sql)) throw new Error(`${t.table} lacks deleted_at.`);
      if (!/\bcompany_id\b/.test(t.sql)) throw new Error(`${t.table} lacks company_id.`);
    }
    const steps = await schemaSteps(conn);
    if (!steps.length) console.log('  schema: already there — nothing to do');
    for (const s of steps) {
      if (APPLY) { await conn.query(s.sql, s.params ?? []); console.log(`  ${s.what} — done`); } else console.log(`  would ${s.what}`);
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
