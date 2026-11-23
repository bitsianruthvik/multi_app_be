/**
 * Builds the ERP dashboard's base data (the "D" that V13 carried inside its HTML) straight from the ERP tables,
 * so the nightly run needs no V13 file. Same shape and meaning as V13's D (decoded and checked against it):
 *
 *   items [no, cust, part, metal, kg per piece, batch day, qty, steps[12], type, order-line index]
 *     steps: 1 assembly, 2 coating, 3 de-waxing, 4 melting, 5 heat treatment (final pass, +HT-vendor flag),
 *            6 final inspection, 7 cleared, 8 machining inspection, 9 injection, 10 knock-out, 11 injection rejections [day, pieces, 0]; rows [day, processed, good]
 *   rej [day, stage, reason, item, qty]   ord / wo / ol order and work-order lines   disp dispatch per order line
 *   vend challan lines out (with receipts)   rcv receipts   rfd finished-store stock   crej customer rejections
 * Days count from 2024-01-01. Windows follow V13: batch items made from Jul 2023 or with any entry from 2024,
 * orders and work orders from 2023, dispatch / challans / receipts / customer rejections from 2024, store stock
 * entered from 21 Oct 2024. hist.mjs then adds the earlier years.
 *
 *   node build-d.mjs            reads SUMANGAL_DB (default D:/SumangalData/work/casting.sqlite), writes <work>/v13-data.js
 *
 * The ERP copy is only read. Every query is a SELECT.
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'fs';
const WORK = process.env.SUMANGAL_WORK || 'D:/SumangalData/work';
const DB = process.env.SUMANGAL_DB || 'D:/SumangalData/work/casting.sqlite';
const db = new DatabaseSync(DB, { readOnly: true });
const all = (q) => db.prepare(q).all();
const D0 = Date.UTC(2024, 0, 1);
const day = (x) => (x ? Math.round((Date.UTC(+x.slice(0, 4), +x.slice(5, 7) - 1, +x.slice(8, 10)) - D0) / 864e5) : null);
const n = (x) => Math.round(+x || 0);
const r3 = (x) => +(+x || 0).toFixed(3);

// ---- dictionaries
const idx = () => { const m = new Map(), a = []; return { a, get(k, v) { if (!m.has(k)) { m.set(k, a.length); a.push(v); } return m.get(k); } }; };
const custRows = new Map(all('select customer_id, trim(customer_name) nm from tbl_customer_master').map((r) => [r.customer_id, r.nm]));
const cust = idx(); const C = (id) => cust.get(custRows.has(id) ? id : 0, custRows.get(id) || 'Unknown');
const dies = new Map(all('select die_id, trim(die_no) no, trim(coalesce(die_description,\'\')) ds, raw_casting_weight w, customer_id c from tbl_die_master').map((r) => [r.die_id, r]));
const part = idx(); const PT = (dieId) => { const d = dies.get(dieId); if (!d) return -1; return part.get(d.no, [d.no, d.ds, r3(d.w), 0, C(d.c)]); };
const castW = (dieId) => +(dies.get(dieId)?.w || 0);
const METALS = ['Stainless Steel', 'Carbon Steel', 'Mild Steel', 'Not set', 'Cast Iron', 'Duplex Steel'];
const cmb = new Map(all('select cmb_id, trim(cmb_value) v from tbl_combobox_master').map((r) => [r.cmb_id, r.v]));
const cmGroup = new Map(all('select cm.customer_metal_id id, mm.casting_type_cmb_id ct from tbl_customer_metal_master cm left join tbl_metal_master mm on mm.metal_id=cm.metal_id').map((r) => [r.id, r.ct]));
const metalOf = (cm) => { const i = METALS.indexOf(cmb.get(cmGroup.get(cm)) || ''); return i >= 0 ? i : METALS.indexOf('Not set'); };
const TYPES = ['Machining', 'Non-machining', 'Zn', 'PM'];
const typeOf = (ct) => { ct = String(ct || '').toUpperCase().replace(/\s/g, ''); return /^FM/.test(ct) ? 0 : ct === 'PM' ? 3 : ct === 'ZN' ? 2 : 1; };

// ---- order lines, work orders
const ol = all(`select d.order_item_id oi, trim(m.order_no) no, substr(m.order_date,1,10) od, m.customer_id c, d.die_id, d.customer_metal_id cm, d.order_quantity q, substr(d.delivery_date,1,10) dd, d.casting_type ct, d.is_short_close sc, d.die_invoice_type dit from tbl_order_acceptance_detail d join tbl_order_acceptance_master m using(order_id)`);
const olById = new Map(ol.map((r) => [r.oi, r]));
const dispByOi = new Map(); for (const r of all(`select o.order_item_id oi, substr(m.dispatch_date,1,10) d, sum(o.dispatch_quantity) q from tbl_dispatch_oa_detail o join tbl_dispatch_intimation_master m using(dispatch_id) group by 1,2 order by 2`)) (dispByOi.get(r.oi) || dispByOi.set(r.oi, []).get(r.oi)).push([day(r.d), n(r.q)]);
const woRowsByOi = new Map(); for (const r of all(`select d.order_item_id oi, substr(w.work_order_date,1,10) d, d.order_quantity q from tbl_work_order_detail d join tbl_work_order_master w using(work_order_id) where d.order_item_id>0 order by 2`)) (woRowsByOi.get(r.oi) || woRowsByOi.set(r.oi, []).get(r.oi)).push([day(r.d), n(r.q)]);
const OL = []; const olIx = new Map();
const OLI = (oi) => { if (oi == null || !olById.has(oi)) return -1; if (!olIx.has(oi)) { const r = olById.get(oi); olIx.set(oi, OL.length); OL.push([n(r.q), r.sc ? 1 : 0, dispByOi.get(oi) || [], r.dit === 2 ? 1 : 0]); } return olIx.get(oi); };
const woLines = all(`select d.work_order_item_id wi, trim(w.work_order_no) no, substr(w.work_order_date,1,10) d, w.work_order_type_value t, d.order_item_id oi, d.die_id, d.customer_metal_id cm, d.order_quantity q, d.casting_type ct, substr(d.short_close_date,1,10) scd, d.short_close_quantity scq from tbl_work_order_detail d join tbl_work_order_master w using(work_order_id)`);
const woById = new Map(woLines.map((r) => [r.wi, r]));
const batchesByWi = new Map(); for (const r of all(`select work_order_item_id wi, substr(batch_date,1,10) d, batch_quantity q from tbl_batch_master where work_order_item_id>0 order by 2`)) (batchesByWi.get(r.wi) || batchesByWi.set(r.wi, []).get(r.wi)).push([day(r.d), n(r.q)]);

// ---- batch items: made from Jul 2023, or with any step entry from 2024
const SLOT = {
  1: `select batch_item_id id, substr(asmbly_prod_date,1,10) d, asmbly_quantity q, net_quantity g from tbl_assembly_production`,
  2: `select batch_item_id id, substr(coating_prod_date,1,10) d, coating_quantity q, net_quantity g from tbl_coating_production`,
  3: `select batch_item_id id, substr(dwx_prod_date,1,10) d, dwx_quantity q, net_quantity g from tbl_dewaxing_production`,
  4: `select d.batch_item_id id, substr(m.melting_date,1,10) d, d.melting_quantity q, d.net_quantity g from tbl_melting_production_detail d join tbl_melting_production_master m using(melting_prod_id)`,
  5: `select d.batch_item_id id, substr(m.heat_treatment_date,1,10) d, d.ht_qty q, d.ht_qty g, (m.supplier_id>0) f from tbl_heat_treatment_detail d join tbl_heat_treatment_master m using(heat_treatment_id) where d.next_fix_process_id=14`,
  6: `select batch_item_id id, substr(insp_prod_date,1,10) d, insp_quantity q, net_quantity g from tbl_inspection_production`,
  7: `select batch_item_id id, substr(dispatch_authorize_date,1,10) d, authorize_quantity q, authorize_quantity g from tbl_dispatch_authorization`,
  8: `select batch_item_id id, substr(machining_insp_date,1,10) d, machining_insp_quantity q, net_quantity g from tbl_machining_inspection`,
  9: `select batch_item_id id, substr(inj_prod_date,1,10) d, inj_quantity q, net_quantity g from tbl_injection_production`,
  10: `select batch_item_id id, substr(fettling_date,1,10) d, fettling_quantity q, net_quantity g from tbl_fettling_production`,
};
const stepRows = {}; const lastAct = new Map();
for (const [slot, q] of Object.entries(SLOT)) { stepRows[slot] = all(q); for (const r of stepRows[slot]) { const d = r.d || ''; if (d > (lastAct.get(r.id) || '')) lastAct.set(r.id, d); } }
const bd = all(`select d.batch_item_id id, trim(d.batch_item_no) no, d.batch_quantity q, d.die_id, d.customer_metal_id cm, d.raw_casting_weight w, substr(m.batch_date,1,10) bd, m.customer_id c, m.work_order_item_id wi from tbl_batch_detail d join tbl_batch_master m using(batch_id) order by d.batch_item_id`);
const keep = bd.filter((r) => r.bd >= '2023-07-01' || (lastAct.get(r.id) || '') >= '2024-01-01');
const itemIx = new Map(); const items = [];
for (const r of keep) {
  const w = woById.get(r.wi); const o = w && w.oi ? olById.get(w.oi) : null; const p = PT(r.die_id); if (p < 0) continue;
  const t = o ? typeOf(o.ct) : 1; // V13: a batch item with no order line counts as non-machining
  itemIx.set(r.id, items.length);
  items.push([r.no, C(r.c || dies.get(r.die_id)?.c), p, metalOf(r.cm), r3(+r.w || castW(r.die_id)), day(r.bd), n(r.q), Array.from({ length: 12 }, () => []), t, o ? OLI(o.oi) : -1]);
}
for (const [slot, rows] of Object.entries(stepRows)) for (const r of rows) { const i = itemIx.get(r.id); if (i == null) continue; const row = [day(r.d), n(r.q), n(r.g)]; if (+slot === 5) row.push(r.f ? 1 : 0); items[i][7][slot].push(row); }
// slot 11: wax patterns rejected at injection, by day [day, pieces, 0] (taken off before assembly)
for (const r of all(`select p.batch_item_id id, substr(p.inj_prod_date,1,10) d, sum(r.inj_rejection_quantity) q from tbl_injection_production_rejection r join tbl_injection_production p using(inj_prod_id) group by 1,2`)) { const i = itemIx.get(r.id); if (i != null && n(r.q)) items[i][7][11].push([day(r.d), n(r.q), 0]); }
for (const it of items) for (const st of it[7]) st.sort((a, b) => a[0] - b[0]);
// part type: the type most of its batch items carry
{ const v = new Map(); for (const it of items) { const m = v.get(it[2]) || v.set(it[2], new Map()).get(it[2]); m.set(it[8], (m.get(it[8]) || 0) + 1); } for (const [p, m] of v) part.a[p][3] = [...m.entries()].sort((a, b) => b[1] - a[1])[0][0] === 0 ? 1 : 0; }

// ---- rejections
const reasons = new Map(all('select r.rejection_id id, trim(r.reason_name) nm, trim(coalesce(d.department_name,\'Not set\')) dp from tbl_rejection_master r left join tbl_department_master d using(department_id)').map((r) => [r.id, r]));
const rsn = idx(); const rdep = []; const RS = (id) => { const r = reasons.get(id); const nm = r ? r.nm : 'No reason'; const i = rsn.get(nm, nm); if (rdep.length <= i) rdep.push(r ? r.dp : 'Not set'); return i; };
const REJ = [[0, `select p.batch_item_id id, substr(p.inj_prod_date,1,10) d, r.rejection_id x, r.inj_rejection_quantity q from tbl_injection_production_rejection r join tbl_injection_production p using(inj_prod_id)`],
  [1, `select p.batch_item_id id, substr(p.asmbly_prod_date,1,10) d, r.rejection_id x, r.rejection_quantity q from tbl_assembly_rejection r join tbl_assembly_production p using(asmbly_prod_id)`],
  [2, `select p.batch_item_id id, substr(p.coating_prod_date,1,10) d, r.rejection_id x, r.rejection_quantity q from tbl_coating_rejection r join tbl_coating_production p using(coating_prod_id)`],
  [3, `select p.batch_item_id id, substr(p.dwx_prod_date,1,10) d, r.rejection_id x, r.rejection_quantity q from tbl_dewaxing_rejection r join tbl_dewaxing_production p using(dwx_prod_id)`],
  [4, `select x.batch_item_id id, substr(m.melting_date,1,10) d, r.rejection_id x, r.rejection_quantity q from tbl_melting_rejection r join tbl_melting_production_detail x using(melting_prod_item_id) join tbl_melting_production_master m using(melting_prod_id)`],
  [5, `select p.batch_item_id id, substr(p.fettling_date,1,10) d, r.rejection_id x, r.rejection_quantity q from tbl_fettling_rejection r join tbl_fettling_production p using(fettling_prod_id)`],
  [6, `select p.batch_item_id id, substr(p.insp_prod_date,1,10) d, r.rejection_id x, r.rejection_quantity q from tbl_inspection_rejection r join tbl_inspection_production p using(insp_prod_id)`],
  [7, `select p.batch_item_id id, substr(p.machining_insp_date,1,10) d, r.rejection_id x, r.rejection_quantity q from tbl_machining_inspection_rejection r join tbl_machining_inspection p using(machining_insp_id)`]];
const rej = []; for (const [st, q] of REJ) for (const r of all(q)) { const i = itemIx.get(r.id); if (i == null || !n(r.q)) continue; rej.push([day(r.d), st, RS(r.x), i, n(r.q)]); }
const dtgt = {}; for (const r of all(`select trim(dm.department_name) nm, c.rej_per p, c.effective_date e from tbl_department_wise_rejection_control c join tbl_department_master dm on dm.department_unique_id=c.department_unique_id_fix order by c.effective_date`)) dtgt[r.nm] = +r.p;

// ---- orders (from 2023) and work orders (from 2023)
const ord = ol.filter((r) => r.od >= '2023-01-01' && !r.sc && r.dit !== 2).map((r) => { const p = PT(r.die_id); if (p < 0) return null; return [r.oi, r.no, day(r.od), C(r.c), p, metalOf(r.cm), n(r.q), r3(castW(r.die_id)), day(r.dd), typeOf(r.ct), woRowsByOi.get(r.oi) || [], dispByOi.get(r.oi) || []]; }).filter(Boolean);
const wo = woLines.filter((r) => r.d >= '2023-01-01').map((r) => { const o = r.oi ? olById.get(r.oi) : null; const p = PT(r.die_id); if (p < 0) return null; return [r.no, C(o ? o.c : dies.get(r.die_id)?.c), p, metalOf(r.cm), r3(castW(r.die_id)), day(r.d), n(r.q), batchesByWi.get(r.wi) || [], r.scd ? day(r.scd) : null, n(r.scq), typeOf(o ? o.ct : r.ct), o ? OLI(o.oi) : -1]; }).filter(Boolean);

// ---- dispatch per order line (from 2024)
const disp = []; for (const r of all(`select o.order_item_id oi, substr(m.dispatch_date,1,10) d, m.customer_id c, o.die_id, sum(o.dispatch_quantity) q from tbl_dispatch_oa_detail o join tbl_dispatch_intimation_master m using(dispatch_id) where substr(m.dispatch_date,1,10)>='2024-01-01' group by m.dispatch_id,1,2,3,4`)) {
  const o = olById.get(r.oi); const p = PT(r.die_id); if (p < 0) continue; disp.push([day(r.d), C(r.c), p, o ? metalOf(o.cm) : METALS.indexOf('Not set'), n(r.q), +(n(r.q) * castW(r.die_id)).toFixed(1), r.oi, o ? typeOf(o.ct) : 1]); }

// ---- job-work challans and receipts (from 2024); contract fettling from its own challans
const vend = idx(); const supp = new Map(all('select supplier_id, trim(supplier_name) nm from tbl_supplier_master').map((r) => [r.supplier_id, r.nm]));
const procs = idx(); for (const r of all('select trim(process_name) n from tbl_for_process_master order by for_process_id')) procs.get(r.n, r.n);
const CF = procs.get('Contract fettling (in-house)', 'Contract fettling (in-house)');
const CONTRACTOR = { 1: 'Fettling contractor A - SCPL', 2: 'Fettling contractor B - SCPL' };
const vendLines = [], rcv = [];
const ins = new Map(); for (const r of all(`select d.manual_casting_outward_detail_id oid, substr(m.manual_casting_inward_date,1,10) d, d.inward_quantity q, d.total_rejection_quantity rj, d.waste_scrap sc from tbl_manual_casting_inward_detail d join tbl_manual_casting_inward_master m using(manual_casting_inward_id)`)) (ins.get(r.oid) || ins.set(r.oid, []).get(r.oid)).push(r);
for (const r of all(`select d.manual_casting_outward_detail_id oid, substr(o.manual_casting_outward_date,1,10) d, o.supplier_id s, trim(f.process_name) pn, d.die_id, d.outward_quantity q from tbl_manual_casting_outward_detail d join tbl_manual_casting_outward_master o using(manual_casting_outward_id) left join tbl_for_process_master f using(for_process_id) where o.is_cancel=0`)) {
  const inWin = r.d >= '2024-01-01' || (ins.get(r.oid) || []).some((x) => x.d >= '2024-01-01'); if (!inWin || !r.pn) continue;
  const p = PT(r.die_id); if (p < 0) continue; const pr = procs.get(r.pn, r.pn); const v = vend.get(supp.get(r.s) || '?', supp.get(r.s) || '?'); const sd = day(r.d);
  const rc = (ins.get(r.oid) || []).map((x) => [day(x.d), n(x.q)]).sort((a, b) => a[0] - b[0]);
  if (r.d >= '2024-01-01') vendLines.push([v, pr, p, sd, n(r.q), +(n(r.q) * castW(r.die_id)).toFixed(1), rc.length ? rc[rc.length - 1][0] : null, rc.reduce((t, x) => t + x[1], 0), rc]);
  for (const x of ins.get(r.oid) || []) if (x.d >= '2024-01-01') rcv.push([day(x.d), v, pr, p, n(x.q), n(x.rj), +(n(x.q) * castW(r.die_id)).toFixed(1), +(+x.sc || 0).toFixed(2)]);
}
{
  const fin = new Map(); for (const r of all(`select x.manual_fettling_outward_detail_id id, substr(m.manual_fettling_inward_date,1,10) d, x.reveive_qty q, x.rejection_qty rj from tbl_manual_fettling_inward_detail x join tbl_manual_fettling_inward_master m using(manual_fettling_inward_id)`)) (fin.get(r.id) || fin.set(r.id, []).get(r.id)).push(r);
  for (const r of all(`select x.manual_fettling_outward_detail_id id, substr(m.manual_fettling_outward_date,1,10) d, m.from_id src, x.die_id, x.issue_qty q from tbl_manual_fettling_outward_detail x join tbl_manual_fettling_outward_master m using(manual_fettling_outward_id)`)) {
    if (r.d < '2024-01-01' && !(fin.get(r.id) || []).some((x) => x.d >= '2024-01-01')) continue;
    const p = PT(r.die_id); if (p < 0) continue; const nm = CONTRACTOR[r.src] || `Fettling contractor (ERP code ${r.src})`; const v = vend.get(nm, nm);
    const rc = (fin.get(r.id) || []).map((x) => [day(x.d), n(x.q)]).sort((a, b) => a[0] - b[0]);
    if (r.d >= '2024-01-01') vendLines.push([v, CF, p, day(r.d), n(r.q), +(n(r.q) * castW(r.die_id)).toFixed(1), rc.length ? rc[rc.length - 1][0] : null, rc.reduce((t, x) => t + x[1], 0), rc]);
    for (const x of fin.get(r.id) || []) if (x.d >= '2024-01-01') rcv.push([day(x.d), v, CF, p, n(x.q), n(x.rj), +(n(x.q) * castW(r.die_id)).toFixed(1), 0]);
  }
}

// ---- finished-store stock (entered from 21 Oct 2024) and customer rejections (from 2024)
const rfd = all(`select substr(entry_date,1,10) d, customer_id c, die_id, customer_metal_id cm, trim(coalesce(heat_no,'')) h, stock, casting_type ct from tbl_production_store where store_type=2 and stock>0 and substr(entry_date,1,10)>='2024-10-21'`)
  .map((r) => { const p = PT(r.die_id); if (p < 0) return null; return [day(r.d), C(r.c), p, metalOf(r.cm), r.h, n(r.stock), +(n(r.stock) * castW(r.die_id)).toFixed(1), typeOf(r.ct)]; }).filter(Boolean);
const crej = all(`select substr(customer_reject_date,1,10) d, customer_id c, die_id, trim(coalesce(heat_no,'')) h, reject_quantity q, trim(coalesce(nullif(rejection_reason,''), remark, '')) r from tbl_customer_rejection where substr(customer_reject_date,1,10)>='2024-01-01'`)
  .map((r) => { const p = PT(r.die_id); if (p < 0) return null; return [day(r.d), C(r.c), p, r.h, n(r.q), +(n(r.q) * castW(r.die_id)).toFixed(1), r.r.slice(0, 80)]; }).filter(Boolean);

const end = all(`select max(d) d from (select max(substr(insp_prod_date,1,10)) d from tbl_inspection_production union all select max(substr(melting_date,1,10)) from tbl_melting_production_master union all select max(substr(dispatch_date,1,10)) from tbl_dispatch_intimation_master)`)[0].d;
const D = { ol: OL, rdep, dtgt, types: TYPES, wo, rej, rsn: rsn.a, rstg: ['Injection', 'Wax assembly', 'Coating', 'De-waxing', 'Melting', 'Knock-out', 'Final inspection', 'Machining inspection'], crej, ord, rcv, d0: '2024-01-01', end, cust: cust.a, parts: part.a, metals: METALS, vendors: vend.a, procs: procs.a, items, disp, rfd, vend: vendLines };
fs.writeFileSync(`${WORK}/v13-data.js`, 'const D=' + JSON.stringify(D) + ';');
console.log({ end, items: items.length, ord: ord.length, wo: wo.length, ol: OL.length, rej: rej.length, disp: disp.length, vend: vendLines.length, rcv: rcv.length, rfd: rfd.length, crej: crej.length, cust: cust.a.length, parts: part.a.length });
