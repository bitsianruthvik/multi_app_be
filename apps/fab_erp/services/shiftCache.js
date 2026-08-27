/**
 * shiftCache.js — the plant's working calendar, held in memory.
 *
 * WHY THIS EXISTS
 * ---------------
 * Profiling one girder drag on the production plan: 84 queries, 5.8 seconds,
 * essentially all of it waiting on the database. Fifty-two of those queries —
 * 3.1 of the 6.2 seconds — were these three tables:
 *
 *     fab_shift_calendars    18 calls   1090 ms
 *     fab_shifts             17 calls   1032 ms
 *     fab_calendar_days      17 calls    998 ms
 *
 * The tenant they were asked about has ONE calendar, ONE shift and ZERO
 * exception days. Three seconds of a planner's drag went on re-reading two rows,
 * fifty-two times, because the scheduler asks per resource and per capacity
 * window rather than once.
 *
 * WHY IT IS SAFE TO CACHE
 * -----------------------
 * This is the shape of the working week: which calendars a plant has, what
 * shifts they run, and which individual days are exceptions to that pattern.
 * Nothing in this application writes any of it — the tables are seeded, and a
 * shop's shift pattern changes on the order of twice a year. It is the most
 * static data the scheduler touches and the most frequently re-read.
 *
 * The whole thing is small by construction: a plant has a handful of calendars,
 * a few shifts each, and fab_calendar_days is an EXCEPTION list (a day is
 * working unless a row says otherwise — see the note at taskWaitService.js:24),
 * so it holds holidays, not every date. Loading all of it per company costs
 * three queries and a few kilobytes.
 *
 * INVALIDATION
 * ------------
 * A TTL, plus clearShiftCache() for anything that learns the calendar changed.
 * The TTL is the real safety net: nothing in this codebase mutates these tables
 * today, so the risk being covered is an edit made out of band — a migration, a
 * direct statement, or a shift-pattern screen that does not exist yet. Those
 * heal within a minute rather than needing a restart, which is the right trade
 * for data whose staleness costs a slightly wrong gap, not a wrong plan.
 */

import { pool } from '../../../db.js';
import logger from '../../../core/utils/logger.js';

/**
 * How long a snapshot is trusted.
 *
 * Deliberately short for something that changes twice a year. The cost of a
 * miss is three cheap queries; the cost of holding a stale calendar is a
 * planner being told a Saturday is workable when the holiday list says it is
 * not. Cheap to refresh, so refresh often.
 */
const TTL_MS = 60 * 1000;

/** companyId -> { at, byPlant, allIds, liveIds, shiftsByCalendar, daysByCalendar } */
const cache = new Map();

/** Drop the snapshot for one company, or all of them. */
export function clearShiftCache(companyId = null) {
  if (companyId == null) cache.clear();
  else cache.delete(Number(companyId));
}

function toYMD(d) {
  const dt = d instanceof Date ? d : new Date(d);
  const m = String(dt.getMonth() + 1).padStart(2, '0');
  const day = String(dt.getDate()).padStart(2, '0');
  return `${dt.getFullYear()}-${m}-${day}`;
}

/**
 * Everything about a company's working calendar, in three queries.
 *
 * Returned objects are SHARED with every other caller of this snapshot, so
 * treat them as read-only. Every consumer today only reads; anything that needs
 * to mutate should copy first.
 */
export async function shiftWorld(companyId) {
  const key = Number(companyId);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit;

  const world = {
    at: Date.now(),
    byPlant: new Map(),       // plantId -> [calendarId]
    allIds: [],               // every live calendar id
    liveIds: new Set(),       // membership test for an explicit calendar id
    shiftsByCalendar: {},     // calendarId -> [shift row]
    daysByCalendar: {},       // calendarId -> { 'YYYY-MM-DD': isWorking }
  };

  try {
    const [cals] = await pool.query(
      `SELECT id, plant_id AS plantId FROM fab_shift_calendars
        WHERE company_id = ? AND deleted_at IS NULL`,
      [key],
    );
    for (const c of cals) {
      const id = Number(c.id);
      world.allIds.push(id);
      world.liveIds.add(id);
      if (c.plantId != null) {
        const p = Number(c.plantId);
        if (!world.byPlant.has(p)) world.byPlant.set(p, []);
        world.byPlant.get(p).push(id);
      }
    }

    if (world.allIds.length > 0) {
      const [shifts] = await pool.query(
        `SELECT id, calendar_id, name, start_time, end_time, working_minutes
           FROM fab_shifts
          WHERE company_id = ? AND calendar_id IN (?) AND deleted_at IS NULL`,
        [key, world.allIds],
      );
      for (const s of shifts) {
        if (!world.shiftsByCalendar[s.calendar_id]) world.shiftsByCalendar[s.calendar_id] = [];
        world.shiftsByCalendar[s.calendar_id].push(s);
      }

      // The whole exception list, not a date range. It is holidays, not dates.
      const [days] = await pool.query(
        `SELECT calendar_id, day_date, is_working
           FROM fab_calendar_days
          WHERE company_id = ? AND calendar_id IN (?) AND deleted_at IS NULL`,
        [key, world.allIds],
      );
      for (const row of days) {
        const ymd = row.day_date instanceof Date ? toYMD(row.day_date) : String(row.day_date).slice(0, 10);
        if (!world.daysByCalendar[row.calendar_id]) world.daysByCalendar[row.calendar_id] = {};
        world.daysByCalendar[row.calendar_id][ymd] = !!row.is_working;
      }
    }
  } catch (err) {
    // A calendar that cannot be read must not take scheduling down: an empty
    // snapshot means "no shifts found", which every caller already handles.
    logger.warn({ err, companyId: key }, 'shiftCache: calendar load failed');
  }

  cache.set(key, world);
  return world;
}
