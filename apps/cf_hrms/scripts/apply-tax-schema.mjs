/**
 * apply-tax-schema.mjs — the tax rules table of the income tax engine
 * (TM/CF_HRMS_HIRING_SPEC.md §25.3; models/init.sql §27).
 *
 *   node apply-tax-schema.mjs                       DRY RUN on local — says what it would do
 *   node apply-tax-schema.mjs --apply
 *   node apply-tax-schema.mjs --apply --target=prod
 *
 *   1. hrms_tax_rules (global, not per company): one row per tax year, regime and rule.
 *
 * DDL commits by itself: the step is guarded, and a second run finds nothing to do.
 * No rules are written here — that is seed-tax-rules.mjs.
 */
import path from 'path';
import { fileURLToPath } from 'url';
import mysql from 'mysql2/promise';
import { resolveTarget, announce } from './dbTarget.mjs';

const APPLY = process.argv.includes('--apply');

const one = async (conn, sql, params) => (await conn.query(sql, params))[0][0] ?? null;
const table = async (conn, t) => Boolean(await one(conn, 'SELECT 1 AS x FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', [t]));
const column = async (conn, t, c) => Boolean(await one(conn, 'SELECT 1 AS x FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?', [t, c]));

/** The same as init.sql §27. */
export const CREATE_TAX_RULES = `CREATE TABLE IF NOT EXISTS hrms_tax_rules (
  id           INT           AUTO_INCREMENT PRIMARY KEY,
  tax_year     VARCHAR(7)    NOT NULL,
  regime       ENUM('OLD','NEW') NOT NULL,
  rule_key     VARCHAR(64)   NOT NULL,
  value_json   JSON          NOT NULL,
  source_note  VARCHAR(1000) NULL,
  source_url   VARCHAR(500)  NULL,
  verified     TINYINT(1)    NOT NULL DEFAULT 0,
  created_at   TIMESTAMP     DEFAULT CURRENT_TIMESTAMP,
  updated_at   TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at   DATETIME      NULL,
  UNIQUE KEY uq_htr_rule (tax_year, regime, rule_key),
  KEY idx_htr_year (tax_year, regime)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`;

const COLUMNS = ['id', 'tax_year', 'regime', 'rule_key', 'value_json', 'source_note', 'source_url', 'verified', 'created_at', 'updated_at', 'deleted_at'];

/** What is still missing, in order: [{ what, sql }]. Reads only. */
export async function schemaSteps(conn) {
  if (!await table(conn, 'hrms_tax_rules')) return [{ what: 'create hrms_tax_rules', sql: CREATE_TAX_RULES }];
  const missing = [];
  for (const c of COLUMNS) if (!await column(conn, 'hrms_tax_rules', c)) missing.push(c);
  if (missing.length) throw new Error(`hrms_tax_rules is there but lacks ${missing.join(', ')} — not a table this script made; look at it by hand.`);
  return [];
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
    if (APPLY) {
      const again = await schemaSteps(conn);
      if (again.length) throw new Error(`after applying, still to do: ${again.map((s) => s.what).join('; ')}`);
      console.log('  checked: a second run plans nothing');
    }
    console.log(APPLY ? '\n  done. Seed the rules with seed-tax-rules.mjs.\n' : `\n  nothing written — ${steps.length} schema step(s) would run. Run again with --apply.\n`);
  } finally {
    await conn.end();
  }
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) main().then(() => process.exit(0)).catch((e) => { console.error(`\n  FAILED: ${e.message}\n`); process.exit(1); });
