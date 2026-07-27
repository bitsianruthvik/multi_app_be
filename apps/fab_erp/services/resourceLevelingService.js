// resourceLevelingService.js — EU-2: pure, deterministic server-side resource-
// leveling engine for fab_erp. Persists nothing; it is a compute service.
//
// Given a set of fab_project_tasks, their precedence edges, resource capacities
// and a shift calendar, it produces a resource-FEASIBLE schedule: no resource is
// ever loaded beyond its concurrency at any instant. Durations are WORKING-
// minutes (computed_hours × 60), walked over the shift calendar — never wall-
// clock. Given identical inputs and the same `anchor`, output is byte-identical
// every run: nothing here reads the wall clock except the `anchor` default, and
// no sort/scheduling decision depends on the current time.
//
// Calendar math is NOT reimplemented — it reuses taskWaitService's already-public
// calendar helpers (resolveTaskPlantId / resolveCalendarIds / workingIntervals-
// InWindow). Edge-building mirrors GET /tasks/graph exactly (see buildEdges).

import { pool } from '../../../db.js';
import {
  resolveTaskPlantId,
  resolveCalendarIds,
  workingIntervalsInWindow,
} from './taskWaitService.js';
import { parseDependsOn } from './taskGatingService.js';

// ─── edge building (mirrors GET /tasks/graph) ─────────────────────────────────

/**
 * Build precedence edges for a task set, replicating GET /tasks/graph exactly.
 *
 *   - Intra-item "flow" edges: from fab_project_tasks.depends_on (CSV of
 *     predecessor seq_no), resolved STRICTLY within one (item_id, flow_id) group
 *     — never across groups, or duplicate flow instances cross-link. With no
 *     depends_on, the immediate previous seq_no in the group is the predecessor.
 *   - Cross-BOM "component" edges: from fab_task_inputs (input_role='component',
 *     gate=1). The edge runs FROM the producing item's TERMINAL task to the
 *     consuming task. The terminal task is the GLOBAL max-seq_no task across ALL
 *     of that item's tasks (tie-break max id) — matching
 *     taskGatingService.terminalTaskDone (ORDER BY seq_no DESC LIMIT 1), NOT a
 *     per-flow terminal.
 *
 * @param {{companyId:number, tasks:object[]}} args
 * @returns {Promise<{from:number,to:number,kind:'flow'|'component'}[]>}
 */
export async function buildEdges({ companyId, tasks }) {
  const edges = [];

  // Intra-item flow edges, grouped by (item_id, flow_id).
  const groups = new Map();
  for (const t of tasks) {
    const key = `${t.item_id}:${t.flow_id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }
  for (const rows of groups.values()) {
    const seqNos = rows.map((r) => Number(r.seq_no)).sort((a, b) => a - b);
    const idBySeq = new Map(rows.map((r) => [Number(r.seq_no), r.id]));
    const previousSeqNo = (seqNo) => {
      let prev = null;
      for (const s of seqNos) if (s < seqNo && (prev === null || s > prev)) prev = s;
      return prev;
    };
    for (const row of rows) {
      const deps = parseDependsOn(row.depends_on);
      const predSeqs = deps.length > 0
        ? deps
        : (() => { const p = previousSeqNo(Number(row.seq_no)); return p === null ? [] : [p]; })();
      for (const sn of predSeqs) {
        const fromId = idBySeq.get(sn);
        if (fromId != null && fromId !== row.id) edges.push({ from: fromId, to: row.id, kind: 'flow' });
      }
    }
  }

  // Cross-BOM component edges. Terminal task = global max seq_no across ALL of an
  // item's tasks (tie-break max id) — must match terminalTaskDone, not per-flow.
  const taskIdSet = new Set(tasks.map((t) => t.id));
  const terminalByItem = new Map();
  for (const t of tasks) {
    const cur = terminalByItem.get(t.item_id);
    const sn = Number(t.seq_no);
    if (!cur || sn > cur.seqNo || (sn === cur.seqNo && t.id > cur.id)) {
      terminalByItem.set(t.item_id, { id: t.id, seqNo: sn });
    }
  }

  const taskIds = tasks.map((t) => t.id);
  if (taskIds.length > 0) {
    const [inputRows] = await pool.query(
      `SELECT task_id, producing_item_id
         FROM fab_task_inputs
        WHERE company_id = ? AND task_id IN (?) AND input_role = 'component'
          AND gate = 1 AND producing_item_id IS NOT NULL AND deleted_at IS NULL`,
      [companyId, taskIds],
    );
    const seen = new Set();
    for (const r of inputRows) {
      if (!taskIdSet.has(r.task_id)) continue;
      const terminal = terminalByItem.get(r.producing_item_id);
      if (!terminal || terminal.id === r.task_id) continue;
      const k = `${terminal.id}:${r.task_id}`;
      if (seen.has(k)) continue;
      seen.add(k);
      edges.push({ from: terminal.id, to: r.task_id, kind: 'component' });
    }
  }

  return edges;
}

// ─── resource capacity ────────────────────────────────────────────────────────

/**
 * Load resource concurrency from the DB. Returns { typeUnits, resourceUnits }
 * where each is a Map of id → num_units for rows that declare a positive
 * num_units. A missing/NULL type entry means "no capacity info" (treated as
 * unconstrained downstream); a concrete fab_resources row overrides its type.
 *
 * @param {number} companyId
 */
export async function loadResourceCapacity(companyId) {
  const [typeRows] = await pool.query(
    `SELECT id, num_units FROM fab_resource_types WHERE company_id = ? AND deleted_at IS NULL`,
    [companyId],
  );
  const [resRows] = await pool.query(
    `SELECT id, num_units FROM fab_resources WHERE company_id = ? AND deleted_at IS NULL`,
    [companyId],
  );
  const typeUnits = new Map();
  for (const r of typeRows) {
    if (r.num_units != null && Number(r.num_units) > 0) typeUnits.set(Number(r.id), Number(r.num_units));
  }
  const resourceUnits = new Map();
  for (const r of resRows) {
    if (r.num_units != null && Number(r.num_units) > 0) resourceUnits.set(Number(r.id), Number(r.num_units));
  }
  return { typeUnits, resourceUnits };
}

/**
 * The contention scope + capacity for a task.
 *   - Pinned (assigned_resource_id): contends only on that specific unit; default
 *     capacity 1, overridden by the fab_resources row's num_units if present.
 *   - Unpinned with a type that declares num_units: contends on the type pool.
 *   - Otherwise: unconstrained (infinite capacity) — scheduled precedence-earliest.
 */
function resourceContext(task, cap) {
  const rid = task.assigned_resource_id;
  if (rid != null) {
    const c = cap.resourceUnits.get(Number(rid));
    return { key: `r:${rid}`, capacity: c != null && c > 0 ? c : 1 };
  }
  const tid = task.resource_type_id;
  if (tid != null) {
    const c = cap.typeUnits.get(Number(tid));
    if (c != null && c > 0) return { key: `t:${tid}`, capacity: c };
  }
  return { key: null, capacity: Infinity };
}

// ─── calendar walk (reuses taskWaitService's working-interval helper) ──────────

const CHUNK_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_SCAN_MS = 366 * 24 * 60 * 60 * 1000;

/**
 * First working instant at or after `from` on the given calendars. With no
 * calendars resolved, time is treated as continuous (24/7) — the same optimistic
 * spirit as taskWaitService's empty-calendar fallback — so the engine still runs
 * in setups without a configured shift calendar.
 */
async function nextWorkingInstant(companyId, calendarIds, from) {
  if (calendarIds.length === 0) return new Date(from.getTime());
  let windowStart = new Date(from.getTime());
  let scanned = 0;
  while (scanned <= MAX_SCAN_MS) {
    const windowEnd = new Date(windowStart.getTime() + CHUNK_MS);
    const ivs = await workingIntervalsInWindow(companyId, calendarIds, windowStart, windowEnd);
    if (ivs.length > 0) return new Date(ivs[0].start.getTime());
    windowStart = windowEnd;
    scanned += CHUNK_MS;
  }
  throw new Error(
    `resourceLevelingService: no working time found within ${MAX_SCAN_MS / 86400000} days after ${from.toISOString()} for calendars [${calendarIds.join(', ')}]`,
  );
}

/**
 * Occupy `durationMin` WORKING minutes starting at the first working instant at
 * or after `from`. Returns { start, end, intervals } where `intervals` is the
 * list of wall-clock in-shift intervals the task actually consumes (used for
 * concurrency checks). Walks the calendar in chunks via workingIntervalsInWindow.
 */
async function computeSpan(companyId, calendarIds, from, durationMin) {
  if (calendarIds.length === 0) {
    // 24/7 fallback: working minutes == wall-clock minutes.
    const start = new Date(from.getTime());
    const end = new Date(from.getTime() + Math.max(0, durationMin) * 60000);
    return { start, end, intervals: durationMin > 0 ? [{ start, end }] : [] };
  }
  if (!(durationMin > 0)) {
    const inst = await nextWorkingInstant(companyId, calendarIds, from);
    return { start: inst, end: new Date(inst.getTime()), intervals: [] };
  }

  let remaining = durationMin;
  let windowStart = new Date(from.getTime());
  let started = null;
  const occupied = [];
  let scanned = 0;
  while (remaining > 1e-9) {
    if (scanned > MAX_SCAN_MS) {
      throw new Error(
        `resourceLevelingService: could not fit ${durationMin} working minutes within ${MAX_SCAN_MS / 86400000} days after ${from.toISOString()} for calendars [${calendarIds.join(', ')}]`,
      );
    }
    const windowEnd = new Date(windowStart.getTime() + CHUNK_MS);
    const ivs = await workingIntervalsInWindow(companyId, calendarIds, windowStart, windowEnd);
    for (const iv of ivs) {
      if (started === null) started = new Date(iv.start.getTime());
      const lenMin = (iv.end.getTime() - iv.start.getTime()) / 60000;
      if (remaining <= lenMin + 1e-9) {
        const end = new Date(iv.start.getTime() + remaining * 60000);
        occupied.push({ start: new Date(iv.start.getTime()), end });
        return { start: started, end, intervals: occupied };
      }
      occupied.push({ start: new Date(iv.start.getTime()), end: new Date(iv.end.getTime()) });
      remaining -= lenMin;
    }
    windowStart = windowEnd;
    scanned += CHUNK_MS;
  }
  // remaining <= 0 with no interval consumed: zero-length at the found start.
  const inst = started ?? (await nextWorkingInstant(companyId, calendarIds, from));
  return { start: inst, end: new Date(inst.getTime()), intervals: occupied };
}

// ─── concurrency feasibility ──────────────────────────────────────────────────

/**
 * True if adding a task occupying `newIntervals` to a resource that already has
 * `existing` intervals scheduled keeps concurrency ≤ capacity at every instant.
 * Endpoints touch without overlapping (a.end == b.start is not concurrent).
 */
function feasible(existing, newIntervals, capacity) {
  if (!(capacity < Infinity)) return true;
  const clips = [];
  for (const e of existing) {
    for (const n of newIntervals) {
      const s = Math.max(e.start.getTime(), n.start.getTime());
      const en = Math.min(e.end.getTime(), n.end.getTime());
      if (en > s) clips.push([s, en]);
    }
  }
  if (clips.length === 0) return true;
  const events = [];
  for (const [s, en] of clips) { events.push([s, 1]); events.push([en, -1]); }
  // At an equal timestamp, close (-1) before open (+1) so touching clips don't
  // count as simultaneous.
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let cur = 0;
  let mx = 0;
  for (const [, d] of events) { cur += d; if (cur > mx) mx = cur; }
  return mx <= capacity - 1;
}

// ─── main entry ───────────────────────────────────────────────────────────────

/**
 * Produce a deterministic, resource-feasible schedule.
 *
 * @param {object}   args
 * @param {number}   args.companyId
 * @param {object[]} args.tasks             fab_project_tasks rows (non-cancelled),
 *                   each with at least id, computed_hours, resource_type_id,
 *                   assigned_resource_id, seq_no, item_id, flow_id, depends_on.
 * @param {object[]} [args.edges]           precedence edges {from,to}. If omitted,
 *                   they are built internally via buildEdges (which does a DB read
 *                   of fab_task_inputs for cross-BOM component edges).
 * @param {{typeUnits:Map,resourceUnits:Map}} [args.resourceCapacity]
 *                   if omitted, loaded via loadResourceCapacity(companyId).
 * @param {number[]} [args.calendar]        explicit calendar id list applied to
 *                   ALL tasks (testability / a single global calendar). If
 *                   omitted, each task resolves its own calendar via
 *                   taskWaitService (plant → calendars), mirroring taskWaitService.
 * @param {Date}     [args.anchor]          earliest allowed start (default now).
 *                   Only the anchor may influence output; scheduling is otherwise
 *                   independent of the wall clock.
 * @returns {Promise<Map<number,{start:Date,end:Date}>>}
 */
export async function levelSchedule({ companyId, tasks, edges, resourceCapacity, calendar, anchor } = {}) {
  const schedule = new Map();
  if (!Array.isArray(tasks) || tasks.length === 0) return schedule;

  const anchorDate = anchor instanceof Date ? anchor : new Date();
  const cap = resourceCapacity ?? (await loadResourceCapacity(companyId));
  const edgeList = edges ?? (await buildEdges({ companyId, tasks }));

  const taskById = new Map(tasks.map((t) => [t.id, t]));

  // ── topological order (Kahn), deterministic tie-break by seq_no then id ──────
  const indeg = new Map();
  const adj = new Map();
  for (const t of tasks) { indeg.set(t.id, 0); adj.set(t.id, []); }
  const predsOf = new Map(tasks.map((t) => [t.id, []]));
  const seenEdge = new Set();
  for (const e of edgeList) {
    if (!taskById.has(e.from) || !taskById.has(e.to)) continue;
    if (e.from === e.to) continue;
    const k = `${e.from}->${e.to}`;
    if (seenEdge.has(k)) continue;
    seenEdge.add(k);
    adj.get(e.from).push(e.to);
    indeg.set(e.to, indeg.get(e.to) + 1);
    predsOf.get(e.to).push(e.from);
  }

  const cmp = (a, b) => {
    const ta = taskById.get(a);
    const tb = taskById.get(b);
    return (Number(ta.seq_no) || 0) - (Number(tb.seq_no) || 0) || a - b;
  };

  const ready = tasks.filter((t) => indeg.get(t.id) === 0).map((t) => t.id);
  const order = [];
  while (ready.length > 0) {
    ready.sort(cmp);
    const id = ready.shift();
    order.push(id);
    for (const nx of adj.get(id)) {
      indeg.set(nx, indeg.get(nx) - 1);
      if (indeg.get(nx) === 0) ready.push(nx);
    }
  }
  if (order.length !== tasks.length) {
    const stuck = tasks.filter((t) => indeg.get(t.id) > 0).map((t) => t.id);
    throw new Error(
      `resourceLevelingService.levelSchedule: precedence cycle detected among tasks [${stuck.join(', ')}]`,
    );
  }

  // ── per-task calendar resolution (cached by resource identity / plant) ───────
  const plantCache = new Map();  // resourceKey -> plantId
  const calCache = new Map();    // plantId key -> calendarIds
  async function calendarIdsFor(task) {
    if (Array.isArray(calendar)) return calendar;
    const rKey = `${task.assigned_resource_id ?? ''}|${task.resource_type_id ?? ''}`;
    let plantId;
    if (plantCache.has(rKey)) plantId = plantCache.get(rKey);
    else { plantId = await resolveTaskPlantId(companyId, task); plantCache.set(rKey, plantId); }
    const pKey = plantId == null ? 'null' : String(plantId);
    if (calCache.has(pKey)) return calCache.get(pKey);
    const ids = await resolveCalendarIds(companyId, plantId);
    calCache.set(pKey, ids);
    return ids;
  }

  // ── forward pass ─────────────────────────────────────────────────────────────
  const resourceState = new Map(); // key -> occupied intervals [{start,end}]
  for (const id of order) {
    const task = taskById.get(id);
    const durationMin = Number(task.computed_hours) > 0 ? Number(task.computed_hours) * 60 : 0;

    let earliest = anchorDate;
    for (const pid of predsOf.get(id)) {
      const p = schedule.get(pid);
      if (p && p.end > earliest) earliest = p.end;
    }

    const calendarIds = await calendarIdsFor(task);
    const { key, capacity } = resourceContext(task, cap);

    let span;
    if (key === null || !(capacity < Infinity) || durationMin <= 0) {
      // Unconstrained (or zero-length): schedule at precedence-earliest.
      span = await computeSpan(companyId, calendarIds, earliest, durationMin);
    } else {
      const existing = resourceState.get(key) ?? [];
      // Candidate starts: the precedence-earliest instant, plus every existing
      // interval end at/after it. The latest candidate lies after all existing
      // work, so a feasible placement is always found (loop terminates).
      const candTimes = [earliest.getTime()];
      for (const iv of existing) if (iv.end.getTime() >= earliest.getTime()) candTimes.push(iv.end.getTime());
      const candidates = [...new Set(candTimes)].sort((a, b) => a - b);
      span = null;
      for (const c of candidates) {
        const s = await computeSpan(companyId, calendarIds, new Date(c), durationMin);
        if (feasible(existing, s.intervals, capacity)) { span = s; break; }
      }
      if (span === null) {
        // Defensive: place strictly after all existing work (guaranteed feasible).
        const latest = candidates[candidates.length - 1];
        span = await computeSpan(companyId, calendarIds, new Date(latest), durationMin);
      }
    }

    schedule.set(id, { start: span.start, end: span.end });
    if (key !== null && capacity < Infinity && span.intervals.length > 0) {
      if (!resourceState.has(key)) resourceState.set(key, []);
      const arr = resourceState.get(key);
      for (const iv of span.intervals) arr.push(iv);
    }
  }

  return schedule;
}
