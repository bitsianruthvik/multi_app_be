/**
 * The plumbing behind the organisation-workbook regression tests (run them with run.mjs).
 *
 * What is here: opening and editing a workbook the way a person, or Excel, does (change a cell, insert a row, copy a
 * row, delete a row), planning and applying it, and a per-case context `t` that collects checks, notes and skips.
 * The cases themselves live in cases/*.mjs and only talk to `t`.
 *
 * THE RULES THE CASES FOLLOW, so the suite survives the next chart revision:
 *   - No hard-coded counts, ids or names. Every case PICKS its rows from a fresh export of whatever the company holds
 *     now (a seat that shares its role, a person, a leaf with no children ...) and SKIPS, saying why, when the data has
 *     no such row. A skip is reported and counted; it is never a pass and never a failure.
 *   - Every name a case creates carries `t.tag`, unique to the run, so a department or role that already exists can
 *     never turn "creates one" into "creates none".
 *   - Nothing is left behind. Applies are rehearsed: the real apply runs in a transaction, the case looks at the database
 *     as the apply leaves it, and the transaction is rolled back (flags.rehearse in org-apply-workbook.mjs). The one case
 *     that really commits is opt-in (--commit) and puts everything back.
 */
import ExcelJS from 'exceljs';
import * as T from '../org-template.mjs';
import * as A from '../org-apply-workbook.mjs';
import * as S from '../lib/orgTemplateSheets.mjs';
import * as R from '../lib/orgWorkbookReader.mjs';

export { T, A, S, R, ExcelJS };

/** Thrown by t.skip / t.need: the data has nothing to test this with. Not a failure. */
export class Skip extends Error {
  constructor(message) { super(message); this.name = 'Skip'; }
}

export const SHEETS = Object.freeze({
  structure: S.SHEET.structure, people: S.SHEET.people, responsibilities: S.SHEET.responsibilities,
  departments: S.SHEET.departments, questions: S.SHEET.questions, start: S.SHEET.start,
});
const KEY_OF_SHEET = Object.freeze({
  [S.SHEET.structure]: 'structure', [S.SHEET.people]: 'people', [S.SHEET.responsibilities]: 'responsibilities',
  [S.SHEET.departments]: 'departments', [S.SHEET.questions]: 'questions',
});
/** Structure's columns. */
export const COLS = Object.freeze({
  count: S.COL.count, shift: S.COL.shift, department: S.COL.department, location: S.COL.location,
  notes: S.COL.notes, key: S.COL.key,
});
/** The Departments sheet's columns. */
export const DEPT = S.DEPT_COL;

// ------------------------------------------------------------------------ editing a workbook ----
export async function open(buf) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  return wb;
}
export const save = async (wb) => Buffer.from(await wb.xlsx.writeBuffer());

/** Every Structure row that holds a seat title: { row, level, title, key }. */
export function structureRows(wb) {
  const ws = wb.getWorksheet(SHEETS.structure);
  const out = [];
  for (let r = 2; r <= ws.rowCount; r++) {
    for (let c = S.COL.firstLevel; c <= S.COL.lastLevel; c++) {
      const v = ws.getRow(r).getCell(c).value;
      if (v != null && String(v).trim()) {
        out.push({ row: r, level: c - S.COL.firstLevel + 1, title: String(v), key: String(ws.getRow(r).getCell(COLS.key).value ?? '') });
        break;
      }
    }
  }
  return out;
}
export const rowOfKey = (wb, key) => structureRows(wb).find((s) => s.key === key)?.row;
export const levelOfRow = (wb, row) => structureRows(wb).find((s) => s.row === row)?.level;
/** The title cell of a Structure row, wherever its Level column is. */
export function setSeatTitle(wb, row, title) {
  const ws = wb.getWorksheet(SHEETS.structure);
  for (let c = S.COL.firstLevel; c <= S.COL.lastLevel; c++) {
    const cell = ws.getRow(row).getCell(c);
    if (cell.value != null && String(cell.value).trim()) { cell.value = title; return; }
  }
  throw new Error(`no title on Structure row ${row}`);
}
export const setCell = (wb, sheet, row, col, value) => { wb.getWorksheet(sheet).getRow(row).getCell(col).value = value; };
export const getCell = (wb, sheet, row, col) => wb.getWorksheet(sheet).getRow(row).getCell(col).value;
/** The sheet's key cell for a row. */
export const keyCol = (sheet) => S.KEY_COLUMN[KEY_OF_SHEET[sheet]];

/**
 * Insert a new Structure row at `at` (every row from there moves down one, as in Excel) and fill it in. Blank key.
 * `level` is 1-based.
 */
export function insertSeat(wb, at, { level, title, count = 1, shift = '', department = '', location = '' }) {
  const ws = wb.getWorksheet(SHEETS.structure);
  ws.spliceRows(at, 0, new Array(S.COL.key).fill(null));
  const row = ws.getRow(at);
  row.getCell(S.COL.firstLevel + level - 1).value = title;
  row.getCell(COLS.count).value = count;
  if (shift) row.getCell(COLS.shift).value = shift;
  if (department) row.getCell(COLS.department).value = department;
  if (location) row.getCell(COLS.location).value = location;
  return at;
}
/** Copy row `from` (its key and all, but not its formulas) into a new row inserted at `at`: what copy and paste does. */
export function copyRow(wb, sheet, from, at) {
  const ws = wb.getWorksheet(sheet);
  const values = [];
  for (let c = 1; c <= ws.columnCount; c++) {
    const v = ws.getRow(from).getCell(c).value;
    values.push(v && typeof v === 'object' && 'formula' in v ? null : v);
  }
  ws.spliceRows(at, 0, values);
  return at;
}
/**
 * Add a department on the first empty row of Departments, the way a person types one. `serves` is a list of names (one per Serves
 * column). Returns the row. Blank Key, so it is a CREATE.
 */
export function appendDepartment(wb, { name, under = '', type = 'Department', shared = false, serves = [] }) {
  const ws = wb.getWorksheet(SHEETS.departments);
  let r = ws.rowCount;
  while (r > 1 && !String(ws.getRow(r).getCell(DEPT.name).value ?? '').trim()) r--;
  const row = ws.getRow(r + 1);
  row.getCell(DEPT.name).value = name;
  if (under) row.getCell(DEPT.under).value = under;
  if (type) row.getCell(DEPT.type).value = type;
  row.getCell(DEPT.shared).value = shared ? S.YES : S.NO;
  serves.forEach((s, i) => { row.getCell(DEPT.firstServes + i).value = s; });
  return r + 1;
}
/** Set the Serves cells of a Departments row to exactly these names. */
export function setServes(wb, row, names) {
  const ws = wb.getWorksheet(SHEETS.departments);
  for (let i = 0; i < S.SERVES_SLOTS; i++) ws.getRow(row).getCell(DEPT.firstServes + i).value = names[i] ?? null;
}
/** The Serves names a Departments row currently holds. */
export function servesOf(wb, row) {
  const ws = wb.getWorksheet(SHEETS.departments);
  const out = [];
  for (let i = 0; i < S.SERVES_SLOTS; i++) { const v = ws.getRow(row).getCell(DEPT.firstServes + i).value; if (v != null && String(v).trim()) out.push(String(v)); }
  return out;
}
export const deleteRow = (wb, sheet, row) => wb.getWorksheet(sheet).spliceRows(row, 1);
/** Put `values` on the first empty row at the end of a simple sheet. */
export function appendRow(wb, sheet, values) {
  const ws = wb.getWorksheet(sheet);
  let r = ws.rowCount;
  while (r > 1 && !String(ws.getRow(r).getCell(1).value ?? '').trim() && !String(ws.getRow(r).getCell(2).value ?? '').trim()) r--;
  const row = ws.getRow(r + 1);
  values.forEach((v, i) => { row.getCell(i + 1).value = v; });
  return r + 1;
}
/** The row of a sheet whose column `col` holds exactly `text` (formula results count). */
export function findRow(wb, sheet, col, text) {
  const ws = wb.getWorksheet(sheet);
  for (let r = 2; r <= ws.rowCount; r++) {
    const v = ws.getRow(r).getCell(col).value;
    const t = v && typeof v === 'object' && 'result' in v ? v.result : v;
    if (t != null && String(t).trim() === text) return r;
  }
  return null;
}
export const findKeyRow = (wb, sheet, key) => findRow(wb, sheet, keyCol(sheet), key);
/** Rewrite a Start here provenance cell. */
export function setProvenance(wb, field, value) {
  const ws = wb.getWorksheet(SHEETS.start);
  for (let r = 1; r <= ws.rowCount; r++) {
    if (ws.getRow(r).getCell(2).value === `${S.PROVENANCE_PREFIX}${field}`) { ws.getRow(r).getCell(3).value = value; return; }
  }
  throw new Error(`no provenance.${field}`);
}
export function clearProvenance(wb, field) {
  const ws = wb.getWorksheet(SHEETS.start);
  for (let r = 1; r <= ws.rowCount; r++) {
    if (ws.getRow(r).getCell(2).value === `${S.PROVENANCE_PREFIX}${field}`) { ws.getRow(r).getCell(2).value = null; ws.getRow(r).getCell(3).value = null; return; }
  }
}

// -------------------------------------------------------------------------- reading the data ----
export const labelOf = (data, seat) => S.seatLabel(data.seats.indexOf(seat), seat.title);
export const isLeaf = (data, seat) => !data.seats.some((c) => c.parentPositionId === seat.positionId);
export const seatsOfRole = (data, seat) => data.seats.filter((x) => x.roleId === seat.roleId).length;
export const peopleIn = (data, seat) => data.people.filter((p) => p.seatKey === seat.key);
export const isLastChild = (data, seat) => seat.parent != null
  && data.seats.filter((c) => c.parentPositionId === data.seats[seat.parent].positionId).pop() === seat;
export const errorsOf = (prep) => (prep.problems ?? []).filter((p) => p.severity === 'error');
export const codes = (prep) => errorsOf(prep).map((p) => p.code);
/** The error codes of a plan, each once with how often it occurred: 'SEAT_NOT_FOUND x3, BAD_COUNT'. */
export const codeList = (prep) => {
  const n = new Map();
  for (const c of codes(prep)) n.set(c, (n.get(c) ?? 0) + 1);
  return [...n].map(([c, k]) => (k > 1 ? `${c} x${k}` : c)).join(', ');
};
export const warns = (prep) => (prep.problems ?? []).filter((p) => p.severity === 'warning').map((p) => p.code);
export const summary = (plan) => Object.entries(plan.counts).filter(([, n]) => n).map(([k, n]) => `${k}=${n}`).join(' ') || '(empty)';
/** Names of the counters that are not zero, sorted: for "exactly these changes and no others". */
export const changed = (plan) => Object.entries(plan.counts).filter(([, n]) => n).map(([k]) => k).sort().join(',');
export const totalChanges = (plan) => Object.values(plan.counts).reduce((a, b) => a + b, 0);

// -------------------------------------------------------------------------------- the context ----
/**
 * The object every case receives. One per attempt of a case: its checks, notes and skipped sub-checks are that
 * attempt's alone, so a case that has to be run again (the database moved under it) starts clean.
 */
export function makeCase({ conn, target, company, tag }) {
  const results = [];
  const notes = [];
  const partial = [];
  const t = {
    conn, target, company, slug: company.slug, companyId: company.id, tag,
    T, A, S, R, ExcelJS,
    results, notes, partial,

    /** A check. Returns whether it held, so a case can stop early when a precondition fails. */
    ok(cond, message) { results.push({ pass: Boolean(cond), message }); return Boolean(cond); },
    /** Context printed only when a case fails (or with --verbose). */
    note(text) { notes.push(String(text)); },
    /** Give up on the whole case: the data has nothing to test it with. */
    skip(reason) { throw new Skip(reason); },
    /** The value, or skip the case if there is none. */
    need(value, reason) {
      if (value === undefined || value === null || value === false) throw new Skip(reason);
      return value;
    },
    /** The value, or null and a mention that part of the case did not run (the rest still does). */
    part(value, reason) {
      if (value === undefined || value === null || value === false) { partial.push(reason); return null; }
      return value;
    },
    /** A name that no row in the company can already have. */
    name: (what) => `ZZ ${tag} ${what}`,

    q: async (sql, params = [], c = conn) => (await c.query(sql, params))[0],
    env: () => A.loadEnv(conn, company.id),

    exportWorkbook: () => T.exportWorkbook(conn, company.slug, target),
    freshExport: async (c = conn) => {
      const ex = await T.exportWorkbook(c, company.slug, target);
      return { buf: Buffer.from(await ex.wb.xlsx.writeBuffer()), data: ex.data };
    },
    open, save,
    plan: (buf, flags = {}) => A.prepare({ conn, buf, slug: company.slug, target, deleteMissing: Boolean(flags.deleteMissing) }),
    describe: (prep) => A.describePlan(prep.plan, A.reportContext(prep)),
    /**
     * Apply for real inside a transaction, hand the open transaction to `observe` (it sees the database as the apply
     * leaves it, after the apply's own convergence check), then roll everything back.
     */
    rehearse: async (buf, flags, observe) => {
      const res = await A.applyWorkbook({
        conn, buf, file: 'rehearsal.xlsx', slug: company.slug, target,
        flags: { deleteMissing: false, allowStale: false, again: true, createOnly: false, ...flags, rehearse: observe },
      });
      if (res.status === 'FAILED') notes.push(`apply FAILED: ${res.error?.message} ${JSON.stringify(res.error?.problems ?? '')}\n${String(res.error?.stack ?? '').split('\n').slice(0, 5).join('\n')}`);
      if (res.status === 'DID_NOT_CONVERGE' || res.status === 'PROBLEMS') notes.push(`apply ${res.status}:\n  ${(res.reasons ?? []).slice(0, 12).join('\n  ')}`);
      return res;
    },
    /** The reason an apply did not happen, for a check message. */
    why: (res) => `${res.status}${res.reasons ? `: ${res.reasons.slice(0, 3).join(' | ')}` : ''}${res.error ? `: ${res.error.message}` : ''}`,

    // editing (re-exported so a case needs no imports)
    structureRows, rowOfKey, levelOfRow, setSeatTitle, setCell, getCell, keyCol, insertSeat, copyRow, deleteRow, appendRow,
    appendDepartment, setServes, servesOf, findRow, findKeyRow, setProvenance, clearProvenance, COLS, DEPT,
    labelOf, isLeaf, seatsOfRole, peopleIn, isLastChild, errorsOf, codes, codeList, warns, summary, changed, totalChanges,
    /** A check that the plan has no errors, naming them when it has. */
    noErrors(prep) { const list = codeList(prep); return t.ok(!list, `no errors${list ? ` (${list})` : ''}`); },
  };
  return t;
}
