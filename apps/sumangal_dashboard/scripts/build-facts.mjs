/**
 * Turns a working copy of Sumangal's ERP (SQLite, made by mdf/mdfread.mjs + mdf/clean.mjs)
 * into the rows the dashboard reads: one JSON file, kept outside the repo and outside OneDrive.
 *
 *   node --no-warnings apps/sumangal_dashboard/scripts/build-facts.mjs <casting.sqlite> <facts.json>
 *
 * Only what the ERP records, added up. No cost estimates, no predictions. A line is shipped
 * when dispatched quantity reaches ordered quantity; short-closed lines are the ERP's own flag.
 */
import fs from 'fs';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';

const [src, out] = process.argv.slice(2);
if (!src || !out) { console.error('Usage: build-facts.mjs <casting.sqlite> <facts.json>'); process.exit(1); }
const db = new DatabaseSync(src, { readOnly: true });
const all = (s, ...p) => db.prepare(s).all(...p);
const days = (a, b) => (Date.parse(b.slice(0, 10)) - Date.parse(a.slice(0, 10))) / 86400000;
const sum = (a, f) => a.reduce((t, x) => t + (f(x) || 0), 0);
const round = (v, n = 2) => (v == null ? null : Math.round(v * 10 ** n) / 10 ** n);
const d10 = (s) => (s ? String(s).slice(0, 10) : null);

const AS_OF = d10(all("select max(melting_date) d from tbl_melting_production_master where melting_date<'2027'")[0].d);
const W0 = new Date(Date.parse(AS_OF) - 730 * 86400000 + 86400000).toISOString().slice(0, 10);
console.log(`as of ${AS_OF}, window from ${W0}`);

// ── References ──
const customers = all('select customer_id id, customer_name name, wa_country country, payment_terms terms from tbl_customer_master');
const custById = new Map(customers.map((c) => [c.id, c]));
const dieM = new Map(all('select die_id id, die_description de, raw_casting_weight w from tbl_die_master').map((x) => [x.id, x]));
const cmb = new Map(all('select cmb_id id, cmb_value v from tbl_combobox_master').map((x) => [x.id, x.v]));
const metal = new Map(all('select metal_id id, metal_name n, casting_type_cmb_id t from tbl_metal_master').map((x) => [x.id, x]));
const custMetal = new Map(all('select customer_metal_id id, metal_id m from tbl_customer_metal_master').map((x) => [x.id, x.m]));
const family = (m) => String(cmb.get(metal.get(m)?.t) || 'Not set').trim();
const finishOf = (ct) => { const c = String(ct || '').trim().toUpperCase(); return !c ? 'No code' : c.startsWith('FM-') ? 'FM-A to F' : c === 'ZN' ? 'Zn' : c; };
const sizeOf = (t) => (t < 100 ? 'Under 100 kg' : t < 500 ? '100–500 kg' : t < 2000 ? '0.5–2 t' : 'Over 2 t');
const weightOf = (w) => (!w ? 'Not set' : w < 1 ? 'Under 1 kg' : w < 5 ? '1–5 kg' : w < 20 ? '5–20 kg' : 'Over 20 kg');
const isExport = (c) => { const x = custById.get(c)?.country; return !!x && !/india/i.test(x); };

// ── Batches and stage records ──
const bi = new Map(all('select b.batch_item_id id, b.raw_casting_weight w, b.die_id die, b.batch_quantity bq, b.customer_metal_id cm, m.customer_id c, wd.order_item_id oi, b.is_short_close sc from tbl_batch_detail b join tbl_batch_master m using(batch_id) left join tbl_work_order_detail wd on wd.work_order_item_id=m.work_order_item_id').map((r) => [r.id, r]));
const load = (sql) => { const m = new Map(); for (const e of all(sql)) { if (!e.dt || e.dt >= '2027') continue; e.dt = d10(e.dt); if (!m.has(e.id)) m.set(e.id, []); m.get(e.id).push(e); } return m; };
const STAGES = {
  Injection: load('select batch_item_id id, inj_prod_date dt, inj_quantity qi, net_quantity qn from tbl_injection_production'),
  Assembly: load('select batch_item_id id, asmbly_prod_date dt, asmbly_quantity qi, net_quantity qn from tbl_assembly_production'),
  Coating: load('select batch_item_id id, coating_prod_date dt, coating_quantity qi, net_quantity qn from tbl_coating_production'),
  Dewaxing: load('select batch_item_id id, dwx_prod_date dt, dwx_quantity qi, net_quantity qn from tbl_dewaxing_production'),
  Melting: load('select x.batch_item_id id, m.melting_date dt, x.melting_quantity qi, x.net_quantity qn from tbl_melting_production_detail x join tbl_melting_production_master m using(melting_prod_id)'),
  Fettling: load('select batch_item_id id, fettling_date dt, fettling_quantity qi, net_quantity qn from tbl_fettling_production'),
  'Heat treatment': load('select x.batch_item_id id, m.heat_treatment_date dt, x.ht_qty qi, x.ht_qty qn from tbl_heat_treatment_detail x join tbl_heat_treatment_master m using(heat_treatment_id)'),
  Inspection: load('select batch_item_id id, insp_prod_date dt, insp_quantity qi, net_quantity qn from tbl_inspection_production'),
  'Machining inspection': load('select batch_item_id id, machining_insp_date dt, machining_insp_quantity qi, net_quantity qn from tbl_machining_inspection'),
  Cleared: load('select batch_item_id id, dispatch_authorize_date dt, authorize_quantity qi, authorize_quantity qn from tbl_dispatch_authorization'),
};
const inj = STAGES.Injection; const melt = STAGES.Melting; const ins = STAGES.Inspection; const auth = STAGES.Cleared;
const minD = (m, ids) => { let x = null; for (const id of ids) for (const e of m.get(id) || []) if (!x || e.dt < x) x = e.dt; return x; };
const maxD = (m, ids) => { let x = null; for (const id of ids) for (const e of m.get(id) || []) if (!x || e.dt > x) x = e.dt; return x; };
const qtySum = (m, ids, f) => ids.reduce((t, id) => t + sum(m.get(id) || [], (e) => e[f]), 0);
const itemsByOI = new Map(); for (const b of bi.values()) if (b.oi) { if (!itemsByOI.has(b.oi)) itemsByOI.set(b.oi, []); itemsByOI.get(b.oi).push(b.id); }
const plansByWI = new Map(); for (const p of all('select d.work_order_item_id wi, m.prod_date dt from tbl_production_planing_detail d join tbl_production_planing_master m using(prod_planing_id)')) { if (!plansByWI.has(p.wi)) plansByWI.set(p.wi, []); plansByWI.get(p.wi).push(d10(p.dt)); }
const woByOI = new Map(all('select order_item_id oi, group_concat(work_order_item_id) w, min(casting_del_date) cd, max(is_rt) rt, max(is_hyt) hyt, max(is_mp) mp, max(is_dp) dp, max(is_igc) igc, max(is_3_2_tuv) tuv, max(is_3_2_lr) lr, max(is_ibr) ibr from tbl_work_order_detail where order_item_id>0 group by 1').map((r) => [r.oi, r]));
const testsOf = (oi) => { const f = woByOI.get(oi); return f && ['rt', 'hyt', 'mp', 'dp', 'igc', 'tuv', 'lr', 'ibr'].some((k) => f[k] > 0) ? 'Tests flagged' : 'No tests flagged'; };
const firstOrderDie = new Map(all('select d.die_id id, min(m.order_date) dt from tbl_order_acceptance_detail d join tbl_order_acceptance_master m using(order_id) group by 1').map((r) => [r.id, r.dt]));
const shipped = new Map(); for (const r of all('select x.order_item_id id, m.dispatch_date dt, x.dispatch_quantity q from tbl_dispatch_oa_detail x join tbl_dispatch_intimation_master m using(dispatch_id) order by m.dispatch_date')) { r.dt = d10(r.dt); if (!shipped.has(r.id)) shipped.set(r.id, []); shipped.get(r.id).push(r); }

// ── Dimensions ──
const orderDims = new Map(all('select d.order_item_id id, d.casting_type ct, d.customer_metal_id cm, d.raw_casting_weight w, d.die_id die, d.total_weight t, m.customer_id c, m.order_date od from tbl_order_acceptance_detail d join tbl_order_acceptance_master m using(order_id)').map((r) => [r.id, r]));
const dimsOfLine = (oi, fb = {}) => {
  const o = orderDims.get(oi); const m = custMetal.get(o?.cm ?? fb.cm); const die = o?.die ?? fb.die; const w = dieM.get(die)?.w || o?.w || fb.w; const c = o?.c ?? fb.c;
  return { c, f: o ? finishOf(o.ct) : 'No order', m: family(m), w: weightOf(w), s: o ? sizeOf(o.t) : 'No order', x: isExport(c) ? 'Export' : 'Domestic', n: o && firstOrderDie.get(die) === o.od && d10(o.od) >= '2024-04-01' ? 'First order for part' : 'Repeat part', t: testsOf(oi) };
};
const dimsOfBatch = (b) => dimsOfLine(b.oi, { cm: b.cm, die: b.die, w: b.w, c: b.c });
const aggregate = (rows, keyOf, add) => { const m = new Map(); for (const r of rows) { const row = keyOf(r); const k = JSON.stringify(row); let a = m.get(k); if (!a) { a = { ...row, kg: 0, pcs: 0 }; m.set(k, a); } add(a, r); } return [...m.values()]; };

// ── Invoiced so far, per order line (ERP invoice amount and weight in the same window as sales) ──
const invByOI = new Map(all(`select x.order_item_id oi, sum(x.amount) am, sum(x.total_weight) kg from tbl_invoice_domestic_detail x join tbl_invoice_domestic i using(invoice_id) where i.invoice_date>='${W0}' and i.invoice_date<='${AS_OF} 23:59' and i.die_invoice_type in (1,4) group by x.order_item_id`).map((r) => [r.oi, { am: Number(r.am), kg: Number(r.kg) }]));

// ── Order lines ──
const rawLines = all("select d.order_item_id id, m.order_no ono, m.order_date od, d.delivery_date dd, d.order_quantity q, d.total_weight tn, m.customer_id c, d.is_short_close sc, d.die_id die from tbl_order_acceptance_detail d join tbl_order_acceptance_master m using(order_id) where m.order_date>='2024-04-01' and d.die_invoice_type=1 and d.order_quantity>0");
const lines = rawLines.map((l) => {
  const ids = itemsByOI.get(l.id) || []; const s = shipped.get(l.id) || [];
  let cum = 0; let full = null; for (const e of s) { cum += e.q; if (!full && cum >= l.q) full = e.dt; }
  const wi = woByOI.get(l.id); const plans = String(wi?.w || '').split(',').flatMap((x) => plansByWI.get(Number(x)) || []).sort();
  const lInj = maxD(inj, ids); const lMelt = maxD(melt, ids); const lIns = maxD(ins, ids); const lAuth = maxD(auth, ids);
  const od = d10(l.od); const fp = plans[0] ?? null; const clamp = (a, b) => (a && b ? Math.max(0, days(a, b)) : null);
  const legs = full && lInj && lMelt && lIns && lAuth ? { plan: fp ? clamp(od, fp) : 0, wax: clamp(fp || od, lInj), melt: clamp(lInj, lMelt), postPour: clamp(lMelt, lIns), clear: clamp(lIns, lAuth), ship: clamp(lAuth, full) } : null;
  const shipQty = sum(s, (e) => e.q);
  const injN = qtySum(inj, ids, 'qn'); const pourI = qtySum(melt, ids, 'qi'); const pourN = qtySum(melt, ids, 'qn'); const insI = qtySum(ins, ids, 'qi'); const insN = qtySum(ins, ids, 'qn'); const authQ = qtySum(auth, ids, 'qi');
  const piles = { 'Not injected': Math.max(0, l.q - injN), 'Injected, not poured': Math.max(0, injN - pourI), 'Poured, not inspected': Math.max(0, pourN - insI), 'Inspected, not cleared': Math.max(0, insN - authQ), 'Cleared, not shipped': Math.max(0, authQ - shipQty) };
  return { id: l.id, ono: l.ono, die: l.die, ...dimsOfLine(l.id), c: l.c, od, dd: d10(l.dd), q: l.q, tn: round(l.tn, 1), inv: round(invByOI.get(l.id)?.am ?? 0, 0), invKg: round(invByOI.get(l.id)?.kg ?? 0, 1), sc: l.sc ? 1 : 0, shipQty, full, sh: s.map((e) => [e.dt, e.q]), legs, bq: sum(ids.map((id) => bi.get(id)), (b) => b.bq), pour: pourI, ok: insN, castDue: d10(wi?.cd) || null, lastPour: lMelt, firstIns: minD(ins, ids), lastIns: lIns, qi: injN, qp: pourN, qn: insN, qc: authQ, at: Object.entries(piles).sort((a, b) => b[1] - a[1])[0][0], piles: Object.fromEntries(Object.entries(piles).map(([k, v]) => [k, Math.round(v)])) };
}).filter((l) => (l.dd && l.dd >= W0) || l.od >= W0);

// ── Invoices and dispatches ──
const sales = all(`select x.order_item_id oi, x.die_id die, x.packing_quantity q, x.amount am, x.total_weight kg, i.customer_id c, i.invoice_date dt, i.sales_type_id st, x.customer_metal_id cm, i.due_date due from tbl_invoice_domestic_detail x join tbl_invoice_domestic i using(invoice_id) where i.invoice_date>='${W0}' and i.invoice_date<='${AS_OF} 23:59' and i.die_invoice_type in (1,4)`).map((x) => {
  const o = orderDims.get(x.oi); const die = x.die || o?.die; const w = dieM.get(die)?.w || o?.w || (x.q ? x.kg / x.q : 0);
  return { dt: d10(x.dt), die, ...dimsOfLine(x.oi, { cm: x.cm, die, w, c: x.c }), c: x.c, x: x.st === 3 ? 'Export' : 'Domestic', am: round(x.am, 0), kg: round(x.kg, 1), due: d10(x.due) };
});
const disp = aggregate(all(`select x.order_item_id oi, x.die_id die, x.customer_metal_id cm, x.dispatch_quantity q, x.raw_casting_weight w, m.dispatch_date dt, m.customer_id c from tbl_dispatch_oa_detail x join tbl_dispatch_intimation_master m using(dispatch_id) where m.dispatch_date>='${W0}' and m.dispatch_date<='${AS_OF} 23:59'`), (r) => ({ dt: d10(r.dt), ...dimsOfLine(r.oi, { cm: r.cm, die: r.die, w: r.w, c: r.c }), c: r.c }), (a, r) => { a.kg = round(a.kg + r.q * (r.w || 0), 1); a.pcs += r.q; });

// ── Stage throughput by month ──
const flowRows = []; const workDays = new Map();
for (const [stage, m] of Object.entries(STAGES)) for (const [id, a] of m) { const b = bi.get(id); if (!b) continue; for (const e of a) if (e.dt >= W0 && e.dt <= AS_OF) { flowRows.push({ stage, b, e }); const k = `${stage}|${e.dt.slice(0, 7)}`; if (!workDays.has(k)) workDays.set(k, new Set()); workDays.get(k).add(e.dt); } }
const flow = aggregate(flowRows, (r) => ({ stage: r.stage, mo: r.e.dt.slice(0, 7), ...dimsOfBatch(r.b) }), (a, r) => { a.kg = round(a.kg + r.e.qi * r.b.w, 1); a.pcs += r.e.qi; a.netKg = round((a.netKg || 0) + r.e.qn * r.b.w, 1); });
const workDayRows = [...workDays.entries()].map(([k, v]) => { const [stage, mo] = k.split('|'); return { stage, mo, days: v.size }; });
const pouredRows = flowRows.filter((r) => r.stage === 'Melting');
const dieMelt = aggregate(pouredRows, (r) => ({ die: r.b.die, mo: r.e.dt.slice(0, 7), ...dimsOfBatch(r.b) }), (a, r) => { a.kg = round(a.kg + r.e.qi * r.b.w, 1); a.pcs += r.e.qi; });

// ── Rejections ──
const reasons = new Map(all('select r.rejection_id id, r.reason_name n, m.department_name dep from tbl_rejection_master r left join tbl_department_master m using(department_id)').map((r) => [r.id, r]));
const AREAS = [
  ['Injection', 'select p.batch_item_id id, p.inj_prod_date dt, null hn, r.rejection_id rid, r.inj_rejection_quantity q from tbl_injection_production_rejection r join tbl_injection_production p using(inj_prod_id) where p.inj_prod_date>=?'],
  ['Assembly', 'select p.batch_item_id id, p.asmbly_prod_date dt, null hn, r.rejection_id rid, r.rejection_quantity q from tbl_assembly_rejection r join tbl_assembly_production p using(asmbly_prod_id) where p.asmbly_prod_date>=?'],
  ['Coating', 'select p.batch_item_id id, p.coating_prod_date dt, null hn, r.rejection_id rid, r.rejection_quantity q from tbl_coating_rejection r join tbl_coating_production p using(coating_prod_id) where p.coating_prod_date>=?'],
  ['Dewaxing', 'select p.batch_item_id id, p.dwx_prod_date dt, null hn, r.rejection_id rid, r.rejection_quantity q from tbl_dewaxing_rejection r join tbl_dewaxing_production p using(dwx_prod_id) where p.dwx_prod_date>=?'],
  ['Melting', 'select x.batch_item_id id, m.melting_date dt, x.heat_no hn, r.rejection_id rid, r.rejection_quantity q from tbl_melting_rejection r join tbl_melting_production_detail x using(melting_prod_item_id) join tbl_melting_production_master m using(melting_prod_id) where m.melting_date>=?'],
  ['Fettling', 'select p.batch_item_id id, p.fettling_date dt, p.heat_no hn, r.rejection_id rid, r.rejection_quantity q from tbl_fettling_rejection r join tbl_fettling_production p using(fettling_prod_id) where p.fettling_date>=?'],
  ['Inspection', 'select p.batch_item_id id, p.insp_prod_date dt, p.heat_no hn, r.rejection_id rid, r.rejection_quantity q from tbl_inspection_rejection r join tbl_inspection_production p using(insp_prod_id) where p.insp_prod_date>=?'],
  ['Machining inspection', 'select p.batch_item_id id, p.machining_insp_date dt, p.heat_no hn, r.rejection_id rid, r.rejection_quantity q from tbl_machining_inspection_rejection r join tbl_machining_inspection p using(machining_insp_id) where p.machining_insp_date>=?'],
];
const rawRej = []; for (const [area, sql] of AREAS) for (const r of all(sql, W0)) { const b = bi.get(r.id); if (b && r.q && r.dt < '2027') rawRej.push({ ...r, area, b }); }
const rej = aggregate(rawRej, (r) => ({ mo: r.dt.slice(0, 7), area: r.area, reason: reasons.get(r.rid)?.n ?? 'Not set', dep: reasons.get(r.rid)?.dep ?? 'Not set', die: r.b.die, ...dimsOfBatch(r.b) }), (a, r) => { a.kg = round(a.kg + r.q * r.b.w, 2); a.pcs += r.q; });
const control = all('select m.department_name dep, c.rej_per pct from tbl_department_wise_rejection_control c join tbl_department_master m on m.department_unique_id=c.department_unique_id_fix');

// ── Work in process at month ends, from stage quantities ──
const monthEnds = []; for (let d = new Date(Date.UTC(+W0.slice(0, 4), +W0.slice(5, 7), 0)); d.toISOString().slice(0, 10) < AS_OF; d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 2, 0))) monthEnds.push(d.toISOString().slice(0, 10));
monthEnds.push(AS_OF);
const recent = [...bi.values()].filter((b) => !b.sc && (minD(inj, [b.id]) ?? '0') >= '2024-04-01');
const upTo = (m, id, f, me) => { let t = 0; for (const e of m.get(id) || []) if (e.dt <= me) t += e[f]; return t; };
const wipMap = new Map();
for (const me of monthEnds) for (const b of recent) {
  const dm = dimsOfBatch(b); const nInj = upTo(inj, b.id, 'qn', me); const nMi = upTo(melt, b.id, 'qi', me); const nMn = upTo(melt, b.id, 'qn', me); const nIi = upTo(ins, b.id, 'qi', me); const nIn = upTo(ins, b.id, 'qn', me); const nA = upTo(auth, b.id, 'qi', me);
  const add = (bucket, pcs) => { if (pcs <= 0) return; const row = { me, bucket, ...dm }; const k = JSON.stringify(row); const a = wipMap.get(k) || { ...row, kg: 0 }; a.kg = round(a.kg + pcs * b.w, 1); wipMap.set(k, a); };
  add('Injected, not poured', nInj - nMi); add('Poured, not inspected', nMn - nIi); add('Inspected, not cleared', nIn - nA);
}
const wip = [...wipMap.values()];

// ── Heats and charge ──
const itemName = new Map(all('select item_id id, item_name n from tbl_item_master').map((r) => [r.id, r.n]));
const heats = all(`select * from tbl_melting_production_master where melting_date>='${W0}' and melting_date<='${AS_OF} 23:59'`);
const heatRows = aggregate(heats, (h) => ({ dt: d10(h.melting_date), family: family(h.metal_id) }), (a) => { a.pcs += 1; }).map(({ dt, family: fam, pcs }) => ({ dt, m: fam, heats: pcs }));
const chargeMap = new Map();
for (const h of heats) for (const i of [1, 2, 3, 4, 5, 6]) for (const [kind, id, kg] of [['Scrap', h[`scrap_${i}`], h[`scrap_kg_${i}`]], ['Alloy', h[`ferro_alloy_${i}`], h[`ferro_alloy_kg_${i}`]], ['Returns', h[`return_${i}`], h[`return_kg_${i}`]]]) {
  if (!kg || kg <= 0) continue;
  const row = { mo: d10(h.melting_date).slice(0, 7), m: family(h.metal_id), kind, item: kind === 'Returns' ? 'Returns' : (itemName.get(id) || 'Not set') };
  const k = JSON.stringify(row); const a = chargeMap.get(k) || { ...row, kg: 0 }; a.kg = round(a.kg + kg, 1); chargeMap.set(k, a);
}
const energy = all(`select electricity_and_solar_consumption_date dt, kwh, melting_furnace mf, solar_1 s1, solar_2 s2, gas_meter_1 g1, gas_meter_2 g2 from tbl_electricity_and_solar_consumption where electricity_and_solar_consumption_date>='${W0}' order by 1`).map((r) => ({ ...r, dt: d10(r.dt) }));

// ── Outside vendors ──
const supName = new Map(all('select supplier_id id, supplier_name n from tbl_supplier_master').map((s) => [s.id, s.n]));
const inw = new Map(); for (const r of all('select x.manual_casting_outward_detail_id id, m.manual_casting_inward_date dt, x.inward_quantity q from tbl_manual_casting_inward_detail x join tbl_manual_casting_inward_master m using(manual_casting_inward_id)')) { if (!inw.has(r.id)) inw.set(r.id, []); inw.get(r.id).push(r); }
const vendors = all(`select x.manual_casting_outward_detail_id id, m.manual_casting_outward_no no, x.die_id die, m.manual_casting_outward_date dt, m.supplier_id s, f.process_name p, x.outward_quantity q, x.total_weight t from tbl_manual_casting_outward_detail x join tbl_manual_casting_outward_master m using(manual_casting_outward_id) left join tbl_for_process_master f on f.for_process_id=m.for_process_id where m.manual_casting_outward_date>='${W0}' and coalesce(m.is_cancel,0)=0`).map((o) => {
  const a = inw.get(o.id) || []; const got = sum(a, (e) => e.q); const last = a.length ? a.reduce((x, e) => (e.dt > x ? e.dt : x), a[0].dt) : null; const g = last ? days(o.dt, last) : null;
  return { dt: d10(o.dt), p: o.p || 'Not set', v: supName.get(o.s) || 'Not set', t: round(o.t, 1), days: g != null && g >= 0 ? g : null, openKg: got < o.q && o.q > 0 ? round(((o.q - got) / o.q) * o.t, 1) : 0, no: o.no, die: o.die, q: o.q, got, rj: 0 };
});
const fettlingIn = new Map(); for (const r of all('select x.manual_fettling_outward_detail_id id, m.manual_fettling_inward_date dt, x.reveive_qty q, x.rejection_qty rj from tbl_manual_fettling_inward_detail x join tbl_manual_fettling_inward_master m using(manual_fettling_inward_id)')) { if (!fettlingIn.has(r.id)) fettlingIn.set(r.id, []); fettlingIn.get(r.id).push(r); }
for (const o of all(`select x.manual_fettling_outward_detail_id id, m.manual_fettling_outward_no no, m.manual_fettling_outward_date dt, m.from_id src, x.die_id die, x.description part, x.issue_qty q, x.issue_wt t from tbl_manual_fettling_outward_detail x join tbl_manual_fettling_outward_master m using(manual_fettling_outward_id) where m.manual_fettling_outward_date>='${W0}'`)) {
  const a = fettlingIn.get(o.id) || []; const got = sum(a, (e) => e.q); const last = a.length ? a.reduce((x, e) => (e.dt > x ? e.dt : x), a[0].dt) : null; const g = last ? days(o.dt, last) : null;
  vendors.push({ dt: d10(o.dt), p: 'Contract fettling', v: `Fettling (ERP code ${o.src})`, t: round(o.t, 1), days: g != null && g >= 0 ? g : null, openKg: got < o.q && o.q > 0 ? round(((o.q - got) / o.q) * o.t, 1) : 0, no: o.no, die: o.die, part: o.part, q: o.q, got, rj: sum(a, (e) => e.rj) });
}


// ── Each production step ──
const step2 = (stage, mo, b) => { const dm = dimsOfBatch(b); return { stage, mo, f: dm.f, m: dm.m }; };
const stepParts = aggregate(flowRows, (r) => ({ ...step2(r.stage, r.e.dt.slice(0, 7), r.b), die: r.b.die }), (a, r) => { a.kg = round(a.kg + r.e.qi * r.b.w, 1); a.pcs += r.e.qi; });
const dispRaw = all(`select x.order_item_id oi, x.die_id die, x.customer_metal_id cm, x.dispatch_quantity q, x.raw_casting_weight w, m.dispatch_date dt, m.customer_id c, m.dispatch_id id from tbl_dispatch_oa_detail x join tbl_dispatch_intimation_master m using(dispatch_id) where m.dispatch_date>='${W0}' and m.dispatch_date<='${AS_OF} 23:59'`);
for (const row of aggregate(dispRaw, (r) => { const dm = dimsOfLine(r.oi, { cm: r.cm, die: r.die, w: r.w, c: r.c }); return { stage: 'Dispatched', mo: d10(r.dt).slice(0, 7), f: dm.f, m: dm.m, die: r.die }; }, (a, r) => { a.kg = round(a.kg + r.q * (r.w || 0), 1); a.pcs += r.q; })) stepParts.push(row);

// Days from the previous step's first entry to this step's first entry, per batch line.
const firstOf = (m, id) => { const a = m.get(id); return a ? a.reduce((x, e) => (e.dt < x ? e.dt : x), a[0].dt) : null; };
const lastOf = (m, id) => { const a = m.get(id); return a ? a.reduce((x, e) => (e.dt > x ? e.dt : x), a[0].dt) : null; };
const PREV = { Assembly: 'Injection', Coating: 'Assembly', Dewaxing: 'Coating', Melting: 'Dewaxing', Fettling: 'Melting', 'Heat treatment': 'Melting', Inspection: 'Melting', 'Machining inspection': 'Inspection', Cleared: 'Inspection' };
const batchDate = new Map(all('select b.batch_item_id id, m.batch_date dt from tbl_batch_detail b join tbl_batch_master m using(batch_id)').map((r) => [r.id, d10(r.dt)]));
const gapMap = new Map();
for (const [stage, m] of Object.entries(STAGES)) for (const id of m.keys()) {
  const b = bi.get(id); if (!b) continue; const here = firstOf(m, id); if (!here || here < W0 || here > AS_OF) continue;
  const before = stage === 'Injection' ? batchDate.get(id) : firstOf(STAGES[PREV[stage]] ?? new Map(), id); if (!before) continue;
  const g = days(before, here); if (g < 0) continue;
  const row = { ...step2(stage, here.slice(0, 7), b), days: g }; const k = JSON.stringify(row); const a = gapMap.get(k) || { ...row, n: 0 }; a.n += 1; gapMap.set(k, a);
}

// Pieces through the previous step and not yet entered here, for steps every batch line passes through.
const CHAIN = { Assembly: 'Injection', Coating: 'Assembly', Dewaxing: 'Coating', Melting: 'Dewaxing', Fettling: 'Melting', Inspection: 'Melting', Cleared: 'Inspection' };
const stepWait = []; const lineDue = new Map(lines.map((l) => [l.id, l.dd]));
for (const b of recent) for (const [stage, prev] of Object.entries(CHAIN)) {
  const out = upTo(STAGES[prev], b.id, 'qn', AS_OF); const inn = upTo(STAGES[stage], b.id, 'qi', AS_OF); if (out <= inn) continue;
  const dm = dimsOfBatch(b);
  stepWait.push({ stage, die: b.die, c: b.c, f: dm.f, m: dm.m, pcs: out - inn, kg: round((out - inn) * b.w, 1), since: lastOf(STAGES[prev], b.id), due: lineDue.get(b.oi) ?? null });
}

// What else the ERP records for a step.
const stepBreak = [];
const addBreak = (stage, mo, dim, key, f, m, kg, pcs) => { stepBreak.push({ stage, mo, dim, key: String(key), f, m, kg: round(kg, 1), pcs }); };
{ const hm = new Map(all(`select melting_prod_id id, furnace_id fu, shift sh from tbl_melting_production_master`).map((r) => [r.id, r]));
  const rows = all(`select x.melting_prod_id h, x.batch_item_id id, x.melting_quantity q, m.melting_date dt from tbl_melting_production_detail x join tbl_melting_production_master m using(melting_prod_id) where m.melting_date>='${W0}' and m.melting_date<='${AS_OF} 23:59'`);
  for (const dim of ['Furnace', 'Shift']) for (const a of aggregate(rows.filter((r) => bi.has(r.id)), (r) => { const b = bi.get(r.id); const h = hm.get(r.h); const dm = dimsOfBatch(b); return { mo: d10(r.dt).slice(0, 7), key: dim === 'Furnace' ? `Furnace ${h.fu}` : `Shift ${h.sh}`, f: dm.f, m: dm.m }; }, (x, r) => { x.kg = round(x.kg + r.q * bi.get(r.id).w, 1); x.pcs += r.q; })) addBreak('Melting', a.mo, dim, a.key, a.f, a.m, a.kg, a.pcs); }
{ const fix = new Map(all('select Fix_process_id id, process_name n from tbl_fix_process_master').map((r) => [r.id, String(r.n).replace(/\.$/, '')]));
  const rows = all(`select x.batch_item_id id, x.ht_qty q, x.fix_process_id p, m.heat_treatment_date dt, m.supplier_id s from tbl_heat_treatment_detail x join tbl_heat_treatment_master m using(heat_treatment_id) where m.heat_treatment_date>='${W0}' and m.heat_treatment_date<='${AS_OF} 23:59'`).filter((r) => bi.has(r.id));
  const supplier = new Map(all('select supplier_id id, supplier_name n from tbl_supplier_master').map((r) => [r.id, r.n]));
  const run = (dim, keyOf) => { for (const a of aggregate(rows, (r) => { const dm = dimsOfBatch(bi.get(r.id)); return { mo: d10(r.dt).slice(0, 7), key: keyOf(r), f: dm.f, m: dm.m }; }, (x, r) => { x.kg = round(x.kg + r.q * bi.get(r.id).w, 1); x.pcs += r.q; })) addBreak('Heat treatment', a.mo, dim, a.key, a.f, a.m, a.kg, a.pcs); };
  run('Process', (r) => fix.get(r.p) || 'Not set'); run('Where', (r) => (r.s > 0 ? (supplier.get(r.s) || 'Outside') : 'In-house')); }
for (const a of aggregate(dispRaw, (r) => { const dm = dimsOfLine(r.oi, { cm: r.cm, die: r.die, w: r.w, c: r.c }); return { mo: d10(r.dt).slice(0, 7), key: isExport(r.c) ? 'Export' : 'Domestic', f: dm.f, m: dm.m }; }, (x, r) => { x.kg = round(x.kg + r.q * (r.w || 0), 1); x.pcs += r.q; })) addBreak('Dispatched', a.mo, 'Market', a.key, a.f, a.m, a.kg, a.pcs);
for (const a of aggregate(dispRaw, (r) => { const dm = dimsOfLine(r.oi, { cm: r.cm, die: r.die, w: r.w, c: r.c }); return { mo: d10(r.dt).slice(0, 7), key: custById.get(r.c)?.name || 'Not set', f: dm.f, m: dm.m }; }, (x, r) => { x.kg = round(x.kg + r.q * (r.w || 0), 1); x.pcs += r.q; })) addBreak('Dispatched', a.mo, 'Customer', a.key, a.f, a.m, a.kg, a.pcs);

// ── Machining orders ──
const machPo = all(`select s.supplier_name v, m.machining_po_no no, m.machining_po_date dt, d.die_id die, d.quantity q, d.received_quantity rq, d.total_amount am, d.machining_completion_date plan from tbl_machining_po_detail d join tbl_machining_po_master m using(machining_po_id) left join tbl_supplier_master s using(supplier_id) where m.machining_po_date>='${W0}'`).map((r) => ({ v: r.v || 'Not set', no: r.no, dt: d10(r.dt), die: r.die, q: r.q, rq: r.rq, am: round(r.am, 0), plan: d10(r.plan) }));

// ── Material suppliers ──
const items = new Map(all('select i.item_id id, i.item_name n, g.item_group_name g from tbl_item_master i left join tbl_item_group_master g using(item_group_id)').map((r) => [r.id, r]));
const purchases = all(`select s.supplier_name v, m.inward_date dt, m.inward_id doc, x.item_id item, x.quantity q, x.unit_rate rate, x.quantity*x.unit_rate val from tbl_inward_detail x join tbl_inward_master m using(inward_id) left join tbl_supplier_master s on s.supplier_id=m.supplier_id where m.inward_date>='${W0}' and m.inward_date<='${AS_OF} 23:59'`).map((r) => ({ v: r.v || 'Not set', dt: d10(r.dt), doc: r.doc, item: items.get(r.item)?.n || 'Not set', group: items.get(r.item)?.g || 'Not set', q: round(r.q, 1), val: round(r.val, 0), rate: r.rate }));
// A rate over 100 times the item's usual rate is a typing error (5,800 entered for 5.8).
{ const byItem = new Map(); for (const p of purchases) if (p.rate > 0) { if (!byItem.has(p.item)) byItem.set(p.item, []); byItem.get(p.item).push(p.rate); }
  const usual = new Map([...byItem].map(([k, a]) => [k, [...a].sort((x, y) => x - y)[Math.floor((a.length - 1) / 2)]]));
  for (const p of purchases) { if (byItem.get(p.item)?.length >= 5 && p.rate > usual.get(p.item) * 100) p.bad = 1; delete p.rate; } }
const grn = all(`select s.supplier_name v, m.grn_date dt, x.item_id item, x.grn_quantity q, x.accepted_quantity acc, x.rejected_quantity rj, pm.po_date pd from tbl_grn_detail x join tbl_grn_master m using(grn_id) left join tbl_supplier_master s on s.supplier_id=m.supplier_id left join tbl_item_po_detail pi on pi.po_item_id=x.po_item_id left join tbl_item_po_master pm on pm.po_id=pi.po_id where m.grn_date>='${W0}' and m.grn_date<='${AS_OF} 23:59'`).map((r) => { const g = r.pd ? days(d10(r.pd), d10(r.dt)) : null; return { v: r.v || 'Not set', dt: d10(r.dt), q: round(r.q, 1), acc: round(r.acc, 1), rj: round(r.rj, 1), lead: g != null && g >= 0 ? g : null }; });

// ── Shipments: how long cleared castings wait to go, and what for ──
// Cleared pieces are queued per order line in clearance order; each dispatch takes the earliest pieces cleared on or before its date.
// The shipment (one dispatch document) is the lot. A piece's wait splits at the date the last piece of its shipment was cleared:
// before it, the piece waits for the rest of its shipment; after it, the whole shipment is cleared and waiting to go.
const shipLots = []; const clearedNow = [];
{ const lineById = new Map(all('select d.order_item_id id, d.delivery_date dd, d.raw_casting_weight w, d.is_short_close sc, m.customer_id c, m.order_id so, m.order_date od from tbl_order_acceptance_detail d join tbl_order_acceptance_master m using(order_id)').map((l) => [l.id, l]));
  const queue = new Map(); for (const r of all('select wd.order_item_id oi, a.dispatch_authorize_date dt, a.authorize_quantity q from tbl_dispatch_authorization a join tbl_batch_detail b using(batch_item_id) join tbl_batch_master m using(batch_id) join tbl_work_order_detail wd on wd.work_order_item_id=m.work_order_item_id where a.dispatch_authorize_date<=? order by a.dispatch_authorize_date', `${AS_OF} 23:59`)) { if (!r.oi || !(r.q > 0)) continue; if (!queue.has(r.oi)) queue.set(r.oi, []); queue.get(r.oi).push({ dt: d10(r.dt), q: r.q }); }
  const docs = new Map();
  for (const r of all(`select x.order_item_id oi, x.dispatch_quantity q, x.raw_casting_weight w, m.dispatch_date dt, m.customer_id c, m.dispatch_id id from tbl_dispatch_oa_detail x join tbl_dispatch_intimation_master m using(dispatch_id) where m.dispatch_date<='${AS_OF} 23:59' order by m.dispatch_date, m.dispatch_id`)) {
    const dt = d10(r.dt); const qu = queue.get(r.oi) || []; let left = r.q || 0; const took = [];
    while (left > 0 && qu.length && qu[0].dt <= dt) { const a = qu[0]; const t = Math.min(a.q, left); took.push({ dt: a.dt, q: t }); a.q -= t; left -= t; if (a.q <= 0) qu.shift(); }
    if (dt < W0) continue;
    let s = docs.get(r.id); if (!s) { s = { id: r.id, dt, c: r.c, kg: 0, noClrKg: 0, lines: new Set(), pieces: [] }; docs.set(r.id, s); }
    const w = r.w || 0; s.kg += (r.q || 0) * w; s.noClrKg += left * w; s.lines.add(r.oi);
    for (const x of took) s.pieces.push({ dt: x.dt, kg: x.q * w, due: d10(lineById.get(r.oi)?.dd) });
  }
  for (const s of docs.values()) {
    const p = s.pieces; const last = p.length ? p.reduce((m, x) => (x.dt > m ? x.dt : m), p[0].dt) : null; const first = p.length ? p.reduce((m, x) => (x.dt < m ? x.dt : m), p[0].dt) : null;
    const after = last ? days(last, s.dt) : 0; const waits = new Map();
    for (const x of p) { const t = days(x.dt, s.dt); waits.set(t, (waits.get(t) || 0) + x.kg); }
    const dues = p.map((x) => x.due).filter(Boolean).sort();
    const sos = new Map(); for (const oi of s.lines) { const l = lineById.get(oi); if (l) sos.set(l.so, d10(l.od)); } const ods = [...sos.values()].filter(Boolean).sort();
    shipLots.push({ id: s.id, sos: sos.size, odSpread: ods.length ? days(ods[0], ods[ods.length - 1]) : 0, dt: s.dt, c: s.c, x: isExport(s.c) ? 'Export' : 'Domestic', kg: round(s.kg, 1), lines: s.lines.size, noClrKg: round(s.noClrKg, 1), matchedKg: round(sum(p, (x) => x.kg), 1),
      restKgD: round(sum(p, (x) => x.kg * days(x.dt, last)), 0), afterKgD: round(sum(p, (x) => x.kg * after), 0), firstClr: first, lastClr: last, firstDue: dues[0] || null, lastDue: dues[dues.length - 1] || null,
      lateKg: round(sum(p.filter((x) => x.due && x.dt <= x.due && s.dt > x.due), (x) => x.kg), 1), lateLotKg: round(sum(p.filter((x) => x.due && last <= x.due && s.dt > x.due), (x) => x.kg), 1),
      waits: [...waits].map(([t, kg]) => [t, round(kg, 1)]) });
  }
  // What is cleared and not shipped now, and since when.
  // Only the dashboard's own open order lines, and never more pieces than the line still has to ship (latest clearances first).
  for (const ol of lines) { if (ol.sc || ol.full) continue; const qu = queue.get(ol.id); const l = lineById.get(ol.id); if (!qu?.length || !l) continue; let left = Math.max(0, ol.q - ol.shipQty);
    for (const a of [...qu].reverse()) { if (left <= 0) break; const t = Math.min(a.q, left); left -= t; if (t > 0) clearedNow.push({ c: l.c, oi: ol.id, kg: round(t * (l.w || 0), 1), days: days(a.dt, AS_OF), due: d10(l.dd) }); } }
}

// ── Daily output per step: the last 60 days, for the day-to-day screen ──
const DAY0 = new Date(Date.parse(AS_OF) - 179 * 86400000).toISOString().slice(0, 10);
const dailyFlow = aggregate(flowRows.filter((r) => r.e.dt >= DAY0), (r) => ({ stage: r.stage, dt: r.e.dt }), (a, r) => { a.kg = round(a.kg + r.e.qi * r.b.w, 1); a.pcs += r.e.qi; });
for (const a of aggregate(dispRaw.filter((r) => d10(r.dt) >= DAY0), (r) => ({ stage: 'Dispatched', dt: d10(r.dt) }), (x, r) => { x.kg = round(x.kg + r.q * (r.w || 0), 1); x.pcs += r.q; })) dailyFlow.push(a);

// ── Material stock against use: store stock, what the issue slips took out, and the item's purchase lead time ──
const issueSince = (n) => new Date(Date.parse(AS_OF) - (n - 1) * 86400000).toISOString().slice(0, 10);
const stock = (() => {
  const use = new Map();
  for (const r of all('select x.item_id it, m.slip_date dt, x.issue_quantity q from tbl_material_issue_slip_detail x join tbl_material_issue_slip_master m using(slip_id) where m.slip_date>=? and m.slip_date<=?', issueSince(365), AS_OF + ' 23:59')) {
    const a = use.get(r.it) || { u90: 0, u365: 0, last: null }; const dt = d10(r.dt); a.u365 += r.q || 0; if (dt >= issueSince(90)) a.u90 += r.q || 0; if (!a.last || dt > a.last) a.last = dt; use.set(r.it, a);
  }
  const lastBuy = new Map();
  for (const p of all('select x.item_id it, m.inward_date dt, x.unit_rate rate, s.supplier_name v from tbl_inward_detail x join tbl_inward_master m using(inward_id) left join tbl_supplier_master s on s.supplier_id=m.supplier_id where m.inward_date<=? order by m.inward_date', AS_OF + ' 23:59')) lastBuy.set(p.it, { dt: d10(p.dt), rate: p.rate, v: p.v });
  const units = new Map(all('select unit_id k, unit_short_name v from tbl_unit_master').map((r) => [r.k, r.v]));
  return all('select i.item_id id, i.item_name n, g.item_group_name g, i.unit_id u, i.current_stock st, i.purchase_lead_time lead from tbl_item_master i left join tbl_item_group_master g using(item_group_id)').map((i) => {
    const u = use.get(i.id); const b = lastBuy.get(i.id);
    return { id: i.id, item: String(i.n || '').trim(), group: i.g || 'Not set', unit: units.get(i.u) || '', stock: round(i.st || 0, 1), used90: round(u?.u90 || 0, 1), used365: round(u?.u365 || 0, 1), lastIssue: u?.last || null, lead: i.lead || 0, lastBuy: b?.dt || null, lastRate: b?.rate ?? null, lastVendor: b?.v || null };
  }).filter((r) => r.stock > 0 || r.used365 > 0);
})();

// ── Customer rejections: castings a customer rejected, as entered ──
const custRej = all('select customer_reject_date dt, customer_id c, die_id die, reject_quantity q, raw_casting_weight w, rejection_reason reason, heat_no heat from tbl_customer_rejection where customer_reject_date>=? and customer_reject_date<=?', W0, AS_OF + ' 23:59')
  .map((r) => ({ dt: d10(r.dt), c: r.c, die: r.die, q: r.q, kg: round((r.q || 0) * (r.w || 0), 1), reason: String(r.reason || '').trim() || 'Not set', heat: r.heat }));

// ── Order journey, planning and sub-batches ──
// "Done" at a stage is the date the line's cumulative good pieces there first reach the ordered quantity.
const reachQ = (m, ids, q, f) => { const ev = []; for (const id of ids) for (const e of m.get(id) || []) ev.push(e); ev.sort((a, b) => (a.dt < b.dt ? -1 : 1)); let c = 0; for (const e of ev) { c += e[f] || 0; if (c >= q) return e.dt; } return null; };
const batchRows = all("select bm.batch_id id, bm.batch_date bd, bm.batch_type bt, bm.batch_quantity bq, coalesce(pd.prod_planing_type,'Regular') ty, wd.order_item_id oi, bm.customer_id c from tbl_batch_master bm left join tbl_production_planing_detail pd on pd.prod_planing_item_id=bm.prod_planing_item_id left join tbl_work_order_detail wd on wd.work_order_item_id=bm.work_order_item_id").map((r) => ({ ...r, bd: d10(r.bd) }));
const batchesByOI = new Map(); for (const b of batchRows) if (b.oi && b.bt === 1) { if (!batchesByOI.has(b.oi)) batchesByOI.set(b.oi, []); batchesByOI.get(b.oi).push(b); }
const subsByBatch = new Map(); for (const r of all('select batch_item_id id, batch_id bid, batch_code code, batch_quantity q, raw_casting_weight w from tbl_batch_detail')) { if (!subsByBatch.has(r.bid)) subsByBatch.set(r.bid, []); subsByBatch.get(r.bid).push(r); }
const journey = lines.filter((l) => l.od >= W0 && !l.sc).map((l) => {
  const ids = itemsByOI.get(l.id) || []; const bs = (batchesByOI.get(l.id) || []).sort((a, b) => (a.bd < b.bd ? -1 : 1)); const reg = bs.filter((b) => b.ty === 'Regular'); const start = bs[0]?.bd || null;
  const injDone = reachQ(inj, ids, l.q, 'qn'); const pourDone = reachQ(melt, ids, l.q, 'qn'); const insDone = reachQ(ins, ids, l.q, 'qn');
  const gap = (a, b) => (a && b ? Math.max(0, days(a, b)) : null);
  const cls = !l.full ? 'Open' : l.full <= l.dd ? 'Shipped on time' : insDone && insDone <= l.dd ? 'Ready on time, shipped late' : pourDone && pourDone <= l.dd ? 'Poured on time, finished late' : 'Poured late';
  return { id: l.id, ono: l.ono, c: l.c, die: l.die, f: l.f, m: l.m, x: l.x, od: l.od, dd: l.dd, q: l.q, tn: l.tn, start, injDone, pourDone, insDone, full: l.full, sh: l.sh, cls,
    legs: { o2b: gap(l.od, start), b2inj: gap(start, injDone), inj2pour: gap(injDone, pourDone), pour2ins: gap(pourDone, insDone), ins2ship: gap(insDone, l.full) },
    batches: reg.length, rework: bs.filter((b) => b.ty === 'ReWork').length, later: reg.filter((b) => b.bd > (reg[0]?.bd || '')).length, planned: round(l.q ? sum(reg, (b) => b.bq) / l.q : null, 2),
    subs: sum(bs, (b) => (subsByBatch.get(b.id) || []).length) };
});
// One row per production batch started in the window: how it was split and how its sub-batches moved.
const batchFacts = [];
{ const lastOf = (m, id) => { let x = null; for (const e of m.get(id) || []) if (!x || e.dt > x) x = e.dt; return x; }; const firstOf = (m, id) => { let x = null; for (const e of m.get(id) || []) if (!x || e.dt < x) x = e.dt; return x; };
  for (const b of batchRows) { if (b.bt !== 1 || !b.bd || b.bd < W0 || b.bd > AS_OF) continue; const subs = (subsByBatch.get(b.id) || []).sort((x, y) => (x.code < y.code ? -1 : 1)); if (!subs.length) continue;
    const pours = subs.map((s) => lastOf(melt, s.id)); const insF = subs.map((s) => firstOf(ins, s.id)); const injF = subs.map((s) => firstOf(inj, s.id));
    const allPoured = pours.every(Boolean); const lastPour = allPoured ? pours.reduce((m, x) => (x > m ? x : m)) : null; const allIns = insF.every(Boolean);
    const sib = []; const after = []; const p2i = [];
    if (lastPour && allIns) subs.forEach((s, k) => { if (insF[k] < pours[k]) return; sib.push(Math.min(days(pours[k], lastPour), days(pours[k], insF[k]))); after.push(Math.max(0, days(lastPour, insF[k]))); p2i.push(days(pours[k], insF[k])); });
    const injDates = injF.filter(Boolean).sort();
    const dm = dimsOfBatch({ oi: b.oi, c: b.c, die: null, cm: null, w: subs[0].w });
    batchFacts.push({ f: dm.f, m: dm.m, x: dm.x, id: b.id, c: b.c, oi: b.oi, bd: b.bd, ty: b.ty, subs: subs.length, pcs: subs.map((s) => s.q), kg: round(sum(subs, (s) => s.q * (s.w || 0)), 1), pw: subs[0].w,
      injSpread: injDates.length > 1 ? days(injDates[0], injDates[injDates.length - 1]) : null, sib: sib.length ? round(sum(sib, (x) => x) / sib.length, 1) : null, after: after.length ? round(sum(after, (x) => x) / after.length, 1) : null,
      p2i: p2i.length ? round(sum(p2i, (x) => x) / p2i.length, 1) : null, sameDayIns: allIns && subs.length > 1 ? (new Set(insF).size === 1 ? 1 : 0) : null }); } }
// Each customer's shipping rhythm: shipments (dispatch days at least a quarter of the usual day, within 3 days counted once),
// the usual gap between them, and the slots where an expected shipment did not come, with what was ready and late then.
const rhythm = [];
{ const lineInfo = new Map(all('select d.order_item_id id, m.customer_id c, d.order_quantity q, d.raw_casting_weight w, d.delivery_date dd, d.is_short_close sc from tbl_order_acceptance_detail d join tbl_order_acceptance_master m using(order_id) where d.order_quantity>0 and d.die_invoice_type=1').map((l) => [l.id, { ...l, dd: d10(l.dd) }]));
  const clrEv = new Map(); for (const r of all('select wd.order_item_id oi, a.dispatch_authorize_date dt, a.authorize_quantity q from tbl_dispatch_authorization a join tbl_batch_detail b using(batch_item_id) join tbl_batch_master bm using(batch_id) join tbl_work_order_detail wd on wd.work_order_item_id=bm.work_order_item_id')) { if (!r.oi) continue; if (!clrEv.has(r.oi)) clrEv.set(r.oi, []); clrEv.get(r.oi).push([d10(r.dt), r.q]); }
  const linesByC = new Map(); for (const l of lineInfo.values()) { if (l.sc) continue; if (!linesByC.has(l.c)) linesByC.set(l.c, []); linesByC.get(l.c).push(l); }
  const upto = (a, dt) => (a || []).reduce((t, [x, q]) => (x <= dt ? t + q : t), 0);
  const stateAt = (c, dt) => { let ready = 0, late = 0; for (const l of linesByC.get(c) || []) { const sh = upto((shipped.get(l.id) || []).map((e) => [e.dt, e.q]), dt); const open = Math.max(0, l.q - sh); if (!open) continue; const cl = upto(clrEv.get(l.id), dt); ready += Math.min(open, Math.max(0, cl - sh)) * (l.w || 0); if (l.dd && l.dd < dt) late += open * (l.w || 0); } return [round(ready / 1000, 1), round(late / 1000, 1)]; };
  const addD = (a, n) => new Date(Date.parse(a) + n * 86400000).toISOString().slice(0, 10);
  const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor((s.length - 1) * p)] : null; };
  const byC = new Map(); for (const r of all(`select customer_id c, substr(dispatch_date,1,10) dt, sum(total_weight) kg from tbl_dispatch_intimation_master where dispatch_date>='${W0}' and dispatch_date<='${AS_OF} 23:59' group by 1,2 order by 2`)) { if (!byC.has(r.c)) byC.set(r.c, []); byC.get(r.c).push(r); }
  for (const [c, a] of byC) {
    const usual = q(a.map((r) => r.kg), 0.5); const ships = []; for (const r of a.filter((r) => r.kg >= 0.25 * usual)) { const l = ships[ships.length - 1]; if (l && days(l[0], r.dt) <= 3) l[1] += r.kg; else ships.push([r.dt, r.kg]); }
    if (ships.length < 4) continue; const gaps = ships.slice(1).map((s, i) => days(ships[i][0], s[0])); const m = q(gaps, 0.5);
    const skips = []; for (let i = 1; i < ships.length; i++) { const g = days(ships[i - 1][0], ships[i][0]); if (g > Math.max(1.6 * m, m + 14)) { const exp = addD(ships[i - 1][0], m); skips.push([exp, ...stateAt(c, exp)]); } }
    const last = ships[ships.length - 1][0]; const nextDue = addD(last, m);
    rhythm.push({ c, x: isExport(c) ? 'Export' : 'Domestic', median: m, p25: q(gaps, 0.25), p75: q(gaps, 0.75), ships: ships.map(([d, kg]) => [d, round(kg / 1000, 2)]), skips, last, next: nextDue, nowAt: stateAt(c, AS_OF) });
  } }
// Sales orders placed in the window, with their total weight: to set beside shipment sizes.
const salesOrders = all(`select m.order_id id, m.order_no no, m.customer_id c, m.order_date od, sum(d.total_weight) kg, count(*) n from tbl_order_acceptance_master m join tbl_order_acceptance_detail d using(order_id) where m.order_date>='${W0}' and m.order_date<='${AS_OF} 23:59' and d.order_quantity>0 and d.die_invoice_type=1 group by 1`).map((r) => ({ id: r.id, no: r.no, c: r.c, x: isExport(r.c) ? 'Export' : 'Domestic', od: d10(r.od), kg: round(r.kg, 1), n: r.n }));

const usedDies = new Set([...lines.map((l) => l.die), ...sales.map((s) => s.die), ...rej.map((r) => r.die), ...dieMelt.map((r) => r.die)]);
const parts = [...usedDies].filter(Boolean).map((id) => ({ id, name: dieM.get(id)?.de || `Part ${id}` }));
const usedCust = new Set([...lines.map((l) => l.c), ...sales.map((s) => s.c), ...rej.map((r) => r.c), ...dieMelt.map((r) => r.c)]);
const mach = all("select d.machining_completion_date plan, d.actual_completion_date act, m.machining_po_date dt from tbl_machining_po_detail d join tbl_machining_po_master m using(machining_po_id) where m.machining_po_date>=?", W0);

const facts = {
  meta: [{ asOf: AS_OF, from: W0, machPlan: { lines: mach.length, planned: mach.filter((r) => r.plan).length, actual: mach.filter((r) => r.plan && r.act).length } }],
  customers: customers.filter((c) => usedCust.has(c.id)), parts, sales, disp, lines, rej, control, flow, workDays: workDayRows, dieMelt, wip, heats: heatRows, charge: [...chargeMap.values()], energy, vendors, machPo, purchases, grn, stepParts, stepGap: [...gapMap.values()], stepWait, stepBreak, shipLots, clearedNow, journey, batchFacts, rhythm, salesOrders, dailyFlow, stock, custRej,
};
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(facts));
for (const [k, v] of Object.entries(facts)) console.log(k.padEnd(10), v.length);
console.log('sales cr', round(sum(sales, (s) => s.am) / 1e7, 2), 'dispatched t', round(sum(disp, (r) => r.kg) / 1000, 1), 'poured t', round(sum(flow.filter((r) => r.stage === 'Melting'), (r) => r.kg) / 1000, 1), 'rejected t', round(sum(rej, (r) => r.kg) / 1000, 1), 'heats', heats.length);
