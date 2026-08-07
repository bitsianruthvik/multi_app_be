/**
 * machineAnalyticsService.js — one honest picture of a machine.
 *
 * Three questions, answered from the same events the Shift Log is written from:
 *
 *   1. Where did this machine's time go?
 *   2. How much steel came off it?
 *   3. How fast is it when it is actually cutting — and how consistent?
 *
 * TIME USE IS NOT RECOMPUTED HERE. It comes straight from `rangeGaps`, the same
 * function the Shift Log renders. That is deliberate: two code paths deriving
 * "utilisation" from the same events WILL drift, and then the analytics page and
 * the page people actually write to disagree about the same day. Whichever one
 * they trust less becomes the one they stop filling in. One derivation, two
 * readers.
 *
 * ── WHAT "REMOVING ALL IDLE TIME" CAN AND CANNOT MEAN ──────────────────────
 *
 * Measured against production on 2026-08-07: there are ZERO wait segments inside
 * any task's run window. The attribution engine explains time BEFORE a task
 * starts; once it starts, nothing is recorded until it stops. So micro-idle
 * inside a run — operator steps away, machine waits for the crane — is not
 * captured anywhere and cannot be subtracted. Claiming otherwise would be
 * inventing precision.
 *
 * What CAN be subtracted from a run window is everything asserted:
 *   · non-working time (nights, non-working days) via the shift calendar
 *   · the machine being down, the site being stopped, the job being on hold
 *   · explicit pause/resume events
 *
 * So `touchMinutes` means "working time inside the run, with known stoppages
 * removed" — an UPPER BOUND on true cutting time, and the throughput derived
 * from it is therefore a LOWER bound. Every payload says which, because a rate
 * whose definition is fuzzy gets quoted as fact within a week.
 *
 * ── TONNAGE ────────────────────────────────────────────────────────────────
 *
 * `fab_project_tasks.produced_qty` is the right source and holds ZERO rows in
 * production — the FEAT-05 capture shipped and nobody uses it. So tonnage falls
 * back to the item's planned qty, and every payload carries `tonnesSource` plus
 * a count of how many runs used which. A number that silently blends "what we
 * made" with "what we meant to make" is worse than no number: it looks like
 * measurement.
 *
 * ── VARIATION, AND WHY n IS ALWAYS RETURNED ────────────────────────────────
 *
 * Spread over one run is not variation, it is a single observation. Production
 * has machines with ONE completed task in 30 days. So every statistic ships with
 * its `n`, and `reliable` is false below MIN_RUNS_FOR_SPREAD — the UI is
 * expected to show the number differently, not to hide it. Suppressing it would
 * just move the guessing somewhere we cannot see.
 *
 * Per FAB_ERP_PEOPLE_PLAN §0: this describes a MACHINE. It is deliberately not
 * cut by operator. The moment a rate can be used against the person who entered
 * it, the entries stop being true and every estimate downstream degrades.
 */

import { pool } from '../../../db.js';
import { rangeGaps } from './gapService.js';
import { resolveCapacityForResource, capacityIntervals } from './capacityService.js';
import { mergeIntervals } from './taskWaitService.js';

/** Below this, report the rate but not a spread. */
export const MIN_RUNS_FOR_SPREAD = 5;

const WEIGHT_METRIC = 'unit_weight_kg';

const minutesOf = (list) => list.reduce((a, x) => a + (x.end - x.start) / 60000, 0);

/** Overlap of two interval lists, in minutes. Both must already be merged. */
function intersectMinutes(a, b) {
  let total = 0;
  for (const x of a) {
    for (const y of b) {
      const s = x.start > y.start ? x.start : y.start;
      const e = x.end < y.end ? x.end : y.end;
      if (e > s) total += (e - s) / 60000;
    }
  }
  return total;
}

function clipToWindow(list, start, end) {
  const out = [];
  for (const x of list) {
    const s = x.start > start ? x.start : start;
    const e = x.end < end ? x.end : end;
    if (e > s) out.push({ start: s, end: e });
  }
  return out;
}

/** Median, p10 and p90 of an already-sorted numeric array. */
function quantile(sorted, p) {
  if (!sorted.length) return null;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/**
 * Stoppages asserted against this machine, as intervals, over a window.
 * Deliberately the same three streams the gap engine reads — machine state,
 * site-wide events, and holds on whatever job was on the machine.
 */
async function assertedStoppages(companyId, resourceId, plantId, start, end) {
  const out = [];

  // Machine state: a `down`/`off` event runs until the next event of any kind.
  const [ev] = await pool.query(
    `SELECT state, at FROM fab_resource_events
      WHERE company_id = ? AND resource_id = ? AND deleted_at IS NULL
        AND superseded_by_event_id IS NULL AND at < ?
      ORDER BY at ASC`,
    [companyId, resourceId, end],
  );
  for (let i = 0; i < ev.length; i++) {
    if (ev[i].state !== 'down' && ev[i].state !== 'off') continue;
    const f = new Date(ev[i].at);
    const t = i + 1 < ev.length ? new Date(ev[i + 1].at) : end;
    if (t > start && f < end) out.push({ start: f, end: t });
  }

  // Site-wide stoppages.
  if (plantId) {
    const [pe] = await pool.query(
      `SELECT from_ts, to_ts FROM fab_plant_events
        WHERE company_id = ? AND plant_id = ? AND deleted_at IS NULL
          AND superseded_by_id IS NULL AND from_ts < ? AND (to_ts IS NULL OR to_ts > ?)`,
      [companyId, plantId, end, start],
    );
    for (const r of pe) out.push({ start: new Date(r.from_ts), end: r.to_ts ? new Date(r.to_ts) : end });
  }

  // Holds on jobs that were on this machine.
  const [th] = await pool.query(
    `SELECT h.from_ts, h.to_ts FROM fab_task_holds h
       JOIN fab_project_tasks t ON t.id = h.task_id
      WHERE h.company_id = ? AND t.assigned_resource_id = ? AND h.deleted_at IS NULL
        AND h.superseded_by_id IS NULL AND h.from_ts < ? AND (h.to_ts IS NULL OR h.to_ts > ?)`,
    [companyId, resourceId, end, start],
  );
  for (const r of th) out.push({ start: new Date(r.from_ts), end: r.to_ts ? new Date(r.to_ts) : end });

  return mergeIntervals(out);
}

/** Explicit pause windows for a task, from its event log. */
function pauseIntervals(events, runEnd) {
  const out = [];
  let open = null;
  for (const e of events) {
    if (e.event_type === 'paused' && !open) open = new Date(e.at);
    else if (e.event_type === 'resumed' && open) { out.push({ start: open, end: new Date(e.at) }); open = null; }
  }
  if (open) out.push({ start: open, end: runEnd });
  return out;
}

/**
 * The runs a machine completed in a window, each with its tonnage and the time
 * it actually had the metal under it.
 */
export async function machineRuns(companyId, resourceId, windowStart, windowEnd) {
  const [tasks] = await pool.query(
    `SELECT t.id, t.item_id, t.operation_id, t.started_at, t.completed_at,
            t.produced_qty, t.scrap_qty, t.qc_result, t.is_rework,
            o.name AS operation_name, i.name AS item_name, i.mark AS item_mark, i.qty AS item_qty,
            mv.metric_value AS unit_weight_kg
       FROM fab_project_tasks t
       LEFT JOIN fab_operations o ON o.id = t.operation_id
       LEFT JOIN fab_items i ON i.id = t.item_id AND i.deleted_at IS NULL
       LEFT JOIN fab_item_metric_values mv
              ON mv.item_id = i.id AND mv.metric_key = ? AND mv.deleted_at IS NULL
      WHERE t.company_id = ? AND t.assigned_resource_id = ? AND t.deleted_at IS NULL
        AND t.status = 'done' AND t.started_at IS NOT NULL AND t.completed_at IS NOT NULL
        AND t.completed_at > ? AND t.completed_at <= ?
      ORDER BY t.completed_at ASC`,
    [WEIGHT_METRIC, companyId, resourceId, windowStart, windowEnd],
  );
  if (!tasks.length) return [];

  const [[res]] = await pool.query(
    'SELECT plant_id AS plantId FROM fab_resources WHERE id = ? AND company_id = ?',
    [resourceId, companyId],
  );
  const plantId = res?.plantId ?? null;
  // Mode-aware: in crew mode the machine's working time IS its crew's presence,
  // so a run outside anybody's shift correctly contributes no touch time.
  const cap = await resolveCapacityForResource(companyId, resourceId, plantId);

  const earliest = new Date(Math.min(...tasks.map((t) => +new Date(t.started_at))));
  const stoppages = await assertedStoppages(companyId, resourceId, plantId, earliest, windowEnd);

  const [allEvents] = await pool.query(
    `SELECT task_id, event_type, at FROM fab_task_events
      WHERE task_id IN (${tasks.map(() => '?').join(',')})
        AND event_type IN ('paused','resumed') AND superseded_by_event_id IS NULL
      ORDER BY at ASC`,
    tasks.map((t) => t.id),
  );
  const eventsByTask = new Map();
  for (const e of allEvents) {
    if (!eventsByTask.has(e.task_id)) eventsByTask.set(e.task_id, []);
    eventsByTask.get(e.task_id).push(e);
  }

  const runs = [];
  for (const t of tasks) {
    const runStart = new Date(t.started_at);
    const runEnd = new Date(t.completed_at);
    // A non-positive run window is a data problem, not a zero-second job.
    // Production has two. Carry them so they can be seen and fixed, but never
    // let them reach a division.
    const elapsedMinutes = Math.round((runEnd - runStart) / 60000);

    let touchMinutes = 0;
    let touchBasis = 'none';
    if (elapsedMinutes > 0) {
      const raw = await capacityIntervals(companyId, cap, runStart, runEnd);
      // No calendar and no crew means no basis for excluding non-working time.
      // Falling back to raw elapsed is the honest read — unbounded capacity —
      // and `touchBasis` says so rather than letting it pass as measured.
      const working = raw.length ? mergeIntervals(raw) : [{ start: runStart, end: runEnd }];
      touchBasis = raw.length ? cap.mode : 'elapsed';
      const workingMinutes = minutesOf(working);
      const paused = mergeIntervals(pauseIntervals(eventsByTask.get(t.id) ?? [], runEnd));
      const blocked = mergeIntervals([
        ...clipToWindow(stoppages, runStart, runEnd),
        ...paused,
      ]);
      touchMinutes = Math.max(0, workingMinutes - intersectMinutes(working, blocked));
    }

    // produced_qty is the truth when captured; the item's qty is the fallback.
    const usedProduced = t.produced_qty != null && Number(t.produced_qty) > 0;
    const qty = usedProduced ? Number(t.produced_qty) : Number(t.item_qty ?? 0);
    const unitWeight = t.unit_weight_kg == null ? null : Number(t.unit_weight_kg);
    const tonnes = unitWeight == null ? null : (qty * unitWeight) / 1000;

    runs.push({
      taskId: t.id,
      itemId: t.item_id,
      itemMark: t.item_mark,
      itemName: t.item_name,
      operationName: t.operation_name,
      startedAt: runStart,
      completedAt: runEnd,
      elapsedMinutes,
      touchMinutes: Math.round(touchMinutes),
      touchBasis,
      qty,
      unitWeightKg: unitWeight,
      tonnes,
      tonnesSource: unitWeight == null ? 'none' : (usedProduced ? 'produced' : 'planned'),
      scrapQty: t.scrap_qty == null ? null : Number(t.scrap_qty),
      qcResult: t.qc_result,
      isRework: !!t.is_rework,
      // Rate only where both sides are real. A 3-minute run of an unweighed item
      // must not enter the distribution as a zero.
      tonnesPerHour: tonnes != null && touchMinutes > 0 ? tonnes / (touchMinutes / 60) : null,
    });
  }
  return runs;
}

/** Mean, median, spread and reliability of a machine's run rates. */
export function throughputStats(runs) {
  const rated = runs.filter((r) => r.tonnesPerHour != null && r.tonnesPerHour > 0);
  const rates = rated.map((r) => r.tonnesPerHour).sort((a, b) => a - b);
  const n = rates.length;

  const totalTonnes = runs.reduce((a, r) => a + (r.tonnes ?? 0), 0);
  const totalTouchHours = runs.reduce((a, r) => a + r.touchMinutes, 0) / 60;

  // The RATE is computed over rated runs only — both sides from the same runs.
  //
  // Dividing all tonnes by all touch hours silently inflates the rate whenever a
  // run has weight but no touch time, which is not hypothetical: a job paused
  // across the whole window contributes its tonnes to the numerator and nothing
  // to the denominator. Measured locally, that turned 1.10 t/h into 1.38.
  const ratedTonnes = rated.reduce((a, r) => a + r.tonnes, 0);
  const ratedTouchHours = rated.reduce((a, r) => a + r.touchMinutes, 0) / 60;

  if (!n) {
    return {
      n: 0, reliable: false,
      totalTonnes, totalTouchHours,
      ratedTonnes: 0, ratedTouchHours: 0,
      overallTonnesPerHour: null,
      meanTonnesPerHour: null, medianTonnesPerHour: null,
      p10: null, p90: null, stdDev: null, coefficientOfVariation: null,
    };
  }

  const mean = rates.reduce((a, x) => a + x, 0) / n;
  // Sample standard deviation — n-1, because these runs are a sample of what the
  // machine does, not the complete population of everything it will ever cut.
  //
  // NULL at n = 1, never 0. A single run has no spread to measure, and a zero
  // there renders as "perfectly consistent" — the exact opposite of the truth,
  // and the reading somebody would take into a capacity decision.
  const stdDev = n > 1
    ? Math.sqrt(rates.reduce((a, x) => a + (x - mean) ** 2, 0) / (n - 1))
    : null;

  return {
    n,
    reliable: n >= MIN_RUNS_FOR_SPREAD,
    totalTonnes,
    totalTouchHours,
    ratedTonnes,
    ratedTouchHours,
    // Weighted by time — what the machine actually averaged, which is not the
    // mean of the per-run rates when runs differ in length.
    overallTonnesPerHour: ratedTouchHours > 0 ? ratedTonnes / ratedTouchHours : null,
    meanTonnesPerHour: mean,
    medianTonnesPerHour: quantile(rates, 0.5),
    p10: quantile(rates, 0.1),
    p90: quantile(rates, 0.9),
    stdDev,
    coefficientOfVariation: stdDev != null && mean > 0 ? stdDev / mean : null,
  };
}

/**
 * Everything about one machine over a date range: where its time went, what came
 * off it, and how fast it runs when it runs.
 */
export async function machinePerformance(companyId, resourceId, fromDate, toDate) {
  const gaps = await rangeGaps(companyId, resourceId, fromDate, toDate);
  if (!gaps) return null;

  // Time use, aggregated from the SAME instances the Shift Log shows.
  const byReason = new Map();
  let runningMinutes = 0;
  for (const inst of gaps.instances) {
    for (const e of inst.explained) {
      const mins = (new Date(e.to) - new Date(e.from)) / 60000;
      if (e.kind === 'work') { runningMinutes += mins; continue; }
      const key = e.code ?? e.kind;
      const cur = byReason.get(key) ?? { code: key, label: e.label, scope: e.kind, minutes: 0 };
      cur.minutes += mins;
      byReason.set(key, cur);
    }
  }
  const stoppages = [...byReason.values()]
    .map((s) => ({ ...s, minutes: Math.round(s.minutes) }))
    .sort((a, b) => b.minutes - a.minutes);

  const windowStart = gaps.instances.length ? gaps.instances[gaps.instances.length - 1].start : null;
  const windowEnd = gaps.instances.length ? gaps.instances[0].end : null;
  const runs = windowStart ? await machineRuns(companyId, resourceId, windowStart, windowEnd) : [];
  const throughput = throughputStats(runs);

  const withWeight = runs.filter((r) => r.tonnes != null).length;
  const fromProduced = runs.filter((r) => r.tonnesSource === 'produced').length;

  return {
    resourceId,
    resourceName: gaps.resourceName,
    from: fromDate,
    to: toDate,
    timezone: gaps.timezone,

    timeUse: {
      // Available = the machine's shift time in the period, clipped to now.
      availableMinutes: gaps.workingMinutes,
      runningMinutes: Math.round(runningMinutes),
      stoppageMinutes: Math.round(gaps.explainedMinutes - runningMinutes),
      unaccountedMinutes: gaps.gapMinutes,
      stoppages,
      shiftCount: gaps.instances.length,
    },

    output: {
      tonnes: throughput.totalTonnes,
      runs: runs.length,
      runsWithWeight: withWeight,
      // The honesty flags. See the header note on tonnage.
      runsMissingWeight: runs.length - withWeight,
      runsFromProducedQty: fromProduced,
      runsFromPlannedQty: withWeight - fromProduced,
      tonnesSource: withWeight === 0 ? 'none' : (fromProduced === withWeight ? 'produced' : (fromProduced === 0 ? 'planned' : 'mixed')),
      scrapQty: runs.reduce((a, r) => a + (r.scrapQty ?? 0), 0),
      reworkRuns: runs.filter((r) => r.isRework).length,
      qcFailRuns: runs.filter((r) => r.qcResult === 'fail').length,
    },

    throughput,
    runsDetail: runs,
  };
}

/**
 * The same figures for every machine, for a fleet table. Sequential rather than
 * parallel: each machine costs several queries and a company can have 43 of
 * them, and hammering the pool to render one page is how the shop floor's
 * task-start call starts timing out.
 */
export async function fleetPerformance(companyId, fromDate, toDate) {
  const [machines] = await pool.query(
    `SELECT id, name, code FROM fab_resources
      WHERE company_id = ? AND deleted_at IS NULL ORDER BY name ASC`,
    [companyId],
  );

  const out = [];
  for (const m of machines) {
    const p = await machinePerformance(companyId, m.id, fromDate, toDate);
    if (!p) continue;
    out.push({
      resourceId: m.id,
      name: m.name,
      code: m.code,
      availableMinutes: p.timeUse.availableMinutes,
      runningMinutes: p.timeUse.runningMinutes,
      stoppageMinutes: p.timeUse.stoppageMinutes,
      unaccountedMinutes: p.timeUse.unaccountedMinutes,
      utilisationPct: p.timeUse.availableMinutes > 0
        ? (p.timeUse.runningMinutes / p.timeUse.availableMinutes) * 100
        : null,
      tonnes: p.output.tonnes,
      tonnesSource: p.output.tonnesSource,
      runs: p.output.runs,
      touchHours: p.throughput.totalTouchHours,
      tonnesPerHour: p.throughput.overallTonnesPerHour,
      medianTonnesPerHour: p.throughput.medianTonnesPerHour,
      coefficientOfVariation: p.throughput.coefficientOfVariation,
      n: p.throughput.n,
      reliable: p.throughput.reliable,
    });
  }
  return out;
}
