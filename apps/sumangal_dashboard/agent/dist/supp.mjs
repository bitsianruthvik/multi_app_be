// Supplement for the merged dashboard: fields V13's data does not carry. Read-only on the ERP copy.
import { DatabaseSync } from 'node:sqlite';
import fs from 'fs';
const WORK = process.env.SUMANGAL_WORK || 'D:/SumangalData/work';
const here = (f) => WORK + '/' + f;
const s = fs.readFileSync(here('v13-data.js'), 'utf8'); const D = JSON.parse(s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1));
const db = new DatabaseSync(process.env.SUMANGAL_DB || 'D:/SumangalData/work/casting.sqlite', { readOnly: true });
const all = (q) => db.prepare(q).all();
const D0 = Date.UTC(2024, 0, 1);
const day = (x) => (x ? Math.round((Date.UTC(+x.slice(0, 4), +x.slice(5, 7) - 1, +x.slice(8, 10)) - D0) / 864e5) : null);

// batch items
const bi = new Map(all(`select d.batch_item_id id, trim(d.batch_item_no) no, m.batch_type bt, m.work_order_item_id wi from tbl_batch_detail d join tbl_batch_master m using(batch_id)`).map((r) => [r.no, r]));
const wo = new Map(all(`select d.work_order_item_id wi, trim(w.work_order_no) no, w.work_order_type_value t, d.order_item_id oi, trim(coalesce(d.remarks,'')) rm from tbl_work_order_detail d join tbl_work_order_master w using(work_order_id)`).map((r) => [r.wi, r]));
const ordIx = new Map(D.ord.map((o, i) => [o[0], i]));
const heats = new Map();
for (const r of all(`select d.batch_item_id id, coalesce(nullif(trim(m.manual_heat_no),''),trim(m.heat_no)) h from tbl_melting_production_detail d join tbl_melting_production_master m using(melting_prod_id)`)) { const x = heats.get(r.id) || new Set(); if (r.h) x.add(r.h); heats.set(r.id, x); }
const it = D.items.map((x) => { const b = bi.get(String(x[0]).trim()); const w = b ? wo.get(b.wi) : null; return [w ? w.no : '', b && heats.has(b.id) ? [...heats.get(b.id)].join(' ') : '', b ? b.bt : 0, w && w.oi && ordIx.has(w.oi) ? ordIx.get(w.oi) : -1, w ? w.t : 0]; });

// plan quantity per order line (all work order lines of the order line)
const planByOi = new Map(all(`select wd.order_item_id oi, sum(pd.planing_quantity) p, sum(pd.prod_planing_value=2) rw from tbl_production_planing_detail pd join tbl_work_order_detail wd on wd.work_order_item_id=pd.work_order_item_id group by 1`).map((r) => [r.oi, r]));
const plan = D.ord.map((o) => { const p = planByOi.get(o[0]); return p ? Math.round(p.p) : 0; });

// parts: die id -> V13 part index (by die number)
const pIx = new Map(D.parts.map((p, i) => [String(p[0]).trim(), i]));
const dies = new Map(all(`select die_id, trim(die_no) no, substr(created_date,1,10) c, die_status_name st from tbl_die_master`).map((r) => [r.die_id, r]));
const partOf = (dieId) => { const d = dies.get(dieId); return d && pIx.has(d.no) ? pIx.get(d.no) : -1; };

// manual work orders (type 2) since 1 Jan 2024
const ords = all(`select d.die_id, substr(m.order_date,1,10) d from tbl_order_acceptance_detail d join tbl_order_acceptance_master m using(order_id)`);
const ordDays = new Map(); for (const o of ords) (ordDays.get(o.die_id) || ordDays.set(o.die_id, []).get(o.die_id)).push(day(o.d));
for (const a of ordDays.values()) a.sort((x, y) => x - y);
const prodBatch = new Map(all(`select b.die_id, min(substr(m.batch_date,1,10)) d from tbl_batch_detail b join tbl_batch_master m using(batch_id) where m.batch_type=1 group by 1`).map((r) => [r.die_id, day(r.d)]));
const man = all(`select trim(w.work_order_no) no, substr(w.work_order_date,1,10) d, d.die_id, d.order_quantity q, trim(coalesce(d.remarks,'')) rm, w.work_order_type_value t from tbl_work_order_detail d join tbl_work_order_master w using(work_order_id) where w.work_order_type_value in (2,3) and substr(w.work_order_date,1,10)>='2024-01-01'`).map((r) => {
  const t = day(r.d); const dm = dies.get(r.die_id) || {}; const od = ordDays.get(r.die_id) || [];
  const prev = od.filter((x) => x < t).length; const next = od.find((x) => x >= t);
  return [r.no, t, partOf(r.die_id), Math.round(r.q), r.rm.replace(/\s+/g, ' ').slice(0, 60), day(dm.c), dm.st || '', prev ? 1 : 0, next != null ? next - t : null, prodBatch.has(r.die_id) ? prodBatch.get(r.die_id) - t : null, r.t];
});

// heats since 21 Oct 2024: [day, kg poured, batch items]
const heatRows = all(`select substr(m.melting_date,1,10) d, sum(d.melting_quantity*b.raw_casting_weight) kg, count(distinct d.batch_item_id) n from tbl_melting_production_detail d join tbl_melting_production_master m using(melting_prod_id) join tbl_batch_detail b on b.batch_item_id=d.batch_item_id where substr(m.melting_date,1,10)>='2024-10-21' group by m.melting_prod_id`).map((r) => [day(r.d), Math.round(r.kg), r.n]);

const S = { it, plan, man, heats: heatRows };
const js = JSON.stringify(S);
fs.writeFileSync(here('supp.json'), js);
console.log('bytes', js.length, 'items with WO', it.filter((x) => x[0]).length, 'with heats', it.filter((x) => x[1]).length, 'with ord', it.filter((x) => x[3] >= 0).length, 'manual', man.length, 'heats', heatRows.length, 'plan>0', plan.filter((x) => x).length);
