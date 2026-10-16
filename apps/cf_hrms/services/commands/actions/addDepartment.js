/**
 * add_department — a department or a section (spec §14.2).
 * Calls organisationService.createDepartment: the label is checked against the
 * company's list there, and the code is issued by the code generator.
 *
 * `label` is the department's ONE label (Department, Section, Machine … —
 * the company's list); a position added to it later in the same plan starts
 * on that label's default shift (addPosition.shiftChoiceOf).
 */
import { createDepartment } from '../../organisationService.js';
import {
  PERM, textOf, fieldOf, resolve, needRight, pathOf, OUTSIDE,
} from './common.js';

export default {
  key: 'add_department',
  label: 'Add a department or section',
  template: 'Add the {label} {name} under {under}',
  fields: [
    { name: 'name', kind: 'newText', required: true, label: 'Name' },
    { name: 'label', kind: 'label', required: true, label: 'Label' },
    { name: 'under', kind: 'department', required: false, label: 'Under' },
  ],
  examples: [
    'add a department called Quality Assurance',
    'create a new section Quality under Production',
    'add a section named Dispatch under Logistics',
    'new department Research and Development',
    'make a Warehouse department',
    'add the Tool Room section in Maintenance',
    'set up a new unit for Exports',
    'create a machine Slitter 3 under Slitting',
    'add a sub-department Payroll under HR & Admin',
    'we need a Safety department under Operations',
    'add department "Customer Service"',
    'open a new section called Ink Kitchen under Printing',
    'add a Machine department Printing 3 under Production',
  ],
  rightOf: () => PERM.org.edit,

  validate(step, ctx) {
    const problems = [];
    needRight(ctx, PERM.org.edit, 'add departments', problems);
    const name = textOf(step, 'name');
    if (!name) problems.push('Give the new department a name.');
    else if (name.length > 200) problems.push('A department name is up to 200 characters.');
    const label = textOf(step, 'label') || ctx.recs.labels[0] || 'Department';
    if (!ctx.recs.labels.some((l) => l.toLowerCase() === label.toLowerCase())) {
      problems.push(`"${label}" is not one of this company's department labels (${ctx.recs.labels.join(', ')}).`);
    }
    const hasUnder = fieldOf(step, 'under')?.ref || fieldOf(step, 'under')?.value != null || fieldOf(step, 'under')?.fromText;
    const under = hasUnder ? resolve(ctx, step, 'under', 'department', problems, { words: 'the department it sits under' }) : null;
    const scoped = !(ctx.actor.scope ?? { all: true }).all;
    if (scoped && !under) problems.push('Choose the department it sits under — inside your own. Your access covers your own department and the ones below it.');
    if (scoped && under && !under.inside) problems.push(OUTSIDE(`${under.name}`));
    if (name && ctx.recs.departments.some((d) => d.name.toLowerCase() === name.toLowerCase() && (d.parentId ?? null) === (under?.step ? -1 : under?.id ?? null))) {
      problems.push(`There is already a department called ${name} there.`);
    }
    // Its label — what a position added to it later in the plan starts its shift from.
    const made = { kind: 'department', name, label, inside: under ? under.inside : !scoped, parentStep: under?.step ?? null };
    ctx.preview.departments.push({
      key: step.id, name, label,
      parentId: under?.step ? null : under?.id ?? null,
      parentKey: under?.step ?? null,
      parentName: under?.name ?? null,
      path: under && !under.step ? pathOf(ctx.recs, under.id) : [],
    });
    return { problems, made };
  },

  async apply(step, conn, ctx) {
    const label = textOf(step, 'label') || ctx.recs.labels[0];
    const under = ctx.refId(step, 'under');
    const d = await createDepartment(conn, ctx.c, { name: textOf(step, 'name'), type: label, parentId: under ?? null });
    return { kind: 'department', id: d.id, code: d.code ?? null, name: d.name ?? textOf(step, 'name'), departmentId: d.id, link: 'departments' };
  },
};

