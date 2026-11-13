/**
 * monthPlanService.js — PLANNING › THE MONTH PLAN (init.sql §105; user 2026-11-13; engine: monthPlanEngine.js).
 *
 *   "a plan made at the start of the month and locked … the priority order of the production orders and all the machines
 *    that will be used that month … the dates of availability of various material. By default all the machines currently
 *    on in production should be selected … an option to add more machines which are available … only the machines for
 *    production and fabrication, not electrical machines … The AI should run an optimization plan to get out the max
 *    output in the entire month (the execution plan's shipping units) … suggestions … how to use more machines to
 *    improve the tonnage and by how much … created by the planner and frozen once MD approves."
 *
 * WHAT IS PLANNED. The shipping units of every order that has a production order in Planning or Released: the planner
 * snapshot's ship MARKS (plannerService — tonnes, the work in sequence per machine type, what is left of released work,
 * the day the material is ready); a line with no marks is one unit. A unit already made counts as done.
 * WHICH MACHINES. The FABRICATION machines: live machines some active operation can run on (operationService
 * .productionMachineIds — a machine type an operation's rules reach; electrical panels, utilities and vehicles are
 * reached by none). Those switched on (status active) are in the plan by default; the rest can be added.
 * CAPACITY = the shift calendars of the machines in the plan (planned downtime and open faults already out), summed per
 * machine type per day. Contractor work and work with no machine type has no pool: a daily rate per unit.
 * MATERIAL: a unit starts no earlier than the day its material is ready (materialReadyService through the snapshot). A
 * unit whose material has no date is ASSUMED ready ASSUMED_DAYS after the plan's first day — and says so.
 * THE DOCUMENT. cf_mplans keeps inputs_json (machines, ranks, tolerance) and result_json (the facts planned from and
 * the optimiser's answer) — what was assumed stays beside what was decided, so alerts and the review can compare.
 *
 *   GET  /planning/month?month=YYYY-MM          the month's plan (the frozen one and the draft, if any) + the choices
 *   POST /planning/month/run   { month, machineIds?, ranks?, toleranceDays?, save? }  optimise (and save the draft)
 *   POST /planning/month/:id/send { note? }     to the MD (approval 'month_plan')
 *   POST /planning/month/:id/withdraw
 *   GET  /planning/months                       every month's plans (the history list)
 */
import { invalid, notFound, conflict } from '../lib/errors.js';
import { getPlanner, CONTRACTOR, UNASSIGNED } from './plannerService.js';
import { productionMachineIds } from './operationService.js';
import { machinesCalendar } from './shiftService.js';
import { optimise, whatIf } from './monthPlanEngine.js';
import { requestApproval } from './approvalService.js';

export const ASSUMED_DAYS = 14;
export const SPILL_DAYS = 45;                 // days planned past the month's end, so a unit that misses still gets a date
export const UNLIMITED_MINUTES = 600;          // a day's contractor / unassigned work on one unit
export const PLAN_PO_STATUSES = ['planning', 'planned'];
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const blank = (v) => v == null || String(v).trim() === '';
const r3 = (x) => Math.round(Number(x) * 1000) / 1000;
const dayMs = (s) => Date.parse(`${s}T00:00:00Z`);
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
export const addDays = (s, n) => dayOf(dayMs(s) + n * 86400000);
export const daysBetween = (a, b) => Math.round((dayMs(b) - dayMs(a)) / 86400000);
const json = (v) => (v == null ? null : typeof v === 'string' ? JSON.parse(v) : v);

export async function plantToday(db, companyId) {
  const { plantZone, wallOf } = await import('./floorService.js');
  const wall = wallOf(Date.now(), await plantZone(db, companyId));
  return { wall, today: wall.slice(0, 10) };
}

export function monthBounds(month) {
  if (!MONTH_RE.test(String(month))) throw invalid('INVALID', 'Month: YYYY-MM.');
  const first = `${month}-01`;
  const [y, m] = month.split('-').map(Number);
  const last = dayOf(Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 0));
  return { first, last };
}

/**
 * The weeks of a month as the plan speaks of them: Monday–Sunday, the first from the 1st and the last to the month's end.
 * A stub shorter than MIN_WEEK days joins its neighbour (Nov 2026 starts on a Sunday: its weeks are 1–8, 9–15, 16–22, 23–30).
 */
const MIN_WEEK = 4;
export function weeksOf(month) {
  const { first, last } = monthBounds(month);
  const out = [];
  let s = first;
  while (s <= last) {
    const dow = new Date(`${s}T00:00:00Z`).getUTCDay();          // 0 = Sunday
    let e = addDays(s, dow === 0 ? 0 : 7 - dow);
    if (e > last) e = last;
    out.push({ start: s, end: e });
    s = addDays(e, 1);
  }
  if (out.length > 1 && daysBetween(out[0].start, out[0].end) + 1 < MIN_WEEK) { out[1].start = out[0].start; out.shift(); }
  const n = out.length;
  if (n > 1 && daysBetween(out[n - 1].start, out[n - 1].end) + 1 < MIN_WEEK) { out[n - 2].end = out[n - 1].end; out.pop(); }
  return out.map((w, i) => ({ no: i + 1, ...w }));
}

/* ── The facts a plan is made from ─────────────────────────────────────────────────────────────────── */

/** The fabrication machines: [{ id, code, name, typeId, typeName, areaId, areaName, status, on, contractor }]. 3 reads. */
export async function fabricationMachines(db, companyId) {
  const [prod, [rows], [outs]] = await Promise.all([
    productionMachineIds(db, companyId),
    db.query(
      `SELECT m.id, m.code, m.name, m.status, m.stage, m.kind, m.classification_id AS type_id, v.name AS type_name, s.id AS area_id, s.name AS area_name
         FROM cf_machines m JOIN cf_classification_nodes v ON v.id = m.classification_id LEFT JOIN cf_classification_nodes s ON s.id = v.parent_id
        WHERE m.company_id = ? AND m.deleted_at IS NULL`, [companyId]),
    db.query(
      `SELECT k.machine_id, p.id AS party_id, p.name FROM cf_machine_checkouts k JOIN cf_parties p ON p.id = k.party_id
        WHERE k.company_id = ? AND k.in_at IS NULL AND k.to_kind = 'contractor'`, [companyId]).catch(() => [[]]),
  ]);
  const withC = new Map(outs.map((o) => [Number(o.machine_id), { id: Number(o.party_id), name: o.name }]));
  return rows
    .filter((m) => prod.has(m.id) && (m.kind ?? 'machine') === 'machine' && !['condemned', 'condemn_requested'].includes(m.stage ?? 'live'))
    .map((m) => ({
      id: Number(m.id), code: m.code, name: m.name, typeId: String(m.type_id), typeName: m.type_name, areaId: m.area_id == null ? null : Number(m.area_id), areaName: m.area_name ?? 'Other',
      status: m.status, stage: m.stage ?? 'live', on: m.status === 'active' && (m.stage ?? 'live') === 'live', contractor: withC.get(Number(m.id)) ?? null,
    }))
    .sort((a, b) => a.areaName.localeCompare(b.areaName) || a.typeName.localeCompare(b.typeName) || a.code.localeCompare(b.code));
}

/** The steps of a unit, in the order the work is done: its stages (deepest first), else its work per type. */
function stepsOf(u) {
  const out = [];
  if (Array.isArray(u.stages) && u.stages.length) {
    for (const st of u.stages) for (const s of st.steps) if (s.minutes > 0.01) out.push({ fn: String(s.fn), minutes: Number(s.minutes) });
  } else {
    for (const [fn, minutes] of Object.entries(u.work ?? {})) if (minutes > 0.01) out.push({ fn: String(fn), minutes: Number(minutes) });
  }
  // The same type twice in a row is one step.
  const merged = [];
  for (const s of out) { const l = merged[merged.length - 1]; if (l && l.fn === s.fn) l.minutes += s.minutes; else merged.push({ ...s }); }
  return merged;
}

/**
 * Everything a plan of `month` is made from, as of `from` (the plan's first day: the month's 1st, or today when the
 * month has begun). { month, from, last, days, orders, units, machines, calendars, fns, assumed }.
 */
export async function loadFacts(db, companyId, opts = {}) {
  // One screen asks for the same facts several times (the overview: the week, its progress, the alerts). They are kept
  // FACTS_TTL_MS per company, month and first day; a plan run inside a transaction reads them fresh.
  const key = `${companyId}|${opts.month}|${opts.from ?? ''}`;
  const hit = factsCache.get(key);
  if (hit && Date.now() - hit.at < FACTS_TTL_MS && !opts.fresh) return structuredClone(hit.facts);
  const facts = await loadFactsNow(db, companyId, opts);
  factsCache.set(key, { at: Date.now(), facts: structuredClone(facts) });
  if (factsCache.size > 40) factsCache.delete(factsCache.keys().next().value);
  return facts;
}
const FACTS_TTL_MS = 45_000;
const factsCache = new Map();

async function loadFactsNow(db, companyId, { month, from = null } = {}) {
  const { first, last } = monthBounds(month);
  const { today } = await plantToday(db, companyId);
  const start = from ?? (today > first ? (today > last ? last : today) : first);
  const horizonEnd = addDays(last, SPILL_DAYS);
  const days = daysBetween(start, horizonEnd) + 1;
  const [snapshot, machines, [pos]] = await Promise.all([
    getPlanner(db, companyId, { from: first }),
    fabricationMachines(db, companyId),
    db.query(
      `SELECT p.id, p.code, p.order_id, p.order_line_id, p.lines_json, p.level, p.status, p.label FROM cf_production_orders p
        WHERE p.company_id = ? AND p.deleted_at IS NULL AND p.status IN (?) ORDER BY p.order_id, p.seq`, [companyId, PLAN_PO_STATUSES]),
  ]);
  const calendars = await machinesCalendar(db, companyId, { from: start, to: horizonEnd, machineIds: machines.map((m) => m.id) });
  // The lines the production orders cover (a production order of the whole order covers every line).
  const linesOfOrder = new Map(snapshot.orders.map((o) => [Number(o.id), o.lines.map((l) => Number(l.id))]));
  const poOfLine = new Map();          // line → [production orders]
  for (const p of pos) {
    const lines = p.order_line_id ? [Number(p.order_line_id)] : (json(p.lines_json) ?? []).map(Number).filter(Boolean);
    const cover = lines.length ? lines : linesOfOrder.get(Number(p.order_id)) ?? [];
    for (const l of cover) { if (!poOfLine.has(l)) poOfLine.set(l, []); poOfLine.get(l).push({ id: p.id, code: p.code, status: p.status }); }
  }
  const fnName = new Map(snapshot.functions.map((f) => [String(f.key), f.name]));
  const fnArea = new Map(snapshot.functions.map((f) => [String(f.key), (f.path ?? []).find((p) => p.depth === 1)?.name ?? null]));
  const orderById = new Map(snapshot.orders.map((o) => [Number(o.id), o]));
  const byLine = new Map();
  for (const u of snapshot.units) { if (!byLine.has(u.lineId)) byLine.set(u.lineId, []); byLine.get(u.lineId).push(u); }
  const units = [];
  let assumed = 0;
  for (const [lineId, list] of byLine) {
    const covering = poOfLine.get(Number(lineId));
    if (!covering) continue;
    const marks = list.filter((u) => u.isMark && u.level !== 'line');
    const ship = marks.length ? marks : list.filter((u) => u.level === 'line');
    const order = orderById.get(Number(ship[0]?.orderId));
    ship.forEach((u, i) => {
      const mat = u.material ?? null;
      let earliest = 0; let materialDate = null; let materialAssumed = false;
      if (mat && mat.state !== 'ready') {
        if (mat.readyDate) materialDate = String(mat.readyDate).slice(0, 10);
        else { materialDate = addDays(start, ASSUMED_DAYS); materialAssumed = true; assumed += 1; }
        earliest = Math.max(0, daysBetween(start, materialDate));
      }
      units.push({
        key: u.key, orderId: Number(u.orderId), lineId: Number(lineId), code: u.code ?? u.name, name: u.name, tonnes: Number(u.tonnes ?? 0),
        done: !!u.done, progress: Number(u.progress ?? 0), seq: i, steps: u.done ? [] : stepsOf(u),
        earliest, materialDate, materialAssumed, materialState: mat?.state ?? 'ready', materialText: mat?.text ?? null,
        committedDate: u.committedDate ?? order?.committedDate ?? null, productionOrders: covering.map((p) => p.code),
      });
    });
  }
  const orders = [...new Set(units.map((u) => u.orderId))].map((id) => {
    const o = orderById.get(id);
    const mine = units.filter((u) => u.orderId === id);
    return {
      id, code: o?.code ?? `Order ${id}`, customer: o?.customer ?? null, committedDate: o?.committedDate ?? null, priority: o?.priority ?? null,
      tonnes: r3(mine.reduce((t, u) => t + u.tonnes, 0)), units: mine.length, doneUnits: mine.filter((u) => u.done).length,
      productionOrders: [...new Set(mine.flatMap((u) => u.productionOrders))],
    };
  });
  const fns = {};
  for (const u of units) for (const s of u.steps) if (!fns[s.fn]) fns[s.fn] = { key: s.fn, name: s.fn === CONTRACTOR ? 'Contractors' : s.fn === UNASSIGNED ? 'No machine type' : fnName.get(s.fn) ?? `Machine type ${s.fn}`, area: fnArea.get(s.fn) ?? null };
  for (const m of machines) if (!fns[m.typeId]) fns[m.typeId] = { key: m.typeId, name: m.typeName, area: m.areaName };
  return { month, first, from: start, last, horizonEnd, days, monthEndDay: daysBetween(start, last), today, orders, units, machines, calendars, fns, assumed };
}

/** Orders in the planner's order: the ranks given, then the order's own priority, then its committed date. */
export function rankOrders(orders, ranks = null) {
  const pos = new Map((ranks ?? []).map((id, i) => [Number(id), i]));
  return [...orders].sort((a, b) => (pos.has(a.id) ? pos.get(a.id) : 1e6) - (pos.has(b.id) ? pos.get(b.id) : 1e6)
    || (a.priority ?? 1e6) - (b.priority ?? 1e6) || String(a.committedDate ?? '9999').localeCompare(String(b.committedDate ?? '9999')) || a.id - b.id);
}

/** The capacity pools of a set of machines: machine type → minutes per day index. */
export function poolsOf(facts, machineIds) {
  const want = new Set(machineIds.map(Number));
  const pools = {};
  for (const m of facts.machines) {
    if (!want.has(m.id)) continue;
    const cal = facts.calendars.get(m.id);
    if (!pools[m.typeId]) pools[m.typeId] = new Array(facts.days).fill(0);
    if (!cal?.days) continue;
    cal.days.forEach((d, i) => { if (i < facts.days) pools[m.typeId][i] += Number(d.minutes ?? 0); });
  }
  return pools;
}

/** The engine's input from the facts and the planner's choices. */
export function engineInput(facts, { machineIds, ranks = null, toleranceDays = 3 }) {
  const ranked = rankOrders(facts.orders, ranks);
  const rankOf = new Map(ranked.map((o, i) => [o.id, i]));
  const pools = poolsOf(facts, machineIds);
  // A type some unit needs and no machine in the plan gives: an empty pool, so the unit waits (and the plan says why).
  for (const u of facts.units) for (const s of u.steps) if (s.fn !== CONTRACTOR && s.fn !== UNASSIGNED && !pools[s.fn]) pools[s.fn] = new Array(facts.days).fill(0);
  return {
    days: facts.days, monthEndDay: facts.monthEndDay, toleranceDays,
    pools, unlimited: { [CONTRACTOR]: UNLIMITED_MINUTES, [UNASSIGNED]: UNLIMITED_MINUTES },
    units: facts.units.filter((u) => !u.done).map((u) => ({ key: u.key, orderId: u.orderId, rank: rankOf.get(u.orderId) ?? 1e6, seq: u.seq, tonnes: u.tonnes, earliest: u.earliest, steps: u.steps })),
    ranked: ranked.map((o) => o.id),
  };
}

/**
 * MORE MACHINES: the options, the best first. One option = the best set (machines added one at a time while each adds
 * tonnes, up to MAX_SET), then single machines of the types the plan waits for. [{ key, label, machineIds, tonnes, gain }]
 */
const MAX_SET = 6;
function suggestMachines(facts, input, plan, machineIds) {
  const inPlan = new Set(machineIds.map(Number));
  const minutesOf = (m) => (facts.calendars.get(m.id)?.days ?? []).slice(0, facts.monthEndDay + 1).reduce((t, d) => t + Number(d.minutes ?? 0), 0);
  // The machine types units waited for, most days first.
  const waited = new Map();
  for (const u of plan.units) if (u.reason?.kind === 'capacity' && u.reason.fn) waited.set(u.reason.fn, (waited.get(u.reason.fn) ?? 0) + u.tonnes);
  // Also the types the plan loads to the brim in the month.
  for (const [fn, arr] of Object.entries(plan.load)) {
    const cap = (input.pools[fn] ?? []).slice(0, facts.monthEndDay + 1).reduce((t, x) => t + x, 0);
    const used = arr.slice(0, facts.monthEndDay + 1).reduce((t, x) => t + x, 0);
    if (cap > 0 && used / cap > 0.9 && !waited.has(fn)) waited.set(fn, 0.001);
  }
  const spare = facts.machines.filter((m) => !inPlan.has(m.id) && minutesOf(m) > 0);
  const bestOfType = (fn, skip) => spare.filter((m) => m.typeId === fn && !skip.has(m.id)).sort((a, b) => minutesOf(b) - minutesOf(a))[0] ?? null;
  const addOf = (ms) => {
    const add = {};
    for (const m of ms) {
      const days = facts.calendars.get(m.id)?.days ?? [];
      if (!add[m.typeId]) add[m.typeId] = new Array(facts.days).fill(0);
      days.forEach((d, i) => { if (i < facts.days) add[m.typeId][i] += Number(d.minutes ?? 0); });
    }
    return add;
  };
  const fnsToTry = [...waited].sort((a, b) => b[1] - a[1]).map(([fn]) => fn).slice(0, 8);
  const singles = fnsToTry.map((fn) => bestOfType(fn, new Set())).filter(Boolean);
  if (!singles.length) return { options: [], noSpare: fnsToTry.filter((fn) => !bestOfType(fn, new Set())).map((fn) => facts.fns[fn]?.name ?? fn) };
  const single = whatIf(input, singles.map((m) => ({ key: `m${m.id}`, label: `${m.code} · ${m.name}`, machineIds: [m.id], add: addOf([m]) })), { basePlan: plan, iterations: 80 });
  // The best set: greedy, the best next machine each round.
  const set = []; const taken = new Set(); let cur = plan.tonnes;
  for (let round = 0; round < MAX_SET; round += 1) {
    const cands = fnsToTry.map((fn) => bestOfType(fn, taken)).filter(Boolean).slice(0, 4);
    if (!cands.length) break;
    const res = whatIf(input, cands.map((m) => ({ key: `m${m.id}`, machine: m, add: addOf([...set, m]) })), { basePlan: plan, iterations: 60 });
    const top = res[0];
    if (!top || top.tonnes <= cur + 0.0005) break;
    set.push(top.machine); taken.add(top.machine.id); cur = top.tonnes;
  }
  const options = [];
  if (set.length > 1) options.push({ key: `set${set.map((m) => m.id).join('.')}`, label: `${set.length} machines: ${set.map((m) => m.code).join(', ')}`, machineIds: set.map((m) => m.id), tonnes: r3(cur), gain: r3(cur - plan.tonnes), best: true });
  for (const o of single) if (o.gain > 0.0005) options.push({ key: o.key, label: o.label, machineIds: o.machineIds, tonnes: o.tonnes, gain: o.gain });
  options.sort((a, b) => b.gain - a.gain);
  return { options: options.slice(0, 6), noSpare: fnsToTry.filter((fn) => !bestOfType(fn, new Set())).map((fn) => facts.fns[fn]?.name ?? fn) };
}

/** The optimiser's answer in the screen's words: dates, names, weeks, the load against capacity. */
export function describePlan(facts, input, plan, machineIds) {
  const date = (d) => (d == null ? null : addDays(facts.from, d));
  const unitBy = new Map(facts.units.map((u) => [u.key, u]));
  const orderBy = new Map(facts.orders.map((o) => [o.id, o]));
  const weeks = weeksOf(facts.month).map((w) => ({ ...w, tonnes: 0, units: 0 }));
  const weekOf = (s) => weeks.find((w) => s >= w.start && s <= w.end) ?? null;
  const units = plan.units.map((p) => {
    const u = unitBy.get(p.key);
    const fin = date(p.finish);
    const w = fin && p.inMonth ? weekOf(fin) : null;
    if (w) { w.tonnes += p.tonnes; w.units += 1; }
    return {
      key: p.key, orderId: p.orderId, order: orderBy.get(p.orderId)?.code ?? null, code: u?.code ?? p.key, name: u?.name ?? null, tonnes: p.tonnes,
      start: date(p.start), finish: fin, inMonth: p.inMonth, week: w?.no ?? null,
      reason: p.reason ? { ...p.reason, fnName: p.reason.fn ? facts.fns[p.reason.fn]?.name ?? p.reason.fn : null } : null,
      materialDate: u?.materialDate ?? null, materialAssumed: !!u?.materialAssumed, productionOrders: u?.productionOrders ?? [],
      steps: p.days.map((s) => ({ fn: s.fn, fnName: facts.fns[s.fn]?.name ?? s.fn, from: date(s.from), to: date(s.to), minutes: s.minutes, byDay: Object.fromEntries(Object.entries(s.byDay).map(([d, m]) => [date(Number(d)), m])) })),
    };
  });
  for (const w of weeks) w.tonnes = r3(w.tonnes);
  const doneUnits = facts.units.filter((u) => u.done);
  const orders = rankOrders(facts.orders, input.ranked).map((o, i) => {
    const p = plan.orders.find((x) => x.orderId === o.id);
    const mine = units.filter((u) => u.orderId === o.id);
    return {
      id: o.id, code: o.code, customer: o.customer, committedDate: o.committedDate, rank: i + 1, productionOrders: o.productionOrders,
      tonnes: o.tonnes, units: o.units, doneUnits: o.doneUnits,
      tonnesInMonth: r3(p?.tonnesInMonth ?? 0), unitsInMonth: p?.unitsInMonth ?? 0,
      finish: date(p?.finish ?? null), priorityFinish: date(p?.priorityFinish ?? null),
      late: !!o.committedDate && !!date(p?.finish ?? null) && date(p.finish) > o.committedDate,
      byWeek: weeks.map((w) => r3(mine.filter((u) => u.week === w.no).reduce((t, u) => t + u.tonnes, 0))),
    };
  });
  // Load against capacity per machine type per week of the month (hours), and across the month.
  const M = facts.monthEndDay;
  const inMonthIdx = (s) => Math.max(0, daysBetween(facts.from, s));
  const load = Object.entries(plan.load).map(([fn, arr]) => {
    const cap = input.pools[fn] ?? [];
    const sum = (a, lo, hi) => { let t = 0; for (let d = lo; d <= hi && d < a.length; d += 1) t += a[d]; return t; };
    const used = sum(arr, 0, M); const have = sum(cap, 0, M);
    return {
      fn, name: facts.fns[fn]?.name ?? fn, area: facts.fns[fn]?.area ?? null,
      machines: facts.machines.filter((m) => m.typeId === fn && machineIds.includes(m.id)).length,
      hours: Math.round(used / 60), capacityHours: Math.round(have / 60), usedPct: have > 0 ? Math.round((used / have) * 100) : (used > 0 ? 999 : 0),
      byWeek: weeks.map((w) => {
        const lo = inMonthIdx(w.start < facts.from ? facts.from : w.start); const hi = inMonthIdx(w.end);
        if (w.end < facts.from) return { hours: 0, capacityHours: 0 };
        return { hours: Math.round(sum(arr, lo, hi) / 60), capacityHours: Math.round(sum(cap, lo, hi) / 60) };
      }),
    };
  }).filter((l) => l.hours > 0 || l.capacityHours > 0).sort((a, b) => b.usedPct - a.usedPct);
  // The pivot the MD reads: orders × machine types, hours in the month.
  const pivotFns = load.filter((l) => l.hours > 0).map((l) => ({ fn: l.fn, name: l.name }));
  const lastDay = facts.last;
  const pivot = orders.map((o) => {
    const cells = {};
    for (const u of units) if (u.orderId === o.id) for (const s of u.steps) for (const [d, m] of Object.entries(s.byDay)) if (d <= lastDay) cells[s.fn] = (cells[s.fn] ?? 0) + m;
    return { orderId: o.id, code: o.code, tonnes: o.tonnesInMonth, hours: Object.fromEntries(Object.entries(cells).map(([fn, m]) => [fn, Math.round(m / 60)])) };
  });
  return {
    month: facts.month, from: facts.from, last: facts.last, today: facts.today,
    tonnes: plan.tonnes, priorityTonnes: plan.priorityTonnes, boundTonnes: plan.boundTonnes, boundBy: plan.boundBy ? facts.fns[plan.boundBy]?.name ?? plan.boundBy : null, gapPct: plan.gapPct,
    doneTonnes: r3(doneUnits.reduce((t, u) => t + u.tonnes, 0)), doneUnits: doneUnits.length,
    totalTonnes: r3(facts.units.reduce((t, u) => t + u.tonnes, 0)), totalUnits: facts.units.length,
    notInMonth: units.filter((u) => !u.inMonth).length, assumedMaterial: facts.assumed,
    feasible: plan.feasible, iterations: plan.iterations, ms: plan.ms, order: plan.order,
    weeks, orders, units, load, pivot: { fns: pivotFns, rows: pivot },
  };
}

/** Optimise a month from the planner's choices (nothing is written). */
export async function planMonth(db, companyId, { month, machineIds = null, ranks = null, toleranceDays = 3, from = null, suggest = true, iterations = 400, startOrder = null, materialAsKnown = null } = {}) {
  const facts = await loadFacts(db, companyId, { month, from });
  // materialAsKnown { orderId: 'YYYY-MM-DD' } — a plan made AS OF an earlier day (the demo's history, scripts/cf_kepl/
  // planning-demo.mjs): the date that order's material was promised for then. Never set from a request.
  if (materialAsKnown) {
    for (const u of facts.units) {
      const d = materialAsKnown[u.orderId];
      if (!d || u.done || u.materialState === 'ready') continue;
      u.materialDate = d; u.materialAssumed = false; u.earliest = Math.max(0, daysBetween(facts.from, d));
    }
    facts.assumed = facts.units.filter((u) => u.materialAssumed).length;
  }
  const ids = (machineIds ?? facts.machines.filter((m) => m.on).map((m) => m.id)).map(Number).filter((id) => facts.machines.some((m) => m.id === id));
  const tol = Math.max(0, Math.min(60, Number.isFinite(Number(toleranceDays)) ? Math.round(Number(toleranceDays)) : 3));
  const input = engineInput(facts, { machineIds: ids, ranks, toleranceDays: tol });
  const plan = optimise(input, { iterations, startOrder });
  const result = describePlan(facts, input, plan, ids);
  result.suggestions = suggest ? suggestMachines(facts, input, plan, ids) : { options: [], noSpare: [] };
  return { facts, input, plan, result, machineIds: ids, toleranceDays: tol, ranks: input.ranked };
}

/* ── The choices screen: machines by area ──────────────────────────────────────────────────────────── */

function machineChoices(facts, machineIds) {
  const inPlan = new Set(machineIds);
  const hoursOf = (m) => Math.round((facts.calendars.get(m.id)?.days ?? []).slice(0, facts.monthEndDay + 1).reduce((t, d) => t + Number(d.minutes ?? 0), 0) / 60);
  const areas = new Map();
  for (const m of facts.machines) {
    const key = m.areaName;
    if (!areas.has(key)) areas.set(key, { area: key, machines: [] });
    areas.get(key).machines.push({ id: m.id, code: m.code, name: m.name, typeId: m.typeId, typeName: m.typeName, on: m.on, stage: m.stage, inPlan: inPlan.has(m.id), hours: hoursOf(m), contractor: m.contractor });
  }
  return [...areas.values()].map((a) => ({ ...a, total: a.machines.length, inPlan: a.machines.filter((m) => m.inPlan).length, on: a.machines.filter((m) => m.on).length }));
}

/* ── The stored plan ───────────────────────────────────────────────────────────────────────────────── */

const HEAD = 'id, company_id, month, version, status, tolerance_days, tonnes, bound_tonnes, note, approval_id, run_at, sent_at, frozen_at, frozen_by, created_by, created_at';
function shapeHead(r) {
  return {
    id: r.id, month: String(r.month).slice(0, 7), version: r.version, status: r.status, toleranceDays: r.tolerance_days,
    tonnes: r.tonnes == null ? null : Number(r.tonnes), boundTonnes: r.bound_tonnes == null ? null : Number(r.bound_tonnes), note: r.note ?? null,
    approvalId: r.approval_id ?? null, runAt: r.run_at, sentAt: r.sent_at, frozenAt: r.frozen_at,
  };
}

export async function plansOfMonth(db, companyId, month) {
  const { first } = monthBounds(month);
  // Sorted here, not in SQL: the rows carry the plan documents (JSON) and MySQL will not sort rows that large.
  const [rows] = await db.query('SELECT * FROM cf_mplans WHERE company_id = ? AND month = ? AND deleted_at IS NULL', [companyId, first]);
  return rows.sort((a, b) => b.version - a.version);
}

/** The frozen plan of a month (the latest), or null. */
export async function frozenPlan(db, companyId, month) {
  const rows = await plansOfMonth(db, companyId, month);
  const f = rows.find((r) => r.status === 'frozen');
  return f ? { ...shapeHead(f), inputs: json(f.inputs_json), result: json(f.result_json) } : null;
}

/**
 * GET /planning/month?month= — the month's plan as the screen opens it: the working plan (a draft or one with the MD,
 * else the frozen one), the frozen one beside it, and the machine choices. A month with no plan yet gets a fresh run
 * from the defaults (not saved).
 */
export async function getMonth(db, companyId, q = {}) {
  const { today } = await plantToday(db, companyId);
  const month = blank(q.month) ? today.slice(0, 7) : String(q.month);
  const rows = await plansOfMonth(db, companyId, month);
  const working = rows.find((r) => ['draft', 'pending'].includes(r.status)) ?? null;
  const frozen = rows.find((r) => r.status === 'frozen') ?? null;
  const shown = working ?? frozen;
  const facts = await loadFacts(db, companyId, { month });
  let doc; let inputs;
  if (shown) { doc = json(shown.result_json); inputs = json(shown.inputs_json) ?? {}; }
  else {
    const run = await planMonth(db, companyId, { month, iterations: 250 });
    doc = run.result; inputs = { machineIds: run.machineIds, ranks: run.ranks, toleranceDays: run.toleranceDays };
  }
  const machineIds = (inputs.machineIds ?? []).map(Number);
  return {
    month, today, weeks: weeksOf(month),
    plan: shown ? shapeHead(shown) : null, frozen: frozen ? shapeHead(frozen) : null,
    frozenTonnes: frozen ? Number(frozen.tonnes) : null,
    versions: rows.map(shapeHead),
    inputs: { machineIds, ranks: inputs.ranks ?? [], toleranceDays: inputs.toleranceDays ?? 3 },
    result: doc,
    areas: machineChoices(facts, machineIds),
    canEdit: !shown || shown.status === 'draft' || shown.status === 'frozen',
    fresh: !shown,
  };
}

/**
 * POST /planning/month/run { month, machineIds?, ranks?, toleranceDays?, save? } — optimise with these choices; with
 * save, keep it as the month's draft (a new version when the month already has a frozen plan; a plan with the MD is
 * not changed — withdraw it first).
 */
export async function runMonth(db, c, input = {}) {
  const run = await planMonth(db, c.companyId, { month: input.month, machineIds: input.machineIds ?? null, ranks: input.ranks ?? null, toleranceDays: input.toleranceDays ?? 3 });
  const inputs = { machineIds: run.machineIds, ranks: run.ranks, toleranceDays: run.toleranceDays, from: run.facts.from };
  let head = null;
  if (input.save) {
    const rows = await plansOfMonth(db, c.companyId, input.month);
    if (rows.some((r) => r.status === 'pending')) throw conflict('WITH_MD', 'This month\'s plan is with the MD — withdraw it to change it.');
    const draft = rows.find((r) => r.status === 'draft');
    const { wall } = await plantToday(db, c.companyId);
    const { first } = monthBounds(input.month);
    if (draft) {
      await db.query('UPDATE cf_mplans SET tolerance_days = ?, inputs_json = ?, result_json = ?, tonnes = ?, bound_tonnes = ?, run_at = ?, note = ? WHERE company_id = ? AND id = ?',
        [run.toleranceDays, JSON.stringify(inputs), JSON.stringify(run.result), run.result.tonnes, run.result.boundTonnes, wall, blank(input.note) ? draft.note : String(input.note).slice(0, 1000), c.companyId, draft.id]);
      head = draft.id;
    } else {
      const version = (rows[0]?.version ?? 0) + 1;
      const [ins] = await db.query(
        'INSERT INTO cf_mplans (company_id, month, version, status, tolerance_days, inputs_json, result_json, tonnes, bound_tonnes, run_at, note, created_by) VALUES (?, ?, ?, \'draft\', ?, ?, ?, ?, ?, ?, ?, ?)',
        [c.companyId, first, version, run.toleranceDays, JSON.stringify(inputs), JSON.stringify(run.result), run.result.tonnes, run.result.boundTonnes, wall, blank(input.note) ? null : String(input.note).slice(0, 1000), c.userId ?? null]);
      head = ins.insertId;
    }
  }
  const facts = run.facts;
  return { saved: !!input.save, planId: head, inputs, result: run.result, areas: machineChoices(facts, run.machineIds) };
}

async function requirePlan(db, companyId, id, { lock = false } = {}) {
  const [[p]] = await db.query(`SELECT * FROM cf_mplans WHERE company_id = ? AND id = ? AND deleted_at IS NULL${lock ? ' FOR UPDATE' : ''}`, [companyId, Number(id)]);
  if (!p) throw notFound('Month plan');
  return p;
}

/** POST /planning/month/:id/send { note? } — to the MD: frozen once approved. */
export async function sendMonth(db, c, id, input = {}) {
  const p = await requirePlan(db, c.companyId, id, { lock: true });
  if (p.status !== 'draft') throw invalid('NOT_DRAFT', `This plan is ${p.status} — only a draft is sent to the MD.`);
  const doc = json(p.result_json);
  const month = String(p.month).slice(0, 7);
  const { wall } = await plantToday(db, c.companyId);
  const approvalId = await requestApproval(db, c, {
    type: 'month_plan', subjectId: p.id, subjectCode: `${month} v${p.version}`, title: `Month plan ${month} (v${p.version}) — ${doc.tonnes} t`,
    summary: `${doc.tonnes} t to finish in ${month} across ${doc.orders.length} orders; best possible ${doc.boundTonnes} t.`, note: blank(input.note) ? null : String(input.note),
    context: {
      kind: 'month_plan', month, version: p.version, tonnes: doc.tonnes, priorityTonnes: doc.priorityTonnes, boundTonnes: doc.boundTonnes, boundBy: doc.boundBy,
      weeks: doc.weeks, orders: doc.orders.map((o) => ({ code: o.code, customer: o.customer, rank: o.rank, tonnes: o.tonnes, tonnesInMonth: o.tonnesInMonth, finish: o.finish, committedDate: o.committedDate, late: o.late })),
      pivot: doc.pivot, machines: (json(p.inputs_json)?.machineIds ?? []).length, notInMonth: doc.notInMonth, assumedMaterial: doc.assumedMaterial,
    },
  });
  await db.query("UPDATE cf_mplans SET status = 'pending', approval_id = ?, sent_at = ?, note = COALESCE(?, note) WHERE company_id = ? AND id = ?", [approvalId, wall, blank(input.note) ? null : String(input.note).slice(0, 1000), c.companyId, p.id]);
  return getMonth(db, c.companyId, { month });
}

/** POST /planning/month/:id/withdraw — take it back from the MD (a draft again). */
export async function withdrawMonth(db, c, id) {
  const p = await requirePlan(db, c.companyId, id, { lock: true });
  if (p.status !== 'pending') throw invalid('NOT_PENDING', 'This plan is not with the MD.');
  const { withdrawApprovals } = await import('./approvalService.js');
  await withdrawApprovals(db, c, { subjectType: 'month_plan', subjectId: p.id, types: ['month_plan'], note: 'Taken back by the planner' });
  await db.query("UPDATE cf_mplans SET status = 'draft', approval_id = NULL WHERE company_id = ? AND id = ?", [c.companyId, p.id]);
  return getMonth(db, c.companyId, { month: String(p.month).slice(0, 7) });
}

/** The MD's decision: approve = frozen (the earlier frozen version of the month is superseded); send back = a draft again. */
export const monthPlanApprovalHandler = {
  async onApprove(db, c, row) {
    const p = await requirePlan(db, c.companyId, row.subject_id, { lock: true });
    if (p.status !== 'pending') throw invalid('NOT_PENDING', 'This plan is not waiting for the MD.');
    const { wall } = await plantToday(db, c.companyId);
    await db.query("UPDATE cf_mplans SET status = 'superseded' WHERE company_id = ? AND month = ? AND status = 'frozen' AND id <> ?", [c.companyId, p.month, p.id]);
    await db.query("UPDATE cf_mplans SET status = 'frozen', frozen_at = ?, frozen_by = ? WHERE company_id = ? AND id = ?", [wall, c.userId ?? null, c.companyId, p.id]);
    return { frozen: true };
  },
  async onReject(db, c, row, note) {
    await db.query("UPDATE cf_mplans SET status = 'draft', approval_id = NULL, note = ? WHERE company_id = ? AND id = ? AND status = 'pending'", [note ? `Sent back: ${String(note).slice(0, 900)}` : null, c.companyId, row.subject_id]);
    return { rejected: true };
  },
  async onWithdraw(db, c, row) {
    await db.query("UPDATE cf_mplans SET status = 'draft', approval_id = NULL WHERE company_id = ? AND id = ? AND status = 'pending'", [c.companyId, row.subject_id]);
  },
};

/** GET /planning/months — every month with a plan: its frozen plan's tonnes and the versions. */
export async function listMonths(db, companyId) {
  const [rows] = await db.query(`SELECT ${HEAD} FROM cf_mplans WHERE company_id = ? AND deleted_at IS NULL ORDER BY month DESC, version DESC LIMIT 200`, [companyId]);
  const byMonth = new Map();
  for (const r of rows) {
    const m = String(r.month).slice(0, 7);
    if (!byMonth.has(m)) byMonth.set(m, { month: m, frozen: null, versions: [] });
    const e = byMonth.get(m);
    e.versions.push(shapeHead(r));
    if (r.status === 'frozen' && !e.frozen) e.frozen = shapeHead(r);
  }
  return { months: [...byMonth.values()] };
}
