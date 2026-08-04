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
        AND a.deleted_at IS NULL AND ${OVERLAPS}
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
        AND a.deleted_at IS NULL AND ${OVERLAPS}
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
  const at = toSqlUtc(fromTs ?? new Date());
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query(
      `UPDATE fab_worker_assignments
          SET to_ts = ?
        WHERE company_id = ? AND worker_id = ? AND kind = 'assigned'
          AND deleted_at IS NULL AND to_ts IS NULL AND resource_id <> ?`,
      [at, companyId, workerId, resourceId],
    );
    // Idempotent: if they're already open on this machine, don't stack a duplicate.
    const [[existing]] = await conn.query(
      `SELECT id FROM fab_worker_assignments
        WHERE company_id = ? AND worker_id = ? AND resource_id = ? AND kind = 'assigned'
          AND deleted_at IS NULL AND to_ts IS NULL LIMIT 1`,
      [companyId, workerId, resourceId],
    );
    let id = existing?.id ?? null;
    if (!id) {
      const [ins] = await conn.query(
        `INSERT INTO fab_worker_assignments (company_id, worker_id, resource_id, kind, from_ts, note, entered_by)
         VALUES (?, ?, ?, 'assigned', ?, ?, ?)`,
        [companyId, workerId, resourceId, at, note ?? null, enteredBy ?? null],
      );
      id = ins.insertId;
    }
    await conn.commit();
    return { id };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/** Take a worker off a machine — closes the open interval rather than deleting it. */
export async function unassignWorker(companyId, { workerId, resourceId, at }) {
  const ts = toSqlUtc(at ?? new Date());
  const [res] = await pool.query(
    `UPDATE fab_worker_assignments SET to_ts = ?
      WHERE company_id = ? AND worker_id = ? AND resource_id = ? AND kind = 'assigned'
        AND deleted_at IS NULL AND to_ts IS NULL`,
    [ts, companyId, workerId, resourceId],
  );
  return { closed: res.affectedRows };
}

/**
 * Record time away. One shape covers "off today", "left at 4", and "at training
 * all week" — the difference is only the size of the interval.
 */
export async function setAway(companyId, { workerId, fromTs, toTs, reason, note, enteredBy }) {
  const [ins] = await pool.query(
    `INSERT INTO fab_worker_assignments (company_id, worker_id, resource_id, kind, from_ts, to_ts, reason, note, entered_by)
     VALUES (?, ?, NULL, 'away', ?, ?, ?, ?, ?)`,
    [companyId, workerId, toSqlUtc(fromTs), toTs ? toSqlUtc(toTs) : null, reason ?? null, note ?? null, enteredBy ?? null],
  );
  return { id: ins.insertId };
}

/** Withdraw an away/assignment interval that was entered by mistake. */
export async function removeInterval(companyId, id) {
  const [res] = await pool.query(
    `UPDATE fab_worker_assignments SET deleted_at = NOW()
      WHERE company_id = ? AND id = ? AND deleted_at IS NULL`,
    [companyId, id],
  );
  return { removed: res.affectedRows };
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
