/**
 * Every entity that has an Excel file, in the order GET /excel/entities lists them.
 * (TM/CF_HRMS_HIRING_SPEC.md §13.3.) To add one: a definition file, and a line here.
 */
import departments from './departments.js';
import locations from './locations.js';
import roles from './roles.js';
import positions from './positions.js';
import employees from './employees.js';
import holidays from './holidays.js';
import shifts from './shifts.js';
import libraries from './libraries.js';
import actuals from './actuals.js';
import leaveBalances from './leaveBalances.js';
import paySalaries from './paySalaries.js';
import payItems from './payItems.js';

export const ENTITIES = [departments, locations, roles, positions, employees, holidays, shifts, ...libraries, actuals, leaveBalances, paySalaries, payItems];

export default ENTITIES;
