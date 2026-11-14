import { load, sum, median, pctl, pct, days, round, groupBy, dimFilter, inDates } from './reportService.js';

/**
 * The "By flow" dashboard: four screens (Customer, Planning, Production, Dispatch), each in two tabs.
 * As-is = what is open today. Historic = orders that came in (or planning or dispatch in) the chosen range.
 * Only what the ERP records. Where a figure is worked out from dates, the screen's footnote says how.
 */

const STAGES = ['Not injected', 'Injected, not poured', 'Poured, not inspected', 'Inspected, not shipped'];
const BUCKETS = [['0–7 days', 0, 7], ['8–30 days', 8, 30], ['31–60 days', 31, 60], ['Over 60 days', 61, Infinity]];
const bucketOf = (n) => { if (n == null || Number.isNaN(n)) return 'No date'; const b = BUCKETS.find(([, a, z]) => n >= a && n <= z); return b ? b[0] : 'No date'; };
const orderType = (l) => `${l.m} · ${l.f}`;
const kgPerPiece = (l) => (l.q ? (l.tn || 0) / l.q : 0);
const addDays = (iso, n) => new Date(Date.parse(iso + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const jrMap = (d) => new Map(d.journey.map((j) => [j.id, j]));
const isoMax = (a) => a.reduce((m, x) => (x > m ? x : m), '');

/** Pieces in each open stage, as the ERP has them on the line. Two late piles are shown as one stage. */
function stagePieces(lines) {
  const units = Object.fromEntries(STAGES.map((s) => [s, 0]));
  const tonnes = Object.fromEntries(STAGES.map((s) => [s, 0]));
  for (const l of lines) for (const [st, u] of Object.entries(l.piles || {})) {
    const k = st === 'Inspected, not cleared' || st === 'Cleared, not shipped' ? 'Inspected, not shipped' : st;
    if (!(k in units)) continue;
    units[k] += u; tonnes[k] += (u * kgPerPiece(l)) / 1000;
  }
  for (const k of STAGES) tonnes[k] = round(tonnes[k]);
  return { units, tonnes };
}

function summary(lines, asis) {
  const s = {
    orders: new Set(lines.map((l) => l.ono)).size,
    lines: lines.length,
    units: sum(lines, (l) => l.q),
    tonnes: round(sum(lines, (l) => l.tn || 0) / 1000),
    invoiced: round(sum(lines, (l) => l.inv || 0), 0),
  };
  if (asis) { s.shippedUnits = sum(lines, (l) => l.shipQty || 0); s.stages = stagePieces(lines); }
  return s;
}

// ── 1. Customer ──────────────────────────────────────────────────────────────
/** Customers, with order types under each and part types under those. */
export async function flowCustomers(companyId, q, mode) {
  const d = await load(companyId); const f = dimFilter(q); const asis = mode === 'asis';
  const lines = d.lines.filter((l) => !l.sc && f(l) && (asis ? !l.full : inDates(l.od, q)));
  const level = (a) => ({ ...summary(a, asis), parts: [...groupBy(a, (l) => l.die).entries()].map(([die, pa]) => ({ id: die, name: d.partName.get(die) || `Part ${die}`, ...summary(pa, asis) })).sort((x, y) => y.units - x.units) });
  const rows = [...groupBy(lines, (l) => l.c).entries()].map(([c, a]) => ({
    id: c, name: d.custName.get(c) || `Customer ${c}`, ...summary(a, asis),
    types: [...groupBy(a, orderType).entries()].map(([label, ta]) => ({ key: label, label, ...level(ta) })).sort((x, y) => y.units - x.units),
  })).sort((x, y) => y.invoiced - x.invoiced);
  return { asOf: d.m.asOf, mode, rows, totals: summary(lines, asis) };
}

// ── 2. Planning ──────────────────────────────────────────────────────────────
/** As-is: orders not fully planned into batches. Historic: orders whose first batch started in the range. */
export async function flowPlanning(companyId, q, mode) {
  const d = await load(companyId); const f = dimFilter(q); const j = jrMap(d); const asOf = d.m.asOf;
  if (mode === 'asis') {
    const pend = d.lines.filter((l) => !l.full && !l.sc && f(l) && (l.bq || 0) < l.q);
    const part = (a, unitsOf) => [...groupBy(a, (l) => l.die).entries()].map(([die, pa]) => ({ id: die, name: d.partName.get(die) || `Part ${die}`, units: sum(pa, unitsOf) })).sort((x, y) => y.units - x.units);
    const rows = [...groupBy(pend, (l) => l.c).entries()].map(([c, a]) => {
      const planned = a.filter((l) => (l.bq || 0) > 0); const toPlan = a.filter((l) => l.q - (l.bq || 0) > 0);
      return {
        id: c, name: d.custName.get(c) || `Customer ${c}`, orders: new Set(a.map((l) => l.ono)).size, lines: a.length,
        orderedUnits: sum(a, (l) => l.q), plannedUnits: sum(a, (l) => l.bq || 0), toPlanUnits: sum(a, (l) => Math.max(0, l.q - (l.bq || 0))),
        stages: stagePieces(a).units,
        tree: [
          { key: 'planned', label: 'In sub-batches', lines: planned.length, units: sum(planned, (l) => l.bq || 0), subBatches: sum(planned, (l) => j.get(l.id)?.subs || 0), parts: part(planned, (l) => l.bq || 0) },
          { key: 'toPlan', label: 'Yet to plan', lines: toPlan.length, units: sum(toPlan, (l) => Math.max(0, l.q - (l.bq || 0))), parts: part(toPlan, (l) => Math.max(0, l.q - (l.bq || 0))) },
        ],
      };
    }).sort((x, y) => y.toPlanUnits - x.toPlanUnits);
    const lines = pend.map((l) => ({ id: l.id, ono: l.ono, customer: d.custName.get(l.c) || '', part: d.partName.get(l.die) || '', od: l.od, dd: l.dd, castDue: l.castDue, ordered: l.q, planned: l.bq || 0, toPlan: Math.max(0, l.q - (l.bq || 0)), days: round(days(l.od, asOf), 0), stages: l.piles })).sort((x, y) => (x.dd || '').localeCompare(y.dd || ''));
    const toPlanLines = lines.filter((x) => x.toPlan > 0);
    return {
      asOf, mode,
      kpis: { lines: pend.length, orders: new Set(pend.map((l) => l.ono)).size, toPlanUnits: sum(toPlanLines, (x) => x.toPlan), plannedUnits: sum(pend, (l) => l.bq || 0), oldestDays: toPlanLines.length ? Math.max(...toPlanLines.map((x) => x.days)) : null, dueSoonUnplanned: toPlanLines.filter((x) => x.dd && x.dd <= addDays(asOf, 30)).length },
      rows, lines: lines.slice(0, 400),
    };
  }
  // Historic: orders whose first batch started in the range.
  const hist = d.lines.filter((l) => !l.sc && f(l) && j.get(l.id)?.start && inDates(j.get(l.id).start, q)).map((l) => {
    const jr = j.get(l.id); const toPlan = days(l.od, jr.start);
    return { l, jr, toPlan, batches: jr.batches, rework: jr.rework || 0, later: jr.later || 0, planned: jr.planned, oneBatch: jr.batches === 1, accurate: jr.planned != null && jr.planned >= 0.95 && jr.planned <= 1.05, planInTime: !!l.dd && jr.start <= l.dd, shipped: !!l.full, onTime: !!l.full && !!l.dd && l.full <= l.dd, part: d.partName.get(l.die) || `Part ${l.die}`, type: orderType(l) };
  });
  const metrics = (a) => ({
    lines: a.length,
    medianDaysToPlan: round(median(a.map((x) => x.toPlan)), 0),
    oneBatchPct: round(pct(a.filter((x) => x.oneBatch).length, a.length)),
    accuratePct: round(pct(a.filter((x) => x.accurate).length, a.length)),
    planInTimePct: round(pct(a.filter((x) => x.planInTime).length, a.length)),
    reworkPct: round(pct(a.filter((x) => x.rework > 0).length, a.length)),
    onTimeShippedPct: round(pct(a.filter((x) => x.onTime).length, a.filter((x) => x.shipped).length)),
  });
  const group = (key) => [...groupBy(hist, key).entries()].map(([label, a]) => ({ label, ...metrics(a) })).sort((x, y) => y.lines - x.lines);
  const byMonth = [...groupBy(hist, (x) => x.jr.start.slice(0, 7)).entries()].map(([mo, a]) => ({ mo, ...metrics(a) })).sort((x, y) => (x.mo < y.mo ? -1 : 1));
  const bands = [['Under 95%', (p) => p < 0.95], ['95% to 105%', (p) => p >= 0.95 && p <= 1.05], ['Over 105%', (p) => p > 1.05]].map(([label, test]) => ({ label, lines: hist.filter((x) => x.jr.planned != null && test(x.jr.planned)).length }));
  const compare = [
    { label: 'Planned in one batch', a: hist.filter((x) => x.oneBatch) }, { label: 'Split into several batches', a: hist.filter((x) => !x.oneBatch) },
    { label: 'Planned within the delivery date', a: hist.filter((x) => x.planInTime) }, { label: 'Planned after the delivery date', a: hist.filter((x) => !x.planInTime) },
    { label: 'Planned within 7 days of order', a: hist.filter((x) => x.toPlan <= 7) }, { label: 'Took more than 14 days to plan', a: hist.filter((x) => x.toPlan > 14) },
  ].map((g) => ({ label: g.label, ...metrics(g.a) }));
  return { asOf, mode, kpis: metrics(hist), byPart: group((x) => x.part).slice(0, 20), byType: group((x) => x.type), byMonth, accuracy: bands, compare };
}

// ── 3. Production ────────────────────────────────────────────────────────────
/** Which stage a line's pieces were in on a given day, from the line's dates. Null when not known or not in process. */
function stageAt(l, jr, date) {
  if (!l.od || date < l.od) return null;
  if (l.full && date >= l.full) return null;
  if (!jr) return null;
  if (jr.insDone && date >= jr.insDone) return ['Inspected, not shipped', jr.insDone];
  if (jr.pourDone && date >= jr.pourDone) return ['Poured, not inspected', jr.pourDone];
  if (jr.injDone && date >= jr.injDone) return ['Injected, not poured', jr.injDone];
  return ['Not injected', l.od];
}
const tonsOf = (l) => (l.tn || 0) / 1000;

/** Each pile's entry date for the as-is aging: the date its stage began. */
function ageOfPile(l, jr, stage, asOf) {
  const entry = { 'Not injected': l.od, 'Injected, not poured': jr?.injDone || l.od, 'Poured, not inspected': jr?.pourDone || l.od, 'Inspected, not shipped': jr?.insDone || l.od }[stage];
  return entry ? days(entry, asOf) : null;
}

const WORK_STAGES = ['Injection', 'Assembly', 'Coating', 'Dewaxing', 'Melting', 'Fettling', 'Heat treatment', 'Inspection', 'Machining inspection', 'Dispatched'];

export async function flowProduction(companyId, q, mode, opts = {}) {
  const d = await load(companyId); const f = dimFilter(q); const j = jrMap(d); const asOf = d.m.asOf;
  if (mode === 'asis') {
    const open = d.lines.filter((l) => !l.full && !l.sc && f(l));
    const wip = STAGES.map((stage) => {
      let units = 0; let tonnes = 0; const buckets = Object.fromEntries([...BUCKETS.map(([b]) => b), 'No date'].map((b) => [b, 0]));
      for (const l of open) {
        const jr = j.get(l.id);
        for (const [st, u] of Object.entries(l.piles || {})) {
          const k = st === 'Inspected, not cleared' || st === 'Cleared, not shipped' ? 'Inspected, not shipped' : st;
          if (k !== stage || !u) continue;
          const t = (u * kgPerPiece(l)) / 1000; units += u; tonnes += t; buckets[bucketOf(ageOfPile(l, jr, stage, asOf))] += t;
        }
      }
      return { stage, units, tonnes: round(tonnes), buckets: Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, round(v)])) };
    });
    // Today's work per step, against the average working day of the last 90 days.
    const flow = d.dailyFlow || [];
    const last = isoMax(flow.map((r) => r.dt));
    const win = (dt) => dt > addDays(asOf, -90) && dt <= asOf;
    const work = WORK_STAGES.map((stage) => {
      const rows = flow.filter((r) => r.stage === stage);
      const today = sum(rows.filter((r) => r.dt === last), (r) => r.kg);
      const w = rows.filter((r) => win(r.dt));
      const days90 = new Set(w.map((r) => r.dt)).size;
      const avg = days90 ? sum(w, (r) => r.kg) / days90 : null;
      return { stage, todayKg: round(today, 0), avg90Kg: round(avg, 0), vsAvgPct: avg ? round(pct(today, avg) - 100, 0) : null };
    }).filter((r) => r.todayKg || r.avg90Kg);
    return { asOf, mode, lastDay: last, wip, work, ageBuckets: [...BUCKETS.map(([b]) => b), 'No date'] };
  }
  // Historic: WIP over the range, sampled at period ends.
  const from = q.from || d.m.from; const to = q.to || asOf;
  const g = ['day', 'week', 'month', 'year'].includes(opts.g) ? opts.g : 'month';
  const dates = [];
  if (g === 'day') for (let t = from; t <= to; t = addDays(t, 1)) dates.push(t);
  else if (g === 'week') { for (let t = to; t >= from; t = addDays(t, -7)) dates.unshift(t); }
  else if (g === 'month') { for (let t = from; t <= to; t = addDays(t, 1)) if (addDays(t, 1).slice(8) === '01' || t === to) dates.push(t); }
  else { for (let y = Number(from.slice(0, 4)); y <= Number(to.slice(0, 4)); y += 1) { const t = `${y}-12-31` > to ? to : `${y}-12-31`; if (t >= from) dates.push(t); } }
  const lines = d.lines.filter((l) => !l.sc && f(l) && j.get(l.id));
  const point = (date) => {
    const tonnes = Object.fromEntries(STAGES.map((s) => [s, 0])); const age = Object.fromEntries(STAGES.map((s) => [s, []]));
    for (const l of lines) { const st = stageAt(l, j.get(l.id), date); if (!st) continue; tonnes[st[0]] += tonsOf(l); age[st[0]].push([days(st[1], date), tonsOf(l)]); }
    return { date, tonnes: Object.fromEntries(Object.entries(tonnes).map(([k, v]) => [k, round(v)])), age, };
  };
  const monthEnds = []; for (let t = from; t <= to; t = addDays(t, 1)) if (addDays(t, 1).slice(8) === '01' || t === to) monthEnds.push(t);
  const monthly = monthEnds.map(point);
  const avgWip = Object.fromEntries(STAGES.map((s) => [s, round(sum(monthly, (p) => p.tonnes[s]) / (monthly.length || 1))]));
  const avgAge = Object.fromEntries(STAGES.map((s) => {
    const per = monthly.map((p) => { const a = p.age[s]; const tt = sum(a, (x) => x[1]); return tt ? sum(a, (x) => x[0] * x[1]) / tt : null; }).filter((x) => x != null);
    return [s, round(per.length ? sum(per, (x) => x) / per.length : null, 0)];
  }));
  const series = dates.length > 400 && g === 'day' ? dates.filter((_, i) => i % Math.ceil(dates.length / 400) === 0 || i === dates.length - 1) : dates;
  const timeline = series.map((t) => { const p = point(t); return { date: t, tonnes: p.tonnes }; });
  const sel = STAGES.includes(opts.stage) ? opts.stage : STAGES[1];
  const aging = monthly.map((p) => { const a = p.age[sel]; const b = Object.fromEntries([...BUCKETS.map(([x]) => x), 'No date'].map((x) => [x, 0])); for (const [n, t] of a) b[bucketOf(n)] += t; return { date: p.date, buckets: Object.fromEntries(Object.entries(b).map(([k, v]) => [k, round(v)])) }; });
  return { asOf, mode, from, to, g, stages: STAGES, avgWip, avgAge, timeline, stage: sel, aging, ageBuckets: [...BUCKETS.map(([b]) => b), 'No date'] };
}

// ── 4. Dispatch ──────────────────────────────────────────────────────────────
/** Top ten customers by invoiced revenue; their dispatch days and the tonnes on each. */
export async function flowDispatch(companyId, q, mode) {
  const d = await load(companyId); const asOf = d.m.asOf;
  const from = mode === 'asis' ? addDays(asOf, -89) : (q.from || d.m.from);
  const to = mode === 'asis' ? asOf : (q.to || asOf);
  const inWin = (dt) => dt >= from && dt <= to;
  const rev = new Map(); for (const s of d.sales) if (inWin(s.dt)) rev.set(s.c, (rev.get(s.c) || 0) + s.am);
  const top = [...rev.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  const ids = new Set(top.map(([c]) => c));
  const perDay = new Map();
  for (const r of d.disp) if (ids.has(r.c) && inWin(r.dt)) { const k = `${r.c}|${r.dt}`; perDay.set(k, (perDay.get(k) || 0) + (r.kg || 0)); }
  const ships = new Map(top.map(([c]) => [c, []]));
  for (const [k, kg] of perDay) { const [c, dt] = k.split('|'); ships.get(Number(c)).push([dt, kg / 1000]); }
  const rows = top.map(([c, am]) => {
    const s = (ships.get(c) || []).sort((a, b) => (a[0] < b[0] ? -1 : 1));
    const gaps = s.slice(1).map((x, i) => days(s[i][0], x[0]));
    const kgs = s.map((x) => x[1]);
    return { id: c, name: d.custName.get(c) || `Customer ${c}`, revenue: round(am, 0), dispatches: s.length, totalT: round(sum(s, (x) => x[1]), 1), medianT: round(median(kgs), 2), p25T: round(pctl(kgs, 0.25), 2), p75T: round(pctl(kgs, 0.75), 2), medianGapDays: round(median(gaps), 0), p25GapDays: round(pctl(gaps, 0.25), 0), p75GapDays: round(pctl(gaps, 0.75), 0), ships: s.map(([dt, t]) => [dt, round(t, 2)]) };
  });
  const all = rows.flatMap((r) => r.ships.map((x) => x[1]));
  const bins = [['Under 1 t', 0, 1], ['1 to 3 t', 1, 3], ['3 to 6 t', 3, 6], ['6 to 10 t', 6, 10], ['10 t and over', 10, Infinity]].map(([label, a, z]) => ({ label, dispatches: all.filter((t) => t >= a && t < z).length }));
  const months = [...groupBy(rows.flatMap((r) => r.ships.map((x) => ({ mo: x[0].slice(0, 7), c: r.id }))), (x) => x.mo).entries()].map(([mo, a]) => ({ mo, dispatches: a.length, customers: new Set(a.map((x) => x.c)).size })).sort((a, b) => (a.mo < b.mo ? -1 : 1));
  return { asOf, mode, from, to, rows, bins, months };
}
