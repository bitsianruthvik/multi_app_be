/** add_kpi — a KPI, with an optional target, on a role or on one position (spec §14.2). */
import { PERM } from './common.js';
import { contentLine, onPosition, onPerson } from './contentLine.js';

const line = contentLine('KPI');

export default {
  key: 'add_kpi',
  label: 'Add a KPI',
  template: 'Add the KPI {text} with the target {target} to {role}{position}{person} under the KRA {kra}',
  fields: [
    { name: 'text', kind: 'newText', required: true, label: 'KPI' },
    { name: 'target', kind: 'newText', required: false, label: 'Target' },
    { name: 'role', kind: 'role', required: false, label: 'Role' },
    { name: 'position', kind: 'position', required: false, label: 'Position' },
    // Spec §16.2: one person's own line, on top of their position's.
    { name: 'person', kind: 'employee', required: false, label: 'Person' },
    { name: 'kra', kind: 'kra', required: false, label: 'Under the KRA' },
  ],
  oneOf: ['role', 'position', 'person'],
  examples: [
    'add a KPI machine downtime with a target of under 2 hours a week to Maintenance Engineer',
    'add KPI "On-time dispatch %" target 98% for the Logistics Incharge',
    'measure the Printing operator on wastage percentage, target below 3%',
    'add a KPI customer complaints per month to the Quality Manager role',
    'new KPI for the Store Keeper: stock accuracy, target 99%',
    'track the number of safety incidents for the Production Manager',
    'add KPI attendance percentage with target 95 to Helper',
    'the Sales Manager should be measured on monthly sales against target',
    'add a KPI for P159-1: rolls produced per shift, target 40',
    'add the key performance indicator training hours per employee to HR Executive',
    'set a KPI first pass yield target 97% on the Lamination operator',
    'add KPI "scrap under 2%" for Ravi Kumar',
    'for Ravi Kumar only, add the KPI rolls inspected per shift with target 40',
  ],
  rightOf: (step) => (onPerson(step) ? PERM.employees.edit : onPosition(step) ? PERM.positions.edit : PERM.roles.edit),
  validate: line.validate,
  apply: line.apply,
};
