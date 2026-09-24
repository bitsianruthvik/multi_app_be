/**
 * How many seats a position actually has — the ONE definition of the rule.
 *
 * WHY THIS FILE EXISTS. The rule was written out FOUR times — twice in
 * orgChartService, once in positionService, once in routes/overview.js — and
 * they disagreed in production. The org chart said Karni had 156 vacant seats;
 * the Positions screen said 101; a nav badge reading "156 vacant" sat directly
 * above a StatStrip reading "Vacant 101". Same question, two numbers, adjacent
 * pixels. Nothing erodes trust in a system faster than that.
 *
 * THE RULE. `sanctioned_headcount` means ONE SEAT, always. A position that runs
 * day AND night needs that many people PER SHIFT, and the import recorded that
 * as one `hrms_manpower_requirements` row per shift (plan §9.1) rather than by
 * doubling the column — because doubling it would make "sanctioned headcount"
 * mean two different things depending on the shift pattern.
 *
 *   day + night  ->  strength = SUM(required_count) over its live requirement rows
 *   otherwise    ->  strength = sanctioned_headcount
 *
 * Karni: 59 single-shift seats + 55 day/night positions x 2 = 169, not 114.
 * Counting the raw column gives 114 sanctioned and 101 vacant — wrong by exactly
 * the night shift.
 *
 * WHAT IS SHARED HERE AND WHAT IS NOT. The *rule* is shared: what counts as a
 * day shift, what makes a seat DN, and what its strength is. The *query shape*
 * is deliberately not — asking "how strong is this one position" and "what do
 * all positions come to" are different questions, and forcing one shape to
 * serve both makes the aggregate do 114 correlated subqueries. So there are two
 * SQL exports below, built from the same predicates.
 *
 * If you find yourself writing `sanctioned_headcount - filled` anywhere, or a
 * fresh `LIKE 'D%'`, you are reintroducing the bug.
 */

/* ── The predicates. Everything else is built from these. ───────────────────
 * Prefix matching, not equality: a tenant may code its shifts D/N, DAY/NIGHT,
 * D1/N1 or DAY-A/NIGHT-A, and all of them mean the same thing here. This is the
 * behaviour orgChartService had when it was the authority and produced the
 * correct 169/156, so it is the behaviour that is preserved.
 */
export const DAY_CODE_SQL = (col) => `UPPER(TRIM(${col})) LIKE 'D%'`;
export const NIGHT_CODE_SQL = (col) => `UPPER(TRIM(${col})) LIKE 'N%'`;

const up = (c) => String(c ?? '').trim().toUpperCase();
export const isDayCode = (code) => up(code).startsWith('D');
export const isNightCode = (code) => up(code).startsWith('N');

/* ── In memory, for a caller that already holds the rows ─────────────────── */

/**
 * @param {number} sanctioned the position's raw sanctioned_headcount
 * @param {Array<{shiftCode: string|null, requiredCount: number}>} requirements its live requirement rows
 */
export function effectiveSeats(sanctioned, requirements = []) {
  const hasDay = requirements.some((r) => isDayCode(r.shiftCode));
  const hasNight = requirements.some((r) => isNightCode(r.shiftCode));
  if (hasDay && hasNight) return requirements.reduce((n, r) => n + Number(r.requiredCount || 0), 0);
  return Number(sanctioned || 0);
}

/** 'DN' when the position runs both shifts; otherwise its own code, defaulting to 'G'. */
export function shiftPattern(defaultShiftCode, requirements = []) {
  const hasDay = requirements.some((r) => isDayCode(r.shiftCode));
  const hasNight = requirements.some((r) => isNightCode(r.shiftCode));
  return hasDay && hasNight ? 'DN' : (defaultShiftCode || 'G');
}

/** A vacancy is never negative on the wire: an over-filled seat is its own signal. */
export const vacancies = (seats, filled) => Math.max(0, Number(seats || 0) - Number(filled || 0));

/* ── In SQL ──────────────────────────────────────────────────────────────── */

/**
 * ONE position's effective seats, as a scalar expression for a row-at-a-time
 * SELECT. Correlated, which is fine over one company's positions (Karni is 114)
 * and keeps the surrounding query's other aggregates intact. For a TOTAL, use
 * `SEAT_TOTALS_SQL` instead — 114 correlated subqueries to produce one number
 * is the wrong trade.
 *
 * Consumes 4 `?` when `onSql` is `?`.
 *
 * @param {string} p     alias of hrms_positions in the outer query
 * @param {string} onSql SQL expression for the as-of date
 */
export const EFFECTIVE_SEATS_SQL = (p = 'p', onSql = '?') => `
  CASE WHEN (
         SELECT COUNT(DISTINCT CASE WHEN ${DAY_CODE_SQL('ms.code')} THEN 'D'
                                    WHEN ${NIGHT_CODE_SQL('ms.code')} THEN 'N' END)
           FROM hrms_manpower_requirements m
           JOIN hrms_shifts ms ON ms.company_id = m.company_id AND ms.id = m.shift_id
          WHERE m.company_id = ${p}.company_id AND m.position_id = ${p}.id
            AND m.deleted_at IS NULL
            AND (m.effective_from IS NULL OR m.effective_from <= ${onSql})
            AND (m.effective_to   IS NULL OR m.effective_to   >= ${onSql})
       ) >= 2
       THEN (
         SELECT COALESCE(SUM(m2.required_count), 0)
           FROM hrms_manpower_requirements m2
          WHERE m2.company_id = ${p}.company_id AND m2.position_id = ${p}.id
            AND m2.deleted_at IS NULL
            AND (m2.effective_from IS NULL OR m2.effective_from <= ${onSql})
            AND (m2.effective_to   IS NULL OR m2.effective_to   >= ${onSql})
       )
       ELSE ${p}.sanctioned_headcount
  END`;

/** How many `?` `EFFECTIVE_SEATS_SQL` consumes when `onSql` is `?`. */
export const EFFECTIVE_SEATS_PARAMS = 4;

/**
 * Sanctioned / filled / vacant / positions across a whole company, in one pass.
 * Two grouped sub-selects rather than a correlated scalar per row.
 *
 * CLOSED positions are excluded: a closed seat would invent a vacancy nobody
 * intends to fill. DRAFT and FROZEN are included — a frozen seat is still a seat.
 *
 * Parameter order (9): companyId, on, on · companyId, on, on · companyId, on, on
 *
 * @param {(alias: string) => string} liveOn the caller's effective-date predicate
 */
export const SEAT_TOTALS_SQL = (liveOn) => `
  SELECT COALESCE(SUM(eff), 0)                        AS sanctioned,
         COALESCE(SUM(filled), 0)                     AS filled,
         COALESCE(SUM(GREATEST(eff - filled, 0)), 0)  AS vacant,
         COUNT(*)                                     AS positions
    FROM (
      SELECT CASE WHEN req.day_rows > 0 AND req.night_rows > 0
                  THEN req.required ELSE p.sanctioned_headcount END AS eff,
             COALESCE(occ.filled, 0) AS filled
        FROM hrms_positions p
        LEFT JOIN (
          SELECT m.position_id,
                 SUM(m.required_count)                AS required,
                 SUM(${DAY_CODE_SQL('s.code')})       AS day_rows,
                 SUM(${NIGHT_CODE_SQL('s.code')})     AS night_rows
            FROM hrms_manpower_requirements m
            LEFT JOIN hrms_shifts s ON s.company_id = m.company_id AND s.id = m.shift_id
           WHERE m.company_id = ? AND m.deleted_at IS NULL AND m.position_id IS NOT NULL
             AND ${liveOn('m')}
           GROUP BY m.position_id
        ) req ON req.position_id = p.id
        LEFT JOIN (
          SELECT wa.position_id, COUNT(*) AS filled
            FROM hrms_work_assignments wa
           WHERE wa.company_id = ? AND wa.deleted_at IS NULL AND wa.status = 'ACTIVE'
             AND wa.position_id IS NOT NULL AND ${liveOn('wa')}
           GROUP BY wa.position_id
        ) occ ON occ.position_id = p.id
       WHERE p.company_id = ? AND p.deleted_at IS NULL AND p.status <> 'CLOSED'
         AND ${liveOn('p')}
    ) seat`;
