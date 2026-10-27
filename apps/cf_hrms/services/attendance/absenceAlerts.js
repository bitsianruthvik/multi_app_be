/**
 * absenceAlerts.js — "who has not come in" (TM/CF_HRMS_HIRING_SPEC.md §42.3).
 *
 * WHEN. For every shift working on a date, the check is DUE at the shift's start + the shift's grace + the
 * company's delay (Attendance › Settings). From then until MAX_LATE_MINUTES after it, a pass that finds it due
 * checks it ONCE; a server that was down longer skips it (an alert hours late is noise, not help).
 *
 * WHO IS LISTED. A person whose seat is on that shift, the day a WORKING day of the shift (not a weekly off,
 * not a full holiday of its calendar), joined and not left, attendance live on the date and the month not
 * closed, with NO punch from the shift's window start until now, no approved full-day leave (or first-half
 * leave), no approved on-duty, and no day row set by hand / by a correction / by a file saying otherwise.
 *
 * WHO HEARS — ONE DIGEST PER RECIPIENT per (date, shift), never one message per absent person:
 *   - HR: logins of the company with CF HRMS on an access role of the chosen templates (default Owner and HR
 *     manager; "OWNER" also means the platform role admin). A department-scoped login hears only of the
 *     people in its org units.
 *   - In-charges: each listed person's RESOLVED MANAGER (§40, reportingResolver.loadReportingModel →
 *     model.manager: explicit line, unit head, Reports into, walking up past vacant chairs) — the person in
 *     that chair, when they have a login. They hear only of their own people.
 *   A login that is both hears once, of the union.
 * CHANNELS: channels.js (in-app and email now; SMS / WhatsApp stubs that send nothing until a provider is set).
 *
 * SAFE ON A RESTART AND WITH TWO INSTANCES. The claim is a row in hrms_absence_alert_runs, run_key
 * "<date>:<shift id>" unique per company, inserted IN THE SAME TRANSACTION as the digests: a crash rolls both
 * back (the next pass tries again), a second instance waits on the unique key and then finds it taken. So a
 * shift's alert goes out once a day, whatever happens. Emails go through the compliance outbox after commit.
 *
 * Started by app.js in the real server only (every 5 minutes); off with CF_HRMS_ABSENCE_ALERTS=off.
 */
import { pool, withTransaction } from '../../lib/db.js';
import { invalid } from '../../lib/errors.js';
import { audit } from '../peopleService.js';
import { logger } from '../../../../core/utils/logger.js';
import { addDays, weekdayOf, WEEKDAY_NAMES } from '../leave/days.js';
import { loadPersons } from '../leave/requestService.js';
import { loadReportingModel } from '../reportingResolver.js';
import { scopeFor } from '../accessScope.js';
import { sendPending } from '../compliance/notify.js';
import { settingsOf, closedMonths } from './settings.js';
import { loadInputs, planDay, leaveOn } from './process.js';
import { nowIn, toMin, fromMin, hm, monthOf, day, wall } from './time.js';
import { CHANNELS, SETTING_KEY, channelStatus } from './channels.js';

export const MAX_LATE_MINUTES = 4 * 60;
export const HR_TEMPLATES = ['OWNER', 'HR_MANAGER', 'HR_EXECUTIVE'];
export const DEFAULT_ALERT_SETTINGS = Object.freeze({
  enabled: false, delayMinutes: 30, hrTemplates: ['OWNER', 'HR_MANAGER'], notifyManagers: true,
  channels: { inApp: true, email: true, sms: false, whatsapp: false },
});
const PASS_EVERY_MS = 5 * 60 * 1000;
/** A day row set by a person (or a file) that says the day is accounted for. */
const SET_BY_HAND = new Set(['MANUAL', 'REGULARIZATION', 'IMPORT']);
const json = (v, d = null) => { if (v == null) return d; if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return d; } };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const MONTHS3 = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dateWords = (d) => `${WEEKDAY_NAMES[weekdayOf(d) - 1].slice(0, 3)} ${Number(d.slice(8, 10))} ${MONTHS3[Number(d.slice(5, 7)) - 1]}`;

/* ══ settings ═══════════════════════════════════════════════════════════════ */

export async function alertSettingsOf(db, companyId) {
  const [[r]] = await db.query('SELECT * FROM hrms_absence_alert_settings WHERE company_id = ? AND deleted_at IS NULL', [companyId]);
  const d = DEFAULT_ALERT_SETTINGS;
  if (!r) return { ...d, hrTemplates: [...d.hrTemplates], channels: { ...d.channels }, saved: false };
  const ch = json(r.channels_json, {}) ?? {};
  return {
    enabled: Boolean(r.enabled), delayMinutes: Number(r.delay_minutes),
    hrTemplates: (json(r.hr_templates_json, null) ?? d.hrTemplates).filter((t) => HR_TEMPLATES.includes(t)),
    notifyManagers: Boolean(r.notify_managers),
    channels: Object.fromEntries(Object.keys(d.channels).map((k) => [k, ch[k] === undefined ? d.channels[k] : Boolean(ch[k])])),
    saved: true,
  };
}

/** PUT /attendance/alerts/settings */
export async function putAlertSettings(conn, c, body = {}, requestId = null) {
  const before = await alertSettingsOf(conn, c.companyId);
  const problems = [];
  const next = { ...before, channels: { ...before.channels } };
  if (body.enabled !== undefined) next.enabled = body.enabled === true || body.enabled === 1 || body.enabled === 'true';
  if (body.delayMinutes !== undefined) {
    const n = Number(body.delayMinutes);
    if (!Number.isInteger(n) || n < 0 || n > 600) problems.push('The delay is a whole number of minutes from 0 to 600.');
    else next.delayMinutes = n;
  }
  if (body.hrTemplates !== undefined) {
    const t = Array.isArray(body.hrTemplates) ? [...new Set(body.hrTemplates.map((x) => String(x).toUpperCase()))] : null;
    if (!t || t.some((x) => !HR_TEMPLATES.includes(x))) problems.push('HR who hear: choose from Owner, HR manager and HR executive.');
    else next.hrTemplates = t;
  }
  if (body.notifyManagers !== undefined) next.notifyManagers = Boolean(body.notifyManagers);
  if (body.channels !== undefined) {
    for (const k of Object.keys(DEFAULT_ALERT_SETTINGS.channels)) if (body.channels?.[k] !== undefined) next.channels[k] = Boolean(body.channels[k]);
  }
  if (next.enabled && !next.hrTemplates.length && !next.notifyManagers) problems.push('Nobody would hear: choose HR roles, in-charges, or both.');
  if (next.enabled && !Object.values(next.channels).some(Boolean)) problems.push('Choose at least one way to tell them (in the app, email …).');
  if (problems.length) throw invalid('INVALID', problems[0], { problems });
  await conn.query(
    `INSERT INTO hrms_absence_alert_settings (company_id, enabled, delay_minutes, hr_templates_json, notify_managers, channels_json, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE enabled = VALUES(enabled), delay_minutes = VALUES(delay_minutes), hr_templates_json = VALUES(hr_templates_json),
       notify_managers = VALUES(notify_managers), channels_json = VALUES(channels_json), deleted_at = NULL`,
    [c.companyId, next.enabled ? 1 : 0, next.delayMinutes, JSON.stringify(next.hrTemplates), next.notifyManagers ? 1 : 0, JSON.stringify(next.channels), c.userId]);
  const after = await alertSettingsOf(conn, c.companyId);
  const strip = ({ saved, ...x }) => x;
  await audit(conn, c, 'hrms_absence_alert_settings', c.companyId, 'UPDATE', strip(before), strip(after), requestId);
  return { settings: after };
}

/* ══ who is due, who is absent (pure over loaded inputs) ════════════════════ */

/**
 * The checks of a pass over some people: Map<runKey, { runKey, date, shiftId, shiftName, start, dueAt, people: [person] , absent: [{ person, why }] }>
 * for every (date, shift) that is due at `now` (start + grace + delay ≤ now ≤ that + MAX_LATE_MINUTES).
 * @param people  loadInputs(...).people for [dates]
 * @param records Map<"employeeId|date", { status, source }>
 * @param opts    { now (wall-clock), dates, delayMinutes, liveFrom, closed: Set<'YYYY-MM'>, ignoreLate }
 */
export function dueChecks(people, records, { now, dates, delayMinutes, liveFrom, closed = new Set(), ignoreLate = false }) {
  const out = new Map();
  for (const person of people) {
    if (!person.shift) continue;
    for (const date of dates) {
      if (!liveFrom || date < liveFrom || closed.has(monthOf(date))) continue;
      const plan = planDay(date, person.shift, person.holidays);
      if (plan.kind !== 'WORKING' || !plan.startAt) continue;
      const due = fromMin(toMin(plan.startAt) + (Number(person.shift.graceIn) || 0) + delayMinutes);
      if (now < due) continue;
      if (!ignoreLate && toMin(now) - toMin(due) > MAX_LATE_MINUTES) continue;
      const key = `${date}:${person.shift.id}`;
      if (!out.has(key)) out.set(key, { runKey: key, date, shiftId: person.shift.id, shiftName: person.shift.name, start: plan.start, dueAt: due, people: [], absent: [] });
      const check = out.get(key);
      const e = person.employee;
      if ((e.joinDate && date < e.joinDate) || (e.exitDate && date > e.exitDate)) continue;
      check.people.push(person);
      const lv = leaveOn(person, date);
      if (lv && (!lv.half || lv.half === 'FIRST')) continue;
      if (person.regs.some((r) => day(r.attendance_date) === date && r.kind === 'ON_DUTY')) continue;
      const rec = records.get(`${e.id}|${date}`);
      if (rec && SET_BY_HAND.has(rec.source) && rec.status !== 'ABSENT' && rec.status !== 'UNKNOWN') continue;
      if (person.punches.some((p) => p.at >= plan.windowFrom && p.at <= now)) continue;
      check.absent.push({ person, why: lv?.half === 'SECOND' ? 'not punched in (second-half leave only)' : 'not punched in' });
    }
  }
  return out;
}

/* ══ recipients ═════════════════════════════════════════════════════════════ */

/** HR logins of the chosen templates, with their scope: [{ userId, name, email, phone, all, departmentIds }]. */
async function hrRecipients(db, companyId, templates) {
  if (!templates.length) return [];
  const [rows] = await db.query(
    `SELECT DISTINCT u.id, u.name, u.email, COALESCE(har.scope, 'COMPANY') AS scope, LOWER(r.name) = 'admin' AS is_admin, har.template_key
       FROM users u
       JOIN apps a ON a.company_id = u.company_id AND a.slug = 'cf_hrms'
       JOIN app_user_access aua ON aua.user_id = u.id AND aua.app_id = a.id AND aua.company_id = u.company_id AND aua.deleted_at IS NULL
       JOIN roles r ON r.id = aua.role_id AND r.company_id = u.company_id AND r.deleted_at IS NULL
       LEFT JOIN hrms_access_roles har ON har.company_id = u.company_id AND har.role_id = aua.role_id AND har.deleted_at IS NULL
      WHERE u.company_id = ? AND u.deleted_at IS NULL
        AND ((? AND LOWER(r.name) = 'admin') OR har.template_key IN (?))
      ORDER BY u.id`, [companyId, templates.includes('OWNER') ? 1 : 0, templates]);
  const out = [];
  for (const r of rows) {
    const owner = Boolean(Number(r.is_admin));
    const scope = owner ? { all: true } : await scopeFor(db, { companyId, userId: r.id, scope: r.scope, owner: false });
    out.push({ userId: r.id, name: r.name, email: r.email, all: Boolean(scope.all), departmentIds: scope.all ? null : scope.departmentIds });
  }
  return out;
}

/* ══ the digest ═════════════════════════════════════════════════════════════ */

const LIST_MAX = 40;

export function digestOf({ companyName, check, listed, persons, forWhom }) {
  const n = listed.length;
  const title = `${n} not punched in — ${check.shiftName ?? 'shift'}, ${dateWords(check.date)}`;
  const lineOf = (x) => {
    const p = persons.get(x.person.employee.id);
    return `${x.person.employee.name}${x.person.employee.code ? ` (${x.person.employee.code})` : ''}${p?.departmentName ? ` — ${p.departmentName}` : ''}`;
  };
  const lines = listed.slice(0, LIST_MAX).map(lineOf);
  const more = n > LIST_MAX ? `and ${n - LIST_MAX} more` : null;
  const intro = `By ${hm(wall(check.dueAt))} (the ${check.start} start, its grace and ${companyName ? `${companyName}'s` : 'the'} delay), ${n === 1 ? 'this person has' : `these ${n} people have`} not punched in and ${n === 1 ? 'has' : 'have'} no approved leave${forWhom === 'MANAGER' ? ' — they report to you' : ''}.`;
  const text = `${title}. ${lines.join('; ')}${more ? `; ${more}` : ''}.`;
  const link = `attendance?tab=today&date=${check.date}`;
  const html = `<div style="font-family:Arial,sans-serif;font-size:14px;color:#1A1C2E;max-width:640px">
<h2 style="font-size:17px;margin:0 0 8px">${esc(title)}</h2>
<p style="margin:0 0 8px">${esc(intro)}</p>
<ul>${lines.map((l) => `<li>${esc(l)}</li>`).join('')}${more ? `<li>${esc(more)}</li>` : ''}</ul>
<p style="color:#555">Open Attendance › Today in CF HRMS to see the day. Someone on duty outside, on leave not yet entered, or a device that missed a punch can be corrected there.</p>
<p style="color:#777;font-size:12px">Sent by CF HRMS for ${esc(companyName ?? 'your company')} — one message for the whole shift. Change who receives it in Attendance › Settings.</p></div>`;
  return {
    kind: 'ABSENCE_DIGEST', title, text, html, link,
    dedupeKey: `ABSENCE:${check.runKey}`,
    intro,
    data: {
      date: check.date, shiftId: check.shiftId, shift: check.shiftName, start: check.start, dueAt: check.dueAt, forWhom, count: n,
      people: listed.map((x) => { const p = persons.get(x.person.employee.id); return { employeeId: x.person.employee.id, code: x.person.employee.code, name: x.person.employee.name, unit: p?.departmentName ?? null, why: x.why }; }),
    },
  };
}

/* ══ one pass ═══════════════════════════════════════════════════════════════ */

async function companyName(db, companyId) {
  const [[r]] = await db.query('SELECT name FROM companies WHERE id = ?', [companyId]);
  return r?.name ?? null;
}

/**
 * What is due now for one company, who is listed — reads only (the settings screen's "Who would be listed now").
 * `ignoreLate`: a check more than MAX_LATE past its time still shows (preview only).
 */
export async function loadChecks(db, companyId, { now = new Date(), ignoreLate = false, settings = null } = {}) {
  const att = await settingsOf(db, companyId);
  const s = settings ?? await alertSettingsOf(db, companyId);
  const local = nowIn(att.defaultTimezone, now);
  const today = local.slice(0, 10);
  const dates = [addDays(today, -1), today];
  if (!att.liveFrom) return { local, att, settings: s, checks: new Map(), people: [] };
  const { people } = await loadInputs(db, companyId, { from: dates[0], to: today, on: today });
  const ids = people.map((p) => p.employee.id);
  const [recs] = ids.length ? await db.query(
    'SELECT employee_id, attendance_date, status, source FROM hrms_attendance_records WHERE company_id = ? AND employee_id IN (?) AND deleted_at IS NULL AND attendance_date BETWEEN ? AND ?',
    [companyId, ids, dates[0], today]) : [[]];
  const records = new Map(recs.map((r) => [`${r.employee_id}|${day(r.attendance_date)}`, { status: r.status, source: r.source }]));
  const closed = await closedMonths(db, companyId);
  const checks = dueChecks(people, records, { now: local, dates, delayMinutes: s.delayMinutes, liveFrom: att.liveFrom, closed, ignoreLate });
  return { local, att, settings: s, checks, people };
}

/**
 * Send one check's digests, in `conn`'s transaction, after claiming it. Returns null when it was claimed already.
 * @returns { runId, runKey, absent, digests: [{ userId, forWhom, people, deliveries: [{ channel, status }] }] }
 */
export async function sendCheck(conn, companyId, check, { settings, name, trigger = 'SCHEDULED', userId = null }) {
  try {
    await conn.query(
      `INSERT INTO hrms_absence_alert_runs (company_id, alert_date, shift_id, run_key, due_at, started_at, absent_count, absent_json, trigger_kind, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [companyId, check.date, check.shiftId, check.runKey, check.dueAt, new Date(), check.absent.length, JSON.stringify(check.absent.map((x) => x.person.employee.id)), trigger, userId]);
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return null;
    throw err;
  }
  const [[run]] = await conn.query('SELECT id FROM hrms_absence_alert_runs WHERE company_id = ? AND run_key = ?', [companyId, check.runKey]);
  const out = { runId: run.id, runKey: check.runKey, absent: check.absent.length, digests: [] };
  if (!check.absent.length) {
    await conn.query('UPDATE hrms_absence_alert_runs SET finished_at = ? WHERE id = ?', [new Date(), run.id]);
    return out;
  }
  const persons = await loadPersons(conn, companyId, check.absent.map((x) => x.person.employee.id), check.date);
  // Who hears of whom: Map<userId, { recipient, forWhom, ids: Set }>.
  const hear = new Map();
  const add = (u, forWhom, ids) => {
    const h = hear.get(u.userId) ?? { recipient: u, forWhom, ids: new Set() };
    if (h.forWhom !== forWhom) h.forWhom = 'HR';
    for (const id of ids) h.ids.add(id);
    hear.set(u.userId, h);
  };
  for (const hr of await hrRecipients(conn, companyId, settings.hrTemplates)) {
    const ids = check.absent.filter((x) => hr.all || (x.person.seat?.department_id != null && hr.departmentIds.has(Number(x.person.seat.department_id)))).map((x) => x.person.employee.id);
    if (ids.length) add(hr, 'HR', ids);
  }
  if (settings.notifyManagers) {
    const model = await loadReportingModel(conn, companyId, { on: check.date });
    const managerOf = new Map();
    for (const x of check.absent) {
      const pos = x.person.seat?.position_id;
      if (!pos) continue;
      const m = model.manager(pos);
      const occ = m.positionId != null ? (model.positions.get(m.positionId)?.occupants ?? []).map((o) => o.employeeId).filter((id) => id !== x.person.employee.id) : [];
      if (occ.length) managerOf.set(x.person.employee.id, occ[0]);
    }
    const managerIds = [...new Set(managerOf.values())];
    if (managerIds.length) {
      const [mgrs] = await conn.query(
        `SELECT e.id AS employee_id, u.id AS user_id, u.name, u.email FROM hrms_employees e
           JOIN users u ON u.id = e.user_id AND u.company_id = e.company_id AND u.deleted_at IS NULL
          WHERE e.company_id = ? AND e.id IN (?) AND e.deleted_at IS NULL`, [companyId, managerIds]);
      const userOf = new Map(mgrs.map((r) => [r.employee_id, { userId: r.user_id, name: r.name, email: r.email }]));
      for (const [empId, mgrEmp] of managerOf) {
        const u = userOf.get(mgrEmp);
        if (u) add(u, 'MANAGER', [empId]);
      }
    }
  }
  // Phones, for SMS / WhatsApp when a provider is set: the login's own person.
  const userIds = [...hear.keys()];
  const [phones] = userIds.length ? await conn.query('SELECT user_id, phone FROM hrms_employees WHERE company_id = ? AND user_id IN (?) AND deleted_at IS NULL', [companyId, userIds]) : [[]];
  const phoneOf = new Map(phones.map((p) => [p.user_id, p.phone]));
  const channels = Object.entries(SETTING_KEY).filter(([k]) => settings.channels[k]).map(([, key]) => CHANNELS[key]);
  for (const [uid, h] of hear) {
    const listed = check.absent.filter((x) => h.ids.has(x.person.employee.id));
    const digest = digestOf({ companyName: name, check, listed, persons, forWhom: h.forWhom });
    const recipient = { ...h.recipient, phone: phoneOf.get(uid) ?? null };
    const deliveries = [];
    for (const ch of channels) {
      // eslint-disable-next-line no-await-in-loop -- one digest at a time; a provider may rate-limit
      const r = await ch.deliver(conn, { companyId, runId: run.id, recipient, digest });
      await conn.query(
        'INSERT INTO hrms_alert_deliveries (company_id, run_id, user_id, channel, status, detail, notification_id, email_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [companyId, run.id, uid, ch.key, r.status, r.detail ? String(r.detail).slice(0, 500) : null, r.notificationId ?? null, r.emailId ?? null]);
      deliveries.push({ channel: ch.key, status: r.status });
    }
    out.digests.push({ userId: uid, forWhom: h.forWhom, people: listed.map((x) => x.person.employee.id), deliveries });
  }
  await conn.query('UPDATE hrms_absence_alert_runs SET finished_at = ?, digest_count = ? WHERE id = ?', [new Date(), out.digests.length, run.id]);
  return out;
}

/**
 * One pass: every company (or the ones named) with alerts on and attendance live. Returns what it did.
 * `trigger`: SCHEDULED (the timer) or BY_HAND (HR's "Check now"; then a check up to MAX_LATE behind still goes).
 */
export async function alertPass({ now = new Date(), companyIds = null, trigger = 'SCHEDULED', userId = null } = {}) {
  const [rows] = await pool.query(
    `SELECT s.company_id FROM hrms_absence_alert_settings s JOIN hrms_attendance_settings a ON a.company_id = s.company_id
      WHERE s.enabled = 1 AND s.deleted_at IS NULL AND a.live_from IS NOT NULL${companyIds ? ' AND s.company_id IN (?)' : ''}`, companyIds ? [companyIds] : []);
  const done = [];
  let emails = false;
  for (const { company_id: companyId } of rows) {
    try {
      const { checks, settings } = await loadChecks(pool, companyId, { now });
      if (!checks.size) continue;
      const name = await companyName(pool, companyId);
      for (const check of checks.values()) {
        // eslint-disable-next-line no-await-in-loop -- one claim per check, each in its own transaction
        const r = await withTransaction((conn) => sendCheck(conn, companyId, check, { settings, name, trigger, userId }));
        if (r) { done.push({ companyId, ...r }); if (settings.channels.email && r.digests.length) emails = true; }
      }
    } catch (err) {
      logger.warn({ err: err.message, companyId }, '[cf_hrms] absence alerts failed for a company; the next pass tries again');
    }
  }
  if (emails) await sendPending(pool).catch((err) => logger.warn({ err: err.message }, '[cf_hrms] absence alert emails: the outbox will try again'));
  if (done.length) logger.info({ done: done.map((d) => ({ companyId: d.companyId, runKey: d.runKey, absent: d.absent, digests: d.digests.length })) }, '[cf_hrms] absence alerts');
  return done;
}

let timer = null;
export function startAbsenceAlerts() {
  if (timer || String(process.env.CF_HRMS_ABSENCE_ALERTS ?? '').toLowerCase() === 'off') return;
  const tick = () => { alertPass().catch((err) => logger.warn({ err: err.message }, '[cf_hrms] absence alert pass failed')); };
  setTimeout(tick, 2 * 60 * 1000).unref();
  timer = setInterval(tick, PASS_EVERY_MS);
  timer.unref();
}

/* ══ the screen ═════════════════════════════════════════════════════════════ */

/** GET /attendance/alerts — the settings, the channels, what is due now and the last runs. */
export async function alertsScreen(db, c) {
  const { local, att, settings, checks } = await loadChecks(db, c.companyId, { ignoreLate: true });
  const [runs] = await db.query(
    `SELECT r.*, s.name AS shift_name FROM hrms_absence_alert_runs r LEFT JOIN hrms_shifts s ON s.company_id = r.company_id AND s.id = r.shift_id
      WHERE r.company_id = ? AND r.deleted_at IS NULL ORDER BY r.alert_date DESC, r.id DESC LIMIT 20`, [c.companyId]);
  const runIds = runs.map((r) => r.id);
  const [dels] = runIds.length ? await db.query('SELECT run_id, channel, status, COUNT(*) AS n FROM hrms_alert_deliveries WHERE company_id = ? AND run_id IN (?) AND deleted_at IS NULL GROUP BY run_id, channel, status', [c.companyId, runIds]) : [[]];
  const claimed = new Set(runs.map((r) => r.run_key));
  return {
    settings, channels: channelStatus(), now: local, live: Boolean(att.liveFrom), liveFrom: att.liveFrom,
    due: [...checks.values()].map((k) => ({
      runKey: k.runKey, date: k.date, shift: k.shiftName, start: k.start, dueAt: k.dueAt, sent: claimed.has(k.runKey),
      people: k.people.length, absent: k.absent.map((x) => ({ employeeId: x.person.employee.id, code: x.person.employee.code, name: x.person.employee.name, why: x.why })),
    })),
    runs: runs.map((r) => ({
      id: r.id, date: day(r.alert_date), shift: r.shift_name ?? null, dueAt: wall(r.due_at), absent: Number(r.absent_count), digests: Number(r.digest_count), trigger: r.trigger_kind,
      deliveries: dels.filter((d) => d.run_id === r.id).map((d) => ({ channel: d.channel, status: d.status, count: Number(d.n) })),
    })),
  };
}

export default { alertSettingsOf, putAlertSettings, dueChecks, loadChecks, sendCheck, alertPass, startAbsenceAlerts, alertsScreen, digestOf, MAX_LATE_MINUTES, DEFAULT_ALERT_SETTINGS };
