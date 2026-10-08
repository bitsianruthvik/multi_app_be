/**
 * The CF_HRMS organisation workbook, READ BACK: an ExcelJS workbook in, a structured
 * description of what it says plus a list of problems out.
 *
 * PURE. No database, no disk, no clock. It only needs the constants and the outline
 * rule that lib/orgTemplateSheets.mjs already owns, so the layout the generator
 * writes and the layout this reads cannot drift apart. What the rows MEAN against
 * the database (which record a key is, whether a seat moved, what to write) is
 * org-apply-workbook.mjs's job; this file only says what the sheets contain and
 * whether it is well formed.
 *
 * WHY IT VALIDATES AT ALL. The workbook carries drop-downs and rules, and Excel
 * will not stop a person pasting past them. Everything the in-sheet rules check is
 * checked again here, plus what no in-sheet rule can: the keys.
 *
 * THE KEY COLUMN (hidden, last column of every editable sheet), and what a reader does with it:
 *   - a well-formed key of the right kind is that record's identity;
 *   - a BLANK key is a row the human added. That is the normal way to add a seat, never an error;
 *   - a key that appears a second time is a copy-pasted row. The first occurrence in row order keeps
 *     the identity; every later one is read as a new row and reported as an info finding;
 *   - a key that is malformed, or of the wrong kind for its sheet (an `asg:` on Structure), is an error;
 *   - a pre-filled workbook whose sheet has lost ALL its keys is an error, not a thousand new rows
 *     (someone cleared the hidden column).
 * Whether a key still exists in the database is not known here; the applier reports that.
 *
 * PROBLEMS carry a severity. 'error' means a row cannot be understood and nothing may be applied.
 * 'warning' means it was understood but something was ignored or assumed. 'info' is a finding.
 *
 * Rows whose visible cells start with EXAMPLE_MARK are skipped (and counted). A row that holds nothing
 * visible is not a row, even if its hidden key is still there: that is how "I cleared this row" reads.
 */
import {
  SHEET, HEADERS, COL, LEVELS, KEY_COLUMN, KEY_HEADER, KEY_KINDS, SCHEMA_VERSION, EXAMPLE_MARK, MAX_MACHINES,
  KINDS, DAY_AND_NIGHT, DEFAULT_SHIFTS, PROVENANCE_FIELDS,
  cellText, readOutline, readProvenanceBlock, parseKey, squeeze, seatLabel, machineKey, splitMachineList,
} from './orgTemplateSheets.mjs';

/** Schema versions this reader understands. A workbook stamped with any other is refused, never guessed at. */
export const SUPPORTED_SCHEMA_VERSIONS = Object.freeze([SCHEMA_VERSION]);

const SHEET_OF = Object.freeze({
  structure: SHEET.structure, people: SHEET.people, responsibilities: SHEET.responsibilities,
  machines: SHEET.machines, questions: SHEET.questions,
});
export const DATA_SHEETS = Object.freeze(Object.keys(SHEET_OF));

/** Sheet-level limits, from the database columns the values end up in. */
const LIMITS = Object.freeze({ title: 200, name: 200, code: 50, departmentOrLocation: 200, machineName: 200, text: 4000 });

// ------------------------------------------------------------------ cells ----
const valueOf = (cell) => {
  const v = cell?.value;
  if (v == null) return null;
  if (typeof v === 'object' && !(v instanceof Date)) {
    if ('result' in v) return v.result ?? null;
    if (v.richText) return v.richText.map((t) => t.text).join('');
    if (v.text != null) return v.text;
  }
  return v;
};
const textAt = (sheet, r, c) => squeeze(cellText(sheet.getRow(r).getCell(c).value));

/** Number of a count cell: a number, or text that is only a number. NaN otherwise. */
function numberFrom(raw) {
  if (typeof raw === 'number') return raw;
  const s = squeeze(raw);
  return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : NaN;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const ymd = (y, m, d) => `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const realDate = (y, m, d) => {
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
};

/**
 * A Joined cell as 'YYYY-MM-DD', or undefined when it cannot be read as a date. A date typed into Excel arrives as a
 * Date at UTC midnight (no time zone can move it a day); text is accepted as 2021-04-01 or 01-Apr-2021 (day first, as
 * the sheet's own format shows it). Anything else is refused rather than guessed: 03/04/2021 means two things.
 */
export function dateFrom(raw) {
  if (raw == null || raw === '') return null;
  if (raw instanceof Date) return Number.isNaN(raw.getTime()) ? undefined : raw.toISOString().slice(0, 10);
  if (typeof raw === 'number') {
    const d = new Date(Math.round((raw - 25569) * 86400000)); // an Excel serial that nothing formatted as a date
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString().slice(0, 10);
  }
  const s = squeeze(raw);
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m && realDate(+m[1], +m[2], +m[3])) return ymd(m[1], m[2], m[3]);
  m = /^(\d{1,2})[-\s]([A-Za-z]{3})[A-Za-z]*[-\s,]+(\d{4})$/.exec(s);
  const mi = m ? MONTHS.indexOf(m[2].toLowerCase()) : -1;
  if (m && mi >= 0 && realDate(+m[3], mi + 1, +m[1])) return ymd(m[3], mi + 1, m[1]);
  return undefined;
}

// ----------------------------------------------------------- seat labels ----
/** "P012 — Helper 1" -> { ref: "P012", title: "Helper 1" }; plain text -> { ref: null, title: text }. */
export function labelParts(text) {
  const s = squeeze(text);
  const m = /^(P\d+)\s*[—–-]\s*(.*)$/i.exec(s);
  return m ? { ref: m[1].toUpperCase(), title: squeeze(m[2]) } : { ref: null, title: s };
}

/**
 * Which Structure row a Seat cell on another sheet names. The cell holds the label the drop-down offered
 * ("P012 — Title"), and Ref is positional, so a label can go stale when rows are inserted above it.
 *
 *   1. the exact label of a seat in this workbook       -> { how: 'label' }
 *   2. otherwise the title alone, if exactly one seat has it -> { how: 'title' }  (the Ref went stale)
 *   3. otherwise nothing: EMPTY, NOT_FOUND or AMBIGUOUS (ten seats are called "Helper 1")
 *
 * @param {string} text
 * @param {{label:string,title:string}[]} seats  the workbook's seats, in row order
 * @returns {{ok:true, seat:number, how:'label'|'title'}|{ok:false, reason:'EMPTY'|'NOT_FOUND'|'AMBIGUOUS', candidates?:number[]}}
 */
export function resolveSeatCell(text, seats) {
  const s = squeeze(text);
  if (!s) return { ok: false, reason: 'EMPTY' };
  const exact = seats.findIndex((x) => x.label === s);
  if (exact >= 0) return { ok: true, seat: exact, how: 'label' };
  const { title } = labelParts(s);
  const same = seats.map((x, i) => (squeeze(x.title).toLowerCase() === title.toLowerCase() ? i : -1)).filter((i) => i >= 0);
  if (same.length === 1) return { ok: true, seat: same[0], how: 'title' };
  return same.length > 1 ? { ok: false, reason: 'AMBIGUOUS', candidates: same } : { ok: false, reason: 'NOT_FOUND' };
}

// ---------------------------------------------------------------- reading ----
/**
 * @param {import('exceljs').Workbook} wb
 * @returns {{
 *   kind: 'prefilled'|'blank'|'legacy'|'unknown',
 *   provenance: null|object, lists: {seatShifts:string[], personShifts:string[]},
 *   seats: object[], people: object[], responsibilities: object[], machines: object[], questions: object[],
 *   skippedExamples: Record<string, number>, problems: object[], stats: object
 * }}
 */
export function readOrgWorkbook(wb) {
  const problems = [];
  const add = (severity, code, sheet, row, message) => problems.push({ severity, code, sheet, row: row ?? null, message });
  const result = {
    kind: 'unknown', provenance: null, lists: { seatShifts: [], personShifts: [] },
    seats: [], people: [], responsibilities: [], machines: [], questions: [],
    skippedExamples: Object.fromEntries(DATA_SHEETS.map((k) => [k, 0])), problems,
    stats: { rows: {}, keyed: {}, blankKey: {}, duplicateKey: {} },
  };

  // ---- the sheets are there ----
  const sheets = {};
  for (const [key, name] of Object.entries(SHEET_OF)) {
    sheets[key] = wb.getWorksheet(name);
    if (!sheets[key]) add('error', 'MISSING_SHEET', name, null, `The sheet "${name}" is missing.`);
  }
  if (problems.some((p) => p.severity === 'error')) return result;

  // ---- provenance, and so what KIND of workbook this is ----
  const block = readProvenanceBlock(wb.getWorksheet(SHEET.start));
  const hasKeyHeader = Object.fromEntries(DATA_SHEETS.map((k) => [k, textAt(sheets[k], 1, KEY_COLUMN[k]) === KEY_HEADER]));
  if (block) {
    const missing = PROVENANCE_FIELDS.filter((f) => !block[f]);
    if (missing.length) {
      add('error', 'PROVENANCE_INCOMPLETE', SHEET.start, null, `The hidden provenance block on "${SHEET.start}" is missing ${missing.join(', ')}.`);
      return result;
    }
    let counts = {};
    try { counts = JSON.parse(block.counts); } catch { counts = null; }
    result.provenance = {
      schemaVersion: Number(block.schemaVersion), companySlug: block.companySlug, companyId: Number(block.companyId),
      target: block.target, targetName: block.targetName, exportedAt: block.exportedAt, contentHash: block.contentHash, counts,
    };
    if (!SUPPORTED_SCHEMA_VERSIONS.includes(result.provenance.schemaVersion)) {
      add('error', 'UNKNOWN_SCHEMA_VERSION', SHEET.start, null,
        `This workbook is schema version ${block.schemaVersion}; this reader understands ${SUPPORTED_SCHEMA_VERSIONS.join(', ')}. `
        + 'Export a fresh workbook with the same version of the tool you are applying with.');
      return result;
    }
    if (!counts || !Number.isFinite(result.provenance.companyId)) {
      add('error', 'PROVENANCE_INCOMPLETE', SHEET.start, null, 'The hidden provenance block cannot be read (company id or counts are not valid).');
      return result;
    }
    result.kind = 'prefilled';
  } else if (DATA_SHEETS.every((k) => hasKeyHeader[k])) {
    result.kind = 'blank';
  } else {
    result.kind = 'legacy';
  }

  // ---- the headings are the contract ----
  for (const k of DATA_SHEETS) {
    const want = result.kind === 'legacy' ? HEADERS[k].slice(0, -1) : HEADERS[k];
    want.forEach((text, i) => {
      const got = textAt(sheets[k], 1, i + 1);
      if (got !== text) add('error', 'BAD_HEADER', SHEET_OF[k], 1, `Column ${i + 1} heading is "${got}", expected "${text}". A column has been inserted, moved or renamed.`);
    });
  }
  if (problems.some((p) => p.severity === 'error')) return result;

  // ---- the lists the drop-downs offered ----
  const lists = wb.getWorksheet(SHEET.lists);
  const column = (c) => {
    const out = [];
    for (let r = 2; lists && r <= Math.min(lists.rowCount, 40); r++) { const t = textAt(lists, r, c); if (t) out.push(t); else break; }
    return out;
  };
  result.lists.seatShifts = column(1);
  result.lists.personShifts = column(2);
  if (!result.lists.personShifts.length) result.lists.personShifts = [...DEFAULT_SHIFTS];
  if (!result.lists.seatShifts.length) result.lists.seatShifts = [...DEFAULT_SHIFTS, DAY_AND_NIGHT];
  const canon = (list, text) => list.find((x) => x.toLowerCase() === squeeze(text).toLowerCase()) ?? null;

  // ---- one pass over each sheet's rows, keys included ----
  /** The key cell of a row, validated for its sheet. Returns { key, keyState, identity }. */
  const keyOf = (k, r, seenKeys) => {
    if (result.kind !== 'prefilled' && result.kind !== 'blank') return { key: null, keyState: 'none', identity: null };
    const raw = textAt(sheets[k], r, KEY_COLUMN[k]);
    if (!raw) return { key: null, keyState: 'none', identity: null };
    const parsed = parseKey(raw);
    if (!parsed || !KEY_KINDS[k].includes(parsed.kind)) {
      add('error', 'BAD_KEY', SHEET_OF[k], r, `The hidden Key "${raw}" is not a ${KEY_KINDS[k].map((x) => `${x}:`).join(' or ')} key. Clear that cell to treat the row as new, or export a fresh workbook.`);
      return { key: raw, keyState: 'bad', identity: null };
    }
    const key = raw.toLowerCase();
    if (seenKeys.has(key)) {
      add('info', 'DUPLICATE_KEY', SHEET_OF[k], r, `Row ${r} repeats the Key ${key} of row ${seenKeys.get(key)}: it was copied, so it is read as a NEW row. The first one keeps the identity.`);
      result.stats.duplicateKey[k] = (result.stats.duplicateKey[k] ?? 0) + 1;
      return { key, keyState: 'duplicate', identity: null };
    }
    seenKeys.set(key, r);
    return { key, keyState: 'ok', identity: parsed };
  };
  const tally = (k, rows) => {
    result.stats.rows[k] = rows.length;
    result.stats.keyed[k] = rows.filter((x) => x.keyState === 'ok').length;
    result.stats.blankKey[k] = rows.filter((x) => x.keyState === 'none').length;
  };

  // ============================ Machines & areas (read first: Structure checks its names against it) ============================
  {
    const sh = sheets.machines;
    const seen = new Map();
    const names = new Map(); // machineKey -> first row
    for (let r = 2; r <= sh.rowCount; r++) {
      const values = [1, 2, 3].map((c) => textAt(sh, r, c));
      if (!values.some(Boolean)) continue;
      if (values.some((v) => v.startsWith(EXAMPLE_MARK))) { result.skippedExamples.machines++; continue; }
      const id = keyOf('machines', r, seen);
      const [name, kindText, where] = values;
      const row = { sheet: SHEET.machines, row: r, ...id, name, kind: canon(KINDS, kindText) ?? '', where };
      if (!name) add('error', 'NAME_REQUIRED', SHEET.machines, r, `Machines & areas row ${r} has no Name.`);
      else if (name.length > LIMITS.machineName) add('error', 'TEXT_TOO_LONG', SHEET.machines, r, `Machines & areas row ${r}: the name is over ${LIMITS.machineName} characters.`);
      if (name && names.has(machineKey(name))) add('error', 'DUPLICATE_NAME', SHEET.machines, r, `Machines & areas row ${r}: "${name}" is already listed on row ${names.get(machineKey(name))}. A machine is named once.`);
      else if (name) names.set(machineKey(name), r);
      if (!kindText) add('error', 'KIND_REQUIRED', SHEET.machines, r, `Machines & areas row ${r} ("${name}") has no Kind.`);
      else if (!row.kind) add('error', 'BAD_KIND', SHEET.machines, r, `Machines & areas row ${r}: "${kindText}" is not one of ${KINDS.join(', ')}.`);
      if (where.length > LIMITS.departmentOrLocation) add('error', 'TEXT_TOO_LONG', SHEET.machines, r, `Machines & areas row ${r}: "Where" is over ${LIMITS.departmentOrLocation} characters.`);
      result.machines.push(row);
    }
    tally('machines', result.machines);
  }
  const machineKeys = new Map(result.machines.filter((m) => m.name).map((m) => [machineKey(m.name), m.name]));

  // ============================ Structure ============================
  {
    const sh = sheets.structure;
    const outline = readOutline(sh);
    const seen = new Map();
    const seatIndexOfOutline = new Map();
    const titledRows = new Set(outline.map((o) => o.row));

    for (const o of outline) {
      const r = o.row;
      const visible = Array.from({ length: COL.notes }, (_, c) => textAt(sh, r, c + 1));
      if (visible.some((v) => v.startsWith(EXAMPLE_MARK))) { result.skippedExamples.structure++; continue; }
      if (o.problem === 'Two titles in one row') {
        add('error', 'TWO_TITLES', SHEET.structure, r, `Structure row ${r} has a title in more than one Level column (${o.title}). One row is one seat: keep one.`);
        continue;
      }
      const id = keyOf('structure', r, seen);
      const title = squeeze(o.title);
      const seat = {
        sheet: SHEET.structure, row: r, ref: o.ref, ...id, label: seatLabel(r - 2, title),
        level: o.level, title, parent: null, outlineIndex: outline.indexOf(o),
        count: null, shift: '', department: '', location: '', machines: [], notes: '',
      };
      if (o.problem === 'Skipped a level') {
        add('error', 'SKIPPED_LEVEL', SHEET.structure, r, `Structure row ${r} ("${title}") sits at Level ${o.level} but nothing above it is at Level ${o.level - 1}, so it has no manager. Indent it one level, or give it a manager.`);
      }
      if (title.length > LIMITS.title) add('error', 'TEXT_TOO_LONG', SHEET.structure, r, `Structure row ${r}: the title is over ${LIMITS.title} characters.`);

      // How many people?
      const countRaw = valueOf(sh.getRow(r).getCell(COL.count));
      const countText = squeeze(countRaw);
      if (countText) {
        const n = numberFrom(countRaw);
        if (!Number.isFinite(n) || n < 0 || n > 1000) add('error', 'BAD_COUNT', SHEET.structure, r, `Structure row ${r} ("${title}"): "How many people?" must be a number from 0 to 1000, not "${countText}".`);
        else {
          seat.count = Math.round(n * 100) / 100;
          if (seat.count !== n) add('warning', 'COUNT_ROUNDED', SHEET.structure, r, `Structure row ${r} ("${title}"): ${n} was rounded to ${seat.count} (two decimals are kept).`);
        }
      }
      // Shift
      const shiftText = textAt(sh, r, COL.shift);
      // An empty count or shift is not a problem in itself: the database may hold none either. Whether it matters is the applier's call.
      if (shiftText) {
        seat.shift = canon(result.lists.seatShifts, shiftText) ?? '';
        if (!seat.shift) add('error', 'BAD_SHIFT', SHEET.structure, r, `Structure row ${r} ("${title}"): "${shiftText}" is not one of ${result.lists.seatShifts.join(', ')}.`);
      }
      seat.department = textAt(sh, r, COL.department);
      seat.location = textAt(sh, r, COL.location);
      for (const [what, v] of [['Department', seat.department], ['Location', seat.location]]) {
        if (v.length > LIMITS.departmentOrLocation) add('error', 'TEXT_TOO_LONG', SHEET.structure, r, `Structure row ${r}: ${what} is over ${LIMITS.departmentOrLocation} characters.`);
      }
      // Machines or areas: comma separated, each on the Machines sheet (a name may itself hold a comma)
      const machineText = textAt(sh, r, COL.machines);
      if (machineText) {
        if (/(^|,)\s*(,|$)/.test(machineText)) add('warning', 'EMPTY_PIECE', SHEET.structure, r, `Structure row ${r} ("${title}"): the Machines cell has an empty piece between commas; it was ignored.`);
        const seenHere = new Set();
        for (const name of splitMachineList(machineText, new Set(machineKeys.keys()))) {
          const canonical = machineKeys.get(machineKey(name));
          if (!canonical) { add('error', 'UNKNOWN_MACHINE', SHEET.structure, r, `Structure row ${r} ("${title}"): "${name}" is not on Machines & areas. Check the spelling, or add it there first.`); continue; }
          if (seenHere.has(machineKey(canonical))) { add('warning', 'DUPLICATE_MACHINE', SHEET.structure, r, `Structure row ${r} ("${title}"): "${canonical}" is listed twice; once is enough.`); continue; }
          seenHere.add(machineKey(canonical));
          seat.machines.push(canonical);
        }
        if (seat.machines.length > MAX_MACHINES) add('error', 'TOO_MANY_MACHINES', SHEET.structure, r, `Structure row ${r} ("${title}"): ${seat.machines.length} machines listed, the most a seat may list is ${MAX_MACHINES}.`);
      }
      seat.notes = textAt(sh, r, COL.notes);
      seatIndexOfOutline.set(seat.outlineIndex, result.seats.length);
      result.seats.push(seat);
    }
    // The manager of a seat is the nearest row above it one level to the left (readOutline's rule), re-pointed at this list.
    for (const seat of result.seats) {
      const parentOutline = outline[seat.outlineIndex].parent;
      if (parentOutline == null) continue;
      const parent = seatIndexOfOutline.get(parentOutline);
      if (parent == null) {
        add('error', 'PARENT_UNREADABLE', SHEET.structure, seat.row, `Structure row ${seat.row} ("${seat.title}") reports to a row that could not be read (an example row or a row with two titles).`);
      } else seat.parent = parent;
    }
    // A row with details but no title: the details would vanish without a word, so say so.
    for (let r = 2; r <= sh.rowCount; r++) {
      if (titledRows.has(r)) continue;
      const rest = [COL.count, COL.shift, COL.department, COL.location, COL.machines, COL.notes].map((c) => textAt(sh, r, c));
      if (rest.some(Boolean) && !rest.some((v) => v.startsWith(EXAMPLE_MARK))) {
        add('error', 'NO_TITLE', SHEET.structure, r, `Structure row ${r} has details (${rest.filter(Boolean).slice(0, 2).join('; ')}) but no seat title in any Level column.`);
      }
    }
    tally('structure', result.seats);
  }

  // ============================ People ============================
  {
    const sh = sheets.people;
    const seen = new Map();
    for (let r = 2; r <= sh.rowCount; r++) {
      const values = [1, 2, 3, 4].map((c) => textAt(sh, r, c));
      const joinedRaw = valueOf(sh.getRow(r).getCell(5));
      if (!values.some(Boolean) && !squeeze(joinedRaw)) continue;
      if (values.some((v) => v.startsWith(EXAMPLE_MARK))) { result.skippedExamples.people++; continue; }
      const id = keyOf('people', r, seen);
      const [name, seatText, shiftText, code] = values;
      const row = { sheet: SHEET.people, row: r, ...id, name, seatText, shift: '', code, joined: null };
      if (!name) add('error', 'NAME_REQUIRED', SHEET.people, r, `People row ${r} has no Full name.`);
      else if (name.length > LIMITS.name) add('error', 'TEXT_TOO_LONG', SHEET.people, r, `People row ${r}: the name is over ${LIMITS.name} characters.`);
      if (!seatText) add('error', 'SEAT_REQUIRED', SHEET.people, r, `People row ${r} ("${name}") has no Seat.`);
      if (shiftText) {
        row.shift = canon(result.lists.personShifts, shiftText) ?? '';
        if (!row.shift) add('error', 'BAD_SHIFT', SHEET.people, r, `People row ${r} ("${name}"): "${shiftText}" is not one of ${result.lists.personShifts.join(', ')}.`);
      }
      if (code.length > LIMITS.code) add('error', 'TEXT_TOO_LONG', SHEET.people, r, `People row ${r}: the employee code is over ${LIMITS.code} characters.`);
      const joined = dateFrom(joinedRaw);
      if (joined === undefined) add('error', 'BAD_DATE', SHEET.people, r, `People row ${r} ("${name}"): "${squeeze(joinedRaw)}" is not a date. Type it as 01-Apr-2021.`);
      else if (joined && (joined < '1930-01-01' || joined > '2100-12-31')) add('error', 'BAD_DATE', SHEET.people, r, `People row ${r} ("${name}"): the joining date ${joined} is outside 1930 to 2100.`);
      else row.joined = joined;
      result.people.push(row);
    }
    tally('people', result.people);
  }

  // ============================ Responsibilities ============================
  {
    const sh = sheets.responsibilities;
    const seen = new Map();
    for (let r = 2; r <= sh.rowCount; r++) {
      const values = [1, 2].map((c) => textAt(sh, r, c));
      if (!values.some(Boolean)) continue;
      if (values.some((v) => v.startsWith(EXAMPLE_MARK))) { result.skippedExamples.responsibilities++; continue; }
      const id = keyOf('responsibilities', r, seen);
      const [seatText, text] = values;
      if (!seatText) add('error', 'SEAT_REQUIRED', SHEET.responsibilities, r, `Responsibilities row ${r} has no Seat.`);
      if (!text) add('error', 'TEXT_REQUIRED', SHEET.responsibilities, r, `Responsibilities row ${r} has no Responsibility.`);
      else if (text.length > LIMITS.text) add('error', 'TEXT_TOO_LONG', SHEET.responsibilities, r, `Responsibilities row ${r}: the text is over ${LIMITS.text} characters.`);
      result.responsibilities.push({ sheet: SHEET.responsibilities, row: r, ...id, seatText, text });
    }
    tally('responsibilities', result.responsibilities);
  }

  // ============================ Questions & doubts ============================
  {
    const sh = sheets.questions;
    const seen = new Map();
    for (let r = 2; r <= sh.rowCount; r++) {
      const values = [1, 2].map((c) => textAt(sh, r, c));
      if (!values.some(Boolean)) continue;
      if (values.some((v) => v.startsWith(EXAMPLE_MARK))) { result.skippedExamples.questions++; continue; }
      const id = keyOf('questions', r, seen);
      const [seatText, text] = values;
      if (!text) add('error', 'TEXT_REQUIRED', SHEET.questions, r, `Questions & doubts row ${r} has no question.`);
      else if (text.length > LIMITS.text) add('error', 'TEXT_TOO_LONG', SHEET.questions, r, `Questions & doubts row ${r}: the text is over ${LIMITS.text} characters.`);
      result.questions.push({ sheet: SHEET.questions, row: r, ...id, seatText, text });
    }
    tally('questions', result.questions);
  }

  // ---- the seats the other sheets name must exist (the same thing the red cells say) ----
  for (const list of [result.people, result.responsibilities, result.questions]) {
    for (const x of list) {
      if (!x.seatText) continue;
      // Only RESOLVED here. Whether a stale or unmatched label matters is the applier's call: a keyed row whose seat cell is
      // exactly what the export wrote has not been touched, and keeps its seat whatever Refs have slid under it.
      x.seat = resolveSeatCell(x.seatText, result.seats);
    }
  }

  // ---- a pre-filled workbook that lost its keys is not a thousand new rows ----
  if (result.kind === 'prefilled') {
    for (const k of DATA_SHEETS) {
      const exported = Number(result.provenance.counts?.[k] ?? 0);
      if (exported > 0 && result.stats.rows[k] > 0 && result.stats.keyed[k] === 0) {
        add('error', 'KEYS_MISSING', SHEET_OF[k], null,
          `${SHEET_OF[k]} was exported with ${exported} keyed rows but ${result.stats.rows[k]} rows are here and none has a Key. `
          + 'The hidden Key column looks cleared. Applying this would add every row again as new; export a fresh workbook instead.');
      }
    }
  } else if (result.kind === 'blank') {
    for (const k of DATA_SHEETS) {
      if (result.stats.keyed[k] > 0) {
        add('error', 'KEYS_WITHOUT_PROVENANCE', SHEET_OF[k], null,
          `${SHEET_OF[k]} has ${result.stats.keyed[k]} keyed rows but the workbook has no provenance, so the keys cannot be trusted to belong to this database.`);
      }
    }
  }

  const examples = Object.values(result.skippedExamples).reduce((a, b) => a + b, 0);
  if (examples) add('info', 'EXAMPLE_ROWS', null, null, `${examples} grey example row(s) were skipped.`);
  return result;
}
