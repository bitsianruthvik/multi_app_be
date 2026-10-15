/**
 * Positions in Excel. Code (issued) · Role★ · Department★ · Shift · Location · Reports to · Status · Person (info).
 * A NEW row with the Shift left blank starts on its department's label default, else General
 * (spec §17.2, services/newPositionShift.js — worked out in memory, no query per row); an existing
 * row cannot be left without a shift.
 * A position is one chair for one person on one shift. Writes go through positionService:
 * the code, the shift that moves the person with it, the reporting line that is ended and not overwritten.
 * Closed positions are not in the file and not in its lists; closing is done on the screen.
 */
import { PERM, words, coded, textOf, changedKeys, inScope, loops, todayText } from './_shared.js';
import * as POS from '../../positionService.js';
import { labelState, groupColumns, groupCells } from './_labels.js';
import { chooseNewShift } from '../../newPositionShift.js';

const STATUSES = ['DRAFT', 'ACTIVE', 'FROZEN'];

export default {
  entity: 'positions',
  label: 'Positions',
  area: 'positions',
  viewRight: PERM.positions.view,
  uploadRight: PERM.positions.upload,
  wholeCompany: false,
  // A new position costs about a dozen round trips (its code, its reporting line, the loop check).
  maxAdds: 100,
  intro: [
    'One row is one position: one chair, for one person, on one shift. Seven helpers are seven rows.',
    'Reports to: the position this one reports to (its main manager). Leave it blank for the top of the chart.',
    'Changing a position’s shift moves the person in it to that shift too.',
  ],
  rules: [
    'A new position can only report to a position that already exists. To add a manager and their team, upload the manager first, download again, then add the team.',
    'A position is closed on the Positions screen, not here: uploading never removes anything. Closed positions are not in this file.',
    'Putting a person in a position is not done here: use the employee’s page, a hiring, or the Employees file.',
  ],
  list: { name: 'positions', read: async (db, c, env) => (await POS.listPositions(db, c.companyId, env.query ?? {})).items },

  async load(db, c, env) {
    const on = todayText();
    const [[rows], [edges], [people], [roles], [departments], [shifts], [locations], [[type]], groups] = await Promise.all([
      db.query(
        `SELECT p.id, p.position_code, p.role_id, p.department_id, p.default_shift_id, p.location_id, p.status, p.updated_at, r.title AS role_title
           FROM hrms_positions p LEFT JOIN hrms_roles r ON r.company_id = p.company_id AND r.id = p.role_id
          WHERE p.company_id = ? AND p.deleted_at IS NULL AND p.status <> 'CLOSED' ORDER BY p.position_code, p.id`, [c.companyId]),
      db.query(
        `SELECT rr.id, rr.from_position_id, rr.to_position_id FROM hrms_position_reporting_relationships rr
           JOIN hrms_reporting_relationship_types t ON t.company_id = rr.company_id AND t.id = rr.relationship_type_id AND t.code = 'PRIMARY_MANAGER'
          WHERE rr.company_id = ? AND rr.deleted_at IS NULL AND (rr.effective_from IS NULL OR rr.effective_from <= ?) AND (rr.effective_to IS NULL OR rr.effective_to >= ?)
          ORDER BY rr.is_primary DESC, rr.id`, [c.companyId, on, on]),
      db.query(
        `SELECT wa.position_id, e.full_name, e.employee_code FROM hrms_work_assignments wa JOIN hrms_employees e ON e.company_id = wa.company_id AND e.id = wa.employee_id
          WHERE wa.company_id = ? AND wa.deleted_at IS NULL AND wa.status <> 'ENDED' AND wa.position_id IS NOT NULL
            AND (wa.effective_from IS NULL OR wa.effective_from <= ?) AND (wa.effective_to IS NULL OR wa.effective_to >= ?)`, [c.companyId, on, on]),
      db.query('SELECT id, role_code AS code, title AS name FROM hrms_roles WHERE company_id = ? AND deleted_at IS NULL ORDER BY title', [c.companyId]),
      db.query('SELECT id, code, name FROM hrms_departments WHERE company_id = ? AND deleted_at IS NULL ORDER BY name', [c.companyId]),
      db.query('SELECT id, code, name, status FROM hrms_shifts WHERE company_id = ? AND deleted_at IS NULL ORDER BY id', [c.companyId]),
      db.query('SELECT id, code, name FROM hrms_locations WHERE company_id = ? AND deleted_at IS NULL ORDER BY name', [c.companyId]),
      db.query("SELECT id FROM hrms_reporting_relationship_types WHERE company_id = ? AND code = 'PRIMARY_MANAGER' AND deleted_at IS NULL ORDER BY id LIMIT 1", [c.companyId]),
      labelState(db, c.companyId),
    ]);
    const lists = {
      roles: coded('Roles', roles), departments: coded('Departments', departments), shifts: coded('Shifts', shifts), locations: coded('Locations', locations),
      positions: coded('Positions', rows.map((p) => ({ id: p.id, code: p.position_code, name: p.role_title ?? '' }))), status: words('Status', STATUSES),
    };
    const manager = new Map();
    for (const e of edges) if (!manager.has(e.from_position_id)) manager.set(e.from_position_id, { lineId: e.id, toId: e.to_position_id });
    const person = new Map(people.map((p) => [p.position_id, `${p.full_name}${p.employee_code ? ` (${p.employee_code})` : ''}`]));
    const current = new Map(rows.map((p) => [p.id, {
      id: p.id, seen: p.updated_at, label: `${p.position_code ?? ''} ${p.role_title ?? ''}`.trim(),
      managerId: manager.get(p.id)?.toId ?? null, lineId: manager.get(p.id)?.lineId ?? null, departmentId: p.department_id,
      inScope: inScope(env, p.department_id),
      cells: {
        code: p.position_code, role: textOf(lists.roles, p.role_id), department: textOf(lists.departments, p.department_id), shift: textOf(lists.shifts, p.default_shift_id),
        location: textOf(lists.locations, p.location_id), reportsTo: textOf(lists.positions, manager.get(p.id)?.toId ?? null), status: p.status, person: person.get(p.id) ?? null,
        ...groupCells(groups.model, groups.ofDepartment, p.department_id, { kind: true }),
      },
    }]));
    // Each department's labels that carry a default shift, in group order: what a new row with no shift starts on.
    const shiftLabels = new Map();
    for (const [departmentId, names] of groups.ofDepartment) {
      const list = [];
      for (const g of groups.model.groups) {
        const l = names.has(g.id) ? groups.model.labelsOf(g.id).find((x) => x.name === names.get(g.id)) : null;
        if (l?.default_shift_id != null) list.push({ labelId: l.id, name: l.name, groupName: g.name, defaultShiftId: l.default_shift_id });
      }
      if (list.length) shiftLabels.set(departmentId, list);
    }
    return { lists, current, primaryTypeId: type?.id ?? null, model: groups.model, shiftLabels, shiftRows: shifts };
  },

  columns: (state) => [
    { key: 'code', header: 'Code', kind: 'issued', width: 14, meaning: 'The position’s code.', example: 'P021-2' },
    { key: 'role', header: 'Role', kind: 'list', list: 'roles', required: true, width: 36, meaning: 'The job this position is for.', example: 'R014 — Shift In-charge' },
    { key: 'department', header: 'Department', kind: 'list', list: 'departments', required: true, width: 34, meaning: 'Where the position sits.', example: 'D004 — Production' },
    { key: 'shift', header: 'Shift', kind: 'list', list: 'shifts', width: 18, meaning: 'The one shift this position works. Blank on a new row: the shift its department’s label starts new positions on, else the General shift.', example: 'D — Day' },
    { key: 'location', header: 'Location', kind: 'list', list: 'locations', width: 22, meaning: 'Where it is based, if the company has more than one place.', example: 'L01 — Unit 2' },
    { key: 'reportsTo', header: 'Reports to', kind: 'list', list: 'positions', width: 34, meaning: 'The position this one reports to. Blank = the top of the chart.', example: 'P004 — Plant Head' },
    { key: 'status', header: 'Status', kind: 'list', list: 'status', width: 12, meaning: 'DRAFT, ACTIVE or FROZEN (kept, not to be filled).', example: 'ACTIVE' },
    { key: 'person', header: 'Person', kind: 'info', width: 30, meaning: 'Who is in the position today.', example: 'Asha Verma (KP0031)' },
    // Its department's label in each group, for reading and sorting (spec §15.3). Ignored on upload.
    ...groupColumns(state.model, ['Code', 'Role', 'Department', 'Shift', 'Location', 'Reports to', 'Status', 'Person'], { info: true, kind: true }),
  ],
  labelOf: (row) => `New position — ${row.values.role ?? ''}`.trim(),

  check(row, state, env) {
    if (!row.isNew && row.current && row.values.shift == null && row.current.cells.shift != null) {
      row.problems.push('Shift: a position is on one shift. Choose the shift it works.');
    }
    if (row.isNew && !row.entries.shift) {
      // spec §17.2: none named -> the department's label default, else General. Said in the preview.
      const choice = chooseNewShift({ labels: state.shiftLabels.get(row.entries.department?.id ?? null) ?? [], shifts: state.shiftRows });
      if (!choice.shift) row.problems.push('Shift: this company has no shift yet. Add one under Shifts first.');
      else {
        row.entries.shift = { id: choice.shift.id };
        const why = choice.from === 'LABEL' ? `from the label ${choice.label.name}` : 'the company’s general shift';
        row.values.shift = `${textOf(state.lists.shifts, choice.shift.id) ?? choice.shift.name} (${why})`;
      }
    }
    row.managerId = row.entries.reportsTo?.id ?? null;
    if (!row.isNew && row.managerId === row.id) row.problems.push('Reports to: a position cannot report to itself.');
    if (row.isNew && row.values.status == null) row.values.status = 'ACTIVE';
    if (row.managerId != null && state.primaryTypeId == null) row.problems.push('Reports to: this company has no “primary manager” reporting type. Add it under Reporting types first.');
    const departmentId = row.entries.department?.id ?? null;
    if (!env.scope.all && departmentId != null && !inScope(env, departmentId)) {
      row.problems.push('Department: choose a department inside your own. Your access covers your own department and the ones below it.');
    }
  },

  checkFile(rows, state) {
    const now = new Map([...state.current.values()].map((p) => [p.id, p.managerId]));
    for (const r of loops(rows, now, (row) => row.managerId)) r.problems.push('Reports to: this would make a loop — the position you chose reports, directly or through others, to this one.');
  },

  async add(db, c, row, state) {
    const made = (await POS.createPosition(db, c, {
      roleId: row.entries.role.id, departmentId: row.entries.department.id, defaultShiftId: row.entries.shift.id,
      locationId: row.entries.location?.id ?? null, status: row.values.status,
    })).position;
    if (row.managerId != null) {
      await POS.addPositionReporting(db, c, made.id, { toPositionId: row.managerId, relationshipTypeId: state.primaryTypeId, effectiveFrom: todayText() });
    }
    return { id: made.id, code: made.positionCode };
  },

  async change(db, c, row, state) {
    const keys = changedKeys(row);
    const body = {};
    if (keys.has('role')) body.roleId = row.entries.role?.id ?? null;
    if (keys.has('department')) body.departmentId = row.entries.department?.id ?? null;
    if (keys.has('shift')) body.defaultShiftId = row.entries.shift?.id ?? null;
    if (keys.has('location')) body.locationId = row.entries.location?.id ?? null;
    if (keys.has('status')) body.status = row.values.status;
    if (Object.keys(body).length) await POS.updatePosition(db, c, row.id, body);
    if (keys.has('reportsTo')) {
      const lineId = row.current.lineId;
      if (row.managerId == null) { if (lineId) await POS.endPositionReporting(db, c, lineId, {}); }
      // The old line is ended the day before and the new one starts today — ended, not overwritten.
      else await POS.addPositionReporting(db, c, row.id, { toPositionId: row.managerId, relationshipTypeId: state.primaryTypeId, effectiveFrom: todayText(), ...(lineId ? { replacesId: lineId } : {}) });
    }
  },
};
