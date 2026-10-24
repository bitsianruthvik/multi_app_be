/**
 * scheduler.js — the hourly compliance pass (spec §36.4), like the attendance nightly run
 * (services/attendance/scheduler.js): started by app.js in the real server only, never in a test
 * script; every step is safe on a restart and with two instances, because each claims its work in
 * the database first (a unique row or a conditional UPDATE only one instance can win).
 *
 *   1. the watcher: every source that is due (watcher.js — a claim row per source and slot)
 *   2. deadline reminders: 3 days and 1 day before, per company (the mark row's reminded_3_at /
 *      reminded_1_at, set by a conditional UPDATE): a DEADLINE notification on the bell and an email
 *   3. re-sends: unacknowledged law changes every RESEND_DAYS days (notify.resendPass)
 *   4. the outbox: queued emails sent, rate-limited (notify.sendPending — nothing without SMTP)
 *
 * Off with CF_HRMS_COMPLIANCE_WATCHER=off (then nothing is fetched, reminded or sent by this server).
 */
import { pool, withTransaction } from '../../lib/db.js';
import { logger } from '../../../../core/utils/logger.js';
import { watchPass } from './watcher.js';
import { companiesWithHrms, queueEmails, resendPass, sendPending } from './notify.js';
import { deadlinesFor, today } from './calendar.js';

const HOUR = 60 * 60 * 1000;
let timer = null;

/** Reminders for one company's deadlines in the next three days. Returns what was sent. */
export async function remindCompany(db, company, { on = today() } = {}) {
  const cal = await deadlinesFor(db, company.id, { from: on, to: new Date(Date.parse(`${on}T00:00:00Z`) + 3 * 86400000).toISOString().slice(0, 10), on });
  const out = [];
  for (const d of cal.deadlines) {
    if (d.status === 'DONE') continue;
    const which = d.daysLeft <= 1 ? 'reminded_1_at' : d.daysLeft <= 3 ? 'reminded_3_at' : null;
    if (!which) continue;
    await db.query('INSERT IGNORE INTO hrms_compliance_deadline_marks (company_id, deadline_key, due_date) VALUES (?, ?, ?)', [company.id, d.key, d.dueDate]);
    // The claim: only one instance changes the row.
    const [u] = await db.query(`UPDATE hrms_compliance_deadline_marks SET ${which} = ? WHERE company_id = ? AND deadline_key = ? AND deleted_at IS NULL AND done_at IS NULL AND ${which} IS NULL`, [new Date(), company.id, d.key]);
    if (!u.affectedRows) continue;
    const when = d.daysLeft <= 0 ? 'today' : d.daysLeft === 1 ? 'tomorrow' : `in ${d.daysLeft} days`;
    const title = `Due ${when} (${d.dueDate}): ${d.title}`.slice(0, 300);
    const body = `${d.title} is due on ${d.dueDate}. Mark it done on Compliance › Calendar once it is filed or paid. Date from: ${d.source}.`;
    const [[have]] = await db.query('SELECT id FROM hrms_compliance_notifications WHERE company_id = ? AND deadline_key = ? AND deleted_at IS NULL', [company.id, d.key]);
    let id = have?.id;
    if (id) await db.query("UPDATE hrms_compliance_notifications SET title = ?, body = ?, status = 'OPEN', last_sent_at = ?, send_count = send_count + 1 WHERE id = ?", [title, body, new Date(), id]);
    else {
      const [ins] = await db.query("INSERT INTO hrms_compliance_notifications (company_id, kind, deadline_key, due_date, title, body, last_sent_at, send_count) VALUES (?, 'DEADLINE', ?, ?, ?, ?, ?, 1)", [company.id, d.key, d.dueDate, title, body, new Date()]);
      id = ins.insertId;
    }
    const emails = await queueEmails(db, company, { id, title, body, impact_json: { lines: [] } }, 'REMINDER');
    out.push({ key: d.key, which, emails });
  }
  return out;
}

/** One pass. Each step's failure is logged and leaves the others to run. */
export async function compliancePass({ now = new Date(), fetchOptions = {} } = {}) {
  const done = {};
  try { done.watched = await watchPass({ now, fetchOptions }); } catch (err) { logger.warn({ err: err.message }, '[cf_hrms] compliance watcher pass failed'); }
  try {
    done.reminded = [];
    for (const company of await companiesWithHrms(pool)) {
      const r = await withTransaction((conn) => remindCompany(conn, company));
      if (r.length) done.reminded.push({ companyId: company.id, r });
    }
  } catch (err) { logger.warn({ err: err.message }, '[cf_hrms] compliance reminders failed'); }
  try { done.resent = await withTransaction((conn) => resendPass(conn, { now })); } catch (err) { logger.warn({ err: err.message }, '[cf_hrms] compliance re-sends failed'); }
  try { done.mail = await sendPending(pool, { now }); } catch (err) { logger.warn({ err: err.message }, '[cf_hrms] compliance outbox failed'); }
  const busy = (done.watched ?? []).some((w) => !w.skipped) || done.reminded?.length || done.resent?.length || done.mail?.sent;
  if (busy) logger.info({ watched: (done.watched ?? []).map((w) => ({ id: w.sourceId, status: w.status, found: w.found })), reminded: done.reminded?.length ?? 0, resent: done.resent?.length ?? 0, mail: done.mail }, '[cf_hrms] compliance pass');
  return done;
}

export function startCompliance() {
  if (timer || String(process.env.CF_HRMS_COMPLIANCE_WATCHER ?? '').toLowerCase() === 'off') return;
  const tick = () => { compliancePass().catch((err) => logger.warn({ err: err.message }, '[cf_hrms] compliance pass failed')); };
  setTimeout(tick, 2 * 60 * 1000).unref();
  timer = setInterval(tick, HOUR);
  timer.unref();
}

export default { compliancePass, remindCompany, startCompliance };
