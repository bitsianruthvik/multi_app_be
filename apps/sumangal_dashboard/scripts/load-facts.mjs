/**
 * Loads the facts file from build-facts.mjs into a company's dashboard rows, one dataset at a time.
 *
 *   node apps/sumangal_dashboard/scripts/load-facts.mjs <facts.json>          dry run, local
 *   node apps/sumangal_dashboard/scripts/load-facts.mjs <facts.json> --apply  write, local
 *   --company=<slug> (default sumangal)   --target=prod
 *   --only=lines,stock      load just these datasets (the ones that changed)
 *
 * Each dataset is replaced in its own transaction (delete its rows, insert the new ones, commit), so a
 * dropped connection loses one dataset's work, not the whole load. Re-running is safe: a dataset that
 * already went in is simply replaced by the same rows. Datasets no longer in the file are removed.
 */
import fs from 'fs';
import mysql from 'mysql2/promise';
import { resolveTarget, announce } from '../../cf_hrms/scripts/dbTarget.mjs';

const file = process.argv[2];
if (!file || file.startsWith('--')) { console.error('Usage: load-facts.mjs <facts.json> [--apply] [--only=a,b]'); process.exit(1); }
const APPLY = process.argv.includes('--apply');
const SLUG = (process.argv.find((a) => a.startsWith('--company=')) || '--company=sumangal').split('=')[1];
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) || '').split('=')[1]?.split(',').map((s) => s.trim()).filter(Boolean) || null;
const CHUNK = 500;

const target = resolveTarget();
announce(target);
console.log(APPLY ? '  mode: APPLY\n' : '  mode: dry run (add --apply to write)\n');
const facts = JSON.parse(fs.readFileSync(file, 'utf8'));
if (ONLY) for (const k of ONLY) if (!(k in facts)) { console.error(`No dataset "${k}" in the facts file.`); process.exit(1); }
const conn = await mysql.createConnection(target.cfg);
const [[company]] = await conn.query('SELECT id FROM companies WHERE slug = ? AND deleted_at IS NULL', [SLUG]);
if (!company) { console.error(`No company "${SLUG}". Run setup.mjs first.`); process.exit(1); }

const [have] = await conn.query('SELECT dataset, COUNT(*) n FROM sd_rows WHERE company_id = ? GROUP BY dataset', [company.id]);
const stored = new Map(have.map((r) => [r.dataset, Number(r.n)]));
const todo = Object.entries(facts).filter(([k]) => !ONLY || ONLY.includes(k));
for (const [k, v] of todo) console.log(`${k.padEnd(12)} ${String(v.length).padStart(7)}   stored now ${stored.get(k) ?? 0}`);
const gone = ONLY ? [] : [...stored.keys()].filter((k) => !(k in facts));
if (gone.length) console.log(`no longer in the file, to remove: ${gone.join(', ')}`);

if (APPLY) {
  for (const [dataset, rows] of todo) {
    await conn.beginTransaction();
    try {
      await conn.query('DELETE FROM sd_rows WHERE company_id = ? AND dataset = ?', [company.id, dataset]);
      for (let i = 0; i < rows.length; i += CHUNK) {
        const part = rows.slice(i, i + CHUNK).map((r) => [company.id, dataset, JSON.stringify(r)]);
        await conn.query('INSERT INTO sd_rows (company_id, dataset, data) VALUES ?', [part]);
      }
      await conn.commit();
      console.log(`  loaded ${dataset} (${rows.length})`);
    } catch (e) { await conn.rollback(); console.error(`  FAILED ${dataset}: ${e.message}. Datasets before it are in; re-run to continue.`); await conn.end(); process.exit(1); }
  }
  for (const dataset of gone) { await conn.query('DELETE FROM sd_rows WHERE company_id = ? AND dataset = ?', [company.id, dataset]); console.log(`  removed ${dataset}`); }
  console.log('\nloaded');
}
await conn.end();
