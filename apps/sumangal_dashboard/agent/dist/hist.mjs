// History from 1 Jan 2022 in V13's data format, plus short customer names and part numbers. Read-only on the ERP copy.
import { DatabaseSync } from 'node:sqlite';
import fs from 'fs';
const WORK = process.env.SUMANGAL_WORK || 'D:/SumangalData/work';
const here = (f) => WORK + '/' + f;
const s = fs.readFileSync(here('v13-data.js'), 'utf8'); const D = JSON.parse(s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1));
const db = new DatabaseSync(process.env.SUMANGAL_DB || 'D:/SumangalData/work/casting.sqlite', { readOnly: true });
const all = (q) => db.prepare(q).all();
const D0 = Date.UTC(2024, 0, 1); const day = (x) => (x ? Math.round((Date.UTC(+x.slice(0, 4), +x.slice(5, 7) - 1, +x.slice(8, 10)) - D0) / 864e5) : null);
const FROM = '2022-01-01', FROMD = day(FROM);
const n = (x) => Math.round(+x || 0);
// ---- dictionaries (extend V13's)
const cust = D.cust.slice(), parts = D.parts.map((p) => p.slice()), rsn = D.rsn.slice(), rdep = D.rdep.slice(), vendors = D.vendors.slice();
const custIx = new Map(cust.map((c, i) => [c.trim().toLowerCase(), i]));
const custRows = new Map(all('select customer_id, trim(customer_name) nm, trim(coalesce(customer_short_name,\'\')) sn from tbl_customer_master').map((r) => [r.customer_id, r]));
const C = (id) => { const r = custRows.get(id); if (!r) return -1; const k = r.nm.toLowerCase(); if (!custIx.has(k)) { custIx.set(k, cust.length); cust.push(r.nm); } return custIx.get(k); };
const partIx = new Map(parts.map((p, i) => [String(p[0]).trim(), i]));
const dies = new Map(all('select die_id, trim(die_no) no, trim(die_description) ds, raw_casting_weight w, customer_id c, trim(coalesce(nullif(customer_drawing_no_new,\'\'), customer_drawing_no, \'\')) dwg from tbl_die_master').map((r) => [r.die_id, r]));
const dieByNo = new Map([...dies.values()].map((r) => [r.no, r]));
const PT = (dieId, typeIdx) => { const d = dies.get(dieId); if (!d) return -1; if (!partIx.has(d.no)) { partIx.set(d.no, parts.length); parts.push([d.no, d.ds || '', +(+d.w || 0).toFixed(3), typeIdx ?? 1, C(d.c)]); } return partIx.get(d.no); };
const typeOf = (ct) => { ct = String(ct || '').toUpperCase().replace(/\s/g, ''); return /^FM/.test(ct) ? 0 : ct === 'PM' ? 3 : ct === 'ZN' ? 2 : 1; };
// metal: learn customer_metal_id -> V13 metal index from items already in V13
const bdAll = all('select d.batch_item_id id, trim(d.batch_item_no) no, d.batch_quantity q, d.die_id, d.customer_metal_id cm, d.raw_casting_weight w, substr(m.batch_date,1,10) bd, m.batch_type bt, m.customer_id c, m.work_order_item_id wi from tbl_batch_detail d join tbl_batch_master m using(batch_id)');
const v13No = new Map(D.items.map((it, i) => [String(it[0]).trim(), i]));
const cmVote = new Map(); for (const r of bdAll) { const i = v13No.get(r.no); if (i == null) continue; const m = cmVote.get(r.cm) || cmVote.set(r.cm, new Map()).get(r.cm); m.set(D.items[i][3], (m.get(D.items[i][3]) || 0) + 1); }
const metalOf = (cm) => { const m = cmVote.get(cm); if (!m) return D.metals.indexOf('Not set'); return [...m.entries()].sort((a, b) => b[1] - a[1])[0][0]; };
// work order lines and order lines
const wo = new Map(all('select d.work_order_item_id wi, trim(w.work_order_no) no, w.work_order_type_value t, d.order_item_id oi from tbl_work_order_detail d join tbl_work_order_master w using(work_order_id)').map((r) => [r.wi, r]));
const olRows = all(`select d.order_item_id oi, trim(m.order_no) no, substr(m.order_date,1,10) od, m.customer_id c, d.die_id, d.customer_metal_id cm, d.order_quantity q, d.raw_casting_weight w, substr(d.delivery_date,1,10) dd, d.casting_type ct from tbl_order_acceptance_detail d join tbl_order_acceptance_master m using(order_id)`);
const olById = new Map(olRows.map((r) => [r.oi, r]));
const ordIx = new Map(D.ord.map((o, i) => [o[0], i]));
const v13OrdMin = Math.min(...D.ord.map((o) => o[2]));
const newOrd = [];
const woRowsByOi = new Map(); for (const r of all(`select d.order_item_id oi, substr(w.work_order_date,1,10) d, d.order_quantity q from tbl_work_order_detail d join tbl_work_order_master w using(work_order_id) where d.order_item_id>0`)) (woRowsByOi.get(r.oi) || woRowsByOi.set(r.oi, []).get(r.oi)).push([day(r.d), n(r.q)]);
const dispByOi = new Map(); for (const r of all(`select o.order_item_id oi, substr(m.dispatch_date,1,10) d, sum(o.dispatch_quantity) q from tbl_dispatch_oa_detail o join tbl_dispatch_intimation_master m using(dispatch_id) group by 1,2`)) (dispByOi.get(r.oi) || dispByOi.set(r.oi, []).get(r.oi)).push([day(r.d), n(r.q)]);
for (const r of olRows) { const d = day(r.od); if (d < FROMD || d >= v13OrdMin || ordIx.has(r.oi)) continue; const t = typeOf(r.ct); const p = PT(r.die_id, t); if (p < 0) continue; const dd = dies.get(r.die_id);
  ordIx.set(r.oi, D.ord.length + newOrd.length); newOrd.push([r.oi, r.no, d, C(r.c), p, metalOf(r.cm), n(r.q), +(+(dd?.w) || 0).toFixed(3), day(r.dd), t, woRowsByOi.get(r.oi) || [], dispByOi.get(r.oi) || []]); }
// ---- step rows per batch item (V13 slots)
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
const add = bdAll.filter((r) => r.bd >= '2021-07-01' && !v13No.has(r.no));
const addIx = new Map(add.map((r, k) => [r.id, k]));
const steps = add.map(() => Array.from({ length: 12 }, () => []));
for (const [slot, q] of Object.entries(SLOT)) for (const r of all(q)) { const k = addIx.get(r.id); if (k == null) continue; const row = [day(r.d), n(r.q), n(r.g)]; if (+slot === 5) row.push(r.f ? 1 : 0); steps[k][slot].push(row); }
// check the heat-treatment rule against V13 on items V13 already has
{ const t = new Map(); for (const r of all(SLOT[5])) t.set(r.id, (t.get(r.id) || 0) + n(r.q)); let ok = 0, bad = 0; for (const r of bdAll) { const i = v13No.get(r.no); if (i == null || !t.has(r.id)) continue; const v = D.items[i][7][5].reduce((a, x) => a + x[1], 0); if (v === t.get(r.id)) ok++; else bad++; } console.log('HT final-pass rule matches V13 on', ok, 'items, differs on', bad); }
const base = D.items.length;
const heats = new Map(); for (const r of all(`select d.batch_item_id id, coalesce(nullif(trim(m.manual_heat_no),''),trim(m.heat_no)) h from tbl_melting_production_detail d join tbl_melting_production_master m using(melting_prod_id)`)) { if (!addIx.has(r.id) || !r.h) continue; const x = heats.get(r.id) || new Set(); x.add(r.h); heats.set(r.id, x); }
const items = [], sit = [];
add.forEach((r, k) => { const w = wo.get(r.wi); const ol = w && w.oi ? olById.get(w.oi) : null; const t = ol ? typeOf(ol.ct) : (parts[partIx.get(dies.get(r.die_id)?.no)]?.[3] ?? 1); const p = PT(r.die_id, t); if (p < 0) return;
  items.push([r.no, C(r.c || dies.get(r.die_id)?.c), p, metalOf(r.cm), +(+r.w || +(dies.get(r.die_id)?.w) || 0).toFixed(3), day(r.bd), n(r.q), steps[k], t, -1]);
  sit.push([w ? w.no : '', heats.has(r.id) ? [...heats.get(r.id)].join(' ') : '', r.bt, w && w.oi && ordIx.has(w.oi) ? ordIx.get(w.oi) : -1, w ? w.t : 0]); });
// rows were pushed in add order but some may be skipped: rebuild index map
const itemIx = new Map(); { let j = 0; add.forEach((r, k) => { if (items[j] && items[j][0] === r.no) { itemIx.set(r.id, base + j); j++; } }); }
// ---- rejections for the added items: [day, rstg, reason index, item index, qty]
const rsIx = new Map(rsn.map((x, i) => [x.trim(), i]));
const reasons = new Map(all('select r.rejection_id id, trim(r.reason_name) nm, trim(coalesce(d.department_name,\'Not set\')) dp from tbl_rejection_master r left join tbl_department_master d using(department_id)').map((r) => [r.id, r]));
const RS = (id) => { const r = reasons.get(id); const nm = r ? r.nm : 'No reason'; if (!rsIx.has(nm)) { rsIx.set(nm, rsn.length); rsn.push(nm); rdep.push(r ? r.dp : 'Not set'); } return rsIx.get(nm); };
const REJ = [[0, `select p.batch_item_id id, substr(p.inj_prod_date,1,10) d, r.rejection_id x, r.inj_rejection_quantity q from tbl_injection_production_rejection r join tbl_injection_production p using(inj_prod_id)`],
  [1, `select p.batch_item_id id, substr(p.asmbly_prod_date,1,10) d, r.rejection_id x, r.rejection_quantity q from tbl_assembly_rejection r join tbl_assembly_production p using(asmbly_prod_id)`],
  [2, `select p.batch_item_id id, substr(p.coating_prod_date,1,10) d, r.rejection_id x, r.rejection_quantity q from tbl_coating_rejection r join tbl_coating_production p using(coating_prod_id)`],
  [3, `select p.batch_item_id id, substr(p.dwx_prod_date,1,10) d, r.rejection_id x, r.rejection_quantity q from tbl_dewaxing_rejection r join tbl_dewaxing_production p using(dwx_prod_id)`],
  [4, `select x.batch_item_id id, substr(m.melting_date,1,10) d, r.rejection_id x, r.rejection_quantity q from tbl_melting_rejection r join tbl_melting_production_detail x using(melting_prod_item_id) join tbl_melting_production_master m using(melting_prod_id)`],
  [5, `select p.batch_item_id id, substr(p.fettling_date,1,10) d, r.rejection_id x, r.rejection_quantity q from tbl_fettling_rejection r join tbl_fettling_production p using(fettling_prod_id)`],
  [6, `select p.batch_item_id id, substr(p.insp_prod_date,1,10) d, r.rejection_id x, r.rejection_quantity q from tbl_inspection_rejection r join tbl_inspection_production p using(insp_prod_id)`],
  [7, `select p.batch_item_id id, substr(p.machining_insp_date,1,10) d, r.rejection_id x, r.rejection_quantity q from tbl_machining_inspection_rejection r join tbl_machining_inspection p using(machining_insp_id)`]];
const rej = []; for (const [st, q] of REJ) for (const r of all(q)) { const i = itemIx.get(r.id); if (i == null || !n(r.q)) continue; rej.push([day(r.d), st, RS(r.x), i, n(r.q)]); }
// ---- dispatch per order line before V13's first dispatch day: [day, cust, part, metal, pcs, kg, order_item_id, type]
const v13DispMin = Math.min(...D.disp.map((r) => r[0]));
const disp = []; for (const r of all(`select o.order_item_id oi, substr(m.dispatch_date,1,10) d, m.customer_id c, o.die_id, sum(o.dispatch_quantity) q from tbl_dispatch_oa_detail o join tbl_dispatch_intimation_master m using(dispatch_id) where substr(m.dispatch_date,1,10)>='${FROM}' group by 1,2,3,4`)) {
  const d = day(r.d); if (d >= v13DispMin) continue; const ol = olById.get(r.oi); const t = ol ? typeOf(ol.ct) : 1; const p = PT(r.die_id, t); if (p < 0) continue; disp.push([d, C(r.c), p, ol ? metalOf(ol.cm) : D.metals.indexOf('Not set'), n(r.q), +(n(r.q) * parts[p][2]).toFixed(1), r.oi, t]); }
// ---- vendor challans before V13's first send day: vend [vendor, proc, part, sendDay, pcs, kg, lastDay, received, receipts]; rcv [day, vendor, proc, part, pcs, rej, kg, scrap]
const vIx = new Map(vendors.map((v, i) => [v.trim().toLowerCase(), i])); const supp = new Map(all('select supplier_id, trim(supplier_name) nm from tbl_supplier_master').map((r) => [r.supplier_id, r.nm]));
const VN = (nm) => { const k = String(nm || '?').toLowerCase(); if (!vIx.has(k)) { vIx.set(k, vendors.length); vendors.push(nm || '?'); } return vIx.get(k); };
const pIx = new Map(D.procs.map((p, i) => [p, i]));
const v13VendMin = Math.min(...D.vend.map((v) => v[3]));
const vend = [], rcv = [];
const ins = new Map(); for (const r of all(`select d.manual_casting_outward_detail_id oid, substr(m.manual_casting_inward_date,1,10) d, d.inward_quantity q, d.total_rejection_quantity rj, d.waste_scrap sc from tbl_manual_casting_inward_detail d join tbl_manual_casting_inward_master m using(manual_casting_inward_id)`)) (ins.get(r.oid) || ins.set(r.oid, []).get(r.oid)).push(r);
for (const r of all(`select d.manual_casting_outward_detail_id oid, substr(o.manual_casting_outward_date,1,10) d, o.supplier_id s, f.process_name pn, d.die_id, d.outward_quantity q from tbl_manual_casting_outward_detail d join tbl_manual_casting_outward_master o using(manual_casting_outward_id) left join tbl_for_process_master f using(for_process_id) where o.is_cancel=0 and substr(o.manual_casting_outward_date,1,10)>='${FROM}'`)) {
  const d = day(r.d); if (d >= v13VendMin) continue; const pr = pIx.get(r.pn); const p = PT(r.die_id); if (pr == null || p < 0) continue; const v = VN(supp.get(r.s)); const kg = n(r.q) * parts[p][2]; const rc = (ins.get(r.oid) || []).map((x) => [day(x.d), n(x.q)]);
  vend.push([v, pr, p, d, n(r.q), +kg.toFixed(1), rc.length ? Math.max(...rc.map((x) => x[0])) : null, rc.reduce((t, x) => t + x[1], 0), rc]);
  for (const x of ins.get(r.oid) || []) { const dd = day(x.d); if (dd >= Math.min(...D.rcv.map((y) => y[0]))) continue; rcv.push([dd, v, pr, p, n(x.q), n(x.rj), +(n(x.q) * parts[p][2]).toFixed(1), +(+x.sc || 0).toFixed(2)]); } }
// contract fettling (in-house contractors): tbl_manual_fettling_*; vendor names follow V13 (learned by matching 2024+ lines)
try {
  const cf = pIx.get('Contract fettling (in-house)'); const fin = new Map(); for (const r of all(`select x.manual_fettling_outward_detail_id id, substr(m.manual_fettling_inward_date,1,10) d, x.reveive_qty q, x.rejection_qty rj from tbl_manual_fettling_inward_detail x join tbl_manual_fettling_inward_master m using(manual_fettling_inward_id)`)) (fin.get(r.id) || fin.set(r.id, []).get(r.id)).push(r);
  const fo = all(`select x.manual_fettling_outward_detail_id id, substr(m.manual_fettling_outward_date,1,10) d, m.from_id src, x.die_id, x.issue_qty q from tbl_manual_fettling_outward_detail x join tbl_manual_fettling_outward_master m using(manual_fettling_outward_id) where substr(m.manual_fettling_outward_date,1,10)>='${FROM}'`);
  const vote = new Map(); const key = (p, d, q) => p + '|' + d + '|' + q; const v13cf = new Map(); for (const v of D.vend) if (v[1] === cf) v13cf.set(key(v[2], v[3], v[4]), v[0]);
  for (const r of fo) { const p = partIx.get(dies.get(r.die_id)?.no); const v = v13cf.get(key(p, day(r.d), n(r.q))); if (v != null) { const m = vote.get(r.src) || vote.set(r.src, new Map()).get(r.src); m.set(v, (m.get(v) || 0) + 1); } }
  const srcV = (src) => { const m = vote.get(src); return m ? [...m.entries()].sort((a, b) => b[1] - a[1])[0][0] : VN('Fettling contractor (ERP code ' + src + ')'); };
  for (const r of fo) { const d = day(r.d); if (d >= v13VendMin) continue; const p = PT(r.die_id); if (p < 0) continue; const v = srcV(r.src); const rc = (fin.get(r.id) || []).map((x) => [day(x.d), n(x.q)]);
    vend.push([v, cf, p, d, n(r.q), +(n(r.q) * parts[p][2]).toFixed(1), rc.length ? Math.max(...rc.map((x) => x[0])) : null, rc.reduce((t, x) => t + x[1], 0), rc]);
    for (const x of fin.get(r.id) || []) { const dd = day(x.d); if (dd >= Math.min(...D.rcv.map((y) => y[0]))) continue; rcv.push([dd, v, cf, p, n(x.q), n(x.rj), +(n(x.q) * parts[p][2]).toFixed(1), 0]); } }
  console.log('contract fettling sources mapped:', JSON.stringify([...vote.entries()].map(([k, m]) => [k, vendors[[...m.entries()].sort((a, b) => b[1] - a[1])[0][0]]])));
} catch (e) { console.log('contract fettling skipped:', e.message); }
// ---- short names and part numbers for the final dictionaries
const shortByName = new Map([...custRows.values()].map((r) => [r.nm.toLowerCase(), r.sn]));
const short = cust.map((c) => { const sn = shortByName.get(c.trim().toLowerCase()); return sn && sn.length <= 14 && !/^spare$/i.test(sn) ? sn : c; });
const dwg = parts.map((p) => (dieByNo.get(String(p[0]).trim())?.dwg) || '');
const H = { cust, parts, rsn, rdep, vendors, items, sit, rej, disp, ord: newOrd, vend, rcv, short, dwg };
fs.writeFileSync(here('hist.json'), JSON.stringify(H));
console.log({ items: items.length, rej: rej.length, disp: disp.length, ord: newOrd.length, vend: vend.length, rcv: rcv.length, newCust: cust.length - D.cust.length, newParts: parts.length - D.parts.length, newReasons: rsn.length - D.rsn.length, newVendors: vendors.length - D.vendors.length, bytes: JSON.stringify(H).length });
console.log('short names:', JSON.stringify(cust.map((c, i) => [c.slice(0, 30), short[i]]).slice(0, 80)));
