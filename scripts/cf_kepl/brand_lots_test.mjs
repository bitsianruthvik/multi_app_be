/**
 * brand_lots_test.mjs — brands on lots (init.sql §117; services/brandService.js, stockService.keepByLot, the GRN rule).
 *
 *   cd multi_app_be && node scripts/cf_kepl/brand_lots_test.mjs        CF_COMPANY=2 (the default)
 *
 * One transaction on an existing catalog item of the company, ROLLED BACK at the end: nothing is kept.
 *   1. the brand list: Unbranded first; a name in another spelling is the same brand; a close one is asked about
 *   2. keep by lot: loose stock becomes one opening lot — same quantity and value, the average leaves, tracking is 'batch'
 *   3. a receipt from a supplier into a new lot must name its brand; the lot keeps brand and vendor
 *   4. give out takes the oldest lot first; the desk's item panel shows each lot's brand and vendor
 *   5. merge moves the lots; the setting off lets a receipt leave the brand empty
 */
import path from 'path';
import { pathToFileURL } from 'url';

const BE = process.cwd();
const imp = (p) => import(pathToFileURL(path.join(BE, p)).href);
const { pool } = await imp('db.js');
await imp('apps/cf_erp/services/codegenProvider.js');
const B = await imp('apps/cf_erp/services/brandService.js');
const S = await imp('apps/cf_erp/services/stockService.js');
const D = await imp('apps/cf_erp/services/storesDeskService.js');
const St = await imp('apps/cf_erp/services/settingsService.js');
const { getBatch } = await imp('apps/cf_erp/services/batchService.js');
const { attachNodeCache, detachNodeCache } = await imp('apps/cf_erp/lib/nodeCache.js');

const COMPANY = Number(process.env.CF_COMPANY ?? 2);
let pass = 0; let fail = 0;
const ok = (name, cond, detail = '') => { if (cond) { pass += 1; console.log(`  PASS ${name}`); } else { fail += 1; console.log(`  FAIL ${name} ${detail}`); } };
const refusal = (p) => p.then(() => null, (e) => e);
const said = (e) => JSON.stringify([e?.code, e?.message, e?.problems]);
const counts = async () => Object.fromEntries(await Promise.all(['cf_brands', 'cf_stock_batches', 'cf_stock_movements', 'cf_stock_ledger'].map(async (t) => [t, (await pool.query(`SELECT COUNT(*) n FROM ${t}`))[0][0].n])));

const before = await counts();
const db = await pool.getConnection();
try {
  await db.beginTransaction(); attachNodeCache(db);
  const [[user]] = await db.query('SELECT id FROM users WHERE company_id = ? ORDER BY id LIMIT 1', [COMPANY]);
  const c = { companyId: COMPANY, userId: user?.id ?? null };
  await St.saveSettings(db, c, { values: { giveout_loose: true, giveout_departments: true, grn_brand_required: true } }); St.clearSettingsCache();
  const [[item]] = await db.query(
    `SELECT m.id, m.code, m.name FROM cf_master_records m JOIN cf_item_details i ON i.master_id = m.id
      WHERE m.company_id = ? AND m.deleted_at IS NULL AND m.status = 'active' AND i.item_type = 'catalog' AND i.tracked_by = 'quantity'
        AND i.issue_conditions IS NULL AND NOT EXISTS (SELECT 1 FROM cf_stock_balances k WHERE k.item_id = m.id AND k.quantity <> 0)
      ORDER BY m.id DESC LIMIT 1`, [COMPANY]);
  const [[area]] = await db.query("SELECT id, name FROM cf_stocking_areas WHERE company_id = ? AND purpose = 'storage' AND status = 'active' AND deleted_at IS NULL ORDER BY id LIMIT 1", [COMPANY]);
  const [[party]] = await db.query('SELECT id, name FROM cf_parties WHERE company_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 1', [COMPANY]);
  if (!item || !area || !party) throw new Error('This company needs a catalog item counted by quantity with no stock, a storage area and a party.');
  await db.query('UPDATE cf_parties SET is_supplier = 1 WHERE id = ?', [party.id]);

  console.log('1. the brand list');
  const l0 = await B.listBrands(db, COMPANY);
  ok('Unbranded is on the list, first', l0[0]?.unbranded === true && l0[0].name === 'Unbranded', JSON.stringify(l0.slice(0, 2)));
  const tag = `T${Date.now() % 100000}`;
  const a = await B.addBrand(db, c, { name: `Berger Paints ${tag}` });
  ok('a new brand is added', a.created && a.brand.name === `Berger Paints ${tag}`);
  const a2 = await B.addBrand(db, c, { name: `  BERGER-paints.  ${tag.toLowerCase()} ` });
  ok('another spelling of it is the same brand (no second row)', !a2.created && a2.brand.id === a.brand.id, JSON.stringify(a2));
  const near = await refusal(B.addBrand(db, c, { name: `Bergar Paints ${tag}` }));
  ok('a close spelling is asked about (SIMILAR), naming the one on the list', near?.code === 'SIMILAR' && near.message.includes(`Berger Paints ${tag}`), said(near));
  const other = await B.addBrand(db, c, { name: `Bergar Paints ${tag}`, confirm: true });
  ok('…and added when the person says it is a different brand', other.created && other.brand.id !== a.brand.id);
  ok('"Unbranded" typed is the Unbranded row', (await B.addBrand(db, c, { name: 'un-branded' })).brand.unbranded === true);
  ok('a rename onto another brand\'s name is refused', (await refusal(B.renameBrand(db, c, other.brand.id, { name: `berger paints ${tag}` })))?.code === 'SAME');
  ok('Unbranded is not renamed', (await refusal(B.renameBrand(db, c, l0[0].id, { name: 'Local' })))?.code === 'FIXED');

  console.log(`2. keep by lot (${item.code})`);
  await S.postMovement(db, c, { movementType: 'receipt', movementDate: '2026-11-01', lines: [{ itemId: item.id, quantity: 100, toAreaId: area.id, unitCost: 10 }] }).catch(async () =>
    S.postMovement(db, c, { movementType: 'receipt', lines: [{ itemId: item.id, quantity: 100, toAreaId: area.id, unitCost: 10 }] }));
  await S.postMovement(db, c, { movementType: 'receipt', lines: [{ itemId: item.id, quantity: 50, toAreaId: area.id, unitCost: 13 }] });
  const [[val0]] = await db.query('SELECT ROUND(SUM(value), 2) v, SUM(quantity) q FROM cf_stock_ledger WHERE company_id = ? AND item_id = ?', [COMPANY, item.id]);
  const kept = await S.keepByLot(db, c, [{ itemId: item.id, brandId: a.brand.id }]);
  const lot = kept.items[0]?.lots[0];
  ok('one opening lot of the 150, in the same area', kept.items.length === 1 && kept.items[0].lots.length === 1 && lot.quantity === 150 && lot.areaId === area.id, JSON.stringify(kept.items));
  const [[after]] = await db.query('SELECT tracked_by FROM cf_item_details WHERE master_id = ?', [item.id]);
  ok('the item is kept by batch now', after.tracked_by === 'batch');
  const [[loose]] = await db.query('SELECT COALESCE(SUM(quantity), 0) q FROM cf_stock_balances WHERE item_id = ? AND batch_key = 0', [item.id]);
  ok('no loose stock is left', Number(loose.q) === 0);
  const b0 = await getBatch(db, COMPANY, lot.batchId);
  ok('the lot is at the average cost (11), with the brand given', b0.unitCost === 11 && b0.brand?.id === a.brand.id && b0.onHand === 150, JSON.stringify([b0.unitCost, b0.brand, b0.onHand]));
  const [[val1]] = await db.query('SELECT ROUND(SUM(value), 2) v, SUM(quantity) q FROM cf_stock_ledger WHERE company_id = ? AND item_id = ?', [COMPANY, item.id]);
  ok('quantity and value of stock unchanged (one adjustment, out and in)', Number(val1.q) === Number(val0.q) && Number(val1.v) === Number(val0.v), JSON.stringify([val0, val1]));
  const [[pool0]] = await db.query('SELECT costed_qty FROM cf_item_costs WHERE company_id = ? AND item_id = ? AND owner_key = 0', [COMPANY, item.id]);
  ok('the loose average holds nothing any more', !pool0 || Number(pool0.costed_qty) === 0, JSON.stringify(pool0));
  ok('the movement is an adjustment that says why', kept.movement?.movementType === 'adjustment' || kept.movement?.type === 'adjustment' || /ADJ/.test(kept.movement?.code ?? ''), JSON.stringify(kept.movement?.code));
  const again = await S.keepByLot(db, c, [{ itemId: item.id }]);
  ok('running it again changes nothing', again.movement === null && again.switched === 0);
  ok('the ledger checks out', (await S.checkLedger(db, COMPANY)).ok !== false);

  console.log('3. a receipt from a supplier');
  const noBrand = await refusal(S.postMovement(db, c, { movementType: 'receipt', partyId: party.id, lines: [{ itemId: item.id, quantity: 20, toAreaId: area.id, unitCost: 12, batch: {} }] }));
  ok('a new lot with no brand is refused, in words', /pick its brand/.test(said(noBrand)), said(noBrand));
  const rc = await S.postMovement(db, c, { movementType: 'receipt', partyId: party.id, lines: [{ itemId: item.id, quantity: 20, toAreaId: area.id, unitCost: 12, batch: { brandId: other.brand.id } }] });
  const [[nb]] = await db.query('SELECT id, brand_id, supplier_id FROM cf_stock_batches WHERE company_id = ? AND item_id = ? ORDER BY id DESC LIMIT 1', [COMPANY, item.id]);
  ok('the lot carries its brand and its vendor (the supplier)', Number(nb.brand_id) === other.brand.id && Number(nb.supplier_id) === party.id && !!rc.id, JSON.stringify(nb));
  const badBrand = await refusal(S.postMovement(db, c, { movementType: 'receipt', partyId: party.id, lines: [{ itemId: item.id, quantity: 1, toAreaId: area.id, batch: { brandId: 999999999 } }] }));
  ok('a brand not on the list is refused', /not on the brand list/.test(said(badBrand)), said(badBrand));

  console.log('4. give out and the item panel');
  const g = await D.giveOut(db, c, { givenFor: { type: 'department', departmentId: (await D.addDepartment(db, c, { name: `Brand test ${tag}` })).id }, lines: [{ itemId: item.id, quantity: 160 }] })
    .catch(async (e) => { if (e?.code === 'USE_A_REQUEST' || /department/i.test(said(e))) { await St.saveSettings(db, c, { values: { giveout_departments: true } }); St.clearSettingsCache(); return D.giveOut(db, c, { givenFor: { type: 'department', departmentId: (await D.addDepartment(db, c, { name: `Brand test2 ${tag}` })).id }, lines: [{ itemId: item.id, quantity: 160 }] }); } throw e; });
  const [legs] = await db.query('SELECT batch_id, quantity FROM cf_stock_ledger WHERE movement_id = ? ORDER BY id', [g.movement.id]);
  ok('160 given out: all 150 of the opening lot, then 10 of the new one', legs.length === 2 && Number(legs[0].batch_id) === lot.batchId && Number(legs[0].quantity) === -150 && Number(legs[1].batch_id) === Number(nb.id) && Number(legs[1].quantity) === -10, JSON.stringify(legs));
  const panel = await D.itemLedger(db, COMPANY, item.id, {});
  const pl = panel.lots.find((x) => x.id === Number(nb.id));
  ok('the item panel lists the lot left, with its brand and vendor', panel.lots.length === 1 && pl?.quantity === 10 && pl.brand?.id === other.brand.id && pl.vendor?.id === party.id, JSON.stringify(panel.lots));

  console.log('5. merge, and the setting');
  const m = await B.mergeBrand(db, c, other.brand.id, { intoId: a.brand.id });
  const [[mb]] = await db.query('SELECT brand_id FROM cf_stock_batches WHERE id = ?', [nb.id]);
  ok('merging moves its lots to the other brand and it leaves the list', m.lotsMoved >= 1 && Number(mb.brand_id) === a.brand.id && !(await B.listBrands(db, COMPANY)).some((x) => x.id === other.brand.id));
  const used = (await B.listBrands(db, COMPANY, { withUse: true })).find((x) => x.id === a.brand.id);
  ok('the list counts the brand\'s items and lots', used?.items === 1 && used.lots === 2 && used.lotsInStock === 1, JSON.stringify(used));
  await St.saveSettings(db, c, { values: { grn_brand_required: false } }); St.clearSettingsCache();
  const free = await refusal(S.postMovement(db, c, { movementType: 'receipt', partyId: party.id, lines: [{ itemId: item.id, quantity: 5, toAreaId: area.id, unitCost: 12, batch: {} }] }));
  ok('with "A GRN line must name the brand" off, the brand may be left empty', free === null, said(free));
} catch (e) {
  fail += 1; console.log('  FAIL (threw)', e?.message, JSON.stringify(e?.problems ?? ''), e?.stack?.split('\n').slice(1, 3).join(' '));
} finally {
  try { await db.rollback(); } catch { /* */ }
  detachNodeCache(db); db.release();
  St.clearSettingsCache?.();
  const after = await counts();
  ok('rolled back: every table count as before', JSON.stringify(after) === JSON.stringify(before), JSON.stringify([before, after]));
  console.log(`\n${pass} passed, ${fail} failed`);
  await pool.end();
  process.exit(fail ? 1 : 0);
}
