/**
 * place_person — put an existing employee in a vacant position (spec §14.2):
 * employeePositionsService.moveEmployee, the same rules as "Move to another
 * position" — the current position ends the day before, a filled position or one
 * with an open hiring is refused by the service.
 */
import { moveEmployee } from '../../employeePositionsService.js';
import { PERM, textOf, resolve, needRight, OUTSIDE, pathOf } from './common.js';
import { readDateWords } from '../text.js';

export default {
  key: 'place_person',
  label: 'Put a person in a position',
  template: 'Put {employee} in the position {position} from {from}',
  fields: [
    { name: 'employee', kind: 'employee', required: true, label: 'Person' },
    { name: 'position', kind: 'position', required: true, label: 'Position' },
    { name: 'from', kind: 'date', required: false, label: 'From' },
  ],
  examples: [
    'put Ravi Kumar in P159-2',
    'move Anita to the new position',
    'place Suresh Patil as Store Keeper in Stores',
    'assign employee K0123 to position P124-1 from 1 November',
    'transfer Mohan to the Quality Officer position',
    'Priya takes the vacant Helper seat in Slitting from Monday',
    'move Rakesh from Printing to the Lamination operator position',
    'appoint Deepak to P208 with effect from 2026-11-01',
    'shift Kiran into the new Shift Supervisor position',
    'put him in it',
    'make Sunita the Officer - Quality',
    'fill P050 with Ganesh from tomorrow',
  ],
  rightOf: () => PERM.positions.edit,

  validate(step, ctx) {
    const problems = [];
    needRight(ctx, PERM.positions.edit, 'move people between positions', problems);
    const employee = resolve(ctx, step, 'employee', 'employee', problems, { words: 'the person' });
    if (employee && !employee.inside) problems.push(OUTSIDE(employee.name));
    const position = resolve(ctx, step, 'position', 'position', problems, { words: 'the position' });
    if (position && !position.inside) problems.push(OUTSIDE(position.name));
    if (position?.record && position.record.occupantId != null && position.record.occupantId !== employee?.id) {
      const who = ctx.recs.employees.find((e) => e.id === position.record.occupantId)?.name;
      problems.push(`${position.name}${position.code ? ` (${position.code})` : ''} is not vacant${who ? ` — ${who} is in it` : ''}. Choose a vacant position.`);
    }
    if (position?.record && employee?.record?.positionId === position.id) problems.push(`${employee.name} is already in that position.`);
    if (employee?.step) problems.push('Choose an existing person — a new person joins through a hiring.');
    const fromText = textOf(step, 'from');
    const from = fromText ? (readDateWords(fromText) ?? (/^\d{4}-\d{2}-\d{2}$/.test(fromText) ? fromText : null)) : null;
    if (fromText && !from) problems.push(`"${fromText}" is not a date I can read. Write it as 1 Nov 2026 or 2026-11-01.`);
    const fromPos = employee?.record?.positionId ? ctx.recs.positionById.get(employee.record.positionId) : null;
    // Taken: a later step may not put somebody else in the same new position.
    const taken = ctx.taken ?? (ctx.taken = new Set());
    const key = position?.step ? `step:${position.step}` : position ? `id:${position.id}` : null;
    if (key && taken.has(key)) problems.push('An earlier step already puts somebody in that position.');
    if (key) taken.add(key);
    ctx.preview.moves.push({
      key: step.id,
      employeeId: employee?.id ?? null,
      employeeName: employee?.name ?? null,
      fromPositionId: fromPos?.id ?? null,
      fromName: fromPos ? `${fromPos.name}${fromPos.code ? ` (${fromPos.code})` : ''}` : null,
      toPositionId: position?.step ? null : position?.id ?? null,
      toKey: position?.step ?? null,
      toName: position ? `${position.name}${position.code ? ` (${position.code})` : ''}` : null,
      toPath: position?.record ? pathOf(ctx.recs, position.record.departmentId) : [],
      from: from ?? null,
    });
    return { problems, made: null };
  },

  async apply(step, conn, ctx) {
    const fromText = textOf(step, 'from');
    const from = fromText ? (readDateWords(fromText) ?? fromText) : undefined;
    const employeeId = ctx.refId(step, 'employee');
    const positionId = ctx.refId(step, 'position');
    const out = await moveEmployee(conn, ctx.c, employeeId, { positionId, ...(from ? { effectiveFrom: from } : {}) });
    return { kind: 'move', id: out?.moved?.assignmentId ?? null, name: 'Moved', link: `employees/${employeeId}`, positionId };
  },
};
