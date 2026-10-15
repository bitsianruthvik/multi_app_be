/**
 * add_role — a role (spec §14.2). roleContentService.createRole: the title must
 * be free, the code is issued by the code generator. Roles belong to the whole
 * company, so a department-scoped login cannot add one.
 */
import { createRole } from '../../roleContentService.js';
import { PERM, textOf, needRight, companyWideOnly } from './common.js';

export default {
  key: 'add_role',
  label: 'Add a role',
  template: 'Add the role {title} with the purpose {purpose}',
  fields: [
    { name: 'title', kind: 'newText', required: true, label: 'Title' },
    { name: 'purpose', kind: 'newText', required: false, label: 'Purpose' },
  ],
  examples: [
    'add a role called Shift Supervisor',
    'create a new role Safety Officer',
    'new role: Quality Inspector',
    'add the job Maintenance Planner',
    'create a role named Store Keeper with purpose keep the stores in order',
    'we need a new role for a Data Analyst',
    'add role "Export Coordinator"',
    'make a role Trainee Operator',
    'set up a new job title Line Leader',
    'create the role HR Business Partner',
    'add a new designation Senior Chemist',
  ],
  rightOf: () => PERM.roles.edit,

  validate(step, ctx) {
    const problems = [];
    needRight(ctx, PERM.roles.edit, 'add roles', problems);
    companyWideOnly(ctx, problems);
    const title = textOf(step, 'title');
    if (!title) problems.push('Give the new role a title.');
    else if (title.length > 200) problems.push('A role title is up to 200 characters.');
    else if (ctx.recs.roles.some((r) => r.name.toLowerCase() === title.toLowerCase())) {
      problems.push(`A role titled ${title} already exists. One title is one role — use that one.`);
    }
    ctx.preview.roles.push({ key: step.id, title, purpose: textOf(step, 'purpose') || null });
    return { problems, made: { kind: 'role', name: title, inside: true } };
  },

  async apply(step, conn, ctx) {
    const purpose = textOf(step, 'purpose');
    const r = await createRole(conn, ctx.c, { title: textOf(step, 'title'), rolePurpose: purpose || null });
    return { kind: 'role', id: r.id, code: r.roleCode ?? r.role_code ?? null, name: r.title ?? textOf(step, 'title'), link: `roles/${r.id}` };
  },
};
