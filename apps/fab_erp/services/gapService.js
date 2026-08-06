/**
 * gapService.js — the unaccounted time on one machine, on one day.
 *
 * This is the read side of the gap table: what the working day was, what is
 * already explained, and what is left over. The leftover IS
 * `unexplained_idle` — not a UI construct — so when it disappears from the
 * screen the segment genuinely stops existing.
 *
 * A LEFTOVER GAP IS A LEGITIMATE END STATE. Nothing here pushes toward zero and
 * nothing blocks on it. Forcing a supervisor to account for every minute
 * manufactures fiction, and fiction in this stream flows into
 * `fab_operation_stats` and every future estimate — the number would get
 * prettier and the plant would get less predictable. See FAB_ERP_PEOPLE_PLAN §0.
 */

import { pool } from '../../../db.js';
import { resolveCapacityForResource, capacityIntervals } from './capacityService.js';
import { mergeIntervals } from './taskWaitService.js';
import { zonedWallClockToUtc, calendarTimezones, tzForCalendar, DEFAULT_TZ } from './plantTime.js';
import { reasonCatalogue, SCOPE_SITE, SCOPE_MACHINE, SCOPE_TASK } from './gapReasons.js';

const sqlUtc = (d) => new Date(d).toISOString().slice(0, 19).replace('T', ' ');

/** The parts of one interval that fall inside any of `working`. */
function intersectWorking(iv, working) {
  const out = [];
  for (const w of working) {
    const s = iv.start > w.start ? iv.start : w.start;
    const e = iv.end < w.end ? iv.end : w.end;
    if (e > s) out.push({ start: s, end: e });
  }
  return out;
}

/** Subtract `cut` from `base`; both normalised, result non-overlapping. */
function subtract(base, cut) {
  const B = mergeIntervals(base);
  const C = mergeIntervals(cut);
  const out = [];
  for (const b of B) {
    let cur = b.start;
    for (const c of C) {
      if (c.end <= cur) continue;
      if (c.start >= b.end) break;
      if (c.start > cur) out.push({ start: cur, end: c.start < b.end ? c.start : b.end });
      if (c.end > cur) cur = c.end;
      if (cur >= b.end) break;
    }
    if (cur < b.end) out.push({ start: cur, end: b.end });
  }
  return out.filter((iv) => iv.end > iv.start);
}

/**
 * The plant-local day boundaries for a machine.
 *
 * A day is a local concept — "the 11th" at the site, not a UTC span. Using UTC
 * would slice an Indian day at 05:30 and put the morning of one shift on the
 * previous sheet.
 */
export async function dayBoundsForResource(companyId, resourceId, date) {
  const [[row]] = await pool.query(
    `SELECT r.plant_id AS plantId, r.shift_calendar_id AS calId, r.name
       FROM fab_resources r
      WHERE r.id = ? AND r.company_id = ? AND r.deleted_at IS NULL`,
    [resourceId, companyId],
  );
  if (!row) return null;

  // Resolve the zone the SAME way capacity resolves calendars: the machine's own
  // calendar, then any calendar on its plant, then the company default.
  //
  // Reading only the machine's own `shift_calendar_id` was wrong and visibly so:
  // a machine with no calendar of its own still gets its working intervals from
  // its plant's calendar (resolveCalendarIds widens), so it would show a correct
  // IST working day with every time rendered in UTC — the day would be right and
  // every clock face on it wrong.
  const tzMap = await calendarTimezones(companyId);
  let calId = row.calId;
  if (!calId && row.plantId != null) {
    const [[viaPlant]] = await pool.query(
      `SELECT id FROM fab_shift_calendars
        WHERE company_id = ? AND plant_id = ? AND deleted_at IS NULL LIMIT 1`,
      [companyId, row.plantId],
    );
    calId = viaPlant?.id ?? null;
  }
  const tz = calId
    ? tzForCalendar(tzMap, calId)
    : (tzMap.get('__default') ?? DEFAULT_TZ);

  const start = zonedWallClockToUtc(date, '00:00:00', tz);
  const nextDay = new Date(`${date}T00:00:00Z`);
  nextDay.setUTCDate(nextDay.getUTCDate() + 1);
  const end = zonedWallClockToUtc(nextDay.toISOString().slice(0, 10), '00:00:00', tz);
  return { start, end, tz, plantId: row.plantId, resourceName: row.name };
}

/**
 * Everything the gap table needs for one machine-day.
 *
 * `explained` rows are what has already been asserted or derived, each carrying
 * the stream it came from so the UI can offer to withdraw it. `gaps` is what
 * remains of the working day.
 */
export async function dayGaps(companyId, resourceId, date) {
  const bounds = await dayBoundsForResource(companyId, resourceId, date);
  if (!bounds) return null;
  const { start, end } = bounds;

  // The working day itself. No shift ⇒ no working time ⇒ nothing to explain;
  // an empty day is not a gap, it is a day the plant was not open.
  const cap = await resolveCapacityForResource(companyId, resourceId, bounds.plantId);
  const working = await capacityIntervals(companyId, cap, start, end);

  const catalogue = await reasonCatalogue(companyId);
  const labelFor = (code) => catalogue.find((r) => r.code === code)?.label ?? code;

  const explained = [];

  // 1. Work actually done on this machine — tasks that ran. Not a "gap reason",
  //    but it must be shown, or the sheet asks the supervisor to explain time
  //    the machine was busy producing.
  const [work] = await pool.query(
    `SELECT t.id AS taskId, t.started_at AS fromTs,
            COALESCE(t.completed_at, ?) AS toTs, o.name AS operationName
       FROM fab_project_tasks t
       LEFT JOIN fab_operations o ON o.id = t.operation_id
      WHERE t.company_id = ? AND t.assigned_resource_id = ? AND t.deleted_at IS NULL
        AND t.started_at IS NOT NULL AND t.started_at < ?
        AND (t.completed_at IS NULL OR t.completed_at > ?)`,
    [sqlUtc(end), companyId, resourceId, sqlUtc(end), sqlUtc(start)],
  );
  for (const w of work) {
    // CLAMP to the day. A task that started three weeks ago and is still open
    // otherwise reports its whole life as this day's explained time — 28,961
    // minutes against a 480-minute shift, which swallows the sheet and leaves a
    // zero gap on a day nothing happened.
    const f = new Date(w.fromTs);
    const t = new Date(w.toTs);
    explained.push({
      kind: 'work', stream: 'task', label: w.operationName ?? `Task #${w.taskId}`,
      taskId: w.taskId,
      from: f < start ? start : f,
      to: t > end ? end : t,
      code: null, removable: false,
    });
  }

  // 2. Machine-scope assertions.
  const [dn] = await pool.query(
    `SELECT id, state, reason_code AS code, at FROM fab_resource_events
      WHERE company_id = ? AND resource_id = ? AND deleted_at IS NULL
        AND superseded_by_event_id IS NULL AND at < ?
      ORDER BY at ASC`,
    [companyId, resourceId, sqlUtc(end)],
  );
  for (let i = 0; i < dn.length; i++) {
    if (dn[i].state !== 'down' && dn[i].state !== 'off') continue;
    const f = new Date(dn[i].at);
    const t = i + 1 < dn.length ? new Date(dn[i + 1].at) : end;
    if (t <= start || f >= end) continue;
    explained.push({
      kind: 'machine', stream: 'resource', id: dn[i].id,
      code: dn[i].code, label: labelFor(dn[i].code ?? dn[i].state),
      from: f < start ? start : f, to: t > end ? end : t, removable: true,
    });
  }

  // 3. Site-scope assertions — one row covers every machine at the plant.
  const [pe] = await pool.query(
    `SELECT id, event_code AS code, from_ts AS fromTs, to_ts AS toTs
       FROM fab_plant_events
      WHERE company_id = ? AND plant_id = ? AND deleted_at IS NULL
        AND superseded_by_id IS NULL AND from_ts < ? AND (to_ts IS NULL OR to_ts > ?)`,
    [companyId, bounds.plantId, sqlUtc(end), sqlUtc(start)],
  );
  for (const p of pe) {
    explained.push({
      kind: 'site', stream: 'plant', id: p.id, code: p.code, label: labelFor(p.code),
      from: new Date(p.fromTs) < start ? start : new Date(p.fromTs),
      to: !p.toTs || new Date(p.toTs) > end ? end : new Date(p.toTs), removable: true,
    });
  }

  // 4. Task-scope holds, for tasks sitting on this machine.
  const [th] = await pool.query(
    `SELECT h.id, h.hold_code AS code, h.task_id AS taskId, h.party,
            h.from_ts AS fromTs, h.to_ts AS toTs
       FROM fab_task_holds h
       JOIN fab_project_tasks t ON t.id = h.task_id AND t.assigned_resource_id = ?
      WHERE h.company_id = ? AND h.deleted_at IS NULL AND h.superseded_by_id IS NULL
        AND h.from_ts < ? AND (h.to_ts IS NULL OR h.to_ts > ?)`,
    [resourceId, companyId, sqlUtc(end), sqlUtc(start)],
  );
  for (const h of th) {
    explained.push({
      kind: 'task', stream: 'hold', id: h.id, code: h.code, taskId: h.taskId,
      label: labelFor(h.code) + (h.party ? ` — ${h.party}` : ''),
      from: new Date(h.fromTs) < start ? start : new Date(h.fromTs),
      to: !h.toTs || new Date(h.toTs) > end ? end : new Date(h.toTs), removable: true,
    });
  }

  explained.sort((a, b) => a.from - b.from);

  // What is left of the working day. This IS the unexplained_idle the engine
  // computes — the table is a view of the model, not a parallel calculation.
  const gaps = subtract(working, explained.map((e) => ({ start: e.from, end: e.to })));

  const mins = (list, s = 'start', e = 'end') =>
    Math.round(list.reduce((a, x) => a + (x[e] - x[s]) / 60000, 0));

  // Explained minutes are counted over the MERGED union, and only the part that
  // overlaps the working day. Two explanations touching the same minute is one
  // explained minute, and time asserted outside the shift is not shift time
  // reclaimed — without both, explained + gap stops equalling working and the
  // arithmetic on screen visibly fails to add up.
  const explainedInDay = mergeIntervals(
    explained.map((e) => ({ start: e.from, end: e.to })),
  ).flatMap((iv) => intersectWorking(iv, working));

  return {
    resourceId,
    resourceName: bounds.resourceName,
    date,
    timezone: bounds.tz,
    dayStart: start,
    dayEnd: end,
    workingMinutes: mins(working),
    explainedMinutes: mins(explainedInDay),
    gapMinutes: mins(gaps),
    working,
    explained,
    gaps,
  };
}

/** Which stream a reason writes to, and whether it needs a task. */
export function streamForScope(scope) {
  if (scope === SCOPE_SITE) return 'plant';
  if (scope === SCOPE_TASK) return 'hold';
  if (scope === SCOPE_MACHINE) return 'resource';
  return null;
}
