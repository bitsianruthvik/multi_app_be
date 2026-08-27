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
// calendar helpers (resolveTaskCalendarIds / workingIntervals-
// InWindow). Edge-building mirrors GET /tasks/graph exactly (see buildEdges).

import { pool } from '../../../db.js';
import { cachedQuery } from './planReadCache.js';
import { resolveCapacity, capacityIntervals, isUnbounded } from './capacityService.js';
import { parseDependsOn } from './taskGatingService.js';
import { NoCapacityError, NO_WORKING_TIME, NO_CREW_ASSIGNED, isNoCapacity } from './schedulingErrors.js';
import { taskMinutes } from './taskDuration.js';

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
    const [inputRows] = await cachedQuery(`SELECT task_id, producing_item_id
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
  const [typeRows] = await cachedQuery(`SELECT id, num_units FROM fab_resource_types WHERE company_id = ? AND deleted_at IS NULL`,
    [companyId],
  );
  const [resRows] = await cachedQuery(`SELECT id, num_units FROM fab_resources WHERE company_id = ? AND deleted_at IS NULL`,
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
 * Working intervals for one capacity source over one ALIGNED window.
 *
 * ── WHY ALIGNED, AND WHY THIS EXISTS ──────────────────────────────────────
 * The scan used to begin at `from` — an arbitrary instant — and step by
 * CHUNK_MS from there. Every call therefore asked about a window no other call
 * had ever asked about, so nothing could be reused and every one went to the
 * database.
 *
 * That would be merely wasteful if the calls were few. They are not: the
 * placement loop tries one candidate start per interval already booked on the
 * resource, so call count grows with the square of the tasks on it, and each
 * call is several round trips to a remote database. Measured on one real order:
 * 100 tasks took 39 seconds, 250 took 222, and 8,848 — an ordinary bridge —
 * did not finish in eight minutes. The suggestion pass runs the whole leveller
 * up to 26 times.
 *
 * Snapping the window to a fixed epoch grid changes nothing about the answer —
 * a shift exists whether or not the question was asked on a week boundary — but
 * it makes every call for the same resource and week identical, so the second
 * one is free. Callers clip to `from` themselves, which they must do anyway
 * because an aligned window can open before the instant being asked about.
 *
 * The cache lives for one levelling pass. Capacity cannot change inside a pass,
 * and a longer-lived cache would quietly serve yesterday's shift pattern.
 */
const alignWindow = (ms) => Math.floor(ms / CHUNK_MS) * CHUNK_MS;

function capacityKey(cap) {
  if (!cap) return 'none';
  return `${cap.mode ?? ''}|${cap.resourceId ?? ''}|${(cap.calendarIds ?? []).join(',')}`;
}

async function windowIntervals(companyId, cap, alignedStart, cache) {
  const key = `${capacityKey(cap)}@${alignedStart}`;
  const hit = cache?.get(key);
  if (hit) return hit;
  const ivs = await capacityIntervals(
    companyId, cap, new Date(alignedStart), new Date(alignedStart + CHUNK_MS),
  );
  cache?.set(key, ivs);
  return ivs;
}

/** The part of an interval at or after `fromMs`, or null if none of it is. */
function clipFrom(iv, fromMs) {
  const s = Math.max(iv.start.getTime(), fromMs);
  const e = iv.end.getTime();
  return e > s ? { start: new Date(s), end: new Date(e) } : null;
}

/**
 * What a resource is already booked with, kept so that overlap questions do not
 * have to read all of it.
 *
 * ── WHY THIS IS NOT JUST AN ARRAY ─────────────────────────────────────────
 * `feasible` compares a proposed placement against everything already on the
 * resource. It was handed the whole list, so the comparison grew with the work
 * already scheduled — and it is asked once per candidate start, of which there
 * is one per interval already booked. Two nested walks of the same growing list,
 * per task. A CPU profile of one real order put 38% of all time inside
 * `feasible` alone.
 *
 * Almost every one of those comparisons is against an interval nowhere near the
 * placement being tested. Sorting by start makes the relevant slice findable,
 * and remembering the longest interval on the resource bounds how far back the
 * slice can begin — an interval starting before `lo - maxLen` has certainly
 * ended by `lo`.
 *
 * This changes nothing about the answer. A pair that does not overlap
 * contributes no clip, so excluding it early and excluding it late give the same
 * result — which the equivalence check relies on.
 */
function newResourceState() {
  return { ivs: [], maxLen: 0 };
}

/** First index whose start is >= `ms`, in a list sorted by start. */
function lowerBound(ivs, ms) {
  let lo = 0;
  let hi = ivs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ivs[mid].start.getTime() < ms) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function addInterval(state, iv) {
  const at = lowerBound(state.ivs, iv.start.getTime());
  state.ivs.splice(at, 0, iv);
  const len = iv.end.getTime() - iv.start.getTime();
  if (len > state.maxLen) state.maxLen = len;
}

/** The booked intervals that could possibly overlap [lo, hi). */
/**
 * Take an interval back out.
 *
 * `maxLen` is deliberately NOT recomputed. It exists only to bound how far back
 * a search must start, so a value left too high stays correct — it widens the
 * scan slightly and finds the same answer. Recomputing it would mean a pass over
 * the whole list on every removal, to make a search marginally tighter.
 */
function removeInterval(state, iv) {
  const s = iv.start.getTime();
  const e = iv.end.getTime();
  for (let i = lowerBound(state.ivs, s); i < state.ivs.length; i += 1) {
    const cur = state.ivs[i];
    if (cur.start.getTime() !== s) break;
    if (cur.end.getTime() === e) { state.ivs.splice(i, 1); return true; }
  }
  return false;
}

function overlapping(state, lo, hi) {
  const { ivs, maxLen } = state;
  if (ivs.length === 0) return ivs;
  const out = [];
  for (let i = lowerBound(ivs, lo - maxLen); i < ivs.length; i += 1) {
    const iv = ivs[i];
    if (iv.start.getTime() >= hi) break;
    if (iv.end.getTime() > lo) out.push(iv);
  }
  return out;
}

/**
 * First working instant at or after `from` on the given calendars. With no
 * calendars resolved, time is treated as continuous (24/7) — the same optimistic
 * spirit as taskWaitService's empty-calendar fallback — so the engine still runs
 * in setups without a configured shift calendar.
 */
async function nextWorkingInstant(companyId, cap, from, cache) {
  // Only the calendar path treats "no calendars" as 24/7. Crew mode never falls
  // back — an unmanned machine has zero capacity, and pretending otherwise would
  // schedule work onto a machine nobody is standing at.
  if (isUnbounded(cap)) return new Date(from.getTime());
  const fromMs = from.getTime();
  let windowStart = alignWindow(fromMs);
  let scanned = 0;
  while (scanned <= MAX_SCAN_MS) {
    const ivs = await windowIntervals(companyId, cap, windowStart, cache);
    for (const raw of ivs) {
      // Clipped, because an aligned window can open before `from`.
      const iv = clipFrom(raw, fromMs);
      if (iv) return new Date(iv.start.getTime());
    }
    windowStart += CHUNK_MS;
    scanned += CHUNK_MS;
  }
  throw new NoCapacityError({
    reason: NO_WORKING_TIME,
    from,
    scanDays: MAX_SCAN_MS / 86400000,
    calendarIds: cap?.calendarIds ?? [],
    resourceId: cap?.resourceId ?? null,
    reason: cap?.mode === 'crew' ? NO_CREW_ASSIGNED : NO_WORKING_TIME,
  });
}

/**
 * Occupy `durationMin` WORKING minutes starting at the first working instant at
 * or after `from`. Returns { start, end, intervals } where `intervals` is the
 * list of wall-clock in-shift intervals the task actually consumes (used for
 * concurrency checks). Walks the calendar in chunks via workingIntervalsInWindow.
 */
async function computeSpan(companyId, cap, from, durationMin, cache) {
  if (isUnbounded(cap)) {
    // 24/7 fallback: working minutes == wall-clock minutes.
    const start = new Date(from.getTime());
    const end = new Date(from.getTime() + Math.max(0, durationMin) * 60000);
    return { start, end, intervals: durationMin > 0 ? [{ start, end }] : [] };
  }
  if (!(durationMin > 0)) {
    const inst = await nextWorkingInstant(companyId, cap, from, cache);
    return { start: inst, end: new Date(inst.getTime()), intervals: [] };
  }

  const fromMs = from.getTime();
  let remaining = durationMin;
  let windowStart = alignWindow(fromMs);
  let started = null;
  const occupied = [];
  let scanned = 0;
  while (remaining > 1e-9) {
    if (scanned > MAX_SCAN_MS) {
      throw new NoCapacityError({
        reason: NO_WORKING_TIME,
        from,
        scanDays: MAX_SCAN_MS / 86400000,
        calendarIds: cap?.calendarIds ?? [],
      });
    }
    const raws = await windowIntervals(companyId, cap, windowStart, cache);
    for (const raw of raws) {
      // Clipped to `from`: an aligned window can open before the instant asked
      // about, and a shift that started an hour ago offers only its remainder.
      const iv = clipFrom(raw, fromMs);
      if (!iv) continue;
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
    windowStart += CHUNK_MS;
    scanned += CHUNK_MS;
  }
  // remaining <= 0 with no interval consumed: zero-length at the found start.
  const inst = started ?? (await nextWorkingInstant(companyId, cap, from, cache));
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
 * @param {Map<number,Date>} [args.earliestByTask] Per-task floor, merged with the
 *                   precedence-earliest instant. For levelling a SUBSET of a
 *                   plan, where predecessors outside the subset have no edge.
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
 * @param {Map<number,number>} [args.priority]  taskId → rank, LOWER runs first
 *                   when several tasks are ready at once and contend for the same
 *                   resource. Omit (the default) and ties break on seq_no then id
 *                   exactly as before — CC baselines must not move because the
 *                   planner started passing this.
 * @param {{resource_type_id?:number, assigned_resource_id?:number,
 *          start:Date, end:Date}[]} [args.preOccupied]  capacity that is already
 *                   spoken for before this pass begins — in-progress work and
 *                   entries already on the plan. Without it a "suggestion" plans
 *                   straight over committed work, which is worse than no
 *                   suggestion at all.
 * @returns {Promise<Map<number,{start:Date,end:Date}>>}
 */
export async function levelSchedule({
  companyId, tasks, edges, resourceCapacity, calendar, anchor, priority, preOccupied,
  earliestByTask,
} = {}) {
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

  /**
   * A plain topological pass, making no scheduling decision.
   *
   * It exists only to prove the graph is acyclic and to give the tail pass below
   * something to walk backwards. The order that actually decides who gets a
   * contended machine is built after the tails are known.
   */
  const topo = [];
  {
    const deg = new Map(indeg);
    const q = tasks.filter((t) => deg.get(t.id) === 0).map((t) => t.id);
    while (q.length > 0) {
      const id = q.shift();
      topo.push(id);
      for (const nx of adj.get(id)) {
        deg.set(nx, deg.get(nx) - 1);
        if (deg.get(nx) === 0) q.push(nx);
      }
    }
    if (topo.length !== tasks.length) {
      const stuck = tasks.filter((t) => deg.get(t.id) > 0).map((t) => t.id);
      throw new Error(
        `resourceLevelingService.levelSchedule: precedence cycle detected among tasks [${stuck.join(', ')}]`,
      );
    }
  }

  /**
   * How much work still has to happen after a task, in series.
   *
   *   tail(t) = duration(t) + max( tail(s) for every successor s )
   *
   * The longest chain of work from t to the end of its order, and therefore a
   * lower bound on how much longer that order needs once t is done. One reverse
   * pass, O(V+E) — microseconds even for the nine thousand tasks of a bridge.
   *
   * Measured in MINUTES OF WORK through taskMinutes, the same duration the
   * placer uses, so one long task is not outranked by a pile of short ones. A
   * count of successors would do exactly that.
   */
  const tailOf = new Map();
  for (let i = topo.length - 1; i >= 0; i -= 1) {
    const id = topo[i];
    let longest = 0;
    for (const nx of adj.get(id)) {
      const t = tailOf.get(nx) ?? 0;
      if (t > longest) longest = t;
    }
    tailOf.set(id, (taskMinutes(taskById.get(id)) || 0) + longest);
  }

  /**
   * Which ready task gets a contended machine.
   *
   * Priority first. It can never reorder past a precedence edge, because Kahn
   * only ever offers indegree-0 tasks — so a rush order jumps the queue with no
   * risk of a task overtaking its own predecessor.
   *
   * THEN THE LONGEST REMAINING CHAIN, and that is the rule that decides when an
   * order closes. Between orders `priority` already decides; WITHIN one, every
   * task shares a rank and the winner used to fall through to `seq_no` — a
   * number that says nothing at all about finishing sooner.
   *
   * An order closes when its LAST task finishes. Hand a contended machine to a
   * short-tail task and the long-tail task waits: its whole chain shifts, and
   * the close date moves out by exactly that delay. Hand it to the long-tail
   * task and the short-tail one waits inside slack it already had. So feed the
   * longest remaining chain first.
   *
   * It ignores resource contention deliberately — this is a priority signal, and
   * making it resource-aware would turn it into the scheduling problem itself.
   * It also cannot beat the constraint: a station carrying 676 h of work on one
   * machine bounds the order however cleverly its queue is ordered.
   */
  const cmp = (a, b) => {
    const ta = taskById.get(a);
    const tb = taskById.get(b);
    if (priority) {
      const pa = priority.get(a);
      const pb = priority.get(b);
      // A task with no rank sorts after every ranked one rather than at zero,
      // which would put unranked work at the front of the shop.
      const ra = Number.isFinite(pa) ? pa : Number.POSITIVE_INFINITY;
      const rb = Number.isFinite(pb) ? pb : Number.POSITIVE_INFINITY;
      if (ra !== rb) return ra - rb;
    }
    const tailA = tailOf.get(a) ?? 0;
    const tailB = tailOf.get(b) ?? 0;
    if (tailA !== tailB) return tailB - tailA;
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

  // ── per-task capacity resolution (cached by resource identity) ─────────────
  // Keyed by resource, NOT by plant: under calendar mode a machine can carry its
  // own shift_calendar_id, and under crew mode the capacity IS that machine's
  // crew — either way two machines in the same plant can differ, and a
  // plant-keyed cache would hand the first machine's answer to the second.
  const capCache = new Map();    // resourceKey -> capacity source
  /**
   * Working intervals, per capacity source per aligned week, for THIS pass only.
   * See windowIntervals — this is what turns a quadratic pile of database round
   * trips into one call per resource per week.
   */
  const ivCache = new Map();
  async function capacityFor(task) {
    // An explicit `calendar` argument still forces the calendar path — callers
    // pass it to schedule against a hypothetical calendar (what-if runs).
    if (Array.isArray(calendar)) return { mode: 'calendar', resourceId: null, calendarIds: calendar };
    const rKey = `${task.assigned_resource_id ?? ''}|${task.resource_type_id ?? ''}`;
    if (capCache.has(rKey)) return capCache.get(rKey);
    const resolved = await resolveCapacity(companyId, task);
    capCache.set(rKey, resolved);
    return resolved;
  }

  // ── forward pass ─────────────────────────────────────────────────────────────
  // key -> a start-sorted interval index (see newResourceState). A plain array
  // was fine until an order arrived with thousands of tasks on one machine:
  // feasibility was rescanning every booking already made, once per candidate.
  const resourceState = new Map();

  // Seed with capacity that is already committed. resourceContext is reused
  // verbatim so a pre-occupied span lands on exactly the key the tasks contend
  // on — computing the key here by hand is how these two drift apart.
  for (const p of preOccupied ?? []) {
    const start = p.start instanceof Date ? p.start : new Date(p.start);
    const end = p.end instanceof Date ? p.end : new Date(p.end);
    if (!(end > start)) continue;
    const { key } = resourceContext(
      { assigned_resource_id: p.assigned_resource_id ?? null, resource_type_id: p.resource_type_id ?? null },
      cap,
    );
    if (key === null) continue;
    if (!resourceState.has(key)) resourceState.set(key, newResourceState());
    addInterval(resourceState.get(key), { start, end });
  }

  for (const id of order) {
    const task = taskById.get(id);
    // Per-piece × pieces. See taskDuration — the formula is a cycle time, so a
    // task covering 20 flanges used to be scheduled as though it were one.
    const durationMin = taskMinutes(task);

    let earliest = anchorDate;
    for (const pid of predsOf.get(id)) {
      const p = schedule.get(pid);
      if (p && p.end > earliest) earliest = p.end;
    }
    // A floor supplied by the caller, for predecessors that are NOT in this run.
    // Levelling a SUBSET of a plan — one girder, against everything else held
    // fixed — has most of its precedence outside the task set, so there is no
    // edge to carry it. Without this the subset would happily start before work
    // it depends on, and the only alternative would be re-levelling the whole
    // shop in order to move one unit.
    const floor = earliestByTask?.get(id);
    if (floor instanceof Date && floor > earliest) earliest = floor;

    const capSrc = await capacityFor(task);
    const { key, capacity } = resourceContext(task, cap);

    // nextWorkingInstant/computeSpan know the calendars but not whose work it
    // is. Naming the task and machine here is what turns "nothing schedulable
    // in 366 days" into "Press-2 has no crew, so task 4812 cannot be placed" —
    // the difference between a log line and something the floor can act on.
    const withContext = async (fn) => {
      try {
        return await fn();
      } catch (err) {
        if (isNoCapacity(err)) {
          err.taskId = task.id;
          err.resourceId = task.assigned_resource_id ?? null;
        }
        throw err;
      }
    };

    let span;
    if (key === null || !(capacity < Infinity) || durationMin <= 0) {
      // Unconstrained (or zero-length): schedule at precedence-earliest.
      span = await withContext(() => computeSpan(companyId, capSrc, earliest, durationMin, ivCache));
    } else {
      const state = resourceState.get(key) ?? newResourceState();
      const existing = state.ivs;
      // Candidate starts: the precedence-earliest instant, plus every existing
      // interval end at/after it. The latest candidate lies after all existing
      // work, so a feasible placement is always found (loop terminates).
      const earliestMs = earliest.getTime();
      const candTimes = [earliestMs];
      // No interval is longer than maxLen, so one starting before
      // earliestMs - maxLen cannot end at/after earliestMs. Skipping those is
      // exactly the filter below, done by binary search instead of a full scan.
      for (let i = lowerBound(existing, earliestMs - state.maxLen); i < existing.length; i += 1) {
        const end = existing[i].end.getTime();
        if (end >= earliestMs) candTimes.push(end);
      }
      const candidates = [...new Set(candTimes)].sort((a, b) => a - b);
      span = null;
      for (const c of candidates) {
        const s = await withContext(() => computeSpan(companyId, capSrc, new Date(c), durationMin, ivCache));
        // Only the intervals that could touch this placement — see overlapping().
        const near = s.intervals.length === 0 ? [] : overlapping(
          state,
          s.intervals[0].start.getTime(),
          s.intervals[s.intervals.length - 1].end.getTime(),
        );
        if (feasible(near, s.intervals, capacity)) { span = s; break; }
      }
      if (span === null) {
        // Defensive: place strictly after all existing work (guaranteed feasible).
        const latest = candidates[candidates.length - 1];
        span = await withContext(() => computeSpan(companyId, capSrc, new Date(latest), durationMin, ivCache));
      }
    }

    schedule.set(id, { start: span.start, end: span.end });
    if (key !== null && capacity < Infinity && span.intervals.length > 0) {
      if (!resourceState.has(key)) resourceState.set(key, newResourceState());
      const st = resourceState.get(key);
      for (const iv of span.intervals) addInterval(st, iv);
    }
  }

  return schedule;
}

/**
 * A bookable view of the shop, for callers that place work one bar at a time.
 *
 * levelSchedule builds this state internally and throws it away. Schedule repair
 * needs the same thing but incrementally — lift one bar out, ask where it fits
 * now, put it back — and the one thing this codebase keeps being bitten by is a
 * second implementation of a rule that already exists (the calendar walk, the
 * bundle apportionment). So the machinery is shared rather than copied, and
 * levelSchedule is left exactly as it was.
 *
 * The two questions it answers are the leveller's own:
 *   - where does `durationMin` of WORKING time starting at or after `notBefore`
 *     actually land, walking the shift calendar (computeSpan)
 *   - does putting it there keep the resource within its concurrency (feasible)
 *
 * @param {number} companyId
 * @param {{typeUnits:Map, resourceUnits:Map}} resourceCapacity from loadResourceCapacity
 */
export function createPlacer(companyId, resourceCapacity) {
  const ivCache = new Map();
  const state = new Map();

  const stateFor = (key) => {
    if (!state.has(key)) state.set(key, newResourceState());
    return state.get(key);
  };

  return {
    /** {key, capacity} for a bar, by the same rule tasks are grouped by. */
    contextFor: (bar) => resourceContext(bar, resourceCapacity),

    book(key, intervals) {
      if (key == null) return;
      const st = stateFor(key);
      for (const iv of intervals) addInterval(st, iv);
    },

    unbook(key, intervals) {
      if (key == null) return;
      const st = stateFor(key);
      for (const iv of intervals) removeInterval(st, iv);
    },

    /**
     * The working intervals a bar of `durationMin` occupies if it starts at or
     * after `notBefore` — ignoring concurrency. What a bar ALREADY on the plan
     * occupies, so it can be booked or lifted out.
     */
    async span(capSrc, notBefore, durationMin) {
      return computeSpan(companyId, capSrc, notBefore, durationMin, ivCache);
    },

    /**
     * The earliest placement at or after `notBefore` that also keeps the
     * resource within capacity. Candidate starts are `notBefore` plus the end of
     * every booking at or after it — the leveller's own search, which terminates
     * because the last candidate lies beyond all existing work.
     */
    async place(capSrc, key, capacity, notBefore, durationMin) {
      if (key === null || !(capacity < Infinity) || durationMin <= 0) {
        return computeSpan(companyId, capSrc, notBefore, durationMin, ivCache);
      }
      const st = stateFor(key);
      const from = notBefore.getTime();
      const cand = [from];
      for (let i = lowerBound(st.ivs, from - st.maxLen); i < st.ivs.length; i += 1) {
        const end = st.ivs[i].end.getTime();
        if (end >= from) cand.push(end);
      }
      let fallback = null;
      for (const c of [...new Set(cand)].sort((a, b) => a - b)) {
        const s = await computeSpan(companyId, capSrc, new Date(c), durationMin, ivCache);
        fallback = s;
        const near = s.intervals.length === 0 ? [] : overlapping(
          st, s.intervals[0].start.getTime(), s.intervals[s.intervals.length - 1].end.getTime(),
        );
        if (feasible(near, s.intervals, capacity)) return s;
      }
      // Unreachable in practice: the last candidate is past everything booked.
      return fallback ?? computeSpan(companyId, capSrc, notBefore, durationMin, ivCache);
    },
  };
}
