/**
 * Leave balances in Excel (TM/CF_HRMS_HIRING_SPEC.md §22.5): HR's OPENING balances,
 * one row per person for one leave year.
 *
 *   info      Employee code · Name · Leave year · Leave policy
 *   editable  one "Opening — <leave type>" column per active leave type of the company
 *
 * A row is a person in a leave year: its hidden id is employeeId × 10000 + the year the
 * leave year starts in, and an upload loads just the people the file names (engine
 * `idsFirst`). The year of each person is the one of THEIR policy that starts in the
 * calendar year asked for (`?year=2026` or `?year=2026-27`), or the one today is in.
 *
 * Rows cannot be added. A blank cell is "no number from HR" — the balance is carried
 * from the year before by the rule. A number once entered is changed here, not cleared:
 * clearing is on the Leave balances screen (it needs leave remove). Every write goes
 * through requestService.setOpening, the same writer as PUT /leave/balances.
 */
import { PERM, inScope, todayText } from './_shared.js';
import { loadWorlds, setOpening } from '../../leave/requestService.js';
import { leaveYearOf, yearFromStart } from '../../leave/balance.js';

const SPAN = 10000;
const NEVER = new Date(0);
const show = (v) => (v === null || v === undefined || v === '' ? '' : String(v));
const keyOf = (typeId) => `t${typeId}`;

export default {
  entity: 'leave-balances',
  label: 'Leave balances',
  fileLabel: 'Leave balances',
  area: 'leave',
  viewRight: PERM.leave.view,
  // Entering an opening balance is changing leave (the area has no upload right of its own).
  uploadRight: PERM.leave.edit,
  wholeCompany: false,
  idsFirst: true,
  maxChanges: 2000,
  intro: [
    'One row is one person in one leave year. Type the opening balance of each leave type in its column: the days the person starts the year with.',
    'A blank cell means HR has entered nothing: the app carries what was left from the year before, by the policy’s rule.',
    'The balance a person sees is this opening, plus what the policy gives, minus what is taken and what is waiting for approval.',
  ],
  rules: [
    'Rows cannot be added here. Every person is already in the file: download a fresh one for people who joined since.',
    'A number once entered is changed, not cleared, here. To clear one, use the Leave balances screen.',
    'Days are numbers, with up to two decimals: 2, 1.5, 0.25. A negative number is a debt carried into the year.',
  ],

  async load(db, c, env) {
    const [types] = await db.query("SELECT id, code, name FROM hrms_leave_types WHERE company_id = ? AND deleted_at IS NULL AND status = 'ACTIVE' ORDER BY name, id", [c.companyId]);
    let pairs;
    if (env.fileIds) {
      pairs = env.fileIds.map((id) => ({ employeeId: Math.floor(id / SPAN), startYear: id % SPAN }));
    } else {
      const q = env.query ?? {};
      const where = ['company_id = ?', 'deleted_at IS NULL', "employment_status <> 'EXITED'"];
      const params = [c.companyId];
      if (q.q) { where.push('(full_name LIKE ? OR employee_code LIKE ?)'); const like = `%${String(q.q).trim().slice(0, 100)}%`; params.push(like, like); }
      const [emps] = await db.query(`SELECT id FROM hrms_employees WHERE ${where.join(' AND ')} ORDER BY full_name, id LIMIT 5000`, params);
      const startYear = /^\d{4}/.test(String(q.year ?? '')) ? Number(String(q.year).slice(0, 4)) : null;
      pairs = emps.map((e) => ({ employeeId: e.id, startYear }));
    }
    const worlds = await loadWorlds(db, c.companyId, pairs.map((p) => p.employeeId));
    const wantDept = env.fileIds ? null : (Number(env.query?.departmentId) || null);
    const today = todayText();
    const current = new Map();
    for (const p of pairs) {
      const w = worlds.get(p.employeeId);
      if (!w) continue;
      if (wantDept && w.seat?.departmentId !== wantDept) continue;
      const year = p.startYear ? yearFromStart(p.startYear, w.startsMonth) : leaveYearOf(today, w.startsMonth);
      const id = p.employeeId * SPAN + Number(year.from.slice(0, 4));
      if (env.fileIds && !env.fileIds.includes(id)) continue;
      let seen = NEVER;
      const cells = {
        code: w.employee.code ?? null,
        name: w.employee.name,
        year: year.key,
        policy: w.effective.policy?.name ?? 'No leave policy',
      };
      for (const t of types) {
        const o = w.openings.get(t.id)?.get(year.key) ?? null;
        cells[keyOf(t.id)] = o ? o.opening : null;
        if (o?.updatedAt && new Date(o.updatedAt) > seen) seen = new Date(o.updatedAt);
      }
      current.set(id, { id, seen, label: `${w.employee.code ?? '#'} — ${w.employee.name} — ${year.key}`, inScope: inScope(env, w.seat?.departmentId ?? null), world: w, year, cells });
    }
    return { lists: {}, current, types };
  },

  columns: (state) => [
    { key: 'code', header: 'Employee code', kind: 'info', width: 16, meaning: 'The person’s employee code.' },
    { key: 'name', header: 'Name', kind: 'info', width: 28, meaning: 'The person’s name.' },
    { key: 'year', header: 'Leave year', kind: 'info', width: 12, meaning: 'The leave year of the person’s policy these openings are for.' },
    { key: 'policy', header: 'Leave policy', kind: 'info', width: 24, meaning: 'The leave policy that applies to the person today.' },
    ...state.types.map((t) => ({
      key: keyOf(t.id), header: `Opening — ${t.name}`, kind: 'number', whole: false, min: -366, max: 366, width: 18,
      meaning: `HR’s opening balance of ${t.name} for this leave year, in days. Blank: carried from the year before by the rule.`, example: '2',
    })),
  ],

  labelOf: () => 'A new row',

  check(row, state) {
    if (row.isNew) {
      row.problems.push('Rows cannot be added here: every person is already in the file. Download a fresh file for people who joined since.');
      return;
    }
    for (const t of state.types) {
      const k = keyOf(t.id);
      if (!(k in row.values)) continue;
      const was = row.current.cells[k];
      const now = row.values[k];
      if (was != null && now == null) row.problems.push(`Opening — ${t.name}: a number once entered is changed, not cleared, here. Clear it on the Leave balances screen.`);
      else if (now != null && Math.abs(now * 100 - Math.round(now * 100)) > 1e-6) row.problems.push(`Opening — ${t.name}: use at most two decimals.`);
    }
  },

  async change(db, c, row, state, env) {
    const note = `From the Excel file ${String(env.run?.fileName ?? '').slice(0, 200)}`.trim();
    for (const t of state.types) {
      const k = keyOf(t.id);
      if (!(k in row.values) || show(row.values[k]) === show(row.current.cells[k])) continue;
      // eslint-disable-next-line no-await-in-loop -- one opening at a time, through the one writer
      await setOpening(db, c, {
        employeeId: row.current.world.employee.id, leaveTypeId: t.id, yearKey: row.current.year.key, opening: row.values[k], note, readBack: false,
      }, null, { source: 'EXCEL', world: row.current.world, typeKnown: true });
    }
  },
};
