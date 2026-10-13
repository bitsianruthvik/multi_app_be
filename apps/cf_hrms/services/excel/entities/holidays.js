/**
 * Holidays in Excel. Calendar★ · Date★ · Name★ · Optional.
 * Writes go through organisationService (one holiday per calendar per date).
 */
import { PERM, words, changedKeys, day, flag, yes } from './_shared.js';
import * as ORG from '../../organisationService.js';

export default {
  entity: 'holidays',
  label: 'Holidays',
  area: 'time',
  viewRight: PERM.time.view,
  uploadRight: PERM.time.upload,
  wholeCompany: true,
  intro: ['One row is one holiday in one calendar. A shift takes its holidays from the calendar it is given.'],
  rules: ['A holiday stays in its calendar. To move one, remove it on the Holidays screen and add it to the other calendar.'],
  list: { name: 'holidays', read: async (db, c, env) => (await ORG.listHolidays(db, c.companyId, { year: env.query?.year })).holidays },

  async load(db, c) {
    const [[rows], [calendars]] = await Promise.all([
      db.query('SELECT id, calendar_id, holiday_date, name, is_optional, updated_at FROM hrms_holidays WHERE company_id = ? AND deleted_at IS NULL ORDER BY holiday_date, id', [c.companyId]),
      db.query('SELECT id, name FROM hrms_holiday_calendars WHERE company_id = ? AND deleted_at IS NULL ORDER BY name', [c.companyId]),
    ]);
    const list = { label: 'Holiday calendars', entries: calendars.map((k) => ({ text: k.name, key: k.name, id: k.id })) };
    const nameOf = new Map(calendars.map((k) => [k.id, k.name]));
    const current = new Map(rows.map((h) => [h.id, {
      id: h.id, seen: h.updated_at, label: `${day(h.holiday_date)} ${h.name}`, calendarId: h.calendar_id,
      cells: { calendar: nameOf.get(h.calendar_id) ?? null, date: day(h.holiday_date), name: h.name, optional: flag(h.is_optional) },
    }]));
    return { lists: { calendars: list, yesno: words('Yes / No', ['Yes', 'No']) }, current };
  },

  columns: () => [
    { key: 'calendar', header: 'Calendar', kind: 'list', list: 'calendars', required: true, width: 28, meaning: 'The holiday calendar it belongs to.', example: 'Company holidays' },
    { key: 'date', header: 'Date', kind: 'date', required: true, meaning: 'The day of the holiday.', example: '2026-10-20' },
    { key: 'name', header: 'Name', kind: 'text', required: true, max: 200, width: 32, meaning: 'What the holiday is.', example: 'Diwali' },
    { key: 'optional', header: 'Optional', kind: 'yesno', meaning: 'Yes for a holiday a person may choose to take.', example: 'No' },
  ],
  labelOf: (row) => `${row.values.date ?? ''} ${row.values.name ?? ''}`.trim(),

  check(row) {
    row.calendarId = row.entries.calendar?.id ?? null;
    if (!row.isNew && row.calendarId != null && row.calendarId !== row.current.calendarId) {
      row.problems.push('Calendar: a holiday stays in its calendar. To move it, remove it on the Holidays screen and add it to the other calendar.');
    }
  },

  checkFile(rows, state) {
    // One holiday per calendar per date: within the file, and against the rest of the calendar.
    const taken = new Map();
    for (const h of state.current.values()) taken.set(`${h.calendarId}|${h.cells.date}`, h.id);
    const inFile = new Map();
    for (const r of rows) {
      if (r.calendarId == null || !r.values.date) continue;
      const k = `${r.calendarId}|${r.values.date}`;
      inFile.set(k, [...(inFile.get(k) ?? []), r]);
    }
    // Asked of a row this file adds or moves to another date; the holiday that was there first is not the problem.
    for (const r of rows) {
      if (r.calendarId == null || !r.values.date || !(r.isNew || r.changes.some((c) => c.key === 'date'))) continue;
      const k = `${r.calendarId}|${r.values.date}`;
      const holder = taken.get(k);
      const movedAway = holder != null && rows.some((x) => x.id === holder && x.values.date !== r.values.date);
      if (holder != null && holder !== r.id && !movedAway) r.problems.push(`Date: ${r.values.date} is already a holiday in the ${r.values.calendar} calendar.`);
      else if (inFile.get(k).filter((x) => x.isNew || x.changes.some((c) => c.key === 'date')).length > 1) r.problems.push(`Date: ${r.values.date} is in the file more than once for the ${r.values.calendar} calendar.`);
    }
  },

  async add(db, c, row) {
    const made = await ORG.createCalendarHoliday(db, c, row.calendarId, { date: row.values.date, name: row.values.name, isOptional: yes(row.values.optional) });
    return { id: made.id ?? made.holiday?.id ?? null, code: null };
  },

  async change(db, c, row) {
    const keys = changedKeys(row);
    const body = {};
    if (keys.has('date')) body.date = row.values.date;
    if (keys.has('name')) body.name = row.values.name;
    if (keys.has('optional')) body.isOptional = yes(row.values.optional);
    await ORG.updateHoliday(db, c, row.id, body);
  },
};
