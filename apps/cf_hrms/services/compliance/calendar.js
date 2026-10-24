/**
 * calendar.js — a company's deadline calendar (spec §36.4): what is due, when, and where it is done.
 *
 *   TDS deposit           the 7th of the next month; March's by 30 April        hrms_tax_rules `tds_deposit` of the year
 *   Quarterly TDS return  Form 24Q / 138: 31 Jul, 31 Oct, 31 Jan, 31 May          hrms_tax_rules `tds_return`.quarterDue
 *   Form 16 / 130         by 15 June after the year                              hrms_tax_rules `tds_return`.certificateDue
 *   PF (ECR and payment)  the 15th of the next month                             law layer `pf` due_day, else para 38 EPF Scheme 1952
 *   ESI contribution      the 15th of the next month                             law layer `esi` due_day, else reg. 31 ESI (Central) Regs 1950
 *   Professional tax      by the state's rule — Telangana: the 10th of the next month (law layer `pt` due_day, else the default, to verify)
 *   Minimum wage revision the state's revision months — Telangana VDA: April and October (law layer `min_wage` revision_months)
 *   Tax year start        1 April: regime choice, the declaration window
 *
 * Dates come from the rules where they exist and say so (`source`); a default is marked "default".
 * PT and minimum wages appear only for a state the company pays people in (salary rows' state) or has
 * PT settings for. Due items carry the screen where the work is done; "done" is a mark per company.
 *
 * deadlinesBetween() is pure; deadlinesFor() reads the rules and the marks.
 */
import { loadRules } from '../payrollTax/common.js';
import { rulesInForce, taxYearOf } from './lawAdapter.js';

const pad = (n) => String(n).padStart(2, '0');
const addMonths = (ym, k) => { const [y, m] = ym.split('-').map(Number); const t = y * 12 + (m - 1) + k; return `${Math.floor(t / 12)}-${pad((t % 12) + 1)}`; };
const lastDay = (ym) => { const [y, m] = ym.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).getUTCDate(); };
const dayIn = (ym, d) => `${ym}-${pad(Math.min(d, lastDay(ym)))}`;
const monthWord = (ym) => new Date(`${ym}-01T00:00:00Z`).toLocaleString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const STATE_NAMES = { TG: 'Telangana', TS: 'Telangana', AP: 'Andhra Pradesh', KA: 'Karnataka', MH: 'Maharashtra', TN: 'Tamil Nadu', GJ: 'Gujarat', WB: 'West Bengal', KL: 'Kerala', DL: 'Delhi' };
export const stateName = (s) => STATE_NAMES[s] ?? s;

export const DEFAULTS = {
  pf: { dueDay: 15, source: 'Para 38, EPF Scheme 1952: within 15 days of the close of the month (default — not yet in the law layer)' },
  esi: { dueDay: 15, source: 'Regulation 31, ESI (Central) Regulations 1950: within 15 days of the month’s end (default — not yet in the law layer)' },
  pt: { TG: { dueDay: 10, source: 'Telangana Tax on Professions, Trades, Callings and Employments Act 1987 and Rules: tax deducted paid by the 10th of the next month (default — verify; not yet in the law layer)' } },
  minWage: { TG: { months: [4, 10], source: 'Telangana minimum wages: the VDA is revised every April and October (default — not yet in the law layer)' } },
  tdsDeposit: { dueDay: 7, marchDue: '04-30', source: 'Rule 30(2) / rule 218(2): the 7th of the next month; March by 30 April (default)' },
  tdsReturn: { quarterDue: { Q1: '07-31', Q2: '10-31', Q3: '01-31', Q4: '05-31' }, certificateDue: '06-15', source: 'Rule 31A / rule 219 (default)' },
};

const LINK = { TDS_DEPOSIT: 'tax-challans', TDS_RETURN: 'tax-quarterly', FORM16: 'tax-forms', PF: 'statutory-returns', ESI: 'statutory-returns', PT: 'statutory-returns', MIN_WAGE: 'salaries', TAX_YEAR: 'tax-settings' };
const QUARTER_MONTHS = { Q1: ['04', '06'], Q2: ['07', '09'], Q3: ['10', '12'], Q4: ['01', '03'] };

/**
 * Every deadline whose due date falls in [from, to] (both 'YYYY-MM-DD').
 * @param rules { tdsDeposit(year), tdsReturn(year), pf, esi, pt: {state: {dueDay, source}}, minWage: {state: {months, source}} }
 * @param states the states the company pays people in
 */
export function deadlinesBetween(from, to, rules, states = []) {
  const out = [];
  const add = (d) => { if (d.dueDate >= from && d.dueDate <= to) out.push({ ...d, link: LINK[d.kind] }); };
  const startYm = addMonths(from.slice(0, 7), -2);
  const endYm = to.slice(0, 7);
  for (let ym = startYm; ym <= endYm; ym = addMonths(ym, 1)) {
    const next = addMonths(ym, 1);
    const year = taxYearOf(`${ym}-01`);
    const dep = rules.tdsDeposit(year);
    const isMarch = ym.endsWith('-03');
    add({ key: `TDS_DEPOSIT:${ym}`, kind: 'TDS_DEPOSIT', period: ym, title: `TDS on salaries of ${monthWord(ym)}: deposit`, dueDate: isMarch ? `${ym.slice(0, 4)}-${dep.marchDue}` : dayIn(next, dep.dueDay), source: dep.source });
    add({ key: `PF:${ym}`, kind: 'PF', period: ym, title: `PF of ${monthWord(ym)}: ECR and payment`, dueDate: dayIn(next, rules.pf.dueDay), source: rules.pf.source });
    add({ key: `ESI:${ym}`, kind: 'ESI', period: ym, title: `ESI of ${monthWord(ym)}: contribution`, dueDate: dayIn(next, rules.esi.dueDay), source: rules.esi.source });
    for (const st of states) {
      const pt = rules.pt[st];
      if (pt) add({ key: `PT:${st}:${ym}`, kind: 'PT', period: ym, title: `Professional tax (${stateName(st)}) of ${monthWord(ym)}: payment and return`, dueDate: dayIn(next, pt.dueDay), source: pt.source });
      const mw = rules.minWage[st];
      if (mw && mw.months.includes(Number(ym.slice(5, 7)))) add({ key: `MIN_WAGE:${st}:${ym}`, kind: 'MIN_WAGE', period: ym, title: `Minimum wages (${stateName(st)}): revision month — check the new rates against salaries`, dueDate: `${ym}-01`, source: mw.source });
    }
    if (ym.endsWith('-04')) {
      add({ key: `TAX_YEAR:${year}`, kind: 'TAX_YEAR', period: year, title: `Tax year ${year} starts: regime choice and the declaration window`, dueDate: `${ym}-01`, source: 'Income-tax: the tax year runs 1 April to 31 March' });
    }
  }
  // Quarterly returns and Form 16 / 130 per tax year that can fall in the window.
  for (let y = Number(from.slice(0, 4)) - 1; y <= Number(to.slice(0, 4)); y += 1) {
    const year = `${y}-${pad((y + 1) % 100)}`;
    const ret = rules.tdsReturn(year);
    for (const q of ['Q1', 'Q2', 'Q3', 'Q4']) {
      const md = ret.quarterDue[q];
      const calYear = ['Q3', 'Q4'].includes(q) ? y + 1 : y;
      // Q3's due date (31 Jan) and Q4's (31 May) are in the next calendar year.
      add({ key: `TDS_RETURN:${year}:${q}`, kind: 'TDS_RETURN', period: `${year} ${q}`, title: `Quarterly TDS return ${ret.form ?? (y >= 2026 ? 'Form 138' : 'Form 24Q')} for ${year} ${q} (${QUARTER_MONTHS[q].join('–')})`, dueDate: `${calYear}-${md}`, source: ret.source });
    }
    add({ key: `FORM16:${year}`, kind: 'FORM16', period: year, title: `${y >= 2026 ? 'Form 130 (was Form 16)' : 'Form 16'} for ${year} to every employee`, dueDate: `${y + 1}-${ret.certificateDue}`, source: ret.source });
  }
  return out.sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.key.localeCompare(b.key));
}

const dueDayOf = (v) => Number(v?.dueDay ?? v?.due_day ?? v?.paymentDueDay ?? NaN);

/** The rules the calendar needs, from the tax rules and the company's rules in force (defaults where missing). */
export async function calendarRules(db, companyId, on) {
  const taxCache = new Map();
  const taxOf = async (year) => {
    if (!taxCache.has(year)) { const { rules } = await loadRules(db, year); taxCache.set(year, rules); }
    return taxCache.get(year);
  };
  const years = [];
  const y0 = Number(on.slice(0, 4));
  for (let y = y0 - 2; y <= y0 + 1; y += 1) years.push(`${y}-${pad((y + 1) % 100)}`);
  for (const y of years) await taxOf(y);
  const tdsDeposit = (year) => {
    const r = taxCache.get(year)?.NEW;
    const v = r?.has('tds_deposit') ? r.get('tds_deposit') : null;
    return v ? { dueDay: v.dueDay ?? 7, marchDue: v.marchDue ?? '04-30', source: `hrms_tax_rules tds_deposit ${year}${v.section ? ` (${v.section})` : ''}` } : DEFAULTS.tdsDeposit;
  };
  const tdsReturn = (year) => {
    const r = taxCache.get(year)?.NEW;
    const v = r?.has('tds_return') ? r.get('tds_return') : null;
    return v ? { quarterDue: { ...DEFAULTS.tdsReturn.quarterDue, ...(v.quarterDue ?? {}) }, certificateDue: v.certificateDue ?? '06-15', form: v.form ?? null, source: `hrms_tax_rules tds_return ${year}${v.section ? ` (${v.section})` : ''}` } : { ...DEFAULTS.tdsReturn, form: null };
  };
  let inForce = [];
  try { inForce = await rulesInForce(companyId, on, db); } catch { /* defaults */ }
  const law = (domain, st = null) => inForce.find((r) => r.domain === domain && (!st || r.jurisdiction === st) && Number.isFinite(dueDayOf(r.value)));
  const pfR = law('PF'); const esiR = law('ESI');
  const pf = pfR ? { dueDay: dueDayOf(pfR.value), source: `law: ${pfR.ruleKey} v${pfR.version}${pfR.sourceNote ? ` — ${String(pfR.sourceNote).slice(0, 120)}` : ''}` } : DEFAULTS.pf;
  const esi = esiR ? { dueDay: dueDayOf(esiR.value), source: `law: ${esiR.ruleKey} v${esiR.version}` } : DEFAULTS.esi;
  const pt = { ...DEFAULTS.pt };
  for (const r of inForce.filter((x) => x.domain === 'PT' && Number.isFinite(dueDayOf(x.value)))) pt[r.jurisdiction] = { dueDay: dueDayOf(r.value), source: `law: ${r.ruleKey} (${r.jurisdiction}) v${r.version}` };
  const minWage = { ...DEFAULTS.minWage };
  for (const r of inForce.filter((x) => x.domain === 'MIN_WAGE' && Array.isArray(x.value?.revisionMonths ?? x.value?.revision_months))) {
    minWage[r.jurisdiction] = { months: (r.value.revisionMonths ?? r.value.revision_months).map(Number), source: `law: ${r.ruleKey} (${r.jurisdiction}) v${r.version}` };
  }
  return { tdsDeposit, tdsReturn, pf, esi, pt, minWage };
}

/** The states a company pays people in, or has PT settings for. */
export async function statesOf(db, companyId) {
  const [rows] = await db.query(
    `SELECT DISTINCT state_code AS s FROM hrms_pay_salaries WHERE company_id = ? AND deleted_at IS NULL AND state_code IS NOT NULL AND state_code <> ''
     UNION SELECT DISTINCT state_code FROM hrms_pay_statutory_settings WHERE company_id = ? AND deleted_at IS NULL AND kind = 'PT' AND state_code <> 'IN'
     UNION SELECT state_code FROM hrms_pay_settings WHERE company_id = ? AND deleted_at IS NULL`, [companyId, companyId, companyId]);
  return rows.map((r) => r.s).filter(Boolean).sort();
}

const today = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const addDays = (day, k) => { const d = new Date(`${day}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + k); return d.toISOString().slice(0, 10); };
const dateText = (v) => (v == null ? null : (v instanceof Date ? `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}` : String(v).slice(0, 10)));

/** The company's calendar between two dates, with the marks: status DONE / OVERDUE / DUE_SOON / UPCOMING. */
export async function deadlinesFor(db, companyId, { from = null, to = null, on = today() } = {}) {
  const f = from ?? addDays(on, -45);
  const t = to ?? addDays(on, 120);
  const rules = await calendarRules(db, companyId, on);
  const states = await statesOf(db, companyId);
  const items = deadlinesBetween(f, t, rules, states);
  const [marks] = await db.query(
    `SELECT m.*, u.name AS done_name FROM hrms_compliance_deadline_marks m LEFT JOIN users u ON u.id = m.done_by WHERE m.company_id = ? AND m.deleted_at IS NULL AND m.due_date BETWEEN ? AND ?`, [companyId, f, t]);
  const byKey = new Map(marks.map((m) => [m.deadline_key, m]));
  const soon = addDays(on, 3);
  return {
    from: f, to: t, on, states,
    deadlines: items.map((d) => {
      const m = byKey.get(d.key);
      const done = Boolean(m?.done_at);
      const status = done ? 'DONE' : d.dueDate < on ? 'OVERDUE' : d.dueDate <= soon ? 'DUE_SOON' : 'UPCOMING';
      return { ...d, status, doneAt: m?.done_at ? new Date(m.done_at).toISOString() : null, doneBy: m?.done_name ?? null, doneNote: m?.done_note ?? null, daysLeft: Math.round((Date.parse(d.dueDate) - Date.parse(on)) / 86400000) };
    }),
  };
}

/** Mark a deadline done (or not done). The key must be one of the company's own deadlines. */
export async function markDeadline(db, c, key, { done = true, note = null, on = today() } = {}) {
  const cal = await deadlinesFor(db, c.companyId, { from: addDays(on, -400), to: addDays(on, 400), on });
  const d = cal.deadlines.find((x) => x.key === key);
  if (!d) return null;
  const [[m]] = await db.query('SELECT id FROM hrms_compliance_deadline_marks WHERE company_id = ? AND deadline_key = ? AND deleted_at IS NULL FOR UPDATE', [c.companyId, key]);
  const vals = done ? [new Date(), c.userId, note ? String(note).slice(0, 500) : null] : [null, null, null];
  if (m) await db.query('UPDATE hrms_compliance_deadline_marks SET done_at = ?, done_by = ?, done_note = ? WHERE id = ?', [...vals, m.id]);
  else await db.query('INSERT INTO hrms_compliance_deadline_marks (company_id, deadline_key, due_date, done_at, done_by, done_note) VALUES (?, ?, ?, ?, ?, ?)', [c.companyId, key, d.dueDate, ...vals]);
  if (done) await db.query("UPDATE hrms_compliance_notifications SET status = 'ACKNOWLEDGED', acknowledged_by = ?, acknowledged_at = ?, ack_note = 'marked done' WHERE company_id = ? AND deadline_key = ? AND status = 'OPEN'", [c.userId, new Date(), c.companyId, key]);
  return (await deadlinesFor(db, c.companyId, { from: addDays(on, -400), to: addDays(on, 400), on })).deadlines.find((x) => x.key === key);
}

export { dateText, addDays, today };
export default { deadlinesBetween, deadlinesFor, calendarRules, markDeadline, statesOf, DEFAULTS };
