/**
 * Stores the ERP dashboard (V15) dataset for a company: sd_rows, dataset "v15", in chunks of ~400 KB
 * (TiDB caps a row). Touches no other dataset. Re-running replaces the chunks in one transaction.
 *
 *   node apps/sumangal_dashboard/scripts/v15/load-v15.mjs [D:/SumangalData/work/v15.json] [--apply] [--company=sumangal] [--target=prod]
 */
import fs from 'fs';
import mysql from 'mysql2/promise';
import { resolveTarget, announce } from '../../../cf_hrms/scripts/dbTarget.mjs';
const file = process.argv.slice(2).find((a) => !a.startsWith('--')) || 'D:/SumangalData/work/v15.json';
const APPLY = process.argv.includes('--apply');
const SLUG = (process.argv.find((a) => a.startsWith('--company=')) || '--company=sumangal').split('=')[1];
const CHUNK = 400000;
const target = resolveTarget(); announce(target);
console.log(APPLY ? '  mode: APPLY\n' : '  mode: dry run (add --apply to write)\n');
const text = fs.readFileSync(file, 'utf8'); JSON.parse(text);
const parts = []; for (let i = 0; i < text.length; i += CHUNK) parts.push(text.slice(i, i + CHUNK));
const conn = await mysql.createConnection(target.cfg);
const [[company]] = await conn.query('SELECT id FROM companies WHERE slug = ? AND deleted_at IS NULL', [SLUG]);
if (!company) { console.error(`No company "${SLUG}".`); process.exit(1); }
const [[have]] = await conn.query("SELECT COUNT(*) n FROM sd_rows WHERE company_id = ? AND dataset = 'v15'", [company.id]);
console.log(`company ${SLUG} (${company.id}): ${text.length} bytes in ${parts.length} chunks; stored now ${have.n} chunks`);
if (APPLY) {
  await conn.beginTransaction();
  try {
    await conn.query("DELETE FROM sd_rows WHERE company_id = ? AND dataset = 'v15'", [company.id]);
    for (let i = 0; i < parts.length; i++) await conn.query("INSERT INTO sd_rows (company_id, dataset, data) VALUES (?, 'v15', ?)", [company.id, JSON.stringify({ i, s: parts[i] })]);
    await conn.commit(); console.log('loaded');
  } catch (e) { await conn.rollback(); console.error('FAILED, nothing changed:', e.message); process.exitCode = 1; }
}
await conn.end();
