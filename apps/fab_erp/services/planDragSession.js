/**
 * planDragSession.js — one gesture, one set of reads.
 *
 * A drag is many requests: a validity check every time the handle pauses, then
 * one more to commit. Each of them asked the database the same three dozen
 * questions about a plan that, by definition, nobody was changing — the planner
 * was holding it.
 *
 * A session ties those requests together. The first one loads the shop; the
 * rest read it out of memory. See planReadCache for the mechanism.
 *
 * THE ID COMES FROM THE CLIENT
 * ----------------------------
 * The board mints a random id when the handle goes down and sends it with every
 * request of that gesture. No "open a session" round trip at mousedown, which
 * would put a network call in front of the most latency-sensitive moment there
 * is, and no endpoint to leak sessions if a browser tab dies mid-drag: an
 * abandoned session is only a few dozen cached rows waiting for a TTL.
 *
 * The id is namespaced by company and user before it is used as a key, so a
 * guessed or repeated id from one account cannot reach another's cached reads.
 *
 * STALENESS IS CHECKED, NOT ASSUMED
 * ---------------------------------
 * Every request re-reads a version stamp of the plan, outside the cache. If it
 * differs from the one the session was built on, the cache is thrown away and
 * refilled. That is deliberately not an error: another planner having edited
 * something is ordinary, and the right response is to answer from the current
 * plan, not to refuse the drag and make the person start again.
 *
 * WHAT THE STAMP DOES NOT COVER
 * -----------------------------
 * A TASK changing status — somebody on the floor starting a job — does not
 * touch fab_plan_entries and so does not move the stamp. The consequence is
 * bounded and small: for the seconds a drag is in flight, a bar that has just
 * started could still be treated as movable. Covering it would mean a
 * MAX(updated_at) over fab_project_tasks on every keystroke of a drag, which is
 * an unindexed scan of the largest table here to close a race measured in
 * seconds. The short TTL below is the other half of that trade.
 */

import { cachedQuery, withReadCache, withoutReadCache, cacheStats } from './planReadCache.js';

/**
 * How long a session outlives its last use.
 *
 * Long enough for a planner to hold a handle, think, and let go; short enough
 * that the races the version stamp does not cover cannot open far. A session is
 * also dropped the moment its drag commits, since the plan has changed by
 * definition at that point.
 */
const TTL_MS = 2 * 60 * 1000;

/** A ceiling on concurrent drags held in memory, oldest evicted first. */
const MAX_SESSIONS = 200;

const sessions = new Map();

function sweep() {
  const now = Date.now();
  for (const [k, s] of sessions) if (now - s.at > TTL_MS) sessions.delete(k);
  while (sessions.size > MAX_SESSIONS) {
    const oldest = sessions.keys().next().value;
    if (oldest === undefined) break;
    sessions.delete(oldest);
  }
}

/**
 * A fingerprint of where every planned bar currently sits.
 *
 * Count and latest-update alone were not enough, and the way that failed is
 * worth recording. `updated_at` is a TIMESTAMP, so it resolves to the second:
 * a planner who moved a bar and undid it inside the same second produced an
 * identical stamp, and a session built before both would have been reused
 * afterwards. The count was unchanged too, because nothing was added or removed.
 *
 * Summing the start and end instants closes that: any bar landing anywhere
 * different changes the total, whatever the clock did. It is a checksum, not a
 * hash — two compensating moves could in principle cancel out — but that
 * requires one bar to move exactly as far back as another moved forward, in the
 * same second, during one drag, which is a different order of unlikely from the
 * undo-within-a-second case that actually happened in testing.
 *
 * A range scan of the planned bars, once per request. That is the single query
 * a warm validity check now costs, against the two dozen it replaces.
 *
 * Read outside the cache, or it would agree with itself for ever.
 */
async function planVersion(companyId) {
  return withoutReadCache(async () => {
    const [[row]] = await cachedQuery(
      `SELECT COUNT(*) AS n,
              COALESCE(SUM(UNIX_TIMESTAMP(planned_start)), 0) AS s,
              COALESCE(SUM(UNIX_TIMESTAMP(planned_end)), 0) AS e,
              COALESCE(SUM(is_pinned), 0) AS p
         FROM fab_plan_entries
        WHERE company_id = ? AND status = 'planned' AND deleted_at IS NULL`,
      [companyId],
    );
    return `${row?.n ?? 0}:${row?.s ?? 0}:${row?.e ?? 0}:${row?.p ?? 0}`;
  });
}

function keyFor(companyId, userId, sessionId) {
  return `${Number(companyId)}:${Number(userId) || 0}:${String(sessionId).slice(0, 64)}`;
}

/**
 * Run `fn` with this gesture's reads cached.
 *
 * Without a sessionId — every caller that is not a drag — this is just `fn()`,
 * so nothing else in the application changes behaviour.
 *
 * @returns {Promise<{result:any, reused:boolean, stats:object}>}
 */
export async function withDragSession(companyId, userId, sessionId, fn) {
  if (!sessionId) return { result: await fn(), reused: false, stats: null };

  sweep();
  const key = keyFor(companyId, userId, sessionId);
  const version = await planVersion(companyId);

  let session = sessions.get(key);
  let reused = true;
  if (!session || session.version !== version) {
    // Either the first request of this gesture, or somebody else changed the
    // plan underneath it. Both mean: start from what the database says now.
    session = { cache: new Map(), version, at: Date.now() };
    sessions.set(key, session);
    reused = false;
  }
  session.at = Date.now();
  // Re-inserted so Map iteration order stays least-recently-used first.
  sessions.delete(key);
  sessions.set(key, session);

  const result = await withReadCache(session.cache, fn);
  return { result, reused, stats: cacheStats(session.cache) };
}

/**
 * Forget a gesture's reads.
 *
 * Called once a drag has written: every cached answer describes the plan as it
 * was before, and the next gesture must not start from it.
 */
export function endDragSession(companyId, userId, sessionId) {
  if (!sessionId) return;
  sessions.delete(keyFor(companyId, userId, sessionId));
}

/** Drop everything. For tests and for a company whose plan was replaced wholesale. */
export function clearDragSessions() {
  sessions.clear();
}
