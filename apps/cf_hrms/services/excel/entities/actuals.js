/**
 * Actuals in Excel (TM/CF_HRMS_HIRING_SPEC.md §19.3). One row per person × KPI × slot
 * of the chosen period — the slots that have begun.
 *
 *   info      Person · Position · Department · KRA · KPI · Unit · Target · Which way · Slot · Achievement · State
 *   editable  Value (a number) · Met (Met / Not met, for a target written as words) · Note
 *             · Reason for a correction (needed when a value already entered changes)
 *
 * A row is a KPI's slot, not a record of one table: its hidden id is
 * planKpiId × 1000 + the slot's number, and an upload loads just the KPIs the
 * file names (engine `idsFirst`). Rows cannot be added; uploading never removes
 * a value; a value once entered is corrected, never cleared.
 *
 * Writes go through actualsService.enterActuals — the one writer the grid uses —
 * all of a file's rows in ONE call, so an upload of 500 values is the same
 * handful of statements as one.
 */
import { PERM, words } from './_shared.js';
import { actualsGrid, narrowGrid, rowsForKpis, enterActuals } from '../../performance/actualsService.js';
import { DIRECTION_WORDS } from '../../performance/targets.js';

const SLOT_SPAN = 1000;
const idOf = (r) => r.kpiId * SLOT_SPAN + r.slotIndex;
const NEVER = new Date(0);
const MET_WORDS = { YES: 'Met', NO: 'Not met' };
const metOf = (text) => (text === 'Met' ? 'YES' : text === 'Not met' ? 'NO' : null);
const show = (v) => (v === null || v === undefined || v === '' ? '' : String(v));

export default {
  entity: 'actuals',
  label: 'Actuals',
  fileLabel: 'Actuals',
  area: 'performance',
  viewRight: PERM.performance.view,
  uploadRight: PERM.performance.upload,
  wholeCompany: false,
  idsFirst: true,
  maxChanges: 2000,
  intro: [
    'One row is one person’s KPI for one slot of the period: a KPI entered monthly in a quarterly plan has a row for each month that has begun; a KPI entered once has one row.',
    'Type the actual in Value — or, for a target written as words, choose Met or Not met. A Note is optional.',
    'Achievement is the slot on its own; the plan page shows the KPI over all its slots and the plan’s score.',
  ],
  rules: [
    'Rows cannot be added here. Every row the period has is already in the file: download a fresh one to get new slots.',
    'A value already entered is corrected, never removed: type the right value and fill in “Reason for a correction”. The earlier value is kept in its history.',
    'Only an active plan takes actuals. A closed period, a draft plan and a slot that has not begun are read only.',
  ],

  async load(db, c, env) {
    let rows;
    if (env.fileIds) {
      // An upload: just the KPIs the file names, every slot, wherever they are (a row outside the login's departments is a problem).
      rows = await rowsForKpis(db, c.companyId, [...new Set(env.fileIds.map((id) => Math.floor(id / SLOT_SPAN)))]);
      const ids = new Set(env.fileIds);
      rows = rows.filter((r) => ids.has(idOf(r)));
    } else {
      const scope = env.scope.all ? null : [...env.scope.departmentIds];
      const query = { ...(env.query ?? {}), slot: 'all' };
      const grid = await actualsGrid(db, c.companyId, query, { scopeDeptIds: scope, canEnter: true });
      rows = (await narrowGrid(db, c.companyId, grid, env.query ?? {})).rows;
    }
    const inScope = (r) => env.scope.all || (r.departmentId != null && env.scope.departmentIds.has(Number(r.departmentId)));
    const current = new Map(rows.map((r) => [idOf(r), {
      id: idOf(r),
      seen: r.actual?.at ?? NEVER,
      label: `${r.employeeName} — ${r.kpiName} — ${r.slotName}`,
      inScope: inScope(r),
      row: r,
      cells: {
        person: `${r.employeeCode ?? '#'} — ${r.employeeName}`,
        position: [r.positionCode, r.positionTitle].filter(Boolean).join(' — ') || null,
        department: r.departmentName ?? null,
        kra: r.kraName ?? null,
        kpi: r.kpiName,
        unit: r.unit ?? null,
        target: r.target,
        direction: DIRECTION_WORDS[r.direction] ?? r.direction,
        slot: r.slotName,
        achievement: r.achievement == null ? null : `${r.achievement}% · ${r.bandLabel}`,
        state: r.locked ?? (r.actual ? (r.actual.corrected ? 'Entered (corrected)' : 'Entered') : 'To enter'),
        value: r.direction === 'TEXT' ? null : r.actual?.value ?? null,
        met: r.direction === 'TEXT' ? MET_WORDS[r.actual?.met] ?? null : null,
        note: r.actual?.note ?? null,
        reason: null,
      },
    }]));
    return { lists: { met: words('Met / Not met', ['Met', 'Not met']) }, current };
  },

  columns: () => [
    { key: 'person', header: 'Person', kind: 'info', width: 28, meaning: 'Employee code and name.' },
    { key: 'position', header: 'Position', kind: 'info', width: 26, meaning: 'The position the plan was made for.' },
    { key: 'department', header: 'Department', kind: 'info', width: 22, meaning: 'Its department.' },
    { key: 'kra', header: 'KRA', kind: 'info', width: 24, meaning: 'The KRA heading the KPI is under (blank: under no KRA).' },
    { key: 'kpi', header: 'KPI', kind: 'info', width: 36, meaning: 'What is measured.' },
    { key: 'unit', header: 'Unit', kind: 'info', width: 10, meaning: 'The unit of the value.' },
    { key: 'target', header: 'Target', kind: 'info', width: 22, meaning: 'The target for the whole period.' },
    { key: 'direction', header: 'Which way', kind: 'info', width: 16, meaning: 'Higher is better, lower is better, exactly, or written as words (then: Met / Not met).' },
    { key: 'slot', header: 'Slot', kind: 'info', width: 14, meaning: 'The part of the period this row is for.' },
    { key: 'achievement', header: 'Achievement', kind: 'info', width: 18, meaning: 'When downloaded: this slot’s actual against the target.' },
    { key: 'state', header: 'State', kind: 'info', width: 22, meaning: 'To enter, entered, or why the row is read only.' },
    { key: 'value', header: 'Value', kind: 'number', whole: false, min: -1000000000000, max: 1000000000000, width: 14, meaning: 'The actual, as a number in the KPI’s unit. Leave blank for a target written as words.', example: '96.5' },
    { key: 'met', header: 'Met', kind: 'list', list: 'met', width: 12, meaning: 'For a target written as words only: Met or Not met.', example: 'Met' },
    { key: 'note', header: 'Note', kind: 'text', max: 1000, width: 32, meaning: 'Anything worth knowing about this actual. Optional.', example: 'Machine down two days' },
    { key: 'reason', header: 'Reason for a correction', kind: 'text', max: 500, width: 30, newOnly: true, meaning: 'Needed when you change a value or answer that was already entered: why it is corrected.', example: 'Count re-checked at the store' },
  ],

  labelOf: () => 'A new row',

  check(row) {
    if (row.isNew) {
      row.problems.push('Rows cannot be added here: every row is one person’s KPI for one slot, and the file already has them all. Download a fresh file to get new slots.');
      return;
    }
    const r = row.current.row;
    const cells = row.current.cells;
    const isText = r.direction === 'TEXT';
    const valueNow = row.values.value ?? null;
    const metNow = row.values.met ?? null;
    if (isText && valueNow != null) row.problems.push(`Value: ${r.kpiName} has a target written as words. Choose Met or Not met instead of a number.`);
    if (!isText && metNow != null) row.problems.push(`Met: ${r.kpiName} has a number target. Type the number in Value instead.`);
    if (row.problems.length) return;
    const valueChanged = isText ? show(metNow) !== show(cells.met) : show(valueNow) !== show(cells.value);
    const noteChanged = show(row.values.note) !== show(cells.note);
    if (!valueChanged && !noteChanged) return;
    if (r.locked) { row.problems.push(`${r.locked} Leave this row as it was.`); return; }
    const had = isText ? cells.met != null : cells.value != null;
    const has = isText ? metNow != null : valueNow != null;
    if (had && !has) { row.problems.push(`${isText ? 'Met' : 'Value'}: a value once entered is corrected, not removed. Type the right one, and say why in “Reason for a correction”.`); return; }
    if (!had && !has) { row.problems.push(`${isText ? 'Met' : 'Value'}: a note needs the actual beside it. ${isText ? 'Choose Met or Not met.' : 'Type the value.'}`); return; }
    if (had && valueChanged && !row.values.reason) row.problems.push(`Reason for a correction: ${r.kpiName} for ${r.slotName} already has ${isText ? `“${cells.met}”` : `the value ${cells.value}`}. Say why it is corrected.`);
  },

  // Each row is written in afterApply, all in one call to the one writer.
  async change() {},

  async afterApply(db, c, { changes }) {
    if (!changes.length) return;
    await enterActuals(db, c, changes.map((row) => {
      const r = row.current.row;
      const isText = r.direction === 'TEXT';
      return {
        row: row.row, planId: r.planId, kpiId: r.kpiId, slotStart: r.slotStart,
        ...(isText ? { met: metOf(row.values.met) } : { value: row.values.value }),
        note: row.values.note ?? '',
        reason: row.values.reason ?? null,
      };
    }), { source: 'EXCEL' });
  },
};
