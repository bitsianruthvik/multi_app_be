/**
 * The shared body of add_responsibility and add_kpi (spec §14.2): a line on a
 * ROLE (every position of it) or on ONE position, optionally filed under one of
 * the role's KRAs.
 *
 *   on a role      roleContentService.createMasterItem + addContent — what the
 *                  role screen does (a definition in the library, then assigned);
 *   on a position  jobContentService.seatAddLine — the position-level "Add"
 *                  (§5): the line is the position's own, the role is untouched.
 */
import { createMasterItem, addContent } from '../../roleContentService.js';
import { seatAddLine } from '../../jobContentService.js';
import {
  PERM, textOf, fieldOf, resolve, needRight, companyWideOnly, shownName, nameFor, OUTSIDE,
} from './common.js';

/** Does the step say anything at all for this field? */
export const said = (step, name) => {
  const f = fieldOf(step, name);
  return Boolean(f && (f.ref || (f.value != null && f.value !== '') || f.fromText || f.candidates?.length));
};

/** A line goes on a position when the step names a position and no role. */
export const onPosition = (step) => said(step, 'position') && !said(step, 'role');

export function contentLine(kind) {
  const isKpi = kind === 'KPI';
  const noun = isKpi ? 'KPI' : 'responsibility';

  function validate(step, ctx) {
    const problems = [];
    const text = textOf(step, 'text');
    if (!text) problems.push(`Write the ${noun}.`);
    else if (text.length > 2000) problems.push(`A ${noun} is up to 2000 characters.`);
    const toPosition = onPosition(step);
    let role = null;
    let position = null;
    if (toPosition) {
      needRight(ctx, PERM.positions.edit, `change a position's ${isKpi ? 'KPIs' : 'responsibilities'}`, problems);
      position = resolve(ctx, step, 'position', 'position', problems);
      if (position && !position.inside) problems.push(OUTSIDE(position.name));
    } else {
      needRight(ctx, PERM.roles.edit, 'change roles', problems);
      companyWideOnly(ctx, problems);
      role = resolve(ctx, step, 'role', 'role', problems, { words: 'the role or the position it is for' });
    }
    // The KRA it is filed under: one of the role's (or the position's role's), or one an earlier step adds.
    let kra = null;
    if (said(step, 'kra')) {
      const f = fieldOf(step, 'kra');
      const roleId = role?.id ?? position?.record?.roleId ?? position?.roleId ?? null;
      if (f.ref?.kind === 'step') {
        const made = ctx.made.get(f.ref.id);
        if (!made || made.kind !== 'kra') problems.push('Choose the KRA it is filed under again.');
        else if ((role?.step && made.roleStep !== role.step) || (roleId && made.roleId && made.roleId !== roleId)) {
          problems.push('The KRA it is filed under belongs to another role.');
        } else kra = { name: made.name, step: f.ref.id };
      } else if (f.ref?.id != null || (f.value != null && f.value !== '')) {
        const list = ctx.recs.roleKras.get(roleId) ?? [];
        const k = list.find((x) => Number(x.id) === Number(f.ref?.id ?? f.value));
        if (!k) problems.push(`Choose the KRA again — it must be one of the KRAs of ${role?.name ?? 'the role'}.`);
        else kra = { id: k.id, definitionId: k.definitionId, name: k.name };
      } else {
        problems.push(`Choose the KRA it is filed under${f.fromText ? ` — "${f.fromText}" is not one of the role's KRAs` : ''}, or remove it.`);
      }
    }
    const target = isKpi ? textOf(step, 'target') : '';
    if (target.length > 200) problems.push('A target is up to 200 characters.');
    const on = toPosition ? position : role;
    ctx.preview.lines.push({
      key: step.id, kind, text, target: target || null, on: toPosition ? 'position' : 'role',
      targetName: shownName(on), targetId: on?.step ? null : on?.id ?? null, targetKey: on?.step ?? null, kraName: kra?.name ?? null,
    });
    return { problems, made: { kind: isKpi ? 'kpi' : 'responsibility', name: text, inside: true } };
  }

  async function apply(step, conn, ctx) {
    const text = textOf(step, 'text');
    const target = isKpi ? textOf(step, 'target') : '';
    const kraField = fieldOf(step, 'kra');
    const kraMade = kraField?.ref?.kind === 'step' ? ctx.made.get(kraField.ref.id) : null;
    const kraGiven = kraField && (kraField.ref?.id != null || (kraField.value != null && kraField.value !== ''));
    if (onPosition(step)) {
      const positionId = ctx.refId(step, 'position');
      let parentKraDefinitionId = null;
      if (kraMade) parentKraDefinitionId = kraMade.definitionId ?? null;
      else if (kraGiven) {
        const all = [...ctx.recs.roleKras.values()].flat();
        parentKraDefinitionId = all.find((k) => Number(k.id) === Number(kraField.ref?.id ?? kraField.value))?.definitionId ?? null;
      }
      await seatAddLine(conn, ctx.c, positionId, {
        kind, text, parentKraDefinitionId,
        ...(isKpi && target ? { target: { operator: 'EQ', value: target } } : {}),
      });
      return { kind: isKpi ? 'kpi' : 'responsibility', name: text, link: `positions/${positionId}` };
    }
    const roleId = ctx.refId(step, 'role');
    const definition = isKpi
      ? await createMasterItem(conn, ctx.c, 'kpis', {
        name: nameFor(text), description: text.length > 250 ? text : null, measurementType: 'TEXT', status: 'ACTIVE',
      })
      : await createMasterItem(conn, ctx.c, 'responsibilities', { name: nameFor(text), description: text, status: 'ACTIVE' });
    const roleKraAssignmentId = kraMade ? kraMade.id : (kraGiven ? (kraField.ref?.id ?? kraField.value) : null);
    const row = await addContent(conn, ctx.c, roleId, isKpi ? 'kpis' : 'responsibilities', {
      [isKpi ? 'kpiDefinitionId' : 'responsibilityDefinitionId']: definition.id,
      roleKraAssignmentId,
      ...(isKpi ? { targetOperator: target ? 'EQ' : 'INFO', targetValue: target || null } : {}),
    });
    return { kind: isKpi ? 'kpi' : 'responsibility', id: row.id, name: text, link: `roles/${roleId}` };
  }

  return { validate, apply };
}
