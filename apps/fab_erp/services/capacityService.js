// capacityService.js — per-shift capacity / overload / free-slot service.
// EU-D2  (PER-SHIFT granularity)
//
// RESOURCE ↔ SHIFT ASSOCIATION ASSUMPTION
// ─────────────────────────────────────────
// The schema does NOT store a direct link between a fab_resource and a
// fab_shift_calendar.  This service resolves that gap as follows:
//
//   • The caller MUST supply `calendarId` (or we query all calendars for the
//     company).  A calendar owns N shifts via fab_shifts.calendar_id.
//   • ALL in-scope resources are treated as operating under EVERY shift of the
//     selected calendar(s).  This is the standard "plant-wide calendar" model:
//     a fab_shift_calendar is linked to a fab_plant; resources have a plant_id;
//     so if both the calendar and the resource belong to the same plant they
//     share those shifts.  We enforce this via an optional plantId filter —
//     when plantId is supplied we filter both resources and calendars to that
//     plant, tightening the association.  When neither calendarId nor plantId
//     is supplied we return all company resources × all company shifts (broad).
//
// FALLBACK FOR EMPTY fab_calendar_days
// ──────────────────────────────────────
// If a calendar has NO rows in fab_calendar_days for the requested window, we
// treat EVERY date in [from, to] as a working day (optimistic fallback).
// This is documented here and in the returned `meta.workingDaysFallback` flag.
//
// DEFAULT DATE WINDOW: today → today + 13 days (14 days inclusive).

import { pool } from '../../../db.js';

// ─── helpers ────────────────────────────────────────────────────────────────

/**
 * Return an array of YYYY-MM-DD strings for every day in [from, to] inclusive.
 */
function allDatesInRange(from, to) {
  const dates = [];
  const cur = new Date(from + 'T00:00:00Z');
  const end = new Date(to + 'T00:00:00Z');
  while (cur <= end) {
    dates.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return dates;
}

/**
 * Format a JS Date to YYYY-MM-DD in UTC.
 */
function toYMD(d) {
  return d.toISOString().slice(0, 10);
}

// ─── main export ────────────────────────────────────────────────────────────

/**
 * Compute per-(resource × shift × date) capacity rows.
 *
 * @param {number} companyId
 * @param {object} opts
 * @param {string}  [opts.from]           YYYY-MM-DD  (default: today)
 * @param {string}  [opts.to]             YYYY-MM-DD  (default: today + 13 d)
 * @param {number}  [opts.calendarId]     restrict to one shift calendar
 * @param {number}  [opts.resourceTypeId] restrict to one resource type
 * @param {number}  [opts.plantId]        restrict to one plant
 * @returns {Promise<{ rows: object[], freeSlots: object[], meta: object }>}
 */
export async function getCapacity(companyId, {
  from,
  to,
  calendarId,
  resourceTypeId,
  plantId,
} = {}) {

  // ── 1. Default date window ────────────────────────────────────────────────
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const defaultFrom = toYMD(today);
  const defaultTo   = toYMD(new Date(today.getTime() + 13 * 86_400_000));

  const dateFrom = from || defaultFrom;
  const dateTo   = to   || defaultTo;

  // ── 2. Fetch in-scope resources ───────────────────────────────────────────
  const resourceParams = [companyId];
  let resourceSql = `
    SELECT r.id, r.name, r.resource_type_id, r.plant_id
    FROM   fab_resources r
    WHERE  r.company_id = ?
      AND  r.deleted_at IS NULL
  `;
  if (resourceTypeId) {
    resourceSql += ' AND r.resource_type_id = ?';
    resourceParams.push(resourceTypeId);
  }
  if (plantId) {
    resourceSql += ' AND r.plant_id = ?';
    resourceParams.push(plantId);
  }

  const [resourceRows] = await pool.query(resourceSql, resourceParams);
  if (resourceRows.length === 0) {
    return { rows: [], freeSlots: [], meta: { dateFrom, dateTo, workingDaysFallback: false } };
  }

  // ── 3. Fetch in-scope shifts (via calendars) ──────────────────────────────
  const shiftParams = [companyId];
  let shiftSql = `
    SELECT s.id AS shiftId, s.name AS shiftName, s.working_minutes,
           s.calendar_id,
           sc.plant_id AS calendarPlantId
    FROM   fab_shifts s
    JOIN   fab_shift_calendars sc ON sc.id = s.calendar_id
    WHERE  s.company_id  = ?
      AND  s.deleted_at  IS NULL
      AND  sc.deleted_at IS NULL
  `;
  if (calendarId) {
    shiftSql += ' AND s.calendar_id = ?';
    shiftParams.push(calendarId);
  }
  if (plantId) {
    shiftSql += ' AND sc.plant_id = ?';
    shiftParams.push(plantId);
  }

  const [shiftRows] = await pool.query(shiftSql, shiftParams);
  if (shiftRows.length === 0) {
    return { rows: [], freeSlots: [], meta: { dateFrom, dateTo, workingDaysFallback: false } };
  }

  // ── 4. Determine working dates per calendar ───────────────────────────────
  // Collect distinct calendar IDs referenced by the fetched shifts.
  const calendarIds = [...new Set(shiftRows.map(s => s.calendar_id))];

  const [calDayRows] = await pool.query(
    `SELECT calendar_id, day_date
     FROM   fab_calendar_days
     WHERE  company_id  = ?
       AND  calendar_id IN (?)
       AND  day_date    BETWEEN ? AND ?
       AND  is_working  = 1
       AND  deleted_at  IS NULL`,
    [companyId, calendarIds, dateFrom, dateTo],
  );

  // Build a set per calendar: calendarWorkingDays[calId] = Set<'YYYY-MM-DD'>
  const calendarWorkingDays = {};
  let anyCalHasDays = false;
  for (const row of calDayRows) {
    const ymd = row.day_date instanceof Date
      ? toYMD(row.day_date)
      : String(row.day_date).slice(0, 10);
    if (!calendarWorkingDays[row.calendar_id]) {
      calendarWorkingDays[row.calendar_id] = new Set();
    }
    calendarWorkingDays[row.calendar_id].add(ymd);
    anyCalHasDays = true;
  }

  // Fallback: calendars with no day rows → treat entire range as working.
  const fallbackDates = new Set(allDatesInRange(dateFrom, dateTo));
  let workingDaysFallback = false;
  for (const cid of calendarIds) {
    if (!calendarWorkingDays[cid]) {
      calendarWorkingDays[cid] = fallbackDates;
      workingDaysFallback = true;
    }
  }

  // ── 5. Fetch resource assignments + planned_hours in [from, to] ───────────
  const resourceIds = resourceRows.map(r => r.id);
  const shiftIds    = shiftRows.map(s => s.shiftId);

  const [assignRows] = await pool.query(
    `SELECT
       ra.resource_id,
       ra.assigned_shift_id,
       ra.assigned_date,
       po.planned_hours
     FROM   fab_resource_assignments ra
     JOIN   fab_planned_operations   po
            ON po.id          = ra.planned_operation_id
           AND po.deleted_at  IS NULL
     WHERE  ra.company_id    = ?
       AND  ra.deleted_at    IS NULL
       AND  ra.resource_id   IN (?)
       AND  ra.assigned_shift_id IN (?)
       AND  ra.assigned_date BETWEEN ? AND ?`,
    [companyId, resourceIds, shiftIds, dateFrom, dateTo],
  );

  // ── 6. Aggregate load per (resource, shift, date) ─────────────────────────
  // key = `${resourceId}|${shiftId}|${date}`
  const loadMap = {};
  for (const ar of assignRows) {
    const ymd = ar.assigned_date instanceof Date
      ? toYMD(ar.assigned_date)
      : String(ar.assigned_date).slice(0, 10);
    const key = `${ar.resource_id}|${ar.assigned_shift_id}|${ymd}`;
    loadMap[key] = (loadMap[key] || 0) + Number(ar.planned_hours || 0) * 60;
  }

  // ── 7. Build result rows (cross-product: resource × shift × workingDate) ──
  // Index shifts by id for O(1) lookup.
  const shiftById = {};
  for (const s of shiftRows) shiftById[s.shiftId] = s;

  const rows = [];

  for (const resource of resourceRows) {
    for (const shift of shiftRows) {
      const workingDates = calendarWorkingDays[shift.calendar_id];
      if (!workingDates) continue;

      for (const date of workingDates) {
        const key             = `${resource.id}|${shift.shiftId}|${date}`;
        const availableMinutes = shift.working_minutes;
        const loadMinutes      = loadMap[key] || 0;
        const freeMinutes      = Math.max(0, availableMinutes - loadMinutes);
        const overload         = loadMinutes > availableMinutes;

        rows.push({
          resourceId      : resource.id,
          resourceName    : resource.name,
          resourceTypeId  : resource.resource_type_id,
          shiftId         : shift.shiftId,
          shiftName       : shift.shiftName,
          date,
          availableMinutes,
          loadMinutes,
          freeMinutes,
          overload,
        });
      }
    }
  }

  // Sort by date → resource → shift for predictable output.
  rows.sort((a, b) =>
    a.date.localeCompare(b.date) ||
    a.resourceId - b.resourceId  ||
    a.shiftId    - b.shiftId,
  );

  const freeSlots = rows.filter(r => r.freeMinutes > 0);

  return {
    rows,
    freeSlots,
    meta: {
      dateFrom,
      dateTo,
      totalRows      : rows.length,
      overloadedRows : rows.filter(r => r.overload).length,
      freeSlotCount  : freeSlots.length,
      workingDaysFallback,
    },
  };
}
