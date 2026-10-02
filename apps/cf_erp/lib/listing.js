/**
 * Server-side list paging — the one contract every cf_erp list screen pages by.
 *
 * WHY: lists used to load a capped batch (200 / 500 / 1000 rows) and filter and
 * count in the browser, so beyond the cap a search quietly missed records and a
 * chip counted only what happened to be loaded (2026-10-02: "the catalog says
 * only 500 items are there"). Now a list filters, counts and sorts in SQL and
 * hands back one page at a time.
 *
 * The request (all optional, all additive — an old caller that sends none of
 * them gets exactly what it got before, a bare array):
 *   paged=1          answer { rows, total, counts?, limit, offset, hasMore }
 *   limit, offset    the page (limit capped at PAGE_MAX)
 *   all=1            every matching row (an export) — capped at EXPORT_MAX, and
 *                    `truncated: true` says so if that cap was ever reached
 *   sort, dir        a column key the endpoint whitelists, asc|desc
 *
 * Counts (chip / stat figures) are computed by the endpoint over the SAME
 * filters minus the facet the chip sets, in the same Promise.all as the rows —
 * set-based, one or two round trips (prod is ~49 ms away per round trip).
 */
export const PAGE_MAX = 500;
export const EXPORT_MAX = 50_000;

const truthy = (v) => v === '1' || v === 1 || v === true || v === 'true';

/** Does the caller want the paged shape? (`all=1` implies it.) */
export const wantsPage = (q = {}) => truthy(q.paged) || truthy(q.all);

/**
 * limit / offset for one page. `def` is what an old caller that sends no limit
 * got before — keep it, so old callers see no change.
 */
export function pageArgs(q = {}, { def = 100, max = PAGE_MAX } = {}) {
  const all = truthy(q.all);
  if (all) return { limit: EXPORT_MAX, offset: 0, all: true };
  const limit = Math.min(Math.max(Number(q.limit) || def, 1), max);
  const offset = Math.max(Math.floor(Number(q.offset) || 0), 0);
  return { limit, offset, all: false };
}

/**
 * ORDER BY from a whitelist: `map` is { key: 'sql expr' }. Unknown keys fall
 * back. `tie` keeps the order stable across pages (always end on a unique key,
 * or rows repeat / vanish between pages).
 */
export function orderBy(q = {}, map = {}, fallback, tie) {
  const expr = Object.prototype.hasOwnProperty.call(map, q.sort) ? map[q.sort] : null;
  if (!expr) return fallback;
  const dir = String(q.dir).toLowerCase() === 'desc' ? 'DESC' : 'ASC';
  // NULLs last in both directions (MySQL puts them first on ASC).
  return `(${expr}) IS NULL, ${expr} ${dir}${tie ? `, ${tie}` : ''}`;
}

/** %term% for LIKE, with LIKE's own wildcards escaped. null when blank. */
export function likeOf(term) {
  if (term == null) return null;
  const s = String(term).trim();
  if (!s) return null;
  return `%${s.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

/** The paged answer. */
export function pageOf(rows, total, { limit, offset, all }, extra = {}) {
  const t = Number(total) || 0;
  return {
    rows,
    total: t,
    limit: all ? rows.length : limit,
    offset,
    hasMore: !all && offset + rows.length < t,
    ...(all && t > rows.length ? { truncated: true } : {}),
    ...extra,
  };
}

/** { key: n } from GROUP BY rows [{ k, n }], with every expected key present (0). */
export function countsBy(rows, keys = [], keyCol = 'k', nCol = 'n') {
  const out = Object.fromEntries(keys.map((k) => [k, 0]));
  for (const r of rows) {
    const k = r[keyCol];
    if (k == null) continue;
    out[k] = (out[k] ?? 0) + Number(r[nCol] || 0);
  }
  return out;
}
