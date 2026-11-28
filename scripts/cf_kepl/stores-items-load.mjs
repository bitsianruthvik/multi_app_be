/**
 * stores-items-load.mjs — the stores' item list (TM/stores_import/items.json, made by stores_import/clean.mjs) into the
 * catalog: each group as a sub-family with one variant, each name as a catalog item with its unit. ITEMS AND THEIR
 * CLASSIFICATION ONLY: no stock, no price, no ordering method (user, 2026-11-19).
 *
 *   cd multi_app_be
 *   node scripts/cf_kepl/stores-items-load.mjs --company 180005 --prod [--sample 4] [--apply]
 *
 * DRY RUN BY DEFAULT (everything is done in a transaction and rolled back). --sample N takes N items a group.
 * Safe to run again: a sub-family, variant or item that is already there (same name in the same variant) is left alone,
 * and codes carry on from the highest one in use. --apply commits 25 items at a time.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { useProdDb } from '../lib/prodDb.mjs';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
const COMPANY = Number(arg('company'));
const APPLY = process.argv.includes('--apply');
const SAMPLE = Number(arg('sample') ?? 0);
if (!COMPANY) { console.error('Usage: --company <id> [--prod] [--sample N] [--apply]'); process.exit(2); }
const TM = path.join(__dir, '..', '..', '..');
if (process.argv.includes('--prod')) {
  await useProdDb();
}
const imp = (p) => import(pathToFileURL(path.join(__dir, '..', '..', p)).href);
const { pool } = await imp('db.js');
await imp('apps/cf_erp/services/codegenProvider.js');
const { createItem } = await imp('apps/cf_erp/services/masterRecordService.js');
const { createCatalogNode } = await imp('apps/cf_erp/services/classificationService.js');
const { attachNodeCache, detachNodeCache } = await imp('apps/cf_erp/lib/nodeCache.js');
const { GROUPS } = await import(pathToFileURL(path.join(TM, 'stores_import', 'groups.mjs')).href);

const all = JSON.parse(fs.readFileSync(path.join(TM, 'stores_import', 'items.json'), 'utf8'));
const CHUNK = 25;
const node = async (db, where, params) => (await db.query(`SELECT id, code, name, depth FROM cf_classification_nodes WHERE company_id = ? AND deleted_at IS NULL AND ${where} LIMIT 1`, [COMPANY, ...params]))[0][0] ?? null;

/** fn(db) in a transaction: committed with --apply, else rolled back. */
async function unit(fn) {
  const db = await pool.getConnection();
  try {
    await db.beginTransaction(); attachNodeCache(db);
    const out = await fn(db);
    if (APPLY) await db.commit(); else await db.rollback();
    return out;
  } catch (e) { try { await db.rollback(); } catch { /* going back anyway */ } throw e; } finally { detachNodeCache(db); db.release(); }
}

try {
  const where = process.env.DB_HOST && !/^(localhost|127\.0\.0\.1)$/.test(process.env.DB_HOST) ? 'PRODUCTION DB' : 'local';
  const [[co]] = await pool.query('SELECT id, name, slug FROM companies WHERE id = ?', [COMPANY]);
  if (!co) throw new Error(`No company ${COMPANY}.`);
  const [[user]] = await pool.query("SELECT id FROM users WHERE company_id = ? ORDER BY (email LIKE 'admin@%') DESC, id LIMIT 1", [COMPANY]);
  const c = { companyId: COMPANY, userId: user?.id ?? null };
  console.log(`${where} — company ${COMPANY} (${co.slug}) — ${APPLY ? 'APPLY' : 'DRY RUN (rolled back)'}${SAMPLE ? ` — sample of ${SAMPLE} a group` : ''}`);

  let made = 0; let skipped = 0; let failed = 0; let trips = 0;
  const t0 = Date.now();
  for (const [group, g] of Object.entries(GROUPS)) {
    let items = all.filter((i) => i.group === group);
    if (SAMPLE) items = items.slice(0, SAMPLE);
    if (!items.length) continue;
    // In a dry run the nodes made in one transaction are gone in the next, so a dry run does a group in ONE transaction.
    const parts = APPLY ? Array.from({ length: Math.ceil(items.length / CHUNK) }, (_, k) => items.slice(k * CHUNK, (k + 1) * CHUNK)) : [items];
    let said = false;
    for (const part of parts) {
      const r = await unit(async (db) => {
        const q0 = db.query.bind(db); db.query = (...a) => { trips += 1; return q0(...a); };
        const family = await node(db, 'depth = 0 AND code = ?', [g.family]);
        if (!family) throw new Error(`Family ${g.family} is not in company ${COMPANY}.`);
        let sub = await node(db, 'parent_id = ? AND name = ?', [family.id, g.sub]);
        let madeSub = false;
        if (!sub) { sub = await createCatalogNode(db, c, { parentId: family.id, code: `STORES_${g.prefix.replace(/-/g, '_')}`, name: g.sub, createdIn: 'items' }); madeSub = true; }
        const vName = g.variant ?? 'General';
        let variant = await node(db, 'parent_id = ? AND name = ?', [sub.id, vName]);
        let madeVariant = false;
        if (!variant) { variant = await createCatalogNode(db, c, { parentId: sub.id, code: g.variantCode ?? `STORES_${g.prefix.replace(/-/g, '_')}_V`, name: vName, createdIn: 'items' }); madeVariant = true; }
        const [have] = await db.query("SELECT name FROM cf_master_records WHERE company_id = ? AND classification_id = ? AND deleted_at IS NULL AND record_kind = 'item'", [COMPANY, variant.id]);
        const names = new Set(have.map((x) => String(x.name).toUpperCase()));
        const [[top]] = await db.query('SELECT MAX(CAST(SUBSTRING(code, ?) AS UNSIGNED)) AS n FROM cf_master_records WHERE company_id = ? AND code LIKE ?', [g.prefix.length + 2, COMPANY, `${g.prefix}-%`]);
        let seq = Number(top?.n) || 0;
        const out = { made: 0, skipped: 0, failed: [], madeSub, madeVariant, path: `${family.name} › ${sub.name} › ${variant.name}` };
        for (const it of part) {
          if (names.has(it.name.toUpperCase())) { out.skipped += 1; continue; }
          seq += 1;
          const code = `${g.prefix}-${String(seq).padStart(4, '0')}`;
          try {
            await db.query('SAVEPOINT one');
            await createItem(db, c, { classificationId: variant.id, name: it.name.slice(0, 255), code, uom: it.uom, trackedBy: 'quantity', sourcing: 'stock', status: 'active' });
            names.add(it.name.toUpperCase()); out.made += 1;
          } catch (e) {
            await db.query('ROLLBACK TO SAVEPOINT one'); seq -= 1;
            out.failed.push(`${it.name}: ${e.message}${e.problems ? ' — ' + e.problems.join('; ') : ''}`);
          }
        }
        return out;
      });
      if (!said) { console.log(`\n${group} → ${r.path}${r.madeSub ? ' (new sub-family)' : ''}${r.madeVariant ? ' (new variant)' : ''}`); said = true; }
      made += r.made; skipped += r.skipped; failed += r.failed.length;
      for (const f of r.failed.slice(0, 5)) console.log(`   FAILED ${f}`);
      console.log(`   ${r.made} made, ${r.skipped} already there${r.failed.length ? `, ${r.failed.length} failed` : ''}  (${Math.round((Date.now() - t0) / 1000)} s)`);
    }
  }
  console.log(`\n${made} items ${APPLY ? 'made' : 'would be made'}, ${skipped} already there, ${failed} failed; ${trips} round trips, ${Math.round((Date.now() - t0) / 1000)} s`);
  process.exitCode = failed ? 1 : 0;
} finally { await pool.end(); }
