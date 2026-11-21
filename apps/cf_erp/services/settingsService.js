/**
 * settingsService.js — COMPANY SETTINGS (init.sql §113; user, 2026-11-19): "make all the hard codings a setting in the
 * setting page with meaningful grouping. That way we can change it for other clients."
 *
 * SETTINGS is the one list of every limit the app used to carry in code: what it is called, the group it sits in on
 * the page, its type and bounds, and the default (the value the code had). A company's own value is a row of
 * cf_settings — or, for the stores settings that already had a column (§111–§112), that column of cf_company_settings
 * (`col`). No row = the default, so a company nobody has touched behaves exactly as before.
 *
 *   getSettings(db, companyId)   → { key: value } with every key present. Cached 30 s a company; a write clears it.
 *   settingsPage(db, companyId)  → the groups for the screen, each item with its value and default.
 *   saveSettings(db, c, values)  → validates every value, writes only what changed.
 *
 * A new limit goes here FIRST, and the code reads it through getSettings — never a constant in a service.
 */
import { invalid, assertNoProblems } from '../lib/errors.js';

export const GROUPS = [
  { key: 'plant', label: 'Plant', help: 'The week the plant works by. (Its time zone is set with the shop floor settings.)' },
  { key: 'stores_book', label: 'Stores: audits and the stock book', help: 'What an audit may correct on its own, how far back an entry may be dated, and the closed period.' },
  { key: 'stores_day', label: 'Stores: the day and things given out', help: "The store's hours, what counts as out too long, and what the Today page lists." },
  { key: 'levels', label: 'Stock levels suggested from use', help: 'When the app suggests a minimum and maximum for an item, and how it works them out.' },
  { key: 'maintenance', label: 'Maintenance: tickets, tools and machine health', help: 'How long a ticket of each kind may take, when a tool counts as worn early, and the period machine health looks at.' },
  { key: 'alerts', label: 'Alerts: when one is raised', help: 'How late something is before its own department hears of it.' },
  { key: 'md', label: 'Alerts: when it reaches the MD', help: 'How much later the same thing is put in front of the MD.' },
  { key: 'reports', label: 'MD dashboard and weekly reports', help: 'Which reports are made each week for the MD to verify, and who decides when the MD is away.' },
];

const I = (key, group, label, def, min, max, unit, help, extra = {}) => ({ key, group, label, type: 'int', def, min, max, unit, help, ...extra });
export const SETTINGS = [
  // --- plant
  { key: 'week_start', group: 'plant', label: 'The week starts on', type: 'choice', def: '1', choices: [['1', 'Monday'], ['0', 'Sunday'], ['6', 'Saturday']], help: 'Weekly reports and the weekly audit follow this week.' },

  // --- stores: counting and the book (the first four are cf_company_settings columns, §111–§112)
  { key: 'count_auto_limit', col: 'count_auto_limit', group: 'stores_book', label: 'An audit difference up to this value corrects the book at once', type: 'number', def: 500, min: 0, max: 10000000, unit: '₹', help: 'Above it the count waits in Approvals and the book does not move.' },
  { key: 'stock_backdate_days', col: 'stock_backdate_days', group: 'stores_book', label: 'A stock entry may be dated back', type: 'int', def: 3, min: 0, max: 60, unit: 'days', help: 'On a company that runs the Stores desk. Older than this is refused.' },
  { key: 'stock_closed_through', col: 'stock_closed_through', group: 'stores_book', label: 'The stock book is closed up to and including', type: 'date', def: null, help: 'Nothing can be dated on or before it. Empty = nothing is closed.' },
  I('count_daily_max_lines', 'stores_book', "Today's audit lists at most", 40, 5, 500, 'items', 'The busiest items first.'),
  I('count_weekly_lookback_days', 'stores_book', 'A weekly audit includes items that moved in the last', 90, 7, 730, 'days', 'Besides everything of the group that has stock.'),

  // --- stores: the day
  { key: 'store_open_time', col: 'store_open_time', group: 'stores_day', label: 'The store opens at', type: 'time', def: '08:00', help: 'An entry made outside these hours is listed on Today until someone checks it.' },
  { key: 'store_close_time', col: 'store_close_time', group: 'stores_day', label: 'The store closes at', type: 'time', def: '18:00' },
  { key: 'tools_out_days', col: 'tools_out_days', group: 'stores_day', label: 'A thing given out is "out too long" after', type: 'int', def: 90, min: 1, max: 730, unit: 'days', help: "When the item has no due days of its own." },
  I('out_bucket_1_days', 'stores_day', 'Out with: the first age band ends at', 30, 1, 365, 'days', 'The chips on the Out with screen: up to this, up to the next, and over.'),
  I('out_bucket_2_days', 'stores_day', 'Out with: the second age band ends at', 90, 2, 730, 'days'),
  I('po_follow_days', 'stores_day', 'Today lists a purchase order due within', 3, 0, 60, 'days', 'Late ones are always listed.'),

  // --- levels from use
  I('level_min_weeks', 'levels', 'History an item needs before a level is suggested', 8, 2, 104, 'weeks'),
  I('level_min_used_weeks', 'levels', 'Of those, weeks in which it was given out', 4, 1, 104, 'weeks'),
  I('level_window_weeks', 'levels', 'Look back at most', 26, 4, 104, 'weeks'),
  { key: 'level_service_pct', group: 'levels', label: 'The minimum should be enough', type: 'number', def: 95, min: 50, max: 99.9, unit: 'times in 100', help: 'Higher holds more stock.' },
  I('level_review_days', 'levels', 'The list is reviewed every', 7, 1, 60, 'days', 'The minimum covers the lead time plus this.'),
  I('level_default_lead_days', 'levels', 'Lead time assumed when the item has none', 14, 1, 365, 'days'),
  I('level_max_weeks', 'levels', 'Maximum = minimum plus this much average use', 4, 1, 52, 'weeks'),
  { key: 'level_differs_pct', group: 'levels', label: 'Suggest only when it differs from what is set by more than', type: 'number', def: 25, min: 0, max: 500, unit: '%' },

  // --- maintenance (§114)
  I('maint_target_fault_hours', 'maintenance', 'A breakdown ticket should close within', 24, 1, 2000, 'hours', 'From when it is raised. Past it the ticket is late.'),
  I('maint_target_preventive_hours', 'maintenance', 'A preventive ticket should close within', 72, 1, 2000, 'hours'),
  I('maint_target_setup_hours', 'maintenance', 'A new machine should be set up within', 168, 1, 4000, 'hours', 'From when Stores registers it.'),
  I('maint_target_manual_hours', 'maintenance', "A job of maintenance's own should close within", 72, 1, 2000, 'hours'),
  I('maint_health_days', 'maintenance', 'Machine health looks back', 90, 7, 730, 'days'),
  I('maint_early_wear_pct', 'maintenance', 'A tool is worn early when it lasted less than', 60, 1, 100, '% of its life', 'Its life is set on the tool, on Maintenance today.'),
  I('maint_wear_review_days', 'maintenance', 'A worn or lost tool stays on the review list for', 60, 7, 365, 'days', 'Until maintenance marks it reviewed.'),

  // --- alerts: raised
  I('alert_grace_min', 'alerts', 'A step is late after', 60, 0, 1440, 'minutes past its slot'),
  I('alert_machine_down_hours', 'alerts', 'A machine down is an alert after', 4, 0, 720, 'hours', 'To Maintenance and Planning.'),
  I('alert_repeat_breakdowns', 'alerts', 'Repeat breakdown: this many faults on one machine', 3, 2, 50, 'faults'),
  I('alert_repeat_days', 'alerts', '… within', 30, 1, 365, 'days'),
  I('alert_inquiry_days', 'alerts', 'An inquiry not yet confirmed is an alert after', 5, 1, 365, 'days', 'To Engineering (design and materials).'),
  I('alert_count_skip_days', 'alerts', 'Stock moved and nobody audited it for', 2, 1, 60, 'days', 'To Stores. Only on a company that runs the Stores desk.'),
  I('alert_lost_days', 'alerts', 'A lost item stays on the alerts for', 14, 1, 120, 'days', 'To Stores and the MD.'),
  I('alert_billing_days', 'alerts', 'An invoice unpaid is an alert after', 30, 1, 365, 'days from its date', 'To Accounts.'),

  I('alert_ticket_late_hours', 'alerts', 'A maintenance ticket past its target is an alert after', 0, 0, 720, 'hours past', 'To Maintenance.'),

  // --- alerts: to the MD
  I('md_po_late_days', 'md', 'A purchase order late by more than', 3, 0, 120, 'days'),
  { key: 'md_step_late_days', group: 'md', label: 'A start or finish late by', type: 'number', def: 1, min: 0, max: 60, unit: 'days' },
  I('md_machine_down_hours', 'md', 'A machine down for', 24, 1, 2000, 'hours'),
  I('md_ticket_late_hours', 'md', 'A maintenance ticket past its target by', 48, 1, 2000, 'hours'),
  I('md_inquiry_days', 'md', 'An inquiry not confirmed for', 7, 1, 365, 'days'),
  I('md_count_skip_days', 'md', 'No stock audit for', 4, 1, 120, 'days'),
  I('md_out_extra_days', 'md', 'A thing out too long by a further', 30, 0, 730, 'days'),
  I('md_billing_days', 'md', 'An invoice unpaid for', 60, 1, 730, 'days from its date'),

  // --- reports and the stand-in
  { key: 'report_stores', group: 'reports', label: 'Weekly stock audit report', type: 'bool', def: true },
  { key: 'report_plan', group: 'reports', label: 'Week plan against actual report', type: 'bool', def: true },
  { key: 'report_maintenance', group: 'reports', label: 'Maintenance week report', type: 'bool', def: true },
  { key: 'report_purchase', group: 'reports', label: 'Purchase week report', type: 'bool', def: true },
  I('report_keep_weeks', 'reports', 'An unseen report stays on the page for', 6, 1, 52, 'weeks'),
  { key: 'md_standin_user', group: 'reports', label: 'Stand-in for the MD', type: 'user', def: null, help: 'One person who may decide everything the MD decides, while the switch below is on.' },
  { key: 'md_standin_on', group: 'reports', label: 'The stand-in decides now', type: 'bool', def: false, help: 'Switch on when the MD is away, off when back.' },
];
const BY_KEY = new Map(SETTINGS.map((s) => [s.key, s]));

const TTL_MS = 30_000;
const cache = new Map();   // companyId -> { at, values }
export function clearSettingsCache(companyId = null) { if (companyId == null) cache.clear(); else cache.delete(Number(companyId)); }

const pad = (n) => String(n).padStart(2, '0');
const dateText = (d) => (d == null || d === '' ? null : d instanceof Date ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` : String(d).slice(0, 10));
const missing = (e) => e?.errno === 1054 || e?.errno === 1146;

/** A stored text (or column value) as the setting's own type; the default when it is not there or not valid. */
function read(def, raw) {
  if (raw == null || raw === '') return def.def;
  switch (def.type) {
    case 'int': { const n = Number(raw); return Number.isInteger(n) ? n : def.def; }
    case 'number': { const n = Number(raw); return Number.isFinite(n) ? n : def.def; }
    case 'bool': return raw === true || raw === 1 || raw === '1' || raw === 'true';
    case 'date': return dateText(raw);
    case 'user': { const n = Number(raw); return Number.isInteger(n) && n > 0 ? n : null; }
    default: return String(raw);
  }
}

/** Every setting of a company, by key. Reads at most twice, and not at all within 30 s of the last read. */
export async function getSettings(db, companyId, { fresh = false } = {}) {
  const id = Number(companyId);
  const hit = cache.get(id);
  if (!fresh && hit && Date.now() - hit.at < TTL_MS) return hit.values;
  let rows = []; let cols = null;
  try { [rows] = await db.query('SELECT skey, value FROM cf_settings WHERE company_id = ?', [id]); } catch (e) { if (!missing(e)) throw e; }
  try { [[cols]] = await db.query('SELECT * FROM cf_company_settings WHERE company_id = ?', [id]); } catch (e) { if (!missing(e)) throw e; }
  const stored = new Map(rows.map((r) => [r.skey, r.value]));
  const values = {};
  for (const s of SETTINGS) values[s.key] = read(s, s.col ? cols?.[s.col] : stored.get(s.key));
  cache.set(id, { at: Date.now(), values });
  return values;
}

/** GET /settings — the page: groups in order, each item with its value, default, type and bounds. */
export async function settingsPage(db, companyId) {
  const values = await getSettings(db, companyId, { fresh: true });
  const [users] = await db.query('SELECT id, name FROM users WHERE company_id = ? AND deleted_at IS NULL ORDER BY name LIMIT 500', [companyId]).catch(() => [[]]);
  return {
    groups: GROUPS.map((g) => ({
      ...g,
      items: SETTINGS.filter((s) => s.group === g.key).map((s) => ({
        key: s.key, label: s.label, help: s.help ?? null, type: s.type, unit: s.unit ?? null, min: s.min ?? null, max: s.max ?? null,
        choices: s.choices ? s.choices.map(([value, label]) => ({ value, label })) : null,
        default: s.def, value: values[s.key], changed: values[s.key] !== s.def,
      })),
    })),
    users: users.map((u) => ({ id: u.id, name: u.name })),
  };
}

/** One value as it will be stored, or a problem said in words. */
function check(def, v, problems, ctx) {
  const empty = v == null || v === '';
  switch (def.type) {
    case 'int': case 'number': {
      if (empty) return def.def;
      const n = Number(v);
      if (!Number.isFinite(n) || (def.type === 'int' && !Number.isInteger(n))) { problems.push(`${def.label}: a ${def.type === 'int' ? 'whole ' : ''}number.`); return undefined; }
      if ((def.min != null && n < def.min) || (def.max != null && n > def.max)) { problems.push(`${def.label}: from ${def.min} to ${def.max}${def.unit ? ` ${def.unit}` : ''}.`); return undefined; }
      return n;
    }
    case 'bool': return v === true || v === 1 || v === '1' || v === 'true';
    case 'time': {
      if (empty) return def.def;
      const m = /^(\d{1,2}):(\d{2})$/.exec(String(v).trim());
      if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) { problems.push(`${def.label}: a time as HH:MM.`); return undefined; }
      return `${pad(Number(m[1]))}:${m[2]}`;
    }
    case 'date': {
      if (empty) return null;
      const s = String(v).trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) { problems.push(`${def.label}: a date as YYYY-MM-DD.`); return undefined; }
      if (def.key === 'stock_closed_through' && s > dateText(new Date())) { problems.push('A period cannot be closed beyond today.'); return undefined; }
      return s;
    }
    case 'choice': {
      if (empty) return def.def;
      if (!def.choices.some(([c]) => c === String(v))) { problems.push(`${def.label}: one of ${def.choices.map(([, l]) => l).join(', ')}.`); return undefined; }
      return String(v);
    }
    case 'user': {
      if (empty) return null;
      const n = Number(v);
      if (!ctx.userIds.has(n)) { problems.push(`${def.label}: that person is not in this company.`); return undefined; }
      return n;
    }
    default: return empty ? def.def : String(v).slice(0, 255);
  }
}

/** PUT /settings { values: { key: value } } — only the keys sent are touched. A value equal to the default removes the row. */
export async function saveSettings(db, c, input = {}) {
  const sent = input.values && typeof input.values === 'object' ? input.values : {};
  const keys = Object.keys(sent);
  const problems = [];
  for (const k of keys) if (!BY_KEY.has(k)) problems.push(`"${k}" is not a setting.`);
  assertNoProblems(problems, 'The settings cannot be saved.');
  const [users] = await db.query('SELECT id FROM users WHERE company_id = ? AND deleted_at IS NULL', [c.companyId]);
  const ctx = { userIds: new Set(users.map((u) => Number(u.id))) };
  const clean = {};
  for (const k of keys) { const v = check(BY_KEY.get(k), sent[k], problems, ctx); if (v !== undefined) clean[k] = v; }
  const now = { ...(await getSettings(db, c.companyId, { fresh: true })), ...clean };
  if (now.out_bucket_2_days <= now.out_bucket_1_days) problems.push('Out with: the second age band ends after the first.');
  if (now.level_min_used_weeks > now.level_min_weeks) problems.push('Stock levels: the weeks with use cannot be more than the weeks of history.');
  if (now.level_window_weeks < now.level_min_weeks) problems.push('Stock levels: the look-back is at least the history an item needs.');
  if (now.md_standin_on && !now.md_standin_user) problems.push('Choose the stand-in before switching it on.');
  assertNoProblems(problems, 'The settings cannot be saved.');
  const colSets = {};
  for (const [k, v] of Object.entries(clean)) {
    const def = BY_KEY.get(k);
    if (def.col) { colSets[def.col] = v; continue; }
    if (v === def.def || v == null) await db.query('DELETE FROM cf_settings WHERE company_id = ? AND skey = ?', [c.companyId, k]);
    else {
      const text = def.type === 'bool' ? (v ? '1' : '0') : String(v);
      await db.query('INSERT INTO cf_settings (company_id, skey, value, updated_by) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value), updated_by = VALUES(updated_by)', [c.companyId, k, text, c.userId ?? null]);
    }
  }
  const cols = Object.keys(colSets);
  if (cols.length) {
    await db.query('INSERT IGNORE INTO cf_company_settings (company_id) VALUES (?)', [c.companyId]);
    await db.query(`UPDATE cf_company_settings SET ${cols.map((k) => `${k} = ?`).join(', ')}, updated_by = ? WHERE company_id = ?`, [...Object.values(colSets), c.userId ?? null, c.companyId]);
  }
  clearSettingsCache(c.companyId);
  return settingsPage(db, c.companyId);
}

/** z for a one-sided service level (0.95 → 1.645): the inverse of the normal curve (Acklam's approximation). */
export function zOf(p) {
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c2 = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const q = Math.min(Math.max(p, 1e-9), 1 - 1e-9);
  if (q < 0.02425) { const r = Math.sqrt(-2 * Math.log(q)); return (((((c2[0] * r + c2[1]) * r + c2[2]) * r + c2[3]) * r + c2[4]) * r + c2[5]) / ((((d[0] * r + d[1]) * r + d[2]) * r + d[3]) * r + 1); }
  if (q > 1 - 0.02425) { const r = Math.sqrt(-2 * Math.log(1 - q)); return -(((((c2[0] * r + c2[1]) * r + c2[2]) * r + c2[3]) * r + c2[4]) * r + c2[5]) / ((((d[0] * r + d[1]) * r + d[2]) * r + d[3]) * r + 1); }
  const r = q - 0.5; const s = r * r;
  return ((((((a[0] * s + a[1]) * s + a[2]) * s + a[3]) * s + a[4]) * s + a[5]) * r) / (((((b[0] * s + b[1]) * s + b[2]) * s + b[3]) * s + b[4]) * s + 1);
}

/** What the MD decides: the tags a stand-in borrows while the switch is on (lib/http.js standIn). */
export const MD_STANDIN_TAGS = [
  'cf_erp_md_dashboard', 'cf_erp_approve_order_acceptance', 'cf_erp_approve_rate_change', 'cf_erp_approve_purchase_order', 'cf_erp_approve_contractor_po',
  'cf_erp_approve_po_close_short', 'cf_erp_approve_rebaseline', 'cf_erp_approve_machine_purchase', 'cf_erp_approve_machine_condemn', 'cf_erp_approve_month_plan',
  'cf_erp_approve_stock_count', 'cf_erp_plate_change_approve', 'cf_erp_purchase_approve',
];

/** Is this person the MD's stand-in right now? */
export async function isStandIn(db, companyId, userId) {
  if (!userId) return false;
  const s = await getSettings(db, companyId);
  return s.md_standin_on === true && Number(s.md_standin_user) === Number(userId);
}
