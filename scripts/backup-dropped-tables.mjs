/**
 * backup-dropped-tables.mjs — dump the tables the 2026-09-02 migration drops.
 *
 * `fab_flow_rules` is seeded into `fab_item_bom.default_flow_id` before it goes,
 * so its content survives in a better form. `fab_bom_templates` is not migrated
 * anywhere — it was a flat per-line-type part list feeding a wizard that no
 * longer exists — so those rows are genuinely lost at the DROP.
 *
 * A DROP is the one thing in this batch that soft deletion cannot undo, so it
 * gets a file on disk first. Cheap, and it costs nothing to never need it.
 *
 *   node scripts/backup-dropped-tables.mjs [--local]
 */
import mysql from 'mysql2/promise';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const LOCAL = process.argv.includes('--local');
const __dir = path.dirname(fileURLToPath(import.meta.url));
const envPath = LOCAL ? path.join(__dir, '..', '.env') : path.join(__dir, '..', '..', '.env.tidb');

const env = {};
fs.readFileSync(envPath, 'utf8').split('\n').forEach((l) => {
  l = l.trim(); if (!l || l.startsWith('#')) return;
  const [k, ...r] = l.split('='); env[k.trim()] = r.join('=').trim();
});
const conn = await mysql.createConnection({
  host: env.DB_HOST, port: Number(env.DB_PORT) || (LOCAL ? 3306 : 4000),
  user: env.DB_USER, password: env.DB_PASSWORD, database: env.DB_NAME,
  ...(LOCAL ? {} : { ssl: { rejectUnauthorized: true } }),
});

const stamp = new Date().toISOString().slice(0, 10);
const out = path.join(__dir, '..', '..', `backup-dropped-tables-${LOCAL ? 'local' : 'prod'}-${stamp}.sql`);
const lines = [
  `-- Tables dropped by the 2026-09-02 "structure without levels" migration.`,
  `-- Source: ${LOCAL ? 'local' : 'TiDB production'}, taken ${new Date().toISOString()}`,
  '',
];

let total = 0;
for (const table of ['fab_flow_rules', 'fab_bom_templates']) {
  let rows;
  try { [rows] = await conn.query(`SELECT * FROM \`${table}\``); }
  catch { lines.push(`-- ${table}: table not present\n`); continue; }

  const [[create]] = await conn.query(`SHOW CREATE TABLE \`${table}\``);
  lines.push(`-- ${'='.repeat(70)}`, `-- ${table} — ${rows.length} rows`, `-- ${'='.repeat(70)}`, '');
  lines.push(`${create['Create Table']};`, '');

  for (const r of rows) {
    const cols = Object.keys(r).map((c) => `\`${c}\``).join(', ');
    const vals = Object.values(r).map((v) => {
      if (v === null) return 'NULL';
      if (v instanceof Date) return `'${v.toISOString().slice(0, 19).replace('T', ' ')}'`;
      if (typeof v === 'number') return String(v);
      if (typeof v === 'object') return `'${JSON.stringify(v).replace(/'/g, "''")}'`;
      return `'${String(v).replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
    }).join(', ');
    lines.push(`INSERT INTO \`${table}\` (${cols}) VALUES (${vals});`);
  }
  lines.push('');
  total += rows.length;
  console.log(`${table.padEnd(20)} ${rows.length} rows`);
}

fs.writeFileSync(out, lines.join('\n'), 'utf8');
console.log(`\n${total} rows written to ${out}`);
await conn.end();
