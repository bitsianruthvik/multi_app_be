/**
 * One-time items of a payroll run in Excel (TM/CF_HRMS_HIRING_SPEC.md §25.2): bonus,
 * incentive, overtime, loan recovery, TDS of the month … one row per item.
 *
 *   ?runId=<id> on the download AND the upload: the file is that run's.
 *   info      Run (the month)
 *   editable  Employee★ · Component★ · Amount★ · Note
 *
 * New rows are new items; a changed row changes its amount or note (the person and the
 * component of an item stay — remove it on the run and add another). An upload never removes
 * an item. Only while the run is a draft or calculated: calculate again after an upload.
 * Writes go through runService.addItem / updateItem (the run's own checks and audit).
 */
import { PERM, coded } from './_shared.js';
import { addItem, updateItem, itemComponentOk } from '../../payroll/runService.js';
import { loadComponents } from '../../payroll/common.js';
import { monthBounds } from '../../payroll/proration.js';

const runIdOf = (env) => Number(env.query?.runId) || null;

export default {
  entity: 'pay-items',
  label: 'One-time pay items',
  fileLabel: 'One-time pay items',
  area: 'payroll',
  viewRight: PERM.payroll.view,
  uploadRight: PERM.payroll.upload,
  alsoRights: [PERM.payView],
  wholeCompany: true,
  downloadWholeCompany: true,   // everybody's pay items: not for a department-scoped login
  intro: [
    'One row is one addition or deduction for one person in this month’s payroll: a bonus, an incentive, overtime, a loan recovery, the month’s TDS.',
    'Add a row for each new item. Change the amount or the note of an item already there.',
    'After the upload, calculate the run again.',
  ],
  rules: [
    'The file belongs to one payroll run (the month in the Run column). Upload it on that run.',
    'An item keeps its person and component. To change those, remove the item on the run screen and add a new row.',
    'An upload never removes an item.',
  ],

  async load(db, c, env) {
    const runId = runIdOf(env);
    const [[run]] = runId ? await db.query('SELECT id, period_month, status FROM hrms_pay_runs WHERE company_id = ? AND id = ? AND deleted_at IS NULL', [c.companyId, runId]) : [[null]];
    const comps = await loadComponents(db, c.companyId);
    const [emps] = await db.query("SELECT id, employee_code AS code, full_name AS name FROM hrms_employees WHERE company_id = ? AND deleted_at IS NULL AND employment_status <> 'EXITED' ORDER BY full_name", [c.companyId]);
    const [items] = run ? await db.query('SELECT id, employee_id, component_id, amount, note, updated_at FROM hrms_pay_items WHERE company_id = ? AND run_id = ? AND deleted_at IS NULL ORDER BY id', [c.companyId, run.id]) : [[]];
    const empList = coded('Employees', emps);
    const usable = comps.list.filter(itemComponentOk);
    const compList = coded('Components', usable);
    const label = run ? monthBounds(run.period_month).label : '';
    const current = new Map(items.map((i) => {
      const e = emps.find((x) => x.id === i.employee_id);
      const k = comps.byId.get(i.component_id);
      return [i.id, {
        id: i.id, seen: i.updated_at, label: `${e?.code ?? '#'} — ${k?.name ?? ''}`, employeeId: i.employee_id, componentId: i.component_id,
        cells: { run: label, employee: empList.entries.find((x) => x.id === i.employee_id)?.text ?? null, component: compList.entries.find((x) => x.id === i.component_id)?.text ?? null, amount: Number(i.amount), note: i.note ?? null },
      }];
    }));
    return { lists: { employees: empList, components: compList }, current, run, label };
  },

  columns: () => [
    { key: 'run', header: 'Run', kind: 'info', width: 16, meaning: 'The payroll month this file belongs to.' },
    { key: 'employee', header: 'Employee', kind: 'list', list: 'employees', required: true, width: 32, meaning: 'Who it is for.', example: 'KPPL0001 — A. Person' },
    { key: 'component', header: 'Component', kind: 'list', list: 'components', required: true, width: 26, meaning: 'What it is: bonus, overtime, loan recovery, TDS …', example: 'BONUS — Bonus' },
    { key: 'amount', header: 'Amount', kind: 'number', whole: false, min: 0.01, max: 99999999, required: true, width: 14, meaning: 'The amount, in rupees.', example: '5000' },
    { key: 'note', header: 'Note', kind: 'text', max: 300, width: 30, meaning: 'What it is for, as the payslip says it.', example: 'Diwali bonus' },
  ],
  labelOf: (row) => `${row.values.employee ?? ''} ${row.values.component ?? ''}`.trim(),

  fileRules(rows, state) {
    if (!state.run) return ['Open the payroll run and upload the file there: this file has no run.'];
    if (!['DRAFT', 'CALCULATED'].includes(state.run.status)) return [`The ${state.label} payroll is ${state.run.status.toLowerCase()}: its items cannot be changed.`];
    return [];
  },

  check(row) {
    row.employeeId = row.entries.employee?.id ?? null;
    row.componentId = row.entries.component?.id ?? null;
    if (!row.isNew && row.current) {
      if (row.employeeId != null && row.employeeId !== row.current.employeeId) row.problems.push('Employee: an item keeps its person. Remove it on the run and add a new row.');
      if (row.componentId != null && row.componentId !== row.current.componentId) row.problems.push('Component: an item keeps its component. Remove it on the run and add a new row.');
    }
  },

  async add(db, c, row, state) {
    const out = await addItem(db, c, state.run.id, { employeeId: row.employeeId, componentId: row.componentId, amount: row.values.amount, note: row.values.note ?? null });
    return { id: out.item.id, code: null };
  },
  async change(db, c, row) {
    const body = {};
    if (row.changes.some((x) => x.key === 'amount')) body.amount = row.values.amount;
    if (row.changes.some((x) => x.key === 'note')) body.note = row.values.note ?? null;
    await updateItem(db, c, row.id, body);
  },
};
