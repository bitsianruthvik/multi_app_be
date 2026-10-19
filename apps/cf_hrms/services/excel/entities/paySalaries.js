/**
 * Employee salaries in Excel (TM/CF_HRMS_HIRING_SPEC.md §25.2).
 *
 *   info      Employee code · Name · Status
 *   editable  CTC a year · Structure · Effective from · PF · Reason
 *
 * One row per person (not exited more than a year ago), with the salary in force today — or
 * the next one, when it starts later. Rows cannot be added: every person is already in the
 * file. A person with no salary has empty cells: fill them to give one.
 *
 * WHAT A CHANGED ROW DOES, through the same writer as the Salaries screen
 * (payrollService.createSalary / updateSalary):
 *   - Effective from LATER than the salary's: a REVISION from that day (the old one ends the
 *     day before). A day in the past pays arrears in the next run;
 *   - Effective from the SAME: a CORRECTION of that salary — refused when a locked run paid on it;
 *   - Effective from earlier: a problem (a revision starts after the latest salary).
 * Overrides of single components are on the screen, not here; a revision from Excel keeps
 * none, a correction keeps the ones it had.
 *
 * Amounts: the upload needs payroll upload + view and cf_hrms_pay_view; so does the download.
 */
import { PERM, words, day } from './_shared.js';
import { createSalary, updateSalary, auditSalaryRead } from '../../payroll/payrollService.js';
import { loadStructures, shapeSalary, SALARY_COLUMNS, today } from '../../payroll/common.js';

const PF_WORDS = { CEILING: 'Up to the ceiling', FULL: 'On the full wage', NONE: 'Not a member' };
const PF_OF = Object.fromEntries(Object.entries(PF_WORDS).map(([k, v]) => [v, k]));

export default {
  entity: 'pay-salaries',
  label: 'Salaries',
  fileLabel: 'Salaries',
  area: 'payroll',
  viewRight: PERM.payroll.view,
  uploadRight: PERM.payroll.upload,
  alsoRights: [PERM.payView],
  wholeCompany: true,
  downloadWholeCompany: true,   // everybody's CTC: a department-scoped login does not download it either
  maxChanges: 2000,
  intro: [
    'One row is one person, with the salary in force today (or the next one, when it starts later).',
    'To revise a salary, type the new CTC (or structure) and the day it starts in Effective from. The salary before it ends the day before.',
    'A day in the past is allowed: the next payroll run pays the arrears for the months already paid.',
    'To correct a salary instead, change it and keep its Effective from. A salary a locked payroll paid on cannot be corrected — revise it.',
  ],
  rules: [
    'Rows cannot be added here: every person is already in the file.',
    'CTC is the yearly cost to company in rupees, without commas or decimals beyond paise.',
    'Overrides of single components are set on the Salaries screen, not in this file.',
  ],

  async load(db, c, env) {
    const [emps] = await db.query(
      `SELECT id, employee_code, full_name, employment_status FROM hrms_employees WHERE company_id = ? AND deleted_at IS NULL
          AND (employment_status <> 'EXITED' OR exit_date >= DATE_SUB(CURDATE(), INTERVAL 1 YEAR)) ORDER BY full_name, id LIMIT 5000`, [c.companyId]);
    const ids = emps.map((e) => e.id);
    const [rows] = ids.length ? await db.query(`SELECT ${SALARY_COLUMNS} FROM hrms_pay_salaries WHERE company_id = ? AND deleted_at IS NULL AND employee_id IN (${ids.map(() => '?').join(',')}) ORDER BY effective_from, id`, [c.companyId, ...ids]) : [[]];
    const byEmp = new Map();
    for (const r of rows) { const s = shapeSalary(r); if (!byEmp.has(s.employeeId)) byEmp.set(s.employeeId, []); byEmp.get(s.employeeId).push(s); }
    const structs = await loadStructures(db, c.companyId);
    const t = today();
    const current = new Map();
    for (const e of emps) {
      const all = byEmp.get(e.id) ?? [];
      const s = all.filter((x) => x.effectiveFrom <= t && (!x.effectiveTo || x.effectiveTo >= t)).pop() ?? all.find((x) => x.effectiveFrom > t) ?? null;
      current.set(e.id, {
        id: e.id, seen: s?.updatedAt ?? new Date(0), label: `${e.employee_code} — ${e.full_name}`, salary: s, latest: all[all.length - 1] ?? null,
        cells: {
          code: e.employee_code, name: e.full_name, status: e.employment_status,
          ctc: s ? s.annualCtc : null, structure: s ? (structs.get(s.structureId)?.name ?? null) : null, from: s?.effectiveFrom ?? null,
          pf: s ? PF_WORDS[s.pfMode] : null, reason: s?.reason ?? null,
        },
      });
    }
    // The download is a read of everybody's salary: audited like the list.
    if (env.purpose === 'download' && !['1', 'true', 'yes'].includes(String(env.query?.blank ?? '').toLowerCase())) {
      await auditSalaryRead(db, c, [...current.values()].filter((x) => x.salary).map((x) => x.id), 'salaries Excel');
    }
    const live = [...structs.values()].filter((s) => s.status === 'ACTIVE');
    return {
      lists: {
        structures: { label: 'Salary structures', entries: live.map((s) => ({ text: s.name, key: s.name, id: s.id })) },
        pf: words('PF', Object.values(PF_WORDS)),
      },
      current,
    };
  },

  columns: () => [
    { key: 'code', header: 'Employee code', kind: 'info', width: 16, meaning: 'The person’s employee code.' },
    { key: 'name', header: 'Name', kind: 'info', width: 28, meaning: 'The person’s name.' },
    { key: 'status', header: 'Status', kind: 'info', width: 12, meaning: 'Active, on notice or exited.' },
    { key: 'ctc', header: 'CTC a year', kind: 'number', whole: false, min: 0, max: 999999999, width: 16, meaning: 'The yearly cost to company, in rupees.', example: '600000' },
    { key: 'structure', header: 'Structure', kind: 'list', list: 'structures', width: 24, meaning: 'The salary structure that splits the CTC into components.', example: 'Staff standard' },
    { key: 'from', header: 'Effective from', kind: 'date', meaning: 'The day this salary starts. Later than today’s salary: a revision. The same day: a correction.', example: '2026-04-01' },
    { key: 'pf', header: 'PF', kind: 'list', list: 'pf', width: 18, meaning: 'PF on the wage up to the ceiling (usual), on the full wage, or not a PF member.', example: 'Up to the ceiling' },
    { key: 'reason', header: 'Reason', kind: 'text', max: 500, width: 28, meaning: 'Why: joining, annual revision, promotion …', example: 'Annual revision' },
  ],

  labelOf: () => 'A new row',

  check(row) {
    if (row.isNew) row.problems.push('Rows cannot be added here: every person is already in the file.');
  },

  // After the engine has compared the cells (row.changes is known only then).
  checkFile(rows) {
    for (const row of rows) this.checkRow(row);
  },

  checkRow(row) {
    if (row.isNew || !row.current || row.problems.length || !row.changes.length) return;
    const v = row.values;
    const cur = row.current.salary;
    if (v.ctc == null || !v.structure || !v.from) { row.problems.push('A salary needs all three: CTC a year, Structure and Effective from.'); return; }
    row.structureId = row.entries.structure?.id ?? null;
    const latest = row.current.latest;
    if (cur && day(v.from) === cur.effectiveFrom) row.mode = 'CORRECT';
    else if (!latest || day(v.from) > latest.effectiveFrom) row.mode = 'REVISE';
    else row.problems.push(`Effective from: the latest salary starts ${latest.effectiveFrom}. A revision starts after it; a correction keeps the same day.`);
  },

  async change(db, c, row, state, env) {
    const v = row.values;
    const body = { annualCtc: v.ctc, structureId: row.structureId, effectiveFrom: day(v.from), pfMode: v.pf ? PF_OF[v.pf] : undefined, reason: v.reason ?? `From the Excel file ${String(env.run?.fileName ?? '').slice(0, 200)}` };
    if (row.mode === 'CORRECT') await updateSalary(db, c, row.current.salary.id, body);
    else await createSalary(db, c, { ...body, employeeId: row.id, pfMode: body.pfMode ?? row.current.salary?.pfMode ?? 'CEILING' });
  },
};
