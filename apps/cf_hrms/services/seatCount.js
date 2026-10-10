/**
 * The seat rule — the ONE definition of "how many seats, how many filled".
 *
 * WHAT CHANGED (2026-10-10) AND WHY. The model had three levels: a role, a
 * position that held several seats (a `sanctioned_headcount`, doubled by a
 * day/night pattern through `hrms_manpower_requirements`) and the people in
 * those seats. The user's model has two: a ROLE, and POSITIONS under it — each
 * position is ONE chair, for ONE person, on ONE shift. Twelve helpers on days
 * and nights are twelve positions, not one position with a count.
 * `scripts/one-chair-positions.mjs` turned the old shape into the new one.
 *
 * THE RULE.
 *   - a position is one seat. `sanctioned_headcount` is always 1 and nothing
 *     reads it for a count any more;
 *   - a position is FILLED when a work assignment points at it that is not
 *     deleted, not ENDED and in date on the day asked about; VACANT otherwise;
 *   - a CLOSED position does not count at all — a closed chair would invent a
 *     vacancy nobody intends to fill. DRAFT and FROZEN still count;
 *   - a position's shift is its `default_shift_id`. There is no "DN" pattern:
 *     day and night are two positions;
 *   - `hrms_manpower_requirements` no longer decides anything here. A chair IS
 *     the requirement.
 *
 * So across a company: seats = positions, filled + vacant = positions. Two
 * live assignments on one position is bad data (`overFilled`), refused on
 * every write path by assignmentService (POSITION_FILLED); it still counts as
 * ONE filled seat here so the totals keep adding up.
 *
 * WHY THIS FILE STILL EXISTS. The rule used to be written out four times and
 * the copies disagreed in production (the chart said 156 vacant while the
 * Positions screen said 101, in adjacent pixels). It is a much smaller rule
 * now, and it still lives in exactly one place. If you find yourself writing
 * `sanctioned_headcount - filled` anywhere, or a fresh `status = 'ACTIVE'`
 * to decide whether a chair is taken, you are reintroducing the bug.
 */

/** Seats per position. A constant, written down once so nobody reads the column for it. */
export const SEATS_PER_POSITION = 1;

/* ── Shift codes ─────────────────────────────────────────────────────────────
 * Prefix matching, not equality: a tenant may code its shifts D/N, DAY/NIGHT or
 * D1/N1. Nothing in the seat rule reads these any more; they are kept because
 * the retired workbook applier (scripts/org-apply-workbook.mjs) imports them.
 */
const up = (c) => String(c ?? '').trim().toUpperCase();
export const isDayCode = (code) => up(code).startsWith('D');
export const isNightCode = (code) => up(code).startsWith('N');

/* ── In memory, for a caller that already holds the rows ─────────────────── */

/** The position's shift code. 'G' only for a position that has no shift at all (a company with no shifts yet). */
export const shiftPattern = (defaultShiftCode) => defaultShiftCode || 'G';

/** Filled seats of ONE position given how many live assignments point at it: 0 or 1. */
export const filledSeats = (liveAssignments) => (Number(liveAssignments || 0) > 0 ? SEATS_PER_POSITION : 0);

/** Vacant seats of ONE position: 1 or 0. */
export const vacancies = (liveAssignments) => SEATS_PER_POSITION - filledSeats(liveAssignments);

/** Two or more live assignments on one chair. Data that is wrong, never a design. */
export const overFilled = (liveAssignments) => Number(liveAssignments || 0) > SEATS_PER_POSITION;

/* ── In SQL ──────────────────────────────────────────────────────────────── */

/**
 * "This assignment holds its chair" — everything except the date. ENDED is the
 * only status that frees a chair: a SUSPENDED person still has their position,
 * and a PLANNED one holds it from its start date.
 */
export const HOLDS_SEAT_SQL = (wa = 'wa') =>
  `${wa}.deleted_at IS NULL AND ${wa}.status <> 'ENDED' AND ${wa}.position_id IS NOT NULL`;

/**
 * How many live assignments point at ONE position, as a scalar for a
 * row-at-a-time SELECT. 0 = vacant, 1 = filled, more = over-filled.
 * Consumes 2 `?` (the date, twice) when `onSql` is `?`.
 */
export const OCCUPANT_COUNT_SQL = (p = 'p', onSql = '?') => `
  (SELECT COUNT(*) FROM hrms_work_assignments wa
    WHERE wa.company_id = ${p}.company_id AND wa.position_id = ${p}.id AND ${HOLDS_SEAT_SQL('wa')}
      AND (wa.effective_from IS NULL OR wa.effective_from <= ${onSql})
      AND (wa.effective_to   IS NULL OR wa.effective_to   >= ${onSql}))`;

/**
 * Positions / filled / vacant across a whole company, in one pass.
 * `sanctioned` is the same number as `positions`; it is still returned because
 * the Home cards and nav badges were written against it.
 *
 * Parameter order (6): companyId, on, on · companyId, on, on
 *
 * @param {(alias: string) => string} liveOn the caller's effective-date predicate
 */
export const SEAT_TOTALS_SQL = (liveOn) => `
  SELECT COUNT(*)                                                    AS positions,
         COUNT(*)                                                    AS sanctioned,
         COALESCE(SUM(CASE WHEN occ.n > 0 THEN 1 ELSE 0 END), 0)     AS filled,
         COALESCE(SUM(CASE WHEN occ.n > 0 THEN 0 ELSE 1 END), 0)     AS vacant
    FROM hrms_positions p
    LEFT JOIN (
      SELECT wa.position_id, COUNT(*) AS n
        FROM hrms_work_assignments wa
       WHERE wa.company_id = ? AND ${HOLDS_SEAT_SQL('wa')} AND ${liveOn('wa')}
       GROUP BY wa.position_id
    ) occ ON occ.position_id = p.id
   WHERE p.company_id = ? AND p.deleted_at IS NULL AND p.status <> 'CLOSED'
     AND ${liveOn('p')}`;
