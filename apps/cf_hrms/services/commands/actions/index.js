/**
 * The action catalogue (spec §14.1, §14.2) — one file per action. To add an
 * action: write its file (key, label, template, fields, examples, rightOf,
 * validate, apply — apply calling an EXISTING service, never a new write path),
 * list it here, and teach reader.js its cue words.
 */
import addDepartment from './addDepartment.js';
import addRole from './addRole.js';
import addKra from './addKra.js';
import addResponsibility from './addResponsibility.js';
import addKpi from './addKpi.js';
import addPosition from './addPosition.js';
import changeShift from './changeShift.js';
import placePerson from './placePerson.js';

export const ACTIONS = [addDepartment, addRole, addKra, addResponsibility, addKpi, addPosition, changeShift, placePerson];
export const ACTION_BY_KEY = new Map(ACTIONS.map((a) => [a.key, a]));

/** What the screen needs to offer "Add a step": no functions, no examples beyond a few. */
export function catalogue() {
  return ACTIONS.map((a) => ({
    key: a.key,
    label: a.label,
    template: a.template,
    fields: a.fields,
    oneOf: a.oneOf ?? null,
    examples: a.examples.slice(0, 3),
  }));
}
