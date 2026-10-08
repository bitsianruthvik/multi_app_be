/**
 * CF_HRMS: apply an edited organisation workbook back onto the database.
 *
 *   node org-apply-workbook.mjs --file=X.xlsx --company=karni                  DRY RUN (the default): prints the plan, writes nothing
 *   node org-apply-workbook.mjs --file=X.xlsx --company=karni --apply          actually write, in one transaction
 *   ... --delete-missing      rows missing from the workbook are removed (otherwise they are left alone)
 *   ... --allow-stale         apply even though the database has changed since the workbook was exported
 *   ... --again               apply a file that was already applied once
 *   ... --target=prod         opt in to production (local is the default, exactly as in dbTarget.mjs)
 *
 * THE SHAPE OF THE PROBLEM. The workbook is SEAT-shaped; the database is ROLE-and-ASSIGNMENT-shaped. org-template.mjs
 * renders the database into the workbook; this file reads the workbook back and compares it with THE SAME RENDERING of
 * the database as it is now (loadOrg), row by row, matched by the hidden Key. Whatever differs is a human edit. So the
 * comparison is only as honest as the export is faithful, and the first test of both is the identity round trip:
 * export, apply with no edits, and the plan must be empty.
 *
 * WHAT A ROW MEANS WHEN IT CHANGES (every one is a decision, written down so it can be argued with):
 *   Structure   title      -> position_title (the seat's display name). The ROLE keeps its title and its duties.
 *               parent     -> the old PRIMARY_MANAGER line is ENDED (yesterday) and a new one starts today. Dotted lines are untouched.
 *               count      -> sanctioned_headcount and, on a Day & night seat, both shifts' manpower requirement.
 *               shift      -> default shift; Day & night <-> one shift adds or ends the two per-shift requirements.
 *               Notes      -> not saved: it is generated text and the database has no place for a seat note. Reported.
 *   People      seat       -> the assignment is ENDED and a new one starts (a person who moved is two assignments, not one edited).
 *               name/code/joined -> the employee; a person in two seats has two rows and they must agree.
 *   Responsibilities       -> they belong to a ROLE. A new row lands on the role of the seat it names, which every seat of that
 *               role shares; the plan says how many. Editing the wording of a duty that other roles share makes a NEW wording
 *               for this role instead of changing theirs.
 *   Questions   -> open points. A removed one is DISMISSED, with a note, never erased.
 *
 * REMOVING. A row missing from the workbook is ambiguous (deleted, or the sheet was never filled in), so nothing is removed
 * unless --delete-missing is given, and a sheet with NO rows never removes anything. Even then nothing is erased: a seat is
 * CLOSED (it keeps its history and leaves the chart), a person's assignment is ENDED, a duty is retired, a question dismissed.
 * Only a machine is deleted, and only when nothing refers to it.
 *
 * SAFETY, in the order it is checked:
 *   1. the workbook's provenance names the company, database and schema version; a mismatch is REFUSED, never applied;
 *   2. the database must not have moved since the export (its fingerprint), unless --allow-stale;
 *   3. the same file is not applied twice (hrms_import_runs keeps its SHA-256), unless --again;
 *   4. after the writes, still inside the transaction, the workbook is compared with the database AGAIN and the plan must
 *      now be empty. If it is not, something was written wrongly (or could not be), and everything rolls back.
 *
 * REGRESSION TESTS: workbook-tests/run.mjs (one command; every apply is rehearsed and rolled back, so nothing is left behind).
 *
 * EXIT CODES: 0 fine (a dry run's plan printed, an apply done, or nothing to do) | 1 the workbook has problems to fix |
 *   2 refused (wrong company, database or version; stale; already applied; needs --create-only) | 3 the apply failed and was rolled back.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath, pathToFileURL } from 'url';
import ExcelJS from 'exceljs';
import mysql from 'mysql2/promise';
import { resolveTarget, announce } from './dbTarget.mjs';
import { loadOrg } from './org-template.mjs';
import {
  fingerprintOf, squeeze, seatLabel, machineKey, parseKey, DAY_AND_NIGHT, SHEET,
} from './lib/orgTemplateSheets.mjs';
import { readOrgWorkbook, SUPPORTED_SCHEMA_VERSIONS } from './lib/orgWorkbookReader.mjs';
import { isDayCode, isNightCode } from '../services/seatCount.js';
import * as positionSvc from '../services/positionService.js';
import * as assignmentSvc from '../services/assignmentService.js';
import * as peopleSvc from '../services/peopleService.js';
import * as roleSvc from '../services/roleContentService.js';
import * as orgSvc from '../services/organisationService.js';

// ------------------------------------------------------------------ small helpers ----
const norm = (s) => squeeze(s).toLowerCase();
/** The importer's rule for "the same duty": trimmed, lower-cased, whitespace-collapsed, trailing punctuation dropped. */
const normDuty = (s) => squeeze(s).toLowerCase().replace(/[\s.;,:]+$/, '');
const sameNumber = (a, b) => Math.abs(Number(a) - Number(b)) < 0.005;
const pad2 = (n) => String(n).padStart(2, '0');
const localDay = (d = new Date()) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const dayBefore = (iso) => { const d = new Date(`${iso}T00:00:00`); d.setDate(d.getDate() - 1); return localDay(d); };
const day = (v) => (v == null ? null : String(v).slice(0, 10));
const joinedText = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : null);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** KIND_OF in org-template.mjs, reversed: 'Machine' -> 'MACHINE'. */
const typeOfKind = (kind) => String(kind).toUpperCase();

const SOURCE_NOTE = 'Applied from the organisation workbook';

// ------------------------------------------------------------- the database, around the rows ----
/**
 * Everything the planner needs to know about the company that `loadOrg` does not carry: the masters a name in a cell
 * resolves against, the codes already taken, and the shifts by name. One round of SELECTs, nothing written.
 */
async function loadEnv(conn, companyId) {
  const q = async (sql, params = []) => (await conn.query(sql, params))[0];
  const shifts = await q("SELECT id, code, name FROM hrms_shifts WHERE company_id = ? AND deleted_at IS NULL AND status = 'ACTIVE' ORDER BY id", [companyId]);
  const roles = await q('SELECT id, title, status FROM hrms_roles WHERE company_id = ? AND deleted_at IS NULL', [companyId]);
  const departments = await q('SELECT id, name FROM hrms_departments WHERE company_id = ? AND deleted_at IS NULL ORDER BY id', [companyId]);
  const locations = await q('SELECT id, name FROM hrms_locations WHERE company_id = ? AND deleted_at IS NULL ORDER BY id', [companyId]);
  const employees = await q(
    `SELECT id, employee_code AS code, full_name AS name, employment_status AS status, date_of_joining AS joined
       FROM hrms_employees WHERE company_id = ? AND deleted_at IS NULL ORDER BY id`, [companyId]);
  const positionCodes = (await q('SELECT position_code AS code FROM hrms_positions WHERE company_id = ? AND deleted_at IS NULL', [companyId])).map((r) => r.code);
  const defs = await q(
    `SELECT d.id, d.name, d.description,
            (SELECT COUNT(DISTINCT a.role_id) FROM hrms_role_responsibility_assignments a
              WHERE a.company_id = d.company_id AND a.responsibility_definition_id = d.id AND a.deleted_at IS NULL) AS roles
       FROM hrms_responsibility_definitions d
      WHERE d.company_id = ? AND d.deleted_at IS NULL AND d.status = 'ACTIVE' ORDER BY d.id`, [companyId]);
  const [primary] = await q("SELECT id FROM hrms_reporting_relationship_types WHERE company_id = ? AND code = 'PRIMARY_MANAGER' AND deleted_at IS NULL", [companyId]);

  const env = {
    companyId, today: localDay(),
    shifts, shiftByName: new Map(shifts.map((s) => [norm(s.name), s])),
    dayShift: shifts.find((s) => isDayCode(s.code)) ?? null, nightShift: shifts.find((s) => isNightCode(s.code)) ?? null,
    roleByTitle: new Map(roles.map((r) => [norm(r.title), r])),
    departmentByName: new Map(departments.map((d) => [norm(d.name), d])),
    locationByName: new Map(locations.map((l) => [norm(l.name), l])),
    employees, positionCodes,
    defsByText: new Map(), defById: new Map(defs.map((d) => [d.id, d])),
    primaryTypeId: primary?.id ?? null,
  };
  for (const d of defs) {
    const key = normDuty(d.description || d.name);
    if (!env.defsByText.has(key)) env.defsByText.set(key, []);
    env.defsByText.get(key).push(d);
  }
  return env;
}

/** The nearest existing name within two edits, to say "did you mean" when a new department or location is typed. */
function nearest(name, existing) {
  const a = norm(name);
  let best = null;
  for (const e of existing) {
    const b = norm(e);
    if (Math.abs(a.length - b.length) > 2) continue;
    const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      let diag = prev[0];
      prev[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const up = prev[j];
        prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
        diag = up;
      }
    }
    if (prev[b.length] <= 2 && prev[b.length] > 0 && (!best || prev[b.length] < best.d)) best = { name: e, d: prev[b.length] };
  }
  return best?.name ?? null;
}

/** The next code in a series: 'P233' after 'P232', 'KP0014' after 'KP0013'. Falls back to `fallbackPrefix` + 1. */
function nextCode(codes, fallbackPrefix, fallbackWidth) {
  const tally = new Map();
  let max = 0;
  for (const c of codes) {
    const m = /^([A-Za-z]*)(\d+)$/.exec(String(c ?? '').trim());
    if (!m) continue;
    const t = tally.get(m[1]) ?? { n: 0, width: m[2].length, max: 0 };
    t.n++; t.width = Math.max(t.width, m[2].length); t.max = Math.max(t.max, Number(m[2]));
    tally.set(m[1], t);
  }
  let prefix = fallbackPrefix;
  let width = fallbackWidth;
  const top = [...tally].sort((a, b) => b[1].n - a[1].n)[0];
  if (top) { prefix = top[0]; width = top[1].width; max = top[1].max; }
  return (n) => `${prefix}${String(max + n).padStart(width, '0')}`;
}

// ======================================================================================= the plan ====
function newPlan() {
  return {
    departments: [], locations: [], roles: [],
    machines: { create: [], update: [], remove: [] },
    seats: { create: [], update: [], close: [] },
    people: { employeesCreate: [], employeesUpdate: [], assign: [], move: [], shift: [], end: [] },
    responsibilities: { add: [], retext: [], move: [], remove: [] },
    questions: { create: [], update: [], dismiss: [] },
    notices: [],   // understood, but not (or not fully) saved: { code, sheet, row, message }
    kept: { seats: [], people: [], responsibilities: [], machines: [], questions: [] }, // in the database, not in the workbook, left alone
    problems: [],  // { severity: 'error'|'warning', code, sheet, row, message }
  };
}

function makeContext(read, loaded, env, deleteMissing, exportLabels = null) {
  const { data } = loaded;
  const plan = newPlan();
  const X = {
    read, data, env, plan, deleteMissing,
    err: (code, sheet, row, message) => plan.problems.push({ severity: 'error', code, sheet, row: row ?? null, message }),
    warn: (code, sheet, row, message) => plan.problems.push({ severity: 'warning', code, sheet, row: row ?? null, message }),
    notice: (code, sheet, row, message) => plan.notices.push({ code, sheet, row: row ?? null, message }),
    dbSeat: new Map(data.seats.map((s) => [s.key, s])),
    dbSeatIndex: new Map(data.seats.map((s, i) => [s.key, i])),
    dbPeople: new Map(data.people.map((p) => [p.key, p])),
    dbResp: new Map(data.responsibilities.map((r) => [r.key, r])),
    dbMachine: new Map(data.machines.map((m) => [m.key, m])),
    dbQuestion: new Map(data.questions.map((q) => [q.key, q])),
    seatRefOf: [],            // workbook seat index -> 'pos:ID' | 'new:ROW' | 'lost:ROW'
    newSeat: new Map(),       // 'new:ROW' -> the plan.seats.create entry
    machineRefOf: new Map(),  // machineKey(name) -> 'wct:ID' | 'new:ROW' | 'lost:ROW'
    machineNameOf: new Map(), // 'wct:ID' | 'new:ROW' -> the name shown
    claimed: { seats: new Set(), people: new Set(), responsibilities: new Set(), machines: new Set(), questions: new Set() },
    ambiguous: new Map(), stale: new Map(),
  };
  // The label a seat had WHEN THE WORKBOOK WAS WRITTEN. Normally that is what the database says now; the re-check after
  // the writes passes the labels from before them, because the cells in the workbook still say what the export said.
  X.dbLabel = (key) => {
    if (exportLabels?.has(key)) return exportLabels.get(key);
    const i = X.dbSeatIndex.get(key);
    return i == null ? null : seatLabel(i, data.seats[i].title);
  };
  X.seatKeyOfIndex = (i) => (i == null ? null : data.seats[i].key);
  X.seatName = (ref) => {
    if (ref == null) return '(the top of the chart)';
    if (ref.startsWith('new:')) return `new seat "${X.newSeat.get(ref)?.title ?? ref}"`;
    return `"${X.dbSeat.get(ref)?.title ?? ref}"`;
  };
  /** The role a seat belongs to: { id, title } for an existing role, { id: null, title } for one that will be created. */
  X.roleOfSeat = (ref) => {
    if (ref.startsWith('new:')) { const n = X.newSeat.get(ref); return { id: n.roleId, title: n.roleTitle }; }
    const s = X.dbSeat.get(ref);
    return { id: s.roleId, title: s.roleTitle };
  };
  X.seatsOfRole = (role) => data.seats.filter((s) => (role.id != null ? s.roleId === role.id : false)).length
    + [...X.newSeat.values()].filter((n) => (role.id != null ? n.roleId === role.id : norm(n.roleTitle) === norm(role.title))).length;
  return X;
}

/**
 * Which seat a Seat cell names, as a ref ('pos:ID' or 'new:ROW').
 *
 * A row that already exists and whose cell still holds the exact label the export wrote for ITS seat has not been
 * touched, whatever Ref numbers have since slid under it: that is what makes inserting a row not break every
 * person, duty and question below it. Anything else is resolved against the workbook's CURRENT labels.
 */
function resolveSeat(X, w, dbSeatKey, { optional = false } = {}) {
  const text = squeeze(w.seatText);
  if (!text) {
    if (optional) return { ref: null, unchanged: dbSeatKey == null };
    X.err('SEAT_REQUIRED', w.sheet, w.row, `${w.sheet} row ${w.row} has no Seat.`);
    return null;
  }
  const reading = w.seat;
  if (dbSeatKey != null && w.keyState === 'ok') {
    const label = X.dbLabel(dbSeatKey);
    if (label && text === label) {
      if (reading?.ok && reading.how === 'label' && X.seatRefOf[reading.seat] !== dbSeatKey) {
        const k = `${w.sheet}|${text}`;
        if (!X.ambiguous.has(k)) X.ambiguous.set(k, { sheet: w.sheet, text, rows: [] });
        X.ambiguous.get(k).rows.push(w.row);
      }
      return { ref: dbSeatKey, unchanged: true };
    }
  }
  if (!reading?.ok) {
    const why = reading?.reason === 'AMBIGUOUS'
      ? `"${text}" could be ${reading.candidates.length} different seats. Pick the one you mean from the drop-down.`
      : `"${text}" is not a seat on Structure. Pick it from the drop-down (add the seat on Structure first if it is new).`;
    X.err(reading?.reason === 'AMBIGUOUS' ? 'AMBIGUOUS_SEAT' : 'SEAT_NOT_FOUND', w.sheet, w.row, `${w.sheet} row ${w.row}: seat ${why}`);
    return null;
  }
  const ref = X.seatRefOf[reading.seat];
  if (ref.startsWith('lost:')) {
    X.err('SEAT_NOT_FOUND', w.sheet, w.row, `${w.sheet} row ${w.row}: seat "${text}" is a Structure row whose Key is not in the database; fix that row first.`);
    return null;
  }
  if (reading.how === 'title') {
    const k = `${w.sheet}|${text}`;
    if (!X.stale.has(k)) X.stale.set(k, { sheet: w.sheet, text, rows: [] });
    X.stale.get(k).rows.push(w.row);
  }
  return { ref, unchanged: ref === dbSeatKey };
}

/** "22-28, 40" from row numbers: a long run of rows is one phrase, not seven warnings. */
function rowsText(rows) {
  const out = [];
  for (let i = 0; i < rows.length;) {
    let j = i;
    while (j + 1 < rows.length && rows[j + 1] === rows[j] + 1) j++;
    out.push(j > i ? `${rows[i]}-${rows[j]}` : `${rows[i]}`);
    i = j + 1;
  }
  return out.join(', ');
}
/** The two warnings a shifted Ref can cause, once per label instead of once per row. */
function flushSeatLabelWarnings(X) {
  for (const a of X.ambiguous.values()) {
    X.warn('AMBIGUOUS_SEAT_LABEL', a.sheet, a.rows[0],
      `${a.sheet} row${a.rows.length === 1 ? '' : 's'} ${rowsText(a.rows)}: the seat cell "${a.text}" is exactly what the export wrote, so ${a.rows.length === 1 ? 'the row was' : 'the rows were'} left in ${a.rows.length === 1 ? 'its' : 'their'} seat; `
      + 'but rows have been inserted or deleted above, and that label now also names a different seat. If you meant to move ' + (a.rows.length === 1 ? 'it' : 'them') + ', pick the seat again.');
  }
  for (const a of X.stale.values()) {
    X.warn('STALE_SEAT_LABEL', a.sheet, a.rows[0],
      `${a.sheet} row${a.rows.length === 1 ? '' : 's'} ${rowsText(a.rows)}: seat "${a.text}" no longer matches any Ref (rows were inserted or deleted), so it was matched by its title instead.`);
  }
}

function needDepartment(X, name, row) {
  if (!name) return;
  if (X.env.departmentByName.has(norm(name)) || X.plan.departments.some((d) => norm(d.name) === norm(name))) return;
  X.plan.departments.push({ name, row, similar: nearest(name, [...X.env.departmentByName.values()].map((d) => d.name)) });
}
function needLocation(X, name, row) {
  if (!name) return;
  if (X.env.locationByName.has(norm(name)) || X.plan.locations.some((l) => norm(l.name) === norm(name))) return;
  X.plan.locations.push({ name, row, similar: nearest(name, [...X.env.locationByName.values()].map((l) => l.name)) });
}
/** A shift name from a cell must be one the database has (or, on a seat, Day & night with both a day and a night shift). */
function checkShift(X, name, sheet, row, { seat = false } = {}) {
  if (!name) return true;
  if (name === DAY_AND_NIGHT) {
    if (!seat) { X.err('BAD_SHIFT', sheet, row, `${sheet} row ${row}: a person works one shift; "${DAY_AND_NIGHT}" is for seats.`); return false; }
    if (!X.env.dayShift || !X.env.nightShift) { X.err('NO_DAY_NIGHT_SHIFTS', sheet, row, `${sheet} row ${row}: ${DAY_AND_NIGHT} needs an active day shift and an active night shift (codes starting D and N) in this company.`); return false; }
    return true;
  }
  if (!X.env.shiftByName.has(norm(name))) { X.err('SHIFT_NOT_IN_DATABASE', sheet, row, `${sheet} row ${row}: the shift "${name}" is not an active shift in this company.`); return false; }
  return true;
}

// ================================================================================== machines ====
function planMachines(X) {
  const { read, plan, data } = X;
  for (const m of data.machines) X.machineNameOf.set(m.key, m.name);

  for (const w of read.machines) {
    if (!w.name) continue; // already an error from the reader
    if (w.keyState === 'ok') {
      const db = X.dbMachine.get(w.key);
      if (!db) {
        X.err('KEY_NOT_IN_DATABASE', w.sheet, w.row, `Machines & areas row ${w.row} ("${w.name}") has the key ${w.key}, which is not in the database any more (deleted elsewhere?). Clear its Key cell to add it again as new, or delete the row.`);
        X.machineRefOf.set(machineKey(w.name), `lost:${w.row}`);
        continue;
      }
      X.claimed.machines.add(w.key);
      X.machineRefOf.set(machineKey(w.name), w.key);
      X.machineNameOf.set(w.key, w.name);
      const set = {};
      if (w.name !== db.name) set.name = { from: db.name, to: w.name };
      if (w.kind && typeOfKind(w.kind) !== db.typeCode) set.kind = { from: db.kind, to: w.kind };
      if (w.where !== db.where) set.where = { from: db.where, to: w.where };
      if (set.name?.to.includes(',')) X.err('COMMA_IN_NAME', w.sheet, w.row, `Machines & areas row ${w.row}: a machine name cannot contain a comma (commas separate the machines on Structure).`);
      if (set.where) needLocation(X, w.where, w.row);
      if (Object.keys(set).length) plan.machines.update.push({ key: w.key, id: db.id, row: w.row, label: db.name, set });
    } else {
      const ref = `new:${w.row}`;
      X.machineRefOf.set(machineKey(w.name), ref);
      X.machineNameOf.set(ref, w.name);
      if (w.name.includes(',')) X.err('COMMA_IN_NAME', w.sheet, w.row, `Machines & areas row ${w.row}: a machine name cannot contain a comma (commas separate the machines on Structure).`);
      needLocation(X, w.where, w.row);
      plan.machines.create.push({ row: w.row, ref, name: w.name, kind: w.kind, where: w.where, copied: w.keyState === 'duplicate' });
    }
  }
  // a machine keeps its name unless the workbook renames it: two different machines may not end up with one name
  const finalOfDb = new Map(data.machines.map((m) => [m.key, plan.machines.update.find((u) => u.key === m.key)?.set.name?.to ?? m.name]));
  const seen = new Map();
  for (const [key, name] of finalOfDb) {
    if (seen.has(machineKey(name))) X.err('MACHINE_NAME_TAKEN', SHEET.machines, null, `Two machines would both be called "${name}" (${seen.get(machineKey(name))} and ${key}).`);
    seen.set(machineKey(name), key);
  }
  for (const c of plan.machines.create) {
    if (seen.has(machineKey(c.name))) X.err('MACHINE_NAME_TAKEN', SHEET.machines, c.row, `Machines & areas row ${c.row}: "${c.name}" is already the name of a machine (${seen.get(machineKey(c.name))}). A machine is named once; link it on Structure instead.`);
    seen.set(machineKey(c.name), c.ref);
  }

  const missing = data.machines.filter((m) => !X.claimed.machines.has(m.key));
  if (!read.machines.length) {
    if (missing.length) X.notice('SHEET_EMPTY', SHEET.machines, null, `${SHEET.machines} has no rows, so none of the ${missing.length} machines in the database were treated as missing.`);
    return;
  }
  plan.kept.machines = missing;
}

// ==================================================================================== seats ====
function planSeats(X) {
  const { read, data, plan, env } = X;
  const wb = read.seats;

  // identity first, so that a seat can be named as the parent of any seat below it
  wb.forEach((w, i) => {
    if (w.keyState === 'ok') {
      if (!X.dbSeat.has(w.key)) {
        X.err('KEY_NOT_IN_DATABASE', w.sheet, w.row, `Structure row ${w.row} ("${w.title}") has the key ${w.key}, which is not in the database any more (the seat was deleted or closed elsewhere). Clear its Key cell to add it again as a new seat, or delete the row.`);
        X.seatRefOf[i] = `lost:${w.row}`;
      } else { X.seatRefOf[i] = w.key; X.claimed.seats.add(w.key); }
    } else X.seatRefOf[i] = `new:${w.row}`;
  });
  const parentRef = (w) => (w.parent == null ? null : X.seatRefOf[w.parent]);
  const machineRefs = (names, row) => names.map((n) => {
    const ref = X.machineRefOf.get(machineKey(n));
    if (ref?.startsWith('lost:')) { X.err('KEY_NOT_IN_DATABASE', SHEET.structure, row, `Structure row ${row}: the machine "${n}" is on a Machines & areas row whose Key is not in the database; fix that row first.`); return null; }
    return ref;
  }).filter(Boolean);
  const dbParentKey = (s) => X.seatKeyOfIndex(s.parent);

  // new seats first (in row order, so a new seat's own parent is already known), then edits to existing ones
  wb.forEach((w, i) => {
    const ref = X.seatRefOf[i];
    if (!ref.startsWith('new:')) return;
    const roleDb = env.roleByTitle.get(norm(w.title)) ?? null;
    if (roleDb?.status === 'RETIRED') X.err('ROLE_RETIRED', w.sheet, w.row, `Structure row ${w.row}: the role "${roleDb.title}" is retired, so no new seat can be created in it. Reactivate the role, or choose another title.`);
    if (!roleDb && !plan.roles.some((r) => norm(r.title) === norm(w.title))) plan.roles.push({ title: w.title, row: w.row });
    if (w.count == null) X.err('COUNT_REQUIRED', w.sheet, w.row, `Structure row ${w.row} ("${w.title}") is a new seat and needs "How many people?".`);
    if (w.shift) checkShift(X, w.shift, w.sheet, w.row, { seat: true });
    else X.warn('SHIFT_EMPTY', w.sheet, w.row, `Structure row ${w.row} ("${w.title}") is a new seat with no Shift, so it will have no default shift.`);
    needDepartment(X, w.department, w.row);
    needLocation(X, w.location, w.row);
    const parent = parentRef(w);
    if (w.parent == null) X.warn('NEW_TOP_LEVEL_SEAT', w.sheet, w.row, `Structure row ${w.row} ("${w.title}") is a new seat at Level 1: it will have no manager. (Indent it under a seat if that is not what you meant.)`);
    if (w.notes) X.notice('NOTES_NOT_SAVED', w.sheet, w.row, `Structure row ${w.row} ("${w.title}"): Notes were not saved; the database has no place for a seat note.`);
    const entry = {
      row: w.row, ref, title: w.title, roleId: roleDb?.id ?? null, roleTitle: roleDb?.title ?? w.title,
      count: w.count, shift: w.shift, department: w.department, location: w.location,
      machines: machineRefs(w.machines, w.row), parent, copiedFrom: w.keyState === 'duplicate' ? w.key : null,
    };
    X.newSeat.set(ref, entry);
    plan.seats.create.push(entry);
  });

  wb.forEach((w, i) => {
    const ref = X.seatRefOf[i];
    if (ref.startsWith('new:') || ref.startsWith('lost:')) return;
    const db = X.dbSeat.get(ref);
    const set = {};
    if (w.title !== db.title) set.title = { from: db.title, to: w.title };
    if (w.count != null && !sameNumber(w.count, db.count)) set.count = { from: db.count, to: w.count };
    if (w.count == null) X.warn('COUNT_KEPT', w.sheet, w.row, `Structure row ${w.row} ("${w.title}"): "How many people?" was cleared, but a seat always has a headcount; ${db.count} was kept.`);
    if (w.shift && w.shift !== db.shift && checkShift(X, w.shift, w.sheet, w.row, { seat: true })) set.shift = { from: db.shift, to: w.shift };
    if (!w.shift && db.shift) X.warn('SHIFT_KEPT', w.sheet, w.row, `Structure row ${w.row} ("${w.title}"): Shift was cleared; "${db.shift}" was kept.`);
    if (w.department !== db.department) { set.department = { from: db.department, to: w.department }; needDepartment(X, w.department, w.row); }
    if (w.location !== db.location) { set.location = { from: db.location, to: w.location }; needLocation(X, w.location, w.row); }

    const wantMachines = new Set(machineRefs(w.machines, w.row));
    const haveMachines = new Set(db.contextLinks.map((l) => `wct:${l.contextId}`));
    const add = [...wantMachines].filter((m) => !haveMachines.has(m));
    const remove = [...haveMachines].filter((m) => !wantMachines.has(m));
    if (add.length || remove.length) set.machines = { add, remove };

    const from = dbParentKey(db);
    const to = parentRef(w);
    if (to != null && to.startsWith('lost:')) { /* the error is already raised on that row */ } else if (to !== from) set.parent = { from, to };

    if (w.notes !== db.notes) X.notice('NOTES_NOT_SAVED', w.sheet, w.row, `Structure row ${w.row} ("${w.title}"): Notes were changed but not saved; they are generated text (dotted lines, uneven shifts) and the database has no place for a seat note.`);
    if (Object.keys(set).length) plan.seats.update.push({ key: ref, id: db.positionId, row: w.row, label: db.title, set });
  });

  // ---- the order of seats under one manager is NOT stored: the database has none, and a chart lists siblings by position code ----
  const childrenOf = new Map();
  wb.forEach((w, i) => {
    const ref = X.seatRefOf[i];
    if (ref.startsWith('lost:')) return;
    const p = parentRef(w) ?? 'top';
    if (!childrenOf.has(p)) childrenOf.set(p, []);
    childrenOf.get(p).push({ ref, row: w.row, title: w.title });
  });
  const byCode = (a, b) => String(a.code ?? '').localeCompare(String(b.code ?? ''), 'en', { numeric: true, sensitivity: 'base' }) || a.positionId - b.positionId;
  for (const [parent, kids] of childrenOf) {
    const known = kids.filter((k) => !k.ref.startsWith('new:'));
    const here = known.map((k) => k.ref);
    const listed = known.map((k) => X.dbSeat.get(k.ref)).sort(byCode).map((s) => s.key);
    if (here.some((ref, i) => ref !== listed[i])) {
      X.notice('ORDER_NOT_SAVED', SHEET.structure, known[0].row, `The seats under ${parent === 'top' ? 'the top of the chart' : X.seatName(parent)} are in a different order here, but the order is not stored: the next export lists them in position-code order again.`);
    }
    kids.forEach((k, i) => {
      if (k.ref.startsWith('new:') && kids.slice(i + 1).some((x) => !x.ref.startsWith('new:'))) {
        X.notice('NEW_SEAT_LISTED_LAST', SHEET.structure, k.row, `Structure row ${k.row} ("${k.title}") sits before other seats under the same manager, but a new seat is listed last among them in the next export (the order is not stored).`);
      }
    });
  }

  // ---- the seats the workbook does not mention ----
  const missing = data.seats.filter((s) => !X.claimed.seats.has(s.key));
  if (!wb.length) {
    if (missing.length) X.notice('SHEET_EMPTY', SHEET.structure, null, `${SHEET.structure} has no rows, so none of the ${missing.length} seats in the database were treated as missing.`);
    return;
  }
  plan.kept.seats = missing;
  // a new row that is exactly an existing seat whose own row has gone is a damaged Key, not a new seat
  for (const c of plan.seats.create) {
    const look = missing.find((s) => norm(s.title) === norm(c.title) && dbParentKey(s) === c.parent);
    if (look) {
      X.err('LOOKS_LIKE_ERASED_KEY', SHEET.structure, c.row,
        `Structure row ${c.row} ("${c.title}") has no Key but is exactly the existing seat ${look.key} (same title, same manager), whose own row is not in the workbook. `
        + 'Either its Key was cleared (restore it from a fresh export), or you deleted the row and typed it again (then apply with --delete-missing to replace it, or change the title to keep both).');
    }
  }
}

// =================================================================================== people ====
function planPeople(X) {
  const { read, data, plan, env } = X;
  const proposals = new Map();      // employeeId -> { name, code, joined: {from,to,row}, rows: [] }
  const newEmployees = new Map();   // 'name|code' -> plan entry
  const seated = new Set(data.people.map((p) => `${p.employeeId}|${p.seatKey}`));
  const planned = new Set();        // employee|seat pairs this plan adds
  const propose = (employeeId, field, from, to, row, label) => {
    const p = proposals.get(employeeId) ?? { employeeId, label, rows: [], set: {} };
    proposals.set(employeeId, p);
    if (!p.rows.includes(row)) p.rows.push(row);
    if (p.set[field] && p.set[field].to !== to) {
      X.err('PERSON_ROWS_DISAGREE', SHEET.people, row, `People rows ${p.rows.join(' and ')} are the same person (${label}) but give different ${field}s ("${p.set[field].to}" and "${to}"). Make them agree.`);
    } else p.set[field] = { from, to };
  };

  for (const w of read.people) {
    let db = null;
    if (w.keyState === 'ok') {
      db = X.dbPeople.get(w.key);
      if (!db) {
        X.err('KEY_NOT_IN_DATABASE', w.sheet, w.row, `People row ${w.row} ("${w.name}") has the key ${w.key}, which is not in the database any more (the assignment was ended or deleted elsewhere). Clear its Key cell to add the person again as new, or delete the row.`);
        continue;
      }
      X.claimed.people.add(w.key);
    }
    const seat = resolveSeat(X, w, db?.seatKey);
    if (w.shift) checkShift(X, w.shift, w.sheet, w.row);

    if (db) {
      if (!w.name) continue;
      if (!seat) continue;
      if (w.name !== db.name) propose(db.employeeId, 'name', db.name, w.name, w.row, db.name);
      if (w.code && w.code !== db.code) propose(db.employeeId, 'code', db.code, w.code, w.row, db.name);
      if (!w.code && db.code) X.warn('CODE_KEPT', w.sheet, w.row, `People row ${w.row} ("${w.name}"): the employee code was cleared, but every person must have one; ${db.code} was kept.`);
      const was = joinedText(db.joined);
      if (w.joined && w.joined !== was) propose(db.employeeId, 'joined', was, w.joined, w.row, db.name);
      if (!w.joined && was) X.warn('JOINED_KEPT', w.sheet, w.row, `People row ${w.row} ("${w.name}"): the joining date was cleared, but every person must have one; ${was} was kept.`);
      if (w.shift && w.shift !== db.shift) plan.people.shift.push({ key: w.key, assignmentId: db.assignmentId, row: w.row, name: db.name, from: db.shift, to: w.shift });
      if (!w.shift && db.shift) X.warn('SHIFT_KEPT', w.sheet, w.row, `People row ${w.row} ("${w.name}"): Shift was cleared; "${db.shift}" was kept.`);
      if (!seat.unchanged && seat.ref !== db.seatKey) {
        plan.people.move.push({ key: w.key, assignmentId: db.assignmentId, employeeId: db.employeeId, row: w.row, name: db.name, from: db.seatKey, to: seat.ref, shift: w.shift || db.shift });
        seated.delete(`${db.employeeId}|${db.seatKey}`);
        planned.add(`${db.employeeId}|${seat.ref}`);
      }
      continue;
    }

    // ---- a new row: who is this? ----
    if (!w.name || !seat) continue;
    let emp = null;
    if (w.code) {
      emp = env.employees.find((e) => norm(e.code) === norm(w.code)) ?? null;
      if (emp && norm(emp.name) !== norm(w.name)) {
        X.err('CODE_BELONGS_TO_OTHER', w.sheet, w.row, `People row ${w.row}: the code ${w.code} belongs to ${emp.name}, not ${w.name}.`);
        continue;
      }
    } else {
      const same = env.employees.filter((e) => norm(e.name) === norm(w.name));
      if (same.length > 1) {
        X.err('AMBIGUOUS_PERSON', w.sheet, w.row, `People row ${w.row}: ${same.length} people are called "${w.name}" (${same.map((e) => e.code).join(', ')}). Give the Employee code of the one you mean.`);
        continue;
      }
      emp = same[0] ?? null;
    }
    if (emp?.status === 'EXITED') { X.err('PERSON_EXITED', w.sheet, w.row, `People row ${w.row}: ${emp.name} (${emp.code}) has exited, so cannot be put in a seat. Reactivate the person in the application first.`); continue; }

    let employee;
    if (emp) {
      employee = `emp:${emp.id}`;
      if (w.joined && w.joined !== day(emp.joined)) X.warn('JOINED_NOT_CHANGED', w.sheet, w.row, `People row ${w.row}: ${emp.name} already exists, so the Joined date on a new row was not applied. Change it on their existing row.`);
    } else {
      const k = `${norm(w.name)}|${norm(w.code)}`;
      let entry = newEmployees.get(k);
      if (!entry) {
        if (w.code && env.employees.some((e) => norm(e.code) === norm(w.code))) { X.err('CODE_TAKEN', w.sheet, w.row, `People row ${w.row}: the code ${w.code} is already used.`); continue; }
        entry = { ref: `newemp:${newEmployees.size + 1}`, name: w.name, code: w.code || null, joined: w.joined, rows: [] };
        newEmployees.set(k, entry);
        plan.people.employeesCreate.push(entry);
      }
      entry.rows.push(w.row);
      if (!entry.joined && w.joined) entry.joined = w.joined;
      employee = entry.ref;
    }
    const pair = `${emp ? emp.id : employee}|${seat.ref}`;
    if (seated.has(pair) || planned.has(pair)) {
      // A person and a seat are an identity: nobody sits in the same seat twice. A keyless row that names an assignment nobody
      // else has claimed IS that assignment (its Key was cleared), not a second one - and it must not count as missing either.
      const adopted = emp && data.people.find((p) => p.employeeId === emp.id && p.seatKey === seat.ref && !X.claimed.people.has(p.key));
      if (adopted) {
        X.claimed.people.add(adopted.key);
        X.notice('PERSON_MATCHED_BY_NAME', w.sheet, w.row, `People row ${w.row}: ${w.name} has no Key but is already in that seat, so the row was matched to the existing assignment (${adopted.key}) and nothing was added.`);
      } else {
        X.warn('PERSON_ALREADY_IN_SEAT', w.sheet, w.row, `People row ${w.row}: ${w.name} is already in that seat, so this row adds nothing.`);
      }
      continue;
    }
    planned.add(pair);
    plan.people.assign.push({ row: w.row, name: w.name, employee, seat: seat.ref, shift: w.shift, second: Boolean(emp && data.people.some((p) => p.employeeId === emp.id)) });
  }
  for (const p of proposals.values()) {
    const id = p.employeeId;
    const clash = p.set.code && env.employees.find((e) => e.id !== id && norm(e.code) === norm(p.set.code.to));
    if (clash) X.err('CODE_TAKEN', SHEET.people, p.rows[0], `People row ${p.rows[0]}: the code ${p.set.code.to} already belongs to ${clash.name}.`);
    plan.people.employeesUpdate.push({ employeeId: id, label: p.label, rows: p.rows, set: p.set });
  }

  const missing = data.people.filter((p) => !X.claimed.people.has(p.key));
  if (!read.people.length) {
    if (missing.length) X.notice('SHEET_EMPTY', SHEET.people, null, `${SHEET.people} has no rows, so none of the ${missing.length} people in the database were treated as missing.`);
    return;
  }
  plan.kept.people = missing;
  for (const c of plan.people.employeesCreate) {
    const look = missing.find((p) => norm(p.name) === norm(c.name));
    const row = plan.people.assign.find((a) => a.employee === c.ref);
    if (look && row && row.seat === look.seatKey) {
      X.err('LOOKS_LIKE_ERASED_KEY', SHEET.people, row.row, `People row ${row.row} ("${c.name}") has no Key but is exactly ${look.key}, whose own row is not in the workbook. Restore the Key from a fresh export, or apply with --delete-missing to replace it.`);
    }
  }
}

// =========================================================================== responsibilities ====
function planResponsibilities(X) {
  const { read, data, plan, env } = X;
  const roleKey = (role) => (role.id != null ? `role:${role.id}` : `rolenew:${norm(role.title)}`);
  const have = new Set(data.responsibilities.filter((r) => r.roleId != null).map((r) => `role:${r.roleId}|${normDuty(r.text)}`));
  const wanted = new Set();
  const listedOrder = new Map(); // roleId -> its existing duties, in the order the WORKBOOK lists them

  for (const w of read.responsibilities) {
    let db = null;
    if (w.keyState === 'ok') {
      db = X.dbResp.get(w.key);
      if (!db) {
        X.err('KEY_NOT_IN_DATABASE', w.sheet, w.row, `Responsibilities row ${w.row} has the key ${w.key}, which is not in the database any more (the duty was removed elsewhere). Clear its Key cell to add it again as new, or delete the row.`);
        continue;
      }
      X.claimed.responsibilities.add(w.key);
    }
    const seat = resolveSeat(X, w, db ? X.seatKeyOfIndex(db.seat) : undefined);
    if (!seat || !w.text) continue;
    const role = X.roleOfSeat(seat.ref);
    const sharedBy = X.seatsOfRole(role);

    if (db) {
      const textChanged = w.text !== db.text;
      if (db.overrideId != null) {
        if (!seat.unchanged || textChanged) X.err('OVERRIDE_EDIT_UNSUPPORTED', w.sheet, w.row, `Responsibilities row ${w.row} is a duty added to one seat only. Change it in the application; here it can only be left alone or removed.`);
        continue;
      }
      const roleChanged = role.id !== db.roleId;
      if (!roleChanged) {
        if (!listedOrder.has(db.roleId)) listedOrder.set(db.roleId, []);
        listedOrder.get(db.roleId).push({ key: w.key, sequence: db.sequence, rowId: db.rowId, row: w.row });
      }
      if (!roleChanged && !textChanged) { wanted.add(`${roleKey(role)}|${normDuty(w.text)}`); continue; }
      const def = env.defById.get(db.defId);
      if (roleChanged) {
        plan.responsibilities.move.push({
          key: w.key, row: w.row, rowId: db.rowId, defId: db.defId, fromRole: db.roleId, fromTitle: data.seats.find((s) => s.roleId === db.roleId)?.roleTitle ?? `role ${db.roleId}`,
          toRole: role, text: w.text, textChanged, sequence: db.sequence, sharedBy: X.seatsOfRole({ id: db.roleId }), toShared: sharedBy,
        });
      } else {
        plan.responsibilities.retext.push({
          key: w.key, row: w.row, roleId: db.roleId, roleTitle: role.title, defId: db.defId, rowId: db.rowId, sequence: db.sequence,
          from: db.text, text: w.text, defShared: Number(def?.roles ?? 1) > 1, sharedBy,
        });
      }
      wanted.add(`${roleKey(role)}|${normDuty(w.text)}`);
      continue;
    }

    // ---- a new row: the duty goes on the ROLE of the seat it names ----
    const k = `${roleKey(role)}|${normDuty(w.text)}`;
    if (have.has(k) || wanted.has(k)) {
      X.notice('DUTY_ALREADY_THERE', w.sheet, w.row, `Responsibilities row ${w.row}: this duty is already on the role "${role.title}", so nothing was added.`);
      continue;
    }
    wanted.add(k);
    const existing = (env.defsByText.get(normDuty(w.text)) ?? [])[0] ?? null;
    plan.responsibilities.add.push({ row: w.row, role, seat: seat.ref, text: w.text, defId: existing?.id ?? null, sharedBy, copied: w.keyState === 'duplicate' });
  }

  // the order of a role's duties is its JD order, and the workbook cannot set it: say so rather than let a re-sort pass unnoticed
  for (const [roleId, rows] of listedOrder) {
    const stored = [...rows].sort((a, b) => a.sequence - b.sequence || a.rowId - b.rowId).map((r) => r.key);
    if (rows.some((r, i) => r.key !== stored[i])) {
      X.notice('DUTY_ORDER_NOT_SAVED', SHEET.responsibilities, rows[0].row,
        `The duties of the role "${data.seats.find((s) => s.roleId === roleId)?.roleTitle}" are in a different order here, but their order is not saved: the next export lists them in the role's own order again.`);
    }
  }

  const missing = data.responsibilities.filter((r) => !X.claimed.responsibilities.has(r.key));
  if (!read.responsibilities.length) {
    if (missing.length) X.notice('SHEET_EMPTY', SHEET.responsibilities, null, `${SHEET.responsibilities} has no rows, so none of the ${missing.length} duties in the database were treated as missing.`);
    return;
  }
  plan.kept.responsibilities = missing;
}

// ============================================================================== questions ====
function planQuestions(X) {
  const { read, data, plan } = X;
  for (const w of read.questions) {
    let db = null;
    if (w.keyState === 'ok') {
      db = X.dbQuestion.get(w.key);
      if (!db) {
        X.err('KEY_NOT_IN_DATABASE', w.sheet, w.row, `Questions & doubts row ${w.row} has the key ${w.key}, which is not in the database any more (it was answered or removed elsewhere). Clear its Key cell to add it again as new, or delete the row.`);
        continue;
      }
      X.claimed.questions.add(w.key);
    }
    const seat = resolveSeat(X, w, db ? X.seatKeyOfIndex(db.seat) : undefined, { optional: true });
    if (!seat || !w.text) continue;
    if (db) {
      const set = {};
      if (w.text !== db.text) set.text = { from: db.text, to: db.prefix && w.text.startsWith(db.prefix) ? w.text.slice(db.prefix.length) : w.text };
      if (!seat.unchanged) set.about = { from: X.seatKeyOfIndex(db.seat), to: seat.ref };
      if (Object.keys(set).length) plan.questions.update.push({ key: w.key, id: db.id, row: w.row, label: db.rawText, set });
    } else {
      plan.questions.create.push({ row: w.row, about: seat.ref, text: w.text, copied: w.keyState === 'duplicate' });
    }
  }
  const missing = data.questions.filter((q) => !X.claimed.questions.has(q.key));
  if (!read.questions.length) {
    if (missing.length) X.notice('SHEET_EMPTY', SHEET.questions, null, `${SHEET.questions} has no rows, so none of the ${missing.length} questions in the database were treated as missing.`);
    return;
  }
  plan.kept.questions = missing;
  for (const c of plan.questions.create) {
    const look = missing.find((q) => norm(q.rawText) === norm(c.text) || norm(q.text) === norm(c.text));
    if (look) X.err('LOOKS_LIKE_ERASED_KEY', SHEET.questions, c.row, `Questions & doubts row ${c.row} has no Key but is exactly the open question ${look.key}, whose own row is not in the workbook. Restore its Key from a fresh export, or apply with --delete-missing to replace it.`);
  }
}

// ================================================================================== removals ====
/** With --delete-missing: turn "missing" into the removals, and check each is possible. Nothing is erased: see the header. */
function planRemovals(X) {
  const { plan, data } = X;
  if (!X.deleteMissing) return;

  for (const p of plan.kept.people) {
    plan.people.end.push({ key: p.key, assignmentId: p.assignmentId, employeeId: p.employeeId, name: p.name, seat: p.seatKey, label: `${p.name} in ${X.seatName(p.seatKey)}` });
  }
  for (const r of plan.kept.responsibilities) {
    plan.responsibilities.remove.push({
      key: r.key, rowId: r.rowId, overrideId: r.overrideId ?? null, roleId: r.roleId ?? null, positionId: r.positionId ?? null, text: r.text,
      roleTitle: data.seats.find((s) => s.roleId === r.roleId)?.roleTitle ?? null,
      sharedBy: r.roleId != null ? data.seats.filter((s) => s.roleId === r.roleId).length : 1,
    });
  }
  for (const q of plan.kept.questions) plan.questions.dismiss.push({ key: q.key, id: q.id, text: q.rawText });

  // seats: closed, but never while someone still sits in one
  const leaving = new Set(plan.people.end.map((e) => e.key));
  for (const m of plan.people.move) leaving.add(m.key);
  for (const s of plan.kept.seats) {
    const stay = data.people.filter((p) => p.seatKey === s.key && !leaving.has(p.key));
    const arriving = [...plan.people.assign.filter((a) => a.seat === s.key), ...plan.people.move.filter((m) => m.to === s.key)];
    if (stay.length) X.err('SEAT_STILL_OCCUPIED', SHEET.structure, null, `The seat "${s.title}" (${s.key}) is missing from Structure but ${stay.map((p) => p.name).join(', ')} still sit${stay.length === 1 ? 's' : ''} in it on People. Remove or move ${stay.length === 1 ? 'their row' : 'their rows'} as well.`);
    if (arriving.length) X.err('SEAT_STILL_WANTED', SHEET.structure, null, `The seat "${s.title}" (${s.key}) is missing from Structure but People puts ${arriving.map((a) => a.name).join(', ')} in it.`);
    const kids = data.seats.filter((c) => c.parentPositionId === s.positionId && X.claimed.seats.has(c.key));
    plan.seats.close.push({ key: s.key, id: s.positionId, title: s.title, reports: kids.length });
  }
  // Closing a seat changes what an export shows for the rows that hang off it: a role with no seat left shows no duties,
  // and a question about a closed seat is listed as a general one. Nothing is lost - say so, rather than let it surprise.
  const closing = new Set(plan.seats.close.map((s) => s.key));
  const { orphanedRoles, closedLabels } = orphansOf(data, closing, X);
  for (const roleId of orphanedRoles) {
    const n = data.responsibilities.filter((r) => r.roleId === roleId).length;
    if (n) X.notice('ROLE_LEFT_WITHOUT_SEAT', SHEET.responsibilities, null, `The role "${data.seats.find((s) => s.roleId === roleId).roleTitle}" loses its last seat. Its ${plural(n, 'duty', 'duties')} stay on the role (a new seat with that title gets them back) but will not appear in the next export.`);
  }
  const aboutClosed = data.questions.filter((q) => q.seat != null && closing.has(data.seats[q.seat].key));
  if (aboutClosed.length) X.notice('QUESTIONS_ABOUT_CLOSED_SEAT', SHEET.questions, null, `${plural(aboutClosed.length, 'open question')} about a closing seat stay open and will be listed as general questions in the next export.`);
  // machines: only when nothing refers to them (after the plan's own changes)
  const unlinked = new Map(); // ref -> number of seat links the plan removes
  for (const u of plan.seats.update) for (const ref of u.set.machines?.remove ?? []) unlinked.set(ref, (unlinked.get(ref) ?? 0) + 1);
  for (const m of plan.kept.machines) {
    const links = data.seats.filter((s) => s.contextLinks.some((l) => l.contextId === m.id)).length - (unlinked.get(m.key) ?? 0);
    plan.machines.remove.push({ key: m.key, id: m.id, name: m.name, stillLinked: Math.max(0, links) });
    if (links > 0) X.err('MACHINE_IN_USE', SHEET.machines, null, `The machine "${m.name}" is missing from Machines & areas but ${plural(links, 'seat')} still list${links === 1 ? 's' : ''} it (seats that are not in the workbook, or whose rows still name it).`);
  }
}

/** Roles whose every seat is closing, and the export labels of the seats that close. */
function orphansOf(data, closing, X) {
  const orphanedRoles = new Set();
  for (const s of data.seats) {
    if (closing.has(s.key) && data.seats.filter((x) => x.roleId === s.roleId).every((x) => closing.has(x.key))) orphanedRoles.add(s.roleId);
  }
  const closedLabels = new Set([...closing].map((k) => X.dbLabel(k)));
  return { orphanedRoles, closedLabels };
}
export { orphansOf, makeContext };

// =================================================================================== counts ====
function countsOf(plan) {
  const u = plan.seats.update;
  const has = (list, field) => list.filter((x) => x.set?.[field]).length;
  return {
    departmentsCreated: plan.departments.length,
    locationsCreated: plan.locations.length,
    rolesCreated: plan.roles.length,
    machinesCreated: plan.machines.create.length,
    machinesRenamed: has(plan.machines.update, 'name'),
    machinesKindChanged: has(plan.machines.update, 'kind'),
    machinesMoved: has(plan.machines.update, 'where'),
    machinesDeleted: plan.machines.remove.length,
    seatsCreated: plan.seats.create.length,
    seatsRetitled: has(u, 'title'),
    headcountsChanged: has(u, 'count'),
    seatShiftsChanged: has(u, 'shift'),
    seatDepartmentsChanged: has(u, 'department'),
    seatLocationsChanged: has(u, 'location'),
    seatMachinesChanged: has(u, 'machines'),
    seatsMovedToNewManager: has(u, 'parent'),
    seatsClosed: plan.seats.close.length,
    peopleAdded: plan.people.employeesCreate.length,
    peopleSeatedAgain: plan.people.assign.filter((a) => !a.employee.startsWith('newemp:')).length,
    peopleMovedToAnotherSeat: plan.people.move.length,
    peopleChanged: plan.people.employeesUpdate.length,
    peopleShiftChanged: plan.people.shift.length,
    peopleEnded: plan.people.end.length,
    responsibilitiesAdded: plan.responsibilities.add.length,
    responsibilitiesReworded: plan.responsibilities.retext.length,
    responsibilitiesMoved: plan.responsibilities.move.length,
    responsibilitiesRemoved: plan.responsibilities.remove.length,
    questionsAdded: plan.questions.create.length,
    questionsChanged: plan.questions.update.length,
    questionsDismissed: plan.questions.dismiss.length,
  };
}

/**
 * Compare a read workbook with the database as it is now. PURE: no writes, no clock but env.today.
 *
 * @param {{read: object, loaded: {data: object}, env: object, deleteMissing?: boolean}} args
 * @returns the plan (see newPlan), with plan.counts and plan.empty
 */
export function planChanges({ read, loaded, env, deleteMissing = false, exportLabels = null }) {
  const X = makeContext(read, loaded, env, deleteMissing, exportLabels);
  planMachines(X);
  planSeats(X);
  planPeople(X);
  planResponsibilities(X);
  planQuestions(X);
  planRemovals(X);
  flushSeatLabelWarnings(X);
  X.plan.counts = countsOf(X.plan);
  X.plan.empty = Object.values(X.plan.counts).every((n) => n === 0);
  return X.plan;
}

// ================================================================================ the writes ====
const shortName = (text) => (text.length > 250 ? `${text.slice(0, 249)}…` : text);

/**
 * Carry out a plan on `conn`, which the CALLER has already put inside a transaction (and will commit or roll back).
 *
 * Writes go through the application's own services wherever one exists (create/end an assignment, add a reporting line,
 * assign a duty to a role, create an employee ...) so every rule the application enforces is enforced here too, and each
 * of those services writes its own audit row. Where no service exists (a position row, a manpower requirement, an open
 * point) the SQL is here, with its audit row written beside it. Every audit row this file writes carries `requestId`, so
 * one apply can be traced as one act.
 *
 * ORDER MATTERS, and is the reason this is one function: masters first (a department a seat names must exist before
 * the seat), then roles, machines, seats, the chart's reporting lines (ALL the moved seats are detached before any is
 * attached, so a swap of two seats never trips the cycle check), then people, duties and questions, and removals last.
 *
 * @returns {{created: Record<string,string>, log: string[]}}  `created` maps 'structure:12' -> 'pos:77' for every row that
 *   was new, which is how the caller can re-check the plan against the keys those rows now have.
 */
export async function executePlan({ conn, plan, loaded, env, requestId }) {
  const { data } = loaded;
  const companyId = env.companyId;
  const c = { companyId, userId: null };
  const today = env.today;
  const yesterday = dayBefore(today);
  const created = {};
  const log = [];
  const say = (m) => log.push(m);

  const audit = (entityType, entityId, action, before, after) => conn.query(
    `INSERT INTO hrms_audit_log (company_id, actor_user_id, entity_type, entity_id, action, before_json, after_json, request_id, created_by)
     VALUES (?, NULL, ?, ?, ?, ?, ?, ?, NULL)`,
    [companyId, entityType, entityId, action, before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null, requestId],
  );
  const one = async (sql, params) => (await conn.query(sql, params))[0][0] ?? null;

  // ---- ids by ref: what exists now, to which the rows we create are added as we go ----
  const dept = new Map([...env.departmentByName].map(([k, v]) => [k, v.id]));
  const loc = new Map([...env.locationByName].map(([k, v]) => [k, v.id]));
  const role = new Map([...env.roleByTitle].map(([k, v]) => [k, v.id]));
  const machine = new Map(data.machines.map((m) => [m.key, m.id]));
  const seat = new Map(data.seats.map((s) => [s.key, s.positionId]));
  const seatRole = new Map(data.seats.map((s) => [s.key, s.roleId]));
  const employee = new Map(env.employees.map((e) => [`emp:${e.id}`, e.id]));
  const seatTitle = new Map(data.seats.map((s) => [s.key, s.title]));
  const shiftId = (name) => (name ? env.shiftByName.get(norm(name))?.id ?? null : null);

  // ---------------------------------------------------------------- masters ----
  for (const d of plan.departments) {
    const row = await orgSvc.createDepartment(conn, c, { name: d.name });
    dept.set(norm(d.name), row.id);
    say(`department created: ${d.name}`);
  }
  for (const l of plan.locations) {
    const row = await orgSvc.createLocation(conn, c, { name: l.name, locationType: 'PLANT' });
    loc.set(norm(l.name), row.id);
    say(`location created: ${l.name}`);
  }
  for (const r of plan.roles) {
    const row = await roleSvc.createRole(conn, c, { title: r.title, status: 'ACTIVE' });
    role.set(norm(r.title), row.id);
    say(`role created: ${r.title}`);
  }

  // --------------------------------------------------------------- machines ----
  for (const m of plan.machines.create) {
    const row = await orgSvc.createWorkContext(conn, c, { name: m.name, contextType: typeOfKind(m.kind), locationId: m.where ? loc.get(norm(m.where)) : null });
    machine.set(m.ref, row.id);
    created[`machines:${m.row}`] = `wct:${row.id}`;
    say(`machine created: ${m.name}`);
  }
  for (const u of plan.machines.update) {
    const body = {};
    if (u.set.name) body.name = u.set.name.to;
    if (u.set.kind) body.contextType = typeOfKind(u.set.kind.to);
    if (u.set.where) body.locationId = u.set.where.to ? loc.get(norm(u.set.where.to)) : null;
    await orgSvc.updateWorkContext(conn, c, u.id, body);
    say(`machine updated: ${u.label}`);
  }

  // ------------------------------------------------------------------ seats ----
  const nextPositionCode = nextCode(env.positionCodes, 'P', 3);
  let codeN = 0;
  const addManpower = async (positionId, roleId, count) => {
    for (const s of [env.dayShift, env.nightShift]) {
      const [res] = await conn.query(
        `INSERT INTO hrms_manpower_requirements (company_id, role_id, position_id, shift_id, required_count, effective_from, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?)`, [companyId, roleId, positionId, s.id, count, today, SOURCE_NOTE]);
      await audit('hrms_manpower_requirements', res.insertId, 'CREATE', null, { positionId, shiftId: s.id, requiredCount: count });
    }
  };
  const endManpower = async (rows) => {
    for (const m of rows) {
      const cur = await one('SELECT effective_from FROM hrms_manpower_requirements WHERE company_id = ? AND id = ?', [companyId, m.id]);
      if (cur && day(cur.effective_from) > yesterday) await conn.query('UPDATE hrms_manpower_requirements SET deleted_at = NOW() WHERE company_id = ? AND id = ?', [companyId, m.id]);
      else await conn.query('UPDATE hrms_manpower_requirements SET effective_to = ? WHERE company_id = ? AND id = ?', [yesterday, companyId, m.id]);
      await audit('hrms_manpower_requirements', m.id, 'UPDATE', { shift: m.shiftCode, requiredCount: m.count }, { endedOn: yesterday });
    }
  };

  for (const n of plan.seats.create) {
    const roleId = n.roleId ?? role.get(norm(n.roleTitle));
    const dn = n.shift === DAY_AND_NIGHT;
    const code = nextPositionCode(++codeN);
    const [res] = await conn.query(
      `INSERT INTO hrms_positions
         (company_id, position_code, role_id, position_title, department_id, location_id, sanctioned_headcount, default_shift_id, status, effective_from)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?)`,
      [companyId, code, roleId, n.title, n.department ? dept.get(norm(n.department)) : null, n.location ? loc.get(norm(n.location)) : null,
        n.count, dn ? null : shiftId(n.shift), today]);
    const id = res.insertId;
    seat.set(n.ref, id);
    seatRole.set(n.ref, roleId);
    seatTitle.set(n.ref, n.title);
    created[`structure:${n.row}`] = `pos:${id}`;
    await audit('hrms_positions', id, 'CREATE', null, { positionCode: code, title: n.title, roleId, headcount: n.count, shift: n.shift || null, copiedFrom: n.copiedFrom });
    if (dn) await addManpower(id, roleId, n.count);
    for (const [i, ref] of n.machines.entries()) {
      await positionSvc.addPositionContext(conn, c, id, { workContextId: machine.get(ref), isPrimary: i === 0 });
    }
    say(`seat created: ${n.title} (${code})`);
  }

  for (const u of plan.seats.update) {
    const db = data.seats.find((s) => s.key === u.key);
    const cols = {};
    const before = {};
    const after = {};
    const note = (field, from, to) => { before[field] = from; after[field] = to; };
    if (u.set.title) { cols.position_title = u.set.title.to; note('title', u.set.title.from, u.set.title.to); seatTitle.set(u.key, u.set.title.to); }
    if (u.set.department) { cols.department_id = u.set.department.to ? dept.get(norm(u.set.department.to)) : null; note('department', u.set.department.from, u.set.department.to); }
    if (u.set.location) { cols.location_id = u.set.location.to ? loc.get(norm(u.set.location.to)) : null; note('location', u.set.location.from, u.set.location.to); }
    const wasDN = db.shift === DAY_AND_NIGHT;
    const finalShift = u.set.shift?.to ?? db.shift;
    const willDN = finalShift === DAY_AND_NIGHT;
    const finalCount = u.set.count?.to ?? db.count;
    if (u.set.count) { cols.sanctioned_headcount = u.set.count.to; note('headcount', u.set.count.from, u.set.count.to); }
    if (u.set.shift) {
      note('shift', u.set.shift.from, u.set.shift.to);
      cols.default_shift_id = willDN ? null : shiftId(finalShift);
    }
    if (Object.keys(cols).length) {
      await conn.query(`UPDATE hrms_positions SET ${Object.keys(cols).map((k) => `${k} = ?`).join(', ')} WHERE company_id = ? AND id = ?`, [...Object.values(cols), companyId, db.positionId]);
      await audit('hrms_positions', db.positionId, 'UPDATE', before, after);
    }
    const dayNight = db.manpower.filter((m) => isDayCode(m.shiftCode) || isNightCode(m.shiftCode));
    if (!wasDN && willDN) await addManpower(db.positionId, db.roleId, finalCount);
    else if (wasDN && !willDN) await endManpower(dayNight);
    else if (wasDN && willDN && u.set.count) {
      for (const m of dayNight) {
        await conn.query('UPDATE hrms_manpower_requirements SET required_count = ? WHERE company_id = ? AND id = ?', [finalCount, companyId, m.id]);
        await audit('hrms_manpower_requirements', m.id, 'UPDATE', { requiredCount: m.count }, { requiredCount: finalCount });
      }
    }
    if (u.set.machines) {
      for (const ref of u.set.machines.remove) {
        const link = db.contextLinks.find((l) => `wct:${l.contextId}` === ref);
        if (link) await positionSvc.removePositionContext(conn, c, link.linkId);
      }
      const left = db.contextLinks.length - u.set.machines.remove.length;
      for (const [i, ref] of u.set.machines.add.entries()) {
        await positionSvc.addPositionContext(conn, c, db.positionId, { workContextId: machine.get(ref), isPrimary: left + i === 0 });
      }
      await audit('hrms_position_work_contexts', db.positionId, 'UPDATE', { removed: u.set.machines.remove }, { added: u.set.machines.add });
    }
    say(`seat updated: ${u.label}`);
  }

  // ---- the chart: end every moved seat's main line first, then attach new and moved seats top-down ----
  const edge = async (id) => one('SELECT id, effective_from FROM hrms_position_reporting_relationships WHERE company_id = ? AND id = ?', [companyId, id]);
  for (const u of plan.seats.update.filter((x) => x.set.parent)) {
    const db = data.seats.find((s) => s.key === u.key);
    if (db.primaryEdgeId == null) continue;
    const e = await edge(db.primaryEdgeId);
    // a line that began today was never in force for a whole day: ending it "yesterday" would end it before it started
    if (e && day(e.effective_from) > yesterday) await positionSvc.removePositionReporting(conn, c, db.primaryEdgeId);
    else await positionSvc.endPositionReporting(conn, c, db.primaryEdgeId, { effectiveTo: yesterday });
    await audit('hrms_position_reporting_relationships', db.primaryEdgeId, 'UPDATE', { manager: u.set.parent.from }, { endedOn: yesterday });
  }
  const attach = async (positionId, toRef) => {
    if (toRef == null) return;
    const toId = seat.get(toRef);
    const existing = await one(
      `SELECT id, effective_to FROM hrms_position_reporting_relationships
        WHERE company_id = ? AND from_position_id = ? AND to_position_id = ? AND relationship_type_id = ? AND scope_type = 'GENERAL'
          AND scope_label IS NULL AND scope_work_context_id IS NULL AND deleted_at IS NULL`,
      [companyId, positionId, toId, env.primaryTypeId]);
    if (existing) {
      // an earlier main line to this same manager, ended: the key does not take dates, so it is reopened (the gap is in the audit log)
      if (existing.effective_to != null) {
        await conn.query('UPDATE hrms_position_reporting_relationships SET effective_to = NULL WHERE company_id = ? AND id = ?', [companyId, existing.id]);
        await audit('hrms_position_reporting_relationships', existing.id, 'UPDATE', { effectiveTo: day(existing.effective_to) }, { effectiveTo: null, reopened: true });
      }
      return;
    }
    const res = await positionSvc.addPositionReporting(conn, c, positionId, {
      toPositionId: toId, relationshipTypeId: env.primaryTypeId, isPrimary: true, effectiveFrom: today,
    });
    await audit('hrms_position_reporting_relationships', res.id, 'CREATE', null, { from: positionId, to: toId });
  };
  const byRow = [
    ...plan.seats.create.map((n) => ({ row: n.row, id: seat.get(n.ref), to: n.parent })),
    ...plan.seats.update.filter((x) => x.set.parent).map((u) => ({ row: u.row, id: u.id, to: u.set.parent.to })),
  ].sort((a, b) => a.row - b.row);
  for (const a of byRow) await attach(a.id, a.to);

  // ----------------------------------------------------------------- people ----
  const codes = nextCode(env.employees.map((e) => e.code), 'E', 4);
  let codeNo = 0;
  for (const e of plan.people.employeesCreate) {
    const code = e.code ?? codes(++codeNo);
    const row = await peopleSvc.createEmployee(conn, c, { employeeCode: code, fullName: e.name, dateOfJoining: e.joined ?? today }, requestId);
    employee.set(e.ref, row.employee.id); // getEmployee answers { employee, assignments, ... }, not the bare row
    say(`employee created: ${e.name} (${code})`);
  }
  for (const u of plan.people.employeesUpdate) {
    const body = {};
    if (u.set.name) body.fullName = u.set.name.to;
    if (u.set.code) body.employeeCode = u.set.code.to;
    if (u.set.joined) body.dateOfJoining = u.set.joined.to;
    await peopleSvc.updateEmployee(conn, c, u.employeeId, body, requestId);
    say(`employee updated: ${u.label}`);
  }
  const eventFor = (employeeId, type, summary, details, assignmentId) => peopleSvc.createEvent(conn, c, employeeId,
    { eventType: type, eventDate: today, summary, details, workAssignmentId: assignmentId ?? null }, requestId);
  const startable = (a) => (day(a.effectiveFrom) && day(a.effectiveFrom) > yesterday ? day(a.effectiveFrom) : yesterday);

  for (const a of plan.people.assign) {
    const employeeId = employee.get(a.employee);
    const res = await assignmentSvc.createAssignment(conn, c, {
      employeeId, roleId: seatRole.get(a.seat), positionId: seat.get(a.seat), defaultShiftId: shiftId(a.shift),
      effectiveFrom: today, status: 'ACTIVE', isPrimary: !a.second, allocationPercent: a.second ? null : 100, reason: SOURCE_NOTE,
    });
    created[`people:${a.row}`] = `asg:${res.assignment.id}`;
    await eventFor(employeeId, a.second ? 'ASSIGNMENT_CHANGE' : 'OTHER', `${a.name} was seated as ${seatTitle.get(a.seat)}.`, { seat: a.seat, via: SOURCE_NOTE }, res.assignment.id);
    say(`seated: ${a.name} -> ${seatTitle.get(a.seat)}`);
  }
  for (const s of plan.people.shift) {
    await assignmentSvc.updateAssignment(conn, c, s.assignmentId, { defaultShiftId: shiftId(s.to) });
    await audit('hrms_work_assignments', s.assignmentId, 'UPDATE', { shift: s.from }, { shift: s.to });
    say(`shift changed: ${s.name} -> ${s.to}`);
  }
  for (const m of plan.people.move) {
    const old = data.people.find((p) => p.key === m.key);
    const body = {
      employeeId: m.employeeId, roleId: seatRole.get(m.to), positionId: seat.get(m.to), defaultShiftId: shiftId(m.shift),
      effectiveFrom: today, status: 'ACTIVE', isPrimary: old.isPrimary, allocationPercent: old.allocation,
      reason: `Moved from "${seatTitle.get(m.from)}" to "${seatTitle.get(m.to)}" (${SOURCE_NOTE.toLowerCase()})`,
    };
    // The old assignment ends first (the day before; one that began today cannot end before it began, so it ends the same
    // day). Not via replacesId: the service checks "one primary at a time" BEFORE it ends the one being replaced.
    await assignmentSvc.endAssignment(conn, c, m.assignmentId, { effectiveTo: startable(old) });
    const res = await assignmentSvc.createAssignment(conn, c, body);
    await eventFor(m.employeeId, 'TRANSFER', `${m.name} moved from ${seatTitle.get(m.from)} to ${seatTitle.get(m.to)}.`,
      { from: m.from, to: m.to, endedAssignment: m.assignmentId, via: SOURCE_NOTE }, res.assignment.id);
    created[`people:${m.row}`] = `asg:${res.assignment.id}`; // the row now stands for the new assignment
    say(`moved: ${m.name} ${seatTitle.get(m.from)} -> ${seatTitle.get(m.to)}`);
  }

  // ---------------------------------------------------------------- duties ----
  const defFor = async (text, knownId) => {
    if (knownId) return knownId;
    const hit = (env.defsByText.get(normDuty(text)) ?? [])[0];
    if (hit) return hit.id;
    const row = await roleSvc.createMasterItem(conn, c, 'responsibilities', { name: shortName(text), description: text });
    const def = { id: row.id, name: shortName(text), description: text, roles: 0 };
    env.defById.set(def.id, def);
    const k = normDuty(text);
    env.defsByText.set(k, [...(env.defsByText.get(k) ?? []), def]);
    return def.id;
  };
  const roleOf = (r) => r.id ?? role.get(norm(r.title));
  const rolesHolding = (roleId, defId) => data.responsibilities.some((x) => x.roleId === roleId && x.defId === defId);

  for (const a of plan.responsibilities.add) {
    const roleId = roleOf(a.role);
    const defId = await defFor(a.text, a.defId);
    if (rolesHolding(roleId, defId)) continue;
    await roleSvc.addContent(conn, c, roleId, 'responsibilities', { responsibilityDefinitionId: defId, effectiveFrom: today });
    created[`responsibilities:${a.row}`] = `rsp:${roleId}:${defId}`;
    say(`duty added to ${a.role.title}`);
  }
  for (const r of plan.responsibilities.retext) {
    const same = (env.defsByText.get(normDuty(r.text)) ?? []).find((d) => d.id !== r.defId);
    if (!same && !r.defShared) {
      await roleSvc.updateMasterItem(conn, c, 'responsibilities', r.defId, { name: shortName(r.text), description: r.text });
      env.defById.set(r.defId, { ...env.defById.get(r.defId), name: shortName(r.text), description: r.text });
      created[`responsibilities:${r.row}`] = `rsp:${r.roleId}:${r.defId}`;
    } else {
      const defId = same ? same.id : await defFor(r.text, null);
      await roleSvc.removeContent(conn, c, 'responsibilities', r.rowId, { endOn: yesterday });
      // if the role already holds the wording it is reworded to, the two duties simply become one
      if (!rolesHolding(r.roleId, defId)) {
        await roleSvc.addContent(conn, c, r.roleId, 'responsibilities', { responsibilityDefinitionId: defId, sequence: r.sequence, effectiveFrom: today });
      }
      created[`responsibilities:${r.row}`] = `rsp:${r.roleId}:${defId}`;
    }
    say(`duty reworded on ${r.roleTitle}`);
  }
  for (const m of plan.responsibilities.move) {
    const toRole = roleOf(m.toRole);
    const defId = m.textChanged ? await defFor(m.text, null) : m.defId;
    await roleSvc.removeContent(conn, c, 'responsibilities', m.rowId, { endOn: yesterday });
    if (!rolesHolding(toRole, defId)) await roleSvc.addContent(conn, c, toRole, 'responsibilities', { responsibilityDefinitionId: defId, effectiveFrom: today });
    created[`responsibilities:${m.row}`] = `rsp:${toRole}:${defId}`;
    say(`duty moved to ${m.toRole.title}`);
  }

  // ------------------------------------------------------------- questions ----
  for (const q of plan.questions.create) {
    const positionId = q.about == null ? null : seat.get(q.about);
    const [res] = await conn.query(
      "INSERT INTO hrms_open_points (company_id, entity_type, entity_id, description, status) VALUES (?, ?, ?, ?, 'OPEN')",
      [companyId, positionId == null ? 'ORGANIZATION' : 'POSITION', positionId, q.text]);
    await audit('hrms_open_points', res.insertId, 'CREATE', null, { entityType: positionId == null ? 'ORGANIZATION' : 'POSITION', entityId: positionId });
    created[`questions:${q.row}`] = `opn:${res.insertId}`;
    say('question added');
  }
  for (const u of plan.questions.update) {
    const cols = {};
    if (u.set.text) cols.description = u.set.text.to;
    if (u.set.about) {
      const positionId = u.set.about.to == null ? null : seat.get(u.set.about.to);
      cols.entity_type = positionId == null ? 'ORGANIZATION' : 'POSITION';
      cols.entity_id = positionId;
    }
    await conn.query(`UPDATE hrms_open_points SET ${Object.keys(cols).map((k) => `${k} = ?`).join(', ')} WHERE company_id = ? AND id = ?`, [...Object.values(cols), companyId, u.id]);
    await audit('hrms_open_points', u.id, 'UPDATE', { text: u.set.text?.from, about: u.set.about?.from }, { text: u.set.text?.to, about: u.set.about?.to });
    say('question updated');
  }

  // -------------------------------------------------------------- removals ----
  for (const e of plan.people.end) {
    const old = data.people.find((p) => p.key === e.key);
    await assignmentSvc.endAssignment(conn, c, e.assignmentId, { effectiveTo: startable(old) });
    await eventFor(e.employeeId, 'ASSIGNMENT_CHANGE', `${e.name} left the seat ${seatTitle.get(e.seat)} (removed from the organisation workbook).`, { seat: e.seat, via: SOURCE_NOTE }, e.assignmentId);
    say(`assignment ended: ${e.label}`);
  }
  for (const r of plan.responsibilities.remove) {
    if (r.overrideId != null) await positionSvc.removePositionOverride(conn, c, r.overrideId);
    else await roleSvc.removeContent(conn, c, 'responsibilities', r.rowId, { endOn: yesterday });
    say('duty removed');
  }
  for (const q of plan.questions.dismiss) {
    await conn.query(
      "UPDATE hrms_open_points SET status = 'DISMISSED', resolution = ?, resolved_at = NOW() WHERE company_id = ? AND id = ?",
      [`Removed from the organisation workbook on ${today}.`, companyId, q.id]);
    await audit('hrms_open_points', q.id, 'UPDATE', { status: 'OPEN' }, { status: 'DISMISSED' });
    say('question dismissed');
  }
  for (const s of plan.seats.close) {
    await positionSvc.setPositionStatus(conn, c, s.id, 'CLOSED');
    await audit('hrms_positions', s.id, 'UPDATE', { status: 'ACTIVE' }, { status: 'CLOSED', via: SOURCE_NOTE });
    say(`seat closed: ${s.title}`);
  }
  for (const m of plan.machines.remove) {
    await orgSvc.deleteWorkContext(conn, c, m.id);
    say(`machine deleted: ${m.name}`);
  }
  return { created, log };
}

// ============================================================================= safety checks ====
/**
 * Can this workbook be applied to THIS company on THIS database at all? Returns the reasons it cannot (empty = it can).
 * A workbook with no provenance is not refused: it is a blank template, every row is a create, and the report says so.
 */
export function checkProvenance({ read, company, target }) {
  const refusals = [];
  const p = read.provenance;
  if (!p) return refusals;
  if (!SUPPORTED_SCHEMA_VERSIONS.includes(p.schemaVersion)) {
    refusals.push(`This workbook is schema version ${p.schemaVersion}; this tool understands ${SUPPORTED_SCHEMA_VERSIONS.join(', ')}. Export a fresh workbook with the same version of the tool.`);
  }
  if (p.companySlug !== company.slug || p.companyId !== company.id) {
    refusals.push(`This workbook belongs to a different company: it was exported for ${p.companySlug} (company id ${p.companyId}); you are applying it to ${company.slug} (company id ${company.id}).`);
  }
  const here = target.isProd ? 'prod' : 'local';
  if (p.target !== here) {
    refusals.push(`This workbook was exported from the ${p.target.toUpperCase()} database; you are applying it to ${here.toUpperCase()}. The keys in it are ids in the other database and mean nothing here.`);
  }
  return refusals;
}

// ================================================================================== the report ====
const nameList = (xs, n = 6) => (xs.length > n ? `${xs.slice(0, n).join(', ')} and ${xs.length - n} more` : xs.join(', '));

/** The plan as lines of plain text. Everything the apply would write, and everything it would remove, itemised. */
export function describePlan(plan, X) {
  const out = [];
  const L = (s = '') => out.push(s);
  const nameOfMachine = (ref) => X.machineNameOf.get(ref) ?? ref;
  const rowOf = (r) => (r == null ? '' : ` (row ${r})`);
  const c = plan.counts;

  L('PLAN');
  if (plan.empty) {
    L('  EMPTY. The workbook says exactly what the database says; nothing would change.');
    return out;
  }
  const line = (label, parts) => { const p = parts.filter(Boolean); if (p.length) L(`  ${label.padEnd(18)}${p.join('  |  ')}`); };
  line('structure', [
    c.seatsCreated && `${c.seatsCreated} created`, c.seatsRetitled && `${c.seatsRetitled} retitled`, c.headcountsChanged && `${c.headcountsChanged} headcount changed`,
    c.seatShiftsChanged && `${c.seatShiftsChanged} shift changed`, c.seatDepartmentsChanged && `${c.seatDepartmentsChanged} department changed`,
    c.seatLocationsChanged && `${c.seatLocationsChanged} location changed`, c.seatMachinesChanged && `${c.seatMachinesChanged} machine list changed`,
    c.seatsMovedToNewManager && `${c.seatsMovedToNewManager} moved to a new manager`, c.seatsClosed && `${c.seatsClosed} CLOSED`]);
  line('people', [
    c.peopleAdded && `${c.peopleAdded} added`, c.peopleSeatedAgain && `${c.peopleSeatedAgain} given another seat`, c.peopleMovedToAnotherSeat && `${c.peopleMovedToAnotherSeat} moved to a different seat`,
    c.peopleChanged && `${c.peopleChanged} name/code/joined changed`, c.peopleShiftChanged && `${c.peopleShiftChanged} shift changed`, c.peopleEnded && `${c.peopleEnded} taken out of their seat (assignment ENDED)`]);
  line('responsibilities', [
    c.responsibilitiesAdded && `${c.responsibilitiesAdded} added`, c.responsibilitiesReworded && `${c.responsibilitiesReworded} reworded`,
    c.responsibilitiesMoved && `${c.responsibilitiesMoved} moved to another role`, c.responsibilitiesRemoved && `${c.responsibilitiesRemoved} REMOVED`]);
  line('machines & areas', [
    c.machinesCreated && `${c.machinesCreated} created`, c.machinesRenamed && `${c.machinesRenamed} renamed`, c.machinesKindChanged && `${c.machinesKindChanged} kind changed`,
    c.machinesMoved && `${c.machinesMoved} moved to another location`, c.machinesDeleted && `${c.machinesDeleted} DELETED`]);
  line('questions', [c.questionsAdded && `${c.questionsAdded} added`, c.questionsChanged && `${c.questionsChanged} changed`, c.questionsDismissed && `${c.questionsDismissed} DISMISSED`]);
  line('also created', [c.departmentsCreated && `${plural(c.departmentsCreated, 'department')}`, c.locationsCreated && `${plural(c.locationsCreated, 'location')}`, c.rolesCreated && `${plural(c.rolesCreated, 'role')}`]);

  if (plan.departments.length || plan.locations.length || plan.roles.length) {
    L(); L('NEW MASTERS (typed in a cell and not in the system yet - check the spelling)');
    for (const d of plan.departments) L(`  + department "${d.name}"${rowOf(d.row)}${d.similar ? `   <- did you mean "${d.similar}"?` : ''}`);
    for (const l of plan.locations) L(`  + location "${l.name}"${rowOf(l.row)}${l.similar ? `   <- did you mean "${l.similar}"?` : ''}`);
    for (const r of plan.roles) L(`  + role "${r.title}"${rowOf(r.row)}  (a new seat with a title no role has; it starts with no duties)`);
  }
  if (plan.seats.create.length || plan.seats.update.length || plan.seats.close.length) {
    L(); L('SEATS');
    for (const n of plan.seats.create) {
      const bits = [`under ${X.seatName(n.parent)}`, n.shift && n.shift, `${n.count} ${n.count === 1 ? 'person' : 'people'}`, n.department, n.location,
        n.machines.length && `machines: ${nameList(n.machines.map(nameOfMachine))}`,
        n.roleId != null ? `role "${n.roleTitle}" (existing, shared with ${plural(X.seatsOfRole({ id: n.roleId }) - 1, 'other seat')})` : `NEW role "${n.roleTitle}"`,
        n.copiedFrom && `copy of ${n.copiedFrom}`];
      L(`  + "${n.title}"${rowOf(n.row)}: ${bits.filter(Boolean).join(', ')}`);
    }
    for (const u of plan.seats.update) {
      const bits = [];
      if (u.set.title) bits.push(`retitled "${u.set.title.from}" -> "${u.set.title.to}"`);
      if (u.set.count) bits.push(`headcount ${u.set.count.from} -> ${u.set.count.to}`);
      if (u.set.shift) bits.push(`shift ${u.set.shift.from} -> ${u.set.shift.to}`);
      if (u.set.department) bits.push(`department "${u.set.department.from}" -> "${u.set.department.to}"`);
      if (u.set.location) bits.push(`location "${u.set.location.from}" -> "${u.set.location.to}"`);
      if (u.set.machines) bits.push(`machines ${[...u.set.machines.add.map((r) => `+${nameOfMachine(r)}`), ...u.set.machines.remove.map((r) => `-${nameOfMachine(r)}`)].join(' ')}`);
      if (u.set.parent) bits.push(`reports to ${X.seatName(u.set.parent.from)} -> ${X.seatName(u.set.parent.to)}`);
      L(`  ~ "${u.label}" (${u.key})${rowOf(u.row)}: ${bits.join('; ')}`);
    }
    for (const s of plan.seats.close) L(`  - CLOSE "${s.title}" (${s.key}): it leaves the chart and keeps its history${s.reports ? `; ${plural(s.reports, 'seat')} that reported to it now report elsewhere` : ''}`);
  }
  if (plan.people.employeesCreate.length || plan.people.assign.length || plan.people.move.length || plan.people.employeesUpdate.length || plan.people.shift.length || plan.people.end.length) {
    L(); L('PEOPLE');
    for (const e of plan.people.employeesCreate) L(`  + new person "${e.name}"${rowOf(e.rows[0])}, code ${e.code ?? '(next in the series)'}, joined ${e.joined ?? 'today (no date given)'}`);
    for (const a of plan.people.assign) L(`  + ${a.name}${rowOf(a.row)} sits in ${X.seatName(a.seat)}${a.shift ? ` on ${a.shift}` : ''}${a.second ? '  (an additional seat: they keep their existing one)' : ''}`);
    for (const m of plan.people.move) L(`  ~ ${m.name}${rowOf(m.row)} moves from ${X.seatName(m.from)} to ${X.seatName(m.to)}: the old assignment ENDS, a new one starts today`);
    for (const u of plan.people.employeesUpdate) {
      const bits = Object.entries(u.set).map(([f, v]) => `${f} "${v.from ?? ''}" -> "${v.to}"`);
      L(`  ~ ${u.label}${rowOf(u.rows[0])}: ${bits.join('; ')}`);
    }
    for (const s of plan.people.shift) L(`  ~ ${s.name}${rowOf(s.row)}: shift ${s.from || '(none)'} -> ${s.to}`);
    for (const e of plan.people.end) L(`  - END ${e.label}: they stay on the employee list, with no seat`);
  }
  if (plan.responsibilities.add.length || plan.responsibilities.retext.length || plan.responsibilities.move.length || plan.responsibilities.remove.length) {
    L(); L('RESPONSIBILITIES (a duty belongs to a ROLE; every seat with that role shares it)');
    for (const a of plan.responsibilities.add) {
      L(`  + to role "${a.role.title}" (${plural(a.sharedBy, 'seat')} share${a.sharedBy === 1 ? 's' : ''} it)${rowOf(a.row)}: ${a.text.slice(0, 90)}${a.text.length > 90 ? '...' : ''}${a.defId ? '  [existing wording reused]' : ''}`);
    }
    for (const r of plan.responsibilities.retext) {
      L(`  ~ role "${r.roleTitle}"${rowOf(r.row)}: "${r.from.slice(0, 50)}..." reworded${r.defShared ? ' - the old wording is shared by other roles, so THIS role gets new wording and the others keep theirs' : ' - the wording is used by this role only, so it is changed in place'}`);
    }
    for (const m of plan.responsibilities.move) L(`  ~ MOVED from role "${m.fromTitle}" (${plural(m.sharedBy, 'seat')}) to role "${m.toRole.title}" (${plural(m.toShared, 'seat')})${rowOf(m.row)}: ${m.text.slice(0, 70)}...`);
    for (const r of plan.responsibilities.remove) L(`  - REMOVE from ${r.roleId != null ? `role "${r.roleTitle}" (${plural(r.sharedBy, 'seat')})` : 'one seat'}: ${r.text.slice(0, 80)}${r.text.length > 80 ? '...' : ''}`);
  }
  if (plan.machines.create.length || plan.machines.update.length || plan.machines.remove.length) {
    L(); L('MACHINES & AREAS');
    for (const m of plan.machines.create) L(`  + "${m.name}" (${m.kind})${m.where ? ` at ${m.where}` : ''}${rowOf(m.row)}${m.copied ? '  (a copy)' : ''}`);
    for (const u of plan.machines.update) {
      const bits = Object.entries(u.set).map(([f, v]) => `${f} "${v.from ?? ''}" -> "${v.to}"`);
      L(`  ~ "${u.label}"${rowOf(u.row)}: ${bits.join('; ')}`);
    }
    for (const m of plan.machines.remove) L(`  - DELETE "${m.name}" (${m.key})`);
  }
  if (plan.questions.create.length || plan.questions.update.length || plan.questions.dismiss.length) {
    L(); L('QUESTIONS & DOUBTS');
    for (const q of plan.questions.create) L(`  + ${q.about == null ? 'about the whole organisation' : `about ${X.seatName(q.about)}`}${rowOf(q.row)}: ${q.text.slice(0, 80)}`);
    for (const u of plan.questions.update) L(`  ~ ${u.key}${rowOf(u.row)}: ${[u.set.text && 'wording changed', u.set.about && `now about ${X.seatName(u.set.about.to)}`].filter(Boolean).join('; ')}`);
    for (const q of plan.questions.dismiss) L(`  - DISMISS ${q.key}: ${q.text.slice(0, 80)}`);
  }
  return out;
}

/** What is in the database but not in the workbook, left alone because --delete-missing was not given. */
function describeKept(plan, deleteMissing) {
  const k = plan.kept;
  const total = k.seats.length + k.people.length + k.responsibilities.length + k.machines.length + k.questions.length;
  if (!total || deleteMissing) return [];
  const out = ['', 'LEFT ALONE (in the database, not in the workbook)'];
  const row = (n, what, names) => n && out.push(`  ${plural(n, what)}: ${nameList(names)}`);
  row(k.seats.length, 'seat', k.seats.map((s) => `"${s.title}"`));
  row(k.people.length, 'person', k.people.map((p) => p.name));
  row(k.responsibilities.length, 'duty', k.responsibilities.map((r) => `"${r.text.slice(0, 30)}..."`));
  row(k.machines.length, 'machine', k.machines.map((m) => `"${m.name}"`));
  row(k.questions.length, 'question', k.questions.map((q) => q.key));
  out.push('  Nothing has been removed. If these rows were deleted on purpose, run again with --delete-missing to remove them');
  out.push('  (a seat is closed, a person\'s assignment ended, a duty retired, a question dismissed; nothing is erased).');
  return out;
}

// ============================================================================ the apply, whole ====
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/**
 * Read, check and plan. Writes nothing. Shared by the dry run, the apply and the tests.
 *
 * @returns {{read, loaded, env, plan, X, company, refusals, stale, problems, createOnlyOnExisting}}
 */
export async function prepare({ conn, buf, slug, target, deleteMissing }) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const read = readOrgWorkbook(wb);
  const [[company]] = await conn.query('SELECT id, name, slug FROM companies WHERE slug = ? AND deleted_at IS NULL', [slug]);
  if (!company) throw new Error(`No company with slug "${slug}" on ${target.name}.`);
  const refusals = checkProvenance({ read, company, target });
  const base = { read, company, refusals };
  if (refusals.length || read.problems.some((p) => p.severity === 'error' && ['UNKNOWN_SCHEMA_VERSION', 'PROVENANCE_INCOMPLETE', 'MISSING_SHEET', 'BAD_HEADER'].includes(p.code))) {
    return { ...base, problems: read.problems, plan: null };
  }
  const loaded = await loadOrg(conn, slug);
  const env = await loadEnv(conn, company.id);
  const stale = read.kind === 'prefilled' && fingerprintOf(loaded.data) !== read.provenance.contentHash;
  const plan = planChanges({ read, loaded, env, deleteMissing });
  const problems = [...read.problems, ...plan.problems];
  const existing = loaded.data.seats.length;
  return { ...base, loaded, env, plan, stale, problems, existingSeats: existing };
}

/** The little context the report needs to name seats and machines (planChanges keeps its own, private to the planning). */
function reportContext(prep) {
  const X = makeContext(prep.read, prep.loaded, prep.env, false);
  for (const n of prep.plan.seats.create) X.newSeat.set(n.ref, n);
  for (const m of prep.loaded.data.machines) X.machineNameOf.set(m.key, m.name);
  for (const m of prep.plan.machines.create) X.machineNameOf.set(m.ref, m.name);
  return X;
}

/** Re-open the same workbook against the database AFTER the writes, with the new rows' keys filled in. It must now agree. */
async function converges({ conn, prep, created, slug, deleteMissing }) {
  const read = structuredClone(prep.read);
  // Rows that hang off a seat this apply CLOSED are not re-checked: the export no longer shows a role's duties once it has no
  // seat, and shows a question about a closed seat as a general one, so those rows are expected to differ (see planRemovals).
  const closing = new Set(prep.plan.seats.close.map((s) => s.key));
  if (closing.size) {
    const X = makeContext(prep.read, prep.loaded, prep.env, false);
    const { orphanedRoles, closedLabels } = orphansOf(prep.loaded.data, closing, X);
    read.responsibilities = read.responsibilities.filter((r) => !(r.identity?.kind === 'rsp' && orphanedRoles.has(r.identity.ids[0])));
    read.questions = read.questions.filter((q) => !closedLabels.has(q.seatText));
  }
  const sheets = { structure: read.seats, people: read.people, responsibilities: read.responsibilities, machines: read.machines, questions: read.questions };
  for (const [sheet, rows] of Object.entries(sheets)) {
    for (const row of rows) {
      const key = created[`${sheet}:${row.row}`];
      if (key) { row.key = key; row.keyState = 'ok'; row.identity = parseKey(key); }
    }
  }
  const loaded = await loadOrg(conn, slug);
  const env = await loadEnv(conn, prep.company.id);
  // the seat cells in the workbook still hold the labels the export wrote, whatever has been renamed since
  const exportLabels = new Map(prep.loaded.data.seats.map((s, i) => [s.key, seatLabel(i, s.title)]));
  const plan = planChanges({ read, loaded, env, deleteMissing, exportLabels });
  return { plan, errors: plan.problems.filter((p) => p.severity === 'error') };
}

/**
 * Apply a workbook. The caller owns `conn`; this function begins the transaction, and commits ONLY if every write
 * went through AND the workbook, compared with the database again, no longer differs from it.
 *
 * `flags.rehearse(conn, info)`, if given, replaces the commit: it runs after the last write and the convergence check
 * and the transaction is then rolled back. It exists so a test can read the database as an apply leaves it without
 * leaving it that way.
 */
export async function applyWorkbook({ conn, buf, file, slug, target, flags }) {
  await conn.beginTransaction();
  try {
    const prep = await prepare({ conn, buf, slug, target, deleteMissing: flags.deleteMissing });
    const blocked = gate(prep, flags);
    if (blocked) { await conn.rollback(); return { status: blocked.status, reasons: blocked.reasons, prep }; }
    // the same file is never applied twice (its new rows would be added again): hrms_import_runs keeps each applied file's SHA-256
    if (!flags.again) {
      const [[done]] = await conn.query("SELECT id, committed_at FROM hrms_import_runs WHERE company_id = ? AND source_hash = ? AND status = 'COMMITTED' AND deleted_at IS NULL ORDER BY id DESC LIMIT 1",
        [prep.company.id, sha256(buf)]);
      if (done) {
        await conn.rollback();
        return { status: 'ALREADY_APPLIED', reasons: [`This exact file was already applied (import run #${done.id}, ${done.committed_at}). Export a fresh workbook, or pass --again.`], prep };
      }
    }
    const requestId = `org-workbook:${crypto.randomUUID()}`;
    // hrms_audit_log is append-only, and the application's own services write their audit rows without a request id,
    // so the apply is traced by the RANGE of audit rows it wrote, kept on its import-run row.
    const auditFrom = Number((await conn.query('SELECT COALESCE(MAX(id), 0) AS n FROM hrms_audit_log WHERE company_id = ?', [prep.company.id]))[0][0].n);
    const { created, log } = await executePlan({ conn, plan: prep.plan, loaded: prep.loaded, env: prep.env, requestId });
    const auditTo = Number((await conn.query('SELECT COALESCE(MAX(id), 0) AS n FROM hrms_audit_log WHERE company_id = ?', [prep.company.id]))[0][0].n);
    const after = await converges({ conn, prep, created, slug, deleteMissing: flags.deleteMissing });
    if (!after.plan.empty || after.errors.length) {
      await conn.rollback();
      const left = describePlan(after.plan, reportContext({ ...prep, plan: after.plan }));
      return { status: 'DID_NOT_CONVERGE', reasons: [
        'After the writes the workbook still differs from the database, so something was written wrongly or could not be written. EVERYTHING WAS ROLLED BACK.',
        ...after.errors.slice(0, 10).map((e) => `${e.code}: ${e.message}`), ...left.slice(0, 40)], prep };
    }
    const counts = prep.plan.counts;
    await conn.query(
      `INSERT INTO hrms_import_runs
         (company_id, source_kind, source_file_name, source_hash, source_size_bytes, status, parsed_counts_json, findings_json, id_map_json,
          parsed_at, validated_at, committed_at, notes)
       VALUES (?, 'EXCEL', ?, ?, ?, 'COMMITTED', ?, ?, ?, NOW(), NOW(), NOW(), ?)`,
      [prep.company.id, path.basename(file), sha256(buf), buf.length, JSON.stringify(prep.read.stats.rows),
        JSON.stringify({ counts, deleteMissing: flags.deleteMissing, notices: prep.plan.notices.map((n) => n.message).slice(0, 50),
          warnings: prep.problems.filter((p) => p.severity === 'warning').map((p) => p.message).slice(0, 50), requestId,
          auditRows: { after: auditFrom, upTo: auditTo } }),
        JSON.stringify(created), `org-apply-workbook on ${target.name}`]);
    if (flags.rehearse) {
      // FOR TESTS: look at the database as it stands after every write (and the import-run row), then put it all back.
      const observed = await flags.rehearse(conn, { created, log, plan: prep.plan, requestId });
      await conn.rollback();
      return { status: 'REHEARSED', prep, created, log, observed, requestId };
    }
    await conn.commit();
    return { status: 'APPLIED', prep, created, log, requestId };
  } catch (e) {
    try { await conn.rollback(); } catch { /* the first error is the one that matters */ }
    return { status: 'FAILED', error: e };
  }
}

/** The reasons an --apply must not go ahead, or null. Same checks for the dry run, which reports them as warnings. */
function gate(prep, flags) {
  const reasons = [];
  if (prep.refusals.length) return { status: 'REFUSED', reasons: prep.refusals };
  const errors = prep.problems.filter((p) => p.severity === 'error');
  if (errors.length) return { status: 'PROBLEMS', reasons: [`${plural(errors.length, 'problem')} must be fixed first.`] };
  if (prep.stale && !flags.allowStale) {
    return { status: 'STALE', reasons: ['The database has changed since this workbook was exported, so applying it would quietly put back what has changed. Export a fresh workbook and make the edits again, or pass --allow-stale if the difference does not matter.'] };
  }
  if (prep.read.kind !== 'prefilled' && prep.existingSeats > 0 && !flags.createOnly) {
    return { status: 'CREATE_ONLY', reasons: [`This workbook has no provenance, so every row would be ADDED as new next to the ${plural(prep.existingSeats, 'seat')} ${prep.company.slug} already has. Pass --create-only if that is what you want.`] };
  }
  if (prep.plan.empty) return { status: 'NOTHING_TO_DO', reasons: ['The plan is empty.'] };
  return null;
}

// ============================================================================================ CLI ====
const args = process.argv.slice(2);
const arg = (name) => {
  const hit = args.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return null;
  return hit.includes('=') ? hit.slice(hit.indexOf('=') + 1) : '';
};
const has = (name) => args.some((a) => a === `--${name}`);

function printHeader({ file, buf, prep, target, apply, flags }) {
  const { read } = prep;
  console.log(`  WORKBOOK   ${path.basename(file)}   ${(buf.length / 1024).toFixed(0)} KB   sha256 ${sha256(buf).slice(0, 12)}...`);
  if (read.kind === 'prefilled') {
    const p = read.provenance;
    console.log(`  FOR        ${p.companySlug} (company id ${p.companyId}), exported from ${p.target.toUpperCase()} at ${p.exportedAt}, schema ${p.schemaVersion}`);
  } else {
    console.log('  FOR        (no provenance)');
  }
  console.log(`  MODE       ${apply ? `APPLY${target.isProd ? ' TO PRODUCTION' : ''}: this writes, in one transaction` : 'DRY RUN: nothing is written.  Add --apply to write this plan.'}`);
  console.log(`  REMOVALS   ${flags.deleteMissing ? 'ON (--delete-missing): rows missing from the workbook are removed' : 'off: rows missing from the workbook are left alone (add --delete-missing to remove them)'}`);
  console.log();
}

function printProblems(problems) {
  const errors = problems.filter((p) => p.severity === 'error');
  const warnings = problems.filter((p) => p.severity === 'warning');
  const info = problems.filter((p) => p.severity === 'info');
  if (errors.length) {
    console.log(`PROBLEMS (${errors.length}): nothing can be applied until these are fixed`);
    errors.slice(0, 60).forEach((p) => console.log(`  x ${p.message}`));
    if (errors.length > 60) console.log(`  ... and ${errors.length - 60} more`);
    console.log();
  }
  if (warnings.length) {
    console.log(`WARNINGS (${warnings.length})`);
    warnings.slice(0, 40).forEach((p) => console.log(`  ! ${p.message}`));
    if (warnings.length > 40) console.log(`  ... and ${warnings.length - 40} more`);
    console.log();
  }
  if (info.length) {
    console.log('FINDINGS');
    info.slice(0, 40).forEach((p) => console.log(`  - ${p.message}`));
    console.log();
  }
}

async function main() {
  const file = arg('file');
  const slug = arg('company');
  if (!file || !slug) {
    console.error('usage: node org-apply-workbook.mjs --file=X.xlsx --company=<slug> [--apply] [--delete-missing] [--allow-stale] [--again] [--create-only] [--target=prod]');
    process.exit(2);
  }
  const apply = has('apply');
  const flags = { deleteMissing: has('delete-missing'), allowStale: has('allow-stale'), again: has('again'), createOnly: has('create-only') };
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) { console.error(`No such file: ${abs}`); process.exit(2); }
  const buf = fs.readFileSync(abs);

  const target = resolveTarget();
  announce(target);
  const conn = await mysql.createConnection({ ...target.cfg, dateStrings: true });
  let code = 0;
  try {
    // the plan, read-only (an --apply plans again, inside its own transaction, so the plan is for the state it writes into)
    const prep = await prepare({ conn, buf, slug, target, deleteMissing: flags.deleteMissing });
    printHeader({ file: abs, buf, prep, target, apply, flags });

    if (prep.refusals.length) {
      console.log('REFUSED');
      prep.refusals.forEach((r) => console.log(`  * ${r}`));
      console.log('  Nothing was read from or written to the database beyond looking up the company.');
      process.exitCode = 2;
      return;
    }
    if (!prep.plan) {
      printProblems(prep.problems);
      process.exitCode = 1;
      return;
    }
    if (prep.read.kind !== 'prefilled') {
      console.log('*** THIS WORKBOOK HAS NO PROVENANCE ***');
      console.log('  It is a blank template (or a copy made before keys existed), so no row in it can be matched to anything in the database.');
      console.log(`  EVERY row below is a CREATE. Nothing that exists will be changed or removed${prep.existingSeats ? `, but ${slug} already has ${plural(prep.existingSeats, 'seat')}: this ADDS to them, it does not merge` : ''}.`);
      console.log();
    }
    if (prep.stale) {
      console.log('*** THE DATABASE HAS MOVED SINCE THIS WORKBOOK WAS EXPORTED ***');
      console.log('  What differs below is partly your edits and partly changes made in the system since. Applying would put those back.');
      console.log(`  ${flags.allowStale ? '--allow-stale was given.' : 'An --apply is refused unless you export a fresh workbook (or pass --allow-stale).'}`);
      console.log();
    }
    printProblems(prep.problems);
    describePlan(prep.plan, reportContext(prep)).forEach((l) => console.log(l));
    if (prep.plan.notices.length) {
      console.log();
      console.log(`NOT SAVED / NOTED (${prep.plan.notices.length})`);
      prep.plan.notices.slice(0, 40).forEach((n) => console.log(`  - ${n.message}`));
      if (prep.plan.notices.length > 40) console.log(`  ... and ${prep.plan.notices.length - 40} more`);
    }
    describeKept(prep.plan, flags.deleteMissing).forEach((l) => console.log(l));
    console.log();

    const errors = prep.problems.filter((p) => p.severity === 'error');
    if (!apply) {
      if (errors.length) { process.exitCode = 1; return; }
      console.log(prep.plan.empty ? 'Nothing to apply.' : 'DRY RUN only. Run again with --apply to write this plan.');
      return;
    }

    // ---- --apply ----
    const res = await applyWorkbook({ conn, buf, file: abs, slug, target, flags });
    if (res.status === 'APPLIED') {
      console.log(`APPLIED. ${res.log.length} writes in one transaction (request ${res.requestId}); the workbook now matches the database.`);
      console.log('The new rows in this file have no Key yet: export a fresh workbook before editing again, and do not apply this file a second time.');
    } else if (res.status === 'NOTHING_TO_DO') {
      console.log('Nothing to do.');
    } else if (res.status === 'FAILED') {
      console.log('FAILED, everything rolled back:');
      console.log(`  ${res.error?.message ?? res.error}`);
      (res.error?.problems ?? []).slice(0, 10).forEach((p) => console.log(`    - ${p}`));
      code = 3;
    } else {
      console.log(`NOT APPLIED (${res.status}):`);
      res.reasons.forEach((r) => console.log(`  * ${r}`));
      code = res.status === 'PROBLEMS' || res.status === 'DID_NOT_CONVERGE' ? 1 : 2; // REFUSED, STALE, CREATE_ONLY, ALREADY_APPLIED
    }
  } finally {
    await conn.end();
  }
  if (code) process.exitCode = code;
}

// Run only when started as a script, so a test can import planChanges / applyWorkbook without side effects.
const here = fileURLToPath(import.meta.url);
if (process.argv[1] && (import.meta.url === pathToFileURL(process.argv[1]).href || path.basename(process.argv[1]) === path.basename(here))) {
  main().catch((e) => { console.error(e.message ?? e); process.exit(3); });
}

export { loadEnv, reportContext, converges, gate, sha256 };
