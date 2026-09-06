/**
 * consolidate-parts.mjs — give an order's parts their real identity.
 *
 *   node scripts/consolidate-parts.mjs <orderId>            # report
 *   node scripts/consolidate-parts.mjs <orderId> --apply
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const APPLY = process.argv.includes('--apply');
const orderId = Number(process.argv[2]);
const __dir = path.dirname(fileURLToPath(import.meta.url));
const env = {};
fs.readFileSync(path.join(__dir, '..', '..', '.env.tidb'), 'utf8').split('\n').forEach((l) => {
  l = l.trim(); if (!l || l.startsWith('#')) return;
  const [k, ...r] = l.split('='); env[k.trim()] = r.join('=').trim();
});
Object.assign(process.env, {
  DB_HOST: env.DB_HOST, DB_PORT: env.DB_PORT ?? '4000', DB_USER: env.DB_USER,
  DB_PASSWORD: env.DB_PASSWORD, DB_NAME: env.DB_NAME, DB_SSL: 'true',
});
const { pool } = await import('../db.js');
const { consolidateParts } = await import('../apps/fab_erp/services/partIdentityService.js');

const COMPANY = 30005;
const r = await consolidateParts(COMPANY, orderId, { apply: APPLY });
console.log(`part rows          ${r.parts}`);
console.log(`distinct parts     ${r.identities}   (blanks: ${r.blanks})`);
console.log(`rows merged away   ${r.merged}`);
console.log(`pieces             ${r.pieces}\n`);
console.log('the ten biggest:');
for (const g of [...r.groups].sort((a, b) => b.qty - a.qty).slice(0, 10)) {
  console.log(`  ${String(g.qty).padStart(5)} x  ${g.code}`);
  console.log(`          ${g.name} — ${g.rows} row(s), needed by ${g.assemblies} assembly(ies)`);
}
if (!APPLY) console.log('\nDRY RUN — pass --apply.');
await pool.end();
