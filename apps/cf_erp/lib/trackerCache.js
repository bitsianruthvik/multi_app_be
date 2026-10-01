/**
 * trackerCache.js — a short memory of the tracker's raw reads (2026-10-01).
 *
 * WHY. Every tracker screen — an order's Production tab, the progress grid and
 * tree, a branch opened in either, the nav badges — re-reads the WHOLE release:
 * on the KEPL line that is 6,072 pieces, 11,150 steps and 14,083 waits, about a
 * second and a half over the 49 ms link to TiDB, every time. A person opening
 * three branches in a row paid that three times for the same rows.
 *
 * WHAT. releaseService.loadTracker keeps its raw rows here for TRACKER_TTL_MS,
 * keyed by company + release ids, and only hands them out again while a cheap
 * STAMP still matches — one round trip that sums up what the rows depend on
 * (the steps' count / last change / good quantities, the requirements, the
 * reservations, the releases and their lines, the stock ledger, the work
 * orders, the machine log's sessions). Any write in this process clears the lot (lib/db.withTransaction
 * calls invalidateTrackerCache after every commit), so the stamp is only the
 * safety net for a write made by ANOTHER process.
 *
 * RULES.
 *   - Only reads made on the shared pool are cached. A read inside a
 *     transaction (a write path, a test) always goes to the database: it must
 *     see its own uncommitted rows.
 *   - The rows handed out are COPIES (one level deep): evaluate() and its
 *     readers decorate rows (_status, _label, …) and must never reach the copy
 *     the next reader gets.
 */
export const TRACKER_TTL_MS = 30_000;
const MAX_ENTRIES = 24;

const entries = new Map();          // key -> { at, stamp, data }
let hits = 0;
let misses = 0;

export const trackerCacheKey = (companyId, releaseIds) => `${companyId}:${[...releaseIds].map(Number).sort((a, b) => a - b).join(',')}`;

/** The cached rows for `key` while fresh and `stamp` still matches; else null. */
export function cachedTracker(key, stamp, now = Date.now()) {
  const e = entries.get(key);
  if (!e || now - e.at > TRACKER_TTL_MS || e.stamp !== stamp) { misses += 1; return null; }
  hits += 1;
  return copyTracker(e.data);
}

export function rememberTracker(key, stamp, data, now = Date.now()) {
  if (entries.size >= MAX_ENTRIES) {
    // The oldest goes; Map keeps insertion order.
    entries.delete(entries.keys().next().value);
  }
  entries.set(key, { at: now, stamp, data });
  return copyTracker(data);
}

const flying = new Map();      // key -> promise of the one read in progress

/**
 * One read at a time per key: callers that miss together (the grid and its
 * branches re-read at once after a write) share the read in progress instead of
 * each making their own. The promise is forgotten once it settles.
 */
export function readOnce(key, fn) {
  if (flying.has(key)) return flying.get(key);
  const p = Promise.resolve().then(fn).finally(() => flying.delete(key));
  flying.set(key, p);
  return p;
}

/**
 * Something WORKED OUT from the rows (the progress tree, the grid) kept under
 * the same rules: same stamp, same lifetime, cleared with the rows. The value
 * is handed out AS IS, not copied — a reader must build its answer from it and
 * never change it (trackerTreeService only maps it into new objects).
 */
export function cachedDerived(key, stamp, now = Date.now()) {
  const e = entries.get(`derived:${key}`);
  if (!e || now - e.at > TRACKER_TTL_MS || e.stamp !== stamp) { misses += 1; return null; }
  hits += 1;
  return e.data;
}

export function rememberDerived(key, stamp, value, now = Date.now()) {
  if (entries.size >= MAX_ENTRIES) entries.delete(entries.keys().next().value);
  entries.set(`derived:${key}`, { at: now, stamp, data: value });
  return value;
}

/** Forget everything — after any committed write in this process. */
export function invalidateTrackerCache() { entries.clear(); }

export const trackerCacheStats = () => ({ entries: entries.size, hits, misses });

const copyRows = (rows) => rows.map((r) => ({ ...r }));

/** One level deep: every row its own object, the free-stock map its own entries. */
export function copyTracker(data) {
  const free = new Map();
  for (const [k, v] of data.free ?? new Map()) free.set(k, { ...v });
  return {
    releases: copyRows(data.releases),
    items: copyRows(data.items),
    steps: copyRows(data.steps),
    deps: copyRows(data.deps),
    reqs: copyRows(data.reqs),
    reservations: copyRows(data.reservations),
    free,
  };
}

/**
 * The stamp of some releases: one round trip. Every part is a scalar subquery
 * (TiDB is happy with those in the select list; it is subqueries in a JOIN's ON
 * that it refuses).
 */
export async function trackerStamp(db, companyId, releaseIds) {
  const ids = [...releaseIds];
  const [[row]] = await db.query(
    `SELECT
       (SELECT CONCAT(COUNT(*), '/', COALESCE(MAX(s.updated_at), ''), '/', COALESCE(SUM(s.qty_good), 0), '/', COALESCE(SUM(s.qty_scrap), 0))
          FROM cf_production_steps s JOIN cf_production_items pi ON pi.id = s.production_item_id
         WHERE s.company_id = ? AND pi.company_id = ? AND pi.release_id IN (?)) AS steps,
       (SELECT CONCAT(COUNT(*), '/', COALESCE(MAX(pi.updated_at), ''))
          FROM cf_production_items pi WHERE pi.company_id = ? AND pi.release_id IN (?)) AS items,
       (SELECT CONCAT(COUNT(*), '/', COALESCE(MAX(r.updated_at), ''))
          FROM cf_production_releases r WHERE r.company_id = ? AND r.id IN (?)) AS releases,
       (SELECT CONCAT(COUNT(*), '/', COALESCE(MAX(l.updated_at), ''))
          FROM cf_sales_order_lines l JOIN cf_production_releases r ON r.order_line_id = l.id
         WHERE l.company_id = ? AND r.id IN (?)) AS order_lines,
       (SELECT CONCAT(COUNT(*), '/', COALESCE(MAX(q.updated_at), ''), '/', COALESCE(SUM(q.issued), 0))
          FROM cf_material_requirements q WHERE q.company_id = ? AND q.release_id IN (?)) AS reqs,
       (SELECT CONCAT(COUNT(*), '/', COALESCE(MAX(v.id), 0), '/', COALESCE(MAX(v.updated_at), ''))
          FROM cf_stock_reservations v WHERE v.company_id = ?) AS reservations,
       (SELECT COALESCE(MAX(k.id), 0) FROM cf_stock_ledger k WHERE k.company_id = ?) AS ledger,
       (SELECT CONCAT(COUNT(*), '/', COALESCE(MAX(w.updated_at), '')) FROM cf_work_orders w WHERE w.company_id = ?) AS work_orders,
       (SELECT CONCAT(COUNT(*), '/', COALESCE(MAX(ws.updated_at), '')) FROM cf_work_sessions ws WHERE ws.company_id = ?) AS sessions`,
    [companyId, companyId, ids, companyId, ids, companyId, ids, companyId, ids, companyId, ids, companyId, companyId, companyId, companyId],
  );
  return Object.values(row).map((v) => (v instanceof Date ? v.toISOString() : String(v ?? ''))).join('|');
}
