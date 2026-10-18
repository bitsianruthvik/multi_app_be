import cron from 'node-cron';
import { pool } from '../../../db.js';
import { logger } from '../../../core/utils/logger.js';
import { refresh, RULE_META } from './insightService.js';

/**
 * Alerts: telling people about findings at the right pace, by each rule's cadence.
 *
 *   instant — straight after the connector run that found it, in working hours only
 *             (outside them it waits for the morning digest)
 *   daily   — one digest a day at `dailyAt` (India time): what is NEW or WORSE since the last one
 *   weekly  — one digest on `weeklyDay`: the slow-moving rules
 *
 * A finding is sent once (kd_insight_state.notified_at); it is sent again only
 * after it came back new (worse, snooze ended, back again). Every alert is kept
 * in kd_alerts and shown in the app, whether or not email went out.
 *
 * EMAIL goes out only when all three hold: alerts are switched on in the app,
 * the area has recipients, and SMTP_URL is set on the server
 * (e.g. smtps://user:app-password@smtp.gmail.com:465; ALERT_FROM for the sender).
 */
const AREAS = ['Money', 'Sales', 'Orders', 'Purchase', 'Stores', 'Production'];
export const DEFAULT_SETTINGS = {
  enabled: false,
  recipients: { all: [], Money: [], Sales: [], Orders: [], Purchase: [], Stores: [], Production: [] },
  dailyAt: '08:30', weeklyDay: 1, workStart: 9, workEnd: 19,
};
const NAMES = {
  'over-credit-limit': 'Over credit limit, still billed', 'overdue-still-billed': 'Billed while 90+ days overdue',
  'unmatched-payments': 'Payments not matched to invoices', 'due-this-week': 'Due from customers this week',
  'delivered-not-invoiced': 'Delivered, not invoiced', 'quiet-customers': 'Regular customer gone quiet',
  'buying-less': 'Customer buying much less', 'selling-price-down': 'Selling price down', 'credit-notes': 'Credit notes piling up',
  'late-can-ship': 'Late order, stock is there', 'due-nothing-moving': 'Due in 7 days, nothing in motion',
  'buying-price-up': 'Buying price up', 'late-vendors': 'Vendor late', 'grn-not-invoiced': 'GRN not invoiced',
  'low-cover': 'Raw material running out', 'dead-stock': 'Dead stock', 'buying-overstock': 'Buying overstocked material',
  'stuck-orders': 'Production order stuck', 'machine-drop': 'Machine output down', 'scrap-up': 'Scrap up',
};
const IST_MS = 5.5 * 3600000;
const istNow = () => new Date(Date.now() + IST_MS);
const cleanEmails = (list) => [...new Set((Array.isArray(list) ? list : []).map((e) => String(e).trim().toLowerCase())
  .filter((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)))].slice(0, 30);

export const emailConfigured = () => !!process.env.SMTP_URL;

export async function getSettings(companyId) {
  const [[r]] = await pool.query("SELECT v FROM kd_settings WHERE company_id = ? AND k = 'alerts'", [companyId]);
  const v = r ? (typeof r.v === 'string' ? JSON.parse(r.v) : r.v) : {};
  return { ...DEFAULT_SETTINGS, ...v, recipients: { ...DEFAULT_SETTINGS.recipients, ...(v.recipients || {}) } };
}

export async function saveSettings(companyId, input, userId) {
  const cur = await getSettings(companyId);
  const next = {
    enabled: !!input.enabled,
    recipients: Object.fromEntries(['all', ...AREAS].map((a) => [a, cleanEmails(input.recipients?.[a] ?? cur.recipients[a])])),
    dailyAt: /^\d{2}:\d{2}$/.test(input.dailyAt || '') ? input.dailyAt : cur.dailyAt,
    weeklyDay: Number.isInteger(Number(input.weeklyDay)) && input.weeklyDay >= 0 && input.weeklyDay <= 6 ? Number(input.weeklyDay) : cur.weeklyDay,
    workStart: Math.min(Math.max(Number(input.workStart ?? cur.workStart), 0), 23),
    workEnd: Math.min(Math.max(Number(input.workEnd ?? cur.workEnd), 1), 24),
  };
  await pool.query(
    `INSERT INTO kd_settings (company_id, k, v, updated_by) VALUES (?, 'alerts', ?, ?)
     ON DUPLICATE KEY UPDATE v = VALUES(v), updated_by = VALUES(updated_by), updated_at = NOW()`,
    [companyId, JSON.stringify(next), userId ?? null]);
  return next;
}

async function companySlug(companyId) {
  const [[c]] = await pool.query('SELECT slug FROM companies WHERE id = ?', [companyId]);
  return c?.slug || '';
}

async function sendEmail(to, subject, html) {
  const { default: nodemailer } = await import('nodemailer');
  const t = nodemailer.createTransport(process.env.SMTP_URL);
  await t.sendMail({ from: process.env.ALERT_FROM || 'Karni Dashboard <no-reply@karni>', to: to.join(', '), subject, html });
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** Record one alert for an area and email it when everything is in place. */
async function deliver(companyId, settings, kind, area, items) {
  if (!items.length) return null;
  const word = { instant: 'Act now', daily: 'Today', weekly: 'This week' }[kind];
  const title = `${word}: ${items.length} ${items.length === 1 ? 'thing needs' : 'things need'} attention in ${area}`;
  const to = cleanEmails([...(settings.recipients.all || []), ...(settings.recipients[area] || [])]);
  let status = 'sent'; let error = null;
  if (!settings.enabled) status = 'off';
  else if (!to.length) status = 'no_recipients';
  else if (!emailConfigured()) status = 'not_configured';
  else {
    try {
      const base = (process.env.FRONTEND_URL || 'https://multiappfe.vercel.app').replace(/\/+$/, '');
      const link = `${base}/${await companySlug(companyId)}/karni_dashboard/attention`;
      const html = `<div style="font-family:Arial,sans-serif;font-size:14px;color:#1A1C2E">
        <h2 style="font-size:17px">${esc(title)}</h2><ul>${items.map((i) => `<li style="margin:6px 0"><b>${esc(i.name)}</b>: ${esc(i.label)}${i.reason ? ` <span style="color:#8A8EA8">(${esc(i.reason)})</span>` : ''}</li>`).join('')}</ul>
        <p><a href="${esc(link)}">Open "Needs attention"</a> to see the evidence and mark items done.</p>
        <p style="color:#8A8EA8;font-size:12px">Karni Dashboard · read-only from SAP Business One</p></div>`;
      await sendEmail(to, `Karni Dashboard — ${title}`, html);
    } catch (err) {
      status = 'failed'; error = String(err.message || err).slice(0, 1000);
    }
  }
  await pool.query('INSERT INTO kd_alerts (company_id, kind, area, title, items, recipients, email_status, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [companyId, kind, area, title, JSON.stringify(items), JSON.stringify(to), status, error]);
  return { kind, area, title, status, count: items.length };
}

/** New findings not yet told, for rules of the given cadences. */
async function pending(companyId, cadences) {
  const rules = Object.entries(RULE_META).filter(([, m]) => cadences.includes(m.cadence) && !m.noState).map(([id]) => id);
  if (!rules.length) return [];
  const [rows] = await pool.query(
    "SELECT rule_id, subject_key, subject_label, reason, metric FROM kd_insight_state WHERE company_id = ? AND status = 'new' AND notified_at IS NULL AND rule_id IN (?)",
    [companyId, rules]);
  return rows.map((r) => ({ rule: r.rule_id, key: r.subject_key, area: RULE_META[r.rule_id].area, name: NAMES[r.rule_id] || r.rule_id, label: r.subject_label, reason: r.reason }));
}

async function sendBatch(companyId, settings, kind, items, mark = true) {
  const out = [];
  for (const area of AREAS) {
    const list = items.filter((i) => i.area === area);
    const r = await deliver(companyId, settings, kind, area, list);
    if (r) out.push(r);
  }
  if (mark && items.length) {
    for (const i of items) {
      await pool.query('UPDATE kd_insight_state SET notified_at = NOW() WHERE company_id = ? AND rule_id = ? AND subject_key = ?', [companyId, i.rule, i.key]);
    }
  }
  return out;
}

/** After a connector run: bring states up to date, then send instant alerts in working hours. */
export async function afterSync(companyId) {
  await refresh(companyId);
  const settings = await getSettings(companyId);
  const hour = istNow().getUTCHours();
  if (hour < settings.workStart || hour >= settings.workEnd) return [];
  return sendBatch(companyId, settings, 'instant', await pending(companyId, ['instant']));
}

/** Has this kind of digest gone out since midnight India time? (Measured back from the database's own NOW.) */
async function sentToday(companyId, kind) {
  const ist = istNow();
  const minutesSinceMidnight = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  const [[r]] = await pool.query(
    'SELECT COUNT(*) AS n FROM kd_alerts WHERE company_id = ? AND kind = ? AND created_at >= DATE_SUB(NOW(), INTERVAL ? MINUTE)', [companyId, kind, minutesSinceMidnight]);
  return r.n > 0;
}

/** The digests that are due now for one company (daily at dailyAt, weekly on weeklyDay). */
export async function digestsDue(companyId) {
  const settings = await getSettings(companyId);
  const now = istNow();
  const hhmm = now.toISOString().slice(11, 16);
  const out = [];
  if (hhmm >= settings.dailyAt && !(await sentToday(companyId, 'daily'))) {
    const items = await pending(companyId, ['daily', 'instant']);
    // Record that the digest ran even on a quiet day, so it does not run again.
    if (!items.length) await pool.query("INSERT INTO kd_alerts (company_id, kind, area, title, items, email_status) VALUES (?, 'daily', 'All', 'Today: nothing new needs attention', '[]', 'nothing')", [companyId]);
    else out.push(...(await sendBatch(companyId, settings, 'daily', items)));
  }
  if (now.getUTCDay() === settings.weeklyDay && hhmm >= settings.dailyAt && !(await sentToday(companyId, 'weekly'))) {
    const items = await pending(companyId, ['weekly']);
    if (!items.length) await pool.query("INSERT INTO kd_alerts (company_id, kind, area, title, items, email_status) VALUES (?, 'weekly', 'All', 'This week: nothing new needs attention', '[]', 'nothing')", [companyId]);
    else out.push(...(await sendBatch(companyId, settings, 'weekly', items)));
  }
  return out;
}

/** What would go out next, without sending or marking anything. */
export async function preview(companyId) {
  const [instant, daily, weekly] = await Promise.all([pending(companyId, ['instant']), pending(companyId, ['daily', 'instant']), pending(companyId, ['weekly'])]);
  return { instant, daily, weekly };
}

export async function listAlerts(companyId) {
  const [rows] = await pool.query(
    'SELECT id, kind, area, title, items, recipients, email_status AS emailStatus, error, created_at AS createdAt FROM kd_alerts WHERE company_id = ? ORDER BY id DESC LIMIT 100',
    [companyId]);
  return rows.map((r) => ({ ...r, items: typeof r.items === 'string' ? JSON.parse(r.items) : r.items, recipients: typeof r.recipients === 'string' ? JSON.parse(r.recipients) : r.recipients }));
}

/** Every 5 minutes: digests that are due, for every company with an approved connector. */
let started = false;
export function startAlertCron() {
  if (started) return;
  started = true;
  cron.schedule('*/5 * * * *', async () => {
    try {
      const [cs] = await pool.query("SELECT DISTINCT company_id FROM kd_connectors WHERE status = 'approved'");
      for (const { company_id: cid } of cs) {
        try { await digestsDue(cid); } catch (err) { logger.error({ err, cid }, 'karni_dashboard: digest failed'); }
      }
    } catch (err) {
      logger.error({ err }, 'karni_dashboard: alert cron failed');
    }
  });
}
