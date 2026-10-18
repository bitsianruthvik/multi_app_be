/**
 * purchase_flow_v3_test.mjs — PURCHASE FLOW v3, end to end (init.sql §71, TM/s71.sql; contract TM/CF_ERP_BUYING_V2.md
 * "2026-10-18 — Purchase flow v3"): MR → PR (the RFQ, with vendor columns) → PO with MD approval → GRNs → close short.
 *
 *   cd multi_app_be && node scripts/cf_kepl/purchase_flow_v3_test.mjs
 *   CF_PUR_COMPANY (2) · CF_PUR_TRANSCRIPT (TM/PURCHASE_FLOW_RUN.md — a state table after every step, for a person)
 *
 * ONE TRANSACTION, ROLLED BACK; every cf_ table is re-counted at the end. Everything is this run's own, named
 * TEST-PUR-<run>. Line 923 is never touched.
 *
 *   1  SO → lock → nest: a line of plate parts, rolled out (what lock does), nested from the customer's files (5 plates)
 *   2  raise the MR from the sales order (no earmark): the MR screen — required / in stock / take from stock / to buy
 *   3  save the MR: take 1 plate from stock (earmarked to the order); ONE PR for the rest
 *   4  the PR: 3 vendor columns, partial quotes (rate ₹/unit, delivery days, remark)
 *   5  raise a PO from vendor A for one line, from vendor B for the other → both PENDING MD APPROVAL
 *   6  a GRN is refused while it waits; the MD approves → waiting for goods
 *   7  two partial GRNs → the PO's table ordered / received / pending; the MR's "Locked for this order" moves
 *   8  close short → the pending quantity is released, the PR line's "PO raised" goes down
 *   9  another order needs the same plate: what is earmarked / received for the first is NOT free for it
 *  10  its PR, and ONE PO serving both orders (raise again from vendor C, added to the same pending PO)
 *  11  full GRN → the POs close by themselves; earmarked back to each order; the PRs close
 *  12  a customer-supplied order → the ₹0 PO to the customer, no approval, its GRN = the customer's lot
 *  13  nesting saves apply directly with the plate-change gate off (a PO covers the line)
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const BE = process.cwd();
const imp = (p) => import(pathToFileURL(path.join(BE, p)).href);
const { pool } = await imp('db.js');
if (!/^(localhost|127\.0\.0\.1|::1)$/.test(process.env.DB_HOST ?? 'localhost')) throw new Error('This suite is local only.');
await imp('apps/cf_erp/services/codegenProvider.js');
const { attachNodeCache, detachNodeCache } = await imp('apps/cf_erp/lib/db.js');
const MRS = await imp('apps/cf_erp/services/materialReadyService.js');
const RQ = await imp('apps/cf_erp/services/requisitionService.js');
const PRS = await imp('apps/cf_erp/services/purchaseRequestService.js');
const PS = await imp('apps/cf_erp/services/purchaseService.js');
const PC = await imp('apps/cf_erp/services/plateChangeService.js');
const REL = await imp('apps/cf_erp/services/releaseService.js');
const SO = await imp('apps/cf_erp/services/salesOrderService.js');
const LOCK = await imp('apps/cf_erp/services/lockService.js');
const ST = await imp('apps/cf_erp/services/stockService.js');
const NU = await imp('apps/cf_erp/services/nestDxfImportService.js');
const { availability } = await imp('apps/cf_erp/services/rollOutService.js');
const { harness, simple, girder, quietCodes } = await imp('scripts/cf_kepl/lib/buyingFixture.mjs');
const NF = await imp('scripts/cf_kepl/lib/nestV2Fixture.mjs');

const COMPANY = Number(process.env.CF_PUR_COMPANY ?? 2);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const TRANSCRIPT = process.env.CF_PUR_TRANSCRIPT ?? path.resolve(HERE, '../../../PURCHASE_FLOW_RUN.md');
const RUN = Date.now().toString(36).toUpperCase().slice(-5);
const tag = `TEST-PUR-${RUN}`;
const TODAY = '2026-10-18';
const EPS = 1e-6;

const H = harness(pool);
const { ok, section, refusal, j } = H;
const before = await H.counts();
const db = await pool.getConnection();

// ---- the transcript ----------------------------------------------------------------------------------
const md = [];
const say = (s) => { md.push(`${s}\n`); console.log(`        ${s}`); };
const step = (title, what) => { section(title); md.push(`\n## ${title}\n`); if (what) md.push(`${what}\n`); };
const table = (head, rows) => {
  const t = [`| ${head.join(' | ')} |`, `|${head.map((_, i) => (i === 0 ? '---' : '---:')).join('|')}|`, ...rows.map((r) => `| ${r.join(' | ')} |`)];
  md.push(t.join('\n'), '');
  for (const l of t) console.log(`        ${l}`);
};
const n = (v) => String(Number(Number(v ?? 0).toFixed(3)));

try {
  await db.beginTransaction();
  attachNodeCache(db);
  MRS.setToday(TODAY);
  const [[user]] = await db.query('SELECT id, name FROM users WHERE company_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 1', [COMPANY]);
  const c = { companyId: COMPANY, userId: user.id, canManage: true, canApprove: true, isAdmin: true };
  await quietCodes(db, COMPANY);
  ok('the plate-change gate is OFF by default (§71)', PC.plateChangeGateOn() === false);

  const S = await simple(db, c, tag);
  const ins = async (sql, params) => (await db.query(sql, params))[0].insertId;
  const vendor = (key, name) => ins("INSERT INTO cf_parties (company_id, code, name, is_supplier, status) VALUES (?, ?, ?, 1, 'active')", [COMPANY, `${tag}-${key}`, `${tag} ${name}`]);
  const VA = await vendor('VA', 'Vendor A');
  const VB = await vendor('VB', 'Vendor B');
  const VC = await vendor('VC', 'Vendor C');
  const short = (s) => String(s ?? '').replace(`${tag} `, '').replace(`${tag}-`, '');

  /* ════════════════════ 1. SO → lock → nest ════════════════════ */
  step('1. Sales order → lock → nest', 'A sales order line of plate parts (gussets, angles, stiffeners, splices, frames …). Locked: its rows are rolled out into pieces. Nested from the customer\'s five nesting files.');
  const fx = await NF.buildFixture(db, { company: COMPANY, tagPrefix: 'TPUR' });
  const ORDER = `${tag}-NEST`;
  await db.query('UPDATE cf_sales_orders SET code = ?, customer_id = ? WHERE id = ?', [ORDER, S.CUS, fx.orderId]);
  {
    const [bl] = await db.query(
      `SELECT b.parent_id, l.id, l.child_id FROM cf_boms b JOIN cf_bom_lines l ON l.bom_id = b.id AND l.deleted_at IS NULL
        WHERE b.company_id = ? AND b.parent_id IN (?) AND b.deleted_at IS NULL`, [COMPANY, [fx.root, ...Object.values(fx.partRow)]]);
    const lineOf = (parent, child) => bl.find((x) => Number(x.parent_id) === Number(parent) && Number(x.child_id) === Number(child))?.id ?? null;
    let sort = 0;
    const piece = async (parentId, itemId, bomLineId, qty, depth) => ins(
      'INSERT INTO cf_order_pieces (company_id, order_id, order_line_id, parent_id, item_id, bom_line_id, quantity, code, path_key, depth, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [COMPANY, fx.orderId, fx.lineId, parentId, itemId, bomLineId, qty, `${fx.tag}-PCE-${sort}`, `${fx.tag}/${sort}`, depth, sort++]);
    const root = await piece(null, fx.root, null, 1, 0);
    for (const [sfx, p] of Object.entries(fx.parts)) {
      const row = await piece(root, fx.partRow[sfx], lineOf(fx.root, fx.partRow[sfx]), p.qty, 1);
      await piece(row, fx.cut[sfx], lineOf(fx.partRow[sfx], fx.cut[sfx]), p.qty, 2);
    }
  }
  const sets = NF.nestings(fx);
  const asReq = (files) => files.map((f) => ({ filename: f.filename, file: f.file, ...(f.style === 'segments' ? { plateCode: fx.plateCode('PS') } : {}) }));
  const up = await NU.uploadNestFiles(db, c, fx.lineId, { files: asReq(sets.B), dryRun: false });
  ok(`nested: ${up.saved?.lots} plates, nothing left over`, up.applied === true && up.leftOver.length === 0, j([up.applied, up.leftOver]));
  const PSI = Number(fx.plates.PS);
  const PBI = Number(fx.plates.PB);
  const ITEM = { [PSI]: 'PS 14.137 × 3000 × 1500', [PBI]: 'PB 14.137 × 3000 × 1500 (grade B)' };
  const itemName = (id) => ITEM[Number(id)] ?? `item ${id}`;
  const need = (await MRS.lineNeeds(db, COMPANY, await MRS.openLines(db, COMPANY, { orderIds: [fx.orderId] }))).get(fx.lineId);
  table(['Plate', 'The line needs'], [...need.items.values()].map((e) => [itemName(e.item.id), n(e.need)]));
  ok('the line needs 4 PS plates and 1 PB plate', need.items.get(PSI)?.need === 4 && need.items.get(PBI)?.need === 1, j([...need.items.values()].map((e) => [e.item.code, e.need])));
  // Our own stock: 1 PS plate, free.
  await ST.postMovement(db, c, { movementType: 'receipt', toAreaId: S.store, lines: [{ itemId: PSI, quantity: 1, unitCost: 60000 }] });
  say('Our own stock before: 1 PS plate, free.');

  /* ════════════════════ 2. raise the MR ════════════════════ */
  step('2. "Raise MR" on the sales order — the MR screen in Purchase');
  const raised = await RQ.raiseRequisitions(db, c, fx.orderId, {});
  const mr = raised.requisitions[0];
  ok('one MR, numbered MR-<order>-<line>, nothing earmarked by the raise', mr.code === `MR-${ORDER}-1` && raised.earmarked.length === 0, j([mr.code, raised.earmarked]));
  const mrTable = (s) => table(['Material', 'Required', 'In stock (free)', 'Take from stock', 'To buy', 'PO raised', 'Received', 'Locked for this order'],
    s.lines.map((l) => [itemName(l.item.id), n(l.required), n(l.inStock), n(l.takeFromStock), n(l.toBuy), n(l.poRaised), n(l.received), n(l.locked)]));
  let screen = await PRS.mrScreen(db, COMPANY, mr.id);
  mrTable(screen);
  const ln = (s, itemId) => s.lines.find((l) => Number(l.item.id) === Number(itemId));
  ok('PS: required 4, 1 free in stock; PB: required 1, none in stock', ln(screen, PSI).required === 4 && ln(screen, PSI).inStock === 1 && ln(screen, PBI).required === 1 && ln(screen, PBI).inStock === 0);
  ok('no PR yet, nothing locked', screen.purchaseRequest === null && screen.lines.every((l) => l.locked === 0));
  ok('the screen PROPOSES take from stock = min(required, free): PS 1, PB 0 — a suggestion, nothing earmarked', ln(screen, PSI).proposedTake === 1 && ln(screen, PBI).proposedTake === 0 && ln(screen, PSI).heldFromStock === 0 && (await availability(db, COMPANY, [PSI])).get(PSI).free === 1, j(screen.lines.map((l) => l.proposedTake)));
  say('Proposed: take PS 1 from stock (what is free), PB 0. Nothing is earmarked until the MR is saved.');

  /* ════════════════════ 3. save the MR ════════════════════ */
  step('3. Save the MR — take 1 PS from stock; the rest goes on ONE purchase request');
  const tooMuch = await refusal(() => PRS.saveMr(db, c, mr.id, { lines: [{ lineId: ln(screen, PSI).id, takeFromStock: 2 }] }));
  ok('taking 2 when only 1 is free is refused, in words', tooMuch?.status === 422 && tooMuch.problems.some((p) => /only 1 nos is free in stock/.test(p)), j(tooMuch?.problems));
  say(`Refused: "${tooMuch?.problems?.[0]}"`);
  screen = await PRS.saveMr(db, c, mr.id, { lines: [{ lineId: ln(screen, PSI).id, takeFromStock: 1 }, { lineId: ln(screen, PBI).id, takeFromStock: 0 }] });
  mrTable(screen);
  ok('PS: take 1 → to buy 3, locked 1 (earmarked to the order); PB: to buy 1', ln(screen, PSI).takeFromStock === 1 && ln(screen, PSI).toBuy === 3 && ln(screen, PSI).locked === 1 && ln(screen, PBI).toBuy === 1, j(screen.lines));
  ok('the hold is on the MR line, from stock (no PO)', ln(screen, PSI).heldFromStock === 1);
  ok('ONE PR made', !!screen.purchaseRequest?.code && screen.purchaseRequest.status === 'open', j(screen.purchaseRequest));
  const freeForNobody = (await availability(db, COMPANY, [PSI])).get(PSI).free;
  ok('the plate taken is not free for anybody else now', freeForNobody === 0, String(freeForNobody));
  const again = await PRS.saveMr(db, c, mr.id, { lines: [{ lineId: ln(screen, PSI).id, takeFromStock: 1 }] });
  ok('saving again with the same numbers changes nothing (one PR, one hold)', again.purchaseRequest.id === screen.purchaseRequest.id && ln(again, PSI).heldFromStock === 1 && again.saved.held === 0);
  const prId = screen.purchaseRequest.id;

  /* ════════════════════ 4. the PR with vendor columns ════════════════════ */
  step('4. The purchase request — three vendor columns, partial quotes', 'The PR is the RFQ: one row per line, one column per vendor. A cell is that vendor\'s rate (₹ per plate), delivery days and a remark. A vendor may quote any lines; an empty cell is no quote.');
  for (const v of [VA, VB, VC]) await PRS.addVendor(db, c, prId, { supplierId: v });
  let pr = await PRS.getPr(db, COMPANY, prId);
  const prLine = (p, itemId) => p.lines.find((l) => Number(l.item.id) === Number(itemId));
  const col = (p, supplierId) => p.vendors.find((v) => Number(v.supplier.id) === Number(supplierId));
  const dupe = await refusal(() => PRS.addVendor(db, c, prId, { supplierId: VA }));
  ok('a vendor once per PR', dupe?.code === 'DUPLICATE', dupe?.message);
  await PRS.setQuotes(db, c, col(pr, VA).id, { quotes: [{ lineId: prLine(pr, PSI).id, rate: 62000, deliveryDays: 7 }, { lineId: prLine(pr, PBI).id, rate: 71000, deliveryDays: 10 }] });
  await PRS.setQuotes(db, c, col(pr, VB).id, { quotes: [{ lineId: prLine(pr, PBI).id, rate: 70000, deliveryDays: 5, remark: 'grade B from stock' }] });
  pr = await PRS.setQuotes(db, c, col(pr, VC).id, { quotes: [{ lineId: prLine(pr, PSI).id, rate: 60500, deliveryDays: 14, remark: 'mill delivery' }] });
  const grid = (p) => table(['Line', 'Needed', 'PO raised', ...p.vendors.map((v) => short(v.supplier.name))],
    p.lines.map((l) => [itemName(l.item.id), n(l.needed), n(l.poRaised), ...p.vendors.map((v) => { const q = v.quotes[l.id]; return q ? `₹${q.rate}/${l.item.uom}${q.deliveryDays != null ? ` · ${q.deliveryDays} d` : ''}${q.remark ? ` · ${q.remark}` : ''}` : '—'; })]));
  grid(pr);
  ok('PR lines = to buy: PS 3, PB 1; status open', prLine(pr, PSI).needed === 3 && prLine(pr, PBI).needed === 1 && pr.status === 'open', j(pr.lines));
  ok('vendor B quoted only PB; vendor C only PS', Object.keys(col(pr, VB).quotes).length === 1 && Object.keys(col(pr, VC).quotes).length === 1);
  const badRate = await refusal(() => PRS.setQuotes(db, c, col(pr, VA).id, { quotes: [{ lineId: prLine(pr, PSI).id, rate: -1 }] }));
  ok('a negative rate is refused', badRate?.status === 422);
  // Clearing a cell and putting it back.
  await PRS.setQuotes(db, c, col(pr, VA).id, { quotes: [{ lineId: prLine(pr, PBI).id, rate: '' }] });
  ok('a blank rate clears the cell', !(await PRS.getPr(db, COMPANY, prId)).vendors.find((v) => Number(v.supplier.id) === VA).quotes[prLine(pr, PBI).id]);
  pr = await PRS.setQuotes(db, c, col(pr, VA).id, { quotes: [{ lineId: prLine(pr, PBI).id, rate: 71000, deliveryDays: 10 }] });

  /* ════════════════════ 5. raise POs ════════════════════ */
  step('5. Raise PO — vendor A for PS, vendor B for PB', '"Raise PO" on a vendor column lists that vendor\'s quoted lines with the quantity filled in (needed − PO raised).');
  const noQuote = await refusal(() => PRS.raisePo(db, c, col(pr, VB).id, { lines: [{ lineId: prLine(pr, PSI).id, quantity: 1 }] }));
  ok('a line the vendor did not quote cannot go on their PO', noQuote?.status === 422 && /has not quoted/.test(noQuote.problems.join(' ')), j(noQuote?.problems));
  const over = await refusal(() => PRS.raisePo(db, c, col(pr, VA).id, { lines: [{ lineId: prLine(pr, PSI).id, quantity: 4 }] }));
  ok('more than needed − PO raised is refused', over?.status === 422 && /only 3 nos is still to order/.test(over.problems.join(' ')), j(over?.problems));
  const rA = await PRS.raisePo(db, c, col(pr, VA).id, { lines: [{ lineId: prLine(pr, PSI).id, quantity: 3 }, { lineId: prLine(pr, PBI).id, quantity: 0 }] });
  const rB = await PRS.raisePo(db, c, col(pr, VB).id, { lines: [{ lineId: prLine(pr, PBI).id, quantity: 1 }] });
  let poA = rA.purchaseOrder; let poB = rB.purchaseOrder;
  pr = rB.purchaseRequest;
  const poTable = (pos) => table(['PO', 'Type', 'Vendor', 'Stage', 'Line', 'Ordered', 'Received', 'Pending', 'Rate', 'Expected', 'For'],
    pos.flatMap((p) => p.lines.map((l) => [p.code, p.typeLabel, short(p.supplier?.name), p.stageLabel, itemName(l.item.id), n(l.quantity), n(l.received), n(l.pending), l.unitPrice == null ? '—' : `₹${l.unitPrice}`, l.effectiveDate ?? '—',
      l.orders.map((o) => `${o.requisition?.code ?? o.orderCode} ×${n(o.quantity)}`).join(', ')])));
  poTable([poA, poB]);
  grid(pr);
  ok('both POs: type Material, PENDING MD APPROVAL', [poA, poB].every((p) => p.type === 'material' && p.stage === 'pending_approval' && p.approval?.status === 'pending'), j([poA.stage, poB.stage]));
  ok('PO A: PS 3 at the quoted ₹62000, due today + 7 days; PO B: PB 1 at ₹70000', poA.lines.length === 1 && poA.lines[0].quantity === 3 && poA.lines[0].unitPrice === 62000 && String(poA.lines[0].expectedDate).slice(0, 10) === '2026-10-25' && poB.lines[0].unitPrice === 70000, j(poA.lines));
  ok('each PO line serves the MR line of its PR line', poA.lines[0].orders[0].prLineId === ln(screen, PSI).id && poB.lines[0].orders[0].prLineId === ln(screen, PBI).id);
  ok('the PR: every line has PO raised = needed → "Ordered"', prLine(pr, PSI).poRaised === 3 && prLine(pr, PBI).poRaised === 1 && pr.status === 'ordered', j([pr.status, pr.lines]));
  ok('vendor columns list the POs they raised', col(pr, VA).purchaseOrders.some((p) => p.id === poA.id) && col(pr, VB).purchaseOrders.some((p) => p.id === poB.id));
  const moveCol = await refusal(() => PRS.setVendor(db, c, col(pr, VA).id, { supplierId: VC }));
  ok('a column that raised a PO keeps its vendor', moveCol?.code === 'HAS_PO', moveCol?.message);
  const eng = (await MRS.lineReadiness(db, COMPANY, { full: true })).byLine.get(fx.lineId);
  ok('the engine: a PO waiting for the MD gives no date — the line waits', eng?.state === 'waiting', eng?.text);

  /* ════════════════════ 6. MD approval ════════════════════ */
  step('6. Pending MD approval → approved → waiting for goods');
  const early = await refusal(() => PS.receiveLine(db, c, poA.lines[0].id, { quantity: 1, stockingAreaId: S.store }));
  ok('a GRN against a PO waiting for the MD is refused, in words', early?.code === 'NOT_ORDERED' && /waiting for Management approval/.test(early.message), early?.message);
  say(`Refused: "${early?.message}"`);
  poA = await PS.approvePurchaseOrder(db, c, poA.id, {});
  poB = await PS.approvePurchaseOrder(db, c, poB.id, {});
  ok('approved: waiting for goods, approved by the MD', [poA, poB].every((p) => p.stage === 'waiting' && p.status === 'ordered' && p.approval?.status === 'approved' && p.approval.by?.id === user.id), j([poA.stage, poA.approval]));
  const twice = await refusal(() => PS.approvePurchaseOrder(db, c, poA.id, {}));
  ok('approving twice is refused', twice?.code === 'NOT_PENDING', twice?.message);
  poTable([poA, poB]);

  /* ════════════════════ 6b. expected delivery dates ════════════════════ */
  step('6b. Expected delivery dates — the PO\'s date, a line\'s own date, every change recorded', 'Every PO has an expected delivery date for the whole PO; a line may have its own (a blank line date = the PO\'s). The planner takes the line\'s effective date; a GRN keeps its actual receipt date.');
  const dateTable = (p) => {
    table(['PO', 'PO expected', 'Line', 'Line expected', 'Effective (planner)', 'From'], p.lines.map((l) => [p.code, p.expectedDate ?? '—', itemName(l.item.id), l.expectedDate ? String(l.expectedDate).slice(0, 10) : '—', l.effectiveDate ?? '—', l.dateSource ?? '—']));
    if (p.dateChanges.length) table(['Change', 'Line', 'From', 'To', 'By'], p.dateChanges.map((d) => [String(d.id), d.lineId ? itemName(p.lines.find((l) => l.id === d.lineId)?.item.id) : 'the PO', d.from ?? '—', d.to ?? '—', d.by?.name ? 'the buyer' : '—']));
  };
  ok('raised from the PR, PO A gets an expected date for the whole PO (its quote: today + 7 days); its line the same', poA.expectedDate === '2026-10-25' && poA.lines[0].effectiveDate === '2026-10-25', j([poA.expectedDate, poA.lines[0]]));
  poA = await PS.updatePurchaseOrder(db, c, poA.id, { expectedDate: '2026-10-27' });
  poA = await PS.updatePurchaseLine(db, c, poA.lines[0].id, { expectedDate: null });
  ok('the line date cleared: the line takes the PO\'s date (source "po")', poA.lines[0].expectedDate == null && poA.lines[0].effectiveDate === '2026-10-27' && poA.lines[0].dateSource === 'po', j(poA.lines[0]));
  poA = await PS.updatePurchaseLine(db, c, poA.lines[0].id, { expectedDate: '2026-10-29' });
  ok('a line date overrides the PO\'s (source "line")', poA.lines[0].effectiveDate === '2026-10-29' && poA.lines[0].dateSource === 'line' && poA.expectedDate === '2026-10-27');
  dateTable(poA);
  ok('every change is recorded with who and when: the PO 25 → 27 Oct, the line 25 Oct → none → 29 Oct', poA.dateChanges.length === 3 && poA.dateChanges.every((d) => d.by?.id === user.id && !!d.at)
    && j(poA.dateChanges.map((d) => [d.lineId == null ? 'po' : 'line', d.from, d.to]).reverse()) === j([['po', '2026-10-25', '2026-10-27'], ['line', '2026-10-25', null], ['line', null, '2026-10-29']]), j(poA.dateChanges));
  const engA = (await MRS.lineReadiness(db, COMPANY, { full: true })).byLine.get(fx.lineId);
  ok('the engine dates the line by the effective date of its PO line (29 Oct)', engA?.reasons?.some((r) => r.cover.some((x) => x.kind === 'po' && x.date === '2026-10-29')), j(engA?.reasons?.map((r) => r.cover)));

  /* ════════════════════ 7. two partial GRNs ════════════════════ */
  step('7. Inventory › Receive against PO — two partial GRNs on PO A');
  const pend = await PS.pendingLines(db, COMPANY, { search: tag });
  ok('Receive against PO lists both POs\' pending lines', pend.rows.filter((r) => [poA.id, poB.id].includes(r.purchaseOrder.id)).length === 2, j(pend.rows.map((r) => r.purchaseOrder.code)));
  const g1 = await PS.receiveLine(db, c, poA.lines[0].id, { quantity: 1, stockingAreaId: S.store });
  const g2 = await PS.receiveLine(db, c, poA.lines[0].id, { quantity: 1, stockingAreaId: S.store, movementDate: '2026-10-17' });
  say(`GRNs ${g1.movement.code} and ${g2.movement.code}: 1 PS plate each on ${poA.code}, earmarked to ${g2.held.map((h) => h.orderCode).join(', ')}.`);
  poA = g2.order;
  poTable([poA]);
  ok('PO A: ordered 3, received 2, pending 1 — part received', poA.lines[0].quantity === 3 && poA.lines[0].received === 2 && poA.lines[0].pending === 1 && poA.stage === 'part_received', j(poA.lines[0]));
  ok('two GRNs on the one PO line', poA.lines[0].receipts.length === 2);
  ok('a GRN keeps its ACTUAL receipt date (17 Oct), beside the line\'s expected date (29 Oct)', String(poA.lines[0].receipts[1].date).slice(0, 10) === '2026-10-17' && poA.lines[0].effectiveDate === '2026-10-29', j(poA.lines[0].receipts));
  screen = await PRS.mrScreen(db, COMPANY, mr.id);
  mrTable(screen);
  ok('the MR: PS locked 3 (1 from stock + 2 received), live', ln(screen, PSI).locked === 3 && ln(screen, PSI).received === 2, j(ln(screen, PSI)));

  /* ════════════════════ 8. close short ════════════════════ */
  step('8. Close PO A short — the PR line\'s "PO raised" goes down', 'The vendor cannot send the third plate. "Close PO" (with a reason) releases what is pending.');
  const noReason = await refusal(() => PS.closePurchaseOrder(db, c, poA.id, {}));
  ok('closing short needs a reason', noReason?.code === 'REASON');
  poA = await PS.closePurchaseOrder(db, c, poA.id, { reason: 'Mill short of 14.137 mm plate' });
  poTable([poA]);
  ok('PO A: closed short, pending 0, 1 released, the reason kept', poA.stage === 'closed_short' && poA.lines[0].pending === 0 && poA.lines[0].closedQty === 1 && poA.closed?.reason === 'Mill short of 14.137 mm plate', j([poA.stage, poA.lines[0], poA.closed]));
  pr = await PRS.getPr(db, COMPANY, prId);
  grid(pr);
  ok('PR: PS "PO raised" 3 → 2, 1 to order again; status partly ordered', prLine(pr, PSI).poRaised === 2 && prLine(pr, PSI).open === 1 && pr.status === 'partly_ordered', j([pr.status, prLine(pr, PSI)]));
  screen = await PRS.mrScreen(db, COMPANY, mr.id);
  ok('the MR: PS still locked 3, 1 open again', ln(screen, PSI).locked === 3 && ln(screen, PSI).open === 1, j(ln(screen, PSI)));
  const lateGrn = await refusal(() => PS.receiveLine(db, c, poA.lines[0].id, { quantity: 1, stockingAreaId: S.store }));
  ok('nothing more can be received on a PO closed short', lateGrn?.code === 'CLOSED', lateGrn?.message);

  /* ════════════════════ 9. another order ════════════════════ */
  step('9. Another order needs PS — the first order\'s plates are not free for it', 'Order 2 (released) needs 2 PS plates. On hand: 3 PS plates — 1 taken from stock and 2 received, all earmarked to the first order.');
  const O2 = await S.order('O2', [[[PSI, 2]]]);
  const onHand = Number((await db.query('SELECT COALESCE(SUM(k.quantity),0) q FROM cf_stock_balances k WHERE k.company_id = ? AND k.item_id = ?', [COMPANY, PSI]))[0][0].q);
  const av2 = (await availability(db, COMPANY, [PSI], { orderId: O2.id })).get(PSI);
  ok('3 PS on hand, 0 free for order 2', onHand === 3 && av2.free === 0, j([onHand, av2.free]));
  const r2 = await RQ.raiseRequisitions(db, c, O2.id, {});
  const mr2 = r2.requisitions[0];
  let screen2 = await PRS.mrScreen(db, COMPANY, mr2.id);
  mrTable(screen2);
  ok("order 2's MR screen: PS in stock 0", ln(screen2, PSI).inStock === 0, j(ln(screen2, PSI)));
  const steal = await refusal(() => PRS.saveMr(db, c, mr2.id, { lines: [{ lineId: ln(screen2, PSI).id, takeFromStock: 1 }] }));
  ok('order 2 cannot take them from stock', steal?.status === 422 && /only 0 nos is free/.test(steal.problems.join(' ')), j(steal?.problems));
  const rv = await REL.reserveRelease(db, c, O2.line.releaseId);
  const [[{ q: reservedO2 }]] = await db.query(
    `SELECT COALESCE(SUM(v.quantity),0) q FROM cf_stock_reservations v JOIN cf_material_requirements r ON r.id = v.requirement_id
      WHERE v.company_id = ? AND r.release_id = ? AND v.status = 'active' AND v.deleted_at IS NULL`, [COMPANY, O2.line.releaseId]);
  ok('"Reserve all" for order 2 reserves none of them', Number(reservedO2) === 0, j([reservedO2, rv?.reserved]));

  /* ════════════════════ 10. one PO, two PRs ════════════════════ */
  step('10. Order 2\'s PR, and ONE PO from vendor C serving both orders');
  screen2 = await PRS.saveMr(db, c, mr2.id, { lines: [{ lineId: ln(screen2, PSI).id, takeFromStock: 0 }] });
  const pr2Id = screen2.purchaseRequest.id;
  await PRS.addVendor(db, c, pr2Id, { supplierId: VC });
  let pr2 = await PRS.getPr(db, COMPANY, pr2Id);
  pr2 = await PRS.setQuotes(db, c, col(pr2, VC).id, { quotes: [{ lineId: prLine(pr2, PSI).id, rate: 60500, deliveryDays: 14 }] });
  const rC2 = await PRS.raisePo(db, c, col(pr2, VC).id, { lines: [{ lineId: prLine(pr2, PSI).id, quantity: 2 }] });
  const pendingC = await PRS.pendingPosOfVendor(db, COMPANY, col(pr, VC).id);
  ok("vendor C's PO waiting for the MD is offered to add to", pendingC.purchaseOrders.some((p) => p.id === rC2.purchaseOrder.id));
  const rC1 = await PRS.raisePo(db, c, col(pr, VC).id, { lines: [{ lineId: prLine(pr, PSI).id, quantity: prLine(pr, PSI).open }], addToPoId: rC2.purchaseOrder.id });
  let poC = rC1.purchaseOrder;
  poTable([poC]);
  ok('one PO, one PS line of 3: 2 for order 2, 1 for the first order', poC.id === rC2.purchaseOrder.id && poC.lines.length === 1 && poC.lines[0].quantity === 3
    && poC.lines[0].orders.length === 2 && poC.lines[0].orders.some((o) => o.orderId === O2.id && o.quantity === 2) && poC.lines[0].orders.some((o) => o.orderId === fx.orderId && o.quantity === 1), j(poC.lines[0].orders));
  ok('it serves two orders: the header names none', poC.forOrder === null);
  pr = rC1.purchaseRequest;
  grid(pr);
  ok('the first PR is "Ordered" again (PS PO raised 3)', pr.status === 'ordered' && prLine(pr, PSI).poRaised === 3, j([pr.status, prLine(pr, PSI)]));
  poC = await PS.approvePurchaseOrder(db, c, poC.id, {});

  /* ════════════════════ 11. full GRNs ════════════════════ */
  step('11. Full GRNs — the POs close by themselves, the stock is earmarked back to each order');
  const g3 = await PS.receiveLine(db, c, poC.lines[0].id, { quantity: 3, stockingAreaId: S.store });
  say(`GRN ${g3.movement.code}: 3 PS on ${poC.code} → ${g3.held.map((h) => `${h.orderCode} ${n(h.quantity)}`).join(', ')}.`);
  const g4 = await PS.receiveLine(db, c, poB.lines[0].id, { quantity: 1, stockingAreaId: S.store });
  poC = g3.order; poB = g4.order;
  poTable([poA, poB, poC]);
  ok('PO C and PO B: everything received → Closed by itself', poC.stage === 'closed' && poB.stage === 'closed' && poC.lines[0].pending === 0, j([poC.stage, poB.stage]));
  ok('the receipt earmarked 2 to order 2 and 1 to the first order', g3.held.some((h) => h.orderId === O2.id && h.quantity === 2) && g3.held.some((h) => h.orderId === fx.orderId && h.quantity === 1), j(g3.held));
  screen = await PRS.mrScreen(db, COMPANY, mr.id);
  screen2 = await PRS.mrScreen(db, COMPANY, mr2.id);
  md.push('**First order\'s MR:**\n'); mrTable(screen);
  md.push('**Order 2\'s MR:**\n'); mrTable(screen2);
  ok('first order: PS locked 4 of 4, PB 1 of 1', ln(screen, PSI).locked === 4 && ln(screen, PBI).locked === 1, j(screen.lines.map((l) => l.locked)));
  ok('order 2: PS locked 2 of 2', ln(screen2, PSI).locked === 2);
  pr = await PRS.getPr(db, COMPANY, prId);
  pr2 = await PRS.getPr(db, COMPANY, pr2Id);
  grid(pr);
  ok('both PRs closed', pr.status === 'closed' && pr2.status === 'closed', j([pr.status, pr2.status]));
  const list = await PS.listPurchaseOrders(db, COMPANY, { status: 'all', search: tag, paged: '1' });
  ok('the PO list says type and stage, and counts by stage', list.rows.every((p) => p.type === 'material' && !!p.stageLabel) && list.counts.stage.closed === 2 && list.counts.stage.closed_short === 1, j(list.counts.stage));
  const prs = await PRS.listPrs(db, COMPANY, { status: 'all', search: tag });
  ok('the PR list has both, closed', prs.rows.length === 2 && prs.rows.every((p) => p.status === 'closed'), j(prs.rows.map((p) => p.status)));
  const mrs = await PRS.listMrs(db, COMPANY, { search: tag });
  ok('the MR list has both, with their PRs', mrs.rows.length >= 2 && mrs.rows.every((m) => m.purchaseRequest), j(mrs.rows.map((m) => [m.code, m.purchaseRequest?.code])));

  /* ════════════════════ 12. customer supplies ════════════════════ */
  step('12. A customer-supplied order — the ₹0 PO to the customer, no MD approval');
  const G = await girder(db, c, tag);
  Object.assign(ITEM, { [G.A]: 'Girder material A (kg)', [G.B]: 'Girder material B (kg)', [G.C]: 'Girder material C (kg)' });
  const so = await SO.createOrder(db, c, { orderType: 'customer', customerId: G.CUS, code: `${tag}-CUST`, committedDate: '2026-11-20', materialSupply: 'customer' });
  const o = await SO.addOrderLine(db, c, so.id, { recordId: G.GR.id, quantity: 1 });
  await db.query('UPDATE cf_sales_orders SET process_id = ? WHERE id = ?', [G.prc.id, so.id]);
  await LOCK.lockLine(db, c, o.lines[0].id);
  await SO.setOrderStatus(db, c, so.id, 'confirmed');
  const rx = await RQ.raiseRequisitions(db, c, so.id, {});
  const cpo = await PS.getPurchaseOrder(db, COMPANY, rx.customerPurchaseOrders[0].id);
  poTable([cpo]);
  ok('the customer PO: ₹0, supplied by the customer, WAITING FOR GOODS at once (no approval)', cpo.suppliedByCustomer && cpo.stage === 'waiting' && cpo.approval === null && cpo.lines.every((l) => l.unitPrice === 0), j([cpo.stage, cpo.approval]));
  ok("POs straight from MR lines are only the customer's ₹0 PO: the old maker is not exported any more", RQ.makePurchaseOrders === undefined);
  const mrX = await PRS.mrScreen(db, COMPANY, rx.requisitions[0].id);
  ok('a customer-supplied MR has no PR', mrX.supply === 'customer' && mrX.purchaseRequest === null);
  const gx = await PS.receiveLine(db, c, cpo.lines[0].id, { stockingAreaId: G.store });
  const [[lot]] = await db.query('SELECT b.owner_party_id FROM cf_stock_ledger k JOIN cf_stock_batches b ON b.id = k.batch_id WHERE k.movement_id = ? LIMIT 1', [gx.movement.id]);
  ok("its GRN is the customer's lot, earmarked to the MR", Number(lot?.owner_party_id) === Number(G.CUS) && gx.held.length === 1, j([lot, gx.held]));

  /* ════════════════════ 13. nesting gate off ════════════════════ */
  step('13. Nesting saves apply directly — the plate-change gate is off', 'POs cover the first order\'s line. Before §71 a new nesting would have been a request for the MD. Now it is saved at once.');
  const reqBefore = Number((await db.query('SELECT COUNT(*) n FROM cf_plate_change_requests WHERE company_id = ? AND order_line_id = ?', [COMPANY, fx.lineId]))[0][0].n);
  const gateLine = await PC.lineChanges(db, { companyId: COMPANY, userId: user.id }, fx.lineId);
  ok('the line is covered by POs, but nothing needs approval', gateLine.gate.covered === true && gateLine.gate.needsApproval === false && gateLine.gate.on === false, j(gateLine.gate));
  const direct = await PC.plateChangeGate(db, c, fx.lineId, 'upload', { files: asReq(sets.A), dryRun: false, mode: 'replace' });
  const reqAfter = Number((await db.query('SELECT COUNT(*) n FROM cf_plate_change_requests WHERE company_id = ? AND order_line_id = ?', [COMPANY, fx.lineId]))[0][0].n);
  ok('the new nesting (set A, 2 plates) is SAVED directly — no request, no reason asked', direct.applied === true && !direct.requested && reqAfter === reqBefore, j([direct.applied, direct.requested, direct.message]));
  const need2 = (await MRS.lineNeeds(db, COMPANY, await MRS.openLines(db, COMPANY, { orderIds: [fx.orderId] }))).get(fx.lineId);
  table(['Plate', 'The line needs now'], [...need2.items.values()].map((e) => [e.item.code.replace(`${fx.tag}-`, ''), n(e.need)]));
  PC.setPlateChangeGate(true);
  const gated = await refusal(() => PC.plateChangeGate(db, c, fx.lineId, 'upload', { files: asReq(sets.B), dryRun: false, mode: 'replace' }));
  PC.setPlateChangeGate(false);
  ok('(switched on, the same save would ask the MD — the code is kept)', gated?.code === 'PLATE_CHANGE_REASON', gated?.message);
  say('Turned off: the nesting plate-change gate (plateChangeService, constant default off; CF_PLATE_CHANGE_GATE=on turns it back on).');
} finally {
  MRS.setToday(null);
  await db.rollback();
  detachNodeCache(db);
  db.release();
}

const after = await H.counts();
const changed = after.filter((a) => (before.find((b) => b.name === a.name)?.n ?? 0) !== a.n).map((a) => a.name);
ok('ROLLED BACK: every cf_ table has exactly the rows it had', changed.length === 0, changed.join(', '));

const head = [
  '# Purchase flow v3 — a scripted run',
  '',
  `Run \`${tag}\` on the local database, ${new Date().toISOString().slice(0, 16).replace('T', ' ')} (the engine's "today" is ${TODAY}). `
    + 'Everything happened inside ONE database transaction that was rolled back at the end, so nothing of it is left behind. '
    + 'Made by `multi_app_be/scripts/cf_kepl/purchase_flow_v3_test.mjs`. Plates are counted in nos. '
    + '**Locked for this order** = held from stock + received on its POs (earmarked to the order, nobody else can use it). '
    + '**PO raised** = on live purchase orders for that line (a PO closed short counts only what arrived).',
  '',
];
fs.writeFileSync(TRANSCRIPT, [...head, ...md, '', `**Checks: ${H.state.passed} passed, ${H.state.failed} failed.**`, ''].join('\n'));
console.log(`\n${H.state.passed} passed, ${H.state.failed} failed — transcript ${TRANSCRIPT}`);
if (H.state.failed) { console.log(H.state.fails.map((f) => `  - ${f}`).join('\n')); process.exitCode = 1; }
await pool.end();
