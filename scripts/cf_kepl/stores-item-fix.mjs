/**
 * stores-item-fix.mjs — one stores item a thing (user, 2026-11-23): the same material loaded twice (the item list's
 * spec name, empty, and the ledger's branded name holding the stock) is put back to ONE item: the item with the stock
 * keeps its id, history and lots and takes the plain name; the brand goes onto its lots; the empty twin is deleted
 * (deleteRecord refuses anything with stock history, so nothing with a ledger row can go).
 *
 *   cd multi_app_be
 *   node scripts/cf_kepl/stores-item-fix.mjs --company 30005 --prod --plan <plan.json> [--apply] [--before <file.json>]
 * plan.json: [{ "keep": "CN-PNT-0032", "name": "ALUMINIUM PAINT IS 2339", "brand": "Berger", "lotNote": "Berger product 661984",
 *               "retire": ["CN-PNT-0001"] }, ...]   name / brand / lotNote / retire each optional.
 * DRY RUN BY DEFAULT (all of it done and rolled back). --apply commits one plan row at a time; re-running skips what is done.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
const COMPANY = Number(arg('company'));
const APPLY = process.argv.includes('--apply');
if (!COMPANY || !arg('plan')) { console.error('Usage: --company <id> [--prod] --plan plan.json [--apply] [--before file.json]'); process.exit(2); }
const TM = path.join(__dir, '..', '..', '..');
if (process.argv.includes('--prod')) {
  const env = {};
  fs.readFileSync(path.join(TM, '.env.tidb'), 'utf8').split('\n').forEach((l) => {
    l = l.trim(); if (!l || l.startsWith('#')) return;
    const [k, ...r] = l.split('='); env[k.trim()] = r.join('=').trim();
  });
  Object.assign(process.env, { DB_HOST: env.DB_HOST, DB_PORT: env.DB_PORT ?? '4000', DB_USER: env.DB_USER, DB_PASSWORD: env.DB_PASSWORD, DB_NAME: env.DB_NAME, DB_SSL: 'true' });
}
const imp = (p) => import(pathToFileURL(path.join(__dir, '..', '..', p)).href);
const { pool } = await imp('db.js');
await imp('apps/cf_erp/services/codegenProvider.js');
const { updateRecord, deleteRecord } = await imp('apps/cf_erp/services/masterRecordService.js');
const { updateBatch } = await imp('apps/cf_erp/services/batchService.js');
const { addBrand, brandKey } = await imp('apps/cf_erp/services/brandService.js');
const { attachNodeCache, detachNodeCache } = await imp('apps/cf_erp/lib/nodeCache.js');

const plan = JSON.parse(fs.readFileSync(arg('plan'), 'utf8'));
const where = process.env.DB_HOST && !/^(localhost|127\.0\.0\.1)$/.test(process.env.DB_HOST) ? 'PRODUCTION DB' : 'local';
console.log(`${where} — company ${COMPANY} — ${APPLY ? 'APPLY' : 'DRY RUN (rolled back)'} — ${plan.length} plan rows`);

const [[user]] = await pool.query("SELECT id FROM users WHERE company_id = ? ORDER BY (email LIKE 'admin@%') DESC, id LIMIT 1", [COMPANY]);
const c = { companyId: COMPANY, userId: user?.id ?? null };
const item = async (db, code) => (await db.query(
  `SELECT m.id, m.code, m.name, (SELECT COUNT(*) FROM cf_stock_ledger l WHERE l.company_id = m.company_id AND l.item_id = m.id) AS hist
     FROM cf_master_records m WHERE m.company_id = ? AND m.code = ? AND m.deleted_at IS NULL`, [COMPANY, code]))[0][0] ?? null;

const before = [];
let ok = 0; let failed = 0;
for (const p of plan) {
  const db = await pool.getConnection();
  try {
    await db.beginTransaction(); attachNodeCache(db);
    const out = [];
    const k = await item(db, p.keep);
    if (!k) throw new Error(`${p.keep} not found`);
    const [lots] = await db.query('SELECT id, code, brand_id, notes FROM cf_stock_batches WHERE company_id = ? AND item_id = ? AND deleted_at IS NULL', [COMPANY, k.id]);
    const rec = { keep: k.code, id: k.id, name: k.name, lots: lots.map((l) => ({ id: l.id, code: l.code, brandId: l.brand_id, notes: l.notes })), retired: [] };
    // the old name stays in the description: the stores' ledger still calls it that, and next month's load matches by name
    if (p.name && p.name !== k.name) {
      const [[d]] = await db.query('SELECT description FROM cf_master_records WHERE id = ?', [k.id]);
      const note = `Stores ledger name: ${k.name}`;
      await updateRecord(db, c, k.id, { name: p.name, description: [d?.description, note].filter(Boolean).join('\n') });
      rec.description = d?.description ?? null;
      out.push(`name "${k.name}" → "${p.name}"`);
    }
    if (p.brand) {
      const [brands] = await db.query('SELECT id, name FROM cf_brands WHERE company_id = ? AND deleted_at IS NULL', [COMPANY]);
      let b = brands.find((x) => brandKey(x.name) === brandKey(p.brand));
      if (!b) { b = await addBrand(db, c, { name: p.brand, confirm: true }); out.push(`brand ${p.brand} added to the list`); }
      for (const l of lots) {
        const set = {};
        if (!l.brand_id) set.brandId = b.id;
        if (p.lotNote && !String(l.notes ?? '').includes(p.lotNote)) set.notes = [l.notes, p.lotNote].filter(Boolean).join(' · ');
        if (Object.keys(set).length) { await updateBatch(db, c, l.id, set); out.push(`lot ${l.code}: ${set.brandId ? `brand ${b.name}` : ''}${set.notes ? ` note "${p.lotNote}"` : ''}`.trim()); }
        else if (Number(l.brand_id) !== Number(b.id)) out.push(`lot ${l.code} already has another brand (#${l.brand_id}) — left`);
      }
    }
    for (const code of p.retire ?? []) {
      const r = await item(db, code);
      if (!r) continue; // done before
      if (Number(r.hist)) throw new Error(`${code} has ${r.hist} ledger rows — not an empty twin`);
      rec.retired.push({ id: r.id, code: r.code, name: r.name });
      await deleteRecord(db, c, r.id); out.push(`deleted empty twin ${code} "${r.name}"`);
      // its name stays findable on the item kept (the item list and the ledger may still call it that)
      const [[d]] = await db.query('SELECT name, description FROM cf_master_records WHERE id = ?', [k.id]);
      const alias = `Also called: ${r.name} (was ${r.code})`;
      if (r.name !== d.name && !String(d.description ?? '').includes(alias)) {
        if (rec.description === undefined) rec.description = d.description ?? null;
        await updateRecord(db, c, k.id, { description: [d.description, alias].filter(Boolean).join('\n') });
      }
    }
    // aliases: other names the workbooks use for it (a twin deleted before aliases were kept)
    for (const a of p.aliases ?? []) {
      const [[d]] = await db.query('SELECT description FROM cf_master_records WHERE id = ?', [k.id]);
      const alias = `Also called: ${a}`;
      if (!String(d.description ?? '').includes(alias)) {
        if (rec.description === undefined) rec.description = d.description ?? null;
        await updateRecord(db, c, k.id, { description: [d.description, alias].filter(Boolean).join('\n') }); out.push(`alias "${a}"`);
      }
    }
    if (APPLY) await db.commit(); else await db.rollback();
    if (out.length) before.push(rec);
    console.log(`${p.keep}: ${out.length ? out.join('; ') : 'nothing to do'}`); ok++;
  } catch (e) {
    try { await db.rollback(); } catch { /* */ }
    console.log(`${p.keep}: FAILED — ${e.message}`); failed++;
  } finally { detachNodeCache(db); db.release(); }
}
if (APPLY && arg('before') && before.length) { fs.writeFileSync(arg('before'), JSON.stringify(before, null, 1)); console.log(`before-values: ${arg('before')}`); }
console.log(`done ${ok}, failed ${failed}`);
await pool.end();
