/**
 * stock_entry_test.mjs — the stock entry week (services/stockEntryService.js) and the Stores dashboard
 * (services/storesDashboardService.js), 2026-11-23.
 *
 *   cd multi_app_be && node scripts/cf_kepl/stock_entry_test.mjs        CF_COMPANY=2 (the default)
 *
 * One transaction, ROLLED BACK at the end: nothing is kept.
 *   1. closed (no date / a past date) → ENTRY_CLOSED; open → the list reads, every item with its lots
 *   2. an item counted by quantity with stock: saved as two lots (the loose row + a new branded lot) → kept by lot, one ADJ,
 *      the book is what was typed, an audit of kind 'entry' is kept, the list says "entered", todo=1 leaves it out
 *   3. an existing lot set lower and its brand / vendor / lot no. corrected; a lot of another item refused
 *   4. the dashboard answers: tiles, actions (the entry week first), the month's audit, PRs, MRs, things out
 */
import path from 'path';
import { pathToFileURL } from 'url';

const BE = process.cwd();
const imp = (p) => import(pathToFileURL(path.join(BE, p)).href);
const { pool } = await imp('db.js');
await imp('apps/cf_erp/services/codegenProvider.js');
const E = await imp('apps/cf_erp/services/stockEntryService.js');
const Dash = await imp('apps/cf_erp/services/storesDashboardService.js');
const St = await imp('apps/cf_erp/services/settingsService.js');
const B = await imp('apps/cf_erp/services/brandService.js');
const { attachNodeCache, detachNodeCache } = await imp('apps/cf_erp/lib/nodeCache.js');

const COMPANY = Number(process.env.CF_COMPANY ?? 2);
let pass = 0; let fail = 0;
const ok = (name, cond, detail = '') => { if (cond) { pass += 1; console.log(`  PASS ${name}`); } else { fail += 1; console.log(`  FAIL ${name} ${detail}`); } };
const refusal = (p) => p.then(() => null, (e) => e);
const said = (e) => JSON.stringify([e?.code, e?.message, e?.problems]);
const pad = (n) => String(n).padStart(2, '0');
const day = (k) => { const d = new Date(Date.now() + k * 86400000); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

const db = await pool.getConnection();
try {
  await db.beginTransaction(); attachNodeCache(db);
  const [[user]] = await db.query('SELECT id FROM users WHERE company_id = ? ORDER BY id LIMIT 1', [COMPANY]);
  const c = { companyId: COMPANY, userId: user?.id ?? null };
  const [[area]] = await db.query("SELECT id FROM cf_stocking_areas WHERE company_id = ? AND deleted_at IS NULL AND status = 'active' AND purpose = 'storage' ORDER BY id LIMIT 1", [COMPANY]);

  // 1. the window
  await St.saveSettings(db, c, { values: { stock_entry_until: null } }); St.clearSettingsCache();
  let e = await refusal(E.saveEntry(db, c, { areaId: area.id, itemId: 1, lots: [{ quantity: 1 }] }));
  ok('no date: closed', e?.code === 'ENTRY_CLOSED', said(e));
  await St.saveSettings(db, c, { values: { stock_entry_until: day(-1) } }); St.clearSettingsCache();
  e = await refusal(E.saveEntry(db, c, { areaId: area.id, itemId: 1, lots: [{ quantity: 1 }] }));
  ok('yesterday: closed', e?.code === 'ENTRY_CLOSED', said(e));
  await St.saveSettings(db, c, { values: { stock_entry_until: day(7) } }); St.clearSettingsCache();
  ok('a week ahead: open', (await E.entryWindow(db, COMPANY)).open === true);
  const list = await E.entryList(db, COMPANY, { areaId: area.id, limit: 20 });
  ok('the list reads every item, each with its lots', list.rows.length > 0 && list.rows.every((r) => Array.isArray(r.lots) && typeof r.book === 'number') && list.counts.window.open, JSON.stringify(list.counts?.window));

  // 2. an item counted by quantity, with loose stock in the area
  const [[q]] = await db.query(
    `SELECT m.id, m.code, k.quantity FROM cf_master_records m JOIN cf_item_details i ON i.master_id = m.id
       JOIN cf_stock_balances k ON k.item_id = m.id AND k.company_id = m.company_id AND k.stocking_area_id = ? AND k.batch_key = 0 AND k.quantity > 0
      WHERE m.company_id = ? AND m.deleted_at IS NULL AND i.item_type = 'catalog' AND i.tracked_by = 'quantity'
        AND NOT EXISTS (SELECT 1 FROM cf_stock_reservations r WHERE r.item_id = m.id AND r.status = 'active' AND r.deleted_at IS NULL AND r.batch_id IS NULL)
      ORDER BY m.id LIMIT 1`, [area.id, COMPANY]);
  if (!q) ok('a quantity item with stock exists to try', false);
  else {
    const brands = await B.listBrands(db, COMPANY);
    const brand = (brands.rows ?? brands).find((b) => !b.unbranded) ?? (await B.addBrand(db, c, { name: 'EntryTest Brand' }));
    const [[vendor]] = await db.query('SELECT id FROM cf_parties WHERE company_id = ? AND deleted_at IS NULL AND is_supplier = 1 ORDER BY id LIMIT 1', [COMPANY]);
    const was = Number(q.quantity);
    const r = await E.saveEntry(db, c, { areaId: area.id, itemId: q.id, lots: [
      { loose: true, quantity: was + 1 },
      { quantity: 4, brandId: brand.id, vendorId: vendor?.id ?? null, supplierRef: 'HEAT-77', receivedOn: day(-3) },
    ] });
    ok('saved: the book is what was typed (loose row + new lot)', Math.abs(r.book - (was + 5)) < 1e-6, JSON.stringify([r.book, was + 5]));
    ok('two lots, the new one with its brand, vendor and lot no.', r.lots.length === 2 && r.lots.some((l) => l.brand?.id === brand.id && l.supplierRef === 'HEAT-77' && (!vendor || l.vendor?.id === vendor.id) && l.receivedOn === day(-3)), JSON.stringify(r.lots));
    const [[t]] = await db.query('SELECT tracked_by FROM cf_item_details WHERE master_id = ?', [q.id]);
    ok('the item is kept by lot now', t.tracked_by === 'batch');
    const [[cnt]] = await db.query("SELECT kind, status, lines_n, diff_n, movement_id FROM cf_stock_counts WHERE company_id = ? AND kind = 'entry' ORDER BY id DESC LIMIT 1", [COMPANY]);
    ok('kept as an audit of kind entry, posted, with its ADJ', cnt?.status === 'posted' && cnt.lines_n === 2 && cnt.diff_n === 2 && cnt.movement_id === r.movementId, JSON.stringify(cnt));
    const [[mv]] = await db.query('SELECT movement_type, reason FROM cf_stock_movements WHERE id = ?', [r.movementId]);
    ok('one adjustment, reason "Stock entry"', mv.movement_type === 'adjustment' && /^Stock entry/.test(mv.reason), JSON.stringify(mv));
    const again = await E.entryList(db, COMPANY, { areaId: area.id, search: q.code });
    ok('the list says entered', again.rows.find((x) => x.item.id === q.id)?.entered === true);
    const todo = await E.entryList(db, COMPANY, { areaId: area.id, search: q.code, todo: 1 });
    ok('todo=1 leaves it out', !todo.rows.some((x) => x.item.id === q.id));

    // 3. an existing lot lower, its details corrected
    const lot = r.lots.find((l) => l.brand?.id === brand.id);
    const other = r.lots.find((l) => l !== lot);
    const r2 = await E.saveEntry(db, c, { areaId: area.id, itemId: q.id, lots: [{ lotId: lot.lotId, quantity: 1, supplierRef: 'HEAT-78' }] });
    const l2 = r2.lots.find((l) => l.lotId === lot.lotId);
    ok('a lot set lower; the other lot left as it is', l2?.quantity === 1 && l2.supplierRef === 'HEAT-78' && r2.lots.find((l) => l.lotId === other.lotId)?.quantity === other.quantity, JSON.stringify(r2.lots));
    const [[foreign]] = await db.query('SELECT id FROM cf_stock_batches WHERE company_id = ? AND item_id <> ? AND deleted_at IS NULL LIMIT 1', [COMPANY, q.id]);
    if (foreign) {
      e = await refusal(E.saveEntry(db, c, { areaId: area.id, itemId: q.id, lots: [{ lotId: foreign.id, quantity: 1 }] }));
      ok("another item's lot is refused", e && /not of/.test(said(e)), said(e));
    }
    e = await refusal(E.saveEntry(db, c, { areaId: area.id, itemId: q.id, lots: [{ lotId: lot.lotId, quantity: -2 }] }));
    ok('a negative quantity is refused', e && /zero or more/.test(said(e)), said(e));
  }

  // 4. the dashboard
  const d = await Dash.dashboard(db, COMPANY);
  ok('dashboard: tiles', d.tiles && ['mrsOpen', 'prsToOrder', 'posLate', 'outWith', 'machinesOut', 'auditLeft', 'belowMin'].every((k) => typeof d.tiles[k] === 'number'), JSON.stringify(d.tiles));
  ok('dashboard: the entry week is an action', d.actions.some((a) => a.key === 'entry' && a.link === 'stock-entry'));
  ok('dashboard: actions worst first', d.actions.every((a, i) => i === 0 || ({ danger: 0, warning: 1, info: 2 })[d.actions[i - 1].tone] <= ({ danger: 0, warning: 1, info: 2 })[a.tone]));
  ok("dashboard: the month's audit", typeof d.audit.left === 'number' && typeof d.audit.daysLeft === 'number' && d.audit.monthEnd?.length === 10, JSON.stringify(d.audit));
  ok('dashboard: PRs, MRs and things out', Array.isArray(d.prs.rows) && Array.isArray(d.mrs.rows) && Array.isArray(d.out.machines) && typeof d.out.counts.all === 'number');
} catch (err) { fail += 1; console.log('  FAIL (threw)', err?.code, err?.message, err?.problems ?? '', err?.stack?.split('\n').slice(1, 4).join(' | ')); } finally {
  detachNodeCache(db); await db.rollback(); db.release(); St.clearSettingsCache();
  console.log(`\n${pass} passed, ${fail} failed`);
  await pool.end(); process.exit(fail ? 1 : 0);
}
