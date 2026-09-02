/**
 * actualsBoardService.js — what the shop actually did, in the shape a canvas
 * can paint.
 *
 * THE PLAN BOARD, BACKWARDS
 * -------------------------
 * `planService.getPlanBoard` draws `fab_plan_entries`: intentions, in the
 * future. This draws `fab_project_tasks.started_at / completed_at`: facts, in
 * the past, with a live edge at *now*. Same window, same BOM ladder, same flat
 * number tuples, opposite time direction — so the client reuses `BoardCanvas`
 * and `boardModel` unchanged and only the payload is new.
 *
 * Deliberately READ-ONLY. Nothing here writes, locks or takes a transaction, and
 * nothing on the board it feeds can be dragged. It is a record, not a proposal.
 *
 * TWO MODES, BECAUSE THERE ARE TWO QUESTIONS
 * ------------------------------------------
 *   mode=unit      No machine rows at all. One bar per unit at the chosen level
 *                  of the ladder, drawn against the plant as a whole and packed
 *                  into as many parallel lanes as the work genuinely needed. The
 *                  operations underneath are what the timing is computed FROM
 *                  and are not drawn — the lane count is the answer to "how many
 *                  girders did we have open at once".
 *
 *   mode=machine   Every operation at machine granularity. The client nests the
 *                  machine lanes under collapsible hierarchy headers; the server
 *                  just hands over machine lanes and lets `boardModel` say which
 *                  unit each block belongs to, exactly as the Plan Board does.
 *
 * WHAT IS NOT DRAWN
 * -----------------
 * Work that never started. An empty stretch on this board means nothing
 * happened there, and filling it with planned-but-unstarted bars would quietly
 * turn it back into a plan board.
 */

import { pool } from '../../../db.js';
import { plannerTimezone } from './planService.js';
import { loadPlanCompare } from './actualsCompareService.js';
import { GROUP_LEVELS, groupKeyFor } from './planUnitService.js';
import { resolveTaskCalendarIds, workingIntervalsInWindow } from './taskWaitService.js';
import {
  RUN_JOIN_MS, clipToWorking, joinRuns, makeWorkClock, mergeSpans, packLanes, spanMs,
} from './actualsRunService.js';

/** Coarse → fine, plus the rung the ladder does not have: the operation itself. */
export const ACTUALS_LEVELS = [...GROUP_LEVELS, 'operation'];

/** Block status codes. Mirrored by the client's ACTUALS_STATUS. */
export const ST_NONE = 0;
export const ST_IN_PROGRESS = 1;
export const ST_DONE = 2;
export const ST_PAUSED = 3;
export const ST_REWORK = 4;
export const ST_DONE_LATE = 5;

/**
 * Beyond this many item rows the weight roll-up and the unit-level counters are
 * skipped rather than made slow.
 *
 * A month normally touches one to five orders. Somebody selecting a whole year,
 * or a shop running twenty concurrent projects, should get a board rather than a
 * timeout — and `stats.degraded` says out loud which numbers were dropped, so a
 * missing tonnage reads as missing rather than as zero.
 */
const MAX_ITEM_ROWS = 20000;

/** Tasks per `IN (?)` chunk. A real order is nine thousand of them. */
const ID_CHUNK = 2000;

/**
 * The bucket for work with no ancestor at the requested level.
 *
 * Deliberately not a parseable unit key (`o:` / `l:` / `i:` / `p:`), so the
 * client's own walk fails to match it and the blocks fall through to the
 * ungrouped grey rather than borrowing some other unit's hue.
 */
const UNGROUPED_KEY = 'x:none';

/** MySQL DATETIME, UTC. */
function toDateTimeStr(d) {
  const dt = d instanceof Date ? d : new Date(d);
  return dt.toISOString().slice(0, 19).replace('T', ' ');
}

function chunk(list, n) {
  const out = [];
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
  return out;
}

// ─── loading ─────────────────────────────────────────────────────────────────

/**
 * Every task that was being worked on at some point inside the window.
 *
 * The filter is an OVERLAP test, not containment: a girder welded across the
 * month boundary belongs to both months, clipped to each. Requiring the whole
 * task to fall inside would make every long operation vanish from every report.
 */
async function loadTasks(companyId, from, to, { orderIds, resourceTypeIds }) {
  const params = [companyId, toDateTimeStr(to), toDateTimeStr(from)];
  let filter = '';
  if (orderIds.length > 0) { filter += ' AND i.order_id IN (?)'; params.push(orderIds); }
  if (resourceTypeIds.length > 0) { filter += ' AND t.resource_type_id IN (?)'; params.push(resourceTypeIds); }

  const [rows] = await pool.query(
    `SELECT t.id, t.item_id AS itemId, t.operation_id AS operationId,
            t.resource_type_id AS resourceTypeId, t.assigned_resource_id AS resourceId,
            t.status, t.started_at AS startedAt, t.completed_at AS completedAt,
            t.is_rework AS isRework, i.order_id AS orderId
       FROM fab_project_tasks t
       JOIN fab_items i ON i.id = t.item_id AND i.company_id = t.company_id
                       AND i.deleted_at IS NULL
      WHERE t.company_id = ?
        AND t.deleted_at IS NULL
        AND t.status <> 'cancelled'
        AND t.started_at IS NOT NULL
        AND t.started_at < ?
        AND (t.completed_at IS NULL OR t.completed_at > ?)${filter}
      ORDER BY t.started_at ASC`,
    params,
  );
  return rows;
}

/**
 * Every item of the touched orders — the walk data, the labels and the weights,
 * in one read.
 *
 * The Plan Board walks UP from the blocks it drew (`itemAncestry`) because it
 * only ever needs ancestors. This needs descendants too: a girder's weight is
 * the sum of the steel below it, and a girder's completeness is a fact about
 * tasks on items that never appear in the window at all.
 */
async function loadOrderItems(companyId, orderIds) {
  if (orderIds.length === 0) return { rows: [], truncated: false };
  const [[{ n }]] = await pool.query(
    `SELECT COUNT(*) AS n FROM fab_items
      WHERE company_id = ? AND order_id IN (?) AND deleted_at IS NULL`,
    [companyId, orderIds],
  );
  if (Number(n) > MAX_ITEM_ROWS) return { rows: [], truncated: true };

  const [rows] = await pool.query(
    `SELECT id, parent_item_id AS parentItemId, order_id AS orderId,
            order_line_id AS orderLineId, depth, node_kind AS nodeKind,
            name, code, mark, total_weight AS totalWeight
       FROM fab_items
      WHERE company_id = ? AND order_id IN (?) AND deleted_at IS NULL`,
    [companyId, orderIds],
  );
  return { rows, truncated: false };
}

/**
 * Ancestors only, one generation at a time — the fallback when the orders are
 * too big to load whole. Same walk as planService.itemAncestry, and bounded the
 * same way: a cycle in parent_item_id is exactly what a bad import produces.
 */
const MAX_BOM_DEPTH = 24;
async function itemAncestry(companyId, itemIds) {
  const known = new Map();
  let frontier = [...new Set(itemIds.filter((x) => x != null))];
  for (let depth = 0; depth < MAX_BOM_DEPTH && frontier.length > 0; depth += 1) {
    const rows = [];
    for (const part of chunk(frontier, ID_CHUNK)) {
      const [r] = await pool.query(
        `SELECT id, parent_item_id AS parentItemId, order_id AS orderId,
                order_line_id AS orderLineId, depth, node_kind AS nodeKind,
                name, code, mark, total_weight AS totalWeight
           FROM fab_items
          WHERE company_id = ? AND id IN (?) AND deleted_at IS NULL`,
        [companyId, part],
      );
      rows.push(...r);
    }
    const next = [];
    for (const r of rows) {
      if (known.has(r.id)) continue;
      known.set(r.id, r);
      if (r.parentItemId != null && !known.has(r.parentItemId)) next.push(r.parentItemId);
    }
    frontier = [...new Set(next)];
  }
  return [...known.values()];
}

/** Per-item task totals across the WHOLE order, not just the window. */
async function loadItemTaskRollup(companyId, orderIds) {
  if (orderIds.length === 0) return new Map();
  const [rows] = await pool.query(
    `SELECT t.item_id AS itemId,
            COUNT(*) AS total,
            SUM(t.status = 'done') AS done,
            MIN(t.started_at) AS firstStart,
            MAX(t.completed_at) AS lastEnd,
            SUM(t.completed_at IS NULL AND t.status IN ('in_progress','paused')) AS running
       FROM fab_project_tasks t
       JOIN fab_items i ON i.id = t.item_id AND i.company_id = t.company_id
                       AND i.deleted_at IS NULL
      WHERE t.company_id = ? AND t.deleted_at IS NULL AND t.status <> 'cancelled'
        AND i.order_id IN (?)
      GROUP BY t.item_id`,
    [companyId, orderIds],
  );
  return new Map(rows.map((r) => [Number(r.itemId), {
    total: Number(r.total),
    done: Number(r.done),
    firstStart: r.firstStart ? new Date(r.firstStart).getTime() : null,
    lastEnd: r.lastEnd ? new Date(r.lastEnd).getTime() : null,
    running: Number(r.running),
  }]));
}

/**
 * When the plan said each task would finish, so a completion can be called late.
 *
 * Only entries still `planned` count. A retired plan is not a promise anybody
 * broke, and marking work late against a schedule that was withdrawn would put a
 * red rule under most of a re-planned order.
 *
 * TWO INDEXED READS AND A JOIN IN JS, NOT ONE JOINED GROUP BY.
 * ------------------------------------------------------------
 * The obvious single query — join `fab_plan_entry_tasks` to `fab_plan_entries`,
 * `GROUP BY task_id`, `COALESCE(MAX(...), MAX(...))` — measured **2,030 ms** on
 * prod TiDB for 239 task ids, and was ninety-five percent of the whole endpoint.
 * Split into two reads that each hit an index (`idx_fplet_task`, then the
 * entries' primary key) it is **221 ms**, reproducibly, from two different
 * networks. TiDB picks a poor plan for that shape; the rows involved are few
 * enough that the merge belongs in JS anyway.
 *
 * The semantics are preserved exactly, which is the fiddly part:
 *   - only rows whose ENTRY is still `planned` contribute at all;
 *   - the task's own `planned_end` wins where any row has one;
 *   - the entry's end is the fallback only when NO row for that task has one —
 *     which is `COALESCE(MAX(a), MAX(b))`, not a per-row coalesce.
 */
async function loadPlannedEnds(companyId, taskIds) {
  const out = new Map();
  for (const part of chunk(taskIds, ID_CHUNK)) {
    const [links] = await pool.query(
      `SELECT task_id AS taskId, plan_entry_id AS entryId, planned_end AS taskEnd
         FROM fab_plan_entry_tasks
        WHERE company_id = ? AND task_id IN (?) AND deleted_at IS NULL`,
      [companyId, part],
    );
    if (links.length === 0) continue;

    const entryIds = [...new Set(links.map((r) => Number(r.entryId)))];
    const [entries] = await pool.query(
      `SELECT id, planned_end AS plannedEnd
         FROM fab_plan_entries
        WHERE company_id = ? AND id IN (?) AND status = 'planned' AND deleted_at IS NULL`,
      [companyId, entryIds],
    );
    const entryEnd = new Map(entries.map((e) => [Number(e.id), e.plannedEnd]));

    /** Per task: the greatest task-level end, and the greatest entry-level one. */
    const best = new Map();
    for (const r of links) {
      // The JOIN's filter: an entry that is not `planned` is not in the map at
      // all, so its rows contribute to neither maximum.
      if (!entryEnd.has(Number(r.entryId))) continue;
      const id = Number(r.taskId);
      let b = best.get(id);
      if (!b) { b = { task: null, entry: null }; best.set(id, b); }
      const te = r.taskEnd ? new Date(r.taskEnd).getTime() : null;
      const ee = entryEnd.get(Number(r.entryId));
      const eems = ee ? new Date(ee).getTime() : null;
      if (te != null && (b.task == null || te > b.task)) b.task = te;
      if (eems != null && (b.entry == null || eems > b.entry)) b.entry = eems;
    }
    for (const [id, b] of best) {
      const v = b.task ?? b.entry;
      if (v != null) out.set(id, v);
    }
  }
  return out;
}

/** Resource types and their machines — names for the lanes, nothing more. */
async function loadResources(companyId, resourceTypeIds) {
  const params = [companyId];
  let filter = '';
  if (resourceTypeIds.length > 0) { filter = ' AND rt.id IN (?)'; params.push(resourceTypeIds); }
  const [types] = await pool.query(
    `SELECT rt.id, rt.name, rt.code FROM fab_resource_types rt
      WHERE rt.company_id = ? AND rt.deleted_at IS NULL${filter}
      ORDER BY rt.name ASC`,
    params,
  );
  const [machines] = await pool.query(
    `SELECT r.id, r.name, r.resource_type_id AS resourceTypeId, r.plant_id AS plantId
       FROM fab_resources r
      WHERE r.company_id = ? AND r.deleted_at IS NULL
      ORDER BY r.name ASC`,
    [companyId],
  );
  return { types, machines };
}

// ─── working time ────────────────────────────────────────────────────────────

/**
 * The plant's working intervals, resolved ONCE per calendar set per window.
 *
 * Per task this would be one of the most expensive things the app does — the
 * planner's own profiling found fifty-two queries in a single drag going to
 * three tables holding one calendar. Tasks are bucketed by their resolved
 * calendar set and each distinct set is walked once.
 */
function makeCalendarCache(companyId, from, to) {
  const byKey = new Map();
  return async function intervalsFor(calendarIds) {
    const key = calendarIds.slice().sort((a, b) => a - b).join(',');
    if (byKey.has(key)) return byKey.get(key);
    const promise = (async () => {
      const ivs = calendarIds.length === 0
        ? []
        : await workingIntervalsInWindow(companyId, calendarIds, from, to);
      const spans = ivs.map((iv) => ({ s: iv.start.getTime(), e: iv.end.getTime() }));
      /**
       * NO CALENDAR MEANS 24/7, NOT "NEVER".
       *
       * A tenant with no shift calendar has no working intervals, and clipping
       * against an empty list removes everything — which would render a board
       * that is blank however much work the shop did, with no error and nothing
       * to explain it. The scheduler already made this call the other way
       * (`capacityService.isUnbounded`: no calendar, plan it around the clock)
       * and the Plan Board draws such a lane unshaded rather than dead. Three
       * screens asserting opposite things about the same machine is how they
       * come to disagree, so this one agrees.
       *
       * Its own flag rather than an inference from `spans.length`, because a
       * calendar that genuinely has no working time inside the window — a plant
       * shut for the month — is a different fact and must still clip to nothing.
       */
      const unbounded = calendarIds.length === 0;
      return { key, spans, unbounded, clock: unbounded ? ((t) => t) : makeWorkClock(spans) };
    })();
    byKey.set(key, promise);
    return promise;
  };
}

// ─── weight ──────────────────────────────────────────────────────────────────

/**
 * Kilograms of fabricated steel attributable to each item that has tasks.
 *
 * Three facts make this less obvious than summing a column, and getting any of
 * them wrong produces a number that is plausible and badly wrong:
 *
 * 1. **`total_weight` ROLLS UP.** A girder's weight already contains its
 *    segments, which already contain their parts. Summing the tree counts the
 *    same steel once per level, so a row contributes only its OWN weight — its
 *    total minus its children's.
 *
 * 2. **MATERIAL ROWS ARE PLATES, NOT PARTS, AND MUST BE SKIPPED.** A part's
 *    material child is the stock plate it is cut FROM, and it weighs the whole
 *    plate: in the placebo order a 75 kg flange hangs under a 3,014 kg plate.
 *    Counting it would inflate that part forty-fold — and because nesting draws
 *    one plate for several parts, the same plate would be counted once per part
 *    it fed. So material rows contribute nothing and are not children for the
 *    purpose of rule 1 either, which is what leaves a part holding its own
 *    75 kg. (`fab_items.node_kind` is what says a row is material; see the
 *    note at init.sql where it is described as load-bearing for exactly this.)
 *
 * 3. **Weight and work do not sit on the same rows.** An assembly has tasks and
 *    no steel of its own. So every kilogram is pushed UP to the nearest ancestor
 *    that has tasks. Total weight is conserved and nothing is double-counted,
 *    which is the only pair of properties that matters.
 *
 * Checkable against the placebo order: segment 527.52 = 7 parts × 75.36, girder
 * 1055.04 = 2 segments, span 2072.36 = its two girders. Every level nets to zero
 * own-weight except the parts, which is where the work is.
 */
function attributeWeights(items, taskCountByItem) {
  const isMaterial = (it) => it.nodeKind === 'material';
  const byId = new Map(items.map((i) => [Number(i.id), i]));

  const childSum = new Map();
  for (const it of items) {
    if (isMaterial(it)) continue;
    const p = it.parentItemId != null ? Number(it.parentItemId) : null;
    if (p == null || !byId.has(p)) continue;
    childSum.set(p, (childSum.get(p) ?? 0) + (Number(it.totalWeight) || 0));
  }

  const own = new Map();
  for (const it of items) {
    if (isMaterial(it)) continue;
    const id = Number(it.id);
    const total = Number(it.totalWeight) || 0;
    own.set(id, Math.max(0, total - (childSum.get(id) ?? 0)));
  }

  const out = new Map();
  for (const it of items) {
    const w = own.get(Number(it.id)) ?? 0;
    if (w <= 0) continue;
    // Climb to the nearest ancestor that has work on it. A kilogram with nowhere
    // to land is dropped rather than parked on a row nothing can complete.
    let node = it;
    for (let i = 0; i < MAX_BOM_DEPTH && node; i += 1) {
      const id = Number(node.id);
      if ((taskCountByItem.get(id) ?? 0) > 0) {
        out.set(id, (out.get(id) ?? 0) + w);
        break;
      }
      node = node.parentItemId != null ? byId.get(Number(node.parentItemId)) ?? null : null;
    }
  }
  return out;
}

// ─── the board ───────────────────────────────────────────────────────────────

/**
 * @param {number} companyId
 * @param {object} opts
 * @param {Date}   opts.from
 * @param {Date}   opts.to
 * @param {'unit'|'machine'} opts.mode
 * @param {string} opts.level      one of ACTUALS_LEVELS
 */
export async function getActualsBoard(companyId, {
  from, to, mode = 'machine', level = 'girder',
  orderIds = [], resourceTypeIds = [], withPlan = false, now = new Date(),
} = {}) {
  const t0 = from.getTime();
  const t1 = to.getTime();
  const nowMs = now.getTime();
  const rel = (ms) => Math.round(ms - t0);

  /**
   * THE READS RUN IN WAVES, NOT ONE AFTER ANOTHER.
   *
   * Measured on prod: 1.8–2.9 s for a window containing only 244 started tasks.
   * Almost none of that was the work — it was ten queries awaited in a line,
   * each paying a full Render→TiDB round trip. The order-wide ones (the item
   * load, the task roll-up) are the same size whether one girder has been worked
   * or all eight, so the latency was a constant nobody was going to grow out of.
   *
   * Three waves, which is the fewest the dependencies allow:
   *
   *   1  the timezone and the tasks           — nothing depends on anything
   *   2  everything the TASKS identify        — items, planned ends, the three
   *                                             id-keyed lookups, and warming
   *                                             the calendar cache
   *   3  everything the ITEMS identify        — the roll-up (which needs to know
   *                                             whether wave 2 degraded) and the
   *                                             order-line lookup
   *
   * Do not collapse waves 2 and 3 by dropping the `degraded` guard: on an
   * oversized window the roll-up is exactly the query that must not run.
   */
  /**
   * Stage timings, always measured.
   *
   * Reported on every response rather than hidden behind a debug flag, because
   * the one time it mattered the board was already in production and guessing
   * which of ten reads dominated cost a deploy cycle per guess. A handful of
   * Date.now() calls is not a cost worth being clever about.
   */
  const marks = {};
  let mark0 = Date.now();
  const mark = (name) => { marks[name] = Date.now() - mark0; mark0 = Date.now(); };

  const [tz, tasks] = await Promise.all([
    plannerTimezone(companyId),
    loadTasks(companyId, from, to, { orderIds, resourceTypeIds }),
  ]);
  mark('wave1_tasks');
  const empty = {
    from, to, timezone: tz, mode, level, now: now.toISOString(),
    lanes: [], items: [], orders: [], lines: [], entries: [], operations: [], resources: [],
    units: [], laneCount: 0, unitTonnes: {}, unitProgress: {}, plan: null,
    stats: {
      hours: 0, tonnes: 0, taskCount: 0, tasksCompleted: 0, tasksStarted: 0,
      reworkHours: 0, ungroupedHours: 0, machinesActive: 0, peakParallel: 0,
      unitsCompleted: 0, unitsStarted: 0, unitsOpen: 0, unitsCarriedIn: 0,
      degraded: false,
    },
  };
  if (tasks.length === 0) return empty;

  const touchedOrderIds = [...new Set(tasks.map((t) => t.orderId).filter((x) => x != null))];
  const doneIds = tasks.filter((t) => t.status === 'done' && t.completedAt != null).map((t) => t.id);
  const opIds = [...new Set(tasks.map((t) => t.operationId).filter((x) => x != null))];
  const resIds = [...new Set(tasks.map((t) => t.resourceId).filter((x) => x != null))];

  const intervalsFor = makeCalendarCache(companyId, from, to);

  /**
   * Calendar resolution memoised on (machine, type).
   *
   * `resolveTaskCalendarIds` reads the in-memory shift snapshot, so it is cheap
   * — but "cheap" times nine thousand tasks is still nine thousand promises for
   * an answer that only varies across a few dozen machines.
   */
  const calByResource = new Map();
  const calendarFor = (t) => {
    const k = `${t.resourceId ?? 0}:${t.resourceTypeId ?? 0}`;
    if (!calByResource.has(k)) {
      calByResource.set(k, resolveTaskCalendarIds(companyId, {
        assigned_resource_id: t.resourceId,
        resource_type_id: t.resourceTypeId,
      }).then(intervalsFor));
    }
    return calByResource.get(k);
  };

  /**
   * One task per distinct (machine, type), resolved together.
   *
   * Warming the cache up front rather than letting the clip loop discover the
   * keys one at a time: the loop awaits in sequence, so a shop with ten machine
   * groups paid ten serial calendar walks before it clipped its first span.
   */
  const calendarProbes = new Map();
  for (const t of tasks) {
    const k = `${t.resourceId ?? 0}:${t.resourceTypeId ?? 0}`;
    if (!calendarProbes.has(k)) calendarProbes.set(k, t);
  }

  // ── wave 2: everything the TASKS identify ─────────────────────────────────
  /**
   * Timed member by member.
   *
   * A parallel wave takes as long as its SLOWEST member, so an aggregate figure
   * for it says nothing about which query to fix — which is how two deploys went
   * on a diagnosis that turned out to be only half right.
   */
  const timed = (name, p) => {
    const s = Date.now();
    return Promise.resolve(p).then((v) => { marks[`w2_${name}`] = Date.now() - s; return v; });
  };

  // `pool.query` resolves to [rows, fields]; the nested pattern takes the rows.
  const [loaded, plannedEnds, [operations], [resources], [orders]] = await Promise.all([
    timed('items', loadOrderItems(companyId, touchedOrderIds)),
    timed('plannedEnds', doneIds.length ? loadPlannedEnds(companyId, doneIds) : Promise.resolve(new Map())),
    opIds.length === 0 ? Promise.resolve([[]]) : timed('ops', pool.query(
      `SELECT id, name FROM fab_operations WHERE company_id = ? AND id IN (?)`,
      [companyId, opIds],
    )),
    resIds.length === 0 ? Promise.resolve([[]]) : timed('res', pool.query(
      `SELECT id, name FROM fab_resources WHERE company_id = ? AND id IN (?)`,
      [companyId, resIds],
    )),
    touchedOrderIds.length === 0 ? Promise.resolve([[]]) : timed('orders', pool.query(
      `SELECT id, order_number AS orderNumber, customer_name AS customerName,
              priority, priority_rank AS priorityRank, required_date AS requiredDate,
              must_finish_by AS mustFinishBy
         FROM fab_orders WHERE company_id = ? AND id IN (?)`,
      [companyId, touchedOrderIds],
    )),
    timed('calendars', Promise.all([...calendarProbes.values()].map((t) => calendarFor(t)))),
  ]);

  mark('wave2_reads');

  // ── items: the walk data, the labels, the weights ─────────────────────────
  const degraded = loaded.truncated;
  const items = degraded
    ? await itemAncestry(companyId, tasks.map((t) => t.itemId))
    : loaded.rows;
  const itemsById = new Map(items.map((i) => [Number(i.id), i]));
  const lineIds = [...new Set(items.map((i) => i.orderLineId).filter((x) => x != null))];

  // ── wave 3: everything the ITEMS identify ────────────────────────────────
  const [rollup, [lines]] = await Promise.all([
    degraded ? Promise.resolve(new Map()) : loadItemTaskRollup(companyId, touchedOrderIds),
    lineIds.length === 0 ? Promise.resolve([[]]) : pool.query(
      `SELECT id, order_id AS orderId, line_no AS lineNo, code, description
         FROM fab_order_lines WHERE company_id = ? AND id IN (?)`,
      [companyId, lineIds],
    ),
  ]);

  /**
   * Wave 3b: the plan, but only if asked for.
   *
   * Three more reads, so it is opt-in. Started here rather than awaited, so the
   * whole comparison overlaps the clipping and assembly below instead of being
   * charged on top of them.
   */
  const planPromise = withPlan
    ? timed('plan', loadPlanCompare(companyId, {
      from, to, timeZone: tz, taskIds: tasks.map((t) => t.id), orderIds: touchedOrderIds,
    }))
    : null;

  mark('wave3_reads');

  // ── when each task was really being worked on ─────────────────────────────
  /** Every calendar set seen, so the pack lanes can be shaded by their union. */
  const seenCalendars = [];

  const clippedByTask = new Map();
  const clockByTask = new Map();
  for (const t of tasks) {
    // Resolved already — wave 2 warmed every distinct key, so this await is on
    // a settled promise and the loop is pure arithmetic.
    const cal = await calendarFor(t);
    if (!seenCalendars.includes(cal)) seenCalendars.push(cal);

    const startMs = new Date(t.startedAt).getTime();
    /**
     * Where the task's span ends.
     *
     * A running task has no completion, so it runs to NOW — that live sliver is
     * the whole point of putting the board's second clock on screen. A task with
     * neither a completion nor a running status is a data fault, not a task that
     * has been going since March, so it is given no span rather than a fictional
     * one that would stretch across the window.
     */
    const running = t.completedAt == null
      && (t.status === 'in_progress' || t.status === 'paused');
    const endMs = t.completedAt != null
      ? new Date(t.completedAt).getTime()
      : (running ? nowMs : startMs);

    const raw = { s: Math.max(startMs, t0), e: Math.min(endMs, t1) };
    const spans = cal.unbounded
      ? (raw.e > raw.s ? [raw] : [])
      : clipToWorking(raw, cal.spans);
    clippedByTask.set(t.id, spans);
    clockByTask.set(t.id, cal.clock);
  }

  mark('clip');

  // ── status per task ───────────────────────────────────────────────────────
  // `plannedEnds` came back in wave 2.
  const statusOf = (t) => {
    // Rework is its own state even when finished: a bar that exists because
    // something failed inspection is the thing a monthly review looks for, and
    // folding it into "done" is how a shop reports a good month twice.
    if (t.isRework) return ST_REWORK;
    if (t.status === 'done') {
      const pe = plannedEnds.get(Number(t.id));
      const at = t.completedAt ? new Date(t.completedAt).getTime() : null;
      return (pe != null && at != null && at > pe) ? ST_DONE_LATE : ST_DONE;
    }
    if (t.status === 'in_progress') return ST_IN_PROGRESS;
    if (t.status === 'paused') return ST_PAUSED;
    return ST_NONE;
  };

  // ── unit key per task ─────────────────────────────────────────────────────
  const keyMemo = new Map();
  const unitKeyOf = (t) => {
    if (level === 'operation') {
      return t.operationId != null ? `p:${t.operationId}` : null;
    }
    const id = Number(t.itemId);
    if (keyMemo.has(id)) return keyMemo.get(id);
    const k = groupKeyFor(itemsById, id, level);
    keyMemo.set(id, k);
    return k;
  };

  const outLanes = [];
  const units = [];
  let laneCount = 0;

  if (mode === 'unit') {
    // ── Mode A: one bar per unit, packed into parallel lanes ────────────────
    const byUnit = new Map();
    for (const t of tasks) {
      /**
       * WORK THAT DOES NOT RESOLVE TO A UNIT IS STILL DRAWN.
       *
       * Not every task has an ancestor at every level: an item created outside
       * the wizard can have no `order_line_id`, so at line level its key is
       * null. Dropping those was the first version and it was wrong in the worst
       * available way — the board simply showed less work than the shop did, the
       * hours in the header disagreed with the bars underneath them, and nothing
       * on screen said so. (Measured on the local fixture: 83 of 106 hours drawn
       * at line level, silently.)
       *
       * So they go into one visible bucket instead. The client cannot group them
       * either, so they draw in the ungrouped grey — which reads as "work we
       * could not place at this level", which is exactly what it is. Same
       * decision as the Project Progress view's "Other / unmapped" stage.
       */
      const key = unitKeyOf(t) ?? UNGROUPED_KEY;
      let u = byUnit.get(key);
      if (!u) {
        u = { key, anchorItemId: Number(t.itemId), operationId: t.operationId, spans: [], tasks: [] };
        byUnit.set(key, u);
      }
      const sp = clippedByTask.get(t.id) ?? [];
      for (const s of sp) u.spans.push({ ...s, taskId: t.id });
      u.tasks.push(t);
    }

    /**
     * The runs, per unit.
     *
     * Joined through the work clock of whichever calendar the unit's tasks ran
     * on — one unit is one plant's work, so taking the first task's clock is not
     * an approximation in any shop this models.
     *
     * The spans go in carrying their task id and `joinRuns` hands each run back
     * the parts that fed it, so a run's status is a lookup rather than a search.
     * The obvious alternative — asking, per run, which of the unit's tasks
     * overlap it — is quadratic, and at order level a unit holds every task in
     * the order.
     */
    const taskById = new Map(tasks.map((t) => [t.id, t]));
    for (const u of byUnit.values()) {
      if (u.spans.length === 0) continue;
      const clock = clockByTask.get(u.tasks[0].id) ?? ((x) => x);
      const runs = joinRuns(u.spans, clock, RUN_JOIN_MS);
      if (runs.length === 0) continue;

      /**
       * What a run is drawn as, decided by the tasks inside it.
       *
       * Anything still moving beats anything finished: "this is running right
       * now" is the one thing on a retrospective that is not history, and a run
       * that ends at the live edge must not read as closed.
       */
      const runStatus = runs.map((r) => {
        let anyRunning = false;
        let anyPaused = false;
        let anyLate = false;
        let allRework = r.parts.length > 0;
        for (const p of r.parts) {
          const t = taskById.get(p.taskId);
          if (!t) continue;
          if (t.status === 'in_progress') anyRunning = true;
          else if (t.status === 'paused') anyPaused = true;
          if (!t.isRework) allRework = false;
          if (statusOf(t) === ST_DONE_LATE) anyLate = true;
        }
        if (anyRunning) return ST_IN_PROGRESS;
        if (anyPaused) return ST_PAUSED;
        if (allRework) return ST_REWORK;
        return anyLate ? ST_DONE_LATE : ST_DONE;
      });

      units.push({
        key: u.key,
        anchorItemId: u.anchorItemId,
        operationId: u.operationId ?? null,
        startRel: rel(runs[0].s),
        endRel: rel(runs[runs.length - 1].e),
        runs,
        runStatus,
        // Labour, not wall clock. Three machines on one girder for two hours is
        // six hours of work and two hours of the board — the bar already shows
        // the second, so the number reports the first.
        workMs: u.tasks.reduce((n, t) => n + spanMs(clippedByTask.get(t.id) ?? []), 0),
        taskCount: u.tasks.length,
        laneIdx: 0,
      });
    }

    laneCount = packLanes(units);

    // Union of every calendar in play, so a pack lane is shaded by the plant's
    // working time rather than by any one machine's.
    const plantSpans = mergeSpans(seenCalendars.flatMap((c) => c.spans));
    for (let l = 0; l < laneCount; l += 1) {
      const mine = units.filter((u) => u.laneIdx === l);
      const blocks = [];
      const blockStatus = [];
      const blockOp = [];
      for (const u of mine) {
        u.runs.forEach((r, ri) => {
          blocks.push(rel(r.s), Math.max(0, r.e - r.s), u.anchorItemId, 0, 0);
          blockStatus.push(u.runStatus[ri]);
          blockOp.push(u.operationId ?? 0);
        });
      }
      // Blocks must arrive sorted by start — the canvas hit-test bisects them.
      const order = blockStatus.map((_, i) => i)
        .sort((a, b) => blocks[a * 5] - blocks[b * 5]);
      const sortedBlocks = [];
      const sortedStatus = [];
      const sortedOp = [];
      for (const i of order) {
        sortedBlocks.push(...blocks.slice(i * 5, i * 5 + 5));
        sortedStatus.push(blockStatus[i]);
        sortedOp.push(blockOp[i]);
      }

      outLanes.push({
        kind: 'pack',
        resourceTypeId: -(l + 1),
        machineId: null,
        typeName: 'Plant',
        name: `Lane ${l + 1}`,
        code: null,
        totalUnits: 1,
        // Unshaded only when there is genuinely no calendar. A real calendar with
        // no working time in the window is a shut plant, and must still read shut.
        unbounded: seenCalendars.length > 0 && seenCalendars.every((c) => c.unbounded),
        resourceCount: 0,
        unitCount: mine.length,
        coverage: plantSpans.flatMap((s) => [rel(s.s), rel(s.e), 1]),
        blocks: sortedBlocks,
        blockStatus: sortedStatus,
        blockOp: sortedOp,
        blockCount: sortedBlocks.length / 5,
      });
    }
  } else {
    // ── Mode B: machine lanes ───────────────────────────────────────────────
    const { types, machines } = await loadResources(companyId, resourceTypeIds);
    const typeById = new Map(types.map((t) => [Number(t.id), t]));
    const machineById = new Map(machines.map((m) => [Number(m.id), m]));

    /**
     * One lane per machine, plus one "unassigned" lane per type that has
     * unassigned work.
     *
     * A task with no machine is not nothing — it is work somebody did that the
     * system cannot place, and dropping it would make the hours on this board
     * disagree with the hours in the shift log.
     */
    const laneKeyOf = (t) => (t.resourceId != null
      ? `m:${t.resourceId}`
      : `u:${t.resourceTypeId ?? 0}`);

    const tasksByLane = new Map();
    for (const t of tasks) {
      const k = laneKeyOf(t);
      if (!tasksByLane.has(k)) tasksByLane.set(k, []);
      tasksByLane.get(k).push(t);
    }

    /** Lanes in a stable order: by type name, then machine name, unassigned last. */
    const laneKeys = [...tasksByLane.keys()].sort((a, b) => {
      const info = (k) => {
        if (k.startsWith('m:')) {
          const m = machineById.get(Number(k.slice(2)));
          const ty = m ? typeById.get(Number(m.resourceTypeId)) : null;
          return [ty?.name ?? '~', m?.name ?? '~', 0];
        }
        const ty = typeById.get(Number(k.slice(2)));
        return [ty?.name ?? '~', '~~', 1];
      };
      const [an, am, az] = info(a);
      const [bn, bm, bz] = info(b);
      return an.localeCompare(bn) || az - bz || am.localeCompare(bm);
    });

    for (const k of laneKeys) {
      const laneTasks = tasksByLane.get(k) ?? [];
      const isMachine = k.startsWith('m:');
      const machine = isMachine ? machineById.get(Number(k.slice(2))) : null;
      const type = isMachine
        ? (machine ? typeById.get(Number(machine.resourceTypeId)) : null)
        : typeById.get(Number(k.slice(2)));
      // A resource type filter was applied upstream; a lane whose type is not in
      // the filtered set only exists when the task named a type that was deleted.
      if (resourceTypeIds.length > 0 && type == null) continue;

      const rows = [];
      for (const t of laneTasks) {
        const st = statusOf(t);
        for (const s of (clippedByTask.get(t.id) ?? [])) {
          rows.push({ s: rel(s.s), d: Math.max(0, s.e - s.s), item: Number(t.itemId), task: t.id, st, op: t.operationId ?? 0 });
        }
      }
      rows.sort((a, b) => a.s - b.s);

      const blocks = [];
      const blockStatus = [];
      const blockOp = [];
      for (const r of rows) {
        blocks.push(r.s, r.d, r.item, r.task, 0);
        blockStatus.push(r.st);
        blockOp.push(r.op);
      }

      const cal = await intervalsFor(await resolveTaskCalendarIds(companyId, {
        assigned_resource_id: machine?.id ?? null,
        resource_type_id: type?.id ?? null,
      }));

      outLanes.push({
        kind: 'machine',
        resourceTypeId: Number(type?.id ?? 0),
        machineId: machine ? Number(machine.id) : null,
        typeName: type?.name ?? 'Unknown',
        name: machine ? machine.name : `${type?.name ?? 'Unknown'} · unassigned`,
        code: type?.code ?? null,
        totalUnits: 1,
        unbounded: cal.unbounded,
        resourceCount: machine ? 1 : 0,
        unitCount: 0,
        coverage: cal.spans.flatMap((s) => [rel(s.s), rel(s.e), 1]),
        blocks,
        blockStatus,
        blockOp,
        blockCount: blocks.length / 5,
      });
    }
  }

  mark('assemble');

  // ── statistics ────────────────────────────────────────────────────────────
  const taskCountByItem = new Map();
  // `rollup` came back in wave 3.
  for (const [id, r] of rollup) taskCountByItem.set(id, r.total);

  const weightByItem = degraded ? new Map() : attributeWeights(items, taskCountByItem);

  let hours = 0;
  let reworkHours = 0;
  let tonnes = 0;
  let tasksCompleted = 0;
  let tasksStarted = 0;
  /**
   * Work with no ancestor at this level.
   *
   * Reported rather than merely drawn grey, because "some of this month is not
   * attributable to a line item" is a fact about the DATA that a reader should
   * be told once, not left to infer from the shade of a few bars.
   */
  let ungroupedHours = 0;
  /**
   * Tonnes per unit key, at the level being drawn.
   *
   * Sent for BOTH modes even though only one of them has a `units[]` array: the
   * gutter offers hours / tonnes / operations as the number beside each unit,
   * and in machine mode the units are the collapsible headers, which have the
   * same keys and the same right to a tonnage.
   */
  const unitTonnes = {};
  for (const t of tasks) {
    const ms = spanMs(clippedByTask.get(t.id) ?? []);
    hours += ms / 3600000;
    if (t.isRework) reworkHours += ms / 3600000;
    if (unitKeyOf(t) == null) ungroupedHours += ms / 3600000;
    const endedIn = t.completedAt != null
      && new Date(t.completedAt).getTime() >= t0 && new Date(t.completedAt).getTime() < t1;
    if (endedIn) {
      tasksCompleted += 1;
      // Steel is credited by the WORK DONE in the window, not by when the unit
      // it belongs to happens to close. A girder ninety percent welded in July
      // and closed on the 2nd of August is August's ten percent — crediting the
      // finish date would hand August the whole girder and July nothing.
      const total = taskCountByItem.get(Number(t.itemId)) ?? 0;
      const w = weightByItem.get(Number(t.itemId)) ?? 0;
      if (total > 0 && w > 0) {
        const share = (w / total) / 1000;
        tonnes += share;
        const key = unitKeyOf(t);
        if (key) unitTonnes[key] = (unitTonnes[key] ?? 0) + share;
      }
    }
    const st = new Date(t.startedAt).getTime();
    if (st >= t0 && st < t1) tasksStarted += 1;
  }

  // Unit-level counters, rolled up through the same walk the board draws with.
  let unitsCompleted = 0;
  let unitsStarted = 0;
  let unitsOpen = 0;
  let unitsCarriedIn = 0;
  /** Per-unit progress, keyed like the grouping. The monthly report's table. */
  const unitProgress = {};
  if (!degraded && level !== 'operation') {
    const byUnit = new Map();
    for (const [itemId, r] of rollup) {
      const key = groupKeyFor(itemsById, itemId, level);
      if (!key) continue;
      let u = byUnit.get(key);
      if (!u) { u = { total: 0, done: 0, firstStart: null, lastEnd: null }; byUnit.set(key, u); }
      u.total += r.total;
      u.done += r.done;
      if (r.firstStart != null) u.firstStart = u.firstStart == null ? r.firstStart : Math.min(u.firstStart, r.firstStart);
      // A unit with any unfinished task has no last end, however many of its
      // tasks carry one — that is what stops a half-built girder counting as
      // completed on the date its first operation happened to close.
      if (r.done < r.total) u.lastEnd = Number.NaN;
      else if (r.lastEnd != null && !Number.isNaN(u.lastEnd)) {
        u.lastEnd = u.lastEnd == null ? r.lastEnd : Math.max(u.lastEnd, r.lastEnd);
      }
    }
    for (const [key, u] of byUnit) {
      const complete = u.total > 0 && u.done === u.total && !Number.isNaN(u.lastEnd) && u.lastEnd != null;
      if (complete && u.lastEnd >= t0 && u.lastEnd < t1) unitsCompleted += 1;
      if (u.firstStart != null && u.firstStart >= t0 && u.firstStart < t1) unitsStarted += 1;
      if (!complete && u.firstStart != null && u.firstStart < t1) unitsOpen += 1;
      if (u.firstStart != null && u.firstStart < t0
        && !(complete && u.lastEnd <= t0)) unitsCarriedIn += 1;

      /**
       * The same roll-up, kept per unit rather than only counted.
       *
       * The monthly report needs a row per girder — done of total, and whether
       * it is finished, running or untouched — and every figure for it is
       * already in this loop. Emitting it here costs nothing; computing it
       * anywhere else would mean a second walk that could disagree with the
       * counters printed beside it.
       *
       * Sent for EVERY unit of the touched orders, not just the ones that were
       * worked this month: a progress report has to list the girder that saw no
       * work at all, and it is the only document on this board that does.
       */
      unitProgress[key] = {
        done: u.done,
        total: u.total,
        state: complete ? 'complete' : (u.firstStart != null ? 'in_progress' : 'not_started'),
        firstStart: u.firstStart != null ? new Date(u.firstStart).toISOString() : null,
        lastEnd: (complete && u.lastEnd != null && !Number.isNaN(u.lastEnd))
          ? new Date(u.lastEnd).toISOString() : null,
        /** True when this unit moved at all inside the window. */
        touchedInWindow: u.firstStart != null && u.firstStart < t1
          && (Number.isNaN(u.lastEnd) || u.lastEnd == null || u.lastEnd > t0),
      };
    }
  }

  // The words themselves were fetched in waves 2 and 3 — see the note at the
  // top of this function. Nothing is read after this point.

  return {
    from,
    to,
    timezone: tz,
    mode,
    level,
    now: now.toISOString(),
    lanes: outLanes,
    // The client walks these to group and to label; `totalWeight` is dropped —
    // it is a server-side input to the tonnage, not something the canvas reads.
    items: items.map((i) => ({
      id: i.id,
      parentItemId: i.parentItemId,
      orderId: i.orderId,
      orderLineId: i.orderLineId,
      depth: i.depth, nodeKind: i.nodeKind,
      name: i.name,
      code: i.code,
      mark: i.mark,
    })),
    orders,
    lines,
    entries: [],
    operations,
    resources,
    laneCount: mode === 'unit' ? laneCount : outLanes.length,
    // Awaited last: it was started before the clipping and has had the whole
    // assembly to finish in, so on a warm connection it costs nothing here.
    plan: planPromise ? await planPromise : null,
    unitProgress,
    unitTonnes: Object.fromEntries(
      Object.entries(unitTonnes).map(([k, v]) => [k, Math.round(v * 1000) / 1000]),
    ),
    units: units.map((u) => ({
      key: u.key,
      anchorItemId: u.anchorItemId,
      laneIdx: u.laneIdx,
      startRel: u.startRel,
      endRel: u.endRel,
      runCount: u.runs.length,
      workMs: u.workMs,
      taskCount: u.taskCount,
    })),
    stats: {
      hours: Math.round(hours * 10) / 10,
      tonnes: degraded ? null : Math.round(tonnes * 1000) / 1000,
      taskCount: tasks.length,
      tasksCompleted,
      tasksStarted,
      reworkHours: Math.round(reworkHours * 10) / 10,
      ungroupedHours: Math.round(ungroupedHours * 10) / 10,
      machinesActive: new Set(tasks.map((t) => t.resourceId).filter((x) => x != null)).size,
      peakParallel: mode === 'unit' ? laneCount : 0,
      unitsCompleted,
      unitsStarted,
      unitsOpen,
      unitsCarriedIn,
      degraded,
    },
    timings: { ...marks, stats: Date.now() - mark0 },
  };
}
