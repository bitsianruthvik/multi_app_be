/**
 * perquisites.js (payroll side) — the perquisites register: per person, per tax year, the FACTS HR
 * enters (hrms_pay_perquisites); the VALUE is worked out each time by services/tax/perquisites.js with
 * the year's rule `perquisites`. (TM/CF_HRMS_HIRING_SPEC.md §25.5 "Perquisites".)
 *
 * FOR THE TDS PROJECTION (P3b wires it into services/payroll/tds.js / payrollTax/runTax.js):
 *
 *   import { perquisitesAsOf } from '../payrollExtras/perquisites.js';
 *   const m = await perquisitesAsOf(db, companyId, '2026-10', employeeIds);
 *   m.get(employeeId) = {
 *     year: '2026-27', asOf: '2026-10',
 *     total,        // the YEAR's taxable value as the register stands (all months, past and to come)
 *     toDate,       // months up to and including asOf
 *     byMonth,      // { 'YYYY-MM': value } — the projection adds the months it needs
 *     items: [{ id, kind, label, nature, row, value, recovered, taxable, byMonth, lines }],
 *     perquisites,  // [{ name, value }] — exactly the engine's input shape (computeTax / projectYear `perquisites`)
 *   }
 *   People with nothing in the register are not in the map.
 *
 * FOR FORM 12BA / 123 (payrollTax/form16.js): perquisiteStatement(db, companyId, year, employeeId) →
 *   [{ name, value, nature, row, valueAsPerRules, recovered }] — `name` and `value` (the taxable amount)
 *   are the shape actuals.js already hands form16.js; nature / row / valueAsPerRules / recovered fill the
 *   statement's columns. (form16.js is not changed here: see the HANDOFF entry for the change it needs.)
 *
 * Salary for accommodation ("salary" of rule 3(1) / 15(8)(k)): the month's taxable EARNING components as
 * paid (locked runs) or, for a month without a locked run, the salary in force — perquisite components
 * left out. HR may type the salary on the entry instead. The same salary over the year decides the
 * "specified employee" test for a car.
 */
import { HrmsError } from '../../lib/errors.js';
import { valuePerquisites, statementRows, factProblems, KINDS, STATEMENT_ROW } from '../tax/perquisites.js';
import { audit, bad, refuse, json, stamp, text, dateText, yearOf, yearMonths, loadRules, isDate, n } from '../payrollTax/common.js';
import { loadTaxWorld, salaryMonth } from '../payrollTax/runTax.js';

export { KINDS };

/** The rule of a year (same in both regimes), with its source. */
export async function perquisiteRule(db, year) {
  const { rules, reason } = await loadRules(db, year);
  if (!rules) return { rule: null, reason };
  if (!rules.NEW.has('perquisites')) return { rule: null, reason: `The rule "perquisites" is missing for ${year}. Run seed-tax-rules.mjs.` };
  const src = rules.NEW.source('perquisites');
  return { rule: rules.NEW.get('perquisites'), source: { note: src.note, url: src.url, verified: src.verified }, reason: null };
}

const shape = (r) => ({
  id: r.id, employeeId: r.employee_id, year: r.tax_year, kind: r.kind, label: r.label ?? null,
  fromDate: dateText(r.from_date), toDate: dateText(r.to_date), facts: json(r.facts_json, {}) ?? {}, note: r.note ?? null, updatedAt: stamp(r.updated_at),
});

async function entriesOf(db, companyId, year, employeeIds = null) {
  const where = employeeIds ? `AND employee_id IN (${employeeIds.length ? employeeIds.map(() => '?').join(',') : 'NULL'})` : '';
  const [rows] = await db.query(`SELECT * FROM hrms_pay_perquisites WHERE company_id = ? AND tax_year = ? AND deleted_at IS NULL ${where} ORDER BY employee_id, from_date, id`, [companyId, year, ...(employeeIds ?? [])]);
  const out = new Map();
  for (const r of rows) { if (!out.has(r.employee_id)) out.set(r.employee_id, []); out.get(r.employee_id).push(shape(r)); }
  return out;
}

/** Salary for accommodation by month, and the year's monetary salary: Map<employeeId, { byMonth, annual }>. */
export async function salaryContext(db, companyId, year, employeeIds) {
  const out = new Map();
  if (!employeeIds.length) return out;
  const months = yearMonths(year);
  const world = await loadTaxWorld(db, companyId, months[11], employeeIds, { paidBefore: '9999-12' });
  const counts = (c) => c.taxable !== 'NO' && !['PERQUISITE', 'NPS_80CCD2'].includes(String(c.exemptRule ?? '').toUpperCase());
  for (const id of employeeIds) {
    const byMonth = {};
    for (const m of months) {
      const paid = world.paid.get(id)?.get(m);
      let comps = null;
      if (paid) comps = paid.components;
      else if (!world.lockedMonths.has(m)) comps = (await salaryMonth(world, id, m))?.components ?? null;
      byMonth[m] = comps ? Math.round(comps.filter(counts).reduce((s, c) => s + n(c.amount), 0)) : 0;
    }
    out.set(id, { byMonth, annual: Object.values(byMonth).reduce((a, b) => a + b, 0) });
  }
  return out;
}

/** The register of these people valued: Map<employeeId, { entries, valued }>. */
async function valued(db, companyId, year, employeeIds = null, { extra = null } = {}) {
  const { rule, reason } = await perquisiteRule(db, year);
  if (!rule) throw refuse('NO_RULES', reason);
  const entries = await entriesOf(db, companyId, year, employeeIds);
  if (extra) {
    const list = (entries.get(extra.employeeId) ?? []).filter((e) => e.id !== extra.entry.id);
    list.push(extra.entry);
    entries.set(extra.employeeId, list);
  }
  const ids = [...entries.keys()];
  const sal = await salaryContext(db, companyId, year, ids);
  const months = yearMonths(year);
  const out = new Map();
  for (const id of ids) {
    const s = sal.get(id);
    const v = valuePerquisites(entries.get(id), { rule, months, salaryByMonth: s?.byMonth ?? {}, annualMonetarySalary: s && s.annual ? s.annual : null });
    out.set(id, { entries: entries.get(id), valued: v, salary: s ?? null });
  }
  return { rule, out };
}

/** The year's perquisite value per person as of a month (see the header). */
export async function perquisitesAsOf(db, companyId, month, employeeIds = null) {
  const year = yearOf(month);
  const { rule } = await perquisiteRule(db, year);
  if (!rule) return new Map();
  const { out } = await valued(db, companyId, year, employeeIds);
  const res = new Map();
  for (const [id, x] of out) {
    const v = x.valued;
    const toDate = Math.round(Object.entries(v.byMonth).filter(([m]) => m <= month).reduce((s, [, a]) => s + a, 0));
    res.set(id, {
      year, asOf: month, total: v.total, toDate, byMonth: v.byMonth,
      items: v.items.map((it) => ({ ...it })),
      perquisites: v.items.filter((it) => it.taxable > 0).map((it) => ({ name: `${it.nature}${it.label ? ` (${it.label})` : ''}`, value: it.taxable })),
    });
  }
  return res;
}

/** Form 12BA / 123 rows of a person's year (see the header). */
export async function perquisiteStatement(db, companyId, year, employeeId) {
  const { rule } = await perquisiteRule(db, year);
  if (!rule) return [];
  const { out } = await valued(db, companyId, year, [employeeId]);
  const x = out.get(employeeId);
  if (!x) return [];
  return statementRows(x.valued.items).map((r) => ({ name: r.nature, value: r.taxable, nature: r.nature, row: r.row, valueAsPerRules: r.value, recovered: r.recovered }));
}

/* ── HR: the register ──────────────────────────────────────────────── */

export async function listYear(db, c, year, query = {}) {
  const { rule, source, reason } = await perquisiteRule(db, year);
  const entries = await entriesOf(db, c.companyId, year);
  const ids = [...entries.keys()];
  const [emps] = ids.length ? await db.query(`SELECT id, employee_code, full_name FROM hrms_employees WHERE company_id = ? AND id IN (${ids.map(() => '?').join(',')})`, [c.companyId, ...ids]) : [[]];
  const empOf = new Map(emps.map((e) => [e.id, { id: e.id, code: e.employee_code, name: e.full_name }]));
  let people = [];
  if (rule) {
    const { out } = await valued(db, c.companyId, year, ids);
    people = ids.map((id) => {
      const x = out.get(id);
      return {
        employee: empOf.get(id), total: x.valued.total, salaryKnown: Boolean(x.salary?.annual),
        entries: x.entries.map((e, i) => ({ ...e, valued: x.valued.items[i] })),
      };
    });
  }
  const q = String(query.q ?? '').trim().toLowerCase();
  if (q) people = people.filter((p) => `${p.employee?.name} ${p.employee?.code}`.toLowerCase().includes(q));
  people.sort((a, b) => String(a.employee?.name).localeCompare(String(b.employee?.name)));
  return {
    year, rule, source: source ?? null, rulesMissing: rule ? null : reason, kinds: KINDS.map((k) => ({ kind: k, ...STATEMENT_ROW[k] })),
    people, totals: { people: people.length, entries: people.reduce((s, p) => s + p.entries.length, 0), value: people.reduce((s, p) => s + p.total, 0) },
  };
}

function readEntry(body, year, { creating, current = null }) {
  const problems = [];
  const out = {};
  const [y1] = year.split('-').map(Number);
  const first = `${y1}-04-01`;
  const last = `${y1 + 1}-03-31`;
  if (creating) {
    out.employeeId = Number(body.employeeId);
    if (!Number.isInteger(out.employeeId) || out.employeeId <= 0) problems.push('Person: choose the employee.');
  }
  const kind = creating ? String(body.kind ?? '').toUpperCase() : current.kind;
  if (creating) { if (!KINDS.includes(kind)) problems.push(`Kind: one of ${KINDS.join(', ')}.`); out.kind = kind; }
  if (body.label !== undefined || creating) out.label = text(body.label, 120);
  const from = body.fromDate !== undefined ? String(body.fromDate ?? '') : current?.fromDate;
  const to = body.toDate !== undefined ? (body.toDate ? String(body.toDate) : null) : current?.toDate ?? null;
  if (!isDate(from)) problems.push('From: a date (YYYY-MM-DD).');
  else if (from < first || from > last) problems.push(`From: a day of the tax year ${year} (${first} to ${last}).`);
  if (to != null && (!isDate(to) || to < from || to > last)) problems.push(`To: a date from ${from || 'the start'} to ${last}, or empty for the rest of the year.`);
  out.fromDate = from;
  out.toDate = to;
  const facts = body.facts !== undefined ? (body.facts && typeof body.facts === 'object' ? body.facts : {}) : current?.facts ?? {};
  if (KINDS.includes(kind)) problems.push(...factProblems(kind, facts));
  out.facts = facts;
  if (body.note !== undefined || creating) out.note = text(body.note, 500);
  if (problems.length) throw bad('That perquisite cannot be saved.', problems);
  return out;
}

async function entryRow(db, companyId, id) {
  const [[r]] = await db.query('SELECT * FROM hrms_pay_perquisites WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [companyId, id]);
  if (!r) throw new HrmsError(404, 'NOT_FOUND', 'That perquisite not found.');
  return r;
}

async function personValue(db, c, year, employeeId, id) {
  const { out } = await valued(db, c.companyId, year, [employeeId]);
  const x = out.get(employeeId);
  const i = x?.entries.findIndex((e) => e.id === id) ?? -1;
  return { total: x?.valued.total ?? 0, valued: i >= 0 ? x.valued.items[i] : null };
}

export async function addEntry(db, c, year, body = {}, requestId = null) {
  const e = readEntry(body, year, { creating: true });
  const [[emp]] = await db.query('SELECT id FROM hrms_employees WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [c.companyId, e.employeeId]);
  if (!emp) throw new HrmsError(404, 'NOT_FOUND', 'That employee not found.');
  const [ins] = await db.query('INSERT INTO hrms_pay_perquisites (company_id, employee_id, tax_year, kind, label, from_date, to_date, facts_json, note, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [c.companyId, e.employeeId, year, e.kind, e.label, e.fromDate, e.toDate, JSON.stringify(e.facts), e.note, c.userId]);
  await audit(db, c, 'hrms_pay_perquisites', ins.insertId, 'CREATE', null, { employeeId: e.employeeId, year, kind: e.kind, label: e.label, fromDate: e.fromDate, toDate: e.toDate, facts: e.facts }, requestId);
  const entry = shape(await entryRow(db, c.companyId, ins.insertId));
  return { entry, ...(await personValue(db, c, year, e.employeeId, entry.id)) };
}

export async function updateEntry(db, c, id, body = {}, requestId = null) {
  const cur = shape(await entryRow(db, c.companyId, id));
  const e = readEntry(body, cur.year, { creating: false, current: cur });
  await db.query('UPDATE hrms_pay_perquisites SET label = COALESCE(?, label), from_date = ?, to_date = ?, facts_json = ?, note = ? WHERE id = ?',
    [e.label ?? null, e.fromDate, e.toDate, JSON.stringify(e.facts), e.note === undefined ? cur.note : e.note, id]);
  await audit(db, c, 'hrms_pay_perquisites', id, 'UPDATE', { fromDate: cur.fromDate, toDate: cur.toDate, facts: cur.facts }, { fromDate: e.fromDate, toDate: e.toDate, facts: e.facts }, requestId);
  const entry = shape(await entryRow(db, c.companyId, id));
  return { entry, ...(await personValue(db, c, cur.year, cur.employeeId, id)) };
}

export async function removeEntry(db, c, id, requestId = null) {
  const cur = shape(await entryRow(db, c.companyId, id));
  await db.query('UPDATE hrms_pay_perquisites SET deleted_at = NOW() WHERE id = ?', [id]);
  await audit(db, c, 'hrms_pay_perquisites', id, 'DELETE', { employeeId: cur.employeeId, kind: cur.kind, facts: cur.facts }, null, requestId);
  return { ok: true };
}

/** The value of an entry not saved yet (or of a changed one), with the person's other entries. Writes nothing. */
export async function preview(db, c, year, body = {}) {
  const current = body.id ? shape(await entryRow(db, c.companyId, Number(body.id))) : null;
  const e = readEntry(body, year, { creating: !current, current });
  const employeeId = current ? current.employeeId : e.employeeId;
  const entry = { id: current?.id ?? 0, kind: current?.kind ?? e.kind, label: e.label ?? current?.label ?? null, fromDate: e.fromDate, toDate: e.toDate, facts: e.facts };
  const { out } = await valued(db, c.companyId, year, [employeeId], { extra: { employeeId, entry } });
  const x = out.get(employeeId);
  const i = x.entries.findIndex((y) => y === entry);
  return { valued: x.valued.items[i], total: x.valued.total, salary: x.salary };
}

export default { listYear, addEntry, updateEntry, removeEntry, preview, perquisitesAsOf, perquisiteStatement, perquisiteRule, salaryContext };
