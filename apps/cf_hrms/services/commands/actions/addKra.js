/**
 * add_kra — a KRA on a role (spec §14.2). KRAs are fixed at the role (§5), so
 * there is no position form of this action. jobContentService.createRoleKra
 * reuses a KRA definition of the same name or writes one.
 */
import { createRoleKra } from '../../jobContentService.js';
import { PERM, textOf, resolve, needRight, companyWideOnly, shownName } from './common.js';

export default {
  key: 'add_kra',
  label: 'Add a KRA to a role',
  template: 'Add the KRA {text} to the role {role}',
  fields: [
    { name: 'text', kind: 'newText', required: true, label: 'KRA' },
    { name: 'role', kind: 'role', required: true, label: 'Role' },
  ],
  examples: [
    'add a KRA Customer complaints to the Sales Manager role',
    'add KRA "Safety & compliance" for Production Manager',
    'give the Store Keeper role a KRA Stock accuracy',
    'the Quality Officer should have a key result area for audits',
    'new KRA Cost control on the Purchase Manager',
    'add key result area Machine uptime to Maintenance Engineer',
    'add the KRA training of operators to the Production Manager role',
    'KRA Delivery on time for the Logistics Incharge',
    'put a KRA called Wastage control on Operator Printing',
    'add a KRA for dispatch accuracy to the Dispatch Supervisor',
  ],
  rightOf: () => PERM.roles.edit,

  validate(step, ctx) {
    const problems = [];
    needRight(ctx, PERM.roles.edit, 'change roles', problems);
    companyWideOnly(ctx, problems);
    const text = textOf(step, 'text');
    if (!text) problems.push('Write the KRA.');
    else if (text.length > 200) problems.push('A KRA is up to 200 characters — a short heading.');
    const role = resolve(ctx, step, 'role', 'role', problems);
    if (role && !role.step && text && (ctx.recs.roleKras.get(role.id) ?? []).some((k) => k.name.toLowerCase() === text.toLowerCase())) {
      problems.push(`${role.name} already has the KRA ${text}.`);
    }
    ctx.preview.lines.push({ key: step.id, kind: 'KRA', text, on: 'role', targetName: shownName(role), targetId: role?.step ? null : role?.id ?? null, targetKey: role?.step ?? null });
    return { problems, made: { kind: 'kra', name: text, roleStep: role?.step ?? null, roleId: role?.step ? null : role?.id ?? null, inside: true } };
  },

  async apply(step, conn, ctx) {
    const roleId = ctx.refId(step, 'role');
    const row = await createRoleKra(conn, ctx.c, roleId, { name: textOf(step, 'text') });
    return { kind: 'kra', id: row.id, definitionId: row.definitionId ?? null, roleId, name: textOf(step, 'text'), link: `roles/${roleId}` };
  },
};
