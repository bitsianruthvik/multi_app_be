import { pool } from '../../../db.js';

/**
 * Every figure is added up here from sd_rows, in memory, for the filters asked.
 * Only what the ERP records: no estimated costs, no forecasts, no attribution.
 * A line is on time when dispatched quantity reached ordered quantity by its delivery date.
 */
const CACHE_MS = 5 * 60 * 1000;
const cache = new Map();
const fail = (status, message) => Object.assign(new Error(message), { status });
const DATASETS = ['meta', 'customers', 'parts', 'sales', 'disp', 'lines', 'rej', 'control', 'flow', 'workDays', 'dieMelt', 'wip', 'heats', 'charge', 'energy', 'vendors', 'machPo', 'purchases', 'grn', 'stepParts', 'stepGap', 'stepWait', 'stepBreak', 'shipLots', 'clearedNow', 'journey', 'batchFacts', 'rhythm', 'salesOrders'];

async function load(companyId) {
  const hit = cache.get(companyId);
  if (hit && hit.until > Date.now()) return hit.data;
  const [rows] = await pool.query('SELECT dataset, data FROM sd_rows WHERE company_id = ?', [companyId]);
  const d = Object.fromEntries(DATASETS.map((k) => [k, []]));
  for (const r of rows) d[r.dataset]?.push(typeof r.data === 'string' ? JSON.parse(r.data) : r.data);
  if (!d.meta.length) throw fail(404, 'No data has been loaded for this company yet.');
  d.m = d.meta[0];
  d.custName = new Map(d.customers.map((c) => [c.id, c.name]));
  d.partName = new Map(d.parts.map((p) => [p.id, p.name]));
  cache.set(companyId, { until: Date.now() + CACHE_MS, data: d });
  return d;
}

// ── Helpers ──
const sum = (a, f) => a.reduce((t, x) => t + (f(x) || 0), 0);
const median = (a) => { const v = a.filter((x) => x != null && !Number.isNaN(x)); if (!v.length) return null; const s = [...v].sort((x, y) => x - y); return s[Math.floor((s.length - 1) / 2)]; };
const pctl = (a, p) => { const v = a.filter((x) => x != null && !Number.isNaN(x)).sort((x, y) => x - y); return v.length ? v[Math.floor((v.length - 1) * p)] : null; };
const pct = (a, b) => (b ? (a / b) * 100 : null);
const days = (a, b) => (Date.parse(b) - Date.parse(a)) / 86400000;
const round = (v, n = 1) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** n) / 10 ** n);
const groupBy = (rows, key) => { const m = new Map(); for (const r of rows) { const k = key(r); if (!m.has(k)) m.set(k, []); m.get(k).push(r); } return m; };
const addMonths = (mo, n) => { const [y, m] = mo.split('-').map(Number); return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7); };
const tonnes = (kg) => round(kg / 1000);
const byMonth = (a, b) => (a.mo < b.mo ? -1 : 1);

export const LEGS = [['plan', 'Order to plan'], ['wax', 'Plan to last injection'], ['melt', 'Last injection to last pour'], ['postPour', 'Last pour to last inspection'], ['clear', 'Last inspection to cleared'], ['ship', 'Cleared to fully shipped']];
const STAGE_ORDER = ['Injection', 'Assembly', 'Coating', 'Dewaxing', 'Melting', 'Fettling', 'Heat treatment', 'Inspection', 'Machining inspection', 'Cleared', 'Dispatched'];

// ── Filters ──
const DIM = { finish: 'f', metal: 'm', weight: 'w', size: 's', market: 'x', repeat: 'n', tests: 't' };
const dimFilter = (q) => { const checks = Object.entries(DIM).filter(([p]) => q[p]).map(([p, k]) => [k, String(q[p])]); const customer = q.customer ? Number(q.customer) : null; return (r) => checks.every(([k, v]) => r[k] === v) && (customer == null || r.c === customer); };
const inDates = (dt, q) => dt && (!q.from || dt >= q.from) && (!q.to || dt <= q.to);
const inMonths = (mo, q) => (!q.from || mo >= q.from.slice(0, 7)) && (!q.to || mo <= q.to.slice(0, 7));
const salesOf = (d, q) => { const f = dimFilter(q); return d.sales.filter((s) => f(s) && inDates(s.dt, q)); };
const dispOf = (d, q) => { const f = dimFilter(q); return d.disp.filter((s) => f(s) && inDates(s.dt, q)); };
const dueLinesOf = (d, q) => { const f = dimFilter(q); return d.lines.filter((l) => !l.sc && l.dd && l.dd <= d.m.asOf && f(l) && inDates(l.dd, q)); };
const openLinesOf = (d, q) => { const f = dimFilter(q); return d.lines.filter((l) => !l.sc && !l.full && f(l)); };
const rejOf = (d, q) => { const f = dimFilter(q); return d.rej.filter((r) => f(r) && inMonths(r.mo, q)); };
const flowOf = (d, q) => { const f = dimFilter(q); return d.flow.filter((r) => f(r) && inMonths(r.mo, q)); };
const pouredKg = (d, q) => sum(flowOf(d, q).filter((r) => r.stage === 'Melting'), (r) => r.kg);

// ── Delivery ──
const isLate = (l, asOf) => (l.full ? l.full > l.dd : asOf > l.dd);
const delivery = (d, rows) => {
  const asOf = d.m.asOf; const late = rows.filter((l) => isLate(l, asOf)); const shipped = rows.filter((l) => l.full); const shippedLate = shipped.filter((l) => l.full > l.dd);
  return { lines: rows.length, onTime: rows.length - late.length, lateLines: late.length, onTimePct: round(pct(rows.length - late.length, rows.length)), medianDelay: median(shippedLate.map((l) => days(l.dd, l.full))), leadDays: median(shipped.map((l) => days(l.od, l.full))), promisedDays: median(rows.map((l) => days(l.od, l.dd))), stillOpenLate: rows.filter((l) => !l.full).length };
};
const pending = (l) => Math.max(0, l.q - l.shipQty);
const pendingKg = (l) => (l.q ? (l.tn * pending(l)) / l.q : 0);
const openRow = (d, l) => ({ id: l.id, orderNo: l.ono, customer: d.custName.get(l.c) || '', customerId: l.c, part: d.partName.get(l.die) || '', finish: l.f, due: l.dd, ordered: l.q, shipped: l.shipQty, pending: pending(l), tonnes: round(pendingKg(l) / 1000, 2), at: l.at, daysOverdue: l.dd && l.dd < d.m.asOf ? days(l.dd, d.m.asOf) : 0 });
const sales1 = (rows) => { const am = sum(rows, (s) => s.am); const kg = sum(rows, (s) => s.kg); return { sales: Math.round(am), kg: Math.round(kg), pricePerKg: round(kg ? am / kg : null, 0) }; };
const onTimeByMonth = (d, rows) => [...groupBy(rows, (l) => l.dd.slice(0, 7)).entries()].map(([mo, a]) => ({ mo, onTimePct: round(pct(a.filter((l) => !isLate(l, d.m.asOf)).length, a.length), 0), lines: a.length })).sort(byMonth);
const legMedians = (rows) => LEGS.map(([key, label]) => ({ key, label, days: median(rows.map((l) => l.legs?.[key])) }));

export async function meta(companyId) {
  const d = await load(companyId);
  const opts = (k) => [...new Set(d.lines.map((l) => l[k]).concat(d.sales.map((s) => s[k])))].filter((v) => v && v !== 'No order' && v !== 'Not set');
  const ordered = (k, order) => opts(k).sort((a, b) => order.indexOf(a) - order.indexOf(b));
  const months = [...new Set(d.sales.map((s) => s.dt.slice(0, 7)))].sort().reverse();
  return { asOf: d.m.asOf, from: d.m.from, months, options: { finish: ordered('f', ['FM', 'FM-A to F', 'PM', 'Zn', 'No code']), metal: opts('m').sort(), weight: ordered('w', ['Under 1 kg', '1–5 kg', '5–20 kg', 'Over 20 kg']), size: ordered('s', ['Under 100 kg', '100–500 kg', '0.5–2 t', 'Over 2 t']), market: opts('x').sort(), repeat: opts('n').sort().reverse(), tests: opts('t').sort(), customers: d.customers.map((c) => ({ id: c.id, name: c.name })).sort((a, b) => a.name.localeCompare(b.name)) } };
}

// ── 2. Orders ──
export async function orders(companyId, q) {
  const d = await load(companyId); const asOf = d.m.asOf;
  const open = openLinesOf(d, q); const over = open.filter((l) => l.dd && l.dd < asOf); const due = dueLinesOf(d, q);
  const band = (label, test) => { const a = open.filter(test); return { label, lines: a.length, tonnes: round(sum(a, pendingKg) / 1000) }; };
  const age = (l) => days(l.dd, asOf);
  const bands = [band('Over 180 days overdue', (l) => l.dd && age(l) > 180), band('91–180 days overdue', (l) => l.dd && age(l) > 90 && age(l) <= 180), band('31–90 days overdue', (l) => l.dd && age(l) > 30 && age(l) <= 90), band('1–30 days overdue', (l) => l.dd && age(l) > 0 && age(l) <= 30), band('Due in next 30 days', (l) => l.dd && age(l) <= 0 && age(l) >= -30), band('Due in 31–90 days', (l) => l.dd && age(l) < -30 && age(l) >= -90), band('Due later', (l) => l.dd && age(l) < -90), band('No delivery date', (l) => !l.dd)];
  const at = [...groupBy(open, (l) => l.at).entries()].map(([label, a]) => ({ label, lines: a.length, tonnes: round(sum(a, pendingKg) / 1000) })).sort((a, b) => b.tonnes - a.tonnes);
  const customers = [...groupBy(due, (l) => l.c).entries()].map(([c, a]) => { const openC = open.filter((l) => l.c === c); const dl = delivery(d, a); return { id: c, name: d.custName.get(c) || '', ...dl, openLines: openC.length, openTonnes: round(sum(openC, pendingKg) / 1000), overdueLines: openC.filter((l) => l.dd && l.dd < asOf).length }; }).sort((a, b) => b.lines - a.lines);
  return { kpis: { openLines: open.length, openTonnes: tonnes(sum(open, pendingKg)), overdueLines: over.length, overdueTonnes: tonnes(sum(over, pendingKg)), ...delivery(d, due) }, bands, at, customers, trend: onTimeByMonth(d, due), list: open.map((l) => openRow(d, l)).sort((a, b) => b.daysOverdue - a.daysOverdue || (b.tonnes ?? 0) - (a.tonnes ?? 0)), asOf };
}

// ── 3. Production ──
export async function production(companyId, q) {
  const d = await load(companyId); const flow = flowOf(d, q); const dsp = dispOf(d, q); const f = dimFilter(q);
  const workDays = (stage) => sum(d.workDays.filter((w) => w.stage === stage && inMonths(w.mo, q)), (w) => w.days);
  const stages = STAGE_ORDER.filter((s) => s !== 'Dispatched').map((stage) => { const a = flow.filter((r) => r.stage === stage); const kg = sum(a, (r) => r.kg); const wd = workDays(stage); return { stage, tonnes: tonnes(kg), kgPerDay: wd ? Math.round(kg / wd) : null, workDays: wd, pieces: sum(a, (r) => r.pcs) }; });
  const dkg = sum(dsp, (r) => r.kg); const ddays = new Set(dsp.map((r) => r.dt)).size;
  stages.push({ stage: 'Dispatched', tonnes: tonnes(dkg), kgPerDay: ddays ? Math.round(dkg / ddays) : null, workDays: ddays, pieces: sum(dsp, (r) => r.pcs) });
  const months = [...new Set(flow.map((r) => r.mo))].sort().map((mo) => { const a = flow.filter((r) => r.mo === mo); const pick = (s) => tonnes(sum(a.filter((r) => r.stage === s), (r) => r.kg)); return { mo, injection: pick('Injection'), melting: pick('Melting'), inspection: pick('Inspection'), dispatched: tonnes(sum(dsp.filter((r) => r.dt.startsWith(mo)), (r) => r.kg)) }; });
  const wip = d.wip.filter(f); const start = addMonths(d.m.from.slice(0, 7), 3);
  const dates = [...new Set(wip.map((r) => r.me))].filter((me) => me.slice(0, 7) >= start).sort();
  const series = dates.map((me) => { const a = wip.filter((r) => r.me === me); const pick = (b) => tonnes(sum(a.filter((r) => r.bucket === b), (r) => r.kg)); return { me, injected: pick('Injected, not poured'), poured: pick('Poured, not inspected'), inspected: pick('Inspected, not cleared') }; });
  const open = openLinesOf(d, q); const cleared = sum(open.filter((l) => l.at === 'Cleared, not shipped'), pendingKg);
  return { stages, months, wip: series, now: series.at(-1) ?? {}, clearedNotShipped: tonnes(cleared), asOf: d.m.asOf };
}

// ── 4. Quality ──
export async function quality(companyId, q) {
  const d = await load(companyId); const rej = rejOf(d, q); const flow = flowOf(d, q); const poured = pouredKg(d, q); const rk = sum(rej, (r) => r.kg); const f = dimFilter(q);
  const stages = ['Injection', 'Assembly', 'Coating', 'Dewaxing', 'Melting', 'Fettling', 'Inspection', 'Machining inspection'].map((stage) => { const kg = sum(flow.filter((r) => r.stage === stage), (r) => r.kg); const r = sum(rej.filter((x) => x.area === stage), (x) => x.kg); return { stage, inputTonnes: tonnes(kg), rejectedKg: Math.round(r), pct: round(pct(r, kg), 2) }; });
  const reasons = [...groupBy(rej, (r) => r.reason).entries()].map(([reason, a]) => ({ reason: reason.replace(/_/g, ' – '), kg: Math.round(sum(a, (r) => r.kg)), pieces: sum(a, (r) => r.pcs), share: round(pct(sum(a, (r) => r.kg), rk), 0) })).sort((a, b) => b.kg - a.kg);
  const pouredBy = (rows, key) => { const m = new Map(); for (const r of rows) m.set(r[key], (m.get(r[key]) || 0) + r.kg); return m; };
  const melt = d.dieMelt.filter((r) => f(r) && inMonths(r.mo, q)); const byC = pouredBy(melt, 'c'); const byDie = pouredBy(melt, 'die'); const byM = pouredBy(melt, 'm');
  const breakdown = (key, label, den, minKg) => [...groupBy(rej, (r) => r[key]).entries()].filter(([k]) => (den.get(k) || 0) >= minKg).map(([k, a]) => ({ key: k, name: label(k), pouredTonnes: tonnes(den.get(k)), rejectedKg: Math.round(sum(a, (r) => r.kg)), pct: round(pct(sum(a, (r) => r.kg), den.get(k))) })).sort((a, b) => b.rejectedKg - a.rejectedKg);
  const control = new Map(d.control.map((c) => [c.dep, c.pct]));
  const departments = [...groupBy(rej, (r) => r.dep).entries()].map(([dep, a]) => ({ department: dep, rejectedKg: Math.round(sum(a, (r) => r.kg)), pct: round(pct(sum(a, (r) => r.kg), poured), 2), control: control.get(dep) ?? null })).sort((a, b) => b.rejectedKg - a.rejectedKg);
  const months = [...groupBy(flow.filter((r) => r.stage === 'Melting'), (r) => r.mo).entries()].map(([mo, a]) => ({ mo, pct: round(pct(sum(rej.filter((r) => r.mo === mo), (r) => r.kg), sum(a, (r) => r.kg))) })).sort(byMonth);
  return { kpis: { rejectedKg: Math.round(rk), pieces: sum(rej, (r) => r.pcs), pouredTonnes: tonnes(poured), pct: round(pct(rk, poured)) }, stages, reasons: reasons.slice(0, 15), customers: breakdown('c', (k) => d.custName.get(k) || `Customer ${k}`, byC, 1000).slice(0, 40), parts: breakdown('die', (k) => d.partName.get(k) || `Part ${k}`, byDie, 500).slice(0, 40), metals: breakdown('m', (k) => k, byM, 1000), departments, months };
}

// ── 5. Melting and energy ──
const METERS = [['main', ['kwh']], ['furnace', ['mf']], ['solar', ['s1', 's2']], ['gas', ['g1', 'g2']]];
export async function melting(companyId, q) {
  const d = await load(companyId); const metalOk = (r) => !q.metal || r.m === q.metal;
  const heats = d.heats.filter((r) => metalOk(r) && inDates(r.dt, q));
  const total = sum(heats, (r) => r.heats); const perDay = [...groupBy(heats, (r) => r.dt).values()].map((a) => sum(a, (r) => r.heats));
  const heatMonths = [...groupBy(heats, (r) => r.dt.slice(0, 7)).entries()].map(([mo, a]) => ({ mo, heats: sum(a, (r) => r.heats), days: new Set(a.map((r) => r.dt)).size })).sort(byMonth);
  const charge = d.charge.filter((r) => metalOk(r) && inMonths(r.mo, q));
  const kinds = ['Scrap', 'Alloy', 'Returns'].map((k) => ({ kind: k, tonnes: tonnes(sum(charge.filter((r) => r.kind === k), (r) => r.kg)) }));
  const items = [...groupBy(charge.filter((r) => r.kind !== 'Returns'), (r) => r.item).entries()].map(([item, a]) => ({ item, kind: a[0].kind, tonnes: round(sum(a, (r) => r.kg) / 1000, 1) })).sort((a, b) => b.tonnes - a.tonnes).slice(0, 12);
  const flow = d.flow.filter((r) => r.stage === 'Melting' && metalOk(r) && inMonths(r.mo, q)); const cast = sum(flow, (r) => r.kg); const chargeKg = sum(charge, (r) => r.kg);
  // Meter readings are running totals. A fall, or a jump over 10 times the usual day, is a typing error or a reset: that day isn't counted.
  const rows = d.energy; const skipped = {}; const delta = {};
  for (const [meter, cols] of METERS) for (const col of cols) {
    const raw = rows.slice(1).map((r, i) => { const g = days(rows[i].dt, r.dt); return g > 0 && r[col] != null && rows[i][col] != null ? (r[col] - rows[i][col]) / g : null; });
    const usual = median(raw.filter((v) => v > 0));
    rows.slice(1).forEach((r, i) => { const v = raw[i]; if (!inDates(r.dt, q)) return; const mo = r.dt.slice(0, 7); if (v == null || v < 0 || v > usual * 10) { skipped[meter] = (skipped[meter] || 0) + 1; return; } const g = days(rows[i].dt, r.dt); delta[mo] = delta[mo] || {}; delta[mo][meter] = (delta[mo][meter] || 0) + v * g; });
  }
  const meltByMonth = new Map([...groupBy(d.flow.filter((r) => r.stage === 'Melting' && inMonths(r.mo, q)), (r) => r.mo).entries()].map(([mo, a]) => [mo, sum(a, (r) => r.kg)]));
  const energy = Object.keys(delta).sort().map((mo) => ({ mo, main: Math.round(delta[mo].main ?? 0), furnace: Math.round(delta[mo].furnace ?? 0), solar: Math.round(delta[mo].solar ?? 0), gas: Math.round(delta[mo].gas ?? 0), meltedTonnes: tonnes(meltByMonth.get(mo) || 0), mainPerTonne: meltByMonth.get(mo) ? Math.round((delta[mo].main ?? 0) / (meltByMonth.get(mo) / 1000)) : null }));
  return { kpis: { heats: total, heatsPerDay: median(perDay), workingDays: perDay.length, castTonnes: tonnes(cast), chargeTonnes: tonnes(chargeKg), yieldPct: round(pct(cast, chargeKg)) }, heatMonths, kinds, items, energy, skipped, asOf: d.m.asOf };
}

// ── Customers ──
function customerRows(d, q) {
  const sales = salesOf(d, q); const lines = groupBy(dueLinesOf(d, q), (l) => l.c); const f = dimFilter(q); const total = sum(sales, (s) => s.am);
  const orders = groupBy(d.lines.filter((l) => f(l) && inDates(l.od, q)), (l) => l.c);
  return [...groupBy(sales, (s) => s.c).entries()].map(([c, a]) => {
    const e = sales1(a); const invDates = [...new Set(a.map((s) => s.dt))].sort(); const gaps = invDates.slice(1).map((x, i) => days(invDates[i], x));
    const dl = delivery(d, lines.get(c) || []); const O = orders.get(c) || []; const oids = new Set(O.map((l) => l.ono));
    return { id: c, name: d.custName.get(c) || `Customer ${c}`, ...e, share: round(pct(e.sales, total)), orders: oids.size, tonnesPerOrder: oids.size ? round(sum(O, (l) => l.tn) / 1000 / oids.size) : null, billedEvery: median(gaps), invoices: invDates.length, parts: new Set(a.map((s) => s.die)).size, creditDays: median(a.filter((s) => s.due).map((s) => days(s.dt, s.due))), onTimePct: dl.onTimePct, medianDelay: dl.medianDelay, leadDays: dl.leadDays, promisedDays: dl.promisedDays, dueLines: dl.lines };
  }).sort((a, b) => b.sales - a.sales);
}

export async function customers(companyId, q) {
  const d = await load(companyId); const rows = customerRows(d, q); const sales = salesOf(d, q); const e = sales1(sales); const dl = delivery(d, dueLinesOf(d, q));
  const tiers = [['Largest customer', rows.slice(0, 1)], ['Next 4', rows.slice(1, 5)], ['Next 10', rows.slice(5, 15)], [`Other ${Math.max(0, rows.length - 15)}`, rows.slice(15)]].filter(([, c]) => c.length).map(([label, c]) => { const ids = new Set(c.map((x) => x.id)); const s = sales1(sales.filter((x) => ids.has(x.c))); return { label, customers: c.length, sales: s.sales, share: round(pct(s.sales, e.sales)), pricePerKg: s.pricePerKg, onTimePct: delivery(d, dueLinesOf(d, q).filter((l) => ids.has(l.c))).onTimePct }; });
  const billing = [...groupBy(sales.filter((s) => s.due), (s) => s.due.slice(0, 7)).entries()].map(([mo, a]) => ({ mo, billed: Math.round(sum(a, (s) => s.am)) })).sort(byMonth);
  const credit = [...groupBy(sales.filter((s) => s.due), (s) => Math.round(days(s.dt, s.due))).entries()].map(([k, a]) => ({ days: k, billed: Math.round(sum(a, (s) => s.am)) })).sort((a, b) => b.billed - a.billed).slice(0, 5);
  const months = [...groupBy(sales, (s) => s.dt.slice(0, 7)).entries()].map(([mo, a]) => ({ mo, sales: Math.round(sum(a, (s) => s.am)) })).sort(byMonth);
  return { kpis: { ...e, tonnes: round(e.kg / 1000), customers: rows.length, topShare: rows[0]?.share ?? null, onTimePct: dl.onTimePct }, rows, tiers, months, billing, credit, asOf: d.m.asOf };
}

export async function customerDetail(companyId, id, q) {
  const d = await load(companyId); const c = Number(id); const info = d.customers.find((x) => x.id === c); if (!info) throw fail(404, 'No such customer.');
  const qq = { ...q, customer: c }; const sales = salesOf(d, qq); const due = dueLinesOf(d, qq);
  const parts = [...groupBy(sales, (s) => s.die).entries()].map(([die, a]) => ({ die, name: d.partName.get(die) || `Part ${die}`, ...sales1(a) })).sort((a, b) => b.sales - a.sales).slice(0, 8);
  const open = openLinesOf(d, qq).map((l) => openRow(d, l)).sort((a, b) => b.daysOverdue - a.daysOverdue).slice(0, 15);
  const months = [...groupBy(sales, (s) => s.dt.slice(0, 7)).entries()].map(([mo, a]) => ({ mo, sales: Math.round(sum(a, (s) => s.am)) })).sort(byMonth);
  const poured = pouredKg(d, qq); const rk = sum(rejOf(d, qq), (r) => r.kg);
  return { id: c, name: info.name, country: info.country, terms: info.terms || null, ...sales1(sales), delivery: delivery(d, due), months, parts, stages: legMedians(due.filter((l) => l.legs)), open, rejectionPct: round(pct(rk, poured)), creditDays: median(sales.filter((s) => s.due).map((s) => days(s.dt, s.due))) };
}

// ── Delays ──
export async function delays(companyId, q) {
  const d = await load(companyId); const rows = dueLinesOf(d, q); const dl = delivery(d, rows);
  const withLegs = rows.filter((l) => l.legs); const late = withLegs.filter((l) => l.full > l.dd); const onTime = withLegs.filter((l) => l.full <= l.dd);
  const l1 = legMedians(late); const l2 = legMedians(onTime);
  const stages = LEGS.map(([key, label], i) => ({ key, label, lateDays: l1[i].days, onTimeDays: l2[i].days }));
  const longest = (l) => LEGS.map(([k, label]) => [label, l.legs[k] ?? 0]).sort((a, b) => b[1] - a[1])[0];
  const lateList = late.map((l) => { const [stage, n] = longest(l); return { id: l.id, orderNo: l.ono, customer: d.custName.get(l.c) || '', customerId: l.c, part: d.partName.get(l.die) || '', finish: l.f, due: l.dd, shipped: l.full, daysLate: days(l.dd, l.full), tonnes: round(l.tn / 1000, 2), longestStage: stage, longestDays: n }; }).sort((a, b) => b.daysLate - a.daysLate).slice(0, 500);
  return { kpis: dl, stages, trend: onTimeByMonth(d, rows), lateList, asOf: d.m.asOf };
}

export async function lineDetail(companyId, id) {
  const d = await load(companyId); const l = d.lines.find((x) => x.id === Number(id)); if (!l) throw fail(404, 'No such order line.');
  return { id: l.id, orderNo: l.ono, customer: d.custName.get(l.c) || '', customerId: l.c, part: d.partName.get(l.die) || '', finish: l.f, metal: l.m, weight: l.w, ordered: l.od, due: l.dd, shipped: l.full, castingDue: l.castDue, lastPour: l.lastPour, firstInspection: l.firstIns, lastInspection: l.lastIns, qty: l.q, planned: l.bq, poured: l.pour, okQty: l.ok, shippedQty: l.shipQty, daysLate: l.dd && l.full ? days(l.dd, l.full) : null, daysOverdue: l.dd && !l.full && l.dd < d.m.asOf ? days(l.dd, d.m.asOf) : null, steps: l.legs ? LEGS.map(([k, label]) => ({ key: k, label, days: l.legs[k] })) : null, at: l.at };
}

// ── Plan vs actual ──
export async function plan(companyId, q) {
  const d = await load(companyId); const asOf = d.m.asOf; const f = dimFilter(q);
  const closed = d.lines.filter((l) => f(l) && !l.sc && l.full && inDates(l.dd, q)); const ordered = sum(closed, (l) => l.q);
  const stage = [['Ordered', ordered], ['Planned', sum(closed, (l) => l.bq)], ['Poured', sum(closed, (l) => l.pour)], ['Passed inspection', sum(closed, (l) => l.ok)], ['Shipped', sum(closed, (l) => l.shipQty)]].map(([label, pcs]) => ({ label, pcs, pct: round(pct(pcs, ordered)) }));
  const dated = d.lines.filter((l) => f(l) && !l.sc && l.castDue && l.castDue <= asOf && inDates(l.castDue, q));
  const hit = (rows, key) => { const v = rows.filter((l) => l[key]); return { lines: v.length, hitPct: round(pct(v.filter((l) => l[key] <= l.castDue).length, v.length), 0), medianDays: median(v.map((l) => days(l.castDue, l[key]))) }; };
  const milestones = [{ label: 'Last pour', ...hit(dated, 'lastPour') }, { label: 'First inspection', ...hit(dated, 'firstIns') }, { label: 'Last inspection', ...hit(dated, 'lastIns') }];
  const byFinish = [...groupBy(closed, (l) => l.f).entries()].map(([k, a]) => { const o = sum(a, (l) => l.q); const pr = dated.filter((l) => l.f === k); return { finish: k, lines: a.length, plannedPct: round(pct(sum(a, (l) => l.bq), o), 0), pouredPct: round(pct(sum(a, (l) => l.pour), o), 0), shippedPct: round(pct(sum(a, (l) => l.shipQty), o), 0), pourHit: hit(pr, 'lastPour').hitPct, inspHit: hit(pr, 'lastIns').hitPct }; }).sort((a, b) => b.lines - a.lines);
  return { stage, milestones, buffer: median(dated.filter((l) => l.dd).map((l) => days(l.castDue, l.dd))), byFinish, machining: d.m.machPlan, lines: closed.length };
}

// ── Yield by area and type ──
const AREAS = ['Injection', 'Assembly', 'Coating', 'Dewaxing', 'Melting', 'Fettling', 'Inspection', 'Machining inspection'];
const BY = { finish: 'f', metal: 'm', weight: 'w', size: 's', market: 'x', repeat: 'n', tests: 't' };
export async function yieldReport(companyId, q) {
  const d = await load(companyId); const rej = rejOf(d, q); const melt = flowOf(d, q).filter((r) => r.stage === 'Melting'); const key = BY[q.by] || 'f'; const mk = sum(melt, (r) => r.kg); const rk = sum(rej, (r) => r.kg);
  const matrix = [...groupBy(melt, (r) => r[key]).entries()].filter(([k]) => k !== 'No order' && k !== 'Not set').map(([k, a]) => { const kg = sum(a, (r) => r.kg); const rr = rej.filter((r) => r[key] === k); return { type: k, pouredTonnes: tonnes(kg), ...Object.fromEntries(AREAS.map((ar) => [ar, round(pct(sum(rr.filter((r) => r.area === ar), (r) => r.kg), kg), 1)])), total: round(pct(sum(rr, (r) => r.kg), kg), 1) }; }).filter((r) => r.pouredTonnes >= 1).sort((a, b) => b.pouredTonnes - a.pouredTonnes);
  const areas = AREAS.map((area) => { const x = rej.filter((r) => r.area === area); return { area, kg: Math.round(sum(x, (r) => r.kg)), pct: round(pct(sum(x, (r) => r.kg), mk), 2) }; });
  return { kpis: { pct: round(pct(rk, mk), 1), rejectedTonnes: tonnes(rk), pouredTonnes: tonnes(mk) }, areas, matrix, by: q.by || 'finish' };
}

// ── Job-work vendors ──
const vendorStats = (d, a) => { const asOf = d.m.asOf; const v = a.map((r) => r.days); const open = a.filter((r) => r.openKg > 0); return { lines: a.length, tonnes: round(sum(a, (r) => r.t) / 1000, 0), medianDays: median(v), slowDays: pctl(v, 0.9), openTonnes: round(sum(open, (r) => r.openKg) / 1000, 1), oldOpenTonnes: round(sum(open.filter((r) => days(r.dt, asOf) > 60), (r) => r.openKg) / 1000, 1), rejectedPcs: sum(a, (r) => r.rj) }; };
// ── Order journey ──
// Each sales order line from order to shipment. "Done" at a stage is the date good pieces there first reached the ordered quantity.
export const JOURNEY_CLASSES = ['Shipped on time', 'Ready on time, shipped late', 'Poured on time, finished late', 'Poured late', 'Open'];
const JLEGS = [['o2b', 'Order to production start'], ['b2inj', 'Start to wax done'], ['inj2pour', 'Wax done to poured'], ['pour2ins', 'Poured to passed inspection'], ['ins2ship', 'Passed to shipped']];
// An order takes the class of its worst line.
const WORST = ['Open', 'Poured late', 'Poured on time, finished late', 'Ready on time, shipped late', 'Shipped on time'];
const journeyOf = (d, q) => { const f = dimFilter(q); return d.journey.filter((j) => f(j) && inDates(j.od, q)); };
const maxOf = (a) => a.filter(Boolean).reduce((m, x) => (!m || x > m ? x : m), null); const minOf = (a) => a.filter(Boolean).reduce((m, x) => (!m || x < m ? x : m), null);
export async function journey(companyId, q) {
  const d = await load(companyId); const rows = journeyOf(d, q);
  const classes = JOURNEY_CLASSES.map((label) => { const a = rows.filter((j) => j.cls === label); return { label, lines: a.length, tonnes: tonnes(sum(a, (j) => j.tn)) }; });
  const orders = [...groupBy(rows, (j) => j.ono).entries()].map(([no, a]) => {
    const ships = new Map(); for (const j of a) for (const [dt, qy] of j.sh || []) ships.set(dt, (ships.get(dt) || 0) + (j.q ? (qy / j.q) * j.tn : 0));
    const open = a.some((j) => !j.full);
    return { no, customer: d.custName.get(a[0].c) || '', customerId: a[0].c, od: a[0].od, due: minOf(a.map((j) => j.dd)), tonnes: round(sum(a, (j) => j.tn) / 1000, 2), lines: a.length, start: minOf(a.map((j) => j.start)), pourDone: open ? null : maxOf(a.map((j) => j.pourDone)), insDone: open ? null : maxOf(a.map((j) => j.insDone)), shipped: open ? null : maxOf(a.map((j) => j.full)), ships: [...ships].sort().map(([dt, kg]) => [dt, round(kg / 1000, 1)]), open,
      cls: WORST.find((c) => a.some((j) => j.cls === c)) };
  }).sort((x, y) => (x.od < y.od ? 1 : -1));
  const shipped = rows.filter((j) => j.full);
  return { classes, legs: JLEGS.map(([key, label]) => ({ key, label, days: median(shipped.map((j) => j.legs[key])) })), promised: median(shipped.map((j) => days(j.od, j.dd))), orders, totalOrders: orders.length, asOf: d.m.asOf };
}

// ── Where the time goes ──
export async function timeSpent(companyId, q) {
  const d = await load(companyId); const f = dimFilter(q); const rows = d.journey.filter((j) => j.full && f(j) && inDates(j.full, q));
  const legsOf = (a) => Object.fromEntries(JLEGS.map(([k]) => [k, median(a.map((j) => j.legs[k]))]));
  const months = [...groupBy(rows, (j) => j.full.slice(0, 7)).entries()].map(([mo, a]) => ({ mo, lines: a.length, ...legsOf(a), promised: median(a.map((j) => days(j.od, j.dd))) })).sort(byMonth);
  const customers = [...groupBy(rows, (j) => j.c).entries()].map(([c, a]) => ({ id: c, customer: d.custName.get(c) || '', lines: a.length, tonnes: tonnes(sum(a, (j) => j.tn)), ...legsOf(a), promised: median(a.map((j) => days(j.od, j.dd))), onTimePct: round(pct(a.filter((j) => j.full <= j.dd).length, a.length), 0) })).filter((r) => r.lines >= 5).sort((a, b) => b.tonnes - a.tonnes);
  return { legs: JLEGS.map(([key, label]) => ({ key, label, days: median(rows.map((j) => j.legs[key])), slow: pctl(rows.map((j) => j.legs[key]), 0.9) })), promised: median(rows.map((j) => days(j.od, j.dd))), lines: rows.length, months, customers, asOf: d.m.asOf };
}

// ── Planning: how orders become batches ──
export async function planning(companyId, q) {
  const d = await load(companyId); const rows = journeyOf(d, q);
  const band = (v) => (v == null ? null : v < 0.95 ? 'Less than ordered' : v <= 1.05 ? 'About the order' : v <= 1.15 ? '5 to 15% extra' : v <= 1.3 ? '15 to 30% extra' : 'Over 30% extra');
  const PB = ['Less than ordered', 'About the order', '5 to 15% extra', '15 to 30% extra', 'Over 30% extra'];
  const multi = [...groupBy(rows.filter((j) => j.start), (j) => j.ono).values()].filter((a) => a.length > 1);
  const sameDay = multi.filter((a) => new Set(a.map((j) => j.start)).size === 1).length;
  const startBands = [['Within a week', 0, 7], ['8 to 14 days', 8, 14], ['15 to 30 days', 15, 30], ['Over 30 days', 31, Infinity]].map(([label, a, b]) => ({ label, lines: rows.filter((j) => j.legs.o2b != null && j.legs.o2b >= a && j.legs.o2b <= b).length }));
  const subBands = [['1', 1, 1], ['2', 2, 2], ['3 to 4', 3, 4], ['5 to 7', 5, 7], ['8 or more', 8, Infinity]].map(([label, a, b]) => ({ label, lines: rows.filter((j) => j.subs >= a && j.subs <= b).length }));
  const extra = rows.filter((j) => j.later > 0 || j.rework > 0);
  const months = [...groupBy(rows.filter((j) => j.start), (j) => j.od.slice(0, 7)).entries()].map(([mo, a]) => ({ mo, lines: a.length, startDays: median(a.map((j) => j.legs.o2b)) })).sort(byMonth);
  return { kpis: { lines: rows.length, orders: new Set(rows.map((j) => j.ono)).size, oneBatchPct: round(pct(rows.filter((j) => j.batches === 1).length, rows.filter((j) => j.batches > 0).length), 0), planned: median(rows.map((j) => j.planned)), startDays: median(rows.map((j) => j.legs.o2b)), sameDayPct: round(pct(sameDay, multi.length), 0), multiOrders: multi.length, extraLines: extra.length, extraTonnes: tonnes(sum(extra, (j) => j.tn)), reworkLines: rows.filter((j) => j.rework > 0).length, subsMedian: median(rows.filter((j) => j.subs).map((j) => j.subs)) },
    plannedBands: PB.map((label) => ({ label, lines: rows.filter((j) => band(j.planned) === label).length })), startBands, subBands, months,
    extraList: extra.sort((a, b) => (a.od < b.od ? 1 : -1)).slice(0, 200).map((j) => ({ id: j.id, no: j.ono, customer: d.custName.get(j.c) || '', part: d.partName.get(j.die) || '', od: j.od, batches: j.batches, later: j.later, rework: j.rework, tonnes: round(j.tn / 1000, 2), cls: j.cls })), asOf: d.m.asOf };
}

// ── Batches and sub-batches ──
export async function batches(companyId, q) {
  const d = await load(companyId); const f = dimFilter(q); const rows = d.batchFacts.filter((b) => f(b) && inDates(b.bd, q) && b.ty === 'Regular');
  const split = rows.filter((b) => b.subs > 1); const unsplit = rows.filter((b) => b.subs === 1);
  const W = [['Under 1 kg', 0, 1], ['1 to 3 kg', 1, 3], ['3 to 10 kg', 3, 10], ['10 to 30 kg', 10, 30], ['Over 30 kg', 30, Infinity]];
  const subs = rows.flatMap((b) => b.pcs.map((p) => ({ pcs: p, kg: p * (b.pw || 0), pw: b.pw || 0 })));
  const byWeight = W.map(([label, a, b]) => { const s = subs.filter((x) => x.pw >= a && x.pw < b); return { label, subBatches: s.length, pieces: median(s.map((x) => x.pcs)), kg: round(median(s.map((x) => x.kg)), 0) }; });
  const months = [...groupBy(split.filter((b) => b.p2i != null), (b) => b.bd.slice(0, 7)).entries()].map(([mo, a]) => ({ mo, sib: round(median(a.map((b) => b.sib)), 1), after: round(median(a.map((b) => b.after)), 1) })).sort(byMonth);
  const evenSplit = split.filter((b) => { const s = b.pcs; return new Set(s.slice(0, -1)).size === 1 && s[s.length - 1] <= s[0]; }).length;
  return { kpis: { batches: rows.length, splitPct: round(pct(split.length, rows.length), 0), subsMedian: median(split.map((b) => b.subs)), subKg: round(median(subs.map((x) => x.kg)), 0), evenPct: round(pct(evenSplit, split.length), 0), sib: median(split.map((b) => b.sib)), after: median(split.map((b) => b.after)), sameDayPct: round(pct(split.filter((b) => b.sameDayIns === 1).length, split.filter((b) => b.sameDayIns != null).length), 0), p2iSplit: median(split.map((b) => b.p2i)), p2iUnsplit: median(unsplit.map((b) => b.p2i)) },
    subsDist: [1, 2, 3, 4, 5, 6, 7].map((n) => ({ label: n === 7 ? '7 or more' : String(n), batches: rows.filter((b) => (n === 7 ? b.subs >= 7 : b.subs === n)).length })), byWeight, months, asOf: d.m.asOf };
}

// ── Shipping rhythm ──
const rhythmKind = (m) => (m <= 10 ? 'Weekly' : m <= 24 ? 'Every 2 to 3 weeks' : m <= 40 ? 'About monthly' : m <= 75 ? 'About every 2 months' : 'Every 3 months or more');
const rhythmRows = (d, q) => { const cust = q.customer ? Number(q.customer) : null; return d.rhythm.filter((r) => (cust == null || r.c === cust) && (!q.market || r.x === q.market)); };
export async function shippingRhythm(companyId, q) {
  const d = await load(companyId); const minT = Number(q.minTonnes || 3);
  const rows = rhythmRows(d, q).map((r) => ({ id: r.c, customer: d.custName.get(r.c) || '', kind: rhythmKind(r.median), median: r.median, p25: r.p25, p75: r.p75, shipments: r.ships.length, tonnes: round(sum(r.ships, (s) => s[1]), 1), ships: r.ships, skips: r.skips.map(([dt, ready, late]) => ({ dt, ready, late, why: ready >= 0.3 ? 'Castings were ready' : late >= 0.3 ? 'Orders late, nothing ready' : 'Nothing due, nothing ready' })), last: r.last, next: r.next }))
    .filter((r) => r.tonnes >= minT).sort((a, b) => a.median - b.median);
  const all = rows.flatMap((r) => r.skips);
  return { rows, skipCounts: ['Castings were ready', 'Orders late, nothing ready', 'Nothing due, nothing ready'].map((why) => ({ why, slots: all.filter((s) => s.why === why).length })), from: d.m.from, asOf: d.m.asOf };
}
export async function readyWaiting(companyId, q) {
  const d = await load(companyId); const r = new Map(d.rhythm.map((x) => [x.c, x])); const cust = q.customer ? Number(q.customer) : null;
  const now = d.clearedNow.filter((n) => cust == null || n.c === cust);
  const rows = [...groupBy(now, (n) => n.c).entries()].map(([c, a]) => { const rh = r.get(c); return { id: c, customer: d.custName.get(c) || '', tonnes: round(sum(a, (n) => n.kg) / 1000, 2), lines: new Set(a.map((n) => n.oi)).size, oldest: Math.max(...a.map((n) => n.days)), pastDue: round(sum(a.filter((n) => n.due && n.due < d.m.asOf), (n) => n.kg) / 1000, 2), rhythm: rh ? rhythmKind(rh.median) : 'No regular rhythm', median: rh?.median ?? null, last: rh?.last ?? null, next: rh?.next ?? null, daysToNext: rh ? days(d.m.asOf, rh.next) : null }; })
    .filter((x) => x.tonnes >= 0.05).sort((a, b) => b.tonnes - a.tonnes);
  const age = [['Up to 7 days', 0, 7], ['8 to 30 days', 8, 30], ['Over 30 days', 31, Infinity]].map(([label, a, b]) => ({ label, tonnes: round(sum(now.filter((n) => n.days >= a && n.days <= b), (n) => n.kg) / 1000, 1) }));
  return { kpis: { tonnes: round(sum(now, (n) => n.kg) / 1000, 1), customers: rows.length, pastDue: round(sum(now.filter((n) => n.due && n.due < d.m.asOf), (n) => n.kg) / 1000, 1), overdueSlot: rows.filter((x) => x.daysToNext != null && x.daysToNext < 0).length }, rows, age, asOf: d.m.asOf };
}
export async function ordersPerShipment(companyId, q) {
  const d = await load(companyId); const cust = q.customer ? Number(q.customer) : null; const keep = (r) => (cust == null || r.c === cust) && (!q.market || r.x === q.market);
  const ships = d.shipLots.filter((s) => keep(s) && inDates(s.dt, q)); const sos = d.salesOrders.filter((s) => keep(s) && inDates(s.od, q));
  const avg = (a) => (a.length ? sum(a, (x) => x) / a.length : null);
  const customers = [...groupBy(ships, (s) => s.c).entries()].map(([c, a]) => { const o = sos.filter((s) => s.c === c); return { id: c, customer: d.custName.get(c) || '', shipments: a.length, shipKg: round(avg(a.map((s) => s.kg)), 0), shipMedKg: round(median(a.map((s) => s.kg)), 0), orders: o.length, orderKg: round(avg(o.map((s) => s.kg)), 0), orderMedKg: round(median(o.map((s) => s.kg)), 0), ordersPerShipment: median(a.map((s) => s.sos)), placedApart: median(a.map((s) => s.odSpread)), tonnes: tonnes(sum(a, (s) => s.kg)) }; })
    .filter((r) => r.tonnes >= 3).sort((a, b) => b.tonnes - a.tonnes);
  const spread = [['Same day', 0, 0], ['1 to 30 days', 1, 30], ['31 to 60 days', 31, 60], ['61 to 90 days', 61, 90], ['91 to 180 days', 91, 180], ['Over 180 days', 181, Infinity]].map(([label, a, b]) => ({ label, tonnes: tonnes(sum(ships.filter((s) => s.odSpread >= a && s.odSpread <= b), (s) => s.kg)) }));
  const per = [['1', 1, 1], ['2', 2, 2], ['3', 3, 3], ['4 to 5', 4, 5], ['6 or more', 6, Infinity]].map(([label, a, b]) => ({ label, tonnes: tonnes(sum(ships.filter((s) => s.sos >= a && s.sos <= b), (s) => s.kg)) }));
  return { kpis: { orderKg: round(avg(sos.map((s) => s.kg)), 0), shipKg: round(avg(ships.map((s) => s.kg)), 0), multiPct: round(pct(sum(ships.filter((s) => s.sos > 1), (s) => s.kg), sum(ships, (s) => s.kg)), 0), placedApart: median(ships.filter((s) => s.sos > 1).map((s) => s.odSpread)) }, customers, spread, per, asOf: d.m.asOf };
}

export async function vendors(companyId, q) {
  const d = await load(companyId); const v = d.vendors.filter((r) => inDates(r.dt, q) && (!q.process || r.p === q.process)); const w = compareWindows(d, 6);
  const window = (r, s) => r.dt >= s.from && r.dt <= s.to;
  const list = [...groupBy(v, (r) => `${r.p}|${r.v}`).entries()].map(([k, a]) => { const [process, vendor] = k.split('|'); const all = d.vendors.filter((r) => r.p === process && r.v === vendor); return { key: k, process, vendor, ...vendorStats(d, a), prevDays: median(all.filter((r) => window(r, w.prev)).map((r) => r.days)), nowDays: median(all.filter((r) => window(r, w.now)).map((r) => r.days)) }; }).filter((r) => r.tonnes >= 1).sort((a, b) => b.tonnes - a.tonnes);
  const processes = [...groupBy(d.vendors.filter((r) => inDates(r.dt, q)), (r) => r.p).entries()].map(([process, a]) => ({ process, vendors: new Set(a.map((r) => r.v)).size, ...vendorStats(d, a) })).filter((r) => r.tonnes >= 1).sort((a, b) => b.tonnes - a.tonnes);
  const quarters = [...groupBy(v.filter((r) => r.p === (q.process || 'Machining')), (r) => `${r.dt.slice(0, 4)} Q${Math.ceil(+r.dt.slice(5, 7) / 3)}`).entries()].map(([quarter, a]) => ({ quarter, tonnes: round(sum(a, (r) => r.t) / 1000, 0), medianDays: median(a.map((r) => r.days)), returned: round(pct(a.filter((r) => r.days != null).length, a.length), 0) })).sort((a, b) => (a.quarter < b.quarter ? -1 : 1));
  const s = vendorStats(d, v);
  return { kpis: { ...s, vendors: new Set(v.map((r) => r.v)).size }, processes, vendors: list, quarters, quarterProcess: q.process || 'Machining', now: w.now, prev: w.prev, asOf: d.m.asOf };
}

export async function vendorDetail(companyId, q) {
  const d = await load(companyId); const name = String(q.vendor || ''); const a = d.vendors.filter((r) => r.v === name && (!q.process || r.p === q.process)); if (!a.length) throw fail(404, 'No such vendor.');
  const months = [...groupBy(a, (r) => r.dt.slice(0, 7)).entries()].map(([mo, x]) => ({ mo, tonnes: round(sum(x, (r) => r.t) / 1000, 1), medianDays: median(x.map((r) => r.days)) })).sort(byMonth);
  const open = a.filter((r) => r.openKg > 0).map((r) => ({ no: r.no, sent: r.dt, part: d.partName.get(r.die) || r.part || '', sentPcs: r.q, backPcs: r.got, kg: Math.round(r.openKg), days: days(r.dt, d.m.asOf) })).sort((x, y) => y.days - x.days).slice(0, 20);
  const parts = [...groupBy(a, (r) => r.die).entries()].map(([die, x]) => ({ die, name: d.partName.get(die) || x[0].part || `Part ${die}`, tonnes: round(sum(x, (r) => r.t) / 1000, 1), medianDays: median(x.map((r) => r.days)) })).sort((x, y) => y.tonnes - x.tonnes).slice(0, 8);
  const po = d.machPo.filter((r) => r.v.toLowerCase() === name.toLowerCase());
  return { vendor: name, process: q.process || null, ...vendorStats(d, a), months, open, parts, poValue: po.length ? Math.round(sum(po, (r) => r.am)) : null, asOf: d.m.asOf };
}

// ── Machining orders ──
export async function machiningOrders(companyId, q) {
  const d = await load(companyId); const asOf = d.m.asOf; const po = d.machPo.filter((r) => inDates(r.dt, q));
  const openOf = (r) => Math.max(0, (r.q || 0) - (r.rq || 0)); const pastPlan = (r) => openOf(r) > 0 && r.plan && r.plan < asOf;
  const rows = [...groupBy(po, (r) => r.v).entries()].map(([vendor, a]) => ({ vendor, lines: a.length, value: Math.round(sum(a, (r) => r.am)), share: round(pct(sum(a, (r) => r.am), sum(po, (r) => r.am)), 0), ordered: sum(a, (r) => r.q), received: sum(a, (r) => r.rq), openPcs: sum(a, openOf), pastPlanLines: a.filter(pastPlan).length })).sort((a, b) => b.value - a.value);
  const months = [...groupBy(po, (r) => r.dt.slice(0, 7)).entries()].map(([mo, a]) => ({ mo, value: Math.round(sum(a, (r) => r.am)) })).sort(byMonth);
  const openList = po.filter((r) => openOf(r) > 0).map((r) => ({ key: `${r.no}|${r.die}|${r.q}`, no: r.no, vendor: r.v, part: d.partName.get(r.die) || '', date: r.dt, planned: r.plan, ordered: r.q, received: r.rq, open: openOf(r), daysPastPlan: r.plan && r.plan < asOf ? days(r.plan, asOf) : 0 })).sort((a, b) => b.daysPastPlan - a.daysPastPlan);
  return { kpis: { value: Math.round(sum(po, (r) => r.am)), lines: po.length, vendors: rows.length, openPcs: sum(po, openOf), pastPlanLines: po.filter(pastPlan).length }, rows, months, openList: openList.slice(0, 300), asOf };
}

// ── Material suppliers ──
export async function materialSuppliers(companyId, q) {
  const d = await load(companyId); const period = d.purchases.filter((r) => inDates(r.dt, q)); const excluded = period.filter((r) => r.bad); const good = d.purchases.filter((r) => !r.bad); const buy = period.filter((r) => !r.bad && (!q.group || r.group === q.group)); const grn = d.grn.filter((r) => inDates(r.dt, q)); const total = sum(buy, (r) => r.val); const w = compareWindows(d, 6);
  const rows = [...groupBy(buy, (r) => r.v).entries()].map(([supplier, a]) => { const g = grn.filter((r) => r.v === supplier); return { supplier, value: Math.round(sum(a, (r) => r.val)), share: round(pct(sum(a, (r) => r.val), total), 0), receipts: new Set(a.map((r) => r.doc)).size, items: new Set(a.map((r) => r.item)).size, leadDays: median(g.map((r) => r.lead)) }; }).sort((a, b) => b.value - a.value);
  const groups = [...groupBy(period.filter((r) => !r.bad), (r) => r.group).entries()].map(([group, a]) => ({ group, value: Math.round(sum(a, (r) => r.val)) })).sort((a, b) => b.value - a.value);
  const rate = (a) => { const qty = sum(a, (r) => r.q); return qty ? sum(a, (r) => r.val) / qty : null; };
  const items = [...groupBy(buy, (r) => r.item).entries()].map(([item, a]) => { const all = good.filter((r) => r.item === item); return { item, group: a[0].group, qty: Math.round(sum(a, (r) => r.q)), value: Math.round(sum(a, (r) => r.val)), rate: round(rate(a), 1), prevRate: round(rate(all.filter((r) => r.dt >= w.prev.from && r.dt <= w.prev.to)), 1), nowRate: round(rate(all.filter((r) => r.dt >= w.now.from && r.dt <= w.now.to)), 1) }; }).sort((a, b) => b.value - a.value).slice(0, 25);
  const months = [...groupBy(buy, (r) => r.dt.slice(0, 7)).entries()].map(([mo, a]) => ({ mo, value: Math.round(sum(a, (r) => r.val)) })).sort(byMonth);
  return { kpis: { value: Math.round(total), suppliers: rows.length, topShare: rows[0]?.share ?? null, topName: rows[0]?.supplier ?? null, items: new Set(buy.map((r) => r.item)).size, leadDays: median(grn.map((r) => r.lead)) }, excluded: { lines: excluded.length, value: Math.round(sum(excluded, (r) => r.val)), items: [...new Set(excluded.map((r) => r.item))] }, rows, groups, items, months, now: w.now, prev: w.prev };
}

// ── One production step ──
const STEP_SLUG = { injection: 'Injection', assembly: 'Assembly', coating: 'Coating', dewaxing: 'Dewaxing', melting: 'Melting', fettling: 'Fettling', 'heat-treatment': 'Heat treatment', inspection: 'Inspection', 'machining-inspection': 'Machining inspection', dispatch: 'Dispatched' };
const PREV_LABEL = { Injection: 'Batch date', Assembly: 'Injection', Coating: 'Assembly', Dewaxing: 'Coating', Melting: 'Dewaxing', Fettling: 'Melting', 'Heat treatment': 'Melting', Inspection: 'Melting', 'Machining inspection': 'Inspection' };
const WAIT_LABEL = { Assembly: 'Injected, not assembled', Coating: 'Assembled, not coated', Dewaxing: 'Coated, not dewaxed', Melting: 'Dewaxed, not poured', Fettling: 'Poured, not fettled', Inspection: 'Poured, not inspected' };
const histMedian = (rows, p = 0.5) => { const total = sum(rows, (r) => r.n); if (!total) return null; const s = [...rows].sort((a, b) => a.days - b.days); let c = 0; const at = Math.floor((total - 1) * p); for (const r of s) { c += r.n; if (c > at) return r.days; } return s.at(-1).days; };
export async function step(companyId, slug, q) {
  const d = await load(companyId); const stage = STEP_SLUG[slug]; if (!stage) throw fail(404, 'No such step.');
  const ok = (r) => (!q.finish || r.f === q.finish) && (!q.metal || r.m === q.metal); const inP = (r) => ok(r) && inMonths(r.mo, q);
  const rows = d.stepParts.filter((r) => r.stage === stage && inP(r)); const kg = sum(rows, (r) => r.kg);
  const wdRows = stage === 'Dispatched' ? [...groupBy(d.disp.filter((r) => inMonths(r.dt.slice(0, 7), q)), (r) => r.dt.slice(0, 7)).entries()].map(([mo, a]) => ({ mo, days: new Set(a.map((r) => r.dt)).size })) : d.workDays.filter((r) => r.stage === stage && inMonths(r.mo, q));
  const wd = sum(wdRows, (r) => r.days);
  const rej = stage === 'Dispatched' ? [] : d.rej.filter((r) => r.area === stage && inP(r)); const rk = sum(rej, (r) => r.kg);
  const months = [...groupBy(rows, (r) => r.mo).entries()].map(([mo, a]) => { const k = sum(a, (r) => r.kg); const day = wdRows.find((w) => w.mo === mo)?.days; const rr = sum(rej.filter((r) => r.mo === mo), (r) => r.kg); const gaps = d.stepGap.filter((g) => g.stage === stage && g.mo === mo && ok(g)); return { mo, tonnes: tonnes(k), kgPerDay: day ? Math.round(k / day) : null, rejectionPct: round(pct(rr, k), 1), gapDays: histMedian(gaps) }; }).sort(byMonth);
  const gaps = d.stepGap.filter((g) => g.stage === stage && inP(g));
  const rejByDie = totalsBy(rej, 'die', (r) => r.kg);
  const parts = [...groupBy(rows, (r) => r.die).entries()].map(([die, a]) => { const k = sum(a, (r) => r.kg); const r = rejByDie.get(die) ?? 0; return { die, name: d.partName.get(die) || `Part ${die}`, tonnes: round(k / 1000, 1), pieces: sum(a, (x) => x.pcs), rejectedKg: Math.round(r), rejectionPct: round(pct(r, k), 1) }; }).sort((a, b) => b.tonnes - a.tonnes).slice(0, 25);
  const reasons = [...groupBy(rej, (r) => r.reason).entries()].map(([reason, a]) => ({ reason: reason.replace(/_/g, ' – '), kg: Math.round(sum(a, (r) => r.kg)), pieces: sum(a, (r) => r.pcs) })).sort((a, b) => b.kg - a.kg).slice(0, 8);
  const metals = [...groupBy(rows, (r) => r.m).entries()].map(([label, a]) => ({ label, tonnes: tonnes(sum(a, (r) => r.kg)) })).sort((a, b) => b.tonnes - a.tonnes);
  const breakRows = d.stepBreak.filter((r) => r.stage === stage && inP(r));
  const breaks = [...groupBy(breakRows, (r) => r.dim).entries()].map(([dim, a]) => ({ dim, rows: [...groupBy(a, (r) => r.key).entries()].map(([label, x]) => ({ label, tonnes: tonnes(sum(x, (r) => r.kg)), pieces: sum(x, (r) => r.pcs) })).sort((m, n) => n.tonnes - m.tonnes).slice(0, 10) }));
  let waiting = null;
  if (stage === 'Dispatched') {
    const open = d.lines.filter((l) => !l.sc && !l.full && l.at === 'Cleared, not shipped' && ok(l));
    waiting = { label: 'Cleared, not shipped', tonnes: round(sum(open, pendingKg) / 1000), lines: open.length, bands: null, rows: open.map((l) => ({ key: l.id, part: d.partName.get(l.die) || '', customer: d.custName.get(l.c) || '', pieces: pending(l), kg: Math.round(pendingKg(l)), days: null, due: l.dd })).sort((a, b) => b.kg - a.kg).slice(0, 100) };
  } else if (WAIT_LABEL[stage]) {
    const w = d.stepWait.filter((r) => r.stage === stage && ok(r)); const age = (r) => days(r.since, d.m.asOf);
    const band = (label, a, b) => { const x = w.filter((r) => age(r) >= a && age(r) < b); return { label, tonnes: round(sum(x, (r) => r.kg) / 1000, 1), lines: x.length }; };
    waiting = { label: WAIT_LABEL[stage], tonnes: round(sum(w, (r) => r.kg) / 1000), lines: w.length, bands: [band('Under 15 days', 0, 15), band('15–30 days', 15, 30), band('30–60 days', 30, 60), band('60–180 days', 60, 180), band('Over 180 days', 180, 1e9)], rows: w.map((r, i) => ({ key: i, part: d.partName.get(r.die) || '', customer: d.custName.get(r.c) || '', pieces: r.pcs, kg: Math.round(r.kg), days: age(r), due: r.due })).sort((a, b) => b.kg - a.kg).slice(0, 100) };
  }
  return { stage, previous: PREV_LABEL[stage] ?? null, kpis: { tonnes: tonnes(kg), pieces: sum(rows, (r) => r.pcs), workDays: wd, kgPerDay: wd ? Math.round(kg / wd) : null, rejectedKg: Math.round(rk), rejectionPct: round(pct(rk, kg), 2), gapDays: histMedian(gaps), gapSlow: histMedian(gaps, 0.9) }, months, parts, reasons, metals, breaks, waiting, asOf: d.m.asOf };
}

// ── Comparing periods: complete calendar months only, so both sides are whole ──
function compareWindows(d, months) {
  const n = [3, 6, 12].includes(Number(months)) ? Number(months) : 6;
  const last = addMonths(d.m.asOf.slice(0, 7), -1); const nowFrom = addMonths(last, 1 - n); const prevTo = addMonths(nowFrom, -1); const prevFrom = addMonths(prevTo, 1 - n);
  return { n, now: { from: `${nowFrom}-01`, to: `${last}-31`, first: nowFrom, last }, prev: { from: `${prevFrom}-01`, to: `${prevTo}-31`, first: prevFrom, last: prevTo }, prevPartial: prevFrom <= d.m.from.slice(0, 7) };
}
const movers = (prev, now, min = 0) => {
  const rows = [...new Set([...prev.keys(), ...now.keys()])].map((key) => ({ key, prev: prev.get(key) ?? 0, now: now.get(key) ?? 0 })).map((r) => ({ ...r, change: r.now - r.prev })).filter((r) => r.change !== 0 && Math.max(r.prev, r.now) >= min);
  return { up: rows.filter((r) => r.change > 0).sort((a, b) => b.change - a.change).slice(0, 5), down: rows.filter((r) => r.change < 0).sort((a, b) => a.change - b.change).slice(0, 5) };
};
const totalsBy = (rows, key, value) => { const m = new Map(); for (const r of rows) m.set(r[key], (m.get(r[key]) || 0) + value(r)); return m; };

// ── What changed ──
export async function whatChanged(companyId, q) {
  const d = await load(companyId); const w = compareWindows(d, q.months); const qp = { ...q, from: w.prev.from, to: w.prev.to }; const qn = { ...q, from: w.now.from, to: w.now.to }; const f = dimFilter(q);
  const fig = (x) => { const s = sales1(salesOf(d, x)); const poured = pouredKg(d, x); const rk = sum(rejOf(d, x), (r) => r.kg); const dl = delivery(d, dueLinesOf(d, x)); return { sales: s.sales, soldT: tonnes(s.kg), price: s.pricePerKg, orderedT: tonnes(sum(d.lines.filter((l) => f(l) && inDates(l.od, x)), (l) => l.tn)), pouredT: tonnes(poured), dispatchedT: tonnes(sum(dispOf(d, x), (r) => r.kg)), rejectionPct: round(pct(rk, poured)), onTimePct: dl.onTimePct, medianDelay: dl.medianDelay }; };
  const now = fig(qn); const prev = fig(qp);
  const metric = (key, label, unit, better) => ({ key, label, unit, better, prev: prev[key], now: now[key], changePct: prev[key] ? round(((now[key] - prev[key]) / prev[key]) * 100, 0) : null });
  const summary = [metric('sales', 'Sales', 'money', 'up'), metric('soldT', 'Weight invoiced', 't', 'up'), metric('price', 'Price per kg', 'perKg', 'up'), metric('orderedT', 'Orders received', 't', 'up'), metric('pouredT', 'Metal poured', 't', 'up'), metric('dispatchedT', 'Dispatched', 't', 'up'), metric('rejectionPct', 'Rejected, of metal poured', 'pct', 'down'), metric('onTimePct', 'Lines on time', 'pct', 'up'), metric('medianDelay', 'Median delay when late', 'days', 'down')];
  const names = (group, label) => ({ up: group.up.map((r) => ({ ...r, name: label(r.key), id: r.key })), down: group.down.map((r) => ({ ...r, name: label(r.key), id: r.key })) });
  const customerSales = names(movers(totalsBy(salesOf(d, qp), 'c', (s) => s.am), totalsBy(salesOf(d, qn), 'c', (s) => s.am)), (k) => d.custName.get(k) || `Customer ${k}`);
  const reason = (k) => String(k).replace(/_/g, ' – ');
  const reasons = names(movers(totalsBy(rejOf(d, qp), 'reason', (r) => r.kg), totalsBy(rejOf(d, qn), 'reason', (r) => r.kg), 100), reason);
  const onTimeMap = (x) => { const m = new Map(); for (const [c, a] of groupBy(dueLinesOf(d, x), (l) => l.c)) if (a.length >= 10) m.set(c, delivery(d, a).onTimePct); return m; };
  const opv = onTimeMap(qp); const onw = onTimeMap(qn); const shared = (m, o) => new Map([...m].filter(([k]) => o.has(k)));
  const customerOnTime = names(movers(shared(opv, onw), shared(onw, opv)), (k) => d.custName.get(k) || `Customer ${k}`);
  const vendorMap = (x) => { const m = new Map(); const rows = d.vendors.filter((r) => inDates(r.dt, x)); for (const [k, a] of groupBy(rows, (r) => `${r.p}: ${r.v}`)) { const v = a.map((r) => r.days).filter((y) => y != null); if (v.length >= 10 && sum(a, (r) => r.t) >= 5000) m.set(k, median(v)); } return m; };
  const vp = vendorMap(w.prev); const vn = vendorMap(w.now); const vendors = names(movers(shared(vp, vn), shared(vn, vp)), (k) => k);
  const stageDay = (x, stage) => { const kg = sum(flowOf(d, x).filter((r) => r.stage === stage), (r) => r.kg); const wd = sum(d.workDays.filter((r) => r.stage === stage && inMonths(r.mo, x)), (r) => r.days); return wd ? Math.round(kg / wd) : null; };
  const stages = STAGE_ORDER.filter((s) => s !== 'Dispatched').map((stage) => ({ stage, prev: stageDay(qp, stage), now: stageDay(qn, stage) }));
  return { months: w.n, now: w.now, prev: w.prev, prevPartial: w.prevPartial, from: d.m.from, summary, customerSales, customerOnTime, reasons, vendors, stages };
}

// ── Action list ──
export async function actions(companyId, q) {
  const d = await load(companyId); const asOf = d.m.asOf; const open = openLinesOf(d, q);
  const row = (l) => ({ ...openRow(d, l), lastPour: l.lastPour, sincePour: l.lastPour ? days(l.lastPour, asOf) : null, daysToDue: l.dd ? days(asOf, l.dd) : null });
  const dueSoon = open.filter((l) => l.dd && l.dd >= asOf && days(asOf, l.dd) <= 30);
  const list = (rows, sort) => { const r = rows.map(row).sort(sort); return { lines: r.length, tonnes: round(sum(r, (x) => x.tonnes)), rows: r }; };
  const notPoured = (l) => l.at === 'Not injected' || l.at === 'Injected, not poured';
  return {
    dueNotPoured: list(dueSoon.filter(notPoured), (a, b) => a.daysToDue - b.daysToDue),
    pastDue: list(open.filter((l) => l.dd && l.dd < asOf), (a, b) => b.daysOverdue - a.daysOverdue),
    waitingAfterPour: list(open.filter((l) => l.at === 'Poured, not inspected' && l.lastPour && days(l.lastPour, asOf) >= 60), (a, b) => b.sincePour - a.sincePour),
    readyToShip: list(open.filter((l) => l.at === 'Cleared, not shipped'), (a, b) => (b.tonnes ?? 0) - (a.tonnes ?? 0)),
    dueSoon: { lines: dueSoon.length, tonnes: round(sum(dueSoon, pendingKg) / 1000) }, asOf,
  };
}

// ── Problem parts ──
const MIN_PART_POURED_KG = 2000;
export async function problemParts(companyId, q) {
  const d = await load(companyId); const w = compareWindows(d, q.months); const f = dimFilter(q); const qp = { ...q, ...w.prev }; const qn = { ...q, ...w.now };
  const poured = (x) => totalsBy(d.dieMelt.filter((r) => f(r) && inMonths(r.mo, x)), 'die', (r) => r.kg); const rejected = (x) => totalsBy(rejOf(d, x), 'die', (r) => r.kg);
  const pn = poured(qn); const pp = poured(qp); const rn = rejected(qn); const rp = rejected(qp);
  const custOf = new Map(); for (const r of d.dieMelt) if (!custOf.has(r.die)) custOf.set(r.die, r.c);
  const topReason = new Map(); for (const [die, a] of groupBy(rejOf(d, qn), (r) => r.die)) topReason.set(die, [...groupBy(a, (r) => r.reason).entries()].map(([k, x]) => [k, sum(x, (r) => r.kg)]).sort((m, o) => o[1] - m[1])[0][0].replace(/_/g, ' – '));
  const rows = [...new Set([...pn.keys(), ...rn.keys()])].map((die) => { const p = pn.get(die) ?? 0; const r = rn.get(die) ?? 0; const p0 = pp.get(die) ?? 0; const r0 = rp.get(die) ?? 0; return { die, name: d.partName.get(die) || `Part ${die}`, customer: d.custName.get(custOf.get(die)) || '', pouredKg: Math.round(p), rejectedKg: Math.round(r), pct: round(pct(r, p)), prevPouredKg: Math.round(p0), prevRejectedKg: Math.round(r0), prevPct: round(pct(r0, p0)), topReason: topReason.get(die) ?? null }; });
  const rejectedTotal = sum(rows, (r) => r.rejectedKg); let cum = 0; let half = 0;
  const ranked = [...rows].filter((r) => r.rejectedKg > 0).sort((a, b) => b.rejectedKg - a.rejectedKg);
  for (const r of ranked) { cum += r.rejectedKg; half += 1; if (cum >= rejectedTotal / 2) break; }
  const comparable = rows.filter((r) => r.pouredKg >= MIN_PART_POURED_KG && r.prevPouredKg >= MIN_PART_POURED_KG && r.pct != null && r.prevPct != null).map((r) => ({ ...r, changePts: round(r.pct - r.prevPct) }));
  return { months: w.n, now: w.now, prev: w.prev, minPouredT: MIN_PART_POURED_KG / 1000, rejectedKg: Math.round(rejectedTotal), partsPoured: rows.filter((r) => r.pouredKg > 0).length, partsWithRejects: ranked.length, partsForHalf: half, ranked: ranked.slice(0, 200), worse: comparable.filter((r) => r.changePts > 0).sort((a, b) => b.changePts - a.changePts).slice(0, 15), better: comparable.filter((r) => r.changePts < 0).sort((a, b) => a.changePts - b.changePts).slice(0, 15) };
}

export async function partDetail(companyId, id, q) {
  const d = await load(companyId); const die = Number(id); if (!d.partName.has(die)) throw fail(404, 'No such part.');
  const f = dimFilter(q); const rej = d.rej.filter((r) => r.die === die && f(r)); const melt = d.dieMelt.filter((r) => r.die === die && f(r));
  const reasonsNow = [...groupBy(rej, (r) => r.reason).entries()].map(([k, a]) => ({ reason: k.replace(/_/g, ' – '), kg: Math.round(sum(a, (r) => r.kg)), pieces: sum(a, (r) => r.pcs) })).sort((a, b) => b.kg - a.kg).slice(0, 8);
  const areas = [...groupBy(rej, (r) => r.area).entries()].map(([area, a]) => ({ area, kg: Math.round(sum(a, (r) => r.kg)) })).sort((a, b) => b.kg - a.kg);
  const moSet = [...new Set(melt.map((r) => r.mo).concat(rej.map((r) => r.mo)))].sort();
  const months = moSet.map((mo) => ({ mo, pouredKg: Math.round(sum(melt.filter((r) => r.mo === mo), (r) => r.kg)), rejectedKg: Math.round(sum(rej.filter((r) => r.mo === mo), (r) => r.kg)) }));
  const open = d.lines.filter((l) => l.die === die && !l.sc && !l.full && f(l)).map((l) => openRow(d, l)).sort((a, b) => b.daysOverdue - a.daysOverdue).slice(0, 10);
  const p = sum(melt, (r) => r.kg); const rk = sum(rej, (r) => r.kg);
  return { die, name: d.partName.get(die), pouredT: tonnes(p), rejectedKg: Math.round(rk), pct: round(pct(rk, p)), reasons: reasonsNow, areas, months, open, asOf: d.m.asOf };
}

// ── Key metrics: one page, each figure taken from the report behind it ──
// Every figure here is read from the same report its detail screen shows, with the same filters,
// so the two never disagree.
export async function summary(companyId, q) {
  const d = await load(companyId);
  const [cust, ord, qual, time, ready, rhythm, ven, mat, act] = await Promise.all([
    customers(companyId, q), orders(companyId, q), quality(companyId, q), timeSpent(companyId, q), readyWaiting(companyId, q),
    shippingRhythm(companyId, q), vendors(companyId, q), materialSuppliers(companyId, q), actions(companyId, q)]);
  const disp = dispOf(d, q); const leg = (k) => time.legs.find((l) => l.key === k)?.days ?? null;
  const months = [...groupBy(salesOf(d, q), (s) => s.dt.slice(0, 7)).entries()].map(([mo, a]) => ({ mo, sales: Math.round(sum(a, (s) => s.am)), dispatchedT: tonnes(sum(disp.filter((r) => r.dt.slice(0, 7) === mo), (r) => r.kg)) })).sort(byMonth);
  return {
    sales: { sales: cust.kpis.sales, pricePerKg: cust.kpis.pricePerKg, customers: cust.kpis.customers, topShare: cust.kpis.topShare, topName: cust.rows[0]?.name ?? null },
    delivery: { onTimePct: ord.kpis.onTimePct, lines: ord.kpis.lines, medianDelay: ord.kpis.medianDelay, openTonnes: ord.kpis.openTonnes, openLines: ord.kpis.openLines, overdueTonnes: ord.kpis.overdueTonnes, overdueLines: ord.kpis.overdueLines },
    actions: { pastDue: act.pastDue.lines, pastDueT: act.pastDue.tonnes, dueNotPoured: act.dueNotPoured.lines, waitingAfterPour: act.waitingAfterPour.lines, waitingAfterPourT: act.waitingAfterPour.tonnes, readyToShip: act.readyToShip.lines },
    production: { pouredT: qual.kpis.pouredTonnes, rejectionPct: qual.kpis.pct, rejectedKg: qual.kpis.rejectedKg, orderToShip: time.legs.reduce((s, l) => s + (l.days || 0), 0), promised: time.promised, pourToPass: leg('pour2ins'), slowPourToPass: time.legs.find((l) => l.key === 'pour2ins')?.slow ?? null },
    shipping: { dispatchedT: tonnes(sum(disp, (r) => r.kg)), shipments: new Set(disp.map((r) => `${r.dt}|${r.c}`)).size, readyT: ready.kpis.tonnes, readyPastDueT: ready.kpis.pastDue, pastUsualSlot: ready.kpis.overdueSlot, regularCustomers: rhythm.rows.length, missedWithStock: rhythm.skipCounts.find((s) => s.why === 'Castings were ready')?.slots ?? 0 },
    vendors: { sentT: ven.kpis.tonnes, medianDays: ven.kpis.medianDays, notBackT: ven.kpis.openTonnes, oldNotBackT: ven.kpis.oldOpenTonnes, purchases: mat.kpis.value, suppliers: mat.kpis.suppliers },
    months, asOf: d.m.asOf,
  };
}
