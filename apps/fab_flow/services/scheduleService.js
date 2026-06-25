import { pool } from '../../../db.js';

// ──────────────────────────────────────────────────────────────────────────────
//  Parallel SGS Scheduler — node-level task granularity
//
//  Each process step is expanded into one task per mapped node.
//  Tasks for the same step but different nodes are independent and can be
//  dispatched to different work areas simultaneously.
//  Duration always comes from node metrics × rate (no manual fallback).
// ──────────────────────────────────────────────────────────────────────────────

const DAY_NAMES = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

function dateStr(d) {
  const y  = d.getFullYear();
  const m  = String(d.getMonth() + 1).padStart(2, '0');
  const dy = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dy}`;
}
function addDays(d, n) { const r = new Date(d); r.setDate(r.getDate() + n); return r; }

function typeMatches(capability, processType) {
  if (!capability || !processType) return false;
  const cap = capability.toLowerCase().replace(/[-\s]/g, '');
  const pt  = processType.toLowerCase().replace(/[-\s]/g, '');
  return cap === pt || pt.endsWith(cap);
}

// ── Duration: always metric-based (node metric × rate) ───────────────────────
// Returns hours for a SINGLE node.
function getDurationHoursForNode(step, nodeId, metricsByNodeKey) {
  if (!step.time_metric_key || step.time_rate_value == null) return 0;
  const rate = parseFloat(step.time_rate_value) || 0;
  const v    = metricsByNodeKey.get(`${nodeId}:${step.time_metric_key}`);
  return v != null ? parseFloat(v) * rate : 0;
}

// ── Calendar helpers ──────────────────────────────────────────────────────────
async function loadCalendars(ids, conn) {
  if (ids.length === 0) return {};
  const [days] = await conn.query(
    'SELECT calendar_id, day_of_week, is_working_day, working_hours FROM fab_work_calendar_days WHERE calendar_id IN (?)',
    [ids],
  );
  const [excs] = await conn.query(
    `SELECT calendar_id, DATE_FORMAT(exception_date,'%Y-%m-%d') as exception_date, is_working_day, working_hours
     FROM fab_work_calendar_exceptions WHERE calendar_id IN (?)`,
    [ids],
  );
  const cals = {};
  for (const id of ids) {
    const dowHours = {};
    for (const d of days.filter(x => x.calendar_id === id))
      dowHours[d.day_of_week] = d.is_working_day ? parseFloat(d.working_hours) : 0;
    const excMap = {};
    for (const e of excs.filter(x => x.calendar_id === id))
      excMap[e.exception_date] = e.is_working_day ? parseFloat(e.working_hours) : 0;
    cals[id] = { dowHours, excMap };
  }
  return cals;
}
function getWorkingHours(date, cal) {
  if (!cal) return 8;
  const ds  = dateStr(date);
  if (ds in cal.excMap) return cal.excMap[ds];
  const dow = DAY_NAMES[date.getDay()];
  return cal.dowHours[dow] ?? 0;
}
function nextWorkingDayFrom(d, cal) {
  let cur = new Date(d.getTime());
  for (let i = 0; i < 60; i++) {
    if (getWorkingHours(cur, cal) > 0) return cur;
    cur = addDays(cur, 1);
  }
  return new Date(d.getTime());
}

// ── Task graph — one task per (step, node) ────────────────────────────────────
//
// Dependency rules:
//   1. Within the same node-prefix group, sequence_no creates a chain.
//      But the chain is node-aware: task (stepB, nodeN) depends only on
//      task (stepA, nodeN) from the previous seq level — NOT on tasks for
//      other nodes. This lets each node progress independently.
//   2. Explicit preconditions are also resolved node-by-node when possible.
//   3. Steps with no node maps get one placeholder task with zero duration.
function buildTaskGraph(steps, preconditions, nodeMapsByStep, metricsByNodeKey) {
  const tasksByStep = new Map();  // stepId → Task[]
  const tasks       = [];

  // Group steps by node prefix (strip trailing _NN)
  const groups = new Map();
  for (const s of steps) {
    const prefix = (s.process_step_code || '').replace(/_\d+$/, '') || `step_${s.id}`;
    if (!groups.has(prefix)) groups.set(prefix, []);
    groups.get(prefix).push(s);
  }

  for (const [nodePrefix, gSteps] of groups) {
    gSteps.sort((a, b) => a.sequence_no - b.sequence_no);

    // Build seq → [steps] map
    const seqMap = new Map();
    for (const s of gSteps) {
      if (!seqMap.has(s.sequence_no)) seqMap.set(s.sequence_no, []);
      seqMap.get(s.sequence_no).push(s);
    }
    const seqs = [...seqMap.keys()].sort((a, b) => a - b);

    // Expand each seq level into per-node tasks
    for (let i = 0; i < seqs.length; i++) {
      const seqNo    = seqs[i];
      const currTasks = [];

      for (const step of seqMap.get(seqNo)) {
        const maps        = nodeMapsByStep.get(step.id) ?? [];
        const workedNodes = maps.filter(m => m.node_role === 'Worked-On');
        const nodeMaps    = workedNodes.length > 0 ? workedNodes : maps;

        if (nodeMaps.length === 0) {
          // Step has no node maps — one placeholder task, zero duration
          const t = makeTask(step, null, nodePrefix, 0);
          tasks.push(t);
          currTasks.push(t);
          if (!tasksByStep.has(step.id)) tasksByStep.set(step.id, []);
          tasksByStep.get(step.id).push(t);
        } else {
          for (const nm of nodeMaps) {
            const dur = getDurationHoursForNode(step, nm.node_id, metricsByNodeKey);
            const t   = makeTask(step, nm.node_id, nodePrefix, dur);
            tasks.push(t);
            currTasks.push(t);
            if (!tasksByStep.has(step.id)) tasksByStep.set(step.id, []);
            tasksByStep.get(step.id).push(t);
          }
        }
      }

      // Chain to previous seq level (node-aware)
      if (i > 0) {
        const prevSeqTasks = seqMap.get(seqs[i - 1])
          .flatMap(s => tasksByStep.get(s.id) ?? []);

        // Build nodeId → [prevTasks] index for O(1) lookup
        const prevByNode = new Map();
        for (const p of prevSeqTasks) {
          if (!prevByNode.has(p.nodeId)) prevByNode.set(p.nodeId, []);
          prevByNode.get(p.nodeId).push(p);
        }

        for (const curr of currTasks) {
          // Prefer same-node predecessor; fall back to all prev if no match
          const matching = curr.nodeId != null ? (prevByNode.get(curr.nodeId) ?? []) : [];
          const deps     = matching.length > 0 ? matching : prevSeqTasks;
          for (const p of deps) {
            if (!curr.predecessors.includes(p)) { curr.predecessors.push(p); p.successors.push(curr); }
          }
        }
      }
    }
  }

  // Explicit precondition edges — node-aware
  for (const pc of preconditions) {
    const depTasks = tasksByStep.get(pc.process_step_id)         ?? [];
    const reqTasks = tasksByStep.get(pc.required_process_step_id) ?? [];
    if (!depTasks.length || !reqTasks.length) continue;

    const reqByNode = new Map();
    for (const r of reqTasks) {
      if (!reqByNode.has(r.nodeId)) reqByNode.set(r.nodeId, []);
      reqByNode.get(r.nodeId).push(r);
    }

    for (const dep of depTasks) {
      const matching = dep.nodeId != null ? (reqByNode.get(dep.nodeId) ?? []) : [];
      const srcs     = matching.length > 0 ? matching : reqTasks;
      for (const req of srcs) {
        if (dep === req || dep.predecessors.includes(req)) continue;
        dep.predecessors.push(req);
        req.successors.push(dep);
      }
    }
  }

  return tasks;
}

function makeTask(step, nodeId, nodePrefix, durationHours) {
  return {
    id:                  step.id,       // processStepId
    nodeId,                              // null or actual node id
    taskKey:             `${step.id}:${nodeId ?? 'null'}`,
    stepName:            step.process_name,
    nodePrefix,
    processType:         step.process_type,
    preferredWorkAreaId: step.preferred_work_area_id,
    durationHours,
    predecessors: [], successors: [],
    es: 0, ef: 0, ls: Infinity, lf: Infinity, totalFloat: 0,
    isCritical: false, scheduled: null,
  };
}

// ── CPM forward & backward pass ───────────────────────────────────────────────
function computeCPM(tasks) {
  const visited = new Set();
  function forward(t) {
    if (visited.has(t)) return;
    visited.add(t);
    for (const p of t.predecessors) forward(p);
    t.es = t.predecessors.length === 0 ? 0 : Math.max(...t.predecessors.map(p => p.ef));
    t.ef = t.es + (t.durationHours || 0);
  }
  for (const t of tasks) forward(t);

  const projectEF = tasks.length ? Math.max(...tasks.map(t => t.ef)) : 0;

  const back = new Set();
  function backward(t) {
    if (back.has(t)) return;
    back.add(t);
    for (const s of t.successors) backward(s);
    t.lf = t.successors.length === 0 ? projectEF : Math.min(...t.successors.map(s => s.ls));
    t.ls = t.lf - (t.durationHours || 0);
    t.totalFloat = t.lf - t.ef;
    t.isCritical = t.totalFloat <= 0.0001;
  }
  for (const t of tasks) backward(t);
}

// ── Work area selection ───────────────────────────────────────────────────────
function findEligibleWAs(task, workAreas) {
  const out = [];
  for (const wa of workAreas) {
    if (wa.id === task.preferredWorkAreaId) { out.unshift({ wa, score: 100 }); continue; }
    for (const cap of wa.capabilities) {
      if (typeMatches(cap, task.processType)) { out.push({ wa, score: 1 }); break; }
    }
  }
  return out.sort((a, b) => b.score - a.score).map(x => x.wa);
}

// ── Hour-based slot finder ────────────────────────────────────────────────────
function findEarliestHourSlot(wa, task, minStartDate, waSlotUse, cal) {
  const hoursNeeded = task.durationHours;
  if (hoursNeeded <= 0.0001) {
    const ds = dateStr(minStartDate);
    return { startDate: ds, endDate: ds, scheduledHours: 0, dayAllocations: [] };
  }
  const usePerDay      = waSlotUse.get(wa.id);
  const dayAllocations = [];
  let remaining = hoursNeeded;
  let cur = new Date(minStartDate.getTime());
  let firstDay = null;

  for (let iter = 0; iter < 1000 && remaining > 0.0001; iter++) {
    const ds     = dateStr(cur);
    const dayCap = getWorkingHours(cur, cal);
    if (dayCap > 0) {
      const dayTotal = dayCap * wa.max_parallel_jobs;
      const used     = usePerDay.get(ds) || 0;
      const free     = dayTotal - used;
      if (free > 0.0001) {
        const take = Math.min(remaining, dayCap, free);
        dayAllocations.push({ day: ds, hours: take });
        remaining -= take;
        if (firstDay === null) firstDay = ds;
      }
    }
    cur = addDays(cur, 1);
  }
  if (dayAllocations.length === 0) {
    const ds = dateStr(minStartDate);
    return { startDate: ds, endDate: ds, scheduledHours: hoursNeeded, dayAllocations: [{ day: ds, hours: hoursNeeded }] };
  }
  return {
    startDate:      dayAllocations[0].day,
    endDate:        dayAllocations[dayAllocations.length - 1].day,
    scheduledHours: hoursNeeded,
    dayAllocations,
  };
}

// ── Main scheduler ────────────────────────────────────────────────────────────
export async function buildSchedule(planId, companyId, opts = {}) {
  const conn = await pool.getConnection();
  try {
    const [[plan]] = await conn.query(
      `SELECT id, company_id, calendar_id,
              DATE_FORMAT(planned_start_date,'%Y-%m-%d') as planned_start_date
       FROM fab_project_plans WHERE id=? AND company_id=?`,
      [planId, companyId],
    );
    if (!plan) throw new Error('Plan not found');

    const [steps] = await conn.query(
      `SELECT id, process_step_code, process_name, process_type, sequence_no,
              preferred_work_area_id,
              time_calc_mode, time_metric_key, time_rate_value, time_rate_unit
       FROM fab_process_steps
       WHERE project_plan_id=? AND deleted_at IS NULL
       ORDER BY sequence_no, id`,
      [planId],
    );
    if (steps.length === 0) {
      return { totalTasks: 0, assignedTasks: 0, unassignedTasks: 0,
               startDate: plan.planned_start_date, endDate: plan.planned_start_date };
    }
    const stepIds = steps.map(s => s.id);

    // Node maps
    const [nodeMaps] = await conn.query(
      `SELECT process_step_id, node_id, node_role
       FROM fab_process_step_node_map
       WHERE process_step_id IN (?) AND deleted_at IS NULL`,
      [stepIds],
    );
    const nodeMapsByStep = new Map();
    for (const nm of nodeMaps) {
      if (!nodeMapsByStep.has(nm.process_step_id)) nodeMapsByStep.set(nm.process_step_id, []);
      nodeMapsByStep.get(nm.process_step_id).push(nm);
    }

    // Node metrics
    const involvedNodeIds = [...new Set(nodeMaps.map(nm => nm.node_id))];
    const metricsByNodeKey = new Map();
    if (involvedNodeIds.length > 0) {
      const [metricRows] = await conn.query(
        `SELECT node_id, metric_key, metric_value
         FROM fab_node_metrics
         WHERE node_id IN (?) AND deleted_at IS NULL`,
        [involvedNodeIds],
      );
      for (const r of metricRows)
        metricsByNodeKey.set(`${r.node_id}:${r.metric_key}`, r.metric_value);
    }

    // Preconditions
    const [preconditions] = await conn.query(
      `SELECT process_step_id, required_process_step_id
       FROM fab_process_preconditions
       WHERE process_step_id IN (?) AND deleted_at IS NULL AND required_process_step_id IS NOT NULL`,
      [stepIds],
    );

    // Work areas
    const [waRows] = await conn.query(
      `SELECT wa.id, wa.work_area_code, wa.work_area_name, wa.max_parallel_jobs, wa.calendar_id,
              GROUP_CONCAT(wac.process_type ORDER BY wac.priority SEPARATOR '||') as caps_raw
       FROM fab_work_areas wa
       LEFT JOIN fab_work_area_capabilities wac ON wac.work_area_id=wa.id AND wac.allowed=1 AND wac.deleted_at IS NULL
       WHERE wa.company_id=? AND wa.deleted_at IS NULL AND wa.active=1
       GROUP BY wa.id`,
      [companyId],
    );
    const workAreas = waRows.map(wa => ({
      ...wa,
      max_parallel_jobs: parseInt(wa.max_parallel_jobs, 10) || 1,
      capabilities: wa.caps_raw ? wa.caps_raw.split('||') : [],
    }));

    // Calendars
    const calendarIds  = [...new Set([plan.calendar_id, ...workAreas.map(w => w.calendar_id)].filter(Boolean))];
    const calendars    = await loadCalendars(calendarIds, conn);
    const defaultCal   = calendars[plan.calendar_id] ?? Object.values(calendars)[0] ?? null;

    // ── Re-plan: load progress and old schedule (keyed by taskKey = stepId:nodeId) ──
    const isReplan          = !!opts.fromDate;
    const completionByKey   = new Map();  // taskKey → 0..1
    const oldByKey          = new Map();  // taskKey → { wa, start, end, hours }

    if (isReplan) {
      // opts.progressMap (Map<taskKey,0..1>) takes priority over DB read.
      // Falls back to fab_node_process_progress for backwards-compat with old replan button.
      if (opts.progressMap instanceof Map) {
        for (const [k, v] of opts.progressMap)
          completionByKey.set(k, Math.max(0, Math.min(1, v)));
      } else {
        const [progress] = await conn.query(
          `SELECT process_step_id, node_id, batch_qty, completion_pct, snapshot_date
           FROM fab_node_process_progress
           WHERE plan_id=? AND deleted_at IS NULL`,
          [planId],
        );
        const latestDate = new Map();
        for (const p of progress) {
          const k  = `${p.process_step_id}:${p.node_id}`;
          const ds = String(p.snapshot_date);
          if (!latestDate.get(k) || ds > latestDate.get(k)) latestDate.set(k, ds);
        }
        const batches = new Map();
        for (const p of progress) {
          const k = `${p.process_step_id}:${p.node_id}`;
          if (String(p.snapshot_date) !== latestDate.get(k)) continue;
          if (!batches.has(k)) batches.set(k, []);
          batches.get(k).push(p);
        }
        for (const [k, bb] of batches) {
          const totQty = bb.reduce((s, x) => s + parseFloat(x.batch_qty), 0) || 1;
          const wtd    = bb.reduce((s, x) => s + parseFloat(x.batch_qty) * parseFloat(x.completion_pct), 0) / totQty;
          completionByKey.set(k, Math.max(0, Math.min(1, wtd / 100)));
        }
      }

      const [oldRows] = await conn.query(
        `SELECT process_step_id, node_id, work_area_id,
                DATE_FORMAT(scheduled_start,'%Y-%m-%d') as scheduled_start,
                DATE_FORMAT(scheduled_end,'%Y-%m-%d')   as scheduled_end,
                scheduled_hours
         FROM fab_schedule_tasks WHERE plan_id=? AND company_id=?`,
        [planId, companyId],
      );
      for (const r of oldRows) {
        oldByKey.set(`${r.process_step_id}:${r.node_id ?? 'null'}`, {
          wa: r.work_area_id, start: r.scheduled_start, end: r.scheduled_end,
          hours: parseFloat(r.scheduled_hours),
        });
      }
    }

    // Build task graph (node-level)
    const tasks = buildTaskGraph(steps, preconditions, nodeMapsByStep, metricsByNodeKey);

    // Scale remaining duration in re-plan mode
    if (isReplan) {
      for (const t of tasks) {
        const done = completionByKey.get(t.taskKey) ?? 0;
        t.completion    = done;
        t.durationHours = t.durationHours * (1 - done);
      }
    }

    computeCPM(tasks);

    // ── Parallel SGS dispatch ─────────────────────────────────────────────────
    const startDateStr  = plan.planned_start_date?.toString().slice(0, 10) ?? dateStr(new Date());
    const projectStart  = new Date(startDateStr + 'T00:00:00');
    const fromDate      = isReplan ? new Date(opts.fromDate + 'T00:00:00') : projectStart;

    const waSlotUse = new Map();
    for (const wa of workAreas) waSlotUse.set(wa.id, new Map());

    const results   = [];
    const scheduled = new Set();

    // Pre-process locked (in-progress / completed) tasks
    if (isReplan) {
      for (const t of tasks) {
        const done = t.completion ?? 0;
        const old  = oldByKey.get(t.taskKey);
        if (!old) continue;

        if (done >= 0.9999) {
          t.scheduled = { waId: old.wa, startDate: old.start, endDate: old.end,
                          scheduledHours: old.hours, dayAllocations: [] };
          scheduled.add(t);
          results.push(makeResult(t, planId, companyId, old.wa, old.start, old.end, old.hours));
        } else if (done > 0.0001) {
          const wa  = workAreas.find(w => w.id === old.wa);
          const cal = wa ? (calendars[wa.calendar_id] ?? defaultCal) : defaultCal;
          const startD = new Date(old.start + 'T00:00:00');
          if (wa) {
            const slot = findEarliestHourSlot(wa, t, startD, waSlotUse, cal);
            for (const a of slot.dayAllocations)
              waSlotUse.get(wa.id).set(a.day, (waSlotUse.get(wa.id).get(a.day) || 0) + a.hours);
            t.scheduled = { waId: wa.id, ...slot };
            results.push(makeResult(t, planId, companyId, wa.id, slot.startDate, slot.endDate, slot.scheduledHours));
          } else {
            t.scheduled = { waId: null, startDate: old.start, endDate: old.start, scheduledHours: t.durationHours, dayAllocations: [] };
            results.push(makeResult(t, planId, companyId, null, old.start, old.start, t.durationHours));
          }
          scheduled.add(t);
        }
      }
    }

    // Set minStart for ready tasks
    for (const t of tasks) {
      if (scheduled.has(t)) continue;
      if (t.predecessors.length === 0 || t.predecessors.every(p => scheduled.has(p))) {
        const predEnd = t.predecessors.length === 0 ? null
          : t.predecessors.map(p => p.scheduled?.endDate).reduce((m, d) => (m && m > d ? m : d), null);
        const base      = predEnd ? addDays(new Date(predEnd + 'T00:00:00'), 1) : fromDate;
        const effective = base < fromDate ? fromDate : base;
        t.minStart = nextWorkingDayFrom(effective, defaultCal);
      }
    }

    const ready = new Set(tasks.filter(t => !scheduled.has(t) && t.predecessors.every(p => scheduled.has(p))));

    let iter = 0;
    while (ready.size > 0 && iter++ < 20000) {
      const batch = [...ready].sort((a, b) => a.totalFloat - b.totalFloat || b.ef - a.ef);
      for (const task of batch) {
        ready.delete(task);
        if (scheduled.has(task)) continue;

        const eligible = findEligibleWAs(task, workAreas);
        let best = null;
        for (const wa of eligible) {
          const cal  = calendars[wa.calendar_id] ?? defaultCal;
          const slot = findEarliestHourSlot(wa, task, task.minStart, waSlotUse, cal);
          if (!best || slot.endDate < best.slot.endDate ||
              (slot.endDate === best.slot.endDate && slot.startDate < best.slot.startDate)) {
            best = { wa, slot };
          }
        }

        if (best) {
          const { wa, slot } = best;
          for (const a of slot.dayAllocations)
            waSlotUse.get(wa.id).set(a.day, (waSlotUse.get(wa.id).get(a.day) || 0) + a.hours);
          task.scheduled = { waId: wa.id, ...slot };
          results.push(makeResult(task, planId, companyId, wa.id, slot.startDate, slot.endDate, slot.scheduledHours));
        } else {
          const ds = dateStr(task.minStart);
          task.scheduled = { waId: null, startDate: ds, endDate: ds, dayAllocations: [] };
          results.push(makeResult(task, planId, companyId, null, ds, ds, task.durationHours));
        }
        scheduled.add(task);

        for (const s of task.successors) {
          if (scheduled.has(s) || ready.has(s)) continue;
          if (s.predecessors.every(p => scheduled.has(p))) {
            const latestEnd = s.predecessors
              .map(p => p.scheduled?.endDate ?? dateStr(projectStart))
              .reduce((m, d) => (d > m ? d : m));
            const cal  = calendars[s.preferredWorkAreaId
              ? (workAreas.find(w => w.id === s.preferredWorkAreaId)?.calendar_id) : null] ?? defaultCal;
            let base = addDays(new Date(latestEnd + 'T00:00:00'), 1);
            if (base < fromDate) base = fromDate;
            s.minStart = nextWorkingDayFrom(base, cal);
            ready.add(s);
          }
        }
      }
    }

    // Any remaining (cyclic / orphan) tasks
    for (const t of tasks) {
      if (!scheduled.has(t)) {
        const ds = dateStr(projectStart);
        results.push(makeResult(t, planId, companyId, null, ds, ds, t.durationHours));
      }
    }

    // Persist
    await conn.beginTransaction();
    await conn.query('DELETE FROM fab_schedule_tasks WHERE plan_id=? AND company_id=?', [planId, companyId]);
    if (results.length > 0) {
      await conn.query(
        `INSERT INTO fab_schedule_tasks
           (plan_id,company_id,node_prefix,node_id,process_step_id,work_area_id,
            scheduled_start,scheduled_end,scheduled_hours,is_critical,is_unassigned)
         VALUES ?`,
        [results.map(r => [r.planId, r.companyId, r.nodePrefix, r.nodeId ?? null, r.processStepId,
          r.workAreaId, r.scheduledStart, r.scheduledEnd, r.scheduledHours, r.isCritical, r.isUnassigned])],
      );
    }
    await conn.commit();

    const ends       = results.map(r => r.scheduledEnd);
    const projectEnd = ends.length > 0 ? ends.reduce((m, d) => (d > m ? d : m)) : startDateStr;
    return {
      totalTasks:      results.length,
      assignedTasks:   results.filter(r => !r.isUnassigned).length,
      unassignedTasks: results.filter(r => r.isUnassigned).length,
      criticalTasks:   results.filter(r => r.isCritical).length,
      startDate:       startDateStr,
      endDate:         projectEnd,
    };
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
}

function makeResult(task, planId, companyId, workAreaId, scheduledStart, scheduledEnd, scheduledHours) {
  return {
    planId, companyId,
    nodePrefix:     task.nodePrefix,
    nodeId:         task.nodeId ?? null,
    processStepId:  task.id,
    workAreaId,
    scheduledStart, scheduledEnd,
    scheduledHours,
    isCritical:   task.isCritical ? 1 : 0,
    isUnassigned: workAreaId ? 0 : 1,
  };
}

// ── Snapshot (call BEFORE overwriting fab_schedule_tasks) ────────────────────
export async function saveSnapshot(planId, companyId, triggeredBy = 'manual') {
  const snapshot = await getSchedule(planId, companyId);
  if (!snapshot) return null;
  const [[{ nextVer }]] = await pool.query(
    'SELECT COALESCE(MAX(version_no),0)+1 AS nextVer FROM fab_schedule_snapshots WHERE plan_id=?',
    [planId],
  );
  const [res] = await pool.query(
    `INSERT INTO fab_schedule_snapshots
       (plan_id, company_id, version_no, triggered_by, task_count, snapshot_data)
     VALUES (?,?,?,?,?,?)`,
    [planId, companyId, nextVer, triggeredBy, snapshot.tasks.length, JSON.stringify(snapshot)],
  );
  return { id: res.insertId, versionNo: nextVer };
}

// ── Read API ──────────────────────────────────────────────────────────────────
export async function getSchedule(planId, companyId) {
  const [rows] = await pool.query(
    `SELECT
       st.id, st.node_prefix, st.node_id, st.process_step_id,
       st.work_area_id, st.is_critical, st.is_unassigned, st.scheduled_hours,
       DATE_FORMAT(st.scheduled_start,'%Y-%m-%d') as scheduled_start,
       DATE_FORMAT(st.scheduled_end,  '%Y-%m-%d') as scheduled_end,
       ps.process_name as step_name, ps.process_type,
       wa.work_area_code, wa.work_area_name,
       COALESCE(fn.display_name, st.node_prefix) as node_display
     FROM fab_schedule_tasks st
     JOIN fab_process_steps ps ON ps.id = st.process_step_id
     LEFT JOIN fab_work_areas wa ON wa.id = st.work_area_id
     LEFT JOIN fab_nodes fn ON fn.id = st.node_id AND fn.deleted_at IS NULL
     WHERE st.plan_id=? AND st.company_id=?
     ORDER BY st.scheduled_start, st.node_prefix`,
    [planId, companyId],
  );
  if (rows.length === 0) return null;

  const waMap = new Map();
  for (const r of rows) {
    if (r.work_area_id && !waMap.has(r.work_area_id))
      waMap.set(r.work_area_id, { id: r.work_area_id, code: r.work_area_code, name: r.work_area_name });
  }
  const waIds = [...waMap.keys()];
  const [waDetail] = waIds.length > 0
    ? await pool.query('SELECT id, max_parallel_jobs FROM fab_work_areas WHERE id IN (?)', [waIds])
    : [[]];
  const workAreas = [...waMap.values()].map(wa => ({
    ...wa,
    maxParallelJobs: waDetail.find(w => w.id === wa.id)?.max_parallel_jobs ?? 1,
  }));

  const starts  = rows.map(r => r.scheduled_start);
  const ends    = rows.map(r => r.scheduled_end);
  const minDate = starts.reduce((m, d) => (d < m ? d : m));
  const maxDt   = ends.reduce((m, d) => (d > m ? d : m));

  return {
    startDate: minDate,
    endDate:   maxDt,
    workAreas,
    tasks: rows.map(r => ({
      id:             r.id,
      nodePrefix:     r.node_prefix,
      nodeId:         r.node_id ?? null,
      nodeDisplay:    r.node_display,
      processStepId:  r.process_step_id,
      stepName:       r.step_name,
      processType:    r.process_type,
      workAreaId:     r.work_area_id,
      workAreaCode:   r.work_area_code,
      workAreaName:   r.work_area_name,
      startDate:      r.scheduled_start,
      endDate:        r.scheduled_end,
      scheduledHours: parseFloat(r.scheduled_hours) || 0,
      isCritical:     !!r.is_critical,
      isUnassigned:   !!r.is_unassigned,
    })),
  };
}
