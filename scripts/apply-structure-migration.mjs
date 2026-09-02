/**
 * apply-structure-migration.mjs — run the 2026-09-02 block of init.sql.
 *
 * The whole file is a 6,000-line replayable patch; running all of it against
 * TiDB to add three columns is slow and gives a much larger blast radius than
 * the change deserves. This slices out the final section by its banner and runs
 * only that.
 *
 * Every statement in the block is guarded (information_schema checks, IF NOT
 * EXISTS, blank-filling UPDATEs), so re-running is a no-op.
 *
 *   node scripts/apply-structure-migration.mjs            # print the statements
 *   node scripts/apply-structure-migration.mjs --apply    # run them
 */
import mysql from 'mysql2/promise';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const APPLY = process.argv.includes('--apply');
const __dir = path.dirname(fileURLToPath(import.meta.url));
const MARKER = 'STRUCTURE WITHOUT LEVELS (2026-09-02)';

const sqlFile = path.join(__dir, '..', 'apps', 'fab_erp', 'models', 'init.sql');
const full = fs.readFileSync(sqlFile, 'utf8');
const at = full.indexOf(MARKER);
if (at === -1) throw new Error(`Could not find "${MARKER}" in init.sql`);
const block = full.slice(at);

/**
 * Strip `--` comments, split on `;`, then trim each statement back to its first
 * SQL keyword.
 *
 * That last step matters: the slice starts at the MARKER, which sits inside the
 * banner comment, so the banner's own text survives the comment filter and gets
 * glued onto the front of the first `SET`. Running that is a syntax error, and
 * it would be a syntax error against production.
 */
const SQL_START = /^(SET|PREPARE|EXECUTE|DEALLOCATE|UPDATE|ALTER|CREATE|DROP|INSERT|DELETE|SELECT)\b/i;

const statements = block
  .split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n')
  .split(';')
  .map((s) => {
    const lines = s.split('\n');
    const first = lines.findIndex((l) => SQL_START.test(l.trim()));
    return first === -1 ? '' : lines.slice(first).join('\n').trim();
  })
  .filter(Boolean);

console.log(`${APPLY ? 'APPLY' : 'DRY RUN'} — ${statements.length} statements\n`);
if (!APPLY) {
  statements.forEach((s, i) => console.log(`${String(i + 1).padStart(2)}. ${s.split('\n')[0].slice(0, 96)}`));
  process.exit(0);
}

/**
 * `--local` runs against the dev database in multi_app_be/.env; the default is
 * TiDB. Explicit rather than inferred, because "which database am I dropping a
 * column from" is not a question to answer by convention.
 */
const LOCAL = process.argv.includes('--local');
const envPath = LOCAL ? path.join(__dir, '..', '.env') : path.join(__dir, '..', '..', '.env.tidb');

const env = {};
fs.readFileSync(envPath, 'utf8').split('\n').forEach((l) => {
  l = l.trim(); if (!l || l.startsWith('#')) return;
  const [k, ...r] = l.split('='); env[k.trim()] = r.join('=').trim();
});
const conn = await mysql.createConnection({
  host: env.DB_HOST, port: Number(env.DB_PORT) || (LOCAL ? 3306 : 4000), user: env.DB_USER,
  password: env.DB_PASSWORD, database: env.DB_NAME,
  ...(LOCAL ? {} : { ssl: { rejectUnauthorized: true } }),
  multipleStatements: false,
});
console.log('connected:', LOCAL ? `${env.DB_HOST}/${env.DB_NAME} (local)` : env.DB_HOST, '\n');

let ok = 0;
for (const [i, stmt] of statements.entries()) {
  const head = stmt.split('\n')[0].slice(0, 80);
  try {
    const [res] = await conn.query(stmt);
    const n = res?.affectedRows;
    console.log(`  ${String(i + 1).padStart(2)}. ok${n ? ` (${n} rows)` : ''}  ${head}`);
    ok++;
  } catch (err) {
    console.error(`  ${String(i + 1).padStart(2)}. FAILED  ${head}\n      ${err.message}`);
    await conn.end();
    process.exit(1);
  }
}
console.log(`\n${ok}/${statements.length} statements applied.`);

const [[shape]] = await conn.query(
  `SELECT
     (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE()
       AND TABLE_NAME='fab_items' AND COLUMN_NAME IN ('node_kind','depth','is_leaf')) AS new_cols,
     (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE()
       AND TABLE_NAME='fab_items' AND COLUMN_NAME IN ('level_kind','flow_source','manufacturing_method_template_id')) AS old_cols,
     (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE()
       AND TABLE_NAME='fab_item_bom' AND COLUMN_NAME='default_flow_id') AS bom_flow,
     (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()
       AND TABLE_NAME IN ('fab_flow_rules','fab_bom_templates')) AS dead_tables`,
);
console.log('\nverify:', JSON.stringify(shape), '\n(expect new_cols 3, old_cols 0, bom_flow 1, dead_tables 0)');
await conn.end();
