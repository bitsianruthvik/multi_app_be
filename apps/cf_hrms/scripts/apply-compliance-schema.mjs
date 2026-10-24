/**
 * apply-compliance-schema.mjs — the tables of compliance (TM/CF_HRMS_HIRING_SPEC.md §36.4, §36.5;
 * models/init.sql §38 COMPLIANCE): platform admins, the watcher's sources, items, check runs and
 * notices, publications, per-company notifications, the email outbox, deadline marks, the CA's
 * reviews, comments and sign-offs — and the seeded official sources.
 *
 *   node apply-compliance-schema.mjs                       DRY RUN on local — says what it would do
 *   node apply-compliance-schema.mjs --apply
 *   node apply-compliance-schema.mjs --apply --target=prod
 *
 * The CREATE statements are READ FROM init.sql §38 — one source, so this script and a fresh database
 * cannot disagree. A table that is there is left alone. Then the sources of services/compliance/sources.js
 * whose code is missing are added (never changed). Global tables have deleted_at; company tables have
 * company_id and deleted_at (checked). Grant a platform admin afterwards with grant-platform-admin.mjs.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import mysql from 'mysql2/promise';
import { resolveTarget, announce } from './dbTarget.mjs';
import { SEED_SOURCES } from '../services/compliance/sources.js';

const APPLY = process.argv.includes('--apply');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const INIT = path.join(HERE, '..', 'models', 'init.sql');
const HEADER = '-- ## 38. COMPLIANCE';

function sectionText() {
  const text = fs.readFileSync(INIT, 'utf8').replace(/\r\n/g, '\n');
  const start = text.indexOf(HEADER);
  if (start < 0) throw new Error('init.sql has no §38 COMPLIANCE section.');
  const rest = text.slice(start + 10);
  const next = rest.search(/\n-- ## \d+\./);
  return next < 0 ? text.slice(start) : text.slice(start, start + 10 + next);
}

/** The CREATE TABLE statements of init.sql §38, in order: [{ table, sql, global }]. */
export function complianceTables() {
  const out = [];
  const re = /CREATE TABLE IF NOT EXISTS ([a-z0-9_]+) \([\s\S]*?\) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;/g;
  for (const m of sectionText().matchAll(re)) out.push({ table: m[1], sql: m[0], global: !/\n\s+company_id\s/.test(m[0]) });
  return out;
}
export const COMPLIANCE_TABLES = complianceTables().map((t) => t.table);
export const GLOBAL_TABLES = complianceTables().filter((t) => t.global).map((t) => t.table);

const one = async (conn, sql, params) => (await conn.query(sql, params))[0][0] ?? null;
const table = async (conn, t) => Boolean(await one(conn, 'SELECT 1 AS x FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', [t]));

/** What is still missing, in the order it must run: [{ what, sql }]. Reads only. */
export async function schemaSteps(conn) {
  for (const t of ['companies', 'users', 'hrms_tax_settings']) {
    if (!await table(conn, t)) throw new Error(`${t} is not there — run the earlier schema scripts first.`);
  }
  const steps = [];
  for (const t of complianceTables()) if (!await table(conn, t.table)) steps.push({ what: `create ${t.table}`, sql: t.sql });
  return steps;
}

/** Sources of the seed whose code is missing. */
export async function sourceSteps(conn) {
  if (!await table(conn, 'hrms_compliance_sources')) return SEED_SOURCES.map((s) => s.code);
  const [have] = await conn.query('SELECT code FROM hrms_compliance_sources WHERE deleted_at IS NULL');
  const codes = new Set(have.map((r) => r.code));
  return SEED_SOURCES.filter((s) => !codes.has(s.code)).map((s) => s.code);
}

async function main() {
  const target = resolveTarget();
  announce(target);
  const conn = await mysql.createConnection({ ...target.cfg, dateStrings: true });
  try {
    if (!APPLY) console.log('  DRY RUN — nothing is written without --apply\n');
    const tables = complianceTables();
    if (tables.length !== 12) throw new Error(`init.sql §38 should declare 12 tables; it declares ${tables.length}.`);
    for (const t of tables) {
      if (!/\bdeleted_at\b/.test(t.sql)) throw new Error(`${t.table} lacks deleted_at.`);
      if (t.table.startsWith('hrms_compliance_') && !t.global && !/\bcompany_id\b/.test(t.sql)) throw new Error(`${t.table} lacks company_id.`);
    }
    const steps = await schemaSteps(conn);
    if (!steps.length) console.log('  schema: already there — nothing to do');
    for (const s of steps) {
      if (APPLY) { await conn.query(s.sql); console.log(`  schema: ${s.what} — done`); } else console.log(`  schema: would ${s.what}`);
    }
    const missing = await sourceSteps(conn);
    if (!missing.length) console.log(`  sources: all ${SEED_SOURCES.length} there — nothing to add`);
    for (const code of missing) {
      const s = SEED_SOURCES.find((x) => x.code === code);
      if (APPLY) {
        await conn.query(
          `INSERT INTO hrms_compliance_sources (code, name, url, kind, frequency_hours, domains_json, jurisdictions_json, link_pattern, watch_text, also_sites, note, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
          [s.code, s.name, s.url, s.kind, s.frequency_hours, JSON.stringify(s.domains), JSON.stringify(s.jurisdictions), s.link_pattern ?? null, s.watch_text ? 1 : 0, s.also_sites ?? null, s.note ?? null]);
        console.log(`  sources: add ${s.code} (${s.kind}) — done`);
      } else console.log(`  sources: would add ${s.code} (${s.kind}) ${s.url}`);
    }
    if (APPLY) {
      const again = await schemaSteps(conn);
      if (again.length || (await sourceSteps(conn)).length) throw new Error('after applying, something is still to do');
      console.log('  checked: a second run plans nothing');
    }
    console.log(APPLY ? '\n  done. Next: grant-platform-admin.mjs --email=… --apply for the product team.\n' : `\n  nothing written — ${steps.length} schema step(s), ${missing.length} source(s) would be added. Run again with --apply.\n`);
  } finally {
    await conn.end();
  }
}

// Run only when called as a script; the test imports schemaSteps.
if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) main().then(() => process.exit(0)).catch((e) => { console.error(`\n  FAILED: ${e.message}\n`); process.exit(1); });
