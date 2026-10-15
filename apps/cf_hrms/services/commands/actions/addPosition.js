/**
 * add_position — a vacant position (spec §14.2). positionService.createPosition
 * (the code is issued by the code generator; no shift named = the company's
 * General shift), then, when a manager is named, addPositionReporting with the
 * company's PRIMARY_MANAGER type — the same two calls the position screen makes.
 *
 * Created ACTIVE: a position written in words is a real chair, ready to be
 * filled or hired for (the form's default, DRAFT, is for a position still being
 * set up).
 */
import { createPosition, addPositionReporting } from '../../positionService.js';
import {
  PERM, fieldOf, resolve, needRight, pathOf, shownName, OUTSIDE,
} from './common.js';
import { said } from './contentLine.js';

export default {
  key: 'add_position',
  label: 'Add a vacant position',
  template: 'Add a position for the role {role} in {department} on the {shift} shift, reporting to {reportsTo}',
  fields: [
    { name: 'role', kind: 'role', required: true, label: 'Role' },
    { name: 'department', kind: 'department', required: true, label: 'Department' },
    { name: 'shift', kind: 'shift', required: false, label: 'Shift' },
    { name: 'reportsTo', kind: 'position', required: false, label: 'Reports to' },
  ],
  examples: [
    'add a position Operator Printing in Printing',
    'add another Helper position in Slitting on the night shift',
    'open a vacancy for a Quality Officer in Quality reporting to P208',
    'create a new seat for Store Keeper in Stores',
    'we need one more Asst Operator in Lamination on the day shift',
    'add a position for the role Shift Supervisor in Production',
    'add a new post of Security Guard in Security, night shift',
    'create a vacant position Officer - Quality under Quality',
    'add a position Incharge - Quality in it',
    'add 1 more helper in BFL reporting to the BFL operator',
    'open a position for a Maintenance Technician in Maintenance',
    'add a position of Driver in Own Vehicles',
  ],
  rightOf: () => PERM.positions.edit,

  validate(step, ctx) {
    const problems = [];
    needRight(ctx, PERM.positions.edit, 'add positions', problems);
    const role = resolve(ctx, step, 'role', 'role', problems);
    const department = resolve(ctx, step, 'department', 'department', problems, { words: 'the department it is in' });
    if (department && !department.inside) problems.push(OUTSIDE(department.name));
    const shift = said(step, 'shift') ? resolve(ctx, step, 'shift', 'shift', problems) : null;
    const reportsTo = said(step, 'reportsTo') ? resolve(ctx, step, 'reportsTo', 'position', problems, { words: 'the position it reports to' }) : null;
    const general = ctx.recs.shifts.find((s) => String(s.code ?? '').toUpperCase().startsWith('G')) ?? ctx.recs.shifts[0];
    ctx.preview.positions.push({
      key: step.id,
      title: shownName(role),
      roleId: role?.step ? null : role?.id ?? null,
      roleKey: role?.step ?? null,
      departmentId: department?.step ? null : department?.id ?? null,
      departmentKey: department?.step ?? null,
      departmentName: department?.name ?? null,
      path: department && !department.step ? pathOf(ctx.recs, department.id) : [],
      shiftName: (shift ?? general)?.name ?? null,
      reportsToId: reportsTo?.step ? null : reportsTo?.id ?? null,
      reportsToKey: reportsTo?.step ?? null,
      reportsToName: reportsTo ? `${reportsTo.name}${reportsTo.code ? ` (${reportsTo.code})` : ''}` : null,
    });
    return {
      problems,
      made: {
        kind: 'position', name: role?.name ?? 'New position', departmentId: department?.step ? null : department?.id ?? null,
        departmentStep: department?.step ?? null, roleId: role?.step ? null : role?.id ?? null, inside: Boolean(department?.inside), vacant: true,
      },
    };
  },

  async apply(step, conn, ctx) {
    const shiftGiven = said(step, 'shift');
    const out = await createPosition(conn, ctx.c, {
      roleId: ctx.refId(step, 'role'),
      departmentId: ctx.refId(step, 'department'),
      ...(shiftGiven ? { defaultShiftId: ctx.refId(step, 'shift') } : {}),
      status: 'ACTIVE',
    });
    const p = out.position ?? out;
    if (said(step, 'reportsTo') && fieldOf(step, 'reportsTo')) {
      const [[type]] = await conn.query(
        "SELECT id FROM hrms_reporting_relationship_types WHERE company_id = ? AND code = 'PRIMARY_MANAGER' AND deleted_at IS NULL",
        [ctx.c.companyId],
      );
      await addPositionReporting(conn, ctx.c, p.id, { toPositionId: ctx.refId(step, 'reportsTo'), relationshipTypeId: type?.id ?? null, isPrimary: true });
    }
    return { kind: 'position', id: p.id, code: p.positionCode ?? p.position_code ?? null, name: p.displayTitle ?? p.positionTitle ?? 'Position', link: `positions/${p.id}` };
  },
};
