/**
 * SETTLING A LINE OUTSIDE THE REQUEST (2026-11-16).
 *
 * The Structure step's read used to choose the selections the system can answer (selectionService.autofillLineSelections)
 * and then work the changed values out again (valueService.refreshValues) INSIDE the request. refreshValues goes record by
 * record and follows each change up the BOM, so on a large imported line it is thousands of round trips: SO260032 (253 rows)
 * about 33 s, SO260031 span 1 (362 rows) 434 s and 2,987 round trips on TiDB. The browser gives up at 30 s, so the page
 * said "The server took too long to answer" on every try while the server carried on.
 *
 * Now the same work runs in ITS OWN transaction, started by the read and shared by every read of that line while it runs
 * (one run per line in this process). The read waits for it a few seconds — a normal line is done well inside that, and
 * nothing changes for it — and otherwise answers with the structure as it stands and `settling: true`; the screen reads
 * again until it is done. All of a line's choices and values commit together or not at all, so a restart mid-way leaves the
 * line as it was and the next open starts again.
 *
 * Since the same day refreshValues works a wave of records at a time (valueService, valueWaveReads.js): all the values of
 * that 362-row line from nothing are 80 round trips and 12 s, so a first open normally ends inside the read's wait. The
 * run outside the request stays: it is what keeps a read from ever waiting on a line larger than any seen so far.
 */
import { withTransaction } from '../lib/db.js';
import { autofillLineSelections } from './selectionService.js';
import { refreshValues } from './valueService.js';
import { logger } from '../../../core/utils/logger.js';

/** How long a read waits for the line to settle before it answers without it. Well under the browser's 30 s. */
export const SETTLE_WAIT_MS = 8000;
/** How long a finished run's count stays readable (two reads of one page both learn that values moved). */
const RECENT_MS = 30000;

const running = new Map();   // `${companyId}:${lineId}` → { promise, startedAt }
const recent = new Map();    // `${companyId}:${lineId}` → { filled, at }

const key = (companyId, lineId) => `${companyId}:${lineId}`;

/** The run for a line: the one in flight, or a new one. Never rejects: → { filled, failed? }. */
function settleLine(c, lineId, run = null) {
  const k = key(c.companyId, lineId);
  const now = running.get(k);
  if (now) return now.promise;
  const startedAt = Date.now();
  const work = run ?? (() => withTransaction((db) => autofillLineSelections(db, c, lineId, { refresh: (ids) => refreshValues(db, c, ids) })));
  const promise = Promise.resolve().then(() => work(lineId))
    .then((r) => {
      const filled = Number(r?.filled ?? 0);
      const ms = Date.now() - startedAt;
      if (filled) recent.set(k, { filled, at: Date.now() });
      if (ms > SETTLE_WAIT_MS) logger.warn({ lineId, companyId: c.companyId, ms, filled }, '[cf_erp] a line took longer to settle than a read waits');
      return { filled };
    })
    .catch((err) => {
      logger.error({ lineId, companyId: c.companyId, err: err?.message }, '[cf_erp] settling a line failed (nothing was written)');
      return { filled: 0, failed: err?.message ?? String(err) };
    })
    .finally(() => { running.delete(k); });
  running.set(k, { promise, startedAt });
  return promise;
}

/**
 * Before a structure read: start (or join) each line's run and wait for them together, at most `waitMs`.
 * `run(lineId)` replaces the work itself (tests only).
 * → Map lineId → { settling (still running when the wait ended), filled (selections chosen by a run that finished now or
 *   in the last moments), seconds (how long the run has been going, when settling) }
 */
export async function settleLines(c, lineIds, { waitMs = SETTLE_WAIT_MS, run = null } = {}) {
  const ids = [...new Set(lineIds.map(Number).filter(Boolean))];
  const runs = ids.map((id) => ({ id, promise: settleLine(c, id, run), done: null }));
  for (const r of runs) r.promise.then((v) => { r.done = v; });
  let timer;
  await Promise.race([
    Promise.all(runs.map((r) => r.promise)),
    new Promise((resolve) => { timer = setTimeout(resolve, waitMs); }),
  ]);
  clearTimeout(timer);
  const out = new Map();
  const t = Date.now();
  for (const r of runs) {
    const k = key(c.companyId, r.id);
    const rec = recent.get(k);
    if (rec && t - rec.at > RECENT_MS) recent.delete(k);
    const live = running.get(k);
    out.set(r.id, {
      settling: !r.done,
      filled: r.done ? Math.max(r.done.filled, recent.get(k)?.filled ?? 0) : 0,
      seconds: !r.done && live ? Math.round((t - live.startedAt) / 1000) : 0,
    });
  }
  return out;
}

/** For tests: is a run in flight for this line? */
export const isSettling = (companyId, lineId) => running.has(key(companyId, lineId));
