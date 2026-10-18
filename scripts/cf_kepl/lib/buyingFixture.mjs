/**
 * buyingFixture.mjs — the fixtures of the Buying v2 suites (init.sql §56):
 * buying_v2_test, buying_v2_scale_test, buying_v2_http_test.
 *
 * EVERY ROW IS THIS RUN'S OWN (tag in every code and name; uq_ccn_sibling is
 * unique on NAME). Nothing of the tenant is borrowed.
 *
 *   simple(db, c)   catalog materials, suppliers, two customers, a store, and
 *                   `order(key, lines)`: a confirmed order whose lines are each
 *                   released by hand (a release row + requirement rows, as
 *                   po_order_link_test does) — one plan unit per line.
 *   girder(db, c)   templates GR → SG ×2 → CL ×4 (made of A, 0.5 each) + BK ×1
 *                   (made of B, 3), and C ×5 straight under the girder; a flow,
 *                   piece-coding rules, a dispatch area. `girderOrder(key, qty)`
 *                   sells N girders on one custom line; frozen, each girder is
 *                   ONE PLAN UNIT needing A 4, B 6, C 5.
 */
import { createItem, createDefinition, updateRecord } from '../../../apps/cf_erp/services/masterRecordService.js';
import { createOrder, addOrderLine, setOrderStatus } from '../../../apps/cf_erp/services/salesOrderService.js';
import { createNode } from '../../../apps/cf_erp/services/classificationService.js';
import * as BOM from '../../../apps/cf_erp/services/bomService.js';
import * as OPS from '../../../apps/cf_erp/services/operationService.js';
import * as FLOWS from '../../../apps/cf_erp/services/flowService.js';
import * as PROC from '../../../apps/cf_erp/services/processService.js';
import { createArea } from '../../../apps/cf_erp/services/stockingAreaService.js';
import { postMovement } from '../../../apps/cf_erp/services/stockService.js';
import { lockLine } from '../../../apps/cf_erp/services/lockService.js';
import * as codegen from '../../../apps/cf_erp/modules/codegen/service.js';

export const PER_GIRDER = { A: 4, B: 6, C: 5 };

/** ok()/count, sections, refusals, table counts — the suites' common harness. */
export function harness(pool) {
  const state = { passed: 0, failed: 0, fails: [] };
  function ok(label, condition, detail = '') {
    if (typeof label !== 'string' || typeof condition !== 'boolean') throw new Error(`ok(label, condition) takes a string and then a boolean — got ${typeof label}, ${typeof condition}`);
    console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${!condition && detail ? ` — ${String(detail).slice(0, 700)}` : ''}`);
    if (condition) state.passed += 1; else { state.failed += 1; state.fails.push(label); }
  }
  const section = (s) => console.log(`\n${s}`);
  const says = (s) => console.log(`        says: ${s}`);
  async function refusal(fn) { try { await fn(); return null; } catch (e) { return e; } }
  const j = (v) => JSON.stringify(v);
  let tables = null;
  const counts = async () => {
    if (!tables) [tables] = await pool.query("SELECT TABLE_NAME name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME LIKE 'cf\\_%' ORDER BY TABLE_NAME");
    return (await pool.query(tables.map((t) => `SELECT '${t.name}' AS name,COUNT(*) AS n FROM \`${t.name}\``).join(' UNION ALL ')))[0];
  };
  /** A connection that counts the round trips made through it. */
  const counting = (db) => {
    const tally = { n: 0 };
    const proxy = new Proxy(db, { get: (t, p) => (p === 'query' || p === 'execute' ? (...a) => { tally.n += 1; return t[p](...a); } : Reflect.get(t, p)) });
    return { db: proxy, tally };
  };
  const measured = async (db, fn) => { const m = counting(db); const result = await fn(m.db); return { result, queries: m.tally.n }; };
  return { state, ok, section, says, refusal, j, counts, counting, measured };
}

const addDays = (iso, n) => { const [y, m, d] = iso.split('-').map(Number); const x = new Date(y, m - 1, d + n); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; };
export { addDays };

async function family(db, c, tag) {
  const fam = await createNode(db, c, { code: `${tag}-F`, name: `Buying fixture ${tag}` });
  const sub = await createNode(db, c, { parentId: fam.id, code: `${tag}-S`, name: `Buying fixture kinds ${tag}` });
  const variant = async (key, name) => createNode(db, c, { parentId: sub.id, code: `${tag}-V${key}`, name: `${name} ${tag}` });
  return { fam, sub, variant };
}

/** A process of this run with a Buying stage, to stamp on its orders (orderProcess reads the order's own process). */
export async function ownProcess(db, c, tag) {
  const prc = await PROC.createProcess(db, c, { code: `${tag}-PRC`, name: `Buying test ${tag}` });
  await PROC.replaceStages(db, c, prc.id, { stages: ['structure', 'values', 'lock', 'nesting', 'buying', 'production'].map((stageKey) => ({ stageKey })) });
  await PROC.setProcessStatus(db, c, prc.id, 'active');
  return prc;
}

/** The orders' code schemes are switched off for the transaction: this run numbers its own documents. */
export async function quietCodes(db, companyId, entityTypes = ['purchase_order', 'sales_order', 'stock_movement']) {
  await db.query("UPDATE cf_code_schemes SET status = 'inactive' WHERE company_id = ? AND entity_type IN (?)", [companyId, entityTypes]);
}

export async function simple(db, c, tag, { itemKeys = ['A', 'B', 'C'] } = {}) {
  const ins = async (sql, params) => (await db.query(sql, params))[0].insertId;
  const { variant } = await family(db, c, `${tag}S`);
  const mat = await variant('M', 'Materials');
  const fgNode = await variant('G', 'Finished');
  const items = {};
  const item = async (key, node = mat.id) => {
    if (!items[key]) items[key] = (await createItem(db, c, { itemType: 'catalog', classificationId: node, code: `${tag}-${key}`, name: `${tag} material ${key}`, uom: 'kg', status: 'active' })).id;
    return items[key];
  };
  for (const k of itemKeys) await item(k);
  const FG = await item('FG', fgNode.id);
  const party = (key, role) => ins(`INSERT INTO cf_parties (company_id, code, name, ${role}, status) VALUES (?, ?, ?, 1, 'active')`, [c.companyId, `${tag}-${key}`, `${tag} ${key}`]);
  const S1 = await party('S1', 'is_supplier');
  const S2 = await party('S2', 'is_supplier');
  const CUS = await party('CUS', 'is_customer');
  const CUS2 = await party('CUS2', 'is_customer');
  const store = (await createArea(db, c, { code: `${tag}-ST`, name: `${tag} store`, purpose: 'storage' })).id;
  const prc = await ownProcess(db, c, `${tag}S`);
  /**
   * A confirmed order; each entry of `lines` is one order line, released by hand
   * with those requirements: [[itemId, qty], …]. → { id, code, lines: [{ id, lineNo, releaseId, unitKey }] }.
   */
  const order = async (key, lines, { customer = CUS, committed = '2099-12-31', status = 'confirmed' } = {}) => {
    const so = await createOrder(db, c, { orderType: 'customer', customerId: customer, code: `${tag}-${key}`, committedDate: committed });
    let o = so;
    for (let i = 0; i < lines.length; i++) o = await addOrderLine(db, c, so.id, { recordId: FG, quantity: 1 });
    await db.query('UPDATE cf_sales_orders SET process_id = ? WHERE id = ?', [prc.id, so.id]);
    if (status === 'confirmed') await setOrderStatus(db, c, so.id, 'confirmed');
    const out = [];
    for (const [i, reqs] of lines.entries()) {
      const l = o.lines[i];
      const rel = await ins('INSERT INTO cf_production_releases (company_id, order_id, order_line_id, item_id, quantity) VALUES (?, ?, ?, ?, 1)', [c.companyId, so.id, l.id, FG]);
      for (const [it, qty] of reqs) await ins('INSERT INTO cf_material_requirements (company_id, release_id, item_id, quantity) VALUES (?, ?, ?, ?)', [c.companyId, rel, it, qty]);
      out.push({ id: l.id, lineNo: l.lineNo ?? l.line_no ?? i + 1, releaseId: rel, unitKey: `l${l.id}` });
    }
    return { id: so.id, code: `${tag}-${key}`, lines: out, line: out[0] };
  };
  const receive = (itemId, quantity) => postMovement(db, c, { movementType: 'receipt', toAreaId: store, lines: [{ itemId, quantity, unitCost: 10 }] });
  return { items, item, FG, S1, S2, CUS, CUS2, store, order, receive, prc };
}

const tok = (key, extra = {}) => ({ segmentType: 'token', tokenKey: key, transform: 'none', isRequired: true, ...extra });
const lit = (text) => ({ segmentType: 'literal', literalText: text });

export async function girder(db, c, tag) {
  const { fam, variant } = await family(db, c, `${tag}G`);
  const v = { assy: await variant('A', 'Assemblies'), seg: await variant('S', 'Segments'), part: await variant('P', 'Parts'), mat: await variant('M', 'Material') };
  // Every other item / piece coding rule of the company is off for the transaction: this run's rules code its pieces.
  await db.query("UPDATE cf_code_schemes SET status = 'inactive' WHERE company_id = ? AND entity_type IN ('item', 'production_piece') AND status = 'active'", [c.companyId]);
  const op = await OPS.createOperation(db, c, { code: `${tag}-OP`, name: `Make ${tag}` });
  const flow = await FLOWS.createFlow(db, c, { code: `${tag}-FL`, name: `Make ${tag}` });
  await FLOWS.addStep(db, c, flow.id, { operationId: op.id });
  await FLOWS.setFlowStatus(db, c, flow.id, 'active');
  const material = async (key) => (await createItem(db, c, { itemType: 'catalog', classificationId: v.mat.id, code: `${tag}-M${key}`, name: `${tag} girder material ${key}`, shortName: `M${key}`, uom: 'kg', status: 'active' })).id;
  const A = await material('A');
  const B = await material('B');
  const C = await material('C');
  const tpl = async (code, name, shortName, classificationId) => {
    const d = await createDefinition(db, c, { definitionType: 'template', classificationId, code: `${tag}-${code}`, name: `${name} ${tag}`, shortName, status: 'active' });
    await updateRecord(db, c, d.id, { defaultFlowId: flow.id });
    return d;
  };
  const CL = await tpl('CL', 'Cleat', 'CL', v.part.id);
  const BK = await tpl('BK', 'Bracket', 'BK', v.part.id);
  const SG = await tpl('SG', 'Segment', 'SG', v.seg.id);
  const GR = await tpl('GR', 'Girder', 'GR', v.assy.id);
  await BOM.addLine(db, c, CL.id, { childId: A, quantity: 0.5 });
  await BOM.setBomStatus(db, c, CL.id, 'active');
  await BOM.addLine(db, c, BK.id, { childId: B, quantity: 3 });
  await BOM.setBomStatus(db, c, BK.id, 'active');
  await BOM.addLine(db, c, SG.id, { childId: CL.id, quantity: 4, role: 'Cleats' });
  await BOM.addLine(db, c, SG.id, { childId: BK.id, quantity: 1, role: 'Bracket' });
  await BOM.setBomStatus(db, c, SG.id, 'active');
  await BOM.addLine(db, c, GR.id, { childId: SG.id, quantity: 2, role: 'Segments' });
  await BOM.addLine(db, c, GR.id, { childId: C, quantity: 5 });
  await BOM.setBomStatus(db, c, GR.id, 'active');
  const temporary = { tokenKey: 'kind', operator: 'eq', value: 'temporary' };
  const underFam = { tokenKey: 'classification', operator: 'under', value: String(fam.id) };
  const pieceRule = (code, body) => codegen.createScheme(db, c.companyId, c.userId, {
    code: `${tag}-${code}`, name: `Buying test ${code} ${tag}`, entityType: 'production_piece', targetField: 'code', seqScope: 'prefix', priority: 0, status: 'active', ...body,
  });
  await pieceRule('PTOP', { conditions: [temporary, { tokenKey: 'placement', operator: 'eq', value: 'line' }, underFam], segments: [tok('order.code'), lit('-'), tok('item.shortName'), lit('-'), tok('line.position', { format: '00' }), lit('-'), tok('piece.seq')] });
  await pieceRule('PPART', { conditions: [{ tokenKey: 'placement', operator: 'eq', value: 'component' }, underFam], segments: [tok('parent.code'), lit('-'), tok('item.shortName'), tok('piece.seq')] });
  const ins = async (sql, params) => (await db.query(sql, params))[0].insertId;
  const CUS = await ins("INSERT INTO cf_parties (company_id, code, name, is_customer, status) VALUES (?, ?, ?, 1, 'active')", [c.companyId, `${tag}-GCUS`, `${tag} girder customer`]);
  const SUP = await ins("INSERT INTO cf_parties (company_id, code, name, is_supplier, status) VALUES (?, ?, ?, 1, 'active')", [c.companyId, `${tag}-GSUP`, `${tag} girder supplier`]);
  const dispatch = (await createArea(db, c, { code: `${tag}-GDSP`, name: `${tag} dispatch`, purpose: 'dispatch' })).id;
  const store = (await createArea(db, c, { code: `${tag}-GST`, name: `${tag} girder store`, purpose: 'storage' })).id;
  const prc = await ownProcess(db, c, `${tag}G`);
  /**
   * An order selling `quantity` girders on one custom line, frozen (and confirmed unless told not to).
   * → { id, code, lineId, units: ['p<piece>' …] in piece order }
   */
  const girderOrder = async (key, quantity, { status = 'confirmed', lock = true, committed = '2099-12-31' } = {}) => {
    const so = await createOrder(db, c, { orderType: 'customer', customerId: CUS, code: `${tag}-${key}`, committedDate: committed });
    const o = await addOrderLine(db, c, so.id, { recordId: GR.id, quantity });
    await db.query('UPDATE cf_sales_orders SET process_id = ? WHERE id = ?', [prc.id, so.id]);
    const lineId = o.lines[0].id;
    if (lock) await lockLine(db, c, lineId);
    if (status === 'confirmed') await setOrderStatus(db, c, so.id, 'confirmed');
    return { id: so.id, code: `${tag}-${key}`, lineId, lineKey: `l${lineId}`, units: lock ? await unitsOf(db, c.companyId, lineId) : [] };
  };
  const receive = (itemId, quantity) => postMovement(db, c, { movementType: 'receipt', toAreaId: store, lines: [{ itemId, quantity, unitCost: 10 }] });
  return { A, B, C, CL, BK, SG, GR, CUS, SUP, dispatch, store, flow, op, girderOrder, receive, prc };
}

/** The plan units of a frozen girder line: its top pieces (one girder each), in piece order. */
export async function unitsOf(db, companyId, lineId) {
  const [rows] = await db.query('SELECT id FROM cf_order_pieces WHERE company_id = ? AND order_line_id = ? AND parent_id IS NULL AND deleted_at IS NULL ORDER BY sort_order, id', [companyId, lineId]);
  return rows.map((r) => `p${r.id}`);
}

/** A plain receipt into a store (no order named), for a fixture that is already committed. */
export const receiveInto = (db, c, storeId, itemId, quantity) => postMovement(db, c, { movementType: 'receipt', toAreaId: storeId, lines: [{ itemId, quantity, unitCost: 10 }] });

/**
 * §71: the suites' way to put MR lines on a purchase order now that the only way is the PR — save the MR (makes / updates
 * its PR), a vendor column, a quote per line (delivery days = the date asked − today), Raise PO (several MRs → one PO
 * through addToPoId), the PO's own date, then the MD's approval when `place`. Answers like the old makePurchaseOrders:
 * { purchaseOrders: [purchaseOrdersBrief] }. No supplierId → a supplier party of the run is made.
 * lines: [{ prLineId, quantity?, expectedDate?, unitPrice? }] (prLineId = the MR line).
 */
export async function buyThroughPr(db, c, { supplierId = null, expectedDate = null, place = true, lines = [] } = {}) {
  const PRS = await import('../../../apps/cf_erp/services/purchaseRequestService.js');
  const PS = await import('../../../apps/cf_erp/services/purchaseService.js');
  const RQ = await import('../../../apps/cf_erp/services/requisitionService.js');
  const { today } = await import('../../../apps/cf_erp/services/materialReadyService.js');
  let sid = supplierId;
  if (!sid) {
    const [r] = await db.query("INSERT INTO cf_parties (company_id, code, name, is_supplier, status) VALUES (?, ?, ?, 1, 'active')", [c.companyId, `PRBUY-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, 'PR buy test supplier']);
    sid = r.insertId;
  }
  const [rows] = await db.query('SELECT id, requisition_id FROM cf_requisition_lines WHERE company_id = ? AND id IN (?)', [c.companyId, lines.map((l) => l.prLineId)]);
  const reqOf = new Map(rows.map((r) => [Number(r.id), Number(r.requisition_id)]));
  // Consecutive lines of one MR go in one Raise PO, in the order given (the PO lines' shares keep that order).
  const groups = [];
  for (const l of lines) { const k = reqOf.get(Number(l.prLineId)); const last = groups.at(-1); if (last && last[0] === k) last[1].push(l); else groups.push([k, [l]]); }
  const t = today();
  const days = (d) => { if (!d) return null; const a = Date.UTC(...t.split('-').map((x, i) => Number(x) - (i === 1 ? 1 : 0))); const b = Date.UTC(...String(d).slice(0, 10).split('-').map((x, i) => Number(x) - (i === 1 ? 1 : 0))); return Math.max(0, Math.round((b - a) / 86400000)); };
  let poId = null;
  for (const [reqId, group] of groups) {
    await PRS.saveMr(db, c, reqId, { lines: [] });
    let pr = (await PRS.readPrs(db, c.companyId, { requisitionIds: [reqId] }))[0];
    if (!pr.vendors.some((v) => Number(v.supplier.id) === Number(sid))) pr = await PRS.addVendor(db, c, pr.id, { supplierId: sid });
    const col = pr.vendors.find((v) => Number(v.supplier.id) === Number(sid));
    const prLineOf = (l) => pr.lines.find((x) => Number(x.mrLineId) === Number(l.prLineId));
    await PRS.setQuotes(db, c, col.id, { quotes: group.map((l) => ({ lineId: prLineOf(l).id, rate: l.unitPrice ?? 1, deliveryDays: days(l.expectedDate) })) });
    const r = await PRS.raisePo(db, c, col.id, { lines: group.map((l) => ({ lineId: prLineOf(l).id, quantity: l.quantity ?? prLineOf(l).open })), addToPoId: poId });
    poId = r.purchaseOrder.id;
  }
  if (expectedDate) await PS.updatePurchaseOrder(db, c, poId, { expectedDate });
  if (place) await PS.approvePurchaseOrder(db, c, poId, {});
  return { purchaseOrders: await RQ.purchaseOrdersBrief(db, c.companyId, [poId]) };
}
