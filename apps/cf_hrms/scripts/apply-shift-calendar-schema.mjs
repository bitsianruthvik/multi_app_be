/**
 * Shifts by weekday and holiday calendars (CF_HRMS_HIRING_SPEC.md §6): exactly
 * that change, on a database that already exists.
 *
 *   node apply-shift-calendar-schema.mjs                    DRY RUN on local — says what it would do
 *   node apply-shift-calendar-schema.mjs --apply
 *   node apply-shift-calendar-schema.mjs --apply --target=prod
 *
 * WHAT IT DOES, each step only if it is not already done:
 *   1. creates hrms_holiday_calendars and hrms_shift_days — the CREATE TABLE
 *      statements are read out of models/init.sql, never retyped here;
 *   2. adds hrms_shifts.holiday_calendar_id and .week_summary, and
 *      hrms_holidays.calendar_id, with their keys and foreign keys; replaces the
 *      holidays' unique key (a date once per company) by one per calendar. The
 *      same guarded changes as section 10d of init.sql, one per statement;
 *   3. THE ROWS, for every company:
 *        - a holiday with no calendar goes into its company's "Company
 *          holidays" calendar (created when the company has such holidays);
 *        - every shift gets its seven day rows: its own times on Monday to
 *          Saturday, Sunday off; a shift with no times gets Monday–Saturday
 *          working without hours. A weekday that already has a row is left
 *          alone, so an edit is never undone;
 *        - every shift's summary line (hrms_shifts.week_summary) is written
 *          from its days.
 *      No calendar is selected on any shift.
 *
 * Idempotent: a second run finds everything in place and changes nothing.
 * Dry run by default; local by default (scripts/dbTarget.mjs). The rows are
 * written in one transaction; the DDL cannot be (MySQL and TiDB commit it as it
 * runs), which is why every DDL step is guarded and safe to repeat.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import mysql from 'mysql2/promise';
import { resolveTarget, announce } from './dbTarget.mjs';
import { weekOf, summaryOf, defaultWeek } from '../services/shiftRead.js';

const APPLY = process.argv.includes('--apply');
const CALENDAR_NAME = 'Company holidays';
const sql = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../models/init.sql'), 'utf8');

/** A CREATE TABLE statement, as models/init.sql has it. */
function createOf(table) {
  const start = sql.indexOf(`CREATE TABLE IF NOT EXISTS ${table} (`);
  if (start < 0) throw new Error(`init.sql has no CREATE TABLE for ${table}`);
  const end = sql.indexOf(';', sql.indexOf('\n)', start));
  return sql.slice(start, end);
}

const target = resolveTarget();
announce(target);
const conn = await mysql.createConnection({ ...target.cfg, dateStrings: true });
const one = async (q, p = []) => Number((await conn.query(q, p))[0][0].n);
const say = (what, state) => console.log(`  ${what.padEnd(58)} ${state}`);

const tableThere = (t) => one('SELECT COUNT(*) n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', [t]);
const columnThere = (t, c) => one('SELECT COUNT(*) n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?', [t, c]);
const indexThere = (t, i) => one('SELECT COUNT(*) n FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?', [t, i]);
const constraintThere = (t, k) => one('SELECT COUNT(*) n FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_NAME = ?', [t, k]);

/** One guarded DDL step: `done()` says whether it is already in place. */
async function step(what, done, statement) {
  if (await done()) { say(what, 'already there'); return false; }
  if (!APPLY) { say(what, 'would be done'); return true; }
  await conn.query(statement);
  say(what, 'done');
  return true;
}

try {
  let pendingDdl = false;
  console.log('  schema');
  // The calendars table first: shifts and holidays point at it.
  for (const t of ['hrms_holiday_calendars', 'hrms_shift_days']) {
    pendingDdl = await step(`table ${t}`, () => tableThere(t), createOf(t)) || pendingDdl;
  }
  const ddl = [
    ['hrms_shifts.holiday_calendar_id', () => columnThere('hrms_shifts', 'holiday_calendar_id'),
      'ALTER TABLE hrms_shifts ADD COLUMN holiday_calendar_id INT NULL AFTER status'],
    ['hrms_shifts.week_summary', () => columnThere('hrms_shifts', 'week_summary'),
      'ALTER TABLE hrms_shifts ADD COLUMN week_summary VARCHAR(200) NULL AFTER holiday_calendar_id'],
    ['hrms_shifts key idx_hshf_calendar', () => indexThere('hrms_shifts', 'idx_hshf_calendar'),
      'ALTER TABLE hrms_shifts ADD KEY idx_hshf_calendar (company_id, holiday_calendar_id)'],
    ['hrms_shifts foreign key fk_hshf_calendar', () => constraintThere('hrms_shifts', 'fk_hshf_calendar'),
      'ALTER TABLE hrms_shifts ADD CONSTRAINT fk_hshf_calendar FOREIGN KEY (company_id, holiday_calendar_id) REFERENCES hrms_holiday_calendars(company_id, id)'],
    ['hrms_holidays.calendar_id', () => columnThere('hrms_holidays', 'calendar_id'),
      'ALTER TABLE hrms_holidays ADD COLUMN calendar_id INT NULL AFTER is_optional'],
    ['hrms_holidays unique key uq_hhol_calday (per calendar)', () => indexThere('hrms_holidays', 'uq_hhol_calday'),
      'ALTER TABLE hrms_holidays ADD UNIQUE KEY uq_hhol_calday (company_id, calendar_id, location_key, date_active)'],
    ['hrms_holidays foreign key fk_hhol_calendar', () => constraintThere('hrms_holidays', 'fk_hhol_calendar'),
      'ALTER TABLE hrms_holidays ADD CONSTRAINT fk_hhol_calendar FOREIGN KEY (company_id, calendar_id) REFERENCES hrms_holiday_calendars(company_id, id)'],
    // Last, once its replacement exists: the old key allowed a date once per company.
    ['hrms_holidays old unique key uq_hhol_day retired', async () => !(await indexThere('hrms_holidays', 'uq_hhol_day')),
      'ALTER TABLE hrms_holidays DROP INDEX uq_hhol_day'],
  ];
  for (const [what, done, statement] of ddl) pendingDdl = await step(what, done, statement) || pendingDdl;

  console.log('\n  rows');
  if (pendingDdl && !APPLY) {
    // The columns the row steps read do not exist yet on this database: say what they would do, from what does exist.
    const shifts = await one('SELECT COUNT(*) n FROM hrms_shifts WHERE deleted_at IS NULL');
    const holidays = await one('SELECT COUNT(*) n FROM hrms_holidays WHERE deleted_at IS NULL');
    say('shift days', `would give ${shifts} shift(s) their seven days (${shifts * 7} rows) and a summary line`);
    say('holidays without a calendar', holidays ? `would move ${holidays} into "${CALENDAR_NAME}"` : 'none');
  } else {
    await conn.beginTransaction();

    // ── holidays with no calendar -> their company's "Company holidays" ──
    const [orphans] = await conn.query('SELECT company_id, COUNT(*) AS n FROM hrms_holidays WHERE calendar_id IS NULL AND deleted_at IS NULL GROUP BY company_id');
    let moved = 0;
    for (const o of orphans) {
      let [[cal]] = await conn.query('SELECT id FROM hrms_holiday_calendars WHERE company_id = ? AND deleted_at IS NULL AND LOWER(name) = LOWER(?) ORDER BY id LIMIT 1', [o.company_id, CALENDAR_NAME]);
      if (!cal && APPLY) {
        const [r] = await conn.query("INSERT INTO hrms_holiday_calendars (company_id, name, description, status) VALUES (?, ?, 'Holidays entered before calendars existed.', 'ACTIVE')", [o.company_id, CALENDAR_NAME]);
        cal = { id: r.insertId };
      }
      if (APPLY) await conn.query('UPDATE hrms_holidays SET calendar_id = ? WHERE company_id = ? AND calendar_id IS NULL AND deleted_at IS NULL', [cal.id, o.company_id]);
      moved += Number(o.n);
    }
    say('holidays without a calendar', moved ? `${APPLY ? 'moved' : 'would move'} ${moved} into "${CALENDAR_NAME}" (${orphans.length} compan${orphans.length === 1 ? 'y' : 'ies'})` : 'none');

    // ── seven days per shift, and its summary line ──
    const [shifts] = await conn.query('SELECT id, company_id, code, start_time, end_time, week_summary FROM hrms_shifts WHERE deleted_at IS NULL ORDER BY company_id, id');
    const [dayRows] = await conn.query('SELECT shift_id, weekday, is_working, start_time, end_time, break_minutes FROM hrms_shift_days WHERE deleted_at IS NULL');
    const daysOf = new Map();
    for (const d of dayRows) daysOf.set(d.shift_id, [...(daysOf.get(d.shift_id) ?? []), d]);
    let addedDays = 0;
    let shiftsFilled = 0;
    let summaries = 0;
    for (const s of shifts) {
      const have = daysOf.get(s.id) ?? [];
      const present = new Set(have.map((d) => Number(d.weekday)));
      const missing = defaultWeek(s.start_time, s.end_time).filter((d) => !present.has(d.weekday));
      if (missing.length) {
        shiftsFilled += 1;
        addedDays += missing.length;
        if (APPLY) {
          for (const d of missing) {
            await conn.query(
              'INSERT INTO hrms_shift_days (company_id, shift_id, weekday, is_working, start_time, end_time, crosses_midnight, break_minutes) VALUES (?, ?, ?, ?, ?, ?, ?, 0)',
              [s.company_id, s.id, d.weekday, d.isWorking ? 1 : 0, d.startTime, d.endTime, d.crossesMidnight ? 1 : 0]);
          }
        }
      }
      // The line of the week as it stands (rows that exist, the default for the rest — which is what was just written).
      const summary = summaryOf(weekOf(have, s));
      if (s.week_summary !== summary) {
        summaries += 1;
        if (APPLY) await conn.query('UPDATE hrms_shifts SET week_summary = ? WHERE id = ?', [summary, s.id]);
      }
    }
    say(`shift days (${shifts.length} shifts, every company)`, addedDays ? `${APPLY ? 'added' : 'would add'} ${addedDays} day rows to ${shiftsFilled} shift(s)` : 'every shift has its seven days');
    say('shift summary lines', summaries ? `${APPLY ? 'wrote' : 'would write'} ${summaries}` : 'all in step');

    if (APPLY) await conn.commit(); else await conn.rollback();
    const short = APPLY ? await one('SELECT COUNT(*) n FROM hrms_shifts s WHERE s.deleted_at IS NULL AND (SELECT COUNT(*) FROM hrms_shift_days d WHERE d.shift_id = s.id AND d.deleted_at IS NULL) <> 7') : 0;
    if (short) throw new Error(`${short} shift(s) still do not have seven days`);
  }
  console.log(APPLY ? '\n  done.\n' : '\n  DRY RUN. Nothing written. Add --apply to write.\n');
} catch (e) {
  try { await conn.rollback(); } catch { /* the first error is the one that matters */ }
  console.error(`\n  FAILED: ${e.message}\n`);
  process.exitCode = 1;
} finally {
  await conn.end();
}
