/** add_responsibility — a responsibility on a role or on one position (spec §14.2). */
import { PERM } from './common.js';
import { contentLine, onPosition, onPerson } from './contentLine.js';

const line = contentLine('RESPONSIBILITY');

export default {
  key: 'add_responsibility',
  label: 'Add a responsibility',
  template: 'Add the responsibility {text} to {role}{position}{person} under the KRA {kra}',
  fields: [
    { name: 'text', kind: 'newText', required: true, label: 'Responsibility' },
    { name: 'role', kind: 'role', required: false, label: 'Role' },
    { name: 'position', kind: 'position', required: false, label: 'Position' },
    // Spec §16.2: one person's own line, on top of their position's.
    { name: 'person', kind: 'employee', required: false, label: 'Person' },
    { name: 'kra', kind: 'kra', required: false, label: 'Under the KRA' },
  ],
  oneOf: ['role', 'position', 'person'],
  examples: [
    'add a responsibility check the boiler pressure every shift to the Boiler Operator role',
    'add responsibility "Prepare the daily production report" to Production Manager',
    'the Store Keeper should also count the stock every Friday',
    'give the Printing operator the duty of cleaning the ink trays',
    'add the task record machine stoppages to Operator Printing',
    'add a duty to P159-1: inspect the rolls before dispatch',
    'Quality Officer is responsible for calibrating the instruments',
    'new responsibility for the Security guard: check visitor passes',
    'add responsibility train new helpers under the KRA Manpower & training for Production Manager',
    'make the HR Executive responsible for joining formalities',
    'add a job duty maintain the attendance register to the Time Office role',
    'only for position P124-1 add the responsibility look after the rewinder',
    'add the responsibility "train the new helper" for Ravi Kumar',
    'only for Sunita Devi add the duty of checking the gate register',
  ],
  rightOf: (step) => (onPerson(step) ? PERM.employees.edit : onPosition(step) ? PERM.positions.edit : PERM.roles.edit),
  validate: line.validate,
  apply: line.apply,
};
