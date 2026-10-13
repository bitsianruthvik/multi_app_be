/**
 * The six libraries in Excel: KRAs, responsibilities, KPIs, skills, qualifications, authorities.
 * One definition each, made from one description — the fields are the ones that library's own
 * add / edit dialog has. Writes go through roleContentService (createMasterItem / updateMasterItem).
 * A library belongs to the whole company. Which roles use an entry is not in this file.
 */
import { PERM, words, changedKeys } from './_shared.js';
import * as RC from '../../roleContentService.js';

const STATUS = ['ACTIVE', 'INACTIVE'];
const text = (key, header, max, meaning, example, extra = {}) => ({ key, header, kind: 'text', max, width: max > 300 ? 60 : 28, meaning, example, ...extra });
const pick = (key, header, list, meaning, example, extra = {}) => ({ key, header, kind: 'list', list, width: 20, meaning, example, ...extra });
const status = pick('status', 'Status', 'status', 'ACTIVE, or INACTIVE to keep it out of pickers.', 'ACTIVE');
const code = text('code', 'Code', 50, 'A short code of your own, if you use them.', 'K-01', { width: 14 });

/** kind -> { label, columns, lists }. `key` is the service's own field name; `column` is the table's. */
const LIBRARIES = {
  kras: {
    label: 'KRAs', one: 'KRA',
    columns: [code, text('name', 'Name', 200, 'The key result area.', 'Output and delivery', { required: true }), text('description', 'Description', 4000, 'What it covers.', ''), text('category', 'Category', 100, 'A grouping of your own.', 'Production'), status],
    db: { code: 'code', name: 'name', description: 'description', category: 'category', status: 'status' },
  },
  responsibilities: {
    label: 'Responsibilities', one: 'responsibility',
    columns: [
      code, text('name', 'Name', 250, 'A short name for the duty.', 'Shift handover', { required: true }), text('description', 'Statement', 4000, 'The duty, as a sentence.', 'Signs off the handover note at the end of every shift.', { required: true }),
      pick('responsibilityClass', 'Class', 'responsibilityClass', 'How the holder is involved.', 'OWNER'), status,
    ],
    lists: { responsibilityClass: words('Class', ['OWNER', 'JOINT_OWNER', 'SUPPORT', 'BACKUP', 'APPROVER', 'REVIEWER', 'GENERIC']) },
    db: { code: 'code', name: 'name', description: 'description', responsibilityClass: 'responsibility_class', status: 'status' },
  },
  kpis: {
    label: 'KPIs', one: 'KPI',
    columns: [
      code, text('name', 'Name', 250, 'What is measured.', 'On-time dispatch', { required: true }), text('description', 'Description', 4000, 'What it means.', ''),
      pick('measurementType', 'Measurement type', 'measurementType', 'What kind of number it is.', 'PERCENTAGE'), text('unit', 'Unit', 50, 'The unit it is counted in.', '%', { width: 12 }),
      pick('direction', 'Direction', 'direction', 'Which way is better.', 'HIGHER_BETTER'), text('formulaText', 'Formula', 4000, 'How it is worked out, in words.', 'Orders dispatched on time ÷ orders due'),
      text('dataSource', 'Data source', 250, 'Where the number comes from.', 'Dispatch register'), pick('defaultFrequency', 'Frequency', 'frequency', 'How often it is looked at.', 'MONTHLY'), status,
    ],
    lists: {
      measurementType: words('Measurement type', ['NUMBER', 'PERCENTAGE', 'CURRENCY', 'DURATION', 'BOOLEAN', 'RATING', 'TEXT']),
      direction: words('Direction', ['HIGHER_BETTER', 'LOWER_BETTER', 'TARGET_RANGE', 'NEUTRAL']),
      frequency: words('Frequency', ['DAILY', 'WEEKLY', 'MONTHLY', 'QUARTERLY', 'YEARLY', 'ON_EVENT']),
    },
    db: { code: 'code', name: 'name', description: 'description', measurementType: 'measurement_type', unit: 'unit', direction: 'direction', formulaText: 'formula_text', dataSource: 'data_source', defaultFrequency: 'default_frequency', status: 'status' },
  },
  skills: {
    label: 'Skills', one: 'skill',
    columns: [text('name', 'Name', 200, 'The skill.', 'Reading a job card', { required: true }), pick('skillType', 'Skill type', 'skillType', 'What kind of skill it is.', 'TECHNICAL'), text('description', 'Description', 4000, 'What it means here.', ''), status],
    lists: { skillType: words('Skill type', ['TECHNICAL', 'BEHAVIOURAL', 'SYSTEM', 'MACHINE', 'OTHER']) },
    db: { name: 'name', skillType: 'skill_type', description: 'description', status: 'status' },
  },
  qualifications: {
    label: 'Qualifications', one: 'qualification',
    columns: [text('name', 'Name', 250, 'The qualification.', 'ITI Fitter', { required: true }), pick('qualificationType', 'Qualification type', 'qualificationType', 'What kind it is.', 'EDUCATION'), text('description', 'Description', 4000, 'What it means here.', ''), status],
    lists: { qualificationType: words('Qualification type', ['EDUCATION', 'CERTIFICATION', 'LICENCE', 'OTHER']) },
    db: { name: 'name', qualificationType: 'qualification_type', description: 'description', status: 'status' },
  },
  authorities: {
    label: 'Authorities', one: 'authority',
    columns: [
      text('name', 'Name', 250, 'The authority.', 'Stop the line', { required: true }), pick('authorityType', 'Authority type', 'authorityType', 'What kind it is.', 'STOP'),
      text('description', 'What the holder may do', 4000, 'The authority, as a sentence.', 'May stop the line on a safety or quality doubt.', { required: true }), status,
    ],
    lists: { authorityType: words('Authority type', ['APPROVE', 'DECIDE', 'STOP', 'ISSUE', 'ESCALATE', 'FINANCIAL', 'OTHER']) },
    db: { name: 'name', authorityType: 'authority_type', description: 'description', status: 'status' },
  },
};

const clean = (v) => (v == null || String(v).trim() === '' ? null : String(v).trim());

export default Object.entries(LIBRARIES).map(([kind, lib]) => {
  const table = RC.MASTERS[kind].table;
  return {
    entity: `library-${kind}`,
    label: lib.label,
    fileLabel: `Library ${lib.label}`,
    area: 'roles',
    viewRight: PERM.roles.view,
    uploadRight: PERM.roles.upload,
    wholeCompany: true,
    intro: [`One row is one ${lib.one} of the company’s library. Roles pick from this list; which roles use an entry is on the Libraries screen.`],
    rules: ['An entry that roles use cannot be removed; set it INACTIVE to keep it out of pickers.'],
    list: { name: 'libraries', read: async (db, c) => (await RC.listMaster(db, c.companyId, kind)).items },

    async load(db, c) {
      const [rows] = await db.query(`SELECT * FROM ${table} WHERE company_id = ? AND deleted_at IS NULL ORDER BY name, id`, [c.companyId]);
      const current = new Map(rows.map((r) => [r.id, {
        id: r.id, seen: r.updated_at, label: `${r.code ? `${r.code} ` : ''}${r.name}`,
        cells: Object.fromEntries(Object.entries(lib.db).map(([key, column]) => [key, clean(r[column])])),
      }]));
      return { lists: { ...(lib.lists ?? {}), status: words('Status', STATUS) }, current };
    },

    columns: () => lib.columns,

    check(row) {
      if (row.isNew && row.values.status == null) row.values.status = 'ACTIVE';
    },

    async add(db, c, row) {
      const input = Object.fromEntries(Object.keys(lib.db).filter((k) => row.values[k] != null).map((k) => [k, row.values[k]]));
      const made = await RC.createMasterItem(db, c, kind, input);
      return { id: made.id, code: made.code ?? null };
    },

    async change(db, c, row) {
      const keys = changedKeys(row);
      const input = Object.fromEntries(Object.keys(lib.db).filter((k) => keys.has(k)).map((k) => [k, row.values[k]]));
      await RC.updateMasterItem(db, c, kind, row.id, input);
    },
  };
});
