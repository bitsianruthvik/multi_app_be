/**
 * verify-cataloged.mjs — does the data still obey "non-catalog is never bought
 * or received"? Re-run after any bulk import, script or migration.
 *
 * Read-only. Each check prints OK or the offending rows.
 *
 *   node scripts/verify-cataloged.mjs          # local
 *   node scripts/verify-cataloged.mjs --prod   # TiDB
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dir = path.dirname(fileURLToPath(import.meta.url));
if (process.argv.includes('--prod')) {
  const env = {};
  fs.readFileSync(path.join(__dir, '..', '..', '.env.tidb'), 'utf8').split('\n').forEach((l) => {
    l = l.trim(); if (!l || l.startsWith('#')) return;
    const [k, ...r] = l.split('='); env[k.trim()] = r.join('=').trim();
  });
  Object.assign(process.env, {
    DB_HOST: env.DB_HOST, DB_PORT: env.DB_PORT ?? '4000', DB_USER: env.DB_USER,
    DB_PASSWORD: env.DB_PASSWORD, DB_NAME: env.DB_NAME, DB_SSL: 'true',
  });
}
const { pool } = await import('../db.js');

const CHECKS = [
  ['every cut plate is non-catalog',
    `SELECT company_id, code FROM fab_item_catalog
      WHERE deleted_at IS NULL AND material_form = 'blank' AND is_cataloged = 1`],
  ['no non-catalog item is buyable',
    `SELECT company_id, code, procurement_type FROM fab_item_catalog
      WHERE deleted_at IS NULL AND is_cataloged = 0 AND procurement_type <> 'make'`],
  ['no non-catalog item was received into stock by hand',
    `SELECT l.company_id, c.code, COUNT(*) AS receipts FROM fab_stock_ledger l
       JOIN fab_item_catalog c ON c.id = l.catalog_item_id
      WHERE c.is_cataloged = 0 AND l.txn_type = 'stock_in'
      GROUP BY l.company_id, c.code`],
  ['no purchase-order line names a non-catalog item',
    `SELECT ol.company_id, o.order_number, c.code FROM fab_order_lines ol
       JOIN fab_orders o ON o.id = ol.order_id AND o.order_type = 'purchase' AND o.deleted_at IS NULL
       JOIN fab_item_catalog c ON c.id = ol.catalog_item_id
      WHERE ol.deleted_at IS NULL AND c.is_cataloged = 0`],
  ['no stock policy on a non-catalog item',
    `SELECT sp.company_id, c.code FROM fab_stock_policies sp
       JOIN fab_item_catalog c ON c.id = sp.catalog_item_id
      WHERE sp.deleted_at IS NULL AND c.is_cataloged = 0`],
];

let failed = 0;
try {
  for (const [label, sql] of CHECKS) {
    const [rows] = await pool.query(sql);
    if (!rows.length) { console.log(`OK    ${label}`); continue; }
    failed += 1;
    console.log(`FAIL  ${label} — ${rows.length}`);
    for (const r of rows.slice(0, 10)) console.log('        ', JSON.stringify(r));
  }

  // Static: every runtime INSERT into the catalog must state the flag, or a
  // new path quietly creates catalog items by the column default.
  const appDir = path.join(__dir, '..', 'apps', 'fab_erp');
  const offenders = [];
  const walk = (dir) => {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, f.name);
      if (f.isDirectory()) { if (!['models', 'node_modules'].includes(f.name)) walk(p); continue; }
      if (!f.name.endsWith('.js')) continue;
      const src = fs.readFileSync(p, 'utf8');
      const re = /INSERT INTO fab_item_catalog[\s\S]{0,600}?(VALUES|SET \?)/g;
      let m;
      while ((m = re.exec(src))) {
        if (!/is_cataloged/.test(src.slice(Math.max(0, m.index - 3000), m.index + m[0].length))) {
          offenders.push(path.relative(appDir, p));
        }
      }
    }
  };
  walk(appDir);
  if (offenders.length) { failed += 1; console.log(`FAIL  catalog inserts that do not set is_cataloged: ${offenders.join(', ')}`); }
  else console.log('OK    every runtime catalog insert sets is_cataloged');
} finally {
  await pool.end();
}
console.log(failed ? `\n${failed} check(s) failed.` : '\nAll checks passed.');
process.exitCode = failed ? 1 : 0;
