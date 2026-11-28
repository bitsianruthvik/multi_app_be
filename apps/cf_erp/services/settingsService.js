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
  { key: 'parties', label: 'Parties: codes', help: 'How a new party is coded when it is saved without one.' },
  { key: 'production', label: 'Production: stages', help: 'The stages an order moves through on the floor, in order. "Set opening position" on the Tracker marks a released line done up to one of them.' },
];

/**
 * The stages of production (init.sql §121; user, 2026-11-28: "Most of the orders move by girders. And they all move
 * to the same phase more or less. So give a way to easily set everything to a particular stage."). In order; each a
 * name and the operation codes that belong to it. An operation in no stage belongs to the stage of the step before it
 * in its flow (openingPositionService.stageOfSteps). Stored as JSON in cf_settings; shown and edited on Setup ›
 * Settings as one line per stage, "Name: CODE, CODE".
 */
export const DEFAULT_STAGES = [
  { name: 'Cut', ops: ['CNCP-CUT', 'GASCUT'] },
  { name: 'Fit-up & weld', ops: ['HBFIT', 'SAWWELD', 'JACKBEND', 'STIFFFIT', 'MIGWELD', 'FLIPGIRDER', 'IDEDFIT', 'ARCWELD', 'XFRAMEFIT', 'STUDWELD', 'LINEMATCH', 'PARTQC', 'SETCHECK'] },
  { name: 'Drill', ops: ['CNCDRILL', 'MANDRILL'] },
  { name: 'Trial assembly', ops: ['TRIALASM', 'DISMANTLE'] },
  { name: 'Blast & paint', ops: ['BLAST', 'METALLIZE', 'PAINT'] },
  { name: 'Dispatched', ops: ['DISPATCH'] },
];
export const STAGES_MAX = 20;
/** cf_settings.value holds at most this much (§121 widened it from 255). */
export const STAGES_MAX_TEXT = 4000;

/** "Name: A, B" lines (or an array, or its JSON) → { stages } or { problems }. Codes upper-cased; a code in one stage only. */
export function parseStages(input) {
  let list = input;
  const problems = [];
  if (typeof input === 'string') {
    const t = input.trim();
    if (t.startsWith('[')) {
      try { list = JSON.parse(t); } catch { return { problems: ['Stages: that is not a list.'] }; }
    } else {
      list = t.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l, i) => {
        const at = l.indexOf(':');
        if (at < 0) { problems.push(`Stages, line ${i + 1}: write it as "Name: CODE, CODE".`); return null; }
        return { name: l.slice(0, at), ops: l.slice(at + 1).split(/[,\s]+/).filter(Boolean) };
      }).filter(Boolean);
    }
  }
  if (!Array.isArray(list)) return { problems: ['Stages: a list of stages, each a name and its operation codes.'] };
  const stages = [];
  const names = new Set();
  const seen = new Map();
  for (const [i, x] of list.entries()) {
    const name = String(x?.name ?? '').trim().slice(0, 60);
    if (!name) { problems.push(`Stages: stage ${i + 1} needs a name.`); continue; }
    if (names.has(name.toLowerCase())) problems.push(`Stages: "${name}" is named twice.`);
    names.add(name.toLowerCase());
    const ops = [];
    for (const raw of Array.isArray(x?.ops) ? x.ops : []) {
      const code = String(raw ?? '').trim().toUpperCase().slice(0, 50);
      if (!code || ops.includes(code)) continue;
      if (seen.has(code)) { problems.push(`Stages: ${code} is in both "${seen.get(code)}" and "${name}" — an operation belongs to one stage.`); continue; }
      seen.set(code, name);
      ops.push(code);
    }
    stages.push({ name, ops });
  }
  if (!stages.length && !problems.length) problems.push('Stages: name at least one stage.');
  if (stages.length > STAGES_MAX) problems.push(`Stages: at most ${STAGES_MAX}.`);
  if (stages.length && !stages.some((s) => s.ops.length)) problems.push('Stages: give at least one stage its operation codes.');
  if (JSON.stringify(stages).length > STAGES_MAX_TEXT) problems.push('Stages: the list is too long to keep.');
  return problems.length ? { problems } : { stages };
}
/** The stages as the settings page shows them: one line per stage. */
export const stagesText = (stages) => (stages ?? []).map((s) => `${s.name}: ${s.ops.join(', ')}`).join('\n');

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
  // 2026-11-23 (user): a temporary screen to get the real stock in, lot by lot, "active for next one week".
  { key: 'stock_entry_until', group: 'stores_book', label: 'The stock entry screen is open up to and including', type: 'date', def: null, help: 'Stores › Stock entry: every item, its quantity typed and split into lots / brands / vendors, saved without an approval. Empty or past = closed (use Audit).' },

  // --- stores: the day
  { key: 'store_open_time', col: 'store_open_time', group: 'stores_day', label: 'The store opens at', type: 'time', def: '08:00', help: 'An entry made outside these hours is listed on Today until someone checks it.' },
  { key: 'store_close_time', col: 'store_close_time', group: 'stores_day', label: 'The store closes at', type: 'time', def: '18:00' },
  { key: 'tools_out_days', col: 'tools_out_days', group: 'stores_day', label: 'A thing given out is "out too long" after', type: 'int', def: 90, min: 1, max: 730, unit: 'days', help: "When the item has no due days of its own." },
  I('out_bucket_1_days', 'stores_day', 'Out with: the first age band ends at', 30, 1, 365, 'days', 'The chips on the Out with screen: up to this, up to the next, and over.'),
  I('out_bucket_2_days', 'stores_day', 'Out with: the second age band ends at', 90, 2, 730, 'days'),
  { key: 'giveout_loose', group: 'stores_day', label: 'Give out without a material request', type: 'bool', def: false, help: 'Off: stock leaves the store only by "Issue now" on a request, so every stock-out is tied to one (user, 2026-11-23). On: Stores › Stock also has a Give out button.' },
  { key: 'giveout_departments', group: 'stores_day', label: 'Give out may be charged to a department', type: 'bool', def: false, help: 'Off: a give-out is for a sales order or goes to a contractor (user, 2026-11-22).' },
  { key: 'giveout_person', group: 'stores_day', label: 'Give out records who collected it', type: 'bool', def: false, help: 'Off: nobody is named; a tool given for a sales order is out with that order.' },
  { key: 'grn_brand_required', group: 'stores_day', label: 'A GRN line must name the brand', type: 'bool', def: true, help: 'On: every new lot received from a supplier is given a brand from the brand list (or Unbranded); its vendor is the supplier on the GRN (user, 2026-11-22). Off: the brand may be left empty.' },
  I('po_follow_days', 'stores_day', 'The dashboard lists a purchase order due within', 3, 0, 60, 'days', 'Late ones are always listed.'),
  I('dash_pr_stale_days', 'stores_day', 'A purchase request with something still to order is followed up after', 3, 1, 60, 'days', 'From when it was raised. On the Stores dashboard.'),
  I('dash_mr_stale_days', 'stores_day', 'A material request with something still to give out or buy is followed up after', 2, 1, 60, 'days', 'From when it was raised. On the Stores dashboard.'),
  I('dash_audit_warn_days', 'stores_day', "The month's audit is a warning when this many days are left and it is not done", 7, 1, 28, 'days', 'On the Stores dashboard.'),

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
  I('alert_count_skip_days', 'alerts', 'Stock moved and nobody audited it for', 35, 1, 120, 'days', 'To Stores. Only on a company that runs the Stores desk.'),
  I('alert_lost_days', 'alerts', 'A lost item stays on the alerts for', 14, 1, 120, 'days', 'To Stores and the MD.'),
  I('alert_billing_days', 'alerts', 'An invoice unpaid is an alert after', 30, 1, 365, 'days from its date', 'To Accounts.'),

  I('alert_ticket_late_hours', 'alerts', 'A maintenance ticket past its target is an alert after', 0, 0, 720, 'hours past', 'To Maintenance.'),

  // --- alerts: to the MD
  I('md_po_late_days', 'md', 'A purchase order late by more than', 3, 0, 120, 'days'),
  { key: 'md_step_late_days', group: 'md', label: 'A start or finish late by', type: 'number', def: 1, min: 0, max: 60, unit: 'days' },
  I('md_machine_down_hours', 'md', 'A machine down for', 24, 1, 2000, 'hours'),
  I('md_ticket_late_hours', 'md', 'A maintenance ticket past its target by', 48, 1, 2000, 'hours'),
  I('md_inquiry_days', 'md', 'An inquiry not confirmed for', 7, 1, 365, 'days'),
  I('md_count_skip_days', 'md', 'No stock audit for', 45, 1, 240, 'days'),
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

  // --- production stages (init.sql §121)
  { key: 'subcontractor_code_prefix', group: 'parties', label: 'Sub-contractor code series', type: 'text', def: 'SC-', help: 'A sub-contractor saved without a code gets the next number of this series, three digits: SC-001, SC-002 … A vendor code from accounts can still be typed instead.' },
  I('rollout_max_pieces', 'production', 'Most pieces a line rolls out into', 10000, 1000, 200000, 'pieces', 'A line whose pieces (every span, part and cut piece) come to more than this is refused at lock, so a mistake cannot make a huge plan. Raise it for long multi-span lines (SLR 36 m × 6 spans, 2026-11-28).'),
  { key: 'plan_asked_po_dated', group: 'production', label: 'Plan with requested purchase order dates', type: 'bool', def: false, help: 'On: a purchase order that is requested or a draft (not ordered yet) counts in planning as arriving on its expected date. Off: only ordered purchase orders give material a date (user, 2026-11-28: "RM shows as if it is available from Dec 1").' },
  I('plan_assumed_material_days', 'production', 'Material with no date: assume ready after', 14, 0, 90, 'days', 'The month plan starts a unit whose material has no date this many days after the first day of the plan, and says so.'),
  { key: 'production_stages', group: 'production', label: 'Stages, in order', type: 'stages', def: DEFAULT_STAGES, help: 'One line per stage: its name, a colon, then its operation codes. An operation in no stage counts with the step before it in its flow. Codes this company does not use are ignored.' },
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
    case 'stages': { const r = parseStages(String(raw)); return r.stages ?? def.def; }
    default: return String(raw);
  }
}
/** Two values of a setting are the same (a list compares by its content). */
const sameValue = (def, a, b) => (def.type === 'stages' ? JSON.stringify(a) === JSON.stringify(b) : a === b);

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
        ...(s.type === 'stages'
          ? { default: stagesText(s.def), value: stagesText(values[s.key]), changed: !sameValue(s, values[s.key], s.def) }
          : { default: s.def, value: values[s.key], changed: values[s.key] !== s.def }),
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
    case 'text': {
      if (empty) return def.def;
      const t = String(v).trim();
      if (t.length > 20 || !/^[A-Za-z0-9][A-Za-z0-9_./-]*$/.test(t)) { problems.push(`${def.label}: up to 20 letters, digits and - _ . /, no spaces.`); return undefined; }
      return t;
    }
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
    case 'stages': {
      if (empty) return def.def;
      const r = parseStages(v);
      if (r.problems) { problems.push(...r.problems); return undefined; }
      return r.stages;
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
    if (sameValue(def, v, def.def) || v == null) await db.query('DELETE FROM cf_settings WHERE company_id = ? AND skey = ?', [c.companyId, k]);
    else {
      const text = def.type === 'bool' ? (v ? '1' : '0') : def.type === 'stages' ? JSON.stringify(v) : String(v);
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
