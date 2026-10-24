/**
 * Org units (departments) in Excel. Code (issued) · Kind★ · Name★ · Under · Shared · Serves · Status (spec §33).
 * Kind: the unit's ONE label, a drop-down of the company's kinds. Older files (header "Label", and the "Kind" of
 * the label-group days) still read — the column's `aliases`.
 * Writes go through organisationService (the label rules, the cycle rule, the serves rule, the code).
 */
import { PERM, words, coded, textOf, STATUS, yes, flag, changedKeys, inScope, loops } from './_shared.js';
import * as ORG from '../../organisationService.js';
import { labelState } from './_labels.js';

const codesOf = (text) => String(text ?? '').split(',').map((s) => s.trim()).filter(Boolean);

export default {
  entity: 'departments',
  label: 'Org units',
  area: 'org',
  viewRight: PERM.org.view,
  uploadRight: PERM.org.upload,
  wholeCompany: false,
  intro: [
    'One row is one org unit: a department, a section, a machine … The Kind says which.',
    'Under: the org unit this one sits in. Leave it blank for an org unit at the top.',
    'Serves: only for a shared org unit — the codes of the org units it works for, separated by commas.',
  ],
  rules: ['A new org unit can only be put under an org unit that already exists. To add an org unit and one below it, upload the first, download again, then add the second.'],
  list: { name: 'departments', read: async (db, c) => (await ORG.listDepartments(db, c.companyId)).rows },

  async load(db, c, env) {
    const [[rows], [serves], groups] = await Promise.all([
      db.query('SELECT id, code, name, department_type, parent_department_id, is_shared, status, updated_at FROM hrms_departments WHERE company_id = ? AND deleted_at IS NULL ORDER BY name, id', [c.companyId]),
      db.query('SELECT department_id, serves_department_id FROM hrms_department_serves WHERE company_id = ? AND deleted_at IS NULL', [c.companyId]),
      labelState(db, c.companyId),
    ]);
    const labels = groups.model.labels;
    const departments = coded('Org units', rows);
    const codeOf = new Map(departments.entries.map((e) => [e.id, e.key]));
    const servedBy = new Map();
    for (const s of serves) if (codeOf.has(s.serves_department_id)) servedBy.set(s.department_id, [...(servedBy.get(s.department_id) ?? []), codeOf.get(s.serves_department_id)]);
    const current = new Map(rows.map((r) => [r.id, {
      id: r.id, seen: r.updated_at, label: `${r.code ?? ''} ${r.name}`.trim(), parentId: r.parent_department_id,
      inScope: inScope(env, r.id),
      cells: {
        code: r.code, name: r.name, label: r.department_type, under: textOf(departments, r.parent_department_id),
        shared: flag(r.is_shared), serves: (servedBy.get(r.id) ?? []).sort().join(', ') || null, status: r.status,
      },
    }]));
    return {
      lists: { labels: words('Kinds', labels.map((l) => l.name)), departments, status: words('Status', STATUS) },
      current,
    };
  },

  columns: () => [
    { key: 'code', header: 'Code', kind: 'issued', width: 14, meaning: 'The org unit’s code.', example: 'D012' },
    { key: 'label', header: 'Kind', aliases: ['Label'], kind: 'list', list: 'labels', required: true, width: 18, meaning: 'What kind of org unit it is: Department, Section, Machine, or another of the company’s kinds.', example: 'Section' },
    { key: 'name', header: 'Name', kind: 'text', required: true, max: 200, width: 34, meaning: 'What the org unit is called.', example: 'Quality Control' },
    { key: 'under', header: 'Under', kind: 'list', list: 'departments', width: 36, meaning: 'The org unit it sits in. Blank = at the top.', example: 'D004 — Production' },
    { key: 'shared', header: 'Shared', kind: 'yesno', meaning: 'Yes when it works for several org units.', example: 'No' },
    { key: 'serves', header: 'Serves', kind: 'text', max: 500, width: 26, meaning: 'For a shared org unit: the codes of the org units it works for, separated by commas.', example: 'D004, D007' },
    { key: 'status', header: 'Status', kind: 'list', list: 'status', width: 14, meaning: 'ACTIVE, or INACTIVE to keep it out of pickers.', example: 'ACTIVE' },
  ],

  check(row, state, env) {
    const byCode = new Map(state.lists.departments.entries.map((e) => [e.key.toLowerCase(), e]));
    const parent = row.entries.under ?? null;
    row.parentId = parent?.id ?? null;
    if (!row.isNew && parent?.id === row.id) row.problems.push('Under: an org unit cannot be under itself.');
    // Serves: codes, each a department of this company, none of them itself, only on a shared department.
    const codes = codesOf(row.values.serves);
    row.servesIds = [];
    const unknown = codes.filter((k) => !byCode.has(k.toLowerCase()));
    if (unknown.length) row.problems.push(`Serves: ${unknown.map((k) => `“${k.slice(0, 30)}”`).join(', ')} ${unknown.length === 1 ? 'is not the code of an org unit' : 'are not codes of org units'}. Use the codes on the Lists sheet, separated by commas.`);
    else {
      row.servesIds = codes.map((k) => byCode.get(k.toLowerCase()).id);
      if (!row.isNew && row.servesIds.includes(row.id)) row.problems.push('Serves: an org unit cannot serve itself.');
      if (codes.length && !yes(row.values.shared)) row.problems.push('Serves: only a shared org unit serves others. Set Shared to Yes, or clear Serves.');
      row.values.serves = codes.map((k) => byCode.get(k.toLowerCase()).key).sort().join(', ') || null;
    }
    if (row.isNew && row.values.status == null) row.values.status = 'ACTIVE';
  },

  checkFile(rows, state, env) {
    // A login limited to its department: only inside it, never its own top, and never moved out.
    // Asked of rows this file changes or adds — a row left as it was is nobody's problem.
    if (!env.scope.all) {
      for (const row of rows) {
        if (row.problems.length || (!row.isNew && !row.changes.length)) continue;
        if (!row.isNew && env.scope.rootIds.includes(row.id)) row.problems.push('This is your own org unit. Changing it needs somebody whose access covers the whole company.');
        else if (!inScope(env, row.parentId)) row.problems.push('Under: choose an org unit inside your own. Your access covers your org unit and everything under it.');
      }
    }
    const now = new Map([...state.current.values()].map((d) => [d.id, d.parentId]));
    for (const r of loops(rows, now, (row) => row.parentId)) r.problems.push('Under: this would put the org unit inside itself (the org unit you chose is below this one).');
  },

  async add(db, c, row) {
    const made = await ORG.createDepartment(db, c, {
      name: row.values.name, type: row.values.label, parentId: row.parentId, isShared: yes(row.values.shared), serves: row.servesIds, status: row.values.status,
    });
    return { id: made.id, code: made.code };
  },

  async change(db, c, row) {
    const keys = changedKeys(row);
    const body = {};
    if (keys.has('name')) body.name = row.values.name;
    if (keys.has('label')) body.type = row.values.label;
    if (keys.has('under')) body.parentId = row.parentId;
    if (keys.has('shared')) body.isShared = yes(row.values.shared);
    if (keys.has('serves') || (keys.has('shared') && yes(row.values.shared))) body.serves = row.servesIds;
    if (keys.has('status')) body.status = row.values.status;
    await ORG.updateDepartment(db, c, row.id, body);
  },
};
