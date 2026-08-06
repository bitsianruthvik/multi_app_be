/**
 * plantTime.js — the factory's clock, as distinct from the server's.
 *
 * THE BUG THIS EXISTS TO FIX
 * -------------------------
 * `fab_shifts.start_time` is a TIME column holding what is written on the board:
 * "the day shift runs 08:00 to 17:00". Until now the calendar walk built that as
 * `new Date(\`${date}T08:00:00Z\`)` — i.e. it read the floor's wall clock as UTC.
 *
 * On a UTC server with a UTC factory that is harmless, which is why it survived.
 * Prod runs on Render + TiDB, both UTC, while the plant is in India: so a shift
 * the floor means as 08:00–17:00 IST was evaluated as 08:00–17:00 UTC, i.e.
 * 13:30–22:30 IST. Every derived number inherited that 5½-hour error — `no_shift`
 * attribution, the coverage meter, and (since capacity_mode='crew') the
 * scheduling calendar itself.
 *
 * The timezone belongs to the PLANT, not the server and not the company: a
 * company can run sites in different zones, and a shift means what it means at
 * the site where people physically turn up.
 *
 * WHY Intl AND NOT A LIBRARY
 * --------------------------
 * Node ships full ICU, so `Intl.DateTimeFormat` already knows every IANA zone
 * and its historical DST rules. Adding a date library for two functions would be
 * a dependency to keep current for no additional correctness.
 */

import { pool } from '../../../db.js';
import { logger } from '../../../core/utils/logger.js';

export const DEFAULT_TZ = 'UTC';

/** Cheap validity check — an unknown zone must not take the scheduler down. */
export function isValidTimeZone(tz) {
  if (!tz || typeof tz !== 'string') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const partsCache = new Map();
function formatterFor(timeZone) {
  let f = partsCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    partsCache.set(timeZone, f);
  }
  return f;
}

/**
 * How far ahead of UTC `timeZone` is AT THIS INSTANT, in ms.
 *
 * Computed by formatting the instant in the target zone and reading the result
 * back as if it were UTC; the difference is the offset. This is instant-specific
 * on purpose, so DST is handled by ICU rather than by us assuming a fixed offset.
 */
export function tzOffsetMs(date, timeZone) {
  const parts = Object.fromEntries(
    formatterFor(timeZone).formatToParts(date).map((p) => [p.type, p.value]),
  );
  // Some ICU builds render midnight as hour '24'; normalise before arithmetic.
  const hour = parts.hour === '24' ? 0 : Number(parts.hour);
  const asIfUtc = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    hour, Number(parts.minute), Number(parts.second),
  );
  return asIfUtc - date.getTime();
}

/** The local calendar date ('YYYY-MM-DD') an instant falls on, in `timeZone`. */
export function zonedYMD(date, timeZone) {
  // en-CA formats as YYYY-MM-DD, which is exactly the shape the calendar tables
  // and the day-walk already use.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
}

/**
 * The UTC instant at which local wall-clock `ymd hms` occurs in `timeZone`.
 *
 * Two passes, because the offset depends on the instant we are trying to find:
 * guess by treating the wall clock as UTC, look up the offset there, correct,
 * then re-check at the corrected instant. The second pass is what makes DST
 * transitions come out right — near a spring-forward the first guess can land on
 * the wrong side of the jump.
 *
 * Edge behaviour, measured rather than assumed:
 *   - A NONEXISTENT local time (the hour skipped by spring-forward) resolves to
 *     the instant immediately before the gap — 2026-03-08 02:30 in New York
 *     comes back as 06:30Z, i.e. 01:30 EST.
 *   - An AMBIGUOUS local time (the hour repeated by fall-back) resolves to the
 *     FIRST occurrence — 2026-11-01 01:30 comes back as 05:30Z, i.e. 01:30 EDT.
 *
 * Both are well-defined instants adjacent to the discontinuity rather than
 * throws, which is what a shift boundary needs: a scheduler must not fall over
 * twice a year. Neither case is reachable at all in a zone without DST — which
 * India, the case this was written for, is.
 */
export function zonedWallClockToUtc(ymd, hms, timeZone) {
  const naive = new Date(`${ymd}T${hms}Z`);
  if (Number.isNaN(naive.getTime())) return null;

  const firstGuess = new Date(naive.getTime() - tzOffsetMs(naive, timeZone));
  const secondOffset = tzOffsetMs(firstGuess, timeZone);
  const corrected = new Date(naive.getTime() - secondOffset);
  return corrected;
}

// ─── resolving which zone a calendar runs on ────────────────────────────────

const tzCache = new Map();          // companyId -> { map, at }
const TZ_TTL_MS = 60_000;

export function clearPlantTimezoneCache(companyId) {
  if (companyId == null) tzCache.clear();
  else tzCache.delete(Number(companyId));
}

/**
 * calendarId → IANA zone, for every calendar in a company.
 *
 * Resolution order, widening: the calendar's plant's `timezone`, then the
 * company default (`fab_company_settings.timezone`), then UTC. A calendar with
 * no plant is a company-wide calendar and takes the company default.
 *
 * UTC is the last resort rather than the server's zone deliberately — falling
 * back to the host would make the same data mean different things on a laptop
 * and on Render, which is the class of bug this module exists to end.
 */
export async function calendarTimezones(companyId) {
  const key = Number(companyId);
  const hit = tzCache.get(key);
  if (hit && Date.now() - hit.at < TZ_TTL_MS) return hit.map;

  const map = new Map();
  let companyDefault = DEFAULT_TZ;
  try {
    const [[row]] = await pool.query(
      `SELECT setting_value AS v FROM fab_company_settings
        WHERE company_id = ? AND setting_key = 'timezone' AND deleted_at IS NULL`,
      [key],
    );
    if (isValidTimeZone(row?.v)) companyDefault = row.v;

    const [cals] = await pool.query(
      `SELECT c.id, p.timezone AS plantTz
         FROM fab_shift_calendars c
         LEFT JOIN fab_plants p ON p.id = c.plant_id AND p.deleted_at IS NULL
        WHERE c.company_id = ? AND c.deleted_at IS NULL`,
      [key],
    );
    for (const c of cals) {
      map.set(Number(c.id), isValidTimeZone(c.plantTz) ? c.plantTz : companyDefault);
    }
  } catch (err) {
    // A missing column or table (migration not yet applied) must not take
    // scheduling down — everything falls back to UTC, i.e. the old behaviour.
    logger.warn({ err, companyId }, 'plantTime: timezone lookup failed, falling back to UTC');
  }

  map.set('__default', companyDefault);
  tzCache.set(key, { map, at: Date.now() });
  return map;
}

/** Zone for one calendar, with the company default as the fallback. */
export function tzForCalendar(tzMap, calendarId) {
  return tzMap.get(Number(calendarId)) ?? tzMap.get('__default') ?? DEFAULT_TZ;
}

/**
 * The zone a PERSON's times should be read in.
 *
 * Times typed into the People screen ("away 12:30–17:00") are wall clock at the
 * site, not at whoever is holding the laptop. Resolving them in the browser's
 * zone is only correct while the supervisor happens to sit in the same country
 * as the plant — which is an assumption, not a fact, and silently wrong by the
 * offset when it breaks.
 *
 * Widening: the plant behind their SHIFT's calendar (the shift is the thing the
 * times relate to), then the plant of the machine they are assigned to, then the
 * company default, then UTC.
 */
export async function timezoneForWorker(companyId, workerId) {
  const tzMap = await calendarTimezones(companyId);
  const fallback = tzMap.get('__default') ?? DEFAULT_TZ;
  try {
    const [[row]] = await pool.query(
      `SELECT sh.calendar_id AS calendarId, rp.timezone AS resourcePlantTz
         FROM fab_workers w
         LEFT JOIN fab_worker_shifts ws
                ON ws.worker_id = w.id AND ws.deleted_at IS NULL
               AND ws.superseded_by_id IS NULL AND ws.to_ts IS NULL
         LEFT JOIN fab_shifts sh ON sh.id = ws.shift_id AND sh.deleted_at IS NULL
         LEFT JOIN fab_worker_assignments a
                ON a.worker_id = w.id AND a.kind = 'assigned' AND a.deleted_at IS NULL
               AND a.superseded_by_id IS NULL AND a.to_ts IS NULL
         LEFT JOIN fab_resources r ON r.id = a.resource_id AND r.deleted_at IS NULL
         LEFT JOIN fab_plants rp ON rp.id = r.plant_id AND rp.deleted_at IS NULL
        WHERE w.id = ? AND w.company_id = ? AND w.deleted_at IS NULL
        LIMIT 1`,
      [workerId, companyId],
    );
    if (row?.calendarId != null) {
      const viaShift = tzMap.get(Number(row.calendarId));
      if (isValidTimeZone(viaShift)) return viaShift;
    }
    if (isValidTimeZone(row?.resourcePlantTz)) return row.resourcePlantTz;
  } catch (err) {
    logger.warn({ err, companyId, workerId }, 'plantTime: worker timezone lookup failed');
  }
  return fallback;
}
