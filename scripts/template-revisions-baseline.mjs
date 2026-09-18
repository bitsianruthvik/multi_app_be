/**
 * template-revisions-baseline.mjs — Rev 1 for every template that exists today.
 *
 * From 2026-09-18 an order is built from a template's latest RELEASED revision
 * and a template with none cannot be built from (templateRevisionService). So
 * every item that has a BOM gets a baseline Rev 1 of its current working copy,
 * or nothing that sells today could be ordered tomorrow.
 *
 * Safe to re-run: an item that already has a revision is skipped. Orders built
 * before this keep `template_revision` NULL — "built before revisions" — since
 * the tree they were built from is not necessarily the one frozen here.
 *
 *   node scripts/template-revisions-baseline.mjs                 # local, dry run
 *   node scripts/template-revisions-baseline.mjs --apply
 *   node scripts/template-revisions-baseline.mjs --prod [--apply]
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const PROD = process.argv.includes('--prod');
const APPLY = process.argv.includes('--apply');
if (PROD) {
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
const { releaseRevision } = await import('../apps/fab_erp/services/templateRevisionService.js');

try {
  const [items] = await pool.query(
    `SELECT DISTINCT c.company_id AS companyId, c.id, c.name, c.code
       FROM fab_item_bom b
       JOIN fab_item_catalog c ON c.id = b.parent_item_id AND c.deleted_at IS NULL
      WHERE b.deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM fab_template_revisions r
                         WHERE r.company_id = c.company_id AND r.template_item_id = c.id AND r.deleted_at IS NULL)
      ORDER BY c.company_id, c.name`,
  );
  console.log(`${PROD ? 'PROD' : 'LOCAL'} — ${items.length} template(s) with no revision yet`);
  let done = 0;
  for (const it of items) {
    console.log(`  Rev 1  co ${it.companyId}  ${it.code}  ${it.name}`);
    if (APPLY) {
      await releaseRevision(it.companyId, it.id, { note: 'Baseline — revisions start here (2026-09-18)' });
      done += 1;
    }
  }
  console.log(APPLY ? `\nReleased ${done}.` : '\nDRY RUN — nothing was written. Re-run with --apply.');
} finally {
  await pool.end();
}
