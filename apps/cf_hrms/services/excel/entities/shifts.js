/**
 * Shifts in Excel. Code★ · Name★ · Holiday calendar · then, for Monday … Sunday: Working · Start · End · Break minutes.
 * A shift's code is typed (G, D, N) — it is not issued. Writes go through organisationService, which
 * checks the week: both times or neither, a break shorter than the day, seven days always.
 */
import { PERM, words, changedKeys, flag, yes } from './_shared.js';
import * as ORG from '../../organisationService.js';
import { weekOf, WEEKDAY_NAMES } from '../../shiftRead.js';

const DAYS = [1, 2, 3, 4, 5, 6, 7];
const k = (d, part) => `d${d}${part}`;

export default {
  entity: 'shifts',
  label: 'Shifts',
  area: 'time',
  viewRight: PERM.time.view,
  uploadRight: PERM.time.upload,
  wholeCompany: true,
  intro: [
    'One row is one shift, with its week: for each day, whether it is worked, from when to when, and the break.',
    'A working day with no Start and no End is a day with flexible hours. A day that is not worked needs no times.',
    'An End earlier than the Start means the shift runs past midnight (20:00 to 08:00).',
  ],
  list: { name: 'shifts', read: async (db, c) => (await ORG.listShifts(db, c.companyId)).shifts },

  async load(db, c) {
    const [[rows], [dayRows], [calendars]] = await Promise.all([
      db.query('SELECT id, code, name, start_time, end_time, holiday_calendar_id, status, updated_at FROM hrms_shifts WHERE company_id = ? AND deleted_at IS NULL ORDER BY id', [c.companyId]),
      db.query('SELECT shift_id, weekday, is_working, start_time, end_time, break_minutes, updated_at FROM hrms_shift_days WHERE company_id = ? AND deleted_at IS NULL', [c.companyId]),
      db.query('SELECT id, name FROM hrms_holiday_calendars WHERE company_id = ? AND deleted_at IS NULL ORDER BY name', [c.companyId]),
    ]);
    const nameOf = new Map(calendars.map((x) => [x.id, x.name]));
    const byShift = new Map();
    for (const d of dayRows) byShift.set(d.shift_id, [...(byShift.get(d.shift_id) ?? []), d]);
    const current = new Map(rows.map((s) => {
      const days = weekOf(byShift.get(s.id) ?? [], s);
      const cells = { code: s.code, name: s.name, calendar: nameOf.get(s.holiday_calendar_id) ?? null, status: s.status };
      for (const d of days) {
        cells[k(d.weekday, 'w')] = flag(d.isWorking);
        cells[k(d.weekday, 's')] = d.isWorking ? d.startTime : null;
        cells[k(d.weekday, 'e')] = d.isWorking ? d.endTime : null;
        cells[k(d.weekday, 'b')] = d.isWorking && d.breakMinutes ? d.breakMinutes : null;
      }
      // A day changed on the screen moves the day's row, not the shift's: the later of the two is what was seen.
      const seen = (byShift.get(s.id) ?? []).reduce((m, d) => (d.updated_at > m ? d.updated_at : m), s.updated_at);
      return [s.id, { id: s.id, seen, label: `${s.code} ${s.name}`, cells }];
    }));
    return {
      lists: { calendars: { label: 'Holiday calendars', entries: calendars.map((x) => ({ text: x.name, key: x.name, id: x.id })) }, status: words('Status', ['ACTIVE', 'INACTIVE']) },
      current,
    };
  },

  columns: () => [
    { key: 'code', header: 'Code', kind: 'text', required: true, max: 50, width: 10, meaning: 'A short code for the shift: letters and digits, no spaces.', example: 'D' },
    { key: 'name', header: 'Name', kind: 'text', required: true, max: 100, width: 20, meaning: 'What the shift is called.', example: 'Day' },
    { key: 'calendar', header: 'Holiday calendar', kind: 'list', list: 'calendars', width: 26, meaning: 'Whose holidays this shift takes. Blank = none.', example: 'Company holidays' },
    { key: 'status', header: 'Status', kind: 'list', list: 'status', width: 12, meaning: 'ACTIVE, or INACTIVE to keep it out of pickers.', example: 'ACTIVE' },
    ...DAYS.flatMap((d) => {
      const name = WEEKDAY_NAMES[d - 1];
      return [
        { key: k(d, 'w'), header: `${name} working`, kind: 'yesno', width: 11, meaning: `Is ${name} worked?`, example: d === 7 ? 'No' : 'Yes' },
        { key: k(d, 's'), header: `${name} start`, kind: 'time', width: 10, meaning: `When ${name} starts. Blank on a day off, or for flexible hours.`, example: '08:00' },
        { key: k(d, 'e'), header: `${name} end`, kind: 'time', width: 10, meaning: `When ${name} ends.`, example: '20:00' },
        { key: k(d, 'b'), header: `${name} break minutes`, kind: 'number', min: 0, max: 600, width: 10, meaning: 'Minutes of break in that day.', example: '30' },
      ];
    }),
  ],
  labelOf: (row) => `${row.values.code ?? ''} ${row.values.name ?? ''}`.trim(),

  check(row) {
    if (row.isNew && row.values.status == null) row.values.status = 'ACTIVE';
    if (row.values.code && !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(row.values.code)) row.problems.push('Code: letters, digits, "_", "-" or "." with no spaces (G, D, N).');
    row.days = DAYS.map((d) => {
      const working = yes(row.values[k(d, 'w')]);
      const name = WEEKDAY_NAMES[d - 1];
      const start = row.values[k(d, 's')] ?? null;
      const end = row.values[k(d, 'e')] ?? null;
      const brk = row.values[k(d, 'b')] ?? null;
      if (!working && (start || end || brk)) row.problems.push(`${name}: it is not a working day, so it has no start, end or break. Clear them, or set ${name} working to Yes.`);
      if (working && Boolean(start) !== Boolean(end)) row.problems.push(`${name}: give both a start and an end, or neither for flexible hours.`);
      return { weekday: d, isWorking: working, startTime: working ? start : null, endTime: working ? end : null, breakMinutes: working ? (brk ?? 0) : 0 };
    });
  },

  checkFile(rows, state) {
    const holder = new Map([...state.current.values()].map((s) => [String(s.cells.code).toLowerCase(), s.id]));
    const inFile = new Map();
    for (const r of rows) {
      const code = String(r.values.code ?? '').toLowerCase();
      if (!code) continue;
      inFile.set(code, [...(inFile.get(code) ?? []), r]);
      const other = holder.get(code);
      if (other != null && other !== r.id && !rows.some((x) => x.id === other && String(x.values.code ?? '').toLowerCase() !== code)) r.problems.push(`Code: the shift ${r.values.code} already exists.`);
    }
    for (const list of inFile.values()) if (list.length > 1) for (const r of list) r.problems.push(`Code: ${r.values.code} is in the file ${list.length} times.`);
  },

  async add(db, c, row) {
    const made = await ORG.createShift(db, c, { code: row.values.code, name: row.values.name, holidayCalendarId: row.entries.calendar?.id ?? null, status: row.values.status, days: row.days });
    return { id: made.id, code: made.code };
  },

  async change(db, c, row) {
    const keys = changedKeys(row);
    const body = {};
    if (keys.has('code')) body.code = row.values.code;
    if (keys.has('name')) body.name = row.values.name;
    if (keys.has('status')) body.status = row.values.status;
    if (keys.has('calendar')) body.holidayCalendarId = row.entries.calendar?.id ?? null;
    if ([...keys].some((x) => /^d[1-7][wseb]$/.test(x))) body.days = row.days;
    await ORG.updateShift(db, c, row.id, body);
  },
};
