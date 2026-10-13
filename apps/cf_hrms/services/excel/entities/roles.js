/**
 * Roles in Excel. Code (issued) · Title★ · Purpose · Status · Positions (info).
 * Writes go through roleContentService. Job content (KRAs, responsibilities, KPIs) is not in this file.
 */
import { PERM, words, changedKeys } from './_shared.js';
import * as RC from '../../roleContentService.js';

export default {
  entity: 'roles',
  label: 'Roles',
  area: 'roles',
  viewRight: PERM.roles.view,
  uploadRight: PERM.roles.upload,
  wholeCompany: true,
  intro: ['One row is one role: the job. Its positions and its job content are on their own screens.'],
  rules: ['A role is retired on the Roles screen, not here: uploading never removes anything.'],
  list: { name: 'roles', read: async (db, c) => (await RC.listRoles(db, c.companyId)).items },

  async load(db, c) {
    const [rows] = await db.query(
      `SELECT r.id, r.role_code, r.title, r.role_purpose, r.status, r.updated_at,
              (SELECT COUNT(*) FROM hrms_positions p WHERE p.company_id = r.company_id AND p.role_id = r.id AND p.deleted_at IS NULL) AS positions
         FROM hrms_roles r WHERE r.company_id = ? AND r.deleted_at IS NULL ORDER BY r.title, r.id`, [c.companyId]);
    const current = new Map(rows.map((r) => [r.id, {
      id: r.id, seen: r.updated_at, label: `${r.role_code ?? ''} ${r.title}`.trim(), title: r.title,
      cells: { code: r.role_code, title: r.title, purpose: r.role_purpose && String(r.role_purpose).trim() ? String(r.role_purpose).trim() : null, status: r.status, positions: Number(r.positions) },
    }]));
    return { lists: { status: words('Status', ['DRAFT', 'ACTIVE', 'RETIRED']) }, current };
  },

  columns: () => [
    { key: 'code', header: 'Code', kind: 'issued', width: 14, meaning: 'The role’s code.', example: 'R014' },
    { key: 'title', header: 'Title', kind: 'text', required: true, max: 200, width: 36, meaning: 'What the job is called. One title is one role.', example: 'Shift In-charge' },
    { key: 'purpose', header: 'Purpose', kind: 'text', max: 4000, width: 60, meaning: 'Why the job exists, in a sentence or two.', example: 'Runs the shift safely and to plan.' },
    { key: 'status', header: 'Status', kind: 'list', list: 'status', width: 14, meaning: 'DRAFT or ACTIVE. A retired role stays RETIRED; retiring is done on the screen.', example: 'ACTIVE' },
    { key: 'positions', header: 'Positions', kind: 'info', width: 12, meaning: 'How many positions the role has.', example: '4' },
  ],
  labelOf: (row) => row.values.title ?? '',

  check(row) {
    if (row.isNew && row.values.status == null) row.values.status = 'DRAFT';
    const was = row.current?.cells.status ?? null;
    if (row.values.status === 'RETIRED' && was !== 'RETIRED') row.problems.push('Status: a role is retired on the Roles screen, where you are told what it affects. Uploading never removes anything.');
  },

  checkFile(rows, state) {
    // One title is one role: against the company's roles, and within the file.
    const holder = new Map([...state.current.values()].map((r) => [String(r.title).trim().toLowerCase(), r.id]));
    const inFile = new Map();
    for (const r of rows) {
      const k = String(r.values.title ?? '').trim().toLowerCase();
      if (!k) continue;
      inFile.set(k, [...(inFile.get(k) ?? []), r]);
      const other = holder.get(k);
      if (other != null && other !== r.id && !rows.some((x) => x.id === other && String(x.values.title ?? '').trim().toLowerCase() !== k)) {
        r.problems.push(`Title: a role called “${r.values.title}” already exists. One title is one role.`);
      }
    }
    for (const list of inFile.values()) if (list.length > 1) for (const r of list) if (r.isNew || r.changes.some((c) => c.key === 'title')) r.problems.push('Title: this title is in the file twice. One title is one role.');
  },

  async add(db, c, row) {
    const made = await RC.createRole(db, c, { title: row.values.title, rolePurpose: row.values.purpose, status: row.values.status });
    return { id: made.id, code: made.roleCode };
  },

  async change(db, c, row) {
    const keys = changedKeys(row);
    const body = {};
    if (keys.has('title')) body.title = row.values.title;
    if (keys.has('purpose')) body.rolePurpose = row.values.purpose;
    if (keys.has('status')) body.status = row.values.status;
    await RC.updateRole(db, c, row.id, body);
  },
};
