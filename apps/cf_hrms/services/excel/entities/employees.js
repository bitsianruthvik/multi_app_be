/**
 * Employees in Excel.
 * Code (issued) · Salutation · Name★ · Gender · Date of birth · Date of joining★ · Phone · Email · Address ·
 * Employment type · Status (info) · Position.
 *
 * CONTACT (date of birth, phone, email, address) is in the file only for a
 * caller who may see contact details. Without that right the columns are not
 * there, and an upload cannot touch them.
 *
 * A NEW ROW IS THE "INITIAL SET-UP" DOOR, and it needs its own right
 * (cf_hrms_employee_bulk_add): it creates the employee with an issued code and,
 * when Position names a vacant position, puts them in it from the joining date
 * — as the last step of a hiring does, but with no hiring record and no
 * letters. A file with new rows from somebody without that right is refused
 * whole. The run is in the audit log as BULK_ADD, with the file's name.
 *
 * For a row that already exists, Position is for reading only: a person is
 * moved on their own page.
 *
 * Writes go through peopleService and assignmentService.
 */
import { PERM, words, coded, changedKeys, inScope, todayText, day } from './_shared.js';
import * as PEOPLE from '../../peopleService.js';
import { createAssignment } from '../../assignmentService.js';
import { labelState, labelInfoColumn, labelInfoCell } from './_labels.js';

const TYPES = ['EMPLOYEE', 'CONTRACT', 'TRAINEE', 'CONSULTANT', 'OTHER'];
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const readJson = (v) => { if (v == null) return {}; if (typeof v === 'object') return v; try { return JSON.parse(v) ?? {}; } catch { return {}; } };

export default {
  entity: 'employees',
  label: 'Employees',
  area: 'employees',
  viewRight: PERM.employees.view,
  uploadRight: PERM.employees.upload,
  wholeCompany: false,
  // A new employee put in a position costs about fifteen round trips (the code, the record, its file, the position's rules).
  maxAdds: 75,
  intro: [
    'One row is one employee.',
    'A NEW row adds an employee straight away, WITHOUT the hiring steps: no offer letter, no appointment letter. It is for the first set-up of a company, and only somebody given the right “Add employees from Excel” can do it.',
    'Position, on a new row: a vacant position. The person is put in it, on its shift, from the date of joining. On a row that already exists it is for reading only — a person is moved on their own page.',
  ],
  rules: ['Address is the first line of the address. The city and the rest are kept as they are and are changed on the employee’s page.'],
  list: {
    name: 'employees',
    read: async (db, c, env) => (await PEOPLE.listEmployees(db, c.companyId, env.query ?? {}, { departmentIds: env.scope.all ? null : [...env.scope.departmentIds], searchContact: env.can(PERM.contactView) })).items,
  },

  async load(db, c, env) {
    const on = todayText();
    const [[rows], [work], [positions], [holders], [hirings], groups] = await Promise.all([
      db.query(
        `SELECT id, employee_code, full_name, salutation, gender, date_of_birth, date_of_joining, phone, email, address_json, employment_type, employment_status, updated_at
           FROM hrms_employees WHERE company_id = ? AND deleted_at IS NULL ORDER BY full_name, id`, [c.companyId]),
      db.query(
        `SELECT wa.employee_id, wa.is_primary, p.position_code, COALESCE(p.department_id, wa.department_id) AS department_id
           FROM hrms_work_assignments wa LEFT JOIN hrms_positions p ON p.company_id = wa.company_id AND p.id = wa.position_id
          WHERE wa.company_id = ? AND wa.deleted_at IS NULL AND wa.status <> 'ENDED'
            AND (wa.effective_from IS NULL OR wa.effective_from <= ?) AND (wa.effective_to IS NULL OR wa.effective_to >= ?)
          ORDER BY wa.is_primary DESC, wa.id`, [c.companyId, on, on]),
      db.query(
        `SELECT p.id, p.position_code AS code, p.role_id, p.department_id, p.location_id, p.default_shift_id, p.status, COALESCE(p.position_title, r.title) AS name
           FROM hrms_positions p LEFT JOIN hrms_roles r ON r.company_id = p.company_id AND r.id = p.role_id
          WHERE p.company_id = ? AND p.deleted_at IS NULL ORDER BY p.position_code, p.id`, [c.companyId]),
      // Everybody who holds, or is due to hold, a position from today on.
      db.query(
        `SELECT DISTINCT wa.position_id FROM hrms_work_assignments wa
          WHERE wa.company_id = ? AND wa.deleted_at IS NULL AND wa.status <> 'ENDED' AND wa.position_id IS NOT NULL AND (wa.effective_to IS NULL OR wa.effective_to >= ?)`, [c.companyId, on]),
      db.query('SELECT open_position FROM hrms_hirings WHERE company_id = ? AND open_position IS NOT NULL', [c.companyId]),
      labelState(db, c.companyId),
    ]);
    const held = new Set(holders.map((h) => h.position_id));
    const hiring = new Set(hirings.map((h) => h.open_position));
    const all = coded('Positions', positions);
    const vacant = { label: 'Vacant positions', entries: all.entries.filter((e) => e.row.status !== 'CLOSED' && !held.has(e.id) && !hiring.has(e.id) && inScope(env, e.row.department_id)) };
    const main = new Map();
    for (const w of work) if (!main.has(w.employee_id)) main.set(w.employee_id, w);
    const contact = env.can(PERM.contactView);
    const current = new Map(rows.map((e) => {
      const address = readJson(e.address_json);
      const m = main.get(e.id) ?? null;
      return [e.id, {
        id: e.id, seen: e.updated_at, label: `${e.employee_code ?? ''} ${e.full_name}`.trim(), address,
        inScope: env.scope.all || (m != null && inScope(env, m.department_id)),
        cells: {
          code: e.employee_code, salutation: e.salutation || null, name: e.full_name, gender: e.gender || null,
          joined: day(e.date_of_joining), type: e.employment_type, status: e.employment_status, position: m?.position_code ?? null,
          ...labelInfoCell(groups.ofDepartment, m?.department_id ?? null),
          ...(contact ? { born: day(e.date_of_birth), phone: e.phone || null, email: e.email || null, address: address.line1 ? String(address.line1) : null } : {}),
        },
      }];
    }));
    // Lists that also hold what the company already uses, so an unusual value round-trips.
    const usedIn = (key, base) => [...new Set([...base, ...rows.map((r) => r[key]).filter((v) => v != null && String(v).trim() !== '')])];
    return {
      lists: {
        salutation: words('Salutation', usedIn('salutation', ['Mr.', 'Ms.', 'Mrs.', 'Dr.'])), gender: words('Gender', usedIn('gender', ['Male', 'Female', 'Other'])),
        type: words('Employment type', TYPES), vacant,
      },
      current, positions: new Map(all.entries.map((e) => [e.key.toLowerCase(), e])), held, hiring, model: groups.model,
    };
  },

  columns(state, env) {
    const contact = env.can(PERM.contactView);
    return [
      { key: 'code', header: 'Code', kind: 'issued', width: 14, meaning: 'The employee code.', example: 'KP0072' },
      { key: 'salutation', header: 'Salutation', kind: 'list', list: 'salutation', width: 12, meaning: '', example: 'Ms.' },
      { key: 'name', header: 'Name', kind: 'text', required: true, max: 200, width: 32, meaning: 'The person’s full name.', example: 'Asha Verma' },
      { key: 'gender', header: 'Gender', kind: 'list', list: 'gender', width: 12, meaning: '', example: 'Female' },
      ...(contact ? [{ key: 'born', header: 'Date of birth', kind: 'date', meaning: '', example: '1995-04-03' }] : []),
      { key: 'joined', header: 'Date of joining', kind: 'date', required: true, meaning: 'The day they joined, or will join.', example: '2026-10-01' },
      ...(contact ? [
        { key: 'phone', header: 'Phone', kind: 'text', max: 40, width: 16, meaning: '', example: '9000000000' },
        { key: 'email', header: 'Email', kind: 'text', max: 200, width: 30, meaning: '', example: 'asha.verma@example.com' },
        { key: 'address', header: 'Address', kind: 'text', max: 500, width: 40, meaning: 'The first line of the address.', example: 'Flat 1, Example Towers' },
      ] : []),
      { key: 'type', header: 'Employment type', kind: 'list', list: 'type', width: 16, meaning: '', example: 'EMPLOYEE' },
      { key: 'status', header: 'Status', kind: 'info', width: 12, meaning: 'ACTIVE, NOTICE or EXITED. Leaving is recorded on the employee’s page.', example: 'ACTIVE' },
      {
        key: 'position', header: 'Position', kind: 'list', list: 'vacant', lenient: true, newOnly: true, width: 34,
        meaning: 'NEW rows only: a vacant position to put the person in from the date of joining. On an existing row it shows their position and is ignored.', example: 'P021-2 — Operator',
      },
      // The label of the department of their position, for reading and sorting. Ignored on upload.
      labelInfoColumn(state.model),
    ];
  },

  check(row, state, env) {
    if (row.values.email && !EMAIL_RE.test(row.values.email)) row.problems.push(`Email: “${String(row.values.email).slice(0, 60)}” does not look like an email address.`);
    // A contract worker belongs to a contractor, which this file does not carry.
    if (row.values.type === 'CONTRACT' && (row.isNew || row.current?.cells.type !== 'CONTRACT')) row.problems.push('Employment type: a contract worker is added on the Employees screen, where the contractor is chosen.');
    if (!row.isNew) return;
    if (row.values.type == null) row.values.type = 'EMPLOYEE';
    // The position: resolved here, by its code, so the refusal can say WHY it cannot be taken.
    const typed = row.values.position;
    row.position = null;
    if (typed) {
      const entry = state.positions.get(String(typed).split(' — ')[0].trim().toLowerCase()) ?? null;
      if (!entry) row.problems.push(`Position: “${String(typed).slice(0, 60)}” is not a position of this company. Choose a vacant position from the drop-down.`);
      else if (entry.row.status === 'CLOSED') row.problems.push(`Position: ${entry.key} is closed. Reopen it on the Positions screen, or choose another.`);
      else if (state.hiring.has(entry.id)) row.problems.push(`Position: a hiring is open for ${entry.key}. Finish or close the hiring, or choose another position.`);
      else if (state.held.has(entry.id)) row.problems.push(`Position: ${entry.key} is not vacant — somebody is in it, or is due to join it. A position is for one person.`);
      else if (!inScope(env, entry.row.department_id)) row.problems.push(`Position: ${entry.key} is outside your department. Your access covers your own department and the ones below it.`);
      else { row.position = entry; row.values.position = entry.text; }
    } else if (!env.scope.all) {
      row.problems.push('Position: a new person is added to a position inside your department. Choose a vacant one.');
    }
  },

  checkFile(rows) {
    const by = new Map();
    for (const r of rows) if (r.isNew && r.position) by.set(r.position.id, [...(by.get(r.position.id) ?? []), r]);
    for (const list of by.values()) if (list.length > 1) for (const r of list) r.problems.push(`Position: ${r.position.key} is named on ${list.length} rows (${list.map((x) => x.row).join(', ')}). A position is for one person.`);
  },

  /** New rows need the bulk-add right: without it the whole file is refused. */
  fileRules(rows, state, env) {
    const adds = rows.filter((r) => r.isNew).length;
    if (adds && !env.can(PERM.employeeBulkAdd)) {
      return [`This file adds ${adds} ${adds === 1 ? 'employee' : 'employees'}. Adding employees from Excel skips the hiring steps, and needs the right “Add employees from Excel” — an Owner or an HR manager can do it. You can still upload changes to people who already exist.`];
    }
    return [];
  },

  async add(db, c, row, state, env) {
    const v = row.values;
    const made = (await PEOPLE.createEmployee(db, c, {
      fullName: v.name, salutation: v.salutation, gender: v.gender, dateOfJoining: v.joined, employmentType: v.type,
      ...(env.can(PERM.contactView) ? { dateOfBirth: v.born, phone: v.phone, email: v.email, address: v.address ? { line1: v.address } : null } : {}),
    }, null, row.position ? { codeContext: { departmentId: row.position.row.department_id, locationId: row.position.row.location_id, roleId: row.position.row.role_id, shiftId: row.position.row.default_shift_id } } : {})).employee;
    if (row.position) {
      const p = row.position.row;
      // As the last step of a hiring does it: ACTIVE, from the joining date — the dates say when.
      await createAssignment(db, c, {
        employeeId: made.id, roleId: p.role_id, positionId: p.id, departmentId: p.department_id, locationId: p.location_id, defaultShiftId: p.default_shift_id,
        isPrimary: true, status: 'ACTIVE', effectiveFrom: v.joined, reason: `Added from Excel (${env.run.fileName || 'a file'})`.slice(0, 300),
      });
    }
    return { id: made.id, code: made.employeeCode };
  },

  async change(db, c, row, state, env) {
    const keys = changedKeys(row);
    const v = row.values;
    const body = {};
    if (keys.has('name')) body.fullName = v.name;
    if (keys.has('salutation')) body.salutation = v.salutation;
    if (keys.has('gender')) body.gender = v.gender;
    if (keys.has('joined')) body.dateOfJoining = v.joined;
    if (keys.has('type')) body.employmentType = v.type;
    if (env.can(PERM.contactView)) {
      if (keys.has('born')) body.dateOfBirth = v.born;
      if (keys.has('phone')) body.phone = v.phone;
      if (keys.has('email')) body.email = v.email;
      if (keys.has('address')) { const a = { ...row.current.address }; if (v.address) a.line1 = v.address; else delete a.line1; body.address = Object.keys(a).length ? a : null; }
    }
    await PEOPLE.updateEmployee(db, c, row.id, body);
  },

  /** One line in the audit log for the run: BULK_ADD, the file and how many. (`action` is a fixed list; IMPORT is the one for a file.) */
  async afterApply(db, c, { adds, issuedCodes }, state, env) {
    if (!adds.length) return;
    await PEOPLE.audit(db, c, 'hrms_employees', 0, 'IMPORT', null, {
      event: 'BULK_ADD', fileName: env.run.fileName, rows: adds.length, placedInPositions: adds.filter((r) => r.position).length, codes: issuedCodes.map((x) => x.code).slice(0, 2000),
    });
  },
};
