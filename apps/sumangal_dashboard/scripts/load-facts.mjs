/**
 * Replaces a company's dashboard rows with the facts file from build-facts.mjs.
 *
 *   node apps/sumangal_dashboard/scripts/load-facts.mjs <facts.json>          dry run, local
 *   node apps/sumangal_dashboard/scripts/load-facts.mjs <facts.json> --apply  write, local
 *   --company=<slug> (default sumangal)   --target=prod
 */
import fs from 'fs';
import mysql from 'mysql2/promise';
import { resolveTarget, announce } from '../../cf_hrms/scripts/dbTarget.mjs';

const file = process.argv[2];
if (!file || file.startsWith('--')) { console.error('Usage: load-facts.mjs <facts.json> [--apply]'); process.exit(1); }
const APPLY = process.argv.includes('--apply');
const SLUG = (process.argv.find((a) => a.startsWith('--company=')) || '--company=sumangal').split('=')[1];
const CHUNK = 500;

const target = resolveTarget();
announce(target);
console.log(APPLY ? '  mode: APPLY\n' : '  mode: dry run (add --apply to write)\n');
const facts = JSON.parse(fs.readFileSync(file, 'utf8'));
const conn = await mysql.createConnection(target.cfg);
const [[company]] = await conn.query('SELECT id FROM companies WHERE slug = ? AND deleted_at IS NULL', [SLUG]);
if (!company) { console.error(`No company "${SLUG}". Run setup.mjs first.`); process.exit(1); }

for (const [k, v] of Object.entries(facts)) console.log(`${k.padEnd(10)} ${v.length}`);
if (APPLY) {
  await conn.beginTransaction();
  await conn.query('DELETE FROM sd_rows WHERE company_id = ?', [company.id]);
  for (const [dataset, rows] of Object.entries(facts)) {
    for (let i = 0; i < rows.length; i += CHUNK) {
      const part = rows.slice(i, i + CHUNK).map((r) => [company.id, dataset, JSON.stringify(r)]);
      await conn.query('INSERT INTO sd_rows (company_id, dataset, data) VALUES ?', [part]);
    }
  }
  await conn.commit();
  console.log('\nloaded');
}
await conn.end();
