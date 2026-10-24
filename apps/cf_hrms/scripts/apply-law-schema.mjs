/**
 * apply-law-schema.mjs — the law layer's tables (TM/CF_HRMS_HIRING_SPEC.md §36.1; models/init.sql §37 LAW LAYER).
 *
 *   node apply-law-schema.mjs                       DRY RUN on local — says what it would do
 *   node apply-law-schema.mjs --apply
 *   node apply-law-schema.mjs --apply --target=prod
 *
 * Creates the tables of §37 that are missing (the CREATE statements are READ FROM init.sql §37 — one
 * source, so this script and a fresh database cannot disagree), then the guarded steps of 37b
 * (hrms_tax_rules gets version / status / publish fields; existing rows become PUBLISHED version 1) and
 * 37c (hrms_pay_runs.law_versions_json). Each step runs only when what it adds is missing. No law data:
 * migrate-statutory-to-law.mjs and seed-law-rules.mjs write that. A second run finds nothing to do.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import mysql from 'mysql2/promise';
import { resolveTarget, announce } from './dbTarget.mjs';

const APPLY = process.argv.includes('--apply');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const INIT = path.join(HERE, '..', 'models', 'init.sql');
const HEADER = '-- ## 37. LAW LAYER';

function sectionText() {
  const text = fs.readFileSync(INIT, 'utf8').replace(/\r\n/g, '\n');
  const start = text.indexOf(HEADER);
  if (start < 0) throw new Error('init.sql has no §37 LAW LAYER section.');
  const rest = text.slice(start + 10);
  const next = rest.search(/\n-- ## \d+\./);
  return next < 0 ? text.slice(start) : text.slice(start, start + 10 + next);
}

/** The CREATE TABLE statements of §37, in order: [{ table, sql }]. */
export function lawTables() {
  const out = [];
  const re = /CREATE TABLE IF NOT EXISTS (hrms_[a-z0-9_]+) \([\s\S]*?\) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;/g;
  for (const m of sectionText().matchAll(re)) out.push({ table: m[1], sql: m[0] });
  return out;
}
export const LAW_TABLES = lawTables().map((t) => t.table);
export const GLOBAL_LAW_TABLES = ['hrms_law_rules'];

/** The quoted statements of 37b / 37c, in order. */
function quoted() {
  return [...sectionText().matchAll(/^-- "([^"]+)"$/gm)].map((m) => m[1]);
}

const one = async (conn, sql, params) => (await conn.query(sql, params))[0][0] ?? null;
const table = async (conn, t) => Boolean(await one(conn, 'SELECT 1 AS x FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', [t]));
const column = async (conn, t, c) => Boolean(await one(conn, 'SELECT 1 AS x FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?', [t, c]));
const index = async (conn, t, i) => Boolean(await one(conn, 'SELECT 1 AS x FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?', [t, i]));

/** Is the quoted statement already done? */
async function done(conn, sql) {
  let m = /^ALTER TABLE (\w+) ADD COLUMN (\w+)/.exec(sql);
  if (m) return column(conn, m[1], m[2]);
  m = /^ALTER TABLE (\w+) ADD UNIQUE KEY (\w+)/.exec(sql);
  if (m) return index(conn, m[1], m[2]);
  m = /^ALTER TABLE (\w+) DROP INDEX (\w+)/.exec(sql);
  if (m) return !await index(conn, m[1], m[2]);
  m = /^UPDATE hrms_tax_rules/.exec(sql);
  if (m) return !(await column(conn, 'hrms_tax_rules', 'published_at')) ? false : !(await one(conn, "SELECT 1 AS x FROM hrms_tax_rules WHERE published_at IS NULL AND status = 'PUBLISHED' LIMIT 1"));
  throw new Error(`apply-law-schema does not know how to check: ${sql}`);
}

/** What is still missing, in order: [{ what, sql }]. Reads only. */
export async function schemaSteps(conn) {
  for (const t of ['companies', 'users', 'hrms_locations', 'hrms_roles', 'hrms_pay_structures', 'hrms_pay_runs', 'hrms_tax_rules']) {
    if (!await table(conn, t)) throw new Error(`${t} is not there — run the earlier schema scripts first.`);
  }
  const steps = [];
  for (const t of lawTables()) if (!await table(conn, t.table)) steps.push({ what: `create ${t.table}`, sql: t.sql });
  // 37b/37c: the UPDATE needs the columns, the DROP needs the new unique keys first — they are in that order.
  for (const sql of quoted()) {
    const ok = await done(conn, sql).catch(() => false);
    if (!ok) steps.push({ what: sql.length > 110 ? `${sql.slice(0, 107)}…` : sql, sql });
  }
  return steps;
}

async function main() {
  const target = resolveTarget();
  announce(target);
  const conn = await mysql.createConnection({ ...target.cfg, dateStrings: true });
  try {
    if (!APPLY) console.log('  DRY RUN — nothing is written without --apply\n');
    const tables = lawTables();
    if (tables.length !== 6) throw new Error(`init.sql §37 should declare 6 tables; it declares ${tables.length}.`);
    for (const t of tables) {
      if (!/\bdeleted_at\b/.test(t.sql)) throw new Error(`${t.table} lacks deleted_at.`);
      if (!GLOBAL_LAW_TABLES.includes(t.table) && !/\bcompany_id\b/.test(t.sql)) throw new Error(`${t.table} lacks company_id.`);
    }
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
    console.log(APPLY ? '\n  done. Next: migrate-statutory-to-law.mjs --apply, then seed-law-rules.mjs --apply.\n' : `\n  nothing written — ${steps.length} step(s) would run. Run again with --apply.\n`);
  } finally {
    await conn.end();
  }
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) main().then(() => process.exit(0)).catch((e) => { console.error(`\n  FAILED: ${e.message}\n`); process.exit(1); });
