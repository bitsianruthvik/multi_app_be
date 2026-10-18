/**
 * scrap_offcut_charge_test.mjs — SCRAP & OFFCUTS, PLATE RATES, GST ON ITEMS (2026-10-18; contract
 * TM/CF_ERP_ORDER_FLOW_PLAN.md "2026-10-18 — One order value; scrap & offcuts; GST gaps"). User: scrap and offcut
 * costs may be claimed from the customer; costing must never value things at ₹0 silently; items with no HSN/GST rate.
 *
 *   cd multi_app_be && node scripts/cf_kepl/scrap_offcut_charge_test.mjs        CF_SCRAP_COMPANY (2)
 *
 * ONE TRANSACTION, ROLLED BACK; every cf_ table is re-counted at the end. Everything is this run's own (TEST-SOCH-<run>).
 *
 *   1  the charge kind: basis scrap kg / offcut kg / % of material read and checked
 *   2  the waste of the order's saved nesting, split scrap vs offcut (waste_json; a plate without the split counts its
 *      offcuts only)
 *   3  the acceptance estimate: scrap kg × rate, offcut kg × rate, % of the material; no nesting → no quantity, said so
 *   4  sent and approved: in the approval card's terms and estimate
 *   5  order costing: actual scrap kg (scrap area) and offcut kg (offcut lots) against the charge; earned on completion;
 *      "not costed — set the scrap rate" until there is one; a stock row with no cost → "set the plate rate" (item link)
 *   6  the MR material at the list price when nothing was bought yet; neither → named as not costed
 *   7  HSN / GST by family: the gaps, a suggestion (shown only), dry run, fill the gaps, nothing left, overwrite, a rate
 *      not on the list refused; the PO says how many lines have no GST rate
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const BE = process.cwd();
const imp = (p) => import(pathToFileURL(path.join(BE, p)).href);
const { pool } = await imp('db.js');
if (!/^(localhost|127\.0\.0\.1|::1)$/.test(process.env.DB_HOST ?? 'localhost')) throw new Error('This suite is local only.');
await imp('apps/cf_erp/services/codegenProvider.js');
const { attachNodeCache, detachNodeCache } = await imp('apps/cf_erp/lib/db.js');
const ACC = await imp('apps/cf_erp/services/acceptanceService.js');
const AP = await imp('apps/cf_erp/services/approvalService.js');
const COST = await imp('apps/cf_erp/services/costingService.js');
const RQ = await imp('apps/cf_erp/services/requisitionService.js');
const PROC = await imp('apps/cf_erp/services/processService.js');
const OPS = await imp('apps/cf_erp/services/operationService.js');
const SCRAP = await imp('apps/cf_erp/services/scrapService.js');
const TAX = await imp('apps/cf_erp/services/taxService.js');
const TF = await imp('apps/cf_erp/services/taxFamilyService.js');
const CLS = await imp('apps/cf_erp/services/classificationService.js');
const MR = await imp('apps/cf_erp/services/masterRecordService.js');
const { writeTransform } = await imp('apps/cf_erp/services/productionLedgerService.js');
const { postMovement } = await imp('apps/cf_erp/services/stockService.js');
const { harness, girder, quietCodes } = await imp('scripts/cf_kepl/lib/buyingFixture.mjs');

const COMPANY = Number(process.env.CF_SCRAP_COMPANY ?? 2);
const RUN = Date.now().toString(36).toUpperCase().slice(-5);
const tag = `TEST-SOCH-${RUN}`;
const H = harness(pool);
const { ok, section, refusal, j } = H;
const near = (a, b, tol = 0.011) => a != null && Math.abs(Number(a) - Number(b)) <= tol;
const before = await H.counts();
const db = await pool.getConnection();
const all = () => true;
const kg = (areaMm2, t = 10, d = 7850) => (areaMm2 * t * d) / 1e9;

try {
  /* ════════════════════ 1. the charge kind ════════════════════ */
  section('1. The charge kind "Scrap & offcuts"');
  const ctx = { opById: new Map([[1, { id: 1, name: 'Cutting' }]]), specByCode: new Map(), anyWeBuy: true, anyCustomer: false, stageKeys: new Set() };
  const row = (basis, rate = 20) => ({ charges: [{ key: 'sc', label: 'Scrap & offcuts', operationId: 1, basis, rate, billing: 'pro_rata' }], milestones: [{ key: 'm1', label: 'All', kind: 'percent', value: 100, trigger: { type: 'order_accepted' } }] });
  let r = ACC.readTerms(row({ type: 'scrap', of: 'scrap' }), ctx);
  ok('scrap kg × rate is a basis', r.problems.length === 0 && r.terms.charges[0].basis.type === 'scrap' && r.terms.charges[0].basis.of === 'scrap', j(r.problems));
  ok('offcut kg and % of material too', ACC.readTerms(row({ type: 'scrap', of: 'offcut' }), ctx).problems.length === 0 && ACC.readTerms(row({ type: 'scrap', of: 'material_pct' }, 5), ctx).problems.length === 0);
  r = ACC.readTerms(row({ type: 'scrap', of: 'gold' }), ctx);
  ok('an unknown scrap basis is refused, in words', r.problems.some((p) => /scrap kg, offcut kg or a % of the material/.test(p)), j(r.problems));
  r = ACC.readTerms(row({ type: 'scrap', of: 'material_pct' }, 120), ctx);
  ok('a % of the material is at most 100', r.problems.some((p) => /at most 100/.test(p)));
  ok('the grids get the bases', !!ACC.termLists({ operations: [], fields: [] }).scrapBases?.material_pct);

  await db.beginTransaction();
  attachNodeCache(db);
  const [users] = await db.query('SELECT id FROM users WHERE company_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 2', [COMPANY]);
  if (users.length < 2) throw new Error('The suite needs two users in the company.');
  const c = { companyId: COMPANY, userId: users[0].id };
  const md = { companyId: COMPANY, userId: users[1].id };
  const asMd = { can: all, isAdmin: false };
  await quietCodes(db, COMPANY, ['purchase_order', 'sales_order', 'stock_movement', 'tax_invoice']);
  const ins = async (sql, params) => (await db.query(sql, params))[0].insertId;

  // ── fixture: a girder order (2 × 2 000 kg), we buy; a cutting operation; the acceptance process ──
  const G = await girder(db, c, tag);
  const cut = await OPS.createOperation(db, c, { code: `${tag}-CUT`, name: `Cutting ${tag}` });
  const fab = await OPS.createOperation(db, c, { code: `${tag}-FAB`, name: `Fabrication ${tag}` });
  const [[weightSpec]] = await db.query("SELECT id FROM cf_specifications WHERE company_id = ? AND code = 'WEIGHT' AND deleted_at IS NULL", [COMPANY]);
  const prc = await PROC.createProcess(db, c, { code: `${tag}-PRC`, name: `Scrap charge test ${tag}` });
  await PROC.replaceStages(db, c, prc.id, { stages: ['structure', 'lock', 'nesting', 'buying', 'acceptance', 'production'].map((stageKey) => ({ stageKey })) });
  await PROC.setProcessStatus(db, c, prc.id, 'active');
  const o = await G.girderOrder('A', 2, { status: 'inquiry', lock: true });
  await db.query('UPDATE cf_sales_orders SET process_id = ? WHERE id = ?', [prc.id, o.id]);
  const [[line]] = await db.query('SELECT item_id FROM cf_sales_order_lines WHERE id = ?', [o.lineId]);
  await db.query(`INSERT INTO cf_spec_values (company_id, specification_id, subject_type, subject_id, value_number, uom, source) VALUES (?, ?, 'master', ?, 2000, 'kg', 'entered')
                  ON DUPLICATE KEY UPDATE value_number = 2000, uom = 'kg'`, [COMPANY, weightSpec.id, line.item_id]);

  /* ════════════════════ 2. the nesting's waste ════════════════════ */
  section('2. The waste of the saved nesting — scrap vs offcut');
  let w = await ACC.nestWasteOf(db, COMPANY, [o.lineId]);
  ok('no nesting saved: nothing', w.plates === 0 && w.scrapKg === 0 && w.offcutKg === 0);
  const waste = { rim: 100000, sequenceGaps: 50000, wastage: 350000, offcut: 400000, kerf: 60000, partsArea: 3540000, plateArea: 4500000 };
  const lot1 = await ins(`INSERT INTO cf_plate_lots (company_id, order_line_id, plate_item_id, lot_no, thickness_mm, length_mm, width_mm, density, waste_json)
                          VALUES (?, ?, ?, ?, 10, 3000, 1500, 7850, ?)`, [COMPANY, o.lineId, G.A, `${tag}-N1`, JSON.stringify(waste)]);
  await ins("INSERT INTO cf_offcuts (company_id, order_line_id, plate_lot_id, offcut_no, thickness_mm, area_mm2, weight_kg) VALUES (?, ?, ?, ?, 10, 400000, ?)", [COMPANY, o.lineId, lot1, `${tag}-N1-A`, kg(400000)]);
  const lot2 = await ins(`INSERT INTO cf_plate_lots (company_id, order_line_id, plate_item_id, lot_no, thickness_mm, length_mm, width_mm, density)
                          VALUES (?, ?, ?, ?, 10, 2000, 1000, 7850)`, [COMPANY, o.lineId, G.A, `${tag}-N2`]);
  await ins("INSERT INTO cf_offcuts (company_id, order_line_id, plate_lot_id, offcut_no, thickness_mm, area_mm2, weight_kg) VALUES (?, ?, ?, ?, 10, 150000, 12.5)", [COMPANY, o.lineId, lot2, `${tag}-N2-A`]);
  w = await ACC.nestWasteOf(db, COMPANY, [o.lineId]);
  const SCRAP_KG = Math.round(kg(500000) * 1000) / 1000; // rim + gaps + wastage = 39.25
  const OFF_KG = Math.round((kg(400000) + 12.5) * 1000) / 1000; // 31.4 + 12.5
  ok(`scrap = rim + sequence gaps + wastage = ${SCRAP_KG} kg (the kerf is burnt, not scrap)`, near(w.scrapKg, SCRAP_KG, 0.002) && near(w.kerfKg, kg(60000), 0.002), j(w));
  ok(`offcut = the offcut area of the split plate + the offcuts of the plate saved before the split = ${OFF_KG} kg`, near(w.offcutKg, OFF_KG, 0.002) && w.unsplit === 1 && w.plates === 2, j(w));

  /* ════════════════════ 3. the estimate ════════════════════ */
  section('3. The acceptance estimate');
  await RQ.raiseRequisitions(db, c, o.id, { earmark: true });
  const base = {
    charges: [{ key: 'fab', label: 'Fabrication', operationId: fab.id, basis: { type: 'weight', weight: 'drawing' }, rate: 45000, billing: 'pro_rata' }],
    material: { rate: 70000, weight: 'drawing' }, lumpSums: [],
    milestones: [{ key: 'm1', label: 'Advance', kind: 'percent', value: 100, trigger: { type: 'order_accepted' }, creditDays: 0 }], stages: [],
  };
  const sc = (key, of, rate, billing = 'on_completion') => ({ key, label: `Scrap & offcuts ${of}`, operationId: cut.id, basis: { type: 'scrap', of }, rate, billing });
  const dry = await ACC.saveAcceptance(db, c, o.id, { ...base, charges: [...base.charges, sc('s1', 'scrap', 20), sc('s2', 'offcut', 30), sc('s3', 'material_pct', 5)], dryRun: true });
  const e = (k) => dry.estimate.charges.find((x) => x.key === k);
  ok('the dry run reads: no problems with the terms', dry.problems.length === 0, j(dry.problems));
  ok(`scrap: ${SCRAP_KG} kg × ₹20`, near(e('s1').quantity, SCRAP_KG, 0.002) && e('s1').unit === 'kg' && near(e('s1').amount, SCRAP_KG * 20, 0.05) && e('s1').basisKind === 'scrap' && /From the nesting: 2 plates/.test(e('s1').note), j(e('s1')));
  ok(`offcuts: ${OFF_KG} kg × ₹30`, near(e('s2').quantity, OFF_KG, 0.002) && near(e('s2').amount, OFF_KG * 30, 0.05) && /without a scrap split/.test(e('s2').note));
  ok('5 % of the material charged (4 t × ₹70,000 = ₹2,80,000) = ₹14,000', near(e('s3').quantity, 280000) && near(e('s3').amount, 14000) && e('s3').rateUnit === '%');
  ok('the order value includes them', near(dry.estimate.value, 180000 + 280000 + e('s1').amount + e('s2').amount + 14000, 0.05), j(dry.estimate.value));
  ok('the estimate carries the waste split', near(dry.estimate.waste?.scrapKg, SCRAP_KG, 0.002));
  const o2 = await G.girderOrder('B', 1, { status: 'inquiry', lock: true });
  const dry2 = await ACC.saveAcceptance(db, c, o2.id, { ...base, charges: [sc('s1', 'scrap', 20)], dryRun: true });
  ok('no nesting saved → no quantity, and it says where the kg come from', dry2.estimate.charges[0].quantity == null && /No nesting saved yet/.test(dry2.estimate.charges[0].note));

  /* ════════════════════ 4. sent and approved ════════════════════ */
  section('4. Sent and approved — on the approval card');
  const saved = await ACC.saveAcceptance(db, c, o.id, { ...base, charges: [...base.charges, sc('s1', 'scrap', 20)] });
  const [ap] = (await AP.listApprovals(db, COMPANY, all, { status: 'pending', type: 'order_acceptance', orderId: o.id })).rows ?? [];
  const actx = ap?.context;
  ok('the approval card has the scrap charge and its estimate', actx?.terms?.charges?.some((x) => x.basis?.type === 'scrap' && x.basis.of === 'scrap') && actx?.estimate?.charges?.some((x) => x.key === 's1' && near(x.quantity, SCRAP_KG, 0.002)), j(actx?.terms?.charges));
  await AP.decide(db, md, saved.pending.approvalId, { decision: 'approve' }, asMd);
  const acc = await ACC.getAcceptance(db, COMPANY, o.id);
  ok('approved: the order is confirmed', acc.order.status === 'confirmed' && acc.approved?.terms.charges.some((x) => x.basis?.type === 'scrap'));

  /* ════════════════════ 5. order costing ════════════════════ */
  section('5. Order costing — actual scrap and offcuts against the charge');
  await SCRAP.setScrapRate(db, c, { ratePerKg: '' });
  const scrapArea = await SCRAP.scrapArea(db, c);
  const scrapItem = await SCRAP.scrapItem(db, c);
  await writeTransform(db, c, { reference: `${tag}-SCRAP`, notes: 'Plate skeleton', orderId: o.id, orderLineId: o.lineId, legs: [{ areaId: scrapArea.id, itemId: scrapItem, batchId: null, delta: 50, unitCost: 0, value: 0 }] });
  const batch = await ins('INSERT INTO cf_stock_batches (company_id, item_id) VALUES (?, ?)', [COMPANY, G.A]);
  await ins("INSERT INTO cf_offcuts (company_id, order_line_id, plate_lot_id, offcut_no, thickness_mm, area_mm2, weight_kg, status, batch_id) VALUES (?, ?, ?, ?, 10, 1528662, 120, 'available', ?)", [COMPANY, o.lineId, lot1, `${tag}-N1-B`, batch]);
  let sheet = await COST.costSheet(db, COMPANY, o.id);
  let so = sheet.scrapOffcuts;
  ok('actual scrap: 50 kg into the scrap area', near(so.actual.scrapKg, 50), j(so.actual));
  ok('actual offcuts: the lots cut from its plates (120 kg, 1 lot; planned offcuts do not count)', near(so.actual.offcutKg, 120) && so.actual.offcutLots === 1, j(so.actual));
  const flag = so.flags.find((f) => f.code === 'NO_SCRAP_RATE');
  ok('no scrap rate → "Scrap 50 kg not costed — set the scrap rate", with the link to Setup › Cutting', flag && /50 kg not costed/.test(flag.message) && flag.fix?.to === 'cutting', j(so.flags));
  const ch = so.charges.find((x) => x.key === 's1');
  ok('the charge: estimate kg × ₹20 as contract, nothing earned before cutting is complete', ch && near(ch.contract, SCRAP_KG * 20, 0.05) && ch.earned === 0, j(ch));
  ok('…and what it would be on the actual 50 kg', near(ch.actualKg, 50) && near(ch.onActual, 1000));
  // Cutting done for the whole order → the on-completion charge is earned.
  const rel = await ins('INSERT INTO cf_production_releases (company_id, order_id, order_line_id, item_id, quantity) VALUES (?, ?, ?, ?, 2)', [COMPANY, o.id, o.lineId, line.item_id]);
  for (const n of [1, 2]) {
    const p = await ins('INSERT INTO cf_production_items (company_id, release_id, item_id, piece_no, quantity, code, flow_id, depth, sort_order) VALUES (?, ?, ?, ?, 1, ?, ?, 0, ?)', [COMPANY, rel, line.item_id, n, `${tag}-P${n}`, G.flow.id, n]);
    await ins("INSERT INTO cf_production_steps (company_id, production_item_id, operation_id, sequence, quantity, state, qty_good, started_at, finished_at) VALUES (?, ?, ?, 10, 1, 'done', 1, NOW(), NOW())", [COMPANY, p, cut.id]);
  }
  sheet = await COST.costSheet(db, COMPANY, o.id);
  so = sheet.scrapOffcuts;
  ok('cutting complete → the scrap charge is earned (on completion), and it is in Charged so far', near(so.charges[0].earned, SCRAP_KG * 20, 0.05) && sheet.earned.rows.some((x) => x.kind === 'scrap_charge' && near(x.amount, SCRAP_KG * 20, 0.05)), j(so.charges));
  await SCRAP.setScrapRate(db, c, { ratePerKg: 30 });
  sheet = await COST.costSheet(db, COMPANY, o.id);
  ok('a scrap rate set → the flag goes', !sheet.scrapOffcuts.flags.some((f) => f.code === 'NO_SCRAP_RATE') && sheet.scrapOffcuts.ratePerKg === 30);
  // A stock row with no cost: received without a price, issued to the order.
  await postMovement(db, c, { movementType: 'receipt', toAreaId: G.store, lines: [{ itemId: G.B, quantity: 5 }] });
  await postMovement(db, c, { movementType: 'issue', orderId: o.id, fromAreaId: G.store, lines: [{ itemId: G.B, quantity: 5 }] });
  sheet = await COST.costSheet(db, COMPANY, o.id);
  const nc = sheet.scrapOffcuts.flags.find((f) => f.code === 'NOT_COSTED');
  ok('a stock row with no cost → "not costed — set the plate rate", linked to the item', nc && /not costed — set the plate rate/.test(nc.message) && nc.fix?.to === `items/${G.B}`, j(sheet.scrapOffcuts.flags));
  const list = await COST.costingList(db, COMPANY, { search: tag });
  const lr = list.rows.find((x) => x.order.id === o.id);
  ok('the costing list: scrap kg, offcut kg, what the scrap charge earned, how many flags', lr && near(lr.scrapKg, 50) && near(lr.offcutKg, 120) && near(lr.scrapCharged, SCRAP_KG * 20, 0.05) && lr.flags >= 1, j(lr));

  /* ════════════════════ 6. MR material priced ════════════════════ */
  section('6. The MR material — last price paid, else the list price, else not costed');
  const est0 = acc.approved.estimate;
  ok('nothing bought, no list prices: every MR material is named as not costed', (est0.materialNotCosted ?? []).length >= 1 && /Not costed/.test(est0.materialCostNote), j([est0.materialNotCosted, est0.materialCostNote]));
  await db.query("UPDATE cf_item_details SET list_price = 60, price_basis = 'unit' WHERE master_id IN (?)", [[G.A, G.B, G.C]]);
  const dry3 = await ACC.saveAcceptance(db, c, o2.id, { ...base, dryRun: true });
  ok('with list prices: costed at the list price, and said so', dry3.estimate.materialCost == null || ((dry3.estimate.materialNotCosted ?? []).length === 0), j([dry3.estimate.materialCost, dry3.estimate.materialCostNote]));
  const dry4 = await ACC.saveAcceptance(db, c, o.id, { ...base, dryRun: true });
  ok('the accepted order\'s MR now costs at the list price', dry4.estimate.materialCost > 0 && /list price/.test(dry4.estimate.materialCostNote) && (dry4.estimate.materialNotCosted ?? []).length === 0, j([dry4.estimate.materialCost, dry4.estimate.materialCostNote]));

  /* ════════════════════ 7. HSN / GST by family ════════════════════ */
  section('7. HSN / GST by catalog family');
  ok('suggestions: plates 7208 / 18 %, sections 7216, studs 7318; made families none', TF.suggestFor('Steel › Plates › Plate', [18])?.hsnCode === '7208' && TF.suggestFor('Steel › Angles › Angle', [18])?.hsnCode === '7216'
    && TF.suggestFor('Bought out › Fasteners › Shear stud', [18])?.hsnCode === '7318' && TF.suggestFor('Fabricated › Parts › Plate part', [18]) === null && TF.suggestFor('Steel › Plates › Cut plate', [18]) === null);
  ok('a suggested rate not on the company list is flagged', TF.suggestFor('Steel › Plates', [5, 12])?.rateOnList === false);
  const root = await CLS.createNode(db, c, { code: `${tag}-STL`, name: `${tag} Steel` });
  const plates = await CLS.createNode(db, c, { parentId: root.id, code: `${tag}-PL`, name: `${tag} MS Plates` });
  const msPlate = await CLS.createNode(db, c, { parentId: plates.id, code: `${tag}-PLMS`, name: `${tag} MS plate` });
  const tenMm = await CLS.createNode(db, c, { parentId: plates.id, code: `${tag}-PL10`, name: `${tag} 10 mm` });
  const item = async (key, nodeId) => (await MR.createItem(db, c, { itemType: 'catalog', classificationId: nodeId, code: `${tag}-I${key}`, name: `${tag} plate ${key}`, shortName: `I${key}`, uom: 'nos', status: 'active' })).id;
  const i1 = await item('1', msPlate.id); const i2 = await item('2', msPlate.id); const i3 = await item('3', tenMm.id);
  await MR.updateRecord(db, c, i2, { hsnCode: '7211', gstRate: 12 });
  let view = await TF.familyTaxView(db, COMPANY);
  const fam = view.families.find((f) => f.nodeId === msPlate.id);
  ok('the family is listed with its gaps (1 of 2 without HSN / rate) and the suggestion', fam && fam.items === 2 && fam.noHsn === 1 && fam.noRate === 1 && fam.suggestion?.hsnCode === '7208', j(fam));
  ok('the gap totals are there', view.gaps.items >= 3 && view.gaps.noRate >= 2);
  const dr = await TF.applyFamilyTax(db, c, plates.id, { hsnCode: '7208', gstRate: 18, dryRun: true });
  ok('dry run: 2 items would be set (the family and the 10 mm under it), nothing written', dr.dryRun && dr.items === 2, j(dr));
  const [[stillNull]] = await db.query('SELECT hsn_code FROM cf_item_details WHERE master_id = ?', [i1]);
  ok('…nothing written', stillNull.hsn_code == null);
  const done = await TF.applyFamilyTax(db, c, plates.id, { hsnCode: '7208', gstRate: 18 });
  const tax = await TAX.itemTaxOf(db, COMPANY, [i1, i2, i3]);
  ok('the gaps filled: items 1 and 3 → 7208 / 18 %; item 2 keeps its own 7211 / 12 %', done.items === 2 && tax.get(i1).hsnCode === '7208' && tax.get(i1).gstRate === 18 && tax.get(i3).gstRate === 18 && tax.get(i2).hsnCode === '7211' && tax.get(i2).gstRate === 12, j([...tax]));
  const again = await refusal(() => TF.applyFamilyTax(db, c, plates.id, { hsnCode: '7208', gstRate: 18 }));
  ok('again: nothing left to set, says to tick overwrite', again?.code === 'NOTHING_TO_SET' && /overwrite/.test(again.message));
  const ow = await TF.applyFamilyTax(db, c, plates.id, { gstRate: 18, overwrite: true });
  ok('overwrite: every item of the family takes 18 %', ow.items === 3 && (await TAX.itemTaxOf(db, COMPANY, [i2])).get(i2).gstRate === 18);
  const bad = await refusal(() => TF.applyFamilyTax(db, c, plates.id, { gstRate: 7 }));
  ok('a rate not on the company list is refused', bad?.status === 422 && bad.problems?.some((p) => /not on the company's list/.test(p)), j(bad?.problems));
  const badHsn = await refusal(() => TF.applyFamilyTax(db, c, plates.id, { hsnCode: '72' }));
  ok('a bad HSN is refused', badHsn?.problems?.some((p) => /4, 6 or 8 digits/.test(p)));
  view = await TF.familyTaxView(db, COMPANY);
  ok('the family has no gaps now', view.families.filter((f) => [msPlate.id, tenMm.id].includes(f.nodeId)).every((f) => f.noRate === 0));
  const { poTax } = await TAX.purchaseOrderTax(db, COMPANY, [{ id: 1, supplier_id: null }], [
    { id: 11, purchase_order_id: 1, item_id: i1, amount: 1000 }, { id: 12, purchase_order_id: 1, item_id: G.C, amount: 500 },
  ]);
  ok('a PO says how many lines have no GST rate (not a silent ₹0)', poTax.get(1).noGstLines === 1, j(poTax.get(1)));
} catch (e) {
  console.error(e);
  ok(`no crash: ${e.message}`, false, e.problems ? j(e.problems) : '');
} finally {
  await db.rollback().catch(() => {});
  detachNodeCache(db);
  db.release();
}
const after = await H.counts();
const changed = after.filter((a) => Number(before.find((x) => x.name === a.name)?.n) !== Number(a.n));
ok('rolled back: every cf_ table is as it was', changed.length === 0, j(changed));
console.log(`\n${H.state.passed} passed, ${H.state.failed} failed${H.state.failed ? `\n  ${H.state.fails.join('\n  ')}` : ''}`);
await pool.end();
process.exit(H.state.failed ? 1 : 0);
