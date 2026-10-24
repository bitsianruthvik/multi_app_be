/**
 * watcher.js — reads each source when it is due and queues what is new as NOTICES (spec §36.4).
 *
 * SAFE ON A RESTART, AND WITH TWO INSTANCES — the attendance scheduler's pattern (a claim row with a
 * unique key) adapted to a slow network read:
 *   a check of a source CLAIMS its slot first: a row in hrms_compliance_check_runs with run_key
 *   "SRC:<id>:<slot>" (slot = the source's frequency window, or "MANUAL:<minute>" for "Check now"),
 *   unique. A second instance gets ER_DUP_ENTRY and leaves it. The page is read OUTSIDE any
 *   transaction (a read can take 20 s); what it found is written in ONE transaction with the run's
 *   end. A claim left RUNNING for more than STALE_MINUTES (the server died mid-read) is taken over by
 *   the next pass — an UPDATE that only one instance can win.
 *
 * WHAT COUNTS AS NEW. Each link is an item (hash of its URL); the title and date are its content
 * hash. The FIRST good read of a source is its baseline: every item is stored and NO notice is made
 * (a page with two thousand old circulars must not flood the queue). After that a new item is a NEW
 * notice and a changed title / date (or page text) is a CHANGED notice.
 *
 * WHEN A SITE BLOCKS OR CHANGES. Nothing throws: a refusal (401 / 403 / robots.txt) is BLOCKED, any
 * other failure ERROR, and a page with no links at all is an ERROR ("built by script, or its layout
 * changed") — with the reason on the source, shown on the console, and the next try after
 * min(frequency, 6 h × failures). Known items are never deleted because a read found nothing.
 *
 * No AI call: a notice is a title, a link, a date and the source. An AI summary could be added at
 * the marked line below (hrms_compliance_notices.summary) without changing anything else.
 */
import { pool, withTransaction } from '../../lib/db.js';
import { fetchSource } from './fetcher.js';
import { extractItems, alsoSitesOf } from './extract.js';

export const STALE_MINUTES = 15;
const HOUR = 60 * 60 * 1000;

// A Date goes to mysql2 as it is (written and read back in the server's time zone, like every other DATETIME here).
const sqlTime = (d) => new Date(d.getTime());

/** The slot a scheduled check claims: one per frequency window. */
export const slotOf = (source, now) => Math.floor(now.getTime() / (Math.max(1, Number(source.frequency_hours)) * HOUR));

async function claim(source, runKey, now) {
  try {
    const [r] = await pool.query('INSERT INTO hrms_compliance_check_runs (source_id, run_key, status, started_at) VALUES (?, ?, \'RUNNING\', ?)', [source.id, runKey, sqlTime(now)]);
    return r.insertId;
  } catch (err) {
    if (err.code !== 'ER_DUP_ENTRY') throw err;
    // Taken. A claim left RUNNING by a server that died is taken over — by exactly one instance.
    const stale = sqlTime(new Date(now.getTime() - STALE_MINUTES * 60 * 1000));
    const [u] = await pool.query("UPDATE hrms_compliance_check_runs SET started_at = ?, error = 'taken over: the earlier check never finished' WHERE run_key = ? AND status = 'RUNNING' AND started_at < ?", [sqlTime(now), runKey, stale]);
    if (!u.affectedRows) return null;
    const [[row]] = await pool.query('SELECT id FROM hrms_compliance_check_runs WHERE run_key = ?', [runKey]);
    return row.id;
  }
}

/**
 * One source: claim, read, compare, write. Returns { status, found: { new, changed }, error } or
 * { skipped: true } when another instance holds the claim.
 */
export async function checkSource(sourceId, { now = new Date(), manual = false, fetchOptions = {} } = {}) {
  const [[source]] = await pool.query('SELECT * FROM hrms_compliance_sources WHERE id = ? AND deleted_at IS NULL', [sourceId]);
  if (!source) return { skipped: true, reason: 'no such source' };
  const runKey = manual ? `SRC:${source.id}:MANUAL:${Math.floor(now.getTime() / 60000)}` : `SRC:${source.id}:${slotOf(source, now)}`;
  const runId = await claim(source, runKey, now);
  if (!runId) return { skipped: true, reason: 'another check holds this slot' };

  const got = await fetchSource(source.url, { alsoSites: alsoSitesOf(source), ...fetchOptions });
  let items = [];
  let failure = null;
  let filteredOut = false;
  if (got.ok) {
    const found = extractItems(source, got.body, got.url);
    items = found.items;
    if (!found.total) failure = { status: 'ERROR', error: 'No links found on the page — it may be built by script in the browser, or its layout changed.' };
    else if (!items.length) filteredOut = found.total;
  } else {
    failure = { status: got.blocked ? 'BLOCKED' : 'ERROR', error: got.error };
  }

  return withTransaction(async (conn) => {
    const at = sqlTime(now);
    if (failure) {
      const fails = Number(source.fail_count) + 1;
      const waitH = Math.min(Number(source.frequency_hours), 6 * fails);
      await conn.query('UPDATE hrms_compliance_sources SET last_checked_at = ?, last_status = ?, last_error = ?, fail_count = ?, next_check_at = ? WHERE id = ?',
        [at, failure.status, String(failure.error).slice(0, 500), fails, sqlTime(new Date(now.getTime() + waitH * HOUR)), source.id]);
      await conn.query("UPDATE hrms_compliance_check_runs SET status = 'ERROR', finished_at = ?, http_status = ?, error = ? WHERE id = ?", [at, got.status ?? null, String(failure.error).slice(0, 500), runId]);
      return { status: failure.status, error: failure.error, found: { new: 0, changed: 0 }, items: 0 };
    }
    const baseline = !source.last_ok_at;
    const [known] = await conn.query('SELECT id, item_hash, content_hash FROM hrms_compliance_source_items WHERE source_id = ?', [source.id]);
    const byHash = new Map(known.map((k) => [k.item_hash, k]));
    let fresh = 0; let changed = 0;
    for (const it of items) {
      const k = byHash.get(it.itemHash);
      if (!k) {
        const [ins] = await conn.query(
          'INSERT INTO hrms_compliance_source_items (source_id, item_hash, content_hash, url, title, item_date, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          [source.id, it.itemHash, it.contentHash, it.url.slice(0, 1000), it.title.slice(0, 500), it.date, at, at]);
        if (!baseline) {
          fresh += 1;
          // (An AI summary of the notice would be written here, into `summary`. Not today: title, link, date, source.)
          await conn.query('INSERT INTO hrms_compliance_notices (source_id, item_id, change_kind, title, url, item_date, found_at) VALUES (?, ?, \'NEW\', ?, ?, ?, ?)',
            [source.id, ins.insertId, it.title.slice(0, 500), it.url.slice(0, 1000), it.date, at]);
        }
      } else if (k.content_hash !== it.contentHash) {
        await conn.query('UPDATE hrms_compliance_source_items SET content_hash = ?, title = ?, item_date = ?, last_seen_at = ?, changed_at = ? WHERE id = ?', [it.contentHash, it.title.slice(0, 500), it.date, at, at, k.id]);
        if (!baseline) {
          changed += 1;
          await conn.query('INSERT INTO hrms_compliance_notices (source_id, item_id, change_kind, title, url, item_date, found_at) VALUES (?, ?, \'CHANGED\', ?, ?, ?, ?)',
            [source.id, k.id, it.title.slice(0, 500), it.url.slice(0, 1000), it.date, at]);
        }
      } else {
        await conn.query('UPDATE hrms_compliance_source_items SET last_seen_at = ? WHERE id = ?', [at, k.id]);
      }
    }
    const [[{ n }]] = await conn.query('SELECT COUNT(*) AS n FROM hrms_compliance_source_items WHERE source_id = ? AND deleted_at IS NULL', [source.id]);
    // A page that suddenly lists far fewer links than before has probably changed its layout: said, not an error.
    const drop = Number(source.item_count) >= 10 && items.length < Number(source.item_count) * 0.2;
    const note = drop ? `The page now lists ${items.length} links, far fewer than the ${source.item_count} known — its layout may have changed.`
      : filteredOut ? `${filteredOut} links on the page; none matches the source's pattern today.`
        : (baseline ? `First read: ${items.length} items stored as the starting point; nothing queued.` : null);
    await conn.query(
      'UPDATE hrms_compliance_sources SET last_checked_at = ?, last_ok_at = ?, last_status = ?, last_error = ?, fail_count = 0, item_count = ?, last_change_at = IF(?, ?, last_change_at), next_check_at = ? WHERE id = ?',
      [at, at, fresh + changed ? 'CHANGED' : 'OK', note, n, fresh + changed > 0, at, sqlTime(new Date(now.getTime() + Number(source.frequency_hours) * HOUR)), source.id]);
    await conn.query("UPDATE hrms_compliance_check_runs SET status = 'DONE', finished_at = ?, http_status = ?, items_seen = ?, found_new = ?, found_changed = ? WHERE id = ?", [at, got.status ?? null, items.length, fresh, changed, runId]);
    return { status: fresh + changed ? 'CHANGED' : 'OK', baseline, found: { new: fresh, changed }, items: items.length, note };
  });
}

/** Every active source that is due, one after another. */
export async function watchPass({ now = new Date(), limit = 20, fetchOptions = {} } = {}) {
  const [due] = await pool.query('SELECT id FROM hrms_compliance_sources WHERE deleted_at IS NULL AND active = 1 AND (next_check_at IS NULL OR next_check_at <= ?) ORDER BY next_check_at IS NOT NULL, next_check_at LIMIT ?', [sqlTime(now), limit]);
  const done = [];
  for (const s of due) {
    try { done.push({ sourceId: s.id, ...(await checkSource(s.id, { now, fetchOptions })) }); } catch (err) { done.push({ sourceId: s.id, status: 'ERROR', error: err.message }); }
  }
  return done;
}

export default { checkSource, watchPass, slotOf, STALE_MINUTES };
