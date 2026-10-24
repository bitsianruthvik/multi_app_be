/**
 * notify.js — telling each company (spec §36.4).
 *
 *   notifyPublication(publication)   per company with CF HRMS: the impact (impact.js), ONE notification
 *                                    (unique per company and publication — a second call adds nothing),
 *                                    and emails queued for its Owner / HR logins when the change touches it.
 *   acknowledge                      once, by a login with compliance edit; who, when and a note are kept.
 *   resendPass                       an unacknowledged law change is mailed again every RESEND_DAYS days,
 *                                    at most MAX_SENDS times in all. The claim is a conditional UPDATE, so
 *                                    two instances never both re-send.
 *   sendPending                      the outbox: QUEUED → SENT / FAILED / SKIPPED, rate-limited (PASS_LIMIT a
 *                                    pass, COMPANY_HOURLY per company an hour); nothing leaves without SMTP.
 *
 * NEVER OUTSIDE THE COMPANY. Recipients are the company's own users (users.company_id) with access to
 * its CF HRMS app on the Owner, HR manager or HR executive role. At sending, the address is checked
 * again: the user still exists, is still of that company and still has that address — else SKIPPED.
 */
import { pool } from '../../lib/db.js';
import { computeImpact } from './impact.js';
import { mailConfigured, sendOne } from './mailer.js';

export const RESEND_DAYS = Number(process.env.CF_HRMS_COMPLIANCE_RESEND_DAYS) || 7;
export const MAX_SENDS = 4;
export const PASS_LIMIT = 100;
export const COMPANY_HOURLY = 30;
const EMAIL_RE = /^[^\s@<>()",;]+@[^\s@<>()",;]+\.[A-Za-z]{2,}$/;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const json = (v, d = null) => { if (v == null) return d; if (typeof v === 'object') return v; try { return JSON.parse(v); } catch { return d; } };
const dateText = (v) => (v == null ? null : (v instanceof Date ? `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}` : String(v).slice(0, 10)));
const stamp = (v) => (v ? (v instanceof Date ? v.toISOString() : String(v)) : null);

/** Companies that have the CF HRMS app. */
export async function companiesWithHrms(db = pool) {
  const [rows] = await db.query("SELECT c.id, c.name, c.slug FROM companies c JOIN apps a ON a.company_id = c.id AND a.slug = 'cf_hrms' WHERE c.deleted_at IS NULL ORDER BY c.id");
  return rows;
}

/** A company's Owner and HR logins with an email that looks like one. Never anybody of another company. */
export async function recipientsOf(db, companyId) {
  const [rows] = await db.query(
    `SELECT DISTINCT u.id, u.name, u.email FROM users u
       JOIN apps a ON a.company_id = u.company_id AND a.slug = 'cf_hrms'
       JOIN app_user_access aua ON aua.user_id = u.id AND aua.app_id = a.id AND aua.company_id = u.company_id AND aua.deleted_at IS NULL
       JOIN roles r ON r.id = aua.role_id AND r.company_id = u.company_id AND r.deleted_at IS NULL
       LEFT JOIN hrms_access_roles har ON har.company_id = u.company_id AND har.role_id = aua.role_id AND har.deleted_at IS NULL
      WHERE u.company_id = ? AND u.deleted_at IS NULL
        AND (LOWER(r.name) = 'admin' OR har.template_key IN ('OWNER', 'HR_MANAGER', 'HR_EXECUTIVE'))
      ORDER BY u.id`, [companyId]);
  return rows.filter((r) => EMAIL_RE.test(String(r.email ?? '').trim()));
}

function companyLink(slug) {
  const base = (process.env.FRONTEND_URL || 'https://multiappfe.vercel.app').replace(/\/+$/, '');
  return `${base}/${encodeURIComponent(slug)}/cf_hrms/compliance`;
}

function emailHtml({ company, title, body, lines = [], link, reason }) {
  const intro = reason === 'RESEND' ? '<p style="color:#8a5a00">A reminder: this has not been acknowledged yet.</p>' : '';
  return `<div style="font-family:Arial,sans-serif;font-size:14px;color:#1A1C2E;max-width:640px">
${intro}<h2 style="font-size:17px;margin:0 0 8px">${esc(title)}</h2>
<p style="margin:0 0 8px">${esc(body)}</p>
${lines.length ? `<ul>${lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>` : ''}
<p><a href="${esc(link)}">Open Compliance in CF HRMS</a> to see what it means for ${esc(company.name)} and acknowledge it.</p>
<p style="color:#777;font-size:12px">Sent to the Owner and HR logins of ${esc(company.name)}. Compliance stays with the employer and its CA; the app applies, checks, explains and records.</p></div>`;
}

/** Queue one email per recipient for a notification. Returns how many were queued. */
export async function queueEmails(db, company, note, reason = 'NEW') {
  const people = await recipientsOf(db, company.id);
  const impact = json(note.impact_json, {}) ?? {};
  const subject = `${reason === 'RESEND' ? 'Reminder: ' : ''}${note.title}`.slice(0, 300);
  for (const u of people) {
    await db.query(
      `INSERT INTO hrms_compliance_emails (company_id, notification_id, to_user_id, to_email, subject, body_html, reason, queued_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [company.id, note.id, u.id, String(u.email).trim(), subject,
        emailHtml({ company, title: note.title, body: note.body ?? '', lines: impact.lines ?? [], link: companyLink(company.slug), reason }), reason, new Date()]);
  }
  return people.length;
}

/** The words of a law-change notification for one company. */
function lawWords(pub, company, impact) {
  const where = pub.jurisdiction && pub.jurisdiction !== 'IN' ? ` (${pub.jurisdiction})` : '';
  const title = `Law change${where}: ${pub.title}`.slice(0, 300);
  const body = `${pub.summary ? `${pub.summary} ` : ''}In force from ${dateText(pub.effective_from)}. For ${company.name}: ${impact.lines.join(' ')}${pub.source_url ? ` Source: ${pub.source_url}` : ''}`;
  return { title, body };
}

/**
 * Every company with CF HRMS hears of a publication once. Returns [{ companyId, notificationId, emails, affected }].
 * Idempotent: a company that already has its notification for this publication is skipped.
 */
export async function notifyPublication(db, publicationId) {
  const [[pub]] = await db.query('SELECT * FROM hrms_compliance_publications WHERE id = ? AND deleted_at IS NULL', [publicationId]);
  if (!pub) return [];
  const out = [];
  for (const company of await companiesWithHrms(db)) {
    const [[have]] = await db.query('SELECT id FROM hrms_compliance_notifications WHERE company_id = ? AND publication_id = ? AND deleted_at IS NULL', [company.id, pub.id]);
    if (have) continue;
    const impact = await computeImpact(db, company.id, { domain: pub.domain, jurisdiction: pub.jurisdiction, ruleKey: pub.rule_key, effectiveFrom: dateText(pub.effective_from) });
    const { title, body } = lawWords(pub, company, impact);
    let id;
    try {
      const [ins] = await db.query(
        `INSERT INTO hrms_compliance_notifications (company_id, kind, publication_id, title, body, impact_json, last_sent_at, send_count) VALUES (?, 'LAW_CHANGE', ?, ?, ?, ?, ?, ?)`,
        [company.id, pub.id, title, body, JSON.stringify(impact), impact.affected ? new Date() : null, impact.affected ? 1 : 0]);
      id = ins.insertId;
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') continue; // another instance made it
      throw err;
    }
    // Email when the change touches the company; the bell and the Compliance page always show it.
    const emails = impact.affected ? await queueEmails(db, company, { id, title, body, impact_json: impact }, 'NEW') : 0;
    out.push({ companyId: company.id, notificationId: id, emails, affected: impact.affected });
  }
  await db.query('UPDATE hrms_compliance_publications SET companies_notified = companies_notified + ? WHERE id = ?', [out.length, pub.id]);
  return out;
}

export function shapeNotification(r) {
  return {
    id: r.id, kind: r.kind, publicationId: r.publication_id ?? null, deadlineKey: r.deadline_key ?? null, dueDate: dateText(r.due_date),
    title: r.title, body: r.body ?? '', impact: json(r.impact_json, null), status: r.status,
    acknowledgedAt: stamp(r.acknowledged_at), acknowledgedBy: r.ack_name ?? null, ackNote: r.ack_note ?? null,
    createdAt: stamp(r.created_at), lastSentAt: stamp(r.last_sent_at), sendCount: Number(r.send_count),
    sourceUrl: r.source_url ?? null, effectiveFrom: dateText(r.effective_from), domain: r.domain ?? null, jurisdiction: r.jurisdiction ?? null,
  };
}

const NOTE_SELECT = `SELECT n.*, u.name AS ack_name, p.source_url, p.effective_from, p.domain, p.jurisdiction
  FROM hrms_compliance_notifications n
  LEFT JOIN users u ON u.id = n.acknowledged_by
  LEFT JOIN hrms_compliance_publications p ON p.id = n.publication_id`;

export async function listNotifications(db, companyId, { status = 'ALL', kind = null, limit = 200 } = {}) {
  const where = ['n.company_id = ?', 'n.deleted_at IS NULL'];
  const params = [companyId];
  if (status !== 'ALL') { where.push('n.status = ?'); params.push(status); }
  if (kind) { where.push('n.kind = ?'); params.push(kind); }
  const [rows] = await db.query(`${NOTE_SELECT} WHERE ${where.join(' AND ')} ORDER BY n.status = 'OPEN' DESC, n.created_at DESC, n.id DESC LIMIT ?`, [...params, limit]);
  const [[emails]] = await db.query("SELECT COALESCE(SUM(status = 'QUEUED'), 0) AS queued, COALESCE(SUM(status = 'SENT'), 0) AS sent FROM hrms_compliance_emails WHERE company_id = ? AND deleted_at IS NULL", [companyId]);
  return { notifications: rows.map(shapeNotification), emails: { queued: Number(emails.queued), sent: Number(emails.sent) } };
}

export async function acknowledge(db, c, id, note = null) {
  const [[n]] = await db.query('SELECT * FROM hrms_compliance_notifications WHERE company_id = ? AND id = ? AND deleted_at IS NULL FOR UPDATE', [c.companyId, id]);
  if (!n) return null;
  if (n.status !== 'ACKNOWLEDGED') {
    await db.query("UPDATE hrms_compliance_notifications SET status = 'ACKNOWLEDGED', acknowledged_by = ?, acknowledged_at = ?, ack_note = ? WHERE company_id = ? AND id = ?",
      [c.userId, new Date(), note ? String(note).slice(0, 500) : null, c.companyId, id]);
    // Emails still waiting for this one are not needed any more.
    await db.query("UPDATE hrms_compliance_emails SET status = 'SKIPPED', error = 'acknowledged before it was sent' WHERE company_id = ? AND notification_id = ? AND status = 'QUEUED'", [c.companyId, id]);
  }
  const [[row]] = await db.query(`${NOTE_SELECT} WHERE n.company_id = ? AND n.id = ?`, [c.companyId, id]);
  return shapeNotification(row);
}

/** Unacknowledged law changes past RESEND_DAYS since the last mail: mailed again. */
export async function resendPass(db = pool, { now = new Date(), days = RESEND_DAYS } = {}) {
  const before = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const [due] = await db.query(
    `SELECT n.*, c.name AS company_name, c.slug AS company_slug FROM hrms_compliance_notifications n JOIN companies c ON c.id = n.company_id
      WHERE n.deleted_at IS NULL AND n.kind = 'LAW_CHANGE' AND n.status = 'OPEN' AND n.send_count BETWEEN 1 AND ? AND n.last_sent_at < ?`, [MAX_SENDS - 1, before]);
  const out = [];
  for (const n of due) {
    // The claim: only the instance whose UPDATE changes the row re-sends.
    const [u] = await db.query('UPDATE hrms_compliance_notifications SET last_sent_at = ?, send_count = send_count + 1 WHERE id = ? AND status = \'OPEN\' AND send_count = ? AND last_sent_at < ?', [now, n.id, n.send_count, before]);
    if (!u.affectedRows) continue;
    const queued = await queueEmails(db, { id: n.company_id, name: n.company_name, slug: n.company_slug }, n, 'RESEND');
    out.push({ companyId: n.company_id, notificationId: n.id, emails: queued });
  }
  return out;
}

/** The outbox, rate-limited. Without SMTP nothing is sent and every email stays QUEUED. */
export async function sendPending(db = pool, { limit = PASS_LIMIT, perCompanyHourly = COMPANY_HOURLY, now = new Date() } = {}) {
  if (!mailConfigured()) return { sent: 0, failed: 0, skipped: 0, reason: 'not configured' };
  const [queued] = await db.query("SELECT * FROM hrms_compliance_emails WHERE status = 'QUEUED' AND deleted_at IS NULL ORDER BY queued_at, id LIMIT ?", [limit]);
  const hourAgo = new Date(now.getTime() - 60 * 60 * 1000);
  const sentThisHour = new Map();
  const r = { sent: 0, failed: 0, skipped: 0, held: 0 };
  for (const e of queued) {
    if (!sentThisHour.has(e.company_id)) {
      const [[c]] = await db.query("SELECT COUNT(*) AS n FROM hrms_compliance_emails WHERE company_id = ? AND status = 'SENT' AND sent_at >= ?", [e.company_id, hourAgo]);
      sentThisHour.set(e.company_id, Number(c.n));
    }
    if (sentThisHour.get(e.company_id) >= perCompanyHourly) { r.held += 1; continue; }
    // Claim it, so a second instance does not send it too.
    const [cl] = await db.query("UPDATE hrms_compliance_emails SET attempts = attempts + 1, status = 'FAILED', error = 'sending' WHERE id = ? AND status = 'QUEUED'", [e.id]);
    if (!cl.affectedRows) continue;
    const [[u]] = await db.query('SELECT id, email, company_id, deleted_at FROM users WHERE id = ?', [e.to_user_id]);
    if (!u || u.deleted_at || Number(u.company_id) !== Number(e.company_id) || String(u.email ?? '').trim().toLowerCase() !== String(e.to_email).toLowerCase()) {
      await db.query("UPDATE hrms_compliance_emails SET status = 'SKIPPED', error = 'the login is gone, moved company or changed its email' WHERE id = ?", [e.id]);
      r.skipped += 1; continue;
    }
    try {
      await sendOne({ to: e.to_email, subject: e.subject, html: e.body_html });
      await db.query("UPDATE hrms_compliance_emails SET status = 'SENT', sent_at = ?, error = NULL WHERE id = ?", [new Date(), e.id]);
      sentThisHour.set(e.company_id, sentThisHour.get(e.company_id) + 1);
      r.sent += 1;
    } catch (err) {
      // Back to the queue for the next pass, up to three tries.
      await db.query('UPDATE hrms_compliance_emails SET status = IF(attempts >= 3, \'FAILED\', \'QUEUED\'), error = ? WHERE id = ?', [String(err.message).slice(0, 500), e.id]);
      r.failed += 1;
    }
  }
  return r;
}

export default { notifyPublication, listNotifications, acknowledge, resendPass, sendPending, recipientsOf, companiesWithHrms, queueEmails, shapeNotification, RESEND_DAYS };
