/**
 * scheduler.js — the nightly run: yesterday, for every company whose attendance is live.
 * (TM/CF_HRMS_HIRING_SPEC.md §28.2: "nightly for yesterday".)
 *
 * SAFE ON A RESTART, AND WITH TWO INSTANCES. Every hour the server looks at each live company.
 * When it is past 10:00 there (every night shift has ended) and yesterday has no NIGHTLY claim,
 * it claims it — a row in hrms_attendance_runs with run_key "NIGHTLY:<date>", unique per company —
 * and processes the two days before today, IN THE SAME TRANSACTION as the claim. A crash rolls the
 * claim back with the work, so the next hour tries again; a second instance waits on the claim's
 * unique key and then finds it taken. A server that was down for a night catches up only the
 * latest night (the days before were already processed by punches as they came, and
 * POST /attendance/process covers any range by hand).
 *
 * Started by app.js only in the real server (index.js), never in a test script.
 * Turn it off with CF_HRMS_ATTENDANCE_NIGHTLY=off (Render: then add a cron job calling
 * POST /api/<company>/cf_hrms/attendance/process — see CF_HRMS_MANUAL.md).
 */
import { pool, withTransaction } from '../../lib/db.js';
import { logger } from '../../../../core/utils/logger.js';
import { addDays } from '../leave/days.js';
import { nowIn, utcNow } from './time.js';
import { processRange } from './process.js';

export const RUN_AFTER_HOUR = 10;
const HOUR = 60 * 60 * 1000;
let timer = null;

/** One pass over every live company. Returns what it did, for the log and a test. */
export async function nightlyPass({ now = new Date() } = {}) {
  const [companies] = await pool.query('SELECT company_id, default_timezone FROM hrms_attendance_settings WHERE live_from IS NOT NULL');
  const done = [];
  for (const s of companies) {
    const local = nowIn(s.default_timezone || 'Asia/Kolkata', now);
    if (Number(local.slice(11, 13)) < RUN_AFTER_HOUR) continue;
    const yesterday = addDays(local.slice(0, 10), -1);
    try {
      const r = await withTransaction(async (conn) => {
        try {
          await conn.query('INSERT INTO hrms_attendance_runs (company_id, kind, run_key, from_date, to_date, started_at, note) VALUES (?, \'NIGHTLY\', ?, ?, ?, ?, ?)',
            [s.company_id, `NIGHTLY:${yesterday}`, addDays(yesterday, -1), yesterday, utcNow(), 'the nightly run']);
        } catch (err) {
          if (err.code === 'ER_DUP_ENTRY') return null;
          throw err;
        }
        return processRange(conn, { companyId: s.company_id, userId: null }, { from: addDays(yesterday, -1), to: yesterday, kind: 'NIGHTLY', now: local });
      });
      if (r) done.push({ companyId: s.company_id, date: yesterday, days: r.daysWritten, penalties: r.penalties });
    } catch (err) {
      logger.warn({ err: err.message, companyId: s.company_id }, '[cf_hrms] attendance nightly run failed; the next hour tries again');
    }
  }
  if (done.length) logger.info({ done }, '[cf_hrms] attendance nightly run');
  return done;
}

export function startNightly() {
  if (timer || String(process.env.CF_HRMS_ATTENDANCE_NIGHTLY ?? '').toLowerCase() === 'off') return;
  const tick = () => { nightlyPass().catch((err) => logger.warn({ err: err.message }, '[cf_hrms] attendance nightly pass failed')); };
  setTimeout(tick, 90 * 1000).unref();
  timer = setInterval(tick, HOUR);
  timer.unref();
}

export default { nightlyPass, startNightly, RUN_AFTER_HOUR };
