import cron from 'node-cron';
import { q, parseJson } from './db.js';
import { sendPush } from './push.js';

/**
 * THE MORNING FOLLOW-UP REMINDER. Once a day per customer, at the customer's
 * reminder hour (config.reminderHour, default 8, in config.timezone, default
 * Asia/Kolkata), every active member who acts as an owner name and has open
 * leads with a next-action date of today or earlier gets one notification —
 * in the app and, where they turned alerts on, on their phone or computer.
 *
 * Checked every 15 minutes. Several servers may run this: a row in
 * cf_crm_settings ('digest:<date>') is claimed with INSERT IGNORE, so only one
 * of them sends a given day's reminders.
 *
 * Open / won / lost follows the customer's stages; the defaults mirror the
 * app's (public/cf_crm/app.js DEFAULT_STAGES).
 */
const DEFAULT_CLOSED = {
  chit: { enrolled: 'won', lost: 'lost' },
  re: { registered: 'won', lost: 'lost' },
  _default: { won: 'won', lost: 'lost' },
};
const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

function isOpen(lead, cfg) {
  const biz = lead.business || lead.line || '';
  const stages = cfg.stages && Array.isArray(cfg.stages[biz]) && cfg.stages[biz].length ? cfg.stages[biz] : null;
  const v = String(lead.stage || '').toLowerCase();
  if (stages) {
    const st = stages.find((x) => x.id === lead.stage) || stages.find((x) => String(x.name || '').toLowerCase() === v) || stages.find((x) => x.id === slug(v)) || stages[0];
    return !st || (st.kind !== 'won' && st.kind !== 'lost');
  }
  const closed = DEFAULT_CLOSED[biz] || DEFAULT_CLOSED._default;
  return !closed[v] && !closed[slug(v)];
}

/** Local date and hour in a time zone. */
function localNow(tz) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date()).map((p) => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

/** Who has what due, for one customer. Exported for the test. */
export async function dueByOwner(customerId, cfg, today) {
  const rows = await q("SELECT data FROM cf_crm_records WHERE customer_id = ? AND type = 'leads' AND deleted = 0", [customerId]);
  const by = new Map(); // owner -> { due, overdue, biz:Set }
  for (const r of rows) {
    const l = parseJson(r.data, null);
    if (!l || !l.owner || !l.nextDate || String(l.nextDate).slice(0, 10) > today || !isOpen(l, cfg)) continue;
    const o = by.get(l.owner) || { due: 0, overdue: 0, leads: [] };
    o.due += 1;
    if (String(l.nextDate).slice(0, 10) < today) o.overdue += 1;
    o.leads.push(l);
    by.set(l.owner, o);
  }
  return by;
}

export async function runDigest(customer, { force = false } = {}) {
  const cfg = parseJson((await q("SELECT value FROM cf_crm_settings WHERE customer_id = ? AND k = 'config'", [customer.id]))[0]?.value, {}) || {};
  if (cfg.reminders === 'off') return { skipped: 'off' };
  let tz = 'Asia/Kolkata';
  try { if (cfg.timezone) { new Intl.DateTimeFormat('en', { timeZone: cfg.timezone }); tz = cfg.timezone; } } catch { /* keep the default */ }
  const hour = Number.isInteger(cfg.reminderHour) && cfg.reminderHour >= 0 && cfg.reminderHour <= 23 ? cfg.reminderHour : 8;
  const now = localNow(tz);
  if (!force && now.hour < hour) return { skipped: 'early' };
  const claim = await q("INSERT IGNORE INTO cf_crm_settings (customer_id, k, value) VALUES (?, ?, '{}')", [customer.id, 'digest:' + now.date]);
  if (!force && !claim.affectedRows) return { skipped: 'done' };

  const by = await dueByOwner(customer.id, cfg, now.date);
  const members = await q('SELECT user_id, owner, businesses FROM cf_crm_members WHERE customer_id = ? AND active = 1 AND owner <> ?', [customer.id, '']);
  let told = 0;
  for (const m of members) {
    const mine = by.get(m.owner);
    if (!mine) continue;
    const biz = parseJson(m.businesses, []);
    const leads = biz.length ? mine.leads.filter((l) => biz.includes(l.business || l.line)) : mine.leads;
    if (!leads.length) continue;
    const overdue = leads.filter((l) => String(l.nextDate).slice(0, 10) < now.date).length;
    const text = `${leads.length} follow-up${leads.length === 1 ? '' : 's'} due today${overdue ? ` (${overdue} overdue)` : ''}. Open Follow-ups to work through them.`;
    await q('INSERT INTO cf_crm_notifications (customer_id, user_id, kind, text, link, at) VALUES (?, ?, ?, ?, ?, UTC_TIMESTAMP(3))', [customer.id, m.user_id, 'due', text, 'followups']);
    await sendPush(customer.id, [m.user_id], { text, link: 'followups', tag: 'digest:' + now.date });
    told += 1;
  }
  // claims older than a fortnight are of no use
  await q("DELETE FROM cf_crm_settings WHERE customer_id = ? AND k LIKE 'digest:%' AND k < ?", [customer.id, 'digest:' + new Date(Date.now() - 14 * 864e5).toISOString().slice(0, 10)]);
  return { told, date: now.date };
}

let started = false;
export function startDigest() {
  if (started || process.env.CF_CRM_DIGEST === 'off') return;
  started = true;
  cron.schedule('*/15 * * * *', async () => {
    try {
      const customers = await q('SELECT id FROM cf_crm_customers WHERE deleted_at IS NULL');
      for (const c of customers) await runDigest(c).catch((e) => console.warn('[cf_crm] digest', c.id, e.message));
    } catch (e) {
      // the tables may not exist yet on a database that has not had the schema
      if (!/doesn't exist|does not exist/i.test(String(e.message))) console.warn('[cf_crm] digest', e.message);
    }
  });
}
