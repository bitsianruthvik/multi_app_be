/**
 * workerService.js — who is on which machine, and when.
 *
 * Assignment is modelled as INTERVALS (`fab_worker_assignments`), the same way
 * `fab_resource_events` models machine state, rather than as the standing/absent
 * flags `fab_resource_operators` used. That one change is what makes intraday
 * moves, part-day leave, and fixed-term vendor labour expressible at all — see
 * FAB_ERP_PEOPLE_PLAN.md §1 for what each of those broke on before.
 *
 * WHAT THIS MODULE WILL NOT DO
 * ----------------------------
 * It answers "who was on this machine" and never "how long was this person
 * away". There is no per-person break or idle accounting here, and
 * `fab_task_wait_segments` still attributes `no_operator` to the MACHINE's
 * timeline as a cause rather than to anybody's name. That is deliberate: the
 * moment a number can only be used against the person entering it, it stops
 * being true — and because these events share a stream with production timing,
 * the falsification would flow into `fab_operation_stats` and quietly corrupt
 * every future duration estimate. See FAB_ERP_PEOPLE_PLAN.md §0.
 */

import { pool } from '../../../db.js';

const toSqlUtc = (d) => new Date(d).toISOString().slice(0, 19).replace('T', ' ');

/** Open-ended (`to_ts IS NULL`) counts as "still true", for both kinds. */
const OVERLAPS = 'a.from_ts < ? AND (a.to_ts IS NULL OR a.to_ts > ?)';

/**
 * Rows that are CURRENTLY TRUE: not withdrawn, and not replaced by a correction.
 *
 * Append-only correction means a superseded row still physically exists — that
 * is the point, it is how "what did we believe last Tuesday" stays answerable.
 * Every read that wants the present truth must therefore filter both columns,
 * and forgetting `superseded_by_id` silently double-counts a person across the
 * original interval and its correction.
 */
const LIVE = 'a.deleted_at IS NULL AND a.superseded_by_id IS NULL';

/**
 * The crew on one machine over a window — everyone whose `assigned` interval
 * overlaps it, each with any `away` intervals that overlap the same window.
 *
 * `away` is returned as intervals rather than a boolean because "off today" and
 * "left at 4" are the same kind of fact at different scales, and collapsing them
 * to a flag is precisely what the old model did wrong.
 */
export async function crewForWindow(exec, companyId, resourceId, windowStart, windowEnd) {
  const s = toSqlUtc(windowStart);
  const e = toSqlUtc(windowEnd);

  const [rows] = await exec.query(
    `SELECT a.id AS assignmentId, a.from_ts AS fromTs, a.to_ts AS toTs, a.note,
            w.id AS workerId, w.name, w.code, w.worker_type AS workerType,
            w.vendor_name AS vendorName, w.user_id AS userId, w.phone
       FROM fab_worker_assignments a
       JOIN fab_workers w ON w.id = a.worker_id AND w.deleted_at IS NULL
      WHERE a.company_id = ? AND a.resource_id = ? AND a.kind = 'assigned'
        AND ${LIVE} AND ${OVERLAPS}
      ORDER BY w.name ASC`,
    [companyId, resourceId, e, s],
  );
  if (!rows.length) return [];

  const workerIds = [...new Set(rows.map((r) => r.workerId))];
  // Away is per-PERSON, not per-machine: someone who left early is away from
  // every machine, so this is not scoped by resource_id.
  const [aways] = await exec.query(
    `SELECT a.id, a.worker_id AS workerId, a.from_ts AS fromTs, a.to_ts AS toTs, a.reason, a.note
       FROM fab_worker_assignments a
      WHERE a.company_id = ? AND a.worker_id IN (?) AND a.kind = 'away'
        AND ${LIVE} AND ${OVERLAPS}
      ORDER BY a.from_ts ASC`,
    [companyId, workerIds, e, s],
  );

  const awayByWorker = new Map();
  for (const r of aways) {
    if (!awayByWorker.has(r.workerId)) awayByWorker.set(r.workerId, []);
    awayByWorker.get(r.workerId).push(r);
  }

  return rows.map((r) => ({ ...r, away: awayByWorker.get(r.workerId) ?? [] }));
}

/** Crew right now — what the Machine Board shows. */
export function crewNow(exec, companyId, resourceId) {
  const now = new Date();
  return crewForWindow(exec, companyId, resourceId, now, new Date(now.getTime() + 1000));
}

/**
 * Assign a worker to a machine from `fromTs` (default now).
 *
 * Assigning to a new machine CLOSES any open assignment on a different one:
 * a person is in one place at a time, and leaving the old interval open would
 * make them count toward two machines' crews at once — which would then make
 * `no_operator` quietly wrong on the machine they actually left.
 */
export async function assignWorker(companyId, { workerId, resourceId, fromTs, note, enteredBy }) {
  const atDate = fromTs ? new Date(fromTs) : new Date();
  const at = toSqlUtc(atDate);
  // Anything dated before now is a write-up, not an observation. Recording which
  // is which is the difference between "we saw this" and "we reconstructed this"
  // when a delay figure is later questioned.
  const source = atDate.getTime() < Date.now() - 60_000 ? 'backfill' : 'live';

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // ── SPLICE, not append ───────────────────────────────────────────────────
    // Every `assigned` interval for this worker that is still true at or after
    // `at`. Until 2026-08-06 this step only closed intervals with `to_ts IS
    // NULL`, i.e. it assumed `at` was NOW and nothing existed after it. That
    // holds for a live tap and fails for every backdated entry: writing
    // "Ramesh was on Press-2 last Tuesday 14:00" into a timeline that already
    // had him on Bay-3 on Wednesday left BOTH intervals covering Wednesday.
    //
    // Overlapping `assigned` intervals are not a cosmetic problem —
    // coveredIntervals() unions them, so the machine reads as crewed when it
    // was not, `no_operator` shrinks, and the delay quietly under-reports. The
    // number goes wrong in the direction nobody checks.
    const [clashes] = await conn.query(
      `SELECT id, resource_id AS resourceId, from_ts AS fromTs, to_ts AS toTs, reason, note, entered_by AS enteredBy
         FROM fab_worker_assignments
        WHERE company_id = ? AND worker_id = ? AND kind = 'assigned'
          AND deleted_at IS NULL AND superseded_by_id IS NULL
          AND (to_ts IS NULL OR to_ts > ?)
        ORDER BY from_ts ASC`,
      [companyId, workerId, at],
    );

    for (const c of clashes) {
      // Already on this machine and covering `at` — nothing to change. Keeps the
      // call idempotent, which the crew panel relies on (double-tap is common).
      if (c.resourceId === resourceId && new Date(c.fromTs) <= atDate) {
        await conn.commit();
        return { id: c.id, spliced: 0, source };
      }

      if (new Date(c.fromTs) < atDate) {
        // Straddles the boundary: it was true before `at` and claims to still be
        // true after. Truncate it — append-only, so supersede rather than UPDATE
        // the row in place.
        await supersedeInterval(conn, companyId, c, { toTs: at }, enteredBy);
      } else {
        // Lies entirely after `at`. A backdated correction that contradicts a
        // later record does NOT get to silently delete it: it is withdrawn as a
        // supersede, so the old belief stays readable and the change is
        // attributable.
        await conn.query(
          `UPDATE fab_worker_assignments SET deleted_at = UTC_TIMESTAMP()
            WHERE id = ? AND company_id = ?`,
          [c.id, companyId],
        );
      }
    }

    const [ins] = await conn.query(
      `INSERT INTO fab_worker_assignments
         (company_id, worker_id, resource_id, kind, from_ts, note, entered_by, source)
       VALUES (?, ?, ?, 'assigned', ?, ?, ?, ?)`,
      [companyId, workerId, resourceId, at, note ?? null, enteredBy ?? null, source],
    );

    await conn.commit();
    return { id: ins.insertId, spliced: clashes.length, source };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * Replace an interval with a corrected copy, append-only.
 *
 * Inserts the new version, then points the old row's `superseded_by_id` at it —
 * so the original stays on disk and readable. Reads filter
 * `superseded_by_id IS NULL`, so only the newest version is "true" now, but the
 * chain of what was believed, and when, survives.
 *
 * This is why a correction never UPDATEs: machine and project delays are derived
 * from these rows, and a delay figure that changes with no record of why is worse
 * than one that is simply wrong — nothing signals that it moved.
 */
async function supersedeInterval(conn, companyId, row, changes, enteredBy) {
  // UNCHANGED TIMESTAMPS ARE COPIED COLUMN-TO-COLUMN, IN SQL — they must never
  // make a round trip through JS.
  //
  // Reading a DATETIME gives a JS Date that mysql2 built by interpreting the
  // stored value in the CONNECTION's timezone; writing it back through
  // toSqlUtc() re-encodes it as UTC. Where those two differ (any non-UTC host —
  // see FAB_ERP_PEOPLE_PLAN.md §10.3) the value moves by the offset, and because
  // supersede is itself a read-modify-write, correcting the same interval twice
  // moves it TWICE. Observed locally: 08:00 → 02:30 → 21:00 across two
  // supersedes. A history table whose history silently drifts is worse than none.
  //
  // Only `changes.*` — genuinely new values, already UTC strings — are passed as
  // parameters. NULL means "keep the column as it is".
  const [ins] = await conn.query(
    `INSERT INTO fab_worker_assignments
       (company_id, worker_id, resource_id, kind, from_ts, to_ts, reason, note, entered_by, source)
     SELECT company_id, worker_id, resource_id, kind,
            COALESCE(?, from_ts), COALESCE(?, to_ts),
            reason, note, COALESCE(?, entered_by), 'backfill'
       FROM fab_worker_assignments WHERE id = ? AND company_id = ?`,
    [changes.fromTs ?? null, changes.toTs ?? null, enteredBy ?? null, row.id, companyId],
  );
  await conn.query(
    `UPDATE fab_worker_assignments SET superseded_by_id = ? WHERE id = ? AND company_id = ?`,
    [ins.insertId, row.id, companyId],
  );
  return ins.insertId;
}

/** Take a worker off a machine — closes the open interval rather than deleting it. */
export async function unassignWorker(companyId, { workerId, resourceId, at }) {
  const ts = toSqlUtc(at ?? new Date());
  const [res] = await pool.query(
    `UPDATE fab_worker_assignments SET to_ts = ?
      WHERE company_id = ? AND worker_id = ? AND resource_id = ? AND kind = 'assigned'
        AND deleted_at IS NULL AND superseded_by_id IS NULL AND to_ts IS NULL`,
    [ts, companyId, workerId, resourceId],
  );
  return { closed: res.affectedRows };
}

/**
 * Record time away. One shape covers "off today", "left at 4", and "at training
 * all week" — the difference is only the size of the interval.
 */
export async function setAway(companyId, { workerId, fromTs, toTs, reason, note, enteredBy }) {
  const source = new Date(fromTs).getTime() < Date.now() - 60_000 ? 'backfill' : 'live';
  const [ins] = await pool.query(
    `INSERT INTO fab_worker_assignments (company_id, worker_id, resource_id, kind, from_ts, to_ts, reason, note, entered_by, source)
     VALUES (?, ?, NULL, 'away', ?, ?, ?, ?, ?, ?)`,
    [companyId, workerId, toSqlUtc(fromTs), toTs ? toSqlUtc(toTs) : null, reason ?? null, note ?? null, enteredBy ?? null, source],
  );
  return { id: ins.insertId };
}

/**
 * Withdraw an away/assignment interval that was entered by mistake.
 *
 * Returns the row's shape as it was BEFORE removal (`worker`, `from`, `to`) so
 * the caller can re-derive attribution over the span it used to cover. Once
 * `deleted_at` is set the row is invisible to `resourcesTouchedByWorker`, so a
 * caller that recomputes afterwards without this would find no machines to
 * recompute and silently leave the stale segments in place.
 */
export async function removeInterval(companyId, id) {
  const [[row]] = await pool.query(
    `SELECT worker_id AS workerId, resource_id AS resourceId, kind, from_ts AS fromTs, to_ts AS toTs
       FROM fab_worker_assignments
      WHERE company_id = ? AND id = ? AND deleted_at IS NULL`,
    [companyId, id],
  );
  if (!row) return { removed: 0, was: null };

  const [res] = await pool.query(
    `UPDATE fab_worker_assignments SET deleted_at = UTC_TIMESTAMP()
      WHERE company_id = ? AND id = ? AND deleted_at IS NULL`,
    [companyId, id],
  );
  return { removed: res.affectedRows, was: row };
}

// ─── the busy rule ───────────────────────────────────────────────────────────

/**
 * Can these people work on `resourceId` right now?
 *
 * THE RULE (FAB_ERP_PEOPLE_PLAN.md §12): a person may run any number of tasks on
 * the machine they are assigned to, but is blocked on every other machine.
 *
 * This needs NO new locking, because it is already the invariant `assignWorker`
 * maintains — one open `assigned` interval per worker. Somebody's machine
 * assignment IS their availability; asking "are you free?" is the same question
 * as "which machine are you on?", and keeping it that way means there is one
 * fact to get right rather than two that can disagree.
 *
 * Returns the blocked workers rather than throwing, so the caller can offer to
 * move them instead of just refusing.
 */
export async function workersBlockedElsewhere(exec, companyId, workerIds, resourceId) {
  if (!workerIds?.length) return [];
  const [rows] = await exec.query(
    `SELECT a.worker_id AS workerId, w.name, a.resource_id AS currentResourceId,
            r.name AS currentResourceName
       FROM fab_worker_assignments a
       JOIN fab_workers w ON w.id = a.worker_id AND w.deleted_at IS NULL
       LEFT JOIN fab_resources r ON r.id = a.resource_id
      WHERE a.company_id = ? AND a.worker_id IN (?) AND a.kind = 'assigned'
        AND a.deleted_at IS NULL AND a.superseded_by_id IS NULL
        AND a.to_ts IS NULL AND a.resource_id <> ?`,
    [companyId, workerIds, resourceId],
  );
  return rows;
}

/**
 * Record that these people are working this task, from now.
 *
 * Anyone with no open machine assignment is put on this task's machine at the
 * same time — starting work on a machine IS being on it, and requiring a
 * separate rostering step before the Start button worked would guarantee the
 * roster stayed empty.
 *
 * Idempotent per (task, worker): re-starting a paused task does not stack a
 * second open row for somebody already on it.
 */
export async function attachWorkersToTask(exec, companyId, { taskId, workerIds, resourceId, enteredBy }) {
  if (!workerIds?.length) return { attached: 0 };
  let attached = 0;
  for (const workerId of workerIds) {
    const [[open]] = await exec.query(
      `SELECT id FROM fab_task_workers
        WHERE company_id = ? AND task_id = ? AND worker_id = ?
          AND deleted_at IS NULL AND superseded_by_id IS NULL AND to_ts IS NULL
        LIMIT 1`,
      [companyId, taskId, workerId],
    );
    if (open) continue;
    await exec.query(
      `INSERT INTO fab_task_workers (company_id, task_id, worker_id, from_ts, entered_by, source)
       VALUES (?, ?, ?, UTC_TIMESTAMP(), ?, 'live')`,
      [companyId, taskId, workerId, enteredBy ?? null],
    );
    attached++;

    const [[assigned]] = await exec.query(
      `SELECT id FROM fab_worker_assignments
        WHERE company_id = ? AND worker_id = ? AND kind = 'assigned'
          AND deleted_at IS NULL AND superseded_by_id IS NULL AND to_ts IS NULL
        LIMIT 1`,
      [companyId, workerId],
    );
    if (!assigned && resourceId) {
      await exec.query(
        `INSERT INTO fab_worker_assignments
           (company_id, worker_id, resource_id, kind, from_ts, entered_by, source, note)
         VALUES (?, ?, ?, 'assigned', UTC_TIMESTAMP(), ?, 'live', 'auto-assigned on task start')`,
        [companyId, workerId, resourceId, enteredBy ?? null],
      );
    }
  }
  return { attached };
}

/**
 * Close the open worker intervals on a task — it stopped or was paused.
 *
 * Deliberately does NOT touch their machine assignment. Finishing a job does not
 * mean leaving the machine; unassigning them here would make the machine read as
 * unmanned between two jobs on the same station and manufacture `no_operator`
 * minutes out of an ordinary changeover.
 */
export async function detachWorkersFromTask(exec, companyId, taskId) {
  const [res] = await exec.query(
    `UPDATE fab_task_workers SET to_ts = UTC_TIMESTAMP()
      WHERE company_id = ? AND task_id = ? AND deleted_at IS NULL
        AND superseded_by_id IS NULL AND to_ts IS NULL`,
    [companyId, taskId],
  );
  return { closed: res.affectedRows };
}

// ─── shift assignment (people own the calendar) ──────────────────────────────

/**
 * Put a worker on a shift from `fromTs`, closing whatever they were on.
 *
 * A person is assigned to a SHIFT ROW rather than a bare time range, so night
 * shifts (`end_time <= start_time`), unpaid breaks (`working_minutes`) and the
 * plant's non-working days (the shift's parent calendar) all come from code that
 * already works. Rotation is close-one-open-the-next, the same idiom as machine
 * assignment — there is no weekday map, because a person stays on one shift
 * until somebody moves them (FAB_ERP_PEOPLE_PLAN.md §6).
 */
export async function assignShift(companyId, { workerId, shiftId, fromTs, note, enteredBy }) {
  const atDate = fromTs ? new Date(fromTs) : new Date();
  const at = toSqlUtc(atDate);
  const source = atDate.getTime() < Date.now() - 60_000 ? 'backfill' : 'live';

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // Same splice as machine assignment: close anything still true at `at`, and
    // withdraw anything that starts after it, so a backdated shift change cannot
    // leave two shifts covering the same instant. Two live shifts would union in
    // the capacity calc and hand the machine hours nobody was there for.
    const [clashes] = await conn.query(
      `SELECT id, shift_id AS shiftId, from_ts AS fromTs, to_ts AS toTs
         FROM fab_worker_shifts
        WHERE company_id = ? AND worker_id = ?
          AND deleted_at IS NULL AND superseded_by_id IS NULL
          AND (to_ts IS NULL OR to_ts > ?)
        ORDER BY from_ts ASC`,
      [companyId, workerId, at],
    );

    for (const c of clashes) {
      if (c.shiftId === shiftId && new Date(c.fromTs) <= atDate) {
        await conn.commit();
        return { id: c.id, spliced: 0, source };
      }
      if (new Date(c.fromTs) < atDate) {
        const [ins] = await conn.query(
          `INSERT INTO fab_worker_shifts
             (company_id, worker_id, shift_id, from_ts, to_ts, note, entered_by, source)
           SELECT company_id, worker_id, shift_id, from_ts, ?, note, COALESCE(?, entered_by), 'backfill'
             FROM fab_worker_shifts WHERE id = ? AND company_id = ?`,
          [at, enteredBy ?? null, c.id, companyId],
        );
        await conn.query(
          `UPDATE fab_worker_shifts SET superseded_by_id = ? WHERE id = ? AND company_id = ?`,
          [ins.insertId, c.id, companyId],
        );
      } else {
        await conn.query(
          `UPDATE fab_worker_shifts SET deleted_at = UTC_TIMESTAMP() WHERE id = ? AND company_id = ?`,
          [c.id, companyId],
        );
      }
    }

    const [ins] = await conn.query(
      `INSERT INTO fab_worker_shifts
         (company_id, worker_id, shift_id, from_ts, note, entered_by, source)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [companyId, workerId, shiftId, at, note ?? null, enteredBy ?? null, source],
    );

    await conn.commit();
    return { id: ins.insertId, spliced: clashes.length, source };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * One worker's full record: who they are, and every interval ever recorded —
 * including superseded and withdrawn rows.
 *
 * The history deliberately returns the dead rows too. Append-only correction is
 * only worth the complexity if somebody can actually SEE that a correction
 * happened; a history view that silently shows only the current truth is
 * indistinguishable from edit-in-place, which is what §7.3 rejected.
 */
export async function workerDetail(companyId, workerId) {
  const [[worker]] = await pool.query(
    `SELECT id, name, code, worker_type AS workerType, vendor_name AS vendorName,
            user_id AS userId, phone, active
       FROM fab_workers WHERE id = ? AND company_id = ? AND deleted_at IS NULL`,
    [workerId, companyId],
  );
  if (!worker) return null;

  const [assignments] = await pool.query(
    `SELECT a.id, a.resource_id AS resourceId, r.name AS resourceName, a.kind,
            a.from_ts AS fromTs, a.to_ts AS toTs, a.reason, a.note, a.source,
            a.superseded_by_id AS supersededById, a.deleted_at AS deletedAt,
            a.entered_by AS enteredBy, u.name AS enteredByName
       FROM fab_worker_assignments a
       LEFT JOIN fab_resources r ON r.id = a.resource_id
       LEFT JOIN users u ON u.id = a.entered_by
      WHERE a.company_id = ? AND a.worker_id = ?
      ORDER BY a.from_ts DESC, a.id DESC`,
    [companyId, workerId],
  );

  const [shifts] = await pool.query(
    `SELECT s.id, s.shift_id AS shiftId, sh.name AS shiftName,
            sh.start_time AS startTime, sh.end_time AS endTime,
            sh.working_minutes AS workingMinutes, cal.name AS calendarName,
            s.from_ts AS fromTs, s.to_ts AS toTs, s.note, s.source,
            s.superseded_by_id AS supersededById, s.deleted_at AS deletedAt
       FROM fab_worker_shifts s
       LEFT JOIN fab_shifts sh ON sh.id = s.shift_id
       LEFT JOIN fab_shift_calendars cal ON cal.id = sh.calendar_id
      WHERE s.company_id = ? AND s.worker_id = ?
      ORDER BY s.from_ts DESC, s.id DESC`,
    [companyId, workerId],
  );

  const [tasks] = await pool.query(
    `SELECT tw.id, tw.task_id AS taskId, tw.role, tw.from_ts AS fromTs, tw.to_ts AS toTs,
            tw.source, tw.superseded_by_id AS supersededById, tw.deleted_at AS deletedAt,
            t.status, op.name AS operationName, r.name AS resourceName
       FROM fab_task_workers tw
       LEFT JOIN fab_project_tasks t ON t.id = tw.task_id
       LEFT JOIN fab_operations op ON op.id = t.operation_id
       LEFT JOIN fab_resources r ON r.id = t.assigned_resource_id
      WHERE tw.company_id = ? AND tw.worker_id = ?
      ORDER BY tw.from_ts DESC, tw.id DESC
      LIMIT 200`,
    [companyId, workerId],
  );

  return { worker, assignments, shifts, tasks };
}

/**
 * Machines with nobody rostered on them across a window.
 *
 * A PRECHECK, deliberately run before a scheduling pass rather than discovered
 * during one. Under the zero-capacity rule (FAB_ERP_PEOPLE_PLAN.md §9) an
 * unmanned machine cannot be scheduled, so without this the planner fails once
 * per affected TASK — dozens of separate NoCapacityErrors that all trace back to
 * the same four machines nobody was put on. This answers the question the user
 * actually has ("which machines need crew?") in one query, before any of that.
 *
 * `onlyWithWork: true` restricts the answer to machines that actually have tasks
 * waiting, so a decommissioned machine sitting idle in the list doesn't read as
 * a problem to solve.
 */
export async function crewCoverageGaps(companyId, { from, to, onlyWithWork = false } = {}) {
  const s = toSqlUtc(from ?? new Date());
  const e = toSqlUtc(to ?? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000));

  const [rows] = await pool.query(
    `SELECT r.id AS resourceId, r.name, r.code, r.plant_id AS plantId,
            COUNT(DISTINCT t.id) AS waitingTasks
       FROM fab_resources r
       LEFT JOIN fab_project_tasks t
              ON t.assigned_resource_id = r.id AND t.deleted_at IS NULL
             AND t.status IN ('eligible','blocked','paused')
      WHERE r.company_id = ? AND r.deleted_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM fab_worker_assignments a
            JOIN fab_workers w ON w.id = a.worker_id AND w.deleted_at IS NULL AND w.active = 1
           WHERE a.company_id = r.company_id AND a.resource_id = r.id
             AND a.kind = 'assigned' AND a.deleted_at IS NULL AND a.superseded_by_id IS NULL
             AND a.from_ts < ? AND (a.to_ts IS NULL OR a.to_ts > ?)
        )
      GROUP BY r.id, r.name, r.code, r.plant_id
      ORDER BY waitingTasks DESC, r.name ASC`,
    [companyId, e, s],
  );

  return onlyWithWork ? rows.filter((r) => r.waitingTasks > 0) : rows;
}

/**
 * Every machine this worker's `assigned` intervals touch inside a window.
 *
 * Exists so a roster write can say WHICH machines' attribution just went stale.
 * It is not always the machine named in the request: marking someone away has no
 * resource_id at all, yet invalidates `no_operator` on every machine they were
 * assigned to across that window — and a backdated change can span several
 * machines they moved between. Callers pass the result to
 * `recomputeForResourceWindow`.
 *
 * Lives here rather than in taskAttributionService because that module already
 * imports this one; the recompute is wired up by the route, which can import
 * both without creating a cycle.
 */
export async function resourcesTouchedByWorker(companyId, workerId, windowStart, windowEnd) {
  const [rows] = await pool.query(
    `SELECT DISTINCT a.resource_id AS resourceId
       FROM fab_worker_assignments a
      WHERE a.company_id = ? AND a.worker_id = ? AND a.kind = 'assigned'
        AND a.resource_id IS NOT NULL
        AND ${LIVE} AND ${OVERLAPS}`,
    [companyId, workerId, toSqlUtc(windowEnd), toSqlUtc(windowStart)],
  );
  return rows.map((r) => r.resourceId);
}

/**
 * Working intervals a machine actually had SOMEONE on it, within a window.
 *
 * This is what `no_operator` should be computed from. The old rule could only
 * ask "was every standing operator absent for this whole DATE", because absence
 * was a date column — so an afternoon with nobody on the machine was invisible.
 * Returns the periods where at least one assigned worker was not away.
 */
export async function coveredIntervals(exec, companyId, resourceId, windowStart, windowEnd) {
  const crew = await crewForWindow(exec, companyId, resourceId, windowStart, windowEnd);
  if (!crew.length) return [];

  const wStart = new Date(windowStart).getTime();
  const wEnd = new Date(windowEnd).getTime();
  const clamp = (v, fallback) => {
    const t = v == null ? fallback : new Date(v).getTime();
    return Math.min(Math.max(t, wStart), wEnd);
  };

  // Each person contributes their assigned span minus their away spans; the
  // machine is covered wherever at least one person's contribution lands.
  const spans = [];
  for (const c of crew) {
    let pieces = [[clamp(c.fromTs, wStart), clamp(c.toTs, wEnd)]];
    for (const a of c.away) {
      const aS = clamp(a.fromTs, wStart);
      const aE = clamp(a.toTs, wEnd);
      const next = [];
      for (const [s, e] of pieces) {
        if (aE <= s || aS >= e) { next.push([s, e]); continue; }
        if (aS > s) next.push([s, aS]);
        if (aE < e) next.push([aE, e]);
      }
      pieces = next;
    }
    for (const p of pieces) if (p[1] > p[0]) spans.push(p);
  }

  spans.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const [s, e] of spans) {
    const last = merged[merged.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else merged.push([s, e]);
  }
  return merged.map(([s, e]) => ({ start: new Date(s), end: new Date(e) }));
}
