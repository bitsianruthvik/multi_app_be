/**
 * dashboardService.js — Production › Dashboard: what management reads at a glance.
 *
 * The user (2026-09-30): "a dashboard for the management to view work done by
 * machines, by orders — two separate tabs … all the details they would want to
 * see in one glance." Two reads, both ONLY read:
 *
 *   machinesDashboard(from, to)  every active machine over a period of plant days:
 *       status now, shift time, run time (in shift / overtime), stops by reason,
 *       time nobody recorded, output (operations, pieces, tonnes, standard hours),
 *       and a day-by-day series for the sparkline.
 *   ordersDashboard(from, to)    every CONFIRMED order: % complete, tonnes made /
 *       dispatched, committed date against a forecast, the operation with most
 *       work left, what is blocked and why, material, and money.
 *
 * HONEST NUMBERS. Everything is either a recorded fact (sessions, stops,
 * movements, step counts) or labelled as an estimate by the field that carries
 * it (`basis`, `estimate: true`, a coverage share). A missing weight or cost is
 * null — "not weighed", "not costed" — never 0.
 *
 * TIME. Sessions, stops and shifts are the plant's wall clock (floorService's
 * rule); they are compared as zone-free numbers (wms). A shift belongs to the
 * day it STARTS, so each plant day OWNS its own shift windows plus the rest of
 * its calendar day that no neighbour's window claims — Friday's night shift
 * that ends Saturday 06:00 is Friday's. Step events are in NOW()'s frame and are
 * compared through UNIX_TIMESTAMP with instants worked out from the plant zone.
 *
 * ROUND TRIPS (prod: ~49 ms each). Neither read loops per machine, per order or
 * per step. machines: the plant zone (cached 60 s) then ONE parallel stage of 9
 * set-based reads. orders: the zone, one parallel stage of 12 reads, then one
 * stage of 3 (free stock and open purchases of the short items, line measures).
 * `meta.queries` / `meta.stages` report it on every call.
 */
import { invalid } from '../lib/errors.js';
import { calendarDays } from './shiftService.js';
import { plantZone, wallOf, epochOfWall } from './floorService.js';
import { availability } from './rollOutService.js';
import { amountOf, kgPerUom } from './priceService.js';

const MIN = 60000;
const DAY_MS = 86400000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const MAX_DAYS = 92;
/** How far back "the current pace" looks. */
export const PACE_DAYS = 14;
const EPS = 1e-6;
const r1 = (n) => Math.round(n * 10) / 10;
const r3 = (n) => Math.round(n * 1000) / 1000;
const mins = (ms) => Math.round(ms / MIN);

// --- plant clock arithmetic (zone-free numbers, as floorService) ----------------------

const wms = (wall) => Date.parse(`${String(wall).replace(' ', 'T').slice(0, 19)}Z`);
const wallText = (n) => new Date(n).toISOString().slice(0, 19).replace('T', ' ');
const dbWall = (d) => (d == null ? null : d instanceof Date ? d.toISOString().slice(0, 19) : String(d).replace(' ', 'T').slice(0, 19));
const dayText = (d) => (d == null ? null : d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));
const addDays = (ds, n) => new Date(Date.parse(`${ds}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);

function union(xs) {
  const s = xs.filter(([a, b]) => b > a).sort((p, q) => p[0] - q[0]);
  const out = [];
  for (const [a, b] of s) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}
const total = (xs) => xs.reduce((t, [a, b]) => t + (b - a), 0);
/** Intersection of two merged, sorted interval lists. */
function intersect(A, B) {
  const out = [];
  let i = 0;
  let j = 0;
  while (i < A.length && j < B.length) {
    const a = Math.max(A[i][0], B[j][0]);
    const b = Math.min(A[i][1], B[j][1]);
    if (b > a) out.push([a, b]);
    if (A[i][1] < B[j][1]) i++; else j++;
  }
  return out;
}
/** A merged list minus another merged list. */
function minus(A, B) {
  const out = [];
  for (const [s, e] of A) {
    let at = s;
    for (const [bs, be] of B) {
      if (be <= at) continue;
      if (bs >= e) break;
      if (bs > at) out.push([at, bs]);
      at = Math.max(at, be);
      if (at >= e) break;
    }
    if (at < e) out.push([at, e]);
  }
  return out;
}

/** from / to as plant dates; default this week (Monday → today). */
export function readPeriod(q = {}, todayS) {
  const blank = (v) => v == null || String(v).trim() === '';
  const valid = (s) => { if (!DATE_RE.test(s)) return false; const t = Date.parse(`${s}T00:00:00Z`); return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === s; };
  const problems = [];
  let from = blank(q.from) ? null : String(q.from).trim();
  let to = blank(q.to) ? null : String(q.to).trim();
  if (from && !valid(from)) problems.push('from needs a date as YYYY-MM-DD.');
  if (to && !valid(to)) problems.push('to needs a date as YYYY-MM-DD.');
  if (problems.length) throw invalid('INVALID', problems[0], { problems });
  if (!from) {
    const wd = (new Date(`${todayS}T00:00:00Z`).getUTCDay() + 6) % 7;   // Monday = 0
    from = addDays(todayS, -wd);
  }
  if (!to) to = from > todayS ? from : todayS;
  const days = daysBetween(from, to) + 1;
  if (days < 1) throw invalid('INVALID', 'to comes before from.');
  if (days > MAX_DAYS) throw invalid('INVALID', `Ask for up to ${MAX_DAYS} days at a time.`);
  return { from, to, days };
}

/** A db whose query() is counted; `stage()` marks a new round of parallel reads. */
function counted(db) {
  const meta = { queries: 0, stages: 0 };
  const profile = process.env.CF_DASH_PROFILE ? (meta.profile = []) : null;
  const run = (t, a) => {
    meta.queries++;
    if (!profile) return t.query(...a);
    const t0 = Date.now();
    return t.query(...a).then((r) => { profile.push({ ms: Date.now() - t0, sql: String(a[0]).replace(/\s+/g, ' ').slice(0, 70) }); return r; });
  };
  const proxy = new Proxy(db, { get: (t, p) => (p === 'query' ? (...a) => run(t, a) : Reflect.get(t, p)) });
  return { db: proxy, meta, stage: () => { meta.stages++; } };
}

/**
 * LEFT JOINs an item's stored item-level WEIGHT (per ONE of it) as w_val / w_uom.
 * Two company placeholders, in this order, where the fragment appears.
 */
const weightJoin = (itemExpr) => `
  LEFT JOIN cf_spec_values wv ON wv.company_id = ? AND wv.subject_type = 'master' AND wv.subject_id = ${itemExpr}
        AND wv.deleted_at IS NULL AND wv.value_number IS NOT NULL
        AND wv.specification_id = (SELECT id FROM cf_specifications WHERE company_id = ? AND code = 'WEIGHT' AND deleted_at IS NULL ORDER BY id LIMIT 1)
  LEFT JOIN cf_specifications wsp ON wsp.id = wv.specification_id`;
const WEIGHT_COLS = 'wv.value_number AS w_val, COALESCE(wv.uom, wsp.default_uom) AS w_uom';
/** kg per ONE from the joined columns, or null ("not weighed"). */
const kgOf = (row) => {
  if (row.w_val == null) return null;
  const f = kgPerUom(row.w_uom ?? 'kg');
  return f == null ? null : Number(row.w_val) * f;
};

/**
 * What production FINISHED (a line's own piece received into stock) and what was
 * DISPATCHED (a line's own item issued out of a dispatch area) on plant days
 * from..to, per day and order line, with its kilograms. Reversed movements are
 * left out. One read.
 */
function periodOutputSql(companyId, from, to) {
  return [
    `SELECT 'made' AS kind, m.movement_date AS d, r.order_line_id AS line_id, SUM(l.quantity) AS qty, ${WEIGHT_COLS}
       FROM cf_stock_ledger l
       JOIN cf_stock_movements m ON m.id = l.movement_id AND m.movement_type = 'receipt' AND m.reversal_of_id IS NULL AND m.reversed_by_id IS NULL
       JOIN cf_stock_batches b ON b.id = l.batch_id AND b.production_item_id IS NOT NULL
       JOIN cf_production_items pi ON pi.id = b.production_item_id AND pi.parent_id IS NULL
       JOIN cf_production_releases r ON r.id = pi.release_id
       ${weightJoin('l.item_id')}
      WHERE l.company_id = ? AND l.quantity > 0 AND m.movement_date BETWEEN ? AND ?
      GROUP BY m.movement_date, r.order_line_id, l.item_id, wv.value_number, wv.uom, wsp.default_uom
     UNION ALL
     SELECT 'shipped', m.movement_date, m.order_line_id, SUM(-l.quantity), ${WEIGHT_COLS}
       FROM cf_stock_ledger l
       JOIN cf_stock_movements m ON m.id = l.movement_id AND m.movement_type = 'issue' AND m.order_line_id IS NOT NULL
                                AND m.reversal_of_id IS NULL AND m.reversed_by_id IS NULL
       JOIN cf_sales_order_lines ol ON ol.id = m.order_line_id AND ol.item_id = l.item_id
       JOIN cf_stocking_areas a ON a.id = l.stocking_area_id AND a.purpose = 'dispatch'
       ${weightJoin('l.item_id')}
      WHERE l.company_id = ? AND l.quantity < 0 AND m.movement_date BETWEEN ? AND ?
      GROUP BY m.movement_date, m.order_line_id, l.item_id, wv.value_number, wv.uom, wsp.default_uom`,
    [companyId, companyId, companyId, from, to, companyId, companyId, companyId, from, to],
  ];
}

/** Today's plant date and the plant wall clock now (zone-free ms). */
function plantNow(tz) {
  const wall = wallOf(Date.now(), tz);
  return { todayS: wall.slice(0, 10), nowW: wms(wall), nowText: wall.replace(' ', 'T') };
}

/* =====================================================================================
 * BY MACHINE
 * ================================================================================== */

/**
 * GET /dashboard/machines?from=&to= — see the file header. Minutes everywhere;
 * `utilisationPct` = run time inside the shifts ÷ shift time so far (breaks of
 * the shift pattern already off it), null for a machine with no shifts.
 */
export async function machinesDashboard(dbIn, companyId, q = {}) {
  const t0 = Date.now();
  const { db, meta, stage } = counted(dbIn);
  stage();
  const tz = await plantZone(db, companyId);
  const { todayS, nowW, nowText } = plantNow(tz);
  const { from, to, days } = readPeriod(q, todayS);

  // Wide enough for the neighbours' night shifts and for "in a shift now".
  const lo = `${addDays(from, -1)} 00:00:00`;
  const hi = `${addDays(to, 2)} 00:00:00`;
  const exA = [addDays(from, -2), addDays(to, 1)];
  const exB = [addDays(todayS, -2), todayS];

  stage();
  const [[machines], [shiftRows], [exRows], [sessions], [stops], [activity], [openSessions], [openStops], [output]] = await Promise.all([
    db.query(
      `SELECT m.id, m.code, m.name, m.classification_id AS type_id, n.name AS type_name
         FROM cf_machines m LEFT JOIN cf_classification_nodes n ON n.id = m.classification_id
        WHERE m.company_id = ? AND m.deleted_at IS NULL AND m.status = 'active' ORDER BY m.code`,
      [companyId],
    ),
    db.query('SELECT * FROM cf_machine_shifts WHERE company_id = ? AND deleted_at IS NULL ORDER BY machine_id, sort_order, start_time, id', [companyId]),
    db.query(
      `SELECT * FROM cf_machine_calendar_exceptions WHERE company_id = ? AND deleted_at IS NULL
          AND (exception_date BETWEEN ? AND ? OR exception_date BETWEEN ? AND ?)`,
      [companyId, ...exA, ...exB],
    ),
    db.query(
      `SELECT ws.id, ws.machine_id, ws.step_id, ws.operator_id, opr.name AS operator_name, ws.started_at, ws.ended_at, ws.end_kind,
              ws.qty_good, ws.qty_scrap, s.est_work_minutes, s.est_setup_minutes, ${WEIGHT_COLS}
         FROM cf_work_sessions ws
         JOIN cf_production_steps s ON s.id = ws.step_id
         JOIN cf_production_items pi ON pi.id = s.production_item_id
         LEFT JOIN cf_operators opr ON opr.id = ws.operator_id
         ${weightJoin('pi.item_id')}
        WHERE ws.company_id = ? AND ws.deleted_at IS NULL AND ws.started_at < ? AND (ws.ended_at IS NULL OR ws.ended_at > ?)`,
      [companyId, companyId, companyId, hi, lo],
    ),
    db.query(
      `SELECT st.id, st.machine_id, st.started_at, st.ended_at, st.reason_id, r.code AS reason_code, r.label AS reason_label
         FROM cf_machine_stops st JOIN cf_stop_reasons r ON r.id = st.reason_id
        WHERE st.company_id = ? AND st.deleted_at IS NULL AND st.started_at < ? AND (st.ended_at IS NULL OR st.ended_at > ?)`,
      [companyId, hi, lo],
    ),
    db.query(
      `SELECT machine_id, MAX(last_at) AS last_at FROM (
         SELECT machine_id, MAX(COALESCE(ended_at, started_at)) AS last_at FROM cf_work_sessions WHERE company_id = ? AND deleted_at IS NULL GROUP BY machine_id
         UNION ALL
         SELECT machine_id, MAX(COALESCE(ended_at, started_at)) FROM cf_machine_stops WHERE company_id = ? AND deleted_at IS NULL GROUP BY machine_id
       ) x GROUP BY machine_id`,
      [companyId, companyId],
    ),
    db.query(
      `SELECT ws.machine_id, ws.started_at, op.name AS op_name, pi.code AS piece_code, o.code AS order_code
         FROM cf_work_sessions ws
         JOIN cf_production_steps s ON s.id = ws.step_id
         JOIN cf_operations op ON op.id = s.operation_id
         JOIN cf_production_items pi ON pi.id = s.production_item_id
         JOIN cf_production_releases r ON r.id = pi.release_id
         JOIN cf_sales_orders o ON o.id = r.order_id
        WHERE ws.company_id = ? AND ws.ended_at IS NULL AND ws.deleted_at IS NULL ORDER BY ws.started_at`,
      [companyId],
    ),
    db.query(
      `SELECT st.machine_id, st.started_at, r.label FROM cf_machine_stops st JOIN cf_stop_reasons r ON r.id = st.reason_id
        WHERE st.company_id = ? AND st.ended_at IS NULL AND st.deleted_at IS NULL`,
      [companyId],
    ),
    db.query(...periodOutputSql(companyId, from, to)),
  ]);

  const group = (rows, key = 'machine_id') => {
    const m = new Map();
    for (const r of rows) { if (!m.has(r[key])) m.set(r[key], []); m.get(r[key]).push(r); }
    return m;
  };
  const shiftsOf = group(shiftRows);
  const exOf = group(exRows);
  const sessionsOf = group(sessions);
  const stopsOf = group(stops);
  const openOf = group(openSessions);
  const stopNow = new Map(openStops.map((s) => [s.machine_id, s]));
  const lastAt = new Map(activity.map((a) => [a.machine_id, dbWall(a.last_at)]));
  const periodDays = Array.from({ length: days }, (_, i) => addDays(from, i));
  const winOf = (w) => [wms(`${w.start}:00`), wms(`${w.end}:00`)];

  const plantReasons = new Map();
  const plantDays = new Map(periodDays.map((d) => [d, { date: d, shift: 0, run: 0, runIn: 0, stop: 0, overtime: 0, tonnes: 0 }]));
  const typeMap = new Map();

  const out = machines.map((m) => {
    if (m.type_id) typeMap.set(m.type_id, m.type_name);
    const shifts = shiftsOf.get(m.id) ?? [];
    const hasShifts = shifts.length > 0;
    const exs = exOf.get(m.id) ?? [];
    // Windows of the period's days and their neighbours, per day.
    const cal = calendarDays(shifts, exs, addDays(from, -1), addDays(to, 1));
    const winByDay = new Map(cal.map((d) => [d.date, d.windows.map((w) => ({ span: winOf(w), minutes: w.minutes }))]));
    const nowCal = calendarDays(shifts, exs, addDays(todayS, -1), todayS);
    const inShiftNow = nowCal.some((d) => d.windows.some((w) => { const [s, e] = winOf(w); return nowW >= s && nowW < e; }));

    const ses = (sessionsOf.get(m.id) ?? []).map((x) => {
      const s = wms(dbWall(x.started_at));
      const e = x.ended_at == null ? Math.max(nowW, s) : wms(dbWall(x.ended_at));
      return { ...x, s, e, open: x.ended_at == null };
    });
    const sts = (stopsOf.get(m.id) ?? []).map((x) => {
      const s = wms(dbWall(x.started_at));
      return { ...x, s, e: x.ended_at == null ? Math.max(nowW, s) : wms(dbWall(x.ended_at)) };
    });
    const sesU = union(ses.map((x) => [x.s, Math.min(x.e, nowW)]));
    const stopU = union(sts.map((x) => [x.s, Math.min(x.e, nowW)]));
    const covU = union([...sesU, ...stopU].map((x) => [...x]));

    const acc = { shift: 0, run: 0, runIn: 0, overtime: 0, stop: 0, stopIn: 0, notRecorded: 0, tonnes: 0, good: 0, scrap: 0, done: 0, earned: 0, qtySessions: 0, estSessions: 0, unweighed: 0 };
    const reasons = new Map();
    const operators = new Map();
    const steps = new Set();
    const series = [];
    for (const d of periodDays) {
      const own = union((winByDay.get(d) ?? []).map((w) => [...w.span]));
      const others = union([...(winByDay.get(addDays(d, -1)) ?? []), ...(winByDay.get(addDays(d, 1)) ?? [])].map((w) => [...w.span]));
      const owned = union([...own, ...minus([[wms(`${d} 00:00:00`), wms(`${addDays(d, 1)} 00:00:00`)]], others)].map((x) => [...x]));
      const past = intersect(owned, [[-Infinity, nowW]]);
      // Shift time so far, net of the pattern's break (in proportion, as the calendar does).
      let shift = 0;
      for (const w of winByDay.get(d) ?? []) {
        const [s, e] = w.span;
        const upTo = Math.min(e, nowW);
        if (upTo > s) shift += w.minutes * ((upTo - s) / (e - s));
      }
      const ownPast = intersect(own, [[-Infinity, nowW]]);
      const run = total(intersect(sesU, past));
      const runIn = Math.min(total(intersect(sesU, ownPast)), shift * MIN);
      const stop = total(intersect(stopU, past));
      const stopIn = total(intersect(stopU, ownPast));
      const coveredIn = total(intersect(covU, ownPast));
      const notRecorded = Math.max(0, shift * MIN - coveredIn);
      const overtime = hasShifts ? Math.max(0, run - total(intersect(sesU, ownPast))) : 0;
      acc.shift += shift * MIN; acc.run += run; acc.runIn += runIn; acc.stop += stop; acc.stopIn += stopIn;
      acc.notRecorded += notRecorded; acc.overtime += overtime;
      // Anything this day owns lies between its midnight and the one after next (a night shift).
      const dLo = wms(`${d} 00:00:00`);
      const dHi = dLo + 2 * DAY_MS;
      for (const x of sts) {
        if (x.e <= dLo || x.s >= dHi) continue;
        const part = total(intersect(union([[x.s, Math.min(x.e, nowW)]]), past));
        if (part <= 0) continue;
        const r = reasons.get(x.reason_id) ?? { id: x.reason_id, code: x.reason_code, label: x.reason_label, minutes: 0, count: 0 };
        r.minutes += part;
        r.count += 1;
        reasons.set(x.reason_id, r);
      }
      let dayTonnes = 0;
      for (const x of ses) {
        if (x.e <= dLo || x.s >= dHi) continue;
        const part = total(intersect(union([[x.s, Math.min(x.e, nowW)]]), past));
        if (part > 0) {
          steps.add(x.step_id);
          if (x.operator_id) {
            const o = operators.get(x.operator_id) ?? { id: x.operator_id, name: x.operator_name, minutes: 0 };
            o.minutes += part;
            operators.set(x.operator_id, o);
          }
        }
        // What a session produced counts on the day that owns its END.
        if (x.open || !owned.some(([a, b]) => x.e > a && x.e <= b)) continue;
        const good = Number(x.qty_good);
        acc.good += good;
        acc.scrap += Number(x.qty_scrap);
        if (x.end_kind === 'done') acc.done += 1;
        if (good > EPS) {
          acc.qtySessions += 1;
          const kg = kgOf(x);
          if (kg == null) acc.unweighed += 1; else dayTonnes += (good * kg) / 1000;
          if (x.est_work_minutes != null) {
            acc.estSessions += 1;
            acc.earned += good * Number(x.est_work_minutes) + (x.end_kind === 'done' ? Number(x.est_setup_minutes ?? 0) : 0);
          }
        }
      }
      acc.tonnes += dayTonnes;
      series.push({ date: d, shift: Math.round(shift), run: mins(run), runIn: mins(runIn), stop: mins(stop), overtime: mins(overtime), tonnes: r3(dayTonnes) });
      const pd = plantDays.get(d);
      pd.shift += shift; pd.run += run / MIN; pd.runIn += runIn / MIN; pd.stop += stop / MIN; pd.overtime += overtime / MIN; pd.tonnes += dayTonnes;
    }
    const reasonList = [...reasons.values()].map((r) => ({ ...r, minutes: mins(r.minutes) })).sort((a, b) => b.minutes - a.minutes);
    for (const r of reasonList) {
      const p = plantReasons.get(r.id) ?? { id: r.id, code: r.code, label: r.label, minutes: 0, count: 0, machines: 0 };
      p.minutes += r.minutes; p.count += r.count; p.machines += 1;
      plantReasons.set(r.id, p);
    }
    const open = openOf.get(m.id) ?? [];
    const st = stopNow.get(m.id);
    const state = open.length ? 'running' : st ? 'stopped' : inShiftNow ? 'idle' : 'off_shift';
    const shiftMin = mins(acc.shift);
    const runInMin = mins(acc.runIn);
    return {
      id: m.id, code: m.code, name: m.name,
      type: m.type_id ? { id: m.type_id, name: m.type_name } : null,
      hasShifts,
      now: {
        state, inShift: inShiftNow,
        running: open.map((x) => ({ operation: x.op_name, pieceCode: x.piece_code, orderCode: x.order_code, since: dbWall(x.started_at) })),
        stop: st ? { reason: st.label, since: dbWall(st.started_at) } : null,
        lastActivityAt: lastAt.get(m.id) ?? null,
      },
      shiftMin,
      runMin: mins(acc.run),
      runInShiftMin: runInMin,
      overtimeMin: hasShifts ? mins(acc.overtime) : null,
      stopMin: mins(acc.stop),
      stopInShiftMin: mins(acc.stopIn),
      notRecordedMin: mins(acc.notRecorded),
      utilisationPct: shiftMin > 0 ? r1((runInMin / shiftMin) * 100) : null,
      output: {
        operationsDone: acc.done,
        stepsWorked: steps.size,
        piecesGood: r3(acc.good),
        piecesScrap: r3(acc.scrap),
        tonnes: acc.qtySessions > acc.unweighed ? r3(acc.tonnes) : (acc.qtySessions ? null : 0),
        unweighedSessions: acc.unweighed,
      },
      standard: {
        earnedMin: Math.round(acc.earned),
        // Share of producing sessions whose step had a time estimate — the rest are not in earnedMin.
        coveragePct: acc.qtySessions ? r1((acc.estSessions / acc.qtySessions) * 100) : null,
        performancePct: acc.run > 0 && acc.estSessions ? r1((acc.earned / (acc.run / MIN)) * 100) : null,
      },
      reasons: reasonList,
      operators: [...operators.values()].map((o) => ({ ...o, minutes: mins(o.minutes) })).sort((a, b) => b.minutes - a.minutes).slice(0, 3),
      days: series,
    };
  });

  const sum = (f) => out.reduce((t, m) => t + (f(m) ?? 0), 0);
  const shiftMin = sum((m) => m.shiftMin);
  const runInShiftMin = sum((m) => m.runInShiftMin);
  const madeKg = { made: 0, shipped: 0, madeUnweighed: 0, shippedUnweighed: 0 };
  for (const r of output) {
    const kg = kgOf(r);
    if (kg == null) madeKg[`${r.kind}Unweighed`] += 1;
    else madeKg[r.kind] += Number(r.qty) * kg;
  }
  const withTonnes = out.filter((m) => m.output.tonnes != null);
  const earned = sum((m) => m.standard.earnedMin);
  const runMin = sum((m) => m.runMin);
  return {
    period: { from, to, days, today: todayS, now: nowText, timezone: tz },
    plant: {
      machines: out.length,
      runningNow: out.filter((m) => m.now.state === 'running').length,
      stoppedNow: out.filter((m) => m.now.state === 'stopped').length,
      idleInShiftNow: out.filter((m) => m.now.state === 'idle').length,
      offShiftNow: out.filter((m) => m.now.state === 'off_shift').length,
      withoutShifts: out.filter((m) => !m.hasShifts).length,
      shiftMin,
      runMin,
      runInShiftMin,
      overtimeMin: sum((m) => m.overtimeMin),
      stopMin: sum((m) => m.stopMin),
      notRecordedMin: sum((m) => m.notRecordedMin),
      utilisationPct: shiftMin > 0 ? r1((runInShiftMin / shiftMin) * 100) : null,
      recordedPct: shiftMin > 0 ? r1(Math.max(0, 100 - (sum((m) => m.notRecordedMin) / shiftMin) * 100)) : null,
      operationsDone: sum((m) => m.output.operationsDone),
      piecesGood: r3(sum((m) => m.output.piecesGood)),
      // A piece counts once at EVERY machine it passes — handled, not made.
      tonnesHandled: withTonnes.length ? r3(withTonnes.reduce((t, m) => t + m.output.tonnes, 0)) : null,
      tonnesFinished: r3(madeKg.made / 1000),
      tonnesDispatched: r3(madeKg.shipped / 1000),
      unweighedMovements: madeKg.madeUnweighed + madeKg.shippedUnweighed,
      earnedMin: earned,
      performancePct: runMin > 0 && earned > 0 ? r1((earned / runMin) * 100) : null,
      topReasons: [...plantReasons.values()].sort((a, b) => b.minutes - a.minutes).slice(0, 5),
      days: [...plantDays.values()].map((d) => ({
        date: d.date, shift: Math.round(d.shift), run: Math.round(d.run), runIn: Math.round(d.runIn), stop: Math.round(d.stop), overtime: Math.round(d.overtime),
        tonnes: r3(d.tonnes), utilisationPct: d.shift > 0 ? r1((d.runIn / d.shift) * 100) : null,
      })),
    },
    types: [...typeMap].map(([id, name]) => ({ id, name })).sort((a, b) => String(a.name).localeCompare(String(b.name))),
    machines: out,
    meta: { ...meta, ms: Date.now() - t0 },
  };
}

/* =====================================================================================
 * BY ORDER
 * ================================================================================== */

export const RISK_ORDER = ['late', 'at_risk', 'no_forecast', 'on_track', 'no_date', 'done'];
/** Below this share of steps with a time estimate, progress counts steps instead of minutes. */
export const MIN_EST_COVERAGE = 0.8;
/** An order due within this many days with no forecast and less than DUE_SOON_PCT done is at risk. */
const DUE_SOON_DAYS = 7;
const DUE_SOON_PCT = 90;
const OPEN_PO = ['ordered', 'partially_received'];

/**
 * Where an order stands against its date. Pure — the test drives it directly.
 * o: { committedDate, pct, delivered (all lines delivered), forecastDate, todayS }
 */
export function riskOf({ committedDate, pct, delivered, forecastDate, todayS }) {
  if (delivered) return { status: 'done', daysLeft: null, slipDays: null, why: 'Everything is dispatched.' };
  if (!committedDate) return { status: 'no_date', daysLeft: null, slipDays: null, why: 'No committed date on the order or its lines.' };
  const daysLeft = daysBetween(todayS, committedDate);
  if (daysLeft < 0) return { status: 'late', daysLeft, slipDays: -daysLeft, why: `Committed for ${committedDate}; ${-daysLeft} day${daysLeft === -1 ? '' : 's'} past it.` };
  if (forecastDate) {
    const slip = daysBetween(committedDate, forecastDate);
    if (slip > 0) return { status: 'at_risk', daysLeft, slipDays: slip, why: `Forecast ${forecastDate} is ${slip} day${slip === 1 ? '' : 's'} after the committed ${committedDate}.` };
    return { status: 'on_track', daysLeft, slipDays: slip, why: `Forecast ${forecastDate}, committed ${committedDate}.` };
  }
  if (daysLeft <= DUE_SOON_DAYS && (pct ?? 0) < DUE_SOON_PCT) {
    return { status: 'at_risk', daysLeft, slipDays: null, why: `Due in ${daysLeft} day${daysLeft === 1 ? '' : 's'} and only ${Math.round(pct ?? 0)}% done, with no forecast yet.` };
  }
  return { status: 'no_forecast', daysLeft, slipDays: null, why: 'No recent progress to measure a pace, and no plan for every line.' };
}

/**
 * A line's progress from its step aggregates (one row per operation). Minutes
 * when enough steps carry a time estimate, else step count; null for an
 * unreleased line with nothing made.
 */
export function lineProgress(ops) {
  if (!ops.length) return null;
  const steps = ops.reduce((t, o) => t + o.steps, 0);
  const withEst = ops.reduce((t, o) => t + o.withEst, 0);
  const estTotal = ops.reduce((t, o) => t + o.estTotal, 0);
  const coverage = steps ? withEst / steps : 0;
  const byWork = coverage >= MIN_EST_COVERAGE && estTotal > EPS;
  const doneShare = byWork ? ops.reduce((t, o) => t + o.estDone, 0) / estTotal : ops.reduce((t, o) => t + o.countDone, 0) / steps;
  return { basis: byWork ? 'work' : 'count', pct: Math.min(100, doneShare * 100), coverage, steps, estTotal, byWork };
}

/**
 * GET /dashboard/orders?from=&to= — see the file header. `withMoney` is false
 * for a reader without orders view: value, invoices and material cost are left out.
 */
export async function ordersDashboard(dbIn, companyId, q = {}, { withMoney = true } = {}) {
  const t0 = Date.now();
  const { db, meta, stage } = counted(dbIn);
  stage();
  const tz = await plantZone(db, companyId);
  const { todayS, nowW, nowText } = plantNow(tz);
  const { from, to, days } = readPeriod(q, todayS);
  // Instants (epoch s) for step events, which live in NOW()'s frame.
  const sec = (wall) => Math.floor(epochOfWall(wall, tz) / 1000);
  const fromSec = sec(`${from} 00:00:00`);
  const toSec = sec(`${addDays(to, 1)} 00:00:00`);
  const paceSec = Math.floor(Date.now() / 1000) - PACE_DAYS * 86400;
  const pFrom = `${from} 00:00:00`;
  const pTo = `${addDays(to, 1)} 00:00:00`;
  const nowWall = wallText(nowW);

  const ORD = "JOIN cf_sales_orders o ON o.id = r.order_id AND o.status = 'confirmed' AND o.deleted_at IS NULL";
  const STEP_BASE = `FROM cf_production_steps s
         JOIN cf_production_items pi ON pi.id = s.production_item_id AND pi.deleted_at IS NULL
         JOIN cf_production_releases r ON r.id = pi.release_id AND r.deleted_at IS NULL
         ${ORD}`;

  stage();
  const [[lines], [stepAgg], [eventAgg], [sessionAgg], [holds], [material], [plan], [output], [invoices], [issued]] = await Promise.all([
    db.query(
      `SELECT o.id AS order_id, o.code, o.revision, o.title, o.order_type, o.committed_date AS order_committed, o.plan_priority,
              o.customer_id, p.name AS customer_name,
              l.id AS line_id, l.line_no, l.item_id, l.quantity, l.made_qty, l.delivered_qty, l.committed_date, l.rate, l.rate_basis,
              mr.code AS item_code, mr.name AS item_name, i.uom,
              (SELECT r.id FROM cf_production_releases r WHERE r.company_id = l.company_id AND r.order_line_id = l.id AND r.deleted_at IS NULL LIMIT 1) AS release_id
         FROM cf_sales_orders o
         JOIN cf_sales_order_lines l ON l.order_id = o.id AND l.deleted_at IS NULL
         LEFT JOIN cf_parties p ON p.id = o.customer_id
         LEFT JOIN cf_master_records mr ON mr.id = l.item_id
         LEFT JOIN cf_item_details i ON i.master_id = l.item_id
        WHERE o.company_id = ? AND o.status = 'confirmed' AND o.deleted_at IS NULL
        ORDER BY o.code, l.line_no`,
      [companyId],
    ),
    db.query(
      // Aggregated from the releases down (release → piece → step by index), and the
      // operation joined on the ~dozen result rows: 3x faster than joining it per step.
      `SELECT x.*, op.code AS op_code, op.name AS op_name FROM (
         SELECT r.order_line_id AS line_id, s.operation_id,
              COUNT(*) AS steps, SUM(s.state = 'done') AS done, SUM(s.state = 'in_progress') AS in_progress, SUM(s.state = 'on_hold') AS on_hold,
              SUM(s.est_minutes IS NOT NULL) AS with_est, SUM(COALESCE(s.est_minutes, 0)) AS est_total,
              SUM(COALESCE(s.est_minutes, 0) * IF(s.state = 'done', 1, LEAST(1, s.qty_good / NULLIF(s.quantity, 0)))) AS est_done,
              SUM(IF(s.state = 'done', 1, LEAST(1, COALESCE(s.qty_good / NULLIF(s.quantity, 0), 0)))) AS count_done,
              AVG(s.sequence) AS seq, SUM(s.work_order_id IS NOT NULL) AS contracted
           FROM cf_production_releases r
           ${ORD}
           JOIN cf_production_items pi ON pi.company_id = r.company_id AND pi.release_id = r.id AND pi.deleted_at IS NULL
           JOIN cf_production_steps s ON s.company_id = pi.company_id AND s.production_item_id = pi.id AND s.deleted_at IS NULL
          WHERE r.company_id = ? AND r.deleted_at IS NULL
          GROUP BY r.order_line_id, s.operation_id) x
       JOIN cf_operations op ON op.id = x.operation_id`,
      [companyId],
    ),
    // Progress recorded in the pace window and in the period, in minutes and in step shares.
    db.query(
      `SELECT r.order_line_id AS line_id,
              SUM(IF(t >= ?, e.qty_good * COALESCE(s.est_minutes, 0) / NULLIF(s.quantity, 0), 0)) AS est_pace,
              SUM(IF(t >= ?, e.qty_good / NULLIF(s.quantity, 0), 0)) AS cnt_pace,
              SUM(IF(t >= ? AND t < ?, e.qty_good * COALESCE(s.est_minutes, 0) / NULLIF(s.quantity, 0), 0)) AS est_period,
              SUM(IF(t >= ? AND t < ?, e.qty_good / NULLIF(s.quantity, 0), 0)) AS cnt_period
         FROM (SELECT step_id, qty_good, UNIX_TIMESTAMP(COALESCE(at, created_at)) AS t FROM cf_step_events
                WHERE company_id = ? AND event = 'progress' AND COALESCE(at, created_at) >= FROM_UNIXTIME(?)) e
         JOIN cf_production_steps s ON s.id = e.step_id
         JOIN cf_production_items pi ON pi.id = s.production_item_id
         JOIN cf_production_releases r ON r.id = pi.release_id AND r.deleted_at IS NULL
         ${ORD}
        GROUP BY r.order_line_id`,
      [paceSec, paceSec, fromSec, toSec, fromSec, toSec, companyId, Math.min(paceSec, fromSec)],
    ),
    // Machine minutes spent on each line within the period (plant calendar days).
    db.query(
      `SELECT r.order_line_id AS line_id,
              SUM(GREATEST(0, TIMESTAMPDIFF(SECOND, GREATEST(ws.started_at, ?), LEAST(COALESCE(ws.ended_at, ?), ?)))) / 60 AS minutes
         FROM cf_work_sessions ws
         JOIN cf_production_steps s ON s.id = ws.step_id
         JOIN cf_production_items pi ON pi.id = s.production_item_id
         JOIN cf_production_releases r ON r.id = pi.release_id AND r.deleted_at IS NULL
         ${ORD}
        WHERE ws.company_id = ? AND ws.deleted_at IS NULL AND ws.started_at < ? AND COALESCE(ws.ended_at, ?) > ?
        GROUP BY r.order_line_id`,
      [pFrom, nowWall, pTo, companyId, pTo, nowWall, pFrom],
    ),
    // Steps on hold, grouped by the note of their latest hold.
    db.query(
      `SELECT r.order_id, COALESCE(NULLIF(TRIM(e.note), ''), 'No reason given') AS reason, COUNT(*) AS n
         ${STEP_BASE}
         LEFT JOIN cf_step_events e ON e.id = (SELECT MAX(e2.id) FROM cf_step_events e2 WHERE e2.company_id = s.company_id AND e2.step_id = s.id AND e2.event = 'hold')
        WHERE s.company_id = ? AND s.deleted_at IS NULL AND s.state = 'on_hold'
        GROUP BY r.order_id, reason`,
      [companyId],
    ),
    // Material per order and item: needed, issued, reserved on a usable batch, and short
    // for steps not done yet (the tracker's own arithmetic: quantity − issued − usable reservation).
    db.query(
      `SELECT r.order_id, q.item_id, mr.code AS item_code, mr.name AS item_name, i.uom,
              COUNT(*) AS reqs, SUM(q.quantity) AS qty, SUM(q.issued) AS issued, SUM(COALESCE(v.usable, 0)) AS reserved,
              SUM(IF(s.id IS NULL OR s.state <> 'done', GREATEST(0, q.quantity - q.issued - COALESCE(v.usable, 0)), 0)) AS short,
              COUNT(DISTINCT IF((s.id IS NULL OR s.state <> 'done') AND q.quantity - q.issued - COALESCE(v.usable, 0) > 0.000001, q.step_id, NULL)) AS short_steps,
              SUM(q.quantity - q.issued <= 0.000001) AS fully_issued
         FROM cf_material_requirements q
         JOIN cf_production_releases r ON r.id = q.release_id AND r.deleted_at IS NULL
         ${ORD}
         JOIN cf_master_records mr ON mr.id = q.item_id
         JOIN cf_item_details i ON i.master_id = q.item_id
         LEFT JOIN cf_production_steps s ON s.id = q.step_id
         LEFT JOIN (SELECT v.requirement_id, SUM(v.quantity) AS usable
                      FROM cf_stock_reservations v LEFT JOIN cf_stock_batches b ON b.id = v.batch_id
                     WHERE v.company_id = ? AND v.status = 'active' AND v.deleted_at IS NULL AND v.requirement_id IS NOT NULL
                       AND (v.batch_id IS NULL OR b.status = 'available')
                     GROUP BY v.requirement_id) v ON v.requirement_id = q.id
        WHERE q.company_id = ? AND q.deleted_at IS NULL
        GROUP BY r.order_id, q.item_id, mr.code, mr.name, i.uom`,
      [companyId, companyId],
    ),
    db.query(
      `SELECT e.order_line_id AS line_id, MAX(e.ship_date) AS last_ship, MIN(e.ship_date) AS first_ship, COUNT(*) AS entries
         FROM cf_plan_entries e
         JOIN cf_sales_order_lines l ON l.id = e.order_line_id AND l.deleted_at IS NULL
         JOIN cf_sales_orders o ON o.id = l.order_id AND o.status = 'confirmed' AND o.deleted_at IS NULL
        WHERE e.company_id = ? AND e.deleted_at IS NULL
        GROUP BY e.order_line_id`,
      [companyId],
    ),
    db.query(...periodOutputSql(companyId, from, to)),
    withMoney ? db.query(
      `SELECT v.order_id, v.status, COUNT(*) AS n, SUM(v.taxable_total) AS taxable, SUM(v.grand_total) AS grand
         FROM cf_invoices v JOIN cf_sales_orders o ON o.id = v.order_id AND o.status = 'confirmed' AND o.deleted_at IS NULL
        WHERE v.company_id = ? AND v.deleted_at IS NULL AND v.status IN ('draft', 'issued')
        GROUP BY v.order_id, v.status`,
      [companyId],
    ) : [[]],
    withMoney ? db.query(
      // Our material issued to the order (a customer's lot costs us nothing; production's own lots leaving are shipments).
      `SELECT m.order_id, SUM(-l.value) AS value, SUM(l.value IS NULL) AS uncosted
         FROM cf_stock_ledger l
         JOIN cf_stock_movements m ON m.id = l.movement_id AND m.movement_type = 'issue' AND m.reversal_of_id IS NULL AND m.reversed_by_id IS NULL
         JOIN cf_sales_orders o ON o.id = m.order_id AND o.status = 'confirmed' AND o.deleted_at IS NULL
         LEFT JOIN cf_stock_batches b ON b.id = l.batch_id
        WHERE l.company_id = ? AND l.quantity < 0 AND b.production_item_id IS NULL AND b.owner_party_id IS NULL
        GROUP BY m.order_id`,
      [companyId],
    ) : [[]],
  ]);

  // Free stock (ours) and open purchases of what is short, and the lines' measures.
  const shortIds = [...new Set(material.filter((mt) => Number(mt.short) > EPS).map((mt) => mt.item_id))];
  const lineItemIds = [...new Set(lines.map((l) => l.item_id).filter((x) => x != null))];
  stage();
  const [free, [poRows], [measureRows]] = await Promise.all([
    availability(db, companyId, shortIds),
    shortIds.length ? db.query(
      `SELECT pl.item_id, SUM(GREATEST(0, pl.quantity - pl.qty_received)) AS open_qty, MIN(COALESCE(pl.expected_date, po.expected_date)) AS first_expected
         FROM cf_purchase_order_lines pl JOIN cf_purchase_orders po ON po.id = pl.purchase_order_id AND po.deleted_at IS NULL AND po.status IN (?)
        WHERE pl.company_id = ? AND pl.deleted_at IS NULL AND pl.item_id IN (?)
        GROUP BY pl.item_id`,
      [OPEN_PO, companyId, shortIds],
    ) : [[]],
    lineItemIds.length ? db.query(
      `SELECT v.subject_id AS item_id, s.code, v.value_number, COALESCE(v.uom, s.default_uom) AS uom
         FROM cf_spec_values v JOIN cf_specifications s ON s.id = v.specification_id AND s.deleted_at IS NULL
        WHERE v.company_id = ? AND v.subject_type = 'master' AND v.subject_id IN (?) AND v.deleted_at IS NULL
          AND v.value_number IS NOT NULL AND s.code IN ('WEIGHT', 'LENGTH')`,
      [companyId, lineItemIds],
    ) : [[]],
  ]);
  const onOrder = new Map(poRows.map((r) => [r.item_id, { qty: Number(r.open_qty), expected: dayText(r.first_expected) }]));
  const M_PER = { m: 1, mtr: 1, metre: 1, meter: 1, mm: 0.001, cm: 0.01, km: 1000 };
  const measure = new Map();
  for (const r of measureRows) {
    const mm = measure.get(r.item_id) ?? { weightKg: null, lengthM: null };
    if (r.code === 'WEIGHT') { const f = kgPerUom(r.uom ?? 'kg'); if (f != null) mm.weightKg = Number(r.value_number) * f; }
    if (r.code === 'LENGTH') { const f = M_PER[String(r.uom ?? '').trim().toLowerCase()]; if (f != null) mm.lengthM = Number(r.value_number) * f; }
    measure.set(r.item_id, mm);
  }

  const by = (rows, key) => { const m = new Map(); for (const r of rows) { if (!m.has(r[key])) m.set(r[key], []); m.get(r[key]).push(r); } return m; };
  const opsOfLine = by(stepAgg.map((r) => ({
    lineId: r.line_id, operationId: r.operation_id, code: r.op_code, name: r.op_name,
    steps: Number(r.steps), done: Number(r.done), inProgress: Number(r.in_progress), onHold: Number(r.on_hold),
    withEst: Number(r.with_est), estTotal: Number(r.est_total), estDone: Number(r.est_done), countDone: Number(r.count_done),
    seq: Number(r.seq), contracted: Number(r.contracted),
  })), 'lineId');
  const eventsOf = new Map(eventAgg.map((r) => [r.line_id, r]));
  const sessionMin = new Map(sessionAgg.map((r) => [r.line_id, Number(r.minutes)]));
  const planOf = new Map(plan.map((r) => [r.line_id, { last: dayText(r.last_ship), first: dayText(r.first_ship), entries: Number(r.entries) }]));
  const holdsOf = by(holds, 'order_id');
  const materialOf = by(material, 'order_id');
  const outputOf = new Map();
  for (const r of output) {
    const e = outputOf.get(r.line_id) ?? { made: 0, shipped: 0 };
    e[r.kind] += Number(r.qty);
    outputOf.set(r.line_id, e);
  }
  const invOf = by(invoices, 'order_id');
  const issuedOf = new Map(issued.map((r) => [r.order_id, r]));

  const orders = [];
  for (const [orderId, ls] of by(lines, 'order_id')) {
    const o = ls[0];
    const lineRows = ls.map((l) => {
      const ops = opsOfLine.get(l.line_id) ?? [];
      const qty = Number(l.quantity);
      const made = Number(l.made_qty);
      const delivered = Number(l.delivered_qty);
      const kgEach = l.item_id != null ? measure.get(l.item_id)?.weightKg ?? null : null;
      const prog = lineProgress(ops);
      // A line with nothing released counts what has been made of it (normally nothing).
      const pct = prog ? prog.pct : qty > EPS ? Math.min(100, (made / qty) * 100) : 0;
      const ev = eventsOf.get(l.line_id);
      // Share of the line gained in the pace window and in the period, on the same basis as pct.
      const gained = (estKey, cntKey) => {
        if (!prog || !ev) return 0;
        return prog.byWork ? (Number(ev[estKey] ?? 0) / prog.estTotal) * 100 : (Number(ev[cntKey] ?? 0) / prog.steps) * 100;
      };
      const out = outputOf.get(l.line_id) ?? { made: 0, shipped: 0 };
      const planned = planOf.get(l.line_id) ?? null;
      const tonnes = kgEach == null ? null : (qty * kgEach) / 1000;
      return {
        id: l.line_id, lineNo: l.line_no,
        item: { id: l.item_id, code: l.item_code, name: l.item_name, uom: l.uom },
        quantity: qty, made, delivered,
        released: !!l.release_id, releaseId: l.release_id ?? null,
        committedDate: dayText(l.committed_date),
        progressPct: r1(pct), basis: prog ? prog.basis : (made > EPS ? 'made' : null),
        // Released with no steps of its own: bought in or taken from stock, nothing to make.
        noSteps: !!l.release_id && !prog,
        estCoveragePct: prog ? r1(prog.coverage * 100) : null,
        stepsTotal: prog ? prog.steps : 0,
        tonnes: tonnes == null ? null : r3(tonnes),
        tonnesMade: kgEach == null ? null : r3((made * kgEach) / 1000),
        tonnesDispatched: kgEach == null ? null : r3((delivered * kgEach) / 1000),
        period: {
          workMin: Math.round(sessionMin.get(l.line_id) ?? 0),
          pctGained: r1(gained('est_period', 'cnt_period')),
          made: r3(out.made), dispatched: r3(out.shipped),
          tonnesMade: kgEach == null ? null : r3((out.made * kgEach) / 1000),
          tonnesDispatched: kgEach == null ? null : r3((out.shipped * kgEach) / 1000),
        },
        pacePctGained: gained('est_pace', 'cnt_pace'),
        plan: planned,
        _ops: ops, _tonnes: tonnes,
        _amount: withMoney && l.item_id != null ? amountOf(l.rate == null ? null : Number(l.rate), l.rate_basis, qty, measure.get(l.item_id) ?? null, l.uom ?? 'nos').amount : null,
        _rated: l.rate != null,
      };
    });

    // The order: each line weighted by its tonnes when every line has a weight, else equally.
    const allWeighed = lineRows.every((l) => l._tonnes != null && l._tonnes > EPS);
    const w = (l) => (allWeighed ? l._tonnes : 1);
    const wSum = lineRows.reduce((t, l) => t + w(l), 0) || 1;
    const pct = lineRows.reduce((t, l) => t + w(l) * l.progressPct, 0) / wSum;
    const pacePct = lineRows.reduce((t, l) => t + w(l) * l.pacePctGained, 0) / wSum;
    const periodPct = lineRows.reduce((t, l) => t + w(l) * l.period.pctGained, 0) / wSum;
    const delivered = lineRows.every((l) => l.delivered + EPS >= l.quantity);
    const perDay = pacePct / PACE_DAYS;
    const paceDate = !delivered && perDay > 0.01 ? addDays(todayS, Math.ceil((100 - pct) / perDay)) : null;
    const planComplete = lineRows.every((l) => l.plan);
    const planDate = planComplete && lineRows.length ? lineRows.reduce((m, l) => (l.plan.last > m ? l.plan.last : m), '') : null;
    // The later of the two: a plan the floor is not keeping up with is not a forecast.
    const forecastDate = [paceDate, planDate].filter(Boolean).sort().at(-1) ?? null;
    const lineDates = lineRows.map((l) => l.committedDate).filter(Boolean).sort();
    const committedDate = dayText(o.order_committed) ?? lineDates[0] ?? null;
    const risk = riskOf({ committedDate, pct, delivered, forecastDate, todayS });

    // Stages: every operation across the order's lines, in flow order.
    const stageMap = new Map();
    const allOps = lineRows.flatMap((l) => l._ops);
    for (const op of allOps) {
      const s = stageMap.get(op.operationId) ?? { operationId: op.operationId, code: op.code, name: op.name, steps: 0, done: 0, inProgress: 0, onHold: 0, estTotal: 0, estDone: 0, withEst: 0, countDone: 0, seqW: 0, contracted: 0 };
      s.steps += op.steps; s.done += op.done; s.inProgress += op.inProgress; s.onHold += op.onHold;
      s.estTotal += op.estTotal; s.estDone += op.estDone; s.withEst += op.withEst; s.countDone += op.countDone;
      s.seqW += op.seq * op.steps; s.contracted += op.contracted;
      stageMap.set(op.operationId, s);
    }
    const stages = [...stageMap.values()].map((s) => ({
      operationId: s.operationId, code: s.code, name: s.name, steps: s.steps, done: s.done, inProgress: s.inProgress, onHold: s.onHold,
      contracted: s.contracted,
      pctDone: r1((s.countDone / s.steps) * 100),
      workMinLeft: s.withEst ? Math.round(s.estTotal - s.estDone) : null,
      _seq: s.seqW / s.steps,
    })).sort((a, b) => a._seq - b._seq || String(a.code).localeCompare(String(b.code))).map(({ _seq, ...s }) => s);
    const open = stages.filter((s) => s.done < s.steps);
    const estKnown = open.length > 0 && open.every((s) => s.workMinLeft != null);
    const workLeft = estKnown ? open.reduce((t, s) => t + s.workMinLeft, 0) : null;
    const neck = [...open].sort((a, b) => (estKnown ? b.workMinLeft - a.workMinLeft : (b.steps - b.done) - (a.steps - a.done)))[0] ?? null;
    const bottleneck = neck ? {
      operationId: neck.operationId, code: neck.code, name: neck.name,
      basis: estKnown ? 'work' : 'count',
      workMinLeft: neck.workMinLeft, stepsLeft: neck.steps - neck.done,
      sharePct: estKnown && workLeft > 0 ? r1((neck.workMinLeft / workLeft) * 100) : r1(((neck.steps - neck.done) / Math.max(1, open.reduce((t, s) => t + s.steps - s.done, 0))) * 100),
    } : null;

    // Material and what is blocked.
    const mats = (materialOf.get(orderId) ?? []).map((mt) => {
      const short = Number(mt.short);
      const freeNow = free.get(mt.item_id)?.free ?? 0;
      const po = onOrder.get(mt.item_id) ?? null;
      const status = short <= EPS ? 'covered' : freeNow + EPS >= short ? 'in_stock' : freeNow + (po?.qty ?? 0) + EPS >= short ? 'on_order' : 'to_buy';
      return {
        itemId: mt.item_id, code: mt.item_code, name: mt.item_name, uom: mt.uom,
        needed: r3(Number(mt.qty)), issued: r3(Number(mt.issued)), reserved: r3(Number(mt.reserved)), short: r3(short),
        shortSteps: Number(mt.short_steps), requirements: Number(mt.reqs), fullyIssued: Number(mt.fully_issued),
        freeNow: r3(freeNow), onOrder: po ? r3(po.qty) : 0, expected: po?.expected ?? null, status,
      };
    });
    const shortMats = mats.filter((mt) => mt.status !== 'covered').sort((a, b) => b.shortSteps - a.shortSteps || b.short - a.short);
    const holdRows = (holdsOf.get(orderId) ?? []).map((h) => ({ reason: h.reason, count: Number(h.n) })).sort((a, b) => b.count - a.count);
    const reqCount = mats.reduce((t, mt) => t + mt.requirements, 0);

    const tonnesKnown = lineRows.every((l) => l.tonnes != null);
    const sumT = (f) => (tonnesKnown ? r3(lineRows.reduce((t, l) => t + (f(l) ?? 0), 0)) : null);
    const inv = invOf.get(orderId) ?? [];
    const issuedRow = issuedOf.get(orderId);
    const amounts = lineRows.map((l) => l._amount);
    const money = withMoney ? {
      value: amounts.some((a) => a != null) ? Math.round(amounts.reduce((t, a) => t + (a ?? 0), 0) * 100) / 100 : null,
      valueComplete: amounts.every((a) => a != null),
      unpricedLines: lineRows.filter((l) => !l._rated).map((l) => l.lineNo),
      invoiced: Math.round(inv.filter((v) => v.status === 'issued').reduce((t, v) => t + Number(v.taxable ?? 0), 0) * 100) / 100,
      invoicedCount: inv.filter((v) => v.status === 'issued').reduce((t, v) => t + Number(v.n), 0),
      draftInvoices: inv.filter((v) => v.status === 'draft').reduce((t, v) => t + Number(v.n), 0),
      materialCost: issuedRow ? Math.round(Number(issuedRow.value ?? 0) * 100) / 100 : 0,
      materialUncostedRows: issuedRow ? Number(issuedRow.uncosted) : 0,
    } : null;

    orders.push({
      id: orderId, code: o.code, revision: o.revision, title: o.title, orderType: o.order_type, planPriority: o.plan_priority,
      customer: o.customer_id ? { id: o.customer_id, name: o.customer_name } : null,
      committedDate,
      progress: {
        pct: r1(pct),
        basis: allWeighed ? 'tonnes' : 'lines',
        lineBasis: lineRows.some((l) => l.basis === 'count') ? 'count' : lineRows.some((l) => l.basis === 'work') ? 'work' : null,
        stepsTotal: lineRows.reduce((t, l) => t + l.stepsTotal, 0),
        workMinLeft: workLeft,
      },
      tonnes: { total: sumT((l) => l.tonnes), made: sumT((l) => l.tonnesMade), dispatched: sumT((l) => l.tonnesDispatched), unweighedLines: lineRows.filter((l) => l.tonnes == null).map((l) => l.lineNo) },
      lines: {
        total: lineRows.length, released: lineRows.filter((l) => l.released).length,
        made: lineRows.filter((l) => l.made + EPS >= l.quantity).length,
        dispatched: lineRows.filter((l) => l.delivered + EPS >= l.quantity).length,
      },
      period: {
        workMin: lineRows.reduce((t, l) => t + l.period.workMin, 0),
        pctGained: r1(periodPct),
        tonnesMade: sumT((l) => l.period.tonnesMade),
        tonnesDispatched: sumT((l) => l.period.tonnesDispatched),
      },
      forecast: {
        date: forecastDate,
        pace: paceDate, pacePctPerWeek: r1(perDay * 7),
        plan: planDate, planComplete, planned: lineRows.filter((l) => l.plan).length,
        estimate: true,
      },
      risk,
      stages,
      bottleneck,
      blocked: {
        onHold: holdRows.reduce((t, h) => t + h.count, 0),
        holdReasons: holdRows.slice(0, 3),
        materialSteps: mats.reduce((t, mt) => t + mt.shortSteps, 0),
      },
      material: {
        requirements: reqCount,
        items: mats.length,
        fullyIssued: mats.reduce((t, mt) => t + mt.fullyIssued, 0),
        covered: mats.filter((mt) => mt.status === 'covered').length,
        inStock: shortMats.filter((mt) => mt.status === 'in_stock').length,
        onOrder: shortMats.filter((mt) => mt.status === 'on_order').length,
        toBuy: shortMats.filter((mt) => mt.status === 'to_buy').length,
        short: shortMats.slice(0, 6),
      },
      money,
      lineRows: lineRows.map(({ _ops, _tonnes, _amount, _rated, pacePctGained, ...l }) => ({ ...l, amount: withMoney ? _amount : undefined })),
    });
  }

  orders.sort((a, b) => RISK_ORDER.indexOf(a.risk.status) - RISK_ORDER.indexOf(b.risk.status)
    || (a.planPriority ?? 1e9) - (b.planPriority ?? 1e9)
    || String(a.committedDate ?? '9999').localeCompare(String(b.committedDate ?? '9999'))
    || String(a.code).localeCompare(String(b.code)));

  const count = (s) => orders.filter((x) => x.risk.status === s).length;
  const tSum = (f) => { const xs = orders.map(f); return xs.every((x) => x != null) ? r3(xs.reduce((t, x) => t + x, 0)) : r3(xs.reduce((t, x) => t + (x ?? 0), 0)); };
  return {
    period: { from, to, days, today: todayS, now: nowText, timezone: tz },
    totals: {
      orders: orders.length,
      lines: orders.reduce((t, x) => t + x.lines.total, 0),
      late: count('late'), atRisk: count('at_risk'), onTrack: count('on_track'), noForecast: count('no_forecast'), noDate: count('no_date'), done: count('done'),
      tonnes: tSum((x) => x.tonnes.total),
      tonnesMade: tSum((x) => x.tonnes.made),
      tonnesDispatched: tSum((x) => x.tonnes.dispatched),
      tonnesComplete: orders.every((x) => x.tonnes.total != null),
      periodTonnesMade: tSum((x) => x.period.tonnesMade),
      periodTonnesDispatched: tSum((x) => x.period.tonnesDispatched),
      onHold: orders.reduce((t, x) => t + x.blocked.onHold, 0),
      materialSteps: orders.reduce((t, x) => t + x.blocked.materialSteps, 0),
      value: withMoney && orders.some((x) => x.money?.value != null) ? Math.round(orders.reduce((t, x) => t + (x.money?.value ?? 0), 0)) : null,
      valueComplete: withMoney ? orders.every((x) => x.money?.valueComplete) : null,
      invoiced: withMoney ? Math.round(orders.reduce((t, x) => t + (x.money?.invoiced ?? 0), 0)) : null,
      materialCost: withMoney ? Math.round(orders.reduce((t, x) => t + (x.money?.materialCost ?? 0), 0)) : null,
    },
    withMoney,
    orders,
    meta: { ...meta, ms: Date.now() - t0 },
  };
}
