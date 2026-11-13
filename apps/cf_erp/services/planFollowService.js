/**
 * planFollowService.js — PLANNING after the month plan is frozen (init.sql §105; user 2026-11-13):
 *
 *   THE WEEK PLAN   "from this plan the weekly plan comes out. At the end of every week, we should look at what should be
 *                   the next week's plan to maximize the output for the month based on that time's reality … MD should be
 *                   notified of the new plan (he should see it at a high level, orders and operations pivot table with
 *                   output)." — the month is optimised again from that day's facts (what is done, the machines as they
 *                   are, the material dates as they stand, the frozen plan's machines and ranks, its order as a warm
 *                   start); the week's slice is the week plan. Published = the MD is told (a Home queue; no approval).
 *                   Closed = what happened is kept beside what was planned, with why (hours lost to stops, material that
 *                   came late, units that moved, contractors behind) and the planner's own notes.
 *   THE DAILY ROSTER "their daily roster for tomorrow, they should take the current reality and plan out for tomorrow
 *                   (auto suggested but with an ability to drag and drop other operations if required). Let the daily
 *                   plan be the output which the production team gets." — tomorrow's slice of a fresh plan, each task
 *                   given a machine of its type; arranged by hand; published to production.
 *   ALERTS          "all sorts of alerts should be raised to the planning team based on what resource changed from
 *                   their plan" — the plan in force (this week's published plan, else the frozen month plan) keeps what
 *                   it assumed; detectAlerts compares it with now: a machine of the plan down or switched off, a
 *                   material date that moved, a unit behind its day, an order added or changed, a contractor work order
 *                   past its date, consumables short. One row per thing; gone when it is no longer true.
 *   THE REVIEW      a month looked back on: the frozen plan against what finished, week by week, why, the contractors,
 *                   and the suggestions that were not taken.
 */
import { invalid, notFound, conflict } from '../lib/errors.js';
import {
  planMonth, loadFacts, frozenPlan, plantToday, monthBounds, weeksOf, addDays, daysBetween, fabricationMachines,
} from './monthPlanService.js';

const blank = (v) => v == null || String(v).trim() === '';
const r3 = (x) => Math.round(Number(x) * 1000) / 1000;
const json = (v) => (v == null ? null : typeof v === 'string' ? JSON.parse(v) : v);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const dateS = (d) => (d == null ? null : d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));

/** The plan week a day falls in (weeksOf its month). */
export function weekOfDay(day) {
  const w = weeksOf(day.slice(0, 7)).find((x) => day >= x.start && day <= x.end);
  return { ...w, month: day.slice(0, 7) };
}

/* ── What happened (actuals) ───────────────────────────────────────────────────────────────────────── */

/** Run hours and stop hours per machine type between two days (plant clock). 2 reads. */
export async function hoursBetween(db, companyId, from, to) {
  const lo = `${from} 00:00:00`; const hi = `${addDays(to, 1)} 00:00:00`;
  const [[runs], [stops]] = await Promise.all([
    db.query(
      `SELECT m.classification_id AS fn, SUM(TIMESTAMPDIFF(MINUTE, GREATEST(ws.started_at, ?), LEAST(COALESCE(ws.ended_at, ?), ?))) AS minutes
         FROM cf_work_sessions ws JOIN cf_machines m ON m.id = ws.machine_id
        WHERE ws.company_id = ? AND ws.deleted_at IS NULL AND ws.started_at < ? AND COALESCE(ws.ended_at, ?) > ? GROUP BY m.classification_id`,
      [lo, hi, hi, companyId, hi, hi, lo]),
    db.query(
      `SELECT m.classification_id AS fn, m.id AS machine_id, m.code, SUM(TIMESTAMPDIFF(MINUTE, GREATEST(s.started_at, ?), LEAST(COALESCE(s.ended_at, ?), ?))) AS minutes,
              MAX(r.label) AS reason
         FROM cf_machine_stops s JOIN cf_machines m ON m.id = s.machine_id LEFT JOIN cf_stop_reasons r ON r.id = s.reason_id
        WHERE s.company_id = ? AND s.started_at < ? AND COALESCE(s.ended_at, ?) > ? GROUP BY m.classification_id, m.id, m.code`,
      [lo, hi, hi, companyId, hi, hi, lo]).catch(() => [[]]),
  ]);
  const run = {}; const stop = {}; const stopped = [];
  for (const r of runs) run[String(r.fn)] = Math.max(0, Number(r.minutes ?? 0));
  for (const s of stops) {
    const m = Math.max(0, Number(s.minutes ?? 0));
    stop[String(s.fn)] = (stop[String(s.fn)] ?? 0) + m;
    if (m > 0) stopped.push({ machineId: s.machine_id, code: s.code, fn: String(s.fn), hours: Math.round(m / 6) / 10, reason: s.reason ?? null });
  }
  return { run, stop, stopped: stopped.sort((a, b) => b.hours - a.hours) };
}

/** The contractors' work orders with what was planned and what is paid: per work order, and per contractor. 2 reads. */
export async function contractorStanding(db, companyId, { from = null, to = null } = {}) {
  let rows = [];
  try {
    [rows] = await db.query(
      `SELECT w.id, w.code, w.status, w.start_date, w.due_date, w.production_order_id, po.code AS production_order, p.id AS contractor_id, p.name AS contractor,
              (SELECT COALESCE(SUM(s.tonnes), 0) FROM cf_work_order_scope s WHERE s.company_id = w.company_id AND s.work_order_id = w.id AND s.deleted_at IS NULL) AS tonnes,
              (SELECT COALESCE(SUM(y.tonnes), 0) FROM cf_work_order_payments y WHERE y.company_id = w.company_id AND y.work_order_id = w.id AND y.deleted_at IS NULL) AS paid,
              (SELECT COALESCE(SUM(y.tonnes), 0) FROM cf_work_order_payments y WHERE y.company_id = w.company_id AND y.work_order_id = w.id AND y.deleted_at IS NULL
                  AND (? IS NULL OR y.payment_date >= ?) AND (? IS NULL OR y.payment_date <= ?)) AS paid_in_range
         FROM cf_work_orders w JOIN cf_parties p ON p.id = w.contractor_id LEFT JOIN cf_production_orders po ON po.id = w.production_order_id
        WHERE w.company_id = ? AND w.deleted_at IS NULL AND w.kind = 'po' AND w.status <> 'cancelled' ORDER BY w.id DESC LIMIT 300`,
      [from, from, to, to, companyId]);
  } catch (e) { if (e.errno !== 1054 && e.errno !== 1146) throw e; }
  const { today } = await plantToday(db, companyId);
  const orders = rows.map((w) => {
    const tonnes = Number(w.tonnes); const paid = Number(w.paid);
    const start = dateS(w.start_date); const due = dateS(w.due_date);
    // What should be done by today on a straight line from its start to its due date.
    let expected = null;
    if (start && due && due >= start) expected = tonnes * Math.max(0, Math.min(1, (daysBetween(start, today) + 1) / (daysBetween(start, due) + 1)));
    return {
      id: w.id, code: w.code, status: w.status, contractor: { id: w.contractor_id, name: w.contractor }, productionOrder: w.production_order ? { id: w.production_order_id, code: w.production_order } : null,
      start, due, tonnes: r3(tonnes), paid: r3(paid), paidInRange: r3(Number(w.paid_in_range)), expected: expected == null ? null : r3(expected),
      behind: expected != null && w.status !== 'done' ? r3(Math.max(0, expected - paid)) : 0, overdue: !!due && due < today && w.status !== 'done' && paid < tonnes - 0.001,
    };
  });
  const by = new Map();
  for (const o of orders) {
    const e = by.get(o.contractor.id) ?? { id: o.contractor.id, name: o.contractor.name, workOrders: 0, tonnes: 0, paid: 0, paidInRange: 0, behind: 0, overdue: 0 };
    e.workOrders += 1; e.tonnes += o.tonnes; e.paid += o.paid; e.paidInRange += o.paidInRange; e.behind += o.behind; e.overdue += o.overdue ? 1 : 0;
    by.set(o.contractor.id, e);
  }
  const machines = (await fabricationMachines(db, companyId)).filter((m) => m.contractor);
  return {
    orders,
    contractors: [...by.values()].map((e) => ({
      ...e, tonnes: r3(e.tonnes), paid: r3(e.paid), paidInRange: r3(e.paidInRange), behind: r3(e.behind), donePct: e.tonnes > 0 ? Math.round((e.paid / e.tonnes) * 100) : null,
      machines: machines.filter((m) => m.contractor.id === e.id).map((m) => ({ id: m.id, code: m.code, name: m.name })),
    })).sort((a, b) => b.behind - a.behind),
    machinesOut: machines.map((m) => ({ id: m.id, code: m.code, name: m.name, contractor: m.contractor })),
  };
}

/** What the plan needs of consumables in a span of days, against what Stores has and what is on order. */
export async function consumableNeeds(db, companyId, doc, { from, to }) {
  let rules = [];
  try {
    [rules] = await db.query(
      `SELECT c.operation_id, c.item_id, c.per, c.quantity, r.subject_type, r.subject_id, i.code, i.name, d.uom
         FROM cf_operation_consumables c
         JOIN cf_master_records i ON i.id = c.item_id JOIN cf_item_details d ON d.master_id = c.item_id
         JOIN cf_operation_machine_rules r ON r.company_id = c.company_id AND r.operation_id = c.operation_id AND r.deleted_at IS NULL AND r.eligible = 1 AND r.subject_type = 'classification'
        WHERE c.company_id = ? AND c.deleted_at IS NULL`, [companyId]);
  } catch (e) { if (e.errno !== 1054 && e.errno !== 1146) throw e; return []; }
  if (!rules.length) return [];
  // Hours per machine type in the span, and the first day each type works in it.
  const hours = {}; const firstDay = {};
  for (const u of doc.units ?? []) for (const s of u.steps ?? []) for (const [d, m] of Object.entries(s.byDay ?? {})) {
    if (d < from || d > to) continue;
    hours[s.fn] = (hours[s.fn] ?? 0) + m / 60;
    if (!firstDay[s.fn] || d < firstDay[s.fn]) firstDay[s.fn] = d;
  }
  const need = new Map();
  for (const r of rules) {
    const fn = String(r.subject_id);
    if (!hours[fn] || r.per !== 'hour') continue;
    const e = need.get(r.item_id) ?? { itemId: r.item_id, code: r.code, name: r.name, uom: r.uom, need: 0, needBy: null };
    e.need += hours[fn] * Number(r.quantity);
    if (!e.needBy || firstDay[fn] < e.needBy) e.needBy = firstDay[fn];
    need.set(r.item_id, e);
  }
  if (!need.size) return [];
  const ids = [...need.keys()];
  const [[stock], [incoming]] = await Promise.all([
    db.query('SELECT item_id, SUM(quantity) AS q FROM cf_stock_balances WHERE company_id = ? AND item_id IN (?) GROUP BY item_id', [companyId, ids]),
    db.query(
      `SELECT l.item_id, SUM(l.quantity - l.qty_received) AS q, MIN(COALESCE(l.expected_date, po.expected_date)) AS due
         FROM cf_purchase_order_lines l JOIN cf_purchase_orders po ON po.id = l.purchase_order_id
        WHERE l.company_id = ? AND l.item_id IN (?) AND l.deleted_at IS NULL AND po.deleted_at IS NULL AND po.status IN ('ordered', 'partially_received', 'pending_approval')
        GROUP BY l.item_id`, [companyId, ids]).catch(() => [[]]),
  ]);
  const have = new Map(stock.map((s) => [Number(s.item_id), Number(s.q)]));
  const onOrder = new Map(incoming.map((s) => [Number(s.item_id), { q: Number(s.q), due: dateS(s.due) }]));
  return [...need.values()].map((e) => {
    const inStock = have.get(Number(e.itemId)) ?? 0;
    const po = onOrder.get(Number(e.itemId)) ?? null;
    const short = Math.max(0, e.need - inStock - (po?.q ?? 0));
    return { ...e, need: r3(e.need), inStock: r3(inStock), onOrder: r3(po?.q ?? 0), onOrderDue: po?.due ?? null, short: r3(short) };
  }).sort((a, b) => b.short - a.short);
}

/** POST /planning/consumables/mr { items: [{ itemId, qty, needBy }], month } — an MR for stock with the date it is needed by. */
export async function raiseConsumableMr(db, c, input = {}) {
  const items = (Array.isArray(input.items) ? input.items : []).filter((x) => Number(x.qty) > 0);
  if (!items.length) throw invalid('INVALID', 'Nothing to ask for.');
  const needBy = items.map((x) => x.needBy).filter(Boolean).sort()[0] ?? null;
  const { createRequisition } = await import('./requisitionService.js');
  const mr = await createRequisition(db, c, {
    forType: 'stock', note: `Consumables for the ${input.month ?? ''} plan${needBy ? ` — needed by ${needBy}` : ''}. Raised from Planning.`.slice(0, 500),
    lines: items.map((x) => ({ itemId: Number(x.itemId), qty: Math.ceil(Number(x.qty)) })),
  });
  return { requisition: mr, needBy };
}

/* ── The week plan ─────────────────────────────────────────────────────────────────────────────────── */

/** The week's slice of a month document: what finishes, the pivot, the load. */
function weekSlice(doc, week) {
  const inWeek = (d) => d >= week.start && d <= week.end;
  const finishing = doc.units.filter((u) => u.finish && inWeek(u.finish));
  const fns = new Map();
  const rows = doc.orders.map((o) => {
    const hours = {}; let any = false;
    for (const u of doc.units) if (u.orderId === o.id) for (const s of u.steps) for (const [d, m] of Object.entries(s.byDay)) if (inWeek(d)) { hours[s.fn] = (hours[s.fn] ?? 0) + m; fns.set(s.fn, s.fnName); any = true; }
    const fin = finishing.filter((u) => u.orderId === o.id);
    return any || fin.length ? { orderId: o.id, code: o.code, customer: o.customer, rank: o.rank, tonnes: r3(fin.reduce((t, u) => t + u.tonnes, 0)), units: fin.length, hours: Object.fromEntries(Object.entries(hours).map(([fn, m]) => [fn, Math.round(m / 6) / 10])) } : null;
  }).filter(Boolean);
  const byDay = {};
  for (const u of doc.units) for (const s of u.steps) for (const [d, m] of Object.entries(s.byDay)) if (inWeek(d)) {
    if (!byDay[s.fn]) byDay[s.fn] = {};
    byDay[s.fn][d] = (byDay[s.fn][d] ?? 0) + m;
  }
  return {
    tonnes: r3(finishing.reduce((t, u) => t + u.tonnes, 0)),
    finishing: finishing.map((u) => ({ key: u.key, order: u.order, orderId: u.orderId, code: u.code, name: u.name, tonnes: u.tonnes, finish: u.finish })),
    pivot: { fns: [...fns].map(([fn, name]) => ({ fn, name })), rows },
    load: Object.entries(byDay).map(([fn, days]) => ({ fn, name: fns.get(fn) ?? fn, hours: Math.round(Object.values(days).reduce((t, m) => t + m, 0) / 6) / 10, byDay: Object.fromEntries(Object.entries(days).map(([d, m]) => [d, Math.round(m / 6) / 10])) })).sort((a, b) => b.hours - a.hours),
  };
}

/** What moved against the frozen month plan: units that left the month, units that came in, the tonnes between. */
function againstFrozen(doc, frozen) {
  if (!frozen?.result) return null;
  const was = new Map(frozen.result.units.map((u) => [u.key, u]));
  const out = []; const into = [];
  for (const u of doc.units) {
    const w = was.get(u.key);
    if (w?.inMonth && !u.inMonth) out.push({ key: u.key, order: u.order, code: u.code, tonnes: u.tonnes, was: w.finish, now: u.finish, reason: u.reason });
    if (w && !w.inMonth && u.inMonth) into.push({ key: u.key, order: u.order, code: u.code, tonnes: u.tonnes, was: w.finish, now: u.finish });
  }
  return { frozenTonnes: frozen.tonnes, out, into, outTonnes: r3(out.reduce((t, u) => t + u.tonnes, 0)), inTonnes: r3(into.reduce((t, u) => t + u.tonnes, 0)) };
}

async function requireWeek(db, companyId, id, { lock = false } = {}) {
  const [[w]] = await db.query(`SELECT * FROM cf_wplans WHERE company_id = ? AND id = ? AND deleted_at IS NULL${lock ? ' FOR UPDATE' : ''}`, [companyId, Number(id)]);
  if (!w) throw notFound('Week plan');
  return w;
}
const shapeWeek = (w) => ({
  id: w.id, weekStart: dateS(w.week_start), weekEnd: dateS(w.week_end), status: w.status, tonnesWeek: w.tonnes_week == null ? null : Number(w.tonnes_week),
  tonnesMonth: w.tonnes_month == null ? null : Number(w.tonnes_month), note: w.note ?? null, runAt: w.run_at, publishedAt: w.published_at, closedAt: w.closed_at,
  inputs: json(w.inputs_json), result: json(w.result_json), actual: json(w.actual_json), review: json(w.review_json),
});

/**
 * POST /planning/week/run { weekStart?, machineIds?, ranks?, toleranceDays?, note? } — the plan of a week (default: the
 * week tomorrow falls in), from today's facts and the frozen month plan's choices. Kept as the week's draft; a
 * published week is planned again only while it has not been closed.
 */
export async function runWeek(db, c, input = {}, sim = null) {
  // sim { from, wall, materialAsKnown, publish } — the demo's history only (planning-demo.mjs): a week planned AS OF a day.
  const clock = await plantToday(db, c.companyId);
  const today = sim?.from ?? clock.today; const wall = sim?.wall ?? clock.wall;
  const day = !blank(input.weekStart) && DATE_RE.test(String(input.weekStart)) ? String(input.weekStart) : addDays(today, 1);
  const week = weekOfDay(day);
  const frozen = await frozenPlan(db, c.companyId, week.month);
  const base = frozen?.inputs ?? {};
  const run = await planMonth(db, c.companyId, {
    month: week.month, machineIds: input.machineIds ?? base.machineIds ?? null, ranks: input.ranks ?? base.ranks ?? null,
    toleranceDays: input.toleranceDays ?? base.toleranceDays ?? 3, startOrder: frozen?.result?.order ?? null, suggest: false,
    from: sim?.from ?? null, materialAsKnown: sim?.materialAsKnown ?? null,
  });
  const doc = run.result;
  const slice = weekSlice(doc, week);
  const contractors = await contractorStanding(db, c.companyId, { from: week.start, to: week.end });
  const consumables = await consumableNeeds(db, c.companyId, doc, { from: week.start, to: week.end });
  // The month as it now stands: what the frozen plan counted and is done since, plus what this plan still finishes.
  const frozenKeys = new Set((frozen?.result?.units ?? []).map((u) => u.key));
  const doneSince = run.facts.units.filter((u) => u.done && frozenKeys.has(u.key));
  const doneTonnes = r3(doneSince.reduce((t, u) => t + u.tonnes, 0));
  const result = {
    week, month: week.month, from: doc.from, tonnesWeek: slice.tonnes, doneTonnes, planTonnes: doc.tonnes, tonnesMonth: r3(doneTonnes + doc.tonnes),
    frozenTonnes: frozen?.tonnes ?? null, against: againstFrozen(doc, frozen),
    finishing: slice.finishing, pivot: slice.pivot, load: slice.load, orders: doc.orders, units: doc.units, weeks: doc.weeks,
    suggestions: frozen?.result?.suggestions ?? doc.suggestions, contractors, consumables, order: doc.order, assumedMaterial: doc.assumedMaterial,
  };
  const inputs = { machineIds: run.machineIds, ranks: run.ranks, toleranceDays: run.toleranceDays, mplanId: frozen?.id ?? null, asOf: today };
  const [[have]] = await db.query('SELECT id, status FROM cf_wplans WHERE company_id = ? AND week_start = ? AND deleted_at IS NULL FOR UPDATE', [c.companyId, week.start]);
  if (have?.status === 'closed') throw conflict('CLOSED', 'That week is closed — its plan is history now.');
  const note = blank(input.note) ? null : String(input.note).slice(0, 1000);
  let id = have?.id;
  if (have) {
    await db.query("UPDATE cf_wplans SET mplan_id = ?, status = 'draft', inputs_json = ?, result_json = ?, tonnes_week = ?, tonnes_month = ?, run_at = ?, note = COALESCE(?, note), published_at = NULL WHERE company_id = ? AND id = ?",
      [frozen?.id ?? null, JSON.stringify(inputs), JSON.stringify(result), result.tonnesWeek, result.tonnesMonth, wall, note, c.companyId, have.id]);
  } else {
    const [ins] = await db.query(
      "INSERT INTO cf_wplans (company_id, mplan_id, week_start, week_end, status, inputs_json, result_json, tonnes_week, tonnes_month, run_at, note, created_by) VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?)",
      [c.companyId, frozen?.id ?? null, week.start, week.end, JSON.stringify(inputs), JSON.stringify(result), result.tonnesWeek, result.tonnesMonth, wall, note, c.userId ?? null]);
    id = ins.insertId;
  }
  if (sim?.publish) await db.query("UPDATE cf_wplans SET status = 'published', published_at = ?, published_by = ? WHERE company_id = ? AND id = ?", [wall, c.userId ?? null, c.companyId, id]);
  return getWeek(db, c.companyId, { id });
}

/** POST /planning/week/:id/publish — the week's plan is the plan in force; the MD is told (Home). */
export async function publishWeek(db, c, id) {
  const w = await requireWeek(db, c.companyId, id, { lock: true });
  if (w.status !== 'draft') throw invalid('NOT_DRAFT', `This week's plan is ${w.status}.`);
  const { wall } = await plantToday(db, c.companyId);
  await db.query("UPDATE cf_wplans SET status = 'published', published_at = ?, published_by = ? WHERE company_id = ? AND id = ?", [wall, c.userId ?? null, c.companyId, w.id]);
  return getWeek(db, c.companyId, { id: w.id });
}

/** What happened in a week against its plan, as of now: units, hours per machine type, stops, contractors, why. */
export async function weekActual(db, companyId, w) {
  const plan = json(w.result_json) ?? {};
  const week = plan.week ?? { start: dateS(w.week_start), end: dateS(w.week_end), month: dateS(w.week_start).slice(0, 7) };
  const [facts, hrs, contractors] = await Promise.all([
    loadFacts(db, companyId, { month: week.month }),
    hoursBetween(db, companyId, week.start, week.end),
    contractorStanding(db, companyId, { from: week.start, to: week.end }),
  ]);
  const now = new Map(facts.units.map((u) => [u.key, u]));
  const finishing = (plan.finishing ?? []).map((u) => {
    const n = now.get(u.key);
    return { ...u, done: !!n?.done, gone: !n, progress: n ? (n.done ? 1 : n.progress) : null, materialDate: n?.materialDate ?? null, materialState: n?.materialState ?? null };
  });
  const planned = r3(finishing.reduce((t, u) => t + u.tonnes, 0));
  const done = r3(finishing.filter((u) => u.done).reduce((t, u) => t + u.tonnes, 0));
  // Finished though not planned for this week (ahead of the plan): done now, and the plan had it later or not at all.
  const plannedKeys = new Set(finishing.map((u) => u.key));
  const planUnits = new Map((plan.units ?? []).map((u) => [u.key, u]));
  const extra = facts.units.filter((u) => u.done && planUnits.has(u.key) && !plannedKeys.has(u.key)).map((u) => ({ key: u.key, code: u.code, order: planUnits.get(u.key).order, tonnes: u.tonnes, plannedFinish: planUnits.get(u.key).finish }));
  const load = (plan.load ?? []).map((l) => ({
    fn: l.fn, name: l.name, plannedHours: l.hours, runHours: Math.round((hrs.run[l.fn] ?? 0) / 6) / 10, stopHours: Math.round((hrs.stop[l.fn] ?? 0) / 6) / 10,
  }));
  // WHY: one line per cause, with the tonnes it touches.
  const wrong = []; const right = [];
  const oldUnit = (k) => planUnits.get(k);
  for (const u of finishing.filter((x) => !x.done)) {
    const o = oldUnit(u.key);
    let cause = 'Not finished in the week'; let kind = 'behind';
    if (u.gone) { cause = 'The order\'s structure changed — the unit is not in the plan any more'; kind = 'changed'; }
    else if (u.materialDate && o?.materialDate !== u.materialDate && u.materialDate > (o?.start ?? week.start)) { cause = `Material now due ${u.materialDate}${o?.materialDate ? ` (planned on ${o.materialDate})` : ''}`; kind = 'material'; }
    else {
      // The operation that held it: one whose machines stood stopped first, else the one furthest behind its hours.
      const behind = (o?.steps ?? []).map((s) => ({ s, l: load.find((x) => x.fn === s.fn) })).filter((x) => x.l && x.l.plannedHours > 0 && x.l.runHours < x.l.plannedHours * 0.9);
      const worst = behind.filter((x) => x.l.stopHours > 0).sort((a, b) => b.l.stopHours - a.l.stopHours)[0]
        ?? behind.sort((a, b) => (a.l.runHours / a.l.plannedHours) - (b.l.runHours / b.l.plannedHours))[0];
      if (worst && worst.l.stopHours > 0 && worst.l.runHours < worst.l.plannedHours * 0.9) { cause = `${worst.l.name}: ${worst.l.stopHours} h stopped, ${worst.l.runHours} of ${worst.l.plannedHours} planned hours run`; kind = 'machine'; }
      else if (worst && worst.l.runHours < worst.l.plannedHours * 0.9) { cause = `${worst.l.name}: ${worst.l.runHours} of ${worst.l.plannedHours} planned hours run`; kind = 'hours'; }
    }
    wrong.push({ kind, unit: u.code, order: u.order, tonnes: u.tonnes, progress: u.progress, cause });
  }
  for (const c of contractors.orders.filter((x) => x.behind > 0.01 || x.overdue)) wrong.push({ kind: 'contractor', unit: c.code, order: c.productionOrder?.code ?? null, tonnes: c.behind, cause: `${c.contractor.name}: ${c.paid} of ${c.tonnes} t done${c.overdue ? `, due ${c.due}` : ''} — ${c.behind} t behind` });
  for (const s of hrs.stopped.slice(0, 5)) if (!wrong.some((x) => x.kind === 'machine' && x.cause.includes(s.code))) wrong.push({ kind: 'machine', unit: s.code, order: null, tonnes: null, cause: `${s.code} stopped ${s.hours} h${s.reason ? ` (${s.reason})` : ''}` });
  for (const u of finishing.filter((x) => x.done)) right.push({ kind: 'done', unit: u.code, order: u.order, tonnes: u.tonnes, cause: 'Finished as planned' });
  for (const u of extra) right.push({ kind: 'ahead', unit: u.code, order: u.order, tonnes: u.tonnes, cause: `Finished ahead of its plan (${u.plannedFinish ?? 'after the month'})` });
  for (const l of load.filter((x) => x.plannedHours > 0 && x.runHours >= x.plannedHours * 0.98)) right.push({ kind: 'hours', unit: l.name, order: null, tonnes: null, cause: `${l.name} ran ${l.runHours} h against ${l.plannedHours} planned` });
  return {
    week, asOf: facts.today, plannedTonnes: planned, doneTonnes: r3(done + extra.reduce((t, u) => t + u.tonnes, 0)), donePlannedTonnes: done, extraTonnes: r3(extra.reduce((t, u) => t + u.tonnes, 0)),
    units: finishing, extra, load, stops: hrs.stopped.slice(0, 20), contractors: contractors.contractors, workOrders: contractors.orders.filter((x) => x.status !== 'done' || x.paidInRange > 0),
    right, wrong,
  };
}

/** POST /planning/week/:id/close { notes? } — the week is history: what happened is kept with its plan. */
export async function closeWeek(db, c, id, input = {}) {
  const w = await requireWeek(db, c.companyId, id, { lock: true });
  if (w.status === 'closed') throw invalid('CLOSED', 'That week is already closed.');
  const actual = await weekActual(db, c.companyId, w);
  const { wall } = await plantToday(db, c.companyId);
  const review = { right: actual.right, wrong: actual.wrong, notes: blank(input.notes) ? null : String(input.notes).slice(0, 4000) };
  await db.query("UPDATE cf_wplans SET status = 'closed', actual_json = ?, review_json = ?, closed_at = ? WHERE company_id = ? AND id = ?", [JSON.stringify(actual), JSON.stringify(review), wall, c.companyId, w.id]);
  return getWeek(db, c.companyId, { id: w.id });
}

/** PUT /planning/week/:id/notes { notes } — the planner's own words on a week (open or closed). */
export async function setWeekNotes(db, c, id, input = {}) {
  const w = await requireWeek(db, c.companyId, id, { lock: true });
  const review = json(w.review_json) ?? {};
  review.notes = blank(input.notes) ? null : String(input.notes).slice(0, 4000);
  await db.query('UPDATE cf_wplans SET review_json = ? WHERE company_id = ? AND id = ?', [JSON.stringify(review), c.companyId, w.id]);
  return getWeek(db, c.companyId, { id: w.id });
}

/**
 * GET /planning/week?week=YYYY-MM-DD | id= — a week: its plan, and what happened (stored when closed, live otherwise).
 * With neither: this week. `weeks` lists the month's weeks with each one's plan standing.
 */
export async function getWeek(db, companyId, q = {}) {
  const { today } = await plantToday(db, companyId);
  let row = null;
  if (!blank(q.id)) row = await requireWeek(db, companyId, q.id);
  const day = row ? dateS(row.week_start) : !blank(q.week) && DATE_RE.test(String(q.week)) ? String(q.week) : today;
  const week = weekOfDay(day);
  if (!row) { const [[r]] = await db.query('SELECT * FROM cf_wplans WHERE company_id = ? AND week_start = ? AND deleted_at IS NULL', [companyId, week.start]); row = r ?? null; }
  const { first, last } = monthBounds(week.month);
  const [all] = await db.query('SELECT id, week_start, week_end, status, tonnes_week, tonnes_month, actual_json FROM cf_wplans WHERE company_id = ? AND week_start BETWEEN ? AND ? AND deleted_at IS NULL', [companyId, first, last]);
  const byStart = new Map(all.map((r) => [dateS(r.week_start), r]));
  const weeks = weeksOf(week.month).map((x) => {
    const r = byStart.get(x.start);
    const a = r ? json(r.actual_json) : null;
    return { ...x, id: r?.id ?? null, status: r?.status ?? null, tonnesWeek: r?.tonnes_week == null ? null : Number(r.tonnes_week), doneTonnes: a?.doneTonnes ?? null, current: today >= x.start && today <= x.end, past: x.end < today };
  });
  const frozen = await frozenPlan(db, companyId, week.month);
  let plan = null; let actual = null;
  if (row) {
    plan = shapeWeek(row);
    actual = plan.actual ?? (week.start <= today ? await weekActual(db, companyId, row) : null);
  }
  return { today, week, weeks, frozen: frozen ? { id: frozen.id, tonnes: frozen.tonnes, version: frozen.version } : null, frozenWeekTonnes: frozen?.result?.weeks?.find((x) => x.no === week.no)?.tonnes ?? null, plan, actual };
}

/* ── The daily roster ──────────────────────────────────────────────────────────────────────────────── */

/** Tomorrow's work from a fresh plan: one task per unit × machine type with hours that day, each on a machine of the type. */
async function suggestDay(db, companyId, day, { fresh = false } = {}) {
  const week = weekOfDay(day);
  const [[wrow]] = await db.query("SELECT * FROM cf_wplans WHERE company_id = ? AND week_start = ? AND deleted_at IS NULL", [companyId, week.start]);
  const frozen = await frozenPlan(db, companyId, week.month);
  const base = (wrow ? json(wrow.inputs_json) : null) ?? frozen?.inputs ?? {};
  const weekDoc = wrow ? json(wrow.result_json) : null;
  let units; let orders; let machines; let minutesOf;
  // The week's plan already says what runs on each day: the roster is its slice of that day (no search). Only "Suggest
  // again" plans afresh from now — in the worker thread.
  const docHasDay = !!weekDoc?.units?.some((u) => u.steps.some((s) => s.byDay?.[day] > 0));
  if (!fresh && docHasDay) {
    const ids = (base.machineIds ?? []).map(Number);
    machines = (await fabricationMachines(db, companyId)).filter((m) => ids.includes(m.id));
    const { machinesCalendar } = await import('./shiftService.js');
    const cal = machines.length ? await machinesCalendar(db, companyId, { from: day, to: day, machineIds: machines.map((m) => m.id) }) : new Map();
    minutesOf = (id) => Number(cal.get(id)?.days?.[0]?.minutes ?? 0);
    units = weekDoc.units; orders = weekDoc.orders;
  } else {
    const startOrder = weekDoc?.order ?? frozen?.result?.order ?? null;
    const { today } = await plantToday(db, companyId);
    const run = await planMonth(db, companyId, { month: week.month, machineIds: base.machineIds ?? null, ranks: base.ranks ?? null, toleranceDays: base.toleranceDays ?? 3, startOrder, suggest: false, iterations: 150, from: day > today ? day : null });
    machines = run.facts.machines.filter((m) => run.machineIds.includes(m.id));
    const idx = daysBetween(run.facts.from, day);
    minutesOf = (id) => Number(run.facts.calendars.get(id)?.days?.[idx]?.minutes ?? 0);
    units = run.result.units; orders = run.result.orders;
  }
  const left = new Map(machines.map((m) => [m.id, minutesOf(m.id)]));
  const tasks = [];
  const rank = new Map(orders.map((o) => [o.id, o.rank]));
  const todo = [];
  for (const u of units) for (const s of u.steps) { const m = s.byDay[day]; if (m > 0) todo.push({ u, s, minutes: m }); }
  todo.sort((a, b) => (rank.get(a.u.orderId) ?? 99) - (rank.get(b.u.orderId) ?? 99) || String(a.u.finish ?? '9').localeCompare(String(b.u.finish ?? '9')));
  for (const t of todo) {
    let rest = t.minutes;
    const cands = machines.filter((m) => m.typeId === t.s.fn).sort((a, b) => (left.get(b.id) ?? 0) - (left.get(a.id) ?? 0));
    if (!cands.length) { tasks.push(taskOf(t, null, rest, tasks.length)); continue; }
    for (const m of cands) {
      if (rest <= 0.5) break;
      const take = Math.min(rest, left.get(m.id) ?? 0);
      if (take <= 0.5) continue;
      left.set(m.id, (left.get(m.id) ?? 0) - take);
      tasks.push(taskOf(t, m, take, tasks.length));
      rest -= take;
    }
    if (rest > 0.5) tasks.push(taskOf(t, cands[0], rest, tasks.length));
  }
  return {
    day, tasks,
    machines: machines.map((m) => ({ id: m.id, code: m.code, name: m.name, typeId: m.typeId, typeName: m.typeName, area: m.areaName, minutes: minutesOf(m.id), contractor: m.contractor })),
  };
}
const taskOf = (t, m, minutes, n) => ({
  id: `t${n + 1}`, unitKey: t.u.key, unit: t.u.code, order: t.u.order, orderId: t.u.orderId, fn: t.s.fn, fnName: t.s.fnName, minutes: Math.round(minutes),
  machineId: m?.id ?? null, tonnes: t.u.tonnes, finish: t.u.finish, source: 'auto', note: null, done: false,
});

/**
 * GET /planning/day?date= — the roster of a day (default tomorrow): the saved one, else a suggestion (not saved).
 * `fresh` = the suggestion from now, beside a saved roster, so the planner can see what changed.
 */
export async function getDay(db, companyId, q = {}) {
  const { today } = await plantToday(db, companyId);
  const day = !blank(q.date) && DATE_RE.test(String(q.date)) ? String(q.date) : addDays(today, 1);
  const [[row]] = await db.query('SELECT * FROM cf_dplans WHERE company_id = ? AND plan_date = ?', [companyId, day]);
  const sug = row && q.fresh !== '1' ? null : await suggestDay(db, companyId, day, { fresh: q.fresh === '1' });
  const saved = row ? json(row.tasks_json) : null;
  const machines = sug?.machines ?? saved?.machines ?? [];
  return {
    today, day, status: row?.status ?? null, publishedAt: row?.published_at ?? null, note: row?.note ?? null,
    tasks: (q.fresh === '1' ? sug.tasks : saved?.tasks ?? sug.tasks), machines, saved: !!row, suggestion: q.fresh === '1',
  };
}

/** PUT /planning/day { date, tasks, machines?, note?, publish? } — the roster as the planner arranged it; publish = production sees it. */
export async function saveDay(db, c, input = {}) {
  const day = String(input.date ?? '');
  if (!DATE_RE.test(day)) throw invalid('INVALID', 'Which day?');
  const tasks = (Array.isArray(input.tasks) ? input.tasks : []).slice(0, 2000).map((t, i) => ({
    id: String(t.id ?? `t${i + 1}`), unitKey: t.unitKey ?? null, unit: String(t.unit ?? '').slice(0, 200), order: t.order ?? null, orderId: t.orderId ?? null,
    fn: t.fn == null ? null : String(t.fn), fnName: t.fnName ?? null, minutes: Math.max(0, Math.round(Number(t.minutes) || 0)), machineId: t.machineId == null ? null : Number(t.machineId),
    tonnes: t.tonnes ?? null, finish: t.finish ?? null, source: t.source === 'manual' ? 'manual' : 'auto', note: blank(t.note) ? null : String(t.note).slice(0, 300), done: !!t.done,
  }));
  const [[row]] = await db.query('SELECT * FROM cf_dplans WHERE company_id = ? AND plan_date = ? FOR UPDATE', [c.companyId, day]);
  const machines = Array.isArray(input.machines) && input.machines.length ? input.machines : (row ? json(row.tasks_json)?.machines : null) ?? (await suggestDay(db, c.companyId, day)).machines;
  const { wall } = await plantToday(db, c.companyId);
  const doc = JSON.stringify({ tasks, machines });
  const status = input.publish ? 'published' : row?.status ?? 'draft';
  const note = blank(input.note) ? null : String(input.note).slice(0, 1000);
  if (row) {
    await db.query('UPDATE cf_dplans SET tasks_json = ?, status = ?, note = ?, published_at = IF(? = 1, ?, published_at), published_by = IF(? = 1, ?, published_by) WHERE company_id = ? AND id = ?',
      [doc, status, note, input.publish ? 1 : 0, wall, input.publish ? 1 : 0, c.userId ?? null, c.companyId, row.id]);
  } else {
    await db.query('INSERT INTO cf_dplans (company_id, plan_date, status, tasks_json, note, published_at, published_by, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [c.companyId, day, status, doc, note, input.publish ? wall : null, input.publish ? c.userId ?? null : null, c.userId ?? null]);
  }
  return getDay(db, c.companyId, { date: day });
}

/** GET /planning/roster?date= — what production reads: the PUBLISHED roster of a day (default today), by machine. */
export async function publishedRoster(db, companyId, q = {}) {
  const { today } = await plantToday(db, companyId);
  const day = !blank(q.date) && DATE_RE.test(String(q.date)) ? String(q.date) : today;
  const [[row]] = await db.query("SELECT * FROM cf_dplans WHERE company_id = ? AND plan_date = ? AND status = 'published'", [companyId, day]);
  const doc = row ? json(row.tasks_json) : null;
  return { today, day, published: !!row, publishedAt: row?.published_at ?? null, note: row?.note ?? null, tasks: doc?.tasks ?? [], machines: doc?.machines ?? [] };
}

/* ── Alerts ────────────────────────────────────────────────────────────────────────────────────────── */

/** The plan in force for a day: this week's published plan, else the frozen month plan. { doc, inputs, source } or null. */
async function planInForce(db, companyId, today) {
  const week = weekOfDay(today);
  // The id first: the row carries the plan document and is not sorted in SQL.
  const [[head]] = await db.query("SELECT id FROM cf_wplans WHERE company_id = ? AND week_start <= ? AND status IN ('published') AND deleted_at IS NULL ORDER BY week_start DESC LIMIT 1", [companyId, today]);
  const [[w]] = head ? await db.query('SELECT * FROM cf_wplans WHERE id = ?', [head.id]) : [[null]];
  if (w && dateS(w.week_start).slice(0, 7) === week.month) return { doc: json(w.result_json), inputs: json(w.inputs_json), source: `the plan of the week of ${dateS(w.week_start)}`, month: week.month };
  const f = await frozenPlan(db, companyId, week.month);
  return f ? { doc: f.result, inputs: f.inputs, source: `the frozen plan of ${week.month}`, month: week.month } : null;
}

/**
 * What changed against the plan in force. Finds, upserts (one row per thing), and resolves what is no longer true.
 * Returns the open alerts. A plan must be in force; with none there is nothing to compare.
 */
export async function detectAlerts(db, c) {
  const { today, wall } = await plantToday(db, c.companyId);
  const force = await planInForce(db, c.companyId, today);
  if (!force?.doc) return { alerts: await openAlerts(db, c.companyId), source: null };
  const { doc, inputs } = force;
  const facts = await loadFacts(db, c.companyId, { month: force.month });
  const found = [];
  const add = (key, kind, severity, title, detail, extra = {}) => found.push({ key, kind, severity, title, detail, ...extra });
  const planned = new Map((doc.units ?? []).map((u) => [u.key, u]));
  const tonnesOn = (fn) => r3((doc.units ?? []).filter((u) => u.inMonth && u.steps.some((s) => s.fn === fn && s.to >= today)).reduce((t, u) => t + u.tonnes, 0));

  // 1. The machines of the plan: down, switched off, in setup again, out with a contractor.
  const inPlan = new Set((inputs?.machineIds ?? []).map(Number));
  const [faults] = await db.query(
    `SELECT mo.machine_id, mo.code, mo.title, mo.raised_at FROM cf_maintenance_orders mo
      WHERE mo.company_id = ? AND mo.deleted_at IS NULL AND mo.source = 'fault' AND mo.status IN ('open', 'in_progress', 'waiting_parts')`, [c.companyId]).catch(() => [[]]);
  const faultOf = new Map(faults.map((f) => [Number(f.machine_id), f]));
  const byId = new Map(facts.machines.map((m) => [m.id, m]));
  for (const id of inPlan) {
    const m = byId.get(id);
    if (!m) { add(`machine_out:${id}`, 'machine_out', 'danger', 'A machine of the plan is no longer available', 'It was condemned, removed or is no longer a fabrication machine.', { subjectType: 'machine', subjectId: id, link: `machines/${id}` }); continue; }
    const f = faultOf.get(id);
    if (f) add(`machine_down:${id}`, 'machine_down', 'danger', `${m.code} is down`, `${f.code}: ${f.title}. ${m.typeName} — ${tonnesOn(m.typeId)} t of this month's plan still needs this machine type.`, { subjectType: 'machine', subjectId: id, link: `machines/${id}`, impactTonnes: tonnesOn(m.typeId) });
    else if (!m.on) add(`machine_off:${id}`, 'machine_out', 'warning', `${m.code} is in the plan but not switched on`, `${m.name} (${m.typeName}) is ${m.stage !== 'live' ? m.stage : 'inactive'}. Switch it on or plan without it.`, { subjectType: 'machine', subjectId: id, link: `machines/${id}` });
    if (m.contractor) add(`machine_contractor:${id}`, 'machine_out', 'info', `${m.code} is with ${m.contractor.name}`, 'Checked out to a contractor — its hours are theirs while it is out.', { subjectType: 'machine', subjectId: id, link: `machines/${id}` });
  }

  // 2. Material: a date that moved later than the plan assumed (or the unit's planned start).
  // One alert per order and new date (a late purchase order moves many units at once).
  const moved = new Map();
  for (const u of facts.units) {
    const p = planned.get(u.key);
    if (!p || u.done) continue;
    if (u.materialDate && !u.materialAssumed && (p.materialDate ?? '') < u.materialDate && u.materialDate > (p.start ?? today)) {
      const k = `${u.orderId}:${u.materialDate}`;
      const e = moved.get(k) ?? { orderId: u.orderId, order: p.order, date: u.materialDate, was: new Set(), units: 0, tonnes: 0, first: p.start ?? today, text: u.materialText ?? null };
      e.units += 1; if (p.inMonth) e.tonnes += u.tonnes; e.was.add(p.materialDate ?? 'in stock'); if ((p.start ?? today) < e.first) e.first = p.start ?? today;
      moved.set(k, e);
    }
  }
  for (const [k, e] of moved) {
    const slip = Math.max(1, daysBetween(e.first, e.date));
    add(`material:${k}`, 'material_date', e.tonnes > 0 ? 'danger' : 'warning', `Material for ${e.order} now comes ${e.date}`,
      `The plan had it ${[...e.was].map((d) => (d === 'in stock' ? d : `on ${d}`)).join(' / ')}. ${e.units} unit${e.units === 1 ? '' : 's'} start up to ${slip} day${slip === 1 ? '' : 's'} later than planned.${e.text ? ` ${e.text}` : ''} Plan the week again to place them.`,
      { subjectType: 'order', subjectId: e.orderId, link: `orders/${e.orderId}`, impactTonnes: r3(e.tonnes) });
  }
  // 3. Behind the plan: a unit whose planned finish has passed and is not done.
  const late = (doc.units ?? []).filter((p) => p.finish && p.finish < today && p.inMonth).map((p) => ({ p, u: facts.units.find((x) => x.key === p.key) })).filter((x) => x.u && !x.u.done);
  const lateByOrder = new Map();
  for (const x of late) { const e = lateByOrder.get(x.p.orderId) ?? { order: x.p.order, units: 0, tonnes: 0, first: x.p.finish }; e.units += 1; e.tonnes += x.p.tonnes; if (x.p.finish < e.first) e.first = x.p.finish; lateByOrder.set(x.p.orderId, e); }
  for (const [oid, e] of lateByOrder) add(`behind:${oid}`, 'behind_plan', 'warning', `${e.order}: ${e.units} unit${e.units === 1 ? '' : 's'} behind the plan`, `${r3(e.tonnes)} t should have finished by now (the first on ${e.first}).`, { subjectType: 'order', subjectId: oid, link: `orders/${oid}`, impactTonnes: r3(e.tonnes) });
  // 4. Orders: new in planning (not in the plan), or changed (units gone, tonnes moved).
  const planOrders = new Set((doc.orders ?? []).map((o) => o.id));
  for (const o of facts.orders) if (!planOrders.has(o.id)) add(`new_order:${o.id}`, 'new_order', 'info', `${o.code} is in planning but not in the plan`, `${o.tonnes} t in ${o.units} units (${o.productionOrders.join(', ')}). Plan the week again to place it.`, { subjectType: 'order', subjectId: o.id, link: `orders/${o.id}` });
  const nowKeys = new Set(facts.units.map((u) => u.key));
  const gone = new Map();
  for (const p of doc.units ?? []) if (!nowKeys.has(p.key)) gone.set(p.orderId, (gone.get(p.orderId) ?? 0) + 1);
  for (const [oid, n] of gone) {
    const o = (doc.orders ?? []).find((x) => x.id === oid);
    add(`changed:${oid}`, 'order_changed', 'warning', `${o?.code ?? 'An order'} changed after the plan`, `${n} planned unit${n === 1 ? ' is' : 's are'} no longer in its structure (a revision, a BOM change or its production orders went back).`, { subjectType: 'order', subjectId: oid, link: `orders/${oid}` });
  }
  // 5. Contractors behind, and consumables short this week.
  const cs = await contractorStanding(db, c.companyId, {});
  for (const w of cs.orders) {
    if (w.overdue) add(`wo_overdue:${w.id}`, 'contractor_behind', 'danger', `${w.code} (${w.contractor.name}) is past its date`, `Due ${w.due}; ${w.paid} of ${w.tonnes} t done.`, { subjectType: 'work_order', subjectId: w.id, link: 'contractor-work-orders', impactTonnes: r3(w.tonnes - w.paid) });
    else if (w.behind > Math.max(0.5, w.tonnes * 0.1)) add(`wo_behind:${w.id}`, 'contractor_behind', 'warning', `${w.contractor.name} is behind on ${w.code}`, `${w.paid} t done; about ${w.expected} t expected by today on its dates (${w.start} to ${w.due}).`, { subjectType: 'work_order', subjectId: w.id, link: 'contractor-work-orders', impactTonnes: w.behind });
  }
  const week = weekOfDay(today);
  for (const n of await consumableNeeds(db, c.companyId, doc, { from: today, to: week.end })) {
    if (n.short > 0.0005) add(`consumable:${n.itemId}`, 'consumable_short', 'warning', `${n.code ?? n.name} is short for this week's plan`, `Needs ${n.need} ${n.uom ?? ''} from ${n.needBy}; ${n.inStock} in stock${n.onOrder ? `, ${n.onOrder} on order${n.onOrderDue ? ` (due ${n.onOrderDue})` : ''}` : ''}. Short by ${n.short}.`, { subjectType: 'item', subjectId: n.itemId, link: `items/${n.itemId}`, impact: { itemId: n.itemId, qty: n.short, needBy: n.needBy } });
  }

  // Upsert what was found; resolve open ones that were not.
  for (const a of found) {
    await db.query(
      `INSERT INTO cf_plan_alerts (company_id, dedupe_key, kind, severity, title, detail, subject_type, subject_id, link, impact_tonnes, impact_json, status, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)
       ON DUPLICATE KEY UPDATE severity = VALUES(severity), title = VALUES(title), detail = VALUES(detail), link = VALUES(link), impact_tonnes = VALUES(impact_tonnes), impact_json = VALUES(impact_json),
         at = IF(status = 'resolved', VALUES(at), at), closed_at = IF(status = 'resolved', NULL, closed_at), status = IF(status = 'resolved', 'open', status)`,
      [c.companyId, a.key, a.kind, a.severity, String(a.title).slice(0, 255), a.detail ? String(a.detail).slice(0, 1000) : null, a.subjectType ?? null, a.subjectId ?? null, a.link ?? null, a.impactTonnes ?? null, a.impact ? JSON.stringify(a.impact) : null, wall]);
  }
  const keys = found.map((a) => a.key);
  await db.query(`UPDATE cf_plan_alerts SET status = 'resolved', closed_at = ? WHERE company_id = ? AND status = 'open'${keys.length ? ' AND dedupe_key NOT IN (?)' : ''}`, keys.length ? [wall, c.companyId, keys] : [wall, c.companyId]);
  return { alerts: await openAlerts(db, c.companyId), source: force.source };
}

const SEV = { danger: 0, warning: 1, info: 2 };
export async function openAlerts(db, companyId, { all = false } = {}) {
  const [rows] = await db.query(`SELECT * FROM cf_plan_alerts WHERE company_id = ?${all ? '' : " AND status = 'open'"} ORDER BY id DESC LIMIT 300`, [companyId]);
  return rows.map((a) => ({
    id: a.id, kind: a.kind, severity: a.severity, title: a.title, detail: a.detail ?? null, subject: a.subject_type ? { type: a.subject_type, id: a.subject_id } : null, link: a.link ?? null,
    impactTonnes: a.impact_tonnes == null ? null : Number(a.impact_tonnes), impact: json(a.impact_json), status: a.status, at: a.at, closedAt: a.closed_at,
  })).sort((x, y) => (x.status === 'open' ? 0 : 1) - (y.status === 'open' ? 0 : 1) || (SEV[x.severity] ?? 3) - (SEV[y.severity] ?? 3) || (y.impactTonnes ?? 0) - (x.impactTonnes ?? 0));
}

/** POST /planning/alerts/:id/dismiss — seen; it comes back only if the thing happens again after being resolved. */
export async function dismissAlert(db, c, id) {
  const { wall } = await plantToday(db, c.companyId);
  const [r] = await db.query("UPDATE cf_plan_alerts SET status = 'dismissed', closed_at = ?, closed_by = ? WHERE company_id = ? AND id = ? AND status = 'open'", [wall, c.userId ?? null, c.companyId, Number(id)]);
  if (!r.affectedRows) throw notFound('Alert');
  return { ok: true };
}

/* ── The review of a month ─────────────────────────────────────────────────────────────────────────── */

/** GET /planning/review?month= — the frozen plan against what happened, week by week, why, the contractors, what was not taken. */
export async function reviewMonth(db, companyId, q = {}) {
  const { today } = await plantToday(db, companyId);
  const month = blank(q.month) ? today.slice(0, 7) : String(q.month);
  const { first, last } = monthBounds(month);
  const frozen = await frozenPlan(db, companyId, month);
  const [rows] = await db.query('SELECT * FROM cf_wplans WHERE company_id = ? AND week_start BETWEEN ? AND ? AND deleted_at IS NULL', [companyId, first, last]);
  const byStart = new Map(rows.map((r) => [dateS(r.week_start), shapeWeek(r)]));
  const weeks = [];
  for (const w of weeksOf(month)) {
    const p = byStart.get(w.start) ?? null;
    let actual = p?.actual ?? null;
    if (p && !actual && w.start <= today) actual = await weekActual(db, companyId, rows.find((r) => dateS(r.week_start) === w.start));
    weeks.push({
      ...w, status: p?.status ?? null, id: p?.id ?? null, current: today >= w.start && today <= w.end, past: w.end < today,
      frozenTonnes: frozen?.result?.weeks?.find((x) => x.no === w.no)?.tonnes ?? null,
      plannedTonnes: p?.tonnesWeek ?? null, doneTonnes: actual?.doneTonnes ?? null, forecastMonth: p?.tonnesMonth ?? null,
      right: (p?.review?.right ?? actual?.right ?? []).slice(0, 30), wrong: (p?.review?.wrong ?? actual?.wrong ?? []).slice(0, 30), notes: p?.review?.notes ?? null,
      load: actual?.load ?? [],
    });
  }
  // The causes of the month, by kind, with the tonnes they touched.
  const causes = new Map();
  for (const w of weeks) for (const x of w.wrong) { const e = causes.get(x.kind) ?? { kind: x.kind, count: 0, tonnes: 0, examples: [] }; e.count += 1; e.tonnes += Number(x.tonnes ?? 0); if (e.examples.length < 4) e.examples.push(`${x.unit ?? ''}${x.order ? ` (${x.order})` : ''}: ${x.cause}`); causes.set(x.kind, e); }
  const contractors = await contractorStanding(db, companyId, { from: first, to: last });
  const done = r3(weeks.reduce((t, w) => t + Number(w.doneTonnes ?? 0), 0));
  const lastPlan = [...weeks].reverse().find((w) => w.forecastMonth != null);
  return {
    month, today, frozen: frozen ? { id: frozen.id, version: frozen.version, tonnes: frozen.tonnes, boundTonnes: frozen.boundTonnes, frozenAt: frozen.frozenAt, priorityTonnes: frozen.result?.priorityTonnes ?? null, orders: frozen.result?.orders ?? [] } : null,
    doneTonnes: done, forecastTonnes: lastPlan?.forecastMonth ?? null, weeks,
    causes: [...causes.values()].map((e) => ({ ...e, tonnes: r3(e.tonnes) })).sort((a, b) => b.tonnes - a.tonnes || b.count - a.count),
    contractors: contractors.contractors, workOrders: contractors.orders,
    notTaken: (frozen?.result?.suggestions?.options ?? []).filter((o) => !(o.machineIds ?? []).every((id) => (frozen.inputs?.machineIds ?? []).includes(id))),
  };
}

/** GET /planning — the planning home: where the month stands, the week, tomorrow's roster, the alerts. */
export async function planningHome(db, c) {
  const { today } = await plantToday(db, c.companyId);
  const month = today.slice(0, 7);
  const [frozen, week, alerts, [[day]], [[draft]]] = await Promise.all([
    frozenPlan(db, c.companyId, month),
    getWeek(db, c.companyId, {}),
    detectAlerts(db, c).catch(() => ({ alerts: [], source: null })),
    db.query('SELECT plan_date, status FROM cf_dplans WHERE company_id = ? AND plan_date = ?', [c.companyId, addDays(today, 1)]),
    db.query("SELECT id, status, version, tonnes FROM cf_mplans WHERE company_id = ? AND month = ? AND status IN ('draft', 'pending') AND deleted_at IS NULL ORDER BY version DESC LIMIT 1", [c.companyId, `${month}-01`]),
  ]);
  const closed = week.weeks.filter((w) => w.doneTonnes != null);
  const doneTonnes = r3(closed.reduce((t, w) => t + Number(w.doneTonnes), 0) + (week.plan && week.plan.status !== 'closed' ? Number(week.actual?.doneTonnes ?? 0) : 0));
  return {
    today, month,
    monthPlan: frozen ? { id: frozen.id, status: 'frozen', version: frozen.version, tonnes: frozen.tonnes, boundTonnes: frozen.boundTonnes, weeks: frozen.result?.weeks ?? [] } : null,
    working: draft ? { id: draft.id, status: draft.status, version: draft.version, tonnes: Number(draft.tonnes) } : null,
    week: { week: week.week, weeks: week.weeks, plan: week.plan ? { id: week.plan.id, status: week.plan.status, tonnesWeek: week.plan.tonnesWeek, tonnesMonth: week.plan.tonnesMonth } : null, actual: week.actual ? { plannedTonnes: week.actual.plannedTonnes, doneTonnes: week.actual.doneTonnes } : null },
    doneTonnes, forecastTonnes: week.plan?.tonnesMonth ?? null,
    tomorrow: { date: addDays(today, 1), status: day?.status ?? null },
    alerts: alerts.alerts, alertSource: alerts.source,
  };
}
