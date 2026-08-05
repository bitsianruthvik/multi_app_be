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
 *       Classified WHOLESALE as a single reason (waiting_predecessors /
 *       waiting_materials) based on the task's CURRENT gate state, because we
 *       keep no per-minute history of when each predecessor/input cleared.
 *       SIMPLIFICATION (per EU-3 spec): if predecessors aren't all done OR a
 *       depends_on is unmet → waiting_predecessors; else if a gate=1 input is
 *       still unsatisfied → waiting_materials; else the window is treated as
 *       "deps cleared instantly" and skipped. A task that has already cleared
 *       therefore contributes nothing here (current state shows all satisfied).
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
  resolveTaskCalendarIds,
  workingIntervalsInWindow,
  fetchOverlappingOtherTasks,
  mergeIntervals,
} from './taskWaitService.js';
import { processPredecessorsDone, isOutputBlocked } from './taskGatingService.js';
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

  const calendarIds = await resolveTaskCalendarIds(companyId, task);

  const segments = []; // { reason, start, end, wm, group:'pre'|'active' }

  // ── window (a): pre-eligibility (wholesale classification) ──────────────────
  if (createdAt) {
    const aTo = depsClearedAt || (task.status === 'blocked' ? now : null);
    if (aTo && aTo > createdAt) {
      let reason = null;
      const predsDone = await processPredecessorsDone(pool, companyId, task);
      if (!predsDone) {
        reason = 'waiting_predecessors';
      } else {
        // Read-only proxy for "a gated input is still unsatisfied": a gate=1
        // row with no satisfied_at. (taskGatingService's live check mutates
        // satisfied_at, so we deliberately don't call it here.)
        const [inp] = await pool.query(
          `SELECT 1 FROM fab_task_inputs
            WHERE company_id = ? AND task_id = ? AND gate = 1
              AND satisfied_at IS NULL AND deleted_at IS NULL
            LIMIT 1`,
          [companyId, taskId],
        );
        if (inp.length > 0) reason = 'waiting_materials';
      }
      if (reason) {
        const inShiftA = await workingIntervalsInWindow(companyId, calendarIds, createdAt, aTo);
        segments.push({
          reason, start: createdAt, end: aTo, wm: Math.round(sumMinutes(inShiftA)), group: 'pre',
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
    if (task.assigned_resource_id) {
      machineDown = await loadMachineDownIntervals(companyId, task.assigned_resource_id, now);
      noOperator = await loadNoOperatorIntervals(companyId, task.assigned_resource_id, spanStart, spanEnd);
    }
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
      const inShift = await workingIntervalsInWindow(companyId, calendarIds, w.start, w.end);

      // 1. no_shift first — out-of-shift time (working_minutes = 0).
      for (const iv of subtractIntervals(win, inShift)) {
        segments.push({ reason: 'no_shift', start: iv.start, end: iv.end, wm: 0, group: 'active' });
      }

      let remaining = inShift;
      // 2. machine_down
      const downHit = intersectIntervals(remaining, machineDown);
      for (const iv of downHit) segments.push(inShiftSeg('machine_down', iv));
      remaining = subtractIntervals(remaining, downHit);
      // 3. no_operator
      const opHit = intersectIntervals(remaining, noOperator);
      for (const iv of opHit) segments.push(inShiftSeg('no_operator', iv));
      remaining = subtractIntervals(remaining, opHit);
      // 4. machine_busy
      const busyHit = intersectIntervals(remaining, machineBusy);
      for (const iv of busyHit) segments.push(inShiftSeg('machine_busy', iv));
      remaining = subtractIntervals(remaining, busyHit);
      // 5. output_blocked — only the still-open tail (interval ending at `now`)
      //    when the task is output-blocked right now (see SIMPLIFICATION above).
      //    Everything else remains unexplained_idle.
      // 6. unexplained_idle — whatever in-shift time is left.
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
    if (last && last.reason === s.reason && last.group === s.group && s.start <= last.end) {
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
      const rows = merged.map((s) => [companyId, taskId, s.reason, s.start, s.end, s.wm, now]);
      await conn.query(
        `INSERT INTO fab_task_wait_segments
           (company_id, task_id, reason, seg_start, seg_end, working_minutes, computed_at)
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
