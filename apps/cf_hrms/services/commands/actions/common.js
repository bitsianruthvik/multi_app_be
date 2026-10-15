/**
 * common.js — what every action in the catalogue shares: reading a step's
 * fields, resolving a field to a record or to something an earlier step of the
 * same plan creates, the scope rule, and the one right check.
 *
 * A STEP (spec §14.1):
 *   { id, action, fields: { [name]: Field }, sourceText, confidence }
 *   Field = { value, ref?: { kind, id, label }, candidates?: [{ id, label }], fromText, confidence }
 * A field naming a record carries `ref: { kind: 'department', id: 12, label }`
 * (and `value: 12`); one naming an earlier step carries `ref: { kind: 'step', id: 's1' }`;
 * new text is `value: 'Quality'`.
 *
 * THE CONTEXT an action's `validate` / `apply` receives:
 *   recs     the company's records (../records.js)
 *   actor    { companyId, userId, can(tag), scope }
 *   made     Map(stepId -> what that step makes: { kind, name, departmentId?, inside, id?, code? })
 *   preview  the picture being built (plan.js)
 */
import { PERM } from '../../../lib/http.js';

export { PERM };

export const fieldOf = (step, name) => step?.fields?.[name] ?? null;

export const textOf = (step, name) => {
  const f = fieldOf(step, name);
  const v = f?.value;
  return v == null ? '' : String(v).trim();
};

const KIND_WORD = {
  department: 'department', role: 'role', position: 'position', employee: 'person', shift: 'shift', label: 'label',
};

/**
 * A field that names a record or an earlier step, resolved.
 * -> { id, name, record?, step?, departmentId?, inside } or null (and a problem pushed when required).
 */
export function resolve(ctx, step, name, kind, problems, { required = true, words = null } = {}) {
  const f = fieldOf(step, name);
  const what = words ?? `the ${KIND_WORD[kind] ?? kind}`;
  if (f?.ref?.kind === 'step') {
    const made = ctx.made.get(f.ref.id);
    if (!made) {
      problems.push(`Choose ${what} — the step it pointed at is no longer in the plan or comes after this one.`);
      return null;
    }
    if (made.kind !== kind) {
      problems.push(`Choose ${what} — the step it pointed at makes a ${KIND_WORD[made.kind] ?? made.kind}, not a ${KIND_WORD[kind] ?? kind}.`);
      return null;
    }
    return { ...made, step: f.ref.id };
  }
  const id = f?.ref?.id ?? f?.value;
  if (id == null || id === '') {
    if (required) {
      problems.push(f?.candidates?.length
        ? `Choose ${what}: "${f.fromText ?? ''}" fits more than one.`
        : `Choose ${what}${f?.fromText ? ` — nothing called "${f.fromText}" was found` : ''}.`);
    }
    return null;
  }
  const list = kind === 'department' ? ctx.recs.departments
    : kind === 'role' ? ctx.recs.roles
      : kind === 'position' ? ctx.recs.positions
        : kind === 'employee' ? ctx.recs.employees
          : kind === 'shift' ? ctx.recs.shifts : [];
  const record = list.find((r) => Number(r.id) === Number(id));
  if (!record) {
    problems.push(`Choose ${what} again — the one chosen is not in this company${kind === 'employee' ? ' or not inside your access' : ''}.`);
    return null;
  }
  const departmentId = kind === 'department' ? record.id : kind === 'position' ? record.departmentId
    : kind === 'employee' ? ctx.recs.positionById.get(record.positionId)?.departmentId ?? null : null;
  return { id: record.id, name: record.name, code: record.code ?? null, record, departmentId, inside: insideDepartment(ctx, departmentId) };
}

/** Is this department inside the login's scope? (Company-wide logins: always.) */
export function insideDepartment(ctx, departmentId) {
  const scope = ctx.actor.scope ?? { all: true };
  if (scope.all) return true;
  return departmentId != null && Boolean(scope.departmentIds?.has(Number(departmentId)));
}

/** The right this step needs, checked. */
export function needRight(ctx, tag, words, problems) {
  if (!ctx.actor.can(tag)) problems.push(`You do not have the right to ${words}.`);
}

export const COMPANY_WIDE = 'Roles belong to the whole company. Your access covers your own department only.';

/** A scoped login may not do this at all. */
export function companyWideOnly(ctx, problems, sentence = COMPANY_WIDE) {
  if (!(ctx.actor.scope ?? { all: true }).all) problems.push(sentence);
}

export const OUTSIDE = (what) => `${what} is outside your department. Your access covers your own department and the ones below it.`;

/** The names of a department's parents, top first — for the picture. */
export function pathOf(recs, departmentId) {
  const out = [];
  const seen = new Set();
  let d = recs.deptById.get(Number(departmentId));
  while (d && !seen.has(d.id)) {
    seen.add(d.id);
    out.unshift({ id: d.id, name: d.name, label: d.department_type ?? d.label ?? null });
    d = d.parent_department_id == null ? null : recs.deptById.get(d.parent_department_id);
  }
  return out;
}

/** "Quality" or "the new section Quality (step 1)". */
export const shownName = (r) => (r?.step ? `${r.name} (new)` : r?.name ?? '');

/** The plain name of a responsibility / KPI that is longer than a definition name may be. */
export const NAME_MAX = 250;
export const nameFor = (text) => (text.length > NAME_MAX ? `${text.slice(0, NAME_MAX - 3).trimEnd()}...` : text);
