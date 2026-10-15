/**
 * change_shift — a position's shift (spec §14.2). positionService.updatePosition
 * with `defaultShiftId`: whoever sits in the position moves to the shift with it,
 * in the same transaction (that is the service's own rule).
 */
import { updatePosition } from '../../positionService.js';
import { PERM, resolve, needRight, OUTSIDE } from './common.js';

export default {
  key: 'change_shift',
  label: "Change a position's shift",
  template: 'Put the position {position} on the {shift} shift',
  fields: [
    { name: 'position', kind: 'position', required: true, label: 'Position' },
    { name: 'shift', kind: 'shift', required: true, label: 'Shift' },
  ],
  examples: [
    'move P159-1 to the night shift',
    'change the shift of P124-2 to Day',
    'put the Operator Printing position on the general shift',
    'switch position P021 to nights',
    'P208 should work the day shift from now on',
    'change P159-2 shift to Night',
    'set the shift of the Store Keeper position to General',
    'make P124-1 a night shift position',
    'shift P050 to the day shift',
    'the security guard position goes on night shift',
  ],
  rightOf: () => PERM.positions.edit,

  validate(step, ctx) {
    const problems = [];
    needRight(ctx, PERM.positions.edit, "change a position's shift", problems);
    const position = resolve(ctx, step, 'position', 'position', problems);
    if (position && !position.inside) problems.push(OUTSIDE(position.name));
    const shift = resolve(ctx, step, 'shift', 'shift', problems);
    const current = position?.record ? ctx.recs.shifts.find((s) => s.id === position.record.shiftId) : null;
    if (position?.record && shift && current?.id === shift.id) problems.push(`${position.name} is already on the ${shift.name} shift.`);
    ctx.preview.shifts.push({
      key: step.id,
      positionId: position?.step ? null : position?.id ?? null,
      positionKey: position?.step ?? null,
      positionName: position ? `${position.name}${position.code ? ` (${position.code})` : ''}` : null,
      fromShift: current?.name ?? null,
      toShift: shift?.name ?? null,
    });
    return { problems, made: null };
  },

  async apply(step, conn, ctx) {
    const positionId = ctx.refId(step, 'position');
    await updatePosition(conn, ctx.c, positionId, { defaultShiftId: ctx.refId(step, 'shift') });
    return { kind: 'shift', id: positionId, name: 'Shift changed', link: `positions/${positionId}` };
  },
};
