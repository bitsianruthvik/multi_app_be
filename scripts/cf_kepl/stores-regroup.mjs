/**
 * stores-regroup.mjs — the stores items of a company put right against the stores' own ledger (user, 2026-11-22):
 *   regroup   every item the November STORE LEDGER names is filed under the ledger's own group (its ABSTRACT sheet: 100
 *             SAFETY, 200 TOOLS & TACKLES, 300 GRINDING & DRILLING, 400 WELDING, 500 GASES, 600 PAINTING, 700 MAINTENANCE
 *             SPARES, 800 CNC, 900 STUDS, 910 FASTENERS) and takes that group's code prefix (user's choice: new codes).
 *             The first load filed by the item list's own blocks and read the master list's codes wrongly (600 PAINTING as
 *             General consumables, 300 as Welding, 400 as General), so paints sat in three other groups.
 *   brands    the brand list is started with the brands the item names carry (§117).
 *   lots      every stores item is kept by lot from now on (user's choice: one lot per GRN line); its loose stock becomes an
 *             opening lot (stockService.keepByLot: same quantity and value, one adjustment a chunk), with the brand its name
 *             carries, else none ("not recorded": unknown is not Unbranded).
 * Items the ledger does not name keep their group and code. Nothing else is touched: balances stay as they are.
 *
 *   cd multi_app_be
 *   node scripts/cf_kepl/stores-regroup.mjs --company 30005 --prod [--step regroup|brands|lots|all] [--apply] [--before <file.json>]
 * DRY RUN BY DEFAULT (one chunk done and rolled back, the whole plan printed). --apply commits 25 items at a time; re-running
 * skips what is done. --before: the codes, groups and tracking before the change, written first (to put it back).
 * Reads TM/stores_import/ledger.json (stores_import/ledger-read.mjs).
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { useProdDb } from '../lib/prodDb.mjs';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
const COMPANY = Number(arg('company'));
const APPLY = process.argv.includes('--apply');
const STEP = arg('step') ?? 'all';
if (!COMPANY) { console.error('Usage: --company <id> [--prod] [--step regroup|brands|lots|all] [--apply] [--before file.json]'); process.exit(2); }
const TM = path.join(__dir, '..', '..', '..');
if (process.argv.includes('--prod')) {
  await useProdDb();
}
const imp = (p) => import(pathToFileURL(path.join(__dir, '..', '..', p)).href);
const { pool } = await imp('db.js');
await imp('apps/cf_erp/services/codegenProvider.js');
const { updateRecord } = await imp('apps/cf_erp/services/masterRecordService.js');
const { createCatalogNode } = await imp('apps/cf_erp/services/classificationService.js');
const { attachNodeCache, detachNodeCache } = await imp('apps/cf_erp/lib/nodeCache.js');
const { keepByLot } = await imp('apps/cf_erp/services/stockService.js');
const { addBrand, ensureUnbranded } = await imp('apps/cf_erp/services/brandService.js');

// the ledger's groups (its ABSTRACT sheet) → where they sit in the catalog
const TARGET = {
  100: { family: 'RES-CONSUMABLES', sub: 'Safety items', prefix: 'CN-SAF' },
  200: { family: 'RES-TOOLS', sub: 'Tools and measuring', prefix: 'TL-GEN' },
  300: { family: 'RES-CONSUMABLES', sub: 'Grinding and drilling', prefix: 'CN-GRD', variant: 'General', variantCode: 'STORES_CN_GRD_V', subCode: 'STORES_CN_GRD' },
  400: { family: 'RES-CONSUMABLES', sub: 'Welding consumables', prefix: 'CN-WLD' },
  500: { family: 'RES-CONSUMABLES', sub: 'Gas consumables', prefix: 'CN-GAS' },
  600: { family: 'RES-CONSUMABLES', sub: 'Painting consumables', prefix: 'CN-PNT' },
  700: { family: 'RES-SPARES', sub: 'Machinery spares', prefix: 'SP-MCH' },
  800: { family: 'RES-CONSUMABLES', sub: 'CNC consumables', prefix: 'CN-CNC' },
  900: { family: 'BOUGHT', sub: 'Fasteners', prefix: 'FS-STR', variant: 'Drifts, fasteners and studs (stores)' },
  910: { family: 'BOUGHT', sub: 'Fasteners', prefix: 'FS-STR', variant: 'Drifts, fasteners and studs (stores)' },
};
// brands the item names carry (the word as it is in the name → the brand's name on the list)
const NAME_BRANDS = [[/\bBERGER\b/i, 'Berger'], [/\bMAKITA\b/i, 'Makita'], [/\bKARAM\b/i, 'Karam'], [/\bANABOND\b/i, 'Anabond'], [/\bESAB\b/i, 'ESAB'],
  [/\bGRACO\b/i, 'Graco'], [/\bPROMOTECH\b/i, 'Promotech'], [/\bBOSCH\b/i, 'Bosch'], [/\bELCOMETER\b/i, 'Elcometer']];
const brandOfName = (n) => NAME_BRANDS.find(([re]) => re.test(n))?.[1] ?? null;
const STORES_CODE = /^(CN|SP|TL|FS)-/;

const tidy = (s) => String(s ?? '').replace(/\s+/g, ' ').replace(/\s+([,.;)])/g, '$1').replace(/\(\s+/g, '(').trim();
const key = (s) => tidy(s).toUpperCase().replace(/['’`]S\b/g, 'S').replace(/(\d)\s*(MM|MTRS?|MTR|AMPS?|AMP|KG|SQM|TONS?|INCH|LB)\b/g, '$1$2').replace(/[^A-Z0-9]+/g, ' ').trim()
  .split(' ').map((w) => (w.length > 3 && /[A-Z]S$/.test(w) && !/SS$/.test(w) ? w.slice(0, -1) : w)).join(' ');

const L = JSON.parse(fs.readFileSync(path.join(TM, 'stores_import', 'ledger.json'), 'utf8'));
// an item the ledger names under two groups (a regulator under GASES and PAINTING) takes the one it is named under most, then the first
const groupOf = new Map();
{ const tally = new Map(); for (const x of L.ledger) { const k = key(x.name); if (!tally.has(k)) tally.set(k, []); tally.get(k).push(Number(x.code)); }
  for (const [k, codes] of tally) { const n = {}; for (const c of codes) n[c] = (n[c] ?? 0) + 1; groupOf.set(k, Number(Object.entries(n).sort((a, b) => b[1] - a[1] || codes.indexOf(Number(a[0])) - codes.indexOf(Number(b[0])))[0][0])); } }

async function unit(fn) {
  const db = await pool.getConnection();
  try { await db.beginTransaction(); attachNodeCache(db); const out = await fn(db); if (APPLY) await db.commit(); else await db.rollback(); return out; }
  catch (e) { try { await db.rollback(); } catch { /* */ } throw e; } finally { detachNodeCache(db); db.release(); }
}
const node = async (db, where, params) => (await db.query(`SELECT id, code, name, parent_id FROM cf_classification_nodes WHERE company_id = ? AND deleted_at IS NULL AND ${where} LIMIT 1`, [COMPANY, ...params]))[0][0] ?? null;

try {
  const where = process.env.DB_HOST && !/^(localhost|127\.0\.0\.1)$/.test(process.env.DB_HOST) ? 'PRODUCTION DB' : 'local';
  const [[user]] = await pool.query("SELECT id FROM users WHERE company_id = ? ORDER BY (email LIKE 'admin@%') DESC, id LIMIT 1", [COMPANY]);
  const c = { companyId: COMPANY, userId: user?.id ?? null };
  console.log(`${where} — company ${COMPANY} — ${APPLY ? 'APPLY' : 'DRY RUN (one chunk rolled back)'} — step ${STEP}`);
  const [items] = await pool.query(
    `SELECT m.id, m.code, m.name, m.classification_id, v.name AS variant, s.id AS sub_id, s.name AS sub, i.tracked_by
       FROM cf_master_records m JOIN cf_item_details i ON i.master_id = m.id
       JOIN cf_classification_nodes v ON v.id = m.classification_id LEFT JOIN cf_classification_nodes s ON s.id = v.parent_id
      WHERE m.company_id = ? AND m.deleted_at IS NULL AND m.record_kind = 'item' AND i.item_type = 'catalog'`, [COMPANY]);
  const stores = items.filter((m) => STORES_CODE.test(m.code ?? ''));
  console.log(`stores items: ${stores.length}`);
  if (arg('before') && APPLY) {
    fs.writeFileSync(arg('before'), JSON.stringify(stores.map((m) => ({ id: m.id, code: m.code, classificationId: m.classification_id, sub: m.sub, trackedBy: m.tracked_by })), null, 1));
    console.log(`before-values: ${arg('before')}`);
  }

  // ---- 1. regroup + recode
  if (STEP === 'regroup' || STEP === 'all') {
    const moves = [];
    for (const m of stores) {
      const g = groupOf.get(key(m.name)); if (!g) continue;
      const t = TARGET[g]; if (!t) continue;
      if (m.sub === t.sub && String(m.code).startsWith(`${t.prefix}-`)) continue;
      moves.push({ m, g, t });
    }
    const by = {}; for (const x of moves) { const k = `${x.m.sub} → ${x.t.sub}`; by[k] = (by[k] ?? 0) + 1; }
    console.log(`\nregroup: ${moves.length} items move (ledger group decides):`); for (const [k, n] of Object.entries(by).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${k}`);
    const paints = moves.filter((x) => x.g === 600).slice(0, 8).map((x) => `${x.m.code} ${x.m.name}`); console.log(`  e.g. into Painting: ${paints.join(' | ')}`);
    const chunks = []; for (let i = 0; i < moves.length; i += 25) chunks.push(moves.slice(i, i + 25));
    let done = 0;
    for (const part of APPLY ? chunks : chunks.slice(0, 1)) {
      const out = await unit(async (db) => {
        const res = [];
        for (const { m, t } of part) {
          const family = await node(db, 'depth = 0 AND code = ?', [t.family]); if (!family) throw new Error(`Family ${t.family} is not in company ${COMPANY}.`);
          let sub = await node(db, 'parent_id = ? AND name = ?', [family.id, t.sub]);
          if (!sub) sub = await createCatalogNode(db, c, { parentId: family.id, code: t.subCode ?? `STORES_${t.prefix.replace(/-/g, '_')}`, name: t.sub, createdIn: 'items' });
          const vName = t.variant ?? 'General';
          let variant = await node(db, 'parent_id = ? AND name = ?', [sub.id, vName]);
          if (!variant) variant = await createCatalogNode(db, c, { parentId: sub.id, code: t.variantCode ?? `STORES_${t.prefix.replace(/-/g, '_')}_V`, name: vName, createdIn: 'items' });
          if (Number(m.classification_id) !== Number(variant.id)) await updateRecord(db, c, m.id, { classificationId: variant.id });
          let code = m.code;
          if (!String(m.code).startsWith(`${t.prefix}-`)) {
            const [[top]] = await db.query('SELECT MAX(CAST(SUBSTRING(code, ?) AS UNSIGNED)) AS n FROM cf_master_records WHERE company_id = ? AND code LIKE ?', [t.prefix.length + 2, COMPANY, `${t.prefix}-%`]);
            code = `${t.prefix}-${String((Number(top?.n) || 0) + 1).padStart(4, '0')}`;
            // An active item's code is fixed in the app (documents may carry it); on this company nothing but the ledger load
            // refers to these items, and that by id: changed here, from the backend, on the user's choice (2026-11-22).
            await db.query('UPDATE cf_master_records SET code = ? WHERE company_id = ? AND id = ?', [code, COMPANY, m.id]);
          }
          res.push(`${m.code} → ${code}  ${m.name}  (${m.sub} → ${t.sub})`);
        }
        return res;
      });
      done += out.length;
      if (!APPLY) out.slice(0, 6).forEach((x) => console.log(`   ${x}`));
      else console.log(`  ${done} / ${moves.length}`);
    }
  }

  // ---- 2. brands from the names
  if (STEP === 'brands' || STEP === 'all') {
    const names = [...new Set(stores.map((m) => brandOfName(m.name)).filter(Boolean))];
    const out = await unit(async (db) => { await ensureUnbranded(db, COMPANY, c.userId); const r = []; for (const n of names) r.push((await addBrand(db, c, { name: n, confirm: true })).brand.name); return r; });
    console.log(`\nbrands: Unbranded + ${out.join(', ')}${APPLY ? '' : ' (dry run)'}`);
  }

  // ---- 3. kept by lot, loose stock into opening lots
  if (STEP === 'lots' || STEP === 'all') {
    const [fresh] = await pool.query(
      `SELECT m.id, m.code, m.name, i.tracked_by FROM cf_master_records m JOIN cf_item_details i ON i.master_id = m.id
        WHERE m.company_id = ? AND m.deleted_at IS NULL AND m.record_kind = 'item' AND i.item_type = 'catalog' AND i.tracked_by = 'quantity'`, [COMPANY]);
    const todo = fresh.filter((m) => STORES_CODE.test(m.code ?? ''));
    const [brands] = await pool.query('SELECT id, name FROM cf_brands WHERE company_id = ? AND deleted_at IS NULL', [COMPANY]).catch(() => [[]]);
    const brandId = (n) => brands.find((b) => b.name.toLowerCase() === String(brandOfName(n) ?? '').toLowerCase())?.id ?? null;
    console.log(`\nlots: ${todo.length} stores items still counted by quantity; ${todo.filter((m) => brandOfName(m.name)).length} carry a brand in their name`);
    const chunks = []; for (let i = 0; i < todo.length; i += 25) chunks.push(todo.slice(i, i + 25));
    let lots = 0; let n = 0;
    for (const part of APPLY ? chunks : chunks.slice(0, 1)) {
      const r = await unit((db) => keepByLot(db, c, part.map((m) => ({ itemId: m.id, brandId: brandId(m.name) })), { reason: 'Stores items kept by lot from 2026-11-22: loose stock becomes an opening lot' }));
      lots += r.items.reduce((t, x) => t + x.lots.length, 0); n += part.length;
      console.log(`  ${n} / ${todo.length} items, ${lots} opening lots${r.movement ? ` (${r.movement.code})` : ''}`);
    }
  }
  if (!APPLY) console.log('\nDry run: nothing written.');
} finally { await pool.end(); }
