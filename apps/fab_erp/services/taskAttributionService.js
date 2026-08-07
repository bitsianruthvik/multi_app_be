/**
 * taskAttributionService.js — EU-3: wait-time attribution engine.
 * -----------------------------------------------------------------
 * Recomputes, for one task, WHY it spent the time it did waiting — carving its
 * wait windows into cause-tagged, non-overlapping fab_task_wait_segments rows,
 * then rolling the totals up onto fab_project_tasks.
 *
 * Two kinds of wait windows are built per task:
 *
 *   (a) PRE-ELIGIBILITY  — created_at → deps_cleared (or now if still blocked).
 *       SLICED BY WHAT WAS OUTSTANDING as of 2026-08-06. The window is cut at
 *       each blocker's clear time (a predecessor's completed_at, an input's
 *       satisfied_at); within a slice the blocking set is constant, so the slice
 *       carries the reason that was true DURING it and names the blocker when
 *       exactly one thing was outstanding. See loadBlockers / sliceByBlocker.
 *
 *       It used to stamp ONE reason over the whole window from the task's state
 *       at recompute time. Measured in production, that was 86.5% of all
 *       attributed waiting (196,345 hours) in a bucket that could not name the
 *       dependency responsible — and worse, a task whose gates had all cleared
 *       matched none of the branches, so its window was skipped entirely: 533
 *       cleared tasks, not one carrying a pre-eligibility segment.
 *
 *       WITH SEVERAL BLOCKERS OUTSTANDING, NO SINGLE ONE IS NAMED. Clearing any
 *       one of them early would not have released the task, so attributing the
 *       wait to one would invent a cause; the label says how many instead.
 *
 *   (b) ELIGIBLE  — deps_cleared → started (or now if not yet started), and
 *   (c) PAUSE GAPS — each paused→resumed pair (trailing paused → now for
 *       non-done tasks).
 *
 * Windows (b) and (c) are the "ready but not progressing" wait; they are sliced
 * by cause with FIRST-MATCH-WINS per sub-interval in the fixed order below.
 * no_shift is carved out FIRST so every other cause only ever competes for
 * genuine in-shift time:
 *
 *     1. no_shift        (window minus working intervals; working_minutes = 0)
 *     -- everything below is classified WITHIN the in-shift intervals only --
 *     2. machine_down    (assigned machine down/off from fab_resource_events)
 *     3. no_operator     (time no assigned worker was present — real intervals
 *                         as of 2026-08-03; was whole dates only, because
 *                         absence used to be a DATE column)
 *     4. machine_busy    (other tasks on the same resource/type)
 *     5. output_blocked  (reserved — produces nothing yet; see TODO below)
 *     6. unexplained_idle (the remainder)
 *
 * Windows (b)/(c) never produce waiting_predecessors/waiting_materials.
 *
 * All interval math is done as continuous [{start:Date,end:Date}] arithmetic
 * (equivalent to, and more precise than, minute-bucket slicing) so the emitted
 * segments exactly tile each window with no overlaps.
 */

import { pool } from '../../../db.js';
import { logger } from '../../../core/utils/logger.js';
import {
  workingIntervalsInWindow,
  fetchOverlappingOtherTasks,
  mergeIntervals,
} from './taskWaitService.js';
import { isOutputBlocked } from './taskGatingService.js';
import { parseDependsOn } from './taskGatingService.js';
import { resolveCapacity, capacityIntervals } from './capacityService.js';
import { reasonCatalogue } from './gapReasons.js';
import { crewForWindow, coveredIntervals } from './workerService.js';

// ─── pure interval helpers (over [{start:Date,end:Date}] lists) ───────────────

function minutesOf(iv) {
  return (iv.end.getTime() - iv.start.getTime()) / 60000;
}

function sumMinutes(list) {
  let m = 0;
  for (const iv of list) m += minutesOf(iv);
  return m;
}

/** Intersection of two interval lists (result is normalized, non-overlapping). */
function intersectIntervals(a, b) {
  const A = mergeIntervals(a);
  const B = mergeIntervals(b);
  const out = [];
  let i = 0;
  let j = 0;
  while (i < A.length && j < B.length) {
    const start = A[i].start > B[j].start ? A[i].start : B[j].start;
    const end = A[i].end < B[j].end ? A[i].end : B[j].end;
    if (end > start) out.push({ start, end });
    if (A[i].end < B[j].end) i++;
    else j++;
  }
  return out;
}

/** `base` minus `cut` (both normalized first); result is non-overlapping. */
function subtractIntervals(base, cut) {
  const B = mergeIntervals(base);
  const C = mergeIntervals(cut);
  const out = [];
  for (const b of B) {
    let curStart = b.start;
    for (const c of C) {
      if (c.end <= curStart) continue;
      if (c.start >= b.end) break;
      if (c.start > curStart) {
        out.push({ start: curStart, end: c.start < b.end ? c.start : b.end });
      }
      if (c.end > curStart) curStart = c.end;
      if (curStart >= b.end) break;
    }
    if (curStart < b.end) out.push({ start: curStart, end: b.end });
  }
  return out.filter((iv) => iv.end > iv.start);
}

/** Build an in-shift-carved segment (its duration IS its working minutes). */
function inShiftSeg(reason, iv) {
  return { reason, start: iv.start, end: iv.end, wm: Math.round(minutesOf(iv)), group: 'active' };
}

// ─── data loaders ─────────────────────────────────────────────────────────────

/**
 * Down/off intervals for a machine, built from its fab_resource_events timeline:
 * events ordered by `at`, a down/off event opens an interval that closes at the
 * next state event (or `now` for the last one). Merged before return.
 */
async function loadMachineDownIntervals(companyId, resourceId, now) {
  const [rows] = await pool.query(
    `SELECT state, at FROM fab_resource_events
      WHERE company_id = ? AND resource_id = ?
        AND superseded_by_event_id IS NULL AND deleted_at IS NULL
      ORDER BY at ASC`,
    [companyId, resourceId],
  );
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].state === 'down' || rows[i].state === 'off') {
      const start = new Date(rows[i].at);
      const end = i + 1 < rows.length ? new Date(rows[i + 1].at) : now;
      if (end > start) out.push({ start, end });
    }
  }
  return mergeIntervals(out);
}

/**
 * Everything that had to happen before this task could start, and when each of
 * them actually happened.
 *
 * Two kinds:
 *   predecessor — a sibling task in the same (item_id, flow_id) at a
 *                 predecessor seq_no. Mirrors processPredecessorsDone exactly:
 *                 explicit `depends_on` when present, else the immediately
 *                 previous seq_no. Clears when that task completed.
 *   input       — a gate = 1 row in fab_task_inputs. Clears at `satisfied_at`.
 *
 * `clearedAt === null` means still outstanding — which, for 3,281 tasks in
 * production, is the answer that matters.
 */
async function loadBlockers(companyId, task) {
  const blockers = [];

  // ── process predecessors ────────────────────────────────────────────────
  const [siblings] = await pool.query(
    `SELECT t.id, t.seq_no AS seqNo, t.status, t.completed_at AS completedAt,
            op.name AS operationName
       FROM fab_project_tasks t
       LEFT JOIN fab_operations op ON op.id = t.operation_id
      WHERE t.company_id = ? AND t.item_id = ? AND t.flow_id = ? AND t.deleted_at IS NULL`,
    [companyId, task.item_id, task.flow_id],
  );
  const deps = parseDependsOn(task.depends_on);
  let predSeqs;
  if (deps.length > 0) {
    predSeqs = deps;
  } else {
    let prev = null;
    for (const s of siblings.map((r) => Number(r.seqNo))) {
      if (s < Number(task.seq_no) && (prev === null || s > prev)) prev = s;
    }
    predSeqs = prev === null ? [] : [prev];
  }
  for (const sn of predSeqs) {
    const p = siblings.find((r) => Number(r.seqNo) === Number(sn));
    if (!p) continue;
    blockers.push({
      type: 'predecessor',
      refId: p.id,
      label: `${p.operationName ?? `Step ${p.seqNo}`} (step ${p.seqNo})`,
      clearedAt: p.status === 'done' && p.completedAt ? new Date(p.completedAt) : null,
    });
  }

  // ── gating material inputs ──────────────────────────────────────────────
  const [inputs] = await pool.query(
    `SELECT ti.id, ti.input_role AS role, ti.satisfied_at AS satisfiedAt,
            COALESCE(ci.name, pi.name, ti.input_role) AS label
       FROM fab_task_inputs ti
       LEFT JOIN fab_item_catalog ci ON ci.id = ti.ref_catalog_item_id
       LEFT JOIN fab_items pi ON pi.id = ti.producing_item_id
      WHERE ti.company_id = ? AND ti.task_id = ? AND ti.gate = 1 AND ti.deleted_at IS NULL`,
    [companyId, task.id],
  );
  for (const i of inputs) {
    blockers.push({
      type: 'input',
      refId: i.id,
      label: i.label ?? 'material',
      clearedAt: i.satisfiedAt ? new Date(i.satisfiedAt) : null,
    });
  }

  return blockers;
}

/**
 * Carve the pre-eligibility window by WHAT WAS OUTSTANDING, instead of stamping
 * one reason over the whole thing.
 *
 * Cut points are the moments the blocking set changes — each blocker's clear
 * time. Within a slice the outstanding set is constant, so:
 *
 *   reason  = waiting_predecessors if any predecessor is outstanding, else
 *             waiting_materials. Predecessors rank first because a task cannot
 *             use material it has nowhere to put yet; the upstream step is the
 *             real constraint while it is unfinished.
 *   blocker = named when exactly ONE thing is outstanding. With several, no
 *             single one is responsible — removing any one changes nothing — so
 *             the label says how many rather than picking a scapegoat.
 *
 * Segments still tile the window with no overlaps; that invariant is what the
 * whole engine rests on.
 */
function sliceByBlocker(windowStart, windowEnd, blockers) {
  const outstandingAt = (t) => blockers.filter((b) => b.clearedAt === null || b.clearedAt > t);

  // Cut wherever something cleared inside the window.
  const cuts = [windowStart, windowEnd];
  for (const b of blockers) {
    if (b.clearedAt && b.clearedAt > windowStart && b.clearedAt < windowEnd) cuts.push(b.clearedAt);
  }
  cuts.sort((a, b) => a - b);

  const out = [];
  for (let i = 0; i < cuts.length - 1; i++) {
    const s = cuts[i];
    const e = cuts[i + 1];
    if (e <= s) continue;
    const live = outstandingAt(s);
    if (live.length === 0) continue;   // nothing was blocking — not a wait

    const preds = live.filter((b) => b.type === 'predecessor');
    const kind = preds.length > 0 ? 'predecessor' : 'input';
    const pool_ = preds.length > 0 ? preds : live;

    out.push({
      start: s,
      end: e,
      reason: kind === 'predecessor' ? 'waiting_predecessors' : 'waiting_materials',
      blockerType: kind,
      // Only name a culprit when there is exactly one. Attributing a wait to one
      // of five simultaneous blockers would invent a cause: clearing it early
      // would not have released the task.
      blockerRefId: pool_.length === 1 ? pool_[0].refId : null,
      blockerLabel: pool_.length === 1
        ? pool_[0].label
        : `${pool_.length} ${kind === 'predecessor' ? 'upstream steps' : 'materials'}`,
    });
  }
  return out;
}

/**
 * Site-wide stoppages covering this machine's plant — rain, a power cut, a
 * shutdown. One `fab_plant_events` row covers every machine at the plant, which
 * is the whole reason the scope exists: entering rain once beats entering it
 * nine times, and a yard that stopped for weather did not stop nine times.
 */
async function loadPlantEventIntervals(companyId, resourceId, windowStart, windowEnd, now) {
  if (!resourceId) return [];
  const [rows] = await pool.query(
    `SELECT pe.from_ts AS fromTs, pe.to_ts AS toTs
       FROM fab_plant_events pe
       JOIN fab_resources r ON r.plant_id = pe.plant_id AND r.id = ?
      WHERE pe.company_id = ? AND pe.deleted_at IS NULL AND pe.superseded_by_id IS NULL
        AND pe.from_ts < ? AND (pe.to_ts IS NULL OR pe.to_ts > ?)`,
    [resourceId, companyId, windowEnd, windowStart],
  );
  return mergeIntervals(rows.map((r) => ({
    start: new Date(r.fromTs), end: r.toTs ? new Date(r.toTs) : now,
  })));
}

/**
 * Holds on THIS task — an inspection, a drawing revision, a customer stop.
 *
 * Returned grouped by the wait reason the hold's code maps to, because
 * `waiting_inspection` and `drawing_hold` are separate causes with very
 * different remedies, and flattening them would lose exactly the distinction
 * that makes the number worth having.
 */
async function loadTaskHoldIntervals(companyId, taskId, windowStart, windowEnd, now, catalogue) {
  const [rows] = await pool.query(
    `SELECT hold_code AS code, from_ts AS fromTs, to_ts AS toTs
       FROM fab_task_holds
      WHERE company_id = ? AND task_id = ? AND deleted_at IS NULL
        AND superseded_by_id IS NULL
        AND from_ts < ? AND (to_ts IS NULL OR to_ts > ?)`,
    [companyId, taskId, windowEnd, windowStart],
  );
  const byReason = new Map();
  for (const r of rows) {
    // An unknown code (a reason deleted after the hold was written) must not
    // silently vanish — it still explains real time, so it lands in the
    // explained bucket rather than falling back to unexplained_idle.
    const reason = catalogue.get(r.code) ?? 'other_explained';
    if (!byReason.has(reason)) byReason.set(reason, []);
    byReason.get(reason).push({
      start: new Date(r.fromTs), end: r.toTs ? new Date(r.toTs) : now,
    });
  }
  for (const [k, v] of byReason) byReason.set(k, mergeIntervals(v));
  return byReason;
}

/**
 * Periods in [windowStart, windowEnd) when this machine had nobody on it.
 *
 * This used to read `fab_resource_operators` and could only produce WHOLE DATES
 * — "every standing operator has an absent_on row for this day" — because
 * absence was a DATE column. An afternoon with nobody on the machine was
 * therefore invisible to attribution, and a half-day of idle time got
 * classified as `unexplained_idle` instead of the real cause.
 *
 * It now derives from `fab_worker_assignments` intervals (workerService
 * .coveredIntervals): no_operator is simply the window minus the time at least
 * one assigned worker was present and not away.
 *
 * IMPORTANT SAFETY PROPERTY, PRESERVED FROM THE OLD RULE: a machine with no
 * crew assigned at all yields NO no_operator intervals. Absence of a roster
 * means we don't know who was there, not that nobody was — and claiming
 * otherwise would reclassify the entire history of every machine that hasn't
 * been rostered yet, which is most of them.
 */
async function loadNoOperatorIntervals(companyId, resourceId, windowStart, windowEnd) {
  const crew = await crewForWindow(pool, companyId, resourceId, windowStart, windowEnd);
  if (crew.length === 0) return [];

  const covered = await coveredIntervals(pool, companyId, resourceId, windowStart, windowEnd);
  return mergeIntervals(subtractIntervals([{ start: windowStart, end: windowEnd }], covered));
}

// ─── public API ───────────────────────────────────────────────────────────────

/**
 * Recompute and persist wait attribution for a single task.
 * Rewrites all of the task's fab_task_wait_segments and updates the three
 * rollup columns on fab_project_tasks in one transaction.
 *
 * @returns {Promise<{ok:boolean, taskId?:number, segments?:number, reason?:string}>}
 */
export async function recomputeTaskAttribution(companyId, taskId, now = new Date()) {
  const [taskRows] = await pool.query(
    `SELECT id, company_id, item_id, flow_id, seq_no, depends_on,
            resource_type_id, assigned_resource_id, status,
            created_at, deps_cleared_at, started_at, paused_at, completed_at
       FROM fab_project_tasks
      WHERE id = ? AND company_id = ? AND deleted_at IS NULL
      LIMIT 1`,
    [taskId, companyId],
  );
  if (taskRows.length === 0) return { ok: false, reason: 'not_found' };
  const task = taskRows[0];

  const [events] = await pool.query(
    `SELECT event_type, at FROM fab_task_events
      WHERE company_id = ? AND task_id = ?
        AND superseded_by_event_id IS NULL AND deleted_at IS NULL
      ORDER BY at ASC`,
    [companyId, taskId],
  );
  const firstEventAt = (type) => {
    const e = events.find((ev) => ev.event_type === type);
    return e ? new Date(e.at) : null;
  };

  const createdAt = task.created_at ? new Date(task.created_at) : null;
  const depsClearedAt = firstEventAt('deps_cleared')
    || (task.deps_cleared_at ? new Date(task.deps_cleared_at) : null);
  const startedAt = firstEventAt('started')
    || (task.started_at ? new Date(task.started_at) : null);
  const completedAt = task.completed_at ? new Date(task.completed_at) : null;
  const isDone = task.status === 'done' || task.status === 'cancelled';

  // Capacity source resolved once. Under crew mode this is the union of the
  // machine's crew shifts; under calendar mode it is the machine/plant calendar,
  // exactly as before. Either way no_shift is carved from it FIRST, so no_operator
  // keeps competing only for genuine in-shift time (FAB_ERP_PEOPLE_PLAN.md §8).
  const cap = await resolveCapacity(companyId, task);

  const segments = []; // { reason, start, end, wm, group:'pre'|'active' }

  // ── window (a): pre-eligibility, SLICED BY WHAT WAS OUTSTANDING ─────────────
  //
  // This used to stamp ONE reason over the whole window, chosen from the task's
  // state at recompute time. Two consequences, both measured in production:
  //
  //   * it is 86.5% of all attributed waiting (196,345 hours) in a single
  //     bucket that cannot name the dependency responsible, and
  //   * a task whose gates had all cleared matched none of the branches, so the
  //     window was skipped entirely — 533 cleared tasks, not one carrying a
  //     pre-eligibility segment.
  //
  // Now the window is cut wherever the blocking set changes, each slice carries
  // the reason that was true DURING it, and the blocker is named when exactly
  // one thing was outstanding.
  if (createdAt) {
    // Ends when the task became eligible; for one still blocked, it is still
    // running, and that open-ended slice is the actionable one — it says what is
    // holding the task right now and for how long it has been doing so.
    const aTo = depsClearedAt || (isDone ? null : now);
    if (aTo && aTo > createdAt) {
      const blockers = await loadBlockers(companyId, task);
      for (const slice of sliceByBlocker(createdAt, aTo, blockers)) {
        const inShift = await capacityIntervals(companyId, cap, slice.start, slice.end);
        segments.push({
          reason: slice.reason,
          start: slice.start,
          end: slice.end,
          wm: Math.round(sumMinutes(inShift)),
          group: 'pre',
          blockerType: slice.blockerType,
          blockerRefId: slice.blockerRefId,
          blockerLabel: slice.blockerLabel,
        });
      }
    }
  }

  // ── windows (b) eligible + (c) pause gaps ───────────────────────────────────
  const activeWindows = [];
  if (depsClearedAt) {
    const bEnd = startedAt || (isDone ? (completedAt || now) : now);
    if (bEnd > depsClearedAt) activeWindows.push({ start: depsClearedAt, end: bEnd });
  }
  let pauseStart = null;
  for (const ev of events) {
    if (ev.event_type === 'paused') {
      if (!pauseStart) pauseStart = new Date(ev.at);
    } else if (ev.event_type === 'resumed') {
      if (pauseStart) {
        const e = new Date(ev.at);
        if (e > pauseStart) activeWindows.push({ start: pauseStart, end: e });
        pauseStart = null;
      }
    }
  }
  if (pauseStart && !isDone && now > pauseStart) {
    activeWindows.push({ start: pauseStart, end: now });
  }

  if (activeWindows.length > 0) {
    const spanStart = activeWindows.reduce((m, w) => (w.start < m ? w.start : m), activeWindows[0].start);
    const spanEnd = activeWindows.reduce((m, w) => (w.end > m ? w.end : m), activeWindows[0].end);

    let machineDown = [];
    let noOperator = [];
    let plantStopped = [];
    if (task.assigned_resource_id) {
      machineDown = await loadMachineDownIntervals(companyId, task.assigned_resource_id, now);
      noOperator = await loadNoOperatorIntervals(companyId, task.assigned_resource_id, spanStart, spanEnd);
      plantStopped = await loadPlantEventIntervals(companyId, task.assigned_resource_id, spanStart, spanEnd, now);
    }

    // Holds follow the JOB, not the machine — an inspection applies wherever the
    // piece is sitting — so this is loaded regardless of resource assignment.
    // The catalogue maps each site's own hold codes onto the wait reasons the
    // engine understands.
    const reasonMap = new Map(
      (await reasonCatalogue(companyId)).map((r) => [r.code, r.waitReason]),
    );
    const holds = await loadTaskHoldIntervals(companyId, taskId, spanStart, spanEnd, now, reasonMap);
    const machineBusy = mergeIntervals(
      await fetchOverlappingOtherTasks(companyId, task, spanStart, spanEnd, now),
    );

    // EU-8 output_blocked. Buffer levels are not historically reconstructable —
    // a buffer's load is derived from the WIP pieces standing at a machine's
    // stock area right now, and a piece records where it IS, not where it was
    // at 14:20 last Tuesday — so we cannot know WHEN in the past a task was
    // output-blocked.
    // SIMPLIFICATION: we classify only the task's still-open idle tail (in-shift
    // remainder running up to `now`) as output_blocked, and only when the task
    // is output-blocked RIGHT NOW. All historical/closed idle stays
    // unexplained_idle. Defensible: the live block explains the current stall.
    const blockedNow = (await isOutputBlocked(companyId, task)).blocked;

    for (const w of activeWindows) {
      const win = [{ start: w.start, end: w.end }];
      const inShift = await capacityIntervals(companyId, cap, w.start, w.end);

      // 1. no_shift first — out-of-shift time (working_minutes = 0).
      for (const iv of subtractIntervals(win, inShift)) {
        segments.push({ reason: 'no_shift', start: iv.start, end: iv.end, wm: 0, group: 'active' });
      }

      let remaining = inShift;

      // ── ASSERTED CAUSES FIRST (2-6) ────────────────────────────────────────
      // Somebody with knowledge said this is what happened; everything below is
      // the engine inferring from absence of evidence.
      //
      // This ordering is load-bearing. A girder waiting on a client inspector
      // ALSO has no operator standing at it and its machine ALSO looks free.
      // All three are true, but only the inspection is the binding constraint —
      // no amount of staffing fixes it. Ranking `no_operator` above it would
      // blame your own people for the client's delay, which is precisely the
      // misreading this whole mechanism exists to prevent.
      const carve = (reason, source) => {
        const hit = intersectIntervals(remaining, source);
        for (const iv of hit) segments.push(inShiftSeg(reason, iv));
        remaining = subtractIntervals(remaining, hit);
      };

      carve('weather', plantStopped);              // 2. site-scope, asserted
      carve('machine_down', machineDown);          // 3. machine-scope, asserted
      carve('waiting_inspection', holds.get('waiting_inspection') ?? []);  // 4.
      carve('drawing_hold', holds.get('drawing_hold') ?? []);              // 5.
      carve('other_explained', holds.get('other_explained') ?? []);        // 6.

      // ── DERIVED CAUSES (7-9) ───────────────────────────────────────────────
      carve('no_operator', noOperator);            // 7.
      carve('machine_busy', machineBusy);          // 8.
      // 9. output_blocked — only the still-open tail (interval ending at `now`)
      //    when the task is output-blocked right now (see SIMPLIFICATION above).
      //    Everything else remains unexplained_idle.
      // 10. unexplained_idle — whatever in-shift time is left. This is the
      //     number the gap-capture mechanism exists to drive down.
      for (const iv of remaining) {
        const openTail = blockedNow && iv.end.getTime() === now.getTime();
        segments.push(inShiftSeg(openTail ? 'output_blocked' : 'unexplained_idle', iv));
      }
    }
  }

  // ── coalesce adjacent same-reason segments; drop zero-length ────────────────
  segments.sort((a, b) => (a.start - b.start) || (a.reason < b.reason ? -1 : 1));
  const merged = [];
  for (const s of segments) {
    if (s.end <= s.start) continue;
    const last = merged[merged.length - 1];
    // Blocker must match too. Two adjacent slices with the same reason but
    // different blockers are the whole point of the change; merging them would
    // quietly rebuild the undiagnosable lump.
    if (last && last.reason === s.reason && last.group === s.group
        && last.blockerRefId === s.blockerRefId && last.blockerLabel === s.blockerLabel
        && s.start <= last.end) {
      if (s.end > last.end) last.end = s.end;
      last.wm += s.wm;
    } else {
      merged.push({ ...s });
    }
  }

  // ── persist + rollup in one transaction ─────────────────────────────────────
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query(
      `DELETE FROM fab_task_wait_segments WHERE company_id = ? AND task_id = ?`,
      [companyId, taskId],
    );
    if (merged.length > 0) {
      const rows = merged.map((s) => [
        companyId, taskId, s.reason, s.start, s.end, s.wm, now,
        s.blockerType ?? null, s.blockerRefId ?? null, s.blockerLabel ?? null,
      ]);
      await conn.query(
        `INSERT INTO fab_task_wait_segments
           (company_id, task_id, reason, seg_start, seg_end, working_minutes, computed_at,
            blocker_type, blocker_ref_id, blocker_label)
         VALUES ?`,
        [rows],
      );
    }

    const waitWorking = merged.filter((s) => s.group === 'active').reduce((a, s) => a + s.wm, 0);
    const blocked = merged.filter((s) => s.reason === 'machine_busy').reduce((a, s) => a + s.wm, 0);
    const idle = merged.filter((s) => s.reason === 'unexplained_idle').reduce((a, s) => a + s.wm, 0);
    await conn.query(
      `UPDATE fab_project_tasks
          SET wait_working_minutes = ?,
              blocked_by_other_tasks_minutes = ?,
              idle_wait_minutes = ?
        WHERE id = ? AND company_id = ? AND deleted_at IS NULL`,
      [waitWorking, blocked, idle, taskId, companyId],
    );

    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }

  return { ok: true, taskId, segments: merged.length };
}

/**
 * Recompute every still-waiting task (status eligible/blocked/paused) assigned
 * to a given resource — used after a machine state change flips the picture.
 */
export async function recomputeForResource(companyId, resourceId, now = new Date()) {
  const [rows] = await pool.query(
    `SELECT id FROM fab_project_tasks
      WHERE company_id = ? AND assigned_resource_id = ? AND deleted_at IS NULL
        AND status IN ('eligible','blocked','paused')`,
    [companyId, resourceId],
  );
  let recomputed = 0;
  for (const r of rows) {
    try {
      await recomputeTaskAttribution(companyId, r.id, now);
      recomputed++;
    } catch (err) {
      logger.error({ err, companyId, resourceId, taskId: r.id }, 'recomputeForResource: task failed');
    }
  }
  return { ok: true, recomputed };
}

/**
 * Recompute every task on a resource whose lifetime OVERLAPS a past window —
 * including tasks that are already `done`.
 *
 * `recomputeForResource` above deliberately only touches still-waiting tasks,
 * because a live machine-state flip can only change the picture for work that
 * hasn't finished. Backdating is the opposite case: entering "Ramesh was on
 * Press-2 last Tuesday 14:00–18:00" changes what `no_operator` should have been
 * for tasks that ran and completed last Tuesday. Those tasks are `done`, so the
 * status filter above skips them entirely and their segments stay stale forever
 * — which is what made backdated roster entry worthless before this existed.
 *
 * `limit` is a real cap, not a formality: a wide backdated correction can touch
 * thousands of tasks and this runs inline. When it truncates it says so rather
 * than reporting a clean success over a partial recompute.
 */
export async function recomputeForResourceWindow(
  companyId, resourceId, windowStart, windowEnd, { limit = 500, now = new Date() } = {},
) {
  const [rows] = await pool.query(
    `SELECT id FROM fab_project_tasks
      WHERE company_id = ? AND assigned_resource_id = ? AND deleted_at IS NULL
        AND (completed_at IS NULL OR completed_at > ?)
        AND created_at < ?
      ORDER BY created_at ASC
      LIMIT ?`,
    [companyId, resourceId, windowStart, windowEnd, Number(limit) + 1],
  );

  const truncated = rows.length > limit;
  const batch = truncated ? rows.slice(0, limit) : rows;
  if (truncated) {
    logger.warn(
      { companyId, resourceId, windowStart, windowEnd, limit },
      'recomputeForResourceWindow: more tasks overlap the window than the limit — attribution is only partially recomputed',
    );
  }

  let recomputed = 0;
  for (const r of batch) {
    try {
      await recomputeTaskAttribution(companyId, r.id, now);
      recomputed++;
    } catch (err) {
      logger.error({ err, companyId, resourceId, taskId: r.id }, 'recomputeForResourceWindow: task failed');
    }
  }
  return { ok: true, recomputed, truncated };
}

/**
 * Recompute up to `limit` waiting tasks for one company, prioritizing those
 * whose attribution is stalest (never computed first, then oldest computed_at).
 */
export async function sweepCompany(companyId, { limit = 500 } = {}) {
  const [rows] = await pool.query(
    `SELECT t.id
       FROM fab_project_tasks t
       LEFT JOIN fab_task_wait_segments s
              ON s.company_id = t.company_id AND s.task_id = t.id AND s.deleted_at IS NULL
      WHERE t.company_id = ? AND t.deleted_at IS NULL
        AND t.status IN ('eligible','blocked','paused')
      GROUP BY t.id
      ORDER BY (MAX(s.computed_at) IS NOT NULL) ASC, MAX(s.computed_at) ASC
      LIMIT ?`,
    [companyId, Number(limit)],
  );
  const now = new Date();
  let recomputed = 0;
  for (const r of rows) {
    try {
      await recomputeTaskAttribution(companyId, r.id, now);
      recomputed++;
    } catch (err) {
      logger.error({ err, companyId, taskId: r.id }, 'sweepCompany: task failed');
    }
  }
  return { ok: true, companyId, recomputed };
}

/** Sweep every company that owns any task rows. */
export async function sweepAllCompanies({ limit = 500 } = {}) {
  const [rows] = await pool.query(
    `SELECT DISTINCT company_id FROM fab_project_tasks WHERE deleted_at IS NULL`,
  );
  const results = [];
  for (const r of rows) {
    try {
      results.push(await sweepCompany(r.company_id, { limit }));
    } catch (err) {
      logger.error({ err, companyId: r.company_id }, 'sweepAllCompanies: company failed');
    }
  }
  return { ok: true, companies: results.length, results };
}
